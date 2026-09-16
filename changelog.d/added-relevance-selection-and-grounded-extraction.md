- Add optional bounded model-based relevance selection after existing recall,
  preserving stored fragments and surfacing inference failures instead of
    treating them as abstention. Require exact source quotations for selections;
    keep model-free defaults unchanged and do not treat quotations as proof of truth.
- Refine source-grounded extraction instructions to preserve wording,
  references, conditions, and qualifiers. Add fresh held-out retrieval and
  extraction comparisons with background-only distractor corpora and explicit
  relevance-model configuration in benchmark reports.
- Add independent opt-in reasoning-effort settings for the decomposition and
    relevance providers, including Compose forwarding with unchanged defaults.
