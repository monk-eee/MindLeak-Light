import { digest } from "./validation-scenarios.mjs";
import { investigationCases, investigationDecision, investigationFixture } from "./investigation-fixtures.mjs";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { agentTools, createCodingWorkspace } from "./validation-runtime.mjs";
import { matchesContract, publicExecution } from "./validation-agent.mjs";
import { compactPriorLesson, rediscoveryArms, rediscoveryExperienceTools } from "./rediscovery-lab.mjs";

const boundedText = (text, maximum) => typeof text === "string" && text.trim().length > 0 && Buffer.byteLength(text) <= maximum;
const executedProbe = (receipt, expected) => receipt && typeof receipt.id === "string" && typeof receipt.sourceSha256 === "string"
  && receipt.tests === expected && receipt.expectedTests === expected && expected > 0
  && Number.isSafeInteger(receipt.passedTests) && receipt.passedTests >= 0 && receipt.passedTests <= expected
  && typeof receipt.passed === "boolean" && (!receipt.passed || receipt.passedTests === expected);

export function investigationPlan(options = {}) {
  const { seed = 20260918, model = "gpt-6-astra" } = options;
  if (Object.keys(options).some(key => !["seed", "model"].includes(key)) || !Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff
    || typeof model !== "string" || !model.trim() || model === "auto") throw new Error("invalid_investigation_plan");
  const cases = investigationCases();
  const discovery = cases.filter(item => item.role === "discovery");
  const validation = cases.filter(item => item.role.startsWith("validation_"));
  const evaluation = cases.filter(item => !discovery.includes(item) && !validation.includes(item));
  const sessions = evaluation.flatMap(item => ["fresh", "notebook", "mindleak", "direct"].map(arm => ({
    id: `${item.id}:${arm}`, caseId: item.id, matchId: item.id, family: "continuation-contract", stage: item.role,
    round: 1, arm, diagnostic: arm === "direct", fixtureSha256: item.fixtureSha256, model,
  }))).sort((left, right) => digest(`${seed}:${left.id}`).localeCompare(digest(`${seed}:${right.id}`)));
  return { protocolVersion: 4, fixtureVersion: 1, name: "Investigation Learning", profile: "mechanism", seed, model, concurrency: 1,
    familyCount: 1, families: 1, discovery, validation, evaluation, sessions, mainSessions: 12, diagnosticSessions: 4, preparationTasks: 2,
    arms: ["fresh", "notebook", "mindleak"], diagnostic: "direct", preparationSessionsPerArm: 4,
    memoryUse: "optional", initialBriefBytes: 2048, scheduleSha256: digest(sessions), frozenInputsSha256: digest(cases),
    evidencePolicy: "Executed claim-specific checks can support an observation while the overall task remains unfinished.",
    formationPolicy: "One investigation is one evidence origin; principles require two distinct discovery cases and reserved validation.",
    interpretation: "One exposed synthetic family tests the mechanism, not population benefit. Validation cases are not evaluation cases; direct delivery is diagnostic." };
}

const textField = maximum => ({ type: "string", minLength: 1, maxLength: maximum });
const observationProperties = { proofId: textField(100), summary: textField(800), conditions: textField(800), uncertainty: textField(800),
  path: textField(256), quote: textField(1000) };
const laboratoryTool = (name, description, properties, required, invoke) => {
  const parameters = { type: "object", additionalProperties: false, properties, required };
  return { definition: { type: "function", function: { name, description, parameters } }, invoke: async args => {
    if (!matchesContract(args, parameters)) throw new Error("invalid_investigation_arguments");
    return invoke(args);
  } };
};
const taskAnswer = { type: "object", additionalProperties: false, properties: { completed: { type: "boolean" } }, required: ["completed"] };

