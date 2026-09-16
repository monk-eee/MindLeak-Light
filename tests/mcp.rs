use std::{
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use mindleak_decomposition::OpenAiDecomposer;
use mindleak_embeddings::OpenAiEmbedder;
use mindleak_mcp::{http_router, MemoryMcp};
use mindleak_memory::MemoryService;
use mindleak_storage_postgres::{PostgresMemoryStore, VectorMemoryRetriever};
use reqwest::{Client, StatusCode, Url};
use rmcp::{
    model::CallToolRequestParams,
    transport::{
        streamable_http_client::StreamableHttpClientTransportConfig, StreamableHttpClientTransport,
        TokioChildProcess,
    },
    ServiceExt,
};
use serde_json::{json, Value};
use tokio::process::Command;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;
use wiremock::{
    matchers::{method, path},
    Mock, MockServer, Request, ResponseTemplate,
};

mod mcp_lifecycle;

const FACTS: [&str; 3] = [
    "User dislikes huge PRs",
    "Team requires reviews",
    "PRs under 500 LOC merge faster",
];
const TOKEN: &str = "mindleak-light-integration-test-token";

fn database_url() -> String {
    let url = std::env::var("MINDLEAK_TEST_DATABASE_URL")
        .expect("set MINDLEAK_TEST_DATABASE_URL to a disposable *_test database");
    let config: tokio_postgres::Config = url.parse().unwrap();
    assert!(config
        .get_dbname()
        .is_some_and(|name| name.ends_with("_test")));
    url
}

async fn provider() -> MockServer {
    let server = MockServer::start().await;
    Mock::given(method("POST")).and(path("/v1/chat/completions"))
        .respond_with(ResponseTemplate::new(200).set_body_json(json!({"choices": [{
            "finish_reason": "stop", "message": {"content": json!({"fragments": FACTS}).to_string()}
        }]}))).mount(&server).await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(|request: &Request| {
            let body: Value = request.body_json().unwrap();
            let inputs = body["input"].as_array().unwrap();
            let data: Vec<_> = inputs
                .iter()
                .enumerate()
                .rev()
                .map(|(index, input)| {
                    let vector = if input.as_str().unwrap().contains("reviews") {
                        [0.0, 1.0]
                    } else {
                        [1.0, 0.0]
                    };
                    json!({"index": index, "embedding": vector})
                })
                .collect();
            ResponseTemplate::new(200).set_body_json(json!({"data": data}))
        })
        .mount(&server)
        .await;
    server
}

fn call(name: &'static str, arguments: Value) -> CallToolRequestParams {
    CallToolRequestParams::new(name).with_arguments(arguments.as_object().unwrap().clone())
}

#[tokio::test]
async fn duplicate_groups_preserve_each_returned_source_and_lifecycle() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("duplicate-groups-{}", Uuid::new_v4());
    let scope = format!("duplicate-scope-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let mut receipts = Vec::new();
    for index in 0..3 {
        let text = if index < 2 {
            "Restart the application pool."
        } else {
            "Never restart the application pool."
        };
        let written = client.call_tool(call("write_memory", json!({
            "agentId": agent_id, "text": format!("{text}\nGuide detail {index}."),
            "context": {"scope": scope, "source": format!("runbook-{index}"), "sessionId": format!("episode-{index}")},
            "facts": [{"text": text, "pinned": index == 1}]
        }))).await.unwrap();
        assert_ne!(written.is_error, Some(true));
        receipts.push(written.structured_content.unwrap());
    }
    let mut request = json!({"agentId": agent_id, "scope": scope, "query": "restart", "limit": 10, "contextLimit": 1});
    let original = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(original["results"].as_array().unwrap().len(), 3);
    request["groupDuplicates"] = json!(true);
    let grouped = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert_ne!(grouped.is_error, Some(true));
    let grouped = grouped.structured_content.unwrap();
    let groups = grouped["results"].as_array().unwrap();
    assert_eq!(
        groups.len(),
        2,
        "negation must not be collapsed into an affirmative fact"
    );
    let positive = groups
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(positive["sourceCount"], 2);
    let sources: Vec<_> = std::iter::once(positive)
        .chain(positive["duplicateSources"].as_array().unwrap())
        .collect();
    assert_eq!(sources.len(), 2);
    for source in sources {
        let original = original["results"]
            .as_array()
            .unwrap()
            .iter()
            .find(|candidate| candidate["fragmentId"] == source["fragmentId"])
            .unwrap();
        for field in [
            "memoryId",
            "fragmentId",
            "agentId",
            "context",
            "lifecycle",
            "score",
            "activation",
            "rankingPriority",
            "relationships",
            "relationshipCount",
            "relationshipsTruncated",
            "documentContext",
            "fragmentIndex",
        ] {
            assert_eq!(source[field], original[field], "provenance field: {field}");
        }
        assert_eq!(source["lifecycle"]["confirmedSessions"], 0);
    }
    let mut limited = request.clone();
    limited["limit"] = json!(1);
    let limited = client
        .call_tool(call("recall_memory", limited))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(limited["results"].as_array().unwrap().len(), 1);
    assert_eq!(
        limited["results"][0]["sourceCount"], 1,
        "group counts cover only the returned working set"
    );
    let archived = client.call_tool(call("write_memory", json!({
        "agentId": agent_id, "text": "Archive the older instruction.", "context": {"scope": scope},
        "facts": [{"text": "Archive the older instruction.", "links": [{
            "targetFragmentId": receipts[0]["fragments"][0]["fragmentId"], "relationshipType": "archives"
        }]}]
    }))).await.unwrap();
    assert_ne!(archived.is_error, Some(true));
    let active = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let active_positive = active["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(active_positive["sourceCount"], 1);
    request["includeInactive"] = json!(true);
    let history = client
        .call_tool(call("recall_memory", request))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let historical = history["results"]
        .as_array()
        .unwrap()
        .iter()
        .find(|group| group["text"] == "Restart the application pool.")
        .unwrap();
    assert_eq!(historical["sourceCount"], 2);
    assert!(historical["duplicateSources"]
        .as_array()
        .unwrap()
        .iter()
        .any(|source| source["lifecycle"]["state"] == "archived"));
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn document_context_returns_bounded_same_episode_steps() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("document-context-{}", Uuid::new_v4());
    let scope = format!("document-scope-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id,
                "text": "# PoolRecovery\n1. Check permissions.\n2. Restart the application pool.\n3. Verify the health probe.",
                "context": {"scope": scope, "source": "test-runbook"}
            }),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(written["fragments"].as_array().unwrap().len(), 4);
    let mut request =
        json!({"agentId": agent_id, "scope": scope, "query": "PoolRecovery", "limit": 1});
    let ordinary = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert!(ordinary.structured_content.unwrap()["results"][0]
        .get("documentContext")
        .is_none());
    request["contextLimit"] = json!(2);
    let expanded = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap();
    assert_ne!(expanded.is_error, Some(true));
    let expanded = expanded.structured_content.unwrap();
    let primary = &expanded["results"][0];
    assert_eq!(expanded["results"].as_array().unwrap().len(), 1);
    assert_eq!(primary["fragmentId"], written["fragments"][0]["fragmentId"]);
    let context = &primary["documentContext"];
    assert_eq!(context["fragments"].as_array().unwrap().len(), 2);
    assert_eq!(context["truncated"], true);
    for (index, fragment) in context["fragments"].as_array().unwrap().iter().enumerate() {
        assert_eq!(fragment["memoryId"], written["memoryId"]);
        assert_eq!(
            fragment["fragmentId"],
            written["fragments"][index + 1]["fragmentId"]
        );
        assert_eq!(fragment["text"], written["fragments"][index + 1]["text"]);
        assert_eq!(fragment["fragmentIndex"], index + 1);
        assert_eq!(fragment["context"]["scope"], scope);
        assert!(fragment.get("score").is_none());
    }
    let archived = client.call_tool(call("write_memory", json!({
        "agentId": agent_id, "text": "Archive the old permission step.",
        "context": {"scope": scope},
        "facts": [{"text": "Archive the old permission step.", "links": [{
            "targetFragmentId": written["fragments"][1]["fragmentId"], "relationshipType": "archives"
        }]}]
    }))).await.unwrap();
    assert_ne!(archived.is_error, Some(true));
    let current = client
        .call_tool(call("recall_memory", request.clone()))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    let steps = current["results"][0]["documentContext"]["fragments"]
        .as_array()
        .unwrap();
    assert_eq!(steps.len(), 2);
    assert_eq!(
        steps[0]["fragmentId"],
        written["fragments"][2]["fragmentId"]
    );
    assert_eq!(
        steps[1]["fragmentId"],
        written["fragments"][3]["fragmentId"]
    );
    assert_eq!(current["results"][0]["documentContext"]["truncated"], false);
    request["includeInactive"] = json!(true);
    let history = client
        .call_tool(call("recall_memory", request))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert_eq!(
        history["results"][0]["documentContext"]["fragments"][0]["lifecycle"]["state"],
        "archived"
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn keyword_match_modes_and_diagnostics_use_the_postgresql_query() {
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("query-options-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "Restart the application pool. Check permissions first."}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    for (mode, count) in [("websearch", 0), ("all", 0), ("any", 2)] {
        let recalled = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": "restart permissions",
                    "matchMode": mode, "diagnostics": true
                }),
            ))
            .await
            .expect("recall must accept explicit matching and diagnostics");
        assert_ne!(recalled.is_error, Some(true));
        let response = recalled.structured_content.unwrap();
        assert_eq!(response["results"].as_array().unwrap().len(), count);
        let diagnostics = &response["diagnostics"];
        assert_eq!(diagnostics["strategy"], "keyword");
        assert_eq!(diagnostics["keyword"]["matchMode"], mode);
        assert_eq!(
            diagnostics["keyword"]["terms"],
            json!(["permiss", "restart"])
        );
        let parsed = diagnostics["keyword"]["parsedQuery"].as_str().unwrap();
        assert!(parsed.contains(if mode == "any" { " | " } else { " & " }));
    }
    for query in [
        "restart' | !permissions",
        "O'Reilly",
        "foo\\bar",
        "foo:*",
        "\"",
        "-",
    ] {
        let literal = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": query, "matchMode": "any", "diagnostics": true
                }),
            ))
            .await
            .unwrap();
        assert_ne!(literal.is_error, Some(true), "literal query: {query}");
    }
    let empty = client
        .call_tool(call(
            "recall_memory",
            json!({"agentId": agent_id, "query": "the and", "matchMode": "any", "diagnostics": true}),
        ))
        .await
        .unwrap()
        .structured_content
        .unwrap();
    assert!(empty["results"].as_array().unwrap().is_empty());
    assert_eq!(empty["diagnostics"]["keyword"]["parsedQuery"], "");
    assert_eq!(empty["diagnostics"]["keyword"]["terms"], json!([]));
    assert_eq!(
        client
            .call_tool(call(
                "recall_memory",
                json!({"query": "restart", "matchMode": "unknown"})
            ))
            .await
            .unwrap()
            .is_error,
        Some(true)
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn write_request_replays_committed_result_after_restart_without_model_calls() {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("retry-write-{}", Uuid::new_v4());
    let arguments = json!({
        "agentId": agent_id,
        "text": FACTS.join(". "),
        "requestId": Uuid::new_v4(),
        "context": {"scope": "retry-test", "sessionId": "original-session"}
    });
    let mut original = None;
    for attempt in 0..2 {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
        command.current_dir(directory.path()).env_clear().envs([
            ("MINDLEAK_DATABASE_URL", database_url()),
            ("MINDLEAK_DECOMPOSITION", "openai".into()),
            ("MINDLEAK_RETRIEVAL", "vector".into()),
            ("MINDLEAK_RELEVANCE", "off".into()),
            ("MINDLEAK_MODEL", "test-model".into()),
            ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_EMBED_MODEL", "test-model".into()),
            ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ]);
        let client = tokio::time::timeout(
            Duration::from_secs(15),
            ().serve(TokioChildProcess::new(command).unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
        let written = client
            .call_tool(call("write_memory", arguments.clone()))
            .await
            .expect("write_memory must accept an optional requestId");
        assert_ne!(written.is_error, Some(true));
        let result = written.structured_content.unwrap();
        if let Some(original) = &original {
            assert_eq!(&result, original, "retry must replay the committed receipt");
        } else {
            assert_eq!(result["fragments"].as_array().unwrap().len(), FACTS.len());
            original = Some(result);
        }
        if attempt == 1 {
            for field in ["text", "context", "facts"] {
                let mut conflict = arguments.clone();
                conflict[field] = match field {
                    "text" => json!("A different write."),
                    "context" => json!({"scope": "another-project"}),
                    _ => json!([{"text": FACTS[0], "pinned": true}]),
                };
                assert!(client
                    .call_tool(call("write_memory", conflict))
                    .await
                    .is_err());
            }
            let mut invalid = arguments.clone();
            invalid["requestId"] = json!("not-a-uuid");
            assert_eq!(
                client
                    .call_tool(call("write_memory", invalid))
                    .await
                    .unwrap()
                    .is_error,
                Some(true)
            );
            let repeated = client
                .call_tool(call("write_memory", arguments.clone()))
                .await
                .unwrap();
            assert_ne!(repeated.is_error, Some(true));
            assert_eq!(repeated.structured_content, original);
        }
        client.cancel().await.unwrap();
        if attempt == 0 {
            provider.reset().await;
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(503))
                .expect(0)
                .mount(&provider)
                .await;
        }
    }
    assert!(provider.received_requests().await.unwrap().is_empty());
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1, "retry must not create a second episode");
}

#[tokio::test]
async fn invalid_provider_data_never_reports_success_or_leaves_partial_memories() {
    let provider = MockServer::start().await;
    let scenario = Arc::new(AtomicUsize::new(0));
    let chat_scenario = scenario.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |_: &Request| {
            let mut body = json!({"choices": [{"finish_reason": "stop", "message": {
                "content": json!({"fragments": FACTS}).to_string()
            }}]});
            if chat_scenario.load(Ordering::SeqCst) == 2 {
                body["metadata"] = json!("x".repeat(4 * 1024 * 1024));
            }
            ResponseTemplate::new(200).set_body_json(body)
        })
        .mount(&provider)
        .await;
    let embedding_scenario = scenario.clone();
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(move |request: &Request| {
            let scenario = embedding_scenario.load(Ordering::SeqCst);
            let request: Value = request.body_json().unwrap();
            let vector = if scenario == 1 {
                [1e-30, 0.0]
            } else {
                [1.0, 0.0]
            };
            let data: Vec<_> = request["input"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(index, _)| json!({"index": index, "embedding": vector}))
                .collect();
            let mut body = json!({
                "model": if scenario == 0 { "different-test-model" } else { "test-model" },
                "data": data
            });
            if scenario == 3 {
                body["metadata"] = json!("x".repeat(4 * 1024 * 1024));
            }
            ResponseTemplate::new(200).set_body_json(body)
        })
        .mount(&provider)
        .await;

    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("provider-validation-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "openai".into()),
        ("MINDLEAK_RETRIEVAL", "vector".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RECALL_MIN_SIMILARITY", "0.9".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    tokio::spawn(async move { connection.await.unwrap() });
    for current in 0..4 {
        scenario.store(current, Ordering::SeqCst);
        let written = client
            .call_tool(call(
                "write_memory",
                json!({
                    "agentId": agent_id, "text": FACTS.join(". ")
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            written.is_error,
            Some(true),
            "invalid scenario {current} must fail"
        );
        let count: i64 = database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE agent_id = $1",
                &[&agent_id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0, "failed writes must not leave raw memories");
    }
    scenario.store(4, Ordering::SeqCst);
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id, "text": FACTS.join(". ")
            }),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    for current in [0, 1, 3] {
        scenario.store(current, Ordering::SeqCst);
        let recalled = client
            .call_tool(call(
                "recall_memory",
                json!({
                    "agentId": agent_id, "query": format!("provider-probe-{current}"), "limit": 5
                }),
            ))
            .await
            .unwrap();
        assert_eq!(
            recalled.is_error,
            Some(true),
            "invalid scenario {current} must not be an empty success"
        );
    }
    scenario.store(4, Ordering::SeqCst);
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({
                "agentId": agent_id, "query": "provider-probe-0", "limit": 5
            }),
        ))
        .await
        .unwrap();
    assert_ne!(recalled.is_error, Some(true));
    let content = recalled.structured_content.unwrap();
    let results = content["results"].as_array().unwrap();
    assert_eq!(results.len(), FACTS.len());
    assert!(results
        .iter()
        .all(|result| result["score"].as_f64().is_some_and(f64::is_finite)));
    client.cancel().await.unwrap();
    database
        .execute(
            "DELETE FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn vector_recall_honors_a_configured_similarity_floor() {
    for retrieval in ["vector", "hybrid"] {
        assert_similarity_floor(retrieval).await;
    }
}

async fn assert_similarity_floor(retrieval: &str) {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("relevance-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", retrieval.into()),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RECALL_MIN_SIMILARITY", "0.5".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "Team requires reviews."}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let relevant = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "reviews", "agentId": agent_id, "limit": 5}),
        ))
        .await
        .unwrap();
    let unrelated = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "PR preferences?", "agentId": agent_id, "limit": 5}),
        ))
        .await
        .unwrap();
    client.cancel().await.unwrap();
    assert_eq!(
        relevant.structured_content.unwrap()["results"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(unrelated.structured_content.unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn relevance_model_filters_candidates_without_changing_facts_or_hiding_failures() {
    let provider = provider().await;
    let relevance = MockServer::start().await;
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(|request: &Request| {
            let body: Value = request.body_json().unwrap();
            let input: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let selected: Vec<Value> = if input["query"] == "What approval is required?" {
                input["candidates"].as_array().unwrap().iter()
                    .filter(|candidate| candidate["text"] == "Team requires reviews.")
                    .map(|candidate| json!({"index": candidate["index"], "evidence": candidate["text"]}))
                    .collect()
            } else {
                vec![]
            };
            ResponseTemplate::new(200).set_body_json(json!({"choices": [{
                "finish_reason": "stop", "message": {"content": json!({"requested_detail": "approval requirement", "relevant": selected}).to_string()}
            }]}))
        })
        .mount(&relevance).await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("relevance-model-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "hybrid".into()),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RELEVANCE", "openai".into()),
        ("MINDLEAK_RELEVANCE_URL", format!("{}/v1", relevance.uri())),
        ("MINDLEAK_RELEVANCE_MODEL", "relevance-model".into()),
        ("MINDLEAK_RELEVANCE_CANDIDATES", "3".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let written = client
        .call_tool(call(
            "write_memory",
            json!({
                "agentId": agent_id, "text": "Team requires reviews. The server uses PostgreSQL."
            }),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"].clone();
    let relevant = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What approval is required?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    let content = relevant.structured_content.unwrap();
    let matches = content["results"].as_array().unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0]["memoryId"], memory_id);
    assert_eq!(matches[0]["text"], "Team requires reviews.");
    let absent = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What is the payroll budget?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    assert_ne!(absent.is_error, Some(true));
    assert_eq!(absent.structured_content.unwrap()["results"], json!([]));
    relevance.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&relevance)
        .await;
    let failed = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "What approval is required?", "agentId": agent_id, "limit": 1
            }),
        ))
        .await
        .unwrap();
    client.cancel().await.unwrap();
    assert_eq!(failed.is_error, Some(true));
}

