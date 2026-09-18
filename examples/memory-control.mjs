import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digest, pairedMetrics } from "./validation-scenarios.mjs";
import { upgradeCases } from "./memory-lab-fixture.mjs";
import { swarmRoles, controlRoles } from "./swarm-fixture.mjs";
import { createKnowledgeLedger, investigatorTools, knowledgeBrief, knowledgeToolView, memoryStartPrompt, memoryProtocol } from "./memory-lab.mjs";
import { publicExecution } from "./validation-agent.mjs";

export { controlRoles } from "./swarm-fixture.mjs";

export function controlPlan({ pairs = 5, rounds = 1, model = null, agentModels = {}, maxSteps = 24, timeoutMs = 600000, maxAiCredits = 30 } = {}) {
  if (pairs !== 5 || !Number.isInteger(rounds) || rounds < 1 || rounds > 3
    || model !== null && (typeof model !== "string" || !model.trim() || model.length > 256 || model === "auto")
    || !Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 32 || !Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 900000
    || !Number.isFinite(maxAiCredits) || maxAiCredits < 30 || maxAiCredits > 100) throw new Error("invalid_control_plan");
  if (!agentModels || typeof agentModels !== "object" || Array.isArray(agentModels) || Object.keys(agentModels).some(id => !swarmRoles.some(role => role.id === id))) throw new Error("invalid_control_plan");
  const planned = Array.from({ length: rounds }, (_, roundIndex) => upgradeCases({ split: "evaluation", round: roundIndex + 1 }).map((specification, index) => {
    const role = swarmRoles[index];
    const selected = model ?? agentModels[role.id] ?? (index < 3 ? "gpt-6-astra" : "claude-opus-5");
    if (typeof selected !== "string" || !selected.trim() || selected.length > 256 || selected === "auto") throw new Error("invalid_control_plan");
    const common = { caseId: specification.id, fixtureSha256: specification.fixtureSha256, model: selected, maxSteps, timeoutMs, maxAiCredits };
    return { id: `round-${roundIndex + 1}-pair-${index + 1}`, round: roundIndex + 1, caseId: specification.id, family: specification.family,
      schedule: "common-start-barrier", withMemory: { ...common, agent: role.id, name: role.name, memoryAccess: "read-only-frozen-guide" },
      withoutMemory: { ...common, agent: controlRoles[index].id, name: controlRoles[index].name, memoryAccess: "none" } };
  })).flat();
  return { version: 3, experiment: "simultaneous-memory-control", model: model ?? "Mixed matched models", rounds, pairs: planned,
    agentExecutions: planned.length * 2, concurrency: 10, caseVariants: planned.length, caseFamilies: 5, freshSessions: true,
    sameSourceAndCorrectnessChecks: true, noCrossArmConversationOrEdits: true, memoryWritesDuringComparison: false,
    preparationCostsIncluded: true, feedbackBetweenRoundsOnly: true, fixtureVersion: 2, fixtureSha256: digest(planned.map(pair => pair.withMemory.fixtureSha256)),
    maximumModelTurns: planned.length * 2 * maxSteps, maximumSessionCredits: planned.length * 2 * maxAiCredits, estimatedCostUsd: null,
    interpretation: "Five matched pairs start concurrently in each round after the guide is frozen. Both arms have identical cases, models, budgets and correctness checks. Memory is read-only until every arm finishes. Later rounds use new values in the same five families, not independent task families. Preparation, between-round learning and memory-processing costs remain visible; repeated exposure is not independent confirmation and no benefit is assumed." };
}

export function continueMemoryPreparation(parent) {
  const accepted = parent?.knowledge?.principles?.find(node => node.chainId === parent.guide?.chainId);
  if (parent?.kind !== "memory_lab" || parent.status !== "completed" || parent.fixtureVersion !== 2 || typeof parent.scope !== "string"
    || !accepted || accepted.state !== "accepted" || accepted.revision !== parent.guide.revision) throw new Error("completed_learning_parent_required");
  return { ...structuredClone(parent), runId: randomUUID(), createdAt: new Date().toISOString(), status: "completed", failure: null,
    preparationReused: true, parentRunId: parent.runId, memoryProtocol, controlExperiment: undefined, comparisons: [], events: [], elapsedMs: 0,
    agents: parent.agents.filter(actor => !actor.control).map(actor => ({ ...structuredClone(actor), state: "queued", attempts: [], evidenceAttempts: [], guideAttempts: [] })),
    summary: { ...parent.summary, agents: 5, agentsPassed: 0, inputTokens: 0, outputTokens: 0, toolCalls: 0 },
    memoryProcessing: { ...parent.memoryProcessing, calls: 0, inputTokens: 0, outputTokens: 0 },
    finalTests: { passed: true, passedTests: 0, expectedTests: 0 }, memoryExhibits: [], toolExhibits: [] };
}

