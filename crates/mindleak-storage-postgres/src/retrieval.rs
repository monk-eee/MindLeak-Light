use std::{
    collections::{HashMap, VecDeque},
    sync::{Arc, Mutex},
};

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use mindleak_memory::{
    validate_embeddings, validate_text, ChainFilter, ChainMatch, InvalidInput, KeywordMatchMode,
    MemoryRetriever, RecallDiagnostics, RecallFilter, RecallMatch, TextEmbedder, MAX_MEMORY_BYTES,
    MAX_RECALL_LIMIT,
};
use tokio::sync::OnceCell;

use crate::PostgresMemoryStore;

struct QueryEmbedding {
    query: String,
    vector: OnceCell<Vec<f32>>,
}

pub struct VectorMemoryRetriever {
    store: PostgresMemoryStore,
    embedder: Arc<dyn TextEmbedder>,
    min_similarity: Option<f64>,
    query_embeddings: Mutex<VecDeque<Arc<QueryEmbedding>>>,
}

const QUERY_EMBEDDING_CACHE_CAPACITY: usize = 128;

impl VectorMemoryRetriever {
    pub fn new(store: PostgresMemoryStore, embedder: Arc<dyn TextEmbedder>) -> Self {
        Self {
            store,
            embedder,
            min_similarity: None,
            query_embeddings: Mutex::new(VecDeque::new()),
        }
    }

    pub fn with_min_similarity(mut self, minimum: Option<f64>) -> Result<Self> {
        ensure!(
            minimum.is_none_or(|value| value.is_finite() && (-1.0..=1.0).contains(&value)),
            "minimum cosine similarity must be finite and in -1..=1"
        );
        self.min_similarity = minimum;
        Ok(self)
    }

    async fn query_embedding(&self, query: &str, dimensions: usize) -> Result<Vec<f32>> {
        let entry = {
            let mut cache = self
                .query_embeddings
                .lock()
                .map_err(|_| anyhow::anyhow!("query embedding cache lock failed"))?;
            if let Some(entry) = cache.iter().find(|entry| entry.query == query) {
                entry.clone()
            } else {
                if cache.len() == QUERY_EMBEDDING_CACHE_CAPACITY {
                    cache.pop_front();
                }
                let entry = Arc::new(QueryEmbedding {
                    query: query.to_owned(),
                    vector: OnceCell::new(),
                });
                cache.push_back(entry.clone());
                entry
            }
        };
        let vector = entry
            .vector
            .get_or_try_init(|| async {
                let embeddings = self.embedder.embed_batch(&[query.to_owned()]).await?;
                validate_embeddings(&embeddings, 1, dimensions)?;
                embeddings
                    .into_iter()
                    .next()
                    .context("missing query embedding")
            })
            .await?;
        Ok(vector.clone())
    }

    async fn candidates(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        filter.validate()?;
        let space = self
            .store
            .space
            .as_ref()
            .context("vector recall requires configured embeddings")?;
        let vector = self.query_embedding(query, space.dimensions).await?;
        self.store
            .search(vector, filter, limit, self.min_similarity)
            .await
    }
}

#[async_trait]
impl MemoryRetriever for VectorMemoryRetriever {
    fn capabilities(&self) -> mindleak_memory::RetrievalCapabilities {
        mindleak_memory::RetrievalCapabilities {
            strategy: "vector",
            match_modes: vec![KeywordMatchMode::Websearch],
            query_diagnostics: true,
            embedding_model: self.store.space.as_ref().map(|space| space.model.clone()),
            embedding_dimensions: self.store.space.as_ref().map(|space| space.dimensions),
            minimum_similarity: self.min_similarity,
            relevance_model: None,
            provider_calls_instrumented: self.embedder.records_usage(),
        }
    }