#[tokio::test]
async fn real_stdio_process_decomposes_writes_recalls_and_refuses_failed_writes() {
    let provider = provider().await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("stdio-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "openai".into()),
        ("MINDLEAK_RETRIEVAL", "vector".into()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        client
            .peer_info()
            .unwrap()
            .server_info
            .as_ref()
            .unwrap()
            .name,
        "mindleak-light"
    );
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let preview = client
        .call_tool(call("decompose_memory", json!({"text": FACTS.join(". ")})))
        .await
        .unwrap();
    assert_eq!(preview.structured_content.unwrap()["results"], json!(FACTS));
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": FACTS.join(". ")}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"]
        .as_str()
        .unwrap()
        .to_owned();
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "PR preferences?", "agentId": agent_id, "limit": 3}),
        ))
        .await
        .unwrap();
    let structured = recalled.structured_content.unwrap();
    let matches = structured["results"].as_array().unwrap();
    assert_eq!(matches.len(), 3);
    assert!(matches.iter().all(|item| item["memoryId"] == memory_id));
    assert_eq!(matches[2]["text"], FACTS[1]);
    assert_eq!(matches[0]["score"], 1.0);

    provider.reset().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&provider)
        .await;
    let refused = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": "must not persist"}),
        ))
        .await
        .unwrap();
    assert_eq!(refused.is_error, Some(true));
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let database_task = tokio::spawn(connection);
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id = $1",
            &[&agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 1);
    client.cancel().await.unwrap();
    drop(database);
    database_task.await.unwrap().unwrap();
}

