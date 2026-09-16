use std::sync::Arc;

use anyhow::Result;
use async_trait::async_trait;
use mindleak_memory::{
    MemoryDecomposer, MemoryRetriever, MemoryStore, PreparedMemory, RecallMatch, TextEmbedder,
};
use rmcp::{model::CallToolRequestParams, ServiceExt};
use uuid::Uuid;

use super::*;

struct Backend;

#[async_trait]
impl MemoryDecomposer for Backend {
    async fn decompose(&self, text: &str) -> Result<Vec<String>> {
        anyhow::ensure!(
            text != "provider failure",
            "decomposition provider unavailable"
        );
        Ok(vec!["User prefers PRs under 500 LOC".into()])
    }
}

#[async_trait]
impl TextEmbedder for Backend {
    fn dimensions(&self) -> usize {
        2
    }
    async fn embed_batch(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(vec![vec![1.0, 0.0]])
    }
}

#[async_trait]
impl MemoryStore for Backend {
    async fn save(&self, memory: &PreparedMemory) -> Result<()> {
        assert_eq!(memory.agent_id, "claude");
        assert_eq!(memory.fragments.len(), 1);
        Ok(())
    }
}

#[async_trait]
impl MemoryRetriever for Backend {
    async fn recall(
        &self,
        _query: &str,
        _agent_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        assert_eq!(limit, 10);
        Ok(vec![RecallMatch {
            memory_id: Uuid::nil(),
            fragment_id: Uuid::nil(),
            agent_id: "claude".into(),
            text: "User prefers PRs under 500 LOC".into(),
            score: 0.92,
        }])
    }
}

#[tokio::test]
async fn mcp_handshake_tools_and_all_three_calls_match_the_contract() {
    let backend = Arc::new(Backend);
    let memory = MemoryService::new(backend.clone(), backend.clone(), backend.clone(), backend);
    let (client_io, server_io) = tokio::io::duplex(16_384);
    let (server, client) =
        tokio::join!(MemoryMcp::new(memory).serve(server_io), ().serve(client_io));
    let server = server.unwrap();
    let client = client.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    let mut names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    names.sort();
    assert_eq!(names, ["decompose_memory", "recall_memory", "write_memory"]);
    let write = tools
        .iter()
        .find(|tool| tool.name == "write_memory")
        .unwrap();
    assert!(write.input_schema["properties"].get("agentId").is_some());
    assert_eq!(
        write.annotations.as_ref().unwrap().idempotent_hint,
        Some(false)
    );
    for (name, arguments) in [
        (
            "write_memory",
            json!({"agentId": "claude", "text": "Keep PRs small"}),
        ),
        ("recall_memory", json!({"query": "PR preferences?"})),
        ("decompose_memory", json!({"text": "Keep PRs small"})),
    ] {
        let result = client
            .call_tool(
                CallToolRequestParams::new(name)
                    .with_arguments(arguments.as_object().unwrap().clone()),
            )
            .await
            .unwrap();
        assert_ne!(result.is_error, Some(true));
        let structured = result.structured_content.unwrap();
        if name == "write_memory" {
            assert!(Uuid::parse_str(structured["memoryId"].as_str().unwrap()).is_ok());
        } else {
            assert_eq!(structured["results"].as_array().unwrap().len(), 1);
        }
    }
    let failed = client
        .call_tool(
            CallToolRequestParams::new("decompose_memory")
                .with_arguments(rmcp::object!({"text": "provider failure"})),
        )
        .await
        .unwrap();
    assert_eq!(failed.is_error, Some(true));
    assert!(client
        .call_tool(
            CallToolRequestParams::new("write_memory")
                .with_arguments(rmcp::object!({"agentId": "claude", "text": " "}))
        )
        .await
        .is_err());
    client.cancel().await.unwrap();
    server.waiting().await.unwrap();
}
