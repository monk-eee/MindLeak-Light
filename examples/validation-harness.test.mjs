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
  } finally { await driver.close(); }
});

test("Lab 2 full relay builds one durable guide from five case chains", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY,
}, async () => {
  const { runMemoryLab, memoryLabRoles } = await import("./memory-lab.mjs");
  const { upgradeCases, assessPackage } = await import("./memory-lab-fixture.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  const cases = upgradeCases();
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE ?? "podman");
  const actors = Object.fromEntries(memoryLabRoles.map((role, index) => [role.id, { configuration: { model: "test-double" }, async run(task, tools, context) {
    assert.equal(context, "");
    assert.ok(task.startsWith("Memory hierarchy for this task:"));
    const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
    const invoke = (name, args = {}) => entries.get(name).invoke(args);
    const specification = cases[index];
    const execution = () => ({ sessionId: randomUUID(), status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 10, outputTokens: 5, toolCalls: 5, elapsedMs: 1 });
    if (entries.has("propose_guide")) {
      assert.ok(!entries.has("verify_assessment"));
      assert.ok(!entries.has("record_observation"));
      const sources = await invoke("inspect_guide_sources");
      const current = sources.principles[0]?.chain;
      const guide = await invoke("propose_guide", { chainId: current?.chainId ?? null, expectedRevision: current?.revision ?? null,
        claim: "Branch-kit durable package-review guide", rationale: "All current accepted case chains support the bounded procedure.",
        conclusion: "Inspect exact shipped paths, the affected range, and every current compatibility rule. Choose the minimum eligible fix or report not_shipped or blocked.",
        applicability: "This synthetic package-review family, including non-shipped and blocked cases.", assumptions: [], evidence: [],
        supportedBy: sources.chains.map(record => ({ chainId: record.chain.chainId, revision: record.chain.revision, reason: "Accepted case evidence." })) });
      await invoke("accept_knowledge", { chainId: guide.chainId, expectedRevision: guide.revision });
      return execution();
    }
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
      const sources = await invoke("recall_guide", { query: "branch-kit" });
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
    assert.equal(report.summary.principlesStored, 1);
    assert.equal(report.summary.memoriesStored, 26);
    assert.equal(report.summary.inputTokens, 140);
    assert.ok(report.agents.every(actor => actor.evidenceAttempts.length === 1 && actor.evidenceAttempts[0].passed));
    assert.equal(report.summary.guideApplications, 3);
    assert.equal(report.summary.sourceObservationsInspected, 6);
    assert.ok(report.agents.slice(1).every(actor => actor.guideAttempts.length === 1 && actor.guideAttempts[0].passed));
    assert.equal(report.guide.revision, 8);
    assert.equal(report.knowledge.principles[0].document.supportedBy.length, 5);
    assert.equal(report.knowledge.durability.length, 5);
    assert.ok(report.knowledge.durability.every(proof => proof.passed && proof.previousPid !== proof.currentPid));
    assert.equal(report.knowledge.durability.at(-1).records, 14);
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
            const guide = await invoke("recall_guide", { query: "branch-kit" });
            assert.equal(guide.principles[0].chain.revision, report.guide.revision + roundIndex * 2);
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
    assert.ok(control.rounds.every(round => round.pairs.every(pair => pair.withMemory.guideRetrievedBeforeAssessment && pair.withMemory.guideApplied && !pair.withoutMemory.knowledgeReceived)));
    const { learnFromControlRound } = await import("./memory-control.mjs");
    let reviewSessions = 0;
    const reviewer = { configuration: { model: "test-double" }, async run(task, tools, context) {
      reviewSessions += 1;
      assert.equal(context, "");
      assert.ok(task.startsWith("Memory hierarchy for this task:"));
      const entries = new Map(tools.map(tool => [tool.definition.function.name, tool]));
      const invoke = (name, args = {}) => entries.get(name).invoke(args);
      await invoke("memory_checkpoint");
      if (entries.has("record_observation")) {
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
        const sources = await invoke("inspect_guide_sources");
        const current = sources.principles[0].chain;
        const guide = await invoke("propose_guide", { ...current.snapshot.document, kind: undefined, chainId: current.chainId, expectedRevision: current.revision,
          supportedBy: sources.chains.map(item => ({ chainId: item.chain.chainId, revision: item.chain.revision, reason: "Accepted recorded case evidence." })) });
        await invoke("accept_knowledge", { chainId: guide.chainId, expectedRevision: guide.revision });
      }
      assert.equal((await invoke("memory_checkpoint")).ready, true);
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
  assert.deepEqual(brief.principles[0].chain.snapshot.document, document);
  assert.equal(brief.principles[0].chain.revision, 4);
  assert.deepEqual(brief.sourceReferences, [{ chainId: "chain-a", revision: 2, fragmentId: "source-a", role: "supports" }]);
  assert.equal(brief.chains.length, 0);
  assert.equal(brief.observations.length, 0);
  assert.ok(!JSON.stringify(brief).includes("redundant history"));
  assert.ok(!JSON.stringify(brief).includes("unneeded raw observation"));
  assert.ok(Buffer.byteLength(JSON.stringify(brief)) < 4096);
  assert.equal(response.principles[0].supportingChains[0].document.rationale, "redundant history ".repeat(1000), "briefing must not mutate stored knowledge");
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
  const guide = { chain: { chainId: "guide", revision: 2, snapshot: { state: "accepted", document } }, supportingChains: [] };
  const observations = ["first", "second"].map(id => ({ actor: id, memoryId: `memory-${id}`, fragments: [{ fragmentId: `fragment-${id}` }] }));
  let writes = 0;
  const ledger = { observations, nodes: new Map([
    ["guide", { actor: "iris", document }],
    ...["first", "second"].map(id => [id, { actor: id, document: { kind: "chain", evidence: [{ fragmentId: `fragment-${id}` }] } }]),
  ]), async search() { return { kind: "knowledge", principles: [guide], chains: [], observations: [] }; }, async inspect() { return guide; },
    async inspectObservation(id) { const observation = observations.find(item => item.fragments[0].fragmentId === id); return { ...observation, fragmentId: id, rawText: "Recorded original source" }; },
    async recordApplication() { writes += 1; return { memoryId: "application" }; } };
  const create = () => investigatorTools({ driver: {}, scope: "test", actor: "nova", specification, ledger, condition: "withMemory", index: 2, emit: () => {} });
  const invoke = (session, name, args) => session.tools.find(tool => tool.definition.function.name === name).invoke(args);
  const assess = async session => {
    for (const path of specification.evidencePaths) await invoke(session, "read_file", { path });
    return invoke(session, "verify_assessment", { ...assessPackage(specification), evidencePaths: specification.evidencePaths });
  };
  const detail = { chainId: "guide", revision: 2, steps: [{ quote: "Inspect the exact shipped path.", evidencePath: "package-lock.json", decision: "applies", reason: "The path was checked." },
    { quote: "Check every current eligibility rule.", evidencePath: "policy/upgrade-policy.json", decision: "applies", reason: "Current policy was checked." }] };
  const late = create(); await assess(late); await invoke(late, "recall_guide", { query: "branch-kit" });
  await assert.rejects(invoke(late, "apply_guide", detail), /guide_must_precede_verified_assessment/);
  const valid = create(); await invoke(valid, "recall_guide", { query: "branch-kit" }); await assess(valid);
  await assert.rejects(invoke(valid, "apply_guide", detail), /inspect_two_guide_sources/);
  for (const source of observations) await invoke(valid, "inspect_observation", { fragmentId: source.fragments[0].fragmentId });
  await assert.rejects(invoke(valid, "apply_guide", { ...detail, steps: [{ ...detail.steps[0], quote: "Invented guidance absent from the stored principle" }, detail.steps[1]] }), /exact_guide_steps_and_current_evidence_required/);
  assert.equal(writes, 0);
  await invoke(valid, "apply_guide", detail);
  assert.equal(writes, 1);
  assert.equal(valid.application.steps, 2);
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
    assert.ok(!tests.includes("from 'linkedom'"), "the DOM library must be bundled for network-disabled tests");
    await assert.rejects(workspace.write("tests/workflow.test.mjs", "tampered"));
    await workspace.write("src/expiry.mjs", "export const marker = true;");
    assert.equal(await workspace.read("src/expiry.mjs"), "export const marker = true;");
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
    if (role.dependencies.length) await get("recall_memory").invoke({ query: "Session Desk" });
    for (const path of role.editable) await get("write_file").invoke({ path, content: "verified-test-double-source" });
    await get("run_tests").invoke({});
    await get("write_memory").invoke({ text: `Session Desk ${role.title} passed its component tests.` });
    const sessionId = randomUUID();
    onEvent({ type: "inference_finished", sessionId, turn: 1, inputTokens: 100, outputTokens: 20, startedMs: 0, elapsedMs: 1 });
    active -= 1;
    return { sessionId, status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 20, toolCalls: 4, elapsedMs: 2 };
  } };
  const report = await runSwarmBuild({ driver, agent, code: { engine: "test-double", image: "unit" },
    workspaceFactory: async () => workspace, applicationBuilder: async () => ({ html: "<html></html>", sha256: "fixture" }), onEvent: event => events.push(event) });
  assert.equal(report.status, "completed");
  assert.equal(report.summary.agentsPassed, 5);
  assert.equal(report.agents.find(role => role.id === "atlas").attempts[0].memoryChecked, false);
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
      for (const path of role.editable) await invoke("write_file", { path, content: memory ? "memory-team-source" : "dalek-team-source" });
      await invoke("run_tests");
      if (memory) await invoke("write_memory", { text: `Session Desk ${role.title} has passed its fixed component tests.` });
      const sessionId = randomUUID(); sessions.push({ sessionId, memory });
      onEvent({ type: "inference_finished", workload: "agent", model: `matched-model-${index}`, sessionId, turn: 1, inputTokens: 100, outputTokens: 20, elapsedMs: 1 });
      return { sessionId, status: "completed", answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 20, toolCalls: 4, elapsedMs: 2 };
    } }]));
  const events = [];
  const comparison = await runSwarmComparison({ driver: memoryDouble(), agentsByRole: actors, code: { engine: "test-double", image: "unit" },
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

  const forbiddenDriver = new Proxy({}, { get() { throw new Error("Daleks must never access a memory driver"); } });
  const isolated = await runSwarmBuild({ driver: forbiddenDriver, memoryEnabled: false, agentsByRole: actors,
    code: { engine: "test-double", image: "unit" }, workspaceFactory, applicationBuilder: async () => ({ html: "control", sha256: "control" }) });
  assert.equal(isolated.status, "completed");
  assert.equal(isolated.summary.memoriesStored, 0);
  const optionalActors = Object.fromEntries(swarmRoles.map(role => [role.id, { configuration: { model: "test-double" }, async run(task, tools) {
    const invoke = (name, args = {}) => tools.find(tool => tool.definition.function.name === name).invoke(args);
    for (const path of role.editable) await invoke("write_file", { path, content: "verified-without-memory-use" });
    await invoke("run_tests");
    return { status: "completed", sessionId: randomUUID(), inputTokens: 10, outputTokens: 1, toolCalls: 2, trace: [], responses: [] };
  } }]));
  const optional = await runSwarmBuild({ driver: memoryDouble(), agentsByRole: optionalActors, code: { engine: "test-double", image: "unit" },
    workspaceFactory, applicationBuilder: async () => ({ html: "verified", sha256: "verified" }) });
  assert.equal(optional.status, "completed", "correctness must not require memory use or publication");
  assert.equal(optional.summary.crossAgentHandoffs, 0);
  assert.ok(optional.agents.every(actor => actor.attempts[0].publishedMemories === 0));
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
  assert.ok(workflow.includes("/mindleak_labs_test?sslmode=disable"));
  assert.ok(workflow.includes("--test-name-pattern='Lab [123]|swarm project'"));
});

test("Lab 3 freezes three main arms and a separate diagnostic across genuine change", async () => {
  const { rediscoveryPlan, rediscoveryPrompt, compactPriorLesson } = await import("./rediscovery-lab.mjs");
  const plan = rediscoveryPlan();
  assert.equal(plan.protocolVersion, 2);
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
  for (const group of new Set(plan.sessions.map(session => session.matchId))) {
    const matched = plan.sessions.filter(session => session.matchId === group);
    assert.equal(matched.length, 4);
    assert.equal(new Set(matched.map(session => session.fixtureSha256)).size, 1);
    assert.equal(new Set(matched.map(session => session.model)).size, 1);
  }
  const prompt = rediscoveryPrompt({ arm: "mindleak", retrievalMode: "keyword", task: "A callback repeats a completed operation." });
  assert.ok(prompt.includes("keyword"));
  assert.ok(prompt.includes("one focused refinement"));
  assert.ok(prompt.includes("optional"));
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
    const misses = rediscoveryExperienceTools({ arm: "mindleak", frozen, driver: monitored, scope: store.scope });
    const search = misses.tools.find(tool => tool.definition.function.name === "recall_experience");
    assert.equal((await search.invoke({ query: "unrelated_zxqv_777" })).hits.length, 0);
    assert.equal((await search.invoke({ query: "unrelated_zxqv_888" })).hits.length, 0);
    await assert.rejects(search.invoke({ query: "unrelated_zxqv_999" }), /query_refinement_exhausted/);
    assert.equal(await store.verifyFrozen(frozen), true);
    assert.ok(calls.filter(call => call.name === "write_memory").every(call => !call.args.facts), "no automatic lifecycle feedback");
  } finally { await driver.close(); }
});

