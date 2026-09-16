use super::*;

#[tokio::test]
async fn companion_recipes_support_fresh_client_handoff_and_correction() {
    use std::collections::HashMap;

    fn substitute(value: &Value, bindings: &HashMap<&str, Value>) -> Value {
        match value {
            Value::String(text) if text.starts_with('$') => bindings
                .get(text.as_str())
                .unwrap_or_else(|| panic!("unbound recipe placeholder: {text}"))
                .clone(),
            Value::Array(values) => Value::Array(
                values
                    .iter()
                    .map(|value| substitute(value, bindings))
                    .collect(),
            ),
            Value::Object(object) => Value::Object(
                object
                    .iter()
                    .map(|(key, value)| (key.clone(), substitute(value, bindings)))
                    .collect(),
            ),
            _ => value.clone(),
        }
    }

    fn recipe(
        recipes: &Value,
        name: &str,
        bindings: &HashMap<&str, Value>,
    ) -> CallToolRequestParams {
        let request = &recipes["calls"][name];
        let arguments = substitute(&request["arguments"], bindings);
        CallToolRequestParams::new(request["name"].as_str().unwrap().to_owned())
            .with_arguments(arguments.as_object().unwrap().clone())
    }

    let recipes: Value = serde_json::from_str(include_str!(
        "../.agents/skills/mindleak-memory/references/tool-recipes.json"
    ))
    .unwrap();
    assert_eq!(recipes["skillVersion"], "1.0.0");
    let scope = format!("companion-{}", Uuid::new_v4());
    let writer = format!("companion-writer-{}", Uuid::new_v4());
    let mut bindings = HashMap::from([
        ("$AGENT_ID", json!(writer)),
        ("$SCOPE", json!(scope)),
        ("$SESSION_ID", json!(Uuid::new_v4())),
        ("$REQUEST_ID", json!(Uuid::new_v4())),
    ]);
    let directory = tempfile::tempdir().unwrap();
    let mut original_receipt = Value::Null;
    let mut correction_receipt = Value::Null;
    let mut database = None;
    for phase in 0..3 {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
        command.current_dir(directory.path()).env_clear().envs([
            ("MINDLEAK_DATABASE_URL", database_url()),
            ("MINDLEAK_DECOMPOSITION", "sentences".into()),
            ("MINDLEAK_RETRIEVAL", "keyword".into()),
            ("MINDLEAK_RELEVANCE", "off".into()),
        ]);
        let client = tokio::time::timeout(
            Duration::from_secs(15),
            ().serve(TokioChildProcess::new(command).unwrap()),
        )
        .await
        .unwrap()
        .unwrap();
        let tools = client.list_all_tools().await.unwrap();
        assert_eq!(tools.len(), 3);
        for request in recipes["calls"].as_object().unwrap().values() {
            assert!(tools
                .iter()
                .any(|tool| tool.name.as_ref() == request["name"].as_str().unwrap()));
        }
        if phase == 0 {
            let (connection, task) =
                tokio_postgres::connect(&database_url(), tokio_postgres::NoTls)
                    .await
                    .unwrap();
            tokio::spawn(async move { task.await.unwrap() });
            database = Some(connection);
            let preview = client
                .call_tool(recipe(&recipes, "preview", &bindings))
                .await
                .unwrap();
            assert_ne!(preview.is_error, Some(true));
            assert_eq!(
                preview.structured_content.unwrap()["results"],
                json!([recipes["calls"]["remember"]["arguments"]["text"]])
            );
            let preview_count: i64 = database
                .as_ref()
                .unwrap()
                .query_one(
                    "SELECT count(*) FROM public.memories WHERE context->>'scope' = $1",
                    &[&scope],
                )
                .await
                .unwrap()
                .get(0);
            assert_eq!(preview_count, 0, "preview is not persistence");
            let written = client
                .call_tool(recipe(&recipes, "remember", &bindings))
                .await
                .unwrap();
            assert_ne!(written.is_error, Some(true));
            original_receipt = written.structured_content.unwrap();
            assert_eq!(original_receipt["fragments"].as_array().unwrap().len(), 1);
            let retry = client
                .call_tool(recipe(&recipes, "remember", &bindings))
                .await
                .unwrap();
            assert_ne!(retry.is_error, Some(true));
            assert_eq!(retry.structured_content.unwrap(), original_receipt);
        } else {
            bindings.insert(
                "$AGENT_ID",
                json!(format!("companion-reader-{phase}-{}", Uuid::new_v4())),
            );
            bindings.insert("$SESSION_ID", json!(Uuid::new_v4()));
            bindings.insert("$REQUEST_ID", json!(Uuid::new_v4()));
            let recalled = client
                .call_tool(recipe(&recipes, "search", &bindings))
                .await
                .unwrap();
            assert_ne!(recalled.is_error, Some(true));
            let results = recalled.structured_content.unwrap();
            let facts = results["results"].as_array().unwrap();
            assert_eq!(facts.len(), 1);
            let fact = &facts[0];
            let expected = if phase == 1 {
                &original_receipt
            } else {
                &correction_receipt
            };
            assert_eq!(fact["memoryId"], expected["memoryId"]);
            assert_eq!(fact["text"], expected["fragments"][0]["text"]);
            assert_ne!(
                fact["agentId"], bindings["$AGENT_ID"],
                "shared recall must cross contributor IDs"
            );
            assert_eq!(fact["lifecycle"]["usefulSessions"], 0);
            assert_eq!(fact["lifecycle"]["confirmedSessions"], 0);
            bindings.insert("$FRAGMENT_ID", fact["fragmentId"].clone());
            let inspected = client
                .call_tool(recipe(&recipes, "inspect", &bindings))
                .await
                .unwrap();
            assert_ne!(inspected.is_error, Some(true));
            let inspected = inspected.structured_content.unwrap();
            assert_eq!(inspected["rawText"], fact["text"]);
            assert_eq!(inspected["context"]["scope"], scope);
            assert_eq!(inspected["lifecycle"]["state"], "active");
            let expanded = client
                .call_tool(recipe(&recipes, "document_search", &bindings))
                .await
                .unwrap();
            assert_ne!(expanded.is_error, Some(true));
            let expanded = expanded.structured_content.unwrap();
            assert!(expanded["diagnostics"].is_object());
            assert_eq!(expanded["results"][0]["memoryId"], fact["memoryId"]);
            assert_eq!(expanded["results"][0]["sourceCount"], 1);

            bindings.insert("$SCOPE", json!(format!("unrelated-{}", Uuid::new_v4())));
            let unrelated = client
                .call_tool(recipe(&recipes, "search", &bindings))
                .await
                .unwrap();
            assert_ne!(unrelated.is_error, Some(true));
            assert!(unrelated.structured_content.unwrap()["results"]
                .as_array()
                .unwrap()
                .is_empty());
            bindings.insert("$SCOPE", json!(scope));
            let row = database.as_ref().unwrap().query_one(
                "SELECT (SELECT count(*) FROM public.memories WHERE context->>'scope' = $1), \
                 (SELECT COALESCE(sum(fragments.useful_sessions + fragments.confirmed_sessions), 0)::bigint \
                 FROM public.fragments JOIN public.memories ON memories.id = fragments.memory_id WHERE memories.context->>'scope' = $1)",
                &[&scope],
            ).await.unwrap();
            assert_eq!(
                row.get::<_, i64>(0),
                phase as i64,
                "read-only handoff added an episode"
            );
            assert_eq!(
                row.get::<_, i64>(1),
                0,
                "recall or inspection reinforced evidence"
            );
            if phase == 1 {
                let corrected = client
                    .call_tool(recipe(&recipes, "correct", &bindings))
                    .await
                    .unwrap();
                assert_ne!(corrected.is_error, Some(true));
                correction_receipt = corrected.structured_content.unwrap();
                let replay = client
                    .call_tool(recipe(&recipes, "correct", &bindings))
                    .await
                    .unwrap();
                assert_ne!(replay.is_error, Some(true));
                assert_eq!(replay.structured_content.unwrap(), correction_receipt);
            } else {
                let history = client
                    .call_tool(recipe(&recipes, "history", &bindings))
                    .await
                    .unwrap();
                assert_ne!(history.is_error, Some(true));
                let history = history.structured_content.unwrap();
                assert!(history["results"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|fact| fact["memoryId"] == original_receipt["memoryId"]
                        && fact["lifecycle"]["state"] == "superseded"));
                let feedback = client
                    .call_tool(recipe(&recipes, "usefulness", &bindings))
                    .await
                    .unwrap();
                assert_ne!(feedback.is_error, Some(true));
                let counters = database.as_ref().unwrap().query_one(
                    "SELECT useful_sessions, confirmed_sessions FROM public.fragments WHERE id = $1",
                    &[&Uuid::parse_str(fact["fragmentId"].as_str().unwrap()).unwrap()],
                ).await.unwrap();
                assert_eq!(counters.get::<_, i32>(0), 1);
                assert_eq!(counters.get::<_, i32>(1), 0);
            }
        }
        let stopped_peer = client.peer().clone();
        client.cancel().await.unwrap();
        if phase == 2 {
            bindings.insert("$REQUEST_ID", json!(Uuid::new_v4()));
            let failed = tokio::time::timeout(
                Duration::from_secs(2),
                stopped_peer.call_tool(recipe(&recipes, "remember", &bindings)),
            )
            .await
            .unwrap();
            assert!(
                failed.is_err(),
                "a stopped server must not report persistence"
            );
        }
    }
    let final_count: i64 = database
        .unwrap()
        .query_one(
            "SELECT count(*) FROM public.memories WHERE context->>'scope' = $1",
            &[&scope],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        final_count, 3,
        "only the original, correction, and explicit usefulness episode persist"
    );
}

