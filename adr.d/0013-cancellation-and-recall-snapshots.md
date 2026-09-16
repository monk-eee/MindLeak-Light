# ADR-0013: Cancellation and Final Recall Snapshots

- Status: Accepted
- Date: 2026-09-16

## Context

The SDK cancels a request token without automatically aborting the handler future.
A client could cancel while model preparation was blocked, yet the handler would
later continue into storage. Separately, candidate search and relationship reads
could observe different committed states: a primary returned as active alongside
a newer archive link. Both defects were reproduced before the v0.3.0 tag.

## Decision

All three MCP tool handlers accept the official SDK request context and race
pending service work against its cancellation token. Prefer a ready cancellation
signal and drop the operation future when it wins. Keep protocol handling in
the SDK, with no custom cancellation framing or background worker.

Before final recall ranking, refresh the bounded candidate IDs with original
scores in a read-only PostgreSQL repeatable-read transaction. Reapply agent,
scope, tier, and active/history filters using current primary metadata, compute
lifecycle priority once, and load bounded direct relationships within the same
transaction. Commit that short snapshot before returning or running any optional
relevance inference. Query embedding remains outside transactions.

## Consequences

- Cancellation observed while preparation is pending stops that handler from
  continuing into storage. A commit already sent to PostgreSQL can still succeed;
  clients must reconcile using the original request ID and payload. A local
  request drop does not guarantee that the remote provider stops computing.
- Returned primary metadata and links are mutually consistent at the final
  snapshot. They can change after it, and earlier search scores/candidate pools
  do not become one transaction-wide search snapshot.
- Final filtering may return fewer results than requested. It does not refill
  discarded candidates or alter stored vectors and original retrieval scores.
- Recall adds one bounded primary refresh query and holds a read-only snapshot
  across database reads. No database transaction is held during model inference.
- Existing relationship ordering, total-count cost, raw-source retrieval, and
  experimental relevance policy gaps are not solved by this decision.

## Verification

An official-SDK cancellation regression blocks write preparation, decomposition,
and recall, sends a cancellation notification, and requires the pending future
to be dropped before releasing it. The write cannot reach storage. It failed on
the old handler and passes with request-context cancellation.

A real database regression captures a candidate, commits an archive and tier
change, and then finalizes recall. It failed because the old result remained
active. It now verifies normal exclusion, refreshed historical state/tier/pin,
scope and provenance filters, unchanged scores, and consistent archive context.
The complete storage and MCP suites cover the combined cache, retry, lifecycle,
ranking, and response-budget contracts.