test("Lab 3 runs optional-memory arms with misses frozen rounds and complete accounting", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY || !process.env.MINDLEAK_VALIDATION_CODE_ENGINE,
}, async () => {
  const { runRediscoveryLab } = await import("./rediscovery-lab.mjs");
  const { rediscoveryFixtureRepair } = await import("./rediscovery-fixtures.mjs");
  const { benchmarkSettings } = await import("./benchmark-recall.mjs");
  const driver = await openMemoryDriver(process.env.MINDLEAK_LAB2_TEST_BINARY, benchmarkSettings({ ...process.env,
    MINDLEAK_TEST_DATABASE_URL: process.env.MINDLEAK_LAB2_TEST_DATABASE_URL ?? process.env.MINDLEAK_TEST_DATABASE_URL }));
  const code = await containerConfiguration(process.env.MINDLEAK_VALIDATION_CODE_ENGINE);
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
    if (entries.has("inspect_task_result")) {
      assert.ok(task.includes("memory-side"));
      assert.ok(!task.includes('"arm":"fresh"') && !task.includes('"arm":"direct"'));
      return { status: "completed", sessionId: randomUUID(), answer: { completed: true }, trace: [], responses: [], inputTokens: 100, outputTokens: 10, toolCalls: 0, elapsedMs: 1 };
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
    if (entries.has("recall_experience")) {
      memoryComparisons += 1;
      if (memoryComparisons === 1) assert.equal((await invoke("recall_experience", { query: "unrelated_test_miss_123" })).hits.length, 0);
    }
    if (entries.has("search_notebook")) assert.equal((await invoke("search_notebook", { query: "Dispatch Ledger" })).hits.length, 1);
    if (context) assert.ok(context.includes("Preserve one logical operation identity"));
    for (const path of [modulePath, "docs/current-contract.md", "src/provider.mjs"]) await invoke("read_file", { path });
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
    assert.equal(report.outcomes.filter(outcome => outcome.arm === "mindleak" && outcome.correct && !outcome.priorKnowledgeDelivered).length, 2);
    assert.equal(report.metrics.arms.mindleak.retrievalMisses, 1);
    assert.equal(report.metrics.arms.mindleak.scheduled, 2);
    assert.equal(report.metrics.arms.mindleak.correct, 2);
    assert.equal(report.metrics.arms.mindleak.knowledgeReuse.successful, 0, "a correct answer alone cannot earn reuse credit");
    assert.equal(report.metrics.arms.fresh.actualCostUsd, null);
    assert.equal(report.metrics.arms.mindleak.totalInputTokens, 200 + 100 + 100 + 200);
    assert.equal(report.metrics.arms.notebook.totalInputTokens, 200 + 100 + 100 + 200);
    assert.equal(report.metrics.arms.fresh.totalInputTokens, 200);
    assert.equal(report.metrics.costBreakEven, null);
    assert.equal(report.metrics.compoundingScore, null);
    assert.equal(report.knowledge.lessons.length, 1);
    assert.equal(report.rounds.length, 2);
    assert.ok(report.rounds.every(round => round.frozenUnchanged && round.learning.outcome === "no_new_learning"));
    assert.equal(sessionCount, 12);
    assert.equal(report.preparationReview.outcome, "no_new_learning");
    const recording = normalizeRecording(report);
    assert.equal(recording.rediscovery, true);
    assert.equal(recording.agents.length, 4);
    const { knowledgeMetrics } = await import("./demo-view.mjs");
    const learning = knowledgeMetrics(report);
    assert.equal(learning.successfulTasks, 2);
    assert.equal(learning.reuse.tasks, 0);
    assert.equal(learning.curve.length, 2);
    assert.equal(learning.curve[0].notebook, 1);
    assert.equal(learning.timeToCorrectHypothesis.status, "verified_fix_time_only");
    const page = await renderDemoPage({ report });
    assert.ok(page.includes('id="nav-lab3"'));
    assert.ok(page.includes('id="rediscovery-results"'));
    assert.ok(page.includes('id="rediscovery-cost-curve"'));
    if (process.env.MINDLEAK_REDISCOVERY_TEST_REPLAY_DIR) await writeDemoReplay(report, process.env.MINDLEAK_REDISCOVERY_TEST_REPLAY_DIR);
  } finally { await driver.close(); }
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
    assert.ok((await readFile(join(finished.directory, "index.html"), "utf8")).includes("MindLeak Swarm Lab"));
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
          handler({ id: "usage-1", type: "assistant.usage", data: { model: "gpt-6-astra", inputTokens: 120, outputTokens: 30, duration: 4, finishReason: "stop" } });
          return { data: { content: '{"completed":true}' } };
        } };
    }, async deleteSession(id) { deleted = id; },
  } };
  const agent = createCopilotAgent(provider);
  const result = await agent.run("private-task", [{ definition: { function: { name: "read_file", description: "Read fixture", parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] } } },
    async invoke() { return "private-file-body"; } }], "", answerSchemaFor("rediscovery_demo"), { onEvent: event => events.push(event) });
  assert.deepEqual(configuration.availableTools, ["custom:demo_read_file"]);
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

