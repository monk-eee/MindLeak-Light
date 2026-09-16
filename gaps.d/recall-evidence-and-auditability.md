# Recall Evidence and Auditability Gaps

These remain open in v0.3.0; response bounds do not establish evidence completeness.

- Direct links are ordered by relationship type and related ID before the
  eight-link limit. Enough confirmations can crowd out a contradiction even
  while the primary is marked disputed. Prioritize decisive contrary/history
  context and design a bounded follow-up read without suppressing useful negative
  evidence. Current `relationshipCount` and `relationshipsTruncated` only expose
  omission, not the missing source.
- Exact `count(*) OVER()` totals inspect eligible links before the per-result
  limit. High-degree facts can therefore cause work disproportionate to output.
  Measure this workload and choose an explicit exact/count-capped policy before
  claiming scalable bounded recall; no production capacity figure is established.
- Exact raw source text is retained in `memories`, but recall exposes fragments
  and context, not a bounded memory-ID/original-source fetch. Agents cannot audit
  extraction against original wording through the three tools without another
  access path. Consider bounded source retrieval within `recall_memory`, keeping
  the existing trust boundary and response limits explicit.

The relevant implementation is [final recall](../crates/mindleak-storage-postgres/src/lifecycle.rs)
and the [MCP contract](../crates/mindleak-mcp/src/lib.rs). The optional selector's
direct-answer versus useful-negative-evidence policy is tracked in the
[relevance gap](recall-relevance-and-semantic-evaluation.md). No recursive graph,
unbounded context, or implicit truth adjudication is proposed.
