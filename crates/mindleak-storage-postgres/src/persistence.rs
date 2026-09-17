use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use mindleak_memory::{
    validate_embeddings, validate_text, ChainFilter, ChainInspection, ChainMatch,
    ChainWriteRequest, ChainWriteResult, DomainInspection, DomainQuery, DomainWrite,
    FragmentInspection, InvalidInput, KnowledgeMatch, KnowledgeReviewPage, MemoryStore, MemoryTier,
    PreparedChain, PreparedMemory, RecallFilter, RelationshipCursor, WriteMemoryResult,
    WriteRequest, MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
};
use pgvector::Vector;
use tokio_postgres::{Row, Transaction};
use uuid::Uuid;

use crate::PostgresMemoryStore;

#[async_trait]
impl MemoryStore for PostgresMemoryStore {
    async fn inspect_domain(
        &self,
        query: &DomainQuery,
        filter: &RecallFilter,
        limit: usize,
    ) -> Result<Option<DomainInspection>> {
        self.inspect_domain_in_snapshot(query, filter, limit).await
    }

    async fn hydrate_knowledge(
        &self,
        selected: &[ChainMatch],
        filter: &ChainFilter,
    ) -> Result<Vec<KnowledgeMatch>> {
        self.hydrate_chain_matches(selected, filter).await
    }

    async fn review_knowledge(
        &self,
        target: Option<Uuid>,
        filter: &ChainFilter,
        after: Option<Uuid>,
        limit: usize,
    ) -> Result<KnowledgeReviewPage> {
        self.knowledge_review_page(target, filter, after, limit)
            .await
    }

    async fn lookup_chain_write(
        &self,
        request: &ChainWriteRequest,
    ) -> Result<Option<ChainWriteResult>> {
        self.pool
            .get()
            .await?
            .query_opt(
                WRITE_REPLAY_SQL,
                &[
                    &request.agent_id,
                    &request.request_id,
                    &serde_json::to_string(request)?,
                ],
            )
            .await?
            .map(write_receipt)
            .transpose()
    }

    async fn save_chain(&self, chain: &PreparedChain) -> Result<ChainWriteResult> {
        self.store_chain(chain).await
    }

    async fn inspect_chain(
        &self,
        chain_id: Uuid,
        revision: Option<u32>,
        after_revision: Option<u32>,
        filter: &ChainFilter,
        limit: usize,
    ) -> Result<Option<ChainInspection>> {
        self.read_chain(chain_id, revision, after_revision, filter, limit)
            .await
    }

    async fn inspect_fragment(
        &self,
        fragment_id: Uuid,
        filter: &RecallFilter,
        after: Option<&RelationshipCursor>,
        limit: usize,
    ) -> Result<Option<FragmentInspection>> {
        self.inspect_fragment_in_snapshot(fragment_id, filter, after, limit)
            .await
    }

    async fn lookup_write(&self, request: &WriteRequest) -> Result<Option<WriteMemoryResult>> {
        self.pool
            .get()
            .await
            .context("acquire database connection")?
            .query_opt(
                WRITE_REPLAY_SQL,
                &[
                    &request.agent_id,
                    &request.request_id,
                    &serde_json::to_string(request)?,
                ],
            )
            .await
            .context("look up committed write")?
            .map(write_receipt)
            .transpose()
    }

