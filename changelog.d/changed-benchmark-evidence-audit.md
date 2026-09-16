- Emit benchmark report v5 with a planned-query manifest and exact query hashes,
  and reject incomplete new comparison or calibration evidence. Add original
  dataset/background audits that detect shared missing queries and changed labels.
- Measure UTF-8 JSON result-array bytes, including related context and escaping,
  alongside primary-fragment text size. Add per-pass size distributions and
  all-pass byte-budget gates that fail closed on missing legacy measurements.
- Require runtime changes to be declared in paired comparisons and expose audit
  flags distinguishing checked provenance from unavailable legacy data. Preserve
  existing gold corpora and first-pass quality semantics.
