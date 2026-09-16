# ADR-0009: Fast Recall and Optional Model Controls

- Status: Accepted
- Date: 2026-09-16

## Context

Recall must be fast by default. Model processing is an explicit option when
quality matters more than latency, not a compulsory read-path dependency. The
experimental relevance selector has not established a general accuracy benefit;
local reasoning models can take tens of seconds per query. Repeated semantic
queries previously requested the same embedding every time.

## Decision

Preserve keyword recall and sentence decomposition as the model-free defaults,
and leave `MINDLEAK_RELEVANCE=off`. Semantic vector/hybrid recall uses one query
embedding on a miss and reuses validated vectors for exact repeat queries. Each
retriever holds at most 128 entries, evicting the oldest insertion. It never
caches result rows. PostgreSQL always evaluates current data, agent provenance,
limit, and similarity filtering. Cache keys preserve case and whitespace.

The cache is in-process and specific to a retriever's fixed embedding space.
No persistent query data, new table, or TTL worker is introduced. No lock is
held during inference. Failed or invalid embedding responses are not cached.
Concurrent misses may issue duplicate embedding requests, but occupy one entry.
Hybrid keyword lookup runs concurrently with the existing vector path; either
branch's failure still fails recall.

Extend the experimental selection contract from ADR-0008 to require a requested
detail plus unique candidate indices with exact source quotations. Reject
invented evidence, malformed responses, and incomplete generation. Quotations
are checked for source presence, not semantic sufficiency; the selector still
preserves original fragments and is not a truth verifier.

Add explicit independent `MINDLEAK_LLM_REASONING_EFFORT` and
`MINDLEAK_RELEVANCE_REASONING_EFFORT` controls for compatible chat providers.
Unset/empty omits the field. Enabled values are none, low, medium, high, and max;
unsupported provider behaviour remains an error, never an implicit retry or
fallback. Defaults do not impose a reasoning policy on existing providers.

Measure first-pass and repeated-query latency separately with benchmark
`--passes`. A warm p95 gate evaluates each later pass, not a blended mean.
Repeated queries do not constitute additional independent accuracy examples.
Keep optional inference benchmarks separate from the fast configuration.

## Consequences

Hot-query semantic recall avoids inference but new queries still depend on
embedding latency. Exact vector search is unchanged and not constant-time at
large corpus sizes. A process restart clears the cache; changing model weights
under the same name remains unsupported. Query strings stay in bounded process
memory until eviction or exit. A cache hit is not a fallback after provider
failure: no provider request is attempted for that validated vector.

Quality options may be slower or less accurate. Disabling reasoning sped up the
installed GLM model but worsened relevance selection, so it is not recommended
as a universal profile. The extracted-fact prompt improvement and fast query
cache have separate evidence; neither fixes all relevance or semantic issues.

## Verification

The repeated-query regression failed with four provider calls before caching
and passed with one afterward, including inserts, deletes, and agent changes.
Database tests cover bounds, exact keys, and failed/invalid provider retries.
Hybrid failure tests remain. Fixed-binary three-pass runs on 240 memories and
88 queries showed unchanged ranking metrics and warm p95 under 20 ms locally.
Run the full `make ci` gate on disposable `_test` storage. Report first-pass
latency and the tested workload rather than promising universal response times.
