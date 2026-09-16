# Architecture

This describes the current source, including unreleased hybrid recall and
similarity thresholds. See [installation](INSTALL.md) for release availability
and the features included in v0.1.0.

```text
Claude / GPT / agents
        |
        | MCP: stdio or authenticated Streamable HTTP
        v
MindLeak Light (one executable)
  MemoryService
                -> MemoryDecomposer -> sentences/lists, or optional chat endpoint
                -> TextEmbedder     -> optional embedding endpoint
    -> MemoryStore     -> PostgreSQL transaction
                -> MemoryRetriever -> keyword, vector, or hybrid rank fusion
        |
        v
PostgreSQL: memories, fragments, relationships
```

## Write

Validate input and decompose it using the configured strategy. The default uses
Unicode sentence boundaries and line/list boundaries, preserving the wording.
Optional model mode extracts atomic facts from structured JSON output. Normalize
whitespace and remove exact duplicates. If vector or hybrid retrieval is enabled,
embed the batch and validate ordering and vector shape before opening a transaction.

Insert the exact raw memory followed by every fragment, using NULL for disabled
embeddings. Commit, then return the memory ID. Enabled model work happens before
the transaction so inference does not hold database connections. No failed
provider call is replaced with another strategy.

Raw text is preserved exactly. Memory text is limited to 32768 UTF-8 bytes;
decomposition produces 1..64 fragments of at most 4096 bytes each. Empty facts,
truncated model responses, zero/non-finite vectors, and dimension mismatches fail.

## Recall

`MemoryRetriever` owns the query-to-results boundary. `KeywordMemoryRetriever`
uses PostgreSQL's English text-search configuration, `websearch_to_tsquery`, and
normalized `ts_rank_cd`, with a GIN expression index. It searches all fragments.
Use short keyword queries; unrelated synonyms are not inferred.

Optional `VectorMemoryRetriever` embeds the query and orders fragments with
vectors by PostgreSQL's cosine-distance operator. NULL embeddings are excluded,
not filled with fake vectors. Both paths filter by agent before limiting. Vector
search is exact and has no approximate-vector index yet.

`MINDLEAK_RECALL_MIN_SIMILARITY` optionally filters vector candidates by cosine
similarity before limiting. It must be finite and in [-1, 1]; unset/-1 is
unfiltered. Calibrate it for the actual model and corpus rather than treating
cosine as confidence. Empty recall results are valid.

Optional `HybridMemoryRetriever` gets up to fifty candidates from each existing
search path and fuses them by fragment ID with reciprocal rank fusion (constant
60). It normalizes by the maximum score of two top-ranked matches, sorts by
fused score then fragment UUID, and applies the requested limit. A keyword hit
can survive without an embedding or below the cosine floor; the floor gates the
semantic branch only. Different facts from one memory remain distinct. Enabled
provider failures are propagated, never hidden behind keyword results.
See [ADR-0007](../adr.d/0007-hybrid-recall-and-calibrated-relevance.md).

`MINDLEAK_RELEVANCE=openai` optionally wraps any candidate retriever with
`OpenAiRelevanceRetriever`. It asks a configured model to select existing
fragment indices with exact quotations supporting the requested detail, never
to generate a recalled fact. It validates nonblank requested detail, unique
indices, and nonblank evidence contained in the corresponding candidate.
Index-only replies and invented quotations are rejected. This verifies source
membership, not semantic relevance or truth. It preserves selected
text, provenance, scores, and original order, then applies the caller's limit.
The candidate budget is 20 by default (1..50), raised to at least the requested
limit. Query plus candidate text must fit 32768 UTF-8 bytes or recall fails;
fragments are not truncated. Empty candidate lists skip inference. Invalid
indices, duplicate candidates, scope violations, truncated replies, and provider
failures are errors, not successful empty recalls. The default is `off`.
See [ADR-0008](../adr.d/0008-bounded-model-relevance-selection.md).

The client agent performs synthesis from returned fragments and their provenance.
Replacing the retriever does not change the MCP tools or write pipeline. RAST
is an interface extension point, not a shipped implementation.

## Storage and Deployment

The Postgres crate owns one bounded pool, shared by all server clones. Startup
serializes idempotent schema initialization with a transaction-scoped advisory
lock. The original schema remains unchanged; the explicit
[optional-embedding migration](../crates/mindleak-storage-postgres/migrations/0002-optional-embeddings.sql)
relaxes nullability and adds the keyword index. Existing data is not rewritten.

Model-free startup does not bind or require an embedding model. On first vector
or hybrid startup, model and dimensions are recorded in the fragments table
comment; the empty vector column can adopt that dimension. Later mismatches refuse startup.
Model-free processes can still read/write NULL-vector fragments in that database.
There is no automatic re-embedding of earlier entries.

Relationships have constrained types, foreign keys, and cascade cleanup but no
automatic inference. `agent_id` records provenance in a shared trust domain.
It is not a tenant key. There is no user table, queue, migration ledger, scheduler,
or background consolidation service.

The Compose file is local development, not an internet-facing production
topology. Production uses the same binary with protected HTTP ingress and a
TLS-verified Postgres connection. See [SECURITY.md](../SECURITY.md).

## Distribution

Native release archives contain the one MCP executable, connection template,
install guides, and checksums. They use an external PostgreSQL/pgvector database.
No host language runtime is needed to run the binary.

The `all-in-one` Docker target packages the same executable with PostgreSQL and
Supervisor. PostgreSQL is socket-only inside the container; the HTTP MCP server
is token-authenticated. A named volume holds database data. The supervisor owns
process startup/restarts/shutdown, not memory orchestration or agent coordination.
The `app` target and two-service source Compose setup remain available.

See [ADR-0006](../adr.d/0006-native-and-all-in-one-distribution.md) and
[installation](INSTALL.md). Docker Hub publishing targets
`monkeemagic/mindleak-light` and requires an explicit manual release-tag run.

## Origin

Adapted from MindLeak's Cargo workspace, OpenAI-compatible consolidation and
embedding clients, batch-vector validation, `deadpool-postgres` pool pattern,
and knowledge-store pgvector queries. Repo processes retain its ADR, changelog,
hook, review, and release conventions. No sibling crate is linked or required.

The user-facing [quickstart](../README.md#quickstart), [integration guide](INTEGRATION.md),
and [model setup](MODELS.md) are the supported entry points. See
[ADR-0005](../adr.d/0005-optional-models-and-model-free-quickstart.md) for the explicit
model-free default and optional-provider contract.