#[tokio::test]
async fn http_requires_auth_rejects_origins_and_serves_the_same_tools() {
    let provider = provider().await;
    let store = PostgresMemoryStore::connect(&database_url(), Some(("test-model", 2)), 4, None)
        .await
        .unwrap();
    let client = Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .unwrap();
    let embedder = Arc::new(
        OpenAiEmbedder::new(
            client.clone(),
            Url::parse(&format!("{}/v1/embeddings", provider.uri())).unwrap(),
            "test-model".into(),
            String::new(),
            2,
        )
        .unwrap(),
    );
    let decomposer = Arc::new(OpenAiDecomposer::new(
        client.clone(),
        Url::parse(&format!("{}/v1/chat/completions", provider.uri())).unwrap(),
        "test-model".into(),
        String::new(),
    ));
    let retriever = Arc::new(VectorMemoryRetriever::new(store.clone(), embedder.clone()));
    let memory = MemoryService::new(
        Arc::new(store.clone()),
        decomposer,
        Some(embedder),
        retriever,
    );
    let cancellation = CancellationToken::new();
    assert!(http_router(
        MemoryMcp::new(memory.clone()),
        store.clone(),
        "short",
        cancellation.child_token()
    )
    .is_err());
    let router = http_router(
        MemoryMcp::new(memory),
        store,
        TOKEN,
        cancellation.child_token(),
    )
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let shutdown = cancellation.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, router)
            .with_graceful_shutdown(shutdown.cancelled_owned())
            .await
            .unwrap();
    });
    for route in ["health", "mcp"] {
        assert_eq!(
            client
                .get(format!("{base}/{route}"))
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
        assert_eq!(
            client
                .get(format!("{base}/{route}"))
                .bearer_auth("wrong")
                .send()
                .await
                .unwrap()
                .status(),
            StatusCode::UNAUTHORIZED
        );
    }
    assert_eq!(
        client
            .get(format!("{base}/health"))
            .bearer_auth(TOKEN)
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::OK
    );
    assert_eq!(
        client
            .post(format!("{base}/mcp"))
            .bearer_auth(TOKEN)
            .header("Origin", "https://example.com")
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        client
            .post(format!("{base}/mcp"))
            .bearer_auth(TOKEN)
            .body("x".repeat(256 * 1024 + 1))
            .send()
            .await
            .unwrap()
            .status(),
        StatusCode::PAYLOAD_TOO_LARGE
    );
    let transport = StreamableHttpClientTransport::with_client(
        reqwest_mcp::Client::new(),
        StreamableHttpClientTransportConfig::with_uri(format!("{base}/mcp")).auth_header(TOKEN),
    );
    let sdk_client = ().serve(transport).await.unwrap();
    assert_eq!(sdk_client.list_all_tools().await.unwrap().len(), 3);
    let result = sdk_client
        .call_tool(call("decompose_memory", json!({"text": FACTS.join(". ")})))
        .await
        .unwrap();
    assert_eq!(result.structured_content.unwrap()["results"], json!(FACTS));
    sdk_client.cancel().await.unwrap();
    cancellation.cancel();
    server.await.unwrap();
}

