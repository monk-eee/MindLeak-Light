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
Current runs use **report version 2** and agent policy `knowledge-first-tools-v3`.
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
(Lab 1), **Form** (Lab 2), and **Reuse** (Lab 3). Route names and historical records
retain their identity. Changed authoring policies have new protocol versions;
old recordings are not relabelled.

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
Each team can inspect only its own evolving project. New memory-team runs use
**verified-handoff v3**: each owner publishes a concise source-qualified finding
after its component tests pass, and dependent owners read every current handoff
through MCP before editing. Controls remain memory-free. Code correctness and
collaboration completion are recorded separately; both must pass for a complete
memory-team run. Historical `optional-use-v2` recordings keep their original
policy and results.

Atlas and Iris investigate independently. Nova receives Atlas and Iris, Vega
receives Atlas, and Orion receives Nova, Vega and Iris: six declared dependency
handoffs. The task supplies acknowledged source IDs, not memory contents or a
reference solution. `inspect_source` retrieves each original handoff through the
scoped MCP connection; an ID, a keyword search excerpt or reading the shared code
alone does not satisfy delivery. Agents still check the current implementation.

`write_memory` is available only after the owner's complete component check
passes. Its bounded handoff names Session Desk and every owned module path,
states the interface/conditions and describes the tests actually exercised. A
successful storage receipt is required before releasing dependent work. Another
edit invalidates that handoff until the new candidate is tested and published.
Storage failures and missing handoffs remain incomplete rather than being hidden
by passing code. This is a component delivery requirement, not a quota for novel
knowledge or independent confirmations. Source wording remains agent-authored.

The sharing panel reports publishing components, current dependency sources read,
cross-agent deliveries and verified component code independently. Continued runs
retain their earlier memory records but must read the newly verified dependency
handoffs, not substitute an older same-author finding. The no-memory comparison
still has identical code fixtures and checks, but no publication/delivery contract;
this guided collaboration demonstration does not establish an adoption or speedup
claim. Existing caller memory policy and MCP defaults are unchanged.

Lab 1's network cards show acknowledged records and handoffs received from distinct
other agents, not Lab 3's linked-task-use counter. Repeated fragments from one
sender do not create another handoff link. The memory-network activity count covers
its five displayed agents; control-team activity is reported separately. Character
motion follows active inference or pending tool calls and stops on pause, completion
or reduced motion. The memory hub and animated connectors follow the rendered
card positions, including live model selectors, rather than fixed coordinates.
The build stage follows coded, verified, published and shared milestones. Lab 1
does not display an empty chain/principle graph or the unrelated reuse scorecard
or a formation score; those belong to the knowledge experiments that measure them.

Use a dedicated disposable database ending in `_test`, the native server binary,
your existing Copilot login, local GLM, and Docker or Podman:

```sh
npm ci --prefix examples
node examples/node_modules/playwright/cli.js install chromium
export MINDLEAK_TEST_DATABASE_URL='postgresql://USER:PASSWORD@localhost:5432/mindleak_demo_test?sslmode=disable'
export MINDLEAK_DEMO_MEMORY_URL='http://127.0.0.1:11434/v1'
podman pull docker.io/library/node:22-bookworm-slim
node examples/swarm-demo.mjs --binary PATH_TO_V060_BINARY --agent-provider copilot --code-engine podman --port 54584 --output-dir target/swarm-labs
```

Chromium is required for Lab 1's artifact acceptance checks. An existing compatible
browser can be selected with `MINDLEAK_BROWSER_EXECUTABLE=/absolute/path/to/chromium`.
The runner checks browser availability before starting paid model work. Lab 2 and
Lab 3 do not require a browser to execute their code fixtures.

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
their prerequisite components pass and the memory team's handoffs are acknowledged.
`--attempts 1..3` defaults to two attempts
per agent, retaining failures in the recording. The page can stop the current run.
The problem/parameters panel and per-agent model selectors apply to the next run
and lock during execution. The task can refine the bounded Session Desk fixture;
it does not yet scaffold arbitrary projects or change the immutable interfaces.
Only explicit commands from the local page can start inference. The chosen model
providers receive the synthetic build context; event telemetry stays local.
The default listener is loopback-only. There is no host code execution or
production memory access.

### Trusted LAN Browser Access

