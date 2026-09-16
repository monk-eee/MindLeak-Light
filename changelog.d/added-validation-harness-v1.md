- Add a JSON-reporting validation harness for persistence, extraction, recall,
  agent handoff, corpus growth, poisoning, corrections, compression, coding,
  and resumable multi-day observations, reusing the existing scoring helpers.
- Add opt-in fresh-context agent comparisons and a container-isolated bug
  rediscovery demo, with actual test/tool/time measurements and provider-reported
  token usage. Failures and unmeasured outcomes remain explicit; no performance
  reduction or real-world accuracy is assumed.
- Emit chart-ready scale data and optional rendered graphs, record executable
  and scenario provenance, and integrate deterministic harness tests into CI.
