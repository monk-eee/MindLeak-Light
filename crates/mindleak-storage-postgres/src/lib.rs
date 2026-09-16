mod lifecycle;

use std::{
    collections::{HashMap, VecDeque},
    path::Path,
    sync::{Arc, Mutex},
    time::Duration,
};

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use mindleak_memory::{
    validate_embeddings, validate_text, MemoryRetriever, MemoryStore, MemoryTier, PreparedMemory,
    RecallFilter, RecallMatch, TextEmbedder, MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
    MAX_RECALL_LIMIT,
};
use pgvector::Vector;
use rustls::pki_types::{pem::PemObject, CertificateDer};
use serde::{Deserialize, Serialize};
use tokio_postgres::config::SslMode;
use tokio_postgres::Row;
use tokio_postgres_rustls::MakeRustlsConnect;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct EmbeddingSpace {
    model: String,
    dimensions: usize,
}

#[derive(Clone)]
pub struct PostgresMemoryStore {
    pool: Pool,
    space: Option<EmbeddingSpace>,
}

impl PostgresMemoryStore {
    pub async fn connect(
        database_url: &str,
        embedding_space: Option<(&str, usize)>,
        pool_size: usize,
        ca_file: Option<&Path>,
    ) -> Result<Self> {
        if let Some((model, dimensions)) = embedding_space {
            validate_embeddings(&[], 0, dimensions)?;
            validate_text(model, "embedding model", 256)?;
        }
        ensure!(
            (1..=64).contains(&pool_size),
            "database pool size must be in 1..=64"
        );
        let mut config: tokio_postgres::Config =
            database_url.parse().context("invalid database URL")?;
        config.connect_timeout(Duration::from_secs(5));
        config.application_name("mindleak-light");
        config.options("-c statement_timeout=15000 -c lock_timeout=5000");
        if config.get_ssl_mode() == SslMode::Prefer {
            config.ssl_mode(SslMode::Require);
        }
        let mut roots = rustls::RootCertStore::empty();
        roots.extend(webpki_roots::TLS_SERVER_ROOTS.iter().cloned());
        if let Some(path) = ca_file {
            let certificates = CertificateDer::pem_file_iter(path)
                .context("open Postgres CA file")?
                .collect::<std::result::Result<Vec<_>, _>>()
                .context("parse Postgres CA file")?;
            ensure!(
                !certificates.is_empty(),
                "Postgres CA file contains no certificates"
            );
            for certificate in certificates {
                roots
                    .add(certificate)
                    .context("invalid Postgres CA certificate")?;
            }
        }
        let tls = MakeRustlsConnect::new(
            rustls::ClientConfig::builder()
                .with_root_certificates(roots)
                .with_no_client_auth(),
        );
        let manager = Manager::from_config(
            config,
            tls,
            ManagerConfig {
                recycling_method: RecyclingMethod::Fast,
            },
        );
        let pool = Pool::builder(manager)
            .max_size(pool_size)
            .runtime(Runtime::Tokio1)
            .wait_timeout(Some(Duration::from_secs(5)))
            .create_timeout(Some(Duration::from_secs(5)))
            .recycle_timeout(Some(Duration::from_secs(5)))
            .build()?;
        let store = Self {
            pool,
            space: embedding_space.map(|(model, dimensions)| EmbeddingSpace {
                model: model.into(),
                dimensions,
            }),
        };
        store.initialize().await?;
        Ok(store)
    }