    async fn save(&self, memory: &PreparedMemory) -> Result<WriteMemoryResult> {
        self.validate_memory(memory)?;
        let mut connection = self
            .pool
            .get()
            .await
            .context("acquire database connection")?;
        let transaction = connection.transaction().await?;
        let result = memory.write_result();
        let request_id = memory.request.as_ref().map(|request| request.request_id);
        let payload = memory
            .request
            .as_ref()
            .map(serde_json::to_string)
            .transpose()?;
        let receipt = memory
            .request
            .as_ref()
            .map(|_| serde_json::to_string(&result))
            .transpose()?;
        let entity = memory
            .request
            .as_ref()
            .and_then(|request| request.domain.as_ref())
            .filter(|domain| matches!(domain, DomainWrite::Entity { .. }))
            .map(serde_json::to_string)
            .transpose()?;
        let conflict = if entity.is_some() {
            "ON CONFLICT DO NOTHING"
        } else {
            "ON CONFLICT (agent_id, request_id) WHERE request_id IS NOT NULL DO NOTHING"
        };
        let inserted = transaction
            .execute(
                &format!("INSERT INTO public.memories (id, agent_id, raw_text, context, request_id, request_payload, write_result, domain_entity) \
                 VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::text::jsonb, $8::text::jsonb) {conflict}"),
                &[&memory.id, &memory.agent_id, &memory.raw_text, &serde_json::to_string(&memory.context)?,
                  &request_id, &payload, &receipt, &entity],
            )
            .await
            .context("store raw memory")?;
        if inserted == 0 {
            let row = transaction
                .query_opt(WRITE_REPLAY_SQL, &[&memory.agent_id, &request_id, &payload])
                .await
                .context("read concurrently committed write")?
                .ok_or_else(|| InvalidInput("entity identity or memory ID already exists; resume with the original agentId, requestId and exact payload".into()))?;
            let result = write_receipt(row)?;
            transaction
                .commit()
                .await
                .context("finish committed write replay")?;
            return Ok(result);
        }
        self.persist_fragments(&transaction, memory).await?;
        self.apply_relationships(&transaction, memory).await?;
        self.store_domain_edge(&transaction, memory).await?;
        transaction
            .commit()
            .await
            .context("commit complete memory")?;
        Ok(result)
    }
}

impl PostgresMemoryStore {
    pub(super) fn validate_memory(&self, memory: &PreparedMemory) -> Result<()> {
        validate_text(&memory.agent_id, "agentId", 256)?;
        validate_text(&memory.raw_text, "text", MAX_MEMORY_BYTES)?;
        memory.context.validate()?;
        if let Some(request) = &memory.request {
            ensure!(
                request.agent_id == memory.agent_id
                    && request.text == memory.raw_text
                    && request.context == memory.context,
                "write request does not match prepared memory"
            );
            if let Some(domain) = &request.domain {
                domain.validate()?;
                ensure!(
                    request.facts.is_empty() && memory.relationships.is_empty(),
                    "domain writes cannot apply fact lifecycle operations"
                );
            }
        }
        ensure!(
            (1..=MAX_FRAGMENTS).contains(&memory.fragments.len()),
            "invalid fragment count"
        );
        for fragment in &memory.fragments {
            validate_text(&fragment.text, "fragment", MAX_FRAGMENT_BYTES)?;
            match (&self.space, &fragment.embedding) {
                (Some(space), Some(vector)) => {
                    validate_embeddings(std::slice::from_ref(vector), 1, space.dimensions)?
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
        Ok(())
    }

    pub(super) async fn persist_fragments(
        &self,
        transaction: &Transaction<'_>,
        memory: &PreparedMemory,
    ) -> Result<()> {
        let statement = transaction
            .prepare(
                     "INSERT INTO public.fragments (id, memory_id, text, embedding, importance, tier, pinned, fragment_index) \
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
            )
            .await?;
        for (index, fragment) in memory.fragments.iter().enumerate() {
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
                        &i32::try_from(index)?,
                    ],
                )
                .await
                .context("store memory fragment")?;
        }
        Ok(())
    }
}

pub(super) const WRITE_REPLAY_SQL: &str =
    "SELECT request_payload = $3::text::jsonb AS matches, write_result::text AS write_result \
    FROM public.memories WHERE agent_id = $1 AND request_id = $2";

pub(super) fn write_receipt<T: serde::de::DeserializeOwned>(row: Row) -> Result<T> {
    if !row.try_get::<_, bool>("matches")? {
        return Err(InvalidInput("requestId was already used for a different write".into()).into());
    }
    serde_json::from_str(&row.try_get::<_, String>("write_result")?)
        .context("decode committed write result")
}
