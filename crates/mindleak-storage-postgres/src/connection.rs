use std::{path::Path, time::Duration};

use anyhow::{ensure, Context, Result};
use deadpool_postgres::{Manager, ManagerConfig, Pool, RecyclingMethod, Runtime};
use mindleak_memory::{validate_embeddings, validate_text};
use rustls::pki_types::{pem::PemObject, CertificateDer};
use tokio_postgres::config::SslMode;
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::{EmbeddingSpace, PostgresMemoryStore};

impl PostgresMemoryStore {
    pub async fn connect(
        database_url: &str,
        embedding_space: Option<(&str, usize)>,
        pool_size: usize,
        ca_file: Option<&Path>,
    ) -> Result<Self> {
        Self::connect_mode(database_url, embedding_space, pool_size, ca_file, false).await
    }

    pub async fn connect_read_only(
        database_url: &str,
        pool_size: usize,
        ca_file: Option<&Path>,
    ) -> Result<Self> {
        Self::connect_mode(database_url, None, pool_size, ca_file, true).await
    }

    async fn connect_mode(
        database_url: &str,
        embedding_space: Option<(&str, usize)>,
        pool_size: usize,
        ca_file: Option<&Path>,
        read_only: bool,
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
        config.options(if read_only {
            "-c statement_timeout=15000 -c lock_timeout=5000 -c default_transaction_read_only=on"
        } else {
            "-c statement_timeout=15000 -c lock_timeout=5000"
        });
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
        if read_only {
            let connection = store.pool.get().await?;
            let ready: bool = connection.query_one(
                "SELECT current_setting('transaction_read_only') = 'on' AND to_regclass('public.memories') IS NOT NULL AND to_regclass('public.fragments') IS NOT NULL AND to_regclass('public.relationships') IS NOT NULL", &[]
            ).await?.get(0);
            ensure!(
                ready,
                "read-only connection requires an existing memory schema"
            );
        } else {
            store.initialize().await?;
        }
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
        transaction
            .batch_execute(include_str!("../migrations/0004-idempotent-writes.sql"))
            .await
            .context("initialize retry-safe writes")?;
        transaction
            .batch_execute(include_str!(
                "../migrations/0005-bounded-relationship-reads.sql"
            ))
            .await
            .context("initialize bounded relationship reads")?;
        transaction
            .batch_execute(include_str!("../migrations/0006-keyword-identifiers.sql"))
            .await
            .context("index qualified identifiers for keyword recall")?;
        transaction
            .batch_execute(include_str!("../migrations/0007-document-search.sql"))
            .await
            .context("index source metadata for keyword recall")?;
        transaction
            .batch_execute(include_str!("../migrations/0008-fragment-order.sql"))
            .await
            .context("record fragment order for document context")?;
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
}
