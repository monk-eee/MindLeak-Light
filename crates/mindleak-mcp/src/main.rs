mod config;
mod migration_canaries;

use std::{net::SocketAddr, path::PathBuf, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use mindleak_decomposition::{OpenAiDecomposer, SentenceDecomposer};
use mindleak_embeddings::{OpenAiEmbedder, OpenAiRelevanceRetriever};
use mindleak_mcp::{http_router, MemoryMcp};
use mindleak_memory::{MemoryDecomposer, MemoryRetriever, MemoryService, TextEmbedder};
use mindleak_storage_postgres::{
    HybridMemoryRetriever, KeywordMemoryRetriever, PostgresMemoryStore, VectorMemoryRetriever,
};
use rmcp::{transport::stdio, ServiceExt};
use tokio_util::sync::CancellationToken;

#[derive(Clone, Copy, ValueEnum)]
enum Transport {
    Stdio,
    Http,
}

#[derive(Parser)]
#[command(
    name = "mindleak-light",
    version,
    about = "Shared, decomposed agent memory over MCP"
)]
struct Args {
    #[arg(long, value_enum, env = "MINDLEAK_TRANSPORT", default_value = "stdio")]
    transport: Transport,
    #[arg(long, env = "MINDLEAK_LISTEN", default_value = "127.0.0.1:8088")]
    listen: SocketAddr,
    #[arg(long)]
    migrate_only: bool,
    #[arg(long, env = "MINDLEAK_MIGRATION_CANARIES")]
    migration_canaries: Option<PathBuf>,
}

#[tokio::main]
async fn main() -> Result<()> {
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(error) if error.not_found() => {}
        Err(error) => return Err(error).context("load .env"),
    }
    let args = Args::parse();
    tracing_subscriber::fmt()
        .with_writer(std::io::stderr)
        .with_ansi(false)
        .with_env_filter(
            "warn,mindleak_light=info,mindleak_mcp=info,mindleak_storage_postgres::migrations=info",
        )
        .init();
    let canaries = args
        .migration_canaries
        .as_deref()
        .filter(|path| !path.as_os_str().is_empty())
        .map(migration_canaries::CanarySuite::load)
        .transpose()?;
    let config = config::Config::from_env()?;
    let model_client = || {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(config.model_timeout_secs))
            .redirect(reqwest::redirect::Policy::none())
            .build()
    };
    let store = PostgresMemoryStore::connect_with_migration_options(
        &config.database_url,
        config
            .embeddings
            .as_ref()
            .map(|embedding| (embedding.provider.model.as_str(), embedding.dimensions)),
        config.pool_size,
        config.database_ca.as_deref(),
        config.migrations,
    )
    .await?;
    let embedder: Option<Arc<dyn TextEmbedder>> = match config.embeddings {
        Some(embedding) => Some(Arc::new(OpenAiEmbedder::new(
            model_client()?,
            embedding.provider.endpoint,
            embedding.provider.model,
            embedding.provider.api_key,
            embedding.dimensions,
        )?)),
        None => None,
    };
    let decomposer: Arc<dyn MemoryDecomposer> = match config.decomposition {
        Some(model) => Arc::new(
            OpenAiDecomposer::new(model_client()?, model.endpoint, model.model, model.api_key)
                .with_reasoning_effort(config.decomposition_reasoning_effort)?,
        ),
        None => Arc::new(SentenceDecomposer),
    };
    let mut retriever: Arc<dyn MemoryRetriever> = match &embedder {
        Some(embedder) if config.retrieval == config::RetrievalMode::Hybrid => Arc::new(
            HybridMemoryRetriever::new(store.clone(), embedder.clone())
                .with_min_similarity(config.min_similarity)?,
        ),
        Some(embedder) => Arc::new(
            VectorMemoryRetriever::new(store.clone(), embedder.clone())
                .with_min_similarity(config.min_similarity)?,
        ),
        None => Arc::new(KeywordMemoryRetriever::new(store.clone())),
    };
    if let Some(model) = config.relevance {
        retriever = Arc::new(
            OpenAiRelevanceRetriever::new(
                retriever,
                model_client()?,
                model.endpoint,
                model.model,
                model.api_key,
                config.relevance_candidates,
            )?
            .with_reasoning_effort(config.relevance_reasoning_effort)?,
        );
    }
    let server = MemoryMcp::new(MemoryService::new(
        Arc::new(store.clone()),
        decomposer,
        embedder,
        retriever,
    ));
    if let Some(canaries) = canaries {
        canaries.verify(server.clone()).await?;
    }
    if args.migrate_only {
        tracing::info!("migration and configured verification complete; no listener started");
        return Ok(());
    }
    match args.transport {
        Transport::Stdio => {
            server.serve(stdio()).await?.waiting().await?;
        }
        Transport::Http => {
            let cancellation = CancellationToken::new();
            let router = http_router(
                server,
                store,
                &config.http_token,
                cancellation.child_token(),
            )?;
            let listener = tokio::net::TcpListener::bind(args.listen)
                .await
                .context("bind MCP HTTP listener")?;
            tracing::info!(address = %args.listen, "MindLeak Light MCP listening");
            axum::serve(listener, router)
                .with_graceful_shutdown(async move {
                    shutdown().await;
                    cancellation.cancel();
                })
                .await?;
        }
    }
    Ok(())
}

async fn shutdown() {
    #[cfg(unix)]
    {
        let mut terminate =
            tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
                .expect("install SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {},
            _ = terminate.recv() => {},
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}