    fn chain_strategy(&self) -> &'static str {
        "vector"
    }
    async fn recall_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Vec<ChainMatch>> {
        if filter.match_mode != KeywordMatchMode::Websearch {
            return Err(InvalidInput(
                "matchMode only applies to keyword or hybrid knowledge search".into(),
            )
            .into());
        }
        ensure!(
            (1..=mindleak_memory::MAX_CHAIN_RESULTS).contains(&limit),
            "invalid knowledge recall limit"
        );
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        let space = self
            .store
            .space
            .as_ref()
            .context("knowledge vector search requires configured embeddings")?;
        let vector = self.query_embedding(query, space.dimensions).await?;
        self.store
            .search_knowledge(
                query,
                filter,
                limit,
                Some(vector),
                self.min_similarity,
                false,
            )
            .await
    }
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        if filter.match_mode != KeywordMatchMode::Websearch {
            return Err(
                InvalidInput("matchMode only applies to keyword or hybrid recall".into()).into(),
            );
        }
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        let candidates = self.candidates(query, filter, MAX_RECALL_LIMIT).await?;
        self.store.finish_recall(candidates, filter, limit).await
    }

    async fn query_diagnostics(
        &self,
        query: &str,
        filter: &RecallFilter,
    ) -> Result<RecallDiagnostics> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        filter.validate()?;
        Ok(RecallDiagnostics {
            strategy: "vector",
            keyword: None,
            relevance_filter: false,
        })
    }
}

pub struct HybridMemoryRetriever {
    vector: VectorMemoryRetriever,
}

impl HybridMemoryRetriever {
    pub fn new(store: PostgresMemoryStore, embedder: Arc<dyn TextEmbedder>) -> Self {
        Self {
            vector: VectorMemoryRetriever::new(store, embedder),
        }
    }

    pub fn with_min_similarity(mut self, minimum: Option<f64>) -> Result<Self> {
        self.vector = self.vector.with_min_similarity(minimum)?;
        Ok(self)
    }
}

#[async_trait]
impl MemoryRetriever for HybridMemoryRetriever {
    fn capabilities(&self) -> mindleak_memory::RetrievalCapabilities {
        let mut capabilities = self.vector.capabilities();
        capabilities.strategy = "hybrid";
        capabilities.match_modes = vec![
            KeywordMatchMode::Websearch,
            KeywordMatchMode::All,
            KeywordMatchMode::Any,
        ];
        capabilities
    }

    fn chain_strategy(&self) -> &'static str {
        "hybrid"
    }
    async fn recall_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Vec<ChainMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        let space = self
            .vector
            .store
            .space
            .as_ref()
            .context("knowledge vector search requires configured embeddings")?;
        let vector = self.vector.query_embedding(query, space.dimensions).await?;
        self.vector
            .store
            .search_knowledge(
                query,
                filter,
                limit,
                Some(vector),
                self.vector.min_similarity,
                true,
            )
            .await
    }
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        filter.validate()?;
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        let (vector, keyword) = tokio::try_join!(
            self.vector.candidates(query, filter, MAX_RECALL_LIMIT),
            self.vector
                .store
                .keyword_search(query, filter, MAX_RECALL_LIMIT),
        )?;
        let candidates = fuse_rankings([vector, keyword], MAX_RECALL_LIMIT * 2);
        self.vector
            .store
            .finish_recall(candidates, filter, limit)
            .await
    }

    async fn query_diagnostics(
        &self,
        query: &str,
        filter: &RecallFilter,
    ) -> Result<RecallDiagnostics> {
        Ok(RecallDiagnostics {
            strategy: "hybrid",
            keyword: Some(self.vector.store.keyword_diagnostics(query, filter).await?),
            relevance_filter: false,
        })
    }
}

fn fuse_rankings(rankings: [Vec<RecallMatch>; 2], limit: usize) -> Vec<RecallMatch> {
    let mut merged = HashMap::new();
    for ranking in rankings {
        for (rank, mut fragment) in ranking.into_iter().enumerate() {
            fragment.score = 30.5 / (61.0 + rank as f64);
            merged
                .entry(fragment.fragment_id)
                .and_modify(|existing: &mut RecallMatch| existing.score += fragment.score)
                .or_insert(fragment);
        }
    }
    let mut results: Vec<_> = merged.into_values().collect();
    results.sort_by(|left, right| {
        right
            .score
            .total_cmp(&left.score)
            .then_with(|| left.fragment_id.cmp(&right.fragment_id))
    });
    results.truncate(limit);
    results
}

pub struct KeywordMemoryRetriever {
    store: PostgresMemoryStore,
}

impl KeywordMemoryRetriever {
    pub fn new(store: PostgresMemoryStore) -> Self {
        Self { store }
    }
}