The native Node lab has an explicit trusted-private-LAN HTTP mode with **no
login and no TLS**. Reachable clients can read lab evidence and use Run/Stop.
This changes only the lab listener, not PostgreSQL, MCP, or Docker ports. Do not
port-forward this development mode or use sensitive source data.

Keep the existing database, launch settings and output directory, and add:

```sh
--listen-host 0.0.0.0 --public-origin http://192.168.68.63:51722
```

Use the current `ipconfig getifaddr en0` address and the existing lab port.
Both options are required; the public origin must be private IPv4 HTTP without
credentials or a path. Omitting them retains loopback-only behavior. Only the
configured LAN and localhost Host/Origin values are accepted; forwarding headers
are rejected. Navigation, assets, events and commands remain same-origin, with
no wildcard CORS. Browser-local reviews are separate for each browser origin.

Check `/lab1/state`, `/lab2/state` and `/lab3/state` before restarting. Wait for
active experiments, retain all reports, and reopen current recordings using the
matching recording options. Keep one current lab process. A networking check
does not need to start a model run.

If macOS prompts, allow incoming connections for the actual Node executable;
do not disable its firewall globally. Testing the Mac's own Wi-Fi address does
not prove access from another computer or rule out Wi-Fi client isolation. Open
`/lab3/` on the configured origin from that computer to confirm. No login or
certificate installation is needed for this trusted-LAN mode.

Each agent has a fresh conversation and its own editable paths. It can read the
project and shared MCP discoveries, but can publish a finding only after its own
component tests pass. Final integration runs eighteen immutable checks per team in a
network-disabled container against a fingerprinted source snapshot. Coordination
lives in this example runner; MindLeak remains the memory server.

New Lab 1 runs use `knowledge-first-handoff-v5`. Every memory-enabled owner,
including one without component dependencies, searches the task subject at startup,
inspects a returned original source, and records an apply/adapt/reject decision
against an exact quotation from a current file before editing. Supplied dependency
IDs do not replace this search. A genuine miss or unavailable lookup permits local
work after explicit assessment; current dependency-source handoffs are still
required. Each fresh attempt performs its own check. Search and assessment counts
are separate from publication, delivery, correctness and demonstrated benefit.
Each current handoff pins the owner's module hashes. Before editing or publishing,
dependents must read every listed module through `read_file`; those read hashes
and the files still on disk must match the published hashes. An apply/adapt
assessment of a current handoff must quote one of its actual module paths, not
the consumer's pending stub. Missing, stale or unpublished dependency changes
block completion. Reports distinguish original handoff delivery from checked
dependency implementations; file access is not a proof of semantic understanding.

The existing 18 named fixture checks now also require nonempty status badges on
active and expired cards. This changes the fixture fingerprint without rewriting
earlier results. Old v2/v3/v4 recordings retain their policy, fixture hashes and
recorded outcomes; missing startup or file-verification measurements stay unknown.

Every Run click creates a new recording directory, without overwriting or deleting
earlier results. `run.json` records the capture ID, start time and parameters before
execution; the runner's eventual run ID is retained separately. `events.ndjson`
receives metadata-only events incrementally. `evidence.ndjson` separately journals
the explicitly visible synthetic findings, safe tool details and knowledge snapshots.
Normal failure and cancellation retain these journals and a `partial-report.json`.
An export failure also retains the computed report rather than discarding its results.
These are local buffered files, not a power-loss-safe transaction log: an abrupt
process or machine failure can lose recent writes, and automatic crash resume is
not implemented. Back up the output directory for long-term analysis.

Completed captures also contain `report.json`, `memories.json`, `tool-details.json`,
and a standalone `index.html`. Successful builds contain `session-desk.html` and
`session-desk-daleks.html`, with separate `project` and `dalek-project` source
directories. The artifact tabs switch between their sandboxed previews. Playback
needs no server or model. Regenerate a page into a new directory:

```sh
node examples/demo-replay.mjs --report target/RUN/report.json --output-dir target/replay-copy
```

### Acceptance and Continued Studies

**RUN FINISHED** means execution ended, not that every requirement passed.
**Acceptance Evidence** separates execution, immutable requirement-test receipts,
quality review coverage and observed learning. Missing or incomplete test receipts
cannot count as a pass. Learning activity is not an acceptance gate, and a passing
fixture is not a production-readiness certification.