export async function runInvestigationSession({ fixture, agent, ledger, code, arm, stage, experience = { tools: [], accesses: [], errors: [] },
  direct = null, signal, onEvent = () => {}, onToolDetail = () => {}, workspaceFactory = createCodingWorkspace }) {
  const started = performance.now(); const id = `${fixture.id}:${stage === "discovery" ? "discover" : arm}`;
  const observed = new Map(); const proofs = new Map(); const reads = []; const writes = []; const probes = []; const observationIds = [];
  let workspace; let baseline; let finalTests = null; let execution; let decision = null; let firstVerifiedFixMs = null;
  const emit = event => onEvent({ ...event, agent: arm, caseId: id, phaseScope: stage === "discovery" ? "preparation" : "evaluation", stage: fixture.role, family: fixture.family });
  const files = async () => Object.fromEntries(await Promise.all(Object.keys(fixture.files).map(async path => [path, await workspace.read(path)])));
  const probe = async (group = null) => {
    if (signal?.aborted) throw new Error("investigation_cancelled");
    const result = await workspace.test(group);
    const expected = group ? fixture.testGroups[group] : fixture.testCount;
    const proof = { ...result, id: randomUUID(), group, expectedTests: expected, atMs: performance.now() - started };
    if (!executedProbe(proof, expected)) throw new Error("incomplete_probe_execution");
    proofs.set(proof.id, { ...proof, files: await files(), inspected: Object.fromEntries(observed) });
    probes.push(proof); emit({ type: "tests", phase: "candidate", ...proof });
    if (!group) {
      finalTests = proof;
      if (proof.passed && writes.length && firstVerifiedFixMs === null) firstVerifiedFixMs = proof.atMs;
    }
    return proof;
  };
  try {
    workspace = await workspaceFactory("investigation", code, fixture);
    const measured = { ...workspace,
      read: async path => { const text = await workspace.read(path); observed.set(path, text); reads.push({ path, atMs: performance.now() - started }); return text; },
      write: async (path, content) => {
        const before = await workspace.read(path); const result = await workspace.write(path, content);
        if (before !== content) { writes.push({ path, beforeSha256: digest(before), afterSha256: digest(content), atMs: performance.now() - started }); finalTests = null; }
        return result;
      },
      test: () => probe(),
    };
    baseline = await probe();
    const tools = [...agentTools(null, measured, { recall: false, write: false }), ...(experience.tools ?? []),
      laboratoryTool("run_probe", "Execute a claim-specific subset of immutable checks and return its evidence receipt. Failed checks are observations, not established causes.",
        { group: { type: "string", enum: ["behavior", "regression"] } }, ["group"], ({ group }) => probe(group))];
    if (stage === "discovery") tools.push(laboratoryTool("capture_observation", "Save an observation grounded in an executed probe and an exact source quotation you inspected before that probe. Overall task completion is not required. Record uncertainty; this never forms or accepts a chain.",
      observationProperties, Object.keys(observationProperties), async observation => {
        const receipt = await ledger.capture({ fixture, proofs, observation, taskComplete: finalTests?.passed === true });
        if (!observationIds.includes(receipt.memoryId)) observationIds.push(receipt.memoryId);
        return { memoryId: receipt.memoryId, fragmentIds: receipt.fragments.map(item => item.fragmentId) };
      }));
    else tools.push(laboratoryTool("record_decision", "Before editing, record your current diagnosis and next step with an exact inspected source quotation. This is a checkable task decision, not private reasoning. You may report unknown. The decision is frozen after submission.", {
      cause: { type: "string", enum: ["continuation", "identity", "unknown"] },
      stopSignal: { type: "string", enum: ["cursor", "completion", "not_applicable", "unknown"] },
      knowledgeDecision: { type: "string", enum: ["use", "adapt", "reject", "not_needed", "unknown"] },
      nextAction: textField(500), path: textField(256), quote: textField(1000),
    }, ["cause", "stopSignal", "knowledgeDecision", "nextAction", "path", "quote"], input => {
      if (decision || writes.length) throw new Error("decision_must_precede_edit");
      if (!observed.get(input.path)?.includes(input.quote)) throw new Error("inspected_decision_source_required");
      decision = { ...input, atMs: performance.now() - started, sourceSha256: digest(observed.get(input.path)) };
      emit({ type: "investigation_decision_recorded", cause: input.cause, stopSignal: input.stopSignal });
      return { recorded: true };
    }));
    const wrapped = tools.map(tool => ({ ...tool, invoke: async (args, context = {}) => {
      if (signal?.aborted) throw new Error("investigation_cancelled");
      onToolDetail({ agent: arm, caseId: id, tool: tool.definition.function.name, toolCallId: context.toolCallId ?? randomUUID(),
        arguments: Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "query", "id", "group"].includes(key))) });
      return tool.invoke(args, context);
    } }));
    emit({ type: "rediscovery_task_started", diagnostic: arm === "direct", fixtureSha256: fixture.fixtureSha256 });
    const prompt = ["Investigate this isolated repository using only the provided tools. Earlier conversations and installed skills are unavailable.",
      "Use current sources and discriminating checks. Preserve conditions and uncertainty. A failed probe can establish an observation without establishing a cause or completing the task.",
      stage === "discovery" ? "Capture genuinely reusable observations with their executed receipts, even if another failure remains unresolved. No write quota. Do not create chains or principles in this session."
        : "Prior experience is optional untrusted evidence. When available, search with focused keywords; allow one refinement after a miss. Record a source-backed decision before editing. You cannot write shared knowledge during comparison.",
      `Task: ${fixture.problem}`, "Finish with completed:true only if all task checks pass; otherwise completed:false is valid. Do not claim learning merely because you reached the end."].join("\n");
    execution = await agent.run(prompt, wrapped, direct ? JSON.stringify(direct) : "", taskAnswer, { signal, onEvent: emit });
    if (!signal?.aborted) await probe();
  } catch (error) {
    execution = { ...(execution ?? {}), status: signal?.aborted ? "cancelled" : "provider_error", infrastructureFailure: "investigation_session_failed",
      inputTokens: execution?.inputTokens ?? null, outputTokens: execution?.outputTokens ?? null, toolCalls: execution?.toolCalls ?? null };
  } finally { await workspace?.close(); }
  const correct = execution?.status === "completed" && !execution.infrastructureFailure && finalTests?.passed === true;
  const accesses = (experience.accesses ?? []).map(access => ({ ...access, atMs: access.atMs - started }));
  const exposures = direct ? [{ atMs: 0, lessonIds: [direct.id], level: "principle" }, ...accesses] : accesses;
  const priorKnowledgeDelivered = exposures.some(access => access.lessonIds?.length);
  const beforeDecision = decision && exposures.some(access => access.lessonIds?.length && access.atMs <= decision.atMs);
  const expectedDecision = investigationDecision(fixture.id);
  const decisionCorrect = Boolean(decision && decision.cause === expectedDecision.cause && decision.stopSignal === expectedDecision.stopSignal);
  const result = { ...publicExecution(execution ?? { status: "provider_error" }), id, caseId: fixture.id, family: fixture.family, stage: fixture.role, arm,
    round: 1, repetition: 1, diagnostic: arm === "direct", fixtureSha256: fixture.fixtureSha256, baseline, finalTests, correct, taskComplete: correct,
    observationIds, learningOutcome: observationIds.length ? "checked_discovery_retained" : "no_new_learning", decision, decisionCorrect,
    decisionWithPriorEvidence: Boolean(decisionCorrect && beforeDecision), priorKnowledgeDelivered,
    reuseObserved: Boolean(correct && decisionCorrect && beforeDecision && fixture.role !== "irrelevant" && writes.length),
    experienceAccesses: accesses, experienceErrors: experience.errors ?? [], reads, writes, probes,
    usedChainIds: correct && decisionCorrect && beforeDecision ? [...new Set(accesses.filter(access => access.level === "chain" && access.atMs <= decision.atMs).map(access => access.resourceId))] : [], knownFailureCandidates: [],
    firstVerifiedFixMs, elapsedMs: performance.now() - started, actualCostUsd: null, proofRecords: [...proofs.values()] };
  emit({ type: "rediscovery_task_finished", correct, diagnostic: result.diagnostic, decisionCorrect, priorKnowledgeDelivered,
    reuseObserved: result.reuseObserved, inputTokens: result.inputTokens, outputTokens: result.outputTokens, elapsedMs: result.elapsedMs, passedTests: finalTests?.passedTests ?? 0 });
  return result;
}

