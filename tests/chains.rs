use super::*;
use mindleak_memory::{
    ChainCommand, ChainDocument, ChainEvidence, ChainEvidenceRole, ChainFilter, ChainReview,
    ChainState, ChainValidation, ChainWriteRequest, PreparedChain,
};

fn propose(observation: &PreparedMemory) -> PreparedChain {
    let mut episode = memory(&observation.agent_id);
    episode.context = MemoryContext {
        scope: observation.context.scope.clone(),
        session_id: Some(Uuid::new_v4().to_string()),
        source: Some("synthetic:chain-validation".into()),
        summary: None,
    };
    let chain = ChainCommand::Propose {
        chain_id: Uuid::new_v4(),
        document: ChainDocument {
            formation: None,
            kind: mindleak_memory::KnowledgeKind::Chain,
            supported_by: vec![],
            claim: format!("Small PR reviews help {}", observation.agent_id),
            rationale: "The source records a review requirement".into(),
            conclusion: "Keep reviews in the workflow".into(),
            applicability: "This test workload only".into(),
            assumptions: vec!["The recorded requirement remains applicable".into()],
            evidence: vec![ChainEvidence {
                fragment_id: observation.fragments[1].id,
                role: ChainEvidenceRole::Supports,
                reason: "Recorded review requirement".into(),
            }],
            reported_confidence: None,
        },
    };
    PreparedChain {
        embedding: Some(vec![1.0, 0.0]),
        request: ChainWriteRequest {
            request_id: Uuid::new_v4(),
            agent_id: episode.agent_id.clone(),
            text: episode.raw_text.clone(),
            context: episode.context.clone(),
            chain,
        },
        memory: episode,
    }
}

fn action(previous: &PreparedChain, chain: ChainCommand) -> PreparedChain {
    let mut episode = memory(&previous.request.agent_id);
    episode.context = previous.request.context.clone();
    PreparedChain {
        embedding: previous.embedding.clone(),
        request: ChainWriteRequest {
            request_id: Uuid::new_v4(),
            agent_id: episode.agent_id.clone(),
            text: episode.raw_text.clone(),
            context: episode.context.clone(),
            chain,
        },
        memory: episode,
    }
}

