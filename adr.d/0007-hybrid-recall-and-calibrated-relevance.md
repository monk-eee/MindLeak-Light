# ADR-0007: Hybrid Recall and Calibrated Relevance

- Status: Accepted
- Date: 2026-09-16

## Context

Unfiltered nearest-neighbour recall always returns candidates when vectors exist,
including for questions the corpus cannot answer. Keyword recall preserves exact
matches and unembedded memories but struggles with conversational paraphrases.
A 24-memory source-ID benchmark hid these differences and could credit an
incorrect fragment merely because it came from the right paragraph.

## Decision

Keep the model-free keyword default and the existing three tools and tables.
Add an optional finite cosine floor, `MINDLEAK_RECALL_MIN_SIMILARITY` in [-1, 1],
applied inside vector SQL before limiting results. No universal nontrivial floor
is chosen. Unset (or -1) retains the existing unfiltered behaviour.

Add `MINDLEAK_RETRIEVAL=hybrid` behind `MemoryRetriever`. Query at most fifty
vector and fifty keyword candidates with the agent filter applied to both. Fuse
by fragment ID using equal-weight reciprocal rank fusion with constant 60,
normalized by the maximum two-list score. Break ties by fragment UUID and limit
after fusion. Keep distinct facts from the same source. Keyword candidates can
include unembedded fragments and are not subject to a cosine test they cannot
satisfy. A failed enabled provider remains an error, not keyword-only success.

Calibrate floors offline on explicitly labelled calibration queries. Freeze the
floor before evaluating disjoint targets; record the model, dimensions, corpus
hash, binary hash, result limit, scores, and executed query IDs. Threshold
selection maximizes no-answer accuracy subject to a declared verified-recall
floor, breaking ties by recall, MRR, then the lower threshold. Fused scores must
never be calibrated as cosine similarities.

Use a risk-oriented benchmark corpus with near-match projects, missing answers,
and multi-fact passages. Main recall metrics credit a gold fact only when the
returned fragment matches its reviewed canonical wording or accepted variant.
Retain source-ID recall separately. Independently score decomposition previews
for gold-fact coverage, verified fragment precision, duplicates, and unverified
outputs. Neither source identity nor JSON validity proves factual faithfulness.

## Consequences

A higher floor trades recall for rejection and may not transfer between models,
domains, or datasets. Cosine and normalized fusion scores are ranking signals,
not confidence probabilities. Hybrid adds a keyword database query and cannot
guarantee relevance or improve every query. No reranker, graph traversal, decay,
new table, new MCP tool, or chat dependency is introduced.

Conservative gold matching undercounts valid unseen paraphrases; report these as
unverified rather than false. Human review and separately versioned accepted
variants remain necessary for semantic claims. Sentence splitting deliberately
does not resolve pronouns or split every compound claim. The benchmark is a
diagnostic suite, not a claim of population accuracy or superiority over another
product. Historical contradictions remain data; this change does not implement
automatic supersession or truth adjudication.

## Verification

The real stdio relevance-floor regression failed before the fix and passed after
it. Unit and PostgreSQL tests cover inclusive thresholds, non-finite settings,
fusion overlap/ties/limits, unembedded keyword matches, provenance filters, and
provider failure. Benchmark regressions reject wrong quantities and altered
identifier casing despite correct source IDs, and reject calibration leakage.
The corpus validates distinct memories and disjoint calibration/evaluation gold
targets. Run `make ci` against a disposable `_test` database and the documented
model-backed calibration/evaluation commands; report losses as well as gains.
