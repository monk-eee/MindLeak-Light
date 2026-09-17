use std::time::{Duration, Instant};

use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use tokio_postgres::{Client, Error, Transaction};
use uuid::Uuid;

#[derive(Clone, Copy, Debug)]
pub struct MigrationOptions {
    pub batch_size: usize,
    pub statement_timeout: Duration,
    pub ddl_timeout: Duration,
}

impl Default for MigrationOptions {
    fn default() -> Self {
        Self {
            batch_size: 1024,
            statement_timeout: Duration::from_secs(30),
            ddl_timeout: Duration::from_secs(900),
        }
    }
}

impl MigrationOptions {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (1..=8192).contains(&self.batch_size),
            "migration batch size must be in 1..=8192"
        );
        ensure!(
            (1..=300_000).contains(&self.statement_timeout.as_millis()),
            "migration statement timeout must be in 1..=300000 milliseconds"
        );
        ensure!(
            (1..=7_200_000).contains(&self.ddl_timeout.as_millis()),
            "migration DDL timeout must be in 1..=7200000 milliseconds"
        );
        Ok(())
    }
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Checkpoint {
    version: u32,
    memory_id: Option<Uuid>,
    fragment_id: Option<Uuid>,
    completed_rows: i64,
    elapsed_ms: u64,
    #[serde(default)]
    complete: bool,
}

struct Progress {
    migration_id: &'static str,
    phase: &'static str,
    completed_rows: i64,
    elapsed_ms: u64,
    started: Instant,
    timeout_ms: u64,
}

impl Progress {
    fn new(migration_id: &'static str, phase: &'static str, timeout_ms: u64) -> Self {
        Self {
            migration_id,
            phase,
            completed_rows: 0,
            elapsed_ms: 0,
            started: Instant::now(),
            timeout_ms,
        }
    }

    fn elapsed(&self) -> u64 {
        self.elapsed_ms + self.started.elapsed().as_millis() as u64
    }

    fn row_kind(&self) -> &'static str {
        if self.migration_id == "0008" {
            "memories"
        } else {
            "fragments"
        }
    }

    fn error(&self, error: Error) -> anyhow::Error {
        let sqlstate = error.code().map_or("none", |code| code.code());
        tracing::error!(
            migration_id = self.migration_id,
            phase = self.phase,
            completed_rows = self.completed_rows,
            row_kind = self.row_kind(),
            elapsed_ms = self.elapsed(),
            timeout_ms = self.timeout_ms,
            sqlstate,
            "migration failed; committed batches are retained"
        );
        anyhow!(
            "migration_id={} phase={} completed_rows={} elapsed_ms={} timeout_ms={} sqlstate={}",
            self.migration_id,
            self.phase,
            self.completed_rows,
            self.elapsed(),
            self.timeout_ms,
            sqlstate
        )
    }

    fn report(&self) {
        tracing::info!(
            migration_id = self.migration_id,
            phase = self.phase,
            completed_rows = self.completed_rows,
            row_kind = self.row_kind(),
            elapsed_ms = self.elapsed(),
            timeout_ms = self.timeout_ms,
            "migration progress"
        );
    }

    async fn timeout(&self, client: &Client) -> Result<()> {
        client
            .query_one(
                "SELECT set_config('statement_timeout', $1, false)",
                &[&self.timeout_ms.to_string()],
            )
            .await
            .map_err(|error| self.error(error))?;
        Ok(())
    }
}

async fn phase_progress(
    client: &Client,
    migration_id: &'static str,
    phase: &'static str,
    timeout: Duration,
) -> Result<Progress> {
    let mut progress = Progress::new(migration_id, phase, timeout.as_millis() as u64);
    let column = match migration_id {
        "0007" => "search_vector",
        "0008" => "fragment_index",
        _ => return Ok(progress),
    };
    let metadata = client
        .query_opt(
            "SELECT col_description(attrelid, attnum) FROM pg_attribute
         WHERE attrelid = to_regclass('public.fragments') AND attname = $1 AND NOT attisdropped",
            &[&column],
        )
        .await
        .map_err(|error| progress.error(error))?;
    if let Some(metadata) = metadata.and_then(|row| row.get::<_, Option<String>>(0)) {
        let checkpoint = parse_checkpoint(&metadata, migration_id)?;
        progress.completed_rows = checkpoint.completed_rows;
        progress.elapsed_ms = checkpoint.elapsed_ms;
    }
    Ok(progress)
}

fn parse_checkpoint(metadata: &str, migration_id: &str) -> Result<Checkpoint> {
    let checkpoint: Checkpoint = serde_json::from_str(metadata)
        .map_err(|_| anyhow!("invalid checkpoint for migration {migration_id}"))?;
    ensure!(
        checkpoint.version == 1 && checkpoint.completed_rows >= 0,
        "unsupported checkpoint for migration {migration_id}"
    );
    Ok(checkpoint)
}

