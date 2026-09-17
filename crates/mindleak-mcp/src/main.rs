mod agent_setup;
mod config;
mod local;
mod local_http;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{Parser, Subcommand, ValueEnum};
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
    #[command(subcommand)]
    command: Option<Command>,
    #[arg(long, value_enum, env = "MINDLEAK_TRANSPORT", default_value = "stdio")]
    transport: Transport,
    #[arg(long, env = "MINDLEAK_LISTEN", default_value = "127.0.0.1:8088")]
    listen: SocketAddr,
}

#[derive(Subcommand)]
enum Command {
    #[command(
        subcommand,
        about = "Install or check project memory instructions for an existing MCP connection"
    )]
    Agent(agent_setup::AgentCommand),
    #[command(
        subcommand,
        about = "Credential-free local Docker access and diagnostics"
    )]
    Local(local::LocalCommand),
}

#[tokio::main]
async fn main() -> Result<()> {
    if let Some(command) = Args::parse().command {
        return match command {
            Command::Agent(command) => agent_setup::run(command).await,
            Command::Local(command) => local::run(command).await,
        };
    }
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
    let model_client = || {
        reqwest::Client::builder()
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(config.model_timeout_secs))
            .redirect(reqwest::redirect::Policy::none())
            .build()
    };
    let store = PostgresMemoryStore::connect(
        &config.database_url,
        config
            .embeddings
            .as_ref()
            .map(|embedding| (embedding.provider.model.as_str(), embedding.dimensions)),
        config.pool_size,
        config.database_ca.as_deref(),
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

#[cfg(test)]
mod agent_cli_tests {
    use super::Args;
    use clap::Parser;

    #[test]
    fn accepts_project_agent_setup_without_server_configuration() {
        assert!(Args::try_parse_from([
            "mindleak-light",
            "agent",
            "setup",
            "--client",
            "vscode",
            "--server",
            "mindleak-light",
            "--scope",
            "repo:example/project",
            "--workspace",
            ".",
            "--dry-run",
        ])
        .is_ok());
    }

    #[test]
    fn dry_run_never_accepts_connection_side_effects() {
        assert!(Args::try_parse_from([
            "mindleak-light",
            "agent",
            "setup",
            "--client",
            "vscode",
            "--server",
            "memory",
            "--scope",
            "repo:example/project",
            "--dry-run",
            "--connect",
        ])
        .is_err());
    }

    #[test]
    fn agent_setup_requires_exactly_one_general_or_scoped_mode() {
        let base = [
            "mindleak-light",
            "agent",
            "setup",
            "--client",
            "vscode",
            "--server",
            "memory",
            "--dry-run",
        ];
        assert!(Args::try_parse_from(base.into_iter().chain(["--general"])).is_ok());
        assert!(
            Args::try_parse_from(base).is_err(),
            "memory mode must be explicit"
        );
        assert!(
            Args::try_parse_from(base.into_iter().chain([
                "--general",
                "--scope",
                "repo:example/project",
            ]))
            .is_err(),
            "general and scoped modes are mutually exclusive"
        );
    }
}