#[async_trait]
impl MemoryRetriever for KeywordMemoryRetriever {
    fn capabilities(&self) -> mindleak_memory::RetrievalCapabilities {
        mindleak_memory::RetrievalCapabilities {
            strategy: "keyword",
            match_modes: vec![
                KeywordMatchMode::Websearch,
                KeywordMatchMode::All,
                KeywordMatchMode::Any,
            ],
            query_diagnostics: true,
            provider_calls_instrumented: true,
            ..Default::default()
        }
    }

    async fn recall_chains(
        &self,
        query: &str,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Vec<ChainMatch>> {
        self.store.search_chains(query, filter, limit).await
    }
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        filter.validate()?;
        let candidates = self
            .store
            .keyword_search(query, filter, MAX_RECALL_LIMIT)
            .await?;
        self.store.finish_recall(candidates, filter, limit).await
    }

    async fn query_diagnostics(
        &self,
        query: &str,
        filter: &RecallFilter,
    ) -> Result<RecallDiagnostics> {
        Ok(RecallDiagnostics {
            strategy: "keyword",
            keyword: Some(self.store.keyword_diagnostics(query, filter).await?),
            relevance_filter: false,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use uuid::Uuid;

    fn fragment(identifier: u128, score: f64) -> RecallMatch {
        RecallMatch {
            memory_id: Uuid::from_u128(100),
            fragment_id: Uuid::from_u128(identifier),
            agent_id: "hybrid-test".into(),
            text: format!("Fact {identifier}"),
            score,
            ..Default::default()
        }
    }

    #[test]
    fn hybrid_fusion_uses_ranks_and_credits_overlap_once() {
        let results = fuse_rankings(
            [
                vec![fragment(1, 0.99), fragment(3, 0.8)],
                vec![fragment(2, 0.001), fragment(3, 0.0001)],
            ],
            5,
        );
        assert_eq!(results.len(), 3);
        assert_eq!(results[0].fragment_id, Uuid::from_u128(3));
        assert!((results[0].score - 61.0 / 62.0).abs() < 1e-12);
        assert_eq!(results[1].fragment_id, Uuid::from_u128(1));
        assert_eq!(results[2].fragment_id, Uuid::from_u128(2));
        assert_eq!(results[1].score, 0.5);
    }

    #[test]
    fn hybrid_fusion_has_stable_fifty_candidate_boundaries() {
        let keyword: Vec<_> = (1..=50)
            .map(|identifier| fragment(identifier, 0.1))
            .collect();
        let vector: Vec<_> = (101..=150)
            .map(|identifier| fragment(identifier, 0.9))
            .collect();
        let single_branch = fuse_rankings([keyword.clone(), vec![]], 50);
        assert_eq!(single_branch.len(), 50);
        assert_eq!(single_branch[49].fragment_id, Uuid::from_u128(50));
        assert_eq!(single_branch[49].score, 30.5 / 110.0);

        let results = fuse_rankings([keyword.clone(), vector.clone()], 50);
        assert_eq!(results.len(), 50);
        assert_eq!(results[48].fragment_id, Uuid::from_u128(25));
        assert_eq!(results[49].fragment_id, Uuid::from_u128(125));
        assert_eq!(results[49].score, 30.5 / 85.0);
        assert!(!results
            .iter()
            .any(|fact| fact.fragment_id == Uuid::from_u128(26)));
        let reversed = fuse_rankings([vector, keyword], 50);
        assert_eq!(
            results
                .iter()
                .map(|fact| (fact.fragment_id, fact.score))
                .collect::<Vec<_>>(),
            reversed
                .iter()
                .map(|fact| (fact.fragment_id, fact.score))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn hybrid_fusion_handles_empty_branches_limits_and_distinct_facts_from_one_memory() {
        assert!(fuse_rankings([vec![], vec![]], 5).is_empty());
        let results = fuse_rankings([vec![], vec![fragment(1, 0.1), fragment(2, 0.05)]], 5);
        assert_eq!(results.len(), 2);
        assert_eq!(results[0].memory_id, results[1].memory_id);
        assert_eq!(fuse_rankings([results, vec![]], 1).len(), 1);
        assert_eq!(
            fuse_rankings([vec![fragment(1, 0.9)], vec![fragment(1, 0.01)]], 5)[0].score,
            1.0
        );
    }
}
