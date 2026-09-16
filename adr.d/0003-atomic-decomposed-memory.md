# ADR-0003: Atomic Decomposed Memory

- Status: Superseded by [ADR-0005](0005-optional-models-and-model-free-quickstart.md)
- Date: 2026-09-16

## Context

Whole paragraphs make poor retrieval units. Model failures must not create
partially searchable memories, and swapping retrieval engines must remain cheap.

## Decision

Extract atomic facts using structured model output. Validate and embed the full
fragment set before opening a database transaction. Within it, insert the raw
memory followed by its fragments and vectors, then commit. Return an ID only
after commit. Standalone decomposition previews facts without storing them.

Recall calls `MemoryRetriever`. The initial implementation embeds the query and
performs exact pgvector cosine search over fragments; the calling agent performs
LLM synthesis. Keep fragment provenance in results. Do not implement RAST now.

## Consequences

Writes need a working model and embedding endpoint. A failed write leaves no
memory and can be retried; the raw-first conceptual pipeline is one atomic
commit, not a durable queue. There is no implicit fallback or automatic write
retry. A lost success response can therefore require caller reconciliation.

The embedding model and dimensions are fixed for a database, recorded in a table
comment without adding a fourth table. Importance defaults to 0.5 and does not
alter similarity. Relationships are constrained storage only, not inferred.

## Verification

Unit tests cover malformed decomposition and embeddings, provider failures,
read-only previews, and replaceable retrieval. Postgres tests prove rollback,
concurrent writes, ranking, agent filtering, and embedding-space mismatch refusal.
