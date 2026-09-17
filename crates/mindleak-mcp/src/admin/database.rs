use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::{Child, ChildStdin, ChildStdout},
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::{
    failure,
    process::{self, Invocation},
    security,
    settings::{self, BackupConfig, Target},
    AdminResult,
};

#[derive(Clone)]
pub(super) struct Database {
    config: BackupConfig,
    container: Option<String>,
    pub name: String,
    user: String,
    env: BTreeMap<std::ffi::OsString, std::ffi::OsString>,
    pub identity: String,
    pub image_id: Option<String>,
    pub engine: Engine,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Engine {
    pub version: String,
    pub sha256: String,
    pub inside_container: bool,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Fingerprint {
    pub records_sha256: String,
    pub schema_sha256: String,
    pub schema_components: BTreeMap<String, String>,
    pub database_settings: Value,
    pub rows: BTreeMap<String, u64>,
    pub postgres_version: String,
    pub extensions: Value,
    pub embedding_binding: Option<String>,
    pub database_bytes: u64,
    pub canary: Option<Canary>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct Canary {
    pub fragment_id: Uuid,
    pub agent_id: String,
    pub scope: Option<String>,
    pub raw_sha256: String,
    pub query: Option<String>,
}

impl Fingerprint {
    pub fn matches(&self, other: &Self) -> bool {
        self.records_sha256 == other.records_sha256
            && self.schema_sha256 == other.schema_sha256
            && self.rows == other.rows
            && self.embedding_binding == other.embedding_binding
            && self.extensions == other.extensions
            && self.database_settings == other.database_settings
    }
}

pub(super) struct Snapshot {
    child: Child,
    input: ChildStdin,
    output: BufReader<ChildStdout>,
    pub id: String,
    pub fingerprint: Fingerprint,
}

impl Database {
    pub async fn resolve(
        config: &BackupConfig,
        target: &Target,
        cancel: &CancellationToken,
    ) -> AdminResult<Self> {
        Self::resolve_database(config, target, false, cancel).await
    }

    pub async fn restore_server(
        config: &BackupConfig,
        target: &Target,
        cancel: &CancellationToken,
    ) -> AdminResult<Self> {
        Self::resolve_database(
            config,
            config.restore_target.as_ref().unwrap_or(target),
            true,
            cancel,
        )
        .await
    }

    async fn resolve_database(
        config: &BackupConfig,
        target: &Target,
        maintenance: bool,
        cancel: &CancellationToken,
    ) -> AdminResult<Self> {
        let mut env = BTreeMap::new();
        let (container, name, user, image_id, inside_container) =
            if let Some(selector) = &target.container {
                let bytes = process::succeeded(
                    process::capture(
                        &Invocation::new(&config.tools.container).args([
                            "inspect",
                            "--type",
                            "container",
                            selector,
                        ]),
                        &[],
                        15,
                        cancel,
                        "target_identity",
                    )
                    .await?,
                    "target_identity",
                )?;
                let values: Vec<Value> = serde_json::from_slice(&bytes)
                    .map_err(|_| failure("target_identity", "invalid_container_identity", 2))?;
                let value = values
                    .first()
                    .filter(|_| values.len() == 1)
                    .ok_or_else(|| failure("target_identity", "ambiguous_container", 2))?;
                let id = value["Id"]
                    .as_str()
                    .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
                    .ok_or_else(|| failure("target_identity", "invalid_container_identity", 2))?
                    .to_owned();
                if value["State"]["Running"] != true {
                    return Err(failure(
                        "target_identity",
                        "postgres_container_not_running",
                        2,
                    ));
                }
                let variables: BTreeMap<_, _> = value["Config"]["Env"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|entry| entry.as_str()?.split_once('='))
                    .collect();
                let user = target.user.clone().unwrap_or_else(|| {
                    variables
                        .get("POSTGRES_USER")
                        .copied()
                        .unwrap_or("postgres")
                        .into()
                });
                let name = target.database.clone().unwrap_or_else(|| {
                    variables
                        .get("POSTGRES_DB")
                        .copied()
                        .unwrap_or(&user)
                        .into()
                });
                let mapped = value["NetworkSettings"]["Ports"]["5432/tcp"]
                    .as_array()
                    .and_then(|ports| ports.first());
                let inside = mapped.is_none();
                if let Some(port) = mapped {
                    let host = port["HostIp"].as_str().unwrap_or_default();
                    if !["127.0.0.1", "::1", "0.0.0.0", "::"].contains(&host) {
                        return Err(failure("target_identity", "local_port_mapping_required", 2));
                    }
                    let port = port["HostPort"]
                        .as_str()
                        .and_then(|port| port.parse::<u16>().ok())
                        .filter(|port| *port > 0)
                        .ok_or_else(|| failure("target_identity", "invalid_port_mapping", 2))?;
                    env.insert("PGHOST".into(), "127.0.0.1".into());
                    env.insert("PGPORT".into(), port.to_string().into());
                    if let Some(password) = variables.get("POSTGRES_PASSWORD") {
                        env.insert("PGPASSWORD".into(), (*password).into());
                    }
                    env.insert("PGSSLMODE".into(), "disable".into());
                }
                (
                    Some(id),
                    name,
                    user,
                    value["Image"].as_str().map(str::to_owned),
                    inside,
                )
            } else {
                security::private(target.connection_file.as_ref().unwrap(), cancel).await?;
                let connection = target.connection()?;
                env.insert("PGHOST".into(), connection.host.into());
                env.insert("PGPORT".into(), connection.port.to_string().into());
                env.insert(
                    "PGPASSWORD".into(),
                    security::secret(&connection.password_file, cancel)
                        .await?
                        .into(),
                );
                env.insert(
                    "PGSSLMODE".into(),
                    if connection.local_plaintext {
                        "disable"
                    } else {
                        "verify-full"
                    }
                    .into(),
                );
                if let Some(path) = connection.ca_file {
                    env.insert("PGSSLROOTCERT".into(), path.into_os_string());
                }
                (None, connection.database, connection.user, None, false)
            };
        let name = if maintenance { "postgres".into() } else { name };
        if !settings::identifier(&name) || !settings::identifier(&user) {
            return Err(failure(
                "target_identity",
                "unsupported_database_identifier",
                2,
            ));
        }
        env.insert("PGUSER".into(), user.clone().into());
        env.insert("PGDATABASE".into(), name.clone().into());
        env.insert("PGCONNECT_TIMEOUT".into(), "10".into());
        let mut database = Self {
            config: config.clone(),
            container,
            name,
            user,
            env,
            identity: String::new(),
            image_id,
            engine: Engine {
                version: env!("CARGO_PKG_VERSION").into(),
                sha256: String::new(),
                inside_container,
            },
        };
        let metadata = database.query("SELECT json_build_object('cluster',(SELECT system_identifier::text FROM pg_control_system()),'database',current_database(),'version',current_setting('server_version_num')::integer)", cancel).await?;
        let version = metadata["version"].as_u64().unwrap_or_default();
        if !(160000..170000).contains(&version) {
            return Err(failure("dependencies", "postgres_16_required", 2));
        }
        database.identity = security::hash(
            serde_json::to_string(&json!([metadata["cluster"], metadata["database"]]))
                .unwrap()
                .as_bytes(),
        );
        for tool in ["pg_dump", "pg_restore", "psql"] {
            let bytes = process::succeeded(
                process::capture(
                    &database.tool(tool).args(["--version"]),
                    &[],
                    15,
                    cancel,
                    "dependencies",
                )
                .await?,
                "dependencies",
            )?;
            if !String::from_utf8_lossy(&bytes).contains("(PostgreSQL) 16.") {
                return Err(failure("dependencies", "postgres_tools_16_required", 2));
            }
        }
        let engine = database.engine_command()?;
        let output = process::succeeded(
            process::capture(&engine, &[], 15, cancel, "engine_identity").await?,
            "engine_identity",
        )?;
        if String::from_utf8_lossy(&output).trim()
            != format!("mindleak-light {}", env!("CARGO_PKG_VERSION"))
        {
            return Err(failure(
                "engine_identity",
                "matching_engine_version_required",
                2,
            ));
        }
        database.engine.sha256 = if inside_container {
            let bytes = process::succeeded(
                process::capture(
                    &Invocation::new(&config.tools.container).args([
                        "exec",
                        database.container.as_deref().unwrap(),
                        "sha256sum",
                        "/usr/local/bin/mindleak-light",
                    ]),
                    &[],
                    15,
                    cancel,
                    "engine_identity",
                )
                .await?,
                "engine_identity",
            )?;
            let hash = String::from_utf8_lossy(&bytes)
                .split_whitespace()
                .next()
                .unwrap_or_default()
                .to_owned();
            if hash.len() != 64 || !hash.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(failure("engine_identity", "invalid_engine_checksum", 2));
            }
            hash
        } else {
            security::hash_file(&database.engine_path()?)?
        };
        Ok(database)
    }

    fn engine_path(&self) -> AdminResult<std::path::PathBuf> {
        self.config.engine_path.clone().map(Ok).unwrap_or_else(|| {
            std::env::current_exe()
                .map_err(|_| failure("engine_identity", "engine_path_required", 2))
        })
    }
    fn engine_command(&self) -> AdminResult<Invocation> {
        if self.engine.inside_container {
            Ok(Invocation::new(&self.config.tools.container).args([
                "exec",
                self.container.as_deref().unwrap(),
                "/usr/local/bin/mindleak-light",
                "--version",
            ]))
        } else {
            Ok(Invocation::new(self.engine_path()?).args(["--version"]))
        }
    }

    fn tool(&self, tool: &str) -> Invocation {
        if let Some(container) = &self.container {
            Invocation::new(&self.config.tools.container).args(["exec", "-i", container, tool])
        } else {
            let path = match tool {
                "pg_dump" => &self.config.tools.pg_dump,
                "pg_restore" => &self.config.tools.pg_restore,
                _ => &self.config.tools.psql,
            };
            let mut command = Invocation::new(path);
            command.env = self.env.clone();
            command
        }
    }

    fn psql(&self) -> Invocation {
        self.tool("psql").args([
            "-X",
            "-qAt",
            "-w",
            "-v",
            "ON_ERROR_STOP=1",
            "-U",
            &self.user,
            "-d",
            &self.name,
        ])
    }

    pub async fn query(&self, sql: &str, cancel: &CancellationToken) -> AdminResult<Value> {
        let bytes = process::succeeded(
            process::capture(&self.psql(), sql.as_bytes(), 30, cancel, "database_query").await?,
            "database_query",
        )?;
        serde_json::from_slice(&bytes)
            .map_err(|_| failure("database_query", "invalid_database_result", 3))
    }

    pub async fn snapshot(&self, cancel: &CancellationToken) -> AdminResult<Snapshot> {
        let child = self
            .psql()
            .command()
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure("snapshot", "psql_unavailable", 2))?;
        let mut snapshot = Snapshot::new(child);
        let result = tokio::time::timeout(
            Duration::from_secs(self.config.policy.backup_timeout_secs),
            snapshot.initialize(cancel),
        )
        .await
        .unwrap_or_else(|_| Err(failure("snapshot", "snapshot_timeout", 3)));
        if let Err(error) = result {
            process::stop(&mut snapshot.child).await;
            return Err(error);
        }
        Ok(snapshot)
    }

    pub async fn dump(
        &self,
        snapshot: &Snapshot,
        path: &Path,
        cancel: &CancellationToken,
    ) -> AdminResult<()> {
        let invocation = self.tool("pg_dump").args([
            "--format=custom",
            "--no-owner",
            "--no-acl",
            "--no-password",
            "--lock-wait-timeout=5s",
            "--snapshot",
            &snapshot.id,
            "--username",
            &self.user,
            "--dbname",
            &self.name,
        ]);
        self.transfer(
            &invocation,
            None,
            Some(path),
            self.config.policy.backup_timeout_secs,
            cancel,
            "database_dump",
        )
        .await
    }

    async fn transfer(
        &self,
        invocation: &Invocation,
        input: Option<&Path>,
        output: Option<&Path>,
        seconds: u64,
        cancel: &CancellationToken,
        stage: &'static str,
    ) -> AdminResult<()> {
        let stdin = input
            .map(std::fs::File::open)
            .transpose()
            .map_err(|_| failure(stage, "dump_unavailable", 3))?
            .map(Stdio::from)
            .unwrap_or_else(Stdio::null);
        let stdout = output
            .map(security::create_file)
            .transpose()?
            .map(Stdio::from)
            .unwrap_or_else(Stdio::null);
        let mut child = invocation
            .command()
            .stdin(stdin)
            .stdout(stdout)
            .stderr(Stdio::null())
            .spawn()
            .map_err(|_| failure(stage, "tool_unavailable", 2))?;
        let result = tokio::select! {
            _ = cancel.cancelled() => Err(failure(stage, "cancelled", 130)),
            result = tokio::time::timeout(Duration::from_secs(seconds), child.wait()) => result.map_err(|_| failure(stage, "operation_timeout", 3)).and_then(|result| result.map_err(|_| failure(stage, "tool_wait_failed", 3))),
        };
        match result {
            Ok(status) if status.success() => Ok(()),
            Ok(_) => Err(failure(stage, "tool_failed", 3)),
            Err(error) => {
                process::stop(&mut child).await;
                Err(error)
            }
        }
    }

    pub async fn create_destination(
        &self,
        name: &str,
        operation: Uuid,
        cancel: &CancellationToken,
    ) -> AdminResult<OwnedDatabase> {
        if !settings::identifier(name)
            || name == self.name
            || ["postgres", "template0", "template1"].contains(&name)
        {
            return Err(failure("restore", "unsafe_restore_destination", 2));
        }
        let marker = format!("mindleak-restore:{operation}");
        let sql = format!("CREATE DATABASE \"{name}\" TEMPLATE template0; COMMENT ON DATABASE \"{name}\" IS '{marker}'; SELECT oid::bigint FROM pg_database WHERE datname = '{name}';");
        let oid = self
            .query(&sql, cancel)
            .await?
            .as_u64()
            .ok_or_else(|| failure("restore", "destination_creation_not_acknowledged", 5))?;
        Ok(OwnedDatabase {
            name: name.into(),
            oid,
            marker,
        })
    }

    pub fn with_name(&self, name: &str) -> Self {
        let mut database = self.clone();
        database.name = name.into();
        database.env.insert("PGDATABASE".into(), name.into());
        database
    }

    pub async fn restore(&self, dump: &Path, cancel: &CancellationToken) -> AdminResult<()> {
        self.transfer(
            &self.tool("pg_restore").args([
                "--exit-on-error",
                "--no-owner",
                "--no-acl",
                "--no-password",
                "--username",
                &self.user,
                "--dbname",
                &self.name,
            ]),
            Some(dump),
            None,
            self.config.policy.restore_timeout_secs,
            cancel,
            "database_restore",
        )
        .await
    }

    pub async fn drop_owned(&self, owned: &OwnedDatabase) -> AdminResult<()> {
        let cancel = CancellationToken::new();
        let sql = format!("SELECT json_build_object('oid',oid::bigint,'marker',shobj_description(oid,'pg_database')) FROM pg_database WHERE datname='{}'", owned.name);
        let metadata = self.query(&sql, &cancel).await?;
        if metadata["oid"].as_u64() != Some(owned.oid)
            || metadata["marker"] != owned.marker
            || owned.name == self.name
        {
            return Err(failure("cleanup", "destination_ownership_mismatch", 5));
        }
        self.query(
            &format!("DROP DATABASE \"{}\"; SELECT to_json(true)", owned.name),
            &cancel,
        )
        .await?;
        Ok(())
    }

    pub async fn verify_mcp(
        &self,
        metadata: &Fingerprint,
        cancel: &CancellationToken,
    ) -> AdminResult<Value> {
        use rmcp::{model::CallToolRequestParams, transport::TokioChildProcess, ServiceExt};
        let mut invocation = if self.engine.inside_container {
            Invocation::new(&self.config.tools.container).args(["exec", "-i", "-w", "/", "-e", "MINDLEAK_DECOMPOSITION=sentences", "-e", "MINDLEAK_RETRIEVAL=keyword", "-e", "MINDLEAK_RELEVANCE=off", "-e",
                &format!("MINDLEAK_DATABASE_URL=host=/var/run/postgresql user={} dbname={} sslmode=disable", self.user, self.name), self.container.as_deref().unwrap(), "/usr/local/bin/mindleak-light", "--transport", "stdio", "--database-read-only"])
        } else {
            Invocation::new(self.engine_path()?).args([
                "--transport",
                "stdio",
                "--database-read-only",
            ])
        };
        let temporary = tempfile::Builder::new()
            .prefix("mcp-verify-")
            .tempdir_in(&self.config.work_dir)
            .map_err(|_| failure("verify", "verification_directory_failed", 5))?;
        invocation.cwd = Some(temporary.path().to_owned());
        if !self.engine.inside_container {
            let mut url = reqwest::Url::parse("postgresql://localhost/").unwrap();
            url.set_host(
                self.env
                    .get(std::ffi::OsStr::new("PGHOST"))
                    .and_then(|value| value.to_str()),
            )
            .map_err(|_| failure("verify", "invalid_restore_host", 5))?;
            url.set_port(
                self.env
                    .get(std::ffi::OsStr::new("PGPORT"))
                    .and_then(|value| value.to_str())
                    .and_then(|value| value.parse().ok()),
            )
            .map_err(|_| failure("verify", "invalid_restore_port", 5))?;
            url.set_username(&self.user)
                .map_err(|_| failure("verify", "invalid_restore_user", 5))?;
            url.set_password(
                self.env
                    .get(std::ffi::OsStr::new("PGPASSWORD"))
                    .and_then(|value| value.to_str()),
            )
            .map_err(|_| failure("verify", "invalid_restore_password", 5))?;
            url.set_path(&self.name);
            let ssl = self
                .env
                .get(std::ffi::OsStr::new("PGSSLMODE"))
                .and_then(|value| value.to_str())
                .unwrap_or("verify-full");
            url.query_pairs_mut().append_pair(
                "sslmode",
                if ssl == "disable" {
                    "disable"
                } else {
                    "require"
                },
            );
            invocation
                .env
                .insert("MINDLEAK_DATABASE_URL".into(), url.as_str().into());
            for (key, value) in [
                ("MINDLEAK_DECOMPOSITION", "sentences"),
                ("MINDLEAK_RETRIEVAL", "keyword"),
                ("MINDLEAK_RELEVANCE", "off"),
            ] {
                invocation.env.insert(key.into(), value.into());
            }
            if let Some(ca) = self.env.get(std::ffi::OsStr::new("PGSSLROOTCERT")) {
                invocation
                    .env
                    .insert("MINDLEAK_DATABASE_CA_FILE".into(), ca.clone());
            }
        }
        let mut command = invocation.command();
        command.stderr(Stdio::null());
        let transport = TokioChildProcess::new(command)
            .map_err(|_| failure("verify", "engine_start_failed", 5))?;
        let client = tokio::time::timeout(Duration::from_secs(30), ().serve(transport))
            .await
            .map_err(|_| failure("verify", "mcp_start_timeout", 5))?
            .map_err(|_| failure("verify", "mcp_start_failed", 5))?;
        let checks = async {
            let negotiated = serde_json::to_value(client.peer_info())
                .map_err(|_| failure("verify", "invalid_mcp_handshake", 5))?;
            if negotiated["serverInfo"]["version"] != env!("CARGO_PKG_VERSION")
                || negotiated["capabilities"]["tools"].is_null()
            {
                return Err(failure("verify", "mcp_capability_mismatch", 5));
            }
            let tools = client
                .list_all_tools()
                .await
                .map_err(|_| failure("verify", "mcp_tool_discovery_failed", 5))?;
            let mut names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
            names.sort();
            if names != ["decompose_memory", "recall_memory", "write_memory"] {
                return Err(failure("verify", "mcp_capability_mismatch", 5));
            }
            if let Some(canary) = &metadata.canary {
                let args = json!({"fragmentId":canary.fragment_id,"agentId":canary.agent_id,"scope":canary.scope});
                let result = client
                    .call_tool(
                        CallToolRequestParams::new("recall_memory")
                            .with_arguments(args.as_object().unwrap().clone()),
                    )
                    .await
                    .map_err(|_| failure("verify", "source_inspection_failed", 5))?;
                let value = result
                    .structured_content
                    .ok_or_else(|| failure("verify", "source_inspection_missing", 5))?;
                if result.is_error == Some(true)
                    || value["fragmentId"] != canary.fragment_id.to_string()
                    || value["rawText"]
                        .as_str()
                        .map(|text| security::hash(text.as_bytes()))
                        .as_deref()
                        != Some(&canary.raw_sha256)
                {
                    return Err(failure("verify", "source_inspection_mismatch", 5));
                }
                let query = canary
                    .query
                    .as_ref()
                    .ok_or_else(|| failure("verify", "searchable_canary_required", 5))?;
                let positive = json!({"query":query,"matchMode":"all","agentId":canary.agent_id,"scope":canary.scope,"limit":5});
                let positive = client
                    .call_tool(
                        CallToolRequestParams::new("recall_memory")
                            .with_arguments(positive.as_object().unwrap().clone()),
                    )
                    .await
                    .map_err(|_| failure("verify", "keyword_recall_failed", 5))?;
                let recalled = positive
                    .structured_content
                    .as_ref()
                    .and_then(|value| value["results"].as_array())
                    .ok_or_else(|| failure("verify", "keyword_recall_invalid", 5))?;
                if positive.is_error == Some(true)
                    || recalled.is_empty()
                    || recalled.iter().any(|value| {
                        value["agentId"] != canary.agent_id
                            || canary.scope.is_some()
                                && value["context"]["scope"] != json!(canary.scope)
                    })
                {
                    return Err(failure("verify", "keyword_recall_or_filter_mismatch", 5));
                }
                let negative = json!({"query":query,"matchMode":"all","agentId":format!("missing-{}",Uuid::new_v4()),"scope":canary.scope,"limit":5});
                let negative = client
                    .call_tool(
                        CallToolRequestParams::new("recall_memory")
                            .with_arguments(negative.as_object().unwrap().clone()),
                    )
                    .await
                    .map_err(|_| failure("verify", "negative_control_failed", 5))?;
                if negative.is_error == Some(true)
                    || negative
                        .structured_content
                        .as_ref()
                        .and_then(|value| value["results"].as_array())
                        .is_none_or(|results| !results.is_empty())
                {
                    return Err(failure("verify", "negative_filter_failed", 5));
                }
            } else {
                let result = client
                    .call_tool(CallToolRequestParams::new("recall_memory").with_arguments(
                        rmcp::object!({"query":"mindleak-empty-restore-control","limit":1}),
                    ))
                    .await
                    .map_err(|_| failure("verify", "empty_recall_failed", 5))?;
                if result.is_error == Some(true)
                    || result
                        .structured_content
                        .as_ref()
                        .and_then(|value| value["results"].as_array())
                        .is_none_or(|results| !results.is_empty())
                {
                    return Err(failure("verify", "empty_recall_mismatch", 5));
                }
            }
            Ok(
                json!({"capabilities":true,"sourceInspection":metadata.canary.is_some(),"keywordRecall":metadata.canary.is_some(),"negativeControl":true,"modelsEnabled":false,"databaseReadOnly":true}),
            )
        };
        let result = tokio::select! { _ = cancel.cancelled() => Err(failure("verify", "cancelled", 130)), result = tokio::time::timeout(Duration::from_secs(60), checks) => result.unwrap_or_else(|_| Err(failure("verify", "mcp_verification_timeout", 5))) };
        client
            .cancel()
            .await
            .map_err(|_| failure("verify", "mcp_cleanup_failed", 5))?;
        result
    }
}

pub(super) struct OwnedDatabase {
    pub name: String,
    oid: u64,
    marker: String,
}

impl Snapshot {
    fn new(mut child: Child) -> Self {
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        Self {
            child,
            input,
            output,
            id: String::new(),
            fingerprint: Fingerprint {
                records_sha256: String::new(),
                schema_sha256: String::new(),
                schema_components: BTreeMap::new(),
                database_settings: Value::Null,
                rows: BTreeMap::new(),
                postgres_version: String::new(),
                extensions: Value::Null,
                embedding_binding: None,
                database_bytes: 0,
                canary: None,
            },
        }
    }

