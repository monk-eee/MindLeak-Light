# ADR-0023: Agent Learning Context and Observable Retrieval

- Status: Accepted
- Date: 2026-09-17

## Context

The v0.7.0 thesis is whether agents can form memory chains from verified work and
build on that knowledge across tasks. ADR-0022 supplies explicit observation,
chain and principle contracts. Formation, correct later reuse and net benefit
remain separate claims; memory calls or revision counts alone do not prove them.

Full knowledge results repeat source documents and validation details when an
agent first needs the conclusion, its conditions and known exceptions. An enabled
extraction model can also be mistaken for semantic retrieval. Strict English
websearch can miss punctuation-sensitive identifiers or reject a useful result
when one extra term is absent. Silent broadening would conceal that distinction.

## Decision

Add opt-in controls inside the existing MCP tools, targeting unreleased v0.7.0.
Keep the three tools/tables, persisted data, ordinary defaults, full knowledge
response shape, vectors, scores, lifecycle and retry receipts unchanged.

- Capability discovery is local metadata from the configured abstractions.
  Agent-authored chains/principles do not require a formation model. Report
  extraction, formation-preview and actual keyword/vector/hybrid capabilities
  separately; custom implementations default to unknown/custom. This is neither
  a health check nor authorization.
- Compact knowledge is a deterministic projection after normal eligibility and
  snapshot checks, not a model summary. Keep complete conclusions, applicability,
  assumptions, direct/inherited counterexample IDs and distinct reasons, revision
  and review metadata, author/scope and original scores. Keep source details and
  validation/history behind exact inspection. Never infer changed revisions from
  missing data or advertise unavailable evidence as resolved.
- Cap compact JSON at 32 KiB including diagnostics. Reject overflow rather than
  silently omit results or shorten conditions/counterevidence. Existing internal
  hydration bounds remain; no database-work reduction is promised.
- Reuse the ordinary PostgreSQL keyword parser for chain/knowledge search.
  Websearch stays the default; all/any are explicit and unsupported in vector-only
  mode. Query diagnostics show the parser actually used. Never broaden silently
  or bypass scope, relevance selection or the semantic similarity floor.
- Optional successful-search diagnostics report retrieval time, structured JSON
  bytes and request-local embedding/relevance provider usage. Preserve missing
  values as null. Count shared cached query work only in its initializing call;
  cache hits/waiters incur no new embedding request. An uninstrumented provider's
  total request count is unknown. Do not infer prices or total agent/formation
  costs, persist telemetry, or log source/provider content. Failures stay errors.
- Guide explicitly selected learning workflows through verified observations,
  proposals, actual validation, conditional reuse, challenge and revision.
  Principles still require accepted chain revisions and preserved counterevidence.
  No autonomous trigger, automatic acceptance, feedback from recall, revision
  quota, client permission change or lab-specific policy is introduced.

## Consequences

Agents can inspect actual capabilities and consume a smaller learning context
without losing the conditions that constrain a conclusion. Explicit matching and
diagnostics make misses and costs observable, not proof of semantic relevance.
The optional diagnostics add serialization and, when requested, parser-query work.
No result cache or new database migration is needed.

Published v0.6.0 clients/calls continue to work against the extended server; new
controls require schema discovery and are not in the v0.6.0 release. The companion
skill versions new recipes separately from existing calls and retains the chosen
memory mode and approvals. Smaller responses are not evidence of autonomous
formation quality, avoided investigation, lower total cost or compounding gains.

## Verification

- MCP default/extended input and handshake tests preserve legacy behavior and
  expose agent authoring independently of optional models.
- Real PostgreSQL tests reproduce punctuation/restrictive-query misses and
  explicit all/any behavior without weakening filters or changing vector scores.
- Compact tests retain absent and inherited counterexamples, scopes, conditions,
  revision/review reasons and exact escaped-byte budgets; overflow fails.
- Actual MCP workflows cover agent-authored and model-assisted formation,
  validation, later revision and dependency review, unchanged ordinary recall,
  provider failures, cache/coalescing attribution and relevance usage.
- Request-local unit tests cover concurrency, cancellation, unknown usage,
  diagnostics opt-out and self-inclusive serialized byte accounting.
- Existing fresh-session recipe and native resource tests cover the shipped
  skill; `make ci` remains required. These are contract checks, not an autonomous
  agent-learning experiment or a production performance claim.
