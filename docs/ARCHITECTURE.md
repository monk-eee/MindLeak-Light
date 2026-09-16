# Architecture

```text
Claude / GPT / agents
        |
        | MCP: stdio or authenticated Streamable HTTP
        v
MindLeak Light (one executable)
  MemoryService
    -> MemoryDecomposer -> OpenAI-compatible chat endpoint
    -> TextEmbedder     -> OpenAI-compatible embedding endpoint
    -> MemoryStore     -> PostgreSQL transaction
    -> MemoryRetriever -> query embedding + pgvector search
        |
        v
PostgreSQL: memories, fragments, relationships
```

## Write

Validate input, extract atomic facts, normalize whitespace and remove exact
duplicates, embed the batch, validate index ordering and vector shape, then open
one transaction. Insert raw memory first, followed by all fragments and vectors.
Commit, then return the memory ID. Model work happens before the transaction so
slow inference does not hold database connections or leave partial records.

Raw text is preserved exactly. Memory text is limited to 32768 UTF-8 bytes;
decomposition produces 1..64 fragments of at most 4096 bytes each. Empty facts,
truncated model responses, zero/non-finite vectors, and dimension mismatches fail.

## Recall

`MemoryRetriever` owns the query-to-results boundary. `VectorMemoryRetriever`
embeds the query and orders fragments using PostgreSQL's cosine-distance operator.
Filtering happens before limiting, so an agent filter cannot lose results to an
approximate global shortlist. Exact search is deliberate for this initial size;
it scans candidates and has no approximate-vector index yet.

The client agent performs synthesis from returned fragments and their provenance.
Replacing the retriever does not change the MCP tools or write pipeline. RAST
is an interface extension point, not a shipped implementation.

## Storage and Deployment

The Postgres crate owns one bounded pool, shared by all server clones. Startup
serializes idempotent schema initialization with a transaction-scoped advisory
lock. Embedding model and dimensions are recorded in the fragments table comment;
incompatible configuration refuses to start rather than comparing unrelated vectors.

Relationships have constrained types, foreign keys, and cascade cleanup but no
automatic inference. `agent_id` records provenance in a shared trust domain.
It is not a tenant key. There is no user table, queue, migration ledger, scheduler,
or background consolidation service.

The Compose file is local development, not an internet-facing production
topology. Production uses the same binary with protected HTTP ingress and a
TLS-verified Postgres connection. See [SECURITY.md](../SECURITY.md).

## Origin

Adapted from MindLeak's Cargo workspace, OpenAI-compatible consolidation and
embedding clients, batch-vector validation, `deadpool-postgres` pool pattern,
and knowledge-store pgvector queries. Repo processes retain its ADR, changelog,
hook, review, and release conventions. No sibling crate is linked or required.