const sum = (records, field) => records.every(record => Number.isFinite(record?.[field]) && record[field] >= 0)
  ? records.reduce((total, record) => total + record[field], 0) : null;
const add = (...values) => values.every(value => Number.isFinite(value) && value >= 0) ? values.reduce((total, value) => total + value, 0) : null;
const reduction = (baseline, memory) => Number.isFinite(baseline) && baseline > 0 && Number.isFinite(memory) ? 100 * (baseline - memory) / baseline : null;

export function controlSummary(preparation, rounds, plannedPairs) {
  const pairs = rounds.flatMap(round => round.pairs);
  const learning = rounds.flatMap(round => round.learning ? [round.learning] : []);
  const group = condition => {
    const outcomes = pairs.map(pair => pair[condition]);
    return { correct: outcomes.filter(outcome => outcome.passed).length, attempts: outcomes.length,
      inputTokens: sum(outcomes, "inputTokens"), outputTokens: sum(outcomes, "outputTokens"), toolCalls: sum(outcomes, "toolCalls"),
      agentWorkMs: sum(outcomes, "elapsedMs"), wallMs: sum(rounds.map(round => ({ elapsedMs: Math.max(0, ...round.pairs.map(pair => pair[condition].finishedAtMs))
        - Math.min(...round.pairs.map(pair => pair[condition].startedAtMs)) })), "elapsedMs") };
  };
  const withMemory = group("withMemory");
  const withoutMemory = group("withoutMemory");
  withMemory.preparationInputTokens = preparation.summary.inputTokens;
  withMemory.preparationOutputTokens = preparation.summary.outputTokens;
  withMemory.learningInputTokens = sum(learning, "inputTokens");
  withMemory.learningOutputTokens = sum(learning, "outputTokens");
  withMemory.totalInputTokens = add(withMemory.inputTokens, withMemory.preparationInputTokens, withMemory.learningInputTokens);
  withMemory.totalOutputTokens = add(withMemory.outputTokens, withMemory.preparationOutputTokens, withMemory.learningOutputTokens);
  withMemory.totalWallMs = add(withMemory.wallMs, preparation.elapsedMs, sum(learning, "elapsedMs"), sum(rounds, "freezeMs"));
  const eligible = preparation.status === "completed" && pairs.length === plannedPairs && withMemory.correct === plannedPairs && withoutMemory.correct === plannedPairs
    && pairs.every(pair => pair.withMemory.guideRetrievedBeforeAssessment) && rounds.every(round => round.frozen.unchangedAfterComparison);
  const memoryProcessing = [preparation.memoryProcessing, ...learning.map(cost => cost.memoryProcessing)];
  return { scheduledPairs: plannedPairs, completedPairs: pairs.length, rounds: rounds.length, withMemory, withoutMemory,
    memoryProcessing: { calls: sum(memoryProcessing, "calls"), inputTokens: sum(memoryProcessing, "inputTokens"), outputTokens: sum(memoryProcessing, "outputTokens") },
    savings: { eligible, assessmentInputPercent: eligible ? reduction(withoutMemory.inputTokens, withMemory.inputTokens) : null,
      includingPreparationInputPercent: eligible ? reduction(withoutMemory.inputTokens, withMemory.totalInputTokens) : null,
      assessmentWallPercent: eligible ? reduction(withoutMemory.wallMs, withMemory.wallMs) : null,
      includingPreparationWallPercent: eligible ? reduction(withoutMemory.wallMs, withMemory.totalWallMs) : null },
    costUsd: null, timingScope: "Per-arm wall time spans its five concurrent sessions. Agent work time is reported separately. Memory totals include the complete preparation, freeze checks and every between-round learning phase. Shared provider/host contention can influence concurrent timing; tokens from different model classes are not priced as equivalent." };
}

const finalSchema = { type: "object", additionalProperties: false, properties: { completed: { type: "boolean" }, finding: { type: ["object", "null"], additionalProperties: false,
  properties: { claim: { type: "string", minLength: 1, maxLength: 1200 }, path: { type: "string", maxLength: 256 },
    quote: { type: "string", minLength: 4, maxLength: 1200 }, guideStep: { type: ["string", "null"], maxLength: 700 } },
  required: ["claim", "path", "quote", "guideStep"] } }, required: ["completed", "finding"] };

