# ADR-0011: Idempotent Memory Writes

- Status: Accepted
- Date: 2026-09-16

## Context

A committed write can lose its response. Repeating it previously generated a new
memory and fragment set, including new lifecycle actions. Atomicity alone does
not prevent duplicates. Retry protection must survive process restart without
adding an MCP tool, a fourth application table, a worker, or a database lock held
while an optional model is running.

## Decision

Add an optional client-generated UUID `requestId` to `write_memory`, scoped by
the caller-supplied `agentId`. The caller retains the original key and arguments
before sending. Existing unkeyed requests still create a new memory per call.
The tool-wide idempotency hint remains false because protection is opt-in.

Validate intrinsic request limits before looking up a committed result. Store a
canonical typed request containing request ID, agent ID, exact raw text, context,
and ordered fact/link directives. Defaults normalize omitted optional fields;
JSON object key order is irrelevant. Different canonical payloads under one
agent/request pair fail with `InvalidInput`, without exposing either payload.

Store the request and original write result in nullable JSONB columns on the
existing `memories` row. A nullable UUID column has a partial unique index on
`(agent_id, request_id)`; a constraint requires all three fields together or none.
The raw memory, receipt, fragments, validated vectors, relationships, and lifecycle
effects commit atomically. Existing rows stay unkeyed.
Catalog guards skip column and index DDL when the idempotency schema already
exists, avoiding unnecessary relation locks on migration replay.

`MemoryStore` owns committed-result lookup and returns a `WriteMemoryResult`
from `save`. `MemoryService` checks for a matching receipt before decomposition
or embedding. The insert uses the unique key to arbitrate concurrent writers;
an insert that loses reads and verifies the winning committed receipt without
adding fragments or reapplying any links. Model work remains outside transactions.

Replay the original ordered write result, including original fragment tiers,
instead of reconstructing it from mutable lifecycle state. Reusing an archive
request after a later restoration must not archive the target again. Receipts
are retained for the lifetime of their memory row.

## Consequences

- Matching retries are safe across server restarts and provider outages after
  a successful commit. Provider failures before storage and database rollback
  leave no key behind; database errors never become false success.
- Concurrent first attempts can duplicate model work. This is one committed
  memory per retained key, not a promise of exactly-once provider execution.
- Keys are not content deduplication, authentication, or tenant isolation. A new
  key or another agent ID is a distinct write. Deleting a memory deletes its key.
- Keyed rows use additional storage for the canonical payload and receipt,
  protected as memory data. Neither is logged. Current lifecycle state still
  comes from recall, not a replayed write receipt.
- Future input-schema or canonical-serialization changes require an explicit
  migration/compatibility decision. Clients must not change payloads in place
  under a previously used key. No automatic client retry policy is introduced.
- This is an unreleased source feature; v0.2.0 packages do not accept the field.

## Verification

The initial real MCP regression failed before implementation and passes with
matching original results after process restart while the configured provider
returns HTTP 503 and receives no requests. The same protocol test rejects changed
text, context, directives, and invalid UUIDs.

PostgreSQL tests exercise eight concurrent writers, one committed episode and
fragment set, agent-scoped keys, unchanged unkeyed writes, conflicting payloads,
rollback after a fragment failure followed by a successful retry, immutable
receipts after tier changes, and archive retries after restoration. Service tests
reject invalid input before lookup and fail closed on lookup/provider failures.
The full database suite also checks three-table schema initialization and upgrades
that preserve legacy vectors and their model binding.

A migration-only regression holds an active read transaction and reruns the
idempotency migration with a short lock timeout. It failed before catalog guards
were added and passes afterward; broader startup locking belongs to the separate
storage workstream.
