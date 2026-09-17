use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

use anyhow::{ensure, Context, Result};
use reqwest_mcp::{
    header::{HeaderMap, HeaderName, HeaderValue, AUTHORIZATION},
    Url,
};
use rmcp::{
    service::RunningService,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
    },
    RoleClient, ServiceExt,
};
use serde_json::{json, Value};
use tokio::{
    process::Command,
    time::{timeout, timeout_at, Instant},
};

fn environment(name: &str) -> Result<String> {
    ensure!(
        !name.is_empty()
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_'),
        "Invalid environment variable name"
    );
    std::env::var(name).ok().filter(|value| !value.is_empty()).context("A required environment variable is unset; supply it to this process without putting secrets in instructions")
}

fn expand(value: &str, root: &Path) -> Result<String> {
    let mut remaining = value;
    let mut result = String::new();
    while let Some((prefix, variable)) = remaining.split_once("${") {
        result.push_str(prefix);
        let (name, suffix) = variable
            .split_once('}')
            .context("Unclosed client variable reference")?;
        if name == "workspaceFolder" {
            result.push_str(root.to_str().context("Workspace path is not UTF-8")?);
        } else {
            ensure!(!name.starts_with("input:"), "Client secret input is unresolved; use --token-env NAME for the HTTP bearer token or check through the client. No development-token fallback is used");
            result.push_str(&environment(name.strip_prefix("env:").unwrap_or(name))?);
        }
        remaining = suffix;
    }
    result.push_str(remaining);
    Ok(result)
}

