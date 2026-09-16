# Recall and Extraction Benchmarks

The [runner](../examples/benchmark-recall.mjs) tests real MCP write/recall and
decomposition-preview calls through the official SDK. It distinguishes source
retrieval from verified fact retrieval: the right memory ID does not earn fact
credit for a fragment that changes a number or drops a qualifier. Gold labels
and accepted variants are never sent to the server. There is no LLM judge.

This guide describes the **unreleased v2 corpus and report-version-3 runner**.
Build source containing the new retrieval modes before using hybrid or similarity
thresholds; v0.1.0 packages predate those controls. See [installation](INSTALL.md)
for availability and [recorded results](BENCHMARK-RESULTS.md) for the measured
improvements and remaining limitations. The older v1 source-ID scores are not
directly comparable with the current fact-level scores.

## Run the Baseline

Requirements: Node.js 22+, a native Rust build, and a disposable PostgreSQL
database. The database name must end in `_test`. Use a separate benchmark database
from the integration suite, which fixes its embedding space to `test-model`.

From the repository root:

```sh
cargo build --workspace --locked
npm ci --prefix examples
docker compose exec postgres createdb -U mindleak_light mindleak_recall_test
export MINDLEAK_TEST_DATABASE_URL='postgresql://mindleak_light:mindleak-light-development-only@127.0.0.1:55432/mindleak_recall_test?sslmode=disable'
node examples/benchmark-recall.mjs --label keyword-baseline > target/recall-keyword.json
```

Replace `docker compose` with `podman compose` when appropriate. The example URL
uses the public local-development password; match your actual test instance.
Database URLs accept only `sslmode` and `connect_timeout` query parameters, so a
query parameter cannot override the validated database name. Use
`MINDLEAK_DATABASE_CA_FILE` when your database needs a custom TLS CA.

The runner starts its own stdio MCP server. It does not contact the running HTTP
server or load the workspace `.env`. The default is explicitly sentence/list
decomposition and keyword retrieval, even if your shell normally enables models.
`--binary PATH` selects another native executable. `--help` lists all options.

Each recall invocation gets a unique `agentId`, used on every write and recall. Records
remain in the disposable database because there is no delete tool. Remove that
database when finished, after checking its name; the benchmark never deletes
database contents itself. A failed run may leave its already-written records.
Extraction-only runs preview facts without writing memories.

JSON goes to stdout; progress and sanitized errors go to stderr. Invoke `node`
directly when capturing JSON: npm may add script banners to redirected stdout.
Reports contain corpus IDs, source/fact rankings, scores, missed IDs, category summaries,
configuration, server version, and corpus/binary SHA-256 hashes, not memory text,
query text, database URLs, API keys, or provider responses. Choose non-sensitive
corpus IDs and run labels. Child-server stderr is suppressed to avoid leaking
connection details; diagnose startup failures separately with the normal server.

## Compare Retrieval Modes

For vector recall, explicitly export the provider settings described in
[Optional Models](MODELS.md), then run the identical corpus and cutoff:

```sh
export MINDLEAK_EMBED_URL='http://localhost:1234/v1'
export MINDLEAK_EMBED_MODEL='your-embedding-model'
export MINDLEAK_EMBED_DIMENSIONS='768'
node examples/benchmark-recall.mjs --retrieval vector --label vector-baseline > target/recall-vector.json
```

Set `MINDLEAK_EMBED_API_KEY` separately if required. `--decomposition openai`
independently enables chat extraction and requires explicit `MINDLEAK_LLM_URL`,
`MINDLEAK_MODEL`, and, when needed, `MINDLEAK_LLM_API_KEY`. Enabled inference can
incur provider charges. `MINDLEAK_MODEL_TIMEOUT_SECS` controls provider timeouts.

The runner re-ingests the corpus for every run, including generating embeddings.
Model-free records from previous runs cannot enter the new run's recall results.
Never change embedding models or dimensions in an already-bound database; create
a different `*_test` database for each embedding model. Record the actual model
weights and provider version separately: a model name does not identify weights.

