- Add optional bounded model-based relevance selection after existing recall,
  preserving stored fragments and surfacing inference failures instead of
  treating them as abstention. Keep model-free defaults unchanged.
- Refine source-grounded extraction instructions to preserve wording,
  references, conditions, and qualifiers. Add fresh held-out retrieval and
  extraction comparisons with background-only distractor corpora and explicit
  relevance-model configuration in benchmark reports.
