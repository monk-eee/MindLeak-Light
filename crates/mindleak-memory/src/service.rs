use std::sync::Arc;

use anyhow::Result;
use uuid::Uuid;

use crate::{
    normalize_fragments, validate_embeddings, validate_text, EmbeddedFragment, InvalidInput,
    MemoryDecomposer, MemoryRetriever, MemoryStore, PreparedMemory, RecallMatch, TextEmbedder,
    WriteMemoryResult, MAX_MEMORY_BYTES, MAX_RECALL_LIMIT,
};

#[derive(Clone)]
pub struct MemoryService {
    store: Arc<dyn MemoryStore>,
    decomposer: Arc<dyn MemoryDecomposer>,
    embedder: Option<Arc<dyn TextEmbedder>>,
    retriever: Arc<dyn MemoryRetriever>,
}

impl MemoryService {
    pub fn new(
        store: Arc<dyn MemoryStore>,
        decomposer: Arc<dyn MemoryDecomposer>,
        embedder: Option<Arc<dyn TextEmbedder>>,
        retriever: Arc<dyn MemoryRetriever>,
    ) -> Self {
        Self {
            store,
            decomposer,
            embedder,
            retriever,
        }
    }

    pub async fn write_memory(&self, agent_id: &str, text: &str) -> Result<WriteMemoryResult> {
        validate_text(agent_id, "agentId", 256)?;
        let fragments = self.decompose_memory(text).await?;
        let embeddings: Vec<_> = if let Some(embedder) = &self.embedder {
            let embeddings = embedder.embed_batch(&fragments).await?;
            validate_embeddings(&embeddings, fragments.len(), embedder.dimensions())?;
            embeddings.into_iter().map(Some).collect()
        } else {
            vec![None; fragments.len()]
        };
        let memory = PreparedMemory {
            id: Uuid::new_v4(),
            agent_id: agent_id.to_owned(),
            raw_text: text.to_owned(),
            fragments: fragments
                .into_iter()
                .zip(embeddings)
                .map(|(text, embedding)| EmbeddedFragment {
                    id: Uuid::new_v4(),
                    text,
                    embedding,
                    importance: 0.5,
                })
                .collect(),
        };
        self.store.save(&memory).await?;
        Ok(WriteMemoryResult {
            memory_id: memory.id,
        })
    }

    pub async fn decompose_memory(&self, text: &str) -> Result<Vec<String>> {
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        normalize_fragments(self.decomposer.decompose(text).await?)
    }

    pub async fn recall_memory(
        &self,
        query: &str,
        agent_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        if let Some(agent_id) = agent_id {
            validate_text(agent_id, "agentId", 256)?;
        }
        if !(1..=MAX_RECALL_LIMIT).contains(&limit) {
            return Err(InvalidInput(format!("limit must be in 1..={MAX_RECALL_LIMIT}")).into());
        }
        self.retriever.recall(query, agent_id, limit).await
    }
}
