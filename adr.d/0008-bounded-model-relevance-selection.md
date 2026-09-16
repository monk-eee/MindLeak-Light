# ADR-0008: Bounded Model Relevance Selection

- Status: Accepted
- Date: 2026-09-16

## Context

The v2 benchmark showed that a calibrated cosine floor rejects missing-answer
queries at the cost of relevant facts. Topic similarity is not evidence that a
candidate contains the requested detail. Extraction evaluation separately exposed
compound claims and references that did not stand alone. These are different
failure modes and must not be hidden by a single source-ID accuracy number.

## Decision

Keep keyword, vector, and hybrid candidate retrieval unchanged. Add an opt-in
`OpenAiRelevanceRetriever` implementing the existing `MemoryRetriever` contract.
It composes a candidate retriever with one OpenAI-compatible structured chat
selection call. It lives beside the embedding provider as optional retrieval
inference, not in PostgreSQL or the domain service. No new crate, table, MCP tool,
worker, or coordination runtime is introduced.

`MINDLEAK_RELEVANCE=off` is the default. `openai` requires explicit
`MINDLEAK_RELEVANCE_URL` and `MINDLEAK_RELEVANCE_MODEL`; the API key is optional.
`MINDLEAK_RELEVANCE_CANDIDATES` is 1..50, default 20, raised to the caller's
requested result limit when necessary. The combined query/candidate text budget
is 32768 UTF-8 bytes; reject overflow without truncating facts. Individual
fragments keep their existing bounds. Invalid provenance, duplicate candidate
IDs, or non-finite scores fail before inference. Empty candidate lists bypass
the provider.

The selection response contains only a unique list of existing candidate
indices. Reject invalid indices, extra fields, malformed or truncated responses,
and provider failures. A valid empty selection is abstention. Preserve original
candidate text, IDs, provenance, scores, and relative ranking; apply the user's
limit after filtering. Never turn an inference failure into unfiltered or empty
success. Send query and fragments as a JSON data message, separate from the
system instructions. Do not send gold labels to the provider.

Refine optional extraction with minimal source-grounded edits: keep atomic
wording, resolve only supported references, split independent claims, and retain
conditions, negation, exact identifiers, uncertainty, and time scope. Default
sentence/list decomposition remains deterministic and does not pretend to do
semantic extraction. Evaluate the extraction change independently of selection.

Use new holdout targets rather than tune against exposed v2 evaluation labels.
The benchmark can add background memories without importing their queries. Keep
before/after binaries stable, record the model/provider identity, and report
latency and unverified wording separately from accuracy. Failed control runs or
hash mismatches do not establish a comparison.

## Consequences

Relevance selection adds a recall-time model dependency and latency. It cannot
retrieve a fact absent from the candidate pool, repair extraction, prove truth,
or guarantee resistance to instructions embedded in memory. A high upstream
cosine floor may discard facts before selection can consider them. Recommend
measuring unfiltered candidates plus selection, not stacking arbitrary gates.

The model can still select a related but insufficient fragment or omit a useful
one. No probability or model-generated answer is exposed as a fact. The filter
must stay opt-in, including for clients that need cheap predictable recall.
Changing the model can change results; offline evaluation and operator choice
remain necessary. Gold-variant matching remains conservative rather than an
independent semantic judge.

## Verification

Provider tests cover lower-ranked answer recovery, preserved candidates/order,
empty selection, invalid/duplicate indices, response truncation, unavailable and
timed-out models, prompt/data separation, provenance, and text budgets. A real
stdio MCP test verifies that explicit configuration reaches the selector and
that failed inference returns a tool error. Default configuration and model-free
tests continue to require no providers. Run `make ci` with a disposable `_test`
database, plus fixed-binary fresh-holdout retrieval and before/after extraction
comparisons. Do not report mock selections as measured model accuracy.
