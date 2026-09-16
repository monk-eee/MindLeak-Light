# ADR-0005: Optional Models and Model-Free Quickstart

- Status: Accepted
- Date: 2026-09-16

## Context

The initial design required both chat and embedding providers before a user
could write or recall anything. The product must instead be usable with just
PostgreSQL, especially for a quickstart. Models remain recommended for semantic
quality. Developers need an uncomplicated way to add memory to existing agents.

## Decision

Supersede [ADR-0003](0003-atomic-decomposed-memory.md) while preserving atomic
writes and the replaceable retriever. Default to Unicode sentence and line/list
segmentation without rewriting, and indexed PostgreSQL full-text keyword recall.
Store absent embeddings as SQL NULL, never fabricated vectors.

Chat extraction (`MINDLEAK_DECOMPOSITION=openai`) and vector recall
(`MINDLEAK_RETRIEVAL=vector`) are independent explicit opt-ins. Require provider
settings only when enabled. Support OpenAI-compatible structured JSON-schema
responses, including LM Studio. Disabled modes construct no provider clients.
An enabled provider's failure remains a failure, never a silent mode switch.

Keep the three application tables. Apply an explicit idempotent migration to
allow NULL embeddings and add the keyword GIN index, under the existing startup
transaction and advisory lock. Preserve old text, vectors, and model metadata.
Bind model/dimension metadata on the first vector-enabled start; refuse mismatches.

Lead documentation with start, connect, write, and recall. The Compose and VS Code
quickstart need no host Rust toolchain or model server. Provide a runnable official
MCP SDK client and a separate recommended-model guide.

## Consequences

Model-free fragmentation preserves wording but cannot guarantee atomic semantic
facts, resolve references, or split every compound claim. Keyword recall is
English full-text search, not a substitute for vector semantics. Recommend models
for richer extraction and natural-language queries, with their inference costs.

All raw memories and fragments still commit together; enabled embeddings join
that transaction. Model-free entries remain keyword-searchable when vectors are
enabled, but are not automatically embedded or included in vector-only results.
No backfill worker, new tool, extra table, or orchestration is introduced.

## Verification

The real-process MCP regression exercises all three tools with an unavailable
mock provider and asserts zero provider requests. Storage tests cover NULL vectors,
keyword ranking/filtering, legacy upgrades, and enabling a model after model-free
writes. Existing provider-error, vector-integrity, and rollback tests remain.
Run the JavaScript client against a disposable test server and `make ci`.
