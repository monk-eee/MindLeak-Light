use super::*;

async fn connect(
    directory: &std::path::Path,
    provider: Option<&str>,
) -> rmcp::service::RunningService<rmcp::RoleClient, ()> {
    let mut settings = Vec::new();
    if let Some(provider) = provider {
        settings.extend([
            ("MINDLEAK_DECOMPOSITION", "openai".into()),
            ("MINDLEAK_LLM_URL", provider.into()),
            ("MINDLEAK_MODEL", "unavailable".into()),
            ("MINDLEAK_RELEVANCE", "openai".into()),
            ("MINDLEAK_RELEVANCE_URL", provider.into()),
            ("MINDLEAK_RELEVANCE_MODEL", "unavailable".into()),
        ]);
    }
    connect_configured(directory, &settings).await
}

async fn connect_configured(
    directory: &std::path::Path,
    settings: &[(&str, String)],
) -> rmcp::service::RunningService<rmcp::RoleClient, ()> {
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "sentences".into()),
        ("MINDLEAK_RETRIEVAL", "keyword".into()),
        ("MINDLEAK_RELEVANCE", "off".into()),
    ]);
    command.envs(settings.iter().map(|(name, value)| (*name, value)));
    tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap()
}

async fn successful(
    client: &rmcp::service::RunningService<rmcp::RoleClient, ()>,
    name: &'static str,
    arguments: Value,
) -> Value {
    let result = client.call_tool(call(name, arguments)).await.unwrap();
    assert_ne!(result.is_error, Some(true));
    let structured = result.structured_content.unwrap();
    if let Some(diagnostics) = structured.get("costDiagnostics") {
        let content = serde_json::to_value(&result.content).unwrap();
        let emitted_bytes = content[0]["text"].as_str().unwrap().len();
        assert_eq!(
            diagnostics["responseBytes"], emitted_bytes,
            "measure the server JSON, not a client's floating-point reserialization"
        );
    }
    structured
}

