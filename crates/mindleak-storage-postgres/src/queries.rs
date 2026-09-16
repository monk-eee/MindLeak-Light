use anyhow::{ensure, Context, Result};
use mindleak_memory::{MemoryTier, RecallFilter, RecallMatch};
use pgvector::Vector;
use tokio_postgres::Row;

use crate::{lifecycle, PostgresMemoryStore};

impl PostgresMemoryStore {
    pub(super) async fn search(
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

    pub(super) async fn keyword_search(
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
