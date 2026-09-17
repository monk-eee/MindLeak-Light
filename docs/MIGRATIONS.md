# Bounded Database Upgrades

These changes are **unreleased**. Published v0.4.0 and v0.5.0 still run their
document-search and fragment-order migrations in one startup transaction under
a 15-second statement timeout. Updating this document does not fix an installed binary.

The candidate keeps the three application tables and exact stored source data.
It commits each schema phase separately, then backfills using keyset batches.
Each batch commits its data and checkpoint together. Failure loses only the
current transaction; restart resumes from the last committed checkpoint.

## Operator Procedure

1. Back up and rehearse restoration into a separate database or volume. Retain
   the original binary/image and off-machine backup. Do not downgrade a partially
   migrated database in place.
2. Stop **every old MCP process and other writer** using the database. This is an
   offline application upgrade, not mixed-version rolling deployment. New
   candidates serialize migrations, but cannot prevent an old binary or SQL
   administrator from accessing the database.
3. Keep the original model identity and dimensions. With the candidate binary
   and normal database settings, run:

   ```sh
   mindleak-light --migrate-only --migration-canaries /private/upgrade-canaries.json
   ```

4. Require successful exit and the `retrieval canaries passed before readiness`
   event. Start the **same candidate** with `MINDLEAK_MIGRATION_CANARIES` set to
   the same manifest. It reruns the read-only canaries before either opening HTTP
   or starting the stdio MCP handshake. No health success means no readiness.
5. Retain metadata-only verification evidence and backup retention. A failed
   canary never triggers a fallback mode, automatic re-embedding, or a database
   restore. Diagnose the reported phase and rerun after correcting the cause.

Both Compose templates forward the settings below. A canary path is a path
**inside the container**: mount the private manifest read-only explicitly. Compose
does not mount an arbitrary host path for you. Health-check timeouts do not kill
a migration; orchestration startup deadlines must cover the rehearsal budget.
Use maintenance execution when the client's MCP-handshake budget is shorter.

## Bounds And Progress

| Setting | Default | Allowed |
|---|---|---|
| `MINDLEAK_MIGRATION_BATCH_SIZE` | 1024 fragments | 1..8192 |
| `MINDLEAK_MIGRATION_STATEMENT_TIMEOUT_SECS` | 30 seconds | 1..300 |
| `MINDLEAK_MIGRATION_DDL_TIMEOUT_SECS` | 900 seconds | 1..7200 |
| `MINDLEAK_MIGRATION_CANARIES` | unset | private JSON path |

Ordering batches visit at most `min(batch size, 128)` memories and inspect at
most 65 fragments per memory. The 65th makes legacy orders over 64 unknown,
matching the original algorithm without scanning an unbounded legacy episode.
Document batches visit at most the configured fragment count. Source/summary
vectors are materialized once per distinct source in that batch. Ordering
normalizes raw text once per selected memory. An episode spanning document
batches can have its metadata calculated once in each batch.
Source reads use bounded primary-key lookups; updates use only the tuple
addresses selected in that SQL statement to avoid whole-table join scans.
Physical tuple addresses never enter persistent checkpoints.

The detached migration connection uses `work_mem=16MB`,
`maintenance_work_mem=64MB`, and `lock_timeout=5s`. PostgreSQL can use multiple
work-memory allocations in a plan and can spill to disk; these settings are not
a total server-RSS cap. Final index creation uses `CREATE INDEX CONCURRENTLY`.
An interrupted invalid index is dropped and rebuilt on restart. PostgreSQL
cannot checkpoint part of one index build or constraint-validation scan; their
bounded statements may repeat, but completed data batches do not.

Application pool connections still use `statement_timeout=15s` and
`lock_timeout=5s`. No `fsync`, `full_page_writes`, `synchronous_commit`, WAL,
constraint, or trigger protection is disabled to accelerate migration.

Progress and errors on stderr include migration ID, phase, completed rows, row
kind, elapsed milliseconds, statement timeout, and SQLSTATE when PostgreSQL
supplies one. `0007` counts fragments; `0008` counts examined memories, including
unknown orders. Counts describe committed work, never merely attempted rows.
Database error messages, details, queries, row payloads, credentials, and canary
expectations are not included. SIGKILL cannot emit a final error; the preceding
committed progress remains available.

Checkpoints live in comments on `fragments.search_vector` and
`fragments.fragment_index`; normal PostgreSQL dumps/restores preserve them. They
contain only version, cursor UUIDs, counters, elapsed time, and completion state.
Do not remove/edit these comments or copy an incomplete schema without them.
The table comment binding the embedding model is untouched. Unknown order is
not a missing checkpoint: examined ambiguous rows intentionally remain NULL.

For read-only inspection with an authenticated PostgreSQL client:

```sql
SELECT attname, col_description(attrelid, attnum) AS checkpoint
FROM pg_attribute
WHERE attrelid = 'public.fragments'::regclass
  AND attname IN ('search_vector', 'fragment_index') AND NOT attisdropped;

SELECT pid, command, phase, blocks_done, blocks_total, tuples_done, tuples_total
FROM pg_stat_progress_create_index
WHERE datname = current_database();
```

