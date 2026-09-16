mod config;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, ValueEnum};
use mindleak_decomposition::OpenAiDecomposer;
use mindleak_embeddings::OpenAiEmbedder;
use mindleak_mcp::{http_router, MemoryMcp};
use mindleak_memory::MemoryService;
use mindleak_storage_postgres::{PostgresMemoryStore, VectorMemoryRetriever};
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
        .with_env_filter("warn,mindleak_mcp=info")
        .init();
    let config = config::Config::from_env()?;
    let client = reqwest::Client::builder()
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(config.model_timeout_secs))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let store = PostgresMemoryStore::connect(
        &config.database_url,
        &config.embed_model,
        config.dimensions,
        config.pool_size,
        config.database_ca.as_deref(),
    )
    .await?;
    let embedder = Arc::new(OpenAiEmbedder::new(
        client.clone(),
        config.embed_endpoint,
        config.embed_model,
        config.embed_api_key,
        config.dimensions,
    )?);
    let decomposer = Arc::new(OpenAiDecomposer::new(
        client,
        config.llm_endpoint,
        config.llm_model,
        config.llm_api_key,
    ));
    let retriever = Arc::new(VectorMemoryRetriever::new(store.clone(), embedder.clone()));
    let server = MemoryMcp::new(MemoryService::new(
        Arc::new(store.clone()),
        decomposer,
        embedder,
        retriever,
    ));
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
