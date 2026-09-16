use super::*;
use mindleak_memory::{
    EvidenceStatus, FactLink, FactState, PreparedRelationship, RelationshipType,
};

fn episode(
    original: &PreparedMemory,
    relation: RelationshipType,
    session: Option<&str>,
) -> PreparedMemory {
    let mut evidence = memory(&original.agent_id);
    evidence.context = original.context.clone();
    evidence.context.session_id = session.map(str::to_owned);
    evidence.context.source = Some("explicit agent feedback".into());
    evidence.raw_text = "Evidence recorded for the policy.".into();
    evidence.fragments.truncate(1);
    evidence.fragments[0].text = evidence.raw_text.clone();
    evidence.fragments[0].embedding = Some(vec![0.0, 1.0]);
    evidence.relationships.push(PreparedRelationship {
        source_fragment: evidence.fragments[0].id,
        target_fragment: original.fragments[0].id,
        relationship_type: relation,
    });
    evidence
}

#[tokio::test]
async fn idempotent_lifecycle_retry_preserves_receipt_without_reapplying_links() {
    let (store, database) = setup().await;
    let original = memory(&format!("idempotent-lifecycle-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    let mut archive = episode(&original, RelationshipType::Archives, None);
    archive.request = Some(WriteRequest {
        request_id: Uuid::new_v4(),
        agent_id: archive.agent_id.clone(),
        text: archive.raw_text.clone(),
        context: archive.context.clone(),
        facts: vec![FactDirective {
            text: archive.fragments[0].text.clone(),
            links: vec![FactLink {
                target_fragment_id: original.fragments[0].id,
                relationship_type: RelationshipType::Archives,
            }],
            ..Default::default()
        }],
    });
    let receipt = store.save(&archive).await.unwrap();
    store
        .save(&episode(&original, RelationshipType::Restores, None))
        .await
        .unwrap();
    database
        .execute(
            "UPDATE public.fragments SET tier = 'long_term' WHERE memory_id = $1",
            &[&archive.id],
        )
        .await
        .unwrap();
    assert_eq!(receipt.fragments[0].tier, MemoryTier::ShortTerm);
    assert_eq!(
        store
            .lookup_write(archive.request.as_ref().unwrap())
            .await
            .unwrap(),
        Some(receipt.clone())
    );
    let mut retried = archive.clone();
    retried.id = Uuid::new_v4();
    retried.fragments[0].id = Uuid::new_v4();
    retried.relationships[0].source_fragment = retried.fragments[0].id;
    assert_eq!(store.save(&retried).await.unwrap(), receipt);
    let state: String = database
        .query_one(
            "SELECT state FROM public.fragments WHERE id = $1",
            &[&original.fragments[0].id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        state, "active",
        "retry must not archive a subsequently restored fact"
    );
    let links: i64 = database.query_one(
        "SELECT count(*) FROM public.relationships WHERE target_fragment = $1 AND relationship_type = 'archives'",
        &[&original.fragments[0].id],
    ).await.unwrap().get(0);
    assert_eq!(links, 1);
}

#[tokio::test]
async fn recalled_facts_include_scope_and_explicit_related_fact_context() {
    let (store, _) = setup().await;
    let mut original = memory(&format!("context-{}", Uuid::new_v4()));
    original.context = MemoryContext {
        scope: Some(format!("project-{}", Uuid::new_v4())),
        session_id: Some("planning".into()),
        source: Some("user".into()),
        summary: Some("Pull request policy".into()),
    };
    store.save(&original).await.unwrap();
    let evidence = episode(&original, RelationshipType::Supports, Some("review"));
    store.save(&evidence).await.unwrap();
    let mut scope = filter(Some(&original.agent_id));
    scope.scope = original.context.scope.clone();
    let retriever = KeywordMemoryRetriever::new(store);
    let matches = retriever.recall("small PRs", &scope, 5).await.unwrap();
    assert_eq!(matches.len(), 1);
    assert_eq!(matches[0].context, original.context);
    assert_eq!(matches[0].lifecycle.tier, MemoryTier::ShortTerm);
    assert_eq!(matches[0].relationship_count, 1);
    let related = &matches[0].relationships[0];
    assert_eq!(related.fragment_id, evidence.fragments[0].id);
    assert_eq!(related.memory_id, evidence.id);
    assert_eq!(related.context, evidence.context);
    assert_eq!(related.relationship_type, RelationshipType::Supports);
    assert_eq!(related.direction, "incoming");
    scope.scope = Some("other-project".into());
    assert!(retriever
        .recall("small PRs", &scope, 5)
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn confirmations_consolidate_only_one_fact_and_preserve_its_pgvector_embedding() {
    let (store, database) = setup().await;
    let original = memory(&format!("consolidate-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    store
        .save(&episode(
            &original,
            RelationshipType::Confirms,
            Some("session-a"),
        ))
        .await
        .unwrap();
    store
        .save(&episode(
            &original,
            RelationshipType::Confirms,
            Some("session-b"),
        ))
        .await
        .unwrap();
    let retriever = KeywordMemoryRetriever::new(store.clone());
    let scope = filter(Some(&original.agent_id));
    let initial = retriever.recall("small", &scope, 5).await.unwrap();
    assert_eq!(initial[0].lifecycle.tier, MemoryTier::ShortTerm);
    assert_eq!(initial[0].lifecycle.confirmed_sessions, 2);
    database.execute(
        "UPDATE public.fragments SET first_evidence_at = now() - interval '25 hours' WHERE id = $1",
        &[&original.fragments[0].id],
    ).await.unwrap();
    store
        .save(&episode(
            &original,
            RelationshipType::Confirms,
            Some("session-a"),
        ))
        .await
        .unwrap();
    assert_eq!(
        retriever.recall("small", &scope, 5).await.unwrap()[0]
            .lifecycle
            .tier,
        MemoryTier::ShortTerm
    );
    store
        .save(&episode(
            &original,
            RelationshipType::Confirms,
            Some("session-c"),
        ))
        .await
        .unwrap();
    let mature = retriever.recall("small", &scope, 5).await.unwrap();
    assert_eq!(mature[0].lifecycle.tier, MemoryTier::LongTerm);
    assert_eq!(mature[0].lifecycle.evidence, EvidenceStatus::Confirmed);
    assert_eq!(mature[0].lifecycle.confirmed_sessions, 3);
    assert_eq!(mature[0].text, original.fragments[0].text);
    assert_eq!(
        retriever.recall("reviews", &scope, 5).await.unwrap()[0]
            .lifecycle
            .tier,
        MemoryTier::ShortTerm
    );
    let vector = database
        .query_one(
            "SELECT embedding FROM public.fragments WHERE id = $1",
            &[&original.fragments[0].id],
        )
        .await
        .unwrap();
    assert_eq!(
        vector.get::<_, pgvector::Vector>(0).to_vec(),
        vec![1.0, 0.0]
    );
    let vector_retriever = VectorMemoryRetriever::new(store, Arc::new(QueryEmbedder));
    let semantic = vector_retriever
        .recall(
            "PR preferences?",
            &RecallFilter {
                tier: Some(MemoryTier::LongTerm),
                ..scope
            },
            5,
        )
        .await
        .unwrap();
    assert_eq!(semantic.len(), 1);
    assert_eq!(semantic[0].fragment_id, original.fragments[0].id);
    assert_eq!(semantic[0].score, 1.0);
}

#[tokio::test]
async fn repeated_concurrent_feedback_counts_once_and_recall_does_not_reinforce() {
    let (store, database) = setup().await;
    let original = memory(&format!("feedback-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    let mut calls = tokio::task::JoinSet::new();
    for _ in 0..10 {
        let store = store.clone();
        let evidence = episode(
            &original,
            RelationshipType::Reinforces,
            Some("same-session"),
        );
        calls.spawn(async move { store.save(&evidence).await });
    }
    while let Some(call) = calls.join_next().await {
        call.unwrap().unwrap();
    }
    let before: String = database
        .query_one(
            "SELECT row_to_json(fragments)::text FROM public.fragments WHERE id = $1",
            &[&original.fragments[0].id],
        )
        .await
        .unwrap()
        .get(0);
    let retriever = KeywordMemoryRetriever::new(store);
    for _ in 0..3 {
        let matches = retriever
            .recall("small", &filter(Some(&original.agent_id)), 5)
            .await
            .unwrap();
        assert_eq!(matches[0].lifecycle.useful_sessions, 1);
        assert_eq!(matches[0].lifecycle.confirmed_sessions, 0);
        assert_eq!(matches[0].lifecycle.evidence, EvidenceStatus::Unconfirmed);
        assert_eq!(matches[0].lifecycle.tier, MemoryTier::ShortTerm);
    }
    let after: String = database
        .query_one(
            "SELECT row_to_json(fragments)::text FROM public.fragments WHERE id = $1",
            &[&original.fragments[0].id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(after, before);
}

#[tokio::test]
async fn context_mismatch_or_missing_target_rolls_back_the_complete_episode() {
    let (store, database) = setup().await;
    let mut original = memory(&format!("scope-{}", Uuid::new_v4()));
    original.context.scope = Some("project-a".into());
    store.save(&original).await.unwrap();
    for mismatch in [true, false] {
        let mut invalid = episode(&original, RelationshipType::Supports, None);
        if mismatch {
            invalid.context.scope = Some("project-b".into());
        } else {
            invalid.relationships[0].target_fragment = Uuid::new_v4();
        }
        assert!(store.save(&invalid).await.is_err());
        let count: i64 = database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE id = $1",
                &[&invalid.id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0);
    }
}

#[tokio::test]
async fn archives_are_reversible_but_superseded_facts_stay_out_of_normal_recall() {
    let (store, database) = setup().await;
    let original = memory(&format!("correction-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    let retriever = KeywordMemoryRetriever::new(store.clone());
    let scope = filter(Some(&original.agent_id));
    store
        .save(&episode(&original, RelationshipType::Archives, None))
        .await
        .unwrap();
    assert!(retriever
        .recall("small", &scope, 5)
        .await
        .unwrap()
        .is_empty());
    let archived = retriever
        .recall(
            "small",
            &RecallFilter {
                include_inactive: true,
                ..scope.clone()
            },
            5,
        )
        .await
        .unwrap();
    assert_eq!(archived[0].lifecycle.state, FactState::Archived);
    store
        .save(&episode(&original, RelationshipType::Restores, None))
        .await
        .unwrap();
    assert_eq!(retriever.recall("small", &scope, 5).await.unwrap().len(), 1);
    let mut correction = episode(&original, RelationshipType::Supersedes, None);
    correction.raw_text = "User prefers PRs under 300 LOC.".into();
    correction.fragments[0].text = correction.raw_text.clone();
    store.save(&correction).await.unwrap();
    assert!(retriever
        .recall("small", &scope, 5)
        .await
        .unwrap()
        .is_empty());
    assert_eq!(
        retriever.recall("300", &scope, 5).await.unwrap()[0].fragment_id,
        correction.fragments[0].id
    );
    assert!(store
        .save(&episode(&original, RelationshipType::Restores, None))
        .await
        .is_err());
    let old_text: String = database
        .query_one(
            "SELECT raw_text FROM public.memories WHERE id = $1",
            &[&original.id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(old_text, original.raw_text);
}

#[tokio::test]
async fn contradiction_blocks_automatic_consolidation_without_silently_resolving_it() {
    let (store, database) = setup().await;
    let original = memory(&format!("disputed-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    store
        .save(&episode(&original, RelationshipType::Confirms, Some("one")))
        .await
        .unwrap();
    database.execute("UPDATE public.fragments SET first_evidence_at = now() - interval '25 hours' WHERE id = $1", &[&original.fragments[0].id]).await.unwrap();
    store
        .save(&episode(&original, RelationshipType::Contradicts, None))
        .await
        .unwrap();
    store
        .save(&episode(&original, RelationshipType::Confirms, Some("two")))
        .await
        .unwrap();
    let matches = KeywordMemoryRetriever::new(store)
        .recall("small", &filter(Some(&original.agent_id)), 5)
        .await
        .unwrap();
    assert_eq!(matches[0].lifecycle.evidence, EvidenceStatus::Disputed);
    assert_eq!(matches[0].lifecycle.tier, MemoryTier::ShortTerm);
    assert_eq!(matches[0].relationship_count, 3);
}

#[tokio::test]
async fn decay_changes_priority_but_not_pgvector_similarity_or_stored_facts() {
    let (store, database) = setup().await;
    let agent = format!("decay-{}", Uuid::new_v4());
    let mut older = memory(&agent);
    older.fragments.truncate(1);
    let mut recent = memory(&agent);
    recent.fragments.truncate(1);
    store.save(&older).await.unwrap();
    store.save(&recent).await.unwrap();
    database
        .execute(
            "UPDATE public.memories SET created_at = now() - interval '14 days' WHERE id = $1",
            &[&older.id],
        )
        .await
        .unwrap();
    let retriever = VectorMemoryRetriever::new(store, Arc::new(QueryEmbedder));
    let recalled = retriever
        .recall("PR preferences?", &filter(Some(&agent)), 5)
        .await
        .unwrap();
    assert_eq!(recalled[0].memory_id, recent.id);
    assert_eq!(recalled[1].memory_id, older.id);
    assert_eq!(recalled[0].score, 1.0);
    assert_eq!(recalled[1].score, 1.0);
    assert!((recalled[1].activation - 0.1875).abs() < 0.001);
    assert!(recalled[0].activation > recalled[1].activation);
}

#[tokio::test]
async fn superseded_facts_cannot_be_reactivated_through_archiving_or_later_feedback() {
    let (store, database) = setup().await;
    let original = memory(&format!("terminal-state-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    store
        .save(&episode(&original, RelationshipType::Supersedes, None))
        .await
        .unwrap();
    for kind in [
        RelationshipType::Archives,
        RelationshipType::Restores,
        RelationshipType::Confirms,
        RelationshipType::Reinforces,
    ] {
        let invalid = episode(&original, kind, Some("later-session"));
        assert!(
            store.save(&invalid).await.is_err(),
            "accepted {kind:?} on a superseded fact"
        );
        let count: i64 = database
            .query_one(
                "SELECT count(*) FROM public.memories WHERE id = $1",
                &[&invalid.id],
            )
            .await
            .unwrap()
            .get(0);
        assert_eq!(count, 0);
    }
    let state: String = database
        .query_one(
            "SELECT state FROM public.fragments WHERE id = $1",
            &[&original.fragments[0].id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(state, "superseded");
}

#[tokio::test]
async fn one_write_cannot_apply_conflicting_lifecycle_actions_to_the_same_fact() {
    let (store, database) = setup().await;
    let original = memory(&format!("ambiguous-state-{}", Uuid::new_v4()));
    store.save(&original).await.unwrap();
    let mut invalid = episode(&original, RelationshipType::Supersedes, None);
    invalid.relationships.push(PreparedRelationship {
        source_fragment: invalid.fragments[0].id,
        target_fragment: original.fragments[0].id,
        relationship_type: RelationshipType::Archives,
    });
    assert!(store.save(&invalid).await.is_err());
    let row = database.query_one("SELECT state, (SELECT count(*) FROM public.memories WHERE id = $2) FROM public.fragments WHERE id = $1",
        &[&original.fragments[0].id, &invalid.id],
    ).await.unwrap();
    assert_eq!(row.get::<_, String>(0), "active");
    assert_eq!(row.get::<_, i64>(1), 0);
}

#[tokio::test]
async fn cached_queries_observe_lifecycle_and_context_changes_without_reembedding() {
    let (store, database) = setup().await;
    for hybrid in [false, true] {
        let mut original = memory(&format!("cached-lifecycle-{}", Uuid::new_v4()));
        original.fragments.truncate(1);
        original.context.scope = Some(format!("project-{}", Uuid::new_v4()));
        store.save(&original).await.unwrap();
        let embedder = Arc::new(CountingQueryEmbedder::default());
        let retriever: Box<dyn MemoryRetriever> = if hybrid {
            Box::new(
                HybridMemoryRetriever::new(store.clone(), embedder.clone())
                    .with_min_similarity(Some(0.5))
                    .unwrap(),
            )
        } else {
            Box::new(
                VectorMemoryRetriever::new(store.clone(), embedder.clone())
                    .with_min_similarity(Some(0.5))
                    .unwrap(),
            )
        };
        let scope = RecallFilter {
            scope: original.context.scope.clone(),
            ..filter(Some(&original.agent_id))
        };
        assert_eq!(
            retriever
                .recall("PR preferences?", &scope, 5)
                .await
                .unwrap()
                .len(),
            1
        );
        assert!(retriever
            .recall(
                "PR preferences?",
                &RecallFilter {
                    scope: Some("other-project".into()),
                    ..scope.clone()
                },
                5
            )
            .await
            .unwrap()
            .is_empty());

        store
            .save(&episode(&original, RelationshipType::Archives, None))
            .await
            .unwrap();
        assert!(retriever
            .recall("PR preferences?", &scope, 5)
            .await
            .unwrap()
            .is_empty());
        let history = retriever
            .recall(
                "PR preferences?",
                &RecallFilter {
                    include_inactive: true,
                    ..scope.clone()
                },
                5,
            )
            .await
            .unwrap();
        assert_eq!(history[0].lifecycle.state, FactState::Archived);
        store
            .save(&episode(&original, RelationshipType::Restores, None))
            .await
            .unwrap();
        assert_eq!(
            retriever
                .recall("PR preferences?", &scope, 5)
                .await
                .unwrap()[0]
                .lifecycle
                .state,
            FactState::Active
        );

        store
            .save(&episode(
                &original,
                RelationshipType::Confirms,
                Some("first-session"),
            ))
            .await
            .unwrap();
        database.execute(
            "UPDATE public.fragments SET first_evidence_at = now() - interval '25 hours' WHERE id = $1",
            &[&original.fragments[0].id],
        ).await.unwrap();
        store
            .save(&episode(
                &original,
                RelationshipType::Confirms,
                Some("second-session"),
            ))
            .await
            .unwrap();
        let mature = retriever
            .recall(
                "PR preferences?",
                &RecallFilter {
                    tier: Some(MemoryTier::LongTerm),
                    ..scope.clone()
                },
                5,
            )
            .await
            .unwrap();
        assert_eq!(mature.len(), 1);
        assert_eq!(mature[0].lifecycle.confirmed_sessions, 2);

        let mut correction = episode(&original, RelationshipType::Supersedes, None);
        correction.fragments[0].embedding = Some(vec![1.0, 0.0]);
        correction.fragments[0].text = "User prefers PRs under 300 LOC".into();
        correction.raw_text = correction.fragments[0].text.clone();
        store.save(&correction).await.unwrap();
        let current = retriever
            .recall("PR preferences?", &scope, 5)
            .await
            .unwrap();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0].fragment_id, correction.fragments[0].id);
        assert_eq!(
            current[0].relationships[0].fragment_id,
            original.fragments[0].id
        );
        assert_eq!(embedder.calls.load(Ordering::SeqCst), 1);
    }
}
