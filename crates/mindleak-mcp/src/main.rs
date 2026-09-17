mod admin;
mod config;

use std::{net::SocketAddr, sync::Arc, time::Duration};

use anyhow::{Context, Result};
use clap::{
    builder::TypedValueParser, Args as ClapArgs, CommandFactory, Parser, Subcommand, ValueEnum,
};
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
    args_conflicts_with_subcommands = true,
    about = "Shared, decomposed agent memory over MCP"
)]
struct Args {
    #[command(flatten)]
    server: ServerArgs,
    #[command(subcommand)]
    command: Option<Command>,
}

#[derive(ClapArgs)]
struct ServerArgs {
    #[arg(long, value_enum)]
    transport: Option<Transport>,
    #[arg(long)]
    listen: Option<SocketAddr>,
    #[arg(long)]
    database_read_only: bool,
}

#[derive(Subcommand)]
enum Command {
    Serve(ServerArgs),
    Backup(admin::BackupArgs),
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = match Args::try_parse() {
        Ok(args) => args,
        Err(error)
            if error.exit_code() != 0
                && std::env::args_os().any(|argument| argument == "backup")
                && std::env::args_os().any(|argument| argument == "--json") =>
        {
            admin::argument_error();
            std::process::exit(2);
        }
        Err(error) => error.exit(),
    };
    let server_args = match args.command {
        Some(Command::Backup(arguments)) => {
            let exit_code = admin::run(arguments).await;
            std::process::exit(i32::from(exit_code));
        }
        Some(Command::Serve(server)) => server,
        None => args.server,
    };
    match dotenvy::dotenv() {
        Ok(_) => {}
        Err(error) if error.not_found() => {}
        Err(error) => return Err(error).context("load .env"),
    }
    let transport = server_args.transport.unwrap_or_else(|| {
        let value = std::env::var_os("MINDLEAK_TRANSPORT").unwrap_or_else(|| "stdio".into());
        let mut command = Args::command();
        command.build();
        let argument = command
            .get_arguments()
            .find(|argument| argument.get_id() == "transport");
        clap::builder::EnumValueParser::<Transport>::new()
            .parse_ref(&command, argument, &value)
            .unwrap_or_else(|error| error.exit())
    });
    let listen = server_args.listen.map(Ok).unwrap_or_else(|| {
        std::env::var("MINDLEAK_LISTEN")
            .unwrap_or_else(|_| "127.0.0.1:8088".into())
            .parse::<SocketAddr>()
            .context("invalid MINDLEAK_LISTEN address")
    })?;
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
    let store = if server_args.database_read_only {
        anyhow::ensure!(
            config.decomposition.is_none()
                && config.embeddings.is_none()
                && config.relevance.is_none(),
            "read-only verification requires model-free settings"
        );
        PostgresMemoryStore::connect_read_only(
            &config.database_url,
            config.pool_size,
            config.database_ca.as_deref(),
        )
        .await?
    } else {
        PostgresMemoryStore::connect(
            &config.database_url,
            config
                .embeddings
                .as_ref()
                .map(|embedding| (embedding.provider.model.as_str(), embedding.dimensions)),
            config.pool_size,
            config.database_ca.as_deref(),
        )
        .await?
    };
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
    match transport {
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
            let listener = tokio::net::TcpListener::bind(listen)
                .await
                .context("bind MCP HTTP listener")?;
            tracing::info!(address = %listen, "MindLeak Light MCP listening");
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
mod cli_tests {
    use super::*;

    #[test]
    fn administrative_commands_parse_without_server_configuration() {
        for arguments in [
            vec![
                "mindleak-light",
                "backup",
                "doctor",
                "--config",
                "/private/backup.json",
                "--json",
                "--non-interactive",
            ],
            vec![
                "mindleak-light",
                "backup",
                "status",
                "--config",
                "/private/backup.json",
                "--check",
            ],
            vec!["mindleak-light", "serve", "--transport", "stdio"],
        ] {
            assert!(
                Args::try_parse_from(arguments.clone()).is_ok(),
                "arguments: {arguments:?}"
            );
        }
    }

    #[test]
    fn legacy_server_flags_remain_valid() {
        assert!(Args::try_parse_from(["mindleak-light", "--transport", "stdio"]).is_ok());
        assert!(Args::try_parse_from([
            "mindleak-light",
            "--transport",
            "http",
            "--listen",
            "127.0.0.1:8088"
        ])
        .is_ok());
    }
}
