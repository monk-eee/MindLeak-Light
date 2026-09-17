use std::{net::SocketAddr, process::Stdio, time::Duration};

use anyhow::{ensure, Result};
use axum::{
    extract::{ConnectInfo, Request, State},
    http::{header, HeaderMap, StatusCode},
    middleware::{self, Next},
    response::Response,
    Router,
};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, ClientRequest, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, ServerResult,
    },
    service::{PeerRequestOptions, RequestContext},
    transport::{
        streamable_http_server::{
            session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
        },
        TokioChildProcess,
    },
    ErrorData, Peer, RoleClient, RoleServer, ServerHandler, ServiceExt,
};
use tokio_util::sync::CancellationToken;
use tower_http::{limit::RequestBodyLimitLayer, timeout::TimeoutLayer};

pub fn validate_listener(listen: SocketAddr, explicit: bool, supported_host: bool) -> Result<()> {
    ensure!(explicit, "Local HTTP requires --allow-unauthenticated-loopback. Prefer local connect for credential-free stdio.");
    ensure!(supported_host, "Unauthenticated HTTP is supported only by the native macOS/Windows launcher, never the Linux/container executable. Use stdio or authenticated HTTP here.");
    ensure!(listen.ip().is_loopback(), "Unauthenticated HTTP requires a literal loopback listen address. Shared/network HTTP requires bearer authentication and TLS.");
    Ok(())
}

fn allowed(headers: &HeaderMap, peer: Option<SocketAddr>, listen: SocketAddr) -> bool {
    peer.is_some_and(|peer| peer.ip().is_loopback())
        && headers.get_all(header::HOST).iter().count() == 1
        && headers
            .get(header::HOST)
            .and_then(|host| host.to_str().ok())
            == Some(listen.to_string().as_str())
        && !headers.keys().any(|name| {
            name == header::ORIGIN
                || name == header::VIA
                || name.as_str() == "forwarded"
                || name.as_str().starts_with("x-forwarded-")
        })
}

async fn guard(
    State(listen): State<SocketAddr>,
    request: Request,
    next: Next,
) -> Result<Response, StatusCode> {
    let peer = request
        .extensions()
        .get::<ConnectInfo<SocketAddr>>()
        .map(|peer| peer.0);
    if !allowed(request.headers(), peer, listen) {
        return Err(StatusCode::FORBIDDEN);
    }
    Ok(next.run(request).await)
}

#[derive(Clone)]
struct Bridge {
    peer: Peer<RoleClient>,
    config: ServerConfig,
}

impl Bridge {
    async fn forward(
        &self,
        request: ClientRequest,
        context: RequestContext<RoleServer>,
    ) -> Result<ServerResult, ErrorData> {
        let mut handle = self
            .peer
            .send_cancellable_request(request, PeerRequestOptions::default())
            .await
            .map_err(|_| {
                ErrorData::internal_error(
                    "Local container connection unavailable; run local status.",
                    None,
                )
            })?;
        tokio::select! {
            biased;
            _ = context.ct.cancelled() => {
                let _ = handle.cancel(None).await;
                Err(ErrorData::internal_error("memory operation cancelled", None))
            }
            result = tokio::time::timeout(Duration::from_secs(650), &mut handle.rx) => {
                match result {
                    Ok(Ok(Ok(result))) => Ok(result),
                    Ok(Ok(Err(rmcp::ServiceError::McpError(error)))) => Err(error),
                    Ok(_) => Err(ErrorData::internal_error("Local container connection failed; run local status.", None)),
                    Err(_) => {
                        let _ = handle.cancel(None).await;
                        Err(ErrorData::internal_error("Local memory operation timed out.", None))
                    }
                }
            }
        }
    }
}

impl ServerHandler for Bridge {
    fn get_info(&self) -> ServerConfig {
        self.config.clone()
    }

    async fn list_tools(
        &self,
        params: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        let request = rmcp::model::ListToolsRequest {
            method: Default::default(),
            params,
            extensions: Default::default(),
        };
        match self.forward(request.into(), context).await? {
            ServerResult::ListToolsResult(result) => Ok(result),
            _ => Err(ErrorData::internal_error(
                "Unexpected local tool-list response.",
                None,
            )),
        }
    }

