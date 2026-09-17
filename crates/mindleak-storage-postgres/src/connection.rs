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
        Self::connect_with_migration_options(
            database_url,
            embedding_space,
            pool_size,
            ca_file,
            crate::MigrationOptions::default(),
        )
        .await
    }

    pub async fn connect_read_only(
        database_url: &str,
        pool_size: usize,
        ca_file: Option<&Path>,
    ) -> Result<Self> {
        Self::connect_mode(database_url, None, pool_size, ca_file, None).await
    }

    pub async fn connect_with_migration_options(
        database_url: &str,
        embedding_space: Option<(&str, usize)>,
        pool_size: usize,
        ca_file: Option<&Path>,
        migration_options: crate::MigrationOptions,
    ) -> Result<Self> {
        Self::connect_mode(
            database_url,
            embedding_space,
            pool_size,
            ca_file,
            Some(migration_options),
        )
        .await
    }

    async fn connect_mode(
        database_url: &str,
        embedding_space: Option<(&str, usize)>,
        pool_size: usize,
        ca_file: Option<&Path>,
        migration_options: Option<crate::MigrationOptions>,
    ) -> Result<Self> {
        if let Some(options) = &migration_options {
            options.validate()?;
        }
        let read_only = migration_options.is_none();
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
        if let Some(options) = migration_options {
            store.initialize(options).await?;
        } else {
            let connection = store.pool.get().await?;
            let ready: bool = connection.query_one(
                "SELECT current_setting('transaction_read_only') = 'on' AND to_regclass('public.memories') IS NOT NULL AND to_regclass('public.fragments') IS NOT NULL AND to_regclass('public.relationships') IS NOT NULL", &[]
            ).await?.get(0);
            ensure!(
                ready,
                "read-only connection requires an existing memory schema"
            );
        }
        Ok(store)
    }

    async fn initialize(&self, migration_options: crate::MigrationOptions) -> Result<()> {
        let mut connection = deadpool_postgres::Object::take(
            self.pool
                .get()
                .await
                .context("acquire migration connection")?,
        );
        crate::migrations::initialize(
            &mut connection,
            self.space.as_ref().map_or(768, |space| space.dimensions),
            migration_options,
        )
        .await?;
        let transaction = connection.transaction().await?;
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

#[cfg(all(test, feature = "postgres-tests"))]
mod tests {
    use super::*;

    #[tokio::test]
    async fn migration_settings_never_enter_the_application_pool() {
        let url = std::env::var("MINDLEAK_TEST_DATABASE_URL").unwrap();
        let config: tokio_postgres::Config = url.parse().unwrap();
        assert!(config.get_dbname().unwrap().ends_with("_test"));
        let store = PostgresMemoryStore::connect(&url, None, 1, None)
            .await
            .unwrap();
        let settings = store
            .pool
            .get()
            .await
            .unwrap()
            .query_one(
                "SELECT current_setting('statement_timeout'), current_setting('lock_timeout'),
             current_setting('application_name'), current_setting('synchronous_commit'),
             current_setting('fsync'), current_setting('full_page_writes')",
                &[],
            )
            .await
            .unwrap();
        for (position, expected) in ["15s", "5s", "mindleak-light", "on", "on", "on"]
            .iter()
            .enumerate()
        {
            assert_eq!(settings.get::<_, String>(position), *expected);
        }
    }
}
