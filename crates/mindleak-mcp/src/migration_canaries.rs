use std::{
    collections::BTreeMap,
    fs::File,
    io::Read,
    path::Path,
    sync::atomic::{AtomicUsize, Ordering},
    time::{Duration, Instant},
};

use anyhow::{anyhow, ensure, Result};
use mindleak_mcp::{MemoryMcp, RecallMemoryInput};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use serde::Deserialize;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct CanarySuite {
    version: u32,
    cases: Vec<Canary>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Canary {
    arguments: Map<String, Value>,
    expected: BTreeMap<String, Value>,
}

impl CanarySuite {
    pub(super) fn load(path: &Path) -> Result<Self> {
        let mut bytes = Vec::new();
        File::open(path)
            .map_err(|_| anyhow!("cannot open migration canaries"))?
            .take(65_537)
            .read_to_end(&mut bytes)
            .map_err(|_| anyhow!("cannot read migration canaries"))?;
        ensure!(
            bytes.len() <= 65_536,
            "migration canary manifest exceeds 65536 bytes"
        );
        let suite: Self = serde_json::from_slice(&bytes)
            .map_err(|_| anyhow!("invalid migration canary manifest"))?;
        ensure!(
            suite.version == 1 && (1..=128).contains(&suite.cases.len()),
            "migration canaries require version 1 and 1..=128 cases"
        );
        for case in &suite.cases {
            ensure!(
                (1..=128).contains(&case.expected.len())
                    && case.expected.keys().all(|pointer| pointer.starts_with('/')),
                "migration canaries require 1..=128 JSON pointer assertions per case"
            );
            serde_json::from_value::<RecallMemoryInput>(Value::Object(case.arguments.clone()))
                .map_err(|_| anyhow!("invalid recall arguments in migration canaries"))?;
        }
        Ok(suite)
    }

    pub(super) async fn verify(&self, server: MemoryMcp) -> Result<()> {
        let started = Instant::now();
        let completed = AtomicUsize::new(0);
        let result =
            tokio::time::timeout(Duration::from_secs(60), self.execute(server, &completed)).await;
        let reason = match result {
            Ok(Ok(())) => None,
            Err(_) => Some("deadline"),
            Ok(Err(error)) => Some(match error.to_string().as_str() {
                "canary server handshake failed" | "canary client handshake failed" => "handshake",
                "canary recall failed" => "recall",
                "canary result missing" => "missing_result",
                "canary assertion failed" => "assertion",
                "canary client shutdown failed" | "canary server shutdown failed" => "shutdown",
                _ => "internal",
            }),
        };
        if let Some(reason) = reason {
            return Err(anyhow!(
                "migration_id=runtime phase=canaries completed_rows={} elapsed_ms={} timeout_ms=60000 sqlstate=none reason={reason}: retrieval verification failed",
                completed.load(Ordering::Relaxed), started.elapsed().as_millis()
            ));
        }
        tracing::info!(
            migration_id = "runtime",
            phase = "canaries",
            completed_rows = completed.load(Ordering::Relaxed),
            elapsed_ms = started.elapsed().as_millis() as u64,
            timeout_ms = 60_000,
            "retrieval canaries passed before readiness"
        );
        Ok(())
    }

    async fn execute(&self, server: MemoryMcp, completed: &AtomicUsize) -> Result<()> {
        let cancellation = CancellationToken::new();
        let _guard = cancellation.clone().drop_guard();
        let (client_transport, server_transport) = tokio::io::duplex(65_536);
        let (server, client) = tokio::try_join!(
            async {
                server
                    .serve_with_ct(server_transport, cancellation.child_token())
                    .await
                    .map_err(|_| anyhow!("canary server handshake failed"))
            },
            async {
                ().serve_with_ct(client_transport, cancellation.child_token())
                    .await
                    .map_err(|_| anyhow!("canary client handshake failed"))
            },
        )?;
        for case in &self.cases {
            let response = client
                .call_tool(
                    CallToolRequestParams::new("recall_memory")
                        .with_arguments(case.arguments.clone()),
                )
                .await
                .map_err(|_| anyhow!("canary recall failed"))?;
            ensure!(response.is_error != Some(true), "canary recall failed");
            let content = response
                .structured_content
                .ok_or_else(|| anyhow!("canary result missing"))?;
            ensure!(
                case.expected
                    .iter()
                    .all(|(pointer, expected)| content.pointer(pointer) == Some(expected)),
                "canary assertion failed"
            );
            completed.fetch_add(1, Ordering::Relaxed);
        }
        client
            .cancel()
            .await
            .map_err(|_| anyhow!("canary client shutdown failed"))?;
        server
            .cancel()
            .await
            .map_err(|_| anyhow!("canary server shutdown failed"))?;
        Ok(())
    }
}
