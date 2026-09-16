- Score headline recall quality on distinct first-pass queries instead of
  inflating the sample with repeat passes. Keep per-pass quality and latency.
- Add offline paired comparisons with declared configuration changes, corpus
  and query integrity checks, grouped bootstrap intervals, per-query/category
  regressions, and observed quality-loss gates.
- Add bounded concurrent recall workloads, reproducible per-pass query ordering,
  throughput and tail-latency reporting, and executable snapshots tied to the
  reported binary hash. Emit report version 4 with workload/runtime provenance.
- Require full fifty-candidate captures for cosine calibration at a separate
  deployment cutoff, and reject calibration/evaluation target or family leakage.
