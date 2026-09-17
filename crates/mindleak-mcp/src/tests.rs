use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use anyhow::Result;
use async_trait::async_trait;
use mindleak_memory::{
    MemoryDecomposer, MemoryRetriever, MemoryStore, PreparedMemory, RecallMatch, TextEmbedder,
    WriteMemoryResult, WriteRequest,
};
use rmcp::{
    model::{CallToolRequest, CallToolRequestParams},
    service::PeerRequestOptions,
    ServiceExt,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use super::*;

#[test]
fn chain_proposal_is_an_explicit_extension_of_legacy_write_input() {
    let legacy = json!({"agentId":"test-agent", "text":"An observed result."});
    assert!(serde_json::from_value::<WriteMemoryInput>(legacy.clone()).is_ok());
    let mut proposal = legacy;
    proposal["requestId"] = json!(Uuid::new_v4());
    proposal["chain"] = json!({
        "operation":"propose", "chainId":Uuid::new_v4(),
        "document": {
            "claim":"Selective retrieval can reduce input tokens for this task.",
            "rationale":"The recorded comparison held answer correctness constant.",
            "conclusion":"Use the measured retrieval strategy for this workload.",
            "applicability":"The recorded task and model configuration only.",
            "assumptions":["The source comparison used equivalent tasks."],
            "evidence":[{"fragmentId":Uuid::new_v4(), "role":"supports", "reason":"Measured task outcome."}]
        }
    });
    assert!(serde_json::from_value::<WriteMemoryInput>(proposal).is_ok());
}

#[test]
fn chain_inspection_and_search_are_explicit_recall_modes() {
    for input in [
        json!({"query":"reviews", "limit":5}),
        json!({"chain":{"operation":"inspect", "chainId":Uuid::new_v4()}, "limit":5}),
        json!({"chain":{"operation":"search", "query":"reviews"}, "limit":5}),
    ] {
        assert!(serde_json::from_value::<RecallMemoryInput>(input).is_ok());
    }
}

#[test]
fn principles_are_typed_knowledge_with_explicit_chain_lineage() {
    let input = json!({
        "agentId":"test-agent", "text":"Candidate principle from two controlled chains.",
        "requestId":Uuid::new_v4(),
        "chain": {
            "operation":"propose", "chainId":Uuid::new_v4(),
            "document": {
                "kind":"principle", "claim":"Selective retrieval helps matching tasks.",
                "rationale":"Two validated comparisons support the restricted generalization.",
                "conclusion":"Prefer the tested strategy under these conditions.",
                "applicability":"Tasks equivalent to the referenced comparisons.",
                "assumptions":[], "evidence":[],
                "supportedBy":[
                    {"chainId":Uuid::new_v4(),"revision":2,"reason":"First validated comparison."},
                    {"chainId":Uuid::new_v4(),"revision":4,"reason":"Second validated comparison."}
                ]
            }
        }
    });
    assert!(serde_json::from_value::<WriteMemoryInput>(input).is_ok());
}

#[test]
fn formation_is_an_explicit_alternative_to_legacy_decomposition() {
    assert!(
        serde_json::from_value::<DecomposeMemoryInput>(json!({"text":"An observation."})).is_ok()
    );
    assert!(serde_json::from_value::<DecomposeMemoryInput>(json!({
        "text":"What do these measured comparisons support?",
        "formation":{"kind":"chain","fragmentIds":[Uuid::new_v4()],"scope":"synthetic:formation"}
    }))
    .is_ok());
}

#[test]
fn knowledge_retrieval_review_and_export_are_explicit_read_modes() {
    for operation in [
        json!({"operation":"search","query":"controlled retrieval"}),
        json!({"operation":"review"}),
        json!({"operation":"dependents","chainId":Uuid::new_v4()}),
        json!({"operation":"export","chainId":Uuid::new_v4(),"format":"markdown"}),
    ] {
        assert!(serde_json::from_value::<RecallMemoryInput>(
            json!({"knowledge":operation,"limit":3})
        )
        .is_ok());
    }
}

#[test]
fn knowledge_search_controls_are_explicit_and_legacy_inputs_remain_valid() {
    for input in [
        json!({"query":"report export", "limit":5}),
        json!({"knowledge":{"operation":"search","query":"report export"}}),
        json!({"knowledge":{"operation":"search","query":"report-export","view":"compact","matchMode":"all","diagnostics":true,"costDiagnostics":true}}),
        json!({"chain":{"operation":"search","query":"report export","matchMode":"any","diagnostics":true,"costDiagnostics":true}}),
        json!({"knowledge":{"operation":"capabilities"}}),
    ] {
        assert!(serde_json::from_value::<RecallMemoryInput>(input).is_ok());
    }
}

#[derive(Default)]
struct Backend {
    started: CancellationToken,
    dropped: CancellationToken,
    proceed: CancellationToken,
    saved: AtomicUsize,
}

impl Backend {
    async fn block(&self) {
        let _guard = self.dropped.clone().drop_guard();
        self.started.cancel();
        self.proceed.cancelled().await;
    }
}

#[async_trait]
impl MemoryDecomposer for Backend {
    async fn decompose(&self, text: &str) -> Result<Vec<String>> {
        if text == "blocked" {
            self.block().await;
        }
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
    async fn inspect_fragment(
        &self,
        _: Uuid,
        _: &RecallFilter,
        _: Option<&RelationshipCursor>,
        _: usize,
    ) -> Result<Option<mindleak_memory::FragmentInspection>> {
        Ok(None)
    }

    async fn lookup_write(&self, _: &WriteRequest) -> Result<Option<WriteMemoryResult>> {
        Ok(None)
    }

    async fn save(&self, memory: &PreparedMemory) -> Result<WriteMemoryResult> {
        self.saved.fetch_add(1, Ordering::SeqCst);
        assert_eq!(memory.agent_id, "claude");
        assert_eq!(memory.fragments.len(), 1);
        Ok(memory.write_result())
    }
}

#[async_trait]
impl MemoryRetriever for Backend {
    async fn recall(
        &self,
        query: &str,
        _filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        if query == "blocked" {
            self.block().await;
        }
        assert_eq!(limit, 10);
        Ok(vec![RecallMatch {
            memory_id: Uuid::nil(),
            fragment_id: Uuid::nil(),
            agent_id: "claude".into(),
            text: "User prefers PRs under 500 LOC".into(),
            score: 0.92,
            ..Default::default()
        }])
    }
}

#[tokio::test]
async fn mcp_handshake_tools_and_all_three_calls_match_the_contract() {
    let backend = Arc::new(Backend::default());
    let memory = MemoryService::new(
        backend.clone(),
        backend.clone(),
        Some(backend.clone()),
        backend,
    );
    let (client_io, server_io) = tokio::io::duplex(16_384);
    let (server, client) =
        tokio::join!(MemoryMcp::new(memory).serve(server_io), ().serve(client_io));
    let server = server.unwrap();
    let client = client.unwrap();
    let info = client.peer_info().unwrap();
    let instructions = info.instructions.as_deref().unwrap();
    for phrase in [
        "Before substantial work",
        "limit 5",
        "explicit general mode",
        "across all scopes",
        "verified reusable",
        "Never store secrets",
        "approvals",
        "agents can author chains directly",
        "knowledge.operation=capabilities",
        "view=compact",
        "Recall never accepts or reinforces knowledge",
    ] {
        assert!(
            instructions.contains(phrase),
            "Missing memory activation guidance: {phrase}"
        );
    }
    let tools = client.list_all_tools().await.unwrap();
    let mut names: Vec<_> = tools.iter().map(|tool| tool.name.as_ref()).collect();
    names.sort();
    assert_eq!(names, ["decompose_memory", "recall_memory", "write_memory"]);
    let write = tools
        .iter()
        .find(|tool| tool.name == "write_memory")
        .unwrap();
    assert!(write.input_schema["properties"].get("agentId").is_some());
    assert!(write.input_schema["properties"].get("context").is_some());
    assert!(write.input_schema["properties"].get("facts").is_some());
    assert_eq!(
        write.annotations.as_ref().unwrap().destructive_hint,
        Some(true)
    );
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

#[tokio::test]
async fn cancellation_drops_pending_operations_before_storage() {
    for (name, arguments) in [
        (
            "write_memory",
            json!({"agentId": "claude", "text": "blocked"}),
        ),
        ("decompose_memory", json!({"text": "blocked"})),
        ("recall_memory", json!({"query": "blocked"})),
    ] {
        let backend = Arc::new(Backend::default());
        let memory = MemoryService::new(backend.clone(), backend.clone(), None, backend.clone());
        let (client_io, server_io) = tokio::io::duplex(16_384);
        let (server, client) =
            tokio::join!(MemoryMcp::new(memory).serve(server_io), ().serve(client_io));
        let server = server.unwrap();
        let client = client.unwrap();
        let request = client
            .send_cancellable_request(
                CallToolRequest::new(
                    CallToolRequestParams::new(name)
                        .with_arguments(arguments.as_object().unwrap().clone()),
                )
                .into(),
                PeerRequestOptions::no_options(),
            )
            .await
            .unwrap();
        tokio::time::timeout(Duration::from_secs(2), backend.started.cancelled())
            .await
            .unwrap();
        request
            .cancel(Some("regression cancellation".into()))
            .await
            .unwrap();
        client
            .send_request(
                rmcp::model::PingRequest {
                    method: Default::default(),
                    extensions: Default::default(),
                }
                .into(),
            )
            .await
            .unwrap();
        let stopped = tokio::time::timeout(Duration::from_secs(1), backend.dropped.cancelled())
            .await
            .is_ok();
        backend.proceed.cancel();
        client.cancel().await.unwrap();
        server.waiting().await.unwrap();
        assert!(stopped, "{name} kept running after SDK cancellation");
        assert_eq!(
            backend.saved.load(Ordering::SeqCst),
            0,
            "cancelled preparation must not reach storage"
        );
    }
}