    async fn initialize(&self) -> Result<()> {
        let mut connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let transaction = connection.transaction().await?;
        transaction
            .query_one("SELECT pg_advisory_xact_lock(5570197736903360513)", &[])
            .await?;
        transaction
            .batch_execute(&format!(
                include_str!("../schema.sql"),
                dimensions = self.space.as_ref().map_or(768, |space| space.dimensions),
            ))
            .await
            .context("initialize the three-table memory schema")?;
        transaction
            .batch_execute(include_str!("../migrations/0002-optional-embeddings.sql"))
            .await
            .context("enable model-free storage and keyword recall")?;
        transaction
            .batch_execute(include_str!("../migrations/0003-fact-lifecycle.sql"))
            .await
            .context("initialize contextual fact lifecycle")?;
        let Some(space) = &self.space else {
            transaction.commit().await?;
            return Ok(());
        };
        let actual_type: String = transaction
            .query_one(
                "SELECT format_type(atttypid, atttypmod) FROM pg_attribute \
             WHERE attrelid = 'public.fragments'::regclass AND attname = 'embedding'",
                &[],
            )
            .await?
            .get(0);
        let metadata: Option<String> = transaction
            .query_one(
                "SELECT obj_description('public.fragments'::regclass, 'pg_class')",
                &[],
            )
            .await?
            .get(0);
        match metadata {
            Some(metadata) => {
                let stored: EmbeddingSpace = serde_json::from_str(&metadata)
                    .context("invalid embedding-space metadata on fragments")?;
                ensure!(
                    &stored == space && actual_type == format!("vector({})", space.dimensions),
                    "stored embedding model or dimensions differ from configuration; use the original model or a new database"
                );
            }
            None => {
                let populated: bool = transaction
                    .query_one(
                        "SELECT EXISTS(SELECT 1 FROM public.fragments WHERE embedding IS NOT NULL)",
                        &[],
                    )
                    .await?
                    .get(0);
                ensure!(
                    !populated,
                    "cannot identify the model of existing fragments"
                );
                if actual_type != format!("vector({})", space.dimensions) {
                    transaction
                        .batch_execute(&format!(
                            "ALTER TABLE public.fragments ALTER COLUMN embedding TYPE vector({})",
                            space.dimensions,
                        ))
                        .await?;
                }
                let metadata = serde_json::to_string(space)?;
                let statement: String = transaction
                    .query_one(
                        "SELECT format('COMMENT ON TABLE public.fragments IS %L', $1::text)",
                        &[&metadata],
                    )
                    .await?
                    .get(0);
                transaction.batch_execute(&statement).await?;
            }
        }
        transaction.commit().await?;
        Ok(())
    }

    pub async fn health(&self) -> Result<()> {
        self.pool.get().await?.query_one("SELECT 1", &[]).await?;
        Ok(())
    }

    async fn search(
        &self,
        vector: Vec<f32>,
        filter: &RecallFilter,
        limit: usize,
        min_similarity: Option<f64>,
    ) -> Result<Vec<RecallMatch>> {
        let vector = Vector::from(vector);
        let limit = i64::try_from(limit)?;
        let connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let rows = connection
            .query(
                &format!("SELECT memories.id AS memory_id, fragments.id AS fragment_id, memories.agent_id, \
                    fragments.text, 1.0 - (fragments.embedding <=> $1) AS score, {} \
             FROM public.fragments AS fragments \
             JOIN public.memories AS memories ON memories.id = fragments.memory_id \
             WHERE fragments.embedding IS NOT NULL AND ($2::text IS NULL OR memories.agent_id = $2) \
                    AND ($4::double precision IS NULL OR 1.0 - (fragments.embedding <=> $1) >= $4) \
                      AND ($5::text IS NULL OR memories.context->>'scope' = $5) \
                      AND ($6::text IS NULL OR fragments.tier = $6) \
                      AND ($7::boolean OR fragments.state = 'active') \
                  ORDER BY fragments.embedding <=> $1, fragments.id LIMIT $3", lifecycle::LIFECYCLE_COLUMNS),
                    &[&vector, &filter.agent_id, &limit, &min_similarity, &filter.scope,
                      &filter.tier.map(MemoryTier::as_str), &filter.include_inactive],
            )
            .await
            .context("recall fragments with pgvector")?;
        rows.into_iter().map(recall_match).collect()
    }

    async fn keyword_search(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        let connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let limit = i64::try_from(limit)?;
        let rows = connection.query(
                &format!("SELECT memories.id AS memory_id, fragments.id AS fragment_id, memories.agent_id, \
                    fragments.text, ts_rank_cd(to_tsvector('english', fragments.text), query, 32)::double precision AS score, {} \
             FROM public.fragments AS fragments \
             JOIN public.memories AS memories ON memories.id = fragments.memory_id \
             CROSS JOIN websearch_to_tsquery('english', $1) AS query \
             WHERE to_tsvector('english', fragments.text) @@ query \
               AND ($2::text IS NULL OR memories.agent_id = $2) \
                             AND ($4::text IS NULL OR memories.context->>'scope' = $4) \
                             AND ($5::text IS NULL OR fragments.tier = $5) \
                             AND ($6::boolean OR fragments.state = 'active') \
                         ORDER BY score DESC, fragments.id LIMIT $3", lifecycle::LIFECYCLE_COLUMNS),
                        &[&query, &filter.agent_id, &limit, &filter.scope, &filter.tier.map(MemoryTier::as_str), &filter.include_inactive],
        ).await.context("recall fragments with PostgreSQL full-text search")?;
        rows.into_iter().map(recall_match).collect()
    }
}

