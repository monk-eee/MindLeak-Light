# Knowledge Formation for Agents

**Observations capture experience. Chains of Memory justify beliefs. Principles
turn validated beliefs into reusable expertise.** Future agents can inspect and
apply that knowledge without inheriting an earlier conversation.

**Available in v0.6.0, opt-in:** a Chain of Memory is a versioned claim with a recorded
justification, evidence, applicability, counterexamples, and validation history.
Principles generalize multiple validated chains. Model-assisted formation,
knowledge-first retrieval, dependency review and JSON/Markdown projections are
available through the same three MCP tools. No client-specific UI is required.
Formation produces candidates, never automatic acceptance or a truth guarantee.

Original observations remain immutable source episodes and fragments. A chain
references those fragments rather than replacing them. The calling agent or
human authors the claim and its concise, auditable rationale; that is not an
export of a model's private reasoning process.

## Agent Learning

Knowledge formation is MindLeak's central workflow, not a synonym for retaining
more context. Agent-authored chains already need no formation model. A useful
chain records a reusable decision, its conditions,
the observations supporting it, and where it failed. It is not another task log.

Start with a verified observation; look for an existing chain before proposing
one. Validate the conclusion explicitly. A later agent checks applicability and
uses the conclusion to choose targeted current checks. New contrary evidence
justifies a challenge or revision, with counterexamples preserved. A principle
generalizes accepted chains only where their shared conditions justify it.