async function readGuide(driver, preparation) {
  const principles = [];
  for (const expected of preparation.knowledge.principles.filter(node => node.state === "accepted")) {
    const result = (await driver.call("recall_memory", { chain: { operation: "inspect", chainId: expected.chainId }, scope: preparation.scope, limit: 2 })).data;
    if (result.chain?.chainId !== expected.chainId || result.chain.revision !== expected.revision
      || result.chain.snapshot?.state !== "accepted" || result.requiresReview !== false || !isDeepStrictEqual(result.chain.snapshot.document, expected.document)) throw new Error("control_guide_changed");
    principles.push(knowledgeToolView(result));
  }
  const primary = principles.find(record => record.chain.chainId === preparation.guide.chainId);
  if (!primary || primary.chain.revision !== preparation.guide.revision) throw new Error("control_guide_changed");
  return { primary, principles };
}

export async function runMemoryControl({ driver, preparation, agentsByRole, code, rounds = 1, learn,
  signal, onEvent = () => {}, onToolDetail = () => {} } = {}) {
  if (!driver?.capabilities?.knowledge || !driver.capabilities.chains || preparation?.status !== "completed" || preparation.fixtureVersion !== 2
    || !preparation.guide || !code || swarmRoles.some(role => !agentsByRole?.[role.id]?.run) || rounds > 1 && !learn) throw new Error("invalid_control_configuration");
  const first = agentsByRole[swarmRoles[0].id].configuration;
  const budgets = { maxSteps: first.maxSteps ?? 24, timeoutMs: first.timeoutMs ?? 600000, maxAiCredits: first.maxAiCredits ?? 30 };
  for (const agent of Object.values(agentsByRole)) for (const [field, value] of Object.entries(budgets)) {
    if ((agent.configuration[field] ?? value) !== value) throw new Error("unequal_control_budgets");
  }
  const plan = controlPlan({ rounds, ...budgets, agentModels: Object.fromEntries(swarmRoles.map(role => [role.id, agentsByRole[role.id].configuration.model])) });
  const runId = randomUUID();
  const started = performance.now();
  const events = []; const completedRounds = []; const toolExhibits = [];
  let current = preparation; let failure = null;
  const emit = record => { if (events.length >= 20000) throw new Error("control_event_budget"); const event = { ...record, id: events.length + 1, atMs: performance.now() - started }; events.push(event); onEvent(structuredClone(event)); };
  const details = detail => { toolExhibits.push(detail); onToolDetail(detail); };
  emit({ type: "control_started", runId, rounds, agents: 10, expectedTests: plan.pairs.length * 14 });
  try {
    for (let number = 1; number <= rounds && !signal?.aborted; number += 1) {
      const freezeStarted = performance.now();
      const transition = await driver.restart();
      if (transition.previous === transition.current || transition.previousPid && transition.previousPid === transition.currentPid) throw new Error("memory_server_did_not_restart");
      const frozenCollection = await readGuide(driver, current);
      const frozenView = frozenCollection.primary;
      const frozenPrinciples = new Map(frozenCollection.principles.map(record => [record.chain.chainId, record]));
      const allowedSources = new Set(frozenCollection.principles.flatMap(record => [...record.chain.snapshot.document.evidence,
        ...record.supportingChains.flatMap(support => support.document?.evidence ?? [])]).map(reference => reference.fragmentId));
      const knownChains = new Map(frozenCollection.principles.flatMap(record => [[record.chain.chainId, record.chain], ...record.supportingChains.map(support => [support.reference.chainId,
        { chainId: support.reference.chainId, revision: support.reference.revision, snapshot: { document: support.document, state: support.state } }])]));
      const round = { number, frozen: { chainId: frozenView.chain.chainId, revision: frozenView.chain.revision, documentSha256: digest(frozenCollection),
        principles: frozenCollection.principles.map(record => ({ chainId: record.chain.chainId, revision: record.chain.revision, documentSha256: digest(record) })), ...transition,
        unchangedAfterComparison: false }, freezeMs: performance.now() - freezeStarted, pairs: [] };
      emit({ type: "control_guide_frozen", round: number, ...round.frozen });
      const cases = upgradeCases({ split: "evaluation", round: number });
      const planned = plan.pairs.filter(pair => pair.round === number);
      const barrier = Promise.withResolvers();
      const jobs = planned.flatMap((pair, index) => ["withMemory", "withoutMemory"].map(async condition => {
        await barrier.promise;
        const arm = pair[condition]; const specification = cases[index];
        const startedAtMs = performance.now() - started;
        const relay = event => emit({ ...event, agent: arm.agent, condition, round: number, experimentPhase: "control" });
        const session = investigatorTools({ driver, scope: current.scope, actor: arm.agent, specification, code,
          ledger: { observations: [], nodes: new Map() }, condition, index: 0, memoryEnabled: false, emit: relay,
          onToolDetail: detail => details({ ...detail, round: number }) });
        const reads = []; const sourceIds = new Set(); const receivedGuides = new Map();
        let receivedAtMs = null; let execution;
        const memoryTool = (name, description, properties, required, invoke) => ({ definition: { type: "function", function: { name, description,
          parameters: { type: "object", additionalProperties: false, properties, required } } }, invoke: async (args, context = {}) => {
          details({ agent: arm.agent, condition, round: number, tool: name, toolCallId: context.toolCallId ?? randomUUID(), arguments: args });
          const readStarted = performance.now();
          const result = await invoke(args);
          const bytes = Buffer.byteLength(JSON.stringify(result));
          if (bytes > 64 * 1024) throw new Error("agent_tool_result_budget");
          const receipt = { tool: name, elapsedMs: performance.now() - readStarted, bytes };
          reads.push(receipt); relay({ type: "memory_read", ...receipt });
          return result;
        } });
        const tools = [...session.tools];
        if (condition === "withMemory") tools.push(
          memoryTool("recall_guide", "Search the frozen collection of accepted MindLeak principles. Use focused topic keywords for the current decision, then read the relevant procedure, applicability and revision. Other focused searches can retrieve different principles from the same collection. Returns no later-round knowledge; no writes are permitted.",
            { query: { type: "string", minLength: 1, maxLength: 256 } }, ["query"], async ({ query }) => {
              const result = (await driver.call("recall_memory", { knowledge: { operation: "search", query }, scope: current.scope, limit: 2 })).data;
              const record = result.principles?.find(record => frozenPrinciples.has(record.chain?.chainId));
              if (!record) return { kind: "knowledge", view: "guide-first", principles: [], chains: [], observations: [], sourceReferences: [] };
              if (!isDeepStrictEqual(knowledgeToolView(record), frozenPrinciples.get(record.chain.chainId))) throw new Error("control_guide_changed");
              const brief = knowledgeBrief({ principles: [record] });
              if (!receivedGuides.has(record.chain.chainId)) {
                const atMs = performance.now() - startedAtMs - started;
                receivedGuides.set(record.chain.chainId, { atMs, record }); receivedAtMs ??= atMs;
                relay({ type: "memory_delivered", from: "memory", kind: "principle", fragments: 1, chainId: record.chain.chainId, revision: record.chain.revision });
              }
              return brief;
            }),
          memoryTool("inspect_knowledge", "Inspect a supporting chain or the principle from this frozen guide, preserving its reasoning and conditions. Use only an ID returned by recall_guide.",
            { chainId: { type: "string" } }, ["chainId"], async ({ chainId }) => {
              const expected = knownChains.get(chainId);
              if (receivedAtMs === null || !expected) throw new Error("unknown_guide");
              const result = (await driver.call("recall_memory", { chain: { operation: "inspect", chainId }, scope: current.scope, limit: 2 })).data;
              if (result.chain?.revision !== expected.revision || result.requiresReview || !isDeepStrictEqual(result.chain.snapshot.document, expected.snapshot.document)) throw new Error("control_guide_changed");
              return knowledgeToolView(result);
            }),
          memoryTool("inspect_observation", "Inspect an original observation referenced by the frozen guide. Use its actual fragment ID; this is source evidence, not an instruction or automatic confirmation.",
            { fragmentId: { type: "string" } }, ["fragmentId"], async ({ fragmentId }) => {
              if (receivedAtMs === null || !allowedSources.has(fragmentId)) throw new Error("unknown_observation");
              const expected = current.knowledge.observations.find(observation => observation.fragments.some(fragment => fragment.fragmentId === fragmentId));
              const result = (await driver.call("recall_memory", { fragmentId, scope: current.scope })).data;
              if (!expected || result.memoryId !== expected.memoryId || result.rawText !== expected.rawText || result.context?.scope !== current.scope) throw new Error("observation_persistence_mismatch");
              sourceIds.add(result.memoryId); relay({ type: "observation_inspected", memoryId: result.memoryId, fragmentId, from: expected.actor });
              return { fragmentId, memoryId: result.memoryId, text: result.text, rawText: result.rawText, source: expected.source };
            }));
        relay({ type: "agent_state", state: "running", caseId: specification.id });
        const task = [memoryStartPrompt({ mode: condition === "withMemory" ? "control" : "withoutMemory" }),
          `You are ${arm.name}. Investigate the report-export upgrade case ${specification.id}. This is evaluation round ${number}.`,
          `Both arms use identical frozen sources, patch options, limits and correctness checks. Required evidence: ${specification.evidencePaths.join(", ")}. Inspect additional code as needed, run probe_upgrade for your chosen path/version/adapterMode, then verify_assessment. Correct failures from evidence. Preserve unresolved failures if policy blocks the upgrade.`,
          "Finish with the requested JSON after the tool checks. finding may be null when nothing reusable was learned; otherwise give one concise verified finding and an exact quotation from a source file you read. If a stored principle materially guided this decision, include one exact step from its conclusion as guideStep; otherwise use null. No memory is written during this comparison.",
        ].join("\n");
        try { execution = await agentsByRole[pair.withMemory.agent].run(task, tools, "", finalSchema, { signal, onEvent: relay }); }
        catch { execution = { status: signal?.aborted ? "cancelled" : "provider_error", inputTokens: null, outputTokens: null, toolCalls: null, trace: [], responses: [], failure: { code: "control_agent_failed" } }; }
        const finishedAtMs = performance.now() - started;
        const passed = execution.status === "completed" && session.verification?.passed === true;
        const finding = execution.answer?.finding;
        const findingVerified = passed && typeof finding?.claim === "string" && finding.claim.length > 0 && finding.claim.length <= 1200
          && typeof finding.quote === "string" && finding.quote.length >= 4 && finding.quote.length <= 1200 && session.workspace.filesRead.has(finding.path)
          && specification.files[finding.path]?.includes(finding.quote);
        const receivedBefore = receivedAtMs !== null && session.investigationMs !== null && receivedAtMs <= session.investigationMs;
        const usedGuide = findingVerified && receivedBefore && typeof finding.guideStep === "string" && finding.guideStep.length >= 12
          ? [...receivedGuides.values()].find(({ atMs, record }) => atMs <= session.investigationMs && record.chain.snapshot.document.conclusion.includes(finding.guideStep))?.record : null;
        const applied = Boolean(usedGuide);
        const outcome = { ...publicExecution(execution), agent: arm.agent, name: arm.name, condition, model: arm.model, caseId: specification.id,
          startedAtMs, finishedAtMs, elapsedMs: finishedAtMs - startedAtMs, investigationMs: session.investigationMs,
          verification: session.verification, answer: session.answer, passed, success: passed, knowledgeReceived: receivedAtMs !== null,
          guideRetrievedBeforeAssessment: receivedBefore, guideApplied: Boolean(applied), finding: findingVerified ? finding : null,
          receivedPrinciples: [...receivedGuides.values()].map(({ atMs, record }) => ({ chainId: record.chain.chainId, revision: record.chain.revision, atMs })),
          guideUsed: usedGuide ? { chainId: usedGuide.chain.chainId, revision: usedGuide.chain.revision } : null,
          memoryReads: reads, sourceObservationsRead: sourceIds.size, upgradeProbes: session.workspace.probes, fixtureSha256: specification.fixtureSha256 };
        relay({ type: "agent_state", state: passed ? "passed" : signal?.aborted ? "cancelled" : "failed", caseId: specification.id });
        relay({ type: "control_arm_finished", passed, caseId: specification.id, inputTokens: outcome.inputTokens, outputTokens: outcome.outputTokens,
          elapsedMs: outcome.elapsedMs, guideRetrievedBeforeAssessment: receivedBefore, guideApplied: Boolean(applied) });
        return { pairId: pair.id, condition, outcome };
      }));
      emit({ type: "control_round_started", round: number, readySessions: jobs.length, expectedSessions: 10 });
      barrier.resolve();
      const outcomes = await Promise.all(jobs);
      round.pairs = planned.map(pair => {
        const withMemory = outcomes.find(result => result.pairId === pair.id && result.condition === "withMemory").outcome;
        const withoutMemory = outcomes.find(result => result.pairId === pair.id && result.condition === "withoutMemory").outcome;
        return { ...pair, withMemory, withoutMemory, startSkewMs: Math.abs(withMemory.startedAtMs - withoutMemory.startedAtMs),
          metrics: pairedMetrics(withoutMemory, withMemory, { memoryExposed: withMemory.guideRetrievedBeforeAssessment, preparationReady: true }) };
      });
      completedRounds.push(round);
      const checkedAt = performance.now();
      round.frozen.unchangedAfterComparison = isDeepStrictEqual(await readGuide(driver, current), frozenCollection);
      round.freezeMs += performance.now() - checkedAt;
      if (!round.frozen.unchangedAfterComparison) throw new Error("control_guide_changed");
      emit({ type: "control_round_finished", round: number, pairs: round.pairs.length, correct: round.pairs.reduce((total, pair) => total + Number(pair.withMemory.passed) + Number(pair.withoutMemory.passed), 0) });
      if (learn && !signal?.aborted) {
        emit({ type: "round_learning_started", round: number, agent: "orion" });
        const updated = await learn({ preparation: current, round, signal, onEvent: event => emit({ ...event, round: number }), onToolDetail: details });
        if (!updated?.preparation?.guide || !updated.cost) throw new Error("round_learning_not_verified");
        current = updated.preparation; round.learning = updated.cost;
        if (updated.status && updated.status !== "completed") throw new Error("round_learning_not_verified");
        emit({ type: "round_learning_finished", round: number, agent: "orion", revision: current.guide.revision });
      }
      round.summary = controlSummary(preparation, completedRounds, number * 5);
    }
  } catch (error) {
    failure = ["control_guide_changed", "memory_server_did_not_restart", "round_learning_not_verified"].includes(error?.message) ? error.message : "control_execution_failed";
    emit({ type: "run_error", reason: failure });
  }
  const summary = controlSummary(preparation, completedRounds, plan.pairs.length);
  const status = signal?.aborted ? "cancelled" : failure || summary.completedPairs !== plan.pairs.length
    || summary.withMemory.correct !== plan.pairs.length || summary.withoutMemory.correct !== plan.pairs.length ? "partial" : "completed";
  emit({ type: "control_finished", status });
  return { reportVersion: 1, kind: "memory_control", runId, status, failure, plan, memoryProtocol, rounds: completedRounds, summary, events, toolExhibits,
    elapsedMs: performance.now() - started, preparation: { runId: preparation.runId, elapsedMs: preparation.elapsedMs, summary: preparation.summary,
      memoryProcessing: preparation.memoryProcessing }, knowledge: current.knowledge, guide: current.guide, guides: current.guides, code,
    binarySha256: driver.binarySha256, realMcpProcess: driver.realProcess, interpretation: plan.interpretation };
}

