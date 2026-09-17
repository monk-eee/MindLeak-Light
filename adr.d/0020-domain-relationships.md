# ADR-0020: Indexed Domain Relationships and Verified Imports

- Status: Accepted
- Date: 2026-09-17

## Context

Lifecycle links join fact fragments and some explicitly change evidence, retention
or visibility. A dependency import must not create confirmation merely because its
predicate is named confirms. Source edges can be directed, parallel or self-referential
and must retain distinct identities and provenance across interrupted imports. The
existing PostgreSQL/pgvector architecture can support this without adding application
tables or recursive graph reasoning. Exact traversal needs different indexes from
semantic or keyword candidate discovery.

## Decision

Add an explicit `domain` write/query mode to the existing MCP tools. Anchor each
identified entity and source edge in one immutable memory episode, using existing
decomposition, optional embedding and atomic keyed-write storage. Keep domain edges in
`relationships` with entity memory endpoints, an external namespace/edge ID, predicate,
and attributed provenance. Database constraints make domain rows and lifecycle rows
mutually exclusive. Domain writes reject lifecycle directives and require a retry key.

Use separate unique namespace/ID indexes for entities and edges. An import's stable
keys replay original source/fragment receipts; changed identities or payloads fail.
Preserve parallel edges and self edges. Confidence is reported, not verified truth,
and never changes pgvector scores or fact lifecycle. Require equal endpoint/source
scope, while retaining the single authenticated trust domain.
Scope remains optional: omission means general search across scoped and unscoped
records, not an unscoped-only restriction. Import namespaces do not set scope.

Use the existing maintained GIN search vector for lower-weight domain metadata and
existing pgvector/hybrid retrieval for source fragments. Do not add a redundant broad
JSONB GIN or implicitly switch to approximate similarity search. Return typed domain
metadata with candidates so a client can follow with exact indexed inspection.

Use two partial covering B-trees for incoming/outgoing adjacency, each serving
queries with and without predicate. Restrict by predicate inside the index range
and page by (predicate, edge UUID), avoiding unrelated global UUID scans. Examine
at most 128 rows plus one lookahead, return at most 50 complete edge records within
512 KiB, and bind cursors to entity/predicate/direction/filters. Read endpoint/source
metadata through bounded point lookups rather than joining an unbounded table scan.
Identity-only entity inspection performs no adjacency read. Preserve old fragment
indexes as partial indexes excluding domain rows.

A read-only snapshot returns exact source and checks physical edge columns, identities
and provenance against the stored immutable claim. It must not echo a request payload
as evidence that a differently stored edge is correct. Do not treat a filtered empty
page as exhausted when its scan cursor advances.

Provide a versioned JSONL importer using the official MCP SDK. Default to validation
only. Apply entities before edges with concurrency 1..8, stable operation IDs, explicit
source-row accounting and exact read-back verification. Unsupported/unresolved rows
are never silently discarded or counted as successful. Preserve each committed record
atomically, not one transaction for an entire file. No compatibility adapter guesses
unknown export formats or substitutes generated facts for missing source edges.

## Consequences

There remain three application tables, three MCP tools, no required model and no
recursive reasoning or workers. Identities are immutable and namespace-global within
each kind, not tenants. This is append-only import, not mutable graph synchronization.
Administrative entity deletion can remove incident links while retaining edge source
episodes; client read-back must still detect absent links on replay.

New indexes cost storage and import writes, but exclude unrelated row kinds and do
not copy large provenance/text into adjacency keys. The first migration replaces the
legacy composite primary key with an equivalent partial unique index and builds
directional indexes; it can block writes and needs a maintenance window on large
stores. Existing transactional migration remains; online/resumable migration is a
separate ownership boundary. Semantic recall remains exact and is not claimed to
scale to millions merely because adjacency is bounded.

## Verification

Real MCP tests cover stable identities, parallel edges, self edges, direction,
provenance, retries, cursor mismatch, identity-only reads and zero lifecycle effects
from a domain predicate named confirms. Storage regressions cover atomic endpoint/
identity failures, tampered physical metadata, empty filtered pages and byte budgets.
The metadata regression verifies reuse of the existing GIN and unchanged vectors.

The actual adjacency SQL is tested with EXPLAIN ANALYZE on a 12,000-edge entity
among 48,000 unrelated edges, both directions, rare predicates and late cursors.
A discovered full source-table
scan was replaced with bounded lateral point reads. Tests assert bounded rows rather
than unstable wall-clock thresholds. The official-SDK importer test uses an owned
`_test` database, verifies every supported edge after a fresh-process resume, accounts
for unsupported/unresolved rows, and checks no source text reaches reports. Passing
these checks is not evidence of source truth, arbitrary-format compatibility or
large-scale production capacity.