    async fn line(&mut self, cancel: &CancellationToken) -> AdminResult<String> {
        let mut bytes = Vec::new();
        let mut reader = (&mut self.output).take(4 * 1024 * 1024 + 1);
        let size = tokio::select! { _ = cancel.cancelled() => return Err(failure("snapshot", "cancelled", 130)), read = reader.read_until(b'\n', &mut bytes) => read.map_err(|_| failure("snapshot", "snapshot_read_failed", 3))? };
        if size == 0 || size > 4 * 1024 * 1024 || bytes.last() != Some(&b'\n') {
            return Err(failure("snapshot", "snapshot_stream_invalid", 3));
        }
        String::from_utf8(bytes).map_err(|_| failure("snapshot", "snapshot_encoding_invalid", 3))
    }

    async fn initialize(&mut self, cancel: &CancellationToken) -> AdminResult<()> {
        let sql = concat!(include_str!("snapshot.sql"), "\n");
        self.input
            .write_all(sql.as_bytes())
            .await
            .map_err(|_| failure("snapshot", "snapshot_begin_failed", 3))?;
        let value: Value = serde_json::from_str(&self.line(cancel).await?)
            .map_err(|_| failure("snapshot", "snapshot_metadata_failed", 3))?;
        if value["tables"] != 3 {
            return Err(failure("snapshot", "unexpected_application_schema", 2));
        }
        self.id = value["snapshot"].as_str().unwrap_or_default().into();
        if self.id.is_empty()
            || !self
                .id
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() || byte == b'-')
        {
            return Err(failure("snapshot", "invalid_snapshot_id", 3));
        }
        self.fingerprint.postgres_version = value["version"].as_str().unwrap_or_default().into();
        self.fingerprint.database_bytes = value["bytes"].as_u64().unwrap_or_default();
        self.fingerprint.embedding_binding = value["binding"].as_str().map(str::to_owned);
        self.fingerprint.extensions = value["extensions"].clone();
        self.fingerprint.schema_sha256 =
            security::hash(serde_json::to_string(&value["schema"]).unwrap().as_bytes());
        self.fingerprint.schema_components = value["schema"]
            .as_object()
            .unwrap()
            .iter()
            .map(|(name, value)| {
                (
                    name.clone(),
                    security::hash(serde_json::to_string(value).unwrap().as_bytes()),
                )
            })
            .collect();
        self.fingerprint.database_settings = value["settings"].clone();
        self.fingerprint.canary = serde_json::from_value(value["canary"].clone())
            .map_err(|_| failure("snapshot", "invalid_canary_metadata", 3))?;
        let mut hash = Sha256::new();
        for (table, order) in [
            ("memories", "id"),
            ("fragments", "id"),
            (
                "relationships",
                "source_fragment,target_fragment,relationship_type",
            ),
        ] {
            let marker = format!("ML_END_{}", Uuid::new_v4().simple());
            self.input.write_all(format!("COPY (SELECT to_jsonb(records)::text FROM public.{table} records ORDER BY {order}) TO STDOUT; SELECT '{marker}';\n").as_bytes()).await.map_err(|_| failure("snapshot", "fingerprint_query_failed", 3))?;
            hash.update(table.as_bytes());
            let mut count = 0;
            loop {
                let line = self.line(cancel).await?;
                if line.trim_end() == marker {
                    break;
                }
                hash.update(line.as_bytes());
                count += 1;
            }
            self.fingerprint.rows.insert(table.into(), count);
        }
        self.fingerprint.records_sha256 = security::hex(&hash.finalize());
        Ok(())
    }