Resume by rerunning the same command. Decrease batch size after a batch timeout;
raise a maintenance timeout only within a justified rehearsal budget. A lock
failure requires investigating other connections, not disabling lock protection.
`elapsed_ms` retains committed backfill time; process downtime and abandoned
attempts are not added to that persistent counter.

## Retrieval Canaries

The optional manifest runs the actual configured runtime through the official
Rust MCP SDK's in-process transport. Only `recall_memory` is callable; no test
facts are inserted and no lifecycle feedback is manufactured. Configuration,
models, filters, context expansion, source inspection, and response serialization
are the same as external requests. Without a manifest, startup still validates
the schema, indexes, triggers, constraints, and a built-in keyword canary, but
**does not claim deployment-specific retrieval acceptance**.

Version 1 permits 1..128 cases in a file of at most 64 KiB. Each case supplies
normal recall arguments and 1..128 exact JSON-pointer assertions on the MCP
`structuredContent`. The complete suite has a 60-second deadline. A mismatch,
invalid argument, provider failure, unreadable/invalid file, or timeout prevents
readiness. Indexes/DDL remain complete if a runtime canary fails. No canary body
or expected value is logged. Protect this file like the source data it describes.

```json
{
  "version": 1,
  "cases": [
    {
      "arguments": {
        "query": "TargetInvocationException AuthFlow",
        "scope": "repo:example/project",
        "matchMode": "all",
        "limit": 1,
        "contextLimit": 1
      },
      "expected": {
        "/results/0/fragmentId": "11111111-1111-1111-1111-111111111111",
        "/results/0/documentContext/orderKnown": true
      }
    },
    {
      "arguments": {"query": "known-absent-marker", "scope": "repo:example/project"},
      "expected": {"/results": []}
    }
  ]
}
```

Replace example IDs and queries with the deployment's reviewed canaries. Include
qualified and short identifiers, metadata-plus-text terms, phrases, exclusions,
wrong scope, empty results, legacy unknown order, source inspection, lifecycle
visibility, and the enabled semantic/hybrid mode. Avoid assertions on activation
values that legitimately decay between snapshots.

## Capacity Rehearsal

An opt-in integration test creates its own UUID-named `*_test` database, seeds
v0.2-era columns with 519,422 memories, 5,720,005 fragments, and 519,422 links,
when explicitly configured, then runs the actual candidate and twelve retrieval
canaries before startup. The default fixture is only 2,048 memories.
It checks original-field fingerprints, every order, non-null search vectors,
durability settings, and unchanged row versions on a repeated startup. Half the
fragments carry two-dimensional synthetic vectors; this is **not** a test of
the incident's private text, vector dimensions, or production retrieval quality.

```sh
MINDLEAK_MIGRATION_SCALE_MEMORIES=519422 \
cargo test -p mindleak-mcp --all-features --locked --test mcp \
  large_corpus_v02_upgrade_preserves_data_and_passes_runtime_canaries \
  -- --exact --ignored --nocapture
```

Set `MINDLEAK_TEST_DATABASE_URL` to a disposable database whose role has
`CREATEDB`. Run the full fixture only on dedicated storage with verified free
space **inside the database filesystem**, not just the client filesystem.
The test reports its unique owned database name and removes it after assertions,
timeouts, or Ctrl-C. SIGKILL/host termination can bypass cleanup: stop its owned
child and drop only that printed database. Never prune shared volumes or images.
For a quick fixture check, omit the scale variable. The test budgets 30 minutes for migration
plus canaries and 15 seconds for restart plus canaries. These are acceptance
bounds, not measured production promises. Allow at least 40 GiB free test-database
storage and retain WAL/disk headroom for the actual restored corpus.

The initial 2,048-memory rehearsal on PostgreSQL 16.15/aarch64 in a 6-vCPU,
8-GiB local VM migrated 22,528 fragments in 7.675 seconds, including twelve
canaries; restart plus canaries took 337 ms. Database size grew from 19,536,919
to 64,060,439 bytes. Full-count verification is recorded separately when run;
do not extrapolate the small result as evidence that the incident corpus passed.

After the indexed-update fix, the same-size final small fixture passed in
10.577 seconds including twelve canaries; restart plus canaries took 320 ms,
and final database size was 58,244,119 bytes. Both disposable databases were
removed by the test and its runner. Workstation contention was not controlled;
these results do not demonstrate an end-to-end speedup.

Two full-count attempts on this workstation were stopped before completion for
disk/resource safety; neither is a capacity pass. Their test databases,
temporary PostgreSQL container, and 5.4 GiB scratch data were removed. The
[capacity acceptance gap](../gaps.d/large-corpus-migration-capacity.md) remains
open until an adequately provisioned controlled-host rehearsal completes.

Run `make ci` for routine gates. Cancellation, real statement timeout, backend
termination, process termination, invalid-index recovery, exact original-vector
and order equivalence, unknown ordering, and pre-readiness canaries have focused
regressions in the existing PostgreSQL and MCP test suites.
