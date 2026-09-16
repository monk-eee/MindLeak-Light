use std::{
    collections::{HashMap, HashSet},
    sync::Arc,
};

use anyhow::Result;
use uuid::Uuid;

use crate::{
    normalize_fragments, validate_embeddings, validate_text, EmbeddedFragment, InvalidInput,
    MemoryDecomposer, MemoryRetriever, MemoryStore, MemoryTier, PreparedMemory,
    PreparedRelationship, RecallFilter, RecallMatch, TextEmbedder, WriteMemoryResult, WriteOptions,
    WriteRequest, MAX_FACT_LINKS, MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
    MAX_MEMORY_LINKS, MAX_RECALL_LIMIT,
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

    pub async fn write_memory(
        &self,
        agent_id: &str,
        text: &str,
        options: WriteOptions,
    ) -> Result<WriteMemoryResult> {
        validate_text(agent_id, "agentId", 256)?;
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        options.context.validate()?;
        if options.facts.len() > MAX_FRAGMENTS {
            return Err(InvalidInput("too many fact directives".into()).into());
        }
        let mut directive_texts = HashSet::new();
        let mut link_count = 0;
        for directive in &options.facts {
            validate_text(&directive.text, "fact text", MAX_FRAGMENT_BYTES)?;
            if !directive_texts.insert(&directive.text) {
                return Err(InvalidInput(
                    "fact directives must match distinct decomposed fragment text exactly".into(),
                )
                .into());
            }
            let importance = directive.importance.unwrap_or(0.5);
            if !importance.is_finite() || !(0.0..=1.0).contains(&importance) {
                return Err(
                    InvalidInput("fact importance must be finite and in 0..=1".into()).into(),
                );
            }
            link_count += directive.links.len();
            if directive.links.len() > MAX_FACT_LINKS || link_count > MAX_MEMORY_LINKS {
                return Err(InvalidInput("too many fact relationships".into()).into());
            }
            let mut targets = HashSet::new();
            for link in &directive.links {
                if !targets.insert(link.target_fragment_id) {
                    return Err(InvalidInput(
                        "a fact can declare only one relationship to each target per write".into(),
                    )
                    .into());
                }
                if link.relationship_type.is_feedback() && options.context.session_id.is_none() {
                    return Err(InvalidInput(
                        "reinforces and confirms require context.sessionId".into(),
                    )
                    .into());
                }
            }
        }
        let request = options.request_id.map(|request_id| WriteRequest {
            request_id,
            agent_id: agent_id.to_owned(),
            text: text.to_owned(),
            context: options.context.clone(),
            facts: options.facts.clone(),
        });
        if let Some(request) = &request {
            if let Some(result) = self.store.lookup_write(request).await? {
                return Ok(result);
            }
        }
        let fragments = self.decompose_memory(text).await?;
        let mut policies = HashMap::new();
        for directive in options.facts {
            if !fragments.contains(&directive.text) {
                return Err(InvalidInput(
                    "fact directives must match distinct decomposed fragment text exactly".into(),
                )
                .into());
            }
            policies.insert(directive.text.clone(), directive);
        }
        let embeddings: Vec<_> = if let Some(embedder) = &self.embedder {
            let embeddings = embedder.embed_batch(&fragments).await?;
            validate_embeddings(&embeddings, fragments.len(), embedder.dimensions())?;
            embeddings.into_iter().map(Some).collect()
        } else {
            vec![None; fragments.len()]
        };
        let mut relationships = Vec::new();
        let memory = PreparedMemory {
            id: Uuid::new_v4(),
            agent_id: agent_id.to_owned(),
            raw_text: text.to_owned(),
            context: options.context,
            fragments: fragments
                .into_iter()
                .zip(embeddings)
                .map(|(text, embedding)| {
                    let id = Uuid::new_v4();
                    let policy = policies.remove(&text).unwrap_or_default();
                    for link in policy.links {
                        relationships.push(PreparedRelationship {
                            source_fragment: id,
                            target_fragment: link.target_fragment_id,
                            relationship_type: link.relationship_type,
                        });
                    }
                    EmbeddedFragment {
                        id,
                        text,
                        embedding,
                        importance: policy.importance.unwrap_or(0.5),
                        tier: if policy.pinned {
                            MemoryTier::LongTerm
                        } else {
                            policy.tier
                        },
                        pinned: policy.pinned,
                    }
                })
                .collect(),
            relationships,
            request,
        };
        self.store.save(&memory).await
    }

    pub async fn decompose_memory(&self, text: &str) -> Result<Vec<String>> {
        validate_text(text, "text", MAX_MEMORY_BYTES)?;
        normalize_fragments(self.decomposer.decompose(text).await?)
    }

    pub async fn recall_memory(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        filter.validate()?;
        if !(1..=MAX_RECALL_LIMIT).contains(&limit) {
            return Err(InvalidInput(format!("limit must be in 1..={MAX_RECALL_LIMIT}")).into());
        }
        self.retriever.recall(query, filter, limit).await
    }
}