    pub async fn close(mut self) {
        process::stop(&mut self.child).await;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mindleak_memory::{
        EmbeddedFragment, MemoryContext, MemoryStore, MemoryTier, PreparedMemory,
    };
    use mindleak_storage_postgres::PostgresMemoryStore;

    #[tokio::test]
    #[ignore = "requires PostgreSQL 16 and MINDLEAK_BACKUP_TEST_CONTAINER"]
    async fn exported_snapshot_excludes_a_later_committed_write() {
        let url = std::env::var("MINDLEAK_TEST_DATABASE_URL").unwrap();
        let connection_config: tokio_postgres::Config = url.parse().unwrap();
        assert!(connection_config.get_dbname().unwrap().ends_with("_test"));
        let (admin, connection) = connection_config
            .connect(tokio_postgres::NoTls)
            .await
            .unwrap();
        tokio::spawn(async move {
            let _ = connection.await;
        });
        let name = format!("mindleak_capture_{}_test", Uuid::new_v4().simple());
        admin
            .batch_execute(&format!("CREATE DATABASE \"{name}\" TEMPLATE template0"))
            .await
            .unwrap();
        let mut source = reqwest::Url::parse(&url).unwrap();
        source.set_path(&name);
        let cleanup = format!("DROP DATABASE \"{name}\" WITH (FORCE)");
        let result = tokio::spawn(async move {
            let store = PostgresMemoryStore::connect(source.as_str(), None, 2, None).await.unwrap();
            let episode = || PreparedMemory { id: Uuid::new_v4(), agent_id: "coherent-capture".into(), raw_text: "A coherent fixture fact.".into(), context: MemoryContext::default(),
                fragments: vec![EmbeddedFragment { id: Uuid::new_v4(), text: "A coherent fixture fact.".into(), embedding: None, importance: 0.5, tier: MemoryTier::ShortTerm, pinned: false }], relationships: Vec::new(), request: None };
            store.save(&episode()).await.unwrap();
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            let container = std::env::var("MINDLEAK_BACKUP_TEST_CONTAINER").unwrap();
            let config: BackupConfig = serde_json::from_value(json!({"schemaVersion":1,"repository":{"kind":"local","path":root.join("repo"),"passwordFile":root.join("key")},"workDir":root,
                "tools":{"container":std::env::var("MINDLEAK_BACKUP_CONTAINER_TOOL").unwrap_or_else(|_| "docker".into())},"targets":[{"id":"fixture","container":container}]})).unwrap();
            let database = Database { config, container: Some(container), name, user: "mindleak_light".into(), env: BTreeMap::new(), identity: String::new(), image_id: None,
                engine: Engine { version: env!("CARGO_PKG_VERSION").into(), sha256: String::new(), inside_container: true } };
            let cancel = CancellationToken::new();
            let snapshot = database.snapshot(&cancel).await.unwrap();
            assert_eq!(snapshot.fingerprint.rows["memories"], 1);
            store.save(&episode()).await.unwrap();
            let dumped = database.dump(&snapshot, &root.join("database.dump"), &cancel).await;
            let original = snapshot.fingerprint.clone(); snapshot.close().await; dumped.unwrap();
            let current = database.snapshot(&cancel).await.unwrap();
            assert_eq!(current.fingerprint.rows["memories"], 2); current.close().await;
            let restored_name = format!("mindleak_capture_restore_{}_test", Uuid::new_v4().simple());
            let owned = database.create_destination(&restored_name, Uuid::new_v4(), &cancel).await.unwrap();
            let restored = database.with_name(&restored_name);
            let checked = async {
                restored.restore(&root.join("database.dump"), &cancel).await?;
                let snapshot = restored.snapshot(&cancel).await?;
                let matches = snapshot.fingerprint.matches(&original); snapshot.close().await;
                Ok::<_, super::super::Failure>(matches)
            }.await;
            database.drop_owned(&owned).await.unwrap();
            assert!(checked.unwrap(), "the dump must use the exported snapshot, not the later committed source state");
        }).await;
        admin.batch_execute(&cleanup).await.unwrap();
        result.unwrap();
    }
}
