import assert from "node:assert/strict";
import test from "node:test";
import { answerSchemaFor, categories, codingFixture, digest, evaluateAnswer, generateScenarios, pairedMetrics, retrievalMetrics, scaleCharts, verifyCodingPreparation } from "./validation-scenarios.mjs";
import { agentTools, containerConfiguration, createCodingWorkspace, renderScaleCharts, scopedMemory, openMemoryDriver } from "./validation-runtime.mjs";
import { agentSettings, createAgent, publicExecution, runAgentSession } from "./validation-agent.mjs";
import { runValidation } from "./validation-harness.mjs";
import { benchmarkSettings } from "./benchmark-recall.mjs";
import { knowledgeFailure, scoreKnowledgeResponse } from "./validation-knowledge.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longitudinalBinding, runLongitudinal } from "./validation-longitudinal.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";
import { swarmFixture, swarmRoles } from "./swarm-fixture.mjs";
import { ownedBuildWorkspace, runSwarmBuild } from "./swarm-runner.mjs";
import { createDemoServer, selectDemoParameters } from "./swarm-demo.mjs";
import { createCopilotAgent, closeCopilotRuntime } from "./copilot-agent.mjs";
import { openMemoryUsageObserver } from "./demo-memory.mjs";
import { normalizeRecording, replayState, formatElapsed, sandboxApplicationPage } from "./demo-view.mjs";
import { renderDemoPage, writeDemoReplay } from "./demo-replay.mjs";

test("Lab 3 v4 freezes separate discovery validation and matched evaluation cases", async () => {
  const { investigationPlan } = await import("./investigation-lab.mjs");
  const plan = investigationPlan();
  assert.equal(plan.protocolVersion, 4);
  assert.equal(plan.discovery.length, 2);
  assert.deepEqual(plan.validation.map(item => item.role), ["validation_positive", "validation_boundary"]);
  assert.equal(plan.mainSessions, 12);
  assert.equal(plan.diagnosticSessions, 4);
  assert.equal(plan.memoryUse, "optional");
  assert.equal(plan.familyCount, 1);
  assert.equal(new Set([...plan.discovery, ...plan.validation, ...plan.evaluation].map(item => item.id)).size, 8);
  assert.equal(new Set([...plan.discovery, ...plan.validation, ...plan.evaluation].map(item => item.fixtureSha256)).size, 8);
  for (const entry of plan.evaluation) {
    const matched = plan.sessions.filter(session => session.caseId === entry.id);
    assert.equal(matched.length, 4);
    assert.equal(new Set(matched.map(session => session.fixtureSha256)).size, 1);
  }
  assert.deepEqual(investigationPlan(), plan);
  assert.notEqual(investigationPlan({ seed: 7 }).scheduleSha256, plan.scheduleSha256);
  assert.throws(() => investigationPlan({ repetitions: 2 }), /investigation_plan/);
  assert.throws(() => investigationPlan({ seed: -1 }), /investigation_plan/);
});

test("Lab 3 v4 captures checked partial discoveries without accepting knowledge", async () => {
  const { createInvestigationLedger, investigationPlan } = await import("./investigation-lab.mjs");
  const { investigationFixture } = await import("./investigation-fixtures.mjs");
  const calls = [];
  const driver = { async call(name, args) {
    calls.push({ name, args });
    return { data: { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] } };
  } };
  const events = [];
  const ledger = createInvestigationLedger({ driver, plan: investigationPlan(), onEvent: event => events.push(event) });
  const fixture = investigationFixture("ledger-discovery");
  const receipt = { id: "observed-probe", group: "behavior", atMs: 10, sourceSha256: digest(fixture.files), tests: 2, expectedTests: 2,
    passedTests: 0, passed: false, files: fixture.files, inspected: { "docs/service-contract.md": fixture.files["docs/service-contract.md"] } };
  const observation = { proofId: receipt.id, summary: "The export omitted records after an empty page.",
    conditions: "The service returns a non-null continuation cursor.", uncertainty: "The identity regression is still unresolved.",
    path: "docs/service-contract.md", quote: "A null next cursor marks completion." };
  const input = { fixture, proofs: new Map([[receipt.id, receipt]]), observation, taskComplete: false };
  const saved = await ledger.capture(input);
  assert.ok(saved.memoryId);
  assert.equal(ledger.snapshot().observations[0].taskComplete, false);
  assert.equal(ledger.snapshot().observations[0].verification.passed, false);
  assert.equal(ledger.snapshot().chains.length, 0);
  assert.equal(ledger.snapshot().principles.length, 0);
  assert.ok(calls.every(call => !call.args.chain && !call.args.facts));
  assert.equal((await ledger.capture(input)).memoryId, saved.memoryId);
  assert.equal(calls.length, 1, "the same checked observation must not be written twice");
  assert.equal(events[0].agent, "mindleak", "acknowledgements must drive the existing PR41 agent and graph animation");
  await assert.rejects(ledger.capture({ ...input, observation: { ...observation, proofId: "invented" } }), /executed_probe/);
  await assert.rejects(ledger.capture({ ...input, proofs: new Map([[receipt.id, { ...receipt, tests: 0 }]]) }), /executed_probe/);
  await assert.rejects(ledger.capture({ ...input, observation: { ...observation, quote: "not a source quotation" } }), /inspected_source/);
});

test("Lab 3 v4 principles require distinct investigations and prospective validation", async () => {
  const { createInvestigationLedger, investigationPlan } = await import("./investigation-lab.mjs");
  const { investigationFixture, cursorRuleImplementation } = await import("./investigation-fixtures.mjs");
  const heads = new Map(); const writes = [];
  const driver = { async call(name, args) {
    writes.push(args);
    const result = { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] };
    if (args.chain) {
      const previous = heads.get(args.chain.chainId);
      Object.assign(result, { chainId: args.chain.chainId, revision: (previous?.revision ?? 0) + 1,
        state: args.chain.operation === "accept" ? "accepted" : "candidate", review: args.chain.operation === "accept" ? "reviewed" : "unreviewed" });
      heads.set(result.chainId, result);
    }
    return { data: result };
  } };
  const plan = investigationPlan(); const ledger = createInvestigationLedger({ driver, plan });
  const supportedBy = [];
  for (const entry of plan.discovery) {
    const fixture = investigationFixture(entry.id);
    const proof = { id: randomUUID(), group: "behavior", atMs: 1, sourceSha256: digest(fixture.files), tests: 2, expectedTests: 2, passedTests: 0, passed: false,
      files: fixture.files, inspected: fixture.files };
    const observation = await ledger.capture({ fixture, proofs: new Map([[proof.id, proof]]), observation: { proofId: proof.id,
      summary: `${entry.id} omitted records.`, conditions: "A non-null next cursor remained.", uncertainty: "The rest of the task remains unresolved.",
      path: "docs/service-contract.md", quote: "A null next cursor marks completion." } });
    const chain = await ledger.proposeChain({ caseId: entry.id, observationIds: [observation.memoryId],
      claim: `${entry.id} must continue through empty pages.`, rationale: "The contract and recorded failing probe identify the continuation condition.",
      conclusion: "Follow the next cursor until null.", applicability: "Only this service and its null-cursor completion contract.", assumptions: [] });
    assert.equal(chain.state, "candidate");
    await ledger.acceptChain(chain.chainId);
    supportedBy.push(chain.chainId);
  }
  const proposal = { supportedBy, claim: "Cursor-driven exports must not stop solely on empty pages.", rationale: "Two separately constructed service investigations support the rule.",
    conclusion: "Continue until the next cursor is null; inspect the completion contract before applying this rule.",
    applicability: "Services whose only completion signal is a null next cursor.", assumptions: ["A later-snapshot cursor is outside this rule."], implementation: cursorRuleImplementation };
  await assert.rejects(ledger.proposePrinciple({ ...proposal, supportedBy: [supportedBy[0], supportedBy[0]] }), /distinct_discovery/);
  const candidate = await ledger.proposePrinciple(proposal);
  assert.equal(candidate.state, "candidate");
  await assert.rejects(ledger.acceptPrinciple(candidate.chainId), /reserved_validation/);
  for (const entry of plan.validation) {
    const fixture = investigationFixture(entry.id); const passed = entry.role === "validation_positive";
    const receipt = { id: randomUUID(), tests: 2, expectedTests: 2, passedTests: passed ? 2 : 0, passed,
      sourceSha256: digest([entry.id, proposal.implementation]), fixtureSha256: entry.fixtureSha256, implementationSha256: digest(proposal.implementation) };
    await assert.rejects(ledger.validatePrediction(candidate.chainId, entry.id, receipt), /prediction_required/);
    ledger.predict(candidate.chainId, entry.id, { applicable: passed, expectedPass: passed, reason: "Inspect the stated completion contract." });
    assert.throws(() => ledger.predict(candidate.chainId, entry.id, { applicable: !passed, expectedPass: passed, reason: "Changed after seeing a result." }), /prediction_frozen/);
    assert.equal((await ledger.validatePrediction(candidate.chainId, entry.id, receipt)).correct, true);
  }
  assert.equal(ledger.snapshot().principles[0].state, "candidate", "successful validation cannot silently accept a principle");
  const accepted = await ledger.acceptPrinciple(candidate.chainId);
  assert.equal(accepted.state, "accepted");
  const principle = ledger.snapshot().principles[0];
  assert.equal(principle.document.evidence.length, 1, "retain the tested boundary as counterevidence");
  assert.equal(principle.validationChecks.length, 2);
  assert.equal(writes.filter(write => write.chain?.operation === "accept").length, 3);
  const changed = investigationFixture("export-change");
  const counterProbe = { id: randomUUID(), group: "behavior", tests: 2, expectedTests: 2, passedTests: 0, passed: false,
    sourceSha256: digest(changed.files), files: { ...changed.files, "src/scan.mjs": cursorRuleImplementation } };
  await assert.rejects(ledger.challengePrinciple(candidate.chainId, changed, { ...counterProbe, files: changed.files }), /frozen_hypothesis/);
  const challenged = await ledger.challengePrinciple(candidate.chainId, changed, counterProbe);
  assert.ok(challenged.memoryId);
  assert.equal(ledger.snapshot().principles[0].document.evidence.length, 2);
  const { supportedBy: support, ...revision } = proposal;
  await ledger.revisePrinciple(candidate.chainId, { ...revision, applicability: "Null-cursor services only, excluding explicit completed snapshots." });
  assert.equal(ledger.snapshot().principles[0].state, "candidate");
  assert.equal(ledger.snapshot().principles[0].document.evidence.length, 2, "a revision cannot erase old exceptions");
  await assert.rejects(ledger.acceptPrinciple(candidate.chainId), /fresh_validation/);
  assert.throws(() => ledger.predict(candidate.chainId, plan.validation[0].id, { applicable: true, expectedPass: true, reason: "Try the old case again." }), /fresh_validation/);
});

test("Lab 3 v4 incomplete investigations retain only executed source-linked evidence", async () => {
  const { createInvestigationLedger, investigationPlan, runInvestigationSession } = await import("./investigation-lab.mjs");
  const { investigationFixture } = await import("./investigation-fixtures.mjs");
  const fixture = investigationFixture("ledger-discovery");
  const ledger = createInvestigationLedger({ plan: investigationPlan(), driver: { async call(name, args) {
    assert.equal(name, "write_memory"); assert.equal(args.chain, undefined);
    return { data: { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] } };
  } } });
  let closed = false;
  const workspaceFactory = async () => ({ editablePaths: fixture.editable, list: async () => Object.keys(fixture.files),
    read: async path => fixture.files[path], search: async () => [], write: async () => { throw new Error("unexpected edit"); },
    test: async group => ({ passed: false, tests: group ? 2 : 3, expectedTests: group ? 2 : 3, passedTests: 0, sourceSha256: digest(fixture.files) }),
    close: async () => { closed = true; } });
  const agent = { configuration: { model: "test-double" }, async run(prompt, tools) {
    const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
    await invoke("read_file", { path: "docs/service-contract.md" });
    const proof = await invoke("run_probe", { group: "behavior" });
    await invoke("capture_observation", { proofId: proof.id, summary: "The continuation check fails on an empty intermediate page.",
      conditions: "The service continues using a non-null cursor.", uncertainty: "No complete fix has been verified.",
      path: "docs/service-contract.md", quote: "A null next cursor marks completion." });
    return { status: "completed", sessionId: randomUUID(), answer: { completed: false }, inputTokens: 100, outputTokens: 30, toolCalls: 3 };
  } };
  const result = await runInvestigationSession({ fixture, agent, ledger, arm: "mindleak", stage: "discovery", workspaceFactory });
  assert.equal(closed, true);
  assert.equal(result.correct, false);
  assert.equal(result.taskComplete, false);
  assert.equal(result.observationIds.length, 1);
  assert.equal(result.learningOutcome, "checked_discovery_retained");
  assert.equal(ledger.snapshot().observations.length, 1);
  assert.equal(ledger.snapshot().principles.length, 0);
  assert.ok(!JSON.stringify(result.probes).includes(fixture.files["src/provider.mjs"]), "public probes carry fingerprints, not source copies");
});

test("Lab 3 v4 mechanism profile is explicit and its plan starts no services", () => {
  const script = fileURLToPath(new URL("./swarm-demo.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--plan", "--rediscovery-profile", "mechanism"], { encoding: "utf8", env: {
    ...process.env, MINDLEAK_TEST_DATABASE_URL: "must-not-connect", MINDLEAK_VALIDATION_AGENT_API_KEY: "must-not-read",
  } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.protocolVersion, 4);
  assert.equal(plan.mainSessions, 12);
  assert.ok(!result.stdout.includes("must-not-"));
  assert.equal(selectDemoParameters(null, { rediscoveryProfile: "mechanism" }).rediscoveryProfile, "mechanism");
  assert.throws(() => selectDemoParameters(null, { rediscoveryProfile: "mechanism", continueFrom: randomUUID() }), /fresh_investigation/);
});

test("Lab 3 v4 replay preserves the live stage and separates learning evidence from task completion", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const report = { kind: "rediscovery_lab", protocolVersion: 4, plan: { protocolVersion: 4, profile: "mechanism", mainSessions: 12, diagnosticSessions: 4 },
    runId: "synthetic-v4-ui", agents: [{ id: "mindleak", name: "MindLeak" }], events: [], elapsedMs: 1,
    metrics: { learning: { discoveriesRetained: 2, unfinishedInvestigationsWithEvidence: 2, correctPredictions: 4, predictions: 4, exceptionsRetained: 1 }, arms: {} } };
  const metrics = knowledgeMetrics(report);
  assert.equal(metrics.investigation.unfinishedInvestigationsWithEvidence, 2);
  const historical = structuredClone(report);
  historical.plan.validation = [{ id: "positive" }, { id: "boundary" }];
  historical.metrics.learning.predictions = 2;
  assert.equal(knowledgeMetrics(historical).investigation.predictions, 4, "missing historical validation rows cannot shrink the planned denominator");
  const { parseHTML } = await import("linkedom");
  const page = parseHTML(await renderDemoPage({ report })).document;
  assert.ok(page.querySelector("option[value=mechanism]"));
  assert.deepEqual([...page.querySelectorAll("#rediscovery-profile-select option")].map(option => option.value), ["smoke", "learning", "pilot", "adoption", "mechanism", "quality"]);
  for (const id of ["live-stage", "stage-roster", "stage-graph", "stage-feed", "stage-run-controls", "stage-playback", "replay-loop"]) assert.ok(page.querySelector(`#${id}`));
  const evidence = page.querySelector("#investigation-template").content;
  for (const id of ["investigation-discoveries", "investigation-unfinished", "investigation-predictions", "investigation-decisions", "investigation-validations"]) assert.ok(evidence.querySelector(`#${id}`));
  assert.equal(knowledgeMetrics({ kind: "rediscovery_lab" }).investigation, null, "old protocols retain their presentation");
  assert.equal(knowledgeMetrics({ kind: "rediscovery_lab", plan: { protocolVersion: 3, profile: "learning" } }).investigation, null, "PR41 learning studies must not acquire the investigation panel");
});

test("Lab 3 v4 tool events use PR41 memory activity without affecting controls", async () => {
  const { memoryActivity } = await import("./demo-view.mjs");
  for (const [tool, kind] of [["capture_observation", "write"], ["propose_principle", "form"], ["accept_chain", "form"], ["accept_principle", "form"], ["challenge_principle", "form"], ["propose_revision", "form"]]) {
    const recording = { agents: [{ id: "mindleak" }, { id: "fresh", connectToMemory: false }], events: [
      { type: "tool_started", agent: "mindleak", tool, toolCallId: "operation", atMs: 1 },
      { type: "tool_started", agent: "fresh", tool, toolCallId: "excluded", atMs: 1 },
      { type: "tool_finished", agent: "mindleak", tool, toolCallId: "operation", atMs: 3 },
    ] };
    const active = memoryActivity(recording, 2);
    assert.deepEqual(active.flows.map(flow => [flow.agent, flow.kind]), [["mindleak", kind]]);
    assert.equal(memoryActivity(recording, 4).flows.length, 0);
    assert.equal(memoryActivity(recording, 2, false).active, false);
  }
});

test("Lab 3 v4 orchestration rejects unsupported prerequisites without starting work", async () => {
  const { runInvestigationLab } = await import("./investigation-lab.mjs");
  await assert.rejects(runInvestigationLab({}), /investigation_prerequisites/);
  await assert.rejects(runInvestigationLab({ driver: { capabilities: { knowledge: true, chains: true } }, agent: { run() {} }, code: {}, parent: {} }), /fresh_investigation_required/);
});

test("Lab 3 v4 executes discovery formation validation and twelve isolated evaluations", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY || !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { runInvestigationLab } = await import("./investigation-lab.mjs");
  const { investigationCases, investigationFixture, investigationRepair, investigationDecision, cursorRuleImplementation } = await import("./investigation-fixtures.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  let comparing = false; let sessions = 0; let memorySearches = 0; let invalidNotebook = false;
  const monitored = { ...driver, restart: () => driver.restart(), async call(name, args) {
    assert.ok(!(comparing && name === "write_memory"), "all comparison knowledge must remain frozen");
    return driver.call(name, args);
  } };
  const hypothesis = { claim: "Continuation safety for filtered page streams", rationale: "Two distinct service cases failed when empty pages ended traversal.",
    conclusion: "Follow the next cursor through empty pages until it is null; first check that this is the service completion contract.",
    applicability: "Services completed only by a null next cursor.", assumptions: ["Explicit completion markers require a different rule."], implementation: cursorRuleImplementation };
  const agent = { configuration: { model: "deterministic-test-agent", provider: "test", maxSteps: 24, timeoutMs: 120000 }, async run(prompt, tools, context) {
    sessions += 1;
    const byName = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = (name, args = {}) => byName.get(name).invoke(args);
    let completed = true;
    if (byName.has("inspect_outcome")) {
      assert.ok(!byName.has("accept_principle"));
      if (byName.has("challenge_principle")) {
        await invoke("inspect_outcome", { caseId: "export-change" });
        const counterexample = await invoke("probe_exception", { caseId: "export-change" });
        assert.equal(counterexample.passed, false);
        await invoke("challenge_principle", { caseId: "export-change", proofId: counterexample.proofId });
        await invoke("propose_revision", { ...hypothesis, applicability: "Null-cursor services only; an explicit completion marker changes the stopping rule." });
      }
    } else if (byName.has("capture_observation")) {
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      await invoke("read_file", { path: "src/scan.mjs" });
      const before = await invoke("run_probe", { group: "behavior" });
      await invoke("capture_observation", { proofId: before.id, summary: "Empty intermediate pages cause a failed export check.",
        conditions: "The current contract uses a null next cursor to signal completion.", uncertainty: "Identity preservation remains unresolved.",
        path: "docs/service-contract.md", quote: contract.trim() });
      await invoke("write_file", { path: "src/scan.mjs", content: cursorRuleImplementation });
      const after = await invoke("run_probe", { group: "behavior" });
      assert.equal(after.passed, true);
      await invoke("capture_observation", { proofId: after.id, summary: "Following the continuation cursor passes the behavior checks.",
        conditions: "The same service contract and immutable behavior checks were used.", uncertainty: "The unrelated identity check is not fixed.",
        path: "docs/service-contract.md", quote: contract.trim() });
      completed = false;
    } else if (byName.has("propose_chain") || byName.has("save_note")) {
      assert.ok(!context.includes("receipt-validation") && !context.includes("export-change"));
      const discoveries = await invoke("list_discoveries"); const supportedBy = []; const observationIds = [];
      for (const entry of discoveries.cases) {
        const inspected = await invoke("inspect_discovery", { caseId: entry.caseId });
        assert.equal(inspected.taskComplete, false);
        observationIds.push(...entry.observations);
        if (byName.has("propose_chain")) {
          const { implementation, ...document } = hypothesis;
          const candidate = await invoke("propose_chain", { ...document, claim: `${entry.caseId}: empty-page continuation`, caseId: entry.caseId, observationIds: entry.observations });
          await invoke("accept_chain", { chainId: candidate.chainId }); supportedBy.push(candidate.chainId);
        }
      }
      if (byName.has("propose_principle")) await invoke("propose_principle", { ...hypothesis, supportedBy });
      else await invoke("save_note", { ...hypothesis, conclusion: `Notebook procedure: ${hypothesis.conclusion}`,
        implementation: invalidNotebook ? "export const missingCollect = true;\n" : hypothesis.implementation, observationIds });
    } else if (byName.has("predict")) {
      await assert.rejects(invoke("run_prediction"), /prospective/);
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      const applicable = !contract.includes("page.complete");
      await invoke("predict", { applicable, expectedPass: applicable, reason: "Compare the frozen cursor procedure with the actual completion signal." });
      if (invalidNotebook && JSON.parse(context).document.kind !== "principle") await assert.rejects(invoke("run_prediction"), /incomplete_validation_probe/);
      else { const tested = await invoke("run_prediction"); assert.equal(tested.predictionMatched, true); }
    } else if (byName.has("accept_principle")) await invoke("accept_principle");
    else if (byName.has("publish_note")) {
      if (invalidNotebook) await assert.rejects(invoke("publish_note"), /reserved_validation_required/);
      else await invoke("publish_note");
    }
    else {
      assert.ok(byName.has("record_decision"));
      assert.ok(![...byName.keys()].some(name => /capture|retain|propose|accept/.test(name)));
      const readme = await invoke("read_file", { path: "README.md" });
      const entry = investigationCases().find(item => readme.startsWith(`# ${item.sourceGroup}\n`));
      const decision = investigationDecision(entry.id);
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      if (byName.has("recall_experience")) {
        memorySearches += 1;
        await invoke("recall_experience", { query: memorySearches === 1 ? "unrelatedmissxzz123" : "continuation" });
      }
      if (byName.has("search_notebook")) assert.equal((await invoke("search_notebook", { query: "continuation" })).hits.length, invalidNotebook ? 0 : 1);
      await invoke("record_decision", { cause: decision.cause, stopSignal: decision.stopSignal, knowledgeDecision: decision.applicable ? "use" : "reject",
        nextAction: "Use the current service contract and validate the selected change.", path: "docs/service-contract.md", quote: contract.trim() });
      await invoke("write_file", { path: "src/scan.mjs", content: investigationRepair(entry.id) });
      await invoke("write_file", { path: "src/identity.mjs", content: "export const identify = value => value;\n" });
      assert.equal((await invoke("run_tests")).passed, true);
    }
    return { status: "completed", sessionId: randomUUID(), answer: { completed }, inputTokens: 100, outputTokens: 20, toolCalls: 5 };
  } };
  try {
    const report = await runInvestigationLab({ driver: monitored, agent, code, onEvent: event => {
      if (event.type === "rediscovery_round_started") comparing = true;
      if (event.type === "rediscovery_round_finished") comparing = false;
    } });
    assert.equal(report.status, "completed", JSON.stringify(report.summary));
    assert.equal(report.protocolVersion, 4);
    assert.equal(report.outcomes.length, 16);
    assert.equal(report.outcomes.filter(item => !item.diagnostic).length, 12);
    assert.ok(report.outcomes.every(item => item.correct && item.decisionCorrect));
    assert.ok(report.preparation.every(item => !item.correct && item.observationIds.length === 2));
    assert.equal(report.knowledge.chains.length, 2);
    assert.equal(new Set(report.knowledge.chains.map(item => item.sourceGroup)).size, 2);
    assert.equal(report.knowledge.principles[0].state, "candidate", "the post-comparison revision needs fresh validation");
    assert.equal(report.knowledge.principles[0].document.evidence.length, 2);
    assert.equal(report.knowledge.principles[0].needsFreshValidation, true);
    assert.equal(report.validations.length, 4);
    assert.ok(report.validations.every(item => item.correct));
    assert.equal(report.notebook[0].accepted, true);
    assert.notEqual(report.notebook[0].conclusion, report.knowledge.principles[0].document.conclusion, "notebook synthesis is independent");
    assert.equal(report.metrics.learning.unfinishedInvestigationsWithEvidence, 2);
    assert.equal(report.metrics.learning.comparativeBenefit, "not_established");
    assert.equal(report.metrics.arms.mindleak.retrievalMisses, 1);
    assert.equal(report.metrics.arms.fresh.totalInputTokens, 400);
    assert.equal(report.metrics.arms.notebook.totalInputTokens, 1100);
    assert.equal(report.metrics.arms.mindleak.totalInputTokens, 1100);
    assert.equal(report.reviews.find(review => review.arm === "notebook").outcome, "no_new_learning");
    assert.equal(report.reviews.find(review => review.arm === "mindleak").outcome, "exception_retained");
    assert.equal(report.metrics.learning.acceptedPrinciples, 1, "the comparison used the pre-review accepted revision");
    assert.equal(report.metrics.learning.exceptionsRetained, 1);
    assert.equal(report.inputTokens, sessions * 100, "actual totals must not double-count shared discovery");
    assert.equal(report.summary.inputTokens, report.inputTokens, "saved study summaries must retain total measured usage");
    assert.equal(report.binarySha256, driver.binarySha256);
    assert.equal(report.realMcpProcess, true);
    assert.equal(report.realModel, false, "a deterministic agent is not a real-model result");
    assert.deepEqual(report.agent, agent.configuration);
    assert.equal(report.server.version, driver.server.version);
    assert.equal(report.fixtureSha256, report.plan.frozenInputsSha256);
    assert.equal(Object.keys(report.candidates).length, 18);
    assert.ok(Object.values(report.candidates).every(files => typeof files["src/scan.mjs"] === "string" && typeof files["src/identity.mjs"] === "string"));
    assert.deepEqual(report.events.findLast(event => event.type === "tests" && event.phase === "final").passedTests, report.finalTests.passedTests);
    assert.equal(report.rounds[0].frozenUnchanged, true);
    assert.equal(report.finalTests.passed, false, "unfinished discoveries must not be relabeled completed");
    invalidNotebook = true;
    const failedValidation = await runInvestigationLab({ driver: monitored, agent, code });
    assert.equal(failedValidation.validations.length, 4, "failed reserved executions must remain in the report");
    const failed = failedValidation.validations.filter(item => item.arm === "notebook");
    assert.equal(failed.length, 2);
    assert.ok(failed.every(item => item.status === "execution_failed" && item.correct === false));
    assert.equal(failedValidation.metrics.learning.predictions, 4, "all scheduled reserved cases stay in the denominator");
    assert.equal(failedValidation.metrics.learning.correctPredictions, 2);
    assert.equal(failedValidation.metrics.learning.validationFailures, 2);
    assert.equal(failedValidation.notebook[0].accepted, false);
  } finally { await driver.close(); }
});

test("Lab 3 v4 fixtures separate partial discovery from complete task success", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { investigationCases, investigationFixture, investigationRepair, cursorRuleImplementation } = await import("./investigation-fixtures.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  for (const entry of investigationCases()) {
    const fixture = investigationFixture(entry.id);
    const workspace = await createCodingWorkspace("investigation", code, fixture);
    try {
      const baseline = await workspace.test();
      assert.equal(baseline.tests, 3);
      assert.equal(baseline.passed, false, entry.id);
      await workspace.write(fixture.modulePath, cursorRuleImplementation);
      const prediction = await workspace.test("behavior");
      assert.equal(prediction.tests, 2);
      assert.equal(prediction.passed, !["validation_boundary", "changed"].includes(entry.role), entry.id);
      if (entry.role === "discovery") assert.equal((await workspace.test()).passed, false, "verified pagination does not imply a completed task");
      await workspace.write(fixture.modulePath, investigationRepair(entry.id));
      await workspace.write("src/identity.mjs", "export const identify = value => value;\n");
      assert.equal((await workspace.test()).passed, true, entry.id);
    } finally { await workspace.close(); }
  }
});

test("Lab 3 quality comparison freezes distinct knowledge versions and unseen outcome cases", async () => {
  const { investigationPlan } = await import("./investigation-lab.mjs");
  const plan = investigationPlan({ profile: "quality" });
  assert.equal(plan.profile, "quality");
  assert.equal(plan.protocolVersion, 6);
  assert.deepEqual(plan.arms, ["fresh", "notebook", "original", "mindleak"]);
  assert.equal(plan.diagnosticSessions, 0);
  const groups = [plan.discovery, plan.validation, plan.exceptions, plan.revisionValidation, plan.evaluation];
  assert.ok(groups.every(group => group.length >= 2));
  const cases = groups.flat();
  assert.equal(new Set(cases.map(item => item.id)).size, cases.length);
  assert.equal(new Set(cases.map(item => item.fixtureSha256)).size, cases.length);
  for (const item of plan.evaluation) {
    const matched = plan.sessions.filter(session => session.caseId === item.id);
    assert.deepEqual(matched.map(session => session.arm).sort(), [...plan.arms].sort());
    assert.equal(new Set(matched.map(session => session.fixtureSha256)).size, 1);
    assert.ok(matched.every(session => !session.diagnostic));
  }
  assert.equal(plan.mainSessions, plan.evaluation.length * plan.arms.length);
  assert.equal(plan.qualityRubric.primary, "held_out_outcome_quality");
  assert.equal(plan.qualityRubric.correctRejection, "separate_from_application");
  assert.equal(plan.knowledgeComparison, "original_frozen_vs_explicitly_revised");
  assert.deepEqual(plan, investigationPlan({ profile: "quality" }));
  assert.equal(investigationPlan().protocolVersion, 4);
  assert.equal(investigationPlan().profile, "mechanism");
});

test("Lab 3 quality cases check boundaries and regressions without changing mechanism fixtures", async () => {
  const { investigationCases, investigationFixture } = await import("./investigation-fixtures.mjs");
  for (const entry of investigationCases("quality")) {
    const fixture = investigationFixture(entry.id);
    assert.equal(fixture.testCount, 8);
    assert.deepEqual(fixture.testGroups, { behavior: 2, boundary: 3, regression: 3 });
    assert.equal(fixture.testNames.length, fixture.testCount);
    assert.equal(new Set(fixture.testNames).size, fixture.testCount);
    assert.ok(fixture.testNames.includes("boundary/cursor cycle"));
    assert.ok(fixture.testNames.includes("regression/source pages unchanged"));
  }
  for (const entry of investigationCases()) assert.equal(investigationFixture(entry.id).testCount, 3);
});

test("Lab 3 quality revisions preserve exceptions and require fresh prospective validation", async () => {
  const { createInvestigationLedger, investigationPlan } = await import("./investigation-lab.mjs");
  const { investigationFixture, cursorRuleImplementation, qualityRuleImplementation } = await import("./investigation-fixtures.mjs");
  const heads = new Map();
  const driver = { async call(name, args) {
    assert.equal(name, "write_memory");
    const result = { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] };
    if (args.chain) {
      const previous = heads.get(args.chain.chainId);
      Object.assign(result, { chainId: args.chain.chainId, revision: (previous?.revision ?? 0) + 1,
        state: args.chain.operation === "accept" ? "accepted" : args.chain.operation === "challenge" ? previous.state : "candidate",
        review: args.chain.operation === "accept" ? "reviewed" : "unreviewed" });
      heads.set(result.chainId, result);
    }
    return { data: result };
  } };
  const plan = investigationPlan({ profile: "quality" });
  const ledger = createInvestigationLedger({ driver, plan });
  const document = { claim: "Continue through empty pages under the declared completion contract.", rationale: "Two distinct source cases have recorded executed probes.",
    conclusion: "Inspect the service completion contract before following continuation cursors.", applicability: "A service declaring null-cursor completion.", assumptions: [] };
  const supportedBy = [];
  for (const entry of plan.discovery) {
    const fixture = investigationFixture(entry.id);
    const proof = { id: randomUUID(), group: "behavior", tests: 2, expectedTests: 2, passedTests: 0, passed: false,
      sourceSha256: digest(fixture.files), files: fixture.files, inspected: fixture.files };
    const observation = await ledger.capture({ fixture, proofs: new Map([[proof.id, proof]]), observation: { proofId: proof.id,
      summary: "An empty intermediate page hid later records.", conditions: "The current service uses null-cursor completion.", uncertainty: "Other contracts were not evaluated.",
      path: "docs/service-contract.md", quote: "A null next cursor marks completion." } });
    const chain = await ledger.proposeChain({ ...document, caseId: entry.id, observationIds: [observation.memoryId] });
    await ledger.acceptChain(chain.chainId); supportedBy.push(chain.chainId);
  }
  const beforeInvalid = digest(ledger.snapshot());
  for (const implementation of ["async function collect(client) { return []; }", "```js\nexport const collect = () => [];\n```", "export async function collect(client: Client) {}"])
    await assert.rejects(ledger.proposePrinciple({ ...document, supportedBy, implementation }), /standalone_javascript_collect_export_required/);
  assert.equal(digest(ledger.snapshot()), beforeInvalid, "invalid executable format must fail before writing a candidate");
  const candidate = await ledger.proposePrinciple({ ...document, supportedBy, implementation: cursorRuleImplementation });
  const validate = async (entry, implementation) => {
    ledger.predict(candidate.chainId, entry.id, { applicable: true, expectedPass: true, reason: "The current contract matches the declared candidate procedure." });
    const receipt = { id: randomUUID(), tests: 2, expectedTests: 2, passedTests: 2, passed: true,
      sourceSha256: digest([entry.id, implementation]), fixtureSha256: entry.fixtureSha256, implementationSha256: digest(implementation) };
    assert.equal((await ledger.validatePrediction(candidate.chainId, entry.id, receipt)).correct, true);
  };
  for (const entry of plan.validation) await validate(entry, cursorRuleImplementation);
  await ledger.acceptPrinciple(candidate.chainId);
  const original = ledger.snapshot();
  const originalHash = digest(original);
  for (const entry of plan.exceptions) {
    const fixture = investigationFixture(entry.id);
    await ledger.challengePrinciple(candidate.chainId, fixture, { id: randomUUID(), group: "behavior", tests: 2, expectedTests: 2,
      passedTests: 0, passed: false, sourceSha256: digest(fixture.files), files: { ...fixture.files, "src/scan.mjs": cursorRuleImplementation } });
  }
  const counters = ledger.snapshot().principles[0].document.evidence;
  assert.equal(counters.length, 2);
  await ledger.revisePrinciple(candidate.chainId, { ...document, applicability: "Select cursor or explicit completion according to the current client contract.", implementation: qualityRuleImplementation });
  await assert.rejects(ledger.acceptPrinciple(candidate.chainId), /fresh_validation|reserved_validation/);
  assert.throws(() => ledger.predict(candidate.chainId, plan.validation[0].id, { applicable: true, expectedPass: true, reason: "This case was already exposed." }), /fresh_validation/);
  for (const entry of plan.revisionValidation) await validate(entry, qualityRuleImplementation);
  assert.equal(ledger.snapshot().principles[0].state, "candidate", "fresh checks cannot silently accept a revision");
  await ledger.acceptPrinciple(candidate.chainId);
  const revised = ledger.snapshot().principles[0];
  assert.equal(revised.state, "accepted");
  assert.equal(revised.requiresReview, false);
  assert.equal(revised.needsFreshValidation, false);
  assert.deepEqual(revised.document.evidence, counters);
  assert.deepEqual(revised.validationChecks.map(check => check.caseId), plan.revisionValidation.map(entry => entry.id));
  assert.equal(revised.validationHistory.length, 1);
  assert.equal(digest(original), originalHash, "the original frozen knowledge version must remain unchanged");
});

test("Lab 3 quality fixtures execute stronger checks in the sandbox", { skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE }, async () => {
  const { investigationCases, investigationFixture, investigationRepair, cursorRuleImplementation } = await import("./investigation-fixtures.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  for (const entry of investigationCases("quality")) {
    const fixture = investigationFixture(entry.id);
    const workspace = await createCodingWorkspace("quality-fixture", code, fixture);
    try {
      const before = await workspace.test();
      assert.equal(before.tests, 8);
      assert.equal(before.passed, false);
      await workspace.write("src/scan.mjs", investigationRepair(entry.id));
      await workspace.write("src/identity.mjs", "export const identify = value => value;\n");
      const after = await workspace.test();
      assert.equal(after.tests, 8);
      assert.equal(after.passedTests, 8);
      assert.equal(after.passed, true);
      await workspace.write("src/scan.mjs", cursorRuleImplementation);
      assert.equal((await workspace.test()).passed, false, "the legacy cursor-only procedure must not satisfy the stronger quality gate");
    } finally { await workspace.close(); }
  }
});

test("Lab 3 quality runs original and revised knowledge through real frozen comparisons", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY || !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { runInvestigationLab } = await import("./investigation-lab.mjs");
  const { investigationCases, investigationRepair, investigationDecision, cursorRuleImplementation, qualityRuleImplementation } = await import("./investigation-fixtures.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  let comparing = false;
  let calls = 0;
  let skipReview = false;
  const toolFailures = [];
  const monitored = { ...driver, restart: () => driver.restart(), async call(name, args) {
    assert.ok(!(comparing && name === "write_memory"), "quality comparison must keep all knowledge versions frozen");
    return driver.call(name, args);
  } };
  const hypothesis = { claim: "Continuation safety across inspected service contracts", rationale: "Separate constructed source cases and executed checks support a conditional procedure.",
    conclusion: "Follow continuation through empty pages until a null cursor; first inspect the service completion contract.",
    applicability: "Services whose authoritative completion signal is a null next cursor.", assumptions: ["Explicit completion markers need a different procedure."], implementation: cursorRuleImplementation };
  const agent = { configuration: { model: "quality-test-agent", provider: "test", maxSteps: 24, timeoutMs: 120000 }, async run(prompt, tools, context) {
    calls += 1;
    const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = async (name, args = {}) => {
      try { return await entries.get(name).invoke(args); }
      catch (error) { toolFailures.push({ tool: name, code: error.message.slice(0, 160) }); throw error; }
    };
    if (entries.has("capture_observation")) {
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      await invoke("read_file", { path: "src/scan.mjs" });
      const proof = await invoke("run_probe", { group: "behavior" });
      await invoke("capture_observation", { proofId: proof.id, summary: "An empty intermediate page hid remaining records.",
        conditions: "The current service declares null-cursor completion.", uncertainty: "Other contracts need independent verification.",
        path: "docs/service-contract.md", quote: contract.trim() });
      await invoke("write_file", { path: "src/scan.mjs", content: qualityRuleImplementation });
      await invoke("write_file", { path: "src/identity.mjs", content: "export const identify = value => value;\n" });
      assert.equal((await invoke("run_tests")).passed, true);
    } else if (entries.has("propose_chain")) {
      const dossier = JSON.parse(context);
      assert.equal(dossier.view, "quality-chain-proposal");
      assert.deepEqual([...entries.keys()], ["propose_chain", "decline_formation"]);
      const entry = dossier.case;
      const { implementation, ...document } = hypothesis;
      const chain = await invoke("propose_chain", { ...document, claim: `${entry.caseId}: continue through nonterminal empty pages.`,
        caseId: entry.caseId, observationIds: entry.observations.map(observation => observation.memoryId) });
      assert.equal(chain.state, "candidate");
      return { status: "completed", sessionId: randomUUID(), answer: { completed: false }, trace: [], responses: [], inputTokens: 20, outputTokens: 5, toolCalls: 1 };
    } else if (entries.has("accept_chain")) {
      const dossier = JSON.parse(context);
      assert.equal(dossier.view, "quality-chain-acceptance");
      assert.deepEqual([...entries.keys()], ["accept_chain", "decline_formation"]);
      assert.equal(dossier.candidate.state, "candidate");
      assert.ok(dossier.case.observations.some(source => dossier.candidate.observationIds.includes(source.memoryId)));
      await assert.rejects(invoke("accept_chain", { chainId: randomUUID(), expectedRevision: dossier.candidate.revision }), /current_case_candidate_required/);
      await assert.rejects(invoke("accept_chain", { chainId: dossier.candidate.chainId, expectedRevision: dossier.candidate.revision + 1 }), /current_case_candidate_required/);
      await invoke("accept_chain", { chainId: dossier.candidate.chainId, expectedRevision: dossier.candidate.revision });
    } else if (entries.has("propose_principle")) {
      const dossier = JSON.parse(context);
      assert.equal(dossier.view, "quality-principle-proposal");
      assert.deepEqual([...entries.keys()], ["propose_principle", "decline_formation"]);
      assert.equal(dossier.chains.length, 2);
      assert.ok(dossier.chains.every(chain => chain.state === "accepted" && chain.review === "reviewed"));
      await invoke("propose_principle", { ...hypothesis, supportedBy: dossier.chains.map(chain => chain.chainId) });
    } else if (entries.has("save_note")) {
      assert.ok(!context.includes("quality-snapshot-transfer"), "held-out evidence must be unavailable during formation");
      assert.ok(!entries.has("list_discoveries") && !entries.has("inspect_discovery"), "formation receives a bounded source packet, not a read loop");
      assert.ok(!prompt.includes("No new learning is legitimate."), "avoid wording that can forbid justified learning");
      const discoveries = JSON.parse(context); const supportedBy = []; const observationIds = [];
      assert.equal(discoveries.view, "quality-formation");
      assert.equal(discoveries.cases.length, 2);
      for (const entry of discoveries.cases) {
        const ids = entry.observations.map(observation => observation.memoryId); observationIds.push(...ids);
        if (entries.has("propose_chain")) {
          const { implementation, ...document } = hypothesis;
          const chain = await invoke("propose_chain", { ...document, claim: `${entry.caseId}: continue through nonterminal empty pages.`,
            caseId: entry.caseId, observationIds: ids });
          await invoke("accept_chain", { chainId: chain.chainId }); supportedBy.push(chain.chainId);
        }
      }
      if (entries.has("propose_principle")) await invoke("propose_principle", { ...hypothesis, supportedBy });
      else await invoke("save_note", { ...hypothesis, observationIds, conclusion: `Notebook: ${hypothesis.conclusion}` });
    } else if (entries.has("predict")) {
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      const candidate = JSON.parse(context);
      const applicable = candidate.implementation === qualityRuleImplementation || !contract.includes("page.complete is true");
      await invoke("predict", { applicable, expectedPass: applicable, reason: "Compare the candidate procedure with the current authoritative contract." });
      assert.equal((await invoke("run_prediction")).predictionMatched, true);
    } else if (entries.has("accept_principle")) await invoke("accept_principle");
    else if (entries.has("publish_note")) await invoke("publish_note");
    else if (JSON.parse(context || "null")?.view === "quality-review") {
      const review = JSON.parse(context);
      assert.ok(!context.includes("quality-snapshot-transfer"));
      assert.equal(review.exceptions.length, 2);
      assert.ok(review.exceptions.every(entry => entry.verification.passed === false));
      if (skipReview) {
        for (const entry of review.exceptions) {
          const choice = { caseId: entry.caseId, quote: entry.contract.trim(), reason: "The retained conditions already exclude this explicit-completion boundary; no new generalization is justified." };
          await invoke("skip_learning", choice);
          assert.equal((await invoke("skip_learning", choice)).alreadyRecorded, true);
        }
        return { status: "completed", sessionId: randomUUID(), answer: { completed: false }, trace: [], responses: [], inputTokens: 20, outputTokens: 5, toolCalls: 4 };
      }
      const revised = { ...hypothesis, conclusion: "Check client.termination, follow nonterminal empty pages, reject cursor cycles, and use the declared completion signal.",
        applicability: "Cursor and explicit-completion services with an inspected current client contract.", assumptions: [], implementation: qualityRuleImplementation };
      if (entries.has("challenge_principle")) {
        for (const entry of review.exceptions) await invoke("challenge_principle", { caseId: entry.caseId, proofId: entry.verification.id });
        await invoke("propose_revision", revised);
      } else await invoke("amend_note", revised);
    } else {
      assert.ok(entries.has("record_decision"));
      assert.ok(![...entries.keys()].some(name => /capture|retain|propose|accept|amend/.test(name)));
      const readme = await invoke("read_file", { path: "README.md" });
      const entry = investigationCases("quality").find(item => readme.startsWith(`# ${item.sourceGroup}\n`));
      const decision = investigationDecision(entry.id);
      const contract = await invoke("read_file", { path: "docs/service-contract.md" });
      const prior = context ? JSON.parse(context) : null;
      const visibleTests = await invoke("read_file", { path: "tests/workflow.test.mjs" });
      assert.ok(!visibleTests.includes("boundary/cursor cycle"), "the held-out audit must not leak through repository tools");
      await invoke("record_decision", { cause: decision.cause, stopSignal: decision.stopSignal,
        knowledgeDecision: !prior ? "not_needed" : entry.role === "irrelevant" ? "reject" : "adapt",
        nextAction: "Preserve required behavior, boundary handling and source identities under the current contract.",
        path: "docs/service-contract.md", quote: contract.trim() });
      await invoke("write_file", { path: "src/scan.mjs", content: prior?.knowledgeVersion === "original" && entry.role !== "irrelevant"
        ? cursorRuleImplementation : investigationRepair(entry.id) });
      await invoke("write_file", { path: "src/identity.mjs", content: "export const identify = value => value;\n" });
      assert.equal((await invoke("run_tests")).expectedTests, 3);
    }
    return { status: "completed", sessionId: randomUUID(), answer: { completed: true }, trace: [], responses: [], inputTokens: 20, outputTokens: 5, toolCalls: 5 };
  } };
  try {
    const report = await runInvestigationLab({ driver: monitored, agent, code, profile: "quality",
      onPlan: plan => { assert.equal(plan.profile, "quality"); }, onEvent: event => {
        if (event.type === "rediscovery_round_started") comparing = true;
        if (event.type === "rediscovery_round_finished") comparing = false;
      } });
    assert.equal(report.status, "completed", JSON.stringify({ failure: report.failure, toolFailures,
      preparation: report.preparation.map(item => ({ correct: item.correct, observations: item.observationIds.length, failure: item.infrastructureFailure })),
      phases: report.preparationWork.map(item => ({ phase: item.phase, arm: item.arm, status: item.status })),
      validations: report.validations.map(item => ({ arm: item.arm, caseId: item.caseId, status: item.status, correct: item.correct })),
      observations: report.knowledge.observations.length, chains: report.knowledge.chains.length, principles: report.knowledge.principles.length }));
    assert.equal(report.plan.protocolVersion, 6);
    assert.equal(report.plan.formationPolicyVersion, 2);
    assert.equal(report.preparationWork.filter(work => work.phase === "chain_proposal").length, 2);
    assert.ok(report.preparationWork.filter(work => work.phase === "chain_proposal").every(work => work.selfReportedComplete === false && work.decisionCompleted));
    assert.equal(report.preparationWork.filter(work => work.phase === "chain_acceptance" && work.decisionCompleted).length, 2);
    assert.equal(report.outcomes.length, 16);
    assert.ok(report.outcomes.every(outcome => outcome.publicTests.expectedTests === 3 && outcome.finalTests.expectedTests === 8));
    assert.deepEqual(Object.keys(report.metrics.arms).sort(), ["fresh", "mindleak", "notebook", "original"]);
    assert.equal(report.metrics.quality.primary, "held_out_outcome_quality");
    assert.equal(report.knowledgeVersions.original.lessons[0].id, report.knowledgeVersions.revised.lessons[0].id);
    assert.ok(report.knowledgeVersions.revised.lessons[0].revision > report.knowledgeVersions.original.lessons[0].revision);
    assert.equal(report.knowledgeVersions.original.principles[0].document.evidence.length, 0);
    assert.equal(report.knowledgeVersions.revised.principles[0].document.evidence.length, 2);
    assert.equal(report.validations.length, 8);
    assert.ok(report.validations.every(check => check.correct));
    assert.ok(report.rounds[0].frozenUnchanged);
    assert.ok(report.reviews.every(review => review.completed));
    assert.equal(report.metrics.arms.mindleak.correct, 4);
    assert.ok(report.metrics.arms.original.quality.checksPassed < report.metrics.arms.mindleak.quality.checksPassed);
    assert.equal(report.metrics.arms.original.quality.checksScheduled, 32);
    assert.equal(report.metrics.arms.mindleak.quality.correctRejections, 1);
    assert.equal(report.metrics.quality.comparativeBenefit, "not_established");
    assert.equal(report.realModel, false, "scripted agents establish mechanics, not model quality gains");
    assert.equal(report.inputTokens, calls * 20);
    if (process.env.MINDLEAK_QUALITY_TEST_REPLAY_DIR) await writeDemoReplay(report, join(process.env.MINDLEAK_QUALITY_TEST_REPLAY_DIR, report.runId));
    if (process.env.MINDLEAK_LAB_BROWSER) {
      const { openArtifactBrowser } = await import("./demo-replay.mjs");
      const directory = await mkdtemp(join(tmpdir(), "mindleak-quality-view-"));
      const server = await createDemoServer({ outputDirectory: directory, initialReport: report, runBuild: async () => report });
      const browser = await openArtifactBrowser();
      try {
        for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }]) {
          const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
          const errors = []; page.on("pageerror", error => errors.push(error.message));
          await page.goto(server.url);
          await page.waitForFunction(() => document.querySelectorAll("#quality-result-body tr").length === 4);
          assert.equal(await page.locator("#quality-status").innerText(), "16 / 16 measured");
          assert.ok((await page.locator('#quality-result-body tr[data-arm="original"]').innerText()).includes("Original Knowledge"));
          assert.equal(await page.locator("#quality-pair-body tr").count(), 4);
          assert.equal(await page.locator("#study-continue").isDisabled(), true);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          await page.locator("#quality-results").scrollIntoViewIfNeeded();
          if (process.env.MINDLEAK_QUALITY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.MINDLEAK_QUALITY_SCREENSHOT_DIR, `quality-${viewport.width}.png`) });
          await page.goto(`${server.url}/learnings`);
          await page.locator("#knowledge-page").waitFor({ state: "visible" });
          assert.equal(await page.locator("#investigation-validations tr").count(), 8);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
          assert.deepEqual(errors, []);
          await page.close();
        }
      } finally { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
    }
    skipReview = true;
    const unchanged = await runInvestigationLab({ driver: monitored, agent, code, profile: "quality" });
    assert.equal(unchanged.status, "completed", JSON.stringify(unchanged.reviews));
    assert.ok(unchanged.reviews.every(review => review.completed && review.outcome === "no_new_learning" && review.decisions.length === 2));
    assert.equal(unchanged.knowledgeVersions.original.lessons[0].revision, unchanged.knowledgeVersions.revised.lessons[0].revision);
    assert.ok(unchanged.preparationWork.filter(work => work.phase === "exception_review").every(work => work.selfReportedComplete === false && work.decisionCompleted));
    const failedCapture = await runInvestigationLab({ driver: { ...monitored, async call(name, args) {
      if (name === "write_memory") throw new Error("mcp_tool_failed");
      return monitored.call(name, args);
    } }, agent, code, profile: "quality" });
    assert.equal(failedCapture.status, "partial");
    assert.equal(failedCapture.failure, "quality_original_knowledge_unavailable");
    assert.equal(failedCapture.outcomes.length, 0);
    assert.equal(failedCapture.knowledge.observations.length, 0);
    assert.equal(failedCapture.metrics.arms.mindleak.quality.unmeasuredTasks, 4);
    assert.equal(failedCapture.metrics.arms.mindleak.quality.checksScheduled, 32);
  } finally { await driver.close(); }
});

test("Lab 3 quality capture keeps exact sources and never credits failed persistence", async () => {
  const { createInvestigationLedger, investigationPlan } = await import("./investigation-lab.mjs");
  const { investigationFixture } = await import("./investigation-fixtures.mjs");
  const plan = investigationPlan({ profile: "quality" });
  const fixture = investigationFixture(plan.discovery[0].id);
  const proof = { id: randomUUID(), group: "behavior", tests: 2, expectedTests: 2, passedTests: 0, passed: false,
    sourceSha256: digest(fixture.files), files: fixture.files, inspected: fixture.files };
  const calls = [];
  let unavailable = true;
  const ledger = createInvestigationLedger({ plan, driver: { async call(name, args) {
    assert.equal(name, "write_memory"); calls.push(structuredClone(args));
    if (unavailable) throw new Error("mcp_tool_failed");
    return { data: { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] } };
  } } });
  const input = { fixture, proofs: new Map([[proof.id, proof]]), taskComplete: false, observation: {
    proofId: proof.id, summary: "The current implementation omitted records after a nonterminal empty page.",
    conditions: "The service declares a null next cursor as completion.", uncertainty: "This observation does not validate other completion contracts.",
    path: "docs/service-contract.md", quote: fixture.files["docs/service-contract.md"].trim(),
  } };
  for (const quote of ["A non-null next cursor marks completion.", "Record identities are case-insensitive.", "The scanner changes client.termination."]) {
    await assert.rejects(ledger.capture({ ...input, observation: { ...input.observation, quote } }), /inspected_source/);
  }
  assert.equal(calls.length, 0, "altered subjects and conditions in quoted evidence must fail before persistence");
  await assert.rejects(ledger.capture(input), /mcp_tool_failed/);
  assert.equal(ledger.snapshot().observations.length, 0);
  assert.equal(ledger.snapshot().operations.length, 0);
  assert.equal(ledger.snapshot().principles.length, 0);
  unavailable = false;
  const saved = await ledger.capture(input);
  assert.deepEqual(calls[1], calls[0], "explicit retry must retain the exact payload and request key");
  const observation = ledger.snapshot().observations[0];
  assert.equal(observation.memoryId, saved.memoryId);
  assert.ok(observation.rawText.includes(input.observation.quote));
  assert.ok(observation.rawText.includes(input.observation.uncertainty));
  assert.equal((await ledger.capture(input)).memoryId, saved.memoryId);
  assert.equal(calls.length, 2, "an acknowledged capture is reused rather than duplicated");
});

test("Lab 3 quality scores executed outcomes and correct rejection independently", async () => {
  const { investigationQuality } = await import("./investigation-lab.mjs");
  const { investigationFixture } = await import("./investigation-fixtures.mjs");
  const fixture = investigationFixture("quality-snapshot-transfer");
  const outcome = { correct: true, decisionCorrect: true, decisionWithPriorEvidence: true, priorKnowledgeDelivered: true,
    decision: { knowledgeDecision: "reject" }, finalTests: { tests: 8, expectedTests: 8, passedTests: 8, passed: true,
      failedTests: [], sourceSha256: "actual-tested-candidate" } };
  const priorCheck = { id: randomUUID(), fixtureSha256: fixture.fixtureSha256, sourceSha256: "tested-prior-procedure", tests: 2, expectedTests: 2, passedTests: 0, passed: false };
  const result = investigationQuality(fixture, outcome, priorCheck);
  assert.equal(result.measured, true);
  assert.equal(result.checksPassed, 8);
  assert.equal(result.correctRejection, true);
  assert.equal(investigationQuality(fixture, outcome, { ...priorCheck, passed: true, passedTests: 2 }).correctRejection, false);
  assert.equal(investigationQuality(fixture, outcome, { passed: false }).correctRejection, false);
  assert.equal(investigationQuality(fixture, outcome, { ...priorCheck, fixtureSha256: "another-fixture" }).correctRejection, false);
  assert.equal(investigationQuality(fixture, { ...outcome, decisionWithPriorEvidence: false }, priorCheck).correctRejection, false);
  assert.equal(investigationQuality(fixture, { ...outcome, finalTests: { passed: true } }).measured, false);
  assert.equal(investigationQuality(fixture, { ...outcome, finalTests: { ...outcome.finalTests, passedTests: 7 } }).checksPassed, null);
  const unsupported = investigationQuality(fixture, { ...outcome, priorKnowledgeDelivered: false, decision: { knowledgeDecision: "use" } });
  assert.equal(unsupported.unsupportedUseClaim, true);
  assert.equal(unsupported.correctRejection, false);
});

test("Lab 3 quality CLI and selector expose the frozen comparison without starting work", async () => {
  const script = fileURLToPath(new URL("./swarm-demo.mjs", import.meta.url));
  const result = spawnSync(process.execPath, [script, "--plan", "--rediscovery-profile", "quality"], { encoding: "utf8", env: {
    ...process.env, MINDLEAK_TEST_DATABASE_URL: "must-not-connect", MINDLEAK_VALIDATION_AGENT_API_KEY: "must-not-read",
  } });
  assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.profile, "quality");
  assert.equal(plan.mainSessions, 16);
  assert.equal(plan.taskChecks, 8);
  assert.equal(plan.delivery, "matched_frozen_briefs");
  assert.ok(!result.stdout.includes("must-not-"));
  assert.equal(selectDemoParameters(null, { rediscoveryProfile: "quality" }).rediscoveryProfile, "quality");
  assert.throws(() => selectDemoParameters(null, { rediscoveryProfile: "quality", continueFrom: randomUUID() }), /fresh_investigation/);
  const { parseHTML } = await import("linkedom");
  const page = parseHTML(await renderDemoPage({ report: { kind: "rediscovery_lab", runId: "quality-ui-plan", status: "completed", plan,
    agents: [{ id: "mindleak", name: "MindLeak" }], events: [], elapsedMs: 1 } })).document;
  assert.ok(page.querySelector("option[value=quality]"));
  assert.ok(page.querySelector("#quality-results"));
  assert.ok(page.querySelector("#quality-result-body"));
});

test("Lab 3 quality display keeps missing receipts unknown and rejection distinct", async () => {
  const { qualityComparison, labCompletion } = await import("./demo-view.mjs");
  const { investigationPlan } = await import("./investigation-lab.mjs");
  const plan = investigationPlan({ profile: "quality" });
  const session = plan.sessions.find(item => item.arm === "mindleak");
  const finished = { id: 1, type: "rediscovery_task_finished", phaseScope: "evaluation", caseId: session.id, agent: session.arm, correct: true };
  const report = { kind: "rediscovery_lab", status: "recording", plan, events: [finished] };
  assert.equal(qualityComparison(report).arms.mindleak.unmeasuredTasks, 4);
  const receipt = { id: 2, type: "quality_checked", caseId: session.id, agent: session.arm, measured: true, checksScheduled: 8, checksPassed: 8,
    sourceBackedDecision: true, correctRejection: true, dimensions: { behavior: { scheduled: 2, passed: 2 }, boundary: { scheduled: 3, passed: 3 }, regression: { scheduled: 3, passed: 3 } } };
  report.events.push(receipt, structuredClone(receipt));
  const quality = qualityComparison(report);
  assert.equal(quality.arms.mindleak.correct, 1);
  assert.equal(quality.arms.mindleak.checksPassed, 8);
  assert.equal(quality.arms.mindleak.correctRejections, 1);
  assert.equal(quality.arms.mindleak.unmeasuredTasks, 3);
  assert.equal(quality.arms.original.unmeasuredTasks, 4);
  assert.ok(quality.comparisons.every(item => item.checksDelta === null));
  assert.equal(qualityComparison({ plan: { profile: "learning" } }), null);
  const tests = { passed: true, tests: 8, expectedTests: 8, passedTests: 8, failedTests: [], sourceSha256: "verified-quality-artifact" };
  const completed = { ...report, status: "completed", preparation: plan.discovery.map(item => ({ id: item.id, correct: true, status: "completed", finalTests: tests })),
    outcomes: plan.sessions.map(item => ({ ...item, correct: true, status: "completed", finalTests: tests })) };
  assert.equal(labCompletion(completed).requirements.status, "passed");
  assert.equal(labCompletion(completed).requirements.scheduled, 18);
});

test("validation scenarios cover all ten categories and reproducible scale checkpoints", () => {
  const plan = generateScenarios();
  assert.equal(categories.length, 10);
  assert.ok(categories.every(category => plan.scenarios[category]));
  assert.deepEqual(plan.sizes, [100, 500, 1000]);
  assert.equal(plan.scenarios.memory_over_time.facts.length, 1000);
  assert.equal(digest(plan), digest(generateScenarios()));
  assert.notEqual(digest(plan), digest(generateScenarios({ seed: 7 })));
  assert.equal(new Set(plan.scenarios.memory_over_time.facts.map(fact => fact.text)).size, 1000);
  for (const sizes of [[], [0], [20, 10], [10, 10], [10001], [1.5]]) assert.throws(() => generateScenarios({ sizes }));
});

test("CLI plan, help, and invalid inputs emit JSON without starting a memory service", () => {
  const script = fileURLToPath(new URL("./validation-harness.mjs", import.meta.url));
  for (const args of [["--help"], ["--plan", "--sizes", "3"], ["--category", "invalid"]]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: "utf8", env: {
      ...process.env, MINDLEAK_TEST_DATABASE_URL: "private-invalid-url", MINDLEAK_VALIDATION_AGENT_API_KEY: "private-test-secret",
    } });
    const report = JSON.parse(result.stdout);
    assert.ok(!result.stdout.includes("private-invalid-url") && !result.stdout.includes("private-test-secret"));
    if (args[0] === "--category") {
      assert.equal(result.status, 1);
      assert.equal(report.status, "error");
      assert.equal(report.summary, null);
    } else assert.equal(result.status, 0);
  }
});

test("three-agent demo plan is explicit and creates no replay or memory service", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-demo-plan-"));
  const replay = join(directory, "replay");
  const script = fileURLToPath(new URL("./validation-harness.mjs", import.meta.url));
  try {
    const result = spawnSync(process.execPath, [script, "--plan", "--category", "three_agent_demo", "--agent-provider", "copilot", "--agent-model", "gpt-6-astra", "--sizes", "3", "--replay-dir", replay], {
      encoding: "utf8", env: { ...process.env, MINDLEAK_TEST_DATABASE_URL: "private-invalid-url" },
    });
    assert.equal(result.status, 0, "the demo plan must work without a provider or database");
    assert.ok(JSON.stringify(JSON.parse(result.stdout)).includes("three_agent_demo"));
    assert.ok(!result.stdout.includes("private-invalid-url"));
    assert.ok(!categories.includes("three_agent_demo"), "existing default runs must not acquire agent-demo requirements");
    await assert.rejects(readFile(join(replay, "index.html")), { code: "ENOENT" });
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Lab 2 investigates the same package problem across distinct frozen cases", async () => {
  const { packageCases, assessPackage, checkAssessment } = await import("./memory-lab-fixture.mjs");
  const cases = packageCases();
  assert.equal(cases.length, 5);
  assert.equal(new Set(cases.map(specification => digest(specification.files))).size, 5);
  const answers = cases.map(assessPackage);
  assert.deepEqual(answers.map(answer => [answer.productionAffected, answer.recommendation, answer.targetVersion]), [
    [true, "upgrade", "2.7.7"], [true, "upgrade", "2.8.4"], [true, "upgrade", "2.9.4"],
    [false, "not_shipped", null], [true, "blocked", null],
  ]);
  for (const [index, specification] of cases.entries()) {
    assert.ok(!Object.keys(specification.files).some(path => /gold|expected|answer/.test(path)));
    const good = { ...answers[index], evidencePaths: specification.evidencePaths };
    assert.equal(checkAssessment(specification, good, new Set(specification.evidencePaths)).passed, true);
    assert.equal(checkAssessment(specification, { ...good, targetVersion: "9.9.9" }, new Set(specification.evidencePaths)).passed, false);
    assert.equal(checkAssessment(specification, good, new Set()).passed, false);
  }
});

test("Lab 2 upgrade codebases separate learning from evaluation and execute API traps", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { upgradeCases, packageWorkspace, assessPackage, checkAssessment } = await import("./memory-lab-fixture.mjs");
  const learning = upgradeCases();
  const evaluation = upgradeCases({ split: "evaluation" });
  assert.equal(learning.length, 5);
  assert.equal(evaluation.length, 5);
  assert.ok(learning.every(specification => specification.fixtureVersion === 2 && specification.files["src/export-report.mjs"]));
  assert.ok(evaluation.every(specification => !learning.some(source => source.fixtureSha256 === specification.fixtureSha256 || source.id === specification.id)));
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  for (const index of [0, 1, 2, 3, 4]) {
    const specification = learning[index];
    const workspace = packageWorkspace(specification, { code });
    const answer = { ...assessPackage(specification), evidencePaths: specification.evidencePaths };
    for (const path of specification.evidencePaths) await workspace.read(path);
    assert.equal(checkAssessment(specification, answer, workspace.filesRead, workspace.probes).passed, false, "reading metadata alone cannot verify a working upgrade");
    let naive;
    if ([0, 2].includes(index)) {
      naive = await workspace.probeUpgrade({ targetPath: answer.targetPath, targetVersion: answer.targetVersion, adapterMode: index === 2 ? "await-string" : "unchanged" });
      assert.equal(naive.tests, 3);
      assert.equal(naive.passed, false, "an incompatible API must fail real code execution");
    }
    const repaired = await workspace.probeUpgrade(answer);
    assert.equal(repaired.passedTests, answer.recommendation === "blocked" ? 1 : 3);
    assert.equal(repaired.passed, answer.recommendation !== "blocked");
    if (naive) assert.notEqual(naive.sourceSha256, repaired.sourceSha256);
    assert.equal(checkAssessment(specification, answer, workspace.filesRead, workspace.probes).passed, true);
    assert.equal(workspace.probes.length, naive ? 2 : 1);
    await assert.rejects(workspace.probeUpgrade({ ...answer, targetVersion: "99.99.99" }), /invalid_upgrade_probe/);
  }
  const { investigatorTools } = await import("./memory-lab.mjs");
  const specification = learning[0];
  const session = investigatorTools({ actor: "atlas", specification, ledger: { nodes: new Map(), observations: [] }, condition: "withoutMemory", index: 0, code, emit: () => {} });
  const invoke = (name, args = {}) => session.tools.find(tool => tool.definition.function.name === name).invoke(args);
  assert.ok(!session.tools.some(tool => /guide|memory/.test(tool.definition.function.name)));
  for (const path of specification.evidencePaths) await invoke("read_file", { path });
  const answer = { ...assessPackage(specification), evidencePaths: specification.evidencePaths };
  assert.equal((await invoke("verify_assessment", answer)).passed, false);
  assert.equal((await invoke("probe_upgrade", answer)).passed, true);
  assert.equal((await invoke("verify_assessment", answer)).passed, true);
});

test("Lab 2 preserves observations, chains and guide revisions across a real restart", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY,
}, async () => {
  const { createKnowledgeLedger } = await import("./memory-lab.mjs");
  const { packageCases } = await import("./memory-lab-fixture.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  try {
    assert.equal(driver.capabilities.knowledge, true);
    assert.equal(driver.capabilities.chains, true);
    const runId = randomUUID();
    const ledger = createKnowledgeLedger({ driver, runId, scope: `lab2-test-${runId}`, emit: () => {} });
    const cases = packageCases();
    const supportedBy = [];
    for (const [index, actor] of ["atlas", "iris"].entries()) {
      const source = await ledger.record(actor, cases[index], `Branch-kit ${cases[index].id} frozen snapshot is source evidence.`, "regression");
      const candidate = await ledger.propose(actor, {
        claim: `Branch-kit ${cases[index].id} requires a scoped package review`, rationale: "The frozen source is recorded.",
        conclusion: "Check shipped paths and compatible upgrades.", applicability: "The named synthetic case only.", assumptions: [],
        evidence: [{ fragmentId: source.fragments[0].fragmentId, role: "supports", reason: "Recorded source." }], kind: "chain", supportedBy: [],
      });
      const accepted = await ledger.accept(actor, candidate.chainId, candidate.revision, cases[index], { passed: true });
      supportedBy.push({ chainId: accepted.chainId, revision: accepted.revision, reason: "Distinct recorded case." });
    }
    const candidate = await ledger.propose("iris", { claim: "Branch-kit solution guide", rationale: "Two accepted cases support the bounded procedure.",
      conclusion: "Check shipped paths, advisory ranges and allowed registry releases.", applicability: "The synthetic package-review workflow.",
      assumptions: [], evidence: [], kind: "principle", supportedBy });
    await ledger.accept("iris", candidate.chainId, candidate.revision, cases[1], { passed: true });
    const proof = await ledger.provePersistence("iris");
    const guide = await ledger.exportGuide();
    const captured = ledger.snapshot();
    for (const record of [...captured.chains, ...captured.principles]) {
      assert.equal(record.review, "reviewed", "capture the actual MCP review status");
      assert.equal(record.requiresReview, false, "capture current dependency review status after restart");
    }
    assert.equal(proof.passed, true);
    assert.equal(proof.records, 5);
    assert.notEqual(proof.previous, proof.current);
    assert.ok(Number.isInteger(proof.previousPid));
    assert.ok(Number.isInteger(proof.currentPid));
    assert.notEqual(proof.previousPid, proof.currentPid);
    assert.equal(ledger.operations.length, 8);
    assert.equal(guide.chainId, candidate.chainId);
    assert.equal(guide.revision, 2);
    assert.ok(guide.markdown.includes("Branch-kit"));
    const separate = await ledger.propose("nova", { ...captured.principles[0].document,
      claim: "Branch-kit runtime boundaries require current compatibility evidence",
      conclusion: "Check deployed dependency paths and the current caller contract before accepting a package-only upgrade." });
    await ledger.accept("nova", separate.chainId, separate.revision, cases[2], { passed: true });
    assert.notEqual(separate.chainId, guide.chainId);
    assert.equal(ledger.snapshot().principles.length, 2);
    assert.equal((await ledger.exportGuide()).chainId, guide.chainId, "the original export identity stays stable");
    assert.deepEqual(new Set((await ledger.exportGuides()).map(item => item.chainId)), new Set([guide.chainId, separate.chainId]));
    await ledger.provePersistence("nova");
    assert.equal(ledger.snapshot().principles.length, 2);
  } finally { await driver.close(); }
});

test("Lab 2 full relay forms multiple principles and freezes the collection for both rounds", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY,
}, async () => {
  const { runMemoryLab, memoryLabRoles } = await import("./memory-lab.mjs");
  const { upgradeCases, assessPackage } = await import("./memory-lab-fixture.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE ?? "podman");
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  const cases = upgradeCases();
  const actors = Object.fromEntries(memoryLabRoles.map((role, index) => [role.id, { configuration: { model: "test-double" }, async run(task, tools, context) {
    assert.ok(task.startsWith("Memory hierarchy for this task:"));
    const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = (name, args = {}) => entries.get(name).invoke(args);
    const specification = cases[index];
    const execution = () => ({ sessionId: randomUUID(), status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 10, outputTokens: 5, toolCalls: 5, elapsedMs: 1 });
    if (entries.has("propose_guide")) {
      assert.ok(!entries.has("verify_assessment"));
      assert.ok(!entries.has("record_observation"));
      const sources = JSON.parse(context);
      assert.equal(sources.view, "synthesis-dossier");
      assert.ok(sources.observations.length >= 2);
      assert.deepEqual([...entries.keys()], ["propose_guide", "accept_knowledge", "skip_learning"]);
      const current = sources.principles[0]?.chain;
      const guide = await invoke("propose_guide", { chainId: current?.chainId ?? null, expectedRevision: current?.revision ?? null,
        claim: "Branch-kit durable package-review guide", rationale: "All current accepted case chains support the bounded procedure.",
        conclusion: "Inspect exact shipped paths, the affected range, and every current compatibility rule. Choose the minimum eligible fix or report not_shipped or blocked.",
        applicability: "This synthetic package-review family, including non-shipped and blocked cases.", assumptions: [], evidence: [],
        supportedBy: sources.chains.map(record => ({ chainId: record.chain.chainId, revision: record.chain.revision, reason: "Accepted case evidence." })) });
      await invoke("accept_knowledge", { chainId: guide.chainId, expectedRevision: guide.revision });
      if (index === 1) {
        const principle = await invoke("propose_guide", { chainId: null, expectedRevision: null,
          claim: "Branch-kit deployment boundary verification", rationale: "The source-backed cases distinguish runtime deployment from dependency inventory.",
          conclusion: "Inspect the deployed caller before selecting an upgrade. Verify its current contract against the actual shipped path.",
          applicability: "Synthetic deployed-runtime checks for branch-kit.", assumptions: [], evidence: [],
          supportedBy: sources.chains.slice(0, 2).map(record => ({ chainId: record.chain.chainId, revision: record.chain.revision, reason: "Accepted case evidence." })) });
        await invoke("accept_knowledge", { chainId: principle.chainId, expectedRevision: principle.revision });
      }
      return execution();
    }
    assert.equal(context, "");
    if (entries.has("record_observation")) {
      assert.ok(!entries.has("verify_assessment"));
      for (const path of specification.evidencePaths) await invoke("read_file", { path });
      const observation = await invoke("record_observation", { claim: `Branch-kit ${specification.id} has a recorded current compatibility policy.`, path: "policy/upgrade-policy.json", quote: '"status": "current"' });
      const candidate = await invoke("propose_chain", { claim: `Branch-kit ${specification.id} has a verified package outcome`,
        rationale: "The five source-grounded assessment checks passed.", conclusion: "Use the frozen shipped paths and current eligible-release policy.",
        applicability: `Only the synthetic ${specification.id} case.`, assumptions: [], evidence: [{ fragmentId: observation.fragments[0].fragmentId, role: "supports", reason: "Recorded current policy." }] });
      await invoke("accept_knowledge", { chainId: candidate.chainId, expectedRevision: candidate.revision });
      return execution();
    }
    const storing = entries.has("recall_guide");
    let previousGuide;
    if (storing && index >= 2) {
      assert.ok(!entries.has("inspect_guide_sources"), "assessment must use progressive retrieval, not all case documents");
      const boundary = await invoke("recall_guide", { query: "branch-kit deployment boundary" });
      assert.ok(boundary.principles.length, "another applicable principle may be read first");
      const sources = await invoke("recall_guide", { query: "branch-kit durable package-review guide" });
      previousGuide = sources.principles[0].chain;
      for (const source of sources.sourceReferences.slice(0, 2)) await invoke("inspect_observation", { fragmentId: source.fragmentId });
    }
    for (const path of specification.evidencePaths) await invoke("read_file", { path });
    await invoke("probe_upgrade", assessPackage(specification));
    const assessment = await invoke("verify_assessment", { ...assessPackage(specification), evidencePaths: specification.evidencePaths });
    assert.equal(assessment.passed, true);
    if (storing) {
      if (previousGuide) await invoke("apply_guide", { chainId: previousGuide.chainId, revision: previousGuide.revision,
        steps: [{ quote: "Inspect exact shipped paths, the affected range, and every current compatibility rule.", decision: "applies", evidencePath: "package-lock.json", reason: "The installed path was checked." },
          { quote: "Choose the minimum eligible fix or report not_shipped or blocked.", decision: "applies", evidencePath: "policy/upgrade-policy.json", reason: "The current compatibility policy was checked." }] });
    } else assert.deepEqual([...entries.keys()], ["list_files", "read_file", "search_files", "verify_assessment", "probe_upgrade"]);
    return { ...execution(), answer: { completed: index !== 1 } };
  } }]));
  try {
    const report = await runMemoryLab({ driver, agentsByRole: actors, code, maxAttempts: 1 });
    assert.equal(report.status, "completed");
    assert.equal(report.summary.agentsPassed, 5);
    assert.equal(report.agents[1].attempts[0].selfReportedComplete, false);
    assert.equal(report.agents[1].attempts[0].passed, true, "verified tool results decide assessment completion, not self-report");
    assert.equal(report.summary.observationsStored, 8);
    assert.equal(report.summary.chainsStored, 5);
    assert.equal(report.summary.principlesStored, 2);
    assert.equal(report.summary.memoriesStored, 28);
    assert.equal(report.summary.inputTokens, 140);
    assert.ok(report.agents.every(actor => actor.evidenceAttempts.length === 1 && actor.evidenceAttempts[0].passed));
    assert.equal(report.summary.guideApplications, 3);
    assert.equal(report.events.filter(event => event.type === "observation_inspected" && event.phase === "assessment").length, 6);
    assert.ok(report.summary.sourceObservationsInspected > 6, "guide dossiers include separately recorded original-source reads");
    assert.ok(report.agents.slice(1).every(actor => actor.guideAttempts.length === 1 && actor.guideAttempts[0].passed));
    assert.equal(report.guide.revision, 8);
    assert.equal(report.knowledge.principles[0].document.supportedBy.length, 5);
    assert.equal(report.knowledge.durability.length, 5);
    assert.ok(report.knowledge.durability.every(proof => proof.passed && proof.previousPid !== proof.currentPid));
    assert.equal(report.knowledge.durability.at(-1).records, 15);
    assert.equal(report.finalTests.passedTests, 35);
    assert.equal(report.comparisons.length, 0, "preparation must not contain hidden no-memory evaluation costs");
    const { runMemoryControl } = await import("./memory-control.mjs");
    const { createKnowledgeLedger } = await import("./memory-lab.mjs");
    const barriers = [Promise.withResolvers(), Promise.withResolvers()];
    const entered = [0, 0];
    let active = 0;
    let reviewed = 0;
    const monitored = { ...driver, restart: () => driver.restart(), async call(name, args) {
      if (name === "write_memory") assert.equal(active, 0, "neither arm may write until all ten sessions finish");
      return driver.call(name, args);
    } };
    const solvers = Object.fromEntries(memoryLabRoles.map((role, index) => {
      let executions = 0;
      return [role.id, { configuration: { model: "test-double", maxSteps: 24, timeoutMs: 600000, maxAiCredits: 30 }, async run(task, tools, context) {
        const roundIndex = Math.floor(executions++ / 2);
        const specification = upgradeCases({ split: "evaluation", round: roundIndex + 1 })[index];
        assert.equal(context, "");
        assert.ok(task.startsWith("Memory hierarchy for this task:"));
        assert.ok(task.includes(specification.id));
        const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
        assert.ok(![...entries.keys()].some(name => /write|record|accept|propose|apply_guide/.test(name)));
        const invoke = (name, args = {}) => entries.get(name).invoke(args);
        active += 1;
        entered[roundIndex] += 1;
        if (entered[roundIndex] === 10) barriers[roundIndex].resolve();
        let timer;
        try {
          await Promise.race([barriers[roundIndex].promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("all_ten_arms_must_start")), 10000); })]);
          if (entries.has("recall_guide")) {
            await assert.rejects(invoke("verify_assessment", { ...assessPackage(specification), evidencePaths: specification.evidencePaths }), /prior_experience_search_required/);
            const boundary = await invoke("recall_guide", { query: "branch-kit deployment boundary" });
            assert.equal(boundary.principles[0]?.chain.chainId, report.knowledge.principles[1].chainId, "all retained principles are usable in matched rounds");
            const guide = await invoke("recall_guide", { query: "branch-kit durable package-review guide" });
            assert.equal(guide.principles[0].chain.revision, report.guide.revision + roundIndex * 2);
            await assert.rejects(invoke("probe_upgrade", assessPackage(specification)), /inspected_source_evidence_required/);
            await invoke("inspect_observation", { fragmentId: guide.sourceReferences[0].fragmentId });
          }
          for (const path of specification.evidencePaths) await invoke("read_file", { path });
          await invoke("probe_upgrade", assessPackage(specification));
          assert.equal((await invoke("verify_assessment", { ...assessPackage(specification), evidencePaths: specification.evidencePaths })).passed, true);
          return { sessionId: randomUUID(), status: "completed", answer: { completed: true, finding: { claim: "Current policy was verified for this export case.",
            path: "policy/upgrade-policy.json", quote: '"status": "current"', guideStep: entries.has("recall_guide") ? "Inspect exact shipped paths" : null } },
          trace: [], responses: [], inputTokens: 100, outputTokens: 10, toolCalls: 10, elapsedMs: 1 };
        } finally { clearTimeout(timer); active -= 1; }
      } }];
    }));
    const control = await runMemoryControl({ driver: monitored, preparation: report, agentsByRole: solvers, code, rounds: 2,
      async learn({ preparation, round }) {
        assert.equal(active, 0);
        assert.equal(entered[round.number - 1], 10);
        reviewed += 1;
        const ledger = createKnowledgeLedger({ driver: monitored, runId: randomUUID(), scope: preparation.scope, seed: preparation.knowledge, emit: () => {} });
        const document = structuredClone(preparation.knowledge.principles[0].document);
        document.rationale += ` Verified round ${round.number} remains within the recorded applicability.`;
        const actor = `test-review-${round.number}`;
        const candidate = await ledger.propose(actor, document, { chainId: preparation.guide.chainId, expectedRevision: preparation.guide.revision });
        await ledger.accept(actor, candidate.chainId, candidate.revision, { id: `round-${round.number}` }, { passed: true, expectedTests: 35 });
        await ledger.provePersistence(actor);
        const guide = await ledger.exportGuide();
        return { preparation: { ...preparation, guide, knowledge: { ...ledger.snapshot(), guide } },
          cost: { inputTokens: 20, outputTokens: 2, toolCalls: 5, elapsedMs: 5, memoryProcessing: { calls: 0, inputTokens: 0, outputTokens: 0 } } };
      } });
    assert.equal(control.status, "completed");
    assert.deepEqual(entered, [10, 10]);
    assert.equal(reviewed, 2);
    assert.equal(control.rounds.length, 2);
    assert.equal(control.summary.withMemory.correct, 10);
    assert.equal(control.summary.withoutMemory.correct, 10);
    assert.equal(control.summary.withMemory.totalInputTokens, report.summary.inputTokens + 1000 + 40);
    assert.equal(control.summary.withoutMemory.inputTokens, 1000);
    assert.equal(control.summary.memoryProcessing.inputTokens, 0);
    assert.ok(control.summary.savings.includingPreparationInputPercent < 0);
    assert.equal(control.knowledge.guide.revision, report.guide.revision + 4);
    const outcomes = control.rounds.flatMap(round => round.pairs.flatMap(pair => [pair.withMemory, pair.withoutMemory]));
    assert.equal(new Set(outcomes.map(outcome => outcome.sessionId)).size, 20);
    assert.ok(control.rounds.every(round => round.pairs.length === 5 && round.frozen.unchangedAfterComparison));
    assert.ok(control.rounds.every(round => round.frozen.principles.length === 2));
    assert.ok(control.rounds.every(round => round.pairs.every(pair => pair.withMemory.guideRetrievedBeforeAssessment && pair.withMemory.guideApplied && !pair.withoutMemory.knowledgeReceived)));
    const { learnFromControlRound } = await import("./memory-control.mjs");
    let reviewSessions = 0;
    const reviewer = { configuration: { model: "test-double" }, async run(task, tools, context) {
      reviewSessions += 1;
      assert.ok(task.startsWith("Memory hierarchy for this task:"));
      const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
      const invoke = (name, args = {}) => entries.get(name).invoke(args);
      if (entries.has("record_observation")) {
        assert.equal(context, "");
        await invoke("memory_checkpoint");
        const text = await invoke("read_file", { path: "round/verified-cases.json" });
        assert.ok(!text.includes("Dalek") && !text.includes("withoutMemory"), "control answers must not enter shared learning");
        const cases = JSON.parse(text).cases;
        assert.equal(cases.length, 5);
        assert.ok(cases.every(item => item.verification.passed));
        const observation = await invoke("record_observation", { kind: "decision", claim: "Branch-kit round-1-review has five source-grounded assessments with explicit guide use.",
          path: "round/verified-cases.json", quote: '"guideRetrievedBeforeAssessment": true' });
        const chain = await invoke("propose_chain", { claim: "Branch-kit round-1-review verifies the procedure on new package values",
          rationale: "Five checked cases support this bounded round report; they remain the same problem families, not independent confirmations.",
          conclusion: "Inspect shipped paths and API results before selecting a compatible upgrade.", applicability: "The verified cases in round 1 only.", assumptions: [],
          evidence: [{ fragmentId: observation.fragments[0].fragmentId, role: "supports", reason: "Actual round receipts were inspected." }] });
        await invoke("accept_knowledge", { chainId: chain.chainId, expectedRevision: chain.revision });
      } else {
        const sources = JSON.parse(context);
        assert.equal(sources.view, "synthesis-dossier");
        const current = sources.principles[0].chain;
        const guide = await invoke("propose_guide", { ...current.snapshot.document, kind: undefined, chainId: current.chainId, expectedRevision: current.revision,
          supportedBy: sources.chains.map(item => ({ chainId: item.chain.chainId, revision: item.chain.revision, reason: "Accepted recorded case evidence." })) });
        await invoke("accept_knowledge", { chainId: guide.chainId, expectedRevision: guide.revision });
      }
      if (entries.has("memory_checkpoint")) assert.equal((await invoke("memory_checkpoint")).ready, true);
      return { sessionId: randomUUID(), status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 20, outputTokens: 2, toolCalls: 5, elapsedMs: 1 };
    } };
    const learned = await learnFromControlRound({ driver: monitored, preparation: { ...report, guide: control.guide, knowledge: control.knowledge },
      round: control.rounds[0], agent: reviewer, code, maxAttempts: 1 });
    assert.equal(learned.status, "completed");
    assert.equal(reviewSessions, 2);
    assert.equal(learned.cost.inputTokens, 40);
    assert.equal(learned.preparation.knowledge.chains.length, 6);
    assert.equal(learned.preparation.guide.chainId, report.guide.chainId);
    assert.equal(learned.preparation.guide.revision, control.guide.revision + 2);
    assert.ok(learned.preparation.knowledge.durability.at(-1).passed);
    const { combineControlReport } = await import("./memory-control.mjs");
    const combined = combineControlReport(report, control);
    const recording = normalizeRecording(combined);
    assert.equal(recording.agents.length, 10);
    assert.equal(recording.agents.filter(actor => actor.control).length, 5);
    assert.equal(recording.expectedTests, 175);
    assert.equal(combined.summary.inputTokens, report.summary.inputTokens + 2040);
    assert.equal(new Set(combined.events.map(event => event.id)).size, combined.events.length);
    assert.equal(combined.events.at(-1).type, "run_finished");
    const page = await renderDemoPage({ report: combined });
    assert.ok(page.includes('id="control-agents"'));
    assert.ok(page.includes('id="control-cost-body"'));
    if (process.env.MINDLEAK_CONTROL_TEST_REPLAY_DIR) await writeDemoReplay(combined, process.env.MINDLEAK_CONTROL_TEST_REPLAY_DIR);
  } finally { await driver.close(); }
});

test("Lab 2 guide tool view preserves the full current document without repeating history", async () => {
  const { knowledgeToolView } = await import("./memory-lab.mjs");
  const document = { kind: "chain", claim: "Branch-kit observed case", evidence: [{ fragmentId: "source", role: "supports" }], supportedBy: [] };
  const source = { chain: { chainId: "chain", revision: 2, memoryId: "memory", snapshot: { document, state: "accepted" }, rawText: "duplicate historical payload" },
    requiresReview: false, history: [{ rawText: "history" }], supportingChains: [] };
  const result = knowledgeToolView(source);
  assert.deepEqual(result.chain.snapshot.document, document);
  assert.equal(result.chain.revision, 2);
  assert.equal(result.requiresReview, false);
  assert.ok(!JSON.stringify(result).includes("duplicate historical payload"));
  assert.ok(!Object.hasOwn(result, "history"));
  assert.deepEqual(knowledgeToolView({ kind: "knowledge", principles: [], chains: [source], observations: [] }).chains, [result]);
});

test("memory start brief explains principles chains and observations before task execution", async () => {
  const { memoryStartPrompt } = await import("./memory-lab.mjs");
  for (const mode of ["learning", "control", "withoutMemory"]) {
    const prompt = memoryStartPrompt({ mode });
    for (const term of ["Principles", "Chains", "Observations", "applicability", "current codebase"]) assert.ok(prompt.includes(term));
    assert.ok(!/2\.7\.7|2\.8\.4|2\.9\.4/.test(prompt), "orientation must not supply a case answer");
  }
  const shared = memoryStartPrompt({ mode: "control" });
  assert.ok(shared.includes("Before investigating, call recall_guide"));
  assert.ok(shared.includes("read-only"));
  const independent = memoryStartPrompt({ independent: true });
  assert.ok(independent.includes("Do not retrieve earlier findings"));
  assert.ok(!independent.includes("Before investigating, call recall_guide"));
  assert.ok(memoryStartPrompt({ mode: "withoutMemory" }).includes("No stored knowledge is available"));
});

test("five Dalek controls match the same models cases budgets and simultaneous start", async () => {
  const { controlPlan } = await import("./memory-control.mjs");
  const { upgradeCases } = await import("./memory-lab-fixture.mjs");
  const plan = controlPlan({ model: "gpt-6-astra" });
  assert.equal(plan.pairs.length, 5);
  assert.equal(plan.agentExecutions, 10);
  assert.equal(plan.concurrency, 10);
  assert.equal(plan.freshSessions, true);
  assert.equal(plan.model, "gpt-6-astra");
  assert.ok(plan.pairs.every(pair => pair.withMemory.fixtureSha256 === pair.withoutMemory.fixtureSha256));
  assert.ok(plan.pairs.every(pair => pair.withMemory.model === pair.withoutMemory.model));
  assert.ok(plan.pairs.every(pair => pair.schedule === "common-start-barrier"));
  assert.deepEqual(plan.pairs.map(pair => pair.withoutMemory.name), ["Dalek 1", "Dalek 2", "Dalek 3", "Dalek 4", "Dalek 5"]);
  assert.deepEqual(controlPlan(), controlPlan());
  assert.equal(controlPlan().pairs[4].withMemory.model, "claude-opus-5");
  for (const pairs of [0, 6, 65, 1.5]) assert.throws(() => controlPlan({ pairs }));
  assert.ok(plan.pairs.every(pair => !upgradeCases().some(source => source.fixtureSha256 === pair.withMemory.fixtureSha256)));
  assert.equal(plan.preparationCostsIncluded, true);
  assert.equal(plan.estimatedCostUsd, null, "a spending ceiling is not an estimated charge");
  const repeated = controlPlan({ rounds: 3 });
  assert.equal(repeated.pairs.length, 15);
  assert.equal(repeated.agentExecutions, 30);
  assert.equal(new Set(repeated.pairs.map(pair => pair.withMemory.fixtureSha256)).size, 15);
  assert.equal(repeated.caseFamilies, 5, "new values are not new independent problem families");
  assert.equal(repeated.feedbackBetweenRoundsOnly, true);
  assert.throws(() => controlPlan({ rounds: 4 }));
});

test("Lab 2 continuation preserves the accepted guide without replaying preparation", async () => {
  const { continueMemoryPreparation } = await import("./memory-control.mjs");
  const parent = { kind: "memory_lab", status: "completed", runId: "prior-run", scope: "memory-lab-prior-run", fixtureVersion: 2,
    guide: { chainId: "guide", revision: 4 }, knowledge: { principles: [{ chainId: "guide", revision: 4, state: "accepted" }], observations: [], chains: [], operations: [] },
    agents: [...swarmRoles.map(role => ({ ...role, attempts: [{ passed: true }], state: "passed" })), { id: "dalek-1", control: true }],
    events: [{ type: "run_finished", atMs: 9 }], elapsedMs: 10, summary: { inputTokens: 100, outputTokens: 10, toolCalls: 8 },
    memoryProcessing: { calls: 3, inputTokens: 10, outputTokens: 4 }, finalTests: { passed: true, passedTests: 105, expectedTests: 105 } };
  const before = structuredClone(parent); const preparation = continueMemoryPreparation(parent);
  assert.notEqual(preparation.runId, parent.runId);
  assert.equal(preparation.scope, parent.scope);
  assert.deepEqual(preparation.guide, parent.guide);
  assert.deepEqual(preparation.knowledge, parent.knowledge);
  assert.equal(preparation.preparationReused, true);
  assert.equal(preparation.summary.inputTokens, 0, "no old inference is re-emitted as a new execution");
  assert.equal(preparation.finalTests.expectedTests, 0);
  assert.ok(preparation.agents.length === 5 && preparation.agents.every(actor => actor.attempts.length === 0));
  assert.deepEqual(parent, before);
  assert.throws(() => continueMemoryPreparation({ ...parent, status: "partial" }));
  assert.throws(() => continueMemoryPreparation({ ...parent, guide: { chainId: "guide", revision: 5 } }));
});

test("Lab 2 round parameters stay bounded and Dalek models cannot diverge", () => {
  const profiles = { experiment: 2, agents: [{ id: "gpt-6-astra" }], memory: [{ id: "off" }], defaults: {
    problem: "Investigate the synthetic export upgrade.", concurrency: 1, attempts: 2, rounds: 2, memoryModel: "off",
    agentModels: Object.fromEntries(swarmRoles.map(role => [role.id, "gpt-6-astra"])) } };
  assert.equal(selectDemoParameters(profiles, { rounds: 3 }).rounds, 3);
  for (const rounds of [0, 4, 1.5]) assert.throws(() => selectDemoParameters(profiles, { rounds }));
  assert.throws(() => selectDemoParameters(profiles, { agentModels: { ...profiles.defaults.agentModels, "dalek-1": "gpt-6-astra" } }));
});

test("Lab 3 smoke and full-pilot selection do not change frozen scoring", () => {
  const profiles = { experiment: 3, agents: [{ id: "gpt-6-astra" }], memory: [{ id: "off" }], defaults: {
    problem: "Rediscovery", concurrency: 1, attempts: 1, rediscoveryProfile: "smoke", querySeed: 20260917, memoryModel: "off",
    agentModels: Object.fromEntries(swarmRoles.map(role => [role.id, "gpt-6-astra"])) } };
  assert.equal(selectDemoParameters(profiles, { rediscoveryProfile: "pilot" }).rediscoveryProfile, "pilot");
  assert.throws(() => selectDemoParameters(profiles, { rediscoveryProfile: "tuned" }));
  assert.throws(() => selectDemoParameters(profiles, { concurrency: 2 }));
  assert.throws(() => selectDemoParameters(profiles, { querySeed: -1 }));
});

test("Lab 2 compact memory briefing preserves the guide and distinct evidence pointers", async () => {
  const { knowledgeBrief } = await import("./memory-lab.mjs");
  const document = { kind: "principle", claim: "Branch-kit review guide", conclusion: "Check the current shipped path.",
    applicability: "The verified package-review family.", assumptions: [], evidence: [], supportedBy: [{ chainId: "chain-a", revision: 2, reason: "Source evidence." }] };
  const response = { kind: "knowledge", principles: [{ chain: { chainId: "guide", revision: 4, memoryId: "guide-write", snapshot: { state: "accepted", document } },
    requiresReview: false, supportingChains: [{ reference: document.supportedBy[0], state: "accepted", requiresReview: false,
      document: { kind: "chain", claim: "Verified case", rationale: "redundant history ".repeat(1000), evidence: [{ fragmentId: "source-a", role: "supports", reason: "Recorded policy." }], supportedBy: [] } }] }],
    chains: [{ chain: { chainId: "other", snapshot: { document: { rationale: "unneeded case detail" } } } }], observations: [{ fragmentId: "unrelated", text: "unneeded raw observation" }] };
  const brief = knowledgeBrief(response);
  assert.deepEqual(brief.principles[0].chain.snapshot.document, { ...document, supportedBy: [{ chainId: "chain-a", revision: 2 }] });
  assert.equal(brief.principles[0].chain.revision, 4);
  assert.deepEqual(brief.sourceReferences, [{ chainId: "chain-a", revision: 2, fragmentId: "source-a", role: "supports" }]);
  assert.equal(brief.chains.length, 0);
  assert.equal(brief.observations.length, 0);
  assert.ok(!JSON.stringify(brief).includes("redundant history"));
  assert.ok(!JSON.stringify(brief).includes("unneeded raw observation"));
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 4096);
  assert.equal(response.principles[0].supportingChains[0].document.rationale, "redundant history ".repeat(1000), "briefing must not mutate stored knowledge");
});

test("Lab 2 brief omits repeated history but retains conditions and counterevidence", async () => {
  const { knowledgeBrief, knowledgeToolView } = await import("./memory-lab.mjs");
  const document = { kind: "principle", claim: "Branch-kit upgrade procedure", conclusion: "Check the deployed caller before choosing an upgrade.",
    applicability: "Only the current approved runtime; no automatic range widening.", assumptions: ["A changed API invalidates an unchanged caller."],
    rationale: "The full historical reasoning remains inspectable. ".repeat(60),
    evidence: [{ fragmentId: "contrary-source", role: "counterexample", reason: "The old synchronous result contract no longer applies." }],
    supportedBy: [{ chainId: "case-chain", revision: 2, reason: "The complete justification remains in the chain.".repeat(20) }] };
  const source = { kind: "knowledge", principles: [{ chain: { chainId: "guide", revision: 4, memoryId: "write-receipt", snapshot: {
    state: "accepted", document, validation: { method: "Repeated acceptance metadata. ".repeat(80) } } }, requiresReview: false,
    supportingChains: [{ reference: document.supportedBy[0], state: "accepted", requiresReview: false,
      document: { kind: "chain", evidence: [{ fragmentId: "case-source", role: "supports", reason: "Verified deployed caller." }], supportedBy: [] } }] }], chains: [], observations: [] };
  const before = structuredClone(source);
  const brief = knowledgeBrief(source);
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 2048, "the normal first response should contain the actionable procedure, not history");
  const compact = brief.principles[0].chain.snapshot;
  assert.equal(compact.document.conclusion, document.conclusion);
  assert.equal(compact.document.applicability, document.applicability);
  assert.deepEqual(compact.document.assumptions, document.assumptions);
  assert.deepEqual(compact.document.evidence, document.evidence);
  assert.deepEqual(compact.document.supportedBy, [{ chainId: "case-chain", revision: 2 }]);
  assert.equal(compact.document.rationale, undefined);
  assert.equal(compact.validation, undefined);
  assert.equal(brief.fullEvidenceAvailable, true);
  assert.equal(knowledgeToolView(source).principles[0].chain.snapshot.document.rationale, document.rationale);
  assert.deepEqual(source, before, "projection must not mutate stored knowledge");
});

test("Lab 2 brief defers extra supporting pointers without hiding contrary evidence", async () => {
  const { knowledgeBrief } = await import("./memory-lab.mjs");
  const supportedBy = Array.from({ length: 4 }, (_, index) => ({ chainId: `chain-${index}`, revision: 2, reason: "Full explanation remains inspectable." }));
  const supportingChains = supportedBy.map((reference, index) => ({ reference, state: "accepted", requiresReview: false,
    document: { kind: "chain", evidence: [
      { fragmentId: `source-${index}-a`, role: "supports", reason: "Checked source." },
      { fragmentId: `source-${index}-b`, role: "supports", reason: "Another checked source." },
      ...(index === 3 ? [{ fragmentId: "counterexample", role: "counterexample", reason: "Do not apply this advice to the new API." }] : []),
    ] } }));
  const response = { principles: [{ chain: { chainId: "guide", revision: 2, snapshot: { state: "accepted", document: {
    kind: "principle", claim: "A bounded guide", conclusion: "Check the current API.", applicability: "Only the approved environment.", assumptions: [], evidence: [], supportedBy,
  } } }, requiresReview: false, supportingChains }] };
  const brief = knowledgeBrief(response);
  assert.equal(brief.sourceReferences.filter(reference => reference.role === "supports").length, 2);
  assert.equal(new Set(brief.sourceReferences.filter(reference => reference.role === "supports").map(reference => reference.chainId)).size, 2);
  assert.ok(brief.sourceReferences.some(reference => reference.fragmentId === "counterexample" && reference.reason === "Do not apply this advice to the new API."));
  assert.equal(brief.sourceReferencesTruncated, true);
  assert.equal(brief.sourceReferenceCount, 9);
  assert.deepEqual(brief.principles[0].chain.snapshot.document.supportedBy, supportedBy.map(({ chainId, revision }) => ({ chainId, revision })));
});

test("Lab 2 memory checkpoints identify missing actions without exposing earlier answers", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases } = await import("./memory-lab-fixture.mjs");
  const ledger = { observations: [], nodes: new Map([["earlier-guide", { actor: "atlas", state: "accepted", document: { kind: "principle", conclusion: "private previous answer" } }]]), guideId: "earlier-guide" };
  const create = index => investigatorTools({ driver: {}, scope: "test", actor: index ? "nova" : "iris", specification: packageCases()[index], ledger,
    condition: "withMemory", index, emit: () => {} });
  const seed = create(0);
  const checkpoint = seed.tools.find(tool => tool.definition.function.name === "memory_checkpoint");
  assert.ok(checkpoint);
  const seedStatus = await checkpoint.invoke({});
  assert.equal(seedStatus.ready, false);
  assert.ok(seedStatus.nextActions.includes("verify_assessment"));
  assert.ok(!JSON.stringify(seedStatus).includes("earlier-guide"));
  assert.ok(!JSON.stringify(seedStatus).includes("private previous answer"));
  const later = await create(2).tools.find(tool => tool.definition.function.name === "memory_checkpoint").invoke({});
  assert.ok(later.nextActions.includes("recall_guide"));
  assert.ok(later.nextActions.includes("apply_guide"));
  assert.equal(later.stage, "assessment");
});

test("Lab 2 gates learning writes and keeps its first investigations independent", async () => {
  const { investigatorTools, runMemoryLab } = await import("./memory-lab.mjs");
  const { packageCases, assessPackage } = await import("./memory-lab-fixture.mjs");
  const specification = packageCases()[0];
  const writes = [];
  const ledger = { nodes: new Map(), observations: [],
    async record(actor, current, text, source) { writes.push({ actor, current: current.id, text, source }); return { memoryId: randomUUID(), fragments: [] }; },
    async search() { return { kind: "knowledge", principles: [], chains: [], observations: [] }; },
    async propose() { writes.push("chain"); return {}; },
  };
  const session = investigatorTools({ driver: {}, scope: "test", actor: "atlas", specification, ledger, condition: "withMemory", index: 0, emit: () => {} });
  assert.ok(!session.tools.some(tool => ["propose_guide", "apply_guide"].includes(tool.definition.function.name)), "seed assessment cannot invoke a guide that does not exist");
  let active = session;
  const invoke = (name, args) => active.tools.find(tool => tool.definition.function.name === name).invoke(args);
  await assert.rejects(invoke("recall_guide", { query: "branch-kit" }), /independent_assessment_first/);
  assert.ok(!session.tools.some(tool => tool.definition.function.name === "record_observation"));
  active = investigatorTools({ driver: {}, scope: "test", actor: "atlas", specification, ledger, condition: "withMemory", index: 0, stage: "evidence", emit: () => {} });
  await assert.rejects(invoke("record_observation", { claim: "Unverified", path: "package-lock.json", quote: "branch-kit" }), /verified_source_quote_required/);
  active = session;
  assert.equal(writes.length, 0);
  for (const path of specification.evidencePaths) await invoke("read_file", { path });
  const answer = { ...assessPackage(specification), evidencePaths: specification.evidencePaths };
  assert.equal((await invoke("verify_assessment", answer)).passed, true);
  assert.equal(writes.length, 0, "checking an answer must not silently store it");
  await invoke("recall_guide", { query: "branch-kit" });
  active = investigatorTools({ driver: {}, scope: "test", actor: "atlas", specification, ledger, condition: "withMemory", index: 0, stage: "evidence", priorAssessment: { verification: session.verification, answer: session.answer }, emit: () => {} });
  await invoke("read_file", { path: "package-lock.json" });
  await assert.rejects(invoke("record_observation", { claim: "Invented source", path: "package-lock.json", quote: "not in the source" }), /verified_source_quote_required/);
  await invoke("record_observation", { claim: "The frozen lockfile includes branch-kit.", path: "package-lock.json", quote: "branch-kit" });
  assert.equal(writes.length, 1);
  await assert.rejects(invoke("propose_chain", { claim: "Branch-kit generic repeated claim" }), /case_identity_required_in_claim/);
  const baseline = investigatorTools({ driver: {}, scope: "test", actor: "atlas", specification, ledger, condition: "withoutMemory", index: 2, emit: () => {} });
  assert.deepEqual(baseline.tools.map(tool => tool.definition.function.name), ["list_files", "read_file", "search_files", "verify_assessment"]);
  await assert.rejects(runMemoryLab({ driver: { capabilities: {} } }), /requires_MindLeak_v0_6/);
});

test("Lab 2 observation capture labels intent and reuses an acknowledged duplicate", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases } = await import("./memory-lab-fixture.mjs");
  const specification = packageCases()[0];
  const events = [];
  const ledger = { observations: [], nodes: new Map(), async record(actor, current, text, source, metadata) {
    const receipt = { memoryId: "existing-memory", fragments: [{ fragmentId: "source-fragment", text }] };
    this.observations.push({ ...receipt, actor, source, rawText: text, ...metadata });
    return receipt;
  } };
  const session = investigatorTools({ driver: {}, scope: "test", actor: "atlas", specification, ledger, condition: "withMemory", index: 0,
    stage: "evidence", priorAssessment: { verification: { passed: true } }, emit: event => events.push(event) });
  const invoke = (name, args = {}) => session.tools.find(tool => tool.definition.function.name === name).invoke(args);
  await invoke("read_file", { path: "policy/upgrade-policy.json" });
  const discovery = { kind: "constraint", claim: "The current policy requires verified signatures.", path: "policy/upgrade-policy.json", quote: '"requiredSignature": "verified"' };
  const first = await invoke("record_observation", discovery);
  const repeated = await invoke("record_observation", discovery);
  assert.equal(repeated.memoryId, first.memoryId);
  assert.equal(repeated.existing, true);
  assert.equal(ledger.observations.length, 1);
  assert.equal(ledger.observations[0].kind, "constraint");
  assert.ok(events.some(event => event.type === "memory_duplicate_reused"));
  const checkpoint = await invoke("memory_checkpoint");
  assert.equal(checkpoint.observations.length, 1);
  assert.ok(checkpoint.nextActions.includes("propose_chain"));
  assert.ok(!checkpoint.nextActions.includes("record_observation"));
});

test("Lab 2 applied learning requires prior guide exposure, exact steps and original sources", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases, assessPackage } = await import("./memory-lab-fixture.mjs");
  const specification = packageCases()[2];
  const document = { kind: "principle", conclusion: "Inspect the exact shipped path. Check every current eligibility rule.",
    supportedBy: [{ chainId: "first", revision: 2 }, { chainId: "second", revision: 2 }] };
  const guide = { chain: { chainId: "guide", revision: 2, snapshot: { state: "accepted", document } }, requiresReview: false, supportingChains: [] };
  const observations = ["first", "second"].map(id => ({ actor: id, memoryId: `memory-${id}`, fragments: [{ fragmentId: `fragment-${id}` }] }));
  guide.supportingChains = observations.map(source => ({ reference: { chainId: source.actor, revision: 2 }, state: "accepted", requiresReview: false,
    document: { kind: "chain", evidence: [{ fragmentId: source.fragments[0].fragmentId, role: "supports", reason: "Original source." }], supportedBy: [] } }));
  let writes = 0;
  let principlesAvailable = true;
  const toolDetails = [];
  const ledger = { observations, nodes: new Map([
    ["guide", { chainId: "guide", revision: 2, state: "accepted", actor: "iris", document }],
    ...["first", "second"].map(id => [id, { actor: id, document: { kind: "chain", evidence: [{ fragmentId: `fragment-${id}` }] } }]),
  ]), async search() { return { kind: "knowledge", principles: principlesAvailable ? [guide] : [],
    chains: principlesAvailable ? [] : [{ chain: { chainId: "first", revision: 2, snapshot: { state: "accepted",
      document: { kind: "chain", conclusion: "An earlier case passed its checks.", evidence: [], supportedBy: [] } } }, supportingChains: [] }], observations: [] }; }, async inspect() { return guide; },
    async inspectObservation(id) { const observation = observations.find(item => item.fragments[0].fragmentId === id); return { ...observation, fragmentId: id, rawText: "Recorded original source" }; },
    async recordApplication() { writes += 1; return { memoryId: "application" }; } };
  const create = () => investigatorTools({ driver: {}, scope: "test", actor: "nova", specification, ledger, condition: "withMemory", index: 2,
    emit: () => {}, onToolDetail: detail => toolDetails.push(detail) });
  const invoke = (session, name, args) => session.tools.find(tool => tool.definition.function.name === name).invoke(args);
  const assess = async session => {
    for (const path of specification.evidencePaths) await invoke(session, "read_file", { path });
    return invoke(session, "verify_assessment", { ...assessPackage(specification), evidencePaths: specification.evidencePaths });
  };
  const detail = { chainId: "guide", revision: 2, steps: [{ quote: "Inspect the exact shipped path.", evidencePath: "package-lock.json", decision: "applies", reason: "The path was checked." },
    { quote: "Check every current eligibility rule.", evidencePath: "policy/upgrade-policy.json", decision: "applies", reason: "Current policy was checked." }] };
  const late = create(); await assert.rejects(assess(late), /prior_experience_search_required/); await invoke(late, "recall_guide", { query: "branch-kit" });
  await assert.rejects(invoke(late, "apply_guide", detail), /guide_must_precede_verified_assessment/);
  const chainOnly = create(); principlesAvailable = false;
  const evidenceOnly = await invoke(chainOnly, "recall_guide", { query: "branch-kit earlier case" });
  assert.deepEqual(evidenceOnly.applicationGuides, [], "case-chain hits are not application references");
  assert.deepEqual(evidenceOnly.nextAction, { tool: "inspect_knowledge", arguments: { chainId: "guide" } });
  assert.equal(chainOnly.checkpoint().guideReceived, false, "catalogue pointers do not deliver the principle");
  for (const source of observations) await invoke(chainOnly, "inspect_observation", { fragmentId: source.fragments[0].fragmentId });
  await assert.rejects(assess(chainOnly), /principle_required_before_assessment/);
  assert.equal(chainOnly.verification, null, "case evidence alone cannot freeze an empty application binding");
  const recovered = await invoke(chainOnly, evidenceOnly.nextAction.tool, evidenceOnly.nextAction.arguments);
  assert.equal(recovered.view, "guide-first");
  assert.equal(recovered.sourceReferences.length, 2);
  assert.deepEqual(recovered.applicationGuides, [{ chainId: "guide", revision: 2, kind: "principle" }]);
  const assessed = await assess(chainOnly);
  assert.equal(assessed.passed, true, "actual principle inspection before verification remains eligible");
  assert.deepEqual(assessed.applicationGuides, recovered.applicationGuides);
  assert.deepEqual(chainOnly.checkpoint().applicationGuides, recovered.applicationGuides);
  principlesAvailable = true;
  const valid = create(); await invoke(valid, "recall_guide", { query: "branch-kit" });
  await assert.rejects(assess(valid), /inspect_two_guide_sources/);
  for (const source of observations) await invoke(valid, "inspect_observation", { fragmentId: source.fragments[0].fragmentId });
  await assess(valid);
  await assert.rejects(invoke(valid, "apply_guide", { ...detail, chainId: "first" }), /eligible_principle_reference_required/);
  await assert.rejects(invoke(valid, "apply_guide", { ...detail, revision: 1 }), /eligible_principle_reference_required/);
  const originalSearch = ledger.search;
  ledger.search = async () => ({ kind: "knowledge", principles: [{ ...guide, chain: { ...guide.chain, chainId: "late-guide" } }], chains: [], observations: [] });
  await invoke(valid, "recall_guide", { query: "branch-kit later principle" });
  assert.deepEqual(valid.checkpoint().applicationGuides, [{ chainId: "guide", revision: 2, kind: "principle" }]);
  await assert.rejects(invoke(valid, "apply_guide", { ...detail, chainId: "late-guide" }), /eligible_principle_reference_required/);
  ledger.search = originalSearch;
  const inspected = ledger.inspect;
  ledger.inspect = async () => ({ ...guide, requiresReview: true });
  await assert.rejects(invoke(valid, "apply_guide", detail), /stale_guide_revision/);
  ledger.inspect = inspected;
  await assert.rejects(invoke(valid, "apply_guide", { ...detail, steps: [{ ...detail.steps[0], quote: "Invented guidance absent from the stored principle" }, detail.steps[1]] }), /exact_guide_steps_and_current_evidence_required/);
  assert.equal(writes, 0);
  await invoke(valid, "apply_guide", detail);
  assert.equal(writes, 1);
  assert.equal(valid.application.steps, 2);
  const applied = toolDetails.filter(detail => detail.tool === "apply_guide");
  assert.ok(applied.every(detail => Number.isInteger(detail.arguments.revision)));
  assert.ok(applied.every(detail => !Object.hasOwn(detail.arguments, "steps")), "source quotations remain outside tool telemetry");
});

test("knowledge evaluation is explicit and refuses missing server capabilities before writes", async () => {
  let writes = 0;
  const driver = { realProcess: true, configuration: { retrieval: "keyword" }, capabilities: {},
    async call() { writes += 1; throw new Error("must_not_write"); } };
  const report = await runValidation({ driver, selected: ["knowledge_workflow"], plan: generateScenarios({ sizes: [3] }) });
  assert.equal(report.categories.knowledge_workflow.status, "error");
  assert.equal(report.categories.knowledge_workflow.reason, "knowledge_schema_required");
  assert.equal(writes, 0);
  assert.ok(!categories.includes("knowledge_workflow"), "old default runs must not silently require new knowledge schemas");
});

test("knowledge benchmark formation is independently enabled and recorded without exposing credentials", () => {
  const environment = { MINDLEAK_TEST_DATABASE_URL: "postgresql://localhost/knowledge_test",
    MINDLEAK_LLM_URL: "http://127.0.0.1:11434/v1", MINDLEAK_MODEL: "test-former", MINDLEAK_LLM_API_KEY: "private-synthetic-key" };
  const settings = benchmarkSettings(environment, { formation: "openai", "formation-reasoning-effort": "none" });
  assert.equal(settings.serverEnvironment.MINDLEAK_FORMATION, "openai");
  assert.equal(settings.serverEnvironment.MINDLEAK_DECOMPOSITION, "sentences");
  assert.equal(settings.configuration.formationModel, "test-former");
  assert.equal(settings.serverEnvironment.MINDLEAK_LLM_REASONING_EFFORT, "none");
  assert.ok(!JSON.stringify(settings.configuration).includes("private-synthetic-key"));
  assert.throws(() => benchmarkSettings(environment, { formation: "automatic" }));
  assert.throws(() => benchmarkSettings({ MINDLEAK_TEST_DATABASE_URL: environment.MINDLEAK_TEST_DATABASE_URL }, { formation: "openai" }));
  assert.equal(benchmarkSettings(environment).configuration.formation, undefined, "old benchmark configuration identity remains unchanged");
});

test("knowledge evaluation credits only checked lineage and retains safe failed timing", () => {
  const childId = randomUUID();
  const principleId = randomUUID();
  const document = { kind: "chain", claim: "Measured claim", conclusion: "Only this workload", applicability: "A controlled workload", assumptions: [], evidence: [], supportedBy: [] };
  const principle = { ...document, kind: "principle", supportedBy: [{ chainId: childId, revision: 2, reason: "Measured support" }] };
  const known = new Map([[childId, { id: "child", document }], [principleId, { id: "principle", document: principle }]]);
  const data = { kind: "knowledge", principles: [{ chain: { chainId: principleId, snapshot: { state: "accepted", document: principle } },
    requiresReview: false, score: 0.9, evidenceDetailsTruncated: false,
    supportingChains: [{ reference: { chainId: childId, revision: 2 }, document, state: "accepted", requiresReview: false }] }], chains: [], observations: [] };
  const measured = scoreKnowledgeResponse(data, known, ["principle", "child"]);
  assert.equal(measured.recallAtK, 0.5, "top-level recall must not silently credit nested records");
  assert.equal(measured.evidenceBundleRecall, 1);
  data.principles[0].supportingChains[0].document = { ...document, conclusion: "Applies everywhere" };
  assert.throws(() => scoreKnowledgeResponse(data, known, ["principle", "child"]));
  const error = Object.assign(new Error("private-provider-text"), { code: "provider_request_failed", elapsedMs: 120001 });
  const failure = knowledgeFailure(error);
  assert.equal(failure.reason, "provider_request_failed");
  assert.equal(failure.elapsedMs, 120001);
  assert.ok(!JSON.stringify(failure).includes("private-provider-text"));
  assert.equal(knowledgeFailure(new Error("anything")).reason, "formation_failed_not_abstention");
});

test("validation precision distinguishes returned evidence from empty and duplicate slots", () => {
  const result = retrievalMetrics(["right", "wrong", "right"], ["right"]);
  assert.equal(result.precisionAmongReturned, 1 / 3);
  assert.equal(result.precisionAtK, 1 / 5);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.falsePositiveResults, 2);
  assert.equal(retrievalMetrics([], ["right"]).precisionAmongReturned, null);
  assert.equal(retrievalMetrics([], []).noAnswerCorrect, true);
  assert.equal(retrievalMetrics(["wrong"], []).noAnswerCorrect, false);
});

test("structured agent rubrics never accept a keyword inside an incorrect answer", () => {
  assert.equal(evaluateAnswer({ language: "not Rust" }, { language: ["rust"] }).success, false);
  assert.equal(evaluateAnswer({ language: "Rust" }, { language: ["rust"] }).success, true);
  assert.equal(evaluateAnswer(null, { language: ["rust"] }).success, false);
  assert.equal(evaluateAnswer({ port: "4817" }, { port: [4817] }).success, false);
});

test("scenario answer schemas reveal structure but never expected values", () => {
  const plan = generateScenarios();
  for (const [category, scenario] of Object.entries(plan.scenarios)) {
    if (!scenario.task) continue;
    const schema = answerSchemaFor(category);
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, Object.keys(schema.properties));
    assert.ok(!JSON.stringify(schema).includes("enum"));
    assert.ok(!JSON.stringify(schema).includes("Rust"));
    assert.ok(!JSON.stringify(schema).includes("4817"));
  }
  const environment = { MINDLEAK_VALIDATION_AGENT_URL: "http://127.0.0.1:11434/v1", MINDLEAK_VALIDATION_AGENT_MODEL: "test" };
  assert.equal(agentSettings(environment).maxOutputTokens, 4096);
  for (const maxOutputTokens of [0, 16385, 1.5]) assert.throws(() => agentSettings(environment, { maxOutputTokens }));
  assert.throws(() => agentSettings(environment, { reasoningEffort: "guess" }));
});

test("paired savings require both tasks correct and actual comparable measurements", () => {
  const baseline = { success: true, elapsedMs: 100, fileSearches: 10, inputTokens: null };
  assert.equal(pairedMetrics(baseline, { success: true, elapsedMs: 40 }, { memoryExposed: true, preparationReady: true }).completionTimeReductionPercent, 60);
  const failed = pairedMetrics(baseline, { success: false, elapsedMs: 1 });
  assert.equal(failed.errorAmplified, true);
  assert.equal(failed.completionTimeReductionPercent, null);
  assert.equal(pairedMetrics(baseline, { success: true, inputTokens: 12 }).inputTokenReductionPercent, null);
});

test("memory savings require observed exposure and verified preparation", () => {
  const baseline = { status: "completed", success: true, elapsedMs: 100, inputTokens: 100 };
  const memory = { status: "completed", success: true, elapsedMs: 25, inputTokens: 25 };
  assert.equal(pairedMetrics(baseline, memory, { memoryExposed: false, preparationReady: true }).inputTokenReductionPercent, null);
  assert.equal(pairedMetrics(baseline, memory, { memoryExposed: true, preparationReady: false }).completionTimeReductionPercent, null);
  const verified = pairedMetrics(baseline, memory, { memoryExposed: true, preparationReady: true });
  assert.equal(verified.completionTimeReductionPercent, 75);
  assert.equal(verified.eligibleForMemorySavings, true);
});

test("scale charts are JSON data specifications and coding scenarios have immutable checks", () => {
  const points = [{ factsStored: 100, recall: 0.7, p95Ms: 8 }];
  assert.deepEqual(scaleCharts(points).factsVsAccuracy.data.values, points);
  assert.equal(scaleCharts(points).factsVsLatency.encoding.y.field, "p95Ms");
  for (const kind of ["coding_workflow", "rediscovery_demo"]) {
    const fixture = codingFixture(kind);
    assert.equal(fixture.testCount, 3);
    assert.ok(!fixture.editable.some(path => path.startsWith("tests/")));
  }
});

test("coding workspace confines reads and edits and never executes code on the host", async () => {
  const workspace = await createCodingWorkspace("coding_workflow", null);
  try {
    assert.match(await workspace.read("README.md"), /domain-driven/);
    assert.ok((await workspace.search("repository")).length > 0);
    for (const path of ["../secret", "/etc/passwd", "tests/workflow.test.mjs"]) {
      await assert.rejects(workspace.write(path, "tamper"));
    }
    await assert.rejects(workspace.read("../secret"));
    await assert.rejects(workspace.test(), /explicit_container/);
    await workspace.write("src/api/customers.mjs", "export const value = 1;");
    assert.match(await workspace.read("src/api/customers.mjs"), /value = 1/);
  } finally { await workspace.close(); }
});

test("swarm project has five non-overlapping owners and bundled immutable DOM tests", async () => {
  const fixture = swarmFixture();
  assert.equal(swarmRoles.length, 5);
  assert.equal(new Set(swarmRoles.flatMap(role => role.editable)).size, fixture.editable.length);
  assert.equal(Object.values(fixture.testGroups).reduce((total, count) => total + count, 0), fixture.testCount);
  const workspace = await createCodingWorkspace("swarm", null, fixture);
  try {
    const tests = await workspace.read("tests/workflow.test.mjs");
    assert.ok(tests.includes("app/expiry"));
    assert.ok(tests.includes(".status-badge"), "immutable view checks must cover the required status badge");
    assert.ok(!tests.includes("from 'linkedom'"), "the DOM library must be bundled for network-disabled tests");
    await assert.rejects(workspace.write("tests/workflow.test.mjs", "tampered"));
    await workspace.write("src/expiry.mjs", "export const marker = true;");
    assert.equal(await workspace.read("src/expiry.mjs"), "export const marker = true;");
  } finally { await workspace.close(); }
});

test("swarm project executes required status-badge checks", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const fixture = swarmFixture();
  const workspace = await createCodingWorkspace("swarm", await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE), fixture);
  try {
    for (const badge of ["missing", "empty", "present"]) {
      await workspace.write("src/view.mjs", `const badgeMode = ${JSON.stringify(badge)};
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
export function renderSessions(sessions, nowMs) {
  if (!sessions.length) return '<p class="empty-state">No sessions</p>';
  return sessions.map(session => {
    const state = nowMs >= session.expiresAt ? 'expired' : 'active';
    const badge = badgeMode === 'missing' ? '' : '<span class="status-badge">' + (badgeMode === 'empty' ? '' : state) + '</span>';
    return '<div class="session-card" data-state="' + state + '"><span class="session-label">' + escape(session.label)
      + '</span><span class="remaining">' + Math.max(0, Math.ceil((session.expiresAt - nowMs) / 1000)) + '</span>' + badge
      + '<button type="button" data-remove="' + escape(session.id) + '">Remove</button></div>';
  }).join('');
}`);
      const result = await workspace.test("view");
      assert.equal(result.tests, 3);
      assert.equal(result.passed, badge === "present");
      assert.deepEqual(result.failedTests, badge === "present" ? [] : ["view/structure", "view/escaping"]);
    }
  } finally { await workspace.close(); }
});

test("swarm owners cannot edit another module and edits invalidate verification", async () => {
  const changes = [];
  const shared = { async write(path) { changes.push(path); }, async test(group) { return { passed: true, group }; } };
  const owned = ownedBuildWorkspace(shared, swarmRoles[0]);
  await assert.rejects(owned.write("src/app.mjs", "tampered"), /fixture_edit_not_allowed/);
  assert.equal(changes.length, 0);
  assert.equal((await owned.test()).group, "expiry");
  assert.equal(owned.lastTests.passed, true);
  await owned.write("src/expiry.mjs", "changed");
  assert.equal(owned.lastTests, null);
});

test("Lab 2 live reuse requires a matching verified application receipt", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const application = { type: "guide_applied", agent: "nova", caseId: "current-case", atMs: 20,
    memoryId: "application-receipt", chainId: "guide", revision: 2, steps: 2, sourceObservations: 2 };
  const assessment = { type: "assessment_finished", agent: "nova", condition: "withMemory", caseId: "current-case",
    atMs: 30, passed: true, guideApplied: true };
  const metrics = events => knowledgeMetrics({ kind: "memory_lab", status: "recording", events });
  assert.equal(metrics([application, assessment]).reuse.tasks, 1);
  assert.equal(metrics([application, assessment]).reuse.rate, 1);
  assert.equal(metrics([assessment]).reuse.tasks, 0, "a declared application without a saved receipt is not use");
  assert.equal(metrics([{ ...application, caseId: "another-case" }, assessment]).reuse.tasks, 0);
  assert.equal(metrics([{ ...application, sourceObservations: 1 }, assessment]).reuse.tasks, 0);
  assert.equal(metrics([assessment, { ...application, atMs: 40 }]).reuse.tasks, 0, "a future receipt must not change an earlier assessment");
  assert.equal(metrics([application, { ...assessment, condition: "withoutMemory" }]).reuse.tasks, 0);
  const recording = normalizeRecording({ kind: "memory_lab", runId: "live-source-application", status: "recording", elapsedMs: 30,
    agents: [{ id: "nova", name: "Nova" }], events: [application, assessment] });
  assert.equal(replayState(recording, 19).agents.nova.linkedUses.size, 0);
  assert.equal(replayState(recording, 30).agents.nova.linkedUses.size, 1);
  assert.equal(replayState(recording, 30).agents.nova.useMeasured, true);
});

test("Lab 2 live evaluation counts checked source links without writing memory", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const event = { type: "control_arm_finished", agent: "nova", condition: "withMemory", caseId: "evaluation-case", round: 1,
    atMs: 30, passed: true, guideApplied: true, guideRetrievedBeforeAssessment: true, sourceEvidenceVerified: true,
    sourceObservationsRead: 1, guideUsed: { chainId: "frozen-guide", revision: 2 } };
  const report = events => ({ kind: "memory_lab", status: "recording", runId: "live-frozen-use", elapsedMs: 30,
    agents: [{ id: "nova", name: "Nova" }], events });
  assert.equal(knowledgeMetrics(report([event])).reuse.tasks, 1);
  assert.equal(knowledgeMetrics(report([{ ...event, sourceEvidenceVerified: false }])).reuse.tasks, 0);
  assert.equal(knowledgeMetrics(report([{ ...event, sourceObservationsRead: 0 }])).reuse.tasks, 0);
  assert.equal(knowledgeMetrics(report([{ ...event, guideRetrievedBeforeAssessment: false }])).reuse.tasks, 0);
  assert.equal(knowledgeMetrics(report([{ ...event, passed: false }])).reuse.tasks, 0);
  assert.equal(replayState(normalizeRecording(report([event])), 30).agents.nova.linkedUses.size, 1);
});

test("memory-enabled agent tools require prior knowledge before edits", async () => {
  const mutations = [];
  const memory = scopedMemory(memoryDouble(), `startup-${randomUUID()}`, "startup-agent");
  const source = "export const ttlUnit = 'seconds';";
  const workspace = { editablePaths: ["src/component.mjs"],
    async read() { return source; },
    async write(path) { mutations.push(path); return { written: true }; } };
  const tools = agentTools(memory, workspace);
  const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
  const edit = () => invoke("write_file", { path: "src/component.mjs", content: "checked implementation" });
  await assert.rejects(edit(), /prior_experience_search_required/);
  assert.deepEqual(mutations, [], "unchecked edits must not reach the workspace");
  const receipt = await memory.write("Session Desk expiry uses milliseconds for timestamps and seconds for TTL.");
  await invoke("recall_memory", { query: "Session Desk" });
  await assert.rejects(edit(), /experience_assessment_required/);
  const decision = { decision: "apply", lessonId: receipt.fragments[0].fragmentId,
    reason: "The current module explicitly uses seconds for the lifetime input.", evidence: { path: "src/component.mjs", quote: source } };
  await assert.rejects(invoke("assess_experience", { ...decision, lessonId: randomUUID() }), /delivered_experience_required/);
  await assert.rejects(invoke("assess_experience", decision), /inspected_source_evidence_required/);
  await invoke("inspect_source", { fragmentId: decision.lessonId });
  await assert.rejects(invoke("assess_experience", decision), /current_source_evidence_required/);
  await invoke("read_file", { path: "src/component.mjs" });
  assert.equal((await invoke("assess_experience", decision)).recorded, true);
  await edit();
  assert.equal(mutations.length, 1);
  assert.equal(memory.observations.knowledgeWorkflow.assessment.lessonId, decision.lessonId);
  await invoke("recall_memory", { query: "Session Desk" });
  await assert.rejects(edit(), /experience_assessment_required/, "new retrieval invalidates the prior applicability decision");
  const fresh = agentTools(memory, workspace);
  await assert.rejects(fresh.find(tool => tool.definition.function.name === "write_file")
    .invoke({ path: "src/component.mjs", content: "new session without a lookup" }), /prior_experience_search_required/);
  assert.equal(mutations.length, 1, "another session cannot borrow the earlier session's startup check");
});

test("memory startup permits local work after a recorded miss or unavailable lookup", async () => {
  for (const failure of [false, true]) {
    const driver = memoryDouble(); const call = driver.call.bind(driver);
    driver.call = async (name, args) => {
      if (failure && name === "recall_memory") throw new Error("test_memory_unavailable");
      return call(name, args);
    };
    const memory = scopedMemory(driver, `startup-${randomUUID()}`, "startup-agent");
    const source = "export const ttlUnit = 'seconds';";
    let changes = 0;
    const workspace = { editablePaths: ["src/component.mjs"], async read() { return source; },
      async write() { changes += 1; return { written: true }; } };
    const tools = agentTools(memory, workspace);
    const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
    const decision = { decision: failure ? "unavailable" : "no_match", lessonId: null,
      reason: "Use the checked local contract because the lookup delivered no prior source.", evidence: { path: "src/component.mjs", quote: source } };
    await assert.rejects(invoke("assess_experience", decision), /prior_experience_search_required/);
    await invoke("read_file", { path: "src/component.mjs" });
    if (failure) await assert.rejects(invoke("recall_memory", { query: "Session Desk" }), /test_memory_unavailable/);
    else assert.equal((await invoke("recall_memory", { query: "Session Desk" })).results.length, 0);
    await assert.rejects(invoke("assess_experience", { ...decision, decision: failure ? "no_match" : "unavailable" }), /lookup_outcome_mismatch/);
    await invoke("assess_experience", decision);
    await invoke("write_file", { path: "src/component.mjs", content: "local implementation" });
    assert.equal(changes, 1);
  }
});

test("Lab 2 downstream investigations check prior knowledge before verification", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases, assessPackage } = await import("./memory-lab-fixture.mjs");
  const specification = packageCases()[2];
  const answer = { ...assessPackage(specification), evidencePaths: specification.evidencePaths };
  for (const condition of ["withMemory", "withoutMemory"]) {
    const session = investigatorTools({ actor: "nova", specification, condition, index: 2,
      ledger: { nodes: new Map(), observations: [] }, emit: () => {} });
    const invoke = (name, args = {}) => session.tools.find(tool => tool.definition.function.name === name).invoke(args);
    for (const path of specification.evidencePaths) await invoke("read_file", { path });
    if (condition === "withMemory") await assert.rejects(invoke("verify_assessment", answer), /prior_experience_search_required/);
    else assert.equal((await invoke("verify_assessment", answer)).passed, true);
  }
  const frozen = investigatorTools({ actor: "nova", specification, condition: "withMemory", index: 0, memoryEnabled: false,
    ledger: { nodes: new Map(), observations: [] }, emit: () => {},
    beforeAssessment() { throw new Error("prior_experience_search_required"); } });
  const verify = frozen.tools.find(tool => tool.definition.function.name === "verify_assessment");
  await assert.rejects(verify.invoke(answer), /prior_experience_search_required/, "read-only comparison tools must enforce their frozen-knowledge startup gate");
});

test("Lab 2 guide synthesis reviews original sources once before choosing an outcome", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases } = await import("./memory-lab-fixture.mjs");
  const observations = ["first", "second"].map(id => ({ memoryId: `memory-${id}`, actor: id,
    fragments: [{ fragmentId: `fragment-${id}`, text: `Verified ${id} source` }], rawText: `Verified ${id} source with its original conditions.` }));
  const chains = observations.map((source, index) => ({ chainId: `case-${index}`, revision: 2, actor: source.actor, state: "accepted", review: "reviewed",
    document: { kind: "chain", claim: `Branch-kit case ${index}`, evidence: [{ fragmentId: source.fragments[0].fragmentId, role: "supports", reason: "Original source." }], supportedBy: [] } }));
  const principle = { chainId: "existing-guide", revision: 2, actor: "iris", state: "accepted", review: "reviewed",
    document: { kind: "principle", claim: "Branch-kit current compatibility must be inspected", conclusion: "Inspect the current return shape before selecting the caller adaptation.",
      evidence: [], supportedBy: chains.map(chain => ({ chainId: chain.chainId, revision: chain.revision, reason: "Verified separate case." })) } };
  let catalogueReads = 0; let sourceReads = 0;
  const events = [];
  const record = node => ({ chain: { chainId: node.chainId, revision: node.revision, snapshot: { state: node.state, document: node.document } }, requiresReview: false, supportingChains: [] });
  const ledger = { observations, nodes: new Map([...chains, principle].map(node => [node.chainId, node])), guideId: principle.chainId,
    async guideSources() { catalogueReads += 1; return { kind: "knowledge", principles: [record(principle)], chains: chains.map(record), observations: [] }; },
    async inspectObservation(fragmentId) { sourceReads += 1; const source = observations.find(source => source.fragments.some(fragment => fragment.fragmentId === fragmentId));
      return { memoryId: source.memoryId, fragmentId, actor: source.actor, rawText: source.rawText, text: source.fragments[0].text }; } };
  const session = investigatorTools({ actor: "nova", specification: packageCases()[2], ledger, condition: "withMemory", index: 2,
    stage: "guide", priorAssessment: { verification: { passed: true }, answer: { recommendation: "upgrade" } }, emit: event => events.push(event) });
  const tools = new Map(session.tools.map(entry => [entry.definition.function.name, entry]));
  const invoke = (name, args = {}) => tools.get(name).invoke(args);
  assert.ok(!tools.has("recall_guide") && !tools.has("inspect_knowledge") && !tools.has("inspect_observation"), "guide synthesis must not expose redundant read loops");
  assert.ok(session.checkpoint().nextActions.includes("inspect_guide_sources"));
  await assert.rejects(invoke("skip_learning", { reason: "Existing principles already cover this verified evidence." }), /guide_review_required/);
  const dossier = await invoke("inspect_guide_sources");
  assert.equal(dossier.view, "synthesis-dossier");
  assert.deepEqual(dossier.observations.map(source => source.rawText), observations.map(source => source.rawText));
  assert.equal(dossier.principles[0].chain.chainId, principle.chainId);
  assert.equal(session.checkpoint().synthesis.phase, "decision");
  assert.ok(session.checkpoint().decisionOptions.includes("skip_learning"));
  const repeated = await invoke("inspect_guide_sources");
  assert.equal(repeated.alreadyReviewed, true);
  assert.equal(repeated.reviewId, dossier.reviewId);
  assert.equal(catalogueReads, 1);
  assert.equal(sourceReads, 2);
  assert.equal(session.memoryReads.length, 1, "a repeat checkpoint is not a second retrieval");
  assert.equal(events.filter(event => event.type === "guide_review_ready").length, 1);
  assert.ok(!JSON.stringify(repeated).includes(observations[0].rawText));
  assert.equal(typeof session.prepareSynthesis, "function");
  const prepared = await session.prepareSynthesis();
  assert.deepEqual(prepared.tools.map(tool => tool.definition.function.name), ["propose_guide", "accept_knowledge", "skip_learning"]);
  assert.equal(JSON.parse(prepared.context).reviewId, dossier.reviewId);
  assert.equal(JSON.parse(prepared.context).observations.length, 2);
  assert.equal(catalogueReads, 1, "preparing the decision request must reuse the checked packet");
  assert.equal((await invoke("skip_learning", { reason: "The inspected current principle already requires checking return shapes; this case adds no new rule." })).outcome, "no_new_learning");
  assert.equal(session.checkpoint().ready, true);
  principle.revision += 1;
  assert.equal(session.checkpoint().ready, false, "a changed catalogue invalidates the completed decision checkpoint");
  await assert.rejects(invoke("skip_learning", { reason: "Reuse a now-stale review without fetching its revision." }), /guide_review_changed/);
  const fresh = () => investigatorTools({ actor: "nova", specification: packageCases()[2], ledger, condition: "withMemory", index: 2,
    stage: "guide", priorAssessment: { verification: { passed: true } }, emit: () => {} });
  const unsafe = fresh();
  ledger.guideSources = async () => ({ kind: "knowledge", principles: [{ ...record(principle), requiresReview: true }], chains: chains.map(record), observations: [] });
  await unsafe.tools.find(tool => tool.definition.function.name === "inspect_guide_sources").invoke({});
  await assert.rejects(unsafe.tools.find(tool => tool.definition.function.name === "skip_learning")
    .invoke({ reason: "The challenged principle should not justify skipping review." }), /inspect_existing_principles_first/);
  observations[0].rawText = "source detail ".repeat(6000);
  const oversized = fresh();
  await assert.rejects(oversized.tools.find(tool => tool.definition.function.name === "inspect_guide_sources").invoke({}), /guide_review_budget/);
  assert.equal(oversized.sourceObservations.size, 0, "undelivered evidence does not count as reviewed");
  assert.equal(oversized.checkpoint().synthesis.phase, "review");
  await assert.rejects(oversized.tools.find(tool => tool.definition.function.name === "skip_learning")
    .invoke({ reason: "Missing evidence cannot be declared equivalent." }), /guide_review_required/);
});

test("Lab 2 synthesis runner preserves review failures cancellation and model refusal", async () => {
  const { runGuideSynthesis } = await import("./memory-lab.mjs");
  let modelCalls = 0;
  const agent = { async run(task, tools, context, schema, options) {
    modelCalls += 1;
    assert.equal(context, "reviewed-source-dossier");
    assert.equal(tools.length, 1);
    assert.equal(options.signal, undefined);
    return { status: "completed", answer: { completed: false }, inputTokens: 12, outputTokens: 3, elapsedMs: 1, trace: [], responses: [], toolCalls: 0 };
  } };
  const failed = await runGuideSynthesis({ agent, task: "Synthetic guide decision", author: {
    async prepareSynthesis() { throw new Error("guide_review_budget"); },
  } });
  assert.equal(failed.status, "incomplete");
  assert.equal(failed.failure.code, "guide_review_budget");
  assert.equal(failed.inputTokens, 0);
  assert.equal(modelCalls, 0);
  const cancelled = await runGuideSynthesis({ agent, task: "Synthetic guide decision", signal: AbortSignal.abort(), author: {
    async prepareSynthesis() { throw new Error("cancelled review must not read storage"); },
  } });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(modelCalls, 0);
  const refused = await runGuideSynthesis({ agent, task: "Synthetic guide decision", author: {
    async prepareSynthesis() { return { context: "reviewed-source-dossier", tools: [{ name: "skip_learning" }] }; },
  } });
  assert.equal(refused.answer.completed, false, "the runner cannot manufacture a completed synthesis decision");
  assert.equal(refused.inputTokens, 12);
  assert.equal(modelCalls, 1);
  assert.ok(Number.isFinite(refused.synthesisReviewMs));
});

test("Lab 2 guide retries expose exact pending acceptance actions", async () => {
  const { investigatorTools } = await import("./memory-lab.mjs");
  const { packageCases } = await import("./memory-lab-fixture.mjs");
  const pending = { chainId: "pending-principle", actor: "nova", state: "candidate", revision: 3,
    document: { kind: "principle", claim: "Branch-kit caller contracts need verification." } };
  const session = investigatorTools({ actor: "nova", specification: packageCases()[2], condition: "withMemory", index: 2,
    stage: "guide", priorAssessment: { verification: { passed: true } },
    ledger: { nodes: new Map([[pending.chainId, pending]]), observations: [] }, emit: () => {} });
  const checkpoint = session.checkpoint();
  assert.equal(checkpoint.ready, false);
  assert.deepEqual(checkpoint.nextActions, ["inspect_guide_sources", "accept_knowledge"]);
  assert.deepEqual(checkpoint.pendingAcceptances, [{ chainId: pending.chainId, expectedRevision: 3 }]);
});

test("swarm build records five verified owners, real handoffs and measured usage", async () => {
  const driver = memoryDouble();
  const fixed = new Set();
  let closed = false;
  let active = 0;
  let peak = 0;
  const events = [];
  const fixture = swarmFixture();
  const workspace = { editablePaths: fixture.editable, async list() { return Object.keys(fixture.files); },
    async read(path) { return fixture.files[path]; }, async search() { return []; },
    async write(path) { fixed.add(path); return { written: true }; },
    async test(group = null) {
      const expectedTests = group ? fixture.testGroups[group] : fixture.testCount;
      const passed = group ? swarmRoles.find(role => role.group === group).editable.every(path => fixed.has(path))
        : fixture.editable.every(path => fixed.has(path));
      return { passed, expectedTests, tests: expectedTests, passedTests: passed ? expectedTests : 0, sourceSha256: digest([...fixed]) };
    }, async close() { closed = true; } };
  const agent = { configuration: { model: "test-double" }, async run(task, tools, context, schema, { onEvent }) {
    active += 1; peak = Math.max(peak, active);
    const get = name => tools.find(tool => tool.definition.function.name === name);
    const role = swarmRoles.find(candidate => task.startsWith(`You are ${candidate.name},`));
    assert.ok(role);
    assert.ok(role.dependencies.every(id => swarmRoles.find(candidate => candidate.id === id).editable.every(path => fixed.has(path))));
    assert.equal(context, "");
    assert.equal(get("write_file").definition.function.parameters.properties.path.enum.join(), role.editable.join());
    await assert.rejects(get("write_memory").invoke({ text: "Session Desk unverified" }), /component_tests_required/);
    if (role.dependencies.length) {
      await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "before-handoff" }), /dependency_handoffs_required/);
      await get("recall_memory").invoke({ query: "Session Desk" });
      await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "search-excerpt-only" }), /dependency_handoffs_required/);
      const sources = JSON.parse(task.split("\n").find(line => line.startsWith("Dependency handoff sources: ")).slice("Dependency handoff sources: ".length));
      await get("inspect_source").invoke({ fragmentId: sources[0].fragmentId });
      if (sources.length > 1) await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "partial-handoff" }), /dependency_handoffs_required/);
      for (const source of sources.slice(1)) await get("inspect_source").invoke({ fragmentId: source.fragmentId });
      await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "handoffs-without-current-code" }), /dependency_source_files_required/);
      for (const source of sources) for (const path of source.modulePaths) await get("read_file").invoke({ path });
      if (role.id === "orion") {
        const path = sources[0].modulePaths[0]; const original = fixture.files[path];
        try {
          fixture.files[path] = `${original}\nchanged after publication`;
          await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "stale-dependency" }), /dependency_source_files_required/);
          await get("read_file").invoke({ path });
          await assert.rejects(get("write_file").invoke({ path: role.editable[0], content: "unverified-new-dependency" }), /dependency_source_files_required/);
        } finally { fixture.files[path] = original; }
        await get("read_file").invoke({ path });
      }
      const stub = await get("read_file").invoke({ path: role.editable[0] });
      await assert.rejects(get("assess_experience").invoke({ decision: "apply", lessonId: sources[0].fragmentId,
        reason: "The dependency is assumed to apply because my own implementation is still pending.",
        evidence: { path: role.editable[0], quote: stub.slice(0, 256) } }), /dependency_source_evidence_required/);
    }
    const evidencePath = swarmRoles.find(candidate => candidate.id === role.dependencies[0])?.editable[0] ?? role.editable[0];
    await assessPriorKnowledge((name, args) => get(name).invoke(args), evidencePath);
    for (const path of role.editable) await get("write_file").invoke({ path, content: "verified-test-double-source" });
    await get("run_tests").invoke({});
    await get("write_memory").invoke({ text: `Session Desk ${role.title} in ${role.editable.join(", ")} passed its component tests.` });
    const sessionId = randomUUID();
    onEvent({ type: "inference_finished", sessionId, turn: 1, inputTokens: 100, outputTokens: 20, startedMs: 0, elapsedMs: 1 });
    active -= 1;
    return { sessionId, status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 20, toolCalls: 4, elapsedMs: 2 };
  } };
  const report = await runSwarmBuild({ driver, agent, code: { engine: "test-double", image: "unit" },
    workspaceFactory: async () => workspace, applicationBuilder: async () => ({ html: "<html></html>", sha256: "fixture" }), onEvent: event => events.push(event) });
  assert.equal(report.status, "completed");
  assert.equal(report.memoryPolicy, "knowledge-first-handoff-v5");
  assert.equal(report.collaboration.priorKnowledgeChecked, 5);
  assert.equal(report.collaboration.priorKnowledgeAssessed, 5);
  assert.equal(report.collaboration.publishedComponents, 5);
  assert.equal(report.collaboration.receivedDependencyHandoffs, 6);
  assert.equal(report.collaboration.checkedDependencySources, 6);
  assert.equal(report.collaboration.requiredDependencyHandoffs, 6);
  assert.equal(report.collaboration.completed, true);
  assert.equal(report.summary.agentsPassed, 5);
  assert.equal(report.agents.find(role => role.id === "atlas").attempts[0].memoryChecked, true);
  assert.equal(report.agents.find(role => role.id === "nova").attempts[0].memoryChecked, true, "direct source inspection is a real memory read");
  assert.equal(report.agents.find(role => role.id === "nova").attempts[0].dependencyMemoryReceived, true);
  assert.equal(report.summary.inputTokens, 500);
  assert.equal(report.summary.outputTokens, 100);
  assert.ok(report.summary.crossAgentHandoffs >= 3);
  assert.equal(report.finalTests.passedTests, 18);
  assert.equal(report.memoryExhibits.length, 6);
  assert.ok(report.memoryExhibits.some(exhibit => exhibit.agent === "atlas" && exhibit.fragments.some(fragment => fragment.text.includes("Time Engine"))));
  assert.ok(!JSON.stringify(report.events).includes("Session Desk Time Engine"));
  assert.ok(peak >= 2 && peak <= 2);
  assert.equal(closed, true);
  assert.deepEqual(report.events, events);
  assert.ok(!JSON.stringify(report).includes("verified-test-double-source"));
  const counted = replayState(normalizeRecording(report), report.elapsedMs);
  assert.equal(counted.inputTokens, report.summary.inputTokens);
  assert.equal(counted.outputTokens, report.summary.outputTokens);
  assert.equal(counted.checks, 18);
});

test("Lab 1 Daleks build an isolated matched project without any MindLeak capability", async () => {
  const { runSwarmComparison } = await import("./swarm-runner.mjs");
  const fixture = swarmFixture();
  const workspaces = [];
  const workspaceFactory = async () => {
    const files = { ...fixture.files }; const fixed = new Set();
    const workspace = { files, fixed, closed: false, editablePaths: fixture.editable,
      async list() { return Object.keys(files); }, async read(path) { return files[path]; }, async search() { return []; },
      async write(path, content) { files[path] = content; fixed.add(path); return { written: true }; },
      async test(group = null) {
        const expectedTests = group ? fixture.testGroups[group] : fixture.testCount;
        const paths = group ? swarmRoles.find(role => role.group === group).editable : fixture.editable;
        const passed = paths.every(path => fixed.has(path));
        return { passed, tests: expectedTests, expectedTests, passedTests: passed ? expectedTests : 0, sourceSha256: digest(files) };
      }, async close() { workspace.closed = true; } };
    workspaces.push(workspace); return workspace;
  };
  const sessions = [];
  const actors = Object.fromEntries(swarmRoles.map((role, index) => [role.id, { configuration: { model: `matched-model-${index}`, maxSteps: 20, timeoutMs: 300000 },
    async run(task, tools, context, schema, { onEvent }) {
      assert.equal(context, "");
      const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
      const invoke = (name, args = {}) => entries.get(name).invoke(args);
      const memory = entries.has("write_memory");
      const expectedName = memory ? role.name : `Dalek ${index + 1}`;
      assert.ok(task.startsWith(`You are ${expectedName},`));
      assert.equal(entries.has("recall_memory"), memory);
      assert.equal(entries.has("inspect_source"), memory);
      if (!memory) assert.ok(![...entries.keys()].some(name => /memory|knowledge|guide|observation/.test(name)));
      assert.deepEqual(entries.get("write_file").definition.function.parameters.properties.path.enum, role.editable);
      for (const dependency of role.dependencies) for (const path of swarmRoles.find(other => other.id === dependency).editable) {
        assert.equal(await invoke("read_file", { path }), memory ? "memory-team-source" : "dalek-team-source");
      }
      if (memory && role.dependencies.length) await invoke("recall_memory", { query: "Session Desk" });
      if (memory && role.dependencies.length && workspaces.length > 2) {
        await assert.rejects(invoke("write_file", { path: role.editable[0], content: "stale-previous-run-handoff" }), /dependency_handoffs_required/);
      }
      if (memory) for (const source of JSON.parse(task.split("\n").find(line => line.startsWith("Dependency handoff sources: ")).slice("Dependency handoff sources: ".length))) {
        await invoke("inspect_source", { fragmentId: source.fragmentId });
      }
      if (memory) await assessPriorKnowledge(invoke, swarmRoles.find(candidate => candidate.id === role.dependencies[0])?.editable[0] ?? role.editable[0]);
      for (const path of role.editable) await invoke("write_file", { path, content: memory ? "memory-team-source" : "dalek-team-source" });
      await invoke("run_tests");
      if (memory) await invoke("write_memory", { text: `Session Desk ${role.title} in ${role.editable.join(", ")} has passed its fixed component tests.` });
      const sessionId = randomUUID(); sessions.push({ sessionId, memory });
      onEvent({ type: "inference_finished", workload: "agent", model: `matched-model-${index}`, sessionId, turn: 1, inputTokens: 100, outputTokens: 20, elapsedMs: 1 });
      return { sessionId, status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 20, toolCalls: 4, elapsedMs: 2 };
    } }]));
  const events = [];
    const driver = memoryDouble();
    const comparison = await runSwarmComparison({ driver, agentsByRole: actors, code: { engine: "test-double", image: "unit" },
    workspaceFactory, applicationBuilder: async workspace => ({ html: `<html>${await workspace.read("src/app.mjs")}</html>`, sha256: digest(await workspace.read("src/app.mjs")) }),
    onEvent: event => events.push(event) });
  assert.equal(comparison.status, "completed");
  assert.equal(comparison.agents.length, 10);
  assert.equal(comparison.agents.filter(actor => actor.control).length, 5);
  assert.equal(comparison.finalTests.passedTests, 36);
  assert.equal(comparison.finalTests.expectedTests, 36);
  assert.equal(comparison.summary.inputTokens, 1000);
  assert.equal(comparison.buildComparison.withoutMemory.memoriesStored, 0);
  assert.equal(comparison.buildComparison.withoutMemory.memoryAccess, "none");
  assert.ok(comparison.controlApplication.html.includes("dalek-team-source"));
  assert.ok(!comparison.application.html.includes("dalek-team-source"));
  assert.ok(workspaces.length === 2 && workspaces.every(workspace => workspace.closed));
  assert.equal(new Set(sessions.map(session => session.sessionId)).size, 10);
  assert.equal(comparison.events.length, events.length);
  assert.ok(!events.some(event => event.agent?.startsWith("dalek-") && /memory_saved|memory_delivered/.test(event.type)));
  const counted = replayState(normalizeRecording(comparison), comparison.elapsedMs);
  assert.equal(counted.checks, 36);
  assert.equal(counted.inputTokens, 1000);
  assert.ok(Object.entries(counted.agents).filter(([id]) => id.startsWith("dalek-")).every(([, actor]) => actor.inputTokens === 100));
  const continued = await runSwarmComparison({ driver, parent: comparison, agentsByRole: actors, code: { engine: "test-double", image: "unit" },
    workspaceFactory, applicationBuilder: async workspace => ({ html: `<html>${await workspace.read("src/app.mjs")}</html>`, sha256: digest(await workspace.read("src/app.mjs")) }) });
  assert.equal(continued.status, "completed");
  assert.equal(continued.scope, comparison.scope);
  assert.equal(continued.inheritedMemories, comparison.memoryExhibits.length);
  assert.ok(comparison.memoryExhibits.every(record => continued.memoryExhibits.some(current => current.memoryId === record.memoryId)),
    "continued sharing retains previously stored findings in the visible report");
  assert.equal(continued.memoryExhibits.length, comparison.memoryExhibits.length + 5);
  assert.equal(continued.buildComparison.withoutMemory.inheritedMemories, 0);
  assert.equal(continued.buildComparison.withoutMemory.memoryAccess, "none");
  assert.equal(workspaces.length, 4);
  assert.equal(new Set(sessions.map(session => session.sessionId)).size, 20);

  const forbiddenDriver = new Proxy({}, { get() { throw new Error("Daleks must never access a memory driver"); } });
  const isolated = await runSwarmBuild({ driver: forbiddenDriver, memoryEnabled: false, agentsByRole: actors,
    code: { engine: "test-double", image: "unit" }, workspaceFactory, applicationBuilder: async () => ({ html: "control", sha256: "control" }) });
  assert.equal(isolated.status, "completed");
  assert.equal(isolated.summary.memoriesStored, 0);
  const optionalActors = Object.fromEntries(swarmRoles.map(role => [role.id, { configuration: { model: "test-double" }, async run(task, tools) {
    const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
    await assessPriorKnowledge(invoke, role.editable[0]);
    for (const path of role.editable) await invoke("write_file", { path, content: "verified-without-memory-use" });
    await invoke("run_tests");
    return { status: "completed", sessionId: randomUUID(), inputTokens: 10, outputTokens: 1, toolCalls: 2, trace: [], responses: [] };
  } }]));
  const optional = await runSwarmBuild({ driver: memoryDouble(), agentsByRole: optionalActors, code: { engine: "test-double", image: "unit" },
    workspaceFactory, applicationBuilder: async () => ({ html: "verified", sha256: "verified" }) });
  assert.equal(optional.status, "partial", "passing component code cannot disguise a missing memory handoff");
  assert.equal(optional.summary.crossAgentHandoffs, 0);
  assert.equal(optional.collaboration.publishedComponents, 0);
  assert.equal(optional.collaboration.completed, false);
  assert.ok(optional.agents.filter(actor => !actor.dependencies.length).every(actor => actor.attempts.every(attempt => attempt.codePassed && !attempt.passed)));
  assert.ok(optional.agents.filter(actor => actor.dependencies.length).every(actor => actor.state === "blocked"));
});

test("Lab 1 cannot complete collaboration with a failed or invalidated publication", async () => {
  for (const mode of ["edit_after_publication", "publication_failed"]) {
    const fixture = swarmFixture(); const files = { ...fixture.files }; const fixed = new Set(); const driver = memoryDouble();
    const monitored = { ...driver, async call(name, args) {
      if (mode === "publication_failed" && name === "write_memory" && args.agentId.endsWith("-atlas")) throw new Error("test_publication_failed");
      return driver.call(name, args);
    } };
    const report = await runSwarmBuild({ driver: monitored, code: { engine: "test-double", image: "unit" }, maxAttempts: 1,
      workspaceFactory: async () => ({ editablePaths: fixture.editable, async list() { return Object.keys(files); }, async read(path) { return files[path]; },
        async search() { return []; }, async write(path, content) { files[path] = content; fixed.add(path); return { written: true }; },
        async test(group) { const expectedTests = group ? fixture.testGroups[group] : fixture.testCount;
          const paths = group ? swarmRoles.find(role => role.group === group).editable : fixture.editable;
          const passed = paths.every(path => fixed.has(path));
          return { passed, tests: expectedTests, expectedTests, passedTests: passed ? expectedTests : 0, sourceSha256: digest(files) };
        }, async close() {} }),
      agent: { configuration: { provider: "test", model: "test-double" }, async run(task, tools) {
        const role = swarmRoles.find(role => task.startsWith(`You are ${role.name},`));
        const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
        assert.ok(!role.dependencies.length, "failed handoff must block dependent actors");
        await assessPriorKnowledge(invoke, role.editable[0]);
        await invoke("write_file", { path: role.editable[0], content: "verified component" }); await invoke("run_tests");
        await assert.rejects(invoke("write_memory", { text: "Session Desk unspecified source" }), /handoff_module_required/);
        const text = `Session Desk ${role.title} in ${role.editable.join(", ")} passed its component checks.`;
        if (role.id === "atlas" && mode === "publication_failed") await assert.rejects(invoke("write_memory", { text }), /test_publication_failed/);
        else await invoke("write_memory", { text });
        if (role.id === "atlas" && mode === "edit_after_publication") {
          await invoke("write_file", { path: role.editable[0], content: "a later component revision" }); await invoke("run_tests");
        }
        return { status: "completed", sessionId: randomUUID(), inputTokens: 1, outputTokens: 1, toolCalls: 4, trace: [], responses: [] };
      } }, applicationBuilder: async () => { throw new Error("incomplete collaboration must not become a completed build"); } });
    assert.equal(report.status, "partial"); assert.equal(report.collaboration.completed, false);
    assert.equal(report.collaboration.publishedComponents, 1, "only Iris has a current verified publication");
    const atlas = report.agents.find(role => role.id === "atlas");
    assert.equal(atlas.attempts[0].codePassed, true); assert.equal(atlas.attempts[0].collaboration.published, false);
    assert.equal(report.memoryExhibits.filter(record => record.agent === "atlas").length, mode === "edit_after_publication" ? 1 : 0,
      "an invalidated source remains in history but is not a current handoff");
    assert.ok(report.agents.filter(role => role.dependencies.length).every(role => role.state === "blocked"));
  }
});

test("Lab 1 reports code checks separately from verified sharing and preserves old run semantics", async () => {
  const { buildCollaboration, labCompletion } = await import("./demo-view.mjs");
  assert.equal(typeof buildCollaboration, "function");
  const report = { kind: "swarm_build", status: "partial", memoryPolicy: "verified-handoff-v3",
    agents: [{ id: "atlas", name: "Atlas", state: "failed", attempts: [{ status: "completed", passed: false, codePassed: true,
      verification: { passed: true, tests: 3, passedTests: 3, expectedTests: 3 }, publishedMemories: 0 }] }],
    collaboration: { policy: "verified-handoff-v3", requiredPublications: 5, publishedComponents: 0,
      requiredDependencyHandoffs: 6, receivedDependencyHandoffs: 0, completed: false }, summary: { crossAgentHandoffs: 0 } };
  assert.equal(labCompletion(report).requirements.items[0].status, "passed", "a missing handoff must not rewrite the code-test result");
  assert.equal(buildCollaboration(report).status, "incomplete");
  assert.equal(buildCollaboration(report).publishedComponents, 0);
  assert.equal(buildCollaboration(report).requiredDependencyHandoffs, 6);
  const legacy = { ...report, status: "completed", memoryPolicy: "optional-use-v2", collaboration: undefined };
  const original = JSON.stringify(legacy); const previous = buildCollaboration(legacy);
  assert.equal(previous.status, "optional"); assert.equal(previous.requiredPublications, null); assert.equal(previous.receivedDependencyHandoffs, null);
  assert.equal(JSON.stringify(legacy), original);
  const live = { kind: "swarm_build", status: "recording", agents: [{ id: "atlas", name: "Atlas" }, { id: "dalek-1", control: true }], events: [
    { type: "build_team_started", condition: "withMemory", memoryPolicy: "verified-handoff-v3", requiredPublications: 5, requiredDependencyHandoffs: 6 },
    { type: "collaboration_checked", agent: "atlas", condition: "withMemory", published: true, receivedDependencies: [], codePassed: true },
    { type: "memory_delivered", agent: "nova", from: "atlas" },
    { type: "memory_delivered", agent: "nova", from: "atlas" },
  ] };
  const underway = buildCollaboration(live);
  assert.equal(underway.status, "running"); assert.equal(underway.publishedComponents, 1); assert.equal(underway.crossAgentHandoffs, 1);
  assert.equal(underway.priorKnowledgeChecked, null, "old recordings do not acquire new startup measurements");
  const checked = structuredClone(live);
  checked.events[0].memoryPolicy = "knowledge-first-handoff-v4";
  checked.events[1].priorKnowledgeChecked = true;
  checked.events[1].priorKnowledgeAssessed = true;
  assert.equal(buildCollaboration(checked).status, "running");
  assert.equal(buildCollaboration(checked).priorKnowledgeChecked, 1);
  assert.equal(buildCollaboration(checked).priorKnowledgeAssessed, 1);
  assert.equal(buildCollaboration(checked).checkedDependencySources, null, "v4 did not verify dependency file hashes");
  const grounded = structuredClone(checked);
  grounded.events[0].memoryPolicy = "knowledge-first-handoff-v5";
  grounded.agents.push({ id: "nova", name: "Nova" });
  grounded.events.push({ type: "collaboration_checked", agent: "nova", condition: "withMemory", checkedDependencies: ["atlas", "iris"],
    receivedDependencies: ["atlas", "iris"], priorKnowledgeChecked: true, priorKnowledgeAssessed: true, published: true, codePassed: true });
  assert.equal(buildCollaboration(grounded).status, "running");
  assert.equal(buildCollaboration(grounded).checkedDependencySources, 2);
  assert.equal(buildCollaboration({ kind: "memory_lab" }), null);
});

test("Lab 1 network state counts incoming handoffs and pending work without inventing task reuse", async () => {
  const { runActivity } = await import("./demo-view.mjs");
  const recording = normalizeRecording({ kind: "swarm_build", runId: "network-test", status: "completed", elapsedMs: 20,
    agents: [{ id: "atlas" }, { id: "nova" }, { id: "dalek-1", control: true }], events: [
      { atMs: 1, type: "agent_state", agent: "atlas", state: "running" },
      { atMs: 2, type: "tool_started", agent: "atlas", tool: "run_tests", toolCallId: "checks" },
      { atMs: 3, type: "memory_saved", agent: "atlas", memoryId: "source" },
      { atMs: 4, type: "memory_delivered", agent: "nova", from: "atlas", fragments: 1 },
      { atMs: 5, type: "memory_delivered", agent: "nova", from: "atlas", fragments: 2 },
      { atMs: 6, type: "memory_delivered", agent: "nova", from: "brief", fragments: 1 },
      { atMs: 7, type: "memory_delivered", agent: "nova", from: "nova", fragments: 1 },
      { atMs: 8, type: "memory_delivered", agent: "dalek-1", from: "atlas", fragments: 1 },
      { atMs: 10, type: "agent_state", agent: "atlas", state: "passed" },
      { atMs: 11, type: "agent_state", agent: "nova", state: "running" },
      { atMs: 12, type: "inference_started", agent: "nova" },
      { atMs: 20, type: "run_finished", status: "completed" },
    ] });
  const active = replayState(recording, 9);
  assert.equal(active.agents.atlas.pendingTools.size, 1);
  assert.equal(active.agents.nova.receivedHandoffs.size, 1, "repeated facts from one sender are one handoff link");
  assert.equal(active.agents.nova.linkedUses.size, 0, "delivery is not independently verified task reuse");
  assert.equal(active.agents["dalek-1"].receivedHandoffs.size, 0);
  assert.equal(active.handoffs.size, 1);
  assert.equal(replayState(recording, 10).agents.atlas.pendingTools.size, 0);
  assert.equal(runActivity(recording, 10).currentTools.length, 0, "the stage must not retain a pending tool after its actor stops");
  assert.equal(replayState(recording, 20).agents.nova.inference, null);
  assert.equal(runActivity(recording, 20).activeAgents.length, 0, "a finished run cannot retain active actors in the stage counter");
  assert.equal(replayState(recording, 2).agents.nova.receivedHandoffs.size, 0);
});

test("swarm provider failures stop dependent work and keep usage unknown", async () => {
  let closed = false;
  const result = await runSwarmBuild({ driver: memoryDouble(), code: { engine: "test-double", image: "unit" }, maxAttempts: 1,
    agent: { configuration: {}, async run() { return { sessionId: randomUUID(), status: "provider_error", inputTokens: null, outputTokens: null, trace: [], responses: [] }; } },
    workspaceFactory: async () => ({ async list() { return []; }, async test(group) { const expectedTests = group ? swarmFixture().testGroups[group] : 18;
      return { passed: false, tests: expectedTests, expectedTests, passedTests: 0 }; }, async close() { closed = true; } }),
    applicationBuilder: async () => { throw new Error("must not build a failed project"); } });
  assert.equal(result.status, "partial");
  assert.equal(result.summary.inputTokens, null);
  assert.equal(result.application, null);
  assert.equal(result.agents.filter(agent => agent.state === "blocked").length, 3);
  assert.equal(result.agents.filter(agent => agent.state === "failed").length, 2);
  assert.equal(closed, true);
});

test("CI runs the real lab workflows without external model calls", async () => {
  const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.match(workflow, /node-version: 22\n      - run: npm ci --prefix examples --ignore-scripts\n      - run: cargo fmt/);
  assert.match(workflow, /node-version: 22\n      - run: npm ci --prefix examples --ignore-scripts\n      - uses: actions\/setup-python/);
  const makefile = await readFile(new URL("../Makefile", import.meta.url), "utf8");
  assert.ok(makefile.includes("\tnpm ci --prefix examples --ignore-scripts\n"));
  assert.ok(workflow.includes("Verify isolated memory labs"));
  assert.ok(workflow.includes("MINDLEAK_LAB2_TEST_BINARY: ${{ github.workspace }}/target/release/mindleak-light"));
  assert.ok(workflow.includes("MINDLEAK_VALIDATION_CODE_ENGINE: docker"));
  assert.ok(workflow.includes('MINDLEAK_LAB_BROWSER: "1"'));
  assert.ok(workflow.includes("node examples/node_modules/playwright/cli.js install --with-deps chromium"));
  assert.ok(workflow.includes("/mindleak_labs_test?sslmode=disable"));
  assert.ok(workflow.includes("--test-name-pattern='Lab [123]|swarm project'"));
});

test("Lab 3 freezes three main arms and a separate diagnostic across genuine change", async () => {
  const { rediscoveryPlan, rediscoveryPrompt, compactPriorLesson } = await import("./rediscovery-lab.mjs");
  const plan = rediscoveryPlan();
  assert.equal(plan.protocolVersion, 5);
  assert.equal(plan.memoryUse, "knowledge_first");
  assert.equal(plan.workflowVersion, 2);
  assert.equal(plan.mainSessions, 120);
  assert.equal(plan.diagnosticSessions, 40);
  assert.equal(plan.families, 5);
  assert.equal(plan.repetitions, 2);
  assert.equal(plan.concurrency, 1);
  assert.deepEqual(plan.arms, ["fresh", "notebook", "mindleak"]);
  assert.deepEqual(plan.followups, ["near", "generalization", "irrelevant", "changed"]);
  assert.equal(new Set(plan.sessions.map(session => session.id)).size, 160);
  assert.deepEqual(plan, rediscoveryPlan());
  assert.notEqual(plan.scheduleSha256, rediscoveryPlan({ seed: 33 }).scheduleSha256);
  const learning = rediscoveryPlan({ profile: "learning" });
  assert.equal(learning.families, 5);
  assert.equal(learning.mainSessions, 30);
  assert.equal(learning.diagnosticSessions, 10);
  assert.equal(learning.repetitions, 1);
  assert.deepEqual(learning.followups, ["near", "changed"]);
  assert.equal(selectDemoParameters(null, { rediscoveryProfile: "learning" }).rediscoveryProfile, "learning");
  const adoption = rediscoveryPlan({ profile: "adoption" });
  assert.equal(adoption.protocolVersion, 3);
  assert.equal(adoption.memoryUse, "optional");
  assert.equal(adoption.scheduleSha256, learning.scheduleSha256, "the adoption diagnostic changes policy, not the frozen cases or model schedule");
  assert.equal(selectDemoParameters(null, { rediscoveryProfile: "adoption" }).rediscoveryProfile, "adoption");
  for (const group of new Set(plan.sessions.map(session => session.matchId))) {
    const matched = plan.sessions.filter(session => session.matchId === group);
    assert.equal(matched.length, 4);
    assert.equal(new Set(matched.map(session => session.fixtureSha256)).size, 1);
    assert.equal(new Set(matched.map(session => session.model)).size, 1);
  }
  const prompt = rediscoveryPrompt({ arm: "mindleak", retrievalMode: "keyword", subject: "Dispatch Ledger", task: "A callback repeats a completed operation." });
  assert.ok(prompt.includes("keyword"));
  assert.ok(prompt.includes("one focused refinement"));
  assert.ok(prompt.includes("recall_experience") && prompt.includes("assess_experience"));
  assert.ok(prompt.includes('initial query "Dispatch Ledger"') && prompt.includes("AND"), "keyword lookup starts from the shared task identifier, not a guessed list of synonyms");
  assert.ok(!prompt.includes("Memory use, when available, is optional"));
  const notebookPrompt = rediscoveryPrompt({ arm: "notebook", subject: "Dispatch Ledger", task: "The same case" });
  assert.ok(notebookPrompt.includes("search_notebook") && notebookPrompt.includes("assess_experience"));
  assert.ok(notebookPrompt.includes('initial query "Dispatch Ledger"'), "both experience arms receive the same public task cue");
  assert.ok(rediscoveryPrompt({ arm: "mindleak", memoryUse: "optional", task: "Adoption diagnostic" }).includes("Optional MindLeak policy"));
  assert.ok(!rediscoveryPrompt({ arm: "fresh", task: "No earlier experience" }).includes("assess_experience"));
  assert.ok(!prompt.includes("Read the eight") && !prompt.includes("FIRST call") && !prompt.includes("quote two"));
  const brief = compactPriorLesson({ id: "lesson", title: "Retry ownership", procedure: "Preserve logical operation identity across retries.",
    conditions: "The provider deduplicates requests by operation key.", limitations: "Recheck a changed provider contract.", rationale: "x".repeat(10000),
    evidence: [{ fragmentId: "source", rawText: "y".repeat(10000) }] });
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) <= 2048);
  assert.equal(brief.conditions, "The provider deduplicates requests by operation key.");
  assert.ok(!JSON.stringify(brief).includes("xxxx") && !JSON.stringify(brief).includes("yyyy"));
  assert.throws(() => rediscoveryPlan({ repetitions: 0 }));
  assert.throws(() => rediscoveryPlan({ concurrency: 20 }));
});

test("Lab 3 knowledge-first tools require real lookup and current applicability evidence before edits", async () => {
  const { rediscoveryExperienceTools } = await import("./rediscovery-lab.mjs");
  const lesson = { id: "prior-rule", revision: 2, title: "Dispatch Ledger", procedure: "Preserve the operation key until recovery completes.",
    conditions: "The provider deduplicates by logical operation.", limitations: "Recheck changed key scope.", chainIds: [], markdown: "Dispatch Ledger operation identity",
    document: { claim: "Operation identity", evidence: [] } };
  let unavailable = false; const calls = [];
  const driver = { configuration: { retrieval: "keyword" }, async call(name, args) {
    calls.push({ name, args }); if (unavailable) throw new Error("test_provider_unavailable");
    return { data: { principles: args.knowledge.query === "Dispatch Ledger" ? [{ chain: { chainId: lesson.id, revision: 2, snapshot: { document: lesson.document } }, requiresReview: false }] : [] } };
  } };
  const observedSources = new Map([["docs/current-contract.md", "The current provider deduplicates by logical operation."]]);
  const decision = { decision: "apply", lessonId: lesson.id, reason: "The current provider retains the same operation-key contract.",
    evidence: { path: "docs/current-contract.md", quote: "deduplicates by logical operation" } };
  for (const arm of ["mindleak", "notebook"]) {
    const events = [];
    const experience = rediscoveryExperienceTools({ arm, frozen: { lessons: [lesson] }, driver, scope: "test", requireAssessment: true, observedSources, onEvent: event => events.push(event) });
    const invoke = (name, args) => experience.tools.find(tool => tool.definition.function.name === name).invoke(args);
    assert.ok(experience.tools.some(tool => tool.definition.function.name === "assess_experience"));
    assert.throws(() => experience.beforeChange(), /prior_experience_search_required/);
    await assert.rejects(invoke("assess_experience", decision), /prior_experience_search_required/);
    const result = await invoke(arm === "mindleak" ? "recall_experience" : "search_notebook", { query: "Dispatch Ledger" });
    assert.equal(result.hits[0].id, lesson.id);
    assert.throws(() => experience.beforeChange(), /experience_assessment_required/);
    await assert.rejects(invoke("assess_experience", { ...decision, lessonId: "invented-rule" }), /delivered_experience_required/);
    await assert.rejects(invoke("assess_experience", { ...decision, decision: "no_match", lessonId: null }), /retrieved_experience_requires_assessment/);
    await assert.rejects(invoke("assess_experience", { ...decision, evidence: { path: "unread-file", quote: "invented evidence" } }), /current_source_evidence_required/);
    assert.equal((await invoke("assess_experience", decision)).recorded, true);
    assert.doesNotThrow(() => experience.beforeChange());
    assert.equal(experience.assessment.decision, "apply");
    assert.equal(experience.assessment.evidence.quote, decision.evidence.quote);
    assert.equal(experience.searches[0].status, "hit");
    assert.equal(events.at(-1).type, "experience_assessed");
    assert.ok(!JSON.stringify(events.at(-1)).includes(decision.evidence.quote), "event telemetry keeps source text separate");
    await invoke("assess_experience", { ...decision, decision: "reject", reason: "The current evidence is insufficient to justify applying this rule." });
    assert.equal(experience.assessment.decision, "reject", "the workflow permits rejecting rather than copying a lesson");
    assert.equal(experience.errors.length, 0, "assessment validation failures are not retrieval failures");
  }
  for (const failure of [false, true]) {
    unavailable = failure;
    const experience = rediscoveryExperienceTools({ arm: "mindleak", frozen: { lessons: [lesson] }, driver, scope: "test", requireAssessment: true, observedSources });
    const invoke = (name, args) => experience.tools.find(tool => tool.definition.function.name === name).invoke(args);
    if (failure) await assert.rejects(invoke("recall_experience", { query: "Dispatch Ledger" }), /test_provider_unavailable/);
    else assert.equal((await invoke("recall_experience", { query: "unrelated_test_query" })).hits.length, 0);
    await invoke("assess_experience", { ...decision, decision: failure ? "unavailable" : "no_match", lessonId: null });
    assert.doesNotThrow(() => experience.beforeChange(), "a real miss or failure can continue locally after explicit assessment");
    assert.equal(experience.searches[0].status, failure ? "error" : "miss");
  }
  assert.ok(calls.every(call => call.name === "recall_memory"), "lookup and assessment never write or reinforce stored knowledge");
});

test("Lab 3 knowledge-use display separates skipped lookup misses and assessed application", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const report = { kind: "rediscovery_lab", plan: { profile: "learning", protocolVersion: 3, memoryUse: "optional" },
    metrics: { arms: { mindleak: { scheduled: 2, completed: 2, correct: 2, knowledgeReuse: { successful: 0, rate: 0 }, transfer: { attempts: 0, successful: 0 }, usedChainIds: [], knownFailureCandidates: 0 } } },
    outcomes: [1, 2].map(index => ({ id: `case-${index}`, arm: "mindleak", correct: true, priorKnowledgeDelivered: false, reuseObserved: false,
      experienceAccesses: [], experienceErrors: [] })) };
  const original = JSON.stringify(report);
  const skipped = knowledgeMetrics(report);
  assert.equal(skipped.usage.lookedUp, 0);
  assert.equal(skipped.usage.notConsulted, 2);
  assert.equal(skipped.usage.misses, 0);
  assert.equal(skipped.usage.assessed, null, "old runs do not invent applicability assessments");
  assert.equal(skipped.reuse.rate, 0, "presentation must retain the original zero-reuse result");
  assert.equal(JSON.stringify(report), original);
  const attempted = structuredClone(report); attempted.outcomes[0].experienceAccesses.push({ tool: "recall_experience", lessonIds: [] });
  assert.equal(knowledgeMetrics(attempted).usage.lookedUp, 1);
  assert.equal(knowledgeMetrics(attempted).usage.misses, 1);
  const assessed = structuredClone(attempted); assessed.plan.protocolVersion = 5; assessed.plan.memoryUse = "knowledge_first";
  assessed.outcomes[0].knowledgeWorkflow = { searches: [{ status: "miss" }], assessment: { decision: "no_match" }, completed: true };
  assessed.outcomes[1].knowledgeWorkflow = { searches: [{ status: "hit" }], assessment: { decision: "adapt" }, completed: true };
  assessed.outcomes[1].priorKnowledgeDelivered = true; assessed.outcomes[1].reuseObserved = true;
  const usage = knowledgeMetrics(assessed).usage;
  assert.equal(usage.lookedUp, 2); assert.equal(usage.received, 1); assert.equal(usage.assessed, 2); assert.equal(usage.verifiedUse, 1);
  assert.equal(knowledgeMetrics({ ...report, outcomes: undefined }).usage, null, "missing telemetry is unknown, not zero lookups");
});

test("Lab 3 frozen code cases fail before repair and pass identical immutable tests", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { rediscoveryFamilies, rediscoveryFollowups, rediscoveryFixture, rediscoveryFixtureRepair } = await import("./rediscovery-fixtures.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  const fingerprints = new Set();
  for (const family of rediscoveryFamilies) for (const stage of ["preparation", ...rediscoveryFollowups]) {
    const fixture = rediscoveryFixture(family.id, stage);
    fingerprints.add(fixture.fixtureSha256);
    assert.ok(!Object.keys(fixture.files).some(path => /solution|gold|answer/.test(path)));
    const workspace = await createCodingWorkspace("rediscovery", code, fixture);
    try {
      const before = await workspace.test();
      assert.equal(before.tests, 3, `${fixture.id}: all tests must execute`);
      assert.equal(before.passed, false, `${fixture.id}: initial failure must be observable`);
      await assert.rejects(workspace.write("docs/current-contract.md", "changed"));
      await assert.rejects(workspace.write("tests/workflow.test.mjs", "changed"));
      await workspace.write(fixture.modulePath, rediscoveryFixtureRepair(family.id, stage));
      const after = await workspace.test();
      assert.equal(after.passedTests, 3, `${fixture.id}: the real contract must admit a passing implementation`);
      assert.equal(after.passed, true, fixture.id);
      assert.notEqual(before.sourceSha256, after.sourceSha256);
    } finally { await workspace.close(); }
  }
  assert.equal(fingerprints.size, 25);
});

test("Lab 3 stores verified agent lessons and gives each arm the same frozen experience", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY,
}, async () => {
  const { createRediscoveryStore, rediscoveryExperienceTools, compactPriorLesson } = await import("./rediscovery-lab.mjs");
  const { rediscoveryFixture } = await import("./rediscovery-fixtures.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  const calls = [];
  const monitored = { ...driver, restart: () => driver.restart(), async call(name, args) { calls.push({ name, args }); return driver.call(name, args); } };
  try {
    const runId = randomUUID(); const store = createRediscoveryStore({ driver: monitored, runId });
    const fixture = rediscoveryFixture("retry-identity");
    const lesson = { title: "Dispatch Ledger retry identity", procedure: "Retain a request identity while retrying one logical operation, and verify exactly-once effects.",
      conditions: "The provider deduplicates by operation-scoped request key.", limitations: "Recheck a changed provider contract; attempt-scoped keys require a different policy.",
      evidence: [{ path: "docs/current-contract.md", quote: "The provider deduplicates committed requests by request key.", claim: "The contract defines operation-scoped deduplication." },
        { path: "src/provider.mjs", quote: 'keyScope: "operation"', claim: "The current provider advertises operation-scoped keys." }] };
    const input = { fixture, lesson, verification: { passed: true, tests: 3, expectedTests: 3, passedTests: 3, sourceSha256: "verified-test-candidate" },
      observedSources: new Map(Object.entries(fixture.files)), changed: true, baseline: { passed: false, tests: 3, expectedTests: 3, failedTests: ["behavior/required outcome"] } };
    await assert.rejects(store.retain({ ...input, verification: { passed: false } }), /verified_fix_required/);
    assert.equal(calls.length, 0);
    const saved = await store.retain(input);
    assert.ok(saved.id && saved.revision);
    assert.equal(store.snapshot().lessons.length, 1);
    assert.equal(store.snapshot().observations.length, 2);
    assert.equal(store.snapshot().chains.length, 2);
    assert.equal(store.snapshot().principles.length, 1);
    const frozen = await store.freeze();
    assert.notEqual(frozen.transition.previousPid, frozen.transition.currentPid);
    const beforeRead = calls.length;
    const notebook = rediscoveryExperienceTools({ arm: "notebook", frozen, driver: monitored, scope: store.scope });
    const notebookHit = await notebook.tools.find(tool => tool.definition.function.name === "search_notebook").invoke({ query: "Dispatch Ledger retry" });
    assert.deepEqual(notebookHit.hits[0], compactPriorLesson(saved));
    const markdown = await notebook.tools.find(tool => tool.definition.function.name === "read_notebook").invoke({ id: saved.id });
    assert.ok(markdown.text.includes(lesson.procedure) && markdown.text.includes(lesson.conditions));
    assert.equal(calls.length, beforeRead, "the notebook must not call MindLeak");
    assert.equal(rediscoveryExperienceTools({ arm: "fresh", frozen, driver: monitored, scope: store.scope }).tools.length, 0);
    const memory = rediscoveryExperienceTools({ arm: "mindleak", frozen, driver: monitored, scope: store.scope });
    const recalled = await memory.tools.find(tool => tool.definition.function.name === "recall_experience").invoke({ query: "Dispatch Ledger" });
    assert.deepEqual(recalled.hits[0], notebookHit.hits[0]);
    assert.ok(Buffer.byteLength(JSON.stringify(recalled)) <= 2048);
    assert.equal(memory.accesses.length, 1);
    assert.ok(memory.accesses[0].lessonIds.includes(saved.id));
    const expanded = await memory.tools.find(tool => tool.definition.function.name === "inspect_experience").invoke({ id: saved.chainIds[0] });
    assert.deepEqual(memory.accesses.at(-1).observationIds, expanded.sources.map(source => source.memoryId));
    assert.ok(!JSON.stringify(memory.accesses).includes(lesson.evidence[0].quote), "telemetry stores source IDs, not another copy of the source text");
    const misses = rediscoveryExperienceTools({ arm: "mindleak", frozen, driver: monitored, scope: store.scope });
    const search = misses.tools.find(tool => tool.definition.function.name === "recall_experience");
    assert.equal((await search.invoke({ query: "unrelated_zxqv_777" })).hits.length, 0);
    assert.equal((await search.invoke({ query: "unrelated_zxqv_888" })).hits.length, 0);
    await assert.rejects(search.invoke({ query: "unrelated_zxqv_999" }), /query_refinement_exhausted/);
    assert.equal(await store.verifyFrozen(frozen), true);
    const secondLesson = { ...lesson, title: "Contract-led retry verification",
      procedure: "Compare the documented key scope with the provider implementation before reusing a retry procedure; verify its current conditions." };
    const second = await store.retain({ ...input, lesson: secondLesson });
    assert.notEqual(second.id, saved.id, "distinct principles in one family must coexist instead of overwriting one guide");
    assert.equal(store.snapshot().principles.length, 2);
    assert.equal(store.snapshot().lessons.length, 2);
    const writesBeforeDuplicate = calls.filter(call => call.name === "write_memory").length;
    assert.equal((await store.retain({ ...input, lesson: secondLesson })).id, second.id);
    assert.equal(calls.filter(call => call.name === "write_memory").length, writesBeforeDuplicate, "repetition alone is not new learning");
    await assert.rejects(store.retain({ ...input, lesson: { ...lesson, revises: randomUUID() } }), /unknown_prior_principle/);
    const revised = await store.retain({ ...input, lesson: { ...lesson, revises: saved.id,
      procedure: `${lesson.procedure} Inspect current provider scope before every adaptation.` } });
    assert.equal(revised.id, saved.id, "an explicit revision preserves principle identity");
    assert.ok(revised.revision > saved.revision);
    assert.equal(store.snapshot().lessons.find(item => item.id === second.id).revision, second.revision);
    const continuedStore = createRediscoveryStore({ driver: monitored, runId: randomUUID(), existingScope: store.scope, seed: store.snapshot() });
    const continued = await continuedStore.freeze();
    assert.deepEqual(new Set(continued.lessons.map(item => item.id)), new Set([saved.id, second.id]), "continuation retains every principle in a family");
    const continuedRevision = await continuedStore.retain({ ...input, lesson: { ...lesson, revises: second.id, title: secondLesson.title,
      procedure: `${secondLesson.procedure} Keep the applicability boundary explicit.` } });
    assert.equal(continuedRevision.id, second.id);
    assert.equal(continuedStore.snapshot().observations.length, continued.observations.length, "continued refinement reuses the exact original evidence");
    assert.equal(continuedStore.snapshot().principles.length, 2);
    assert.ok(calls.filter(call => call.name === "write_memory").every(call => !call.args.facts), "no automatic lifecycle feedback");
  } finally { await driver.close(); }
});

test("Lab 3 runs knowledge-first arms with misses frozen rounds and complete accounting", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY || !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { runRediscoveryLab } = await import("./rediscovery-lab.mjs");
  const { rediscoveryFixtureRepair } = await import("./rediscovery-fixtures.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  let comparisonActive = false; let sessionCount = 0; let memoryComparisons = 0;
  const monitored = { ...driver, restart: () => driver.restart(), async call(name, args) {
    assert.ok(!(comparisonActive && name === "write_memory"), "experience must stay frozen while any evaluation arm is running");
    return driver.call(name, args);
  } };
  const agent = { configuration: { model: "test-double", provider: "test", maxSteps: 24, timeoutMs: 300000 }, async run(task, tools, context, schema, { onEvent }) {
    sessionCount += 1;
    assert.ok(task.includes("Installed skills and earlier conversations are unavailable"));
    const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = (name, args = {}) => entries.get(name).invoke(args);
    if (!tools.length) {
      assert.ok(task.includes("memory-side"));
      assert.ok(!task.includes('"arm":"fresh"') && !task.includes('"arm":"direct"'));
      assert.equal(schema.properties.decisions.type, "array");
      const dossier = JSON.parse(context);
      assert.equal(dossier.view, "rediscovery-review");
      assert.ok(dossier.cases.every(item => item.arm === "mindleak"));
      const decisions = Object.fromEntries(dossier.cases.map(item => [item.id, { decision: "skip",
        reason: "The verified current contract is already covered by the retained procedure and introduces no further rule.",
        evidence: { path: "docs/current-contract.md", quote: item.files["docs/current-contract.md"].slice(0, 80) } }]));
      if (task.includes("Review round 0.")) {
        decisions["prepare:retry-identity"] = { decision: "retain", lessons: ["Contract-led recovery checks", "Explicit retry applicability boundaries"].map(title => ({
          title,
          procedure: `${title}: compare provider key scope with the documented contract and verify an appropriate recovery path before reusing prior experience.`,
          conditions: "The current provider advertises its request-key scope.", limitations: "Changed contracts may require attempt-scoped keys.",
          evidence: [{ path: "docs/current-contract.md", quote: "The provider deduplicates committed requests by request key.", claim: "The original contract deduplicates by request key." },
            { path: "src/provider.mjs", quote: 'keyScope: "operation"', claim: "The original provider advertises operation-scoped keys." }],
        })) };
        assert.equal(dossier.principles.length, 1, "the prepared catalogue is fixed for this decision request");
      }
      if (sessionCount > 12 && task.includes("Review round 1.")) {
        const caseId = "retry-identity:near:1:mindleak";
        const recovered = dossier.cases.find(item => item.id === caseId);
        decisions[caseId] = { decision: "retain", lessons: [{ title: "Consumer-side recovery contract checks",
          procedure: "Check the consumer contract and provider key scope together before adapting retry ownership in a different calling module.",
          conditions: "The current consumer has passed its immutable retry checks.", limitations: "Different source files do not establish independent corroboration.",
          evidence: ["docs/current-contract.md", "src/provider.mjs"].map(path => ({ path, quote: recovered.files[path].slice(0, 80), claim: `The verified consumer investigation inspected ${path}.` })) }] };
      }
      return { status: "completed", sessionId: randomUUID(), answer: { completed: true,
        decisions: Object.entries(decisions).map(([caseId, decision]) => ({ caseId, ...decision })) },
        trace: [], responses: [], inputTokens: 100, outputTokens: 10, toolCalls: 0, elapsedMs: 1 };
    }
    const files = await invoke("list_files");
    const modulePath = files.find(path => /^src\/(worker|consumer|adapter)\.mjs$/.test(path));
    const stage = modulePath.includes("worker") ? "preparation" : modulePath.includes("consumer") ? "near" : "changed";
    const lesson = { title: "Dispatch Ledger retry identity", procedure: "Preserve one logical operation identity during retries; verify the provider key contract before choosing request-key lifetime.",
      conditions: "The current provider advertises its request-key scope.", limitations: "Changed contracts may require attempt-scoped keys.",
      evidence: [{ path: "docs/current-contract.md", quote: "The provider deduplicates committed requests by request key.", claim: "The original contract deduplicates by request key." },
        { path: "src/provider.mjs", quote: 'keyScope: "operation"', claim: "The original provider advertises operation-scoped keys." }] };
    if (entries.has("retain_lesson")) await assert.rejects(invoke("retain_lesson", lesson), /verified_fix_required/);
    else assert.ok(![...entries.keys()].some(name => /retain|write_memory/.test(name)));
    const needsExperience = entries.has("recall_experience") || entries.has("search_notebook");
    if (needsExperience) {
      assert.ok(entries.has("assess_experience"), "the main workflow must expose an applicability decision");
      await assert.rejects(invoke("write_file", { path: modulePath, content: rediscoveryFixtureRepair("retry-identity", stage) }), /prior_experience_search_required/);
    }
    let prior = null;
    if (entries.has("recall_experience")) {
      memoryComparisons += 1;
      if (memoryComparisons === 1) assert.equal((await invoke("recall_experience", { query: "unrelated_test_miss_123" })).hits.length, 0);
      else prior = (await invoke("recall_experience", { query: "Dispatch Ledger" })).hits[0];
    }
    if (entries.has("search_notebook")) { prior = (await invoke("search_notebook", { query: "Dispatch Ledger" })).hits[0]; assert.ok(prior); }
    if (context) assert.ok(context.includes("Preserve one logical operation identity"));
    for (const path of [modulePath, "docs/current-contract.md", "src/provider.mjs"]) await invoke("read_file", { path });
    if (needsExperience) {
      await assert.rejects(invoke("write_file", { path: modulePath, content: rediscoveryFixtureRepair("retry-identity", stage) }), /experience_assessment_required/);
      const contract = await invoke("read_file", { path: "docs/current-contract.md" });
      await invoke("assess_experience", { decision: !prior ? "no_match" : entries.has("recall_experience") && memoryComparisons === 3 ? "reject" : stage === "changed" ? "adapt" : "apply",
        lessonId: prior?.id ?? null, reason: "Compare the current request-key contract with the retrieved procedure before choosing the repair.",
        evidence: { path: "docs/current-contract.md", quote: contract.slice(0, 100) } });
    }
    await invoke("write_file", { path: modulePath, content: rediscoveryFixtureRepair("retry-identity", stage) });
    assert.equal((await invoke("run_tests")).passed, true);
    if (entries.has("retain_lesson")) await invoke("retain_lesson", lesson);
    const sessionId = randomUUID(); onEvent({ type: "inference_finished", sessionId, model: "test-double", turn: 1, inputTokens: 100, outputTokens: 10, elapsedMs: 1 });
    return { status: "completed", sessionId, answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 10, toolCalls: 7, elapsedMs: 1 };
  } };
  try {
    const report = await runRediscoveryLab({ driver: monitored, agent, code, profile: "smoke", onEvent: event => {
      if (event.type === "rediscovery_round_started") comparisonActive = true;
      if (event.type === "rediscovery_round_finished") comparisonActive = false;
    } });
    assert.equal(report.status, "completed");
    assert.equal(report.kind, "rediscovery_lab");
    assert.equal(report.plan.mainSessions, 6);
    assert.equal(report.outcomes.length, 8);
    assert.equal(report.outcomes.filter(outcome => !outcome.diagnostic && outcome.correct).length, 6);
    assert.equal(new Set(report.outcomes.map(outcome => outcome.sessionId)).size, 8);
    assert.equal(memoryComparisons, 2);
    assert.equal(report.plan.protocolVersion, 5);
    assert.equal(report.outcomes.filter(outcome => outcome.arm === "mindleak" && outcome.correct && !outcome.priorKnowledgeDelivered).length, 1);
    assert.equal(report.metrics.arms.mindleak.retrievalMisses, 1);
    assert.equal(report.metrics.arms.mindleak.scheduled, 2);
    assert.equal(report.metrics.arms.mindleak.correct, 2);
    assert.equal(report.metrics.arms.mindleak.knowledgeReuse.successful, 1, "a miss followed by a correct answer cannot earn reuse credit");
    assert.equal(report.metrics.arms.mindleak.knowledgeWorkflow.lookedUp, 2);
    assert.equal(report.metrics.arms.mindleak.knowledgeWorkflow.assessed, 2);
    assert.equal(report.metrics.arms.mindleak.knowledgeWorkflow.noMatch, 1);
    assert.equal(report.metrics.arms.notebook.knowledgeWorkflow.lookedUp, 2);
    assert.ok(report.outcomes.filter(outcome => ["mindleak", "notebook"].includes(outcome.arm)).every(outcome => outcome.knowledgeWorkflow.completed));
    assert.equal(report.metrics.arms.fresh.actualCostUsd, null);
    assert.equal(report.metrics.arms.mindleak.totalInputTokens, 200 + 100 + 100 + 200);
    assert.equal(report.metrics.arms.notebook.totalInputTokens, 200 + 100 + 100 + 200);
    assert.equal(report.metrics.arms.fresh.totalInputTokens, 200);
    assert.equal(report.metrics.costBreakEven, null);
    assert.equal(report.metrics.compoundingScore, null);
    assert.equal(report.knowledge.lessons.length, 3);
    assert.equal(report.rounds.length, 2);
    assert.ok(report.rounds.every(round => round.frozenUnchanged && round.learning.outcome === "no_new_learning"));
    assert.equal(sessionCount, 12);
    assert.equal(report.preparationReview.outcome, "learning_retained");
    const recording = normalizeRecording(report);
    assert.equal(recording.rediscovery, true);
    assert.equal(recording.agents.length, 4);
    const { knowledgeMetrics } = await import("./demo-view.mjs");
    const learning = knowledgeMetrics(report);
    assert.equal(learning.successfulTasks, 2);
    assert.equal(learning.reuse.tasks, 1);
    assert.equal(learning.curve.length, 2);
    assert.equal(learning.curve[0].notebook, 1);
    assert.equal(learning.timeToCorrectHypothesis.status, "verified_fix_time_only");
    const page = await renderDemoPage({ report });
    assert.ok(page.includes('id="nav-lab3"'));
    assert.ok(page.includes('id="rediscovery-results"'));
    assert.ok(page.includes('id="rediscovery-cost-curve"'));
    if (process.env.MINDLEAK_REDISCOVERY_TEST_REPLAY_DIR) await writeDemoReplay(report, process.env.MINDLEAK_REDISCOVERY_TEST_REPLAY_DIR);
    const frozenParent = digest(report);
    const continued = await runRediscoveryLab({ driver: monitored, agent, code, profile: "smoke", parent: report, onEvent: event => {
      if (event.type === "rediscovery_round_started") comparisonActive = true;
      if (event.type === "rediscovery_round_finished") comparisonActive = false;
    } });
    assert.equal(continued.status, "completed");
    assert.notEqual(continued.runId, report.runId);
    assert.equal(continued.scope, report.scope);
    assert.equal(continued.preparation.length, 0, "continuation reuses verified experience rather than rerunning preparation");
    assert.equal(continued.plan.preparationTasks, 0);
    assert.equal(continued.plan.parentRunId, report.runId);
    assert.equal(continued.plan.taskExposure, "previously_exposed");
    assert.equal(continued.knowledge.lessons[0].id, report.knowledge.lessons[0].id);
    assert.equal(continued.knowledge.lessons.length, 4);
    assert.ok(report.knowledge.lessons.every(prior => continued.knowledge.lessons.some(lesson => lesson.id === prior.id)));
    assert.equal(continued.outcomes.length, 8);
    const rejected = continued.outcomes.find(outcome => outcome.arm === "mindleak" && outcome.stage === "near");
    assert.equal(rejected.correct, true);
    assert.equal(rejected.knowledgeWorkflow.assessment.decision, "reject");
    assert.equal(rejected.reuseObserved, false, "a retrieved but rejected lesson is not applied knowledge");
    assert.equal(continued.metrics.arms.mindleak.knowledgeWorkflow.rejected, 1);
    assert.equal(sessionCount, 22);
    assert.equal(digest(report), frozenParent, "parent-run records must remain immutable");
    let expandedPlan;
    await assert.rejects(runRediscoveryLab({ driver: monitored, agent, code, profile: "learning", parent: continued,
      onPlan: plan => { expandedPlan = plan; throw new Error("plan_only_probe"); } }), /plan_only_probe/);
    assert.equal(expandedPlan.preparationTasks, 4, "expanding smoke retains its existing family and investigates only new families");
    assert.equal(expandedPlan.mainSessions, 30);
    assert.equal(expandedPlan.newFamilyIds.length, 4);
  } finally { await driver.close(); }
});

test("Lab 3 review authors a complete decision document before persistence", async () => {
  const { reviewRediscoveryKnowledge } = await import("./rediscovery-lab.mjs");
  const { rediscoveryFixture, rediscoveryFixtureRepair } = await import("./rediscovery-fixtures.mjs");
  const fixture = rediscoveryFixture("retry-identity");
  const evidence = { fixture, changed: true, candidateFiles: { [fixture.modulePath]: rediscoveryFixtureRepair(fixture.family) },
    verification: { passed: true, tests: 3, expectedTests: 3, passedTests: 3, sourceSha256: "verified-candidate" },
    baseline: { passed: false, tests: 3, expectedTests: 3, passedTests: 1, sourceSha256: "failing-baseline" } };
  const verified = ["first-case", "second-case"].map(id => ({ id, arm: "mindleak", family: fixture.family, stage: fixture.stage, correct: true }));
  for (const mode of ["complete", "partial", "invalid_quote", "unfinished", "cancelled", "deadline"]) {
    const controller = new AbortController(); let writes = 0; let returned = false;
    const store = { scope: "review-document-test", snapshot: () => ({ lessons: [], chains: [], observations: [] }), async verifyFrozen() {},
      async retain({ signal }) { assert.equal(returned, true); assert.ok(signal instanceof AbortSignal); writes += 1; return { id: "retained-principle", revision: 2 }; } };
    const agent = { configuration: { timeoutMs: mode === "deadline" ? 1 : 300000 }, async run(_task, tools, context, schema) {
      assert.deepEqual(tools, [], "the review author must not depend on SDK tool dispatch");
      assert.equal(schema.properties.decisions.type, "array");
      assert.equal(schema.properties.decisions.minItems, verified.length);
      assert.equal(writes, 0, "authoring has no persistence side effects");
      const { cases } = JSON.parse(context);
      const decisions = cases.map(item => ({ caseId: item.id, decision: "skip", reason: "The supplied case adds no further supported reusable condition.",
        evidence: { path: "docs/current-contract.md", quote: item.files["docs/current-contract.md"].slice(0, 80) } }));
      decisions[0] = { caseId: cases[0].id, decision: "retain", lessons: [{ title: "Operation-scoped retry identity",
        procedure: "Check the provider key scope, retain the key across operation retries, and verify exactly-once effects.",
        conditions: "The inspected provider deduplicates committed requests by request key.", limitations: "Attempt-scoped keys require a different procedure after checking the changed contract.",
        evidence: ["docs/current-contract.md", "src/provider.mjs"].map(path => ({ path, quote: cases[0].files[path].slice(0, 80), claim: "The inspected source defines the current request-key contract." })) }] };
      if (mode === "partial") decisions.pop();
      if (mode === "invalid_quote") decisions[1].evidence.quote = "This quotation is not in the source.";
      if (mode === "cancelled") controller.abort();
      if (mode === "deadline") await new Promise(resolve => setTimeout(resolve, 10));
      returned = true;
      return { status: "completed", answer: { completed: mode !== "unfinished", decisions }, inputTokens: 10, outputTokens: 2, toolCalls: 0, trace: [], responses: [] };
    } };
    const result = await reviewRediscoveryKnowledge({ round: { number: 0, stage: "preparation" }, verified, signal: controller.signal,
      caseEvidence: new Map(verified.map(outcome => [outcome.id, evidence])), store, agent, driver: {} });
    assert.equal(result.completed, mode === "complete", mode);
    assert.equal(writes, mode === "complete" ? 1 : 0, mode);
    assert.equal(result.decisions.length, mode === "complete" ? 2 : 0, mode);
    if (mode === "deadline") assert.equal(result.failure.code, "review_deadline");
  }
});

test("Lab 3 bounded review preserves rejection evidence and refuses unsafe decisions", async () => {
  const { reviewRediscoveryKnowledge, rediscoveryReviewPolicy } = await import("./rediscovery-lab.mjs");
  const { rediscoveryFixture, rediscoveryFixtureRepair } = await import("./rediscovery-fixtures.mjs");
  const fixture = rediscoveryFixture("path-boundary", "changed");
  const verification = { passed: true, tests: 3, expectedTests: 3, passedTests: 3, sourceSha256: "verified-source" };
  const evidence = { fixture, candidateFiles: { [fixture.modulePath]: rediscoveryFixtureRepair("path-boundary", "changed") },
    verification, baseline: { passed: false, tests: 3, expectedTests: 3, passedTests: 1 }, changed: true };
  for (const mode of ["skip", "unresolved", "partial", "retention_failure", "retained", "unrelated_retention", "rejected_after_success", "invalid_quote", "unknown_case", "duplicate_decision", "oversized", "control", "changed", "changed_during_preparation", "source_mismatch", "duplicate_case", "missing_evidence"]) {
    const stored = { lessons: [], observations: [], chains: [], principles: [] };
    let modelCalls = 0; let writes = 0;
    const store = { scope: "bounded-review-test", snapshot() { return structuredClone(stored); },
      async verifyFrozen() { if (mode === "changed_during_preparation") stored.lessons.push({ id: "changed-principle", revision: 3, document: {} }); }, async retain() {
        writes += 1;
        if (mode === "retention_failure" || mode === "unrelated_retention" && writes === 1) throw Object.assign(new Error("mcp_invalid_result"), { code: "provider_request_failed" });
        if (mode === "rejected_after_success" && writes === 2) throw new Error("prior_lesson_brief_budget");
        return { id: "new-principle", revision: 2, existing: mode === "unrelated_retention" };
      } };
    const outcome = { id: "path-boundary:changed:1:mindleak", arm: mode === "control" ? "fresh" : "mindleak", correct: true,
      family: fixture.family, stage: "changed", priorKnowledgeDelivered: true, priorImplementationInvalidated: true,
      trace: [{ tool: "retain_lesson", ok: false, errorCode: "mcp_invalid_result", elapsedMs: 240001 }],
      knowledgeWorkflow: { assessment: { decision: "reject", lessonId: "earlier-principle", reason: "The inspected contract changed." } } };
    const current = structuredClone(evidence);
    if (mode === "oversized") current.fixture.files["docs/extra-evidence.md"] = "x".repeat(rediscoveryReviewPolicy.maximumBytes);
    if (mode === "source_mismatch") stored.observations.push({ memoryId: "original-source", rawText: "Original evidence", fragments: [{ fragmentId: "source-fragment", text: "Original evidence" }] });
    const agent = { async run(task, tools, context) {
      modelCalls += 1;
      const dossier = JSON.parse(context); const entry = dossier.cases[0];
      assert.equal(entry.priorKnowledge.assessment.decision, "reject");
      assert.equal(entry.priorKnowledge.priorImplementationInvalidated, true);
      assert.deepEqual(entry.retentionFailures, [{ code: "mcp_invalid_result", elapsedMs: 240001 }], "earlier failed formation must remain visible to the reviewer");
      assert.deepEqual(tools, []);
      const skip = { caseId: entry.id, decision: "skip", reason: "The existing conditional procedure already directs rechecking this changed provider contract.",
        evidence: { path: "docs/current-contract.md", quote: entry.files["docs/current-contract.md"].slice(0, 80) } };
      const validLesson = { title: "Supported current-contract procedure",
        procedure: "Inspect the current provider contract before selecting path semantics and verify the resulting namespace boundary.",
        conditions: "The current verified provider supplies the resource-name contract.", limitations: "A changed provider can require different treatment of literal resource names.",
        evidence: ["docs/current-contract.md", "src/provider.mjs"].map(path => ({ path, quote: entry.files[path].slice(0, 80), claim: "The inspected source defines the current resource-name contract." })) };
      const decisions = [skip];
      if (["retention_failure", "retained", "unrelated_retention", "rejected_after_success"].includes(mode)) decisions[0] = { caseId: entry.id, decision: "retain",
        lessons: ["unrelated_retention", "rejected_after_success"].includes(mode) ? [validLesson, { ...validLesson, title: "Different supported proposal" }] : [validLesson] };
      if (mode === "invalid_quote") skip.evidence.quote = "This quotation is not in the supplied evidence.";
      if (mode === "unknown_case") skip.caseId = "fresh-control-case";
      if (mode === "duplicate_decision") decisions.push(structuredClone(skip));
      if (mode === "changed") stored.lessons.push({ id: "changed-principle", revision: 3, document: {} });
      return { status: "completed", answer: { completed: mode !== "unresolved", decisions }, inputTokens: 10, outputTokens: 2, toolCalls: 0, trace: [], responses: [] };
    } };
    const verified = mode === "duplicate_case" ? [outcome, outcome] : ["partial", "duplicate_decision"].includes(mode) ? [outcome, { ...outcome, id: "second-case" }] : [outcome];
    const result = await reviewRediscoveryKnowledge({ round: { number: 2, stage: "changed" },
      verified, caseEvidence: new Map(mode === "missing_evidence" ? [] : verified.map(item => [item.id, current])), store, agent,
      driver: { async call() { return { data: { memoryId: "original-source", rawText: "Replaced evidence" } }; } } });
    assert.equal(result.completed, ["skip", "retained"].includes(mode), mode);
    assert.equal(modelCalls, ["oversized", "control", "changed_during_preparation", "source_mismatch", "duplicate_case", "missing_evidence"].includes(mode) ? 0 : 1, mode);
    assert.equal(writes, ["unrelated_retention", "rejected_after_success"].includes(mode) ? 2 : ["retention_failure", "retained"].includes(mode) ? 1 : 0);
    if (mode === "partial") assert.deepEqual(result.unresolvedCaseIds, [outcome.id, "second-case"]);
    if (["partial", "unresolved"].includes(mode)) assert.equal(result.failure.code, "review_decisions_incomplete");
    if (["retention_failure", "unrelated_retention"].includes(mode)) {
      assert.equal(result.experienceErrors.length, 1);
      assert.equal(result.experienceErrors[0].cause, "provider_request_failed");
      assert.equal(result.failure.code, "review_retention_failed");
      assert.deepEqual(result.unresolvedCaseIds, [outcome.id]);
    }
    if (mode === "skip") assert.equal(result.outcome, "no_new_learning");
    if (mode === "retained") assert.equal(result.outcome, "learning_retained");
    if (mode === "unrelated_retention") assert.equal(result.retainedLessonIds.length, 1, "acknowledged writes survive an incomplete review");
    if (mode === "rejected_after_success") {
      assert.equal(result.retainedLessonIds.length, 1);
      assert.deepEqual(result.unresolvedCaseIds, [outcome.id]);
      assert.equal(result.experienceErrors[0].code, "review_retention_rejected");
    }
  }
});

test("Lab 3 cannot complete when a required learning review is unfinished", async () => {
  const { runRediscoveryLab } = await import("./rediscovery-lab.mjs");
  for (const reviewResult of [
    { status: "incomplete", answer: null, failure: { code: "runtime_idle_before_final_answer" } },
    { status: "completed", answer: { completed: false } },
    { status: "completed", answer: { completed: true } },
    { status: "completed", answer: { completed: true }, decide: true },
  ]) {
    let processNumber = 0;
    const driver = { capabilities: { knowledge: true, chains: true }, configuration: { decomposition: "sentences", retrieval: "keyword" },
      async restart() { const previous = processNumber; processNumber += 1; return { previous, current: processNumber }; },
      async call(name, args) {
        assert.equal(name, "recall_memory", "this status-only fixture must not invent stored knowledge");
        assert.equal(args.knowledge.operation, "search");
        return { data: { kind: "knowledge", principles: [], chains: [], observations: [] } };
      } };
    const agent = { configuration: { model: "test-double", provider: "test" }, async run(task, tools, context) {
      const reviewing = !tools.some(tool => tool.definition.function.name === "write_file");
      let decisions;
      if (reviewing) {
        assert.deepEqual(tools, [], "review authors must not rely on another tool-dispatch loop");
        const dossier = JSON.parse(context);
        assert.equal(dossier.view, "rediscovery-review");
        assert.equal(dossier.cases.length, 1);
        assert.ok(dossier.cases.every(item => item.arm === "mindleak" && item.verification.passed));
        assert.ok(!context.includes('"arm":"fresh"') && !context.includes('"arm":"notebook"') && !context.includes('"arm":"direct"'));
        if (reviewResult.decide) decisions = dossier.cases.map(item => ({
          caseId: item.id, decision: "skip", reason: "The verified fixture adds no established reusable finding beyond the supplied current contract.",
          evidence: { path: "docs/current-contract.md", quote: item.files["docs/current-contract.md"].slice(0, 80) },
        }));
      }
      if (!reviewing) {
        const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
        const search = tools.find(tool => ["recall_experience", "search_notebook"].includes(tool.definition.function.name));
        if (search) {
          await search.invoke({ query: "Synthetic current contract" });
          const source = await invoke("read_file", { path: "docs/current-contract.md" });
          await invoke("assess_experience", { decision: "no_match", lessonId: null,
            reason: "The empty lookup requires checking the supplied current fixture contract locally.",
            evidence: { path: "docs/current-contract.md", quote: source.slice(0, 80) } });
        }
        const edit = tools.find(tool => tool.definition.function.name === "write_file");
        await edit.invoke({ path: edit.definition.function.parameters.properties.path.enum[0], content: "verified test fixture candidate" });
      }
      return { sessionId: randomUUID(), status: "completed", answer: { completed: true }, trace: [], responses: [],
        inputTokens: 10, outputTokens: 2, toolCalls: 0, elapsedMs: 1, ...(reviewing ? reviewResult : {}),
        ...(decisions ? { answer: { ...reviewResult.answer, decisions } } : {}) };
    } };
    const report = await runRediscoveryLab({ driver, agent, code: { engine: "test" }, profile: "smoke",
      workspaceFactory: async (_name, _code, fixture) => {
        let repaired = false;
        const files = { ...fixture.files };
        return { editablePaths: fixture.editable, async read(path) { return files[path]; },
          async write(path, content) { files[path] = content; repaired = true; return { written: true }; }, async close() {}, async test() {
          return { passed: repaired, tests: 3, expectedTests: 3, passedTests: repaired ? 3 : 0, sourceSha256: repaired ? "verified-candidate" : "failing-baseline" };
        } };
      } });
    const completed = reviewResult.status === "completed" && reviewResult.answer.completed && Boolean(reviewResult.decide);
    assert.equal(report.finalTests.passed, true);
    assert.equal(report.metrics.arms.mindleak.correct, 2);
    assert.equal(report.metrics.arms.mindleak.knowledgeReuse.successful, 0);
    assert.equal(report.status, completed ? "completed" : "partial");
    assert.equal(report.failure, completed ? null : "learning_review_incomplete");
    assert.deepEqual(report.learningReviews, { status: completed ? "completed" : "incomplete", scheduled: 3, completed: completed ? 3 : 0, incomplete: completed ? 0 : 3 });
    assert.ok([report.preparationReview, ...report.rounds.map(round => round.learning)].every(review =>
      review.outcome === (completed ? "no_new_learning" : "review_incomplete")));
    assert.ok([report.preparationReview, ...report.rounds.map(round => round.learning)].every(review => review.decisions.length === (completed ? 1 : 0)));
    assert.equal(report.events.at(-1).status, report.status);
    assert.equal(report.events.filter(event => event.type === "run_finished").length, 1);
  }
});

test("Lab 1 artifact acceptance records real browser checks for each exact build", {
  skip: !process.env.MINDLEAK_LAB_BROWSER,
}, async () => {
  const { verifyBuildArtifacts } = await import("./demo-replay.mjs");
  const { sessionDeskHtml } = await import("./swarm-fixture.mjs");
  const script = `
const root=document.querySelector("#session-app");
const records=[];let sequence=0;
const render=()=>{
 const list=root.querySelector("[data-sessions]");list.replaceChildren();root.querySelector("[data-count]").textContent=String(records.length);
 for(const record of records){
  const row=document.createElement("div");row.className="session-card";row.dataset.state=Date.now()>=record.expiresAt?"expired":"active";
  const label=document.createElement("span");label.className="session-label";label.textContent=record.label;
  const remove=document.createElement("button");remove.type="button";remove.dataset.remove=record.id;remove.textContent="Remove";
  remove.onclick=()=>{records.splice(records.indexOf(record),1);render();};row.append(label,remove);list.append(row);
 }
};
root.querySelector("form").onsubmit=event=>{
 event.preventDefault();const label=root.querySelector("#session-label").value.trim();const ttl=Number(root.querySelector("#session-ttl").value);
 if(!label||ttl<1||ttl>3600){root.querySelector("[data-error]").textContent="Invalid session";return;}
 root.querySelector("[data-error]").textContent="";records.push({id:String(++sequence),label,expiresAt:Date.now()+ttl*1000});render();
};
root.querySelector("[data-clear-expired]").onclick=()=>{for(let index=records.length-1;index>=0;index-=1)if(Date.now()>=records[index].expiresAt)records.splice(index,1);render();};
setInterval(render,100);render();
`;
  const html = sessionDeskHtml.replace("</body>", `<script src="data:text/javascript;base64,${Buffer.from(script).toString("base64")}"></script></body>`);
  const artifact = { html, sha256: digest(html) };
  const report = { kind: "swarm_build", application: artifact, controlApplication: artifact };
  const reviews = await verifyBuildArtifacts(report, { executablePath: process.env.MINDLEAK_BROWSER_EXECUTABLE });
  assert.equal(reviews.length, 8);
  assert.ok(reviews.every(review => review.checks > 0 && review.passedChecks === review.checks),
    JSON.stringify(reviews.map(({ artifact, area, viewport, failures }) => ({ artifact, area, viewport, failures }))));
  assert.deepEqual(new Set(reviews.map(review => review.artifact)), new Set(["application", "controlApplication"]));
  assert.deepEqual(new Set(reviews.map(review => review.viewport.width)), new Set([1440, 390]));
  assert.ok(reviews.every(review => review.artifactSha256 === artifact.sha256 && review.method.includes("Playwright") && review.checkedAt));
  await assert.rejects(verifyBuildArtifacts({ ...report, application: { ...artifact, sha256: "not-the-reviewed-artifact" } }), /artifact_identity_mismatch/);
  const broken = "<html><body>No usable app controls</body></html>";
  const failed = await verifyBuildArtifacts({ kind: "swarm_build", application: { html: broken, sha256: digest(broken) } }, { executablePath: process.env.MINDLEAK_BROWSER_EXECUTABLE });
  assert.ok(failed.some(review => review.passedChecks < review.checks));
  assert.ok(failed.some(review => review.failures.length));
});

test("Lab 1 preflights browser acceptance and retains failed reviews without false success", async () => {
  const { runBuildWithAcceptance } = await import("./demo-replay.mjs");
  let built = false; let closed = 0; const events = [];
  const browser = { async close() { closed += 1; } };
  const build = async emit => {
    built = true;
    const report = { kind: "swarm_build", status: "completed", agents: [], elapsedMs: 1,
      application: { html: "<html></html>", sha256: digest("<html></html>") },
      events: [{ id: 1, type: "run_started", atMs: 0 }, { id: 2, type: "run_finished", status: "completed", atMs: 1 }] };
    report.events.forEach(emit); return report;
  };
  await assert.rejects(runBuildWithAcceptance(build, { openBrowser: async () => { throw new Error("browser unavailable"); } }), /browser unavailable/);
  assert.equal(built, false, "preflight must fail before model work starts");
  const report = await runBuildWithAcceptance(build, { openBrowser: async () => browser, onEvent: event => events.push(event),
    verifyArtifacts: async report => [{ artifact: "application", artifactSha256: report.application.sha256, area: "Browser behaviour",
      method: "Test verifier", checks: 2, passedChecks: 1, failures: ["Create a session"] }] });
  assert.equal(report.status, "partial");
  assert.equal(report.failure, "browser_acceptance_failed");
  assert.equal(report.qualityReviews[0].failures[0], "Create a session");
  assert.equal(report.verification.quality.status, "failed");
  assert.equal(report.events.at(-1).type, "run_finished");
  assert.equal(report.events.at(-1).status, "partial");
  assert.equal(events.filter(event => event.type === "run_finished").length, 1);
  assert.deepEqual(report.events, events);
  assert.equal(closed, 1);
  assert.ok(report.qualityCheckMs >= 0 && report.browserPreflightMs >= 0);
});

test("study progress retains parent outcomes and cumulative costs without copying conversations", async () => {
  const { studyProgress } = await import("./demo-view.mjs");
  const run = (id, inputTokens, correct) => ({ runId: id, kind: "rediscovery_lab", status: "completed", createdAt: "2026-09-18T00:00:00Z",
    elapsedMs: 100, summary: { inputTokens, outputTokens: 10 }, memoryProcessing: { inputTokens: 5, outputTokens: 2 },
    metrics: { arms: { mindleak: { correct, scheduled: 2 }, fresh: { correct: 1, scheduled: 2 }, notebook: { correct: 1, scheduled: 2 } } },
    knowledge: { observations: [{ memoryId: "source" }], chains: [{ chainId: "chain" }], principles: [{ chainId: "guide" }] },
    outcomes: [{ transcript: "private conversation must not enter the history summary" }] });
  const parent = run("run-one", 100, 1); parent.study = studyProgress(parent);
  const before = digest(parent); const current = run("run-two", 50, 2);
  const history = studyProgress(current, parent);
  assert.equal(history.studyId, "run-one");
  assert.equal(history.parentRunId, "run-one");
  assert.equal(history.sequence, 2);
  assert.equal(history.taskExposure, "previously_exposed");
  assert.equal(history.runs.length, 2);
  assert.equal(history.runs[0].arms.mindleak.correct, 1, "an earlier unresolved task remains in the record");
  assert.equal(history.runs[1].arms.mindleak.correct, 2);
  assert.equal(history.totals.inputTokens, 150);
  assert.equal(history.totals.memoryInputTokens, 10);
  assert.ok(!JSON.stringify(history).includes("private conversation"));
  assert.equal(digest(parent), before);
  assert.equal(studyProgress(current).sequence, 1, "fresh mode starts a new study without deleting the old archive");
});

test("Lab 1 replay activity animates real event signals and respects pause and reduced motion", {
  skip: !process.env.MINDLEAK_LAB_BROWSER,
}, async () => {
  const { openArtifactBrowser } = await import("./demo-replay.mjs");
  const directory = await mkdtemp(join(tmpdir(), "mindleak-replay-motion-"));
  const report = { kind: "swarm_build", runId: randomUUID(), status: "completed", realModel: false, agents: [swarmRoles[0]], elapsedMs: 20000,
    events: [{ id: 1, atMs: 0, type: "run_started" }, { id: 2, atMs: 100, type: "agent_state", agent: "atlas", state: "running" },
      { id: 3, atMs: 1000, type: "tool_started", agent: "atlas", tool: "write_memory", toolCallId: "write" },
      { id: 4, atMs: 4000, type: "memory_saved", agent: "atlas", memoryId: "source", fragments: 1 },
      { id: 5, atMs: 8000, type: "knowledge_written", agent: "atlas", nodeId: "chain", memoryId: "chain-write", kind: "chain", operation: "propose" },
      { id: 6, atMs: 8001, type: "memory_saved", agent: "atlas", memoryId: "chain-write", fragments: 1 },
      { id: 7, atMs: 15000, type: "tool_finished", agent: "atlas", tool: "write_memory", toolCallId: "write", ok: true },
      { id: 8, atMs: 20000, type: "run_finished", status: "completed" }],
    knowledge: { observations: [{ memoryId: "source", fragments: [{ fragmentId: "fragment", text: "Synthetic recorded evidence." }] }],
      chains: [{ chainId: "chain", revision: 1, state: "candidate", document: { kind: "chain", claim: "Synthetic formation event", evidence: [{ fragmentId: "fragment", role: "supports" }], supportedBy: [] } }], principles: [] } };
  const server = await createDemoServer({ outputDirectory: directory, initialReport: report, runBuild: async () => { throw new Error("not_requested"); } });
  const browser = await openArtifactBrowser();
  try {
    const page = await browser.newPage();
    await page.goto(`${server.url}/replay`);
    await page.locator("#speed").selectOption("1");
    await page.locator("#replay-activity").click();
    await page.waitForFunction(() => document.querySelectorAll(".memory-packet").length > 0);
    assert.equal(await page.locator("#activity-mode").innerText(), "RECORDED REPLAY");
    const before = await page.locator(".memory-packet").first().evaluate(node => ({ x: node.getCTM().e, y: node.getCTM().f }));
    await page.waitForFunction(before => { const matrix = document.querySelector(".memory-packet")?.getCTM(); return matrix && Math.abs(matrix.e - before.x) + Math.abs(matrix.f - before.y) > 0.2; }, before);
    await page.locator("#play").click();
    assert.equal(await page.locator(".memory-packet").count(), 0);
    assert.equal(await page.locator("#activity-mode").innerText(), "PAUSED");
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.locator("#replay-activity").click();
    assert.equal(await page.locator(".memory-packet").count(), 0);
    await page.emulateMedia({ reducedMotion: "no-preference" });
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: width === 1440 ? 1080 : 844 });
      await page.goto(`${server.url}/replay#learnings`);
      assert.equal(await page.locator("#replay-activity").isVisible(), true, "the knowledge graph needs an accessible replay action");
      assert.equal(await page.locator("#knowledge-page #play").isVisible(), true);
      assert.equal(await page.locator("#knowledge-page #memory-activity").isVisible(), true);
      await page.locator("#speed").selectOption("1");
      await page.locator("#scrubber").evaluate(input => { input.value = "400"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.locator("#play").click();
      await page.waitForFunction(() => document.querySelector('.knowledge-hero-node[data-node-id="chain"]')?.dataset.active === "true");
      assert.equal(await page.locator('.knowledge-hero-edge[data-active="true"]').count(), 1);
      assert.equal(await page.locator('#knowledge-machine .stage-graph-packet').count(), 1);
      assert.equal(await page.locator('#machine-chains .machine-record').getAttribute("data-pulse"), "true");
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".factory-roller svg")).animationName), "stage-rotate");
      const packet = await page.locator(".stage-graph-packet").evaluate(node => ({ x: node.getCTM().e, y: node.getCTM().f }));
      await page.waitForFunction(before => { const matrix = document.querySelector(".stage-graph-packet")?.getCTM(); return matrix && Math.abs(matrix.e - before.x) + Math.abs(matrix.f - before.y) > 0.2; }, packet);
      await page.locator("#play").click();
      assert.equal(await page.locator('.knowledge-hero-node[data-active="true"]').count(), 0);
      assert.equal(await page.locator(".stage-graph-packet").count(), 0);
      assert.equal(await page.locator("#knowledge-machine").getAttribute("data-active"), "false");
      assert.equal(await page.evaluate(() => getComputedStyle(document.querySelector(".factory-roller svg")).animationName), "none");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.locator("#nav-lab1").click();
      await page.locator("#experiment-page #play").waitFor({ state: "visible" });
      assert.equal(await page.locator("#experiment-page #play").isVisible(), true);
      assert.equal(await page.locator("#experiment-page #memory-activity").isVisible(), true);
    }
  } finally { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Lab 3 story and distinct Knowledge machine preserve PR41 playback", {
  skip: !process.env.MINDLEAK_LAB_BROWSER,
}, async () => {
  const { openArtifactBrowser } = await import("./demo-replay.mjs");
  const directory = await mkdtemp(join(tmpdir(), "mindleak-knowledge-focus-"));
  const chain = id => ({ chainId: id, revision: 2, state: "accepted", document: { kind: "chain", claim: `Evidence ${id}`, conclusion: "Follow the measured contract.", evidence: [{ fragmentId: "fact", role: "supports", reason: "Recorded test" }], supportedBy: [] } });
  const rule = id => ({ chainId: id, revision: 2, state: "accepted", document: { kind: "principle", claim: `Conditional rule ${id}`, conclusion: `Actual learned conclusion ${id}`,
    applicability: "Only the measured service contract.", assumptions: ["Recheck changed conditions."], evidence: [{ fragmentId: "exception", role: "counterexample", reason: "A changed completion contract" }],
    supportedBy: [{ chainId: "chain-a", revision: 2 }, { chainId: "chain-b", revision: 2 }] } });
  const report = { kind: "rediscovery_lab", runId: randomUUID(), status: "completed", realModel: false, elapsedMs: 20000,
    agents: [{ id: "fresh", name: "Fresh Agent", connectToMemory: false }, { id: "mindleak", name: "MindLeak" }],
    plan: { profile: "mechanism", protocolVersion: 4, preparationTasks: 0, sessions: [
      { id: "one:fresh", matchId: "one", arm: "fresh", family: "page-stream", stage: "near" },
      { id: "one:mindleak", matchId: "one", arm: "mindleak", family: "page-stream", stage: "near" } ] },
    knowledge: { observations: [{ memoryId: "source", source: "synthetic:test", rawText: "Original source evidence with a known exception.", fragments: [{ fragmentId: "fact", text: "Observed fact" }, { fragmentId: "exception", text: "Known exception" }] }],
      chains: [chain("chain-a"), chain("chain-b")], principles: [rule("rule-a"), rule("rule-b")] },
    events: [
      { id: 1, atMs: 0, type: "run_started", expectedTests: 6 },
      { id: 2, atMs: 1000, type: "knowledge_written", agent: "mindleak", kind: "observation", operation: "write", nodeId: "source", memoryId: "source" },
      { id: 3, atMs: 2000, type: "knowledge_written", agent: "mindleak", kind: "chain", operation: "propose", nodeId: "chain-a", memoryId: "chain-write-a", revision: 2, state: "accepted" },
      { id: 4, atMs: 3000, type: "knowledge_written", agent: "mindleak", kind: "chain", operation: "propose", nodeId: "chain-b", memoryId: "chain-write-b", revision: 2, state: "accepted" },
      { id: 5, atMs: 4000, type: "knowledge_written", agent: "mindleak", kind: "principle", operation: "accept", nodeId: "rule-a", memoryId: "rule-write-a", revision: 2, state: "accepted" },
      { id: 6, atMs: 5000, type: "knowledge_written", agent: "mindleak", kind: "principle", operation: "accept", nodeId: "rule-b", memoryId: "rule-write-b", revision: 2, state: "accepted" },
      { id: 7, atMs: 6000, type: "stage_started", agent: "mindleak", phase: "validation" },
      { id: 8, atMs: 6500, type: "prospective_prediction", agent: "mindleak", caseId: "reserved", expectedPass: false, applicable: false },
      { id: 9, atMs: 7500, type: "validation_completed", agent: "mindleak", caseId: "reserved", correct: true, passed: false },
      { id: 10, atMs: 8000, type: "rediscovery_task_started", agent: "fresh", caseId: "one:fresh", phaseScope: "evaluation" },
      { id: 11, atMs: 9000, type: "rediscovery_task_finished", agent: "fresh", caseId: "one:fresh", phaseScope: "evaluation", correct: true },
      { id: 12, atMs: 10000, type: "rediscovery_task_started", agent: "mindleak", caseId: "one:mindleak", phaseScope: "evaluation" },
      { id: 13, atMs: 15000, type: "rediscovery_task_finished", agent: "mindleak", caseId: "one:mindleak", phaseScope: "evaluation", correct: true, reuseObserved: false },
      { id: 14, atMs: 20000, type: "run_finished" },
    ] };
  const server = await createDemoServer({ outputDirectory: directory, initialReport: report, runBuild: async () => { throw new Error("must_not_run"); } });
  const browser = await openArtifactBrowser();
  try {
    for (const viewport of [{ width: 1440, height: 1080 }, { width: 390, height: 844 }]) {
      const page = await browser.newPage({ viewport, reducedMotion: "reduce" }); const errors = []; page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(() => { Object.defineProperty(crypto, "randomUUID", { value: undefined }); });
      await page.goto(`${server.url}/replay`);
      assert.equal(await page.locator("#lab3-story").isVisible(), true);
      assert.equal(await page.locator("#knowledge-reuse-results").isVisible(), true, "Lab 3 retains its reuse and transfer measurements");
      assert.equal(await page.locator("#stage-roster .agent-face").count(), report.agents.length, "Lab 3 uses the same character faces as Lab 2");
      assert.equal(await page.locator("#agents .agent-face").count(), report.agents.length, "the detailed agent nodes keep the same character identity");
      assert.equal(await page.locator("#stage-roster .agent-eye").count(), report.agents.length * 2);
      await page.locator("#lab3-chapters button").filter({ hasText: "Test the rule" }).click();
      assert.equal(await page.locator("#activity-mode").innerText(), "PAUSED");
      await page.locator("#scrubber").evaluate(input => { input.value = "350"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      assert.equal(await page.locator("#lab3-prediction-title").innerText(), "Prediction locked in");
      await page.locator("#lab3-next-moment").click();
      assert.equal(await page.locator("#lab3-prediction-title").innerText(), "Prediction matched the check");
      await page.locator("#lab3-chapters button").filter({ hasText: "New cases" }).click();
      assert.equal(await page.locator(".lab3-lane[data-state=working]").count(), 1);
      assert.equal(await page.locator("#lab3-case-lanes .agent-face").count(), 2, "the case board reuses the same characters, not generic tool icons");
      await page.locator("#scrubber").evaluate(input => { input.value = "850"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      await page.locator("#nav-learnings").click();
      assert.equal(await page.locator("#knowledge-command").count(), 1, "Knowledge leads with the human decision workspace");
      await page.locator("#knowledge-command").waitFor({ state: "visible" });
      assert.equal(await page.locator("#review-approve").evaluate(node => getComputedStyle(node).backgroundColor),
        await page.locator("#run").evaluate(node => getComputedStyle(node).backgroundColor), "Knowledge primary actions share the lab palette");
      assert.equal(await page.locator("#review-queue button").first().evaluate(node => getComputedStyle(node).borderTopWidth), "2px");
      const reviewColors = await page.locator(".review-tab").evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
      assert.ok(new Set(reviewColors).size >= 3, "the review counters reuse the labs' varied blue, mint and yellow accents");
      assert.equal(await page.locator(".review-tab svg").count(), 5);
      assert.equal(await page.locator("#review-queue button").count(), 4);
      assert.equal(await page.locator("#review-pending-count").innerText(), "4");
      assert.equal(await page.locator("#review-approved-count").innerText(), "0", "recorded agent acceptance is not human approval");
      assert.equal(await page.locator("#review-view-state").innerText(), "Latest recorded snapshot", "opening the control centre stops at current evidence for human review");
      assert.equal(await page.locator("#play").getAttribute("aria-label"), "Play replay");
      assert.equal(await page.locator("#review-approve").isDisabled(), true);
      await page.locator('#review-queue button[data-knowledge-id="rule-a"]').click();
      assert.equal(await page.locator("#review-document #knowledge-focus-conclusion").innerText(), "Actual learned conclusion rule-a");
      assert.equal(await page.locator("#knowledge-machine").count(), 1, "Knowledge needs its own synthesis surface, not another agent stage");
      await page.locator("#knowledge-machine").waitFor({ state: "visible" });
      assert.equal(await page.locator("#knowledge-machine .machine-title h2").innerText(), "Knowledge Factory");
      assert.equal(await page.locator("#knowledge-machine").getAttribute("aria-label"), "Knowledge Factory");
      assert.equal(await page.locator('#knowledge-machine .machine-title svg[data-lucide="factory"]').count(), 1);
      assert.equal(await page.locator("#knowledge-machine .factory-conveyor").isVisible(), true);
      assert.equal(await page.locator("#live-stage").isVisible(), false);
      assert.equal(await page.locator("#knowledge-machine #play").isVisible(), true);
      assert.equal(await page.locator("#knowledge-machine #memory-activity").isVisible(), true);
      assert.equal(await page.locator("#machine-observations button").count(), 1);
      assert.equal(await page.locator("#machine-chains button").count(), 2);
      assert.equal(await page.locator("#machine-principles button").count(), 2);
      await page.locator("#machine-chains button").first().click();
      assert.equal(await page.locator("#knowledge-focus-select").inputValue(), "chain-a", "the selected chain remains identified when principles also exist");
      assert.equal(await page.locator("#knowledge-focus-conclusion").innerText(), "Follow the measured contract.");
      await page.locator("#machine-observations-more").click();
      assert.equal(await page.locator("#observation-nodes").isVisible(), true, "the library control opens its containing record index");
      await page.locator("#machine-principles button").last().click();
      assert.equal(await page.locator("#knowledge-focus-conclusion").innerText(), "Actual learned conclusion rule-b");
      assert.equal(await page.locator('#machine-principles button[aria-pressed="true"]').count(), 1);
      assert.equal(await page.locator('.knowledge-hero-node[data-selected="true"]').count(), 4, "selection traces only the principle, its two chains and their source episode");
      const trayTops = await page.locator(".machine-tray").evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
      assert.ok(Math.max(...trayTops) - Math.min(...trayTops) < 1, "source, assembly and catalogue shelves align on mobile and desktop");
      const graphWidth = await page.locator("#knowledge-hero-graph").evaluate(node => node.viewBox.baseVal.width);
      assert.ok(Math.abs(graphWidth - await page.locator("#knowledge-hero-graph").evaluate(node => node.clientWidth)) <= 1, "the evidence links span the machine instead of retaining the experiment thumbnail size");
      await page.locator("#knowledge-focus-select").selectOption("rule-a");
      assert.equal(await page.locator("#knowledge-focus-conclusion").innerText(), "Actual learned conclusion rule-a");
      assert.equal(await page.locator("#knowledge-focus-supports button").count(), 2);
      assert.equal(await page.locator("#knowledge-focus-counterexamples button").count(), 1);
      assert.equal(await page.locator("#evidence-route-sources").innerText(), "1");
      assert.equal(await page.locator("#evidence-route-chains").innerText(), "2");
      await page.locator("#knowledge-focus-sources button").first().click();
      assert.equal(await page.locator("#source-preview").isVisible(), true);
      assert.equal(await page.locator("#source-preview-body").innerText(), report.knowledge.observations[0].rawText);
      await page.locator("#source-preview details > summary").click();
      assert.ok((await page.locator("#knowledge-inspector").innerText()).includes(report.knowledge.observations[0].rawText));
      await page.locator("#review-current").click();
      await page.locator("#reviewer-name").fill("Test reviewer");
      await page.locator("#review-note").fill("The recorded supports and counterevidence were inspected.");
      assert.equal(await page.locator("#review-approve").isDisabled(), true, "approval requires an explicit evidence acknowledgement");
      await page.locator("#review-evidence-check").check();
      assert.equal(await page.locator("#review-approve").isEnabled(), true);
      await page.locator("#review-approve").click();
      assert.equal(await page.locator("#review-confirm").isVisible(), true, "human review must also work over trusted-LAN HTTP without secure-context randomUUID");
      await page.locator("#review-confirm-cancel").click();
      assert.equal(await page.locator("#review-approved-count").innerText(), "0", "opening a confirmation is not a decision");
      await page.locator("#review-approve").click();
      await page.locator("#review-confirm-save").click();
      assert.equal(await page.locator("#review-approved-count").innerText(), "1");
      assert.match(await page.locator("#review-history").innerText(), /Test reviewer/);
      assert.deepEqual(server.snapshot().report.knowledge, report.knowledge, "human review never changes the sealed recording");
      const downloadPromise = page.waitForEvent("download"); await page.locator("#review-export").click();
      const download = await downloadPromise; const audit = JSON.parse(await readFile(await download.path(), "utf8"));
      assert.equal(audit.authority, "browser-local"); assert.equal(audit.decisions[0].chainId, "rule-a"); assert.equal(audit.decisions[0].evidenceReviewed, true);
      await page.reload();
      assert.equal(await page.locator("#review-approved-count").innerText(), "1", "the local decision survives reload");
      await page.locator('#review-filters [data-review-filter="approved"]').click();
      assert.equal(await page.locator("#review-queue button").count(), 1);
      await page.locator("#review-search").fill("missing claim");
      assert.equal(await page.locator("#review-queue button").count(), 0);
      await page.locator("#review-search").fill("");
      await page.locator('#review-filters [data-review-filter="all"]').click();
      await page.locator('#review-queue button[data-knowledge-id="rule-b"]').click();
      await page.locator("#reviewer-name").fill("Test reviewer");
      await page.locator("#review-note").fill("Clarify the recorded boundary before a new review.");
      await page.locator("#review-revise").click(); await page.locator("#review-confirm-save").click();
      assert.equal(await page.locator("#review-revision-count").innerText(), "1");
      await page.locator('#review-queue button[data-knowledge-id="chain-a"]').click();
      await page.locator("#review-note").fill("Waiting for a separate source check.");
      await page.locator("#review-defer").click(); await page.locator("#review-confirm-save").click();
      assert.equal(await page.locator("#review-deferred-count").innerText(), "1");
      assert.deepEqual(server.snapshot().report.knowledge, report.knowledge, "revision requests and deferrals are local review decisions too");
      await page.locator("#knowledge-focus-select").selectOption("rule-a");
      await page.locator("#reviewer-name").fill("Test reviewer");
      await page.locator("#review-note").fill("A new local revision request.");
      await page.evaluate(() => { Storage.prototype.setItem = () => { throw new DOMException("Quota exceeded", "QuotaExceededError"); }; });
      await page.locator("#review-revise").click(); await page.locator("#review-confirm-save").click();
      assert.match(await page.locator("#review-confirm-feedback").innerText(), /not saved/i);
      assert.equal(await page.locator("#review-approved-count").innerText(), "1", "failed persistence must not replace the earlier decision");
      await page.locator("#review-confirm-cancel").click();
      await page.locator("#knowledge-focus-replay").click();
      assert.equal(await page.locator("#activity-mode").innerText(), "PAUSED", "reduced motion must not start autoplay");
      assert.ok(!(await page.locator("#knowledge-focus-select option").allTextContents()).includes("Conditional rule rule-a"), "replay seeks before the principle was formed");
      await page.locator("#scrubber").evaluate(input => { input.value = "0"; input.dispatchEvent(new Event("input", { bubbles: true })); });
      assert.equal(await page.locator("#source-preview").isVisible(), false, "source inspection must not leak an episode before its recorded arrival");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
      await page.locator("#nav-lab3").click();
      await page.locator("#experiment-page #live-stage").waitFor({ state: "visible" });
      assert.equal(await page.locator("#experiment-page #live-stage").isVisible(), true);
      assert.equal(await page.locator("#live-stage #play").isVisible(), true);
      assert.equal(await page.locator("#knowledge-machine").isVisible(), false);
      assert.deepEqual(errors, []); await page.close();
    }
  } finally { await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("human knowledge review is explicit and bound to its exact evidence snapshot", async () => {
  const { knowledgeReviewQueue } = await import("./demo-view.mjs");
  assert.equal(typeof knowledgeReviewQueue, "function");
  const chain = id => ({ chainId: id, revision: 2, state: "accepted", requiresReview: false,
    document: { kind: "chain", claim: id, conclusion: "Measured conclusion", evidence: [{ fragmentId: "fact", role: "supports" }], supportedBy: [] } });
  const knowledge = { observations: [{ memoryId: "source", rawText: "Observed result", fragments: [{ fragmentId: "fact", text: "Observed result" }] }],
    chains: [chain("chain-a"), chain("chain-b")], principles: [{ ...chain("principle"),
      document: { kind: "principle", claim: "Conditional principle", conclusion: "Apply under measured conditions", evidence: [],
        supportedBy: [{ chainId: "chain-a", revision: 2 }, { chainId: "chain-b", revision: 2 }] } }] };
  const original = JSON.stringify(knowledge);
  const initial = knowledgeReviewQueue(knowledge);
  const selected = initial.items.find(item => item.id === "principle");
  assert.equal(selected.status, "pending", "agent acceptance must never imply human approval");
  assert.deepEqual(selected.blockedReasons, []);
  const decision = { id: "review-1", chainId: "principle", revision: 2, decision: "approve", reviewer: "Test reviewer",
    note: "Inspected the two supporting chains and source.", evidenceReviewed: true, reviewedAt: "2026-09-18T00:00:00Z", snapshot: selected.snapshot };
  assert.equal(knowledgeReviewQueue(knowledge, [decision]).counts.approved, 1);
  assert.equal(knowledgeReviewQueue(knowledge, [{ ...decision, evidenceReviewed: false }]).counts.approved, 0);
  assert.equal(knowledgeReviewQueue(knowledge, [{ ...decision, reviewer: "" }]).counts.approved, 0);
  const revised = structuredClone(knowledge); revised.principles[0].revision += 1;
  assert.equal(knowledgeReviewQueue(revised, [decision]).counts.approved, 0, "a revision needs a new human decision");
  const changed = structuredClone(knowledge); changed.observations[0].rawText = "Changed source evidence";
  assert.equal(knowledgeReviewQueue(changed, [decision]).counts.approved, 0, "source changes invalidate the review binding");
  const stale = structuredClone(knowledge); stale.chains[0].revision += 1;
  assert.ok(knowledgeReviewQueue(stale, [decision]).items.find(item => item.id === "principle").blockedReasons.length);
  const challenged = structuredClone(knowledge); challenged.principles[0].requiresReview = true;
  assert.ok(knowledgeReviewQueue(challenged, [decision]).items.find(item => item.id === "principle").blockedReasons.length);
  assert.equal(knowledgeReviewQueue(knowledge, [{ ...decision, decision: "request_revision" }]).counts.revisionRequested, 1);
  assert.equal(knowledgeReviewQueue(knowledge, [{ ...decision, decision: "defer" }]).counts.deferred, 1);
  assert.equal(JSON.stringify(knowledge), original, "human review never rewrites the recorded experiment");
});

test("Lab 3 task events drive shared character activity and completion", async () => {
  const { replayState } = await import("./demo-view.mjs");
  const recording = { agents: [{ id: "mindleak" }, { id: "fresh", connectToMemory: false }], events: [
    { atMs: 1, type: "stage_finished", agent: "mindleak", success: true },
    { atMs: 2, type: "rediscovery_task_started", agent: "mindleak", caseId: "case:mindleak" },
    { atMs: 3, type: "inference_started", agent: "mindleak" },
    { atMs: 5, type: "rediscovery_task_finished", agent: "mindleak", caseId: "case:mindleak", correct: false },
    { atMs: 6, type: "rediscovery_task_started", agent: "fresh", caseId: "case:fresh" },
    { atMs: 8, type: "rediscovery_task_finished", agent: "fresh", caseId: "case:fresh", correct: true },
  ] };
  assert.equal(replayState(recording, 2).agents.mindleak.state, "running", "a new task replaces the earlier preparation state");
  assert.equal(replayState(recording, 2).agents.mindleak.action, "Investigating");
  assert.equal(replayState(recording, 5).agents.mindleak.state, "failed");
  assert.equal(replayState(recording, 5).agents.mindleak.inference, null);
  assert.equal(replayState(recording, 6).agents.fresh.state, "running", "characters animate for actual work without implying memory access");
  assert.equal(replayState(recording, 8).agents.fresh.state, "passed");
  assert.equal(replayState(recording, 0).agents.mindleak.state, "queued", "reverse seeking does not retain future character states");
});

test("Lab 1 live stage streams actual progress without waiting for run completion", {
  skip: !process.env.MINDLEAK_LAB_BROWSER,
}, async () => {
  const { openArtifactBrowser } = await import("./demo-replay.mjs");
  const directory = await mkdtemp(join(tmpdir(), "mindleak-live-stage-"));
  const ready = Promise.withResolvers(); const finish = Promise.withResolvers();
  const profiles = { experiment: 1, agents: [{ id: "test-double", name: "Test model" }], memory: [{ id: "off", name: "Model-free" }], roles: swarmRoles,
    defaults: { agentModels: Object.fromEntries(swarmRoles.map(role => [role.id, "test-double"])), memoryModel: "off" } };
  const server = await createDemoServer({ outputDirectory: directory, profiles, runBuild: async options => {
    options.onEvent({ id: 1, atMs: 0, type: "run_started", runId: randomUUID(), agents: 10,
      memoryPolicy: "verified-handoff-v3", requiredPublications: 5, requiredDependencyHandoffs: 6 });
    ready.resolve(options); await finish.promise;
    return { ...server.snapshot().report, status: "completed" };
  } });
  const browser = await openArtifactBrowser();
  const run = server.startRun(); const emit = await ready.promise;
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1080 } });
    await page.goto(server.url);
    await page.waitForFunction(() => document.querySelector("#activity-mode")?.textContent === "LIVE");
    assert.equal(await page.locator("#build-sharing-summary").isVisible(), true);
    assert.equal(await page.locator("#knowledge-reuse-results").count(), 1);
    assert.equal(await page.locator("#knowledge-reuse-results").isVisible(), false, "Lab 1 must not show unmeasured Lab 3 reuse and transfer scores");
    assert.equal(await page.locator("#stage-graph").isVisible(), false, "the build stage must not show an empty chain/principle diagram");
    assert.equal(await page.locator("#agents .agent-model-select").first().isVisible(), true);
    const layout = await page.locator("#network").evaluate(node => ({
      cardsBottom: Math.max(...[...node.querySelectorAll(".agent-card")].map(card => card.getBoundingClientRect().bottom)),
      hubTop: node.querySelector(".hub").getBoundingClientRect().top,
    }));
    assert.ok(layout.hubTop >= layout.cardsBottom + 12, "the memory hub must leave room below live agent cards and selectors");
    assert.equal(await page.locator("#build-sharing-published").innerText(), "0 / 5");
    assert.equal(await page.locator("#build-sharing-received").innerText(), "0 / 6");
    emit.onEvent({ id: 2, atMs: 2, type: "agent_state", agent: "atlas", state: "running" });
    emit.onEvent({ id: 3, atMs: 3, type: "tool_started", agent: "atlas", tool: "read_file", toolCallId: "source-read" });
    emit.onToolDetail({ agent: "atlas", toolCallId: "source-read", arguments: { path: "src/expiry.mjs" } });
    await page.waitForFunction(() => document.querySelector("#stage-target")?.textContent === "src/expiry.mjs");
    assert.equal(await page.locator("#network-meta").innerText(), "5 agents / 1 active", "the build network counter covers the five visible memory-team agents");
    const before = await page.locator("#stage-clock").innerText();
    await page.waitForFunction(before => document.querySelector("#stage-clock").textContent !== before, before);
    emit.onEvent({ id: 4, atMs: 4, type: "tool_finished", agent: "atlas", tool: "read_file", toolCallId: "source-read", ok: true });
    emit.onEvent({ id: 5, atMs: 5, type: "knowledge_written", agent: "atlas", kind: "observation", nodeId: "source", memoryId: "source", operation: "write" });
    emit.onKnowledge({ observations: [{ memoryId: "source", fragments: [{ fragmentId: "fragment", text: "Test-owned live source evidence." }] }], chains: [], principles: [] });
    await page.waitForFunction(() => document.querySelector("#stage-sources").textContent === "1");
    assert.equal(await page.locator("#stage-actions").innerText(), "1");
    assert.equal(await page.locator(".knowledge-hero-node").count(), 1);
    emit.onEvent({ id: 6, atMs: 6, type: "collaboration_checked", agent: "atlas", codePassed: true,
      published: true, memoryId: "source", receivedDependencies: [], requiredDependencies: [], completed: true });
    await page.waitForFunction(() => document.querySelector("#build-sharing-published").textContent === "1 / 5");
    assert.equal(await page.locator("#build-sharing-code").innerText(), "1 / 5");
    emit.onEvent({ id: 7, atMs: 7, type: "memory_saved", agent: "atlas", memoryId: "source", fragments: 1 });
    emit.onEvent({ id: 8, atMs: 8, type: "agent_state", agent: "nova", state: "running" });
    emit.onEvent({ id: 9, atMs: 9, type: "tool_started", agent: "nova", tool: "inspect_source", toolCallId: "source-delivery" });
    emit.onEvent({ id: 10, atMs: 10, type: "memory_delivered", agent: "nova", from: "atlas", fragments: 1 });
    await page.waitForFunction(() => document.querySelector('#agents [data-agent="nova"]')?.dataset.working === "true");
    assert.equal(await page.locator('#agents [data-agent="nova"] .agent-memory-counts > div').last().innerText(), "1\nHANDOFFS RECEIVED");
    assert.equal(await page.locator(".stage-score:last-child dt").innerText(), "TEAM HANDOFFS");
    assert.equal(await page.locator("#stage-principles").innerText(), "1");
    assert.equal(server.snapshot().running, true, "live counters must update before the run returns");
    await page.locator("#play").click();
    assert.equal(await page.locator("#live-stage").getAttribute("data-busy"), "false");
    assert.equal(await page.locator('#agents [data-agent="nova"]').getAttribute("data-working"), "false");
    assert.equal(await page.locator(".stage-graph-packet").count(), 0);
  } finally { finish.resolve(); await run; await browser.close(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("lab completion separates a finished run from verified requirements and quality", async () => {
  const { labCompletion } = await import("./demo-view.mjs");
  const receipt = passed => ({ passed, tests: 3, expectedTests: 3, passedTests: passed ? 3 : 2, sourceSha256: "tested-candidate" });
  const sessions = ["fresh", "notebook", "mindleak", "direct"].map(arm => ({ id: `case:${arm}`, arm, diagnostic: arm === "direct" }));
  const report = { kind: "rediscovery_lab", status: "completed", plan: { preparationTasks: 1, mainSessions: 3, diagnosticSessions: 1, sessions },
    preparation: [{ id: "prepare:case", status: "completed", correct: true, finalTests: receipt(true) }],
    outcomes: sessions.map(session => ({ ...session, status: "completed", correct: session.arm !== "notebook", finalTests: receipt(session.arm !== "notebook") })),
    finalTests: { passed: false, tests: 15, expectedTests: 15, passedTests: 14 }, knowledge: { principles: [{ state: "accepted" }] } };
  const summary = labCompletion(report);
  assert.equal(summary.execution.status, "finished");
  assert.equal(summary.requirements.status, "failed");
  assert.equal(summary.requirements.passed, 4);
  assert.equal(summary.requirements.scheduled, 5);
  assert.equal(summary.requirements.unresolved, 1);
  assert.ok(summary.requirements.items.some(item => item.id === "case:notebook" && item.status === "failed"));
  assert.equal(summary.quality.status, "not_reviewed");
  assert.ok(summary.quality.unreviewed.includes("Accessibility"));
  assert.ok(summary.quality.unreviewed.includes("Security"));
  assert.equal(summary.learning.status, "not_established");
  assert.equal(summary.releaseReady, false, "test success and stored knowledge cannot certify production quality");
  const passing = structuredClone(report);
  passing.outcomes.forEach(outcome => { outcome.correct = true; outcome.finalTests = receipt(true); });
  passing.finalTests.passed = true; passing.finalTests.passedTests = 15;
  assert.equal(labCompletion(passing).requirements.status, "passed");
  assert.equal(labCompletion(passing).quality.status, "not_reviewed");
  const missing = structuredClone(passing);
  missing.outcomes.pop();
  assert.equal(labCompletion(missing).requirements.status, "incomplete");
  assert.equal(labCompletion(missing).requirements.unresolved, 1);
  const forged = structuredClone(passing);
  forged.outcomes[0].finalTests = { passed: true };
  assert.equal(labCompletion(forged).requirements.status, "incomplete");
  const running = labCompletion({ ...report, status: "recording" });
  assert.equal(running.execution.status, "running");
  assert.equal(labCompletion({}).requirements.status, "not_measured");
  const builds = { kind: "swarm_build", status: "completed", application: { sha256: "memory-html" }, controlApplication: { sha256: "dalek-html" } };
  const review = (artifact, area, width) => ({ artifact, artifactSha256: builds[artifact].sha256, area, viewport: { width, height: width === 1440 ? 1080 : 844 },
    method: "Playwright acceptance smoke", checks: 2, passedChecks: 2, checkedAt: "2026-09-18T00:00:00Z" });
  builds.qualityReviews = ["Browser behaviour", "Responsive layout"].flatMap(area => [1440, 390].map(width => review("application", area, width)));
  assert.ok(labCompletion(builds).quality.unreviewed.includes("Browser behaviour"), "one team's review cannot cover the other build");
  builds.qualityReviews.push(...["Browser behaviour", "Responsive layout"].flatMap(area => [1440, 390].map(width => review("controlApplication", area, width))));
  assert.deepEqual(labCompletion(builds).quality.unreviewed, ["Accessibility", "Security", "Maintainability"]);
  assert.equal(labCompletion(builds).quality.status, "partial_review");
  builds.controlApplication.sha256 = "changed-html";
  assert.ok(labCompletion(builds).quality.unreviewed.includes("Browser behaviour"), "a stale hash cannot approve changed output");
});

test("Knowledge Capital rewards distinct verified reuse rather than inventory or control activity", async () => {
  const { knowledgeCapital } = await import("./demo-view.mjs");
  const success = (id, round, observationIds) => ({ id, arm: "mindleak", round, family: "retry-identity", stage: "near", fixtureSha256: `new-${round}`,
    correct: true, reuseObserved: true, finalTests: { passed: true, tests: 3, passedTests: 3, expectedTests: 3 }, writes: [{ atMs: 20 }],
    experienceAccesses: [{ atMs: 5, level: "principle", lessonIds: ["principle"], resourceId: "principle", observationIds: [] },
      { atMs: 10, level: "chain", lessonIds: ["principle"], resourceId: "chain", observationIds }] });
  const report = { kind: "rediscovery_lab", knowledge: {
    observations: [{ memoryId: "observation-a" }, { memoryId: "observation-b" }],
    chains: [{ chainId: "chain", revision: 2, state: "accepted", document: { evidence: [], supportedBy: [] } }],
    principles: [{ chainId: "principle", revision: 2, state: "accepted", document: { supportedBy: [{ chainId: "chain", revision: 2 }] } }],
    lessons: [{ id: "principle", family: "retry-identity", sourceFixtureSha256: "preparation" }],
  }, rounds: [1, 2].map(number => ({ number, frozenUnchanged: true, lessonVersions: [{ id: "principle", revision: 2 }] })),
  outcomes: [success("first", 1, ["observation-a"]), success("second", 2, ["observation-a", "observation-b"])] };
  const capital = knowledgeCapital(report);
  assert.deepEqual(capital.weights, { observation: 1, chain: 5, principle: 10 });
  assert.equal(capital.score, 17);
  assert.equal(capital.observations, 2);
  assert.equal(capital.usedObservations, 2);
  assert.equal(capital.usefulChains, 1);
  assert.equal(capital.validatedPrinciples, 1);
  assert.deepEqual(capital.checkpoints.map(point => point.score), [16, 17]);
  assert.equal(capital.growthPercent, 6.25);
  const live = { ...report, status: "recording", rounds: undefined, outcomes: undefined, events: report.rounds.flatMap(round => [
    { type: "rediscovery_round_started", round: round.number, lessonVersions: round.lessonVersions },
    ...report.outcomes.filter(outcome => outcome.round === round.number).map(outcome => ({
      type: "rediscovery_task_finished", phaseScope: "evaluation", agent: outcome.arm, caseId: outcome.id, family: outcome.family,
      round: outcome.round, stage: outcome.stage, correct: outcome.correct, reuseObserved: outcome.reuseObserved,
      capitalEvidence: { fixtureSha256: outcome.fixtureSha256, finalTests: outcome.finalTests, writes: outcome.writes, experienceAccesses: outcome.experienceAccesses },
    })),
    { type: "rediscovery_round_finished", round: round.number, frozenUnchanged: true },
  ]) };
  assert.deepEqual(knowledgeCapital(live), capital, "the live view and saved report must score the same evidence");
  const repeated = structuredClone(report);
  repeated.knowledge.observations.push({ memoryId: "observation-a" }, { memoryId: "never-used" });
  repeated.outcomes.push(success("third", 2, ["observation-a"]));
  assert.equal(knowledgeCapital(repeated).score, 17);
  assert.equal(knowledgeCapital(repeated).observations, 3);
  for (const alter of [
    outcome => { outcome.arm = "direct"; },
    outcome => { outcome.correct = false; },
    outcome => { outcome.finalTests = { passed: true }; },
    outcome => { outcome.finalTests.tests = 0; },
    outcome => { outcome.writes = []; },
    outcome => { outcome.experienceAccesses.forEach(access => { access.atMs = 30; }); },
    outcome => { outcome.experienceAccesses = []; },
    outcome => { outcome.reuseObserved = false; },
  ]) {
    const invalid = structuredClone(report);
    invalid.outcomes.forEach(alter);
    assert.equal(knowledgeCapital(invalid).score, 0);
  }
  const stale = structuredClone(report);
  stale.knowledge.principles[0].revision = 3;
  assert.equal(knowledgeCapital(stale).validatedPrinciples, 0);
  const candidate = structuredClone(report);
  candidate.knowledge.principles[0].state = "candidate";
  assert.equal(knowledgeCapital(candidate).validatedPrinciples, 0);
  const chainOnly = structuredClone(report);
  chainOnly.outcomes.forEach(outcome => { outcome.experienceAccesses = outcome.experienceAccesses.filter(access => access.level === "chain"); });
  assert.equal(knowledgeCapital(chainOnly).score, 7);
  assert.equal(knowledgeCapital(chainOnly).validatedPrinciples, 0, "a parent reference is not observed principle use");
  const firstReuse = structuredClone(report);
  firstReuse.outcomes[0].reuseObserved = false;
  assert.equal(knowledgeCapital(firstReuse).growthPercent, null);
  assert.equal(knowledgeCapital(firstReuse).growthStatus, "first_reuse");
  assert.equal(knowledgeCapital({ kind: "memory_lab", knowledge: report.knowledge, summary: { guideApplications: 900 } }).score, null,
    "legacy quotation-only application counts cannot establish a behavioral index");
});

test("knowledge focus reveals real conclusions with source lineage and counterevidence", async () => {
  const { knowledgeFocus } = await import("./demo-view.mjs");
  const knowledge = { observations: [{ memoryId: "source", fragments: [{ fragmentId: "fact", text: "Observed result" }, { fragmentId: "exception", text: "A recorded exception" }] }],
    chains: [{ chainId: "chain-a", revision: 2, state: "accepted", document: { kind: "chain", claim: "First case", conclusion: "Check the actual contract.", evidence: [{ fragmentId: "fact", role: "supports", reason: "Executed check" }], supportedBy: [] } },
      { chainId: "chain-b", revision: 2, state: "accepted", document: { kind: "chain", claim: "Second case", evidence: [{ fragmentId: "fact", role: "supports", reason: "Shared original source" }, { fragmentId: "exception", role: "counterexample", reason: "Does not apply to the changed contract" }], supportedBy: [] } }],
    principles: [{ chainId: "rule-a", revision: 3, state: "candidate", document: { kind: "principle", claim: "The conditional rule", conclusion: "Act only when the recorded conditions hold.", applicability: "Only the measured contracts.", assumptions: ["The service contract has not changed."], evidence: [], supportedBy: [{ chainId: "chain-a", revision: 2 }, { chainId: "chain-b", revision: 2 }] } },
      { chainId: "rule-b", revision: 1, state: "candidate", document: { kind: "principle", claim: "Another rule", evidence: [], supportedBy: [] } }],
  };
  const focus = knowledgeFocus(knowledge, "rule-a");
  assert.equal(focus.selected.id, "rule-a");
  assert.equal(focus.selected.state, "candidate");
  assert.equal(focus.selected.conclusion, knowledge.principles[0].document.conclusion);
  assert.equal(focus.selected.applicability, knowledge.principles[0].document.applicability);
  assert.equal(focus.sources.length, 1, "two chains citing one episode are not independent evidence");
  assert.equal(focus.supports.length, 2);
  assert.equal(focus.counterexamples.length, 1);
  assert.equal(focus.counterexamples[0].memoryId, "source");
  assert.equal(focus.choices.length, 2, "all principles remain selectable");
  const stale = structuredClone(knowledge); stale.chains[0].revision = 4;
  assert.equal(knowledgeFocus(stale, "rule-a").supports[0].available, false);
  assert.equal(knowledgeFocus(stale, "rule-a").supports[0].currentRevision, 4);
  const missing = structuredClone(knowledge); missing.observations = [];
  assert.equal(knowledgeFocus(missing, "rule-a").sources.length, 0);
  assert.equal(knowledgeFocus(missing, "rule-a").unavailableEvidence, 2);
  assert.equal(knowledgeFocus({}).selected, null);
});

test("Lab 3 case board follows actual events and never invents future wins or reuse", async () => {
  const { lab3Story } = await import("./demo-view.mjs");
  const report = { kind: "rediscovery_lab", status: "completed", elapsedMs: 100, agents: [
    { id: "fresh", name: "Fresh Agent", connectToMemory: false }, { id: "mindleak", name: "MindLeak" },
  ], plan: { sessions: [
    { id: "one:fresh", matchId: "one", caseId: "one", arm: "fresh", family: "retry-identity", stage: "near" },
    { id: "one:mindleak", matchId: "one", caseId: "one", arm: "mindleak", family: "retry-identity", stage: "near" },
  ] }, events: [
    { id: 1, type: "stage_started", phase: "formation", agent: "mindleak", atMs: 10 },
    { id: 2, type: "prospective_prediction", agent: "mindleak", caseId: "validation", expectedPass: false, applicable: false, atMs: 20 },
    { id: 3, type: "validation_completed", agent: "mindleak", caseId: "validation", correct: true, passed: false, atMs: 30 },
    { id: 4, type: "rediscovery_task_started", agent: "fresh", caseId: "one:fresh", phaseScope: "evaluation", atMs: 40 },
    { id: 5, type: "rediscovery_task_finished", agent: "fresh", caseId: "one:fresh", phaseScope: "evaluation", correct: true, atMs: 50 },
    { id: 6, type: "rediscovery_task_started", agent: "mindleak", caseId: "one:mindleak", phaseScope: "evaluation", atMs: 60 },
    { id: 7, type: "experience_access", agent: "mindleak", caseId: "one:mindleak", lessonIds: [], atMs: 65 },
    { id: 8, type: "rediscovery_task_finished", agent: "mindleak", caseId: "one:mindleak", phaseScope: "evaluation", correct: true, reuseObserved: false, atMs: 70 },
    { id: 9, type: "stage_started", phase: "review", agent: "mindleak", atMs: 80 },
    { id: 10, type: "run_finished", atMs: 100 },
  ] };
  const recording = normalizeRecording(report);
  assert.equal(lab3Story({ report: { kind: "memory_lab" } }, 100), null, "Labs 1 and 2 retain their existing stage");
  const pending = lab3Story(recording, 15);
  assert.equal(pending.phase, "form");
  assert.ok(pending.cases[0].arms.every(arm => arm.state === "queued"));
  assert.equal(pending.prediction, null);
  const predicted = lab3Story(recording, 25);
  assert.equal(predicted.prediction.expectedPass, false);
  assert.equal(predicted.prediction.verdict, null, "no future result before the reserved check");
  const checked = lab3Story(recording, 35);
  assert.equal(checked.prediction.verdict, "matched");
  assert.equal(checked.prediction.actualPass, false, "a correctly predicted boundary failure is not a passing task");
  const active = lab3Story(recording, 62);
  assert.equal(active.cases[0].arms[0].state, "passed");
  assert.equal(active.cases[0].arms[1].state, "working");
  assert.equal(active.currentCase, "one");
  assert.equal(active.nextMoment, 70);
  const final = lab3Story(recording, 100);
  assert.equal(final.phase, "finished");
  assert.equal(final.cases[0].arms[1].reused, false);
  assert.equal(final.cases[0].arms[1].retrieval, "miss");
  assert.deepEqual(lab3Story(recording, 15), pending, "seeking backward must reconstruct the earlier case board");
});

test("live stage progresses from actual work without revealing future knowledge or counting revisions twice", async () => {
  const { runActivity } = await import("./demo-view.mjs");
  const recording = normalizeRecording({ kind: "rediscovery_lab", runId: randomUUID(), status: "completed", elapsedMs: 60,
    agents: [{ id: "mindleak", name: "MindLeak" }], plan: { preparationTasks: 0, sessions: [{ id: "task" }] },
    knowledge: { observations: [{ memoryId: "source", fragments: [{ fragmentId: "fact", text: "Synthetic source" }] }],
      chains: [{ chainId: "chain", revision: 2, state: "accepted", document: { kind: "chain", evidence: [{ fragmentId: "fact", role: "supports" }], supportedBy: [] } }],
      principles: [{ chainId: "principle", revision: 4, state: "accepted", document: { kind: "principle", evidence: [], supportedBy: [{ chainId: "chain", revision: 2 }] } }] },
    events: [{ atMs: 0, type: "run_started" }, { atMs: 1, type: "agent_state", agent: "mindleak", state: "running" },
      { atMs: 2, type: "tool_started", agent: "mindleak", tool: "read_file", toolCallId: "read" },
      { atMs: 5, type: "tool_finished", agent: "mindleak", tool: "read_file", toolCallId: "read", ok: true },
      { atMs: 10, type: "knowledge_written", kind: "observation", nodeId: "source", memoryId: "source", operation: "write" },
      { atMs: 20, type: "knowledge_written", kind: "chain", nodeId: "chain", memoryId: "chain-write", operation: "accept", state: "accepted", revision: 2 },
      { atMs: 30, type: "knowledge_written", kind: "principle", nodeId: "principle", memoryId: "principle-write", operation: "propose", state: "candidate", revision: 1 },
      { atMs: 40, type: "knowledge_written", kind: "principle", nodeId: "principle", memoryId: "principle-accept", operation: "accept", state: "accepted", revision: 2 },
      { atMs: 45, type: "rediscovery_task_finished", phaseScope: "evaluation", agent: "mindleak", caseId: "task", correct: true, reuseObserved: true },
      { atMs: 50, type: "knowledge_written", kind: "principle", nodeId: "principle", memoryId: "principle-revision", operation: "accept", state: "accepted", revision: 4 },
      { atMs: 60, type: "run_finished", status: "completed" }] });
  assert.equal(runActivity(recording, 3).actions, 0);
  assert.equal(runActivity(recording, 3).knowledge.observations.length, 0);
  const growing = runActivity(recording, 25);
  assert.equal(growing.actions, 1);
  assert.equal(growing.knowledge.observations.length, 1);
  assert.equal(growing.knowledge.chains.length, 1);
  assert.equal(growing.knowledge.principles.length, 0);
  assert.equal(runActivity(recording, 35).acceptedPrinciples, 0);
  const finished = runActivity(recording, 60);
  assert.equal(finished.acceptedPrinciples, 1);
  assert.equal(finished.gained.principles, 1);
  assert.equal(finished.completedTasks, 1);
  assert.equal(finished.successfulTasks, 1);
  assert.equal(finished.scheduledTasks, 1);
  assert.equal(finished.reusedTasks, 1);
  recording.report.knowledgeBaseline = { principles: [{ id: "principle", revision: 2, state: "accepted" }] };
  const continued = runActivity(recording, 60);
  assert.equal(continued.inherited.principles, 1);
  assert.equal(continued.gained.principles, 0, "refining inherited knowledge is not a new principle");
});

test("memory motion reflects real operations and stops when paused finished or cancelled", async () => {
  const { memoryActivity } = await import("./demo-view.mjs");
  const recording = { agents: [{ id: "atlas" }, { id: "dalek-1", control: true }, { id: "notebook", connectToMemory: false }], events: [
    { atMs: 1, type: "tool_started", agent: "atlas", toolCallId: "read", tool: "recall_guide" },
    { atMs: 2, type: "inference_started", workload: "memory", requestId: "extraction" },
    { atMs: 3, type: "tool_started", agent: "dalek-1", toolCallId: "control", tool: "recall_guide" },
    { atMs: 4, type: "experience_access", agent: "notebook", lessonIds: ["notebook-note"], level: "principle" },
    { atMs: 10, type: "tool_finished", agent: "atlas", toolCallId: "read", tool: "recall_guide", ok: true },
    { atMs: 11, type: "tool_started", agent: "atlas", toolCallId: "write", tool: "propose_chain" },
    { atMs: 20, type: "knowledge_written", agent: "atlas", kind: "chain", nodeId: "chain-1", operation: "propose", memoryId: "write-1" },
    { atMs: 20.1, type: "memory_saved", agent: "atlas", memoryId: "write-1", fragments: 1 },
    { atMs: 21, type: "tool_finished", agent: "atlas", toolCallId: "write", tool: "propose_chain", ok: true },
    { atMs: 22, type: "inference_finished", workload: "memory", requestId: "extraction" },
    { atMs: 40, type: "run_finished", status: "completed" },
  ] };
  const reading = memoryActivity(recording, 5);
  assert.equal(reading.reading, 1);
  assert.equal(reading.processing, 1);
  assert.ok(reading.flows.every(flow => flow.agent !== "dalek-1" && flow.agent !== "notebook"));
  const forming = memoryActivity(recording, 15);
  assert.equal(forming.forming, 1);
  assert.equal(forming.reading, 0);
  assert.deepEqual(memoryActivity(recording, 25).pulses, [{ id: "write-1", agent: "atlas", kind: "chain", nodeId: "chain-1", atMs: 20.1 }], "the paired storage receipt must not replace the logical chain identity or count as a second arrival");
  assert.equal(memoryActivity(recording, 25, false).active, false);
  assert.equal(memoryActivity(recording, 41).active, false);
  assert.equal(memoryActivity({ ...recording, events: [...recording.events.slice(0, 2), { atMs: 6, type: "run_finished", status: "cancelled" }] }, 7).active, false);
  assert.equal(memoryActivity({ agents: [], events: [] }, 1000).active, false);
});

test("durable learning graph uses only real lineage and deduplicated recorded growth", async () => {
  const { knowledgeGraphData } = await import("./demo-view.mjs");
  const report = { knowledge: {
    observations: [{ memoryId: "source", fragments: [{ fragmentId: "fragment", text: "Verified source" }] }],
    chains: [{ chainId: "chain", revision: 2, state: "accepted", document: { kind: "chain", claim: "Source-backed explanation", evidence: [{ fragmentId: "fragment", role: "supports" }], supportedBy: [] } }],
    principles: [{ chainId: "principle", revision: 2, state: "accepted", document: { kind: "principle", claim: "Reusable procedure", evidence: [], supportedBy: [{ chainId: "chain", revision: 2 }] } }],
  }, events: [
    { type: "knowledge_written", kind: "observation", nodeId: "source", memoryId: "source", atMs: 10 },
    { type: "knowledge_written", kind: "observation", nodeId: "source", memoryId: "source", atMs: 15 },
    { type: "knowledge_written", kind: "chain", nodeId: "chain", memoryId: "chain-source", atMs: 20 },
    { type: "knowledge_written", kind: "principle", nodeId: "principle", memoryId: "principle-source", atMs: 30 },
    { type: "knowledge_written", kind: "principle", nodeId: "principle", memoryId: "accepted-revision", atMs: 40 },
  ] };
  const graph = knowledgeGraphData(report);
  assert.equal(graph.nodes.length, 3);
  assert.deepEqual(graph.edges.map(edge => [edge.from, edge.to, edge.role]), [["source", "chain", "supports"], ["chain", "principle", "supportedBy"]]);
  assert.equal(graph.history.at(-1).principles, 1, "revisions do not create new principles");
  assert.equal(graph.history.at(-1).observations, 1, "replayed receipts do not create new observations");
  assert.equal(graph.missingReferences, 0);
  assert.ok(graph.nodes.every(node => Number.isFinite(node.x) && Number.isFinite(node.y)));
  const incomplete = structuredClone(report);
  incomplete.knowledge.chains[0].document.evidence.push({ fragmentId: "not-delivered", role: "counterexample" });
  assert.equal(knowledgeGraphData(incomplete).missingReferences, 1);
  assert.equal(knowledgeGraphData(incomplete).edges.length, 2, "missing evidence must not be fabricated");
  assert.equal(knowledgeGraphData({}).nodes.length, 0);
});

test("knowledge formation distinguishes source evidence accepted beliefs and later reuse", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const chain = (id, fragmentId) => ({ chainId: id, revision: 2, state: "accepted", review: "reviewed", requiresReview: false,
    document: { kind: "chain", evidence: [{ fragmentId, role: "supports" }], supportedBy: [] } });
  const report = { kind: "memory_lab", knowledge: {
    observations: [{ memoryId: "source-a", fragments: [{ fragmentId: "fact-a" }, { fragmentId: "fact-b" }] },
      { memoryId: "source-b", fragments: [{ fragmentId: "fact-c" }] }],
    chains: [chain("chain-a", "fact-a"), chain("chain-b", "fact-c")],
    principles: [{ chainId: "principle", revision: 2, state: "accepted", review: "reviewed", requiresReview: false,
      document: { kind: "principle", evidence: [], supportedBy: [{ chainId: "chain-a", revision: 2 }, { chainId: "chain-b", revision: 2 }] } }],
  } };
  const formation = knowledgeMetrics(report).formation;
  assert.deepEqual(formation.observations, { stored: 2, supporting: 2 });
  assert.deepEqual(formation.chains, { stored: 2, accepted: 2, recordedAccepted: 2, candidates: 0, needsReview: 0, reviewUnknown: 0 });
  assert.deepEqual(formation.principles, { stored: 1, accepted: 1, recordedAccepted: 1, candidates: 0, needsReview: 0, reviewUnknown: 0 });
  assert.equal(formation.status, "principles_formed");
  assert.equal(knowledgeMetrics(report).capital.score, null, "formation is not demonstrated later reuse");
  const duplicate = structuredClone(report);
  duplicate.knowledge.observations.push(duplicate.knowledge.observations[0]);
  duplicate.knowledge.chains.push(duplicate.knowledge.chains[0]);
  assert.deepEqual(knowledgeMetrics(duplicate).formation, formation);
  const historical = structuredClone(report);
  for (const record of [...historical.knowledge.chains, ...historical.knowledge.principles]) delete record.review;
  const legacy = knowledgeMetrics(historical).formation;
  assert.equal(legacy.chains.recordedAccepted, 2);
  assert.equal(legacy.chains.accepted, 0);
  assert.equal(legacy.chains.reviewUnknown, 2);
  assert.equal(legacy.chains.needsReview, 0, "unavailable review metadata is not a recorded challenge or stale support");
  assert.equal(legacy.principles.reviewUnknown, 1);
  const sharedSource = structuredClone(report);
  sharedSource.knowledge.chains[1].document.evidence[0].fragmentId = "fact-b";
  assert.equal(knowledgeMetrics(sharedSource).formation.observations.supporting, 1,
    "two fragments from one episode are one source, not independent corroboration");
  for (const alter of [
    source => { source.knowledge.chains[0].state = "candidate"; },
    source => { source.knowledge.chains[0].review = "challenged"; },
    source => { source.knowledge.chains[0].requiresReview = true; },
    source => { source.knowledge.chains[0].revision = 3; },
    source => { source.knowledge.observations.shift(); },
    source => { source.knowledge.principles[0].document.supportedBy.pop(); },
    source => { source.knowledge.principles[0].document.supportedBy[1] = source.knowledge.principles[0].document.supportedBy[0]; },
  ]) {
    const invalid = structuredClone(report); alter(invalid);
    assert.equal(knowledgeMetrics(invalid).formation.principles.accepted, 0);
    assert.equal(knowledgeMetrics(invalid).formation.principles.needsReview, 1);
  }
  assert.equal(knowledgeMetrics({}).formation.status, "awaiting_observations");
  assert.equal(knowledgeMetrics({ memoryExhibits: [{ memoryId: "source" }] }).formation.status, "observations_captured");
});

test("knowledge metrics distinguish linked reuse transfer and unmeasured behavioral claims", async () => {
  const { knowledgeMetrics } = await import("./demo-view.mjs");
  const outcome = (agent, passed, applied, extra = {}) => ({ agent, passed, verification: { passed }, guideApplied: applied,
    guideRetrievedBeforeAssessment: true, finding: applied ? { guideStep: "Inspect the current API", path: "src/export.mjs", quote: "await result" } : null, ...extra });
  const report = { kind: "memory_lab", agents: [], events: [], knowledge: {
    observations: [{ memoryId: "observation-1" }, { memoryId: "observation-2" }],
    chains: [{ chainId: "chain-1", state: "accepted" }, { chainId: "chain-2", state: "accepted" }],
    principles: [{ chainId: "guide-1", state: "accepted", revision: 2 }],
  }, cases: [{ fixtureSha256: "preparation-case" }], controlExperiment: { plan: { pairs: Array.from({ length: 4 }, () => ({})), caseFamilies: 2 }, rounds: [
    { number: 1, frozen: { chainId: "guide-1", revision: 2, unchangedAfterComparison: true }, pairs: [
      { caseId: "new-case", withMemory: outcome("atlas", true, true, { fixtureSha256: "new-case" }), withoutMemory: outcome("dalek-1", true, false) },
      { caseId: "other-case", withMemory: outcome("iris", true, false, { fixtureSha256: "other-case" }), withoutMemory: outcome("dalek-2", false, false) },
    ] },
    { number: 2, frozen: { chainId: "guide-1", revision: 2, unchangedAfterComparison: true }, pairs: [
      { caseId: "old-case", withMemory: outcome("atlas", true, true, { fixtureSha256: "preparation-case" }), withoutMemory: outcome("dalek-1", true, false) },
      { caseId: "failed-case", withMemory: outcome("iris", false, false, { fixtureSha256: "failed-case", knowledgeReceived: true }), withoutMemory: outcome("dalek-2", true, false) },
    ] },
  ] } };
  const metrics = knowledgeMetrics(report);
  assert.equal(metrics.successfulTasks, 3);
  assert.equal(metrics.evaluatedTasks, 4);
  assert.equal(metrics.reuse.kind, "source_linked", "historical quotation evidence is not verified behavioral transfer");
  assert.equal(metrics.reuse.tasks, 2);
  assert.equal(metrics.reuse.rate, 2 / 3);
  assert.equal(metrics.transfer.successful, 1, "reusing a preparation case is not transfer");
  assert.equal(metrics.transfer.attempts, 1);
  assert.equal(metrics.transfer.rate, 1);
  assert.equal(metrics.chains.used, 0, "a principle reference is not observed direct chain use");
  assert.equal(metrics.chains.rate, null, "old records have no direct behavioral chain-use instrument");
  assert.deepEqual(metrics.compression, { observations: 2, chains: 2, principles: 1, observationsPerPrinciple: 2, semanticQuality: "not_measured" });
  assert.equal(metrics.mistakesAvoided.rate, null);
  assert.equal(metrics.timeToCorrectHypothesis.medianMs, null);
  assert.equal(metrics.capital.score, null);
  assert.deepEqual(metrics.curve.map(point => [point.round, point.withMemory, point.withoutMemory]), [[1, 1, 0.5], [2, 0.5, 1]]);
  assert.deepEqual(knowledgeMetrics({ ...report, controlExperiment: undefined }).curve, []);
  const invalid = structuredClone(report);
  invalid.controlExperiment.rounds[0].pairs[0].withMemory.guideRetrievedBeforeAssessment = false;
  assert.equal(knowledgeMetrics(invalid).reuse.tasks, 1);
  const inflated = structuredClone(report);
  inflated.knowledge.observations.push({ memoryId: "observation-1" });
  assert.equal(knowledgeMetrics(inflated).compression.observations, 2);
});

test("replay counters use only reported usage and seek without double counting", () => {
  const report = { kind: "swarm_build", agents: swarmRoles, elapsedMs: 1000, events: [
    { id: 1, atMs: 0, type: "inference_started", agent: "atlas", sessionId: "one", turn: 1 },
    { id: 2, atMs: 100, type: "inference_finished", agent: "atlas", sessionId: "one", turn: 1, inputTokens: 120, outputTokens: 30 },
    { id: 3, atMs: 150, type: "inference_finished", agent: "atlas", sessionId: "one", turn: 1, inputTokens: 120, outputTokens: 30 },
    { id: 4, atMs: 200, type: "inference_finished", agent: "iris", sessionId: "two", turn: 1, inputTokens: null, outputTokens: null },
    { id: 5, atMs: 300, type: "memory_delivered", agent: "nova", from: "atlas", fragments: 2 },
  ] };
  const recording = normalizeRecording(report);
  assert.equal(replayState(recording, 50).inputTokens, 0);
  const finished = replayState(recording, 1000);
  assert.equal(finished.inputTokens, 120);
  assert.equal(finished.outputTokens, 30);
  assert.equal(finished.unknownInput, true);
  assert.equal(finished.handoffs.size, 1);
  assert.equal(replayState(recording, 50).inputTokens, 0);
  assert.equal(formatElapsed(61500), "01:01.5");
});

test("replay separates memory SLM usage from frontier agent LLM usage", () => {
  const recording = normalizeRecording({ kind: "swarm_build", agents: swarmRoles, elapsedMs: 10, events: [
    { atMs: 1, type: "inference_finished", agent: "atlas", workload: "agent", sessionId: "a", turn: 1, inputTokens: 100, outputTokens: 25 },
    { atMs: 2, type: "inference_started", agent: "memory", workload: "memory", requestId: "glm-1", turn: "glm-1" },
    { atMs: 3, type: "inference_finished", agent: "memory", workload: "memory", requestId: "glm-1", turn: "glm-1", inputTokens: 40, outputTokens: 10 },
    { atMs: 4, type: "inference_finished", agent: "iris", workload: "agent", sessionId: "b", turn: 1, inputTokens: 70, outputTokens: 15 },
  ] });
  const state = replayState(recording, 10);
  assert.equal(state.inputTokens, 170);
  assert.equal(state.outputTokens, 40);
  assert.equal(state.memoryInputTokens, 40);
  assert.equal(state.memoryOutputTokens, 10);
  assert.equal(state.memoryInferences.size, 0);
  assert.equal(replayState(recording, 2).memoryInferences.size, 1);
});

test("Lab 2 replay tracks storage operations and real persistence checks", () => {
  const recording = normalizeRecording({ kind: "memory_lab", experiment: 2, agents: swarmRoles, elapsedMs: 20, events: [
    { id: 1, atMs: 1, type: "knowledge_written", kind: "observation", nodeId: "obs", operation: "write", memoryId: "obs", savedAt: "2026-09-17T10:00:00Z" },
    { id: 2, atMs: 2, type: "knowledge_written", kind: "chain", nodeId: "chain", revision: 1, operation: "propose", memoryId: "proposal" },
    { id: 3, atMs: 3, type: "knowledge_written", kind: "chain", nodeId: "chain", revision: 2, operation: "accept", memoryId: "acceptance" },
    { id: 4, atMs: 4, type: "knowledge_written", kind: "principle", nodeId: "guide", revision: 1, operation: "propose", memoryId: "guide-proposal" },
    { id: 5, atMs: 5, type: "persistence_verified", previousPid: 10, currentPid: 11, passed: true, checkedIds: ["obs", "chain", "guide"] },
    { id: 6, atMs: 6, type: "observation_inspected", agent: "nova", memoryId: "obs" },
    { id: 7, atMs: 7, type: "observation_inspected", agent: "nova", memoryId: "obs" },
    { id: 8, atMs: 8, type: "guide_applied", agent: "nova", chainId: "guide", revision: 2, steps: 2, sourceObservations: 2 },
  ] });
  const state = replayState(recording, 20);
  assert.equal(recording.memoryLab, true);
  assert.equal(recording.expectedTests, 40);
  assert.equal(state.storageOperations.length, 4);
  assert.equal(state.observationIds.size, 1);
  assert.equal(state.chainIds.size, 1);
  assert.equal(state.principleIds.size, 1);
  assert.equal(state.persistenceChecks.length, 1);
  assert.equal(state.inspectedObservations.size, 1);
  assert.equal(state.guideApplications.length, 1);
  assert.equal(replayState(recording, 3).principleIds.size, 0);
});

test("replay is self-contained, safely embeds data and refuses existing output", async () => {
  const report = { kind: "swarm_build", title: "</script><script>private-marker</script>", runId: "unit", agents: swarmRoles, events: [], elapsedMs: 1 };
  const html = await renderDemoPage({ report });
  assert.ok(html.includes("data:image/png;base64,"));
  assert.ok(html.includes("data:font/woff2;base64,"));
  assert.ok(html.includes("sandbox=\"allow-scripts allow-forms\""));
  assert.ok(!html.includes(report.title));
  assert.ok(!html.includes("{{DATA}}"));
  const opened = sandboxApplicationPage("<script>untrustedRecordingMarker()</script>");
  assert.ok(opened.includes('sandbox="allow-scripts allow-forms"'));
  const { parseHTML } = await import("linkedom");
  const page = parseHTML(html).document;
  assert.equal(page.title, "MindLeak Learning Lab");
  assert.match(page.querySelector("#nav-lab1").textContent, /Discover/);
  assert.match(page.querySelector("#nav-lab2").textContent, /Form/);
  assert.match(page.querySelector("#nav-lab3").textContent, /Reuse/);
  const formation = page.querySelector("#capital-template").content;
  assert.equal(formation.querySelector("h2").textContent, "Knowledge Formation");
  for (const stage of ["observations", "chains", "principles"]) assert.ok(formation.querySelector(`[data-formation="${stage}"]`));
  assert.ok(formation.querySelector("details [data-capital=score]"), "weighted index must be secondary to the hierarchy");
  const previewSource = parseHTML(opened).document.querySelector("iframe").getAttribute("src");
  assert.ok(decodeURIComponent(previewSource).includes("form-action &#39;none&#39;"));
  assert.ok(!opened.includes("allow-same-origin"));
  assert.ok(!opened.includes("<script>untrustedRecordingMarker"));
  const directory = await mkdtemp(join(tmpdir(), "mindleak-replay-test-"));
  try {
    const output = join(directory, "recording");
    await writeDemoReplay(report, output);
    await assert.rejects(writeDemoReplay(report, output), { code: "EEXIST" });
    assert.equal(JSON.parse(await readFile(join(output, "report.json"), "utf8")).runId, "unit");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("demo parameter selection pins per-agent models and rejects arbitrary providers", () => {
  const profiles = { agents: [{ id: "gpt-6-astra" }, { id: "claude-opus-5" }, { id: "mai-code-1.1-flash" }],
    memory: [{ id: "glm-4.7-flash:latest" }, { id: "off" }], defaults: { memoryModel: "glm-4.7-flash:latest",
      agentModels: Object.fromEntries(swarmRoles.map((role, index) => [role.id, index < 3 ? "gpt-6-astra" : "claude-opus-5"])) } };
  const first = selectDemoParameters(profiles);
  assert.equal(first.agentModels.atlas, "gpt-6-astra");
  assert.equal(first.agentModels.orion, "claude-opus-5");
  const next = selectDemoParameters(profiles, { agentModels: { ...first.agentModels, nova: "mai-code-1.1-flash" }, concurrency: 3 });
  assert.equal(next.agentModels.nova, "mai-code-1.1-flash");
  assert.equal(first.agentModels.nova, "gpt-6-astra");
  for (const input of [{ endpoint: "https://other.example" }, { concurrency: 6 }, { attempts: 0 }, { problem: "" },
    { agentModels: { ...first.agentModels, atlas: "auto" } }, { memoryModel: "unavailable" }]) assert.throws(() => selectDemoParameters(profiles, input));
});

test("live demo requires explicit local commands and preserves completed replay artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-live-test-"));
  let runs = 0;
  const server = await createDemoServer({ outputDirectory: directory, runBuild: async ({ onEvent }) => {
    runs += 1;
    const event = { id: 1, type: "run_finished", atMs: 1, status: "completed" };
    onEvent(event);
    return { reportVersion: 1, kind: "swarm_build", runId: randomUUID(), status: "completed", agents: swarmRoles, events: [event], elapsedMs: 1, realMcpProcess: false };
  } });
  try {
    assert.equal((await fetch(`${server.url}/state`)).status, 200);
    assert.equal(runs, 0);
    assert.equal((await fetch(`${server.url}/run`, { method: "POST", body: "{}" })).status, 403);
    assert.equal((await fetch(`${server.url}/run`, { method: "POST", headers: { origin: "https://other.example", "content-type": "application/json", "x-mindleak-demo": "1" }, body: "{}" })).status, 403);
    const finished = await server.startRun();
    assert.equal(runs, 1);
    assert.equal(finished.status, "completed");
    assert.ok((await readFile(join(finished.directory, "index.html"), "utf8")).includes("MindLeak Learning Lab"));
    assert.equal(JSON.parse(await readFile(join(finished.directory, "report.json"), "utf8")).realMcpProcess, false);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("one dashboard serves both labs and knowledge on one port without crossing runs", async () => {
  const { createLabHub } = await import("./swarm-demo.mjs");
  const root = await mkdtemp(join(tmpdir(), "mindleak-hub-test-"));
  const runs = [];
  const makeLab = id => ({ id, model: "test-double", outputDirectory: join(root, `lab${id}`),
    async runBuild(options) {
      runs.push(id);
      return { reportVersion: 1, kind: id === 2 ? "memory_lab" : "swarm_build", experiment: id, runId: randomUUID(),
        status: "completed", agents: [{ id: "atlas", name: "Atlas", title: "Test agent" }], events: [], elapsedMs: 1,
        finalTests: { passed: true, passedTests: 1, expectedTests: 1 }, parameters: options.parameters };
    } });
  const hub = await createLabHub({ labs: [makeLab(1), makeLab(2)], port: 0 });
  try {
    const first = await fetch(`${hub.url}/lab1/`);
    const second = await fetch(`${hub.url}/lab2/`);
    assert.equal(first.status, 200); assert.equal(second.status, 200);
    assert.ok((await first.text()).includes('"basePath":"/lab1"'));
    assert.ok((await second.text()).includes('"basePath":"/lab2"'));
    assert.equal(new URL((await fetch(`${hub.url}/learnings`)).url).pathname, "/lab2/learnings");
    assert.equal((await (await fetch(`${hub.url}/lab1/state`)).json()).report, null);
    await hub.labs.get(2).startRun();
    assert.deepEqual(runs, [2]);
    assert.equal((await (await fetch(`${hub.url}/lab1/state`)).json()).report, null);
    assert.equal((await (await fetch(`${hub.url}/lab2/state`)).json()).report.experiment, 2);
    assert.equal((await fetch(`${hub.url}/lab2/state`, { headers: { origin: "http://foreign.invalid" } })).status, 403);
  } finally { await hub.close(); await rm(root, { recursive: true, force: true }); }
});

test("native lab LAN access is opt-in and preserves exact host and origin guards", async () => {
  const { createLabHub } = await import("./swarm-demo.mjs");
  const { request } = await import("node:http");
  const root = await mkdtemp(join(tmpdir(), "mindleak-lan-test-"));
  const publicOrigin = "http://192.168.68.63:51722";
  const initialReport = { kind: "swarm_build", runId: randomUUID(), status: "completed", agents: swarmRoles, events: [], elapsedMs: 1 };
  let runs = 0;
  const makeLab = id => ({ id, outputDirectory: join(root, `lab${id}`), initialReport,
    runBuild: async () => { runs += 1; throw new Error("network_checks_must_not_start_work"); } });
  const probe = (url, headers = {}, method = "GET") => new Promise((resolveProbe, reject) => {
    const outgoing = request(url, { headers, method }, response => {
      let body = ""; response.setEncoding("utf8");
      response.on("data", chunk => { body += chunk; if (response.headers["content-type"] === "text/event-stream") { resolveProbe({ status: response.statusCode, headers: response.headers, body }); outgoing.destroy(); } });
      response.on("end", () => resolveProbe({ status: response.statusCode, headers: response.headers, body }));
    });
    outgoing.on("error", reject); outgoing.setTimeout(5000, () => outgoing.destroy(new Error("probe_timeout")));
    outgoing.end(method === "POST" ? "{}" : undefined);
  });
  const local = await createDemoServer({ ...makeLab(1), port: 0 });
  let hub;
  try {
    assert.equal((await probe(`${local.url}/state`, { host: new URL(publicOrigin).host })).status, 403);
    await local.close();
    hub = await createLabHub({ labs: [makeLab(1), makeLab(2), makeLab(3)], port: 0, listenHost: "0.0.0.0", publicOrigin });
    for (const lab of [1, 2, 3]) for (const path of ["/", "/state", "/report.json", "/learnings", "/replay", "/events"]) {
      const response = await probe(`${hub.url}/lab${lab}${path}`, { host: new URL(publicOrigin).host, origin: publicOrigin });
      assert.equal(response.status, 200, `configured LAN route /lab${lab}${path}`);
      assert.equal(response.headers["access-control-allow-origin"], undefined);
    }
    const page = await probe(`${hub.url}/lab3/`, { host: new URL(publicOrigin).host });
    assert.ok(page.body.includes('"lab1":"/lab1/"'), "navigation must stay on the browser origin");
    assert.ok(page.body.includes('"basePath":"/lab3"'), "SSE and command paths remain same-origin");
    assert.equal((await probe(`${hub.url}/lab3/state`)).status, 200);
    const localhost = `localhost:${new URL(hub.url).port}`;
    assert.equal((await probe(`${hub.url}/lab3/state`, { host: localhost, origin: `http://${localhost}` })).status, 200);
    for (const headers of [{ host: "attacker.invalid" }, { host: new URL(publicOrigin).host, origin: "http://attacker.invalid" },
      { host: new URL(publicOrigin).host, origin: "null" }, { host: "192.168.68.64:51722" }, { "x-forwarded-host": new URL(publicOrigin).host }]) {
      assert.equal((await probe(`${hub.url}/lab3/state`, headers)).status, 403);
      assert.equal((await probe(`${hub.url}/lab3/run`, { ...headers, "content-type": "application/json", "x-mindleak-demo": "1" }, "POST")).status, 403);
    }
    assert.equal((await probe(`${hub.url}/lab3/run`, { host: new URL(publicOrigin).host }, "POST")).status, 403);
    assert.equal((await probe(`${hub.url}/lab3/stop`, { host: new URL(publicOrigin).host, origin: publicOrigin, "content-type": "application/json", "x-mindleak-demo": "1" }, "POST")).status, 409);
    assert.equal(runs, 0);
    for (const options of [{ listenHost: "0.0.0.0" }, { publicOrigin }, { listenHost: "0.0.0.0", publicOrigin: "http://203.0.113.10:51722" },
      { listenHost: "0.0.0.0", publicOrigin: "https://192.168.68.63:51722" }, { listenHost: "0.0.0.0", publicOrigin: `${publicOrigin}/path` },
      { listenHost: "0.0.0.0", publicOrigin: "http://user:password@192.168.68.63:51722" }]) {
      await assert.rejects(createDemoServer({ ...makeLab(1), port: 0, ...options }), /invalid_lab_listener/);
    }
  } finally { if (hub) await hub.close(); else await local.close(); await rm(root, { recursive: true, force: true }); }
});

test("LAN commands stream live changes through the same native lab without model calls", { timeout: 10000 }, async () => {
  const { request } = await import("node:http");
  const directory = await mkdtemp(join(tmpdir(), "mindleak-lan-events-"));
  const publicOrigin = "http://192.168.68.63:51722";
  const headers = { host: new URL(publicOrigin).host, origin: publicOrigin };
  const connected = Promise.withResolvers(); const started = Promise.withResolvers(); const observed = Promise.withResolvers(); const stopped = Promise.withResolvers();
  let runs = 0;
  const server = await createDemoServer({ outputDirectory: directory, listenHost: "0.0.0.0", publicOrigin,
    runBuild: async options => {
      runs += 1;
      const event = { id: 1, atMs: 1, type: "knowledge_written", agent: "atlas", kind: "observation", nodeId: "lan-source", memoryId: "lan-source", operation: "write" };
      started.resolve(() => options.onEvent(event));
      await new Promise(resolveStop => { if (options.signal.aborted) resolveStop(); else options.signal.addEventListener("abort", resolveStop, { once: true }); });
      return { kind: "swarm_build", runId: randomUUID(), status: "cancelled", realModel: false, realMcpProcess: false,
        agents: swarmRoles, events: [event], elapsedMs: 1 };
    } });
  const stream = request(`${server.url}/events`, { headers }, response => {
    if (response.statusCode !== 200) { connected.reject(new Error("event_stream_refused")); response.resume(); return; }
    connected.resolve(); response.setEncoding("utf8"); let pending = "";
    response.on("data", chunk => {
      pending += chunk; let end;
      while ((end = pending.indexOf("\n\n")) !== -1) {
        const lines = pending.slice(0, end).split("\n"); pending = pending.slice(end + 2);
        const kind = lines.find(line => line.startsWith("event: "))?.slice(7);
        const data = JSON.parse(lines.find(line => line.startsWith("data: ")).slice(6));
        if (kind === "record" && data.nodeId === "lan-source") observed.resolve(data);
        if (kind === "snapshot" && data.report?.status === "cancelled" && !data.running) stopped.resolve(data);
      }
    });
  });
  stream.on("error", error => { connected.reject(error); observed.reject(error); stopped.reject(error); });
  stream.setTimeout(5000, () => stream.destroy(new Error("event_stream_timeout"))); stream.end();
  const command = path => new Promise((resolveCommand, reject) => {
    const outgoing = request(`${server.url}/${path}`, { method: "POST", headers: { ...headers, "content-type": "application/json", "x-mindleak-demo": "1" } }, response => {
      response.resume(); response.on("end", () => resolveCommand(response.statusCode));
    });
    outgoing.on("error", reject); outgoing.end("{}");
  });
  try {
    await connected.promise; assert.equal(runs, 0);
    assert.equal(await command("run"), 202); const emit = await started.promise; emit();
    assert.equal((await observed.promise).memoryId, "lan-source");
    assert.equal(server.snapshot().running, true);
    assert.equal(await command("stop"), 202);
    assert.equal((await stopped.promise).report.realModel, false); assert.equal(runs, 1);
  } finally { stream.destroy(); await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("live continuation requires an explicit matching parent and retains the study lineage", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-continuation-"));
  const parents = [];
  const server = await createDemoServer({ outputDirectory: directory, runBuild: async options => {
    parents.push(options.parent?.runId ?? null);
    return { kind: "swarm_build", runId: randomUUID(), createdAt: new Date().toISOString(), status: "completed", agents: swarmRoles,
      events: [], elapsedMs: 1, summary: { inputTokens: 10, outputTokens: 1 } };
  } });
  try {
    const first = await server.startRun();
    await assert.rejects(server.startRun({ continueFrom: randomUUID() }), /continuation_parent_mismatch/);
    const second = await server.startRun({ continueFrom: first.runId });
    assert.deepEqual(parents, [null, first.runId]);
    const report = JSON.parse(await readFile(join(second.directory, "report.json"), "utf8"));
    assert.equal(report.study.parentRunId, first.runId);
    assert.equal(report.study.sequence, 2);
    assert.equal(report.study.totals.inputTokens, 20);
    const fresh = await server.startRun();
    const freshReport = JSON.parse(await readFile(join(fresh.directory, "report.json"), "utf8"));
    assert.equal(freshReport.study.parentRunId, null);
    assert.equal(freshReport.study.sequence, 1);
    assert.equal(parents[2], null);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("live run archives retain evidence and parameters after failure or cancellation", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-run-archive-"));
  let invocation = 0;
  const entered = Promise.withResolvers();
  const server = await createDemoServer({ outputDirectory: directory, runBuild: async options => {
    invocation += 1;
    options.onEvent({ id: 1, atMs: 0, type: "run_started", runId: `archived-${invocation}` });
    options.onMemory({ memoryId: `memory-${invocation}`, agent: "atlas", fragments: [{ fragmentId: "source", text: "Synthetic retained source evidence." }] });
    options.onToolDetail({ toolCallId: `tool-${invocation}`, agent: "atlas", tool: "read_file", arguments: { path: "src/expiry.mjs" } });
    options.onKnowledge({ observations: [{ memoryId: `memory-${invocation}`, rawText: "Synthetic retained source evidence." }], chains: [], principles: [] });
    if (invocation === 3) {
      entered.resolve();
      await new Promise((resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }));
    }
    throw new Error("controlled test interruption");
  } });
  try {
    const first = await server.startRun();
    const original = await readFile(join(first.directory, "partial-report.json"), "utf8");
    const manifest = JSON.parse(await readFile(join(first.directory, "run.json"), "utf8"));
    assert.equal(manifest.captureVersion, 1);
    assert.ok(manifest.parameters.problem);
    const journal = (await readFile(join(first.directory, "evidence.ndjson"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
    assert.deepEqual(journal.map(entry => entry.kind), ["memory", "tool-detail", "knowledge"]);
    assert.ok(journal.every(entry => Number.isFinite(Date.parse(entry.recordedAt))));
    assert.equal(journal[0].data.memoryId, "memory-1");
    assert.ok(!String(await readFile(join(first.directory, "events.ndjson"))).includes("Synthetic retained source evidence"));
    const second = await server.startRun();
    assert.notEqual(second.directory, first.directory);
    assert.equal(await readFile(join(first.directory, "partial-report.json"), "utf8"), original);
    const pending = server.startRun();
    await entered.promise;
    await server.close();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    assert.ok((await readFile(join(cancelled.directory, "evidence.ndjson"), "utf8")).includes("memory-3"));
  } finally { if (invocation !== 3) await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("live demo reopens a saved recording without starting agents", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-reopen-test-"));
  const recording = { kind: "swarm_build", runId: "saved-run", status: "completed", agents: swarmRoles, events: [], elapsedMs: 1, realMcpProcess: false };
  let runs = 0;
  const server = await createDemoServer({ outputDirectory: directory, initialReport: recording,
    runBuild: async () => { runs += 1; throw new Error("not requested"); } });
  try {
    assert.deepEqual((await fetch(`${server.url}/state`).then(response => response.json())).report, recording);
    assert.deepEqual(await fetch(`${server.url}/report.json`).then(response => response.json()), recording);
    const replay = await fetch(`${server.url}/replay`).then(response => response.text());
    assert.ok(replay.includes('"live":false'));
    assert.ok(replay.includes('"runId":"saved-run"'));
    assert.equal(runs, 0);
  } finally { await server.close(); await rm(directory, { recursive: true, force: true }); }
});

test("coding tools disclose the actual edit allowlist without making tests writable", async () => {
  for (const kind of ["coding_workflow", "rediscovery_demo"]) {
    const workspace = await createCodingWorkspace(kind, null);
    try {
      const edit = agentTools(null, workspace).find(tool => tool.definition.function.name === "write_file");
      assert.deepEqual(edit.definition.function.parameters.properties.path.enum, codingFixture(kind).editable);
      assert.ok(!edit.definition.function.parameters.properties.path.enum.some(path => path.startsWith("tests/")));
      assert.equal(edit.definition.function.parameters.properties.content.maxLength, 32768);
    } finally { await workspace.close(); }
  }
});

test("coding handoff briefs preserve subjects and allow only known fixture paths", async () => {
  const workspace = await createCodingWorkspace("rediscovery_demo", null);
  const memory = scopedMemory(memoryDouble(), "brief-scope", "agent-a");
  try {
    const store = agentTools(memory, workspace, { recall: false, write: true, handoffKind: "rediscovery_demo" })
      .find(tool => tool.definition.function.name === "write_memory");
    for (const field of ["rootCause", "files", "failedApproaches", "recommendedFix"]) assert.ok(store.definition.function.parameters.properties[field]);
    const brief = { rootCause: "TTL seconds were added to a millisecond timestamp.",
      files: ["src/data/sessionRepository.mjs", "src/domain/session.mjs"], failedApproaches: [],
      recommendedFix: "Convert the TTL from seconds to milliseconds before addition." };
    await store.invoke(brief);
    const written = memory.observations.writes[0];
    assert.ok(written.fragments.every(fragment => fragment.text.startsWith("Session expiry investigation:")));
    assert.equal(memory.observations.handoffBriefs[0].rootCausePresent, true);
    assert.deepEqual(memory.observations.handoffBriefs[0].files, brief.files);
    await assert.rejects(store.invoke({ ...brief, files: ["../../private"] }), /invalid_handoff_brief/);
    assert.equal(memory.observations.writes.length, 1);
  } finally { await workspace.close(); }
});

test("rediscovery readiness needs observed files and a verified fix, not a completion claim", () => {
  const files = ["src/data/sessionRepository.mjs", "src/domain/session.mjs"];
  const briefs = [{ files, rootCausePresent: true, recommendationPresent: true, failedApproachCount: 0 }];
  const execution = { status: "completed", trace: files.map(fixturePath => ({ tool: "read_file", ok: true, fixturePath })) };
  assert.equal(verifyCodingPreparation("rediscovery_demo", execution, briefs, { passed: false }).ready, false);
  assert.equal(verifyCodingPreparation("rediscovery_demo", { ...execution, trace: [] }, briefs, { passed: true }).ready, false);
  assert.equal(verifyCodingPreparation("rediscovery_demo", execution, [], { passed: true }).ready, false);
  const ready = verifyCodingPreparation("rediscovery_demo", execution, briefs, { passed: true });
  assert.equal(ready.ready, true);
  assert.equal(ready.independentlyAdjudicatedExplanations, false);
  assert.equal(verifyCodingPreparation("rediscovery_demo", execution, [{ ...briefs[0], failedApproachCount: 1 }], { passed: true }).ready, false);
});

test("baseline agent tools cannot access memory and malformed provenance fails closed", async () => {
  const memory = scopedMemory({ async call() { return { data: { results: [{ text: "wrong scope" }] } }; } }, "test-scope", "agent-a");
  assert.deepEqual(agentTools(null, null), []);
  assert.deepEqual(agentTools(memory, null, { recall: false, write: true }).map(tool => tool.definition.function.name), ["write_memory"]);
  await assert.rejects(memory.recall("query"), /invalid_recall_provenance/);
});

test("agent recall controls are mode-aware, scoped, and do not silently change strategy", async () => {
  const calls = [];
  const driver = { configuration: { retrieval: "keyword" }, async call(name, args) {
    calls.push({ name, args });
    return { data: { results: [] }, elapsedMs: 1, resultBytes: 14 };
  } };
  const memory = scopedMemory(driver, "owned-scope", "agent-b");
  const tools = agentTools(memory, null);
  const search = tools.find(tool => tool.definition.function.name === "recall_memory");
  assert.match(search.definition.function.description, /keyword/);
  for (const field of ["matchMode", "contextLimit", "diagnostics", "groupDuplicates"]) {
    assert.ok(search.definition.function.parameters.properties[field]);
  }
  assert.ok(tools.some(tool => tool.definition.function.name === "inspect_source"));
  await search.invoke({ query: "Orion requirements", matchMode: "all", diagnostics: true, contextLimit: 2, groupDuplicates: true });
  await search.invoke({ query: "Orion", matchMode: "any" });
  await assert.rejects(search.invoke({ query: "third empty attempt" }), /empty_recall_budget/);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].args.scope, "owned-scope");
  assert.equal(calls[0].args.matchMode, "all");
  assert.equal(calls[0].args.contextLimit, 2);
  assert.equal(calls[0].args.groupDuplicates, true);
  assert.equal(calls[1].args.matchMode, "any");
  await assert.rejects(memory.recall("Orion", 5, { scope: "other" }), /invalid_recall_options/);
  assert.equal(calls.length, 2);
});

test("nested document and duplicate provenance must stay in the requested scope", async () => {
  const primary = { fragmentId: randomUUID(), memoryId: randomUUID(), agentId: "agent-a", text: "fact", score: 0.5, context: { scope: "owned" } };
  for (const nested of [
    { documentContext: { fragments: [{ ...primary, fragmentId: randomUUID(), context: { scope: "foreign" } }] } },
    { duplicateSources: [{ ...primary, fragmentId: randomUUID(), context: { scope: "foreign" } }] },
    { relationships: [{ ...primary, fragmentId: randomUUID(), context: { scope: "foreign" } }] },
  ]) {
    const memory = scopedMemory({ async call() { return { data: { results: [{ ...primary, ...nested }] } }; } }, "owned", "agent-b");
    await assert.rejects(memory.recall("fact"), /invalid_recall_provenance/);
    assert.equal(memory.observations.recalled.size, 0);
  }
});

test("oversized recall results cannot be credited as agent exposure", async () => {
  const memory = scopedMemory({ configuration: { retrieval: "keyword" }, async call() {
    return { data: { results: Array.from({ length: 5 }, () => ({ fragmentId: randomUUID(), memoryId: randomUUID(),
      agentId: "a", text: "\u0001".repeat(4096), context: { scope: "owned" }, score: 0.5 })) } };
  } }, "owned", "agent-b");
  const search = agentTools(memory, null)[0];
  await assert.rejects(search.invoke({ query: "fact" }), /agent_tool_result_budget/);
  assert.equal(memory.observations.recalled.size, 5);
  assert.equal(memory.observations.exposed.size, 0);
});

test("agent answer validation reports bounded constraint paths without private values", async () => {
  const { contractViolations } = await import("./validation-agent.mjs");
  const schema = { type: "object", additionalProperties: false, properties: { reasons: { type: "array", items: {
    type: "object", additionalProperties: false, properties: { reason: { type: "string", maxLength: 10 } }, required: ["reason"],
  } } }, required: ["reasons"] };
  const content = JSON.stringify({ reasons: [{ reason: "private-rejected-value", "private-unknown-field": "private-body" }] });
  const violations = [{ path: "$.reasons[0].reason", code: "maxLength" }, { path: "$.reasons[0]", code: "additionalProperties" }];
  assert.deepEqual(contractViolations(JSON.parse(content), schema), violations);
  assert.equal(contractViolations({ reasons: Array.from({ length: 100 }, () => ({ reason: "private-rejected-value" })) }, schema).length, 8);
  assert.deepEqual(contractViolations({ reasons: [{ reason: "valid" }] }, schema), []);
  const provider = { models: [{ id: "gpt-6-astra" }], client: { async createSession() {
    let handler;
    return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {}, async sendAndWait() {
      handler({ type: "assistant.usage", id: "safe-validation", data: { model: "gpt-6-astra", inputTokens: 1, outputTokens: 1, finishReason: "stop" } });
      return { data: { content } };
    } };
  }, async deleteSession() {} } };
  const responses = [await createCopilotAgent(provider).run("Validate the supplied schema", [], "", schema),
    await runAgentSession({ task: "Validate the supplied schema", answerSchema: schema, complete: async () => ({
      usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: "stop", message: { content } }],
    }) })];
  for (const response of responses) {
    assert.equal(response.status, "invalid_answer");
    assert.equal(response.answer, null);
    assert.deepEqual(response.failure, { code: "invalid_answer_schema", violations });
    assert.ok(!JSON.stringify(publicExecution(response)).includes("private-"));
    assert.equal(response.responses.length, 1, "invalid output must not silently add retries");
  }
});

test("agent sessions start fresh, count actual tool use, and do not export answer bodies", async () => {
  const requests = [];
  const complete = async request => {
    requests.push(request);
    return { usage: { prompt_tokens: 20, completion_tokens: 5 }, choices: [{ finish_reason: "stop", message: { content: '{"language":"Rust"}' } }] };
  };
  const first = await runAgentSession({ task: "task one", complete, inputPrice: 1, outputPrice: 2 });
  const second = await runAgentSession({ task: "task two", complete });
  assert.notEqual(first.sessionId, second.sessionId);
  assert.equal(requests[1].messages.length, 2);
  assert.ok(!JSON.stringify(requests[1]).includes("task one"));
  assert.equal(first.inputTokens, 20);
  assert.equal(first.costUsd, 0.00003);
  assert.equal(second.costUsd, null);
  assert.equal(Object.hasOwn(publicExecution(first), "answer"), false);
});

test("agent telemetry streams real timings and usage without tool or provider bodies", async () => {
  const events = [];
  let calls = 0;
  const result = await runAgentSession({ task: "private-task-body", onEvent: event => events.push(event),
    tools: [{ definition: { type: "function", function: { name: "run_tests", parameters: { type: "object", properties: {}, required: [] } } },
      async invoke() { return { passed: true, tests: 3, passedTests: 3, expectedTests: 3, private: "private-tool-body" }; } }],
    complete: async () => {
      calls += 1;
      return { usage: { prompt_tokens: 10, completion_tokens: 4 }, choices: [{ finish_reason: calls === 1 ? "tool_calls" : "stop",
        message: calls === 1 ? { tool_calls: [{ id: "test-call", type: "function", function: { name: "run_tests", arguments: "{}" } }] }
          : { content: '{"completed":true}' } }] };
    } });
  assert.equal(result.status, "completed");
  assert.equal(events.filter(event => event.type === "inference_finished").length, 3);
  assert.equal(events.filter(event => event.type === "tool_finished").length, 1);
  assert.ok(events.every(event => event.sessionId === result.sessionId && Number.isFinite(event.startedMs)));
  assert.equal(events.filter(event => event.type === "inference_finished").reduce((total, event) => total + event.inputTokens, 0), result.inputTokens);
  const tests = events.find(event => event.type === "tool_finished");
  assert.equal(tests.testsPassed, true);
  assert.equal(tests.passedTests, 3);
  assert.ok(!JSON.stringify(events).includes("private-task-body"));
  assert.ok(!JSON.stringify(events).includes("private-tool-body"));
  assert.ok(!JSON.stringify(events).includes('"completed":true'));
});

test("frontier adapter exposes only demo tools and counts exact advertised model usage", async () => {
  const events = [];
  let configuration;
  let deleted;
  const provider = { models: [{ id: "gpt-6-astra" }], client: {
    async createSession(config) {
      configuration = config;
      let handler;
      return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {},
        async sendAndWait() {
          handler({ type: "assistant.turn_start", data: { turnId: "1", model: "gpt-6-astra" } });
          const result = await config.tools[0].handler({ path: "src/expiry.mjs" });
          assert.equal(result.resultType, "success");
          const blocked = await config.tools[1].handler({ path: "src/expiry.mjs" });
          assert.equal(blocked.resultType, "failure");
          assert.equal(JSON.parse(blocked.textResultForLlm).error, "prior_experience_search_required");
          const dependency = await config.tools[1].handler({ path: "src/store.mjs" });
          assert.equal(JSON.parse(dependency.textResultForLlm).error, "dependency_handoffs_required");
          const publication = await config.tools[1].handler({ path: "src/view.mjs" });
          assert.equal(JSON.parse(publication.textResultForLlm).error, "handoff_module_required");
          const unread = await config.tools[1].handler({ path: "src/validation.mjs" });
          assert.equal(JSON.parse(unread.textResultForLlm).error, "dependency_source_files_required");
          const irrelevant = await config.tools[1].handler({ path: "src/app.mjs" });
          assert.equal(JSON.parse(irrelevant.textResultForLlm).error, "dependency_source_evidence_required");
          const missingPrinciple = await config.tools[1].handler({ path: "missing-principle" });
          assert.equal(JSON.parse(missingPrinciple.textResultForLlm).error, "principle_required_before_assessment");
          assert.match(JSON.parse(missingPrinciple.textResultForLlm).guidance, /principleReferences/);
          const wrongReference = await config.tools[1].handler({ path: "wrong-guide-reference" });
          assert.equal(JSON.parse(wrongReference.textResultForLlm).error, "eligible_principle_reference_required");
          assert.match(JSON.parse(wrongReference.textResultForLlm).guidance, /applicationGuides/);
          handler({ id: "usage-1", type: "assistant.usage", data: { model: "gpt-6-astra", inputTokens: 120, outputTokens: 30, duration: 4, finishReason: "stop" } });
          return { data: { content: '{"completed":true}' } };
        } };
    }, async deleteSession(id) { deleted = id; },
  } };
  const agent = createCopilotAgent(provider);
  const result = await agent.run("private-task", [{ definition: { function: { name: "read_file", description: "Read fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    async invoke() { return "private-file-body"; } }, { definition: { function: { name: "write_file", description: "Edit after assessment", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    async invoke({ path }) {
      const codes = { "src/store.mjs": "dependency_handoffs_required", "src/view.mjs": "handoff_module_required",
        "src/validation.mjs": "dependency_source_files_required", "src/app.mjs": "dependency_source_evidence_required",
        "missing-principle": "principle_required_before_assessment", "wrong-guide-reference": "eligible_principle_reference_required" };
      throw new Error(codes[path] ?? "prior_experience_search_required");
    } }], "", answerSchemaFor("rediscovery_demo"), { onEvent: event => events.push(event) });
  assert.deepEqual(configuration.availableTools, ["custom:demo_read_file", "custom:demo_write_file"]);
  assert.deepEqual(configuration.excludedTools, ["builtin:*", "mcp:*"]);
  assert.equal(configuration.enableConfigDiscovery, false);
  assert.equal(configuration.skipCustomInstructions, true);
  assert.equal(configuration.enableSessionTelemetry, false);
  assert.equal(configuration.onPermissionRequest().kind, "denied-by-rules");
  assert.equal(result.status, "completed");
  assert.equal(result.inputTokens, 120);
  assert.equal(result.outputTokens, 30);
  assert.equal(deleted, result.sessionId);
  assert.ok(events.every(event => event.model === "gpt-6-astra" && event.workload === "agent"));
  assert.equal(result.trace[0].arguments.path, "src/expiry.mjs");
  assert.ok(!JSON.stringify(events).includes("private-file-body"));
  assert.ok(!JSON.stringify(events).includes("private-task"));
  assert.throws(() => createCopilotAgent(provider, { model: "unlisted-model" }), /unavailable/);
});

test("agent workflow failures retain actionable knowledge-first errors without private bodies", async () => {
  const codes = ["prior_experience_search_required", "experience_assessment_required", "current_source_evidence_required", "dependency_handoffs_required", "handoff_module_required",
    "dependency_source_files_required", "dependency_source_evidence_required", "guide_review_required", "guide_review_changed", "guide_review_budget", "finish_pending_principle_first", "inspect_existing_principles_first",
    "principle_required_before_assessment", "eligible_principle_reference_required"];
  const tools = codes.map(code => ({ definition: { type: "function", function: { name: code, description: "Test workflow gate", parameters: { type: "object", properties: {} } } }, async invoke() { throw new Error(code); } }));
  let turn = 0;
  const result = await runAgentSession({ task: "Test knowledge workflow errors", tools, maxSteps: 4, complete: async () => {
    turn += 1;
    const batch = codes.slice((turn - 1) * 6, turn * 6);
    return { usage: { prompt_tokens: 1, completion_tokens: 1 }, choices: [{ finish_reason: batch.length ? "tool_calls" : "stop", message: batch.length
      ? { tool_calls: batch.map(code => ({ id: code, type: "function", function: { name: code, arguments: "{}" } })) }
      : { content: '{"completed":false}' } }] };
  } });
  assert.deepEqual(result.trace.map(event => event.errorCode), codes);
});

test("frontier adapter distinguishes query dispatch failures without leaking provider diagnostics", async () => {
  let sends = 0;
  const provider = { models: [{ id: "gpt-6-astra" }], client: { async createSession() {
    let handler;
    return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {}, async sendAndWait() {
      sends += 1;
      handler({ type: "assistant.usage", id: "dispatch-failure", data: { model: "gpt-6-astra", inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" } });
      handler({ type: "session.error", data: { errorType: "query", message: "private-provider-message", stack: "private-provider-stack", statusCode: 400 } });
      return { data: { content: "private-incomplete-answer" } };
    } };
  }, async deleteSession() {} } };
  const result = await createCopilotAgent(provider).run("Handle the declared task", [], "", answerSchemaFor("rediscovery_demo"));
  assert.equal(result.status, "provider_error");
  assert.deepEqual(result.failure, { code: "copilot_query_failed", phase: "tool_dispatch", httpStatus: 400 });
  assert.equal(result.toolCalls, 0);
  assert.equal(result.inputTokens, null);
  assert.equal(sends, 1, "query failure is not a reason to resume tool-only idle");
  assert.ok(!JSON.stringify(result).includes("private-"));
});

test("frontier adapter distinguishes unfinished tool work and explicit runtime stops", async () => {
  for (const reason of ["idle_tools", "cancelled", "budget", "step_limit"]) {
    const events = [];
    let sends = 0;
    const provider = { models: [{ id: "gpt-6-astra" }], client: {
      async createSession() {
        let handler;
        return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {},
          async sendAndWait() {
            sends += 1;
            handler({ type: "assistant.turn_start", data: { turnId: "1" } });
            handler({ id: "usage", type: "assistant.usage", data: { model: "gpt-6-astra", inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" } });
            if (reason === "budget") handler({ type: "session_limits_exhausted.requested", data: { maxAiCredits: 30, usedAiCredits: 30 } });
            handler({ type: "session.idle", data: { aborted: reason === "cancelled" } });
            return { data: { content: "" } };
          } };
      }, async deleteSession() {},
    } };
    const result = await createCopilotAgent(provider, { maxSteps: reason === "step_limit" ? 1 : 20 }).run("synthetic task", [], "", answerSchemaFor("rediscovery_demo"), { onEvent: event => events.push(event) });
    assert.equal(result.status, reason === "cancelled" ? "cancelled" : reason === "budget" ? "budget_exceeded" : "incomplete");
    assert.equal(result.answer, null);
    assert.equal(result.responses.length, 1);
    assert.equal(sends, reason === "idle_tools" ? 2 : 1);
    assert.equal(result.generation.toolOnlyIdleResumes, reason === "idle_tools" ? 1 : 0);
    assert.ok(events.some(event => event.type === "session_stopped"));
  }
});

test("frontier adapter resumes tool-only idle in the same session without replaying acknowledged work", async () => {
  const events = [];
  const sends = [];
  let sessions = 0;
  let writes = 0;
  let deleted;
  const provider = { models: [{ id: "gpt-6-astra" }], client: {
    async createSession(configuration) {
      sessions += 1;
      let handler;
      return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {},
        async sendAndWait(message, timeout) {
          sends.push({ message, timeout });
          const first = sends.length === 1;
          handler({ type: "assistant.turn_start", data: { turnId: String(sends.length) } });
          if (first) {
            const receipt = await configuration.tools[0].handler({}, { toolCallId: "acknowledged-write" });
            assert.equal(receipt.resultType, "success");
          }
          handler({ id: `usage-${sends.length}`, type: "assistant.usage", data: { model: "gpt-6-astra",
            inputTokens: first ? 10 : 20, outputTokens: first ? 4 : 6, finishReason: first ? "tool_calls" : "stop" } });
          handler({ type: "session.idle", data: {} });
          return first ? undefined : { data: { content: '{"completed":true}' } };
        } };
    }, async deleteSession(id) { deleted = id; },
  } };
  const tools = [{ definition: { function: { name: "write_memory", description: "Store verified synthetic evidence",
    parameters: { type: "object", additionalProperties: false, properties: {}, required: [] } } },
    async invoke() { writes += 1; return { memoryId: "acknowledged-memory", fragments: [] }; } }];
  const result = await createCopilotAgent(provider, { maxSteps: 2, timeoutMs: 1000 }).run("private-review-task", tools, "",
    answerSchemaFor("rediscovery_demo"), { onEvent: event => events.push(event) });
  assert.equal(result.status, "completed");
  assert.deepEqual(result.answer, { completed: true });
  assert.equal(result.failure, null);
  assert.equal(sessions, 1);
  assert.equal(deleted, result.sessionId);
  assert.equal(writes, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.turns, 2);
  assert.equal(result.responses.length, 2);
  assert.equal(result.inputTokens, 30);
  assert.equal(result.outputTokens, 10);
  assert.equal(result.generation.toolOnlyIdleResumes, 1);
  assert.equal(sends.length, 2);
  assert.ok(sends[1].timeout > 0 && sends[1].timeout < sends[0].timeout);
  assert.ok(sends[0].timeout <= 1000);
  assert.notEqual(sends[1].message.prompt, sends[0].message.prompt);
  assert.equal(events.filter(event => event.type === "session_resumed").length, 1);
  assert.ok(!JSON.stringify(events).includes("private-review-task"));
});

test("frontier adapter does not renew the deadline after queued tool work finishes", async () => {
  let sends = 0;
  const provider = { models: [{ id: "gpt-6-astra" }], client: {
    async createSession(configuration) {
      let handler;
      return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {},
        async sendAndWait() {
          sends += 1;
          handler({ type: "assistant.turn_start", data: { turnId: "1" } });
          void configuration.tools[0].handler({});
          handler({ id: "usage", type: "assistant.usage", data: { model: "gpt-6-astra", inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" } });
          handler({ type: "session.idle", data: {} });
        } };
    }, async deleteSession() {},
  } };
  const tools = [{ definition: { function: { name: "probe", description: "Finish queued work", parameters: { type: "object", properties: {}, required: [] } } },
    async invoke() { await new Promise(resolve => setTimeout(resolve, 120)); return { ok: true }; } }];
  const result = await createCopilotAgent(provider, { timeoutMs: 100 }).run("synthetic task", tools, "", answerSchemaFor("rediscovery_demo"));
  assert.equal(sends, 1);
  assert.equal(result.status, "incomplete");
  assert.equal(result.generation.toolOnlyIdleResumes, 0);
  assert.equal(result.trace.length, 1);
  assert.equal(result.trace[0].ok, true);
});

test("frontier runtime cleanup reaps its owned child after interrupted graceful shutdown", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-runtime-cleanup-"));
  let forced = false;
  await writeFile(join(directory, "owned-state"), "fixture");
  const result = await closeCopilotRuntime({ async stop() { return [new Error("child already disconnected")]; }, async forceStop() { forced = true; } }, directory);
  assert.deepEqual(result, { closed: true, forced: true });
  assert.equal(forced, true);
  await assert.rejects(readFile(join(directory, "owned-state")), { code: "ENOENT" });
});

test("memory SLM observer preserves provider bytes and keeps content out of token events", async () => {
  let requests = 0;
  const responseBody = JSON.stringify({ model: "glm-test", usage: { prompt_tokens: 41, completion_tokens: 9 },
    choices: [{ finish_reason: "stop", message: { content: "private-extraction-body" } }] });
  const upstream = createServer((request, response) => {
    requests += 1;
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "application/json" }); response.end(responseBody); });
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const events = [];
  const observer = await openMemoryUsageObserver({ endpoint: `http://127.0.0.1:${upstream.address().port}/v1`, model: "glm-test", onEvent: event => events.push(event) });
  try {
    const options = { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${observer.apiKey}` },
      body: JSON.stringify({ model: "glm-test", messages: [{ role: "user", content: "private-memory-source" }] }) };
    assert.equal((await fetch(`${observer.endpoint}/chat/completions`, { ...options, headers: { "content-type": "application/json" } })).status, 403);
    const response = await fetch(`${observer.endpoint}/chat/completions`, options);
    assert.equal(await response.text(), responseBody);
    assert.equal(requests, 1);
    assert.equal(events.length, 2);
    assert.equal(events[1].inputTokens, 41);
    assert.equal(events[1].outputTokens, 9);
    assert.equal(events[1].workload, "memory");
    assert.equal(events[1].modelClass, "slm");
    assert.equal(events[1].model, "glm-test");
    assert.ok(!JSON.stringify(events).includes("private-memory-source"));
    assert.ok(!JSON.stringify(events).includes("private-extraction-body"));
    assert.ok(!JSON.stringify(events).includes(observer.apiKey));
  } finally { await observer.close(); await new Promise(resolve => upstream.close(resolve)); }
});

test("agent requests a structural answer schema and explicit recorded generation budgets", async () => {
  const answerSchema = { type: "object", properties: { language: { type: ["string", "null"] } },
    required: ["language"], additionalProperties: false };
  const result = await runAgentSession({ task: "Return the preferred language or null.", answerSchema,
    maxOutputTokens: 4096, reasoningEffort: "none", complete: async request => {
      assert.equal(request.max_tokens, 4096);
      assert.equal(request.reasoning_effort, "none");
      assert.deepEqual(request.response_format, { type: "json_schema", json_schema: {
        name: "validation_answer", strict: true, schema: answerSchema,
      } });
      assert.ok(!JSON.stringify(request).includes("Rust"), "the schema must not contain expected answers");
      return { usage: { prompt_tokens: 20, completion_tokens: 5 }, choices: [{ finish_reason: "stop", message: { content: '{"language":null}' } }] };
    } });
  assert.equal(result.status, "completed");
  assert.equal(result.turns, 1);
  assert.equal(result.generation.maxOutputTokens, 4096);
  assert.equal(result.generation.reasoningEffort, "none");
});

test("agent distinguishes output exhaustion and validates returned schema without repairs", async () => {
  const exhausted = await runAgentSession({ task: "solve", complete: async () => ({
    usage: { prompt_tokens: 30, completion_tokens: 2048 },
    choices: [{ finish_reason: "length", message: { content: "" } }],
  }) });
  assert.equal(exhausted.status, "output_limit");
  assert.equal(exhausted.turns, 1);
  assert.equal(exhausted.outputTokens, 2048);
  assert.equal(exhausted.responses[0].finishReason, "length");
  const answerSchema = { type: "object", properties: { completed: { type: "boolean" } },
    required: ["completed"], additionalProperties: false };
  for (const content of ['{"completed":"yes"}', '{"completed":true,"extra":1}', '```json\n{"completed":true}\n```']) {
    const result = await runAgentSession({ task: "solve", answerSchema, complete: async () => ({
      choices: [{ finish_reason: "stop", message: { content } }],
    }) });
    assert.equal(result.status, "invalid_answer");
    assert.equal(result.answer, null);
    assert.ok(!JSON.stringify(publicExecution(result)).includes(content));
  }
});

test("provider refusals and request failures are bounded diagnostics without silent fallback", async () => {
  let calls = 0;
  const failed = await runAgentSession({ task: "solve", complete: async () => {
    calls += 1;
    const error = new Error("private provider response");
    error.status = 400;
    throw error;
  } });
  assert.equal(calls, 1);
  assert.equal(failed.status, "provider_error");
  assert.equal(failed.failure.code, "provider_rejected_request");
  assert.equal(failed.failure.httpStatus, 400);
  assert.equal(failed.turns, 1);
  assert.ok(!JSON.stringify(failed).includes("private provider response"));
});

test("structural contracts reject inherited property names as extra fields", async () => {
  for (const field of ["constructor", "toString", "__proto__"]) {
    const content = `{"completed":true,"${field}":"unexpected"}`;
    const result = await runAgentSession({ task: "finish", answerSchema: answerSchemaFor("coding_workflow"),
      complete: async () => ({ choices: [{ finish_reason: "stop", message: { content } }] }) });
    assert.equal(result.status, "invalid_answer", field);
    assert.equal(result.answer, null);
  }
});

test("tool work and constrained finalization are separate measured provider phases", async () => {
  let requests = 0;
  let executed = 0;
  const tool = { definition: { type: "function", function: { name: "probe", parameters: { type: "object", properties: {}, required: [], additionalProperties: false } } },
    invoke: async () => { executed += 1; return { ok: true }; } };
  const result = await runAgentSession({ task: "Use probe then finish.", tools: [tool], answerSchema: answerSchemaFor("coding_workflow"), complete: async request => {
    requests += 1;
    if (requests === 1) {
      assert.equal(request.response_format, undefined, "tool selection must not be constrained to the final-answer shape");
      return { usage: { prompt_tokens: 10, completion_tokens: 3 }, choices: [{ finish_reason: "tool_calls", message: {
        tool_calls: [{ id: "probe-1", type: "function", function: { name: "probe", arguments: "{}" } }],
      } }] };
    }
    if (requests === 2) return { usage: { prompt_tokens: 20, completion_tokens: 4 }, choices: [{ finish_reason: "stop", message: { content: "The probe succeeded." } }] };
    assert.equal(request.response_format.type, "json_schema");
    assert.equal(request.tools, undefined);
    return { usage: { prompt_tokens: 30, completion_tokens: 5 }, choices: [{ finish_reason: "stop", message: { content: '{"completed":true}' } }] };
  } });
  assert.equal(result.status, "completed");
  assert.equal(executed, 1);
  assert.equal(requests, 3);
  assert.equal(result.turns, 3);
  assert.equal(result.inputTokens, 60);
  assert.deepEqual(result.responses.map(response => response.phase), ["tools", "tools", "answer"]);
});

test("tool traces are measured and gold answers are never sent to the agent", async () => {
  let calls = 0;
  const tools = [{ definition: { type: "function", function: { name: "search_files", parameters: { properties: { query: { type: "string" } }, required: ["query"] } } }, invoke: async () => [{ path: "fixture.mjs" }] }];
  const result = await runAgentSession({ task: "solve", tools, complete: async request => {
    calls += 1;
    if (calls === 1) return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "first", type: "function", function: { name: "search_files", arguments: '{"query":"repository"}' } }] } }] };
    assert.equal(request.messages.at(-1).role, request.response_format ? "user" : "tool");
    return { choices: [{ finish_reason: "stop", message: { content: '{"completed":true}' } }] };
  } });
  assert.equal(result.status, "completed");
  assert.equal(result.fileSearches, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.inputTokens, null);
  assert.equal(result.trace[0].ok, true);
  assert.deepEqual(result.trace[0].arguments, { querySha256: digest("repository"), queryBytes: 10 });
  assert.ok(!JSON.stringify(result.trace).includes("repository"), "generic traces must not contain the raw query");
});

test("agent failures and missing usage cannot become successful savings evidence", async () => {
  const result = await runAgentSession({ task: "test", complete: async () => { throw new Error("secret provider body"); } });
  assert.equal(result.status, "provider_error");
  assert.ok(!JSON.stringify(result).includes("secret"));
  assert.equal(result.inputTokens, null);
  assert.equal(pairedMetrics({ status: "completed", success: true }, { ...result, success: false }).errorAmplified, null);
  assert.throws(() => agentSettings({ MINDLEAK_VALIDATION_AGENT_URL: "http://remote.test/v1", MINDLEAK_VALIDATION_AGENT_MODEL: "test" }));
  assert.throws(() => agentSettings({ MINDLEAK_VALIDATION_AGENT_URL: "http://localhost/v1" }));
  assert.equal(digest(Buffer.from("abc")), digest("abc"));
});

test("official provider client cannot inherit request-body debug logging", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "fixture-model", usage: { prompt_tokens: 10, completion_tokens: 5 },
        choices: [{ finish_reason: "stop", message: { content: '{"completed":true}' } }] }));
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const previous = process.env.OPENAI_LOG;
  const logger = Object.fromEntries(["log", "debug", "info", "warn", "error"].map(name => [name, console[name]]));
  const messages = [];
  let result;
  try {
    process.env.OPENAI_LOG = "debug";
    for (const name of Object.keys(logger)) console[name] = (...args) => messages.push(args);
    const agent = await createAgent(agentSettings({ MINDLEAK_VALIDATION_AGENT_URL: `http://127.0.0.1:${server.address().port}/v1`, MINDLEAK_VALIDATION_AGENT_MODEL: "fixture-model" }));
    result = await agent.run("Private fixture prompt. Return JSON.", []);
  } finally {
    for (const [name, method] of Object.entries(logger)) console[name] = method;
    if (previous === undefined) delete process.env.OPENAI_LOG;
    else process.env.OPENAI_LOG = previous;
    await new Promise(resolve => server.close(resolve));
  }
  assert.equal(result.status, "completed");
  assert.equal(messages.length, 0, "SDK logging must be explicitly disabled");
});

async function assessPriorKnowledge(invoke, path, query = "Session Desk") {
  const result = await invoke("recall_memory", { query });
  const lessonId = result.results[0]?.fragmentId ?? null;
  if (lessonId) await invoke("inspect_source", { fragmentId: lessonId });
  const source = await invoke("read_file", { path });
  await invoke("assess_experience", { decision: lessonId ? "adapt" : "no_match", lessonId,
    reason: "Use the inspected contract against the current module, not an assumed previous implementation.",
    evidence: { path, quote: source.slice(0, 256) } });
}

function memoryDouble() {
  const memories = [];
  return {
    realProcess: false, restarts: 0, session: randomUUID(), server: { name: "test-double", version: "0" }, binarySha256: "test-double",
    async restart() { const previous = this.session; this.session = randomUUID(); this.restarts += 1; return { previous, current: this.session }; },
    async call(name, args) {
      let data;
      if (name === "decompose_memory") data = { results: args.text.split("\n") };
      else if (name === "write_memory") {
        const fragments = args.text.split("\n").map(text => ({ fragmentId: randomUUID(), text,
          lifecycle: { state: "active", tier: "short_term", confirmedSessions: 0, usefulSessions: 0 } }));
        const record = { memoryId: randomUUID(), context: args.context, rawText: args.text, fragments };
        memories.push(record);
        for (const directive of args.facts ?? []) for (const link of directive.links) {
          const target = memories.flatMap(memory => memory.fragments).find(fragment => fragment.fragmentId === link.targetFragmentId);
          if (link.relationshipType === "confirms") target.lifecycle.confirmedSessions += 1;
          else target.lifecycle.state = "superseded";
        }
        data = { memoryId: record.memoryId, fragments };
      } else if (args.fragmentId) {
        const record = memories.find(memory => memory.fragments.some(fragment => fragment.fragmentId === args.fragmentId));
        data = { ...record, ...record.fragments.find(fragment => fragment.fragmentId === args.fragmentId) };
      } else {
        data = { results: memories.filter(memory => memory.context.scope === args.scope).flatMap(memory => memory.fragments
          .filter(fragment => fragment.lifecycle.state === "active")
          .filter(fragment => args.query === "Bob" || args.query === "Project Vega" || args.query.startsWith("What")
            || fragment.text.toLowerCase().includes(args.query.toLowerCase()))
          .map(fragment => ({ ...fragment, memoryId: memory.memoryId, context: memory.context, score: 0.5 }))).slice(0, args.limit) };
      }
      return { data: structuredClone(data), elapsedMs: 1, resultBytes: Buffer.byteLength(JSON.stringify(data)), session: this.session };
    },
  };
}

function threeAgentDoubles({ failSecondInvestigation = false, recall = true } = {}) {
  const driver = memoryDouble();
  const writes = [];
  const call = driver.call.bind(driver);
  driver.call = async (name, args) => {
    if (name === "write_memory") writes.push(args);
    return call(name, args);
  };
  let investigations = 0;
  const workspaces = [];
  const workspaceFactory = async kind => {
    const fixture = codingFixture(kind);
    let fixed = false;
    const workspace = { fixtureSha256: digest(fixture), editablePaths: fixture.editable, closed: false,
      async list() { return Object.keys(fixture.files); },
      async read(path) { return fixture.files[path]; },
      async search() { return []; },
      async write() { fixed = true; return { written: true }; },
      async test() { return { passed: fixed, tests: 3, expectedTests: 3, passedTests: fixed ? 3 : 1 }; },
      async close() { this.closed = true; } };
    workspaces.push(workspace);
    return workspace;
  };
  const agent = { configuration: { model: "test-double" }, async run(task, tools) {
    const trace = [];
    const available = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = async (name, args = {}) => {
      const data = await available.get(name).invoke(args);
      trace.push({ tool: name, ok: true, startedMs: trace.length, elapsedMs: 1,
        ...(name === "read_file" || name === "write_file" ? { fixturePath: args.path } : {}),
        ...(name === "run_tests" ? { testsPassed: data.passed } : {}),
        ...(name === "recall_memory" ? { returned: data.results.length } : {}) });
      return data;
    };
    const preparation = available.has("write_memory");
    if (preparation) investigations += 1;
    if (available.has("recall_memory") && recall) {
      await invoke("recall_memory", { query: "Session expiry investigation" });
      await invoke("recall_memory", { query: "Agent B independently" });
    }
    for (const path of ["src/data/sessionRepository.mjs", "src/domain/session.mjs"]) await invoke("read_file", { path });
    if (available.has("assess_experience")) {
      if (!recall) {
        await assert.rejects(invoke("write_file", { path: "src/data/sessionRepository.mjs", content: "unchecked" }), /prior_experience_search_required/);
        return { sessionId: randomUUID(), status: "incomplete", answer: { completed: false }, trace, responses: [],
          elapsedMs: 10, inputTokens: 100, outputTokens: 20, fileSearches: 0, toolCalls: trace.length, turns: 2 };
      }
      await assessPriorKnowledge(invoke, "src/data/sessionRepository.mjs", "Session expiry investigation");
    }
    if (!(preparation && investigations === 2 && failSecondInvestigation)) {
      await invoke("write_file", { path: "src/data/sessionRepository.mjs", content: "export function saveSession(id, nowMs, ttlSeconds) { return { id, expiresAt: nowMs + ttlSeconds * 1000 }; }" });
      await invoke("run_tests");
      if (preparation) await invoke("write_memory", { rootCause: "TTL seconds were added to a millisecond timestamp.",
        files: ["src/data/sessionRepository.mjs", "src/domain/session.mjs"], failedApproaches: [], recommendedFix: "Convert TTL seconds to milliseconds before addition." });
    }
    return { sessionId: randomUUID(), status: "completed", answer: { completed: true }, trace, responses: [],
      elapsedMs: 10, inputTokens: 100, outputTokens: 20, fileSearches: 0, toolCalls: trace.length, turns: 2 };
  } };
  return { driver, agent, code: { engine: "test-double", image: "test-double" }, workspaceFactory, workspaces, writes };
}

test("three-agent demo verifies independent work and isolates A-only from B", async () => {
  const fixture = threeAgentDoubles();
  const report = await runValidation({ ...fixture, selected: ["three_agent_demo"], plan: generateScenarios({ sizes: [3] }) });
  const demo = report.categories.three_agent_demo;
  assert.equal(demo.status, "measured");
  const trial = demo.trials[0];
  for (const preparation of Object.values(trial.preparations)) {
    assert.equal(preparation.handoffVerification.ready, true);
    assert.ok(!preparation.trace.some(event => event.tool === "recall_memory"));
  }
  assert.equal(trial.confirmation.status, "confirmed");
  assert.equal(trial.confirmation.confirmedSessionsBefore, 0);
  assert.equal(trial.confirmation.confirmedSessionsAfter, 1);
  assert.equal(trial.confirmation.tierAfter, "short_term");
  assert.deepEqual(trial.conditions.afterAgentA.memoryExposure, { agentA: true, agentB: false });
  assert.deepEqual(trial.conditions.afterAgentsAB.memoryExposure, { agentA: true, agentB: true });
  assert.equal(trial.comparisons.afterAgentsAB.eligibleForMemorySavings, true);
  assert.equal(fixture.workspaces.length, 5);
  assert.ok(fixture.workspaces.every(workspace => workspace.closed));
  assert.ok(fixture.writes.every(write => write.requestId && write.context.sessionId));
  assert.ok(demo.events.some(event => event.type === "confirmation"));
  assert.ok(!JSON.stringify(report).includes("TTL seconds were added"));
});

test("three-agent demo does not confirm or credit an unverified second investigation", async () => {
  const fixture = threeAgentDoubles({ failSecondInvestigation: true });
  const report = await runValidation({ ...fixture, selected: ["three_agent_demo"] });
  const trial = report.categories.three_agent_demo.trials[0];
  assert.equal(trial.preparations.B.handoffVerification.ready, false);
  assert.equal(trial.confirmation.status, "not_measured");
  assert.equal(trial.comparisons.afterAgentsAB.eligibleForMemorySavings, false);
  assert.ok(!fixture.writes.some(write => write.facts?.some(fact => fact.links?.some(link => link.relationshipType === "confirms"))));
});

test("three-agent demo keeps savings unknown when C never receives the memories", async () => {
  const fixture = threeAgentDoubles({ recall: false });
  const report = await runValidation({ ...fixture, selected: ["three_agent_demo"] });
  const trial = report.categories.three_agent_demo.trials[0];
  assert.equal(trial.conditions.afterAgentsAB.success, false, "memory-enabled edits cannot skip the startup check");
  assert.equal(trial.comparisons.afterAgentsAB.eligibleForMemorySavings, false);
  assert.equal(trial.comparisons.afterAgentsAB.completionTimeReductionPercent, null);
});

test("full model-free harness reports ten categories and does not invent agent or day metrics", async () => {
  const report = await runValidation({ driver: memoryDouble(), plan: generateScenarios({ sizes: [3, 5] }) });
  assert.equal(report.status, "completed");
  assert.ok(categories.every(category => report.categories[category]));
  assert.equal(report.categories.atomic_extraction.persistence.rawAndFragmentPreservation, true);
  assert.equal(report.categories.memory_over_time.checkpoints[1].factsStored, 5);
  assert.equal(report.categories.contradiction_handling.staleFactReturned, false);
  assert.equal(report.summary.multi_agent_transfer, null);
  assert.equal(report.summary.token_savings, null);
  assert.equal(report.summary.long_term_learning, null);
  assert.equal(report.categories.rediscovery_demo.status, "not_measured");
  assert.equal(report.realMcpProcess, false);
  assert.ok(!JSON.stringify(report).includes("Bob uses PostgreSQL"));
});

test("harness preserves failed category results instead of reporting success", async () => {
  const driver = memoryDouble();
  driver.call = async () => { throw new Error("private body"); };
  const report = await runValidation({ driver, selected: ["atomic_extraction", "semantic_recall"] });
  assert.equal(report.status, "partial");
  assert.equal(report.summary.recall, null);
  assert.equal(report.summary.facts_stored, 0);
  assert.ok(Object.values(report.categories).every(category => category.status === "error"));
  assert.ok(!JSON.stringify(report).includes("private body"));
});

test("standalone agent failures count and missing poison fields stay unmeasured", async () => {
  const failed = { configuration: { model: "test-double" }, async run() {
    return { sessionId: randomUUID(), status: "provider_error", answer: null, trace: [] };
  } };
  const report = await runValidation({ driver: memoryDouble(), agent: failed, selected: ["contradiction_handling"] });
  assert.equal(report.status, "partial");
  assert.equal(report.summary.agent_execution_failures, 1);
  const missing = { configuration: { model: "test-double" }, async run(task, tools) {
    if (tools.length) await tools[0].invoke({ query: "moon" });
    return { sessionId: randomUUID(), status: "completed", answer: {}, trace: [] };
  } };
  const poisoned = await runValidation({ driver: memoryDouble(), agent: missing, selected: ["poisoning_resistance"] });
  assert.equal(poisoned.categories.poisoning_resistance.trials[0].poisoning.exposed, true);
  assert.equal(poisoned.categories.poisoning_resistance.trials[0].poisoning.blindAcceptance, null);
});

test("handoff readiness separates incomplete stored facts from a lucky final answer", async () => {
  const agent = { configuration: { model: "test-double" }, async run(task, tools) {
    const execution = { sessionId: randomUUID(), status: "completed", elapsedMs: 10, trace: [] };
    if (tools.some(tool => tool.definition.function.name === "write_memory")) {
      await tools.find(tool => tool.definition.function.name === "write_memory").invoke({ text: "Customer Orion prefers PostgreSQL." });
      return { ...execution, answer: { completed: true } };
    }
    if (tools.length) await tools[0].invoke({ query: "Customer Orion" });
    return { ...execution, answer: { database: "PostgreSQL", cloud: "Azure", authorization: "RBAC" } };
  } };
  const report = await runValidation({ driver: memoryDouble(), agent, selected: ["agent_handoff"] });
  const trial = report.categories.agent_handoff.trials[0];
  assert.equal(trial.withMemory.success, true);
  assert.equal(trial.stages.writeAcknowledged, true);
  assert.equal(trial.stages.storedFacts.verifiedFactRecall, 1 / 3);
  assert.equal(trial.stages.preparationReady, false);
  assert.equal(trial.stages.matchingSourceDelivered, true);
  assert.equal(trial.transferSuccess, false);
  assert.equal(trial.comparison.completionTimeReductionPercent, null);
});

test("poisoning evaluates the substantive answer and tests guaranteed exposure separately", async () => {
  const agent = { configuration: { model: "test-double" }, async run(task, tools) {
    if (tools.length) await tools[0].invoke({ query: "moon" });
    return { sessionId: randomUUID(), status: "completed", elapsedMs: 10, trace: [],
      answer: { material: "cheese", memoryClaimAccepted: false, conflictDetected: true, attributedToMemory: true } };
  } };
  const report = await runValidation({ driver: memoryDouble(), agent, selected: ["poisoning_resistance"] });
  const trial = report.categories.poisoning_resistance.trials[0];
  assert.equal(trial.poisoning.blindAcceptance, true, "denying acceptance cannot hide an answer repeating the false claim");
  assert.equal(trial.poisoning.conflictDetected, false);
  assert.equal(trial.poisoning.selfReportConsistent, false);
  assert.equal(trial.forcedExposure.evaluation.exposed, true);
  assert.equal(trial.forcedExposure.evaluation.blindAcceptance, true);
});

test("longitudinal checkpoints require elapsed days, preserve bindings, and never credit simulated time", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mindleak-journal-test-"));
  try {
    const driver = memoryDouble();
    const statePath = join(directory, "journal.json");
    const plan = generateScenarios({ sizes: [3] });
    const settings = { configuration: { retrieval: "keyword" }, serverEnvironment: { MINDLEAK_DATABASE_URL: "postgresql://test:private-password@localhost/example_test" } };
    const binding = longitudinalBinding(settings, plan);
    assert.ok(!JSON.stringify(binding).includes("private-password"));
    const initial = new Date("2026-09-16T12:00:00Z");
    const options = { driver, statePath, plan, binding, clock: () => initial };
    assert.equal((await runLongitudinal({ ...options, day: 1 })).status, "recorded");
    assert.equal((await runLongitudinal({ ...options, day: 1 })).status, "already_recorded");
    assert.equal((await runLongitudinal({ ...options, day: 2 })).status, "not_due");
    assert.equal((await runLongitudinal({ ...options, day: 30 })).status, "not_due");
    assert.equal((await runLongitudinal({ ...options, day: 2, clock: () => new Date(initial.getTime() + 86400000) })).status, "recorded");
    const day30 = await runLongitudinal({ ...options, day: 30, clock: () => new Date(initial.getTime() + 29 * 86400000) });
    assert.equal(day30.status, "recorded");
    assert.equal(day30.longTermLearning, null);
    assert.equal(day30.observation.rawPreserved, true);
    assert.match(day30.clock, /not-real-time/);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.observations[1].fragments.length, 1);
    await assert.rejects(runLongitudinal({ ...options, binding: { ...binding, databaseBinding: "other" }, day: 1 }), /binding_mismatch/);
    delete state.requests[2];
    delete state.observations[2];
    await writeFile(statePath, JSON.stringify(state));
    await assert.rejects(runLongitudinal({ ...options, day: 2, clock: () => new Date(initial.getTime() + 86400000) }), /invalid_longitudinal_state/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("scoped writes cannot change provenance and stable session IDs survive retries", async () => {
  let captured;
  const memory = scopedMemory({ async call(name, args) {
    captured = args;
    return { data: { memoryId: randomUUID(), fragments: [{ fragmentId: randomUUID(), text: args.text }] } };
  } }, "required-scope", "required-agent");
  await memory.write("fact", { agentId: "wrong", context: { scope: "wrong", sessionId: "stable" } });
  assert.equal(captured.agentId, "required-agent");
  assert.equal(captured.context.scope, "required-scope");
  assert.equal(captured.context.sessionId, "stable");
});

test("coding fixtures execute failing and passing tests in an isolated container", {
  skip: !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const configuration = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
  for (const kind of ["coding_workflow", "rediscovery_demo"]) {
    const workspace = await createCodingWorkspace(kind, configuration);
    try {
      const before = await workspace.test();
      assert.equal(before.tests, 3);
      assert.equal(before.passed, false);
      const [path] = codingFixture(kind).editable;
      const content = kind === "coding_workflow"
        ? "import { findCustomer } from '../data/customerRepository.mjs';\nexport function getCustomer(id) { const found = findCustomer(id); return {status: found ? 200 : 404, body: found}; }\n"
        : "export function saveSession(id, nowMs, ttlSeconds) { return {id, expiresAt: nowMs + ttlSeconds * 1000}; }\n";
      await workspace.write(path, content);
      const after = await workspace.test();
      assert.equal(after.passed, true);
      assert.equal(after.passedTests, 3);
    } finally { await workspace.close(); }
  }
  const charts = await renderScaleCharts([{ factsStored: 100, recall: 0.5, p95Ms: 10 }, { factsStored: 500, recall: 0.75, p95Ms: 15 }]);
  for (const svg of Object.values(charts)) {
    assert.match(svg, /<svg/);
    assert.match(svg, /<path/);
    assert.match(svg, /Actual stored fragments/);
  }
});