export async function learnFromControlRound({ driver, preparation, round, agent, code, maxAttempts = 2, signal,
  onEvent = () => {}, onToolDetail = () => {}, onMemory = () => {}, onKnowledge = () => {} }) {
  if (!round.frozen?.unchangedAfterComparison || !agent?.run || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) throw new Error("invalid_round_review");
  const started = performance.now();
  const runId = randomUUID(); const actor = `orion-round-${round.number}-${runId.slice(0, 8)}`;
  const cases = upgradeCases({ split: "evaluation", round: round.number });
  const verified = round.pairs.filter(pair => pair.withMemory.passed && pair.withMemory.verification?.passed);
  const files = {};
  const records = verified.map(pair => {
    const specification = cases.find(specification => specification.id === pair.caseId && specification.fixtureSha256 === pair.withMemory.fixtureSha256);
    if (!specification) throw new Error("round_case_identity_mismatch");
    for (const [path, text] of Object.entries(specification.files)) files[`${specification.id}/${path}`] = text;
    return { caseId: specification.id, family: specification.family, fixtureSha256: specification.fixtureSha256,
      verification: pair.withMemory.verification, assessment: pair.withMemory.answer, finding: pair.withMemory.finding,
      guideRetrievedBeforeAssessment: pair.withMemory.guideRetrievedBeforeAssessment, guideApplied: pair.withMemory.guideApplied,
      upgradeProbes: pair.withMemory.upgradeProbes.map(({ callerSource, ...probe }) => probe) };
  });
  files["round/verified-cases.json"] = `${JSON.stringify({ round: round.number, guideUsed: { chainId: round.frozen.chainId, revision: round.frozen.revision },
    cases: records, interpretation: "Verified memory-side cases only. These are repeated problem families, not proof of independent corroboration. A blocked assessment preserves failing runtime tests." }, null, 2)}\n`;
  const specification = { id: `round-${round.number}-review`, files, fixtureSha256: digest(files), evidencePaths: ["round/verified-cases.json"] };
  const ledger = createKnowledgeLedger({ driver, runId, scope: preparation.scope, seed: preparation.knowledge,
    emit: event => onEvent({ ...event, agent: event.agent === actor ? "orion" : event.agent, reviewer: actor }), onMemory, onKnowledge });
  const executions = []; const memoryUsage = [];
  let guide = preparation.guide; let failure = null; let skipped = null;
  const unsubscribe = driver.observeInference?.(event => { if (event.type === "inference_finished") memoryUsage.push(event); onEvent(event); });
  try {
    if (!records.length) skipped = "No verified memory-side case is available to retain.";
    for (const stage of ["evidence", "guide"]) {
      if (skipped || signal?.aborted) break;
      let completed = false;
      for (let attempt = 1; attempt <= maxAttempts && !signal?.aborted; attempt += 1) {
        const author = investigatorTools({ driver, scope: preparation.scope, actor, specification, ledger, condition: "withMemory", index: 2, stage, code,
          priorAssessment: { verification: { passed: true, expectedTests: records.length * 7, passedTests: records.length * 7 }, answer: { caseIds: records.map(record => record.caseId) } },
          emit: event => onEvent({ ...event, agent: event.agent === actor ? "orion" : event.agent, reviewer: actor }),
          onToolDetail: detail => onToolDetail({ ...detail, agent: "orion", reviewer: actor }) });
        const tools = [...author.tools];
        if (stage === "evidence") tools.push({ definition: { type: "function", function: { name: "skip_learning",
          description: "Record that this round adds no reusable learning after reading round/verified-cases.json and inspecting the existing guide. This writes nothing. Use a concise evidence-based reason, not a note quota.",
          parameters: { type: "object", additionalProperties: false, properties: { reason: { type: "string", minLength: 10, maxLength: 500 } }, required: ["reason"] } } },
        invoke: ({ reason }) => {
          if (!author.workspace.filesRead.has("round/verified-cases.json") || !author.accessedKnowledge.has(ledger.guideId)) throw new Error("inspect_round_and_guide_first");
          skipped = reason; return { stored: false, outcome: "no_new_learning", reason };
        } });
        const task = [memoryStartPrompt({ stage }),
          `You are Orion, reviewing completed evaluation round ${round.number}. All ten comparison sessions are finished. The review case is ${specification.id}.`,
          stage === "evidence" ? "Read round/verified-cases.json and inspect_guide_sources. Only verified memory-side cases are present; never use control answers. Inspect the original case source files when needed. Retain a useful new condition, failed approach, application or exception with record_observation and exact source quotes. Connect the useful observations in ONE chain whose claim names branch-kit and this review case, then explicitly accept_knowledge. These repeated families are not independent confirmations."
            : "Recover accepted chains and existing principles with inspect_guide_sources. Form distinct supported decision rules from these verified cases: use null IDs for genuinely new principles and actual catalogue IDs/current revisions for refinement. Choose the 2..8 chains relevant to each rule, preserving conditions and counterexamples. Do not force all cases into one principle or create paraphrases. Explicitly accept every candidate, or use skip_learning when the catalogue already covers the evidence.",
          stage === "evidence" ? "A measured application can add evidence, but no new learning is also valid: after inspecting the round file and stored guide, use skip_learning with a reason instead of inventing a note. Recall and repeated sessions alone are not confirmation or reinforcement. Do not propose a guide in this evidence phase." : "Do not repeat the investigation or create extra source observations in the guide phase.",
          attempt > 1 ? "This is an explicit retry. Recover the current checkpoint and reuse acknowledged observation/chain IDs. Finish pending acceptance instead of creating duplicates." : "",
          'Finish with JSON {"completed":true} only after the required tools succeed; otherwise {"completed":false}. Use memory_checkpoint before finishing unless skip_learning completed the phase.',
        ].filter(Boolean).join("\n");
        const execution = await agent.run(task, tools, "", { type: "object", additionalProperties: false, properties: { completed: { type: "boolean" } }, required: ["completed"] },
          { signal, onEvent: event => onEvent({ ...event, agent: "orion", phaseScope: `round-${stage}`, reviewer: actor, attempt }) });
        const accepted = stage === "evidence" ? [...ledger.nodes.values()].some(node => node.actor === actor && node.document.kind === "chain" && node.state === "accepted")
          : author.checkpoint().ready;
        completed = execution.status === "completed" && (Boolean(skipped) || accepted);
        executions.push({ ...publicExecution(execution), stage, attempt, passed: completed });
        if (completed) break;
      }
      if (!completed && !signal?.aborted) { failure = "round_learning_not_verified"; break; }
    }
    if (!failure && !signal?.aborted && !skipped) {
      await ledger.provePersistence(actor);
      guide = await ledger.exportGuide();
      if (!guide) throw new Error("round_learning_not_verified");
      onKnowledge({ ...ledger.snapshot(), guide, guides: await ledger.exportGuides() });
    }
  } catch { failure = "round_learning_not_verified"; }
  finally { unsubscribe?.(); }
  const status = signal?.aborted ? "cancelled" : failure ? "partial" : "completed";
  const cost = { inputTokens: sum(executions, "inputTokens"), outputTokens: sum(executions, "outputTokens"), toolCalls: sum(executions, "toolCalls"),
    elapsedMs: performance.now() - started, memoryProcessing: { calls: memoryUsage.length, inputTokens: sum(memoryUsage, "inputTokens"), outputTokens: sum(memoryUsage, "outputTokens") },
    executions, outcome: skipped ? "no_new_learning" : status, reason: skipped ?? failure, guideRevision: guide?.revision ?? null };
  const guides = await ledger.exportGuides();
  return { status, failure, cost, preparation: { ...preparation, guide, guides, knowledge: { ...ledger.snapshot(), guide, guides } } };
}

