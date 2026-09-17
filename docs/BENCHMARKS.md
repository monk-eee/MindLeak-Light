# Knowledge Evaluation and Retrieval Benchmarks

MindLeak's product evaluation follows **observations -> Chains of Memory ->
Principles -> later reuse**. Begin with the [learning acceptance criteria](VALIDATION.md#learning-acceptance)
and [knowledge workflow checks](VALIDATION.md#check-chains-and-principles).
The three learning labs test discovery, formation, and reuse against controls.
This guide covers the retrieval/extraction foundation that those workflows need.
A better retrieval score alone does not establish a better agent.

The [runner](../examples/benchmark-recall.mjs) tests real MCP write/recall and
decomposition-preview calls through the official SDK. It distinguishes source
retrieval from verified fact retrieval: the right memory ID does not earn fact
credit for a fragment that changes a number or drops a qualifier. Gold labels
and accepted variants are never sent to the server. There is no LLM judge.

This guide describes the **report-version-5 runner** and **comparison-version-2**
offline audit. The existing corpora and gold labels have not changed. Headline
quality uses the first pass only; repeated passes measure workload/cache behaviour
rather than increasing the quality sample size. Version 3 and 4 reports remain
comparable through first-pass reconstruction, but missing query fingerprints,
planned-population manifests, and byte measurements are reported as unavailable.
See [installation](INSTALL.md) for server feature availability and
[recorded results](BENCHMARK-RESULTS.md) for earlier measurements and limits.
The older v1 source-ID scores are not comparable with current fact-level scores.

## Knowledge Workflow

For the newer chain/principle workflow, use the existing validation harness's
explicit [knowledge benchmark](VALIDATION.md#check-chains-and-principles). It
measures hierarchical retrieval, evidence preservation, dependency review,
revision/export and optional real model formation. It does not change the frozen
legacy recall corpora or give a source match automatic reasoning-quality credit.

## Useful Negative Evidence

Relevance is not restricted to a positive value. A directly relevant prohibition,
explicit unknown, missing prerequisite, or correction to the question's premise
can help an agent act correctly. Use
[recall-evidence-v1.json](../examples/fixtures/recall-evidence-v1.json) to check this
policy with the same runner (`--dataset examples/fixtures/recall-evidence-v1.json`).
It separates direct answers, negative/corrective evidence, explicit unknowns, and
unrelated queries. It is a small exposed policy regression, not a fresh holdout.

The Ilex approved-date query deliberately credits the known unapproved status in
this new fixture. Its historical v3 counterpart required an empty result. Those
old labels and reports remain unchanged and do not measure this revised policy.
Do not improve historical scores by silently changing their gold labels; use
versioned corpora and compare only reports with the same corpus hash.

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
The runner hashes the executable bytes and launches a private temporary copy of
those same bytes. Concurrent builds cannot replace the executable between hashing
and launch. The copy and isolated `.env` are removed when the client closes.

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
Reports also identify the Node version, OS platform, architecture, and available
CPU parallelism. Record machine details and provider/model weights separately;
these fields do not establish identical hardware or pin a provider's weights.

Before ingestion, the runner fingerprints the selected query population in
`querySet`: a count and SHA-256 of query IDs, exact UTF-8 query hashes, categories,
splits, groups, and sorted gold labels. Each observation includes `querySha256`.
Changing query order does not change this population fingerprint; per-pass order
hashes still record the executed schedule. Comparison and calibration check new
reports against this plan, and comparisons require every pass to retain the same
query identities. Hashes are consistency evidence, not signatures or encryption;
short, guessable queries can still be identified by someone testing their hashes.

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
node examples/benchmark-recall.mjs --retrieval vector --split calibration --k 50 > target/calibration.json
node examples/benchmark-recall.mjs --calibrate target/calibration.json --calibration-k 5 --calibration-min-recall 0.8 > target/threshold.json
```

The offline calibrator accepts only calibration-split unfiltered vector reports.
Capture all fifty bounded candidates with `--k 50`; `--calibration-k` is the
deployment result cutoff, default 5. Filtering a saved top-five list cannot
simulate lower-ranked candidates refilling the result, so truncated captures are
rejected. This matches the current server's fifty-candidate vector search; it
is not a simulator for arbitrary retrieval implementations.

The calibrator rejects evaluation queries, duplicate observations, repeated
passes, fused hybrid scores, and already-filtered runs. Version 5 observations
must also match their planned query-set manifest.
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

## Paired Comparisons

Compare two reports over the same corpus, split, cutoff, and query population:

```sh
node examples/benchmark-compare.mjs --baseline target/vector-unfiltered.json --candidate target/hybrid-unfiltered.json --allow-change retrieval --seed 20260916 --resamples 2000 > target/comparison.json
```

This is offline: no SDK dependencies, database, server, or provider are required.
Every changed configuration dimension must be declared with a repeatable
`--allow-change`, for example `binary`, `minSimilarity`, `relevance`,
`embeddingModel`, `embeddingDimensions`, `concurrency`, `querySeed`, or
`queryOrder`. Recorded OS, architecture, Node, or CPU-parallelism changes require
`--allow-change runtime`, including a transition from missing legacy metadata.
`--help` lists all fields. Declarations expose confounding; they
do not make a multi-variable change a controlled one-variable experiment.

The comparator rejects mismatched corpus hashes, query IDs, labels, categories,
splits, and query groups, as well as incomplete or duplicate pass observations.
It recomputes metrics from each first-pass ranking. Changed or forged headline
averages therefore do not change comparison results; this is consistency checking,
not cryptographic authentication of the original observations.

### Audit Against the Corpus

Two reports can omit the same difficult queries and still agree with each other.
Supply the original input files to check the reports against the complete selected
corpus, not only against each other:

```sh
node examples/benchmark-compare.mjs --baseline target/before.json --candidate target/after.json --dataset examples/fixtures/recall-v2.json --allow-change binary > target/audited-comparison.json
```

When the runs used background memories, also supply the original `--background`
file. The audit reconstructs the same combined corpus and checks its ID/hash,
every selected query, gold label, category, split, group, and available exact-query
hash. It rejects shared omissions even if a report's own manifest was recomputed.
It never executes background queries or sends labels to a model.

The comparison's `audit` fields distinguish what was checked:

| Field | Meaning |
|---|---|
| `corpusVerified` | Both query populations and labels agree with the supplied corpus |
| `queryTextVerified` | Both sets of query fingerprints also match that corpus |
| `plannedQuerySetsVerified` | Both reports' observations match their own plans |
| `queryFingerprintsCompared` | Both reports provide matching query hashes |
| `runtimeRecorded` | Both reports supply validated runtime metadata |

Without `--dataset`, corpus verification stays false. Legacy reports without
query hashes cannot establish what wording was executed. These checks cannot
authenticate fabricated timings/rankings, validate gold-label correctness, or
prove the selected groups are statistically independent. Keep original captures
and independently reviewed corpora when making claims.

### Interpreting Differences

Results include per-metric before/after values, paired deltas, counts of improved,
regressed, and unchanged queries, per-category comparisons, and missed gold IDs
per query. Latency remains separate for every pass, including p50/p95/p99 and
the number of rankings that differ from pass 1 and response-size distributions
where recorded. More passes never widen the
quality population or become independent accuracy observations.

The reproducible 95% percentile bootstrap resamples paired query groups with
replacement. Add a short `group` ID to queries derived from the same source or
scenario so correlated questions stay together; group IDs are never sent to the
server. Without `group`, each query ID is one sampling unit. The point estimate
is the macro query mean; resampling preserves every query in a selected group.
An interval is omitted when fewer than two groups contribute to a metric.

These intervals are conditional on the observed corpus and the independence of
the declared groups. Few groups, correlated sources, narrow domains, or biased
labels can make them misleading. Identical observed outcomes can produce a
zero-width interval; that is not certainty about production behaviour. Record
`--seed` and `--resamples`; do not choose a seed to obtain a preferred interval.

Optional observed-delta regression gates emit the full comparison and exit
nonzero on a loss greater than the declared tolerance:

```sh
node examples/benchmark-compare.mjs --baseline target/before.json --candidate target/after.json --allow-change binary --max-recall-drop 0 --max-no-answer-drop 0 > target/regression.json
```

Add `--max-regressed-queries 0` to reject any executed query with a worse
ranking/abstention metric or loss of a previously found gold fact. This catches
offsetting gains and losses hidden by macro averages, including a different
missing fact when Recall@k happens to stay unchanged. `queries` records
`regressed` and `lostRelevantIds`; the gate names its affected query IDs. A
nonnegative integer permits an explicit count tolerance. It does not decide
whether an unseen paraphrase is semantically equivalent or change existing gold
labels. The option is off unless supplied. Every candidate pass is compared with
the corresponding baseline pass, or baseline pass 1 when that pass is absent.
The gate counts distinct affected query IDs, not the number of failed executions;
`regressedPasses` records each failing pass, its baseline pass, metric deltas and
lost facts. The top-level metrics and each query's `deltas`/`lostRelevantIds`
still describe pass 1 only. Later failures cannot be hidden by a good first pass,
but repeats do not inflate the accuracy population or its confidence intervals.

Missing metric populations cannot pass their gates. These gates use observed
deltas, not an assertion of statistical equivalence. A passing benchmark still
does not measure the correctness of a final agent answer or its real task value.

### Automated Release Comparison

PR CI runs [the regression orchestrator](../scripts/regression-check.mjs) inside
the already-required PostgreSQL integration job. It verifies the public v0.4.0
native archive checksum and frozen corpus hashes from
[the baseline definition](../scripts/regression-baseline.json), then benchmarks
both binaries in separate disposable databases with identical settings. The
candidate is snapshotted once; reports must identify those same bytes, planned
passes, concurrency, seed, and full query population.

The engineering and useful-negative corpora cover 100 evaluated queries. Gates
allow no macro recall/abstention drop, no regressed query, and at most 32768 bytes
per candidate result. This fixed-fixture byte budget is not the server's general
response cap. Corpus-audited baseline, candidate, and comparison reports are
uploaded on success or failure. `summary.json` distinguishes incomplete execution
from a completed comparison that failed; local output directories cannot be
overwritten. Advance the pinned release or fixture budgets only with explicit
review and retained before/after evidence, not to erase a failing result.

The runner checks decoded database names rather than their URL spelling and
owns an isolated process group/tree and temporary root for each benchmark.
Forced termination also stops descendants in that group/tree; the parent removes
the child-created MCP executable rather than relying on a killed child's `finally`
block. Output capture is bounded. A timed-out or incomplete run cannot produce
a successful comparison, and cleanup failure invalidates the final summary.
Container cleanup attempts
all test-owned projects and reports all failures, even when a previous cleanup or
log collection failed.

The whole run has a monotonic execution deadline: 600 seconds for PR checks,
900 seconds for load reports by default. Downloads and subprocesses share its
remaining budget; it is not restarted for every query or corpus. Override with
integer `--deadline-seconds` (PR 1..600, load 1..7200). CI step timeouts are longer
than runner deadlines so failure summaries, cleanup and artifact upload can finish.
Longer model evaluations belong on controlled hosts with explicit settings and
budgets, not the shared-runner PR gate.

The separate manual load workflow uses three passes at concurrency one and four,
recording first/repeat p50/p95/p99, throughput, result bytes, and ranking changes.
Those timings are descriptive on shared GitHub hosts. The local `--profile load`
supports an optional warm-p95 threshold and explicit models on controlled hosts;
provider weights and host conditions still require independent recording.
Neither extra passes nor this frozen, exposed suite establish fresh accuracy.
See [local commands](../DEVELOPERS.md#released-baseline-gate).

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
An optional short `group` ID identifies related queries for paired uncertainty
estimation. Named calibration/evaluation splits may not share gold targets or
declared query families; overlap is rejected before any writes or model calls.
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

`summary` scores first-pass verified facts; `sourceSummary` independently scores
first-pass source IDs. `qualityPass: 1` makes that convention explicit, and
`byCategory` and `unverifiedFragments` use the same first-pass population.
Per-query results include both, missed fact IDs, unverified ranks, scores, and
timing. Repeated facts earn credit once while occupying result slots, but distinct
facts from one source can each earn credit. There is no deduplicate-and-refill
scoring. A single-relevant-fact query has a maximum Precision@5 of 0.2.

Write/recall mean, p50, p95, and p99 latency include MCP/provider work but exclude
server startup. Cold model loading is not separated from individual requests.
The default workload is sequential. Overall recall latency contains all execution
passes; compare the individual `byPass` distributions for cold/repeat behaviour.
On small populations p99 is effectively the maximum, not a stable tail estimate.

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

Use `--binary` to select the intended executable; the runner snapshots it before
launch. Reject
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

### Semantic Dependencies

The [semantic-dependency fixture](../examples/fixtures/semantic-dependencies-v1.json)
checks causal links, ambiguous references, conditions, chronology, attribution,
and excluded causes. It includes deliberately non-equivalent decompositions so
scorer regressions can catch lost meaning instead of rewarding shorter strings.
Run it through the existing preview path:

```sh
node examples/benchmark-recall.mjs --dataset examples/fixtures/semantic-dependencies-v1.json --extraction-only
node examples/benchmark-recall.mjs --dataset examples/fixtures/semantic-dependencies-v1.json --extraction-only --decomposition openai
```

The same explicit test database and optional model settings apply. The source
`John approved the PR because Sarah requested it.` is retained when the referent
is unclear. Two disconnected statements omit the causal relationship; assigning
what Sarah requested may additionally invent a referent. A single causal claim
can legitimately contain dependent clauses. This differs from merging unrelated
facts simply because they appeared in one paragraph.

These six hand-authored regression cases are not a new representative quality
benchmark. They verify default preservation and specified semantic-loss checks;
passing them or changing a model prompt does not prove reliable model extraction.

## Quality Gates

### Controlled Workloads

```sh
node examples/benchmark-recall.mjs --retrieval hybrid --concurrency 8 --query-seed 20260916 --passes 3 > target/concurrent-recall.json
```

`--concurrency` bounds in-flight recalls to 1..32 (default 1). Writes remain
sequential and finish before query timing begins. `--query-seed` chooses a
deterministic, different ordering for each pass; omitted means fixture order.
Reports record the workload settings and each pass's query-order hash, completed
request count, elapsed wall time, throughput, and latency percentiles. Result
rows retain schedule order even if requests complete out of order.

This is a closed-loop workload: each worker issues its next request after the
previous response and local scoring. Per-request latency starts at dispatch, not
at time spent waiting in the runner's queue. Throughput uses whole-pass wall time
and includes client/scoring overhead. It does not establish open-loop saturation
behaviour or production capacity. Use the same machine, configuration, corpus,
seed, concurrency, and cache state for a controlled before/after comparison.

On failure, the runner stops scheduling new requests and drains active requests
before throwing; it never returns a successful partial quality report. The
failure remains a failed execution, not a zero-latency or correct-abstention sample.

### Fast Recall

Keep `--relevance off` for latency-sensitive recall. To measure repeated queries
without reingesting the corpus, run multiple passes in one server process:

```sh
node examples/benchmark-recall.mjs --retrieval hybrid --passes 3 --max-warm-p95-ms 20 > target/recall-speed.json
```

Pass 1 reports first-seen-query latency; each later pass has its own metrics and
latency distribution in `byPass`. The gate fails if any later pass exceeds the
declared p95 budget, while retaining the complete report. Each pass also reports
wall time and throughput. Twenty milliseconds
is a local test target, not a service guarantee. Result quality is scored on
every pass, but headline metrics and accuracy gates use only pass 1. Review
later-pass scores and ranking changes separately. Calibration accepts
only a single pass. Query caches hold 128 exact strings, so larger working sets
may evict vectors before reuse. All passes still query current PostgreSQL data.

`--decomposition-reasoning-effort` and `--relevance-reasoning-effort` explicitly
set compatible providers' chat effort controls and are recorded under `reasoning`.
They are omitted by default. Never compare runs with different reasoning settings
as if only the prompt changed. They are quality/latency options, not automatic
optimizations; some models give worse answers with thinking disabled.

### Context Size

Fast retrieval can still return too much context for an agent. Report v5 records
`resultBytes` for each query: the UTF-8 length of the reserialized JSON results
array, including IDs, metadata, relationship context, and JSON escaping. It also
records `primaryTextBytes`, the unescaped UTF-8 text of primary fragments only.
No extra memory, query, or relationship text is retained in reports.

`responseSize` summarizes the first pass; each `byPass` entry has its own count,
total, mean, p50/p95/p99, minimum, and maximum byte values. The offline comparator
recomputes these from observations and reports null where legacy data is missing.
They are not tokenizer counts, the model's total prompt size, or MCP wire bytes:
the text-content copy, structured-content wrapper, protocol and HTTP envelopes
are outside this results-array measurement.

Set an explicit budget in either the runner or comparator:

```sh
node examples/benchmark-recall.mjs --passes 3 --max-result-bytes 16384 > target/context-budget.json
node examples/benchmark-compare.mjs --baseline target/before.json --candidate target/after.json --dataset examples/fixtures/recall-v2.json --allow-change binary --max-result-bytes 16384 > target/context-comparison.json
```

The budget checks every execution in every pass, not just a mean or the first
pass. The comparator checks the candidate report. An exact-boundary result passes;
an oversized result exits nonzero while preserving the full report. Missing byte
measurements cannot pass the gate. The limit accepts integer bytes in 0..67108864;
16384 is illustrative, not a recommended universal budget. Pair size limits with
recall and abstention checks so a tiny but useless result is not rewarded.

### Accuracy Gates

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

There is no measured ten-thousand, hundred-thousand, or million-memory capacity
claim. Exact pgvector search scans eligible vectors; bounding candidates and
response bytes does not bound that search cost. Before a larger deployment,
measure cold and warm latency, query throughput, filtered/unfiltered queries,
negative-query precision, and high-degree relationship costs at each intended
size. Use fresh labelled targets with realistic independent distractors, not
duplicated facts presented as more quality examples. Any future ANN indexing or
reranker needs a recall/latency comparison against the exact baseline; synthesis
alone cannot recover a fact that retrieval never found.

The suite does not measure a final agent's answers, memory-use decisions,
multilingual recall, open-loop production load, automatic supersession, or an adversarial
security guarantee. Keyword search is expected to struggle with full questions.
Unfiltered vectors always have nearest neighbours, including on missing-answer
queries. A calibrated floor exposes the recall/rejection trade-off rather than
solving it universally. See the [recorded experiment](BENCHMARK-RESULTS.md).

This version runs MindLeak Light through its MCP contract. A comparison with
Bluebird or another system needs an adapter that returns ranked source IDs over
the same corpus and queries, plus equivalent preprocessing and retrieval budgets.
The exported `scoreRanking` and `summarizeQueries` functions can score those
rankings, but no competitor adapter or head-to-head result is included here.
