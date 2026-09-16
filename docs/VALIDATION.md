# MindLeak Validation Harness v1

The [runner](../examples/validation-harness.mjs) exercises the real MCP server
and an optional agent under test. It uses the existing
[retrieval/extraction scoring](BENCHMARKS.md), not a second implementation of
MindLeak or an LLM judge. This is a source-checkout developer harness, not a
new MCP tool, service, telemetry collector, or feature of an older binary.

The default run measures deterministic scenarios. Agent tests require explicit
provider configuration. Real elapsed-time checkpoints are resumed on later dates.
Unknown measurements are `null` or `not_measured`, never invented zeros.

## Architecture

```text
JSON scenario generator -> test runner -> fresh agent + real MCP -> evaluator -> JSON report
```

The scenario generator creates fixed diagnostic tasks and seeded scale facts.
The evaluator's accepted answers are not passed to the agent. Agent A and Agent B
are separate, fresh chat histories using the same configured model; this is not
a comparison between different models or agent frameworks. Between phases the
runner actually closes and restarts its private MCP process. It never passes
Agent A's conversation or code edits to Agent B. Both coding arms receive the
same original repository fixture. Only the memory-enabled arm gets memory tools.

## Run Without an Agent

Requirements: Node.js 22+, a source build or a v0.4.0+ native binary, and a
disposable PostgreSQL/pgvector database whose name ends in `_test`. Startup
checks that the server advertises source inspection and retry-safe writes.

```sh
cargo build --workspace --locked
npm ci --prefix examples
docker compose exec postgres createdb -U mindleak_light mindleak_validation_test
export MINDLEAK_TEST_DATABASE_URL='postgresql://mindleak_light:mindleak-light-development-only@127.0.0.1:55432/mindleak_validation_test?sslmode=disable'
node examples/validation-harness.mjs --chart-dir target/validation-charts > target/validation.json
```

Match the test database URL to your local setup. The harness refuses ordinary
database names and does not connect to an existing HTTP memory service. Each
run gets new scopes. It leaves synthetic records in the test database, which
the operator may drop after checking its name. Never use a production database.
Keep different embedding models/dimensions in different databases.
Use a fresh empty database for independent scale runs: scopes separate relevance,
but do not isolate physical index size, cache state, or database work.

Stdout is one JSON report; progress events on stderr are JSON. Invoke Node
directly when redirecting output so npm banners do not enter the report.
`--help` also returns JSON. Optional charts are derived SVG artifacts, not a
replacement for the JSON measurements. `--chart-dir` must name a new directory.
The report always includes Vega-Lite JSON specifications for completed scale
checkpoints; the optional renderer makes `factsVsAccuracy.svg` and
`factsVsLatency.svg` without uploading data.

Useful controls:

```sh
node examples/validation-harness.mjs --plan --sizes 100,500,1000
node examples/validation-harness.mjs --sizes 10,20 --category memory_over_time
node examples/validation-harness.mjs --category simple_recall --category semantic_recall
```

`--seed` is a uint32; the default is 20260916. `--sizes` accepts increasing
populations from 1 to 10000; defaults are 100, 500, and 1000. The report records
requested facts separately from actually stored fragments, because model
decomposition need not produce the requested count. Each checkpoint tests up to
20 distributed positive probes and five no-answer probes. This is a growth
diagnostic, not a throughput/load test or a sample of production traffic.

Optional `--retrieval vector|hybrid`, `--decomposition openai`, and
`--relevance openai` reuse the existing explicit
[provider settings](MODELS.md). Defaults remain sentences, keyword, and relevance
off regardless of inherited production mode settings. `--min-similarity` and
`--relevance-candidates` have the existing benchmark meanings. Do not tune a
threshold on the reported test cases and then present them as unseen evaluation.

## Run Real Agents

Use a model/provider with reliable OpenAI-compatible function calling and JSON
answers. Agent inference is separate from MindLeak's optional providers.
Configuration is explicit, and no API key or endpoint URL is included in reports.
Non-loopback agent endpoints require HTTPS. External inference may incur charges.

```sh
export MINDLEAK_VALIDATION_AGENT_URL='http://127.0.0.1:11434/v1'
export MINDLEAK_VALIDATION_AGENT_MODEL='your-tool-capable-model'
podman pull docker.io/library/node:22-bookworm-slim
node examples/validation-harness.mjs --agent --code-engine podman --trials 3 > target/validation-agents.json
```

