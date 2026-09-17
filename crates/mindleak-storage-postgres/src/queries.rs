use anyhow::{ensure, Context, Result};
use mindleak_memory::{
    validate_text, KeywordQueryDiagnostics, MemoryTier, RecallFilter, RecallMatch, MAX_MEMORY_BYTES,
};
use pgvector::Vector;
use tokio_postgres::Row;

use crate::{lifecycle, PostgresMemoryStore};

pub(super) fn keyword_query_sql(query: &str, mode: &str) -> String {
    format!(
        "CASE {mode}::text \
    WHEN 'all' THEN plainto_tsquery('english', {query}) \
    WHEN 'any' THEN (SELECT COALESCE(string_agg(quote_literal(term), ' | '), '')::tsquery \
        FROM unnest(tsvector_to_array(to_tsvector('english', {query}))) AS terms(term)) \
    ELSE websearch_to_tsquery('english', {query}) END"
    )
}

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
             WHERE memories.chain_id IS NULL AND fragments.embedding IS NOT NULL AND ($2::text IS NULL OR memories.agent_id = $2) \
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
        let keyword_query = keyword_query_sql("$1", "$2");
        let rows = connection.query(
                &format!("SELECT memories.id AS memory_id, fragments.id AS fragment_id, memories.agent_id, \
                    fragments.text, ts_rank_cd(ARRAY[0.025, 0.1, 0.4, 1.0]::real[], fragments.search_vector, query, 32)::double precision AS score, {} \
             FROM public.fragments AS fragments \
             JOIN public.memories AS memories ON memories.id = fragments.memory_id \
             CROSS JOIN (SELECT {keyword_query} AS query) AS parsed \
             WHERE memories.chain_id IS NULL AND fragments.search_vector @@ query \
               AND ($3::text IS NULL OR memories.agent_id = $3) \
                             AND ($5::text IS NULL OR memories.context->>'scope' = $5) \
                             AND ($6::text IS NULL OR fragments.tier = $6) \
                             AND ($7::boolean OR fragments.state = 'active') \
                         ORDER BY score DESC, fragments.id LIMIT $4", lifecycle::LIFECYCLE_COLUMNS),
                        &[&query, &filter.match_mode.as_str(), &filter.agent_id, &limit, &filter.scope, &filter.tier.map(MemoryTier::as_str), &filter.include_inactive],
        ).await.context("recall fragments with PostgreSQL full-text search")?;
        rows.into_iter().map(recall_match).collect()
    }

    pub(super) async fn keyword_diagnostics(
        &self,
        query: &str,
        filter: &RecallFilter,
    ) -> Result<KeywordQueryDiagnostics> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        filter.validate()?;
        let connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let keyword_query = keyword_query_sql("$1", "$2");
        let row = connection
            .query_one(
                &format!(
                    "SELECT ({keyword_query})::text AS parsed_query, \
                tsvector_to_array(to_tsvector('english', $1)) AS terms"
                ),
                &[&query, &filter.match_mode.as_str()],
            )
            .await
            .context("describe PostgreSQL keyword query")?;
        Ok(KeywordQueryDiagnostics {
            match_mode: filter.match_mode,
            parsed_query: row.try_get("parsed_query")?,
            terms: row.try_get("terms")?,
        })
    }
}

pub(super) fn recall_match(row: Row) -> Result<RecallMatch> {
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
        relationship_count_exact: true,
        relationships_truncated: false,
        domain: row
            .try_get::<_, Option<String>>("domain")?
            .map(|value| serde_json::from_str(&value))
            .transpose()?,
        fragment_index: row.try_get("fragment_index")?,
        document_context: None,
        source_count: None,
        duplicate_sources: Vec::new(),
    })
}