export function createInvestigationLedger({ driver, plan, runId = randomUUID(), onEvent = () => {}, onKnowledge = () => {}, onMemory = () => {} }) {
  const scope = `investigation-${runId}`;
  const observations = []; const chains = []; const principles = []; const operations = [];
  const receipts = new Map(); const requests = new Map(); const proposalIds = new Map(); const durability = [];
  let readOnly = false;
  const writable = () => { if (readOnly) throw new Error("frozen_investigation_knowledge"); };
  const snapshot = () => structuredClone({ observations, chains, principles, operations,
    lessons: principles.filter(node => node.state === "accepted" && !node.requiresReview).map(node => ({ id: node.chainId, revision: node.revision,
      family: "continuation-contract", title: node.document.claim, procedure: node.document.conclusion, conditions: node.document.applicability,
      limitations: node.document.assumptions.join(" "), chainIds: node.document.supportedBy.map(reference => reference.chainId),
      document: node.document, sourceFixtureSha256: digest(plan.discovery), markdown: node.document.conclusion })), durability });
  const publish = () => onKnowledge(snapshot());
  const write = async (text, source, chain = null) => {
    writable();
    const payload = { agentId: `investigator-${runId}`, text, context: { scope, sessionId: runId, source,
      summary: "Continuation contract investigation; verified source evidence" }, ...(chain ? { chain } : {}) };
    const key = digest(payload);
    if (receipts.has(key)) return receipts.get(key);
    if (!requests.has(key)) requests.set(key, randomUUID());
    const result = (await driver.call("write_memory", { ...payload, requestId: requests.get(key) })).data;
    if (typeof result.memoryId !== "string" || !result.fragments?.length || result.fragments.some(fragment => typeof fragment.fragmentId !== "string")) throw new Error("invalid_investigation_receipt");
    const savedAt = new Date().toISOString();
    if (chain && (result.chainId !== chain.chainId || !Number.isSafeInteger(result.revision) || !["candidate", "accepted", "retired"].includes(result.state))) throw new Error("invalid_investigation_receipt");
    receipts.set(key, structuredClone(result));
    const kind = chain?.document?.kind ?? [...chains, ...principles].find(node => node.chainId === chain?.chainId)?.document.kind ?? "observation";
    const operation = { memoryId: result.memoryId, nodeId: result.chainId ?? result.memoryId, kind,
      operation: chain?.operation ?? "write", actor: "mindleak", revision: result.revision ?? null, state: result.state ?? "stored", savedAt };
    operations.push(operation); onEvent({ type: "knowledge_written", agent: operation.actor, ...operation });
    onMemory({ agent: "mindleak", memoryId: result.memoryId, scope, kind: operation.kind, fragments: result.fragments, savedAt });
    return result;
  };
  const fields = input => {
    for (const name of ["claim", "rationale", "conclusion", "applicability"]) if (!boundedText(input[name], 1600)) throw new Error("bounded_knowledge_document_required");
    if (!Array.isArray(input.assumptions) || input.assumptions.length > 4 || input.assumptions.some(text => !boundedText(text, 500))) throw new Error("bounded_knowledge_document_required");
    return Object.fromEntries(["claim", "rationale", "conclusion", "applicability", "assumptions"].map(name => [name, structuredClone(input[name])]));
  };
  const rememberNode = (node, result) => {
    Object.assign(node, { memoryId: result.memoryId, revision: result.revision, state: result.state, review: result.review });
    publish(); return result;
  };
  const chainSources = ids => {
    if (!Array.isArray(ids) || ids.length !== 2 || new Set(ids).size !== 2) throw new Error("distinct_discovery_cases_required");
    const selected = ids.map(id => chains.find(node => node.chainId === id));
    if (selected.some(node => !node || node.state !== "accepted" || node.review !== "reviewed" || node.requiresReview)
      || new Set(selected.map(node => node.caseId)).size !== 2 || new Set(selected.map(node => node.sourceGroup)).size !== 2) throw new Error("distinct_discovery_cases_required");
    return selected;
  };
  return {
    scope, snapshot, setReadOnly(value) { readOnly = value; },
    async capture({ fixture, proofs, observation, taskComplete = false }) {
      writable();
      const origin = plan.discovery.find(entry => entry.id === fixture.id && entry.fixtureSha256 === fixture.fixtureSha256);
      if (!origin) throw new Error("discovery_evidence_required");
      const receipt = proofs.get(observation.proofId);
      const expected = receipt?.group ? fixture.testGroups[receipt.group] : fixture.testCount;
      if (!executedProbe(receipt, expected)) throw new Error("executed_probe_required");
      if (!boundedText(observation.summary, 800) || !boundedText(observation.conditions, 800) || !boundedText(observation.uncertainty, 800)) throw new Error("bounded_observation_required");
      if (!boundedText(observation.quote, 1000) || !receipt.inspected?.[observation.path]?.includes(observation.quote)
        || !receipt.files?.[observation.path]?.includes(observation.quote)) throw new Error("inspected_source_required");
      const key = digest({ caseId: fixture.id, sourceSha256: receipt.sourceSha256, group: receipt.group,
        observation: { ...observation, proofId: undefined }, passed: receipt.passed, passedTests: receipt.passedTests });
      const prior = observations.find(item => item.captureKey === key);
      if (prior) return { memoryId: prior.memoryId, fragments: prior.fragments };
      if (observations.length >= 32) throw new Error("investigation_observation_budget");
      const verification = { proofId: receipt.id, group: receipt.group, sourceSha256: receipt.sourceSha256,
        tests: receipt.tests, passedTests: receipt.passedTests, expectedTests: receipt.expectedTests, passed: receipt.passed };
      const rawText = `Case: ${fixture.id}\nSource group: ${origin.sourceGroup}\nConditions: ${observation.conditions}\nExecuted outcome: ${JSON.stringify(verification)}\nSource: ${observation.path}\nExact quotation: ${observation.quote}\nAttributed observation: ${observation.summary}\nUnresolved: ${observation.uncertainty}\nOverall task complete: ${taskComplete}`;
      const result = await write(rawText, `synthetic:investigation-v3/${fixture.id}/${observation.path}`);
      observations.push({ memoryId: result.memoryId, fragments: result.fragments, rawText, caseId: fixture.id, sourceGroup: origin.sourceGroup,
        fixtureSha256: fixture.fixtureSha256, taskComplete, verification, captureKey: key, actor: "mindleak", savedAt: new Date().toISOString() });
      publish(); return result;
    },
    async proposeChain(input) {
      writable();
      const origin = plan.discovery.find(entry => entry.id === input.caseId);
      const selected = (input.observationIds ?? []).map(id => observations.find(record => record.memoryId === id));
      if (!origin || !selected.length || selected.length > 4 || new Set(input.observationIds).size !== selected.length
        || selected.some(record => !record || record.caseId !== origin.id)) throw new Error("case_observations_required");
      if (chains.some(node => node.caseId === origin.id)) throw new Error("one_chain_per_discovery_case");
      const document = { ...fields(input), kind: "chain", evidence: selected.map(record => ({ fragmentId: record.fragments[0].fragmentId,
        role: "supports", reason: `Executed source check from ${origin.id}; interpretation remains an attributed claim.` })), supportedBy: [] };
      const key = digest(document); if (!proposalIds.has(key)) proposalIds.set(key, randomUUID());
      const chainId = proposalIds.get(key);
      const result = await write(`Discovery chain for ${origin.id}: ${JSON.stringify(document)}`, `synthetic:investigation-v3/${origin.id}/chain`, { operation: "propose", chainId, document });
      const node = { chainId, actor: "mindleak", caseId: origin.id, sourceGroup: origin.sourceGroup, observationIds: input.observationIds, document };
      chains.push(node); return rememberNode(node, result);
    },
    async acceptChain(chainId) {
      writable();
      const node = chains.find(item => item.chainId === chainId);
      if (!node || node.state !== "candidate") throw new Error("candidate_chain_required");
      const result = await write(`Explicit validation of discovery chain ${chainId}.`, `synthetic:investigation-v3/${node.caseId}/validation`, {
        operation: "accept", chainId, expectedRevision: node.revision, validation: {
          method: "Inspect the cited source quotations and complete executed probe receipts; judge only this case-specific claim, not whole-task completion or generalization.",
          result: "The author accepted the narrow conclusion against recorded evidence. Semantic interpretation is attributed, not automatically proved.",
          source: `synthetic:investigation-v3/${node.caseId}`, counterEvidenceReviewed: [],
        },
      });
      return rememberNode(node, result);
    },
    async proposePrinciple(input) {
      writable();
      const selected = chainSources(input.supportedBy);
      if (principles.length) throw new Error("one_candidate_in_mechanism_trial");
      if (!boundedText(input.implementation, 6000)) throw new Error("bounded_executable_hypothesis_required");
      const document = { ...fields(input), kind: "principle", evidence: [], supportedBy: selected.map(node => ({ chainId: node.chainId,
        revision: node.revision, reason: `Separate constructed discovery case ${node.caseId}; not statistical independence across problem families.` })) };
      const key = digest({ document, implementation: input.implementation }); if (!proposalIds.has(key)) proposalIds.set(key, randomUUID());
      const chainId = proposalIds.get(key);
      const result = await write(`Candidate principle: ${JSON.stringify(document)}\nExecutable hypothesis, not a future-task patch:\n${input.implementation}`,
        "synthetic:investigation-v3/principle-proposal", { operation: "propose", chainId, document });
      const node = { chainId, actor: "mindleak", document, implementation: input.implementation, implementationSha256: digest(input.implementation),
        propositionSha256: key, predictions: [], validationChecks: [] };
      principles.push(node); return rememberNode(node, result);
    },
    predict(chainId, caseId, prediction) {
      writable();
      const node = principles.find(item => item.chainId === chainId);
      if (node?.needsFreshValidation) throw new Error("fresh_validation_cases_required");
      if (!node || node.state !== "candidate" || !plan.validation.some(entry => entry.id === caseId)) throw new Error("reserved_validation_case_required");
      if (node.predictions.some(item => item.caseId === caseId)) throw new Error("prediction_frozen");
      if (typeof prediction.applicable !== "boolean" || typeof prediction.expectedPass !== "boolean" || !boundedText(prediction.reason, 800)) throw new Error("invalid_prediction");
      const record = { ...structuredClone(prediction), id: randomUUID(), caseId, revision: node.revision, propositionSha256: node.propositionSha256 };
      node.predictions.push(record); onEvent({ type: "prediction_recorded", chainId, caseId, predictionId: record.id, applicable: record.applicable, expectedPass: record.expectedPass });
      publish(); return structuredClone(record);
    },
    async validatePrediction(chainId, caseId, receipt) {
      writable();
      const node = principles.find(item => item.chainId === chainId);
      const prediction = node?.predictions.find(item => item.caseId === caseId);
      if (!prediction || prediction.revision !== node.revision || prediction.propositionSha256 !== node.propositionSha256) throw new Error("prospective_prediction_required");
      const entry = plan.validation.find(item => item.id === caseId);
      if (!executedProbe(receipt, 2) || receipt.fixtureSha256 !== entry.fixtureSha256 || receipt.implementationSha256 !== node.implementationSha256) throw new Error("reserved_validation_receipt_required");
      if (node.validationChecks.some(item => item.caseId === caseId)) throw new Error("validation_already_executed");
      const positive = entry.role === "validation_positive";
      const correct = prediction.expectedPass === receipt.passed && prediction.applicable === receipt.passed && (!positive || receipt.passed);
      const verification = { tests: receipt.tests, passedTests: receipt.passedTests, expectedTests: receipt.expectedTests, passed: receipt.passed,
        sourceSha256: receipt.sourceSha256, implementationSha256: receipt.implementationSha256, fixtureSha256: receipt.fixtureSha256 };
      const rawText = `Reserved case ${caseId}; candidate ${chainId} revision ${node.revision}.\nPrediction recorded before execution: ${JSON.stringify(prediction)}\nExecuted outcome: ${JSON.stringify(verification)}\nPrediction and applicability check: ${correct}.`;
      const result = await write(rawText, `synthetic:investigation-v3/${caseId}/prospective-validation`);
      observations.push({ memoryId: result.memoryId, fragments: result.fragments, rawText, caseId, sourceGroup: entry.sourceGroup,
        verification, kind: "validation", actor: "mindleak", savedAt: new Date().toISOString(), taskComplete: false });
      const check = { caseId, prediction, verification, correct, memoryId: result.memoryId, fragmentId: result.fragments[0].fragmentId };
      node.validationChecks.push(check); publish(); return structuredClone(check);
    },
    async acceptPrinciple(chainId) {
      writable();
      const node = principles.find(item => item.chainId === chainId);
      if (node?.needsFreshValidation) throw new Error("fresh_validation_cases_required");
      if (!node || node.state !== "candidate" || node.validationChecks.length !== plan.validation.length
        || !plan.validation.every(entry => node.validationChecks.some(check => check.caseId === entry.id && check.correct))) throw new Error("reserved_validation_required");
      chainSources(node.document.supportedBy.map(reference => reference.chainId));
      const boundary = node.validationChecks.find(check => plan.validation.find(entry => entry.id === check.caseId).role === "validation_boundary");
      if (!boundary.verification.passed && !node.document.evidence.length) {
        const document = { ...node.document, evidence: [{ fragmentId: boundary.fragmentId, role: "counterexample",
          reason: "The executable hypothesis failed on an explicit-completion contract; the validator predicted non-applicability before execution." }] };
        const revised = await write(`Retain the measured boundary for principle ${chainId}.`, "synthetic:investigation-v3/validated-boundary", {
          operation: "revise", chainId, expectedRevision: node.revision, document,
        });
        node.document = document; rememberNode(node, revised);
      }
      const result = await write(`Explicit acceptance after reserved validation of ${chainId}.`, "synthetic:investigation-v3/principle-acceptance", {
        operation: "accept", chainId, expectedRevision: node.revision, validation: {
          method: "Freeze the executable hypothesis and predictions before two reserved probes; require correct positive application and boundary rejection. Evaluation cases were unavailable.",
          result: "Both reserved checks matched their prospective predictions; the boundary was either correctly rejected or handled by the unchanged procedure. This does not validate every English generalization.",
          source: `synthetic:investigation-v3/${node.validationChecks.map(check => check.caseId).join("+")}`,
          counterEvidenceReviewed: node.document.evidence.map(reference => reference.fragmentId),
        },
      });
      return rememberNode(node, result);
    },
    async challengePrinciple(chainId, fixture, receipt) {
      writable();
      const node = principles.find(item => item.chainId === chainId);
      if (!node || !plan.evaluation.some(entry => entry.id === fixture.id && entry.fixtureSha256 === fixture.fixtureSha256)
        || !executedProbe(receipt, 2) || receipt.group !== "behavior" || receipt.passed || receipt.files?.["src/scan.mjs"] !== node.implementation) throw new Error("failed_frozen_hypothesis_required");
      if (node.exceptionCases?.includes(fixture.id)) throw new Error("exception_already_recorded");
      const rawText = `Counterexample from ${fixture.id}: the frozen principle ${chainId} at revision ${node.revision} failed its behavior checks.\nImplementation SHA256: ${node.implementationSha256}\nSource SHA256: ${receipt.sourceSha256}\nExecuted: ${receipt.tests}; passed: ${receipt.passedTests}.\nCurrent contract: ${fixture.files["docs/service-contract.md"]}`;
      const captured = await write(rawText, `synthetic:investigation-v3/${fixture.id}/counterexample`);
      observations.push({ memoryId: captured.memoryId, fragments: captured.fragments, rawText, caseId: fixture.id, sourceGroup: fixture.sourceGroup,
        kind: "counterexample", actor: "mindleak", verification: { tests: receipt.tests, passedTests: receipt.passedTests, passed: receipt.passed, sourceSha256: receipt.sourceSha256 } });
      const evidence = { fragmentId: captured.fragments[0].fragmentId, role: "counterexample", reason: `The unchanged executable hypothesis failed under the recorded ${fixture.id} contract.` };
      const result = await write(`Explicitly challenge principle ${chainId} with a measured exception.`, `synthetic:investigation-v3/${fixture.id}/challenge`, {
        operation: "challenge", chainId, expectedRevision: node.revision, evidence: [evidence],
      });
      node.document.evidence.push(evidence); node.requiresReview = true; node.needsFreshValidation = true;
      (node.exceptionCases ??= []).push(fixture.id);
      return rememberNode(node, result);
    },
    async revisePrinciple(chainId, input) {
      writable();
      const node = principles.find(item => item.chainId === chainId);
      if (!node || !node.needsFreshValidation || !boundedText(input.implementation, 6000)) throw new Error("challenged_principle_revision_required");
      const document = { ...fields(input), kind: "principle", evidence: structuredClone(node.document.evidence), supportedBy: structuredClone(node.document.supportedBy) };
      const result = await write(`Revised candidate after an observed exception: ${JSON.stringify(document)}\nExecutable hypothesis:\n${input.implementation}`,
        "synthetic:investigation-v3/principle-revision", { operation: "revise", chainId, expectedRevision: node.revision, document });
      node.document = document; node.implementation = input.implementation; node.implementationSha256 = digest(input.implementation);
      node.needsFreshValidation = true; node.requiresReview = true;
      return rememberNode(node, result);
    },
    async freeze() {
      const transition = await driver.restart();
      if (transition.previous === transition.current) throw new Error("investigation_restart_required");
      for (const node of [...chains, ...principles]) {
        const result = (await driver.call("recall_memory", { chain: { operation: "inspect", chainId: node.chainId }, scope, limit: 1 })).data;
        if (result.chain?.revision !== node.revision || result.chain.snapshot?.state !== node.state || !isDeepStrictEqual(result.chain.snapshot.document, node.document)) throw new Error("investigation_knowledge_changed");
        node.requiresReview = result.requiresReview; node.review = result.chain.snapshot.review;
      }
      for (const record of observations) {
        const result = (await driver.call("recall_memory", { fragmentId: record.fragments[0].fragmentId, scope })).data;
        if (result.memoryId !== record.memoryId || result.rawText !== record.rawText) throw new Error("investigation_source_changed");
      }
      durability.push({ ...transition, passed: true, checkedAt: new Date().toISOString(), records: observations.length + chains.length + principles.length });
      publish(); return snapshot();
    },
  };
}