Set `MINDLEAK_VALIDATION_AGENT_API_KEY` through your normal secret mechanism
when required. Do not put credentials in the URL or report. `--agent-max-steps`
accepts 1..32 turns (default 16); `--agent-timeout-ms` accepts 100..300000 per
provider call (default 60000). Each response is bounded to 4 MiB and each turn
requests at most 2048 output tokens. Invalid tool calls and invalid final JSON
remain recorded failures, not repaired answers or successful empty results.

The official OpenAI client handles provider calls, and the official MCP client
handles the memory protocol. Fresh histories prevent deliberate conversation
carryover; provider-side caching or changed model weights are not controlled by
this harness. Model names do not pin weights. Record the actual provider version,
model digest, machine, and resource contention alongside any published run.
SDK logging is explicitly off, including when `OPENAI_LOG` is inherited. Do not
enable wire-level logging in external proxies or the host runtime.

Coding tools can list/search/read only fixture files and edit only declared
implementation paths. Tests are immutable. Code executes in a pinned local image
ID using Docker or Podman with no network, a read-only filesystem/mount, a
non-root user, dropped capabilities, CPU/memory/PID limits, and a timeout. No host
shell, repository checkout, database credentials, or container socket is mounted.
Use `--code-image` to select another explicitly pulled compatible Node image.
Without `--code-engine`, coding outcomes are unmeasured; agent code never falls
back to host execution. These checks are not an adversarial program-proof system.

## Categories

| Category | Measurement and Criterion |
|---|---|
| Atomic fact extraction | Bob/Atlas conversation, verified fact precision/recall and duplicate rate; exact raw text and all receipt fragments inspected after process restart |
| Simple recall | Fresh-session preference queries, latency, verified fact recall; optional paired final-agent answer |
| Semantic recall | Paraphrase hit rates at 1/3/5 and explicit no-answer controls; keyword misses are valid measurements, not hidden fallbacks |
| Agent handoff | Agent A writes customer constraints; fresh Agent B answers without seeing that conversation; checks PostgreSQL/Azure/RBAC and observed exposure to A's writes |
| Memory over time | Growing 100/500/1000-fact corpus, precision/recall, false positives, latency, and graphs; this is not elapsed-time learning |
| Poisoning resistance | False Moon claim, paired answers, observed exposure, reported blind acceptance, and attributed conflict detection; no exposure or missing answer fields stay unmeasured |
| Contradiction handling | Unlinked Java/Rust claims are preserved; an explicit supersedes link retires Java, checked after restart; optional final-agent resolution |
| Context compression | Full prior history versus memory-assisted agent with the same task; byte counts are separate from actual provider token usage, correctness, cost, and latency |
| Coding agent workflow | Fresh agent adds a customer endpoint following the data/repository pattern; fixed tests determine success; measured search/tool counts and completion time |
| Multi-day learning | Resumable day-1/day-2/day-30 writes and final combined question, with actual elapsed-time requirements |

Persistence here means acknowledged writes survive an MCP process restart and
retain raw source/receipt fragments. It does not substitute for database crash,
backup, restore, or power-loss testing. The harness does not change the memory
system's truth policy: recency alone is not evidence, scores are not confidence
probabilities, and contradictions are not silently resolved by last-write-wins.

## Rediscovery Demo

Selecting `coding_workflow` also runs `rediscovery_demo`:

1. Agent A investigates a session-expiry bug in a disposable repository. It can
   test hypotheses and store the root cause, files, recommended fix, and only
   failed approaches it actually tried.
2. Its context and checkout are discarded. The private MCP process restarts.
3. Fresh Agent B tackles the original broken checkout, once without memory and
   once with memory. The fixture and task are identical. Fixed tests check
   valid-session retention, expiry boundaries, and arbitrary TTL conversion.
4. Report actual file searches, tool calls, first-file-read time, completion time,
   final test results, observed memory exposure, and provider-reported tokens.

```sh
node examples/validation-harness.mjs --agent --code-engine podman --category coding_workflow --trials 3 > target/rediscovery.json
```

Pair order is recorded and alternates for coding trials; task pairs use seeded
order. Every arm starts from fresh files and messages. Savings require both arms
to pass; a faster failed solution gets `null`, not a win. Discovery cost is
reported separately, not subtracted from later-agent time. Include it when
estimating an end-to-end benefit or amortization across repeated work.

Immediate replay proves a fresh-session comparison, not that tomorrow passed.
One fixture repeated three times is still one independent task. No 50-80%
rediscovery reduction is assumed. Show failures and negative savings as well as
successes, and add independent real tasks before making organizational-memory
or broad agent-performance claims.

