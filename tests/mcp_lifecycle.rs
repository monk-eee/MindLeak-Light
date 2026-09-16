use super::*;

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
