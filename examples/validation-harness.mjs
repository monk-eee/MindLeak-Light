import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { availableParallelism } from "node:os";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchmarkSettings, scoreDecomposition } from "./benchmark-recall.mjs";
import { agentSettings, createAgent, publicExecution } from "./validation-agent.mjs";
import { agentTools, containerConfiguration, createCodingWorkspace, openMemoryDriver, renderScaleCharts, scopedMemory } from "./validation-runtime.mjs";
import { answerSchemaFor, categories, codingFixture, digest, evaluateAnswer, evaluatePoisoning, generateScenarios, handoffSchema, pairedMetrics, retrievalMetrics, scaleCharts, verifyCodingPreparation } from "./validation-scenarios.mjs";
import { longitudinalBinding, runLongitudinal } from "./validation-longitudinal.mjs";
import { writeDemoReplay } from "./demo-replay.mjs";
import { openCopilotProvider, createCopilotAgent } from "./copilot-agent.mjs";

const optionalCategories = ["three_agent_demo"];
const threeAgentPlan = {
  id: "three_agent_demo", version: 1, fixture: "rediscovery_demo",
  title: "Session expiry investigation",
  stages: ["agent-a-investigates", "agent-b-independently-verifies", "agent-c-compares"],
  comparisons: ["withoutMemory", "afterAgentA", "afterAgentsAB"],
  telemetry: ["tool-events", "test-results", "memory-delivery", "elapsed-time", "provider-token-usage"],
};

const mean = values => values.length ? values.reduce((sum, value) => sum + Number(value), 0) / values.length : null;
const measured = values => values.filter(value => value !== null && value !== undefined && Number.isFinite(Number(value)));
const notMeasured = reason => ({ status: "not_measured", reason });

export function latency(values) {
  const ordered = [...values].sort((left, right) => left - right);
  const percentile = fraction => ordered.length ? ordered[Math.max(0, Math.ceil(ordered.length * fraction) - 1)] : null;
  return { count: ordered.length, meanMs: mean(ordered), p50Ms: percentile(0.5), p95Ms: percentile(0.95), maxMs: ordered.at(-1) ?? null };
}

async function storeEpisode(memory, episode, known) {
  const receipt = await memory.write(episode.text);
  for (const fragment of receipt.fragments) {
    known.set(fragment.fragmentId, scoreDecomposition(episode, [fragment.text]).verifiedIds[0] ?? `unverified-${fragment.fragmentId}`);
  }
  return receipt;
}

async function storeFacts(memory, facts, known) {
  const receipts = [];
  for (let index = 0; index < facts.length; index += 32) {
    const batch = facts.slice(index, index + 32);
    receipts.push(await storeEpisode(memory, { id: `batch-${index}`, text: batch.map(fact => fact.text).join("\n"), facts: batch }, known));
  }
  return receipts;
}

async function observe(memory, query, known) {
  const { facts, elapsedMs, resultBytes, session } = await memory.recall(query.text, 5);
  return { id: query.id, querySha256: digest(query.text), session, relevantIds: query.relevant,
    rankedFactIds: facts.map(fact => known.get(fact.fragmentId) ?? `unverified-${fact.fragmentId}`),
    ...retrievalMetrics(facts.map(fact => known.get(fact.fragmentId) ?? `unverified-${fact.fragmentId}`), query.relevant),
    elapsedMs, resultBytes };
}

function aggregateQueries(queries) {
  return { queries: queries.length, positiveQueries: queries.filter(query => query.relevantIds.length).length,
    negativeQueries: queries.filter(query => !query.relevantIds.length).length,
    recall: mean(measured(queries.map(query => query.recallAtK))),
    precision: mean(measured(queries.map(query => query.precisionAmongReturned))),
    precisionAt5: mean(measured(queries.map(query => query.precisionAtK))),
    top1: mean(measured(queries.map(query => query.top1))), top3: mean(measured(queries.map(query => query.top3))),
    top5: mean(measured(queries.map(query => query.top5))),
    falsePositiveRate: mean(queries.filter(query => query.noAnswerCorrect !== null).map(query => !query.noAnswerCorrect)),
    falsePositiveResults: queries.reduce((sum, query) => sum + query.falsePositiveResults, 0),
    latency: latency(queries.map(query => query.elapsedMs)) };
}

async function agentOutcome(agent, task, memory, workspace, context = "", rubric = null, answerSchema = null) {
  const started = performance.now();
  const execution = await agent.run(task, agentTools(memory, workspace), context, answerSchema);
  const answerEvaluation = rubric ? evaluateAnswer(execution.answer, rubric) : null;
  const tests = workspace ? await workspace.test() : null;
  const success = execution.status === "completed" && (tests ? tests.passed : answerEvaluation?.success === true);
  return { ...publicExecution(execution), agentElapsedMs: execution.elapsedMs, elapsedMs: performance.now() - started, success, answerEvaluation, tests,
    memoryUseObserved: execution.trace.some(event => event.tool === "recall_memory" && event.ok && event.returned > 0),
    _answer: execution.answer };
}

function publishedOutcome(result) {
  const { _answer, ...summary } = result;
  return summary;
}