Lab 1 checks each generated artifact in Chromium at 1440 x 1080 and 390 x 844.
The checks cover rendering, creating and removing sessions, validation, text
escaping, controlled expiry, blocked external requests and responsive layout.
Each receipt names the artifact, its exact SHA-256, viewport and individual results.
A review of one team's output cannot cover the other team's output; stale hashes
do not count. Failed checks keep the artifacts and mark the run incomplete.
Accessibility, security and maintainability remain explicitly unreviewed: these
browser checks are not comprehensive audits. To check an older build without
running models or changing its original record:

```sh
node examples/demo-replay.mjs --report target/RUN/report.json --output-dir target/reviewed-copy --verify-build
```

**Fresh study** is the default: new memory scope, preparation and agent sessions.
**Continue learning** instead uses the completed run currently displayed by the
server as its parent. Reopen an older completed report with the recording options
above to continue that study. The server checks the exact parent run ID; a browser
file import alone does not change the server's parent. Incomplete runs remain
archived but cannot currently be continuation parents. Missing retained database
evidence fails continuation rather than silently starting fresh.

Each continuation still creates new conversations, fresh task workspaces and a
separate recording directory. Lab 1 inherits only the memory team's stored
findings. Lab 2 reuses and verifies its accepted principle collection instead of
replaying initial preparation. Lab 3 reuses the same prior lessons for MindLeak, the notebook and the
direct-lesson diagnostic; its Fresh Agent stays unseeded. Daleks never inherit
memory, conversations or findings, and control answers never enter learning.
Changing Lab 3 from Smoke to Learning or Pilot prepares only newly introduced
families, retaining the existing principles. New recordings include a baseline of
inherited IDs/revisions; a revision does not count as a new principle.
Existing storage and response bounds still apply; repeated runs do not create an
unbounded knowledge store.

The study history links parent run IDs, records per-arm verified completion and
retained knowledge counts, and includes preparation, review and failed-run costs
in cumulative totals. Compact history summaries do not copy prior conversations
into new prompts. Task families are labelled previously exposed on continuation:
a rising curve is not held-out evidence or proof of a causal memory advantage.
Flat, negative, failed and no-new-learning results remain valid study outcomes.

### Formation and Reuse

The live learning stage leads with actual task completions, tool actions, source
episodes and accepted principles at the displayed event position. The knowledge
summary shows **Knowledge Formation**: unique source observations, recorded
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
Lab 2 live source-linked use matches a passing assessment to its earlier saved
application receipt for the same agent and case, including two inspected source
episodes. Retrieval alone, mismatched receipts and future events do not count.
Unmeasured index values display `--`, not a fabricated zero.

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

The prominent live stage shows current agent/tool activity, elapsed work, a growing
source-to-principle graph, recent actions and earned capture/link/formation/reuse
milestones. The READ, WRITE and FORM indicators follow actual pending calls.
Server-sent events update these while a run is active, not just on completion.
An elapsed timer or working animation is not an estimate of unreported tokens.

Completed recordings automatically play and loop on experiment pages as
**RECORDED REPLAY**, without model calls. Experiment pages retain their live agent
stage. **Knowledge Control** instead opens on the latest recorded snapshot with
playback paused: a review queue, principle playbook, source lineage, and human
decision panel. Selecting evidence opens its original wording in the workspace;
raw records and the original guide export remain available behind disclosures.

**Human sign-off is browser-local**, separate from recorded agent acceptance. A
reviewer supplies a name and note, explicitly acknowledges evidence for approval,
then confirms approval, a revision request, or deferral. Each decision binds to
the run, revision and exact available record/support/source snapshot. Changed
evidence requires a new decision; unavailable or challenged support blocks approval.
Review is locked during a live run or historical playback. The log survives reload
in that browser origin and can be downloaded, but it is not authenticated approval,
an MCP write, a dispatched revision task, or a gate on future agent use. Sealed
reports and benchmark results never change. Storage errors do not report a saved
decision; the bounded local log retains at most 200 decisions and 4 MiB per run.

Below the review workspace, **Knowledge Factory** retains source-intake slips,
chain assembly, a principle catalogue and a full-width evidence graph. Library
controls open the complete record index. Only recorded operations and acknowledgements drive
the factory's conveyor, rollers and arrival motion, including paired
knowledge/storage receipts for one write.
The shared playback controls, loop switch and **Replay activity** move between
the stage and the assembly view without starting another run. Future nodes are hidden
until their recorded creation; revisions do not add another node. The displayed
document text remains the latest retained version, not a complete historical
document reconstruction. Full acceptance and outcome tables remain report-level
evidence, separate from playback. Pause and reduced-motion stop animations;
reduced-motion also disables automatic replay. Only an explicit Run command starts
model work. Fresh/continued study controls are visible beside the stage.

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
   second chain, then authors supported principles from the available chains.