const knowledgeProperties = { claim: textField(200), rationale: textField(800), conclusion: textField(800), applicability: textField(350),
  assumptions: { type: "array", maxItems: 3, items: textField(150) } };
const knowledgeRequired = Object.keys(knowledgeProperties);
const sum = (values, field) => values.every(value => Number.isFinite(value?.[field]) && value[field] >= 0)
  ? values.reduce((total, value) => total + value[field], 0) : null;

export async function runInvestigationLab({ driver, agent, code, seed = 20260918, parent = null, signal, onEvent = () => {}, onMemory = () => {},
  onKnowledge = () => {}, onToolDetail = () => {}, onPlan = async () => {}, workspaceFactory = createCodingWorkspace } = {}) {
  if (!driver?.capabilities?.knowledge || !driver.capabilities.chains || !agent?.run || !code) throw new Error("investigation_prerequisites_required");
  if (parent) throw new Error("fresh_investigation_required");
  const plan = investigationPlan({ model: agent.configuration.model, seed }); plan.agentBudget = structuredClone(agent.configuration);
  await onPlan(structuredClone(plan));
  const started = performance.now(); const createdAt = new Date().toISOString(); const runId = randomUUID();
  const events = []; const memoryExhibits = []; const toolExhibits = []; const preparation = []; const preparationWork = [];
  const outcomes = []; const validations = []; const notebook = []; const sourceEvidence = new Map(); const memoryUsage = []; const memoryCalls = [];
  const reviews = []; const operationalWork = []; const inspectedDiscoveries = new Map(); const candidates = {};
  let failure = null; let activePhase = "discovery"; let activeArm = "shared"; let frozen = null; let frozenUnchanged = false;
  const emit = record => {
    if (events.length >= 20000) throw new Error("investigation_event_budget");
    const event = { ...record, id: events.length + 1, atMs: performance.now() - started };
    events.push(event); onEvent(structuredClone(event));
  };
  const details = record => { toolExhibits.push(record); onToolDetail(record); };
  const measuredDriver = { ...driver, restart: () => driver.restart(), async call(name, args) {
    const callStarted = performance.now();
    try { return await driver.call(name, args); }
    finally { memoryCalls.push({ name, phase: activePhase, arm: activeArm, elapsedMs: performance.now() - callStarted }); }
  } };
  const ledger = createInvestigationLedger({ driver: measuredDriver, plan, runId, onEvent: emit, onKnowledge,
    onMemory: record => { memoryExhibits.push(record); onMemory(record); } });
  const unsubscribe = driver.observeInference?.(event => { if (event.type === "inference_finished") memoryUsage.push({ ...event, phase: activePhase, arm: activeArm }); emit(event); });
  const phase = async (name, arm, task, tools, context = "") => {
    if (signal?.aborted) throw new Error("investigation_cancelled");
    activePhase = name; activeArm = arm; const phaseStarted = performance.now();
    emit({ type: "stage_started", agent: arm, phase: name });
    let execution;
    try {
      execution = await agent.run(`Phase: ${name}\nUse only the supplied source evidence and tools. Earlier conversations and installed skills are unavailable. Keep conclusions conditional. No new learning is legitimate.\n${task}`,
        tools, context, taskAnswer, { signal, onEvent: event => emit({ ...event, agent: arm, phaseScope: "preparation", phase: name }) });
    } catch { execution = { status: signal?.aborted ? "cancelled" : "provider_error", inputTokens: null, outputTokens: null, toolCalls: null }; }
    const report = { ...publicExecution(execution), phase: name, arm, elapsedMs: performance.now() - phaseStarted, actualCostUsd: null };
    preparationWork.push(report); emit({ type: "stage_finished", agent: arm, phase: name, success: execution.status === "completed" });
    return report;
  };
  const discoveryTools = () => [
    laboratoryTool("list_discoveries", "List the two discovery cases and retained observations. Multiple records from one case remain one evidence origin.", {}, [], () => ({
      cases: plan.discovery.map(entry => ({ caseId: entry.id, sourceGroup: entry.sourceGroup,
        observations: ledger.snapshot().observations.filter(item => item.caseId === entry.id).map(item => item.memoryId) })),
    })),
    laboratoryTool("inspect_discovery", "Inspect retained source observations and executed checks from a discovery case. Reserved validation and future evaluation cases are unavailable.",
      { caseId: textField(100) }, ["caseId"], ({ caseId }) => {
        if (!plan.discovery.some(entry => entry.id === caseId)) throw new Error("discovery_case_required");
        const observations = ledger.snapshot().observations.filter(item => item.caseId === caseId);
        if (!observations.length) throw new Error("no_checked_discovery");
        if (!inspectedDiscoveries.has(activeArm)) inspectedDiscoveries.set(activeArm, new Set());
        for (const observation of observations) inspectedDiscoveries.get(activeArm).add(observation.memoryId);
        return { caseId, observations, taskComplete: preparation.find(item => item.caseId === caseId)?.correct ?? false };
      }),
  ];
  const noteView = record => ({ id: record.id, revision: 1, family: "continuation-contract", title: record.claim, procedure: record.conclusion,
    conditions: record.applicability, limitations: record.assumptions.join(" "), evidence: [],
    markdown: `# ${record.claim}\n\n${record.conclusion}\n\nConditions: ${record.applicability}\n\nLimits: ${record.assumptions.join(" ")}\n\n${record.sources.map(item => item.rawText).join("\n\n")}` });
  const validate = async (arm, entry) => {
    const candidate = arm === "mindleak" ? ledger.snapshot().principles[0] : notebook[0];
    if (!candidate) { validations.push({ arm, caseId: entry.id, status: "no_candidate", correct: null }); return; }
    let prediction = null; let checked = false; let workspace;
    try {
      const fixture = investigationFixture(entry.id);
      workspace = await workspaceFactory("investigation-validation", code, fixture);
      const read = agentTools(null, workspace, { recall: false }).filter(tool => ["list_files", "read_file", "search_files"].includes(tool.definition.function.name));
      const tools = [...read,
        laboratoryTool("predict", "Freeze a prediction before execution: will the unchanged candidate procedure pass this service's behavior checks, and is that procedure applicable? State the contract reason. Predictions cannot be replaced after seeing results.",
          { applicable: { type: "boolean" }, expectedPass: { type: "boolean" }, reason: textField(800) }, ["applicable", "expectedPass", "reason"], input => {
            if (prediction) throw new Error("prediction_frozen");
            prediction = arm === "mindleak" ? ledger.predict(candidate.chainId, entry.id, input) : { ...input, id: randomUUID(), caseId: entry.id };
            emit({ type: "prospective_prediction", agent: arm, caseId: entry.id, predictionId: prediction.id, applicable: input.applicable, expectedPass: input.expectedPass });
            return { predictionId: prediction.id };
          }),
        laboratoryTool("run_prediction", "Run the frozen executable hypothesis on this reserved case after predicting. Neither the candidate nor tests can be changed here. A failed probe can be a correct boundary prediction.", {}, [], async () => {
          if (!prediction || checked) throw new Error("one_prospective_probe_required");
          checked = true;
          let result;
          try {
            await workspace.write("src/scan.mjs", candidate.implementation);
            result = { ...await workspace.test("behavior"), id: randomUUID(), fixtureSha256: entry.fixtureSha256, implementationSha256: digest(candidate.implementation) };
            if (!executedProbe(result, 2)) throw new Error("incomplete_validation_probe");
            const positive = entry.role === "validation_positive";
            const assessment = arm === "mindleak" ? await ledger.validatePrediction(candidate.chainId, entry.id, result) : {
              caseId: entry.id, prediction, verification: result,
              correct: prediction.expectedPass === result.passed && prediction.applicable === result.passed && (!positive || result.passed),
            };
            if (arm === "notebook") candidate.validationChecks.push(assessment);
            validations.push({ ...assessment, arm, status: "executed" });
            emit({ type: "validation_completed", agent: arm, caseId: entry.id, correct: assessment.correct, passed: result.passed });
            return { ...result, predictionMatched: assessment.correct };
          } catch (error) {
            const failed = { caseId: entry.id, arm, prediction: structuredClone(prediction), correct: false, status: "execution_failed",
              error: error.message === "incomplete_validation_probe" ? error.message : "validation_execution_failed",
              verification: result ? { ...result, executionComplete: false } : null };
            if (!validations.some(item => item.arm === arm && item.caseId === entry.id)) {
              validations.push(failed); if (arm === "notebook") candidate.validationChecks.push(failed);
              emit({ type: "validation_failed", agent: arm, caseId: entry.id, reason: failed.error });
            }
            throw error;
          }
        }),
      ];
      await phase("validation", arm, `Case: ${entry.id}\nInspect the current source contract. Record your prediction before running the frozen procedure. Do not infer a universal rule from a passing test.`, tools,
        JSON.stringify({ document: candidate.document ?? Object.fromEntries(knowledgeRequired.map(key => [key, candidate[key]])), implementation: candidate.implementation }));
      if (!checked) validations.push({ arm, caseId: entry.id, status: "not_executed", correct: null });
    } finally { await workspace?.close(); }
  };
  const review = async arm => {
    const allowed = outcomes.filter(item => item.arm === arm && item.finalTests?.tests === 3);
    const inspected = new Set(); const checked = new Map(); let revised = false;
    const candidate = arm === "mindleak" ? ledger.snapshot().principles[0] : notebook[0];
    const tools = [laboratoryTool("inspect_outcome", "Inspect this arm's post-comparison outcome and the code/checks it actually executed. Other arms' answers are unavailable.",
      { caseId: textField(100) }, ["caseId"], ({ caseId }) => {
        const outcome = allowed.find(item => item.caseId === caseId); if (!outcome) throw new Error("own_review_case_required");
        inspected.add(caseId);
        return { outcome, files: sourceEvidence.get(`${arm}:${caseId}`)?.at(-1)?.files ?? null };
      }), laboratoryTool("probe_exception", "After inspecting an outcome, rerun the unchanged prior procedure against that case's immutable behavior checks. This tests the knowledge itself, not an arbitrary failed candidate. It is not another evaluation attempt.",
      { caseId: textField(100) }, ["caseId"], async ({ caseId }) => {
        if (!candidate || !inspected.has(caseId) || checked.has(caseId) || checked.size >= 4) throw new Error("bounded_inspected_exception_required");
        const fixture = investigationFixture(caseId); const workspace = await workspaceFactory("investigation-exception", code, fixture);
        try {
          await workspace.write("src/scan.mjs", candidate.implementation);
          const receipt = { ...await workspace.test("behavior"), id: randomUUID(), group: "behavior", files: { ...fixture.files, "src/scan.mjs": candidate.implementation } };
          if (!executedProbe(receipt, 2)) throw new Error("incomplete_exception_probe");
          checked.set(caseId, receipt); emit({ type: "exception_checked", agent: arm, caseId, passed: receipt.passed, sourceSha256: receipt.sourceSha256 });
          return { caseId, proofId: receipt.id, passed: receipt.passed, passedTests: receipt.passedTests, tests: receipt.tests };
        } finally { await workspace.close(); }
      })];
    if (arm === "mindleak") tools.push(
      laboratoryTool("challenge_principle", "Explicitly challenge the prior principle using a measured failure of its frozen procedure. This retains the new counterexample and requires review, never automatic acceptance.",
        { caseId: textField(100), proofId: textField(36) }, ["caseId", "proofId"], async ({ caseId, proofId }) => {
          const receipt = checked.get(caseId); if (receipt?.id !== proofId) throw new Error("executed_exception_required");
          const result = await ledger.challengePrinciple(candidate?.chainId, investigationFixture(caseId), receipt); revised = true; return result;
        }),
      laboratoryTool("propose_revision", "Narrow or revise the challenged rule. All counterexamples are preserved. Previously exposed validation cases cannot validate this new revision; it stays a candidate needing fresh cases.",
        { ...knowledgeProperties, implementation: textField(6000) }, [...knowledgeRequired, "implementation"], input => ledger.revisePrinciple(candidate?.chainId, input)),
    );
    else tools.push(laboratoryTool("amend_note", "Record a measured exception and revise the note after comparison. Keep the original note and source evidence; the new version needs fresh validation.",
      { caseId: textField(100), proofId: textField(36), ...knowledgeProperties, implementation: textField(6000) }, ["caseId", "proofId", ...knowledgeRequired, "implementation"], input => {
        const receipt = checked.get(input.caseId);
        if (!candidate || receipt?.id !== input.proofId || receipt.passed || revised) throw new Error("executed_exception_required");
        candidate.previous = Object.fromEntries([...knowledgeRequired, "implementation"].map(key => [key, structuredClone(candidate[key])]));
        Object.assign(candidate, Object.fromEntries([...knowledgeRequired, "implementation"].map(key => [key, structuredClone(input[key])])));
        candidate.exceptions = [{ caseId: input.caseId, proofId: receipt.id, sourceSha256: receipt.sourceSha256 }]; candidate.needsFreshValidation = true; candidate.accepted = false; revised = true;
        return { id: candidate.id, status: "needs_fresh_validation" };
      }));
    const execution = await phase("review", arm, `Review only your arm's outcomes after comparison. A new failed probe may justify a challenge or revision; otherwise record no new learning. Available cases: ${JSON.stringify(allowed.map(item => item.caseId))}`,
      tools, JSON.stringify(candidate ?? { status: "no_candidate" }));
    reviews.push({ arm, outcome: execution.status !== "completed" ? "review_incomplete" : revised ? "exception_retained" : "no_new_learning", checkedCases: [...checked.keys()] });
  };
  emit({ type: "run_started", runId, experiment: 3, title: "Investigation Learning", protocolVersion: 4, expectedTests: 54 });
  try {
    for (const entry of plan.discovery) {
      if (signal?.aborted) break;
      const { proofRecords, ...result } = await runInvestigationSession({ fixture: investigationFixture(entry.id), agent, code, ledger,
        arm: "mindleak", stage: "discovery", signal, onEvent: emit, onToolDetail: details, workspaceFactory });
      preparation.push(result); sourceEvidence.set(entry.id, proofRecords);
      if (proofRecords.length) candidates[result.id] = Object.fromEntries(investigationFixture(entry.id).editable.map(path => [path, proofRecords.at(-1).files[path]]));
    }
    const formationTools = [...discoveryTools(),
      laboratoryTool("propose_chain", "Propose one narrow chain for a discovery case from its inspected observation IDs. A partial task can support a narrow belief. Do not treat two files as independent investigations.",
        { caseId: textField(100), observationIds: { type: "array", minItems: 1, maxItems: 4, items: textField(36) }, ...knowledgeProperties },
        ["caseId", "observationIds", ...knowledgeRequired], input => {
          if (!input.observationIds.every(id => inspectedDiscoveries.get("mindleak")?.has(id))) throw new Error("inspect_discovery_before_formation");
          return ledger.proposeChain(input);
        }),
      laboratoryTool("accept_chain", "Explicitly record validation of a case-specific candidate against its source evidence. This does not validate a generalized principle.",
        { chainId: textField(36) }, ["chainId"], ({ chainId }) => ledger.acceptChain(chainId)),
      laboratoryTool("propose_principle", "Propose one conditional principle from both distinct accepted discovery chains, with a bounded executable collect(client) hypothesis. Reserved cases are unavailable. Validation and acceptance happen in later fresh sessions.",
        { supportedBy: { type: "array", minItems: 2, maxItems: 2, items: textField(36) }, implementation: textField(6000), ...knowledgeProperties },
        ["supportedBy", "implementation", ...knowledgeRequired], input => ledger.proposePrinciple(input)),
    ];
    const noteTools = [...discoveryTools(), laboratoryTool("save_note", "Write one concise searchable Markdown lesson from the same checked discovery evidence, including a collect(client) procedure for reserved validation. Preserve conditions, limits and source IDs. No knowledge graph is available; do not invent evidence.",
      { observationIds: { type: "array", minItems: 2, maxItems: 8, items: textField(36) }, implementation: textField(6000), ...knowledgeProperties },
      ["observationIds", "implementation", ...knowledgeRequired], input => {
        if (notebook.length) throw new Error("one_note_in_mechanism_trial");
        const sources = input.observationIds.map(id => ledger.snapshot().observations.find(item => item.memoryId === id));
        if (sources.some(item => !item || !inspectedDiscoveries.get("notebook")?.has(item.memoryId)) || new Set(sources.map(item => item.caseId)).size !== 2) throw new Error("distinct_discovery_cases_required");
        const record = { ...structuredClone(input), id: randomUUID(), sources, validationChecks: [], accepted: false };
        compactPriorLesson(noteView(record)); notebook.push(record); return { id: record.id, stored: true };
      })];
    for (const arm of ["mindleak", "notebook"].sort((left, right) => digest(`${seed}:${left}`).localeCompare(digest(`${seed}:${right}`)))) {
      await phase("formation", arm, "Inspect the two discovery cases. Produce a useful conditional procedure only when their evidence supports it. A task need not be complete. Keep uncertainty and avoid claims beyond the sources.", arm === "mindleak" ? formationTools : noteTools);
      for (const entry of plan.validation) await validate(arm, entry);
      const candidate = arm === "mindleak" ? ledger.snapshot().principles[0] : notebook[0];
      const tool = arm === "mindleak" ? laboratoryTool("accept_principle", "Explicitly accept the candidate only after both reserved predictions and current source checks succeed. The tested boundary is preserved; no automatic acceptance.",
        {}, [], () => ledger.acceptPrinciple(candidate?.chainId)) : laboratoryTool("publish_note", "Make this note available to future agents only if both reserved checks match its predictions. Otherwise leave it unresolved.", {}, [], () => {
          if (!candidate || candidate.validationChecks.length !== 2 || !candidate.validationChecks.every(check => check.correct)) throw new Error("reserved_validation_required");
          candidate.accepted = true; return { id: candidate.id, accepted: true };
        });
      await phase("acceptance", arm, "Review the actual validation outcomes. Explicitly accept or publish only a validated candidate; leave insufficient or disproved knowledge unresolved. No new learning is a legitimate outcome.", [tool], JSON.stringify(candidate ?? { status: "no_candidate" }));
    }
    activePhase = "freeze"; activeArm = "mindleak"; let freezeStarted = performance.now();
    frozen = await ledger.freeze(); operationalWork.push({ arm: "mindleak", phase: "freeze", elapsedMs: performance.now() - freezeStarted }); ledger.setReadOnly(true);
    const noteSnapshot = notebook.filter(item => item.accepted).map(noteView); const noteFingerprint = digest(noteSnapshot);
    const knowledgeFingerprint = digest([frozen.chains, frozen.principles, frozen.observations]);
    emit({ type: "rediscovery_round_started", round: 1, lessons: frozen.lessons.length, lessonVersions: frozen.lessons.map(item => ({ id: item.id, revision: item.revision })) });
    for (const session of plan.sessions) {
      if (signal?.aborted) break;
      activePhase = "evaluation"; activeArm = session.arm;
      const experience = rediscoveryExperienceTools({ arm: session.arm, frozen: session.arm === "notebook" ? { lessons: noteSnapshot } : frozen,
        driver: measuredDriver, scope: ledger.scope, onEvent: event => emit({ ...event, agent: session.arm, phaseScope: "evaluation", caseId: session.id }) });
      const { proofRecords, ...result } = await runInvestigationSession({ fixture: investigationFixture(session.caseId), agent, code, ledger, arm: session.arm,
        stage: "evaluation", experience, direct: session.diagnostic && frozen.lessons[0] ? compactPriorLesson(frozen.lessons[0]) : null,
        signal, onEvent: emit, onToolDetail: details, workspaceFactory });
      outcomes.push(result); if (["mindleak", "notebook"].includes(session.arm)) sourceEvidence.set(`${session.arm}:${session.caseId}`, proofRecords);
      if (proofRecords.length) candidates[result.id] = Object.fromEntries(investigationFixture(session.caseId).editable.map(path => [path, proofRecords.at(-1).files[path]]));
    }
    activePhase = "freeze"; activeArm = "mindleak";
    freezeStarted = performance.now();
    const after = await ledger.freeze();
    operationalWork.push({ arm: "mindleak", phase: "freeze", elapsedMs: performance.now() - freezeStarted });
    frozenUnchanged = digest([after.chains, after.principles, after.observations]) === knowledgeFingerprint && digest(notebook.filter(item => item.accepted).map(noteView)) === noteFingerprint;
    if (!frozenUnchanged) throw new Error("frozen_investigation_changed");
    emit({ type: "rediscovery_round_finished", round: 1, frozenUnchanged });
    ledger.setReadOnly(false);
    for (const arm of ["notebook", "mindleak"]) if (!signal?.aborted) await review(arm);
  } catch (error) {
    failure = signal?.aborted ? "cancelled" : "investigation_execution_failed";
    emit({ type: "run_error", reason: failure });
  } finally { unsubscribe?.(); }
  const knowledge = ledger.snapshot();
  const arms = {};
  for (const arm of rediscoveryArms) {
    const own = outcomes.filter(item => item.arm === arm.id);
    const preparatory = arm.id === "fresh" ? [] : [...preparation, ...preparationWork.filter(item => item.arm === (arm.id === "direct" ? "mindleak" : arm.id))];
    const correct = own.filter(item => item.correct); const reused = own.filter(item => item.reuseObserved);
    arms[arm.id] = { scheduled: 4, completed: own.length, correct: correct.length, unresolved: 4 - correct.length, correctRate: correct.length / 4,
      checkedDecisions: own.filter(item => item.decisionCorrect).length, decisionRate: own.filter(item => item.decisionCorrect).length / 4,
      decisionsWithPriorEvidence: own.filter(item => item.decisionWithPriorEvidence).length,
      inputTokens: sum(own, "inputTokens"), outputTokens: sum(own, "outputTokens"), totalInputTokens: sum([...own, ...preparatory], "inputTokens"), totalOutputTokens: sum([...own, ...preparatory], "outputTokens"),
      elapsedMs: sum(own, "elapsedMs"), totalElapsedMs: sum([...own, ...preparatory, ...(["mindleak", "direct"].includes(arm.id) ? operationalWork : [])], "elapsedMs"), actualCostUsd: null,
      retrievalMisses: own.reduce((total, item) => total + item.experienceAccesses.filter(access => !access.lessonIds.length).length, 0),
      knowledgeReuse: { successful: reused.length, rate: reused.length / 4, evidence: "Source-backed decision after prior exposure, before a changed passing candidate; not individual causal attribution." },
      transfer: { attempts: own.filter(item => item.priorKnowledgeDelivered && item.stage !== "irrelevant").length, successful: reused.length },
      usedChainIds: [...new Set(own.flatMap(item => item.usedChainIds))], knownFailureCandidates: null, firstVerifiedFixMedianMs: null,
      boundaryDecisions: own.filter(item => ["changed", "irrelevant"].includes(item.stage) && item.decisionCorrect).length };
  }
  const metrics = { arms, curve: [], learning: { discoveriesRetained: knowledge.observations.filter(item => item.kind !== "validation").length,
    unfinishedInvestigationsWithEvidence: preparation.filter(item => !item.correct && item.observationIds.length).length,
    acceptedPrinciples: (frozen?.principles ?? []).filter(item => item.state === "accepted").length,
    exceptionsRetained: reviews.filter(item => item.outcome === "exception_retained").length,
    predictions: plan.validation.length * 2, predictionsExecuted: validations.filter(item => item.status === "executed").length,
    correctPredictions: validations.filter(item => item.correct).length, validationFailures: validations.filter(item => item.status === "execution_failed").length,
    independentFamilies: 1, comparativeBenefit: "not_established", semanticPrincipleQuality: "not_measured" },
    costBreakEven: null, compoundingScore: null, allocation: "Shared discovery is charged once to each experience-bearing counterfactual arm; each gets its own preparation and validation costs. Direct delivery is separate. Actual run totals count each executed session only once." };
  const status = signal?.aborted ? "cancelled" : failure || outcomes.length !== 16 ? "partial" : "completed";
  const allSessions = [...preparation, ...preparationWork, ...outcomes];
  const finalTests = { expectedTests: 54, tests: [...preparation, ...outcomes].reduce((total, item) => total + (item.finalTests?.tests ?? 0), 0),
    passedTests: [...preparation, ...outcomes].reduce((total, item) => total + (item.finalTests?.passedTests ?? 0), 0),
    passed: preparation.length === 2 && outcomes.length === 16 && [...preparation, ...outcomes].every(item => item.correct) };
  const usage = { inputTokens: sum(allSessions, "inputTokens"), outputTokens: sum(allSessions, "outputTokens"), toolCalls: sum(allSessions, "toolCalls") };
  emit({ type: "tests", agent: "system", phase: "final", ...finalTests });
  emit({ type: "run_finished", status });
  return { reportVersion: 2, kind: "rediscovery_lab", experiment: 3, protocolVersion: 4, title: "Investigation Learning", problem: "What survives an investigation and helps the next agent?",
    runId, createdAt, status, failure, plan, scope: ledger.scope, preparation, preparationWork, outcomes, validations, reviews, operationalWork, notebook, knowledge, metrics, candidates,
    rounds: [{ number: 1, stage: "evaluation", frozenUnchanged, lessonVersions: (frozen?.lessons ?? []).map(item => ({ id: item.id, revision: item.revision })), learning: null }],
    agents: rediscoveryArms.map(arm => ({ ...arm, model: agent.configuration.model })), events, memoryExhibits, toolExhibits, finalTests, elapsedMs: performance.now() - started,
    ...usage, binarySha256: driver.binarySha256, fixtureSha256: plan.frozenInputsSha256, server: driver.server,
    agent: structuredClone(agent.configuration), codeContainer: code, realModel: agent.configuration.provider ? agent.configuration.provider !== "test" : null,
    memoryProcessing: { calls: memoryUsage.length, inputTokens: sum(memoryUsage, "inputTokens"), outputTokens: sum(memoryUsage, "outputTokens"), actualCostUsd: null }, memoryCalls,
    summary: { ...metrics.learning, ...usage, memoriesStored: knowledge.operations.length, correct: outcomes.filter(item => item.correct && !item.diagnostic).length, scheduled: 12, actualCostUsd: null },
    realMcpProcess: driver.realProcess === true, evidenceScope: "One-family mechanism experiment; validation checks are separate from task completion and evaluation. No demonstrated general learning advantage." };
}
