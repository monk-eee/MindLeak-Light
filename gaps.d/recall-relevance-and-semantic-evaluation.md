# Relevance Rejection Still Trades Away Useful Facts

## Current Status

**Open quality gap, not a missing API.** A fresh September 17 knowledge benchmark
now covers chains/principles, exact lineage, challenge/revision, dependency review,
export and optional real-model formation. The provider schema gap found by that
run is fixed and regression-tested; the later four-preview GLM run completed.
Full evidence and commands are in [current results](../docs/BENCHMARK-RESULTS.md#knowledge-workflow-2026-09-17).

Unfiltered Nomic hybrid found the relevant principle/evidence bundle on all 12
positive probes, but rejected 0/6 missing-detail queries. Keyword rejected 6/6
and missed paraphrased positives. Formation took about 57 to 71 seconds per preview.
Exact citations still do not establish reasoning quality. These measurements do
not close the historical semantic rejection trade-off described below.

To close the remaining gap: declare a recall/abstention and latency target, freeze
a fresh independently reviewed holdout before tuning, and report per-query losses,
counterevidence preservation and failed calls. Do not tune the exposed fixtures
until a preferred percentage appears. Model confidence is not an acceptance gate.

## Historical Evidence

- Observed on 2026-09-16 in `engineering-recall-v2`: a Nomic cosine floor selected
  solely on calibration rejected 30/32 held-out negative queries, but verified
  Recall@5 fell from 92.86% unfiltered to 75.00% vector or 76.79% hybrid. The
  configurable gate is implemented; high-recall rejection is not solved.
- `VectorMemoryRetriever` and `HybridMemoryRetriever` use cosine/rank
  signals, not a semantic relevance verifier. An optional bounded evidence-selector
  stage is now implemented, but local model experiments have not established a
  reliable speed/accuracy improvement. Keep it off in the fast profile. GLM with
  disabled reasoning completed but made poor rejection decisions; normal reasoning
  was slow, and a full run failed. A smaller Qwen run also failed. See the recorded
  experiment before choosing another model or making quality claims.
- The benchmark now separates source hits from verified facts, but canonical
  wording plus reviewed variants undercounts unseen valid paraphrases. The GLM
  extraction run had six unverified fragments. Independent semantic review and
  fresh, broader extraction cases remain needed before claims of factual accuracy.
- The current source fixes the direct-answer-only policy: the selector permits
  useful negative/corrective claims and explicit unknowns, with a separate
  [policy regression corpus](../examples/fixtures/recall-evidence-v1.json).
  Historical labels/results are unchanged. Independent evaluation of this revised
  policy remains open; prompt and scoring regressions are not model accuracy.
- Fast-path caching and concurrent hybrid lookup reduce repeat-query latency
  without changing scores. Source-grounded extraction improved accepted-variant
  coverage from 75% to 87.5% on eight fresh cases, not an independent semantic
  accuracy estimate. Further tuning needs new holdouts: v2 and v3 are exposed.
- Evidence and limitations: [experiment](../docs/BENCHMARK-RESULTS.md) and
  [methodology](../docs/BENCHMARKS.md). Exact evidence presence does not prove
  relevance. No automatic contradiction resolution or complete extraction
  guarantee is claimed.