fn recall_match(row: Row) -> Result<RecallMatch> {
    let score = row.try_get::<_, f64>("score")?;
    ensure!(
        score.is_finite(),
        "database returned a non-finite recall score"
    );
    let lifecycle = lifecycle::from_row(&row)?;
    Ok(RecallMatch {
        memory_id: row.try_get("memory_id")?,
        fragment_id: row.try_get("fragment_id")?,
        agent_id: row.try_get("agent_id")?,
        text: row.try_get("text")?,
        score: score.clamp(-1.0, 1.0),
        context: serde_json::from_str(&row.try_get::<_, String>("context")?)?,
        activation: lifecycle.activation(row.try_get("observed_at")?, row.try_get("importance")?),
        lifecycle,
        ranking_priority: 0.0,
        relationships: Vec::new(),
        relationship_count: 0,
        relationships_truncated: false,
    })
}

#[async_trait]
impl MemoryStore for PostgresMemoryStore {
    async fn save(&self, memory: &PreparedMemory) -> Result<()> {
        validate_text(&memory.agent_id, "agentId", 256)?;
        validate_text(&memory.raw_text, "text", MAX_MEMORY_BYTES)?;
        memory.context.validate()?;
        ensure!(
            (1..=MAX_FRAGMENTS).contains(&memory.fragments.len()),
            "invalid fragment count"
        );
        for fragment in &memory.fragments {
            validate_text(&fragment.text, "fragment", MAX_FRAGMENT_BYTES)?;
            match (&self.space, &fragment.embedding) {
                (Some(space), Some(vector)) => {
                    validate_embeddings(std::slice::from_ref(vector), 1, space.dimensions)?;
                }
                (None, None) => {}
                _ => anyhow::bail!("fragment embeddings do not match the configured storage mode"),
            }
            ensure!(
                (0.0..=1.0).contains(&fragment.importance),
                "invalid fragment importance"
            );
            ensure!(
                !fragment.pinned || fragment.tier == MemoryTier::LongTerm,
                "pinned facts must be long-term"
            );
        }
        let mut connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let transaction = connection.transaction().await?;
        transaction
            .execute(
                "INSERT INTO public.memories (id, agent_id, raw_text, context) VALUES ($1, $2, $3, $4::text::jsonb)",
                &[&memory.id, &memory.agent_id, &memory.raw_text, &serde_json::to_string(&memory.context)?],
            )
            .await
            .context("store raw memory")?;
        let statement = transaction
            .prepare(
                     "INSERT INTO public.fragments (id, memory_id, text, embedding, importance, tier, pinned) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7)",
            )
            .await?;
        for fragment in &memory.fragments {
            transaction
                .execute(
                    &statement,
                    &[
                        &fragment.id,
                        &memory.id,
                        &fragment.text,
                        &fragment.embedding.clone().map(Vector::from),
                        &fragment.importance,
                        &fragment.tier.as_str(),
                        &fragment.pinned,
                    ],
                )
                .await
                .context("store memory fragment")?;
        }
        self.apply_relationships(&transaction, memory).await?;
        transaction
            .commit()
            .await
            .context("commit complete memory")?;
        Ok(())
    }
}

pub struct VectorMemoryRetriever {
    store: PostgresMemoryStore,
    embedder: Arc<dyn TextEmbedder>,
    min_similarity: Option<f64>,
    query_embeddings: Mutex<VecDeque<(String, Vec<f32>)>>,
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
        let cached = self
            .query_embeddings
            .lock()
            .map_err(|_| anyhow::anyhow!("query embedding cache lock failed"))?
            .iter()
            .find(|(text, _)| text == query)
            .map(|(_, vector)| vector.clone());
        if let Some(vector) = cached {
            return Ok(vector);
        }
        let embeddings = self.embedder.embed_batch(&[query.to_owned()]).await?;
        validate_embeddings(&embeddings, 1, dimensions)?;
        let vector = embeddings
            .into_iter()
            .next()
            .context("missing query embedding")?;
        let mut cache = self
            .query_embeddings
            .lock()
            .map_err(|_| anyhow::anyhow!("query embedding cache lock failed"))?;
        if !cache.iter().any(|(text, _)| text == query) {
            if cache.len() == QUERY_EMBEDDING_CACHE_CAPACITY {
                cache.pop_front();
            }
            cache.push_back((query.to_owned(), vector.clone()));
        }
        Ok(vector)
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
    async fn recall(
        &self,
        query: &str,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        let candidates = self.candidates(query, filter, MAX_RECALL_LIMIT).await?;
        self.store.finish_recall(candidates, filter, limit).await
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
