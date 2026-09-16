use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use mindleak_memory::{
    validate_embeddings, validate_text, InvalidInput, MemoryStore, MemoryTier, PreparedMemory,
    WriteMemoryResult, WriteRequest, MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
};
use pgvector::Vector;
use tokio_postgres::Row;

use crate::PostgresMemoryStore;

#[async_trait]
impl MemoryStore for PostgresMemoryStore {
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
        }
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
        let inserted = transaction
            .execute(
                "INSERT INTO public.memories (id, agent_id, raw_text, context, request_id, request_payload, write_result) \
                 VALUES ($1, $2, $3, $4::text::jsonb, $5, $6::text::jsonb, $7::text::jsonb) \
                 ON CONFLICT (agent_id, request_id) WHERE request_id IS NOT NULL DO NOTHING",
                &[&memory.id, &memory.agent_id, &memory.raw_text, &serde_json::to_string(&memory.context)?,
                  &request_id, &payload, &receipt],
            )
            .await
            .context("store raw memory")?;
        if inserted == 0 {
            let row = transaction
                .query_one(WRITE_REPLAY_SQL, &[&memory.agent_id, &request_id, &payload])
                .await
                .context("read concurrently committed write")?;
            let result = write_receipt(row)?;
            transaction
                .commit()
                .await
                .context("finish committed write replay")?;
            return Ok(result);
        }
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
        Ok(result)
    }
}

const WRITE_REPLAY_SQL: &str =
    "SELECT request_payload = $3::text::jsonb AS matches, write_result::text AS write_result \
    FROM public.memories WHERE agent_id = $1 AND request_id = $2";

fn write_receipt(row: Row) -> Result<WriteMemoryResult> {
    if !row.try_get::<_, bool>("matches")? {
        return Err(InvalidInput("requestId was already used for a different write".into()).into());
    }
    serde_json::from_str(&row.try_get::<_, String>("write_result")?)
        .context("decode committed write result")
}