Compare reports with the same dataset hash and `limit`. Changing extraction and
retrieval together confounds their effects; start by changing one at a time.
Repeat model-backed runs to assess variability. Binary hashes identify different
builds but do not replace a record of the tested source revision.

`--retrieval hybrid` combines at most fifty keyword and fifty vector candidates
by reciprocal rank fusion. It includes unembedded keyword matches. Neither mode
makes chat extraction mandatory; enabled provider errors are never hidden behind
a different retrieval mode. Hybrid scores are fused ranks, not cosine values.

## Calibrate Without Evaluation Leakage

The default split is `evaluation`. First run **only calibration** with unfiltered
vectors, declaring the desired recall trade-off before viewing scores:

```sh
node examples/benchmark-recall.mjs --retrieval vector --split calibration > target/calibration.json
node examples/benchmark-recall.mjs --calibrate target/calibration.json --calibration-min-recall 0.8 > target/threshold.json
```

The offline calibrator accepts only calibration-split unfiltered vector reports.
It rejects evaluation queries, fused hybrid scores, and already-filtered runs.
It selects score-gap midpoints to maximize no-answer accuracy subject to the
declared verified-recall floor, then prefers higher recall/MRR and a lower floor.
All candidate thresholds, model metadata, corpus/binary hashes, and calibration
query IDs are recorded. The 0.8 floor is an example, not a universal target.

Read `minSimilarity` from the result, freeze it, and compare evaluation runs:

```sh
node examples/benchmark-recall.mjs --retrieval vector > target/vector-unfiltered.json
node examples/benchmark-recall.mjs --retrieval hybrid > target/hybrid-unfiltered.json
export RECALL_FLOOR='your-calibration-result'
node examples/benchmark-recall.mjs --retrieval vector --min-similarity "$RECALL_FLOOR" > target/vector-filtered.json
node examples/benchmark-recall.mjs --retrieval hybrid --min-similarity "$RECALL_FLOOR" > target/hybrid-filtered.json
```

`--min-similarity` explicitly sets `MINDLEAK_RECALL_MIN_SIMILARITY` for the child;
an inherited floor is ignored. Unset/-1 means unfiltered. Hybrid applies the floor
to semantic candidates only; keyword hits can remain without vectors or below
the floor. The selected value is model/corpus specific, not truth confidence.
It can lower useful recall and its calibration score may not transfer to evaluation.

Compare matching dataset hash, scoring version, split, and k. Never adjust a floor
against evaluation results. Version any labels or accepted variants changed after
seeing output and disclose that the old holdout was exposed. Further tuning needs
fresh holdout queries. Record model weights/provider version separately: model
names alone do not pin the inference implementation.

## Corpus and Metrics

The default [v2 corpus](../examples/fixtures/recall-v2.json) contains **240 distinct
memories, 266 gold facts, and 176 queries**. It combines 24 lessons paraphrased
from MindLeak proper's tracked guide/benchmark records, 192 fictional engineering
facts, and 24 multi-fact passages. Source paths, revision, and attribution are
recorded in the fixture. No live-memory database was exported.

Each split has 88 queries: 56 answerable and 32 unanswerable. Query strings and
relevant fact IDs are disjoint. Main project groups differ across splits; edge
cases pair a failure type with different entities and values. All memories are
written in each recall run so other-split memories remain distractors.

The passages provide one calibration and one evaluation case for each risk:

| Risk | What Gold Facts Must Preserve |
|---|---|
| Scope and negation | Production versus staging; local versus remote permission |
| Quantities and units | Milliseconds versus seconds; kilobytes versus megabytes |
| Exceptions | An approval requirement and its precise exception |
| Uncertainty | A suspected cause or proposal, not a confirmed fact |
| Coreference | A known subject carried into the next standalone fact |
| Ambiguous entity | An unnamed actor must not become the named reporter |
| Temporal facts | Old/current values with explicit validity dates |
| Identifiers | Case-sensitive flags and URL paths |
| Lists | Independent facts across bullets and numbered boundaries |
| Repetition | Repeated claims cannot inflate fact coverage |
| Untrusted quotations | Quoted instructions remain data; actual state survives |
| Compound claims | Separate claims joined within one sentence |

