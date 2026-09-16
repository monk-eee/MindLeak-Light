use std::sync::{Arc, Mutex};

use super::*;

struct Backend {
    events: Mutex<Vec<&'static str>>,
    saved: Mutex<Vec<PreparedMemory>>,
    fragments: Vec<String>,
    embeddings: Vec<Vec<f32>>,
    fail_embedding: bool,
    fail_lookup: bool,
}

impl Default for Backend {
    fn default() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            saved: Mutex::new(Vec::new()),
            fragments: vec!["Keep PRs small".into(), "Reviews are required".into()],
            embeddings: vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            fail_embedding: false,
            fail_lookup: false,
        }
    }
}

impl Backend {
    fn service(self: &Arc<Self>) -> MemoryService {
        MemoryService::new(self.clone(), self.clone(), Some(self.clone()), self.clone())
    }
}

#[async_trait]
impl MemoryDecomposer for Backend {
    async fn decompose(&self, _text: &str) -> Result<Vec<String>> {
        self.events.lock().unwrap().push("decompose");
        Ok(self.fragments.clone())
    }
}

#[async_trait]
impl TextEmbedder for Backend {
    fn dimensions(&self) -> usize {
        2
    }

    async fn embed_batch(&self, _texts: &[String]) -> Result<Vec<Vec<f32>>> {
        self.events.lock().unwrap().push("embed");
        ensure!(!self.fail_embedding, "model unavailable");
        Ok(self.embeddings.clone())
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
    ) -> Result<Option<FragmentInspection>> {
        self.events.lock().unwrap().push("inspect");
        Ok(None)
    }

    async fn lookup_write(&self, _: &WriteRequest) -> Result<Option<WriteMemoryResult>> {
        self.events.lock().unwrap().push("lookup");
        ensure!(!self.fail_lookup, "storage unavailable");
        Ok(None)
    }

    async fn save(&self, memory: &PreparedMemory) -> Result<WriteMemoryResult> {
        self.events.lock().unwrap().push("save");
        self.saved.lock().unwrap().push(memory.clone());
        Ok(memory.write_result())
    }
}

#[async_trait]
impl MemoryRetriever for Backend {
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        assert_eq!(query, "PR preferences?");
        assert_eq!(filter.agent_id.as_deref(), Some("claude"));
        assert_eq!(limit, 3);
        self.events.lock().unwrap().push("recall");
        Ok(vec![RecallMatch {
            memory_id: Uuid::nil(),
            fragment_id: Uuid::nil(),
            agent_id: "claude".into(),
            text: "Keep PRs small".into(),
            score: 0.92,
            ..Default::default()
        }])
    }
}

#[tokio::test]
async fn invalid_idempotent_requests_fail_before_lookup_or_models() {
    let backend = Arc::new(Backend::default());
    for importance in [f32::NAN, f32::INFINITY, -0.1, 1.1] {
        let error = backend
            .service()
            .write_memory(
                "claude",
                "fact",
                WriteOptions {
                    request_id: Some(Uuid::new_v4()),
                    facts: vec![FactDirective {
                        text: "Keep PRs small".into(),
                        importance: Some(importance),
                        ..Default::default()
                    }],
                    ..Default::default()
                },
            )
            .await
            .unwrap_err();
        assert!(error.is::<InvalidInput>());
    }
    assert!(backend.events.lock().unwrap().is_empty());
}