fn http(root: &Path, entry: &Value, token_env: Option<&str>) -> Result<(Url, HeaderMap)> {
    ensure!(
        entry.get("command").is_none(),
        "Ambiguous server entry contains both command and URL"
    );
    ensure!(
        entry.get("type").is_none_or(|value| value == "http"),
        "Only Streamable HTTP and stdio connections are supported"
    );
    let endpoint = expand(
        entry["url"].as_str().context("HTTP URL must be a string")?,
        root,
    )?;
    let url = Url::parse(&endpoint).map_err(|_| anyhow::anyhow!("Invalid configured MCP URL"))?;
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "MCP URL must not contain credentials, a query, or a fragment; use secret-backed headers"
    );
    let loopback = url.host_str().is_some_and(|host| {
        host == "localhost"
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    ensure!(
        url.scheme() == "https" || (url.scheme() == "http" && loopback),
        "Non-loopback MCP connections require HTTPS"
    );
    let bearer = token_env
        .or_else(|| entry["bearer_token_env_var"].as_str())
        .map(environment)
        .transpose()?;
    let mut headers = HeaderMap::new();
    for field in ["headers", "http_headers", "env_http_headers"] {
        let Some(values) = entry.get(field) else {
            continue;
        };
        for (name, value) in values
            .as_object()
            .context("HTTP headers must be an object")?
        {
            if bearer.is_some() && name.eq_ignore_ascii_case("authorization") {
                continue;
            }
            let name = HeaderName::from_bytes(name.as_bytes())
                .map_err(|_| anyhow::anyhow!("Invalid HTTP header name"))?;
            let value = value
                .as_str()
                .context("HTTP header values must be strings")?;
            let expanded = if field == "env_http_headers" {
                environment(value)?
            } else {
                expand(value, root)?
            };
            let mut value = HeaderValue::from_str(&expanded)
                .map_err(|_| anyhow::anyhow!("Invalid HTTP header value"))?;
            value.set_sensitive(true);
            ensure!(
                !headers.contains_key(&name),
                "Duplicate configured HTTP header"
            );
            headers.insert(name, value);
        }
    }
    if let Some(token) = bearer {
        ensure!(
            token.len() >= 32 && token.is_ascii() && !token.chars().any(char::is_whitespace),
            "HTTP token must contain at least 32 non-whitespace ASCII characters"
        );
        let mut value = HeaderValue::from_str(&format!("Bearer {token}"))
            .map_err(|_| anyhow::anyhow!("Invalid HTTP token"))?;
        value.set_sensitive(true);
        headers.insert(AUTHORIZATION, value);
    }
    Ok((url, headers))
}

fn stdio(root: &Path, entry: &Value) -> Result<Command> {
    ensure!(
        entry.get("type").is_none_or(|value| value == "stdio"),
        "Unsupported MCP transport type"
    );
    ensure!(entry.get("envFile").is_none(), "The connection check does not load envFile; supply the same environment explicitly or verify this connection in its client");
    let program = expand(
        entry["command"]
            .as_str()
            .context("Stdio command must be a string")?,
        root,
    )?;
    ensure!(!program.is_empty(), "Stdio command is empty");
    let mut command = Command::new(program);
    command
        .current_dir(root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true);
    if let Some(arguments) = entry.get("args") {
        for argument in arguments
            .as_array()
            .context("Stdio args must be an array")?
        {
            command.arg(expand(
                argument.as_str().context("Stdio args must be strings")?,
                root,
            )?);
        }
    }
    if let Some(directory) = entry.get("cwd") {
        let directory = PathBuf::from(expand(
            directory.as_str().context("Stdio cwd must be a string")?,
            root,
        )?);
        command.current_dir(if directory.is_absolute() {
            directory
        } else {
            root.join(directory)
        });
    }
    if let Some(variables) = entry.get("env") {
        for (name, value) in variables
            .as_object()
            .context("Stdio env must be an object")?
        {
            if value.is_null() {
                command.env_remove(name);
            } else {
                command.env(
                    name,
                    expand(
                        value
                            .as_str()
                            .context("Stdio env values must be strings or null")?,
                        root,
                    )?,
                );
            }
        }
    }
    if let Some(variables) = entry.get("env_vars") {
        for name in variables.as_array().context("env_vars must be an array")? {
            let name = name.as_str().context("env_vars entries must be strings")?;
            command.env(name, environment(name)?);
        }
    }
    Ok(command)
}

async fn discover(service: RunningService<RoleClient, ()>, deadline: Instant) -> Result<Value> {
    let result = timeout_at(deadline, async {
        let info = service.peer_info().context("Server returned no initialization information")?;
        let implementation = info.server_info.as_ref().context("Server returned no application identity")?;
        ensure!(implementation.name == "mindleak-light", "Selected MCP server is not MindLeak Light");
        let version = &implementation.version;
        ensure!(version.len() <= 64 && version.bytes().all(|byte| byte.is_ascii_alphanumeric() || b".+-".contains(&byte)), "Invalid server version metadata");
        let result = service.list_tools(None).await.map_err(|_| anyhow::anyhow!("MCP tool discovery failed"))?;
        ensure!(result.next_cursor.is_none() && result.tools.len() == 3, "MindLeak must advertise exactly its three memory tools");
        for (name, fields) in [
            ("write_memory", &["agentId", "text", "requestId", "context", "facts"][..]),
            ("recall_memory", &["query", "scope", "fragmentId", "after", "matchMode", "diagnostics", "contextLimit", "groupDuplicates"][..]),
            ("decompose_memory", &["text"][..]),
        ] {
            let tool = result.tools.iter().find(|tool| tool.name == name).context("A required memory tool is missing")?;
            let properties = tool.input_schema.get("properties").and_then(Value::as_object).context("Tool schema has no properties")?;
            ensure!(fields.iter().all(|field| properties.contains_key(*field)), "Server tool schema predates the installed workflow; upgrade the intended server explicitly");
        }
        Ok(json!({"status": "verified", "serverVersion": version, "tools": ["write_memory", "recall_memory", "decompose_memory"], "memoryCalls": 0}))
    }).await.map_err(|_| anyhow::anyhow!("MCP discovery timed out")).and_then(|result| result);
    let closed = timeout(Duration::from_secs(5), service.cancel()).await;
    ensure!(
        matches!(closed, Ok(Ok(_))),
        "MCP connection did not close cleanly"
    );
    result
}

pub(super) async fn check(root: &Path, entry: &Value, token_env: Option<&str>) -> Result<Value> {
    let deadline = Instant::now() + Duration::from_secs(15);
    if entry.get("url").is_some() {
        let (url, headers) = http(root, entry, token_env)?;
        let _ = rustls::crypto::ring::default_provider().install_default();
        let client = reqwest_mcp::Client::builder()
            .default_headers(headers)
            .redirect(reqwest_mcp::redirect::Policy::none())
            .connect_timeout(Duration::from_secs(5))
            .timeout(Duration::from_secs(15))
            .build()
            .map_err(|_| anyhow::anyhow!("Cannot initialize the TLS-enabled MCP client"))?;
        let transport = StreamableHttpClientTransport::with_client(
            client,
            StreamableHttpClientTransportConfig::with_uri(url.as_str()),
        );
        let service = timeout_at(deadline, ().serve(transport)).await.map_err(|_| anyhow::anyhow!("MCP connection timed out"))?
            .map_err(|_| anyhow::anyhow!("HTTP MCP handshake failed; check the endpoint, TLS trust and matching bearer token"))?;
        discover(service, deadline).await
    } else {
        ensure!(
            token_env.is_none(),
            "--token-env applies only to HTTP connections"
        );
        let mut child = stdio(root, entry)?.spawn().map_err(|_| {
            anyhow::anyhow!(
                "Cannot start the configured stdio command; check its path and permissions"
            )
        })?;
        let input = child.stdout.take().context("Cannot capture MCP stdout")?;
        let output = child.stdin.take().context("Cannot capture MCP stdin")?;
        let result = async {
            let service = timeout_at(deadline, ().serve((input, output))).await.map_err(|_| anyhow::anyhow!("MCP stdio handshake timed out"))?
                .map_err(|_| anyhow::anyhow!("MCP stdio handshake failed; check the configured executable and environment"))?;
            discover(service, deadline).await
        }.await;
        if child.try_wait()?.is_none() {
            child
                .kill()
                .await
                .context("Cannot stop the connection-check child process")?;
        }
        child
            .wait()
            .await
            .context("Cannot reap the connection-check child process")?;
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rmcp::{
        model::{
            Implementation, ListToolsResult, PaginatedRequestParams, ServerCapabilities,
            ServerConfig, Tool,
        },
        service::RequestContext,
        ErrorData, RoleServer, ServerHandler,
    };

    #[test]
    fn http_refuses_unsafe_endpoints_and_unresolved_secrets() {
        for url in [
            "http://example.com/mcp",
            "http://user:private@127.0.0.1/mcp",
            "https://example.com/mcp?token=private",
        ] {
            let error = http(Path::new("/project"), &json!({"url":url}), None)
                .unwrap_err()
                .to_string();
            assert!(!error.contains("private"));
        }
        let error = http(Path::new("/project"), &json!({"url":"http://127.0.0.1/mcp", "headers":{"Authorization":"Bearer ${input:token}"}}), None).unwrap_err().to_string();
        assert!(error.contains("--token-env"));
    }

    #[derive(Clone)]
    struct Discovery {
        name: &'static str,
        tool_count: usize,
        scoped: bool,
    }

    impl ServerHandler for Discovery {
        fn get_info(&self) -> ServerConfig {
            let mut config =
                ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
            config.server_info = Implementation::new(self.name, "0.4.0");
            config
        }

        async fn list_tools(
            &self,
            _: Option<PaginatedRequestParams>,
            _: RequestContext<RoleServer>,
        ) -> Result<ListToolsResult, ErrorData> {
            let mut properties: serde_json::Map<_, _> = [
                "agentId",
                "text",
                "requestId",
                "context",
                "facts",
                "query",
                "scope",
                "fragmentId",
                "after",
                "matchMode",
                "diagnostics",
                "contextLimit",
                "groupDuplicates",
            ]
            .into_iter()
            .map(|field| (field.to_owned(), json!({})))
            .collect();
            if !self.scoped {
                properties.remove("scope");
            }
            let tools: Vec<Tool> = [
                "write_memory",
                "recall_memory",
                "decompose_memory",
                "unrelated_tool",
            ]
            .into_iter()
            .take(self.tool_count)
            .map(|name| {
                serde_json::from_value(
                    json!({"name":name,"inputSchema":{"type":"object","properties":properties}}),
                )
                .unwrap()
            })
            .collect();
            Ok(ListToolsResult::with_all_items(tools))
        }
    }

    #[tokio::test]
    async fn connection_check_uses_the_sdk_and_rejects_other_products() {
        use rmcp::transport::streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
        };
        for (name, tool_count, scoped, expected_error) in [
            ("mindleak-light", 3, true, None),
            ("other-memory-product", 3, true, Some("not MindLeak")),
            ("mindleak-light", 2, true, Some("exactly its three")),
            ("mindleak-light", 4, true, Some("exactly its three")),
            (
                "mindleak-light",
                3,
                false,
                Some("predates the installed workflow"),
            ),
        ] {
            let service = StreamableHttpService::new(
                move || {
                    Ok(Discovery {
                        name,
                        tool_count,
                        scoped,
                    })
                },
                LocalSessionManager::default().into(),
                StreamableHttpServerConfig::default()
                    .with_legacy_session_mode(false)
                    .with_json_response(true),
            );
            let app = axum::Router::new().nest_service("/mcp", service);
            let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
            let address = listener.local_addr().unwrap();
            let server = tokio::spawn(async move {
                axum::serve(listener, app).await.unwrap();
            });
            let result = check(
                Path::new("/project"),
                &json!({"url":format!("http://{address}/mcp")}),
                None,
            )
            .await;
            server.abort();
            match expected_error {
                Some(message) => assert!(result.unwrap_err().to_string().contains(message)),
                None => assert_eq!(result.unwrap()["memoryCalls"], 0),
            }
        }
    }
}