The learning policy selects this workflow on a capable approved connection;
the ordinary MCP defaults remain unchanged. See the [product thesis](../RATIONALE.md)
and [learning acceptance criteria](VALIDATION.md#learning-acceptance).
Evaluate formation, correct later reuse/revision, and measured benefit separately.
More stored notes, agreement or revisions alone does not establish learning.
The compact/capability/diagnostic additions below are **unreleased work targeting
v0.7.0**, not features of the published v0.6.0 binaries. Discover the actual schema.

## Compatibility

- There are still exactly three MCP tools and three application tables.
- Calls without the new `chain`, `knowledge` or `formation` modes keep existing arguments, response shapes, retrieval
  strategies, vectors, scores, lifecycle, and retry receipts.
- Chain source episodes and fragments never enter ordinary recall, including
  `includeInactive`. They are inspected through the explicit chain mode.
- A chain write does not reinforce, promote, archive, or supersede an observation.
  Ordinary fact directives cannot mutate a chain revision's fragments.
- Models remain optional. Chain/principle writes use the existing decomposition/embedding
  path for their raw source episode; enabled provider failures still fail the
  complete write. Semantic modes also embed the structured document in the same
  configured vector space. Existing ordinary writes are unchanged.
- `decompose_memory` with only `text` is unchanged. Explicit `formation` previews
  candidates through a separately enabled model. Inspection, export and review
  queues call no models; search honors configured embeddings and relevance.

Old clients may continue their existing calls against the upgraded server.
**Do not run old server binaries on a chain-enabled database:** they do not
know to exclude derived episodes from ordinary recall. Back up before upgrading;
rollback means restoring the backup into a separate database, not downgrading in
place. Client compatibility is not mixed-server compatibility.

## Create a Candidate

### Optional Model-Assisted Formation

Enable `MINDLEAK_FORMATION=openai` and configure the existing `MINDLEAK_LLM_URL`,
`MINDLEAK_MODEL` and optional key/reasoning settings. Decomposition can remain
`sentences`; models never become a quickstart prerequisite. Both Compose files
forward the formation setting. Use v0.6.0 with the advertised schema;
v0.5.0 and older binaries or images do not support these operations.

Select observations using ordinary recall and source inspection, then call:

```json
{
  "text": "What do these controlled measurements support, and where do they not apply?",
  "formation": {
    "kind": "chain",
    "fragmentIds": ["ead11942-3c9c-4b6b-b653-e5059e6c0ba1"]
  }
}
```

The ID is illustrative; use real selected IDs. Optional `formation.scope` and
`formation.agentId` filter source selection. All selected sources must share
the same optional scope, even during general-memory operation. The provider
receives stored sources, not arbitrary claimed evidence supplied in the call.

The result has `kind: formation`, `status: candidate`, `model`, the explicit
validation boundary, `proposal.documents`, exact checked `proposal.citations`,
and `proposal.gaps`. It returns at most three candidates, or no documents with
an explanation of missing evidence. It never stores a memory, executes a test,
or accepts a belief. Citation matching proves source presence, not truth or
independence. HTTP errors, incomplete output and invented citations fail.

Each candidate carries `document.formation` with the configured model,
`promptVersion`, selected fragment IDs and selected chain revisions. These are
formation provenance, not a signed attestation: later caller-authored writes
remain attributed claims. Inspect every selected source and gap, including
sources the model did not use. Save a chosen document explicitly as below;
record the actual source/validation episode in `text` and `context`.

### Explicit Proposal

Store observations through ordinary `write_memory` first. Use their returned
fragment IDs as evidence. Each reference includes a role (`supports` or
`counterexample`) and an explanation of its relevance. References must be
distinct and belong to ordinary observations in the same scope as the chain,
including all being unscoped. Two fragments from one episode remain two
references to one source, not two independent confirmations.

Call `write_memory` with the optional `chain` object. Every chain write requires
a retained UUID `requestId`, the actual `agentId`, `context.sessionId`,
`context.source`, and nonblank `text` documenting this operation. Keep the exact
request for ambiguous-outcome retries. `facts` cannot be combined with `chain`.

The following values are illustrative. Generate the operation/chain IDs and
replace the evidence ID with a real returned observation ID; use only a
disposable database for synthetic examples.

```json
{
  "agentId": "review-agent",
  "requestId": "8f297c36-5d25-48c3-bb19-8dbf72a35421",
  "text": "The controlled comparison supports retrieval for the measured task, not for every workload.",
  "context": {
    "sessionId": "actual-session-id",
    "source": "test-report:controlled-comparison"
  },
  "chain": {
    "operation": "propose",
    "chainId": "f579dd1c-9fa8-46fc-a515-a458f27c2501",
    "document": {
      "claim": "Selective retrieval reduced input usage on the measured task.",
      "rationale": "Both runs passed the same correctness checks; the retrieval run used fewer input tokens.",
      "conclusion": "Use the measured retrieval strategy for equivalent tasks.",
      "applicability": "The tested task, model, corpus and retrieval configuration only.",
      "assumptions": ["The task and correctness checks remain equivalent."],
      "evidence": [{
        "fragmentId": "ead11942-3c9c-4b6b-b653-e5059e6c0ba1",
        "role": "supports",
        "reason": "Recorded outcome of the controlled comparison."
      }]
    }
  }
}
```

The result contains `chainId`, `memoryId`, `revision`, `state`, `review`, and
the complete source-fragment receipts. A new chain is revision 1, `candidate`,
and `unreviewed`. Successful replay returns that original receipt even after
later revisions; inspect the chain for its current state.

Scope is optional. Omit it for general knowledge; an explicit `context.scope`
selects a project context and must stay identical on all revisions. Omitted
recall scope searches all scopes, not just unscoped chains. Scope and agent IDs
are provenance/filter fields, not authorization or proof of independence.

## Validate, Challenge and Revise

### Principles

Set `document.kind` to `principle` and provide `supportedBy` with 2..8 distinct
chain IDs, their exact accepted revisions, and reasons. For example, replace
the proposal document with:

```json
{
  "kind": "principle",
  "claim": "Selective retrieval helps the measured task family.",
  "rationale": "Two validated comparisons support a conditional generalization.",
  "conclusion": "Use the tested strategy on equivalent tasks.",
  "applicability": "Only the recorded task family, models and correctness checks.",
  "assumptions": ["Future tasks satisfy the recorded comparison conditions."],
  "evidence": [],
  "supportedBy": [
    {"chainId": "f579dd1c-9fa8-46fc-a515-a458f27c2501", "revision": 2, "reason": "First validated comparison."},
    {"chainId": "aedb46b3-d77c-4947-94a0-7a84a41f8d63", "revision": 2, "reason": "Second validated comparison."}
  ]
}
```

Principle support must reference current accepted, reviewed chains with healthy
known evidence in the same scope. Direct principle evidence is counterevidence;
positive support comes from chains. A principle cannot support another principle
or a chain. This bounded hierarchy prevents cycles and self-justification.
`observationSources` deduplicates source episodes across supports; two chains
using one episode still have one source, not independent corroboration.

Model-assisted principle formation uses `formation.kind: principle` and
`formation.chains` containing the same ID/revision/reason selections. Optional
`fragmentIds` select additional counterevidence. It returns candidate documents
through the same preview contract; proposing and accepting remain separate.

### Shared Lifecycle

Every subsequent write supplies the same `chainId`, the current
`expectedRevision`, and a new `requestId` for the new logical operation. Reuse
the original request and key only when retrying that operation. Stale revisions
fail rather than overwriting another agent's work. Atomic receipt arbitration
prevents concurrent same-key retries from adding revisions or effects twice.

| Operation | Required Chain Fields | Result |
|---|---|---|
| `propose` | `chainId`, `document` | New candidate, revision 1 |
| `accept` | `chainId`, `expectedRevision`, `validation` | Accepted and reviewed; records the validation claim |
| `challenge` | `chainId`, `expectedRevision`, counterexample `evidence` | New revision marked challenged; no automatic truth decision |
| `revise` | `chainId`, `expectedRevision`, complete `document` | New candidate requiring acceptance again |
| `retire` | `chainId`, `expectedRevision` | Terminal retired revision; source and history remain |

An acceptance's chain object looks like this:

```json
{
  "operation": "accept",
  "chainId": "f579dd1c-9fa8-46fc-a515-a458f27c2501",
  "expectedRevision": 1,
  "validation": {
    "method": "Inspect both runs and repeat the fixed correctness checks.",
    "result": "Both runs pass; the conclusion applies only to the tested workload.",
    "source": "test-report:validation-result",
    "counterEvidenceReviewed": []
  }
}
```

The outer write still requires the source text, actual session, contributor,
source reference, and request key. Validation records what that actor says was
checked. The server checks structure, evidence existence/scope, lifecycle, and
revision consistency; it does not execute arbitrary validation methods, inspect
external source URLs, authenticate a reviewer, or establish the truth of prose.

Every declared counterexample must appear exactly once in
`counterEvidenceReviewed`. A revision cannot erase known counterexample IDs;
it must address them by narrowing the claim/applicability and recording a new
validation. There is no automatic agreement-based confidence increase.
Replacing a principle's supports must also preserve inherited counterexamples,
either directly or through the new supports. Missing prior chain documents
prevent discarding unknown counterevidence; restore the source or retire the
principle. A changed supporting chain makes the principle require review even
if the new chain is accepted. Update the pinned revision explicitly and validate
the revised principle again. Challenges can still be recorded against stale
principles; invalid support cannot be used to accept them.

`state` (`candidate`, `accepted`, `retired`) and `review` (`unreviewed`,
`reviewed`, `challenged`) are independent. An accepted chain can become
challenged. Revising it returns it to candidate status. Older revisions are
immutable historical snapshots with `current: false`, not current accepted
recommendations. Retirement remains possible when an operator has erased an
evidence source; its missing reference is retained rather than invented.

An optional `document.reportedConfidence` contains `estimate` in 0..1 and a
nonblank `method`. It is explicitly a caller-reported estimate, not a calibrated
probability, ranking score, or acceptance condition. Omitting it is preferable
to inventing precision.

## Retrieve Knowledge Explicitly

### Compact Learning Context

For the unreleased v0.7.0 controls, first check that the advertised schema supports
capability discovery. This call uses local configuration only, with no database
or model work and no search filters or limit:

```json
{"knowledge": {"operation": "capabilities"}}
```

`learning` reports agent-authored chains/principles and explicit validation.
`formation` describes the optional preview provider, not whether an agent can
author a chain. `decomposition` is separate again. `retrieval` reports the actual
keyword/vector/hybrid strategy, supported `matchModes`, query diagnostics,
embedding model/dimensions, similarity floor, relevance model and whether provider
requests are instrumented. An extraction or formation model does not enable
semantic search. Custom providers remain `custom` unless they describe themselves.
Capabilities are not authorization or a provider health check.

Use one compact knowledge search for reusable conclusions and independent
observations, rather than automatically issuing a second ordinary search:

```json
{
  "knowledge": {"operation": "search", "query": "report export", "view": "compact"},
  "limit": 3
}
```

Each principle/chain keeps its complete `conclusion`, `applicability`, `assumptions`,
direct and inherited `counterevidence` IDs/reasons, author, scope, exact revision,
state/review, `requiresReview` and original scores. `supportingChains` keeps pinned
and current revisions, availability and review state without repeating full
documents. Identical counterexample IDs are grouped, retaining distinct reasons.
Independent observations keep their text, IDs, author, scope, score and lifecycle
state/evidence status. No model rewrites or summarizes these fields.

`reviewReasons` identifies recorded challenges/unreviewed status, changed or
unavailable supporting chains, and unavailable, inactive or disputed supporting
observations. An unknown current revision is unavailable, not assumed changed.
`evidenceDetailsAvailable: false` means not every reference could be resolved;
the references and recorded counterexample reasons remain. Even when available,
expanding all source details can require separate bounded inspections.

Inspect `chainId` with `revision` for full justification, validation, source and
history; inspect ordinary `fragmentId` references for exact observations. Compact
responses are capped at **32 KiB of serialized UTF-8 JSON**, including requested
diagnostics. Overflow fails: lower `limit` or inspect individual records. Conditions
and counterevidence are never shortened or silently dropped to meet the cap.
Existing internal hydration bounds still apply; compact is a response projection,
not a different relevance filter or a promise of less database/provider work.

### Explicit Search Controls

The new controls belong inside `knowledge` or `chain` when `operation: search`:

- `matchMode: websearch` remains the default, preserving phrases, `OR` and
  exclusions. English terms are ANDed; punctuation can introduce compound terms.
  For example, `report-export` can miss a document containing `report export`,
  and an absent extra term such as `API` can exclude it.
- `matchMode: all` or `any` explicitly chooses literal English term matching.
  `any` admits alternatives; it is not an automatic fallback or relevance claim.
  Vector-only search rejects these modes before calling the embedding provider.
- `diagnostics: true` adds the active strategy, actual PostgreSQL `parsedQuery`
  and normalized `terms`, plus whether relevance selection is enabled. Vector
  diagnostics have no keyword query. There is no silent query broadening.
- `costDiagnostics: true` adds `retrievalMs`, exact structured `responseBytes`,
  `providerRequestCount` and `providerCalls` with operation/model/timing and reported
  input/output/total/cached-input token counts. Missing or invalid counts are null,
  never estimated. A known cache hit has zero new embedding requests; concurrent
  callers count a shared request only in the initializing call, not in every waiter.

Timing includes retrieval, hydration and requested query diagnostics, excluding
MCP transport. Bytes include the diagnostic object itself but exclude the MCP
envelope and duplicate text content. Measure the original server JSON (also in
MCP text content), not a client's reserialization: floating-point parsing can
change numeric encodings and their lengths. These are successful-search measurements,
not total agent, formation, failed-request or monetary costs. Provider errors still
fail the operation. Diagnostics are opt-in, request-local and not persisted or
logged; they do not change scores, acceptance, evidence or query selection.

### Full Results and Inspection

For principles-first retrieval, call:

```json
{
  "knowledge": {"operation": "search", "query": "selective retrieval"},
  "limit": 5
}
```

The response contains `principles`, `chains`, and independently queried
`observations`. Up to `limit` derived results are selected with principles first;
up to `limit` observations remain visible even when a principle matches.
Each derived result carries direct evidence, pinned `supportingChains`, their
documents and evidence when within budget, and deduplicated `observationSources`.
Use independent observation queries to investigate counterevidence not linked
to an existing belief. No search asserts an exhaustive evidence review.

All knowledge results and their references are rechecked in one read-only
snapshot after provider work. Independent observations use their own normal
recall snapshot; the response states this consistency boundary. Results that
changed revision or became ineligible are removed without refill or mutation.
`knowledge.includeCandidates: true` explicitly includes unaccepted candidates.

Use `recall_memory.chain`, without ordinary `query`, `fragmentId`, `after`,
`tier`, or nondefault fact-search controls:

```json
{
  "chain": {"operation": "search", "query": "selective retrieval"},
  "limit": 5
}
```

The response is `{kind: "chains", strategy: "keyword"|"vector"|"hybrid", results: [...]}`. Each
match contains the current chain revision, its complete bounded document and
evidence references, a `score`, `vectorScore`, `keywordScore` and `requiresReview`.
Optional `chain.kind` restricts search to `chain` or `principle`. Keyword search
uses PostgreSQL English websearch and a partial GIN index over the structured
document. Semantic search uses its own validated pgvector document embedding,
with the same model/dimensions and cosine floor as ordinary recall. Hybrid
search uses bounded rank fusion and preserves original branch scores. Scores
are retrieval signals, not confidence. The configured relevance selector applies
without changing scores; provider failures never return unfiltered results.

Default chain search returns only current accepted/reviewed chains whose known
support remains active and undisputed. `chain.includeCandidates: true` adds
current candidates. Top-level `includeInactive: true` deliberately includes
retired or challenged current heads and reports their review requirement. It
does not search all historical revisions. `scope` and `agentId` are optional;
the agent filter selects the author of the returned revision, not an owner role.

Existing pgvector observation recall is unchanged. Keyword-only knowledge has
no vector until an explicit new revision is prepared with embeddings enabled;
hybrid keyword search still finds unembedded revisions. There is no implicit
backfill, vector substitution or model-space mixing.

Inspect a chain's exact source, current evidence, and revision history:

```json
{
  "chain": {
    "operation": "inspect",
    "chainId": "f579dd1c-9fa8-46fc-a515-a458f27c2501"
  },
  "limit": 5
}
```

Supply `chain.revision` for a particular historical revision. History is ordered
by revision; pass the returned `nextRevision` as `chain.afterRevision` for the
next page. Keep the chain and filters unchanged. A null continuation marks the
end of the filtered history, not proof of no other contributors' revisions.
Each call uses one read-only repeatable-read snapshot; separate pages are not
a single snapshot and recall never reinforces or modifies a chain.

`requiresReview` combines the recorded review status with current evidence
availability and lifecycle. Archived, superseded, disputed, missing, or
scope-mismatched support makes an accepted chain ineligible for default chain
search without rewriting the old acceptance record. Source restoration can make
that existing acceptance eligible again if all its conditions hold; no new
validation event is inferred. Inspect evidence and history before reuse.

Every evidence reference stays present, with source memory ID and lifecycle
when available. Optional evidence text/context share a 32 KiB budget.
`evidenceDetailsTruncated: true` means some complete details were omitted,
not that their IDs disappeared or text was shortened. Inspect those ordinary
fragment IDs directly, with explicit history filters when needed. Erased or
invalid derived-source references report `available: false`.

## Review Dependencies and Export

Use `recall_memory` with `knowledge.operation: review` to page through current
knowledge requiring review. Use `knowledge.operation: dependents` and `chainId`
to inspect directly dependent principles, including healthy ones. Both accept
`knowledge.after` from the returned `next` UUID and `limit: 1..10`. Keep target
and filters unchanged. Candidate/challenged/stale records remain auditable;
retired records need top-level `includeInactive: true`. Dependency reads are
indexed and direct, not recursive graph reasoning or a background worker.

```json
{
  "knowledge": {
    "operation": "export",
    "chainId": "f579dd1c-9fa8-46fc-a515-a458f27c2501",
    "format": "markdown"
  },
  "limit": 5
}
```

Export returns `kind: knowledge_export`, `version: 1`, the `snapshot`, and a
Markdown projection when requested. `format: json` is the default. It includes
source episode text, conditions, supporting/counterevidence, provenance and a
paged revision record. `revision` selects an exact version; `afterRevision`
pages history using `snapshot.nextRevision`. It never writes arbitrary server
files or invokes a model. Escaped Markdown and JSON remain untrusted data, not
instructions. Truncation and missing references stay explicit; inspect referenced
IDs for details rather than treating an incomplete projection as a complete audit.

## Bounds and Deliberate Limits

There are at most eight distinct direct evidence references and eight assumptions per
document. Chains need positive observation support; principles need 2..8 distinct
accepted chain revisions. Claim, conclusion, and
applicability are each limited to 2048 bytes; rationale is 4096 bytes; individual
assumptions/reasons are 1024 bytes. The serialized document is at most 32 KiB.
Search and history limits are 1..10; complete responses remain capped at 512 KiB.
The optional compact view has a separate 32 KiB cap. Lower the history/search
limit if the response would exceed its cap. Omitted view and diagnostics preserve
the existing full response shape.

Formation sources and knowledge relevance inputs are each capped at 128 KiB;
formation returns at most three candidate documents. Source detail expansion
shares 32 KiB per inspection or combined knowledge result. No payload is silently
cut into misleading partial text; omitted fields retain references and flags.

Kind, normalized claim and applicability are unique among nonretired current records
in a scope. This catches exact normalized duplicates, not semantic equivalence.
Distinct evidence references do not establish independence, and the system does
not infer confidence from counts, links, agent IDs, or repeated reads.

Chain evidence is observation-only; principles reference chains, never other
principles. Doctrine is an explicitly adopted policy concept, not an automatic
confidence tier. No autonomous formation triggers, source deletion, automatic
acceptance, consolidation worker, coordination system or client UI is introduced.
Protocol and failure tests do not establish model reasoning quality, calibrated
confidence, a compression ratio, or measured improvements in agent learning.
