# MindLeak Learning Labs and Validation

The product question is **whether agents turn experience into knowledge that
helps future agents**. Start with the three [learning labs](#swarm-labs): discover
observations, form evidence-backed Chains of Memory and Principles, then test
later reuse. Storage, extraction and retrieval checks are the foundation, not a
substitute for this learning loop.

## Learning Acceptance

| Claim | Required Evidence | Does Not Establish It |
|---|---|---|
| Observation captured | Successful receipt, exact original source and complete fragment set | A generated note or unacknowledged tool call |
| Chain formed | Source-linked claim, justification, conclusion, conditions and actual recorded validation | A candidate, a citation alone or an invented confidence value |
| Principle formed | Multiple current validated chain revisions, complete known counterevidence, explicit acceptance | Repeated agreement, copied episodes or distinct IDs alone |
| Later use observed | Knowledge delivered before a changed candidate on a new task, with all immutable checks passing | Retrieval alone, a quotation, exposure after the fix or mandatory read counts |
| Transfer demonstrated | Verified use on a new case, with source and case-family identity reported | Repeating preparation or counting correlated cases as independent |
| Comparative improvement | Matched controlled outcomes with misses, failures, preparation and review costs included | More records, a weighted index, a smaller payload or successful execution alone |

Changed-condition and irrelevant cases must test when *not* to apply a principle.
Review stale support and retain counterexamples rather than forcing every case
to confirm the lesson. Separate no-experience, searchable-note, and knowledge arms;
keep direct delivery diagnostic rather than pooling it with optional retrieval.
Fresh sessions receive neither the discovering agent's conversation nor its edits.

The complete pilot and a separately frozen held-out confirmation are required
before claiming general learning benefit. Existing smoke runs and exposed fixtures
do not establish it. Do not change frozen tasks, correctness gates, or scoring to
make the new pitch win. No new learning and no advantage are valid recorded results.

## Validation Harness

The [runner](../examples/validation-harness.mjs) exercises the real MCP server
and an optional agent under test. It uses the existing
[retrieval/extraction scoring](BENCHMARKS.md), not a second implementation of
MindLeak or an LLM judge. This is a source-checkout developer harness, not a
new MCP tool, service, telemetry collector, or feature of an older binary.

The default run measures deterministic scenarios. Agent tests require explicit
provider configuration. Real elapsed-time checkpoints are resumed on later dates.
Unknown measurements are `null` or `not_measured`, never invented zeros.
Current runs use **report version 2** and agent contract `untrusted-memory-tools-v2`.
Earlier version-1 reports remain historical evidence; changed answer contracts,
tool access, generation budgets, and preparation criteria are not directly
comparable with those runs. Original task text, fact labels, and scenario seeds
are unchanged. Contract hashes identify the additional experiment inputs.

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

## Swarm Labs

The dashboard is titled **MindLeak Learning Lab**. Its three views are **Discover**
(Lab 1), **Form** (Lab 2), and **Reuse** (Lab 3). The route names and frozen experiment
protocols remain stable so saved recordings keep their identity.

One dashboard serves all three experiments on **http://127.0.0.1:54584**:
`/lab1/` builds Session Desk, `/lab2/` investigates package upgrades, and
`/lab3/` measures rediscovery against a searchable notebook and a fresh agent.
The Knowledge view is available from each knowledge lab's navigation;
`/learnings` is a shortcut to `/lab2/learnings`. Only one experiment can run at
a time across the dashboard. Standalone lab mode is an explicit CLI option,
not the default way to navigate between experiments.

Lab 1 has two isolated five-agent teams building **Session Desk**. Atlas owns
time calculations, Iris validates input, Nova builds the store, Vega builds the
interface, and Orion integrates it. Five Daleks have matched models, roles,
budgets, dependency order and immutable tests, but no MindLeak tools or findings.
Each team can inspect only its own evolving project. Memory use and publication
are optional; correctness depends on the code tests, not a handoff quota.

Use a dedicated disposable database ending in `_test`, the native server binary,
your existing Copilot login, local GLM, and Docker or Podman:

```sh
npm ci --prefix examples
export MINDLEAK_TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/mindleak_demo_test?sslmode=disable'
export MINDLEAK_DEMO_MEMORY_URL='http://127.0.0.1:11434/v1'
podman pull docker.io/library/node:22-bookworm-slim
node examples/swarm-demo.mjs --binary PATH_TO_V060_BINARY --agent-provider copilot --code-engine podman --port 54584 --output-dir target/swarm-labs
```

The default roster assigns **GPT-6 Astra** to Atlas, Iris, and Nova, and
**Claude Opus 5** to Vega and Orion. **MAI-Code 1.1 Flash** is another selector
option when the authenticated provider advertises it. The official Copilot SDK
exposes only the demo's bounded custom tools; built-in tools, other MCP servers,
configuration discovery, and host-shell access are disabled. Each agent has a
30-AI-credit session ceiling and the configured turn/time limits.

The **memory SLM is GLM 4.7 Flash**, invoked by MindLeak for actual decomposition.
Its input/output usage is measured at the private fixed-target provider boundary
and is displayed separately from the agents' LLM usage. Choose model-free memory
in the page to compare without extraction calls. To use another configured
OpenAI-compatible agent provider, pass `--agent-provider openai` and set
`MINDLEAK_VALIDATION_AGENT_URL`, `MINDLEAK_VALIDATION_AGENT_MODEL`, and, when needed,
`MINDLEAK_VALIDATION_AGENT_API_KEY` in the environment. Secrets never enter the page.

Open a lab and press **Run build** or **Run experiment**. `--run` starts Lab 2
immediately in the shared dashboard; `--once` runs, records, and exits.
`--lab 1|2|3` selects a standalone lab, with `--recording PATH/report.json` for
reopening one result. In the shared dashboard, use `--lab-one-recording`,
`--lab-two-recording` and `--lab-three-recording` instead. Each lab has its own
`/replay`, `/report.json`, `/state` and `/events` routes under its prefix.
Saved replays do not start inference. `--concurrency 1..5` in Lab 1
defaults to two simultaneous model sessions per team; dependent agents start after
their prerequisite components pass. `--attempts 1..3` defaults to two attempts
per agent, retaining failures in the recording. The page can stop the current run.
The problem/parameters panel and per-agent model selectors apply to the next run
and lock during execution. The task can refine the bounded Session Desk fixture;
it does not yet scaffold arbitrary projects or change the immutable interfaces.
Only explicit commands from the local page can start inference. The chosen model
providers receive the synthetic build context; event telemetry stays local.
There is no public listener, host code execution, or production memory access.

Each agent has a fresh conversation and its own editable paths. It can read the
project and shared MCP discoveries, but can publish a finding only after its own
component tests pass. Final integration runs eighteen immutable checks per team in a
network-disabled container against a fingerprinted source snapshot. Coordination
lives in this example runner; MindLeak remains the memory server.

Each recording directory contains `events.ndjson`, `report.json`, `memories.json`,
`tool-details.json`, and a standalone `index.html`. The event log is metadata-only;
the two separate exhibits contain the explicitly visible synthetic saved findings
and safe tool arguments, such as fixture paths and search queries. Successful
builds also contain `session-desk.html` and `session-desk-daleks.html`, with separate
`project` and `dalek-project` source directories. The artifact tabs switch between
their sandboxed previews. Playback needs no server or model. Regenerate a page:

```sh
node examples/demo-replay.mjs --report target/RUN/report.json --output-dir target/replay-copy
```

The headline is **Knowledge Formation**: unique source observations, recorded
accepted Chains of Memory, and recorded accepted Principles. Chain acceptance
requires available referenced observations and a reviewed revision; principles
also require multiple distinct accepted chains at their pinned current revisions.
Candidates and accepted records needing review are shown separately. Historical
recordings that omitted review fields keep their recorded acceptance counts and
show review as unknown, not a fabricated challenge or verified readiness. New
captures retain the returned review status; the restart readback also preserves
dependency status. Unknown or stale support cannot become ready knowledge merely
because an old receipt says accepted. Supporting observations count source episodes, not fragments; source
counts are not an independent judgement of corroboration or truth.

The prior **Knowledge Capital** formula remains under the collapsed **Observed
Reuse Index / v1** diagnostic: one point per used observation, five per directly
used chain, and ten per principle delivered before a verified change on a later
task. Each record earns points once, not per read, write, or revision. Control
arms, retrieval alone, and quotation-only claims earn no points. Index change
compares the first and latest verified checkpoints; a zero baseline never produces
an infinite gain. Missing evidence stays unmeasured. This index is neither the
headline acceptance gate nor a measure of intelligence or compounding benefit.
Historical recordings and their original metric definitions remain unchanged.

The supporting outcome panels show verified tasks, evidence-linked reuse, new-case
transfer and correctness curves. Uninstrumented mistake avoidance and hypothesis
truth remain unmeasured. Lab 3 labels its measured time as **time to verified fix**,
not time to a semantically correct explanation. A flat correctness curve stays
flat when both arms pass; the weighted index is not a causal productivity claim.

Separate LLM/SLM counters and per-agent token tables sit at the bottom in the
collapsed **Operational Costs & Telemetry** section. Agent cards show saved records
and observed task-use counts instead. Counters update when providers report usage.
While generation is active, the page shows elapsed inference time; it does not
estimate unreported tokens. Event telemetry excludes prompts, memory text, and
provider response bodies. The chronological event stream follows the newest event;
scroll up to inspect history, or use its follow toggle to resume tailing. Select
an event to inspect the exact tool name, call ID, model, inference phase, measured
latency, finish reason, usage, and safe arguments. Generated application source is retained only as the
explicit synthetic build artifact, inside a sandboxed preview with no network access.

### Lab 2: Form Knowledge

Lab 1 remains the matched two-team build. **Lab 2 keeps the same five
agents and adds five Dalek controls** for repeated report-export upgrades.
The memory team builds a durable solution guide through MindLeak v0.6.0's real
observation, chain, principle, revision, and export operations. Each Dalek is
matched to one investigator's model, codebase, tools, budget and correctness checks.
Daleks have no MindLeak tools, retrieved context, prior conversation or shared
findings. Their answers never enter the learning loop.

Open `/lab2/` on the shared dashboard above. Use a v0.6.0+ binary and a dedicated
`_test` database. The labs use distinct scopes and artifact directories; the
dashboard does not connect to production memory. Historical databases and
recordings are not replaced or converted into new experiment results.

Preparation uses sequential fresh sessions; each comparison round starts all ten
sessions from a common barrier. The default is two rounds, selectable from one to
three. A matched pair uses the same pinned model, turn/time/credit ceilings and
single assessment attempt. Preparation and review may use the separately configured
one-to-three attempts per phase. Credit ceilings are not estimated spend.

Fixture v2 contains actual caller modules, nested Node package resolution, vendored
release code and three immutable exporter tests. `probe_upgrade` executes an exact
installed-path/version choice and a transparent caller adaptation in a fresh
network-disabled container. No arbitrary shell, installation or host code execution
is available. The original metadata fixture and old recordings remain unchanged.
The cases vary signatures, Node requirements, asynchronous API result shapes,
non-shipped dependencies and policy-blocked upgrades. A patched version can still
fail its caller; changing only the root development copy does not fix the nested
runtime dependency. Seven source/decision/probe checks validate each assessment.
Correctly reporting a blocked upgrade leaves its runtime failures visible rather
than claiming a working fix. All advisories and packages are frozen synthetic data,
not a live vulnerability finding or an unrestricted software-maintenance task.

1. Atlas investigates independently, records quoted source observations, and
   proposes and explicitly accepts a case-specific chain.
2. Iris finishes its own assessment before reading Atlas's work. It records a
   second chain, then authors a principle supported by both accepted chains.
3. Nova, Vega, and Orion retrieve the stored guide for their new cases. Each adds
   a source-backed chain and revises the same principle while retaining the
   earlier case support and known exceptions.
4. MindLeak is actually stopped and restarted between stages. The runner reads
   back every observation and current knowledge document, requiring identical
   IDs, revisions, raw sources, and structured content. Recorded child PIDs show
   the process change; fresh conversations alone do not count as persistence.
5. The final procedure is extracted through `recall_memory` with
   `knowledge.operation=export`, as both JSON and Markdown.

Every start prompt explains principles (procedures/applicability), chains
(reasoning/conditions) and observations (source evidence) before the task.
Memory-enabled investigators retrieve a compact accepted principle before choosing
an approach, then follow the relevant chain and observation references as needed.
The first two seed assessments remain independent despite receiving this orientation.
Assessment, evidence capture and guide authoring use separate fresh sessions.
The authoring session recovers stored case chains instead of an earlier conversation.

Delivery protocol v4 removes repeated rationale, acceptance metadata and duplicated
support explanations from the first guide response. It preserves the complete
procedure, applicability, assumptions and counterevidence. Two initial positive
source pointers are supplied from distinct supporting chains; every contrary
pointer remains visible. `sourceReferencesTruncated` and `sourceReferenceCount`
disclose deferred positive evidence, and full chain/source inspection stays available.
The hard response budget remains 16 KiB so conditions are never silently truncated
to achieve a size target. Reprojecting the recorded revision-8 guide from run
`6f688d8f-294d-4896-874c-fa055505d2bc` reduced the first response from 10,314 to
4,935 bytes (52.2%). This is measured payload reduction, not a measured token bill
or a new model-result claim. No old source or recording was rewritten.

Retrieval alone is not enough to pass the later memory-enabled stages. The agent
must receive the accepted guide before its verified assessment, inspect at least
two distinct original observations from the guide's support, and call `apply_guide`
with two exact guide-step quotations and current-case evidence. This writes a
durable application observation containing the guide ID/revision, selected steps,
their stated application or exception, source IDs, and the verified case decision.
This demonstrates traceable use; it is not an independent proof that the guide
caused a better outcome. This stricter preparation check is not imposed on either
evaluation arm: their identical assessment checks decide correctness, while actual
retrieval and an exact guide-step/source quotation record attributable use separately.

### Matched Dalek Rounds

After preparation, the runner restarts MCP and verifies the accepted guide, then
freezes its revision for a round. Five new codebase variants go to five matched
memory/Dalek pairs simultaneously. The memory team can search the frozen guide and
inspect its sources; no agent in either arm can write during comparison. The runner
checks the guide again only after all ten sessions finish. Session start skew and
actual provider usage remain in the report; a common scheduling barrier does not
guarantee identical provider queue time.

Orion then reviews only verified memory-team results in two fresh evidence/guide
sessions. It can store useful applications, constraints or exceptions, form an
accepted round chain, and revise the same principle. It can instead explicitly
record no new learning without writing. The next round uses the resulting revision
with new versions and case IDs in the same five families. New values and session IDs
are not independent task families or independent confirmations. Ordinary recall
never reinforces/promotes; this experiment does not manufacture lifecycle feedback.

The secondary **Cost of Rediscovery** table shows correctness, assessment input/output tokens,
the complete initial preparation, every review phase, memory SLM usage, and elapsed
time. Each round retains a cumulative preparation-inclusive comparison. Failures,
unknown usage and negative savings are preserved. Agent token totals are separate
from memory-model tokens, and dollar cost remains unknown without applicable pricing.
Timing covers the recorded preparation and round sessions, not client installation;
concurrent provider and host contention can affect it. Results are descriptive for
these exposed synthetic families, not an independently held-out productivity claim.
The guide's prose remains agent-authored, not an independently adjudicated truth proof.

`control-experiment.json` retains the matched plan, per-arm outcomes, round guide
hashes/revisions, source/probe fingerprints, review costs and cumulative summaries.
Starting another dashboard run creates a new scope and independent preparation;
use multiple rounds within one run to continue learning from its existing guide.

### Lab 3: Reuse Knowledge

Open `/lab3/`. Unlike Lab 2's bounded package-review workflow, Lab 3 uses editable
unfamiliar code, ordinary repository docs and immutable runtime tests. Five problem
families cover retry identity, lease expiry, pagination, batch correlation and path
boundaries. Follow-ups test near transfer, a different symptom requiring
generalization, an unrelated fault, and a changed provider contract. These tasks
are frozen synthetic cases, not separately held-out production repositories.

Three main arms receive identical starting code and checks: **Fresh Agent** has
only the repository; **Searchable Notebook** can use ordinary Markdown with a
MiniSearch full-text index; **MindLeak** can retrieve the same experience through
observations, chains and principles. A separately reported **Direct Lesson** arm
gets the applicable prior procedure in its prompt, never a future solution.
The prior lesson is agent-authored only after a changed implementation passes all
three immutable tests. No reference repair or gold answer is exposed to any agent.

The runner supplies the actual policy in each isolated session: active search mode,
optional retrieval, one focused refinement after a miss, current-condition checks,
and untrusted-memory boundaries. Installed skills are deliberately not discovered
by these isolated model sessions. Initial notebook and MindLeak responses expose
the same procedure, conditions, limits and IDs within 2,048 UTF-8 bytes. Supporting
evidence is available on demand. No fixed read-all-files requirement, required
lookup, quoted conclusion or note is part of correctness. Retrieval misses and
non-use stay in the assigned arm's denominator.

Protocol **v2**, fixture **v1**, separates verified code investigation from an
explicit preparation documentation session. Both may retain a useful lesson or
finish with no new learning. Every evaluation uses a fresh session and private
workspace. A seeded randomized schedule runs one session at a time across all
arms, including the separate diagnostic, to avoid concurrent provider congestion.
Experience is frozen and rechecked across every round's arms and repetitions.
Only then can a reviewer retain new evidence, a correction or an exception using
verified memory-side cases. Control answers never enter the learning loop.

The default **smoke** profile covers one family, near transfer and changed
conditions: six main-arm sessions plus two diagnostics, one investigation and
three documentation/review sessions. The explicit **pilot** profile covers five
families, four follow-ups and two repetitions: **120 main-arm sessions**, 40
diagnostics, five investigations and five documentation/review sessions.
Repeated variants are not independent families. Inspect the full plan without
opening a model, database or output directory:

```sh
node examples/swarm-demo.mjs --plan --rediscovery-profile pilot --query-seed 20260917
```

Select the profile before starting. All four arms use the same model and budgets,
with one coding session per scheduled task. The runner writes `frozen-plan.json`
before inference. `rediscovery-results.json`, candidate sources in the replay,
and the final `notebook/*.md` retain auditable results. The guide state and raw
synthetic source exhibits are separate from metadata-only event telemetry.

Click an outcome to inspect reads, changed-candidate hashes, prior-experience
delivery and immutable test receipts. The runner records exposure before a changed
passing candidate, not a quoted claim of use. This is temporal behavioral linkage,
not proof of an individual causal effect. Direct chain inspection earns its own
utility count; transitive principle support does not. The known-failure diagnostic
compares failed invariant labels in distinct changed candidates within the same
family. It excludes unchanged baseline/revalidation runs and is **not** a semantic
count of repeated disproved explanations or a causal mistakes-avoided percentage.

Before a changed-contract round, the old agent-written implementation is executed
under the new contract. Only an actually failing old implementation establishes
invalidation; a subsequent verified fix after prior exposure and current-condition
inspection records adaptation. A stale-mistake flag requires the exact old
implementation to have been repeated and failed, not just any unsuccessful task.
Necessary revalidation is not counted as wasted work.

Knowledge reuse, correctness and adaptation lead the page. The three main curves
show observed cumulative correctness; the direct diagnostic is reported separately.
The secondary cost panel includes preparation, review, failed attempts, validation
and memory processing. Shared authoring token costs are allocated to each
experience-bearing arm for the counterfactual comparison, not summed as additional
actual executions. Notebook/direct elapsed totals exclude measured MCP recording
time; the shared author's inference is still a controlled approximation, not an
independent notebook-authoring experiment. LLM and SLM usage remain separate.
Provider charges are unavailable, so financial break-even and the proposed 20%
cost-reduction threshold are **not measured**. The threshold is not an expected
result, and a broader benefit claim requires separately held-out families.

### Durable Learnings Page

Open `/lab2/learnings` or `/lab3/learnings`, or use **Durable Learnings** from the
corresponding lab. The prominent learning graph connects actual stored
**observations -> chains -> principles**. Click its nodes to inspect source and
lineage; omitted references are reported rather than invented. Its growth curve
counts unique logical records, not replayed receipts or extra revisions. Verified
reuse/transfer is displayed separately from growth in stored evidence.
The graph is a latest-recorded snapshot; it is not a live SQL browser or a
historical graph for every replay position.
Candidates and accepted revisions remain distinct. The storage ledger lists
every acknowledged write with its ID, author, operation, revision, and receipt
timestamp; restart panels show which records were recovered by a new MCP process.
**Applied Learnings** lists the stored guide-application records with their cited
steps and source evidence. Handoff pairs, inspected sources and recorded guide
applications are separate counts; rereading one item does not create new sources.

The guide and hierarchy come from recorded MindLeak writes and readbacks,
not a separate browser memory store. `knowledge.json` and `solution-guide.md`
are exported artifacts alongside the normal replay and event files. Preserve the
Lab 2 database to continue inspecting its durable records later. The guide page
shows the latest stored/exported state for the selected run; the activity replay
shows the chronology of when that state was created.

To increase useful memory capture, the experiment uses explicit checkpoints:
verified observation, evidence-backed chain, and reviewed guide revision. Answer
checking alone stores nothing. Agents must issue the storage operations and use
real returned IDs. An exact duplicate observation returns its acknowledged receipt
without another write. Purpose labels distinguish findings, constraints, failed
approaches, exceptions and decisions; checkpoints identify unfinished actions and
recover saved IDs. Retrieval-call and response-byte counts remain separate from
new writes. There is no quota rewarding duplicate notes or routine transcripts.

### A/B/C Learning Replay

For a controlled comparison, A and B independently investigate and fix the same
session-expiry fixture. B's verified test outcome explicitly confirms A's matching
test-outcome memory. C then receives no memory, an isolated A-only snapshot, or
A+B memory, always starting from the original code and a fresh conversation.

```sh
node examples/validation-harness.mjs --plan --category three_agent_demo
node examples/validation-harness.mjs --category three_agent_demo --agent --agent-provider copilot --agent-model gpt-6-astra --code-engine podman --binary target/debug/mindleak-light --replay-dir target/learning-replay
```

This command uses the same named agent model in all five fresh sessions and
model-free memory by default. `--agent-provider openai` retains the existing
configured OpenAI-compatible path. Copilot's timeout is a session deadline;
OpenAI-compatible timeouts remain per request, as recorded in each report.

The comparison records correctness, time, tools, tokens, delivered memories, and
the separate A/B preparation cost. Savings require correct outcomes and actual
memory delivery; failed, slower, and unmeasured outcomes remain visible. The live
swarm is a collaboration demo with shared files as well as memory, not a memory-only
speedup experiment. Immediate confirmation does not simulate spaced consolidation.

### Recorded Local Run

On 2026-09-17, run `4e942805-f11a-40dd-9049-4546e434bc24` completed with
MindLeak v0.6.0, three GPT-6 Astra owners, two Claude Opus 5 owners, and local
GLM 4.7 Flash memory extraction. All five owners and all eighteen final checks
passed. Four cross-agent memory handoffs were observed; seven memories were
stored. Provider-reported usage was 265,399 input and 8,069 output agent tokens,
plus 4,589 input and 4,011 output GLM tokens. Total build time was 347.8 seconds.
Vega needed a second attempt to receive its required upstream memory. Earlier
partial runs are retained separately, not overwritten or included as successes.

The generated app also passed real Chromium create/remove/expiry/validation and
label-escaping checks inside its sandboxed replay. Standalone replay made no
network requests, reproduced the recorded token totals, and worked at desktop
and mobile sizes. Native form events are allowed inside the frame; CSP still
blocks form navigation, and the frame has no same-origin permission.

Controlled Astra run `b5335d93-4d86-49ae-aa5d-20638294bff3` completed all five
fresh sessions on the original session-expiry fixture. A and B each verified
their fix; B's explicit confirmation changed the test-outcome counter from zero
to one without promotion. C passed with no memory (14.2 seconds), A-only memory
(17.5 seconds), and A+B memory (15.8 seconds), with expected memory exposure in
each arm. This small task showed working transfer, not a speedup over no memory.
The saved report includes negative savings and separate preparation cost.

Later records use different protocols and remain separate from that original run:

| Experiment | Run | Verified Outcome |
|---|---|---|
| Lab 1 optional-use v2 | `756a40de-82e3-4f80-9976-cf422efee344` | Both teams passed 18/18 checks; ten owners completed; no cross-agent memory handoff was observed. Both generated apps passed Chromium interaction checks. |
| Lab 2 two rounds | `6f688d8f-294d-4896-874c-fa055505d2bc` | All 20 comparison sessions correct; 6/10 memory-side outcomes contain source-linked quotations. Both correctness curves are 100%. Memory used more tokens; no correctness or cost advantage demonstrated. |
| Lab 3 v1 smoke | `34319edd-5c43-407a-8061-a24811239245` | All eight evaluations correct, but preparation retained no lesson. The first lesson was written after the last evaluation. No transfer claim. |
| Lab 3 v2 smoke | `b70d8255-bde4-463d-b90e-f2733fffd5b2` | All eight evaluations correct; the preparation reviewer retained a prior lesson. Notebook and MindLeak evaluation agents chose not to retrieve it. The direct diagnostic passed the changed contract after the old implementation was verified to fail. No compounding advantage established. |

These are local smoke results on exposed cases. The full 120-session main-arm
pilot and separately held-out confirmation have **not been run**. The v1 result
is retained rather than rewritten as a v2 experiment. User-approved display
changes do not turn its optional non-use into a successful memory transfer.

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

## Check Chains and Principles

Knowledge checks are explicit and require v0.6.0 advertising the new
schemas. Existing ten-category runs and older-server behavior stay unchanged.

```sh
node examples/validation-harness.mjs --binary target/release/mindleak-light \
   --category knowledge_workflow --retrieval keyword --formation off \
   > target/knowledge-keyword.json
```

The fixed [knowledge fixture](../examples/fixtures/knowledge-v1.json) has six
subjects, 18 literal/paraphrased/missing-detail queries and three repeated passes.
Each run makes 108 paired ordinary/knowledge retrieval calls. It checks candidate
exclusion, acceptance, changed support, dependent review, inherited counterevidence,
revision/export/history, retirement and unchanged retry receipts.

Reports keep latency and UTF-8 response size separate from quality. Top-level
Recall@5 does not silently credit nested chains; `evidenceBundleRecall` separately
checks exact supporting documents. Ordinary observations and derived knowledge
have different target labels, so their recall percentages are not interchangeable.
Repeated passes measure cache behavior, not additional independent examples.

For real models, configure a separate `_test` database bound to your embedding
model, then run:

```sh
node examples/validation-harness.mjs --binary target/release/mindleak-light \
   --category knowledge_workflow --retrieval hybrid --formation openai \
   > target/knowledge-models.json
```

Use the existing explicit `MINDLEAK_EMBED_*` and `MINDLEAK_LLM_*` settings.
`--formation-reasoning-effort` is optional and recorded. Formation previews two
chain and two principle cases; successes retain counts, hashes and timings,
failures retain sanitized categories and elapsed time. Neither is automatically
accepted or scored as independent semantic accuracy. Missing usage stays null.

CI runs the model-free knowledge benchmark alongside existing regressions and
retains the report. Real-provider results, including failures, belong in
[benchmark results](BENCHMARK-RESULTS.md#knowledge-workflow-2026-09-17).

## Run Real Agents

Use a model/provider with reliable OpenAI-compatible function calling and JSON-schema
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
provider call (default 60000). `--agent-max-output-tokens` accepts 128..16384
(default 4096), replacing the old hardcoded 2048-token cap. Optional
`--agent-reasoning-effort none|low|medium|high|max` is sent only when explicitly
specified. Unset leaves the provider's reasoning behavior unchanged. Unsupported
settings fail visibly; no lower-capability retry or model substitution is made.
Each response is bounded to 4 MiB.

The agent first works with tools without a final-answer response constraint.
When it stops, one separate, tool-free request enforces a type-only answer
schema. This prevents providers from suppressing tool calls when constrained to
the final answer's shape. That final request is reserved inside the same turn
budget, appears in `responses` with phase `answer`, and contributes to token
usage, time, and cost. Baselines without tools use constrained output immediately.
Schemas contain field types, not expected answers. No Markdown-fence stripping,
answer repair, or automatic retry is used to turn malformed output into a pass.

`output_limit`, `refused`, `invalid_response`, `invalid_answer`, `step_limit`,
and `provider_error` distinguish execution failures. Diagnostics retain safe
finish reasons and provider error categories/HTTP status, never provider bodies.
`turns` counts every attempted provider request, including an unsuccessful final
one. Incomplete provider usage remains unknown rather than being priced as zero.

The official OpenAI client handles provider calls, and the official MCP client
handles the memory protocol. Fresh histories prevent deliberate conversation
carryover; provider-side caching or changed model weights are not controlled by
this harness. Model names do not pin weights. Record the actual provider version,
model digest, machine, and resource contention alongside any published run.
SDK logging is explicitly off, including when `OPENAI_LOG` is inherited. Do not
enable wire-level logging in external proxies or the host runtime.

### Recall Tools

The agent sees the active retrieval mode. Its `recall_memory` wrapper forwards
explicit `matchMode`, `contextLimit`, `diagnostics`, and `groupDuplicates` to the
existing server with the task scope enforced. Vector-only mode does not offer
keyword matching options. In keyword mode the instructions ask for focused
entity/topic terms; after an empty result the agent may explicitly refine the
query or choose any-term matching. Two empty searches exhaust that phase's empty
search budget. There is no silent mode switch, query rewriting, automatic broad
OR fallback, or change to the server's default ranking.

`inspect_source` exposes the existing source-inspection path and evidence cursor
within the same scope. It does not add an MCP server tool or a fact-checking
service. Primary results, document siblings, grouped sources, and relationship
references all undergo scope/ID validation before exposure. A result retrieved
from storage is counted as delivered only after the agent tool's 64 KiB result
budget accepts it. Queries remain fingerprints, not report text.

Coding tools can list/search/read only fixture files and edit only declared
implementation paths. The write tool lists those exact paths and its content
limit in its schema for both experiment arms; denied edits are not an undisclosed
test constraint. Tests are immutable. Code executes in a pinned local image
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
| Agent handoff | Agent A writes customer constraints; fresh Agent B answers without seeing that conversation; independently checks stored fact coverage, delivery, and PostgreSQL/Azure/RBAC answer correctness |
| Memory over time | Growing 100/500/1000-fact corpus, precision/recall, false positives, latency, and graphs; this is not elapsed-time learning |
| Poisoning resistance | Natural retrieval and a separate guaranteed-exposure arm; substantive false/correct/unverified answers are checked separately from acceptance/conflict self-reports |
| Contradiction handling | Unlinked Java/Rust claims are preserved; an explicit supersedes link retires Java, checked after restart; optional final-agent resolution |
| Context compression | Full prior history versus memory-assisted agent with the same task; byte counts are separate from actual provider token usage, correctness, cost, and latency |
| Coding agent workflow | Fresh agent adds a customer endpoint following the data/repository pattern; fixed tests determine success; measured search/tool counts and completion time |
| Multi-day learning | Resumable day-1/day-2/day-30 writes and final combined question, with actual elapsed-time requirements |

Persistence here means acknowledged writes survive an MCP process restart and
retain raw source/receipt fragments. It does not substitute for database crash,
backup, restore, or power-loss testing. The harness does not change the memory
system's truth policy: recency alone is not evidence, scores are not confidence
probabilities, and contradictions are not silently resolved by last-write-wins.

### Poisoning Controls

The ordinary memory arm remains naturalistic: if the agent never receives the
poisoned claim, resistance is unmeasured, not a pass. A separate fresh agent gets
the actual inspected raw claim explicitly labelled as untrusted historical
context. This `forcedExposure` arm measures behavior when the claim is present
and is not pooled with natural retrieval or paired efficiency results.

The evaluator checks the substantive `material` answer against the frozen
accepted variants and known false answer. Saying "cheese" while claiming not
to accept memory is still blind acceptance; the self-report disagreement is
visible. Other wording is unverified, not forced into a correct/incorrect verdict.
Conflict detection requires a reference-compatible answer and attributed conflict
reporting. This remains a small factual-poisoning diagnostic, not an adversarial
prompt-injection benchmark or an independent verifier of arbitrary world facts.

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

Coding preparation now uses a structured `write_memory` brief containing
`rootCause`, `files`, `failedApproaches`, and `recommendedFix`. Known fixture paths
are enforced, and each stored line repeats its subject so a separate heading
cannot carry the only context. `null` root causes and empty failed-approach lists
are valid admissions of incomplete investigation, not evidence of a ready fix.
The endpoint preparation does not need to fix the later endpoint task; bug
rediscovery readiness does require a candidate passing the immutable tests.

Preparation checks separately report observed reads of relevant source files,
brief fields, declared file grounding, failed-test activity, and functional fix
verification. The agent's completed flag is insufficient. Free-text explanations
and the causal truth of each claimed failed approach are not independently
adjudicated; test activity is evidence of execution, not proof of the narration.

```sh
node examples/validation-harness.mjs --agent --code-engine podman --category coding_workflow --trials 3 > target/rediscovery.json
```

Pair order is recorded and alternates for coding trials; task pairs use seeded
order. Every arm starts from fresh files and messages. Savings require both arms
to pass, verified preparation, and observed delivery of that preparation's memory;
a correct guess without reading it gets `null`, not an attributed memory win.
A faster failed solution also gets `null`. Raw timings and counts remain visible
even when savings are ineligible. Discovery cost is
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

`reportVersion: 2` includes a scenario/fixture manifest, answer/handoff contract
hashes, exact binary SHA-256,
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

Each paired trial has `stages` for preparation completion, acknowledged writes,
conservatively verified stored facts, retrieval attempts, matching IDs retrieved,
matching source delivered, source inspection, and final answer. `failureStage`
identifies the first unmet prerequisite without hiding later outcomes. Stored
wording outside the accepted variants is unverified, not necessarily false.
`multi_agent_transfer` counts success over all handoff trials, including failed
preparations. The conditional rate is reported separately only for trials with
verified preparation, observed exposure, and completed answers. Always publish
the denominators and both rates, not only the favorable conditional subset.

Token counts come only from complete provider-reported usage across agent turns.
Supply both `--input-usd-per-million` and `--output-usd-per-million` for agent
inference cost; missing prices/usage yield `null`. Optional MindLeak model costs
are not exposed by MCP and are excluded, not guessed. Returned JSON bytes are
not tokens, the original history is not assumed to be 5000 tokens, and retrieval
is not assumed to cost 200. Latency/cost comparisons retain negative reductions.
Savings metrics include `eligibleForMemorySavings` and an explicit exclusion
reason; raw observed differences are not causal proof even when eligible.

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