async fn ddl(
    client: &Client,
    migration_id: &'static str,
    phase: &'static str,
    sql: &str,
    options: MigrationOptions,
) -> Result<()> {
    let progress = phase_progress(client, migration_id, phase, options.ddl_timeout).await?;
    progress.timeout(client).await?;
    progress.report();
    client
        .batch_execute(sql)
        .await
        .map_err(|error| progress.error(error))?;
    Ok(())
}

async fn index(
    client: &Client,
    migration_id: &'static str,
    name: &str,
    definition: &str,
    options: MigrationOptions,
) -> Result<()> {
    let progress = phase_progress(client, migration_id, "index", options.ddl_timeout).await?;
    let existing = client
        .query_opt(
            "SELECT indisvalid AND indisready FROM pg_index WHERE indexrelid = to_regclass($1)",
            &[&format!("public.{name}")],
        )
        .await
        .map_err(|error| progress.error(error))?;
    if let Some(existing) = existing {
        if existing.get::<_, bool>(0) {
            return Ok(());
        }
        ddl(
            client,
            migration_id,
            "index_cleanup",
            &format!("DROP INDEX CONCURRENTLY public.{name}"),
            options,
        )
        .await?;
    }
    progress.report();
    ddl(
        client,
        migration_id,
        "index",
        &format!("CREATE INDEX CONCURRENTLY {name} {definition}"),
        options,
    )
    .await
}

async fn save_checkpoint(
    transaction: &Transaction<'_>,
    column: &str,
    checkpoint: &Checkpoint,
    progress: &Progress,
) -> Result<()> {
    let metadata = serde_json::to_string(checkpoint)?;
    let statement: String = transaction
        .query_one(
            "SELECT format('COMMENT ON COLUMN public.fragments.%I IS %L', $1::text, $2::text)",
            &[&column, &metadata],
        )
        .await
        .map_err(|error| progress.error(error))?
        .get(0);
    transaction
        .batch_execute(&statement)
        .await
        .map_err(|error| progress.error(error))?;
    Ok(())
}

async fn backfill(
    client: &mut Client,
    column: &str,
    metadata: Option<String>,
    progress: &mut Progress,
    sql: &str,
    options: MigrationOptions,
) -> Result<()> {
    let mut checkpoint = match metadata {
        Some(metadata) => parse_checkpoint(&metadata, progress.migration_id)?,
        None => Checkpoint {
            version: 1,
            ..Default::default()
        },
    };
    progress.completed_rows = checkpoint.completed_rows;
    progress.elapsed_ms = checkpoint.elapsed_ms;
    if checkpoint.complete {
        return Ok(());
    }
    index(
        client,
        progress.migration_id,
        "fragments_migration_order_idx",
        "ON public.fragments (memory_id, id)",
        options,
    )
    .await?;
    progress.timeout(client).await?;
    progress.report();
    let batch_size = if column == "fragment_index" {
        options.batch_size.min(128)
    } else {
        options.batch_size
    } as i64;
    loop {
        let transaction = client
            .transaction()
            .await
            .map_err(|error| progress.error(error))?;
        let result = transaction
            .query_one(
                sql,
                &[&checkpoint.memory_id, &checkpoint.fragment_id, &batch_size],
            )
            .await
            .map_err(|error| progress.error(error))?;
        let completed: i64 = result.get(0);
        checkpoint.complete = completed == 0;
        if !checkpoint.complete {
            checkpoint.memory_id = result.get(1);
            checkpoint.fragment_id = result.get(2);
        }
        checkpoint.completed_rows += completed;
        checkpoint.elapsed_ms = progress.elapsed();
        save_checkpoint(&transaction, column, &checkpoint, progress).await?;
        transaction
            .commit()
            .await
            .map_err(|error| progress.error(error))?;
        progress.completed_rows = checkpoint.completed_rows;
        progress.report();
        if checkpoint.complete {
            return Ok(());
        }
    }
}

async fn document_search(client: &mut Client, options: MigrationOptions) -> Result<()> {
    let mut progress = Progress::new(
        "0007",
        "backfill",
        options.statement_timeout.as_millis() as u64,
    );
    let column = client.query_one(
        "SELECT attnotnull, col_description(attrelid, attnum) FROM pg_attribute
         WHERE attrelid = 'public.fragments'::regclass AND attname = 'search_vector' AND NOT attisdropped", &[]
    ).await.map_err(|error| progress.error(error))?;
    if !column.get::<_, bool>(0) {
        backfill(
            client,
            "search_vector",
            column.get(1),
            &mut progress,
            include_str!("../migrations/document-search-batch.sql"),
            options,
        )
        .await?;
        ddl(
            client,
            "0007",
            "constraint",
            "DO $$ BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.fragments'::regclass
                           AND conname = 'fragments_search_vector_not_null') THEN
                ALTER TABLE public.fragments ADD CONSTRAINT fragments_search_vector_not_null
                    CHECK (search_vector IS NOT NULL) NOT VALID;
            END IF;
            END $$;",
            options,
        )
        .await?;
        ddl(
            client,
            "0007",
            "validate",
            "ALTER TABLE public.fragments VALIDATE CONSTRAINT fragments_search_vector_not_null",
            options,
        )
        .await?;
        ddl(
            client,
            "0007",
            "constraint",
            "ALTER TABLE public.fragments ALTER COLUMN search_vector SET NOT NULL",
            options,
        )
        .await?;
    }
    Ok(())
}

