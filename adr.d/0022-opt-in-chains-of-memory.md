# ADR-0022: Opt-In Knowledge Formation

- Status: Accepted
- Date: 2026-09-17

## Context

The user wants MCP-facing knowledge formation rather than a larger collection of
memories, while requiring additive compatibility with existing callers and data.
The required workflow is observations, chains and principles, with opt-in model
formation, validation/revision, knowledge-first retrieval, dependency review and
export. A VS Code extension, changed default recall, mandatory models and
automatic acceptance are excluded. Chain-only CRUD is not the full deliverable.

## Decision

Keep the three MCP tools and three application tables. Add optional typed `chain`
operations to `write_memory` and `recall_memory`; absent fields retain legacy
dispatch and serialization. Reject mixed chain/ordinary arguments rather than
discarding constraints. Optional `recall_memory.knowledge` provides hierarchical
search, review, dependents and export; `decompose_memory.formation` previews
candidates. Text-only decomposition and all legacy modes remain unchanged.

Represent each chain operation as an immutable source episode in `memories`,
with its complete source fragments and optional validated vectors in `fragments`.
Nullable chain columns identify revisions, their snapshots, operation, prior
episode, and current-head projection. Only the current-head bit is mutable.
Store the canonical request and original receipt in the same transaction as all
new data. Reuse the existing fragment writer and retry uniqueness domain; add
partial revision/head/kind-normalized-claim, keyword and direct dependency indexes.
Store a separate validated document vector in the existing embedding space when
enabled, atomically with all source fragments and the original receipt.
No existing episode is converted into a chain by migration or recall.

Exclude all chain episodes from ordinary keyword/vector/hybrid candidate reads,
final recall, ordinary source inspection, and ordinary fact mutation targets.
Chains can appear only in explicit chain retrieval. Preserve all legacy IDs,
raw text, vectors, scores, contexts, lifecycle, and receipt shapes.

Every chain write requires an explicit request UUID, contributor, actual session,
source reference, and raw source text. The existing enabled decomposition and
embedding pipeline processes the source before any database transaction; failure
never silently switches strategies. The structured document is explicitly
submitted by the caller, not inferred or semantically verified by decomposition.

Proposals start candidate/unreviewed. Acceptance is a recorded validation claim
with method, result, and source, not independent truth verification. Require
explicit review of every declared counterexample. Challenges mark review state;
revisions preserve known counterevidence and return to candidate status.
Retirement is terminal. Use expected revision compare-and-set with row locking
and immutable keyed replay; retries do not add feedback or duplicate history.

Chains reference at most eight ordinary observation fragments in the same scope.
Principles generalize 2..8 current accepted, reviewed chain revisions with healthy
known evidence; direct principle evidence is counterevidence. These allowed
levels exclude cycles and self-justification. Kind cannot change across revisions.
Replacing principle support must preserve inherited counterexamples directly or
through new supports; unavailable prior documents cannot be silently discarded.
Keep source IDs visible and deduplicate episodes across supports; evidence volume,
different contributors, and repeated sessions are not proof of independence.
Reported confidence is optional and explicitly attributed, never an inferred
truth probability or ranking signal. No observation lifecycle is changed by a
chain operation. General memory remains unscoped, with general search spanning
scoped and unscoped chains inside the same trust domain.

Use `MINDLEAK_FORMATION=off|openai`, default off, independently of decomposition.
Reuse the configured provider, bounded response reader, timeouts and safe errors.
Strict candidate schema, source identity and exact citation checks reject invalid
output but do not prove reasoning validity. Bound selections to eight observations
or chains, input to 128 KiB and output to three candidates with evidence gaps.
Retain the configured model, prompt version and selected sources on the document.
Formation never stores or accepts output; failures never fall back to splitting,
copying the source or a successful empty response.

Expose bounded knowledge search behind `MemoryRetriever` using the configured
keyword/vector/hybrid strategy and optional exact-quote relevance selector.
Document vectors retain pgvector cosine semantics and the configured floor;
hybrid fusion retains original branch scores. Unembedded knowledge remains
keyword-searchable; there is no implicit backfill. Current accepted
and reviewed chains are eligible only while supporting evidence remains active
and undisputed. Recompute `requiresReview` at read time in the same snapshot;
preserve recorded acceptance rather than manufacturing validation events.
Optional candidate/inactive filters permit deliberate inspection of other heads.
History uses revision-keyset pagination, not recursive evidence traversal.

A supporting chain's revision change, challenge, retirement or withdrawn evidence
makes its principles require review without manufacturing an acceptance event.
Knowledge-first search selects principles before chains within a bounded working
set and independently searches observations. Recheck selected knowledge and its
references in one read-only snapshot after provider work; drop changed/ineligible
candidates without refill. Observations use their normal separate read snapshot,
stated explicitly in the response. Indexed direct dependents and a paged review
queue expose stale beliefs without a worker or recursive graph engine.

Return evidence references even when source details exceed their 32 KiB shared
budget; identify omission and preserve full text when present. Whole responses
remain bounded to 512 KiB. Exact source and each historical revision stay
inspectable, while unavailable/erased evidence is reported honestly. Retirement
does not depend on the continued existence of evidence.

Export returns bounded JSON or escaped Markdown with original source, conditions,
evidence, lineage, provenance and paged revision history. It does not invoke a
model to rewrite evidence or write to caller-selected server paths.

## Consequences

Existing clients retain ordinary request/response behavior against an upgraded
server, with no mandatory model or new tool. New typed fields are opt-in. Added
trait methods have explicit unsupported defaults for existing custom stores and
retrievers; they do not fall back to ordinary memory behavior.

Old server executables do not understand the chain exclusion marker. Do not mix
them with new servers against a database containing chains; use backup/restore
for downgrade. This is additive client compatibility, not mixed-version server
compatibility. Initial DDL and partial-index construction use the existing
migration lock and may need a deployment maintenance window. A bounded result
does not establish large-corpus search capacity.

This workflow does not prove reasoning validity, authenticate independent
reviewers, establish source independence, exhaustively discover counterexamples,
generate doctrine or claim measured learning/compression gains. Model quality
and agent benefit require held-out evaluation; protocol success is not evidence
of those outcomes. There are no autonomous triggers or background workers.

## Verification

Require legacy domain/MCP tests, real PostgreSQL upgrade and replay checks,
unchanged keyword/vector/hybrid result scores with chain records present,
general/scoped filters, concurrent same-key operations, stale revision refusal,
duplicate/cross-scope/derived evidence rejection, and atomic rollback. Exercise
the candidate/accept/challenge/revise/retire loop across fresh MCP processes,
including separately configured formation, principle validation/revision,
semantic retrieval, stale dependency review and model-free inspection/export.
Test provider failures, invented citations, retained formation provenance,
inherited counterevidence, missing sources, response bounds and zero feedback.
Run the released-baseline recall gate and restore a pre-chain published database
before claiming compatibility. Record unmeasured native-agent behavior separately.
