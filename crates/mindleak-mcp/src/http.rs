use std::{sync::Arc, time::Duration};

use anyhow::{ensure, Result};
use axum::{
    extract::{Request, State},
    http::{header, StatusCode},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::get,
    Router,
};
use mindleak_storage_postgres::PostgresMemoryStore;
use rmcp::transport::streamable_http_server::{
    session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
};
use subtle::ConstantTimeEq;
use tokio_util::sync::CancellationToken;
use tower_http::{limit::RequestBodyLimitLayer, timeout::TimeoutLayer};

use crate::MemoryMcp;

pub fn http_router(
    server: MemoryMcp,
    store: PostgresMemoryStore,
    token: &str,
    cancellation: CancellationToken,
) -> Result<Router> {
    ensure!(
        token.len() >= 32 && token.is_ascii() && !token.chars().any(char::is_whitespace),
        "HTTP requires MINDLEAK_HTTP_TOKEN with at least 32 non-whitespace ASCII characters"
    );
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        LocalSessionManager::default().into(),
        StreamableHttpServerConfig::default()
            .with_legacy_session_mode(false)
            .with_json_response(true)
            .with_cancellation_token(cancellation),
    );
    Ok(Router::new()
        .nest_service("/mcp", service)
        .route(
            "/health",
            get(move || {
                let store = store.clone();
                async move {
                    match store.health().await {
                        Ok(()) => StatusCode::OK,
                        Err(_) => StatusCode::SERVICE_UNAVAILABLE,
                    }
                }
            }),
        )
        .layer(TimeoutLayer::with_status_code(
            StatusCode::REQUEST_TIMEOUT,
            Duration::from_secs(660),
        ))
        .layer(RequestBodyLimitLayer::new(256 * 1024))
        .layer(middleware::from_fn_with_state(
            Arc::<str>::from(token),
            authorize,
        )))
}

async fn authorize(State(token): State<Arc<str>>, request: Request, next: Next) -> Response {
    if request.headers().contains_key(header::ORIGIN) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let supplied = request
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .unwrap_or_default();
    if !bool::from(supplied.as_bytes().ct_eq(token.as_bytes())) {
        return (
            StatusCode::UNAUTHORIZED,
            [(header::WWW_AUTHENTICATE, "Bearer realm=\"mindleak-light\""),
             (header::CACHE_CONTROL, "no-store")],
            "HTTP credentials are missing or rejected. Use the current configured bearer token, or use the local stdio launcher. MindLeak does not provide OAuth client registration. Cancel unexpected registration dialogs.",
        ).into_response();
    }
    next.run(request).await
}