function transferStages(source, target, preparation, scenario, outcome) {
  const written = source.observations.writes.flatMap(receipt => receipt.fragments);
  const ids = new Set(written.map(fragment => fragment.fragmentId));
  const storedFacts = scenario.facts ? scoreDecomposition({ id: "stored-evidence", facts: scenario.facts }, written.map(fragment => fragment.text)) : null;
  const preparationCompleted = preparation ? preparation.status === "completed" : true;
  const preparationReady = preparationCompleted && written.length > 0
    && (storedFacts ? storedFacts.verifiedFactRecall === 1 : preparation?.handoffVerification?.ready === true);
  const matchingSourceRetrieved = [...target?.observations.recalled ?? []].some(id => ids.has(id));
  const matchingSourceDelivered = [...target?.observations.exposed ?? []].some(id => ids.has(id));
  return { preparationCompleted, writeAcknowledged: written.length > 0, writtenFragments: written.length, storedFacts, preparationReady,
    retrievalAttempted: target?.observations.calls.some(call => call.tool === "recall_memory") ?? false,
    matchingSourceRetrieved, matchingSourceDelivered,
    sourceInspected: [...target?.observations.inspections ?? []].some(id => ids.has(id)),
    answerCompleted: outcome.status === "completed", answerCorrect: outcome.status === "completed" ? outcome.success : null,
    failureStage: !preparationCompleted ? "preparation_execution" : !written.length ? "no_memory_written"
      : !preparationReady ? "preparation_unverified" : !matchingSourceRetrieved ? "source_not_retrieved"
      : !matchingSourceDelivered ? "source_not_delivered" : outcome.status !== "completed" ? "answer_execution"
      : !outcome.success ? "answer_incorrect_or_unverified" : null };
}

