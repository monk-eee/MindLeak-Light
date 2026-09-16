# ADR-0015: Document Keyword Recall and Bounded Context

- Status: Accepted
- Date: 2026-09-16

## Context

Engineering runbooks expose limitations of fragment-only keyword search:
PostgreSQL indexes qualified identifiers as whole tokens, headings can lose
their nearby steps, metadata cannot generate candidates, duplicate text occupies
repeated response space, and callers cannot inspect parsed query semantics.
The default must remain model-free and fast. Source episodes, exact raw text,
pgvector behavior, filters, and independent lifecycle claims must remain intact.

This extends the keyword implementation from [ADR-0005](0005-optional-models-and-model-free-quickstart.md)
and the response/snapshot contracts from
[ADR-0012](0012-bounded-recall-context.md) and
[ADR-0013](0013-cancellation-and-recall-snapshots.md), without adding tools or tables.

## Decision

### Indexed Text and Metadata

Retain original English fragment lexemes and append dot-component aliases for
identifier-shaped PostgreSQL hostname tokens. Numeric literals and email tokens
remain unchanged. Aliases are not compiler name resolution or source positions.

Store `fragments.search_vector`, combining fragment lexemes at weight C and
source/summary lexemes at weight D. Source paths additionally contribute
punctuation-separated terms; their original lexemes are retained. One GIN index
supports queries spanning fields. Use `ts_rank_cd` normalization 32 with weights
D=0.025 and C=0.1. These are lexical ranking weights, not probabilities. Scope,
session ID, and agent provenance do not become searchable metadata fields.

Database triggers derive the vector on fragment insert/text changes and refresh
it when a memory's source/summary changes. The startup transaction backfills
existing rows and builds only the final combined index, then removes obsolete
keyword indexes. Later startups skip already-applied DDL. Future tokenizer
changes require an explicit stored-vector backfill, not a silent replacement of
an immutable helper function. Raw text, fragment IDs, and embeddings are preserved.

### Query Controls

Keep `matchMode=websearch` as the default. Add literal `all` and `any` modes using
PostgreSQL's English parsing and stemming; stop words do not become required
terms. Build any-term expressions from database-derived lexemes with PostgreSQL
quoting, never raw query interpolation. All predicates retain existing filters
before candidate limits. Hybrid applies the mode only to its keyword branch;
vector-only recall rejects explicit all/any modes before embedding.

Optional `diagnostics` returns the retrieval strategy, relevance-filter status,
and keyword `matchMode`, `parsedQuery`, and input-lexeme `terms`. Search and
diagnostics use the same SQL query construction. Diagnostics add a description
lookup only when requested, never a provider call. They do not expose match
counts, establish corpus completeness, or verify relevance. Unsupported custom
retrievers fail explicitly when diagnostics are requested.

### Bounded Episode Context

`contextLimit=0` preserves the default. Values 1..8 add nearby fragments from
the same `memoryId`, not other writes with an equal source label. Store new
fragment order as a zero-based `fragment_index`. Recover legacy order only when
all fragments have distinct literal positions in whitespace-normalized raw text;
otherwise leave it unknown. Never guess ordering for rewritten model output.

Select nearest eligible siblings and return them in fragment order when known,
or stable UUID order otherwise. Apply the requested agent/scope/tier/state filters
within the existing final read-only `REPEATABLE READ` snapshot. No additional
model call, recursive expansion, inferred relationship, or score is attached.

`documentContext` contains complete fragments and provenance, `orderKnown`, and
an explicit `truncated` flag. Read at most the requested limit plus one per
primary to detect omissions. Existing link context is allocated first; document
context shares its remaining 32 KiB serialized budget, including JSON escaping,
and cannot exceed the overall 512 KiB response cap. Preserve primary results
and whole context fragments. The model relevance selector still requires direct
evidence from the selected primary, not a claim inferred from nearby context.

### Source-Preserving Grouping

`groupDuplicates=false` preserves the default. When requested, the memory service
groups exact equal returned text after retrieval, optional relevance selection,
and the original fragment limit. The first ranked occurrence stays primary.
Additional occurrences move to `duplicateSources`, retaining IDs, agent/context,
scores, lifecycle, activation, ranking priority, links, and document context.
`sourceCount` includes the primary and describes only the returned working set.

This is response presentation, not stored deduplication or a corpus-wide source
enumeration. Case, punctuation, and negation remain significant. Do not refill
slots, aggregate confirmation/usefulness, change scores, or claim independent
evidence because several sources repeat text. Reject an oversized grouped
response rather than silently discarding source provenance.

### Compatibility

Keep the three MCP tool names and existing arguments. New controls are optional
and advertised in the tool input schema. Default recall text content remains an
array, with the existing structured `results` wrapper. Requested diagnostics
instead produce an object containing `results` and `diagnostics` in both forms.
The memory service checks final serialized size after grouping and diagnostics;
MCP envelope and duplicated wire representations remain outside the payload cap.

## Consequences

The schema needs function/trigger privileges, derived-vector storage, and a
one-time backfill/index build that can block writes and require extra disk.
Normal indexed recall avoids computing metadata vectors for every candidate.
No model, re-ingestion, re-embedding, new application table, or worker is required.

Metadata matches may increase noise, and positional aliases are not source
phrase spans. The metadata weight is an initial policy, not a measured accuracy
claim. Context can be incomplete or inapplicable to an incident. One stored
episode remains the expansion boundary; source labels are not authorization.
Grouping may yield fewer visible groups than the requested fragment limit and
does not prove that every matching source has been returned.

## Verification

- Real PostgreSQL red/green regressions for short qualified identifiers and
  source/path metadata, including terms spanning metadata and fragment text.
- GIN-plan, single-index, legacy raw/vector preservation, trigger freshness,
  and nonblocking repeated-startup checks.
- Real MCP red/green tests for all/any/websearch modes, parsed diagnostics,
  literal punctuation, empty stop-word queries, and malformed options.
- Real MCP red/green heading/step and duplicate-group tests, checking source
  IDs, lifecycle/history filters, negation, scores, per-source context, and limits.
- Serialized escaping and shared/total context-budget unit tests, default
  response compatibility, zero-provider defaults, and full `make ci` against a
  disposable `_test` database. These are correctness checks, not large-corpus
  latency measurements or evidence of successful real incident diagnosis.