async fn fragment_order(client: &mut Client, options: MigrationOptions) -> Result<()> {
    let mut progress = Progress::new(
        "0008",
        "backfill",
        options.statement_timeout.as_millis() as u64,
    );
    let metadata: Option<String> = client.query_one(
        "SELECT col_description(attrelid, attnum) FROM pg_attribute
         WHERE attrelid = 'public.fragments'::regclass AND attname = 'fragment_index' AND NOT attisdropped", &[]
    ).await.map_err(|error| progress.error(error))?.get(0);
    if metadata.is_some() {
        backfill(
            client,
            "fragment_index",
            metadata,
            &mut progress,
            include_str!("../migrations/fragment-order-batch.sql"),
            options,
        )
        .await?;
    }
    Ok(())
}

pub(super) async fn initialize(
    client: &mut Client,
    dimensions: usize,
    options: MigrationOptions,
) -> Result<()> {
    let lock = Progress::new(
        "schema",
        "lock",
        options.statement_timeout.as_millis() as u64,
    );
    lock.timeout(client).await?;
    client
        .batch_execute(
            "SET application_name = 'mindleak-light-migration';
         SET lock_timeout = '5s';
         SET work_mem = '16MB';
         SET maintenance_work_mem = '64MB'",
        )
        .await
        .map_err(|error| lock.error(error))?;
    loop {
        let acquired: bool = client
            .query_one("SELECT pg_try_advisory_lock(5570197736903360513)", &[])
            .await
            .map_err(|error| lock.error(error))?
            .get(0);
        if acquired {
            break;
        }
        ensure!(lock.started.elapsed() < options.statement_timeout,
            "migration_id=schema phase=lock completed_rows=0 elapsed_ms={} timeout_ms={} sqlstate=none: another migration is running",
            lock.elapsed(), lock.timeout_ms);
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
    let schema = format!(include_str!("../schema.sql"), dimensions = dimensions);
    for (migration_id, sql) in [
        ("0001", schema.as_str()),
        (
            "0002",
            include_str!("../migrations/0002-optional-embeddings.sql"),
        ),
        (
            "0003",
            include_str!("../migrations/0003-fact-lifecycle.sql"),
        ),
        (
            "0004",
            include_str!("../migrations/0004-idempotent-writes.sql"),
        ),
        (
            "0005",
            include_str!("../migrations/0005-bounded-relationship-reads.sql"),
        ),
        (
            "0006",
            include_str!("../migrations/0006-keyword-identifiers.sql"),
        ),
        (
            "0007",
            include_str!("../migrations/0007-document-search.sql"),
        ),
        (
            "0008",
            include_str!("../migrations/0008-fragment-order.sql"),
        ),
    ] {
        ddl(
            client,
            migration_id,
            "prepare",
            &format!("BEGIN; {sql} COMMIT;"),
            options,
        )
        .await?;
    }
    document_search(client, options).await?;
    fragment_order(client, options).await?;
    index(
        client,
        "0007",
        "fragments_document_search_idx",
        "ON public.fragments USING GIN (search_vector)",
        options,
    )
    .await?;
    index(
        client,
        "0008",
        "fragments_document_order_idx",
        "ON public.fragments (memory_id, fragment_index, id)",
        options,
    )
    .await?;
    for name in [
        "fragments_identifier_search_idx",
        "fragments_search_idx",
        "fragments_migration_order_idx",
    ] {
        ddl(
            client,
            "schema",
            "cleanup",
            &format!("DROP INDEX CONCURRENTLY IF EXISTS public.{name}"),
            options,
        )
        .await?;
    }
    let progress = phase_progress(client, "0008", "verify", options.statement_timeout).await?;
    progress.timeout(client).await?;
    let verified: bool = client
        .query_one(include_str!("../migrations/verify.sql"), &[])
        .await
        .map_err(|error| progress.error(error))?
        .get(0);
    ensure!(verified, "migration_id=0008 phase=verify completed_rows={} elapsed_ms={} timeout_ms={} sqlstate=none: schema verification failed",
        progress.completed_rows, progress.elapsed(), progress.timeout_ms);
    progress.report();
    Ok(())
}
