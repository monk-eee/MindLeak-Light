use std::{sync::Arc, time::Duration};

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
