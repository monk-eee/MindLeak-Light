# Recall Quality Experiment: 2026-09-16

These are historical local diagnostic measurements, not production accuracy
estimates. See the [benchmark guide](BENCHMARKS.md) for the current procedure. The
corpus was frozen before calibration and evaluation; labels and the floor were
not adjusted after viewing held-out results.

The experiment used report version 3 and the then-current calibration heuristic,
which filtered a saved top-five ranking. That heuristic could not account for
lower-ranked candidates refilling results after filtering. The current calibrator
requires all fifty bounded candidates and scores a separate deployment cutoff.
The measurements and selected threshold below remain the original record, not
results from the corrected calibration procedure. New evaluation needs a fresh
capture and an unexposed holdout; do not retune these historical results.

## Experiment Identity

- Corpus: `engineering-recall-v2`, 240 memories, 266 gold facts, 176 queries.
- Corpus SHA-256: `f761c717e9de75137c0a7df37601d7daf3ee515609585424799788681eddba68`.
- Native binary SHA-256: `56973a7710e1a957c204fb93502f098457d0a6dee6e46f325d65a818ff695967`.
- Report version: 3; scoring: `verified-fact-variants`; cutoff: 5.
- Embeddings: local Ollama `nomic-embed-text:latest`, 768 dimensions.
- Decomposition for all recall runs: deterministic sentences/lists.
- Each split: 88 queries, 56 answerable and 32 unanswerable; disjoint gold targets.
- PostgreSQL: disposable `_test` database, fresh agent namespace per run.

The model weights/provider version were not captured, so the model name does
not guarantee exact reproducibility on a different installation. Each retrieval
configuration below was run once; no confidence intervals or repeat-run
stability claims are made. Query families are correlated and per-category
samples are small.

## Calibration

Unfiltered calibration vector recall was 89.29% verified Recall@5, with 0/32
negative questions rejected. A declared calibration recall floor of 0.80 selected
cosine threshold **0.78604096524586**, yielding 80.36% verified Recall@5 and 30/32
negative queries rejected on calibration. The selection then remained fixed.
It is not a recommended universal default and was not tuned on evaluation.

## Held-Out Recall

| Mode | Verified Recall@5 | Source Recall@5 | MRR@5 | No-Answer Accuracy | Recall p95 |
|---|---|---|---|---|---|
| Keyword | 5.36% | 5.36% | 0.0536 | 32/32 | 4.4 ms |
| Vector, unfiltered | 92.86% | 100% | 0.8973 | 0/32 | 33.3 ms |
| Hybrid, unfiltered | 92.86% | 100% | 0.8973 | 0/32 | 36.9 ms |
| Vector, calibrated floor | 75.00% | 79.46% | 0.7679 | 30/32 | 41.5 ms |
| Hybrid, same floor | 76.79% | 81.25% | 0.7857 | 30/32 | 50.0 ms |

The floor improves abstention substantially but loses useful facts. Its 80%
calibration recall constraint did not transfer to evaluation. Hybrid recovered
one additional answerable query through its keyword branch without introducing
an additional negative hit in this run. That is a small observed benefit, not
evidence that hybrid wins generally. Unfiltered hybrid matched vector here.

Keyword mode is intended for concise terms, while this corpus deliberately
includes conversational questions and restrictive multi-term phrases. Its low
score is an observation about these exact queries, not a general full-text
search benchmark. The original small v1 keyword run is a different workload and
scoring contract and must not be used as a directly comparable percentage.

The source/verified gap exposes missing standalone facts: a retrieved paragraph
or pronoun-only fragment can name the right source without expressing the gold
fact independently. Higher source recall does not establish correct extraction.

## Independent Extraction

The separate preview-only run evaluated twelve held-out multi-fact passages
containing 25 gold facts. No benchmark memories were written by these runs.

| Decomposition | Macro Verified-Fact Recall | Macro Verified-Fragment Precision | Unverified Fragments | Unmatched Gold Facts | Mean Request Time |
|---|---|---|---|---|---|
| Sentences/lists | 83.33% | 83.33% | 3 | 4 | 0.57 ms |
| GLM 4.7 Flash, local Ollama | 83.33% | 83.33% | 6 | 4 | 37.54 s |

GLM used `glm-4.7-flash:latest` with a 120-second provider timeout. It completed
all twelve cases. It matched both compound-claim facts where sentence mode
matched neither; its exception case returned four unverified fragments instead
of the two canonical facts. Both modes had unmatched standalone facts for the
coreference and ambiguous-actor passages. One case per risk is not a model
accuracy estimate. Unverified output may be a valid unseen paraphrase; these
results were not independently semantically adjudicated and are not proof of
hallucination or lost meaning.

Hashes of unmatched outputs permit later identification, not reconstruction.
Further semantic evaluation needs trusted local review of source and output,
with qualifier checks and a newly versioned acceptance set. Do not silently add
variants from these evaluation outputs and keep calling the scores held out.

## Evidence and Follow-Up

Full local reports were retained under `target/recall-v2-*.json`: calibration,
threshold candidates, five retrieval configurations, and two extraction runs.
They are ignored runtime outputs, not committed fixture data. Their regeneration
commands are in the guide. The corpus, scoring tests, and methodology are tracked.