    async fn call_tool(
        &self,
        params: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        let request = rmcp::model::CallToolRequest::new(params);
        match self.forward(request.into(), context).await? {
            ServerResult::CallToolResult(result) => Ok(CallToolResponse::Complete(result)),
            _ => Err(ErrorData::internal_error(
                "Unexpected local tool response.",
                None,
            )),
        }
    }
}

pub async fn serve(mut command: tokio::process::Command, listen: SocketAddr) -> Result<()> {
    command.stderr(Stdio::null());
    let transport = TokioChildProcess::new(command)
        .map_err(|_| anyhow::anyhow!("Cannot attach the local HTTP bridge to Docker/stdio."))?;
    let upstream = tokio::time::timeout(Duration::from_secs(30), ().serve(transport))
        .await
        .map_err(|_| anyhow::anyhow!("Local MCP initialization timed out; run local status."))?
        .map_err(|_| anyhow::anyhow!("Local MCP initialization failed; run local status."))?;
    let info = upstream.peer_info().ok_or_else(|| {
        anyhow::anyhow!("The local container returned no MCP server information.")
    })?;
    let mut config = ServerConfig::new(ServerCapabilities::builder().enable_tools().build());
    if let Some(server_info) = info.server_info.clone() {
        config.server_info = server_info;
    }
    config.instructions = info.instructions.clone();
    let server = Bridge {
        peer: upstream.peer().clone(),
        config,
    };
    let cancellation = CancellationToken::new();
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_cancellation_token(cancellation.clone()),
    );
    let listener = tokio::net::TcpListener::bind(listen).await.map_err(|_| {
        anyhow::anyhow!(
            "Cannot bind the local HTTP port. Choose another loopback port with --listen."
        )
    })?;
    let listen = listener.local_addr()?;
    let router = Router::new()
        .nest_service("/mcp", service)
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(660),
        ))
        .layer(RequestBodyLimitLayer::new(256 * 1024))
        .layer(middleware::from_fn_with_state(listen, guard));
    eprintln!("Local-only HTTP: http://{listen}/mcp. No bearer token. Do not proxy, tunnel or forward this port; use authenticated HTTP for sharing.");
    let result = axum::serve(
        listener,
        router.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        cancellation.cancel();
    })
    .await;
    let _ = upstream.cancel().await;
    result.map_err(|_| anyhow::anyhow!("The local HTTP bridge stopped unexpectedly."))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn local_http_requires_explicit_host_loopback_and_refuses_every_container_build() {
        let listen = "127.0.0.1:8090".parse().unwrap();
        assert!(validate_listener(listen, true, true).is_ok());
        assert!(validate_listener(listen, false, true).is_err());
        assert!(validate_listener(listen, true, false).is_err());
        for address in ["0.0.0.0:8090", "[::]:8090", "192.168.1.2:8090"] {
            assert!(validate_listener(address.parse().unwrap(), true, true).is_err());
        }
    }

    #[test]
    fn local_http_rejects_origins_forwarding_rebinding_and_nonlocal_peers() {
        let listen = "127.0.0.1:8090".parse().unwrap();
        let peer = Some("127.0.0.1:50000".parse().unwrap());
        let mut headers = HeaderMap::new();
        headers.insert(header::HOST, "127.0.0.1:8090".parse().unwrap());
        assert!(allowed(&headers, peer, listen));
        assert!(!allowed(&headers, None, listen));
        assert!(!allowed(
            &headers,
            Some("192.168.1.2:50000".parse().unwrap()),
            listen
        ));
        for name in [
            "origin",
            "forwarded",
            "x-forwarded-for",
            "x-forwarded-host",
            "via",
        ] {
            let mut forwarded = headers.clone();
            forwarded.insert(name, "canary".parse().unwrap());
            assert!(!allowed(&forwarded, peer, listen));
        }
        for host in ["attacker.invalid:8090", "localhost:8090", "127.0.0.1:8088"] {
            headers.insert(header::HOST, host.parse().unwrap());
            assert!(!allowed(&headers, peer, listen));
        }
    }
}