3. Nova, Vega, and Orion retrieve the stored guide for their new cases. Each adds
   a source-backed chain, then authors a distinct principle, explicitly revises
   a relevant existing ID, or records no new learning. Each principle selects
   2..8 relevant accepted supports rather than absorbing every case chain.
4. MindLeak is actually stopped and restarted between stages. The runner reads
   back every observation and current knowledge document, requiring identical
   IDs, revisions, raw sources, and structured content. Recorded child PIDs show
   the process change; fresh conversations alone do not count as persistence.
5. Every accepted principle is extracted through `recall_memory` with
   `knowledge.operation=export`, as JSON and Markdown. The first guide ID remains
   the stable entry in older report fields; `guides` and `principles.md` retain
   the full collection.

Every start prompt explains principles (procedures/applicability), chains
(reasoning/conditions) and observations (source evidence) before the task.
Memory-enabled investigators retrieve a compact accepted principle before choosing
an approach, then follow the relevant chain and observation references as needed.
The first two seed assessments remain independent despite receiving this orientation.
Assessment, evidence capture and guide authoring use separate fresh sessions.
Guide authoring receives stored evidence instead of an earlier conversation.

Protocol **v8** binds preparation-stage guide application to an actually delivered,
current review-ready principle before `probe_upgrade` or `verify_assessment`.
A search that returns only case chains no longer permits verification to freeze
an empty guide binding. Search results and checkpoints distinguish `applicationGuides`
from supporting case/source references. When no principle has been delivered, they
provide explicit `principleReferences` from this run's stored catalogue; with one
candidate, `nextAction` names its `inspect_knowledge` call. These are pointers,
not retrieved claims or relevance guarantees. Inspection uses real scoped MCP and
returns the same compact procedure and original-source pointers as guide search.
Keyword queries, filters, scores and no-memory controls remain unchanged.

The passing assessment and checkpoint return the exact eligible principle
`chainId` and `revision`. `apply_guide` must use that pair, two exact conclusion
quotations and inspected current evidence, with two distinct original supporting
source episodes. Case-chain IDs, wrong revisions, changed review state and guides
first retrieved after verification are rejected. A later lookup does not rewrite
the earlier assessment's eligibility. Recovery errors identify whether a principle
must first be inspected or the caller supplied the wrong application reference.
Safe tool metadata retains IDs and revisions, never the quoted source bodies.

The **v7** synthesis workflow separates bounded evidence preparation from the model's
decision.
The runner retrieves the current case chains, principle catalogue and
every referenced original observation through MCP, deduplicating source episodes
and repeated support documents without dropping conditions or counterevidence.
The complete dossier, verified current assessment and pending candidate IDs fit
within 64 KiB or the phase fails explicitly. It is supplied as untrusted reference
context, not as instructions or an automatically validated conclusion.

The fresh guide-author session has only `propose_guide`, `accept_knowledge` and
`skip_learning`. No search, source-read or checkpoint tools remain in that phase,
so it cannot spend the session rereading evidence. It must explicitly review and
accept a pending candidate before proposing another, make a justified new proposal
or revision followed by acceptance, or give an evidence-based no-new-learning
reason. A new case-specific answer does not itself require a new general rule.
The runner verifies the final checkpoint; the model's completion claim alone is
insufficient. Changed catalogue revisions invalidate review. Challenged principles,
missing sources, oversized dossiers and provider failures cannot become a skip or
a successful guide. Model budgets and the existing bounded idle continuation are
unchanged. Review time, source-delivery bytes and unsuccessful attempts remain in
the measured costs. The same phase split applies to between-round guide review;
neither evaluation arm gains write access.

The startup checks introduced in **v6** still apply before `probe_upgrade`
or `verify_assessment`: scoped guide search and inspection of two distinct original
supporting observations when a principle is delivered. The independently assessed
seed cases remain isolated. Guide checkpoints expose exact `pendingAcceptances`
IDs/revisions; proposal receipts name the next acceptance action, and retries
prioritize those candidates rather than repeating unchanged source reads. No
candidate is accepted automatically. Exhausted or explicitly incomplete agents
remain failures, with their verified investigation and stored evidence preserved.

