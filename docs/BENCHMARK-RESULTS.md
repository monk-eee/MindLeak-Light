# Recall Quality Experiment: 2026-09-16

These are local diagnostic measurements, not production accuracy estimates.
Follow the [benchmark guide](BENCHMARKS.md) to reproduce the procedure. The
corpus was frozen before calibration and evaluation; labels and the floor were
not adjusted after viewing held-out results.

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

### Corpus File Normalization

Commit-preparation hooks added one missing final newline to each new corpus.
Parsed JSON, text, labels, and ordering were verified identical before and after
this byte-only change. Original report hashes and measurements remain unchanged;
new runs use the normalized file hashes below. This is not a new evaluation or
a change to the acceptance set.

| Corpus | Original SHA-256 | Normalized SHA-256 |
|---|---|---|
| v2 | `f761c717e9de75137c0a7df37601d7daf3ee515609585424799788681eddba68` | `e3ab91ff9a27187d024458b9659f48689c34c9414508680f209fe1543289105d` |
| v3 holdout | `d4ef0b9cc0240e1f43bd4f316ed169a1ea027f6e96581c91bd02df4b7a38d94d` | `6d89a74960b3422998d4033ca31cc79a6f928f27c0807aac228dd45a67b8802c` |

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
