- Share successful embedding calculations across overlapping vector/hybrid
  recalls of the same exact query, using bounded async-initialized cache slots.
  Preserve per-call database reads, provenance/context filters, and original
  retrieval scores; keep model-free defaults unchanged.
- Cover concurrent agent-filtered recalls, independent query strings,
  cancellation handoff, and failed or invalid initializer recovery without
  caching errors or introducing an internal retry loop.
