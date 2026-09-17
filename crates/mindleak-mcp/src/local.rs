use std::{
    io::Write,
    net::SocketAddr,
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{ensure, Context, Result};
use clap::{Args, Subcommand, ValueEnum};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::process::Command;
use uuid::Uuid;

const DEFAULT_IMAGE: &str = "docker.io/monkeemagic/mindleak-light@sha256:b0686294b22c31ea0b6bef64cb139947b04edc27fb2e196923fa5e1f554e381c";
const DATABASE_PATH: &str = "/var/lib/postgresql/data";
const BINARY: &str = "/usr/local/bin/mindleak-light";

#[derive(Clone, Copy, ValueEnum)]
pub enum Engine {
    Docker,
    Podman,
}

impl Engine {
    fn command(self) -> &'static str {
        match self {
            Self::Docker => "docker",
            Self::Podman => "podman",
        }
    }
}

#[derive(Args, Clone)]
pub struct Target {
    #[arg(long, default_value = "mindleak-light")]
    container: String,
    #[arg(long, value_enum, default_value = "docker")]
    engine: Engine,
}

#[derive(Subcommand)]
pub enum LocalCommand {
    #[command(
        about = "Explicitly create or start a local trial, then configure this VS Code workspace"
    )]
    Setup {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value = DEFAULT_IMAGE)]
        image: String,
        #[arg(long, default_value = "mindleak-light-data")]
        volume: String,
        #[arg(long, default_value = "mindleak_light")]
        database: String,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
    #[command(about = "Attach MCP stdio to the existing database; never create a replacement")]
    Connect {
        #[command(flatten)]
        target: Target,
    },
    #[command(about = "Report the actual container, image, version and database without secrets")]
    Status {
        #[command(flatten)]
        target: Target,
    },
    #[command(about = "Generate a token-free VS Code entry for an existing container")]
    Configure {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value = ".")]
        workspace: PathBuf,
    },
    #[command(about = "Opt-in host-loopback HTTP bridge (native macOS/Windows only)")]
    Http {
        #[command(flatten)]
        target: Target,
        #[arg(long, default_value = "127.0.0.1:8090")]
        listen: SocketAddr,
        #[arg(long)]
        allow_unauthenticated_loopback: bool,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Inspection {
    id: String,
    image: String,
    state: ContainerState,
    config: ContainerConfig,
    mounts: Vec<Mount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ContainerState {
    running: bool,
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct ContainerConfig {
    env: Vec<String>,
    image: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct Mount {
    destination: String,
    #[serde(rename = "Type")]
    kind: String,
    #[serde(rename = "RW")]
    writable: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalStatus {
    container_id: String,
    image_id: String,
    image_reference: String,
    server_version: String,
    database: String,
    transport: &'static str,
    persistent_storage: bool,
}

impl Inspection {
    fn database(&self) -> Result<String> {
        let value = |name: &str| {
            self.config
                .env
                .iter()
                .find_map(|entry| entry.strip_prefix(&format!("{name}=")))
        };
        ensure!(value("PGDATA").is_none_or(|path| path == DATABASE_PATH)
            && value("MINDLEAK_DATABASE_URL").is_none_or(str::is_empty),
            "The selected container overrides the bundled database location. Refusing to guess; use its existing authenticated configuration.");
        ensure!(value("POSTGRES_USER") == Some("mindleak_light"),
            "Select the MindLeak all-in-one container, not a separate MCP or PostgreSQL container. Use --container NAME.");
        let database = value("POSTGRES_DB")
            .context("Container has no explicit POSTGRES_DB; refusing to guess a database.")?;
        validate_database(database)?;
        ensure!(self.mounts.iter().any(|mount| mount.destination == DATABASE_PATH
            && ["volume", "bind"].contains(&mount.kind.as_str()) && mount.writable),
            "The selected container has no writable persistent PostgreSQL volume. Refusing an ephemeral database.");
        ensure!(
            self.id.len() == 64 && self.id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid container identity."
        );
        Ok(database.to_owned())
    }
}

fn validate_name(name: &str) -> Result<()> {
    ensure!(
        !name.is_empty()
            && name.len() <= 128
            && !name.starts_with('-')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"_.-".contains(&byte)),
        "Container and volume names must contain only letters, digits, dot, underscore or hyphen."
    );
    Ok(())
}

fn validate_database(database: &str) -> Result<()> {
    ensure!(!database.is_empty() && database.len() <= 63
        && database.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "Database names must contain 1..63 letters, digits or underscores; no replacement will be created.");
    Ok(())
}

fn local_endpoint(endpoint: &str, podman: bool) -> bool {
    let Ok(url) = reqwest::Url::parse(endpoint) else {
        return false;
    };
    if url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
        return false;
    }
    match url.scheme() {
        "unix" | "npipe" => url.host_str().is_none() && !url.path().is_empty(),
        "ssh" if podman => url
            .host_str()
            .and_then(|host| {
                host.trim_matches(['[', ']'])
                    .parse::<std::net::IpAddr>()
                    .ok()
            })
            .is_some_and(|address| address.is_loopback()),
        _ => false,
    }
}

impl Target {
    async fn output(&self, args: &[&str], purpose: &'static str) -> Result<std::process::Output> {
        let mut command = Command::new(self.engine.command());
        command
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true);
        tokio::time::timeout(Duration::from_secs(30), command.output()).await
            .map_err(|_| anyhow::anyhow!("{purpose} timed out. Check Docker Desktop and run local status."))?
            .map_err(|_| anyhow::anyhow!("Cannot run the container engine. Install and start Docker Desktop (Linux containers), then retry."))
    }

    async fn inspect(&self) -> Result<Option<Inspection>> {
        validate_name(&self.container)?;
        self.check_endpoint().await?;
        let engine = self
            .output(
                &["version", "--format", "{{.Server.Version}}"],
                "Container engine check",
            )
            .await?;
        ensure!(engine.status.success(), "The container engine is unavailable. Start Docker Desktop and check the selected Docker context; no data was changed.");
        let output = self
            .output(
                &["container", "inspect", &self.container],
                "Container inspection",
            )
            .await?;
        if !output.status.success() {
            let listed = self
                .output(
                    &[
                        "container",
                        "ls",
                        "--all",
                        "--no-trunc",
                        "--format",
                        "{{json .}}",
                    ],
                    "Container identity check",
                )
                .await?;
            ensure!(
                listed.status.success(),
                "Cannot verify whether the selected container exists; no replacement was created."
            );
            let text = String::from_utf8(listed.stdout)
                .map_err(|_| anyhow::anyhow!("Cannot verify container identities."))?;
            for line in text.lines() {
                let item: Value = serde_json::from_str(line)
                    .map_err(|_| anyhow::anyhow!("Cannot verify container identities."))?;
                let matches_id = item
                    .get("ID")
                    .or_else(|| item.get("Id"))
                    .and_then(Value::as_str)
                    .is_some_and(|id| id.starts_with(&self.container));
                let matches_name = match &item["Names"] {
                    Value::String(names) => names
                        .split(',')
                        .any(|name| name.trim_start_matches('/') == self.container),
                    Value::Array(names) => names.iter().any(|name| {
                        name.as_str()
                            .is_some_and(|name| name.trim_start_matches('/') == self.container)
                    }),
                    _ => true,
                };
                ensure!(!matches_id && !matches_name, "The selected container exists but cannot be inspected. Check engine permissions; no replacement was created.");
            }
            return Ok(None);
        }
        ensure!(
            output.stdout.len() <= 1024 * 1024,
            "Container metadata exceeds the inspection bound."
        );
        let mut containers: Vec<Inspection> = serde_json::from_slice(&output.stdout)
            .map_err(|_| anyhow::anyhow!("Cannot read container metadata; verify the selected Docker context and container."))?;
        ensure!(
            containers.len() == 1,
            "Select exactly one existing container."
        );
        Ok(Some(containers.remove(0)))
    }

    async fn check_endpoint(&self) -> Result<()> {
        let endpoint = match self.engine {
            Engine::Docker => match std::env::var("DOCKER_HOST").ok().filter(|value| {
                !value.is_empty()
                    && std::env::var("DOCKER_CONTEXT")
                        .ok()
                        .is_none_or(|context| context.is_empty())
            }) {
                Some(endpoint) => endpoint,
                None => {
                    let output = self
                        .output(
                            &[
                                "context",
                                "inspect",
                                "--format",
                                "{{json .Endpoints.docker.Host}}",
                            ],
                            "Docker context check",
                        )
                        .await?;
                    ensure!(output.status.success(), "Cannot inspect the Docker context. Start Docker Desktop and select its local Linux engine.");
                    serde_json::from_slice::<String>(&output.stdout).map_err(|_| {
                        anyhow::anyhow!("Cannot identify the Docker context endpoint.")
                    })?
                }
            },
            Engine::Podman => {
                match std::env::var("CONTAINER_HOST")
                    .ok()
                    .filter(|value| !value.is_empty())
                {
                    Some(endpoint) => endpoint,
                    None => {
                        let output = self
                            .output(
                                &["system", "connection", "list", "--format", "json"],
                                "Podman connection check",
                            )
                            .await?;
                        ensure!(
                            output.status.success(),
                            "Cannot inspect the Podman connection. Start the local Podman machine."
                        );
                        let connections: Vec<Value> = serde_json::from_slice(&output.stdout)
                            .map_err(|_| {
                                anyhow::anyhow!("Cannot identify the Podman connection endpoint.")
                            })?;
                        let requested = std::env::var("CONTAINER_CONNECTION").ok();
                        if connections.is_empty()
                            && requested.is_none()
                            && cfg!(target_os = "linux")
                        {
                            return Ok(());
                        }
                        connections.iter().find(|connection| match &requested {
                        Some(name) => connection["Name"].as_str() == Some(name),
                        None => connection["Default"] == true,
                    }).and_then(|connection| connection["URI"].as_str()).map(str::to_owned)
                        .context("Select a local Podman machine connection before using local access.")?
                    }
                }
            }
        };
        ensure!(local_endpoint(&endpoint, matches!(self.engine, Engine::Podman)),
            "Local access refuses remote or TCP container-engine endpoints. Select Docker Desktop or the local Podman machine; use authenticated HTTP with TLS for shared/network agents.");
        Ok(())
    }

    async fn ready(&self, start: bool) -> Result<(Inspection, String, String)> {
        let mut container = self.inspect().await?.context(
            "The selected container does not exist in this Docker context. Run local setup for a NEW trial, or local configure --container NAME for your EXISTING store. No replacement was created.")?;
        let database = container.database()?;
        if !container.state.running {
            ensure!(start && ["exited", "created"].contains(&container.state.status.as_str()),
                "The selected container is stopped or paused. Start it in Docker Desktop, or run local connect to start a stopped container.");
            let files = tempfile::tempdir().context("Cannot inspect existing PostgreSQL files.")?;
            for name in ["PG_VERSION", "global/pg_control"] {
                let destination = files.path().join(name.replace('/', "_"));
                let output = self
                    .output(
                        &[
                            "cp",
                            &format!("{}:{DATABASE_PATH}/{name}", container.id),
                            destination.to_str().context(
                                "Cannot inspect existing PostgreSQL files at this local path.",
                            )?,
                        ],
                        "Existing PostgreSQL file check",
                    )
                    .await?;
                ensure!(output.status.success() && std::fs::metadata(&destination).is_ok_and(|metadata| metadata.is_file() && metadata.len() > 0),
                    "Cannot find the existing PostgreSQL files in the selected volume. Refusing to start and initialize an empty replacement. Restore or select the intended data volume.");
            }
            let output = self
                .output(&["start", &container.id], "Starting the existing container")
                .await?;
            ensure!(output.status.success(), "The existing container could not start. Inspect Docker Desktop; its volume was preserved.");
            container.state.running = true;
        }
        let mut interval = tokio::time::interval(Duration::from_millis(250));
        let ready = tokio::time::timeout(Duration::from_secs(30), async {
            loop {
                interval.tick().await;
                let output = self.output(&["exec", &container.id, "psql", "-X", "-v", "ON_ERROR_STOP=1",
                    "-U", "mindleak_light", "-d", &database, "-Atc",
                    "SELECT (to_regclass('public.memories') IS NOT NULL AND to_regclass('public.fragments') IS NOT NULL AND to_regclass('public.relationships') IS NOT NULL)::text"], "Database readiness").await?;
                if output.status.success() && output.stdout == b"true\n" { return Ok::<_, anyhow::Error>(()); }
            }
        }).await;
        ensure!(matches!(ready, Ok(Ok(()))),
            "The intended PostgreSQL database is unavailable or has no MindLeak schema. Check the selected container/volume and Docker logs. No empty replacement was created.");
        let version = self
            .output(
                &[
                    "exec",
                    "--user",
                    "mindleak",
                    &container.id,
                    BINARY,
                    "--version",
                ],
                "Server version check",
            )
            .await?;
        ensure!(
            version.status.success(),
            "The selected container cannot run its MindLeak executable; no image was replaced."
        );
        let version = String::from_utf8(version.stdout)
            .unwrap_or_default()
            .trim()
            .to_owned();
        ensure!(version.starts_with("mindleak-light ") && version.len() < 100
            && version.bytes().all(|byte| byte.is_ascii_graphic() || byte == b' '),
            "The selected container has no supported MindLeak executable. No database or image was replaced.");
        Ok((container, database, version))
    }

    fn stdio_command(&self, container: &Inspection, database: &str) -> Command {
        let mut command = Command::new(self.engine.command());
        command.args(["exec", "-i", "--user", "mindleak", "--env",
            &format!("MINDLEAK_DATABASE_URL=host=/var/run/postgresql user=mindleak_light dbname={database} sslmode=disable"),
            &container.id, BINARY, "--transport", "stdio"]);
        command.kill_on_drop(true);
        command
    }
}

fn configuration(
    executable: &Path,
    target: &Target,
    container_id: &str,
    mut document: Value,
) -> Result<Value> {
    let root = document
        .as_object_mut()
        .context("VS Code MCP configuration must be a JSON object.")?;
    let servers = root
        .entry("servers")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("VS Code servers must be a JSON object; configuration was not changed.")?;
    let local = json!({
        "type": "stdio", "command": executable,
        "args": ["local", "connect", "--container", container_id, "--engine", target.engine.command()]
    });
    ensure!(servers.get("mindleak-light-local").is_none_or(|existing| existing == &local),
        "mindleak-light-local is already configured differently. Review that entry before removing it and explicitly configuring another store; shared server settings were not changed.");
    servers.insert("mindleak-light-local".into(), local);
    Ok(document)
}

fn configure(workspace: &Path, target: &Target, container_id: &str) -> Result<()> {
    let executable = std::env::current_exe().context("Cannot identify launcher path.")?;
    configure_with_executable(workspace, target, container_id, &executable)
}

fn configure_with_executable(
    workspace: &Path,
    target: &Target,
    container_id: &str,
    executable: &Path,
) -> Result<()> {
    ensure!(
        workspace.is_dir(),
        "Open or create the intended workspace folder before running local setup/configure."
    );
    let directory = workspace.join(".vscode");
    std::fs::create_dir_all(&directory).context("Cannot create workspace .vscode directory.")?;
    let path = directory.join("mcp.json");
    ensure!(
        !std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()),
        "MCP configuration is a symbolic link; update its intended target explicitly."
    );
    let original = if path.exists() {
        Some(std::fs::read_to_string(&path).context("Cannot read existing MCP configuration.")?)
    } else {
        None
    };
    let document = match &original {
        Some(text) => jsonc_parser::parse_to_serde_value(text, &Default::default())
            .map_err(|_| {
                anyhow::anyhow!(
                    "Existing MCP configuration is invalid JSON/JSONC; it was not changed."
                )
            })?
            .context("Existing MCP configuration is empty; it was not changed.")?,
        None => json!({"servers": {}}),
    };
    let updated = configuration(executable, target, container_id, document.clone())?;
    if updated != document {
        let root = jsonc_parser::cst::CstRootNode::parse(
            original.as_deref().unwrap_or("{\n  \"servers\": {}\n}\n"),
            &Default::default(),
        )
        .map_err(|_| {
            anyhow::anyhow!("Cannot parse existing MCP configuration; it was not changed.")
        })?;
        let servers = root
            .object_value()
            .and_then(|root| root.object_value_or_create("servers"))
            .context("VS Code servers must be a JSON object; configuration was not changed.")?;
        let executable = executable
            .to_str()
            .context("Launcher path is not valid Unicode.")?;
        let engine = target.engine.command();
        use jsonc_parser::cst::CstInputValue;
        servers.append(
            "mindleak-light-local",
            CstInputValue::Object(vec![
                ("type".into(), "stdio".into()),
                ("command".into(), "".into()),
                (
                    "args".into(),
                    vec![
                        "local",
                        "connect",
                        "--container",
                        container_id,
                        "--engine",
                        engine,
                    ]
                    .into(),
                ),
            ]),
        );
        let command = servers
            .object_value("mindleak-light-local")
            .and_then(|local| local.get("command"))
            .and_then(|property| property.value())
            .and_then(|value| value.as_string_lit())
            .context("Cannot prepare the local launcher command; prior settings were preserved.")?;
        command.set_raw_value(serde_json::to_string(executable)?);
        let rendered = root.to_string();
        let verified =
            jsonc_parser::parse_to_serde_value(&rendered, &Default::default()).map_err(|_| {
                anyhow::anyhow!(
                    "Generated MCP configuration is invalid; prior settings were preserved."
                )
            })?;
        ensure!(verified.as_ref() == Some(&updated),
            "Generated MCP configuration does not match the intended settings; prior settings were preserved.");
        let mut pending = tempfile::NamedTempFile::new_in(&directory)
            .context("Cannot prepare MCP configuration.")?;
        pending
            .write_all(rendered.as_bytes())
            .context("Cannot prepare MCP configuration.")?;
        pending
            .as_file()
            .sync_all()
            .context("Cannot sync MCP configuration.")?;
        ensure!(std::fs::read_to_string(&path).ok() == original,
            "MCP configuration changed while preparing the local entry; retry after reviewing the file.");
        pending.persist(&path).map_err(|_| {
            anyhow::anyhow!(
                "Cannot replace MCP configuration atomically; prior settings were preserved."
            )
        })?;
    }
    eprintln!("VS Code local configuration is ready. Open this folder, run MCP: List Servers, choose mindleak-light-local and Start. Approve normal server trust. No token or OAuth registration is required.");
    Ok(())
}

pub async fn run(command: LocalCommand) -> Result<()> {
    match command {
        LocalCommand::Setup {
            target,
            image,
            volume,
            database,
            workspace,
        } => {
            validate_name(&volume)?;
            validate_database(&database)?;
            ensure!(
                workspace.is_dir(),
                "Open or create the intended workspace folder before running local setup."
            );
            ensure!(
                !image.is_empty()
                    && !image.starts_with('-')
                    && image
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || b"/._-:@".contains(&byte)),
                "Invalid image reference."
            );
            if target.inspect().await?.is_none() {
                let existing = workspace.join(".vscode/mcp.json");
                if existing.exists() {
                    let text = std::fs::read_to_string(existing)
                        .context("Cannot read existing MCP configuration.")?;
                    let document = jsonc_parser::parse_to_serde_value(&text, &Default::default())
                        .map_err(|_| {
                            anyhow::anyhow!(
                                "Existing MCP configuration is invalid; no container was created."
                            )
                        })?
                        .context(
                            "Existing MCP configuration is empty; no container was created.",
                        )?;
                    ensure!(document["servers"].get("mindleak-light-local").is_none(),
                        "This workspace is already pinned to a local store. Run local connect for that container or explicitly review the configuration; no replacement was created.");
                }
                let volumes = target
                    .output(
                        &["volume", "ls", "--format", "{{json .Name}}"],
                        "Existing volume check",
                    )
                    .await?;
                ensure!(
                    volumes.status.success(),
                    "Cannot verify existing data volumes; no container was created."
                );
                let names = String::from_utf8(volumes.stdout)
                    .context("Cannot verify existing data volume names.")?;
                for name in names.lines() {
                    let name: String = serde_json::from_str(name).map_err(|_| {
                        anyhow::anyhow!("Cannot verify existing data volume names.")
                    })?;
                    ensure!(name != volume, "The selected volume already exists. Attach its existing container with local configure --container NAME, or deliberately choose a new volume for a NEW trial. No replacement was created.");
                }
                let ownership = Uuid::new_v4().to_string();
                let created = target
                    .output(
                        &[
                            "volume",
                            "create",
                            "--label",
                            &format!("io.mindleak.local-setup={ownership}"),
                            &volume,
                        ],
                        "New volume creation",
                    )
                    .await?;
                ensure!(created.status.success(), "The volume could not be created or belongs to another setup. No container was started; existing data was preserved.");
                let inspected = target
                    .output(
                        &["volume", "inspect", "--format", "{{json .Labels}}", &volume],
                        "New volume ownership check",
                    )
                    .await?;
                let labels: Value = serde_json::from_slice(&inspected.stdout).map_err(|_| {
                    anyhow::anyhow!(
                        "Cannot verify ownership of the new volume; no container was started."
                    )
                })?;
                ensure!(inspected.status.success() && labels["io.mindleak.local-setup"].as_str() == Some(ownership.as_str()),
                    "The volume belongs to another setup. No container was started and no data was removed.");
                let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
                let mut command = Command::new(target.engine.command());
                command
                    .args([
                        "run",
                        "--detach",
                        "--name",
                        &target.container,
                        "--network",
                        "none",
                        "--mount",
                        &format!("type=volume,source={volume},target={DATABASE_PATH}"),
                        "--env",
                        "MINDLEAK_HTTP_TOKEN",
                        "--env",
                        "POSTGRES_DB",
                        &image,
                    ])
                    .env("MINDLEAK_HTTP_TOKEN", token)
                    .env("POSTGRES_DB", database)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .kill_on_drop(true);
                eprintln!("Preparing the local container and named volume. The first image download can take a few minutes.");
                let output = tokio::time::timeout(Duration::from_secs(300), command.status()).await
                    .map_err(|_| anyhow::anyhow!("Image startup timed out. Check Docker Desktop and rerun local status; any existing data volume was preserved."))?
                    .context("Cannot start the local container.")?;
                ensure!(output.success(), "Could not create the local container. Check Docker Desktop, image access and the selected name. Existing containers and volumes were not removed.");
            }
            let (container, database, version) = target.ready(true).await?;
            eprintln!(
                "Local store ready: {version}; database {database}; container {}.",
                &container.id[..12]
            );
            configure(&workspace, &target, &container.id)
        }
        LocalCommand::Connect { target } => {
            let (container, database, version) = target.ready(true).await?;
            eprintln!(
                "Local stdio: {version}; container {}; existing database {database}.",
                &container.id[..12]
            );
            let status = target
                .stdio_command(&container, &database)
                .stdin(Stdio::inherit())
                .stdout(Stdio::inherit())
                .stderr(Stdio::null())
                .status()
                .await
                .context("Cannot attach stdio to the selected container.")?;
            ensure!(status.success(), "Local MCP connection ended unexpectedly. Run local status; check Docker Desktop and the intended database. No replacement was created.");
            Ok(())
        }
        LocalCommand::Status { target } => {
            let (container, database, server_version) = target.ready(false).await?;
            let status = LocalStatus {
                container_id: container.id,
                image_id: container.image,
                image_reference: container.config.image,
                server_version,
                database,
                transport: "docker/stdio",
                persistent_storage: true,
            };
            println!("{}", serde_json::to_string_pretty(&status)?);
            Ok(())
        }
        LocalCommand::Configure { target, workspace } => {
            let (container, _, _) = target.ready(true).await?;
            configure(&workspace, &target, &container.id)
        }
        LocalCommand::Http {
            target,
            listen,
            allow_unauthenticated_loopback,
        } => {
            crate::local_http::validate_listener(
                listen,
                allow_unauthenticated_loopback,
                cfg!(any(target_os = "macos", target_os = "windows")),
            )?;
            let (container, database, _) = target.ready(true).await?;
            crate::local_http::serve(target.stdio_command(&container, &database), listen).await
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn inspection() -> Inspection {
        serde_json::from_value(json!({
            "Id": "a".repeat(64), "Image": "sha256:actual-image", "State": {"Running": true, "Status": "running"},
            "Config": {"Image": "selected:0.2.0", "Env": ["POSTGRES_USER=mindleak_light", "POSTGRES_DB=existing_store_test", "MINDLEAK_HTTP_TOKEN=secret-canary"]},
            "Mounts": [{"Destination": DATABASE_PATH, "Type": "volume", "RW": true}]
        })).unwrap()
    }

    #[test]
    fn local_target_requires_an_explicit_persistent_existing_database() {
        assert_eq!(inspection().database().unwrap(), "existing_store_test");
        let mut missing = inspection();
        missing
            .config
            .env
            .retain(|entry| !entry.starts_with("POSTGRES_DB="));
        assert!(missing.database().is_err());
        let mut ephemeral = inspection();
        ephemeral.mounts.clear();
        assert!(ephemeral.database().is_err());
        for value in ["", "--other", "name;command", "name\nsecret"] {
            assert!(validate_name(value).is_err());
        }
    }

    #[test]
    fn local_access_rejects_remote_engines_and_database_overrides() {
        for endpoint in [
            "unix:///var/run/docker.sock",
            "npipe:////./pipe/docker_engine",
        ] {
            assert!(local_endpoint(endpoint, false));
        }
        assert!(local_endpoint(
            "ssh://core@127.0.0.1:50100/run/podman.sock",
            true
        ));
        for endpoint in [
            "tcp://127.0.0.1:2375",
            "ssh://core@192.168.1.2/run/podman.sock",
            "unix://remote/socket",
            "ssh://core:secret@127.0.0.1/socket",
        ] {
            assert!(!local_endpoint(endpoint, true));
        }
        for setting in ["PGDATA=/other", "MINDLEAK_DATABASE_URL=secret-canary"] {
            let mut container = inspection();
            container.config.env.push(setting.into());
            let error = container.database().unwrap_err().to_string();
            assert!(!error.contains("secret-canary"));
        }
    }

    #[test]
    fn generated_configuration_is_token_free_and_pins_the_selected_container() {
        let target = Target {
            container: "selected".into(),
            engine: Engine::Docker,
        };
        let input = json!({"servers": {"other": {"command": "other-tool"}, "mindleak-light": {"type": "http", "headers": {"Authorization": "secret-canary"}}}, "inputs": []});
        let result = configuration(
            Path::new("/launcher path/mindleak-light"),
            &target,
            &"a".repeat(64),
            input.clone(),
        )
        .unwrap();
        assert_eq!(result["servers"]["other"]["command"], "other-tool");
        assert_eq!(
            result["servers"]["mindleak-light"],
            input["servers"]["mindleak-light"]
        );
        let local = &result["servers"]["mindleak-light-local"];
        assert_eq!(local["type"], "stdio");
        assert_eq!(local["args"][3], "a".repeat(64));
        assert!(!local.to_string().contains("secret-canary"));
        assert!(!local.to_string().contains("Authorization"));
        assert_eq!(
            configuration(
                Path::new("/launcher path/mindleak-light"),
                &target,
                &"a".repeat(64),
                result.clone()
            )
            .unwrap(),
            result
        );
        assert!(configuration(
            Path::new("/launcher path/mindleak-light"),
            &target,
            &"b".repeat(64),
            result
        )
        .is_err());
    }

    #[test]
    fn local_configuration_preserves_platform_path_characters() {
        let target = Target {
            container: "selected".into(),
            engine: Engine::Docker,
        };
        for executable in [
            r"C:\Program Files\MindLeak\mindleak-light.exe",
            r"\\?\C:\Users\operator\mindleak-light.exe",
            "/opt/launcher \"quoted\"\\name\n/mindleak-light",
        ] {
            let workspace = tempfile::tempdir().unwrap();
            let path = workspace.path().join(".vscode/mcp.json");
            configure_with_executable(
                workspace.path(),
                &target,
                &"a".repeat(64),
                Path::new(executable),
            )
            .unwrap();
            let rendered = std::fs::read_to_string(&path).unwrap();
            let parsed = jsonc_parser::parse_to_serde_value(&rendered, &Default::default())
                .expect("Generated JSONC must escape executable path characters")
                .unwrap();
            assert_eq!(
                parsed["servers"]["mindleak-light-local"]["command"],
                executable
            );
            configure_with_executable(
                workspace.path(),
                &target,
                &"a".repeat(64),
                Path::new(executable),
            )
            .unwrap();
            assert_eq!(std::fs::read_to_string(&path).unwrap(), rendered);
        }
    }

    #[test]
    fn local_configure_preserves_jsonc_comments_and_never_copies_shared_secrets() {
        let workspace = tempfile::tempdir().unwrap();
        let directory = workspace.path().join(".vscode");
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("mcp.json");
        std::fs::write(&path, "{\n  // retain this server\n  \"servers\": {\n    // retain this credential input\n    \"shared\": {\"type\": \"http\", \"url\": \"https://example.invalid/mcp\",},\n  },\n}\n").unwrap();
        let target = Target {
            container: "selected".into(),
            engine: Engine::Docker,
        };
        configure(workspace.path(), &target, &"a".repeat(64)).unwrap();
        let first = std::fs::read_to_string(&path).unwrap();
        assert!(first.contains("// retain this server"));
        assert!(first.contains("// retain this credential input"));
        let document = jsonc_parser::parse_to_serde_value(&first, &Default::default())
            .unwrap()
            .unwrap();
        assert_eq!(
            document["servers"]["shared"]["url"],
            "https://example.invalid/mcp"
        );
        assert_eq!(document["servers"]["mindleak-light-local"]["type"], "stdio");
        configure(workspace.path(), &target, &"a".repeat(64)).unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert!(configure(workspace.path(), &target, &"b".repeat(64)).is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), first);
        assert_eq!(std::fs::read_dir(directory).unwrap().count(), 1);
    }
}