#[tokio::test]
async fn explicit_knowledge_matching_preserves_default_punctuation_and_reports_capabilities() {
    let (store, _) = setup().await;
    let observation = memory(&format!("knowledge-matching-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let mut proposed = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut proposed.request.chain else {
        unreachable!()
    };
    document.claim = format!(
        "Report export keeps branch-kit upgrades within approved policy for {}",
        observation.agent_id
    );
    let receipt = store.save_chain(&proposed).await.unwrap();
    let retriever = KeywordMemoryRetriever::new(store.clone());
    let mut filter = ChainFilter {
        agent_id: Some(observation.agent_id),
        include_candidates: true,
        ..Default::default()
    };
    let hits = retriever
        .recall_chains("report export", &filter, 5)
        .await
        .unwrap();
    assert_eq!(hits[0].chain.chain_id, receipt.chain_id);
    assert!(retriever
        .recall_chains("report-export", &filter, 5)
        .await
        .unwrap()
        .is_empty());
    assert!(retriever
        .recall_chains("report export API", &filter, 5)
        .await
        .unwrap()
        .is_empty());
    filter.match_mode = mindleak_memory::KeywordMatchMode::Any;
    let explicit = retriever
        .recall_chains("report-export API", &filter, 5)
        .await
        .unwrap();
    assert_eq!(
        explicit.len(),
        1,
        "explicit any-term matching must use its requested parser"
    );
    assert_eq!(explicit[0].chain.chain_id, receipt.chain_id);
    filter.match_mode = mindleak_memory::KeywordMatchMode::All;
    assert!(retriever
        .recall_chains("report export API", &filter, 5)
        .await
        .unwrap()
        .is_empty());
    let capability = retriever.capabilities();
    assert_eq!(capability.strategy, "keyword");
    assert!(capability.embedding_model.is_none());
    assert_eq!(capability.match_modes.len(), 3);
    let vector =
        VectorMemoryRetriever::new(store.clone(), Arc::new(CountingQueryEmbedder::default()));
    assert_eq!(vector.capabilities().strategy, "vector");
    assert_eq!(
        vector.capabilities().embedding_model.as_deref(),
        Some("test-model")
    );
    assert!(
        vector
            .recall_chains("report export", &filter, 5)
            .await
            .is_err(),
        "vector-only search must refuse literal keyword controls"
    );
    let hybrid = HybridMemoryRetriever::new(store, Arc::new(CountingQueryEmbedder::default()));
    assert_eq!(hybrid.capabilities().strategy, "hybrid");
    assert_eq!(hybrid.capabilities().match_modes.len(), 3);
}

#[tokio::test]
async fn backup_canaries_separate_observations_from_derived_knowledge() {
    let (store, database) = setup().await;
    let observation = memory(&format!("backup-knowledge-canary-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let mut proposed = propose(&observation);
    proposed.memory.fragments[0].id =
        Uuid::from_u128((Uuid::new_v4().as_u128() & u64::MAX as u128) | 1);
    store.save_chain(&proposed).await.unwrap();
    let messages = database
        .simple_query(include_str!(
            "../crates/mindleak-mcp/src/admin/snapshot.sql"
        ))
        .await
        .unwrap();
    let metadata: serde_json::Value = messages
        .iter()
        .find_map(|message| match message {
            tokio_postgres::SimpleQueryMessage::Row(row) => {
                Some(serde_json::from_str(row.get(0).unwrap()).unwrap())
            }
            _ => None,
        })
        .unwrap();
    database.batch_execute("ROLLBACK").await.unwrap();
    let selected = Uuid::parse_str(metadata["canary"]["fragmentId"].as_str().unwrap()).unwrap();
    let chain: Option<Uuid> = database.query_one("SELECT memories.chain_id FROM public.fragments JOIN public.memories ON memories.id=fragments.memory_id WHERE fragments.id=$1", &[&selected]).await.unwrap().get(0);
    assert!(
        chain.is_none(),
        "backup source inspection must never select a derived fragment"
    );
    assert!(
        metadata["knowledgeCanary"]["chainId"].is_string(),
        "backups containing knowledge need an explicit knowledge inspection canary"
    );
}

#[tokio::test]
async fn principle_revisions_cannot_drop_inherited_counterevidence() {
    let (store, _) = setup().await;
    let observation = memory(&format!("principle-counters-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let counter = ChainEvidence {
        fragment_id: observation.fragments[0].id,
        role: ChainEvidenceRole::Counterexample,
        reason: "A recorded exception to the general claim.".into(),
    };
    let mut supports = Vec::new();
    for index in 0..3 {
        let mut proposed = propose(&observation);
        let ChainCommand::Propose { document, .. } = &mut proposed.request.chain else {
            unreachable!()
        };
        document.claim.push_str(&format!(" comparison {index}"));
        if index == 0 {
            document.evidence.push(counter.clone());
        }
        let chain_id = store.save_chain(&proposed).await.unwrap().chain_id;
        store
            .save_chain(&action(
                &proposed,
                ChainCommand::Accept {
                    chain_id,
                    expected_revision: 1,
                    validation: ChainValidation {
                        method: "Review comparison".into(),
                        result: "Conditionally supported".into(),
                        source: "synthetic:counter-review".into(),
                        counter_evidence_reviewed: if index == 0 {
                            vec![counter.fragment_id]
                        } else {
                            vec![]
                        },
                    },
                },
            ))
            .await
            .unwrap();
        supports.push(mindleak_memory::ChainSupport {
            chain_id,
            revision: 2,
            reason: "A reviewed comparison.".into(),
        });
    }
    let mut principle = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut principle.request.chain else {
        unreachable!()
    };
    document.kind = mindleak_memory::KnowledgeKind::Principle;
    document.evidence.clear();
    document.supported_by = supports[..2].to_vec();
    let mut replacement = document.clone();
    replacement.supported_by = supports[1..].to_vec();
    let chain_id = store.save_chain(&principle).await.unwrap().chain_id;
    assert!(
        store
            .save_chain(&action(
                &principle,
                ChainCommand::Revise {
                    chain_id,
                    expected_revision: 1,
                    document: replacement.clone()
                }
            ))
            .await
            .is_err(),
        "replacing support cannot erase an inherited known counterexample"
    );
    replacement.evidence.push(counter);
    let revised = store
        .save_chain(&action(
            &principle,
            ChainCommand::Revise {
                chain_id,
                expected_revision: 1,
                document: replacement,
            },
        ))
        .await
        .unwrap();
    assert_eq!(revised.revision, 2);
    assert_eq!(revised.state, ChainState::Candidate);
}

#[tokio::test]
async fn principle_revisions_retain_counterevidence_added_after_support_was_pinned() {
    let (store, mut database) = setup().await;
    let observation = memory(&format!("principle-late-counters-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let counter = ChainEvidence {
        fragment_id: observation.fragments[0].id,
        role: ChainEvidenceRole::Counterexample,
        reason: "The procedure failed after its supporting revision was pinned.".into(),
    };
    let validation = ChainValidation {
        method: "Review controlled observations".into(),
        result: "Supported within the recorded conditions".into(),
        source: "synthetic:late-counter-validation".into(),
        counter_evidence_reviewed: vec![],
    };
    let mut sources = Vec::new();
    let mut supports = Vec::new();
    for index in 0..3 {
        let mut proposed = propose(&observation);
        let ChainCommand::Propose { document, .. } = &mut proposed.request.chain else {
            unreachable!()
        };
        document.claim.push_str(&format!(" comparison {index}"));
        let chain_id = store.save_chain(&proposed).await.unwrap().chain_id;
        store
            .save_chain(&action(
                &proposed,
                ChainCommand::Accept {
                    chain_id,
                    expected_revision: 1,
                    validation: validation.clone(),
                },
            ))
            .await
            .unwrap();
        supports.push(mindleak_memory::ChainSupport {
            chain_id,
            revision: 2,
            reason: "A validated comparison.".into(),
        });
        sources.push(proposed);
    }
    let mut principle = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut principle.request.chain else {
        unreachable!()
    };
    document.kind = mindleak_memory::KnowledgeKind::Principle;
    document.evidence.clear();
    document.supported_by = supports[..2].to_vec();
    let mut replacement = document.clone();
    replacement.supported_by = supports[1..].to_vec();
    let chain_id = store.save_chain(&principle).await.unwrap().chain_id;
    store
        .save_chain(&action(
            &principle,
            ChainCommand::Accept {
                chain_id,
                expected_revision: 1,
                validation: validation.clone(),
            },
        ))
        .await
        .unwrap();
    store
        .save_chain(&action(
            &sources[0],
            ChainCommand::Challenge {
                chain_id: supports[0].chain_id,
                expected_revision: 2,
                evidence: vec![counter.clone()],
            },
        ))
        .await
        .unwrap();
    let filter = ChainFilter {
        agent_id: Some(observation.agent_id),
        ..Default::default()
    };
    let stale = store
        .inspect_chain(chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(stale.requires_review);
    let rejected = action(
        &principle,
        ChainCommand::Revise {
            chain_id,
            expected_revision: 2,
            document: replacement.clone(),
        },
    );
    let error = store.save_chain(&rejected).await.expect_err(
        "replacing a challenged support must retain counterevidence added after the pinned revision",
    );
    assert!(error.is::<mindleak_memory::InvalidInput>());
    assert!(store
        .lookup_chain_write(&rejected.request)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .inspect_chain(chain_id, None, None, &filter, 1)
            .await
            .unwrap()
            .unwrap()
            .chain
            .revision,
        2
    );
    replacement.evidence.push(counter.clone());
    let raced = action(
        &principle,
        ChainCommand::Revise {
            chain_id,
            expected_revision: 2,
            document: replacement.clone(),
        },
    );
    let transaction = database.transaction().await.unwrap();
    transaction
        .query_one(
            "SELECT id FROM public.memories WHERE chain_id=$1 AND chain_current FOR UPDATE",
            &[&supports[0].chain_id],
        )
        .await
        .unwrap();
    let pending = store.save_chain(&raced);
    tokio::pin!(pending);
    tokio::time::timeout(std::time::Duration::from_secs(5), async {
        loop {
            tokio::select! {
                result = &mut pending => panic!("revision did not wait for prior support: {result:?}"),
                row = transaction.query_one(
                    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity \
                     WHERE datname=current_database() AND pg_backend_pid()=ANY(pg_blocking_pids(pid)))",
                    &[],
                ) => if row.unwrap().get::<_, bool>(0) { break; },
            }
        }
    }).await.expect("revision must lock the prior supporting head");
    transaction
        .execute(
            "UPDATE public.memories SET chain_current=false WHERE chain_id=$1 AND chain_current",
            &[&supports[0].chain_id],
        )
        .await
        .unwrap();
    transaction.commit().await.unwrap();
    let error = pending
        .await
        .expect_err("a missing prior head must not be treated as no counterevidence");
    assert!(error.is::<mindleak_memory::InvalidInput>());
    assert!(store
        .lookup_chain_write(&raced.request)
        .await
        .unwrap()
        .is_none());
    assert_eq!(
        store
            .inspect_chain(chain_id, None, None, &filter, 1)
            .await
            .unwrap()
            .unwrap()
            .chain
            .revision,
        2
    );
    database
        .execute(
            "UPDATE public.memories SET chain_current=true WHERE chain_id=$1 AND chain_revision=3",
            &[&supports[0].chain_id],
        )
        .await
        .unwrap();
    let revised = store
        .save_chain(&action(
            &principle,
            ChainCommand::Revise {
                chain_id,
                expected_revision: 2,
                document: replacement,
            },
        ))
        .await
        .unwrap();
    assert_eq!(revised.revision, 3);
    assert!(
        store
            .save_chain(&action(
                &principle,
                ChainCommand::Accept {
                    chain_id,
                    expected_revision: 3,
                    validation: validation.clone(),
                }
            ))
            .await
            .is_err(),
        "acceptance must review the retained counterexample"
    );
    let mut reviewed = validation;
    reviewed.counter_evidence_reviewed.push(counter.fragment_id);
    store
        .save_chain(&action(
            &principle,
            ChainCommand::Accept {
                chain_id,
                expected_revision: 3,
                validation: reviewed,
            },
        ))
        .await
        .unwrap();
    let accepted = store
        .inspect_chain(chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(!accepted.requires_review);
    assert_eq!(accepted.evidence[0].reference, counter);
}

#[tokio::test]
async fn knowledge_search_uses_pgvector_and_preserves_hybrid_branch_scores() {
    let (store, _) = setup().await;
    let observation = memory(&format!("knowledge-semantic-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let receipt = store.save_chain(&propose(&observation)).await.unwrap();
    let filter = ChainFilter {
        agent_id: Some(observation.agent_id.clone()),
        include_candidates: true,
        ..Default::default()
    };
    let vector =
        VectorMemoryRetriever::new(store.clone(), Arc::new(CountingQueryEmbedder::default()))
            .with_min_similarity(Some(0.9))
            .unwrap();
    let results = vector.recall_chains("quartz", &filter, 10).await.unwrap();
    assert_eq!(
        results.len(),
        1,
        "semantic knowledge search must not silently use keyword search"
    );
    assert_eq!(results[0].chain.chain_id, receipt.chain_id);
    assert!((results[0].score - 1.0).abs() < 1e-6);
    let hybrid = HybridMemoryRetriever::new(store, Arc::new(CountingQueryEmbedder::default()));
    let results = hybrid.recall_chains("reviews", &filter, 10).await.unwrap();
    assert_eq!(results.len(), 1);
    let result = serde_json::to_value(&results[0]).unwrap();
    assert_eq!(result["vectorScore"], 1.0);
    assert!(result["keywordScore"].as_f64().unwrap() > 0.0);
    assert_eq!(result["score"], 1.0);
}

#[tokio::test]
async fn chains_are_atomic_replayable_and_absent_from_ordinary_recall() {
    let (store, database) = setup().await;
    let agent = format!("chain-compat-{}", Uuid::new_v4());
    let observation = memory(&agent);
    store.save(&observation).await.unwrap();
    let retriever = KeywordMemoryRetriever::new(store.clone());
    let before = retriever
        .recall("reviews", &filter(Some(&agent)), 10)
        .await
        .unwrap();
    let vector =
        VectorMemoryRetriever::new(store.clone(), Arc::new(CountingQueryEmbedder::default()));
    let hybrid =
        HybridMemoryRetriever::new(store.clone(), Arc::new(CountingQueryEmbedder::default()));
    let before_vector = vector
        .recall("reviews", &filter(Some(&agent)), 10)
        .await
        .unwrap();
    let before_hybrid = hybrid
        .recall("reviews", &filter(Some(&agent)), 10)
        .await
        .unwrap();
    let proposed = propose(&observation);
    let receipt = store.save_chain(&proposed).await.unwrap();
    assert_eq!(receipt.state, ChainState::Candidate);
    assert_eq!(receipt.review, ChainReview::Unreviewed);
    assert_eq!(receipt.revision, 1);
    assert_eq!(store.save_chain(&proposed).await.unwrap(), receipt);
    let after = retriever
        .recall("reviews", &filter(Some(&agent)), 10)
        .await
        .unwrap();
    assert_eq!(
        before
            .iter()
            .map(|fact| (fact.fragment_id, fact.text.clone(), fact.score))
            .collect::<Vec<_>>(),
        after
            .iter()
            .map(|fact| (fact.fragment_id, fact.text.clone(), fact.score))
            .collect::<Vec<_>>()
    );
    for (before, after) in [
        (
            before_vector,
            vector
                .recall("reviews", &filter(Some(&agent)), 10)
                .await
                .unwrap(),
        ),
        (
            before_hybrid,
            hybrid
                .recall("reviews", &filter(Some(&agent)), 10)
                .await
                .unwrap(),
        ),
    ] {
        assert_eq!(
            before
                .iter()
                .map(|fact| (fact.fragment_id, fact.text.clone(), fact.score))
                .collect::<Vec<_>>(),
            after
                .iter()
                .map(|fact| (fact.fragment_id, fact.text.clone(), fact.score))
                .collect::<Vec<_>>()
        );
    }
    let chains = ChainFilter {
        agent_id: Some(agent.clone()),
        ..Default::default()
    };
    assert!(retriever
        .recall_chains("reviews", &chains, 10)
        .await
        .unwrap()
        .is_empty());
    let inspected = store
        .inspect_chain(receipt.chain_id, None, None, &chains, 5)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(inspected.raw_text, proposed.memory.raw_text);
    assert_eq!(inspected.evidence[0].memory_id, Some(observation.id));
    assert_eq!(
        inspected.evidence[0].text.as_deref(),
        Some(observation.fragments[1].text.as_str())
    );
    let accepted = action(
        &proposed,
        ChainCommand::Accept {
            chain_id: receipt.chain_id,
            expected_revision: 1,
            validation: ChainValidation {
                method: "Review source".into(),
                result: "Requirement verified for the fixture".into(),
                source: "synthetic:test-result".into(),
                counter_evidence_reviewed: vec![],
            },
        },
    );
    let accepted_receipt = store.save_chain(&accepted).await.unwrap();
    assert_eq!(accepted_receipt.revision, 2);
    assert_eq!(accepted_receipt.state, ChainState::Accepted);
    let found = retriever
        .recall_chains("reviews", &chains, 10)
        .await
        .unwrap();
    assert_eq!(found.len(), 1);
    assert_eq!(found[0].chain.chain_id, receipt.chain_id);
    assert!(!found[0].requires_review);
    assert_eq!(
        store
            .lookup_chain_write(&proposed.request)
            .await
            .unwrap()
            .unwrap(),
        receipt
    );
    let count: i64 = database.query_one("SELECT count(*) FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE'", &[]).await.unwrap().get(0);
    assert_eq!(count, 3);
}

#[tokio::test]
async fn chain_revision_challenge_history_and_withdrawn_evidence_remain_auditable() {
    let (store, database) = setup().await;
    let agent = format!("chain-history-{}", Uuid::new_v4());
    let observation = memory(&agent);
    store.save(&observation).await.unwrap();
    let proposal = propose(&observation);
    let first = store.save_chain(&proposal).await.unwrap();
    let chain_id = first.chain_id;
    let validate = |expected_revision, reviewed| {
        action(
            &proposal,
            ChainCommand::Accept {
                chain_id,
                expected_revision,
                validation: ChainValidation {
                    method: "Check source and counterexample".into(),
                    result: "Accepted only under the documented conditions".into(),
                    source: "synthetic:validation".into(),
                    counter_evidence_reviewed: reviewed,
                },
            },
        )
    };
    store.save_chain(&validate(1, vec![])).await.unwrap();
    let counter = memory(&agent);
    store.save(&counter).await.unwrap();
    let challenge = action(
        &proposal,
        ChainCommand::Challenge {
            chain_id,
            expected_revision: 2,
            evidence: vec![ChainEvidence {
                fragment_id: counter.fragments[0].id,
                role: ChainEvidenceRole::Counterexample,
                reason: "A differing requirement was recorded".into(),
            }],
        },
    );
    let disputed = store.save_chain(&challenge).await.unwrap();
    assert_eq!(disputed.review, ChainReview::Challenged);
    let filter = ChainFilter {
        agent_id: Some(agent.clone()),
        ..Default::default()
    };
    let retriever = KeywordMemoryRetriever::new(store.clone());
    assert!(retriever
        .recall_chains("reviews", &filter, 10)
        .await
        .unwrap()
        .is_empty());
    let inspection = store
        .inspect_chain(chain_id, None, None, &filter, 2)
        .await
        .unwrap()
        .unwrap();
    assert!(inspection.requires_review);
    assert_eq!(inspection.evidence.len(), 2);
    assert_eq!(inspection.history.len(), 2);
    assert_eq!(inspection.next_revision, Some(2));
    let remaining = store
        .inspect_chain(chain_id, None, inspection.next_revision, &filter, 2)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(remaining.history.len(), 1);
    assert_eq!(remaining.history[0].revision, 3);
    assert_eq!(remaining.next_revision, None);
    assert!(store.save_chain(&validate(3, vec![])).await.is_err());
    let mut revised = inspection.chain.snapshot.document.clone();
    revised.applicability = "Only the workload in the original controlled trial".into();
    let revision = action(
        &proposal,
        ChainCommand::Revise {
            chain_id,
            expected_revision: 3,
            document: revised,
        },
    );
    let revision_receipt = store.save_chain(&revision).await.unwrap();
    assert_eq!(revision_receipt.state, ChainState::Candidate);
    assert_eq!(revision_receipt.revision, 4);
    store
        .save_chain(&validate(4, vec![counter.fragments[0].id]))
        .await
        .unwrap();
    assert_eq!(
        retriever
            .recall_chains("reviews", &filter, 10)
            .await
            .unwrap()
            .len(),
        1
    );
    let accepted_before = store
        .inspect_chain(chain_id, Some(2), None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(accepted_before.chain.snapshot.review, ChainReview::Reviewed);
    assert_eq!(accepted_before.chain.snapshot.document.evidence.len(), 1);
    assert!(!accepted_before.chain.current);
    database
        .execute(
            "UPDATE public.fragments SET state='archived' WHERE id=$1",
            &[&observation.fragments[1].id],
        )
        .await
        .unwrap();
    assert!(
        retriever
            .recall_chains("reviews", &filter, 10)
            .await
            .unwrap()
            .is_empty(),
        "withdrawn support must make an accepted chain ineligible"
    );
    let stale = store
        .inspect_chain(chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(stale.requires_review);
    assert_eq!(
        stale.chain.revision, 5,
        "reads must not invent revisions or validation"
    );
    assert_eq!(
        stale.chain.snapshot.review,
        ChainReview::Reviewed,
        "recorded acceptance is historical, not silently rewritten"
    );
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE chain_id=$1",
            &[&chain_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 5);
    let feedback: i64 = database.query_one("SELECT sum(useful_sessions+confirmed_sessions)::bigint FROM public.fragments JOIN public.memories ON memories.id=fragments.memory_id WHERE memories.agent_id=$1", &[&agent]).await.unwrap().get(0);
    assert_eq!(feedback, 0);
}

#[tokio::test]
async fn concurrent_chain_replays_commit_once_and_stale_revisions_fail() {
    let (store, database) = setup().await;
    let observation = memory(&format!("chain-concurrent-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let proposed = Arc::new(propose(&observation));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let store = store.clone();
        let request = proposed.clone();
        tasks.push(tokio::spawn(
            async move { store.save_chain(&request).await },
        ));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        receipts.push(task.await.unwrap().unwrap());
    }
    assert!(receipts.iter().all(|receipt| *receipt == receipts[0]));
    let chain_id = receipts[0].chain_id;
    let retired = Arc::new(action(
        &proposed,
        ChainCommand::Retire {
            chain_id,
            expected_revision: 1,
        },
    ));
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let store = store.clone();
        let request = retired.clone();
        tasks.push(tokio::spawn(
            async move { store.save_chain(&request).await },
        ));
    }
    let mut receipts = Vec::new();
    for task in tasks {
        receipts.push(task.await.unwrap().unwrap());
    }
    assert!(receipts.iter().all(|receipt| *receipt == receipts[0]));
    assert_eq!(receipts[0].revision, 2);
    let stale = action(
        &proposed,
        ChainCommand::Retire {
            chain_id,
            expected_revision: 1,
        },
    );
    assert!(store.save_chain(&stale).await.is_err());
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE chain_id=$1",
            &[&chain_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 2);
}

#[tokio::test]
async fn invalid_chain_evidence_and_duplicate_claims_never_leave_partial_writes() {
    let (store, database) = setup().await;
    let mut observation = memory(&format!("chain-reject-{}", Uuid::new_v4()));
    observation.context.scope = Some("project-only".into());
    store.save(&observation).await.unwrap();
    let proposed = propose(&observation);
    let receipt = store.save_chain(&proposed).await.unwrap();
    let duplicate = propose(&observation);
    assert!(
        store.save_chain(&duplicate).await.is_err(),
        "normalized duplicate claims require reuse or revision"
    );
    let mut unscoped = propose(&observation);
    unscoped.request.context.scope = None;
    unscoped.memory.context.scope = None;
    assert!(
        store.save_chain(&unscoped).await.is_err(),
        "general scope is not permission to link project evidence"
    );
    let mut circular = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut circular.request.chain else {
        unreachable!()
    };
    document.evidence[0].fragment_id = receipt.fragments[0].fragment_id;
    document.claim = "A chain cannot be its own evidence".into();
    assert!(
        store.save_chain(&circular).await.is_err(),
        "derived chain fragments cannot be observations"
    );
    let mut bad = action(
        &proposed,
        ChainCommand::Retire {
            chain_id: receipt.chain_id,
            expected_revision: 1,
        },
    );
    bad.memory.fragments[1].id = bad.memory.fragments[0].id;
    assert!(store.save_chain(&bad).await.is_err());
    let inspection = store
        .inspect_chain(receipt.chain_id, None, None, &ChainFilter::default(), 1)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(
        inspection.chain.revision, 1,
        "fragment failure must roll back the head change"
    );
    assert!(store
        .lookup_chain_write(&bad.request)
        .await
        .unwrap()
        .is_none());
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id=$1",
            &[&observation.agent_id],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(count, 2);
}

#[tokio::test]
async fn chain_inspection_bounds_evidence_details_without_losing_references() {
    let (store, _) = setup().await;
    let mut observation = memory(&format!("chain-bytes-{}", Uuid::new_v4()));
    observation.fragments = (0..8)
        .map(|_| EmbeddedFragment {
            id: Uuid::new_v4(),
            text: format!("Evidence {}", "\u{0001}".repeat(4000)),
            embedding: Some(vec![1.0, 0.0]),
            importance: 0.5,
            tier: MemoryTier::ShortTerm,
            pinned: false,
        })
        .collect();
    store.save(&observation).await.unwrap();
    let mut proposal = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut proposal.request.chain else {
        unreachable!()
    };
    document.evidence = observation
        .fragments
        .iter()
        .map(|fragment| ChainEvidence {
            fragment_id: fragment.id,
            role: ChainEvidenceRole::Supports,
            reason: "Independent assertion not assumed".into(),
        })
        .collect();
    let receipt = store.save_chain(&proposal).await.unwrap();
    let read = store
        .inspect_chain(receipt.chain_id, None, None, &ChainFilter::default(), 1)
        .await
        .unwrap()
        .unwrap();
    assert!(read.evidence_details_truncated);
    assert_eq!(read.evidence.len(), 8);
    assert!(read
        .evidence
        .iter()
        .all(|reference| reference.available && reference.memory_id == Some(observation.id)));
    assert!(read
        .evidence
        .iter()
        .any(|reference| reference.text.is_none()));
    assert!(read
        .evidence
        .iter()
        .filter_map(|reference| reference.text.as_ref())
        .all(|text| text == &observation.fragments[0].text));
    assert!(serde_json::to_vec(&read).unwrap().len() <= mindleak_memory::MAX_RECALL_RESULT_BYTES);
}

#[tokio::test]
async fn chain_retirement_preserves_missing_evidence_without_claiming_it_available() {
    let (store, database) = setup().await;
    let observation = memory(&format!("chain-erased-evidence-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let proposed = propose(&observation);
    let receipt = store.save_chain(&proposed).await.unwrap();
    database
        .execute(
            "DELETE FROM public.memories WHERE id=$1",
            &[&observation.id],
        )
        .await
        .unwrap();
    let read = store
        .inspect_chain(receipt.chain_id, None, None, &ChainFilter::default(), 1)
        .await
        .unwrap()
        .unwrap();
    assert!(read.requires_review);
    assert!(!read.evidence[0].available);
    assert_eq!(
        read.evidence[0].reference.fragment_id,
        observation.fragments[1].id
    );
    let retired = action(
        &proposed,
        ChainCommand::Retire {
            chain_id: receipt.chain_id,
            expected_revision: 1,
        },
    );
    let retired = store.save_chain(&retired).await.unwrap();
    assert_eq!(retired.state, ChainState::Retired);
    assert_eq!(retired.revision, 2);
    let filter = ChainFilter {
        include_inactive: true,
        ..Default::default()
    };
    let read = store
        .inspect_chain(receipt.chain_id, None, None, &filter, 2)
        .await
        .unwrap()
        .unwrap();
    assert!(!read.evidence[0].available);
    assert_eq!(read.history.len(), 2);
}

#[tokio::test]
async fn chain_database_constraint_rejects_partial_metadata() {
    let (_, database) = setup().await;
    let result = database.execute(
        "INSERT INTO public.memories (id,agent_id,raw_text,request_id,request_payload,write_result,chain_id,chain_current,chain_snapshot,chain_claim_key,chain_search) \
         VALUES ($1,'chain-invalid-metadata','Partial chain record',$2,'{}','{}',$3,true,'{}',$4,''::tsvector)",
        &[&Uuid::new_v4(), &Uuid::new_v4(), &Uuid::new_v4(), &Uuid::new_v4().to_string()],
    ).await;
    assert!(
        matches!(result, Err(error) if error.code() == Some(&tokio_postgres::error::SqlState::CHECK_VIOLATION)),
        "partial chain metadata must fail closed in PostgreSQL"
    );
}

#[tokio::test]
async fn chain_scope_filters_remain_optional_and_keys_cannot_cross_write_modes() {
    let (store, database) = setup().await;
    let agent = format!("chain-general-{}", Uuid::new_v4());
    let mut expected = Vec::new();
    for scope in [None, Some(format!("{agent}-a")), Some(format!("{agent}-b"))] {
        let mut observation = keyed_memory(&agent);
        observation.context.scope = scope.clone();
        observation.request.as_mut().unwrap().context = observation.context.clone();
        let original = store.save(&observation).await.unwrap();
        let mut proposal = propose(&observation);
        let proposal_key = proposal.request.request_id;
        proposal.request.request_id = observation.request.as_ref().unwrap().request_id;
        assert!(
            store.save_chain(&proposal).await.is_err(),
            "an ordinary key cannot be reused as a chain write"
        );
        assert_eq!(
            store
                .lookup_write(observation.request.as_ref().unwrap())
                .await
                .unwrap()
                .unwrap(),
            original
        );
        proposal.request.request_id = proposal_key;
        let receipt = store.save_chain(&proposal).await.unwrap();
        let mut ordinary = keyed_memory(&agent);
        ordinary.request.as_mut().unwrap().request_id = proposal_key;
        assert!(
            store.save(&ordinary).await.is_err(),
            "a chain key cannot be reused as an ordinary write"
        );
        assert_eq!(
            store
                .lookup_chain_write(&proposal.request)
                .await
                .unwrap()
                .unwrap(),
            receipt
        );
        ordinary.request = None;
        ordinary.context.scope = scope.clone();
        ordinary.relationships = vec![mindleak_memory::PreparedRelationship {
            source_fragment: ordinary.fragments[0].id,
            target_fragment: receipt.fragments[0].fragment_id,
            relationship_type: mindleak_memory::RelationshipType::Archives,
        }];
        assert!(
            store.save(&ordinary).await.is_err(),
            "ordinary fact actions cannot change a chain revision"
        );
        expected.push((scope, receipt.chain_id));
    }
    let retriever = KeywordMemoryRetriever::new(store.clone());
    let general = ChainFilter {
        agent_id: Some(agent.clone()),
        include_candidates: true,
        ..Default::default()
    };
    let all = retriever
        .recall_chains("reviews", &general, 10)
        .await
        .unwrap();
    assert_eq!(
        all.len(),
        3,
        "omitted scope must search scoped and unscoped chains"
    );
    for (scope, chain_id) in &expected {
        assert!(all.iter().any(
            |result| &result.chain.chain_id == chain_id && &result.chain.context.scope == scope
        ));
        if scope.is_some() {
            let filtered = ChainFilter {
                scope: scope.clone(),
                ..general.clone()
            };
            let results = retriever
                .recall_chains("reviews", &filtered, 10)
                .await
                .unwrap();
            assert_eq!(results.len(), 1);
            assert_eq!(results[0].chain.chain_id, *chain_id);
        }
    }
    let wrong = ChainFilter {
        scope: Some(format!("{agent}-absent")),
        ..general
    };
    assert!(store
        .inspect_chain(expected[0].1, None, None, &wrong, 1)
        .await
        .unwrap()
        .is_none());
    let count: i64 = database
        .query_one(
            "SELECT count(*) FROM public.memories WHERE agent_id=$1",
            &[&agent],
        )
        .await
        .unwrap()
        .get(0);
    assert_eq!(
        count, 6,
        "rejected cross-mode writes must leave no source episodes"
    );
}

#[tokio::test]
async fn chain_inspection_does_not_expand_into_reclassified_evidence_scopes() {
    let (store, database) = setup().await;
    let mut observation = memory(&format!("chain-reclassified-{}", Uuid::new_v4()));
    observation.context.scope = Some(format!("original-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let proposed = propose(&observation);
    let receipt = store.save_chain(&proposed).await.unwrap();
    database.execute(
        "UPDATE public.memories SET context = jsonb_set(context, '{scope}', to_jsonb($2::text)) WHERE id=$1",
        &[&observation.id, &format!("other-{}", Uuid::new_v4())],
    ).await.unwrap();
    let filter = ChainFilter {
        scope: observation.context.scope.clone(),
        ..Default::default()
    };
    let inspection = store
        .inspect_chain(receipt.chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(inspection.requires_review);
    assert_eq!(
        inspection.evidence[0].reference.fragment_id,
        observation.fragments[1].id
    );
    assert!(
        !inspection.evidence[0].available,
        "evidence outside the chain scope must not be hydrated"
    );
    assert!(inspection.evidence[0].text.is_none());
    assert!(inspection.evidence[0].context.is_none());
}

#[tokio::test]
async fn principles_require_validated_chain_lineage_and_follow_evidence_changes() {
    let (store, _) = setup().await;
    let observation = memory(&format!("principle-lineage-{}", Uuid::new_v4()));
    store.save(&observation).await.unwrap();
    let first = propose(&observation);
    let first_receipt = store.save_chain(&first).await.unwrap();
    let mut second = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut second.request.chain else {
        unreachable!()
    };
    document.claim.push_str(" under a second condition");
    let second_receipt = store.save_chain(&second).await.unwrap();
    let accept = |source: &PreparedChain, revision| {
        action(
            source,
            ChainCommand::Accept {
                chain_id: source.request.chain.chain_id(),
                expected_revision: revision,
                validation: ChainValidation {
                    method: "Review measured evidence".into(),
                    result: "Applicable under stated conditions".into(),
                    source: "synthetic:principle-validation".into(),
                    counter_evidence_reviewed: vec![],
                },
            },
        )
    };
    store.save_chain(&accept(&second, 1)).await.unwrap();
    let mut principle = propose(&observation);
    let ChainCommand::Propose { document, .. } = &mut principle.request.chain else {
        unreachable!()
    };
    document.kind = mindleak_memory::KnowledgeKind::Principle;
    document.claim = format!("Review principles for {}", observation.agent_id);
    document.evidence.clear();
    document.supported_by = vec![
        mindleak_memory::ChainSupport {
            chain_id: first_receipt.chain_id,
            revision: 1,
            reason: "First comparison".into(),
        },
        mindleak_memory::ChainSupport {
            chain_id: second_receipt.chain_id,
            revision: 2,
            reason: "Second comparison".into(),
        },
    ];
    assert!(
        store.save_chain(&principle).await.is_err(),
        "an unvalidated chain cannot support a principle"
    );
    store.save_chain(&accept(&first, 1)).await.unwrap();
    let ChainCommand::Propose { document, .. } = &mut principle.request.chain else {
        unreachable!()
    };
    document.supported_by[0].revision = 2;
    let proposed = store.save_chain(&principle).await.unwrap();
    store.save_chain(&accept(&principle, 1)).await.unwrap();
    let filter = ChainFilter {
        agent_id: Some(observation.agent_id.clone()),
        ..Default::default()
    };
    let inspected = store
        .inspect_chain(proposed.chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    let view = serde_json::to_value(&inspected).unwrap();
    assert_eq!(view["supportingChains"].as_array().unwrap().len(), 2);
    assert_eq!(
        view["observationSources"],
        serde_json::json!([observation.id]),
        "reused evidence must not count as independent sources"
    );
    assert!(!inspected.requires_review);
    let selected = KeywordMemoryRetriever::new(store.clone())
        .recall_chains("review", &filter, 10)
        .await
        .unwrap();
    let bundle = store.hydrate_knowledge(&selected, &filter).await.unwrap();
    let principle_view = bundle
        .iter()
        .find(|entry| entry.matched.chain.chain_id == proposed.chain_id)
        .unwrap();
    let expanded = serde_json::to_value(principle_view).unwrap();
    assert_eq!(expanded["supportingChains"][0]["document"]["kind"], "chain");
    assert_eq!(
        expanded["supportingChains"][0]["evidence"][0]["memoryId"],
        observation.id.to_string()
    );
    let dependents = store
        .review_knowledge(Some(first_receipt.chain_id), &filter, None, 1)
        .await
        .unwrap();
    assert_eq!(dependents.entries[0].chain.chain_id, proposed.chain_id);
    assert!(!dependents.entries[0].requires_review);
    store
        .save_chain(&action(
            &first,
            ChainCommand::Retire {
                chain_id: first_receipt.chain_id,
                expected_revision: 2,
            },
        ))
        .await
        .unwrap();
    let inspected = store
        .inspect_chain(proposed.chain_id, None, None, &filter, 1)
        .await
        .unwrap()
        .unwrap();
    assert!(
        inspected.requires_review,
        "withdrawn supporting chains must invalidate dependent principle eligibility"
    );
    assert_eq!(
        inspected.chain.revision, 2,
        "dependency checks must not manufacture validation events"
    );
    let results = KeywordMemoryRetriever::new(store.clone())
        .recall_chains("review", &filter, 10)
        .await
        .unwrap();
    assert!(!results
        .iter()
        .any(|result| result.chain.chain_id == proposed.chain_id));
    let review = store
        .review_knowledge(None, &filter, None, 1)
        .await
        .unwrap();
    assert_eq!(review.entries[0].chain.chain_id, proposed.chain_id);
    assert!(review.entries[0].requires_review);
    let challenged = action(
        &principle,
        ChainCommand::Challenge {
            chain_id: proposed.chain_id,
            expected_revision: 2,
            evidence: vec![ChainEvidence {
                fragment_id: observation.fragments[0].id,
                role: ChainEvidenceRole::Counterexample,
                reason: "Additional evidence requires reconsideration.".into(),
            }],
        },
    );
    assert_eq!(
        store.save_chain(&challenged).await.unwrap().review,
        ChainReview::Challenged,
        "a stale dependency must not prevent recording a challenge"
    );
}
