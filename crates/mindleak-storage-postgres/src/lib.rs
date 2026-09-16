use std::{path::Path, sync::Arc, time::Duration};

use anyhow::{ensure, Context, Result};
use async_trait::async_trait;
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use mindleak_memory::{
    validate_embeddings, validate_text, MemoryRetriever, MemoryStore, PreparedMemory, RecallMatch,
    TextEmbedder, MAX_FRAGMENTS, MAX_FRAGMENT_BYTES, MAX_MEMORY_BYTES, MAX_RECALL_LIMIT,
};
use pgvector::Vector;
use rustls::pki_types::{pem::PemObject, CertificateDer};
use serde::{Deserialize, Serialize};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
struct EmbeddingSpace {
    model: String,
    dimensions: usize,
}

#[derive(Clone)]
pub struct PostgresMemoryStore {
    pool: Pool,
    space: EmbeddingSpace,
}

impl PostgresMemoryStore {
    pub async fn connect(
        database_url: &str,
        embedding_model: &str,
        dimensions: usize,
        pool_size: usize,
        ca_file: Option<&Path>,
    ) -> Result<Self> {
        validate_embeddings(&[], 0, dimensions)?;
        validate_text(embedding_model, "embedding model", 256)?;
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
            space: EmbeddingSpace {
                model: embedding_model.into(),
                dimensions,
            },
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
                dimensions = self.space.dimensions,
            ))
            .await
            .context("initialize the three-table memory schema")?;
        let actual_type: String = transaction
            .query_one(
                "SELECT format_type(atttypid, atttypmod) FROM pg_attribute \
             WHERE attrelid = 'public.fragments'::regclass AND attname = 'embedding'",
                &[],
            )
            .await?
            .get(0);
        ensure!(
            actual_type == format!("vector({})", self.space.dimensions),
            "stored embedding dimensions differ from configuration; use the original model or a new database"
        );
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
                    stored == self.space,
                    "stored embedding model differs from configuration; use the original model or a new database"
                );
            }
            None => {
                let populated: bool = transaction
                    .query_one("SELECT EXISTS(SELECT 1 FROM public.fragments)", &[])
                    .await?
                    .get(0);
                ensure!(
                    !populated,
                    "cannot identify the model of existing fragments"
                );
                let metadata = serde_json::to_string(&self.space)?;
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
        agent_id: Option<&str>,
        limit: usize,
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
                "SELECT memories.id AS memory_id, fragments.id AS fragment_id, memories.agent_id, \
                    fragments.text, 1.0 - (fragments.embedding <=> $1) AS score \
             FROM public.fragments AS fragments \
             JOIN public.memories AS memories ON memories.id = fragments.memory_id \
             WHERE ($2::text IS NULL OR memories.agent_id = $2) \
             ORDER BY fragments.embedding <=> $1, fragments.id LIMIT $3",
                &[&vector, &agent_id, &limit],
            )
            .await
            .context("recall fragments with pgvector")?;
        rows.into_iter()
            .map(|row| {
                Ok(RecallMatch {
                    memory_id: row.try_get("memory_id")?,
                    fragment_id: row.try_get("fragment_id")?,
                    agent_id: row.try_get("agent_id")?,
                    text: row.try_get("text")?,
                    score: row.try_get::<_, f64>("score")?.clamp(-1.0, 1.0),
                })
            })
            .collect()
    }
}

#[async_trait]
impl MemoryStore for PostgresMemoryStore {
    async fn save(&self, memory: &PreparedMemory) -> Result<()> {
        validate_text(&memory.agent_id, "agentId", 256)?;
        validate_text(&memory.raw_text, "text", MAX_MEMORY_BYTES)?;
        ensure!(
            (1..=MAX_FRAGMENTS).contains(&memory.fragments.len()),
            "invalid fragment count"
        );
        for fragment in &memory.fragments {
            validate_text(&fragment.text, "fragment", MAX_FRAGMENT_BYTES)?;
            validate_embeddings(
                std::slice::from_ref(&fragment.embedding),
                1,
                self.space.dimensions,
            )?;
            ensure!(
                (0.0..=1.0).contains(&fragment.importance),
                "invalid fragment importance"
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
                "INSERT INTO public.memories (id, agent_id, raw_text) VALUES ($1, $2, $3)",
                &[&memory.id, &memory.agent_id, &memory.raw_text],
            )
            .await
            .context("store raw memory")?;
        let statement = transaction
            .prepare(
                "INSERT INTO public.fragments (id, memory_id, text, embedding, importance) \
             VALUES ($1, $2, $3, $4, $5)",
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
                        &Vector::from(fragment.embedding.clone()),
                        &fragment.importance,
                    ],
                )
                .await
                .context("store memory fragment")?;
        }
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
}

impl VectorMemoryRetriever {
    pub fn new(store: PostgresMemoryStore, embedder: Arc<dyn TextEmbedder>) -> Self {
        Self { store, embedder }
    }
}

#[async_trait]
impl MemoryRetriever for VectorMemoryRetriever {
    async fn recall(
        &self,
        query: &str,
        agent_id: Option<&str>,
        limit: usize,
    ) -> Result<Vec<RecallMatch>> {
        validate_text(query, "query", MAX_MEMORY_BYTES)?;
        ensure!(
            (1..=MAX_RECALL_LIMIT).contains(&limit),
            "invalid recall limit"
        );
        let embeddings = self.embedder.embed_batch(&[query.to_owned()]).await?;
        validate_embeddings(&embeddings, 1, self.store.space.dimensions)?;
        let vector = embeddings
            .into_iter()
            .next()
            .context("missing query embedding")?;
        self.store.search(vector, agent_id, limit).await
    }
}