test("frontier adapter distinguishes unfinished tool work and explicit runtime stops", async () => {
  for (const reason of ["idle_tools", "cancelled", "budget"]) {
    const events = [];
    const provider = { models: [{ id: "gpt-6-astra" }], client: {
      async createSession() {
        let handler;
        return { on(callback) { handler = callback; return () => {}; }, async abort() {}, async disconnect() {},
          async sendAndWait() {
            handler({ type: "assistant.turn_start", data: { turnId: "1" } });
            handler({ id: "usage", type: "assistant.usage", data: { model: "gpt-6-astra", inputTokens: 10, outputTokens: 5, finishReason: "tool_calls" } });
            if (reason === "budget") handler({ type: "session_limits_exhausted.requested", data: { maxAiCredits: 30, usedAiCredits: 30 } });
            handler({ type: "session.idle", data: { aborted: reason === "cancelled" } });
            return { data: { content: "" } };
          } };
      }, async deleteSession() {},
    } };
    const result = await createCopilotAgent(provider).run("synthetic task", [], "", answerSchemaFor("rediscovery_demo"), { onEvent: event => events.push(event) });
    assert.equal(result.status, reason === "cancelled" ? "cancelled" : reason === "budget" ? "budget_exceeded" : "incomplete");
    assert.equal(result.answer, null);
    assert.equal(result.responses.length, 1);
    assert.ok(events.some(event => event.type === "session_stopped"));
  }
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
    };
    const preparation = available.has("write_memory");
    if (preparation) investigations += 1;
    if (available.has("recall_memory") && recall) {
      await invoke("recall_memory", { query: "Session expiry investigation" });
      await invoke("recall_memory", { query: "Agent B independently" });
    }
    for (const path of ["src/data/sessionRepository.mjs", "src/domain/session.mjs"]) await invoke("read_file", { path });
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
  assert.equal(trial.conditions.afterAgentsAB.success, true);
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
