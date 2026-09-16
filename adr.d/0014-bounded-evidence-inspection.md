# ADR-0014: Bounded Evidence and Source Inspection

- Status: Accepted
- Date: 2026-09-16

## Context

Alphabetical link ordering let eight confirmations hide a contradiction. Exact
window counts joined every eligible relationship before the output limit. Raw
episodes were preserved but unavailable through MCP for auditing extraction.
The optional selector also treated some useful negative evidence as irrelevant.
Cancellation and final recall-state consistency are handled by ADR-0013.

## Decision

Keep the three tools, three application tables, exact raw episodes, and pgvector.
Add a mutually exclusive inspection mode to `recall_memory`: either `query` for
ranked search, or `fragmentId` for a direct read with optional `after` cursor.
Inspection returns the selected fragment, its exact episode `rawText`, context,
current lifecycle, up to eight direct references, `scannedRelationships`, and
`nextCursor`. It applies the existing agent/scope/tier/state filters. A missing
or excluded fragment is an invalid-parameters result, not a model search fallback.
Both modes honor MCP cancellation. Inspection never invokes a model or retriever.

Share the bounded relationship reader between final recall and inspection.
Order types by explicit policy: supersedes, contradicts, archives, restores,
supports, confirms, reinforces, related. Break ties by related UUID, then incoming
before outgoing. Two expression indexes support directional owner/priority/UUID
scans. Each direction reads at most 129 candidates, their merge retains at most
129, and at most 128 plus a lookahead are examined per owner/page. Context and
agent eligibility are checked within that window. Hydrate at most eight complete
related texts per owner; never count all links on ordinary recall.

`relationshipCount` is the eligible count within the examined window. Add
`relationshipCountExact`: true only when the complete adjacency was examined;
otherwise the count is a lower bound, including possibly zero. Set
`relationshipsTruncated` when eligible references were omitted or unexamined
candidates remain. This explicitly revises the exact-total contract in ADR-0010;
clients must check the new flag rather than interpret every count as a total.

Inspection uses keyset cursors containing owner, relationship type, related UUID,
and direction. Cursors are positions, not authorization or evidence. Reject a
cursor belonging to another owner; reapply filters on every page. Empty filtered
pages can have a next cursor, and clients must continue until null when completing
an audit. A page that exhausts the window advances past filtered links; a page
that stops at the result/byte limit resumes after its last included link.

Primary metadata, raw source, and related evidence share one read-only
REPEATABLE READ snapshot per inspection or finalization. Separate pages do not
reserve a snapshot: inserts before a cursor may require restarting inspection.
Do not hold database connections during model calls or between client requests.

Normal search keeps ADR-0012's 32 KiB relationship-array and 512 KiB result-array
budgets. Inspection has a 512 KiB object budget including exact raw text, metadata,
cursor, and complete related facts; it pages instead of truncating a source or
skipping an oversized reference. MCP envelope/duplicate representations are extra.

The optional relevance prompt allows direct answers, explicit unknowns,
prohibitions, missing prerequisites, and false-premise corrections when directly
useful to the query. It still requires exact source quotations and rejects mere
topic overlap. Add a versioned policy regression corpus; never silently rewrite
the earlier corpora or reinterpret their published metrics as useful-evidence
accuracy.

## Consequences

No new tools, tables, workers, recursive graph traversal, or provider dependencies.
The new store read and relationship module are shared by both inspection and
recall. Index creation requires an upgrade window and DDL privileges; guarded
startup does not rebuild existing indexes. Stored rows and model metadata remain
unchanged. Index maintenance adds write/storage cost.

Bounded logical candidates are not a fixed latency or physical-I/O guarantee:
planner choices, dead tuples, database load, and exact-vector scans still matter.
Sparse filters can require more client pages. Negative claims and sources remain
untrusted historical evidence, not instructions or independently verified truth.
Raw text may contain other claims whose current state differs from the inspected
fragment. Corrective ordering does not resolve disputes or promise full evidence
in a normal search result. No new general semantic-quality claim is established.

## Verification

Regressions reproduce confirmation crowding, full counts at high degree, missing
MCP source inspection, and restrictive selector instructions before fixes. Real
MCP inspection verifies raw whitespace, all paginated evidence, filter/cursor
validation, and zero provider requests with enabled but unavailable models.
Database cases cover filtered empty pages, archive/history visibility, escaped
source/evidence budgets, and exact-versus-lower-bound counts. Verify index-backed
bounded plans and migration reopening alongside cancellation and final-snapshot
regressions. Run `make ci` with a disposable `_test` database before merge.
