- Compare PR candidates against a checksum-pinned v0.4.0 native release using
  frozen engineering and useful-negative corpora, independent test databases,
  per-query regression checks, and response-size limits. Retain reports on failure.
- Add an opt-in per-query failure gate to the benchmark comparator, alongside
  existing macro quality and byte-budget checks. Catch failures on every executed
  pass without counting repeated queries as new accuracy evidence.
- Require a v0.4.0 container upgrade and real backup restoration into a fresh
  volume. Add a separately dispatched model-free load report; timing thresholds
  and model-backed runs remain explicit controlled-host opt-ins.
- Reject encoded aliases of the same test database, enforce subprocess deadlines,
  and attempt all owned container cleanups while preserving the original failure.