export function preparationEvent(event) {
  return event.type === "run_finished" ? { ...event, type: "preparation_finished" }
    : event.type === "tests" && event.agent === "system" && event.phase === "final" ? { ...event, phase: "preparation" } : event;
}

export function combineControlReport(preparation, control) {
  const pairs = control.rounds.flatMap(round => round.pairs);
  const outcomes = pairs.flatMap(pair => [pair.withMemory, pair.withoutMemory]);
  const actors = preparation.agents.map(actor => {
    const attempts = pairs.filter(pair => pair.withMemory.agent === actor.id).map(pair => ({ ...pair.withMemory, phase: "control", round: pair.round }));
    return { ...actor, attempts: [...actor.attempts, ...attempts], state: attempts.length && attempts.every(attempt => attempt.passed) ? "passed" : control.status === "cancelled" ? "cancelled" : "failed" };
  });
  const agents = [...actors, ...controlRoles.map(role => {
    const attempts = pairs.filter(pair => pair.withoutMemory.agent === role.id).map(pair => ({ ...pair.withoutMemory, phase: "control", round: pair.round }));
    return { ...role, model: control.plan.pairs.find(pair => pair.withoutMemory.agent === role.id)?.withoutMemory.model, memoryAccess: "none", attempts,
      state: attempts.length && attempts.every(attempt => attempt.passed) ? "passed" : control.status === "cancelled" ? "cancelled" : "failed" };
  })];
  const elapsedMs = preparation.elapsedMs + control.elapsedMs;
  const finalTests = { passed: control.status === "completed", passedTests: preparation.finalTests.passedTests
    + outcomes.reduce((total, outcome) => total + (outcome.verification?.passedTests ?? 0), 0), expectedTests: preparation.finalTests.expectedTests + control.plan.pairs.length * 14 };
  const events = [...preparation.events.map(preparationEvent), ...control.events.map(event => ({ ...event, atMs: preparation.elapsedMs + event.atMs })),
    { type: "tests", agent: "system", phase: "final", ...finalTests, atMs: elapsedMs }, { type: "run_finished", status: control.status, atMs: elapsedMs }]
    .map((event, index) => ({ ...event, id: index + 1 }));
  const summary = control.summary;
  const { events: controlEvents, toolExhibits, memoryExhibits, knowledge, ...experiment } = control;
  return { ...preparation, title: "Memory vs Daleks", status: control.status, failure: control.failure, agents, events, elapsedMs, finalTests,
    controlExperiment: experiment, knowledge, guide: control.guide, guides: control.guides,
    memoryExhibits: [...preparation.memoryExhibits, ...(memoryExhibits ?? [])], toolExhibits: [...preparation.toolExhibits, ...toolExhibits],
    memoryProcessing: { ...preparation.memoryProcessing, ...summary.memoryProcessing },
    summary: { ...preparation.summary, agents: 10, agentsPassed: agents.filter(agent => agent.state === "passed").length,
      inputTokens: add(summary.withMemory.totalInputTokens, summary.withoutMemory.inputTokens), outputTokens: add(summary.withMemory.totalOutputTokens, summary.withoutMemory.outputTokens),
      toolCalls: add(preparation.summary.toolCalls, summary.withMemory.toolCalls, summary.withoutMemory.toolCalls, sum(control.rounds.flatMap(round => round.learning ? [round.learning] : []), "toolCalls")),
      memoriesStored: knowledge.operations.length, observationsStored: knowledge.observations.length, chainsStored: knowledge.chains.length,
      principlesStored: knowledge.principles.length, restartsVerified: knowledge.durability.length, guideApplications: knowledge.applications.length,
      crossAgentHandoffs: events.filter(event => event.type === "memory_delivered").length,
      retrievalToolCalls: events.filter(event => event.type === "memory_read").length, retrievalBytes: events.filter(event => event.type === "memory_read").reduce((total, event) => total + event.bytes, 0) },
    interpretation: control.interpretation };
}
