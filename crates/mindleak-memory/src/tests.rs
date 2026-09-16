use std::sync::{Arc, Mutex};

use super::*;

struct Backend {
    events: Mutex<Vec<&'static str>>,
    saved: Mutex<Vec<PreparedMemory>>,
    fragments: Vec<String>,
    embeddings: Vec<Vec<f32>>,
    fail_embedding: bool,
}

impl Default for Backend {
    fn default() -> Self {
        Self {
            events: Mutex::new(Vec::new()),
            saved: Mutex::new(Vec::new()),
            fragments: vec!["Keep PRs small".into(), "Reviews are required".into()],
            embeddings: vec![vec![1.0, 0.0], vec![0.0, 1.0]],
            fail_embedding: false,
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
    async fn save(&self, memory: &PreparedMemory) -> Result<()> {
        self.events.lock().unwrap().push("save");
        self.saved.lock().unwrap().push(memory.clone());
        Ok(())
    }
}

#[async_trait]
impl MemoryRetriever for Backend {
    async fn recall(
        &self,
        query: &str,
        agent_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        assert_eq!(query, "PR preferences?");
        assert_eq!(agent_id, Some("claude"));
        assert_eq!(limit, 3);
        self.events.lock().unwrap().push("recall");
        Ok(vec![RecallMatch {
            memory_id: Uuid::nil(),
            fragment_id: Uuid::nil(),
            agent_id: "claude".into(),
            text: "Keep PRs small".into(),
            score: 0.92,
        }])
    }
}

#[tokio::test]
async fn writes_raw_text_and_all_embedded_fragments_in_one_save() {
    let backend = Arc::new(Backend::default());
    let raw = "  Keep PRs small.\nReviews are required.  ";
    let result = backend.service().write_memory("claude", raw).await.unwrap();
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
    let result = service.write_memory("claude", raw).await.unwrap();
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
            .write_memory("claude", "fact")
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
        .write_memory("claude", "fact")
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
        .recall_memory("PR preferences?", Some("claude"), 3)
        .await
        .unwrap();
    assert_eq!(result[0].text, "Keep PRs small");
    assert_eq!(*backend.events.lock().unwrap(), ["recall"]);
}

#[tokio::test]
async fn invalid_requests_fail_before_calling_dependencies() {
    let backend = Arc::new(Backend::default());
    let service = backend.service();
    for (agent_id, text) in [(" ", "fact"), ("claude", " ")] {
        let error = service.write_memory(agent_id, text).await.unwrap_err();
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
        assert!(service.recall_memory(query, agent_id, limit).await.is_err());
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
    ] {
        assert!(validate_embeddings(&[vector], 1, 2).is_err());
    }
    assert!(validate_embeddings(&[vec![1.0, 0.0]], 1, 2).is_ok());
}
