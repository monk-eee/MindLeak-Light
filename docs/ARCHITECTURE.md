# Architecture

This describes the current source: v0.2.0 contextual fact lifecycle, hybrid
recall, similarity thresholds, cached query embeddings, provider response bounds,
and the subsequent unreleased retry-safe write contract.
See [installation](INSTALL.md) for packages and upgrade requirements.

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
        -> MemoryRetriever -> keyword, vector, or hybrid rank fusion + lifecycle priority
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

With a client `requestId`, validate intrinsic input constraints and look up a
committed receipt before model work. The key is a UUID scoped by `agentId`, not
an authentication boundary. A matching canonical request replays its immutable
write result. Changed text, context, or directives fail with invalid parameters.
Typed defaults are normalized; raw text and ordered directive/link lists remain
part of identity. Requests without a key retain the original write-per-call
behaviour.

The `memories` insert stores the canonical typed request and original result in
the same transaction as all fragments, vectors, and lifecycle effects. A partial
unique index on `(agent_id, request_id)` arbitrates concurrent inserts. A losing
insert reads and verifies the committed payload, returning its receipt without
inserting fragments or reapplying relationships. No reservation or database lock
is held during inference; simultaneous initial requests may duplicate model
work. Provider failures and rolled-back transactions do not consume a key.
See [ADR-0011](../adr.d/0011-idempotent-memory-writes.md).

Raw text is preserved exactly. Memory text is limited to 32768 UTF-8 bytes;
decomposition produces 1..64 fragments of at most 4096 bytes each. Empty facts,
truncated model responses, numerically unsafe vectors, and dimension mismatches
fail. Squared vector norms must be finite and normal in f32 so pgvector's cosine
arithmetic cannot underflow on accepted inputs. Non-finite database recall scores
are errors rather than successful results with a null score.

## Provider Responses

The `mindleak-provider` crate owns the shared `read_json_response` boundary used
by the decomposition, embedding, and relevance clients. It caps each provider
body at 4 MiB before JSON parsing, checking the declared length when available
and cumulative bytes while reading chunks. Oversized or broken responses fail
without truncation, response-body logging, or fallback to another strategy.
This shared HTTP boundary keeps transport concerns out of the memory domain.

When an embedding provider reports a non-null model ID, it must exactly match
the configured ID before vectors can be used for writes or queries. Providers
that omit that metadata remain supported, but their actual identity cannot be
verified. Model aliases are not resolved implicitly, and stable model names still
cannot prove that a provider has kept its weights unchanged.

## Recall

`MemoryRetriever` owns the query-to-results boundary. `KeywordMemoryRetriever`
uses PostgreSQL's English text-search configuration, `websearch_to_tsquery`, and
normalized `ts_rank_cd`, with a GIN expression index. It searches all fragments.
Use short keyword queries; unrelated synonyms are not inferred.

Optional `VectorMemoryRetriever` embeds the query and orders fragments with
vectors by PostgreSQL's cosine-distance operator. NULL embeddings are excluded,
not filled with fake vectors. Both paths filter by agent before limiting. Vector
search is exact and has no approximate-vector index yet.

Vector/hybrid retrievers keep an in-process FIFO cache of at most 128 validated
query embeddings, keyed by the exact query string. Cache hits skip embedding
inference, not database recall: current rows and agent filters are always checked.
Invalid vectors and provider failures are not cached. The cache belongs to one
fixed model/dimension space and is cleared on process exit; concurrent misses
may duplicate inference. Hybrid keyword lookup runs concurrently with the vector
path. No mutex is held during an await. See
[ADR-0009](../adr.d/0009-fast-recall-and-optional-model-controls.md).

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
fragment indices with exact evidence quotations, never to generate a recalled fact.
It validates each quotation against the corresponding stored candidate, without
claiming that source presence proves relevance. It preserves selected
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

## Contextual Fact Lifecycle

The source episode stores optional scope, session ID, source, and summary as
bounded context. Fragments have independent short/long-term retention, state,
evidence status, salience, pin, and feedback timestamps/counters. The lifecycle
never copies facts into another database or replaces pgvector embeddings.

Writes can explicitly relate each new fragment to existing fragments in the same
scope. SQL target locks and a feedback-session unique index protect concurrent
updates; the episode, links, vectors, and lifecycle changes commit together.
Confirmation and usefulness are separate feedback types. Consolidation only runs
on new feedback with a demonstrated time span, never as a side effect of recall.
Correction, archive, and restore are evidence-linked writes retaining history.

Context, tier, agent, and state filters enter the keyword/vector SQL before
candidate selection. Lifecycle priority is computed once after candidate search
or hybrid fusion, discounting low activation by at most 25% while preserving the
original score. Exact pgvector cosine remains the semantic query. Read at most
eight direct related references per final result, with a count for truncation;
there is no graph traversal. Optional relevance inference receives the context
but still must quote the selected fact itself as evidence.

See [ADR-0010](../adr.d/0010-contextual-fact-lifecycle.md) for precise policies
and [the lifecycle guide](LIFECYCLE.md) for the human-facing contract.

## Storage and Deployment

The Postgres crate owns one bounded pool, shared by all server clones. Startup
serializes idempotent schema initialization with a transaction-scoped advisory
lock. The original schema remains unchanged; the explicit
[optional-embedding migration](../crates/mindleak-storage-postgres/migrations/0002-optional-embeddings.sql)
relaxes nullability and adds the keyword index. Existing data is not rewritten.

The [lifecycle migration](../crates/mindleak-storage-postgres/migrations/0003-fact-lifecycle.sql)
adds metadata columns, context, typed relationship actions, and feedback uniqueness.
Existing facts default to short-term/active/unconfirmed with creation-time activation;
their raw text, identities, relationships, and vector types/values are preserved.

The [retry-safety migration](../crates/mindleak-storage-postgres/migrations/0004-idempotent-writes.sql)
adds nullable request ID, canonical payload, and result columns plus the unique
key and all-or-none metadata constraint to `memories`. Existing rows stay unkeyed;
no legacy IDs, fragments, vectors, or lifecycle metadata are rewritten. Receipts
last as long as their memory row, including while facts are archived or superseded.
Changes to the canonical request representation need an explicit compatibility
decision so future upgrades do not silently change request identity.

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