The demonstrated fixes are the configurable rejection mechanism, bounded hybrid
retrieval, and the benchmark's removal of source-ID false credit. Remaining work
is better relevance discrimination at useful recall, broader independently
reviewed gold variants, and domain-specific fresh holdouts. Do not increase the
floor until a desired percentage appears on the exposed evaluation set.

## Fast Recall Follow-Up

The user subsequently prioritized fast default recall while allowing explicit
model opt-ins for quality. A bounded query-embedding cache and concurrent hybrid
lookup were measured with the same v2 corpus, the unchanged 0.78604096524586
floor, no chat filter, and three passes over its 88 evaluation queries. Each run
wrote 240 memories once; subsequent passes reread PostgreSQL but reused query
vectors. Models had already been used during ingestion, so first-pass latency
is a query-cache miss measurement, not a model-load measurement.

| Hybrid Recall | Pass 1 p95 | Pass 2 p95 | Pass 3 p95 |
|---|---|---|---|
| Before caching/concurrency | 50.62 ms | 61.57 ms | 76.09 ms |
| After caching/concurrency | 45.68 ms | 6.29 ms | 4.91 ms |

Ranking summaries were exactly equal before/after and across passes: verified
Recall@5 76.79%, MRR@5 0.7857, no-answer accuracy 30/32. The 20 ms warm-p95 gate
passed. These are sequential local measurements, not concurrent-load or large
database guarantees. Correctness tests separately verify fresh inserts/deletes,
agent filters, cache eviction, and retries after failed/invalid embeddings.

- Before binary: `4439836664b1c6cf5c20594d5568f1c836f32f9767ef20308edbc275fb7d6921`.
- After binary: `5239afcaf2388d706d8a3b9a20d3a79d35fad57a0aa4f0aca15e2d1357a26124`.
- Local reports: `target/recall-fast-before.json` and `target/recall-fast-after.json`.
- Reproduce with the runner's `--passes 3 --max-warm-p95-ms 20` options and the
	same model, corpus, cutoff, and explicit `--binary` snapshots.

## Optional Model Follow-Up

The [v3 fixture](../examples/fixtures/recall-v3-holdout.json) introduced fresh
query targets and eight separate extraction passages, using v2 only as background
memories. Its 32 query results were subsequently inspected for development, so
v3 is now exposed and cannot serve as a new unbiased holdout for further tuning.

Ollama was version 0.32.9. Observed model digests were:

- Nomic: `0a109f422b47e3a30ba2b10eca18548e944e8a23073ee3f3e947efcf3c45e59f`.
- GLM 4.7 Flash: `4475827791a269b02c8ec49b1c3bc1abb5846bacf3fae015b75d33986322d8f6`.

With 272 memories and 32 fresh queries, unfiltered hybrid recalled all 16
answers but rejected none of 16 missing-detail questions. The previous fixed
floor retained all answers and rejected 13/16. Initial baseline binaries changed
under a concurrent build; those reports were retained as non-comparable and
replaced with matching-snapshot runs.

The full GLM index-only relevance run failed during recall and produced no
valid report. A single read-only negative-query probe succeeded in 60 seconds.
Explicit `reasoning_effort:none` completed the full run at mean 0.94 seconds but
rejected only 4/16 negative queries. Adding exact-evidence quotations tightened
the response contract but, on the now-exposed development set, disabled-reasoning
GLM rejected only 1/16 negatives at mean 3.61 seconds. Neither profile is a
recommended accuracy improvement. Normal reasoning with five candidates answered
four exposed development probes correctly but took 49..91 seconds per query.
A smaller local Qwen 2.5 3B experiment failed at `h3-n16`; it has no complete
accuracy report. Failed generation is not counted as correct abstention.

For extraction, both saved before/after binaries were evaluated on all eight
fresh passages using GLM and the identical `reasoning_effort:none` request option.
A temporary local test adapter set that field on both requests because the older
binary predated the option; no output text or provider body was logged.

| Extraction | Verified-Fact Coverage | Unverified Fragments | Unmatched Gold Facts |
|---|---|---|---|
| Sentence/list baseline | 62.5% | 4 | 6 |
| Previous extraction prompt | 75.0% | 4 | 4 |
| Source-grounded prompt | 87.5% | 2 | 2 |

Before/after prompt reports are `target/recall-v3-extraction-before-none.json`
and `target/recall-v3-extraction-after-none.json`. Binary hashes are respectively
`3df50ec843d2163d2fd378480b2efdbe643845fbc3d1ebcd97e16dbf26e92d79` and
`79db201fbe9b46955d93824e8f99a817fa335b960d1a3396b93d92647f33acde`.
Mean times were 2.24 and 1.40 seconds, with a cold request included in the former;
do not attribute that timing difference solely to the prompt. Accepted variants
were fixed beforehand. The observed coverage gain is not independently adjudicated
semantic accuracy, and eight cases cannot establish general model quality.

The supported fast profile keeps relevance selection off. Model-based extraction
is a separate write-time quality option; recall-time selection remains experimental.
An exact evidence quote verifies source presence, not that it answers the question.
