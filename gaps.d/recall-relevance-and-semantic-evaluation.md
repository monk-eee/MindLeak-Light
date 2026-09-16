# Relevance Rejection Still Trades Away Useful Facts

- Observed on 2026-09-16 in `engineering-recall-v2`: a Nomic cosine floor selected
  solely on calibration rejected 30/32 held-out negative queries, but verified
  Recall@5 fell from 92.86% unfiltered to 75.00% vector or 76.79% hybrid. The
  configurable gate is implemented; high-recall rejection is not solved.
- `PostgresMemoryStore::search` and `HybridMemoryRetriever` use cosine/rank
  signals. The opt-in `OpenAiRelevanceRetriever` now adds bounded selection with
  exact candidate quotations, but source membership alone cannot prove relevance.
  Its useful-recall/rejection trade-off still needs evaluation on new holdouts;
  do not tune against the now-exposed v2 evaluation queries.
- The benchmark now separates source hits from verified facts, but canonical
  wording plus reviewed variants undercounts unseen valid paraphrases. The GLM
  extraction run had six unverified fragments. Independent semantic review and
  fresh, broader extraction cases remain needed before claims of factual accuracy.
- Evidence and limitations: [experiment](../docs/BENCHMARK-RESULTS.md) and
  [methodology](../docs/BENCHMARKS.md). No independently validated relevance
  guarantee, automatic contradiction resolution, or complete extraction guarantee
  is claimed. Keep this gap open while those evaluation limits remain.