Queries also cover keyword phrases, paraphrases, near-match project settings,
multi-answer questions, plausible missing details, and nonsense. Negative labels
mean no fact supplies the requested value. A related fragment stating that an
actor is unknown may help a final agent abstain but does not supply the requested
name. This strict no-answer metric evaluates retrieval, not final hallucination.

`--dataset PATH` accepts `schemaVersion: 1`, a dataset `id`, `memories` with unique
`id`/`text`, and `queries` with `id`, `category`, `split`, `query`, and `relevantIds`.
Atomic memories implicitly define one fact. Multi-fact memories specify `facts`,
each with a unique `id`, canonical `text`, and optional reviewed `variants`; their
`category` and `split` select them for extraction-only runs. Query relevance IDs
refer to facts, not necessarily memory IDs. `[]` means unanswerable.

A fragment earns fact credit only for a canonical/accepted text match within its
returned source. Matching collapses whitespace and ignores one trailing full
stop, preserving case, numbers, negation, question marks, and other punctuation.
A complete paragraph with several correct claims is not a standalone atomic
fact. Unrecognized wording is **unverified**, not automatically false; a valid
unseen paraphrase can score zero. Canonical matching is not semantic adjudication.

The [original v1 corpus](../examples/fixtures/recall-v1.json) remains available via
`--dataset examples/fixtures/recall-v1.json --split all`. Its old source-only
reports are not directly comparable with verified-fact reports.

The main scoring unit is a verified fact at `--k` fragment slots (default 5):

| Metric | Definition |
|---|---|
| Precision@k | Distinct verified relevant facts divided by k, even for a short result list |
| Recall@k | Distinct verified relevant facts divided by all relevant gold facts |
| MRR@k | Mean reciprocal rank of the first verified relevant fact; zero on a miss |
| nDCG@k | Binary relevance discounted by `1 / log2(rank + 1)`, divided by the ideal score |
| Hit Rate@k | Fraction of answerable queries with at least one verified relevant fact |
| No-Answer Accuracy | Fraction of unanswerable queries that return no results |

Ranking metrics are macro averages over answerable queries, not weighted by the
number of relevant memories. Unanswerable queries are excluded from those means;
their abstention score is reported separately. Empty metric populations are
`null`, not zero or perfect. Category reports use the same rules.

`summary` scores verified facts; `sourceSummary` independently scores source IDs.
Per-query results include both, missed fact IDs, unverified ranks, scores, and
timing. Repeated facts earn credit once while occupying result slots, but distinct
facts from one source can each earn credit. There is no deduplicate-and-refill
scoring. A single-relevant-fact query has a maximum Precision@5 of 0.2.

Write/recall mean, p50, and p95 latency include MCP/provider work but exclude
server startup. Cold model loading is not separated from individual requests.
These sequential measurements are not a controlled load benchmark.

## Independent Extraction Evaluation

### Fresh Comparisons

The [v3 holdout](../examples/fixtures/recall-v3-holdout.json) adds fresh entities
and targets after v2 evaluation was exposed. It has 16 answerable queries, 16
matched missing-detail queries, and eight separate multi-fact extraction cases.
Use the old corpus only as background memories, not as a new set of held-out
questions. `--background` validates both corpora and rejects colliding memory or
fact IDs; it never executes the background's queries. Combined corpus hashes
and the hashes of both input files are recorded in reports.

```sh
node examples/benchmark-recall.mjs --dataset examples/fixtures/recall-v3-holdout.json --background examples/fixtures/recall-v2.json --retrieval hybrid > target/v3-unfiltered.json
```

For model-based candidate filtering, explicitly set the relevance provider
variables in [model setup](MODELS.md) and add:

```sh
node examples/benchmark-recall.mjs --dataset examples/fixtures/recall-v3-holdout.json --background examples/fixtures/recall-v2.json --retrieval hybrid --relevance openai --relevance-candidates 20 > target/v3-selected.json
```