#[test]
fn dotenv_settings_are_loaded_before_clap_resolves_transport() {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(
        directory.path().join(".env"),
        "MINDLEAK_TRANSPORT=invalid\n",
    )
    .unwrap();
    let output = std::process::Command::new(env!("CARGO_BIN_EXE_mindleak-light"))
        .env_clear()
        .current_dir(directory.path())
        .output()
        .unwrap();
    assert!(!output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        stderr.contains("invalid value"),
        "unexpected error: {stderr}"
    );
}

#[tokio::test]
async fn model_free_stdio_works_without_models_and_makes_zero_provider_requests() {
    let provider = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .mount(&provider)
        .await;
    let directory = tempfile::tempdir().unwrap();
    let agent_id = format!("model-free-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
    ]);
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let raw = "  The user dislikes huge PRs.\nThe team requires reviews.  ";
    let preview = client
        .call_tool(call("decompose_memory", json!({"text": raw})))
        .await
        .unwrap();
    assert_ne!(
        preview.is_error,
        Some(true),
        "default decomposition must not require a model"
    );
    assert_eq!(
        preview.structured_content.unwrap()["results"],
        json!(["The user dislikes huge PRs.", "The team requires reviews."])
    );
    let written = client
        .call_tool(call(
            "write_memory",
            json!({"agentId": agent_id, "text": raw}),
        ))
        .await
        .unwrap();
    assert_ne!(written.is_error, Some(true));
    let memory_id = written.structured_content.unwrap()["memoryId"]
        .as_str()
        .unwrap()
        .to_owned();
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "reviews", "agentId": agent_id}),
        ))
        .await
        .unwrap();
    assert_ne!(recalled.is_error, Some(true));
    let matches = recalled.structured_content.unwrap();
    assert_eq!(matches["results"].as_array().unwrap().len(), 1);
    assert_eq!(matches["results"][0]["memoryId"], memory_id);
    assert_eq!(matches["results"][0]["text"], "The team requires reviews.");
    let (database, connection) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let database_task = tokio::spawn(connection);
    let row = database.query_one(
        "SELECT raw_text, (SELECT count(*) FROM public.fragments WHERE memory_id = memories.id AND embedding IS NULL) \
         FROM public.memories AS memories WHERE id = $1", &[&Uuid::parse_str(&memory_id).unwrap()],
    ).await.unwrap();
    assert_eq!(row.get::<_, String>(0), raw);
    assert_eq!(row.get::<_, i64>(1), 2);
    assert!(provider.received_requests().await.unwrap().is_empty());
    client.cancel().await.unwrap();
    drop(database);
    database_task.await.unwrap().unwrap();
}