#[tokio::test]
async fn idempotent_lookup_failure_does_not_fall_through_to_models() {
    let backend = Arc::new(Backend {
        fail_lookup: true,
        ..Default::default()
    });
    assert!(backend
        .service()
        .write_memory(
            "claude",
            "fact",
            WriteOptions {
                request_id: Some(Uuid::new_v4()),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert_eq!(*backend.events.lock().unwrap(), ["lookup"]);
    assert!(backend.saved.lock().unwrap().is_empty());
}

#[tokio::test]
async fn idempotent_provider_failure_never_saves_a_request() {
    let backend = Arc::new(Backend {
        fail_embedding: true,
        ..Default::default()
    });
    assert!(backend
        .service()
        .write_memory(
            "claude",
            "fact",
            WriteOptions {
                request_id: Some(Uuid::new_v4()),
                ..Default::default()
            }
        )
        .await
        .is_err());
    assert_eq!(
        *backend.events.lock().unwrap(),
        ["lookup", "decompose", "embed"]
    );
    assert!(backend.saved.lock().unwrap().is_empty());
}

#[tokio::test]
async fn writes_raw_text_and_all_embedded_fragments_in_one_save() {
    let backend = Arc::new(Backend::default());
    let raw = "  Keep PRs small.\nReviews are required.  ";
    let result = backend
        .service()
        .write_memory("claude", raw, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(
        *backend.events.lock().unwrap(),
        ["decompose", "embed", "save"]
    );
    let saved = backend.saved.lock().unwrap();
    assert_eq!(saved.len(), 1);
    assert_eq!(saved[0].id, result.memory_id);
    assert_eq!(saved[0].agent_id, "claude");
    assert_eq!(saved[0].raw_text, raw);
    assert_eq!(saved[0].fragments.len(), 2);
    assert_eq!(saved[0].fragments[1].text, "Reviews are required");
    assert_eq!(saved[0].fragments[1].embedding, Some(vec![0.0, 1.0]));
    assert_ne!(saved[0].fragments[0].id, saved[0].fragments[1].id);
}

#[tokio::test]
async fn writes_without_an_embedder_and_never_fabricates_vectors() {
    let backend = Arc::new(Backend {
        fail_embedding: true,
        ..Backend::default()
    });
    let service = MemoryService::new(backend.clone(), backend.clone(), None, backend.clone());
    let raw = "Keep PRs small. Reviews are required.";
    let result = service
        .write_memory("claude", raw, WriteOptions::default())
        .await
        .unwrap();
    assert_eq!(*backend.events.lock().unwrap(), ["decompose", "save"]);
    let saved = backend.saved.lock().unwrap();
    assert_eq!(saved[0].id, result.memory_id);
    assert_eq!(saved[0].raw_text, raw);
    assert_eq!(saved[0].fragments.len(), 2);
    assert!(saved[0]
        .fragments
        .iter()
        .all(|fragment| fragment.embedding.is_none()));
}

#[tokio::test]
async fn failed_or_incomplete_embeddings_never_reach_storage() {
    for backend in [
        Backend {
            fail_embedding: true,
            ..Backend::default()
        },
        Backend {
            embeddings: vec![vec![1.0, 0.0]],
            ..Backend::default()
        },
        Backend {
            embeddings: vec![vec![1.0], vec![0.0]],
            ..Backend::default()
        },
    ] {
        let backend = Arc::new(backend);
        assert!(backend
            .service()
            .write_memory("claude", "fact", WriteOptions::default())
            .await
            .is_err());
        assert!(backend.saved.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn empty_decomposition_never_gets_embedded_or_saved() {
    let backend = Arc::new(Backend {
        fragments: vec![],
        ..Backend::default()
    });
    assert!(backend
        .service()
        .write_memory("claude", "fact", WriteOptions::default())
        .await
        .is_err());
    assert_eq!(*backend.events.lock().unwrap(), ["decompose"]);
}

#[tokio::test]
async fn standalone_decomposition_is_a_read_only_preview() {
    let backend = Arc::new(Backend::default());
    let result = backend
        .service()
        .decompose_memory("two facts")
        .await
        .unwrap();
    assert_eq!(result, backend.fragments);
    assert_eq!(*backend.events.lock().unwrap(), ["decompose"]);
}

#[tokio::test]
async fn recall_uses_only_the_replaceable_retriever() {
    let backend = Arc::new(Backend::default());
    let result = backend
        .service()
        .recall_memory(
            "PR preferences?",
            &RecallFilter {
                agent_id: Some("claude".into()),
                ..Default::default()
            },
            3,
        )
        .await
        .unwrap();
    assert_eq!(result.results[0].text, "Keep PRs small");
    assert!(serde_json::to_value(&result).unwrap().is_array());
    assert_eq!(*backend.events.lock().unwrap(), ["recall"]);
}

#[tokio::test]
async fn invalid_requests_fail_before_calling_dependencies() {
    let backend = Arc::new(Backend::default());
    let service = backend.service();
    for (agent_id, text) in [(" ", "fact"), ("claude", " ")] {
        let error = service
            .write_memory(agent_id, text, WriteOptions::default())
            .await
            .unwrap_err();
        assert!(error.is::<InvalidInput>());
    }
    assert!(service
        .decompose_memory(&"x".repeat(MAX_MEMORY_BYTES + 1))
        .await
        .is_err());
    for (query, agent_id, limit) in [
        (" ", None, 3),
        ("query", Some(" "), 3),
        ("query", None, 0),
        ("query", None, MAX_RECALL_LIMIT + 1),
    ] {
        assert!(service
            .recall_memory(
                query,
                &RecallFilter {
                    agent_id: agent_id.map(str::to_owned),
                    ..Default::default()
                },
                limit
            )
            .await
            .is_err());
    }
    assert!(backend.events.lock().unwrap().is_empty());
}

#[test]
fn invalid_vectors_are_rejected_before_pgvector() {
    for vector in [
        vec![],
        vec![1.0],
        vec![0.0, 0.0],
        vec![f32::NAN, 1.0],
        vec![f32::INFINITY, 1.0],
        vec![f32::MAX, f32::MAX],
        vec![1e-30, 0.0],
        vec![1e-20, 0.0],
        vec![f32::MIN_POSITIVE, f32::MIN_POSITIVE],
    ] {
        assert!(validate_embeddings(&[vector], 1, 2).is_err());
    }
    for vector in [
        vec![1.0, 0.0],
        vec![1e-10, -1e-10],
        vec![f32::MIN_POSITIVE.sqrt(), 0.0],
    ] {
        assert!(validate_embeddings(&[vector], 1, 2).is_ok());
    }
}

#[tokio::test]
async fn fact_directives_preserve_context_and_exact_source_fact_links() {
    let backend = Arc::new(Backend::default());
    let target = Uuid::new_v4();
    let context = MemoryContext {
        scope: Some("repo:light".into()),
        session_id: Some("session-1".into()),
        source: Some("user confirmation".into()),
        summary: Some("PR policy".into()),
    };
    let result = backend
        .service()
        .write_memory(
            "claude",
            "raw episode",
            WriteOptions {
                request_id: None,
                context: context.clone(),
                facts: vec![FactDirective {
                    text: "Keep PRs small".into(),
                    pinned: true,
                    links: vec![FactLink {
                        target_fragment_id: target,
                        relationship_type: RelationshipType::Confirms,
                    }],
                    ..Default::default()
                }],
            },
        )
        .await
        .unwrap();
    let saved = backend.saved.lock().unwrap();
    assert_eq!(saved[0].context, context);
    assert_eq!(saved[0].fragments[0].tier, MemoryTier::LongTerm);
    assert_eq!(saved[0].fragments[1].tier, MemoryTier::ShortTerm);
    assert_eq!(
        saved[0].relationships[0].source_fragment,
        result.fragments[0].fragment_id
    );
    assert_eq!(saved[0].relationships[0].target_fragment, target);
}

#[tokio::test]
async fn directives_bind_after_normalization_deduplication_and_reordering() {
    let backend = Arc::new(Backend {
        fragments: vec![
            "  Reviews are required\n".into(),
            " Keep PRs small ".into(),
            "Reviews are required".into(),
        ],
        ..Default::default()
    });
    let target = Uuid::new_v4();
    let result = backend
        .service()
        .write_memory(
            "claude",
            "raw episode",
            WriteOptions {
                request_id: Some(Uuid::new_v4()),
                facts: vec![
                    FactDirective {
                        text: "Keep PRs small".into(),
                        pinned: true,
                        links: vec![FactLink {
                            target_fragment_id: target,
                            relationship_type: RelationshipType::Supports,
                        }],
                        ..Default::default()
                    },
                    FactDirective {
                        text: "Reviews are required".into(),
                        importance: Some(0.25),
                        ..Default::default()
                    },
                ],
                ..Default::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(
        *backend.events.lock().unwrap(),
        ["lookup", "decompose", "embed", "save"]
    );
    let saved = backend.saved.lock().unwrap();
    let prepared = &saved[0];
    assert_eq!(prepared.fragments.len(), 2);
    assert_eq!(prepared.fragments[0].text, "Reviews are required");
    assert_eq!(prepared.fragments[0].importance, 0.25);
    assert_eq!(prepared.fragments[0].tier, MemoryTier::ShortTerm);
    assert_eq!(prepared.fragments[0].embedding, Some(vec![1.0, 0.0]));
    assert_eq!(prepared.fragments[1].text, "Keep PRs small");
    assert_eq!(prepared.fragments[1].tier, MemoryTier::LongTerm);
    assert!(prepared.fragments[1].pinned);
    assert_eq!(prepared.fragments[1].embedding, Some(vec![0.0, 1.0]));
    assert_eq!(prepared.relationships.len(), 1);
    assert_eq!(
        prepared.relationships[0].source_fragment,
        result.fragments[1].fragment_id
    );
    assert_eq!(prepared.relationships[0].target_fragment, target);
}

#[tokio::test]
async fn mismatched_fact_directives_never_attach_links_to_a_different_model_output() {
    for text in ["Keep PRs small.", "Unknown fact"] {
        let backend = Arc::new(Backend::default());
        let result = backend
            .service()
            .write_memory(
                "claude",
                "raw",
                WriteOptions {
                    facts: vec![
                        FactDirective {
                            text: "Reviews are required".into(),
                            pinned: true,
                            ..Default::default()
                        },
                        FactDirective {
                            text: text.into(),
                            ..Default::default()
                        },
                    ],
                    ..Default::default()
                },
            )
            .await;
        let error = result.unwrap_err();
        assert!(error.is::<InvalidInput>());
        assert_eq!(
            error.to_string(),
            "facts[1].text must match a decomposed fragment exactly"
        );
        assert_eq!(*backend.events.lock().unwrap(), ["decompose"]);
        assert!(backend.saved.lock().unwrap().is_empty());
    }
}

#[tokio::test]
async fn feedback_without_a_session_is_rejected_before_embedding_or_storage() {
    let backend = Arc::new(Backend::default());
    let result = backend
        .service()
        .write_memory(
            "claude",
            "raw",
            WriteOptions {
                facts: vec![FactDirective {
                    text: "Keep PRs small".into(),
                    links: vec![FactLink {
                        target_fragment_id: Uuid::new_v4(),
                        relationship_type: RelationshipType::Reinforces,
                    }],
                    ..Default::default()
                }],
                ..Default::default()
            },
        )
        .await;
    assert!(result.unwrap_err().is::<InvalidInput>());
    assert!(backend.events.lock().unwrap().is_empty());
}
