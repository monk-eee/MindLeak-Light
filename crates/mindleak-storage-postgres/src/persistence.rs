use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use mindleak_memory::{
    validate_embeddings, validate_text, MemoryStore, MemoryTier, PreparedMemory, MAX_FRAGMENTS,
    MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES,
};
use pgvector::Vector;

use crate::PostgresMemoryStore;

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