This writes 272 memories but executes only the 32 fresh queries. Start without a
cosine floor so the selector can consider lower-similarity answers. The filter
is a model judgment, not a ground-truth judge: scores still use the independently
specified gold labels. `--relevance off` is the benchmark default even if the
running service enables selection. Relevance URL, model, and candidate count
are explicit settings; secrets never enter the report. A selection-enabled
report cannot be used for cosine calibration.

Use `--binary` with a stable executable copy during concurrent builds; reject
configuration comparisons if binary hashes differ. To test an extraction change,
keep both before and after binaries and run the same frozen extraction fixture:

```sh
node examples/benchmark-recall.mjs --binary /path/to/before-binary --dataset examples/fixtures/recall-v3-holdout.json --extraction-only --decomposition openai > target/v3-extraction-before.json
node examples/benchmark-recall.mjs --binary /path/to/after-binary --dataset examples/fixtures/recall-v3-holdout.json --extraction-only --decomposition openai > target/v3-extraction-after.json
```

The extraction path refuses `--background` and relevance-filter flags: it is an
independent preview, not candidate selection. Exact/accepted-variant coverage
alone is not semantic accuracy. Do not change accepted variants to fit observed
holdout outputs. A small fresh holdout can falsify an improvement claim; it cannot
establish population accuracy or model robustness.

### Decomposition Preview

```sh
node examples/benchmark-recall.mjs --extraction-only > target/extraction-sentences.json
node examples/benchmark-recall.mjs --extraction-only --decomposition openai > target/extraction-model.json
```

The model run needs explicit `MINDLEAK_LLM_URL`, `MINDLEAK_MODEL`, and optional
`MINDLEAK_LLM_API_KEY`, but no embedding model. It previews twelve held-out
passages and reports macro verified-fact coverage, verified-fragment precision,
missing gold IDs, duplicates, and hashes of unverified outputs. This separates
extraction from retrieval. Repeat nondeterministic model runs before stability
claims. Do not equate exact-match precision with semantic precision.

For unfamiliar paraphrases, an independent reviewer must inspect source and
output in a trusted local session, checking qualifiers and standalone meaning,
then propose versioned variants. Hashes identify outputs but cannot reconstruct
them or substitute for review. Do not add evaluation-derived variants silently
and continue calling those scores held out.

## Quality Gates

Provider failures, malformed responses, unknown source IDs, and records from
another agent namespace abort the run without a score report. They are not
converted into empty successful recalls. Quality misses are valid measurements
and do not fail the command unless you supply an explicit threshold:

```sh
node examples/benchmark-recall.mjs --k 5 --min-recall 0.8 --min-no-answer 0.9 > target/recall-gate.json
```

Each optional gate checks its own metric. A below-threshold run emits its complete
report and exits nonzero; missing metric populations cannot pass their gates.
Thresholds are illustrative, not claims. Extraction-only mode rejects ranking
gates. Scorer and fixture tests run in `make script-test` and `make ci`; live model
benchmarks are opt-in. `MINDLEAK_MODEL_TIMEOUT_SECS` bounds provider requests;
raising it does not turn a failed run into an accuracy measurement.

## Interpretation Limits

This is a curated English engineering diagnostic suite, not a representative
production distribution or independently adjudicated semantic benchmark. Many
memories are distractors rather than queried targets. One extraction example per
risk per split is small; category percentages are descriptive, not statistical
confidence. Further claims need fresh domain-specific holdouts and independent
label review. Retain negative cases and report losses as well as gains.

The suite does not measure a final agent's answers, memory-use decisions,
multilingual recall, concurrent load, automatic supersession, or an adversarial
security guarantee. Keyword search is expected to struggle with full questions.
Unfiltered vectors always have nearest neighbours, including on missing-answer
queries. A calibrated floor exposes the recall/rejection trade-off rather than
solving it universally. See the [recorded experiment](BENCHMARK-RESULTS.md).

This version runs MindLeak Light through its MCP contract. A comparison with
Bluebird or another system needs an adapter that returns ranked source IDs over
the same corpus and queries, plus equivalent preprocessing and retrieval budgets.
The exported `scoreRanking` and `summarizeQueries` functions can score those
rankings, but no competitor adapter or head-to-head result is included here.
