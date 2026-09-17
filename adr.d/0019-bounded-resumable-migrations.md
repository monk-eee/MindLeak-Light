# ADR-0019: Bounded Resumable Migrations

- Status: Accepted
- Date: 2026-09-17

## Context

The reported v0.2-to-v0.4 upgrade has 519,422 memories and 5,720,005 fragments.
The monolithic startup transaction uses a 15-second application timeout; an
isolated 90-minute statement also failed and lost the whole transaction.
Document metadata and normalized source text were recalculated per fragment.
The three-table invariant, exact source data, search semantics, and fail-closed
readiness must remain intact.

## Decision

Keep migration ownership inside the PostgreSQL crate. Detach one connection
from the application pool and serialize maintenance with the existing session
advisory-lock key. Use bounded nonblocking lock attempts: a blocking SQL waiter
can hold a snapshot that deadlocks a concurrent index builder.

Commit prerequisite DDL phases independently. Materialize shared source work
once per batch and use indexed keyset updates. Atomically commit each batch and
its versioned cursor in the derived column's PostgreSQL comment. This preserves
three application tables and normal dump/restore behavior; the embedding-space
table comment remains untouched. Track examined memories separately from nullable
order results, so ambiguous order is not repeatedly processed.

Keep the original tokenizer, C/D weights, concatenation/position behavior, and
literal order algorithm. A 65-fragment bounded probe preserves the original
over-64 unknown-order rule. Do not rewrite original fields, re-embed, or disable
durability. Use separately bounded DDL statements and recover interrupted invalid
concurrent indexes. Mark no store ready until backfills, constraints, indexes,
and schema verification have succeeded.
Keep source lookups indexed and constrain updates to statement-local tuple
addresses from the bounded selection. Checkpoints retain only logical UUIDs;
physical addresses never survive a statement or resume boundary.

Expose maintenance-only batch/timeout settings and metadata-only progress/errors.
Add `--migrate-only` and optional private read-only canary manifests. Execute
canaries through the configured candidate runtime and official Rust MCP SDK
before external transport readiness; this is not a fourth MCP tool. The normal
15-second query and five-second lock limits remain on application connections.

## Consequences

Operators must stop all previous versions and other writers. This is not a
rolling-upgrade or general migration framework. Backfill restart preserves
committed work; one interrupted index or validation statement must restart that
statement. Column comments are durable operational state and must accompany
partial restores. A complete old v0.4 schema needs no data backfill.

Additional indexes, updated tuple versions, and WAL need rehearsal-specific disk
headroom. PostgreSQL memory limits bound individual operations, not total RSS.
Built-in schema verification cannot replace deployment-specific retrieval
canaries or prove equivalence for unknown private data. SIGKILL cannot log a
final failure, but its last committed checkpoint survives.

## Verification

The original late document/order failure regressions lost every completed row;
the batched implementation retains progress and resumes without rewriting them.
Exact small-fixture comparisons use the original SQL for full tsvector and
fragment-order equality and preserve IDs, text, vectors, lifecycle, and links.
Real timeout, cancellation, backend/future/process termination, invalid-index
recovery, and active-lock restarts are tested. Actual candidate canary failures
prevent readiness and do not log private fixture values.

Run `make ci` and the explicit capacity rehearsal in
[the operator guide](../docs/MIGRATIONS.md). Report resource/time measurements
and unverified deployment requirements without treating a synthetic corpus as
the incident database.