export async function runValidation({ driver, plan = generateScenarios(), agent = null, code = null,
  trials = 1, selected = categories, onProgress = () => {}, workspaceFactory = createCodingWorkspace } = {}) {
  if (!Number.isInteger(trials) || trials < 1 || trials > 10 || !Array.isArray(selected)
    || !selected.length || selected.some(category => ![...categories, ...optionalCategories].includes(category)) || new Set(selected).size !== selected.length) {
    throw new Error("invalid_validation_selection");
  }
  const runId = randomUUID();
  const started = performance.now();
  const results = {};
  const memories = [];
  const queries = [];
  const pairs = [];
  const memory = (category, role = "fixture", identity = `validation-${role}-${randomUUID()}`) => {
    const scoped = scopedMemory(driver, `validation-${runId}-${category}`, identity);
    memories.push(scoped);
    return scoped;
  };
  async function pairedTask(category, scenario, context = "", prepare = null) {
    if (!agent) return notMeasured("requires_explicit_agent_under_test");
    const trialResults = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const slot = `${category}-${trial}`;
      const source = memory(slot, "agent-a");
      const preparation = prepare ? await prepare(source) : null;
      if (!prepare) await storeFacts(source, scenario.facts, new Map());
      const order = Number.parseInt(digest(`${plan.seed}:${category}:${trial}`).slice(0, 2), 16) % 2
        ? ["withMemory", "withoutMemory"] : ["withoutMemory", "withMemory"];
      const arms = {};
      let targetMemory;
      for (const arm of order) {
        await driver.restart();
        const target = arm === "withMemory" ? memory(slot, "agent-b") : null;
        if (target) targetMemory = target;
        arms[arm] = await agentOutcome(agent, scenario.task, target, null, arm === "withoutMemory" ? context : "", scenario.rubric, answerSchemaFor(category));
      }
      const stages = transferStages(source, targetMemory, preparation, scenario, arms.withMemory);
      const comparison = pairedMetrics(arms.withoutMemory, arms.withMemory, { memoryExposed: stages.matchingSourceDelivered, preparationReady: stages.preparationReady });
      const result = { trial: trial + 1, order, preparation, stages, memoryExposureObserved: stages.matchingSourceDelivered,
        withoutMemory: publishedOutcome(arms.withoutMemory), withMemory: publishedOutcome(arms.withMemory), comparison };
      if (category === "poisoning_resistance") {
        result.poisoning = evaluatePoisoning(arms.withMemory._answer, scenario.rubric,
          { exposed: stages.matchingSourceDelivered, completed: arms.withMemory.status === "completed" });
        await driver.restart();
        const forcedMemory = memory(slot, "agent-forced-exposure");
        const inspected = await forcedMemory.inspect(source.observations.writes[0].fragments[0].fragmentId);
        const context = JSON.stringify({ source: "stored-memory-claim-untrusted", evidence: inspected });
        if (Buffer.byteLength(context) > 64 * 1024) throw new Error("forced_context_budget");
        const forced = await agentOutcome(agent, scenario.task, forcedMemory, null, context, scenario.rubric, answerSchemaFor(category));
        result.forcedExposure = { protocol: "inspected-source-in-context-v1", contextBytes: Buffer.byteLength(context),
          execution: publishedOutcome(forced), evaluation: evaluatePoisoning(forced._answer, scenario.rubric,
            { exposed: true, completed: forced.status === "completed" }), naturalistic: false };
      }
      if (category === "agent_handoff") result.transferSuccess = stages.preparationReady && stages.matchingSourceDelivered && arms.withMemory.success;
      pairs.push(result);
      trialResults.push(result);
    }
    return { status: "measured", trials: trialResults, independentTasks: 1,
      repeatedTrialsAreNotIndependentTasks: true, freshConversations: true, serverRestartedBetweenArms: true };
  }
  async function codingTask(kind, scenario) {
    if (!agent || !code) return notMeasured(!agent ? "requires_explicit_agent_under_test" : "requires_explicit_code_container");
    const trialResults = [];
    for (let trial = 0; trial < trials; trial += 1) {
      const slot = `${kind}-${trial}`;
      const source = memory(slot, "agent-a");
      const discovery = await workspaceFactory(kind, code);
      let preparation;
      try {
        const before = await discovery.test();
        if (before.passed || before.tests !== before.expectedTests) throw new Error("coding_fixture_must_have_executed_failing_tests");
        const execution = await agent.run(scenario.discovery, agentTools(source, discovery, { recall: false, write: true, handoffKind: kind }), "", answerSchemaFor(kind, "preparation"));
        const after = await discovery.test();
        preparation = { ...publicExecution(execution), baselineTests: before, finalTests: after, memoriesWritten: source.observations.writes.length,
          handoffVerification: verifyCodingPreparation(kind, execution, source.observations.handoffBriefs, after),
          briefs: source.observations.handoffBriefs };
      } finally { await discovery.close(); }
      const order = trial % 2 ? ["withMemory", "withoutMemory"] : ["withoutMemory", "withMemory"];
      const arms = {};
      let targetMemory;
      for (const arm of order) {
        await driver.restart();
        const workspace = await workspaceFactory(kind, code);
        const target = arm === "withMemory" ? memory(slot, "agent-b") : null;
        if (target) targetMemory = target;
        try {
          arms[arm] = await agentOutcome(agent, scenario.task, target, workspace, "", null, answerSchemaFor(kind));
        } finally { await workspace.close(); }
      }
      const stages = transferStages(source, targetMemory, preparation, scenario, arms.withMemory);
      const result = { trial: trial + 1, order, preparation, stages, memoryExposureObserved: stages.matchingSourceDelivered,
        withoutMemory: publishedOutcome(arms.withoutMemory), withMemory: publishedOutcome(arms.withMemory),
        comparison: pairedMetrics(arms.withoutMemory, arms.withMemory, { memoryExposed: stages.matchingSourceDelivered, preparationReady: stages.preparationReady }) };
      pairs.push(result);
      trialResults.push(result);
    }
    return { status: "measured", trials: trialResults, independentTasks: 1,
      elapsedDays: 0, timeModel: "fresh-session-replay-not-tomorrow", identicalStartingFiles: true,
      testsRunInNetworkDisabledContainer: true, noDiscoveryEditsTransferred: true };
  }
  async function threeAgentTask() {
    if (!agent || !code) return notMeasured(!agent ? "requires_explicit_agent_under_test" : "requires_explicit_code_container");
    const kind = "rediscovery_demo";
    const scenario = plan.scenarios[kind];
    const fixtureSha256 = digest(codingFixture(kind));
    const events = [];
    const trialResults = [];
    const demoStarted = performance.now();
    const emit = record => {
      const event = { id: events.length + 1, atMs: performance.now() - demoStarted, ...record };
      events.push(event);
      onProgress({ event: "demo_event", record: event });
    };
    const writer = (slot, role, identity) => {
      const source = memory(slot, role, identity);
      const sessionId = randomUUID();
      const requests = new Map();
      return { ...source, async write(text, options = {}) {
        const key = digest([text, options]);
        if (!requests.has(key)) requests.set(key, randomUUID());
        return source.write(text, { ...options, requestId: requests.get(key),
          context: { ...options.context, sessionId } });
      } };
    };
    const recordExecution = (execution, role, trial, condition, stageStart) => {
      for (const event of execution.trace) emit({ ...event, type: "tool", role, trial, condition,
        atMs: stageStart + (event.startedMs ?? 0) + (event.elapsedMs ?? 0) });
      for (const event of execution.responses ?? []) if (Number.isFinite(event.startedMs)) {
        emit({ ...event, type: "inference", role, trial, condition, atMs: stageStart + event.startedMs + (event.elapsedMs ?? 0) });
      }
    };
    for (let trial = 1; trial <= trials; trial += 1) {
      const slot = `three-agent-${trial}`;
      const identityA = `validation-agent-a-${randomUUID()}`;
      const sourceA = writer(slot, "agent-a", identityA);
      const sourceB = writer(slot, "agent-b");
      const snapshotA = writer(`${slot}-a-only`, "agent-a-snapshot", identityA);
      const result = { trial, preparations: {}, conditions: {}, comparisons: {},
        confirmation: notMeasured("requires_two_verified_investigations"), fixtureSha256 };
      trialResults.push(result);
      const investigate = async (role, source) => {
        await driver.restart();
        const stageStart = performance.now() - demoStarted;
        emit({ type: "stage_started", role, trial });
        const workspace = await workspaceFactory(kind, code);
        try {
          if (workspace.fixtureSha256 !== fixtureSha256) throw new Error("demo_fixture_changed");
          const before = await workspace.test();
          emit({ type: "tests", role, trial, phase: "baseline", ...before });
          if (before.passed || before.tests !== before.expectedTests) throw new Error("demo_requires_failing_fixture");
          const execution = await agent.run(scenario.discovery,
            agentTools(source, workspace, { recall: false, write: true, handoffKind: kind }), "", answerSchemaFor(kind, "preparation"));
          const after = await workspace.test();
          const verification = verifyCodingPreparation(kind, execution, source.observations.handoffBriefs, after);
          const preparation = { ...publicExecution(execution), agentElapsedMs: execution.elapsedMs,
            elapsedMs: performance.now() - demoStarted - stageStart, baselineTests: before, finalTests: after,
            fixtureSha256, memoriesWritten: source.observations.writes.length, handoffVerification: verification,
            briefs: source.observations.handoffBriefs };
          recordExecution(execution, role, trial, null, stageStart);
          emit({ type: "tests", role, trial, phase: "verification", ...after });
          emit({ type: "stage_finished", role, trial, status: execution.status, success: verification.ready,
            inputTokens: execution.inputTokens, outputTokens: execution.outputTokens, toolCalls: execution.toolCalls });
          return preparation;
        } finally { await workspace.close(); }
      };
      try {
        result.preparations.A = await investigate("A", sourceA);
        let outcome;
        if (result.preparations.A.handoffVerification.ready) {
          outcome = await sourceA.write("Session expiry investigation: the independently corrected checkout passed all three immutable session-expiry checks.");
          emit({ type: "memory_saved", role: "A", trial, fragments: outcome.fragments.length, memoryId: outcome.memoryId });
          const originals = [...new Map(sourceA.observations.writes.map(receipt => [receipt.memoryId, receipt])).values()];
          for (const receipt of originals) {
            const episode = await sourceA.inspect(receipt.fragments[0].fragmentId);
            const copied = await snapshotA.write(episode.rawText, { context: { source: `control-copy:${receipt.memoryId}` } });
            if (JSON.stringify(copied.fragments.map(fragment => fragment.text)) !== JSON.stringify(receipt.fragments.map(fragment => fragment.text))) {
              throw new Error("demo_snapshot_changed_fragments");
            }
          }
          emit({ type: "snapshot", role: "A", trial, records: originals.length });
        }
        result.preparations.B = await investigate("B", sourceB);
        if (result.preparations.A.sessionId === result.preparations.B.sessionId) throw new Error("demo_requires_fresh_sessions");
        if (outcome && result.preparations.B.handoffVerification.ready) {
          const target = outcome.fragments[0].fragmentId;
          const before = await sourceA.inspect(target);
          const text = "Session expiry investigation: Agent B independently reproduced the failure and validated the same three immutable checks after a correction.";
          const receipt = await sourceB.write(text, { facts: [{ text, links: [{ targetFragmentId: target, relationshipType: "confirms" }] }] });
          const after = await sourceA.inspect(target);
          if (after.lifecycle.confirmedSessions !== before.lifecycle.confirmedSessions + 1
            || after.lifecycle.usefulSessions !== before.lifecycle.usefulSessions || after.lifecycle.tier !== before.lifecycle.tier) {
            throw new Error("demo_confirmation_mismatch");
          }
          result.confirmation = { status: "confirmed", claim: "immutable-test-outcome-only", relationshipType: "confirms",
            targetFragmentId: target, evidenceMemoryId: receipt.memoryId, confirmedSessionsBefore: before.lifecycle.confirmedSessions,
            confirmedSessionsAfter: after.lifecycle.confirmedSessions, tierAfter: after.lifecycle.tier,
            independentlyAdjudicatedNarrative: false, immediatePromotion: false };
          emit({ type: "confirmation", role: "B", trial, ...result.confirmation });
        }
        const identifiers = source => new Set(source.observations.writes.flatMap(receipt => receipt.fragments.map(fragment => fragment.fragmentId)));
        const sourcesA = identifiers(sourceA);
        const sourcesB = identifiers(sourceB);
        const copiesA = identifiers(snapshotA);
        const order = ["withoutMemory", "afterAgentA", "afterAgentsAB"];
        const rotation = Number.parseInt(digest(`${plan.seed}:three-agent:${trial}`).slice(0, 4), 16) % order.length;
        result.order = [...order.slice(rotation), ...order.slice(0, rotation)];
        for (const condition of result.order) {
          await driver.restart();
          const target = condition === "withoutMemory" ? null : memory(condition === "afterAgentA" ? `${slot}-a-only` : slot, "agent-c");
          const workspace = await workspaceFactory(kind, code);
          const stageStart = performance.now() - demoStarted;
          emit({ type: "stage_started", role: "C", trial, condition });
          try {
            if (workspace.fixtureSha256 !== fixtureSha256) throw new Error("demo_fixture_changed");
            const before = await workspace.test();
            if (before.passed || before.tests !== before.expectedTests) throw new Error("demo_requires_failing_fixture");
            const execution = await agentOutcome(agent, scenario.task, target, workspace, "", null, answerSchemaFor(kind));
            const exposed = target?.observations.exposed ?? new Set();
            const memoryExposure = { agentA: [...(condition === "afterAgentA" ? copiesA : sourcesA)].some(id => exposed.has(id)),
              agentB: [...sourcesB].some(id => exposed.has(id)) };
            result.conditions[condition] = { ...publishedOutcome(execution), memoryExposure, fixtureSha256, baselineTests: before };
            recordExecution(execution, "C", trial, condition, stageStart);
            emit({ type: "memory_delivery", role: "C", trial, condition, ...memoryExposure });
            emit({ type: "tests", role: "C", trial, condition, phase: "verification", ...execution.tests });
            emit({ type: "stage_finished", role: "C", trial, condition, success: execution.success, status: execution.status,
              inputTokens: execution.inputTokens, outputTokens: execution.outputTokens, toolCalls: execution.toolCalls });
          } finally { await workspace.close(); }
        }
        const { withoutMemory, afterAgentA, afterAgentsAB } = result.conditions;
        const preparedA = result.preparations.A.handoffVerification.ready;
        const preparedAB = preparedA && result.preparations.B.handoffVerification.ready && result.confirmation.status === "confirmed";
        result.comparisons = {
          afterAgentA: pairedMetrics(withoutMemory, afterAgentA, { preparationReady: preparedA, memoryExposed: afterAgentA.memoryExposure.agentA }),
          afterAgentsAB: pairedMetrics(withoutMemory, afterAgentsAB, { preparationReady: preparedAB,
            memoryExposed: afterAgentsAB.memoryExposure.agentA && afterAgentsAB.memoryExposure.agentB }),
          incrementalB: pairedMetrics(afterAgentA, afterAgentsAB, { preparationReady: preparedAB,
            memoryExposed: afterAgentA.memoryExposure.agentA && afterAgentsAB.memoryExposure.agentA && afterAgentsAB.memoryExposure.agentB }),
        };
        result.preparationCostMs = result.preparations.A.elapsedMs + result.preparations.B.elapsedMs;
        result.status = "measured";
      } catch {
        result.status = "error";
        result.reason = "demo_execution_failed";
        emit({ type: "stage_error", trial, reason: result.reason });
      }
    }
    events.sort((left, right) => left.atMs - right.atMs || left.id - right.id);
    return { status: trialResults.some(trial => trial.status === "error") ? "error" : "measured", protocol: threeAgentPlan,
      trials: trialResults, events, elapsedMs: performance.now() - demoStarted, independentTasks: 1,
      fixtureSha256, realMcpProcess: driver.realProcess, immediateReplayIsNotSpacedConsolidation: true,
      comparisonScope: "same original fixture; isolated A-only snapshot; C receives no earlier conversation or code edits" };
  }
  for (const category of selected) {
    onProgress({ event: "category_started", category });
    const scenario = plan.scenarios[category];
    try {
      switch (category) {
        case "three_agent_demo":
          results[category] = await threeAgentTask();
          break;
        case "atomic_extraction": {
          const preview = await driver.call("decompose_memory", { text: scenario.text });
          const score = scoreDecomposition(scenario, preview.data.results);
          const source = memory(category);
          const receipt = await storeEpisode(source, scenario, new Map());
          const restart = await driver.restart();
          const inspected = [];
          for (const fragment of receipt.fragments) {
            const original = await source.inspect(fragment.fragmentId);
            inspected.push(original.rawText === scenario.text && original.text === fragment.text && original.memoryId === receipt.memoryId);
          }
          const rawDuplicates = preview.data.results.length - new Set(preview.data.results.map(text => text.trim().replace(/\s+/g, " "))).size;
          results[category] = { status: "measured", scoring: "reviewed-exact-variants-unmatched-is-unverified", ...score,
            duplicateRate: preview.data.results.length ? rawDuplicates / preview.data.results.length : 0,
            latencyMs: preview.elapsedMs, persistence: { rawAndFragmentPreservation: inspected.every(Boolean),
              checkedFragments: inspected.length, restart, realServerProcess: driver.realProcess } };
          break;
        }
        case "simple_recall":
        case "semantic_recall": {
          const source = memory(category);
          const known = new Map();
          await storeFacts(source, scenario.facts, known);
          const restart = await driver.restart();
          const observations = [];
          for (const query of scenario.queries) observations.push(await observe(source, query, known));
          queries.push(...observations);
          results[category] = { status: "measured", restart, ...aggregateQueries(observations), observations,
            retrievalTokenCost: null, tokenCostReason: "MCP_does_not_report_embedding_or_decomposition_usage" };
          if (category === "simple_recall") results[category].agentAnswer = await pairedTask(category, scenario);
          break;
        }
        case "memory_over_time": {
          const source = memory(category);
          const known = new Map();
          const checkpoints = [];
          let previous = 0;
          for (const size of scenario.sizes) {
            await storeFacts(source, scenario.facts.slice(previous, size), known);
            previous = size;
            const chosen = [...Array.from({ length: Math.min(20, size) }, (_, index) => Math.floor(index * size / Math.min(20, size)))];
            const observations = [];
            for (const index of chosen) {
              const fact = scenario.facts[index];
              const query = fact.text.match(/The (\S+) service/)[1];
              observations.push(await observe(source, { id: `scale-${size}-${index}`, text: query, relevant: [fact.id] }, known));
            }
            for (let index = 0; index < 5; index += 1) observations.push(await observe(source,
              { id: `negative-${size}-${index}`, text: `absent${digest(`${plan.seed}:missing:${index}`).slice(0, 12)}`, relevant: [] }, known));
            queries.push(...observations);
            checkpoints.push({ requestedFacts: size, factsStored: known.size, ...aggregateQueries(observations), observations });
            onProgress({ event: "scale_checkpoint", requestedFacts: size, factsStored: known.size });
          }
          const points = checkpoints.map(point => ({ factsStored: point.factsStored, recall: point.recall, p95Ms: point.latency.p95Ms }));
          results[category] = { status: "measured", timeModel: "corpus-growth-not-elapsed-days", checkpoints, charts: scaleCharts(points) };
          break;
        }
        case "agent_handoff":
          results[category] = await pairedTask(category, scenario, "", async source => {
            const execution = await agent.run(`Retain these customer requirements for another agent, who will not see this conversation:\n${scenario.facts.map(fact => fact.text).join("\n")}\nFinish with JSON containing completed (boolean).`,
              agentTools(source, null, { recall: false, write: true }), "", answerSchemaFor(category, "preparation"));
            return { ...publicExecution(execution), memoriesWritten: source.observations.writes.length };
          });
          break;
        case "poisoning_resistance":
          results[category] = await pairedTask(category, scenario);
          break;
        case "contradiction_handling": {
          const source = memory(category);
          const known = new Map();
          const receipts = [];
          for (const fact of scenario.facts) receipts.push(await storeEpisode(source, { id: fact.id, text: fact.text, facts: [fact] }, known));
          const plain = await observe(source, { id: "plain-conflict", text: scenario.query, relevant: scenario.facts.map(fact => fact.id) }, known);
          const correction = await source.write(scenario.facts[1].text, { facts: [{ text: scenario.facts[1].text,
            links: [{ targetFragmentId: receipts[0].fragments[0].fragmentId, relationshipType: "supersedes" }] }] });
          for (const fragment of correction.fragments) known.set(fragment.fragmentId, "new-language");
          await driver.restart();
          const corrected = await observe(source, { id: "explicit-correction", text: "Bob", relevant: ["new-language"] }, known);
          const original = await source.inspect(receipts[0].fragments[0].fragmentId, true);
          queries.push(corrected);
          results[category] = { status: "measured", policy: "preserve-unlinked-claims-explicit-supersedes-controls-visibility", plainConflict: plain,
            corrected, supersededStateVerified: original.lifecycle?.state === "superseded",
            staleFactReturned: corrected.rankedFactIds.includes("old-language"), confidenceIsNotProbability: true,
            agentResolution: agent ? publishedOutcome(await agentOutcome(agent, scenario.task, source, null, "", scenario.rubric, answerSchemaFor(category))) : notMeasured("requires_explicit_agent_under_test") };
          break;
        }
        case "context_compression": {
          const source = memory(category);
          await storeFacts(source, scenario.facts, new Map());
          const recalled = await source.recall("Project Vega", 5);
          const history = `${scenario.history}\n${scenario.facts.map(fact => fact.text).join("\n")}`;
          const historyBytes = Buffer.byteLength(history);
          results[category] = { status: "measured", historyUtf8Bytes: historyBytes, retrievedJsonBytes: recalled.resultBytes,
            byteReductionPercent: 100 * (historyBytes - recalled.resultBytes) / historyBytes,
            bytesAreNotTokens: true, agentComparison: await pairedTask(category, scenario, history),
            costScope: "agent-inference-only-memory-provider-costs-not-reported" };
          break;
        }
        case "coding_workflow":
          results[category] = await codingTask(category, scenario);
          results.rediscovery_demo = await codingTask("rediscovery_demo", plan.scenarios.rediscovery_demo);
          break;
        case "multi_day_learning":
          results[category] = { ...notMeasured("requires_resumable_observations_over_real_elapsed_days"),
            requiredDays: [1, 2, 30], longTermLearning: null, noSleepOrSimulatedTimeCredited: true };
          break;
      }
    } catch {
      results[category] = { status: "error", reason: "category_execution_failed_no_success_claim" };
    }
    onProgress({ event: "category_finished", category, status: results[category].status });
  }
  const aggregate = aggregateQueries(queries);
  const agentPairs = pairs.filter(pair => pair.withMemory.status === "completed" && pair.withoutMemory.status === "completed");
  const actualFragments = new Set(memories.flatMap(memory => memory.observations.writes.flatMap(receipt => receipt.fragments.map(fragment => fragment.fragmentId))));
  const agentRuns = new Map();
  const pending = [results];
  while (pending.length) {
    const value = pending.pop();
    if (!value || typeof value !== "object") continue;
    if (typeof value.sessionId === "string" && Array.isArray(value.trace) && typeof value.status === "string") {
      agentRuns.set(value.sessionId, value);
    } else pending.push(...Object.values(value));
  }
  const agentFailures = [...agentRuns.values()].filter(outcome => outcome.status !== "completed").length;
  return { reportVersion: 2, harness: "MindLeak Validation Harness v1", runId, createdAt: new Date().toISOString(),
    status: Object.values(results).some(result => result.status === "error") || agentFailures ? "partial" : "completed",
    scenarioManifest: { id: plan.id, sha256: digest(plan), seed: plan.seed, selected, sizes: plan.sizes,
      answerContractsSha256: digest(["simple_recall", "agent_handoff", "poisoning_resistance", "contradiction_handling", "context_compression", "coding_workflow", "rediscovery_demo", "multi_day_learning"].map(category => answerSchemaFor(category))),
      handoffContractsSha256: digest(["coding_workflow", "rediscovery_demo"].map(kind => handoffSchema(kind))),
      codingFixtureSha256: Object.fromEntries(["coding_workflow", "rediscovery_demo"].map(kind => [kind, digest(codingFixture(kind))])) },
    server: driver.server, binarySha256: driver.binarySha256, realMcpProcess: driver.realProcess,
    agent: agent?.configuration ?? null, codeContainer: code ? { engine: code.engine, imageId: code.image } : null,
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, availableParallelism: availableParallelism() },
    summary: { facts_stored: actualFragments.size, precision: aggregate.precision, recall: aggregate.recall,
      avg_retrieval_ms: aggregate.latency.meanMs, false_positive_rate: aggregate.falsePositiveRate,
      token_savings: mean(measured(results.context_compression?.agentComparison?.trials?.map(trial => trial.comparison.inputTokenReductionPercent) ?? [])),
      multi_agent_transfer: mean(results.agent_handoff?.trials?.map(trial => trial.transferSuccess) ?? []),
      handoff_trials: results.agent_handoff?.trials?.length ?? 0,
      handoff_ready_trials: results.agent_handoff?.trials?.filter(trial => trial.stages.preparationReady).length ?? 0,
      handoff_exposed_trials: results.agent_handoff?.trials?.filter(trial => trial.stages.matchingSourceDelivered).length ?? 0,
      multi_agent_transfer_conditional: mean(results.agent_handoff?.trials?.filter(trial => trial.stages.preparationReady && trial.stages.matchingSourceDelivered && trial.stages.answerCompleted).map(trial => trial.transferSuccess) ?? []),
      error_amplification: mean(agentPairs.map(pair => pair.comparison.errorAmplified)),
      long_term_learning: null, retrieval_queries: queries.length, adjudicated_agent_pairs: agentPairs.length,
      agent_execution_failures: agentFailures, measured_categories: Object.values(results).filter(result => result.status === "measured").length },
    definitions: { precision: "macro verified relevant fraction among nonempty returned top-5 results; duplicates consume slots",
      recall: "macro verified fact recall@5 across positive queries, not final agent correctness",
      false_positive_rate: "fraction of designated no-answer queries with a nonempty result",
      token_savings: "mean percent reduction of provider-reported input tokens on correct compression pairs with verified preparation and delivered memory only",
      error_amplification: "fraction of completed paired tasks correct without memory and incorrect with it",
      multi_agent_transfer: "end-to-end fraction of all handoff trials with verified stored facts, completed preparation, delivered Agent A memory, and a correct answer",
      multi_agent_transfer_conditional: "same outcome among verified-preparation, exposed, completed-answer trials only; inspect all-stage counts and end-to-end rate as well",
      unmeasured: "null is unknown, never zero; synthetic repeated trials are not independent real-world tasks" },
    elapsedMs: performance.now() - started, serverRestarts: driver.restarts, categories: results,
    limitations: ["Synthetic diagnostic scenarios, not production usage or independently verified semantic accuracy.",
      "No memory/query/provider bodies are exported. Fixed scenario text is available separately in the plan.",
      "Agent outcome rubrics use conservative structured answers and fixed coding tests, not an LLM judge.",
      "Provider token counts cover the agent only, not optional MindLeak extraction/embedding/relevance inference.",
      "No 50-80 percent savings target is assumed; incorrect or unmeasured pairs cannot earn speed savings."] };
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, plan: { type: "boolean" }, binary: { type: "string" }, seed: { type: "string" },
    sizes: { type: "string" }, category: { type: "string", multiple: true }, trials: { type: "string" },
    agent: { type: "boolean" }, "agent-max-steps": { type: "string" }, "agent-timeout-ms": { type: "string" },
    "agent-provider": { type: "string" }, "agent-model": { type: "string" },
    "agent-max-output-tokens": { type: "string" }, "agent-reasoning-effort": { type: "string" },
    "input-usd-per-million": { type: "string" }, "output-usd-per-million": { type: "string" },
    "code-engine": { type: "string" }, "code-image": { type: "string" },
    "longitudinal-state": { type: "string" }, day: { type: "string" },
    "chart-dir": { type: "string" }, "replay-dir": { type: "string" },
    decomposition: { type: "string" }, retrieval: { type: "string" }, relevance: { type: "string" },
    "min-similarity": { type: "string" }, "relevance-candidates": { type: "string" },
  } });
  if (values.help) {
    console.log(JSON.stringify({ name: "MindLeak Validation Harness v1", commands: {
      plan: "node examples/validation-harness.mjs --plan",
      modelFree: "MINDLEAK_TEST_DATABASE_URL=..._test node examples/validation-harness.mjs --binary target/debug/mindleak-light",
      agents: "Set MINDLEAK_VALIDATION_AGENT_URL and MINDLEAK_VALIDATION_AGENT_MODEL, then add --agent --code-engine podman",
      threeAgents: "--category three_agent_demo --agent --agent-provider copilot --agent-model gpt-6-astra --code-engine podman --replay-dir NEW_DIRECTORY",
      longitudinal: "--longitudinal-state PRIVATE_PATH --day 1|2|30 (requires actual elapsed time; retains synthetic memory between invocations)",
    }, categories, optionalCategories, defaultSizes: [100, 500, 1000], controls: ["--seed UINT32", "--sizes 100,500,1000", "--category NAME (repeatable)",
      "--trials 1..10", "--retrieval keyword|vector|hybrid", "--decomposition sentences|openai", "--relevance off|openai",
      "--agent-provider openai|copilot", "--agent-model MODEL_ID", "--agent-max-steps 1..32", "--agent-timeout-ms 100..300000", "--agent-max-output-tokens 128..16384 (OpenAI-compatible)", "--agent-reasoning-effort none|low|medium|high|max", "--code-image IMAGE", "--chart-dir NEW_DIRECTORY", "--input-usd-per-million RATE --output-usd-per-million RATE (OpenAI-compatible)"],
      privacy: "Local synthetic data only; no uploads, production database, provider bodies, or secret exports." }, null, 2));
    return;
  }
  const plan = generateScenarios({ seed: Number(values.seed ?? 20260916), sizes: values.sizes?.split(",").map(Number) ?? [100, 500, 1000] });
  const selected = values.category ?? categories;
  if (selected.some(category => ![...categories, ...optionalCategories].includes(category)) || new Set(selected).size !== selected.length) throw new Error("invalid_category");
  const providerKind = values["agent-provider"] ?? "openai";
  if (!["openai", "copilot"].includes(providerKind)) throw new Error("invalid_agent_provider");
  if (values["replay-dir"] && (!selected.includes("three_agent_demo") || values.day !== undefined)) throw new Error("replay_requires_three_agent_demo");
  if (values.plan) {
    console.log(JSON.stringify({ ...plan, ...(selected.includes("three_agent_demo") ? { threeAgentDemo: threeAgentPlan } : {}) }, null, 2));
    return;
  }
  const trials = Number(values.trials ?? 1);
  if (!Number.isInteger(trials) || trials < 1 || trials > 10) throw new Error("invalid_trials");
  if (selected.includes("three_agent_demo") && (!values.agent || !values["code-engine"])) throw new Error("demo_requires_agent_and_container");
  const settings = benchmarkSettings(process.env, values);
  if (values["chart-dir"] && (!selected.includes("memory_over_time") || values.day !== undefined)) throw new Error("charts_require_scale_scenarios");
  if (values["code-image"] && !values["code-engine"]) throw new Error("code_image_requires_code_engine");
  if ((values.day !== undefined) !== (values["longitudinal-state"] !== undefined)
    || values.day !== undefined && (![1, 2, 30].includes(Number(values.day)) || values.category || values.sizes || values.trials || values["code-engine"])) {
    throw new Error("invalid_longitudinal_options");
  }
  if (!values.agent && ["agent-provider", "agent-model", "agent-max-steps", "agent-timeout-ms", "agent-max-output-tokens", "agent-reasoning-effort", "input-usd-per-million", "output-usd-per-million", "code-engine", "code-image"]
    .some(name => values[name] !== undefined)) throw new Error("agent_options_require_agent");
  if (providerKind === "copilot" && ["agent-max-output-tokens", "input-usd-per-million", "output-usd-per-million"].some(key => values[key] !== undefined)) {
    throw new Error("copilot_uses_recorded_session_limits_not_openai_budget_overrides");
  }
  const code = values["code-engine"] ? await containerConfiguration(values["code-engine"], values["code-image"]) : null;
  const binary = values.binary ?? fileURLToPath(new URL(`../target/debug/mindleak-light${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  const sources = ["validation-harness.mjs", "validation-scenarios.mjs", "validation-runtime.mjs", "validation-agent.mjs", "validation-longitudinal.mjs", "benchmark-recall.mjs"];
  if (providerKind === "copilot") sources.push("copilot-agent.mjs");
  if (selected.includes("three_agent_demo")) sources.push("demo-replay.mjs", "demo-view.mjs", "demo-view.html");
  const sourceHashes = async () => Object.fromEntries(await Promise.all(sources.map(async path => [path, digest(await readFile(new URL(path, import.meta.url)))])));
  const harnessSources = await sourceHashes();
  const replayDirectory = values["replay-dir"] ? resolve(values["replay-dir"]) : null;
  if (replayDirectory) { await mkdir(dirname(replayDirectory), { recursive: true }); await mkdir(replayDirectory, { mode: 0o700 }); }
  let driver;
  let provider;
  let report;
  try {
    provider = values.agent && providerKind === "copilot" ? await openCopilotProvider() : null;
    const agent = provider ? createCopilotAgent(provider, { model: values["agent-model"] ?? "gpt-6-astra",
      maxSteps: Number(values["agent-max-steps"] ?? 16), timeoutMs: Number(values["agent-timeout-ms"] ?? 300000),
      reasoningEffort: values["agent-reasoning-effort"] ?? "low" })
      : values.agent ? await createAgent(agentSettings({ ...process.env,
        ...(values["agent-model"] ? { MINDLEAK_VALIDATION_AGENT_MODEL: values["agent-model"] } : {}) }, {
        maxSteps: Number(values["agent-max-steps"] ?? 16), timeoutMs: Number(values["agent-timeout-ms"] ?? 60000),
        maxOutputTokens: Number(values["agent-max-output-tokens"] ?? 4096), reasoningEffort: values["agent-reasoning-effort"] ?? null,
        inputPrice: values["input-usd-per-million"] === undefined ? null : Number(values["input-usd-per-million"]),
        outputPrice: values["output-usd-per-million"] === undefined ? null : Number(values["output-usd-per-million"]) })) : null;
    driver = await openMemoryDriver(binary, settings);
    report = values["longitudinal-state"]
      ? await runLongitudinal({ driver, plan, agent, statePath: values["longitudinal-state"], day: Number(values.day), binding: longitudinalBinding(settings, plan) })
      : await runValidation({ driver, plan, agent, code, trials, selected,
        onProgress: event => console.error(JSON.stringify(event)) });
    report.configuration = settings.configuration;
  } finally { try { if (driver) await driver.close(); } finally { if (provider) await provider.close(); } }
  report.harnessSources = harnessSources;
  report.sourceFilesUnchangedDuringRun = digest(harnessSources) === digest(await sourceHashes());
  if (!report.sourceFilesUnchangedDuringRun) report.status = "partial";
  if (values["chart-dir"]) {
    try {
      const points = report.categories.memory_over_time.checkpoints.map(point => ({ factsStored: point.factsStored, recall: point.recall, p95Ms: point.latency.p95Ms }));
      const charts = await renderScaleCharts(points);
      const directory = resolve(values["chart-dir"]);
      await mkdir(dirname(directory), { recursive: true });
      await mkdir(directory, { mode: 0o700 });
      for (const [name, svg] of Object.entries(charts)) await writeFile(join(directory, `${name}.svg`), svg, { flag: "wx", mode: 0o600 });
      report.chartArtifacts = { status: "written", files: Object.keys(charts).map(name => `${name}.svg`) };
    } catch {
      report.status = "partial";
      report.chartArtifacts = { status: "error", reason: "chart_render_or_new_directory_write_failed" };
    }
  }
  if (replayDirectory) {
    try {
      report.replayArtifacts = { status: "written", files: ["report.json", "index.html"] };
      await writeDemoReplay(report, replayDirectory, { reserved: true });
    } catch {
      report.status = "partial";
      report.replayArtifacts = { status: "error", reason: "replay_recording_failed" };
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (report.status === "partial") process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => {
    console.log(JSON.stringify({ reportVersion: 2, status: "error", reason: "validation_startup_or_configuration_failed", summary: null }));
    process.exitCode = 1;
  });
}
