# Recall Benchmarks

The [benchmark runner](../examples/benchmark-recall.mjs) measures whether labelled
source memories appear in ranked MCP recall results. It writes a fixed corpus,
queries it through the official MCP client SDK, and produces a JSON report.
There is no LLM judge and relevance labels are never sent to the server.

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

Each invocation gets a unique `agentId`, used on every write and recall. Records
remain in the disposable database because there is no delete tool. Remove that
database when finished, after checking its name; the benchmark never deletes
database contents itself. A failed run may leave its already-written records.

JSON goes to stdout; progress and sanitized errors go to stderr. Invoke `node`
directly when capturing JSON: npm may add script banners to redirected stdout.
Reports contain corpus IDs, source rankings, missed IDs, category summaries,
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

## Corpus and Metrics

The [initial corpus](../examples/fixtures/recall-v1.json) contains 24 synthetic
engineering facts and 32 queries: six lexical, eight paraphrases, nine project
disambiguation, five multi-answer, and four unanswerable. Similar facts from two
fictional projects act as distractors.

`--dataset PATH` accepts the same JSON shape: `schemaVersion: 1`, a dataset `id`,
`memories` containing unique `id` and `text` fields, and `queries` containing
unique `id`, `category`, `query`, and `relevantIds` fields. An empty relevance list
means unanswerable; every other label must reference a corpus memory. Version
corpus changes, review labels independently, and keep held-out queries when
tuning retrieval. Use one independently relevant fact per memory for this scorer.

The scoring unit is the source memory ID, at `--k` result slots (default 5):

| Metric | Definition |
|---|---|
| Precision@k | Distinct relevant memories returned divided by k, even for a short result list |
| Recall@k | Distinct relevant memories returned divided by all labelled relevant memories |
| MRR@k | Mean reciprocal rank of the first relevant result; zero on a miss |
| nDCG@k | Binary relevance discounted by `1 / log2(rank + 1)`, divided by the ideal score |
| Hit Rate@k | Fraction of answerable queries with at least one relevant result |
| No-Answer Accuracy | Fraction of unanswerable queries that return no results |

Ranking metrics are macro averages over answerable queries, not weighted by the
number of relevant memories. Unanswerable queries are excluded from those means;
their abstention score is reported separately. Empty metric populations are
`null`, not zero or perfect. Category reports use the same rules.

Multiple fragments from one source memory earn relevance credit only once but
still consume rank positions. The runner does not deduplicate and refill the
ranking. Thus duplicate fragments cannot inflate recall or nDCG. At k=5, a query
with one relevant memory has a maximum Precision@5 of 0.2; use recall and rank
metrics alongside precision, not precision alone.

Provider failures, malformed responses, unknown source IDs, and records from
another agent namespace abort the run without a score report. They are not
converted into empty successful recalls. Quality misses are valid measurements
and do not fail the command unless you supply an explicit threshold:

```sh
node examples/benchmark-recall.mjs --k 5 --min-recall 0.65 > target/recall-gate.json
```

The threshold checks overall macro Recall@k only. A below-threshold run still
emits its complete report and exits nonzero; a corpus without answerable queries
cannot pass this gate. The example threshold is illustrative, not a quality
claim. Scorer and runner-contract tests run in `make script-test` and `make ci`;
live model benchmarks are opt-in and are not required by CI.

## Interpretation Limits

This is a small diagnostic corpus, not evidence of production accuracy or
superiority over another memory product. It tests source retrieval, not whether
an extracted fragment preserved every qualifier, whether a final agent answer
is correct, or whether an agent chose to recall at the right moment. Multi-fact
paragraph extraction needs separate fact-level ground truth.

Keyword search is expected to struggle with natural-language paraphrases. Exact
vector retrieval currently returns nearest neighbours without a relevance
threshold, so it can score poorly on unanswerable queries. Those results expose
different limitations; do not silently remove either category.

This version runs MindLeak Light through its MCP contract. A comparison with
Bluebird or another system needs an adapter that returns ranked source IDs over
the same corpus and queries, plus equivalent preprocessing and retrieval budgets.
The exported `scoreRanking` and `summarizeQueries` functions can score those
rankings, but no competitor adapter or head-to-head result is included here.