#[tokio::test]
async fn fragment_inspection_preserves_source_and_pages_evidence_without_models() {
    let directory = tempfile::tempdir().unwrap();
    let scope = format!("inspection-{}", Uuid::new_v4());
    let agent_id = format!("inspection-agent-{}", Uuid::new_v4());
    let raw = "  Atlas migration has not been approved.\nOnly staging uses SQLite.  ";
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", database_url());
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let written = client.call_tool(call("write_memory", json!({
        "agentId": agent_id, "text": raw, "context": {"scope": scope, "source": "original note"}
    }))).await.unwrap().structured_content.unwrap();
    let target = written["fragments"][0]["fragmentId"].clone();
    let mut expected = std::collections::HashSet::new();
    for index in 0..10 {
        let text = format!("Review source {index} recorded an explicit claim.");
        let kind = if index == 9 {
            "contradicts"
        } else {
            "confirms"
        };
        let feedback = client.call_tool(call("write_memory", json!({
            "agentId": agent_id, "text": text,
            "context": {"scope": scope, "sessionId": format!("review-{index}")},
            "facts": [{"text": text, "links": [{"targetFragmentId": target, "relationshipType": kind}]}]
        }))).await.unwrap().structured_content.unwrap();
        expected.insert(
            feedback["fragments"][0]["fragmentId"]
                .as_str()
                .unwrap()
                .to_owned(),
        );
    }
    client.cancel().await.unwrap();

    let provider = MockServer::start().await;
    Mock::given(method("POST"))
        .respond_with(ResponseTemplate::new(503))
        .expect(0)
        .mount(&provider)
        .await;
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command.current_dir(directory.path()).env_clear().envs([
        ("MINDLEAK_DATABASE_URL", database_url()),
        ("MINDLEAK_DECOMPOSITION", "openai".into()),
        ("MINDLEAK_MODEL", "test-model".into()),
        ("MINDLEAK_LLM_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_RETRIEVAL", "vector".into()),
        ("MINDLEAK_EMBED_MODEL", "test-model".into()),
        ("MINDLEAK_EMBED_URL", format!("{}/v1", provider.uri())),
        ("MINDLEAK_EMBED_DIMENSIONS", "2".into()),
        ("MINDLEAK_RELEVANCE", "openai".into()),
        ("MINDLEAK_RELEVANCE_MODEL", "test-model".into()),
        ("MINDLEAK_RELEVANCE_URL", format!("{}/v1", provider.uri())),
    ]);
    let client = ().serve(TokioChildProcess::new(command).unwrap()).await.unwrap();
    let tools = client.list_all_tools().await.unwrap();
    assert_eq!(tools.len(), 3);
    let mut after = Value::Null;
    let mut seen = std::collections::HashSet::new();
    for page_number in 0..5 {
        let result = client.call_tool(call("recall_memory", json!({
            "fragmentId": target, "agentId": agent_id, "scope": scope, "limit": 3, "after": after
        }))).await.expect("recall_memory must accept a fragment inspection without a query");
        assert_ne!(result.is_error, Some(true));
        let page = result.structured_content.unwrap();
        assert_eq!(page["rawText"], raw);
        assert_eq!(page["memoryId"], written["memoryId"]);
        assert_eq!(page["fragmentId"], target);
        assert_eq!(page["context"]["source"], "original note");
        assert_eq!(page["lifecycle"]["evidence"], "disputed");
        assert!(page["scannedRelationships"].as_u64().unwrap() <= 128);
        let links = page["relationships"].as_array().unwrap();
        assert!(links.len() <= 3);
        if page_number == 0 {
            assert_eq!(links[0]["relationshipType"], "contradicts");
            let mut invalid_cursor = page["nextCursor"].clone();
            invalid_cursor["fragmentId"] = json!(Uuid::new_v4());
            assert!(client
                .call_tool(call(
                    "recall_memory",
                    json!({
                        "fragmentId": target, "after": invalid_cursor
                    })
                ))
                .await
                .is_err());
        }
        for link in links {
            assert!(
                seen.insert(link["fragmentId"].as_str().unwrap().to_owned()),
                "pagination repeated a link"
            );
        }
        let next = page["nextCursor"].clone();
        if next.is_null() {
            break;
        }
        assert_ne!(next, after, "cursor must advance");
        after = next;
        assert!(
            page_number < 4,
            "inspection did not finish its finite link set"
        );
    }
    assert_eq!(seen, expected);
    for arguments in [
        json!({"fragmentId": target, "scope": "wrong-scope"}),
        json!({"fragmentId": target, "agentId": "wrong-agent"}),
        json!({"fragmentId": target, "limit": 9}),
        json!({"fragmentId": target, "query": "Atlas"}),
        json!({"query": "Atlas", "after": after}),
        json!({}),
    ] {
        assert!(client
            .call_tool(call("recall_memory", arguments))
            .await
            .is_err());
    }
    assert!(provider.received_requests().await.unwrap().is_empty());
    client.cancel().await.unwrap();
}