#[tokio::test]
async fn compact_knowledge_budget_is_independent_of_unused_full_evidence() {
    let directory = tempfile::tempdir().unwrap();
    let client = connect(directory.path(), None).await;
    let scope = format!("compact-budget-{}", Uuid::new_v4());
    let query = format!("compactbudget{}", Uuid::new_v4().simple());
    let context =
        json!({"scope":scope,"source":"synthetic:compact-budget","sessionId":Uuid::new_v4()});
    let source = (0..8)
        .map(|index| format!("Synthetic supporting observation number {index}."))
        .collect::<Vec<_>>()
        .join("\n");
    let observation = successful(
        &client,
        "write_memory",
        json!({
            "agentId":"budget-learner","text":source,"context":context
        }),
    )
    .await;
    assert_eq!(observation["fragments"].as_array().unwrap().len(), 8);
    let evidence: Vec<_> = observation["fragments"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
        .map(|(index, fragment)| {
            json!({"fragmentId":fragment["fragmentId"],"role":"supports",
            "reason":if index < 5 { "\u{0001}".repeat(940) } else { "A".repeat(1000) }})
        })
        .collect();
    let write = |chain: Value| {
        json!({"agentId":"budget-learner","requestId":Uuid::new_v4(),
        "text":"Recorded a synthetic budget decision.","context":context,"chain":chain})
    };
    let validation = json!({"method":"Inspect synthetic support","result":"Only the recorded conditions apply",
        "source":"synthetic:budget-validation","counterEvidenceReviewed":[]});
    let mut supports = Vec::new();
    for index in 0..8 {
        let chain_id = Uuid::new_v4();
        successful(&client, "write_memory", write(json!({"operation":"propose","chainId":chain_id,"document":{
            "claim":format!("Budget supporting comparison {index}"),"conclusion":"Reuse the tested procedure.",
            "rationale":"Eight bounded source references.","applicability":"The synthetic runtime only.",
            "assumptions":[],"evidence":evidence
        }}))).await;
        successful(
            &client,
            "write_memory",
            write(json!({"operation":"accept","chainId":chain_id,
            "expectedRevision":1,"validation":validation})),
        )
        .await;
        supports.push(
            json!({"chainId":chain_id,"revision":2,"reason":"Recorded synthetic comparison."}),
        );
    }
    for index in 0..4 {
        let chain_id = Uuid::new_v4();
        successful(&client, "write_memory", write(json!({"operation":"propose","chainId":chain_id,"document":{
            "kind":"principle","claim":format!("{query} comparison {index}"),
            "conclusion":"Use the procedure only under its verified conditions.",
            "rationale":"Supporting evidence remains available by exact inspection.",
            "applicability":"The synthetic runtime only.","assumptions":["The runtime contract is unchanged."],
            "evidence":[],"supportedBy":supports
        }}))).await;
        successful(
            &client,
            "write_memory",
            write(json!({"operation":"accept","chainId":chain_id,
            "expectedRevision":1,"validation":validation})),
        )
        .await;
    }
    let full_error = client
        .call_tool(call(
            "recall_memory",
            json!({
                "knowledge":{"operation":"search","query":query},"scope":scope,"limit":4
            }),
        ))
        .await
        .expect_err("full evidence must retain its existing aggregate byte limit");
    assert!(full_error.to_string().contains("512 KiB"));
    let compact = successful(&client, "recall_memory", json!({
        "knowledge":{"operation":"search","query":query,"view":"compact","costDiagnostics":true},
        "scope":scope,"limit":4
    })).await;
    assert_eq!(compact["principles"].as_array().unwrap().len(), 4);
    assert!(compact["chains"].as_array().unwrap().is_empty());
    assert!(compact["observations"].as_array().unwrap().is_empty());
    assert!(
        compact["costDiagnostics"]["responseBytes"]
            .as_u64()
            .unwrap()
            < 10 * 1024
    );
    assert_eq!(compact["costDiagnostics"]["providerRequestCount"], 0);
    for principle in compact["principles"].as_array().unwrap() {
        assert_eq!(principle["applicability"], "The synthetic runtime only.");
        assert_eq!(
            principle["assumptions"],
            json!(["The runtime contract is unchanged."])
        );
        assert_eq!(principle["supportingChains"].as_array().unwrap().len(), 8);
    }
    let inspected = successful(
        &client,
        "recall_memory",
        json!({
            "chain":{"operation":"inspect","chainId":supports[0]["chainId"]},"scope":scope,"limit":1
        }),
    )
    .await;
    assert_eq!(
        inspected["evidence"][0]["reference"]["reason"],
        "\u{0001}".repeat(940)
    );
    let large_chain_id = Uuid::new_v4();
    let large_query = format!("unusedsource{}", Uuid::new_v4().simple());
    let mut large_proposal = write(
        json!({"operation":"propose","chainId":large_chain_id,"document":{
            "kind":"principle","claim":large_query,"conclusion":"Use the conditional procedure.",
            "rationale":"\u{0001}".repeat(4096),"applicability":"The synthetic runtime only.",
            "assumptions":[],"evidence":[],"supportedBy":supports
        }}),
    );
    let large_source = (0..8)
        .map(|index| format!("Source {index} {}.", "\u{0001}".repeat(4000)))
        .collect::<Vec<_>>()
        .join("\n");
    large_proposal["text"] = json!(large_source);
    successful(&client, "write_memory", large_proposal).await;
    let mut large_acceptance = write(json!({"operation":"accept","chainId":large_chain_id,
        "expectedRevision":1,"validation":validation}));
    large_acceptance["text"] = json!(large_source);
    successful(&client, "write_memory", large_acceptance).await;
    let large_compact = successful(&client, "recall_memory", json!({
        "knowledge":{"operation":"search","query":large_query,"view":"compact","costDiagnostics":true},
        "scope":scope,"limit":1
    })).await;
    assert_eq!(
        large_compact["principles"][0]["chainId"],
        large_chain_id.to_string()
    );
    assert!(
        large_compact["costDiagnostics"]["responseBytes"]
            .as_u64()
            .unwrap()
            < 3 * 1024
    );
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn checkpoint_capture_recipes_are_retry_safe_and_reusable_in_fresh_sessions() {
    let manifest: Value = serde_json::from_str(include_str!(
        "../.agents/skills/mindleak-memory/references/tool-recipes.json"
    ))
    .unwrap();
    assert_eq!(
        manifest["captureCalls"]
            .as_object()
            .expect("capture recipes are shipped")
            .len(),
        2
    );
    let recipes = json!({"calls":manifest["captureCalls"]});
    let directory = tempfile::tempdir().unwrap();
    for mode in ["project", "general"] {
        let cue = format!("capturecue{}", Uuid::new_v4().simple());
        let scope = format!("capture-scope-{}", Uuid::new_v4());
        let text = "When the upstream is slow, the verified timeout test rejects the short deadline; use the tested twelve-second deadline only for this runtime.";
        let bindings = std::collections::HashMap::from([
            (
                "$AGENT_ID",
                json!(format!("capture-agent-{}", Uuid::new_v4())),
            ),
            ("$SCOPE", json!(scope)),
            ("$SESSION_ID", json!(Uuid::new_v4())),
            ("$REQUEST_ID", json!(Uuid::new_v4())),
            ("$FACT_TEXT", json!(text)),
            ("$SOURCE", json!("synthetic:verified-timeout-test")),
            (
                "$RETRIEVAL_CUES",
                json!(format!("{cue} upstream timeout deadline")),
            ),
        ]);
        let request = super::mcp_lifecycle::recipe(&recipes, mode, &bindings);
        let client = connect(directory.path(), None).await;
        let written = client.call_tool(request.clone()).await.unwrap();
        assert_ne!(written.is_error, Some(true));
        let receipt = written.structured_content.unwrap();
        let replay = client.call_tool(request).await.unwrap();
        assert_ne!(replay.is_error, Some(true));
        assert_eq!(replay.structured_content.unwrap(), receipt);
        client.cancel().await.unwrap();

        let client = connect(directory.path(), None).await;
        let mut search = json!({"query":cue,"limit":5});
        if mode == "project" {
            search["scope"] = json!(scope);
        }
        let recalled = successful(&client, "recall_memory", search.clone()).await;
        assert_eq!(recalled["results"].as_array().unwrap().len(), 1);
        let found = &recalled["results"][0];
        assert_eq!(found["memoryId"], receipt["memoryId"]);
        assert_eq!(found["context"]["summary"], bindings["$RETRIEVAL_CUES"]);
        assert_eq!(found["context"]["source"], bindings["$SOURCE"]);
        assert_eq!(
            found["context"]["scope"],
            if mode == "project" {
                json!(scope)
            } else {
                Value::Null
            }
        );
        assert_eq!(found["lifecycle"]["confirmedSessions"], 0);
        assert_eq!(found["lifecycle"]["usefulSessions"], 0);
        let mut inspection = json!({"fragmentId":found["fragmentId"],"limit":1});
        if mode == "project" {
            inspection["scope"] = json!(scope);
        }
        let inspected = successful(&client, "recall_memory", inspection).await;
        assert_eq!(inspected["rawText"], text);
        search["scope"] = json!(format!("{scope}-unrelated"));
        assert!(
            successful(&client, "recall_memory", search).await["results"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        client.cancel().await.unwrap();
    }
}

#[tokio::test]
async fn learning_capabilities_are_model_free_and_separate_extraction_from_search() {
    let directory = tempfile::tempdir().unwrap();
    let provider = MockServer::start().await;
    let client = connect_configured(
        directory.path(),
        &[
            ("MINDLEAK_DECOMPOSITION", "openai".into()),
            ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_MODEL", "configured-extractor".into()),
            ("MINDLEAK_RELEVANCE", "openai".into()),
            ("MINDLEAK_RELEVANCE_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_RELEVANCE_MODEL", "configured-selector".into()),
        ],
    )
    .await;
    let capabilities = successful(
        &client,
        "recall_memory",
        json!({"knowledge":{"operation":"capabilities"}}),
    )
    .await;
    assert_eq!(capabilities["retrieval"]["strategy"], "keyword");
    assert!(capabilities["retrieval"]["embeddingModel"].is_null());
    assert_eq!(capabilities["decomposition"]["mode"], "openai");
    assert_eq!(
        capabilities["decomposition"]["model"],
        "configured-extractor"
    );
    assert_eq!(capabilities["formation"]["mode"], "off");
    assert_eq!(capabilities["learning"]["agentAuthoredChains"], true);
    assert_eq!(capabilities["learning"]["agentAuthoredPrinciples"], true);
    assert_eq!(capabilities["learning"]["modelPreviewRequired"], false);
    assert_eq!(
        capabilities["learning"]["acceptance"],
        "explicit_validation"
    );
    assert_eq!(capabilities["learning"]["recallChangesKnowledge"], false);
    assert_eq!(capabilities["learning"]["checkpointMode"], "agent_guided");
    assert_eq!(
        capabilities["learning"]["checkpointTriggers"],
        json!([
            "verified_fix",
            "verified_failure",
            "changed_assumption",
            "before_handoff"
        ])
    );
    assert!(capabilities["learning"]["captureFormat"]
        .as_str()
        .unwrap()
        .contains("verification"));
    assert!(capabilities["learning"]["captureFormat"]
        .as_str()
        .unwrap()
        .contains("retrieval cues"));
    assert_eq!(
        capabilities["retrieval"]["relevanceModel"],
        "configured-selector"
    );
    assert_eq!(capabilities["retrieval"]["providerCallsInstrumented"], true);
    assert_eq!(capabilities["knowledgeViews"], json!(["full", "compact"]));
    for extra in [
        json!({"scope":"project"}),
        json!({"agentId":"learner"}),
        json!({"limit":1}),
        json!({"includeInactive":true}),
    ] {
        let mut arguments = extra;
        arguments["knowledge"] = json!({"operation":"capabilities"});
        assert!(client
            .call_tool(call("recall_memory", arguments))
            .await
            .is_err());
    }
    assert!(provider.received_requests().await.unwrap().is_empty());
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn knowledge_costs_include_relevance_without_changing_selection() {
    let directory = tempfile::tempdir().unwrap();
    let provider = MockServer::start().await;
    let failure = Arc::new(AtomicUsize::new(0));
    let failure_mode = failure.clone();
    Mock::given(method("POST"))
        .and(path("/v1/chat/completions"))
        .respond_with(move |request: &Request| {
            if failure_mode.load(Ordering::SeqCst) != 0 {
                return ResponseTemplate::new(503);
            }
            let body: Value = request.body_json().unwrap();
            let input: Value =
                serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
            let selected: Vec<_> = input["candidates"]
                .as_array()
                .unwrap()
                .iter()
                .map(|candidate| json!({"index":candidate["index"],"evidence":candidate["text"]}))
                .collect();
            ResponseTemplate::new(200).set_body_json(json!({
                "choices":[{"finish_reason":"stop","message":{"content":json!({
                    "requested_detail":"Recorded approval conditions", "relevant":selected
                }).to_string()}}],
                "usage":{"prompt_tokens":37,"completion_tokens":13,"total_tokens":50,
                    "prompt_tokens_details":{"cached_tokens":5}}
            }))
        })
        .mount(&provider)
        .await;
    let client = connect_configured(
        directory.path(),
        &[
            ("MINDLEAK_RELEVANCE", "openai".into()),
            ("MINDLEAK_RELEVANCE_URL", format!("{}/v1", provider.uri())),
            ("MINDLEAK_RELEVANCE_MODEL", "test-selector".into()),
        ],
    )
    .await;
    let scope = format!("knowledge-costs-{}", Uuid::new_v4());
    let query = format!("approvalfixture{}", Uuid::new_v4().simple());
    let context =
        json!({"scope":scope,"source":"synthetic:approval-workflow","sessionId":Uuid::new_v4()});
    let observation = successful(&client, "write_memory", json!({
        "agentId":"learner","text":format!("For {query}, the blocked runtime failed the approval check."),
        "context":context
    })).await;
    let chain_id = Uuid::new_v4();
    let write = |chain: Value| {
        json!({"agentId":"learner","text":"Recorded the verified approval condition.",
        "requestId":Uuid::new_v4(),"context":context,"chain":chain})
    };
    successful(&client, "write_memory", write(json!({"operation":"propose","chainId":chain_id,"document":{
        "claim":format!("Check approval for {query}"),"rationale":"The blocked runtime was rejected.",
        "conclusion":"Check approval before exporting.","applicability":"The tested runtime only.",
        "assumptions":["The approval contract has not changed."],"evidence":[{
            "fragmentId":observation["fragments"][0]["fragmentId"],"role":"supports","reason":"Verified rejection."
        }]
    }}))).await;
    successful(
        &client,
        "write_memory",
        write(
            json!({"operation":"accept","chainId":chain_id,"expectedRevision":1,
                "validation":{"method":"Run the approval test","result":"Blocked runtime rejected",
                    "source":"synthetic:approval-test","counterEvidenceReviewed":[]}
            }),
        ),
    )
    .await;
    assert!(provider.received_requests().await.unwrap().is_empty());
    let plain = successful(
        &client,
        "recall_memory",
        json!({
            "knowledge":{"operation":"search","query":query},"scope":scope,"limit":2
        }),
    )
    .await;
    assert!(plain.get("costDiagnostics").is_none());
    assert_eq!(provider.received_requests().await.unwrap().len(), 2);
    let measured = successful(&client, "recall_memory", json!({
        "knowledge":{"operation":"search","query":query,"view":"compact","diagnostics":true,"costDiagnostics":true},
        "scope":scope,"limit":2
    })).await;
    assert_eq!(provider.received_requests().await.unwrap().len(), 4);
    assert_eq!(
        measured["chains"][0]["chainId"],
        plain["chains"][0]["chain"]["chainId"]
    );
    assert_eq!(measured["chains"][0]["score"], plain["chains"][0]["score"]);
    assert_eq!(
        measured["observations"][0]["fragmentId"],
        plain["observations"][0]["fragmentId"]
    );
    assert_eq!(measured["diagnostics"]["relevanceFilter"], true);
    assert_eq!(measured["costDiagnostics"]["providerRequestCount"], 2);
    for call in measured["costDiagnostics"]["providerCalls"]
        .as_array()
        .unwrap()
    {
        assert_eq!(call["operation"], "relevance");
        assert_eq!(call["model"], "test-selector");
        assert_eq!(
            call["usage"],
            json!({"inputTokens":37,"outputTokens":13,"totalTokens":50,"cachedInputTokens":5})
        );
    }
    let chains = successful(
        &client,
        "recall_memory",
        json!({
            "chain":{"operation":"search","query":query,"diagnostics":true,"costDiagnostics":true},
            "scope":scope,"limit":2
        }),
    )
    .await;
    assert_eq!(chains["costDiagnostics"]["providerRequestCount"], 1);
    failure.store(1, Ordering::SeqCst);
    let failed = client.call_tool(call("recall_memory", json!({
        "knowledge":{"operation":"search","query":query,"view":"compact","costDiagnostics":true},
        "scope":scope
    }))).await.unwrap();
    assert_eq!(failed.is_error, Some(true));
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn full_knowledge_formation_revision_retrieval_and_export_across_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let agent = format!("knowledge-mcp-{}", Uuid::new_v4());
    let scope = format!("scope-{agent}");
    let query = format!("knowledgefixture{}", Uuid::new_v4().simple());
    let context =
        json!({"scope":scope,"source":"synthetic:knowledge-workflow","sessionId":Uuid::new_v4()});
    let provider = MockServer::start().await;
    let failure = Arc::new(AtomicUsize::new(0));
    let failure_mode = failure.clone();
    Mock::given(method("POST")).and(path("/v1/chat/completions")).respond_with(move |request: &Request| {
        let body: Value = request.body_json().unwrap();
        assert_eq!(body["response_format"]["json_schema"]["name"], "knowledge_candidates");
        assert_eq!(body["response_format"]["json_schema"]["strict"], true);
        let sources: Value = serde_json::from_str(body["messages"][1]["content"].as_str().unwrap()).unwrap();
        let principle = sources["kind"] == "principle";
        let observations = sources["observations"].as_array().unwrap();
        let mut citations: Vec<_> = observations.iter().map(|source| json!({"fragmentId":source["fragmentId"],"quote":source["text"]})).collect();
        let evidence: Vec<_> = observations.iter().map(|source| json!({"fragmentId":source["fragmentId"],"role":if principle {"counterexample"} else {"supports"},"reason":"Controlled fixture observation."})).collect();
        let supports: Vec<_> = sources["chains"].as_array().unwrap().iter().map(|source| json!({
            "chainId":source["chain"]["chainId"],"revision":source["chain"]["revision"],"reason":"Validated comparison under the stated conditions."
        })).collect();
        let mode = failure_mode.load(Ordering::SeqCst);
        if mode == 2 { return ResponseTemplate::new(503); }
        if mode == 1 { citations[0]["quote"] = json!("Fabricated measurement absent from the selected source."); }
        let document = json!({"kind":sources["kind"],"claim":format!("Bounded recall supports {}", sources["question"].as_str().unwrap()),
            "rationale":"Two controlled conditions are not assumed to establish an unrestricted causal claim.",
            "conclusion":"Use bounded recall on equivalent measured tasks.","applicability":"Only the controlled fixture conditions.",
            "assumptions":["Correctness was held constant."],"evidence":evidence,"supportedBy":supports,"reportedConfidence":null});
        ResponseTemplate::new(200).set_body_json(json!({"choices":[{"finish_reason":if mode == 3 {"length"} else {"stop"},
            "message":{"content":json!({"documents":[document],"citations":citations,"gaps":["No result establishes an unrestricted generalization."]}).to_string()}}]}))
    }).mount(&provider).await;
    Mock::given(method("POST"))
        .and(path("/v1/embeddings"))
        .respond_with(|request: &Request| {
            let body: Value = request.body_json().unwrap();
            let data: Vec<_> = body["input"]
                .as_array()
                .unwrap()
                .iter()
                .enumerate()
                .map(|(index, _)| json!({"index":index,"embedding":[1.0,0.0]}))
                .collect();
            let mut response = json!({"model":"test-model","data":data});
            if !body["input"][0].as_str().unwrap().contains("unreported") {
                response["usage"] = json!({"prompt_tokens":11,"total_tokens":11});
            }
            ResponseTemplate::new(200).set_body_json(response)
        })
        .mount(&provider)
        .await;
    let settings = [
        ("MINDLEAK_FORMATION", "openai".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_MODEL", "test-former".into()),
        ("MINDLEAK_RETRIEVAL", "hybrid".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
    ];
    let client = connect_configured(directory.path(), &settings).await;
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    assert_eq!(
        successful(
            &client,
            "decompose_memory",
            json!({"text":"The ordinary preview is unchanged."})
        )
        .await["results"],
        json!(["The ordinary preview is unchanged."])
    );
    let mut observations = Vec::new();
    for condition in ["alpha", "beta"] {
        observations.push(successful(&client, "write_memory", json!({"agentId":agent,"text":format!("For {query}, bounded recall reduced tokens while preserving correctness in condition {condition}."),"context":context})).await);
    }
    assert!(provider
        .received_requests()
        .await
        .unwrap()
        .iter()
        .all(|request| request.url.path() == "/v1/embeddings"));
    let normal = successful(
        &client,
        "recall_memory",
        json!({"query":query,"scope":scope,"limit":5}),
    )
    .await;
    let write = |chain: Value| json!({"agentId":agent,"text":format!("Recorded knowledge decision for {query}."),"context":context,"requestId":Uuid::new_v4(),"chain":chain});
    let validation = json!({"method":"Check controlled fixture and qualifiers","result":"Accepted only within the measured conditions","source":"synthetic:knowledge-validation","counterEvidenceReviewed":[]});
    let mut chains = Vec::new();
    let mut documents = Vec::new();
    for (index, observation) in observations.iter().enumerate() {
        let preview = successful(&client, "decompose_memory", json!({"text":format!("{query} condition {index}"),
            "formation":{"kind":"chain","fragmentIds":[observation["fragments"][0]["fragmentId"]],"scope":scope}})).await;
        assert_eq!(preview["status"], "candidate");
        assert_eq!(preview["model"], "test-former");
        let document = preview["proposal"]["documents"][0].clone();
        assert_eq!(document["formation"]["model"], "test-former");
        assert_eq!(
            document["formation"]["sourceFragmentIds"],
            json!([observation["fragments"][0]["fragmentId"]])
        );
        let chain_id = Uuid::new_v4();
        successful(
            &client,
            "write_memory",
            write(json!({"operation":"propose","chainId":chain_id,"document":document})),
        )
        .await;
        successful(&client, "write_memory", write(json!({"operation":"accept","chainId":chain_id,"expectedRevision":1,"validation":validation}))).await;
        chains.push(
            json!({"chainId":chain_id,"revision":2,"reason":"Controlled validated comparison."}),
        );
        documents.push(document);
    }
    let preview = successful(
        &client,
        "decompose_memory",
        json!({"text":format!("{query} bounded principle"),
        "formation":{"kind":"principle","chains":chains,"scope":scope}}),
    )
    .await;
    let mut principle_document = preview["proposal"]["documents"][0].clone();
    let principle_id = Uuid::new_v4();
    let proposal =
        write(json!({"operation":"propose","chainId":principle_id,"document":principle_document}));
    let receipt = successful(&client, "write_memory", proposal.clone()).await;
    assert_eq!(receipt["state"], "candidate");
    successful(&client, "write_memory", write(json!({"operation":"accept","chainId":principle_id,"expectedRevision":1,"validation":validation}))).await;
    client.cancel().await.unwrap();

    let client = connect_configured(directory.path(), &settings).await;
    let search = json!({"knowledge":{"operation":"search","query":query},"scope":scope,"limit":3});
    let knowledge = successful(&client, "recall_memory", search.clone()).await;
    assert_eq!(knowledge["strategy"], "hybrid");
    assert_eq!(knowledge["principles"].as_array().unwrap().len(), 1);
    assert_eq!(knowledge["chains"].as_array().unwrap().len(), 2);
    assert_eq!(knowledge["observations"].as_array().unwrap().len(), 2);
    assert_eq!(
        knowledge["principles"][0]["observationSources"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        knowledge["principles"][0]["supportingChains"][0]["document"]["kind"],
        "chain"
    );
    assert!(
        knowledge.get("view").is_none()
            && knowledge.get("diagnostics").is_none()
            && knowledge.get("costDiagnostics").is_none()
    );
    let compact_request = |suffix: &str| {
        json!({"knowledge":{"operation":"search","query":format!("{query} {suffix}"),
        "view":"compact","matchMode":"any","diagnostics":true,"costDiagnostics":true},"scope":scope,"limit":3})
    };
    let compact = successful(&client, "recall_memory", compact_request("diagnostic")).await;
    assert_eq!(compact["view"], "compact");
    assert_eq!(
        compact["principles"][0]["conclusion"],
        principle_document["conclusion"]
    );
    assert_eq!(
        compact["principles"][0]["applicability"],
        principle_document["applicability"]
    );
    assert_eq!(compact["diagnostics"]["keyword"]["matchMode"], "any");
    assert!(compact["diagnostics"]["keyword"]["parsedQuery"]
        .as_str()
        .unwrap()
        .contains('|'));
    assert_eq!(compact["costDiagnostics"]["providerRequestCount"], 1);
    assert_eq!(
        compact["costDiagnostics"]["providerCalls"][0]["usage"]["inputTokens"],
        11
    );
    assert!(compact["costDiagnostics"]["providerCalls"][0]["usage"]["outputTokens"].is_null());
    let cached = successful(&client, "recall_memory", compact_request("diagnostic")).await;
    assert_eq!(cached["costDiagnostics"]["providerRequestCount"], 0);
    let (shared_first, shared_second) = tokio::join!(
        successful(&client, "recall_memory", compact_request("coalesced")),
        successful(&client, "recall_memory", compact_request("coalesced"))
    );
    let shared_calls = [shared_first, shared_second]
        .iter()
        .map(|result| {
            result["costDiagnostics"]["providerRequestCount"]
                .as_u64()
                .unwrap()
        })
        .sum::<u64>();
    assert_eq!(
        shared_calls, 1,
        "a shared query embedding must be charged once"
    );
    let (first, second) = tokio::join!(
        successful(&client, "recall_memory", compact_request("first")),
        successful(&client, "recall_memory", compact_request("second"))
    );
    for result in [first, second] {
        assert_eq!(result["costDiagnostics"]["providerRequestCount"], 1);
    }
    let unknown = successful(&client, "recall_memory", compact_request("unreported")).await;
    assert_eq!(unknown["costDiagnostics"]["providerRequestCount"], 1);
    assert!(unknown["costDiagnostics"]["providerCalls"][0]["usage"]["inputTokens"].is_null());
    let unchanged = successful(
        &client,
        "recall_memory",
        json!({"query":query,"scope":scope,"limit":5}),
    )
    .await;
    assert_eq!(unchanged["results"].as_array().unwrap().len(), 2);
    for (before, after) in normal["results"]
        .as_array()
        .unwrap()
        .iter()
        .zip(unchanged["results"].as_array().unwrap())
    {
        for field in [
            "fragmentId",
            "memoryId",
            "text",
            "score",
            "lifecycle",
            "context",
        ] {
            assert_eq!(before[field], after[field]);
        }
    }
    for mode in [1, 2, 3] {
        failure.store(mode, Ordering::SeqCst);
        let failed = client.call_tool(call("decompose_memory", json!({"text":"Check this evidence.",
            "formation":{"kind":"chain","fragmentIds":[observations[0]["fragments"][0]["fragmentId"]],"scope":scope}}))).await.unwrap();
        assert_eq!(failed.is_error, Some(true));
    }
    failure.store(0, Ordering::SeqCst);
    let counter = successful(&client, "write_memory", json!({"agentId":agent,"text":format!("For {query}, bounded recall increased tokens on the gamma task."),"context":context})).await;
    let counter_id = counter["fragments"][0]["fragmentId"].clone();
    let evidence = json!({"fragmentId":counter_id,"role":"counterexample","reason":"Gamma is an explicit counterexample to broader application."});
    let first_chain = &chains[0]["chainId"];
    successful(&client, "write_memory", write(json!({"operation":"challenge","chainId":first_chain,"expectedRevision":2,"evidence":[evidence]}))).await;
    assert!(
        successful(&client, "recall_memory", search.clone()).await["principles"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let dependents = successful(
        &client,
        "recall_memory",
        json!({"knowledge":{"operation":"dependents","chainId":first_chain},"scope":scope}),
    )
    .await;
    assert_eq!(
        dependents["entries"][0]["chain"]["chainId"],
        principle_id.to_string()
    );
    assert_eq!(dependents["entries"][0]["requiresReview"], true);
    let review = successful(
        &client,
        "recall_memory",
        json!({"knowledge":{"operation":"review"},"scope":scope,"limit":1}),
    )
    .await;
    assert_eq!(review["entries"].as_array().unwrap().len(), 1);
    assert!(review["next"].is_string());
    let next = successful(
        &client,
        "recall_memory",
        json!({"knowledge":{"operation":"review","after":review["next"]},"scope":scope,"limit":1}),
    )
    .await;
    assert_eq!(next["entries"].as_array().unwrap().len(), 1);
    assert!(next["next"].is_null());
    successful(&client, "write_memory", write(json!({"operation":"challenge","chainId":principle_id,"expectedRevision":2,"evidence":[evidence]}))).await;
    documents[0]["evidence"]
        .as_array_mut()
        .unwrap()
        .push(evidence.clone());
    documents[0]["applicability"] = json!("Alpha only; gamma is explicitly excluded.");
    successful(&client, "write_memory", write(json!({"operation":"revise","chainId":first_chain,"expectedRevision":3,"document":documents[0]}))).await;
    let mut validation = validation;
    validation["counterEvidenceReviewed"] = json!([counter_id]);
    successful(&client, "write_memory", write(json!({"operation":"accept","chainId":first_chain,"expectedRevision":4,"validation":validation}))).await;
    principle_document["supportedBy"][0]["revision"] = json!(5);
    principle_document["evidence"] = json!([evidence]);
    principle_document["applicability"] =
        json!("Alpha and beta only; gamma is excluded by recorded counterevidence.");
    successful(&client, "write_memory", write(json!({"operation":"revise","chainId":principle_id,"expectedRevision":3,"document":principle_document}))).await;
    successful(&client, "write_memory", write(json!({"operation":"accept","chainId":principle_id,"expectedRevision":4,"validation":validation}))).await;
    let compact = successful(&client, "recall_memory", compact_request("diagnostic")).await;
    assert_eq!(compact["principles"][0]["revision"], 5);
    assert_eq!(
        compact["principles"][0]["applicability"],
        principle_document["applicability"]
    );
    assert_eq!(
        compact["principles"][0]["counterevidence"][0]["fragmentId"],
        counter_id
    );
    assert_eq!(
        compact["principles"][0]["counterevidence"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    assert!(compact["principles"][0]["counterevidence"][0]["reasons"]
        .as_array()
        .unwrap()
        .iter()
        .any(|reason| reason.as_str().unwrap().contains("Gamma")));
    assert!(
        compact["principles"][0].get("document").is_none()
            && compact["principles"][0].get("rawText").is_none()
    );
    assert!(
        serde_json::to_vec(&compact).unwrap().len() < serde_json::to_vec(&knowledge).unwrap().len()
    );
    let mut foreign = compact_request("diagnostic");
    foreign["scope"] = json!(format!("unrelated-{scope}"));
    let foreign = successful(&client, "recall_memory", foreign).await;
    assert!(
        foreign["principles"].as_array().unwrap().is_empty()
            && foreign["chains"].as_array().unwrap().is_empty()
            && foreign["observations"].as_array().unwrap().is_empty()
    );
    assert_eq!(
        successful(&client, "recall_memory", search).await["principles"][0]["chain"]["revision"],
        5
    );
    for format in ["json", "markdown"] {
        let export = successful(&client, "recall_memory", json!({"knowledge":{"operation":"export","chainId":principle_id,"format":format},"scope":scope,"limit":2})).await;
        assert_eq!(export["snapshot"]["chain"]["revision"], 5);
        assert_eq!(export["snapshot"]["nextRevision"], 2);
        assert_eq!(
            export["snapshot"]["evidence"][0]["reference"]["fragmentId"],
            counter_id
        );
        if format == "markdown" {
            assert!(export["markdown"]
                .as_str()
                .unwrap()
                .contains("gamma is excluded"));
        }
    }
    assert!(client
        .call_tool(call(
            "recall_memory",
            json!({"knowledge":{"operation":"search","query":query},"query":query})
        ))
        .await
        .is_err());
    successful(
        &client,
        "write_memory",
        write(json!({"operation":"retire","chainId":principle_id,"expectedRevision":5})),
    )
    .await;
    assert_eq!(successful(&client, "write_memory", proposal).await, receipt);
    client.cancel().await.unwrap();
    let client = connect(directory.path(), None).await;
    assert!(client.call_tool(call("decompose_memory", json!({"text":"Disabled by default.","formation":{"kind":"chain","fragmentIds":[observations[0]["fragments"][0]["fragmentId"]]}}))).await.is_err());
    let export = successful(&client, "recall_memory", json!({"knowledge":{"operation":"export","chainId":principle_id},"scope":scope,"includeInactive":true})).await;
    assert_eq!(export["snapshot"]["chain"]["revision"], 6);
    client.cancel().await.unwrap();
    let (database, task) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let task = tokio::spawn(task);
    let row = database.query_one("SELECT count(*), count(*) FILTER (WHERE chain_id IS NOT NULL) FROM public.memories WHERE agent_id=$1", &[&agent]).await.unwrap();
    assert_eq!(
        row.get::<_, i64>(0),
        16,
        "formation previews and failures must not persist source episodes"
    );
    assert_eq!(row.get::<_, i64>(1), 13);
    drop(database);
    task.await.unwrap().unwrap();
}

#[tokio::test]
async fn chains_form_revise_and_remain_opt_in_across_fresh_mcp_sessions() {
    let directory = tempfile::tempdir().unwrap();
    let agent = format!("chains-mcp-{}", Uuid::new_v4());
    let scope = format!("scope-{agent}");
    let query = format!("chaintrial{}", Uuid::new_v4().simple());
    let chain_id = Uuid::new_v4();
    let context =
        json!({"scope":scope,"source":"synthetic:chain-milestone","sessionId":Uuid::new_v4()});
    let text = format!("For {query}, retrieval reduced input tokens on the controlled task.");
    let client = connect(directory.path(), None).await;
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 3);
    assert!(tools
        .iter()
        .find(|tool| tool.name == "write_memory")
        .unwrap()
        .input_schema["properties"]
        .get("chain")
        .is_some());
    let observation = successful(
        &client,
        "write_memory",
        json!({"agentId":agent,"text":text,"context":context}),
    )
    .await;
    let normal = successful(
        &client,
        "recall_memory",
        json!({"query":query,"scope":scope,"limit":5}),
    )
    .await;
    let mut document = json!({
        "claim":format!("Retrieval helps {query}"), "rationale":"A controlled comparison recorded lower input usage.",
        "conclusion":"Use retrieval for the measured task.", "applicability":"The controlled fixture only.",
        "assumptions":["Answer correctness was held constant."],
        "evidence":[{"fragmentId":observation["fragments"][0]["fragmentId"],"role":"supports","reason":"Recorded outcome."}]
    });
    let proposal = json!({"agentId":agent,"text":format!("Candidate for {query}; raw source is preserved."),"context":context,"requestId":Uuid::new_v4(),
        "chain":{"operation":"propose","chainId":chain_id,"document":document}});
    let first = successful(&client, "write_memory", proposal.clone()).await;
    assert_eq!(first["revision"], 1);
    assert_eq!(first["state"], "candidate");
    assert_eq!(
        successful(&client, "write_memory", proposal.clone()).await,
        first
    );
    let chain_search = json!({"chain":{"operation":"search","query":query},"scope":scope});
    assert!(
        successful(&client, "recall_memory", chain_search.clone()).await["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    let changed = successful(
        &client,
        "recall_memory",
        json!({"query":query,"scope":scope,"includeInactive":true,"limit":50}),
    )
    .await;
    assert_eq!(changed["results"].as_array().unwrap().len(), 1);
    for field in [
        "memoryId",
        "fragmentId",
        "text",
        "score",
        "context",
        "lifecycle",
    ] {
        assert_eq!(
            changed["results"][0][field], normal["results"][0][field],
            "ordinary recall changed field {field}"
        );
    }
    let write = |operation: Value| json!({"agentId":agent,"text":format!("Recorded chain decision for {query}."),"context":context,"requestId":Uuid::new_v4(),"chain":operation});
    let validation = json!({"method":"Review controlled fixture","result":"Accepted only for the measured task","source":"synthetic:validation","counterEvidenceReviewed":[]});
    let accepted = successful(&client, "write_memory", write(json!({"operation":"accept","chainId":chain_id,"expectedRevision":1,"validation":validation}))).await;
    assert_eq!(accepted["revision"], 2);
    client.cancel().await.unwrap();

    let client = connect(directory.path(), None).await;
    let found = successful(&client, "recall_memory", chain_search.clone()).await;
    assert_eq!(found["kind"], "chains");
    assert_eq!(found["strategy"], "keyword");
    assert_eq!(
        found["results"][0]["chain"]["chainId"],
        chain_id.to_string()
    );
    let inspection =
        json!({"chain":{"operation":"inspect","chainId":chain_id},"scope":scope,"limit":2});
    let inspected = successful(&client, "recall_memory", inspection.clone()).await;
    assert_eq!(
        inspected["evidence"][0]["memoryId"],
        observation["memoryId"]
    );
    assert_eq!(inspected["evidence"][0]["text"], text);
    assert_eq!(inspected["requiresReview"], false);
    let counter = successful(&client, "write_memory", json!({"agentId":agent,"text":format!("For {query}, retrieval failed on a different task."),"context":context})).await;
    let counter_id = &counter["fragments"][0]["fragmentId"];
    let evidence = json!({"fragmentId":counter_id,"role":"counterexample","reason":"The broader claim failed on another task."});
    let challenged = successful(&client, "write_memory", write(json!({"operation":"challenge","chainId":chain_id,"expectedRevision":2,"evidence":[evidence]}))).await;
    assert_eq!(challenged["review"], "challenged");
    assert!(
        successful(&client, "recall_memory", chain_search.clone()).await["results"]
            .as_array()
            .unwrap()
            .is_empty()
    );
    document["evidence"].as_array_mut().unwrap().push(evidence);
    document["applicability"] =
        json!("Only the original task; exclude the demonstrated counterexample.");
    let revised = successful(&client, "write_memory", write(json!({"operation":"revise","chainId":chain_id,"expectedRevision":3,"document":document}))).await;
    assert_eq!(revised["state"], "candidate");
    let mut validation = validation;
    validation["counterEvidenceReviewed"] = json!([counter_id]);
    successful(&client, "write_memory", write(json!({"operation":"accept","chainId":chain_id,"expectedRevision":4,"validation":validation}))).await;
    let current = successful(&client, "recall_memory", chain_search.clone()).await;
    assert_eq!(current["results"][0]["chain"]["revision"], 5);
    assert_eq!(
        current["results"][0]["chain"]["snapshot"]["document"]["evidence"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    let history = successful(&client, "recall_memory", inspection.clone()).await;
    assert_eq!(history["nextRevision"], 2);
    let remaining = successful(&client, "recall_memory", json!({"chain":{"operation":"inspect","chainId":chain_id,"afterRevision":2},"scope":scope,"limit":5})).await;
    assert_eq!(remaining["history"].as_array().unwrap().len(), 3);
    assert!(remaining["nextRevision"].is_null());
    let mixed = client
        .call_tool(call(
            "recall_memory",
            json!({"query":query,"chain":{"operation":"search","query":query}}),
        ))
        .await;
    assert!(
        mixed.is_err(),
        "mixed modes must not silently discard legacy arguments"
    );
    successful(
        &client,
        "write_memory",
        write(json!({"operation":"retire","chainId":chain_id,"expectedRevision":5})),
    )
    .await;
    client.cancel().await.unwrap();

    let provider = MockServer::start().await;
    let client = connect(directory.path(), Some(&format!("{}/v1", provider.uri()))).await;
    let replay = successful(&client, "write_memory", proposal.clone()).await;
    assert_eq!(
        replay, first,
        "replay must preserve the original receipt after retirement and before any model call"
    );
    let mut inspection = inspection;
    inspection["includeInactive"] = json!(true);
    assert_eq!(
        successful(&client, "recall_memory", inspection).await["chain"]["revision"],
        6
    );
    let mut chain_search = chain_search;
    chain_search["includeInactive"] = json!(true);
    assert!(provider.received_requests().await.unwrap().is_empty());
    let unavailable_relevance = client
        .call_tool(call("recall_memory", chain_search))
        .await
        .unwrap();
    assert_eq!(unavailable_relevance.is_error, Some(true));
    assert_eq!(provider.received_requests().await.unwrap().len(), 1);
    let mut failed = proposal;
    failed["requestId"] = json!(Uuid::new_v4());
    failed["chain"]["chainId"] = json!(Uuid::new_v4());
    let result = client
        .call_tool(call("write_memory", failed))
        .await
        .unwrap();
    assert_eq!(result.is_error, Some(true));
    assert_eq!(provider.received_requests().await.unwrap().len(), 2);
    client.cancel().await.unwrap();
    let (database, task) = tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
        .await
        .unwrap();
    let task = tokio::spawn(task);
    let row = database.query_one("SELECT count(*), count(*) FILTER (WHERE chain_id IS NOT NULL) FROM public.memories WHERE agent_id=$1", &[&agent]).await.unwrap();
    assert_eq!(row.get::<_, i64>(0), 8);
    assert_eq!(row.get::<_, i64>(1), 6);
    drop(database);
    task.await.unwrap().unwrap();
}