The multiple-principle workflow introduced in **v5** remains, with
a bounded inventory of 32. Source selection and counterevidence requirements still
apply. Different IDs or paraphrases are not independent knowledge. It retains the
compact delivery introduced in v4, which removes repeated rationale, acceptance metadata and duplicated
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
caused a better outcome. Matched evaluation uses a read-only version of the startup
check: the memory arm searches and inspects a cited original observation before
probing or verifying; an actual miss/error permits local work. Both arms retain
identical correctness checks and no evaluation writes. Retrieval and an exact
guide-step/source quotation record attributable use separately from correctness.

### Matched Dalek Rounds

After preparation, the runner restarts MCP and verifies all accepted principles,
then freezes their IDs, revisions and documents for a round. Five new codebase variants go to five matched
memory/Dalek pairs simultaneously. The memory team can search the frozen collection and
inspect its sources; no agent in either arm can write during comparison. The runner
checks the entire collection again only after all ten sessions finish. Session start skew and
actual provider usage remain in the report; a common scheduling barrier does not
guarantee identical provider queue time.

Orion then reviews only verified memory-team results in two fresh evidence/guide
sessions. It can store useful applications, constraints or exceptions, form an
accepted round chain, and form distinct principles or revise existing ones. It can instead explicitly
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
Fresh study creates a new scope and independent preparation. Multiple rounds within
a run, or an explicit continuation from its completed report, reuse the existing
guide while retaining a separate record of every run's work and costs.

### Lab 3: Reuse Knowledge