#[tokio::test]
async fn contextual_fact_lifecycle_works_through_the_three_model_free_tools() {
    let directory = tempfile::tempdir().unwrap();
    let scope = format!("project-{}", Uuid::new_v4());
    let mut command = Command::new(env!("CARGO_BIN_EXE_mindleak-light"));
    command
        .current_dir(directory.path())
        .env_clear()
        .env("MINDLEAK_DATABASE_URL", database_url());
    let client = tokio::time::timeout(
        Duration::from_secs(15),
        ().serve(TokioChildProcess::new(command).unwrap()),
    )
    .await
    .unwrap()
    .unwrap();
    assert_eq!(client.list_all_tools().await.unwrap().len(), 3);
    let fact = "User prefers PRs under 500 LOC.";
    let written = client.call_tool(call("write_memory", json!({
        "agentId": "review-agent", "text": format!("{fact} The current build is running."),
        "context": {"scope": scope, "sessionId": "planning", "source": "user", "summary": "Review policy"},
        "facts": [{"text": fact, "tier": "long_term", "pinned": true, "importance": 0.9}]
    }))).await.unwrap();
    assert_ne!(written.is_error, Some(true));
    let saved = written.structured_content.unwrap();
    let fragments = saved["fragments"].as_array().unwrap();
    assert_eq!(fragments.len(), 2);
    assert_eq!(fragments[0]["tier"], "long_term");
    assert_eq!(fragments[1]["tier"], "short_term");
    let original_id = fragments[0]["fragmentId"].as_str().unwrap();
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "500", "scope": scope, "tier": "long_term"
            }),
        ))
        .await
        .unwrap();
    let recalled = recalled.structured_content.unwrap();
    assert_eq!(
        recalled["results"][0]["context"]["summary"],
        "Review policy"
    );
    assert_eq!(
        recalled["results"][0]["lifecycle"]["evidence"],
        "unconfirmed"
    );
    assert_eq!(recalled["results"][0]["activation"], 1.0);
    assert_eq!(
        recalled["results"][0]["rankingPriority"],
        recalled["results"][0]["score"]
    );
    assert_eq!(recalled["results"][0]["relationshipCount"], 0);
    assert_eq!(recalled["results"][0]["relationshipsTruncated"], false);

    let confirmation = "The user confirmed the pull request preference.";
    let feedback = client.call_tool(call("write_memory", json!({
        "agentId": "review-agent", "text": confirmation,
        "context": {"scope": scope, "sessionId": "review-01", "source": "user confirmation"},
        "facts": [{"text": confirmation, "links": [{"targetFragmentId": original_id, "relationshipType": "confirms"}]}]
    }))).await.unwrap();
    assert_ne!(feedback.is_error, Some(true));
    let recalled = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "500", "scope": scope}),
        ))
        .await
        .unwrap();
    let recalled = recalled.structured_content.unwrap();
    assert_eq!(recalled["results"][0]["lifecycle"]["confirmedSessions"], 1);
    assert_eq!(recalled["results"][0]["lifecycle"]["evidence"], "confirmed");
    assert_eq!(recalled["results"][0]["relationshipCount"], 1);
    assert_eq!(recalled["results"][0]["relationshipsTruncated"], false);
    assert_eq!(
        recalled["results"][0]["relationships"][0]["relationshipType"],
        "confirms"
    );
    assert_eq!(
        recalled["results"][0]["relationships"][0]["context"]["sessionId"],
        "review-01"
    );

    let correction = "User prefers PRs under 300 LOC.";
    let corrected = client.call_tool(call("write_memory", json!({
        "agentId": "review-agent", "text": correction,
        "context": {"scope": scope, "sessionId": "review-02", "source": "user correction"},
        "facts": [{"text": correction, "tier": "long_term", "links": [{"targetFragmentId": original_id, "relationshipType": "supersedes"}]}]
    }))).await.unwrap();
    assert_ne!(corrected.is_error, Some(true));
    let old = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "500", "scope": scope}),
        ))
        .await
        .unwrap();
    assert!(old.structured_content.unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    let historical = client
        .call_tool(call(
            "recall_memory",
            json!({
                "query": "500", "scope": scope, "includeInactive": true
            }),
        ))
        .await
        .unwrap();
    assert_eq!(
        historical.structured_content.unwrap()["results"][0]["lifecycle"]["state"],
        "superseded"
    );
    let current = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "300", "scope": scope}),
        ))
        .await
        .unwrap();
    let current = current.structured_content.unwrap();
    assert_eq!(current["results"][0]["text"], correction);
    assert_eq!(
        current["results"][0]["relationships"][0]["fragmentId"],
        original_id
    );
    assert_eq!(
        current["results"][0]["relationships"][0]["state"],
        "superseded"
    );
    let different_scope = client
        .call_tool(call(
            "recall_memory",
            json!({"query": "300", "scope": "other-project"}),
        ))
        .await
        .unwrap();
    assert!(different_scope.structured_content.unwrap()["results"]
        .as_array()
        .unwrap()
        .is_empty());
    let invalid = client.call_tool(call("write_memory", json!({
        "agentId": "review-agent", "text": "An unrelated observation.",
        "context": {"scope": "other-project"},
        "facts": [{"text": "An unrelated observation.", "links": [{"targetFragmentId": original_id, "relationshipType": "related"}]}]
    }))).await;
    assert!(invalid.is_err());
    client.cancel().await.unwrap();
}