## Multi-Day Journal

Use a separate test database that you will retain for the whole observation
period. Preserve its backup and this private journal together. Keep the same
scenario seed and retrieval configuration. Do not alter the clock or journal
to make the later checks eligible.

```sh
node examples/validation-harness.mjs --longitudinal-state target/learning-study.json --day 1
node examples/validation-harness.mjs --longitudinal-state target/learning-study.json --day 2
node examples/validation-harness.mjs --longitudinal-state target/learning-study.json --day 30 --agent
```

These commands are run on their respective dates, not consecutively as a way to
simulate time. Day 2 requires at least 24 hours after the start; day 30 requires
29 elapsed days and both earlier writes. Early calls return `not_due`, with a
due timestamp and no learning score. Repeated completed checkpoints return the
recorded observation without writing again. Durable request IDs keep interrupted
checkpoint writes retry-safe. A lock prevents concurrent journal updates; after
a process crash, confirm no study process is active before removing its stale
`.lock` file. State files use owner-only permissions and atomic replacement.

Day 30 checks both facts, exact raw sources, and optionally a new agent's combined
answer. Without an agent, retention is measured but combined-answer success stays
unknown. The host clock and local journal are operator-controlled evidence, not
a signed proof of elapsed time. This measures retention/combination, not training
of model weights or general human-like learning. Unit tests using injected time
are explicitly labelled and cannot populate the real-learning metric.

## Report Interpretation

`reportVersion: 1` includes a scenario/fixture manifest, exact binary SHA-256,
harness-source hashes, server/model configuration, runtime details, per-case
observations, paired outcomes, and summary fields:

```json
{
  "facts_stored": 1010,
  "precision": null,
  "recall": null,
  "avg_retrieval_ms": null,
  "false_positive_rate": null,
  "token_savings": null,
  "multi_agent_transfer": null,
  "error_amplification": null,
  "long_term_learning": null
}
```

This illustrates the schema, not a claimed score. Actual reports contain sample
counts and metric definitions. Precision is a macro mean among nonempty returned
top-five sets, with duplicates consuming slots. `precisionAt5` separately uses
the full cutoff denominator. Recall and top-k hit rates use positive queries;
false-positive rate is the fraction of designated no-answer queries returning
anything. Scale probes can dominate aggregate recall, so publish category-level
results rather than presenting the aggregate as natural-language accuracy.

Structured answer rubrics use conservative accepted values, never substring
presence or a second model's opinion. Unmatched wording is unverified and may
need independent review; it is not automatically a false factual claim. The
`error_amplification` field is an observed paired task-regression rate: correct
without memory and unsuccessful under the rubric with memory. It can include
missed evidence, not just copying false claims. Poisoning acceptance/conflict
metrics report the narrower behavior separately. These are not causal estimates
from a representative population.

Token counts come only from complete provider-reported usage across agent turns.
Supply both `--input-usd-per-million` and `--output-usd-per-million` for agent
inference cost; missing prices/usage yield `null`. Optional MindLeak model costs
are not exposed by MCP and are excluded, not guessed. Returned JSON bytes are
not tokens, the original history is not assumed to be 5000 tokens, and retrieval
is not assumed to cost 200. Latency/cost comparisons retain negative reductions.

`completed` means the requested execution finished, not that every answer was
correct or every category was measured. Provider/protocol/category errors produce
a retained `partial` report and nonzero exit. Disabled agent/real-time categories
stay `not_measured`. Startup errors produce a small JSON error with no fake
summary. Source files changed during a run invalidate a clean completion claim.
Hashes detect inconsistency, not forged reports or anonymization.

## Privacy and Tests

This v1 generates synthetic data only. It never collects live usage, contacts a
production memory service, uploads reports, or exports raw recalled/provider
bodies. Agent answers are evaluated in memory; only hashes, rubric checks, and
tool metadata are retained. Search terms, prompts, credentials, and arbitrary
source paths do not enter the report. Fixture paths are synthetic test artifacts.
Consent, redaction, independent labels, and an explicit import workflow are needed
before extending this to private incidents or real user conversations.

```sh
node --test examples/validation-harness.test.mjs
MINDLEAK_VALIDATION_CODE_ENGINE=podman node --test examples/validation-harness.test.mjs
```

Unit tests need no provider or database and run in the normal repository gates.
The second command additionally needs the installed example dependencies and
explicitly pulled container image; it verifies failing/passing coding fixtures,
actual SVG rendering, and a local provider's privacy boundary. Skipped integration
tests are not passing live tests.