The main `smoke`, `learning`, and `pilot` profiles use **protocol v5,
knowledge-first workflow v2**. They retain PR #41's frozen cases, multi-principle
support and continuation, but require the experience-bearing agents to look up
prior knowledge and assess applicability before editing. The explicit `adoption`
profile preserves the optional-lookup v3 diagnostic on the Learning schedule.
The separate [`mechanism` profile](#lab-3-v4-investigation-learning) remains the
v4 formation experiment. Old recordings, their policy and scoring are never
converted or overwritten; continuing an old study does not make its earlier
results comparable to a new policy.

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

The runner supplies the actual policy in each isolated session. The main workflow
is **retrieve, assess, apply/adapt/reject, verify**. MindLeak uses
`recall_experience`; the notebook uses `search_notebook`. Both start with the same
task subject already supplied to every arm, not a gold answer or a hidden family
hint. Keyword instructions explain PostgreSQL's AND semantics; one focused
refinement after an empty result remains available. Retrieval modes, relevance
filters and scores are unchanged. Installed skills are deliberately not discovered
by these isolated model sessions.

Before `write_file`, both experience arms must call `assess_experience` with a
delivered lesson ID, an applicability decision, reason and exact excerpt from a
current file they inspected. `apply`, `adapt` and `reject` require actual delivery;
`no_match` and `unavailable` require a real empty or failed lookup and allow local
investigation to continue. A later lookup requires a fresh assessment before the
next edit. No file-read quota, forced chain inspection, new note or stored feedback
is required. Source matching verifies quotation presence, not the semantic truth
of the agent's assessment. The fresh arm has no prior-knowledge tools; the direct
arm remains a separate delivery diagnostic.

Initial notebook and MindLeak responses expose the same procedure, conditions,
limits and IDs within 2,048 UTF-8 bytes; supporting evidence is available on demand.
Code correctness still comes from the immutable tests. A lookup or assessment
alone does not earn reuse credit: the assessed applicable lesson must precede
an actual changed candidate that passes. Rejected lessons, misses, errors and
incomplete workflows remain explicit, with all scheduled tasks retained in the
denominators. The `adoption` diagnostic instead keeps v3's optional retrieval and
original temporal-use scoring.

Protocol **v5**, fixture **v1**, retains the separate investigation/documentation
sessions and multi-principle support introduced in v2/v3. A family may retain several distinct principles,
keyed by stable principle ID rather than by family. `list_principles` exposes the
catalogue to curators; `retain_lesson.revises` explicitly targets a refinement.
Equivalent lessons and exact accepted source chains are reused instead of creating
duplicates. There is a 32-principle inventory bound and ten retention calls per
review, not a quota. Each rule still needs inspected source evidence and a verified
changed implementation. A reviewer may report no new learning. Every evaluation uses a fresh session and private
workspace. A seeded randomized schedule runs one session at a time across all
arms, including the separate diagnostic, to avoid concurrent provider congestion.
Experience is frozen and rechecked across every round's arms and repetitions.
Only then can a reviewer retain new evidence, a correction or an exception using
verified memory-side cases. Control answers never enter the learning loop.

A review is complete only when the agent finishes successfully with
`completed: true`. A completed review may legitimately retain nothing. Failed,
missing or explicitly unfinished reviews instead produce
`learning_review_incomplete` and a partial run, even when every coding check
passes. `learningReviews` records scheduled, completed and incomplete review
counts separately from task correctness and observed reuse.

If the Copilot SDK becomes idle after tool requests without a final answer, the
adapter permits one continuation in the same session. It retains acknowledged
tool results, uses only the remaining time and turn budget, and counts the extra
inference. Cancellation, quota failures and exhausted budgets do not resume; a
second unfinished response remains incomplete. Recovery attempts appear in
`session_resumed` events and `generation.toolOnlyIdleResumes`, not as fabricated
answers or replayed memory writes.

The integrated repair smoke run `c3f3a27f-2ec5-4f4f-b6fd-ac8d075d1681` used
GPT-6 Astra, model-free storage and the protocol-v5 knowledge-first workflow.
All 27 fixture checks and all three reviews completed. MindLeak retrieved and
assessed prior knowledge on both evaluation tasks, with two verified temporal
reuse outcomes; the notebook recorded one application and one rejection. The
final review revised an accepted principle, and three restart checks passed.
This is one exposed synthetic family with required consultation, not spontaneous
adoption or a measured advantage. MindLeak used 159,201 agent input tokens
including preparation/review versus 15,045 for the fresh control. No idle
continuation was needed in that model run; deterministic regressions verify
recovery and the cancellation, quota, step and deadline boundaries.

The default **learning** profile covers five families, near transfer and changed
conditions: **30 main-arm sessions**, ten diagnostics, five investigations and
three documentation/review sessions. Its full plan and session counts are visible
before starting; selecting a larger profile increases model work.
The shorter **smoke** profile covers one family: six main-arm sessions plus two
diagnostics, one investigation and three documentation/review sessions.
The explicit **pilot** profile covers five
families, four follow-ups and two repetitions: **120 main-arm sessions**, 40
diagnostics, five investigations and five documentation/review sessions.
The **adoption** diagnostic uses the same five-family near/changed schedule as
Learning, but measures optional lookup under v3. It is not the main reuse workflow.
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
delivery, applicability decisions and immutable test receipts. Main v5 reuse
requires an `apply` or `adapt` assessment bound to delivered prior knowledge before
a changed passing candidate, not only a lookup or quoted claim. This is temporal behavioral linkage,
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

The workflow panel separates tasks with lookup, knowledge delivery, applicability
assessment and verified application. An old run with zero calls says **Not
consulted**, not that retrieval failed. Empty-result and error counts are separate;
missing assessment telemetry stays **Not recorded**. Original numeric reuse
results remain in the report. Formation, correctness and adaptation lead the page. The three main curves
show observed cumulative correctness; the direct diagnostic is reported separately.

The retained protocol-v3 smoke run `b13b00af-3d30-4bb1-bfe3-672c607e270c` used
GPT-6 Astra with GLM 4.7 Flash extraction. It passed 27/27 fixture checks, retained
eight observations, eight accepted chains and three accepted principles. Two
principles existed before evaluation; changed-contract review revised one and
added a third. This is actual multi-principle formation, not a fixed record quota.
The MindLeak and notebook arms did not retrieve in that run; their observed reuse
was zero, while the separate direct diagnostic recorded two temporal uses. All
arms passed both tasks, so no comparative improvement is established. Total
recorded agent usage was 171,719 input and 5,710 output tokens, plus 15,816 input
and 2,445 output extraction tokens across 32 writes; elapsed time was 405.3 seconds.
Earlier single-principle, empty-experience and negative results remain unchanged.

The secondary cost panel includes preparation, review, failed attempts, validation
and memory processing. Shared authoring token costs are allocated to each
experience-bearing arm for the counterfactual comparison, not summed as additional
actual executions. Notebook/direct elapsed totals exclude measured MCP recording
time; the shared author's inference is still a controlled approximation, not an
independent notebook-authoring experiment. LLM and SLM usage remain separate.
Provider charges are unavailable, so financial break-even and the proposed 20%
cost-reduction threshold are **not measured**. The threshold is not an expected
result, and a broader benefit claim requires separately held-out families.

### Lab 3 v4: Investigation Learning

This opt-in mechanism experiment asks what an investigation establishes for the
next agent, including when the original task is unfinished. It reuses the real
MCP tools, sandbox, fresh-session runner, journals and replay UI. It introduces
no server-side learner, extra MCP tool, database table or mandatory helper model.

```sh
node examples/swarm-demo.mjs --plan --rediscovery-profile mechanism
node examples/swarm-demo.mjs --lab 3 --rediscovery-profile mechanism --memory-model off --binary target/debug/mindleak-light --code-engine podman --port 54586 --output-dir target/investigation-learning
```

The second command requires the same explicit disposable `_test` database,
approved agent provider and sandbox prerequisites as the other labs. It starts
an idle lab; the page starts a run only on an explicit command. `--once` runs
and exits. The v4 profile refuses continuation from old or exposed runs. It is
available from a source build, not an added feature of published v0.6.0 packages.

#### Separate Phases

1. Two fresh discovery sessions investigate different continuation implementations
   and source groups. They can capture an executed failing probe or a successful
   behavior check while an unrelated identity check remains unresolved.
2. A fresh MindLeak author inspects the retained sources, proposes one conditional
   chain per investigation, explicitly validates those narrow claims, then proposes
   a principle supported by both current accepted chains. Two files from one case
   cannot satisfy the two-case requirement. Source labels do not prove independence.
3. A separate notebook author receives the same discovery observations and the
   same model/budget, but writes its own bounded procedure and Markdown sources.
   It does not receive MindLeak's completed principle. Both arms get one formation,
   two reserved validation, and one explicit acceptance/publication session.
4. Each fresh validator sees one reserved case and the frozen executable procedure.
   It records applicability and expected pass/fail before executing the checks.
   Predictions cannot be replaced. The positive case must pass; the boundary case
   must be correctly rejected or handled by the unchanged procedure. A failed
   boundary is retained as explicit counterevidence, not erased from the principle.
5. Four different evaluation cases cover near transfer, a different implementation,
   a changed completion contract, and an unrelated identity fault. The three main
   arms produce **12 matched sessions**; four direct-delivery diagnostics are
   separate. All start from the same case code and immutable tests with the same
   model and budgets. Retrieval is optional; misses and non-use remain in the denominator.
6. Knowledge remains frozen across all comparisons. Only afterward does each
   experience-bearing arm review its own outcomes. A reviewer can probe the unchanged
   rule on a new case, explicitly retain a measured exception, revise it, or save
   nothing. A changed principle stays a candidate needing fresh validation cases;
   already exposed cases cannot validate that new revision.

The discovery, reserved validation and evaluation fixtures have separate identities
and hashes frozen before inference. They remain **one synthetic problem family**,
not eight independent populations or a production holdout. Each observation keeps
its original source, complete probe receipt, source fingerprint, case origin,
overall task-completion flag and stated uncertainty. Quotes establish source
presence; probe results establish tested behavior. English causal explanations and
generalizations remain attributed claims, not independently adjudicated truth.

#### Outcomes and Costs

The v4 evidence view follows PR #41's unchanged live learning stage with checked discoveries, unfinished investigations
with findings, prospective predictions, supported pre-edit decisions, boundary
decisions, and retained exceptions. Decisions require an inspected source quote and
are recorded before editing; the evaluator checks the diagnosis and completion
signal against the frozen case. Later task completion is reported separately.
Neither a quotation nor a retrieval call earns behavioral reuse credit by itself.

No single intelligence or compounding score is introduced. The principle's executable
hypothesis is assessed separately from whether a later agent receives and uses it.
Direct delivery helps diagnose retrieval failure but never enters main-arm totals.
Optional non-use and no accepted principle are valid results, not missing successes.
All four planned reserved cases remain in the prediction denominator. A procedure
that cannot execute the complete test set records `execution_failed`, not a correct
prediction of behavioral failure. No-candidate and not-executed cases remain explicit.

Actual run token totals count each session once. Counterfactual arm totals allocate
shared discovery to each experience-bearing arm, then add that arm's own formation,
validation, final review, failed attempts and evaluation. MCP readback/freeze costs
are retained separately and included for knowledge-bearing arms. Provider-reported
memory usage remains separate; absent prices and bills remain unknown. These
allocations do not claim an independently measured notebook discovery process.

The fixed tests exercise partial captures, unknown/forged proof rejection, source
isolation, prospective prediction order, explicit acceptance, counterexample
preservation, frozen comparisons, twelve main evaluations and complete accounting
through actual MCP processes and network-disabled containers. A deterministic test
agent proves protocol behavior, not model reasoning quality or a learning advantage.
Real-model findings must be recorded separately with the exact protocol, model,
fixture and binary identity. Broader claims require fresh held-out families.

#### Initial Real-Model Trial

This pre-integration trial used the provisional investigation version 3. The
integrated experiment is version 4 to avoid a collision with PR #41's existing
multi-principle protocol 3. The report keeps its original identity and results;
the frontend selects investigation evidence by the `mechanism` profile, not by
interpreting every protocol-3 report as this experiment. PR #41's CSS, live-stage
layout, growing graph, autoplay/loop, pause/reduced-motion behavior, visible
profile/continuation controls, and default Learning profile remain the baseline.

Run `7626806b-c826-4bbb-9ca1-8080666a69dc` on 2026-09-18 used GPT-6 Astra through
the official Copilot SDK, low reasoning effort, 24 steps and a 120-second deadline
per fresh session. Storage was model-free. Both discovery tasks ultimately passed,
with eight retained observations, two chains, and one accepted principle.
The MindLeak validator recorded and matched the positive-case prediction and
the boundary-case failure prediction before executing them.

All twelve main evaluations and four direct diagnostics passed their task tests.
Each arm recorded three of four rubric-matched pre-edit decisions. The MindLeak
evaluation agents did not use optional retrieval, so no behavioral reuse advantage
was observed. The direct arm recorded prior exposure for three decisions; this is
diagnostic evidence, not a main-arm gain or individual causal attribution.

The notebook author produced a note, but its two validation executions failed
before complete test receipts were obtained. The note was not published, and its
review session was incomplete. This is not a valid demonstration that principles
outperform good notes. The original report omitted those two failed validation rows;
that reporting defect was reproduced with an invalid executable hypothesis and
fixed. Current reports retain failures and the full four-case denominator. The
original report and journals remain unchanged, not relabeled as a corrected rerun.

Reported total agent usage was 521,965 input and 13,310 output tokens across 296
tool calls, with elapsed time about 630 seconds. These are descriptive totals on
a shared host, not controlled latency or a bill. The original binary SHA-256 was
`a4cba2bdd1693a2333aee4bec6bf102cac0a351c3a5fde568a22293072b4092c`.
The ignored run directory is `target/investigation-real-v3/2026-09-18T01-04-00.499Z-d63167b8`;
its original source/binary identity and later final-newline-only formatting record
are retained separately. Later report-field/accounting fixes have deterministic
real-MCP coverage, not a second model-result claim. This single exposed-family
trial supports formation feasibility, not learning benefit or generalization quality.

### Durable Learnings Page

Open `/lab2/learnings` or `/lab3/learnings`, or use **Durable Learnings** from the
corresponding lab. The prominent learning graph connects actual stored
**observations -> chains -> principles**. Click its nodes to inspect source and
lineage; omitted references are reported rather than invented. Its growth curve
counts unique logical records, not replayed receipts or extra revisions. Verified
reuse/transfer is displayed separately from growth in stored evidence.
The graph is a latest-recorded snapshot; it is not a live SQL browser or a
historical graph for every replay position.
The **Knowledge taking shape** section brings the selected conclusion, applicability
and assumptions forward. Switch between all recorded principles, replay a rule's
formation, and inspect its supporting chains and original source episodes. Direct
and inherited counterexamples stay visible; missing or changed support revisions
are marked unavailable, not substituted. The text is explicitly the latest recorded
wording while the state and visible records follow the replay position.

Lab 3 adds a case board within the existing live stage: discovery, formation,
reserved prediction checks where recorded, new cases, and later review. Chapter
buttons and the next-finding control seek recorded events only. Each case shows
the actual arm states and prior-evidence delivery; no artificial race, success,
or reuse is inferred. A predicted behavioral failure can match its check without
becoming a successful task. These additions preserve PR #41's live stage, graph,
autoplay, loop, pause and reduced-motion controls. Labs 1 and 2 keep their stage
layout; the case board appears only for Lab 3.
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
