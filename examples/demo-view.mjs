const colors = ["#145ee0", "#d73537", "#008655", "#a16b00", "#953ecc"];
const defaultAgents = [
  { id: "atlas", name: "Atlas", title: "Time Engine", icon: "timer" },
  { id: "iris", name: "Iris", title: "Input Policy", icon: "shield-check" },
  { id: "nova", name: "Nova", title: "Session Store", icon: "database" },
  { id: "vega", name: "Vega", title: "Interface", icon: "panels-top-left" },
  { id: "orion", name: "Orion", title: "Integration", icon: "workflow" },
];

export function studyProgress(report, parent = null) {
  const summarize = source => {
    const arms = {};
    if (source.kind === "rediscovery_lab") for (const [id, arm] of Object.entries(source.metrics?.arms ?? {})) arms[id] = { correct: arm.correct, scheduled: arm.scheduled };
    else if (source.controlExperiment) for (const [key, id] of [["withMemory", "mindleak"], ["withoutMemory", "daleks"]]) {
      const arm = source.controlExperiment.summary?.[key];
      arms[id] = { correct: arm?.correct ?? 0, scheduled: source.controlExperiment.summary?.scheduledPairs ?? 0 };
    }
    else if (source.buildComparison) for (const [key, id] of [["withMemory", "mindleak"], ["withoutMemory", "daleks"]]) {
      const arm = source.buildComparison[key]; arms[id] = { correct: arm?.agentsPassed ?? 0, scheduled: arm?.agents ?? 5 };
    }
    const unique = (items, key) => new Set((items ?? []).map(item => item[key])).size;
    return { runId: source.runId, createdAt: source.createdAt, status: source.status, kind: source.kind, model: source.agent?.model ?? null,
      arms, observations: unique(source.knowledge?.observations ?? source.memoryExhibits, "memoryId"),
      chains: unique(source.knowledge?.chains, "chainId"), principles: unique(source.knowledge?.principles, "chainId"),
      inputTokens: source.summary?.inputTokens ?? null, outputTokens: source.summary?.outputTokens ?? null,
      memoryInputTokens: source.memoryProcessing?.inputTokens ?? null, memoryOutputTokens: source.memoryProcessing?.outputTokens ?? null,
      elapsedMs: source.elapsedMs ?? null };
  };
  const runs = [...structuredClone(parent?.study?.runs ?? (parent ? [summarize(parent)] : [])), summarize(report)];
  const sum = field => runs.every(run => Number.isFinite(run[field]) && run[field] >= 0) ? runs.reduce((total, run) => total + run[field], 0) : null;
  return { version: 1, studyId: parent?.study?.studyId ?? parent?.runId ?? report.runId, parentRunId: parent?.runId ?? null,
    sequence: runs.length, taskExposure: parent ? "previously_exposed" : "fresh_study", runs,
    totals: { inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), memoryInputTokens: sum("memoryInputTokens"), memoryOutputTokens: sum("memoryOutputTokens"), elapsedMs: sum("elapsedMs") },
    interpretation: "Continuation uses fresh sessions and source workspaces with retained experience. Repeated tasks are exposed; improvement is not guaranteed or independent held-out evidence. Costs and unsuccessful outcomes remain in the run history." };
}

export function buildCollaboration(report = {}) {
  if (report.kind !== "swarm_build" || report.memoryAccess === "none") return null;
  const actors = (report.agents ?? []).filter(actor => !actor.control);
  const events = (report.events ?? []).filter(event => event.condition !== "withoutMemory");
  const started = events.find(event => ["run_started", "build_team_started"].includes(event.type) && event.memoryPolicy);
  const policy = report.memoryPolicy ?? started?.memoryPolicy ?? null;
  const checks = [...new Map(events.filter(event => event.type === "collaboration_checked").map(event => [event.agent, event])).values()];
  const knowledgeFirst = ["knowledge-first-handoff-v4", "knowledge-first-handoff-v5"].includes(policy);
  const measured = report.collaboration ?? (knowledgeFirst || policy === "verified-handoff-v3" ? { requiredPublications: started?.requiredPublications ?? actors.length,
    publishedComponents: checks.filter(check => check.published).length, requiredDependencyHandoffs: started?.requiredDependencyHandoffs ?? null,
    priorKnowledgeChecked: knowledgeFirst ? checks.filter(check => check.priorKnowledgeChecked).length : null,
    priorKnowledgeAssessed: knowledgeFirst ? checks.filter(check => check.priorKnowledgeAssessed).length : null,
    checkedDependencySources: policy === "knowledge-first-handoff-v5" ? checks.reduce((total, check) => total + (check.checkedDependencies?.length ?? 0), 0) : null,
    receivedDependencyHandoffs: checks.reduce((total, check) => total + (check.receivedDependencies?.length ?? 0), 0), completed: false } : null);
  const legacyPublications = actors.every(actor => Number.isInteger(actor.attempts?.at(-1)?.publishedMemories))
    ? actors.filter(actor => actor.attempts.at(-1).publishedMemories > 0).length : null;
  return { policy, status: measured ? measured.completed ? "completed" : report.status === "recording" ? "running" : "incomplete" : policy === "optional-use-v2" ? "optional" : "not_measured",
    requiredPublications: measured?.requiredPublications ?? null, publishedComponents: measured?.publishedComponents ?? legacyPublications,
    priorKnowledgeChecked: measured?.priorKnowledgeChecked ?? null, priorKnowledgeAssessed: measured?.priorKnowledgeAssessed ?? null,
    checkedDependencySources: measured?.checkedDependencySources ?? null,
    requiredDependencyHandoffs: measured?.requiredDependencyHandoffs ?? null, receivedDependencyHandoffs: measured?.receivedDependencyHandoffs ?? null,
    crossAgentHandoffs: report.summary?.crossAgentHandoffs ?? new Set(events.filter(event => event.type === "memory_delivered" && event.from && event.from !== "brief" && event.from !== event.agent)
      .map(event => `${event.from}:${event.agent}`)).size,
    codePassedComponents: report.summary?.codePassedComponents ?? (report.status === "recording" ? checks.filter(check => check.codePassed).length
      : actors.filter(actor => actor.attempts?.at(-1)?.codePassed ?? actor.attempts?.at(-1)?.passed).length), components: actors.length };
}

export function labCompletion(report = {}) {
  const items = [];
  const add = (id, label, outcome, tests, correct = outcome?.passed, expected = tests?.expectedTests) => {
    const measured = Number.isSafeInteger(expected) && expected > 0 && Number.isSafeInteger(tests?.tests)
      && tests.tests === expected && Number.isSafeInteger(tests.passedTests) && tests.passedTests >= 0 && tests.passedTests <= expected;
    const passing = measured && tests.passed === true && tests.passedTests === expected && correct === true
      && !outcome?.infrastructureFailure && (!outcome?.status || outcome.status === "completed");
    items.push({ id, label, status: !measured ? "incomplete" : passing ? "passed" : "failed",
      expectedTests: Number.isSafeInteger(expected) ? expected : null, executedTests: tests?.tests ?? null,
      passedTests: tests?.passedTests ?? null, sourceSha256: tests?.sourceSha256 ?? null,
      checks: tests?.checks ?? (tests?.failedTests ?? []).map(name => ({ name, passed: false })) });
  };
  if (report.kind === "rediscovery_lab" && report.plan) {
    const expectedPreparation = report.plan.preparationTasks ?? 0;
    const expectedChecks = report.plan.profile === "quality" ? 8 : 3;
    for (let index = 0; index < expectedPreparation; index += 1) {
      const outcome = report.preparation?.[index];
      add(outcome?.id ?? `preparation-${index + 1}`, outcome?.id ?? `Preparation ${index + 1}`, outcome, outcome?.finalTests, outcome?.correct, expectedChecks);
    }
    const outcomes = new Map((report.outcomes ?? []).map(outcome => [outcome.id, outcome]));
    for (const planned of report.plan.sessions ?? []) {
      const outcome = outcomes.get(planned.id);
      add(planned.id, `${planned.arm}${planned.diagnostic ? " (diagnostic)" : ""}: ${planned.id}`, outcome, outcome?.finalTests, outcome?.correct, expectedChecks);
    }
  } else if (report.kind === "swarm_build") {
    for (const actor of report.agents ?? []) {
      const attempt = actor.attempts?.at(-1);
      add(actor.id, actor.name, attempt, attempt?.verification, attempt?.codePassed ?? (actor.state === "passed" && attempt?.passed === true));
    }
    if (report.buildComparison) for (const [condition, label] of [["withMemory", "MindLeak integration"], ["withoutMemory", "Dalek integration"]]) {
      const team = report.buildComparison[condition];
      add(condition, label, team?.codeComplete ? { ...team, status: "completed" } : team, team?.finalTests, team?.codeComplete ?? team?.status === "completed", 18);
    }
    else if (report.finalTests) add("integration", "Full application integration", { status: report.status }, report.finalTests, report.finalTests.passed, 18);
  } else if (report.kind === "memory_lab") {
    const preparationActors = report.preparationReused ? [] : (report.agents ?? []).filter(actor => !actor.control);
    for (const actor of preparationActors) {
      const attempt = actor.attempts?.filter(attempt => attempt.phase !== "control" && attempt.condition === "withMemory").at(-1);
      add(`preparation:${actor.id}`, `${actor.name}: preparation`, attempt, attempt?.verification);
    }
    for (const round of report.controlExperiment?.rounds ?? []) for (const pair of round.pairs) for (const condition of ["withMemory", "withoutMemory"]) {
      const outcome = pair[condition];
      add(`${pair.id}:${condition}`, `Round ${round.number}: ${outcome?.name ?? condition} / ${pair.caseId}`, outcome, outcome?.verification);
    }
    const planned = (report.controlExperiment?.plan?.pairs?.length ?? 0) * 2 + preparationActors.length;
    while (items.length < planned) add(`unrecorded-${items.length}`, "Unrecorded scheduled task", null, null, false);
  }
  const executionStatus = { recording: "running", completed: "finished", partial: "incomplete", cancelled: "stopped" }[report.status] ?? "not_started";
  const passed = items.filter(item => item.status === "passed").length;
  const failed = items.filter(item => item.status === "failed").length;
  const incomplete = items.filter(item => item.status === "incomplete").length;
  const requirementsStatus = !items.length ? "not_measured" : incomplete ? "incomplete" : failed ? "failed" : "passed";
  const qualityAreas = ["Browser behaviour", "Responsive layout", "Accessibility", "Security", "Maintainability"];
  const artifacts = report.buildComparison ? ["application", "controlApplication"] : ["application", "controlApplication"].filter(key => report[key]?.sha256);
  const qualityChecks = (report.qualityReviews ?? []).filter(review => qualityAreas.includes(review.area) && typeof review.artifactSha256 === "string"
    && artifacts.includes(review.artifact) && report[review.artifact]?.sha256 === review.artifactSha256
    && typeof review.method === "string" && review.method.length > 0 && Number.isSafeInteger(review.checks) && review.checks > 0
    && Number.isSafeInteger(review.passedChecks) && review.passedChecks >= 0 && review.passedChecks <= review.checks);
  const unreviewed = qualityAreas.filter(area => !artifacts.length || !artifacts.every(artifact => {
    const passedReviews = qualityChecks.filter(review => review.artifact === artifact && review.area === area && review.passedChecks === review.checks);
    return ["Browser behaviour", "Responsive layout"].includes(area) ? [[1440, 1080], [390, 844]].every(([width, height]) =>
      passedReviews.some(review => review.viewport?.width === width && review.viewport?.height === height)) : passedReviews.length > 0;
  }));
  const observedUses = report.kind === "memory_lab" ? knowledgeMetrics(report).reuse.tasks
    : (report.outcomes ?? []).filter(outcome => outcome.arm === "mindleak" && !outcome.diagnostic && outcome.correct === true && outcome.reuseObserved === true).length;
  return { execution: { status: executionStatus },
    requirements: { status: requirementsStatus, passed, failed, incomplete, scheduled: items.length, unresolved: items.length - passed, items },
    quality: { status: qualityChecks.some(review => review.passedChecks !== review.checks) ? "failed" : !qualityChecks.length ? "not_reviewed" : unreviewed.length ? "partial_review" : "reviewed",
      checks: qualityChecks, unreviewed },
    learning: { status: observedUses ? "observed_use" : "not_established", observedUses, advantage: "not_established",
      explanation: "Observed reuse is separate from passing requirements. These synthetic runs do not establish a general learning advantage." },
    releaseReady: false, scope: "Acceptance checks for these fixtures only; not a production quality or security certification." };
}

export function qualityComparison(report = {}) {
  if (report.plan?.profile !== "quality") return null;
  const sessions = report.plan.sessions ?? [];
  const planned = new Map(sessions.map(session => [session.id, session]));
  const receipts = new Map((report.events ?? []).filter(event => event.type === "quality_checked").map(event => [event.caseId, event]));
  const records = report.outcomes ?? (report.events ?? []).filter(event => event.type === "rediscovery_task_finished" && event.phaseScope === "evaluation")
    .map(event => ({ ...event, id: event.caseId, arm: event.agent, quality: receipts.get(event.caseId) }));
  const outcomes = new Map(records.filter(outcome => planned.get(outcome.id)?.arm === outcome.arm).map(outcome => [outcome.id, outcome]));
  const groups = { behavior: 2, boundary: 3, regression: 3 };
  const measured = outcome => outcome?.quality?.measured === true && outcome.quality.checksScheduled === 8
    && Number.isSafeInteger(outcome.quality.checksPassed) && outcome.quality.checksPassed >= 0 && outcome.quality.checksPassed <= 8
    && Object.entries(groups).every(([group, expected]) => outcome.quality.dimensions?.[group]?.scheduled === expected
      && Number.isSafeInteger(outcome.quality.dimensions[group].passed) && outcome.quality.dimensions[group].passed >= 0 && outcome.quality.dimensions[group].passed <= expected)
    && Object.keys(groups).reduce((total, group) => total + outcome.quality.dimensions[group].passed, 0) === outcome.quality.checksPassed;
  const arms = Object.fromEntries((report.plan.arms ?? []).map(arm => {
    const scheduled = sessions.filter(session => session.arm === arm).length;
    const own = [...outcomes.values()].filter(outcome => outcome.arm === arm);
    const checked = own.filter(measured);
    return [arm, { scheduled, completed: own.length, correct: own.filter(outcome => outcome.correct).length,
      checksPassed: checked.reduce((total, outcome) => total + outcome.quality.checksPassed, 0),
      unmeasuredTasks: scheduled - checked.length, correctRejections: checked.filter(outcome => outcome.quality.correctRejection).length,
      checkedDecisions: checked.filter(outcome => outcome.quality.sourceBackedDecision).length,
      dimensions: Object.fromEntries(Object.entries(groups).map(([group, expected]) => [group, {
        scheduled: scheduled * expected, passed: checked.reduce((total, outcome) => total + outcome.quality.dimensions[group].passed, 0),
      }])) }];
  }));
  return { arms, measured: [...outcomes.values()].filter(measured).length, scheduled: sessions.length,
    comparisons: (report.plan.evaluation ?? []).map(entry => {
      const original = outcomes.get(`${entry.id}:original`); const revised = outcomes.get(`${entry.id}:mindleak`);
      const originalChecks = measured(original) ? original.quality.checksPassed : null;
      const revisedChecks = measured(revised) ? revised.quality.checksPassed : null;
      return { caseId: entry.id, originalChecks, revisedChecks,
        checksDelta: originalChecks !== null && revisedChecks !== null ? revisedChecks - originalChecks : null };
    }) };
}

export function knowledgeCapital(report = {}) {
  const records = (items, field) => new Map((items ?? []).filter(item => typeof item?.[field] === "string").map(item => [item[field], item]));
  const knowledge = report.knowledge ?? {};
  const observations = records(knowledge.observations ?? report.memoryExhibits?.filter(item => !item.kind || item.kind === "observation"), "memoryId");
  const chains = records(knowledge.chains, "chainId");
  const principles = records(knowledge.principles, "chainId");
  const lessons = records(knowledge.lessons, "id");
  const weights = { observation: 1, chain: 5, principle: 10 };
  const usedObservations = new Set(); const usefulChains = new Set(); const validatedPrinciples = new Set();
  const usedTasks = new Set(); const checkpoints = [];
  const accepted = record => record?.state === "accepted" && record.requiresReview !== true;
  const liveRounds = new Map(); const liveOutcomes = [];
  for (const event of report.events ?? []) {
    if (event.type === "rediscovery_round_started") liveRounds.set(event.round, { number: event.round, lessonVersions: event.lessonVersions });
    if (event.type === "rediscovery_round_finished" && liveRounds.has(event.round)) liveRounds.get(event.round).frozenUnchanged = event.frozenUnchanged;
    if (event.type === "rediscovery_task_finished" && event.phaseScope === "evaluation" && event.capitalEvidence) liveOutcomes.push({
      ...event.capitalEvidence, id: event.caseId, arm: event.agent, round: event.round, family: event.family, stage: event.stage,
      correct: event.correct, reuseObserved: event.reuseObserved, diagnostic: event.diagnostic,
    });
  }
  const rounds = [...(report.rounds ?? liveRounds.values())].filter(round => round.frozenUnchanged === true).sort((left, right) => left.number - right.number);
  const measured = report.kind === "rediscovery_lab" && (Array.isArray(report.outcomes) || liveOutcomes.length > 0) && rounds.length > 0;
  const outcomes = records(report.outcomes ?? liveOutcomes, "id");
  for (const round of measured ? rounds : []) {
    for (const outcome of outcomes.values()) {
      if (outcome.round !== round.number || outcome.arm !== "mindleak" || outcome.diagnostic || outcome.correct !== true || outcome.reuseObserved !== true
        || outcome.finalTests?.passed !== true || !Number.isSafeInteger(outcome.finalTests.expectedTests) || outcome.finalTests.expectedTests <= 0
        || outcome.finalTests.tests !== outcome.finalTests.expectedTests || outcome.finalTests.passedTests !== outcome.finalTests.expectedTests
        || !outcome.writes?.length || outcome.stage === "irrelevant") continue;
      const decisionAt = Math.max(...outcome.writes.map(write => Number.isFinite(write.atMs) ? write.atMs : -1));
      if (decisionAt < 0) continue;
      for (const access of outcome.experienceAccesses ?? []) {
        if (!Number.isFinite(access.atMs) || access.atMs < 0 || access.atMs > decisionAt) continue;
        const eligible = (access.lessonIds ?? []).filter(id => {
          const lesson = lessons.get(id); const principle = principles.get(id);
          const revision = round.lessonVersions?.find(reference => reference.id === id)?.revision;
          return lesson?.family === outcome.family && typeof outcome.fixtureSha256 === "string" && typeof lesson.sourceFixtureSha256 === "string"
            && lesson.sourceFixtureSha256 !== outcome.fixtureSha256 && accepted(principle) && revision === principle.revision
            && Array.isArray(principle.document?.supportedBy) && principle.document.supportedBy.length > 0
            && principle.document.supportedBy.every(reference => accepted(chains.get(reference.chainId)) && chains.get(reference.chainId).revision === reference.revision);
        });
        if (!eligible.length) continue;
        usedTasks.add(outcome.id);
        if (access.level === "principle") for (const id of eligible) validatedPrinciples.add(id);
        if (access.level === "chain" && accepted(chains.get(access.resourceId)) && eligible.some(id =>
          principles.get(id).document.supportedBy.some(reference => reference.chainId === access.resourceId))) usefulChains.add(access.resourceId);
        for (const id of access.observationIds ?? []) if (observations.has(id)) usedObservations.add(id);
      }
    }
    checkpoints.push({ round: round.number, score: usedObservations.size * weights.observation + usefulChains.size * weights.chain + validatedPrinciples.size * weights.principle,
      usedObservations: usedObservations.size, usefulChains: usefulChains.size, validatedPrinciples: validatedPrinciples.size });
  }
  const score = measured ? checkpoints.at(-1).score : null;
  const baseline = checkpoints[0]?.score;
  const comparable = checkpoints.length > 1;
  return { version: 1, score, weights, observations: observations.size, usedObservations: measured ? usedObservations.size : null,
    usefulChains: measured ? usefulChains.size : null, validatedPrinciples: measured ? validatedPrinciples.size : null,
    acceptedPrinciples: [...principles.values()].filter(accepted).length, checkpoints,
    growthPercent: comparable && baseline > 0 ? 100 * (score - baseline) / baseline : null,
    growthStatus: !measured ? "not_measured" : !comparable ? "needs_comparison" : baseline > 0 ? "comparable" : score > 0 ? "first_reuse" : "no_reuse",
    usedObservationIds: [...usedObservations], usefulChainIds: [...usefulChains], validatedPrincipleIds: [...validatedPrinciples], usedTaskIds: [...usedTasks],
    interpretation: "Weighted observed-reuse index, not a measure of intelligence or a causal productivity claim. Records count once; only current accepted revisions with prior exposure before a changed passing task qualify. Stored observations are shown separately from observations used." };
}

function recordedGuideUse(event, applications) {
  if (event.passed !== true || event.condition !== "withMemory" || event.guideApplied !== true
    || typeof event.caseId !== "string" || !Number.isFinite(event.atMs)) return false;
  if (event.type === "control_arm_finished") return event.guideRetrievedBeforeAssessment === true && event.sourceEvidenceVerified === true
    && event.sourceObservationsRead >= 1 && typeof event.guideUsed?.chainId === "string" && event.guideUsed.chainId.length > 0
    && Number.isSafeInteger(event.guideUsed.revision) && event.guideUsed.revision > 0;
  return event.type === "assessment_finished" && applications.some(application => application.agent === event.agent
    && application.caseId === event.caseId && typeof application.memoryId === "string" && application.memoryId.length > 0
    && typeof application.chainId === "string" && application.chainId.length > 0 && Number.isSafeInteger(application.revision) && application.revision > 0
    && application.steps >= 2 && application.sourceObservations >= 2 && Number.isFinite(application.atMs) && application.atMs <= event.atMs);
}

export function knowledgeMetrics(report = {}) {
  const unique = (records, field) => new Map((records ?? []).filter(record => typeof record?.[field] === "string").map(record => [record[field], record]));
  const knowledge = report.knowledge ?? {};
  const observations = unique(knowledge.observations ?? report.memoryExhibits?.filter(item => item.agent !== "brief"), "memoryId");
  const chains = unique(knowledge.chains, "chainId");
  const principles = unique(knowledge.principles, "chainId");
  const fragmentOwners = new Map([...observations.values()].flatMap(source => (source.fragments ?? []).map(fragment => [fragment.fragmentId, source.memoryId])));
  const reviewed = record => record.state === "accepted" && record.review === "reviewed" && record.requiresReview !== true
    && Number.isSafeInteger(record.revision) && record.revision > 0;
  const knownEvidence = record => Array.isArray(record.document?.evidence)
    && record.document.evidence.every(reference => fragmentOwners.has(reference.fragmentId));
  const acceptedChains = new Map([...chains].filter(([, record]) => reviewed(record) && knownEvidence(record)
    && record.document.evidence.some(reference => reference.role === "supports")));
  const acceptedPrinciples = new Map([...principles].filter(([, record]) => {
    const supports = record.document?.supportedBy;
    return reviewed(record) && knownEvidence(record) && Array.isArray(supports) && supports.length >= 2
      && new Set(supports.map(reference => reference.chainId)).size === supports.length
      && supports.every(reference => acceptedChains.has(reference.chainId) && acceptedChains.get(reference.chainId).revision === reference.revision);
  }));
  const unknownReview = record => record.state === "accepted" && record.requiresReview !== true
    && !["reviewed", "unreviewed", "challenged"].includes(record.review);
  const levels = (records, accepted) => ({ stored: records.size, accepted: accepted.size,
    recordedAccepted: [...records.values()].filter(record => record.state === "accepted").length,
    candidates: [...records.values()].filter(record => record.state === "candidate").length,
    needsReview: [...records].filter(([id, record]) => record.state === "accepted" && !accepted.has(id) && !unknownReview(record)).length,
    reviewUnknown: [...records.values()].filter(unknownReview).length });
  const supporting = new Set([...chains.values()].filter(record => record.state === "accepted" && knownEvidence(record)).flatMap(record => record.document.evidence
    .filter(reference => reference.role === "supports").map(reference => fragmentOwners.get(reference.fragmentId))));
  const formation = { observations: { stored: observations.size, supporting: supporting.size },
    chains: levels(chains, acceptedChains), principles: levels(principles, acceptedPrinciples),
    status: acceptedPrinciples.size ? "principles_formed" : acceptedChains.size ? "chains_formed"
      : [...chains.values(), ...principles.values()].some(unknownReview) ? "review_metadata_unavailable"
      : observations.size ? "observations_captured" : "awaiting_observations" };
  if (report.kind === "rediscovery_lab") {
    const live = [...new Map((report.events ?? []).filter(event => event.type === "rediscovery_task_finished" && event.phaseScope === "evaluation" && event.agent === "mindleak")
      .map(event => [event.caseId, event])).values()];
    const memory = report.metrics?.arms?.mindleak ?? (live.length ? { completed: live.length, correct: live.filter(event => event.correct).length,
      knowledgeReuse: { successful: live.filter(event => event.correct && event.reuseObserved).length,
        rate: live.some(event => event.correct) ? live.filter(event => event.correct && event.reuseObserved).length / live.filter(event => event.correct).length : null,
        evidence: "Recorded prior exposure before a changed passing candidate; final accounting follows at run completion." },
      transfer: { attempts: live.filter(event => event.stage !== "irrelevant" && event.priorKnowledgeDelivered).length, successful: live.filter(event => event.correct && event.reuseObserved).length },
      usedChainIds: [], firstVerifiedFixMedianMs: null, knownFailureCandidates: live.reduce((total, event) => total + (event.knownFailureCandidates ?? 0), 0) } : null);
    const fresh = report.metrics?.arms?.fresh;
    const usageRecords = report.outcomes ? report.outcomes.filter(outcome => outcome.arm === "mindleak") : live;
    const usageKnown = usageRecords.length > 0 && usageRecords.every(outcome => typeof outcome.knowledgeWorkflow?.lookedUp === "boolean"
      || Array.isArray(outcome.knowledgeWorkflow?.searches) || Array.isArray(outcome.experienceAccesses) && Array.isArray(outcome.experienceErrors));
    const attempted = outcome => outcome.knowledgeWorkflow?.lookedUp ?? Boolean(outcome.knowledgeWorkflow?.searches?.length || outcome.experienceAccesses?.length || outcome.experienceErrors?.length);
    const assessed = outcome => outcome.knowledgeWorkflow?.assessment?.decision ?? outcome.knowledgeWorkflow?.decision;
    const lookedUp = usageRecords.filter(attempted).length;
    const usage = usageKnown ? { policy: report.plan?.memoryUse ?? "not_recorded", evaluated: usageRecords.length,
      lookedUp, notConsulted: usageRecords.length - lookedUp, received: usageRecords.filter(outcome => outcome.priorKnowledgeDelivered).length,
      assessed: report.plan?.memoryUse === "knowledge_first" ? usageRecords.filter(assessed).length : null,
      rejected: usageRecords.filter(outcome => assessed(outcome) === "reject").length,
      verifiedUse: usageRecords.filter(outcome => outcome.correct && outcome.reuseObserved).length,
      misses: usageRecords.every(outcome => Array.isArray(outcome.experienceAccesses)) ? usageRecords.reduce((total, outcome) => total + outcome.experienceAccesses.filter(access => access.lessonIds.length === 0).length, 0) : null,
      errors: usageRecords.every(outcome => Array.isArray(outcome.experienceErrors)) ? usageRecords.reduce((total, outcome) => total + outcome.experienceErrors.length, 0) : null,
    } : null;
    return { evaluatedTasks: memory?.completed ?? 0, successfulTasks: memory?.correct ?? 0,
      usage,
      reuse: { kind: "temporal_change", tasks: memory?.knowledgeReuse.successful ?? 0, rate: memory?.knowledgeReuse.rate ?? null, evidence: memory?.knowledgeReuse.evidence ?? "Prior exposure before a changed passing candidate" },
      transfer: { attempts: memory?.transfer.attempts ?? 0, successful: memory?.transfer.successful ?? 0, rate: memory?.transfer.attempts ? memory.transfer.successful / memory.transfer.attempts : null,
        evidence: "A new transfer task with prior experience delivered before a changed passing implementation. All retrieval misses remain in the main-arm correctness result." },
      chains: { created: chains.size, used: memory?.usedChainIds.length ?? 0, rate: chains.size && memory ? memory.usedChainIds.length / chains.size : null,
        status: memory ? "observed" : "not_measured", evidence: "Direct chain inspection before a changed passing candidate, not every transitive support." },
      compression: { observations: observations.size, chains: chains.size, principles: principles.size, observationsPerPrinciple: principles.size ? observations.size / principles.size : null, semanticQuality: "not_measured" },
      mistakesAvoided: { rate: null, count: null, status: "known_failure_candidates_only", withMemory: memory?.knownFailureCandidates ?? null, withoutMemory: fresh?.knownFailureCandidates ?? null },
      timeToCorrectHypothesis: { medianMs: memory?.firstVerifiedFixMedianMs ?? null, status: "verified_fix_time_only" },
      capital: knowledgeCapital(report), formation, investigation: ["mechanism", "quality"].includes(report.plan?.profile) ? {
        ...report.metrics?.learning, predictions: report.plan.profile === "quality" ? report.metrics?.learning?.predictions
          : report.plan.validation ? report.plan.validation.length * 2 : report.metrics?.learning?.predictions,
      } : null,
      curve: (report.metrics?.curve ?? []).map(point => ({ ...point, withMemory: point.mindleak, withoutMemory: point.fresh, tasksPerArm: point.mindleakScheduled })),
      evidenceScope: report.plan ? `${report.plan.profile} / ${report.plan.mainSessions} main + ${report.plan.diagnosticSessions} diagnostic sessions` : "Frozen rediscovery protocol",
      caseFamilies: report.plan?.families ?? null };
  }
  const preparationCases = new Set((report.cases ?? []).map(item => item.fixtureSha256));
  const rounds = report.controlExperiment?.rounds ?? [];
  const assessed = outcome => outcome?.passed === true && outcome.verification?.passed === true;
  const sourceLinked = outcome => outcome?.guideApplied === true && outcome.guideRetrievedBeforeAssessment === true
    && typeof outcome.finding?.guideStep === "string" && outcome.finding.guideStep.length >= 12
    && typeof outcome.finding?.quote === "string" && outcome.finding.quote.length >= 4 && typeof outcome.finding?.path === "string";
  let tasks = rounds.length ? rounds.flatMap(round => round.pairs.map(pair => ({ ...pair.withMemory, round: round.number,
    guideId: round.frozen?.chainId, frozen: round.frozen?.unchangedAfterComparison === true })))
    : (report.agents ?? []).filter(agent => !agent.control).flatMap(agent => {
      const attempt = (agent.attempts ?? []).filter(attempt => !attempt.condition || attempt.condition === "withMemory").at(-1);
      return attempt ? [{ ...attempt, agent: agent.id, guideLinked: attempt.guideApplied && Boolean(attempt.guideApplication?.memoryId) }] : [];
    });
  if (!tasks.length && report.status === "recording") {
    const events = report.events ?? [];
    const controls = events.some(event => event.type === "control_arm_finished");
    const applications = events.filter(event => event.type === "guide_applied");
    tasks = [...new Map(events.filter(event => controls ? event.type === "control_arm_finished" && event.condition === "withMemory"
      : event.condition !== "withoutMemory" && (event.type === "assessment_finished" || event.type === "tests" && event.phase === "verification"))
      .map(event => [`${event.round ?? 0}:${event.agent}`, { ...event, verification: { passed: event.passed },
        guideLinked: recordedGuideUse(event, applications),
      }])).values()];
  }
  const successful = tasks.filter(assessed);
  const reused = successful.filter(outcome => rounds.length ? outcome.frozen && sourceLinked(outcome) : outcome.guideLinked);
  const transfer = tasks.filter(outcome => outcome.frozen && sourceLinked(outcome) && typeof outcome.fixtureSha256 === "string"
    && preparationCases.size > 0 && !preparationCases.has(outcome.fixtureSha256));
  const transferred = transfer.filter(assessed);
  const curve = rounds.map(round => {
    const ratio = condition => round.pairs.length ? round.pairs.filter(pair => assessed(pair[condition])).length / round.pairs.length : null;
    return { round: round.number, tasksPerArm: round.pairs.length, withMemory: ratio("withMemory"), withoutMemory: ratio("withoutMemory"),
      revision: round.frozen?.revision ?? null };
  });
  return { evaluatedTasks: tasks.length, successfulTasks: successful.length,
    reuse: { kind: report.kind === "memory_lab" ? "source_linked" : "not_measured", tasks: reused.length, rate: successful.length ? reused.length / successful.length : null,
      evidence: "Verified task with prior guide retrieval and an exact guide-step/source link; not an independently proven causal effect." },
    transfer: { attempts: transfer.length, successful: transferred.length, rate: transfer.length ? transferred.length / transfer.length : null,
      evidence: "Recorded applications to a case outside initial preparation; repeated families are not independent families. Failed unlinked applications are not instrumented in old reports." },
    chains: { created: chains.size, used: 0, rate: null, status: "not_measured", evidence: "Transitive principle support and retrieval alone do not establish direct behavioral chain utility." },
    compression: { observations: observations.size, chains: chains.size, principles: principles.size,
      observationsPerPrinciple: principles.size ? observations.size / principles.size : null, semanticQuality: "not_measured" },
    mistakesAvoided: { rate: null, count: null, status: "not_measured" },
    timeToCorrectHypothesis: { medianMs: null, status: "not_measured" },
    capital: knowledgeCapital(report), formation,
    curve, evidenceScope: rounds.length ? "Matched evaluation rounds" : report.kind === "swarm_build" ? "Verified build components; memory delivery is not measured application" : "Guide preparation",
    caseFamilies: report.controlExperiment?.plan?.caseFamilies ?? null };
}

export function knowledgeGraphData(report = {}) {
  const knowledge = report.knowledge ?? {};
  const groups = [["observation", knowledge.observations ?? [], "memoryId", 70, 64], ["chain", knowledge.chains ?? [], "chainId", 340, 32], ["principle", knowledge.principles ?? [], "chainId", 610, 16]];
  const all = new Map(); const nodes = []; let omitted = 0;
  for (const [kind, entries, key, x, limit] of groups) {
    const records = [...new Map(entries.map(entry => [entry[key], entry])).values()];
    for (const record of records) all.set(record[key], { kind, record });
    omitted += Math.max(0, records.length - limit);
    for (const [index, record] of records.slice(0, limit).entries()) nodes.push({ id: record[key], kind, x, y: 48 + (index + 0.5) * 228 / Math.min(limit, records.length),
      label: record.document?.claim ?? record.fragments?.[0]?.text ?? "Source observation", state: record.state ?? "stored", revision: record.revision ?? null });
  }
  const visible = new Set(nodes.map(node => node.id));
  const fragmentOwners = new Map((knowledge.observations ?? []).flatMap(source => (source.fragments ?? []).map(fragment => [fragment.fragmentId, source.memoryId])));
  const edges = []; let missingReferences = 0;
  for (const [id, { record }] of all) if (record.document) {
    const references = [...(record.document.evidence ?? []).map(reference => ({ from: fragmentOwners.get(reference.fragmentId), role: reference.role, fragmentId: reference.fragmentId })),
      ...(record.document.supportedBy ?? []).map(reference => ({ from: reference.chainId, role: "supportedBy", referenceRevision: reference.revision }))];
    for (const reference of references) {
      if (!reference.from || !all.has(reference.from)) { missingReferences += 1; continue; }
      if (visible.has(reference.from) && visible.has(id)) edges.push({ ...reference, to: id });
    }
  }
  const ids = { observation: new Set(), chain: new Set(), principle: new Set() }; const receipts = new Set(); const history = [];
  for (const event of report.events ?? []) if (event.type === "knowledge_written" && ids[event.kind] && !receipts.has(event.memoryId)) {
    receipts.add(event.memoryId); ids[event.kind].add(event.nodeId);
    history.push({ atMs: event.atMs, observations: ids.observation.size, chains: ids.chain.size, principles: ids.principle.size });
  }
  return { nodes, edges, missingReferences, omitted, history };
}

export function normalizeRecording(report) {
  if (!report || typeof report !== "object") return null;
  const control = report.categories?.three_agent_demo;
  const memoryLab = report.kind === "memory_lab";
  const rediscovery = report.kind === "rediscovery_lab";
  const source = report.kind === "swarm_build" || memoryLab || rediscovery ? report : control;
  if (!source || !Array.isArray(source.events) || source.events.length > 20000) throw new Error("Unsupported or oversized recording");
  const agents = report.kind === "swarm_build" || memoryLab || rediscovery ? report.agents : [
    { id: "a", name: "Agent A", title: "Investigation", icon: "search-code" },
    { id: "b", name: "Agent B", title: "Independent Verification", icon: "shield-check" },
    { id: "c", name: "Agent C", title: "Controlled Comparison", icon: "workflow" },
  ];
  if (!Array.isArray(agents) || agents.length < 1 || agents.length > 12) throw new Error("Invalid agent roster");
  const roster = agents.map((agent, index) => ({ id: String(agent.id).slice(0, 40), name: String(agent.name).slice(0, 40),
    title: String(agent.title).slice(0, 80), model: typeof agent.model === "string" ? agent.model : null,
    control: agent.control === true, pairedWith: typeof agent.pairedWith === "string" ? agent.pairedWith : null,
    connectToMemory: agent.connectToMemory !== false,
    color: /^#[a-f0-9]{6}$/i.test(agent.color ?? "") ? agent.color : colors[index % colors.length],
    icon: defaultAgents.find(item => item.id === agent.id)?.icon ?? agent.icon ?? "bot" }));
  const events = source.events.map((event, index) => {
    if (!Number.isFinite(event.atMs) || event.atMs < 0 || typeof event.type !== "string") throw new Error("Invalid event timing");
    return { ...event, id: event.id ?? index + 1, agent: event.agent ?? event.role?.toLowerCase(),
      type: ({ tool: "tool_finished", inference: "inference_finished" })[event.type] ?? event.type };
  }).sort((left, right) => left.atMs - right.atMs || left.id - right.id);
  return { report, source, control: Boolean(control), memoryLab, rediscovery, agents: roster, events,
    durationMs: Math.max(Number.isFinite(report.elapsedMs) ? report.elapsedMs : 0, ...events.map(event => event.atMs), 1),
    expectedTests: control ? (control.trials?.length ?? 1) * 15 : report.finalTests?.expectedTests ?? report.expectedTests ?? report.baselineTests?.expectedTests ?? (memoryLab ? 40 : 18) };
}

export function memoryActivity(recording, position, enabled = true, playbackRate = 1) {
  const idle = { active: false, reading: 0, writing: 0, forming: 0, processing: 0, flows: [], pulses: [] };
  if (!enabled) return idle;
  const excluded = new Set((recording.agents ?? []).filter(agent => agent.control || agent.connectToMemory === false).map(agent => agent.id));
  const pending = new Map(); const processing = new Set(); const pulses = new Map();
  const types = { recall_memory: "read", recall_guide: "read", recall_experience: "read", inspect_source: "read", inspect_knowledge: "read",
    inspect_observation: "read", inspect_experience: "read", inspect_guide_sources: "read", write_memory: "write", record_observation: "write",
    apply_guide: "write", retain_lesson: "form", propose_chain: "form", propose_guide: "form", accept_knowledge: "form",
    capture_observation: "write", propose_principle: "form", accept_chain: "form", accept_principle: "form", challenge_principle: "form", propose_revision: "form" };
  for (const event of recording.events ?? []) {
    if (event.atMs > position) break;
    if (event.type === "run_finished") { pending.clear(); processing.clear(); pulses.clear(); continue; }
    if (event.workload === "memory") {
      const id = event.requestId ?? `${event.sessionId}:${event.turn}`;
      if (event.type === "inference_started") processing.add(id);
      if (event.type === "inference_finished") processing.delete(id);
    }
    if (excluded.has(event.agent)) continue;
    if (event.type === "tool_started" && types[event.tool]) pending.set(event.toolCallId, { id: event.toolCallId, agent: event.agent, kind: types[event.tool], sessionId: event.sessionId });
    if (event.type === "tool_finished") pending.delete(event.toolCallId);
    if (event.type === "session_stopped" && event.sessionId) for (const [id, flow] of pending) if (flow.sessionId === event.sessionId) pending.delete(id);
    if (event.type === "agent_state" && ["passed", "failed", "cancelled", "blocked"].includes(event.state)) for (const [id, flow] of pending) if (flow.agent === event.agent) pending.delete(id);
    if (position - event.atMs < 2200 * Math.max(1, playbackRate) && ["memory_saved", "knowledge_written", "memory_delivered", "experience_access"].includes(event.type)) {
      const kind = event.type === "memory_delivered" || event.type === "experience_access" ? "read" : event.kind ?? "observation";
      const id = event.memoryId ?? event.chainId ?? `${event.type}:${event.id ?? event.atMs}`;
      const previous = pulses.get(id);
      pulses.set(id, { id, agent: event.agent ?? previous?.agent, kind: event.type === "memory_saved" ? previous?.kind ?? kind : kind,
        nodeId: event.nodeId ?? event.chainId ?? previous?.nodeId ?? event.memoryId, atMs: event.atMs });
    }
  }
  const flows = [...pending.values()].slice(-12); const recent = [...pulses.values()].slice(-12);
  return { active: Boolean(flows.length || processing.size || recent.length), reading: flows.filter(flow => flow.kind === "read").length,
    writing: flows.filter(flow => flow.kind === "write").length, forming: flows.filter(flow => flow.kind === "form").length,
    processing: processing.size, flows, pulses: recent };
}

export function replayState(recording, position) {
  const state = { inputTokens: 0, outputTokens: 0, unknownInput: false, unknownOutput: false, toolCalls: 0, checks: 0,
    memoryInputTokens: 0, memoryOutputTokens: 0, unknownMemoryInput: false, unknownMemoryOutput: false, memoryInferences: new Set(), memoryCalls: 0,
    storageOperations: [], observationIds: new Set(), chainIds: new Set(), principleIds: new Set(), persistenceChecks: [],
    guideApplications: [], inspectedObservations: new Set(),
    memories: new Set(), handoffs: new Set(), transfers: [], lastTransfer: null, visibleEvents: [], applicationReady: false, controlApplicationReady: false,
    agents: Object.fromEntries(recording.agents.map(agent => [agent.id, { state: "queued", inputTokens: 0, outputTokens: 0,
      storedMemories: new Set(), receivedHandoffs: new Set(), pendingTools: new Set(), linkedUses: new Set(), useMeasured: false, action: "Waiting", inference: null, unknown: false }])) };
  const memoryExcluded = new Set(recording.agents.filter(agent => agent.control || agent.connectToMemory === false).map(agent => agent.id));
  const tests = new Map();
  const usage = new Set();
  let finalTests = null;
  for (const event of recording.events) {
    if (event.atMs > position) break;
    state.visibleEvents.push(event);
    const agent = state.agents[event.agent];
    if (event.type === "agent_state" && agent) {
      agent.state = event.state;
      if (["passed", "failed", "cancelled", "blocked"].includes(event.state)) { agent.inference = null; agent.pendingTools.clear(); }
    }
    if (event.type === "stage_started" && agent) agent.state = "running";
    if (event.type === "stage_finished" && agent) agent.state = event.success ? "passed" : "failed";
    if (event.type === "rediscovery_task_started" && agent) { agent.state = "running"; agent.action = "Investigating"; }
    if (event.type === "rediscovery_task_finished" && agent) { agent.state = event.correct ? "passed" : "failed"; agent.inference = null; }
    if (event.type === "inference_started" && agent) { agent.inference = event.atMs; agent.action = "Generating"; }
    if (event.type === "inference_started" && event.workload === "memory") state.memoryInferences.add(event.requestId ?? event.turn);
    if (event.type === "inference_finished") {
      const key = `${event.workload ?? "agent"}:${event.sessionId ?? `${event.trial}:${event.agent}:${event.condition}`}:${event.requestId ?? event.turn}`;
      if (!usage.has(key)) {
        usage.add(key);
        const memory = event.workload === "memory";
        if (memory) { state.memoryCalls += 1; state.memoryInferences.delete(event.requestId ?? event.turn); }
        for (const field of ["inputTokens", "outputTokens"]) {
          const target = memory ? field === "inputTokens" ? "memoryInputTokens" : "memoryOutputTokens" : field;
          const unknown = memory ? field === "inputTokens" ? "unknownMemoryInput" : "unknownMemoryOutput" : field === "inputTokens" ? "unknownInput" : "unknownOutput";
          if (Number.isSafeInteger(event[field]) && event[field] >= 0) { state[target] += event[field]; if (agent && !memory) agent[field] += event[field]; }
          else { state[unknown] = true; if (agent && !memory) agent.unknown = true; }
        }
      }
      if (agent) { agent.inference = null; agent.action = event.errorCode ? "Provider error" : "Response received"; }
    }
    if (event.type === "tool_started" && agent) { agent.action = event.tool.replaceAll("_", " "); agent.pendingTools.add(event.toolCallId); }
    if (event.type === "tool_finished") {
      state.toolCalls += 1;
      if (agent) { agent.action = event.fixturePath ?? event.tool?.replaceAll("_", " ") ?? "Tool complete"; agent.pendingTools.delete(event.toolCallId); }
      if (event.tool === "write_memory" && event.ok && event.memoryId) state.memories.add(event.memoryId);
    }
    if (event.type === "memory_saved" && event.memoryId) { state.memories.add(event.memoryId); agent?.storedMemories.add(event.memoryId); }
    if (event.type === "rediscovery_task_finished" && agent && event.phaseScope === "evaluation") {
      agent.useMeasured = true;
      if (event.correct && event.reuseObserved) agent.linkedUses.add(event.caseId);
    }
    if (event.type === "knowledge_written") {
      state.storageOperations.push(event);
      if (event.kind === "observation") state.observationIds.add(event.nodeId);
      if (event.kind === "chain") state.chainIds.add(event.nodeId);
      if (event.kind === "principle") state.principleIds.add(event.nodeId);
    }
    if (event.type === "persistence_verified") state.persistenceChecks.push(event);
    if (event.type === "guide_applied") state.guideApplications.push(event);
    if (["assessment_finished", "control_arm_finished"].includes(event.type) && agent && !memoryExcluded.has(event.agent)) {
      agent.useMeasured = event.type === "assessment_finished" || typeof event.sourceEvidenceVerified === "boolean";
      if (recordedGuideUse(event, state.guideApplications)) agent.linkedUses.add(`${event.type}:${event.round ?? 0}:${event.caseId}`);
    }
    if (event.type === "observation_inspected") state.inspectedObservations.add(`${event.agent}:${event.memoryId}`);
    if (event.type === "memory_delivered" && !memoryExcluded.has(event.agent) && !memoryExcluded.has(event.from)) {
      const key = `${event.from}:${event.agent}`;
      if (event.from && event.from !== "brief" && event.from !== event.agent) { state.handoffs.add(key); agent?.receivedHandoffs.add(event.from); }
      state.lastTransfer = event;
      if (position - event.atMs < 2300) state.transfers.push(event);
    }
    if (event.type === "memory_delivery") for (const [field, from] of [["agentA", "a"], ["agentB", "b"]]) {
      if (event[field]) state.handoffs.add(`${from}:${event.agent}:${event.condition}`);
    }
    if (event.type === "tests" && !["baseline", "preparation"].includes(event.phase)) {
      if (event.agent === "system" && event.phase === "final") finalTests = event.passedTests;
      else tests.set(`${event.round ?? event.trial ?? 0}:${event.agent}:${event.condition ?? ""}`, event.passedTests ?? 0);
    }
    if (event.type === "application_ready") state.applicationReady = true;
    if (event.type === "control_application_ready") state.controlApplicationReady = true;
    if (event.type === "run_finished") for (const actor of Object.values(state.agents)) { actor.inference = null; actor.pendingTools.clear(); }
  }
  state.checks = finalTests ?? [...tests.values()].reduce((total, count) => total + count, 0);
  return state;
}

export function runActivity(recording, position, state = replayState(recording, position)) {
  const firstWrites = new Map(); const latestWrites = new Map(); const tasks = new Map(); const reused = new Set();
  const pending = new Map();
  for (const event of recording.events) {
    const nodeId = event.type === "knowledge_written" ? event.nodeId : event.type === "memory_saved" && (!event.kind || event.kind === "observation") ? event.memoryId : null;
    if (nodeId && !firstWrites.has(nodeId)) firstWrites.set(nodeId, event.atMs);
    if (event.atMs > position) continue;
    if (nodeId) latestWrites.set(nodeId, event);
    if (event.type === "tool_started") pending.set(event.toolCallId, event);
    if (event.type === "tool_finished") pending.delete(event.toolCallId);
    if (event.type === "agent_state" && ["passed", "failed", "cancelled", "blocked"].includes(event.state)) {
      for (const [id, tool] of pending) if (tool.agent === event.agent) pending.delete(id);
    }
    if (event.type === "run_finished") pending.clear();
    if (event.type === "rediscovery_task_finished") {
      tasks.set(event.caseId, Boolean(event.correct));
      if (event.agent === "mindleak" && event.correct && event.reuseObserved && !event.diagnostic) reused.add(event.caseId);
    }
    if (event.type === "assessment_finished") tasks.set(`preparation:${event.agent}:${event.caseId}`, Boolean(event.passed));
    if (event.type === "control_arm_finished") tasks.set(`control:${event.round}:${event.caseId}:${event.condition}`, Boolean(event.passed));
    if (recording.report.kind === "swarm_build" && event.type === "agent_state" && ["passed", "failed"].includes(event.state)) tasks.set(event.agent, event.state === "passed");
  }
  const stored = recording.report.knowledge ?? {};
  const knowledge = { ...stored };
  const gained = {}; const inherited = {};
  for (const [kind, key] of [["observations", "memoryId"], ["chains", "chainId"], ["principles", "chainId"]]) {
    const baseline = new Map((recording.report.knowledgeBaseline?.[kind] ?? []).map(record => [record.id, record]));
    const source = stored[kind] ?? (kind === "observations" ? recording.report.memoryExhibits?.filter(record => !record.kind || record.kind === "observation") : []) ?? [];
    const unique = [...new Map(source.map(record => [record[key], record])).values()];
    knowledge[kind] = unique.filter(record => baseline.has(record[key]) || !firstWrites.has(record[key]) || firstWrites.get(record[key]) <= position).map(record => {
      const latest = latestWrites.get(record[key]);
      const evidence = latest ?? baseline.get(record[key]);
      return evidence ? { ...record, ...(evidence.state ? { state: evidence.state } : {}), ...(evidence.revision ? { revision: evidence.revision } : {}) } : record;
    });
    gained[kind] = knowledge[kind].filter(record => firstWrites.has(record[key]) && !baseline.has(record[key])).length;
    inherited[kind] = knowledge[kind].length - gained[kind];
  }
  const expectedTests = Math.max(recording.expectedTests ?? 0,
    (recording.events.find(event => event.type === "run_started")?.expectedTests ?? 0) + (recording.events.find(event => event.type === "control_started")?.expectedTests ?? 0));
  const scheduledTasks = recording.rediscovery ? (recording.report.plan?.preparationTasks ?? 0) + (recording.report.plan?.sessions?.length ?? 0)
    : recording.memoryLab ? expectedTests > 0 && expectedTests % 7 === 0 ? expectedTests / 7 : null : recording.agents.length;
  const memory = memoryActivity(recording, position);
  const finished = state.visibleEvents.at(-1)?.type === "run_finished";
  const active = finished ? [] : recording.agents.filter(agent => state.agents[agent.id]?.state === "running");
  const phase = finished ? "finished" : memory.forming ? "forming" : memory.writing ? "capturing" : memory.reading ? "retrieving"
    : memory.processing ? "extracting" : pending.size ? "working" : active.length ? "thinking" : "ready";
  return { knowledge, gained, inherited, actions: state.toolCalls, completedTasks: tasks.size,
    successfulTasks: [...tasks.values()].filter(Boolean).length, scheduledTasks, reusedTasks: reused.size,
    acceptedPrinciples: knowledge.principles.filter(record => record.state === "accepted").length,
    phase, activeAgents: active, currentTools: [...pending.values()], memory,
    milestones: state.visibleEvents.filter(event => event.type === "knowledge_written" || event.type === "persistence_verified"
      || event.type === "rediscovery_task_finished" || event.type === "control_arm_finished" || event.type === "assessment_finished" || event.type === "candidate_changed"
      || event.type === "collaboration_checked" || event.type === "tool_finished").slice(-6).reverse() };
}

export function lab3Story(recording, position) {
  if (recording?.report?.kind !== "rediscovery_lab") return null;
  const report = recording.report;
  const cases = new Map(); const sessions = new Map();
  const titles = { "retry-identity": "The duplicate delivery", "lease-expiry": "The disappearing lease", "page-stream": "The missing page",
    "batch-correlation": "The mixed-up results", "path-boundary": "The escaped path", "continuation-contract": "The missing records" };
  for (const session of report.plan?.sessions ?? []) {
    const id = session.matchId ?? session.caseId ?? session.id;
    if (!cases.has(id)) cases.set(id, { id, title: titles[session.family] ?? session.family ?? session.caseId ?? "Investigation",
      stage: session.stage, label: session.caseId ?? session.family ?? id, arms: [], firstAt: null, lastAt: null });
    const actor = { id: session.id, arm: session.arm, diagnostic: session.diagnostic === true || session.arm === "direct", state: "queued", reused: false, retrieval: "not_used", atMs: null };
    cases.get(id).arms.push(actor); sessions.set(session.id, { actor, item: cases.get(id) });
  }
  const chapters = [
    { id: "discover", label: "Discover", icon: "scan-search" }, { id: "form", label: "Connect", icon: "git-branch" },
    { id: "validate", label: "Test the rule", icon: "flask-conical" }, { id: "transfer", label: "New cases", icon: "route" },
    { id: "review", label: "Learn again", icon: "lightbulb" },
  ].map(chapter => ({ ...chapter, atMs: null }));
  let phase = "discover"; let currentCase = null; let prediction = null; let nextMoment = null;
  for (const event of recording.events ?? []) {
    const step = event.type === "run_started" ? "discover"
      : event.type === "stage_started" ? ({ formation: "form", acceptance: "form", validation: "validate", review: "review" })[event.phase]
        : event.type === "rediscovery_review_started" ? event.round === 0 ? "form" : "review"
          : event.type === "rediscovery_round_started" ? "transfer"
            : event.type === "rediscovery_task_started" ? event.phaseScope === "preparation" ? "discover" : "transfer"
              : event.type === "knowledge_written" && ["chain", "principle"].includes(event.kind) && event.operation === "propose" ? "form" : null;
    if (step) {
      const chapter = chapters.find(item => item.id === step);
      if (chapter.atMs === null) chapter.atMs = event.atMs;
    }
    const moment = ["validation_completed", "validation_failed", "rediscovery_task_finished", "rediscovery_round_started", "exception_checked"].includes(event.type)
      || event.type === "knowledge_written" && event.kind === "principle";
    if (event.atMs > position) { if (moment && nextMoment === null) nextMoment = event.atMs; continue; }
    if (step) phase = step;
    const match = sessions.get(event.caseId);
    if (match && ["rediscovery_task_started", "rediscovery_task_finished"].includes(event.type)) {
      currentCase = match.item.id; match.item.firstAt ??= event.atMs; match.item.lastAt = event.atMs;
      match.actor.state = event.type.endsWith("started") ? "working" : event.correct === true ? "passed" : "unresolved";
      match.actor.reused = event.reuseObserved === true; match.actor.atMs = event.atMs;
      if (event.priorKnowledgeDelivered && match.actor.retrieval !== "received") match.actor.retrieval = "received";
    }
    if (match && event.type === "experience_access") match.actor.retrieval = event.lessonIds?.length ? "received" : match.actor.retrieval === "received" ? "received" : "miss";
    if (["prospective_prediction", "prediction_recorded"].includes(event.type)) prediction = { caseId: event.caseId, arm: event.agent ?? "mindleak",
      expectedPass: event.expectedPass, applicable: event.applicable, verdict: null, actualPass: null, atMs: event.atMs };
    if (prediction && event.caseId === prediction.caseId && (event.agent ?? "mindleak") === prediction.arm
      && ["validation_completed", "validation_failed"].includes(event.type)) {
      prediction.verdict = event.type === "validation_failed" ? "execution_failed" : event.correct ? "matched" : "mismatch";
      prediction.actualPass = event.type === "validation_completed" ? event.passed : null;
    }
    if (event.type === "run_finished") phase = "finished";
  }
  return { phase, chapters, cases: [...cases.values()], currentCase, prediction, nextMoment };
}

export function knowledgeFocus(knowledge = {}, selectedId = null) {
  const nodes = [...(knowledge.principles ?? []), ...(knowledge.chains ?? [])];
  const choices = [...(knowledge.principles?.length ? knowledge.principles : knowledge.chains ?? [])].map(node => ({ id: node.chainId, claim: node.document?.claim ?? "Recorded knowledge" }));
  const selected = nodes.find(node => node.chainId === selectedId) ?? nodes.find(node => node.chainId === choices.at(-1)?.id);
  if (!selected) return { selected: null, choices, supports: [], sources: [], counterexamples: [], unavailableEvidence: 0 };
  if (!choices.some(choice => choice.id === selected.chainId)) choices.unshift({ id: selected.chainId, claim: selected.document?.claim ?? "Recorded knowledge" });
  const owners = new Map((knowledge.observations ?? []).flatMap(source => (source.fragments ?? []).map(fragment => [fragment.fragmentId, { source, fragment }])));
  const chainMap = new Map((knowledge.chains ?? []).map(node => [node.chainId, node]));
  const references = [...selected.document?.evidence ?? []];
  const supports = (selected.document?.supportedBy ?? []).map(reference => {
    const chain = chainMap.get(reference.chainId); const available = Boolean(chain && chain.revision === reference.revision);
    if (available) references.push(...chain.document?.evidence ?? []);
    return { id: reference.chainId, revision: reference.revision, currentRevision: chain?.revision ?? null, available,
      claim: available ? chain.document?.claim : "Supporting revision unavailable", conclusion: available ? chain.document?.conclusion : null };
  });
  const sourceIds = new Set(); const sources = []; const missing = new Set(); const counters = new Map();
  for (const reference of references) {
    const owner = owners.get(reference.fragmentId);
    if (!owner) missing.add(reference.fragmentId);
    else if (!sourceIds.has(owner.source.memoryId)) {
      sourceIds.add(owner.source.memoryId); sources.push({ id: owner.source.memoryId, label: owner.source.source ?? owner.source.caseId ?? owner.fragment.text, text: owner.fragment.text });
    }
    if (reference.role === "counterexample") {
      const counter = counters.get(reference.fragmentId) ?? { fragmentId: reference.fragmentId, memoryId: owner?.source.memoryId ?? null, reasons: [] };
      if (!counter.reasons.includes(reference.reason)) counter.reasons.push(reference.reason);
      counters.set(reference.fragmentId, counter);
    }
  }
  return { selected: { id: selected.chainId, kind: selected.document?.kind ?? "chain", state: selected.state, review: selected.review,
    revision: selected.revision, requiresReview: selected.requiresReview, claim: selected.document?.claim, conclusion: selected.document?.conclusion,
    applicability: selected.document?.applicability, assumptions: selected.document?.assumptions ?? [] }, choices, supports, sources,
    counterexamples: [...counters.values()], unavailableEvidence: missing.size + supports.filter(support => !support.available).length };
}

export function knowledgeReviewQueue(knowledge = {}, decisions = []) {
  const records = [...new Map([...(knowledge.principles ?? []), ...(knowledge.chains ?? [])].map(node => [node.chainId, node])).values()];
  const chains = new Map((knowledge.chains ?? []).map(node => [node.chainId, node]));
  const sources = new Map((knowledge.observations ?? []).map(node => [node.memoryId, node]));
  const validDecisions = (Array.isArray(decisions) ? decisions : []).filter(decision => decision && typeof decision.id === "string"
    && typeof decision.reviewer === "string" && decision.reviewer.trim().length > 0 && decision.reviewer.length <= 100
    && typeof decision.note === "string" && decision.note.trim().length > 0 && decision.note.length <= 2000
    && Number.isFinite(Date.parse(decision.reviewedAt)) && ["approve", "request_revision", "defer"].includes(decision.decision)
    && (decision.decision !== "approve" || decision.evidenceReviewed === true));
  const statuses = { approve: "approved", request_revision: "revision_requested", defer: "deferred" };
  const items = records.map(record => {
    const focus = knowledgeFocus(knowledge, record.chainId);
    const supports = focus.supports.map(reference => chains.get(reference.id) ?? null);
    const snapshot = JSON.stringify({ record, supports, sources: focus.sources.map(source => sources.get(source.id)) });
    const blockedReasons = [];
    if (!Number.isSafeInteger(record.revision) || record.revision < 1) blockedReasons.push("Recorded revision unavailable");
    if (!["candidate", "accepted"].includes(record.state)) blockedReasons.push("Record is not a current candidate or accepted revision");
    if (!record.document?.claim || !record.document?.conclusion) blockedReasons.push("Claim or conclusion unavailable");
    if (record.requiresReview || record.review?.requiresReview) blockedReasons.push("Recorded evidence requires revision");
    if (focus.unavailableEvidence) blockedReasons.push(`${focus.unavailableEvidence} evidence references unavailable`);
    if (!focus.sources.length) blockedReasons.push("Source observations unavailable");
    if (record.document?.kind === "principle" && new Set(focus.supports.map(reference => reference.id)).size < 2) blockedReasons.push("Fewer than two supporting chains");
    if (supports.some(support => support?.state !== "accepted" || support.requiresReview || support.review?.requiresReview)) blockedReasons.push("Supporting chain is not accepted or needs review");
    const history = validDecisions.filter(decision => decision.chainId === record.chainId);
    const decision = history.findLast(entry => entry.revision === record.revision && entry.snapshot === snapshot);
    const status = decision && !(decision.decision === "approve" && blockedReasons.length) ? statuses[decision.decision] : "pending";
    return { id: record.chainId, revision: record.revision, kind: record.document?.kind ?? "chain", claim: record.document?.claim ?? "Untitled knowledge",
      agentState: record.state, status, decision: decision ?? null, history, snapshot, blockedReasons, staleReview: history.length > 0 && !decision,
      sourceCount: focus.sources.length, supportCount: focus.supports.length, counterexampleCount: focus.counterexamples.length };
  });
  const priority = item => item.status === "pending" && item.blockedReasons.length ? 0 : ({ revision_requested: 1, pending: 2, deferred: 3, approved: 4 })[item.status];
  items.sort((left, right) => priority(left) - priority(right) || (left.kind === "principle" ? 0 : 1) - (right.kind === "principle" ? 0 : 1) || left.claim.localeCompare(right.claim));
  const counts = { pending: 0, approved: 0, revisionRequested: 0, deferred: 0 };
  for (const item of items) counts[item.status === "revision_requested" ? "revisionRequested" : item.status] += 1;
  return { items, counts };
}

export function formatElapsed(milliseconds) {
  const tenths = Math.max(0, Math.floor(milliseconds / 100));
  return `${String(Math.floor(tenths / 600)).padStart(2, "0")}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

export function sandboxApplicationPage(html) {
  if (typeof html !== "string" || html.length > 2 * 1024 * 1024) throw new Error("invalid_application_preview");
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src data:; style-src data: &#39;unsafe-inline&#39;; img-src data:; font-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session Desk</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src data:; frame-src data:; style-src data: 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head><body><iframe title="Agent-built application" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="data:text/html;charset=utf-8,${encodeURIComponent(policy + html)}"></iframe></body></html>`;
}

function initializeReplay() {
  const initial = JSON.parse(document.getElementById("demo-data").textContent);
  const apiBase = initial.basePath ?? "";
  let profiles = initial.profiles;
  let draft = structuredClone(profiles?.defaults ?? { agentModels: {}, memoryModel: "off", concurrency: 2, attempts: 2 });
  let runActive = false;
  const byId = id => document.getElementById(id);
  const icons = () => window.lucide?.createIcons({ attrs: { "stroke-width": 1.6 } });
  const element = (tag, className, text) => { const value = document.createElement(tag); if (className) value.className = className; if (text !== undefined) value.textContent = text; return value; };
  const count = value => Number.isFinite(value) ? new Intl.NumberFormat("en-US", value >= 10000000 ? { notation: "compact", maximumFractionDigits: 2 } : {}).format(value) : "--";
  let recording = null;
  let position = 0;
  let playing = false;
  let following = Boolean(initial.live);
  let frameTime = performance.now();
  let lastEventCount = -1;
  let lastFilter = "";
  let artifactShown = false;
  let artifactTeam = "memory";
  let selectedId = null;
  let toastTimer;
  let followEvents = true;
  let updatingEvents = false;
  let memoryBoardKey = "";
  const agentElements = new Map();
  const laneElements = new Map();
  const paths = new Map();
  let knowledgeKey = "";
  let outcomeKey = "";
  let completionKey = "";
  let studyKey = "";
  let continueLearning = false;
  let activityKey = "";
  let stageFeedKey = "";
  let activityProjection = null;
  let lastRenderAt = 0;
  let timelineKey = "";
  let networkLayoutKey = "";
  let lab3StoryKey = "";
  let lab3NextMoment = null;
  const stageAgents = new Map();
  const knowledgeMilestones = new Map([...document.querySelectorAll(".stage-milestone")].map(badge => [badge.dataset.stage, [...badge.childNodes].map(node => node.cloneNode(true))]));
  let displayedGraphIds = new Set();
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let inspectedNodeId = null;
  let focusedKnowledgeId = null;
  let knowledgeInspector = null;
  let replayKnowledgeAt = null;
  let humanReviews = [];
  let reviewFilter = "pending";
  let currentReviewItem = null;
  let reviewStorageError = null;
  let pendingReview = null;
  const icon = name => { const value = element("i"); value.dataset.lucide = name; return value; };
  const notify = message => { byId("toast").textContent = message; byId("toast").classList.remove("hidden"); clearTimeout(toastTimer); toastTimer = setTimeout(() => byId("toast").classList.add("hidden"), 4500); };
  const save = (text, name, type) => { const url = URL.createObjectURL(new Blob([text], { type })); const link = element("a"); link.href = url; link.download = name; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); };
  const nameFor = id => recording?.agents.find(agent => agent.id === id)?.name ?? (id?.startsWith("orion-round-") ? "Orion / Review" : id === "brief" ? "Project brief" : id === "memory" ? "MindLeak" : "Runner");
  const modelName = id => profiles?.agents.find(model => model.id === id)?.name ?? ({ "gpt-6-astra": "GPT-6 Astra", "claude-opus-5": "Claude Opus 5", "mai-code-1.1-flash": "MAI-Code 1.1 Flash", "glm-4.7-flash:latest": "GLM 4.7 Flash", off: "Model-free" })[id] ?? id ?? "Not recorded";
  const currentApplication = () => recording?.report[artifactTeam === "daleks" ? "controlApplication" : "application"];
  byId("experiment-page").insertBefore(byId("cost-panel"), document.querySelector("#experiment-page .foot"));
  byId("cost-panel").append(byId("control-costs"));
  byId("cost-panel").append(byId("rediscovery-costs"));
  byId("cost-panel").append(byId("comparisons"));
  document.querySelector(".mission-controls").append(byId("rediscovery-profile-control"));
  document.querySelector(".mission-controls").append(byId("study-template").content.cloneNode(true));
  byId("knowledge-outcomes").append(byId("study-progress"));
  byId("cost-panel").append(byId("study-cost-summary"));
  const networkSection = document.querySelector('section[aria-label="Live agent network"]');
  networkSection.insertBefore(byId("activity-template").content.cloneNode(true), networkSection.querySelector(".network-scroll"));
  const networkActions = element("div", "network-heading-actions");
  networkActions.append(byId("network-meta"), byId("replay-activity")); networkSection.querySelector(".section-head").append(networkActions);
  const knowledgeHero = document.querySelector(".knowledge-hero");
  const knowledgeActions = element("div", "network-heading-actions");
  knowledgeActions.append(byId("knowledge-hero-status")); knowledgeHero.querySelector(".section-head").append(knowledgeActions);
  const playback = document.querySelector(".playback");
  byId("stage-graph").append(knowledgeHero);
  byId("stage-activity").append(byId("memory-activity"));
  byId("stage-playback").append(playback);
  byId("stage-controls").prepend(byId("replay-activity"));
  byId("stage-run-controls").append(document.querySelector(".study-mode"), byId("rediscovery-profile-control"));
  byId("stage-run-controls").classList.toggle("hidden", !initial.live);
  byId("stage-run-controls").after(byId("lab3-story-template").content.cloneNode(true));
  document.querySelector(".knowledge-heading h1").textContent = "Knowledge Control";
  byId("knowledge-focus").querySelector("h2").textContent = "Principle playbook";
  byId("review-document").prepend(byId("knowledge-focus"));
  const originalRecords = document.querySelector(".knowledge-lower");
  byId("review-guide-export").append(byId("guide-document").parentElement);
  byId("review-raw-slot").append(byId("knowledge-inspector").parentElement);
  originalRecords.remove();
  for (const id of ["capital-panel", "knowledge-capital-panel"]) byId(id).append(byId("capital-template").content.cloneNode(true));
  byId("knowledge-outcomes").prepend(byId("investigation-template").content.cloneNode(true));
  byId("outcome-scope").parentElement.after(byId("knowledge-use-summary"));
  document.querySelector(".verification-panel").after(byId("build-sharing-summary"));
  const reuseResults = element("section"); reuseResults.id = "knowledge-reuse-results";
  const reuseHeading = byId("outcome-scope").parentElement; reuseHeading.before(reuseResults);
  reuseResults.append(reuseHeading, byId("knowledge-use-summary"), byId("reuse-rate").closest(".outcome-meters"), byId("knowledge-curve").closest(".learning-chart"));
  const options = (select, models, value) => {
    select.replaceChildren();
    for (const model of models) { const choice = element("option", "", model.name ?? model.id); choice.value = model.id; choice.disabled = model.available === false; select.append(choice); }
    select.value = value;
  };
  function configureProfiles(next) {
    if (next) profiles = next;
    if (!profiles) {
      byId("mission").classList.add("hidden");
      for (const view of agentElements.values()) view.select.hidden = true;
      return;
    }
    if (!Object.keys(draft.agentModels).length) draft = structuredClone(profiles.defaults);
    byId("mission").classList.remove("hidden");
    byId("problem-input").value = draft.problem ?? "";
    byId("concurrency-input").value = String(draft.concurrency);
    byId("attempts-input").value = String(draft.attempts);
    byId("rounds-input").value = String(draft.rounds ?? 2);
    byId("rounds-choice").classList.toggle("hidden", profiles.experiment !== 2);
    options(byId("memory-model-select"), profiles.memory, draft.memoryModel);
    byId("memory-model-status").textContent = `Next run: ${modelName(draft.memoryModel)}`;
    for (const [id, view] of agentElements) {
      options(view.select, profiles.agents, draft.agentModels[view.pairedWith ?? id]);
      view.select.hidden = !initial.live || view.control;
      view.select.disabled = runActive || !initial.live || view.control;
    }
    for (const id of ["problem-input", "concurrency-input", "attempts-input", "rounds-input", "memory-model-select"]) byId(id).disabled = runActive || !initial.live;
    byId("concurrency-input").max = profiles.experiment === 2 ? "1" : "5";
    if (profiles.experiment === 2) byId("concurrency-input").disabled = true;
    byId("concurrency-input").parentElement.firstChild.textContent = profiles.experiment === 2 ? "PREPARATION CONCURRENCY" : "CONCURRENT AGENTS";
    byId("problem-input").parentElement.firstChild.textContent = profiles.experiment === 2 ? "EXPERIMENT BRIEF" : "BUILD BRIEF";
    byId("attempts-input").parentElement.firstChild.textContent = profiles.experiment === 2 ? "ATTEMPTS PER PHASE" : "ATTEMPTS PER AGENT";
    if (profiles.experiment !== 2) byId("concurrency-input").parentElement.firstChild.textContent = "CONCURRENT PER TEAM";
    byId("rediscovery-profile-control").classList.toggle("hidden", profiles.experiment !== 3);
    byId("rediscovery-profile-select").value = draft.rediscoveryProfile ?? "learning";
    byId("rediscovery-profile-select").disabled = runActive || !initial.live;
    if (profiles.experiment === 3) {
      byId("problem-input").disabled = true; byId("concurrency-input").disabled = true; byId("attempts-input").disabled = true;
      byId("concurrency-input").parentElement.firstChild.textContent = "SERIAL MATCHED SCHEDULE";
      byId("attempts-input").parentElement.firstChild.textContent = "FRESH SESSION ATTEMPTS";
      byId("problem-input").parentElement.firstChild.textContent = "FROZEN EXPERIMENT";
      for (const [id, view] of agentElements) view.select.hidden = id !== "mindleak" || !initial.live;
    }
    if (!recording) byId("slm-model").textContent = modelName(draft.memoryModel);
    configureStudyMode();
  }
  function configureStudyMode() {
    const report = recording?.report;
    const investigation = ["mechanism", "quality"].includes(report?.plan?.profile) || ["mechanism", "quality"].includes(draft.rediscoveryProfile);
    const available = !investigation && report?.status === "completed" && (report.kind === "swarm_build" ? report.memoryExhibits?.length > 0
      : report.kind === "memory_lab" ? Boolean(report.guide) : report.knowledge?.lessons?.length > 0);
    if (!available && !runActive) continueLearning = false;
    byId("study-fresh").disabled = runActive || !initial.live;
    byId("study-continue").disabled = runActive || !initial.live || !available;
    byId("study-fresh").checked = !continueLearning;
    byId("study-continue").checked = continueLearning;
    byId("study-continue").title = investigation ? "Investigation studies require fresh validation cases" : available ? `Retain experience from run ${report.runId}; start fresh agent sessions and source workspaces` : "A completed run with retained experience is required";
    if (continueLearning) byId("run").querySelector("span").textContent = "Continue learning";
    else byId("run").querySelector("span").textContent = recording?.memoryLab || recording?.rediscovery || profiles?.experiment >= 2 ? "Run experiment" : "Run build";
  }
  function navigateView() {
    const lab = recording?.rediscovery || profiles?.experiment === 3 ? 3 : recording?.memoryLab || profiles?.experiment === 2 ? 2 : 1;
    const learning = location.hash === "#learnings" || !location.hash && location.pathname.endsWith("/learnings");
    const enteringReview = learning && byId("knowledge-page").classList.contains("hidden");
    if (enteringReview && recording && !runActive && recording.report.status !== "recording") { following = false; playing = false; position = recording.durationMs; }
    byId("experiment-page").classList.toggle("hidden", learning);
    byId("knowledge-page").classList.toggle("hidden", !learning);
    byId("knowledge-outcomes").before(byId("live-stage"));
    byId(learning ? "machine-lineage" : "stage-graph").append(knowledgeHero);
    byId(learning ? "machine-activity" : "stage-activity").append(byId("memory-activity"));
    byId(learning ? "machine-playback" : "stage-playback").append(playback);
    if (learning) {
      byId("machine-controls").append(byId("stage-controls"));
      byId("machine-run-controls").append(byId("stage-run-controls"));
    } else {
      byId("live-stage").querySelector(".stage-footer").append(byId("stage-controls"));
      byId("live-stage").querySelector(".stage-heading").after(byId("stage-run-controls"));
    }
    activityKey = "";
    byId("lab-brand").textContent = `LEARNING LAB / 0${lab}`;
    for (const [id, number] of [["nav-lab1", 1], ["nav-lab2", 2], ["nav-lab3", 3]]) {
      const link = byId(id);
      let target = number === lab ? "#recording" : (initial.navigation ?? profiles?.navigation)?.[`lab${number}`];
      try { if (target && !target.startsWith("#")) { const address = new URL(target, location.href); if (!["http:", "https:"].includes(address.protocol) || address.username || address.password) target = null; } } catch { target = null; }
      if (target) link.href = target; else link.removeAttribute("href");
      link.setAttribute("aria-disabled", String(!target));
      if (number === lab && !learning) link.setAttribute("aria-current", "page"); else link.removeAttribute("aria-current");
    }
    const labTwo = (initial.navigation ?? profiles?.navigation)?.lab2;
    byId("nav-learnings").href = lab === 1 && labTwo ? `${labTwo.replace(/\/$/, "")}/learnings` : "#learnings";
    if (learning) byId("nav-learnings").setAttribute("aria-current", "page"); else byId("nav-learnings").removeAttribute("aria-current");
    if (recording) render(true); else renderKnowledge();
  }
  function renderKnowledge() {
    const knowledge = activityProjection?.knowledge ?? recording?.report.knowledge ?? {};
    const observations = knowledge.observations ?? [];
    const chains = knowledge.chains ?? [];
    const principles = knowledge.principles ?? [];
    const operations = knowledge.operations ?? [];
    const durability = knowledge.durability ?? [];
    const applications = knowledge.applications ?? [];
    const guide = recording?.report.guide ?? knowledge.guide;
    const lastOutcome = recording?.events.findLast(event => ["rediscovery_task_finished", "rediscovery_round_finished", "control_arm_finished", "run_finished"].includes(event.type))?.id;
    const key = JSON.stringify([recording?.report.runId, focusedKnowledgeId, humanReviews.length, reviewFilter, byId("review-search").value, byId("knowledge-page").classList.contains("hidden"), operations.length, observations.length, [...chains, ...principles].map(node => [node.chainId, node.revision, node.state, node.requiresReview]), durability.length, applications.length, guide?.revision, lastOutcome]);
    if (key === knowledgeKey) return;
    knowledgeKey = key;
    const all = new Map([...observations.map(node => [node.memoryId, { ...node, kind: "observation" }]), ...[...chains, ...principles].map(node => [node.chainId, { ...node, kind: node.document.kind }])]);
    const fragmentOwners = new Map(observations.flatMap(node => node.fragments.map(fragment => [fragment.fragmentId, node.memoryId])));
    const inspect = (id, reveal = true) => {
      const node = all.get(id); if (!node) return;
      inspectedNodeId = id; byId("inspected-node-kind").textContent = node.kind;
      const content = node.kind === "observation" ? { memoryId: node.memoryId, author: nameFor(node.actor), savedAt: node.savedAt, source: node.source, rawText: node.rawText, fragments: node.fragments }
        : { chainId: node.chainId, revision: node.revision, state: node.state, author: nameFor(node.actor), ...node.document };
      byId("knowledge-inspector").textContent = JSON.stringify(content, null, 2);
      byId("source-preview-title").textContent = node.document?.claim ?? node.source ?? "Source observation";
      byId("source-preview-meta").textContent = `${node.kind} / ${id}${node.revision ? ` / r${node.revision}` : ""} / ${nameFor(node.actor)}`;
      byId("source-preview-body").textContent = (node.kind === "observation" ? node.rawText : node.document?.conclusion) ?? "Source wording unavailable";
      if (reveal) { byId("source-preview").classList.remove("hidden"); byId("source-preview").scrollIntoView({ block: "nearest", behavior: "auto" }); }
    };
    knowledgeInspector = inspect;
    renderKnowledgeFocus(knowledge, inspect);
    renderHumanReview(knowledge);
    renderMachineRecords(knowledge, inspect);
    renderKnowledgeHero(knowledge, inspect);
    for (const [target, nodes, kind] of [["observation-nodes", observations, "observation"], ["chain-nodes", chains, "chain"], ["principle-nodes", principles, "principle"]]) {
      const list = byId(target); list.replaceChildren();
      if (!nodes.length) list.append(element("p", "knowledge-empty", `No ${kind}s stored yet`));
      for (const node of nodes) {
        const id = node.chainId ?? node.memoryId; const card = element("article", "knowledge-node");
        card.dataset.nodeId = id;
        card.style.setProperty("--node-color", recording?.agents.find(agent => agent.id === node.actor)?.color ?? colors[0]);
        const title = element("button", "knowledge-node-title", node.document?.claim ?? node.fragments?.[0]?.text ?? "Stored observation"); title.addEventListener("click", () => inspect(id));
        const lastWrite = [...operations].reverse().find(operation => operation.nodeId === id);
        card.append(title, element("div", "knowledge-node-meta", `${nameFor(node.actor)} / ${node.state ?? "stored"}${node.revision ? ` / revision ${node.revision}` : ""}\n${lastWrite?.savedAt ?? node.savedAt ?? "Time not recorded"}`));
        const links = element("div", "knowledge-node-links");
        const parents = node.document ? [...node.document.evidence.map(reference => ({ id: fragmentOwners.get(reference.fragmentId), label: reference.role })),
          ...(node.document.supportedBy ?? []).map(reference => ({ id: reference.chainId, label: `chain r${reference.revision}` }))] : [];
        for (const parent of parents) if (parent.id && all.has(parent.id)) {
          const button = element("button", "", `${parent.label} ${parent.id.slice(0, 7)}`); button.addEventListener("click", () => inspect(parent.id)); links.append(button);
        }
        card.append(links, element("div", "knowledge-node-id", id)); list.append(card);
      }
    }
    byId("observation-count").textContent = String(observations.length); byId("chain-count").textContent = String(chains.length);
    byId("principle-count").textContent = String(principles.length); byId("persistence-count").textContent = String(durability.filter(proof => proof.passed).length);
    byId("knowledge-origin").textContent = recording?.memoryLab || recording?.rediscovery ? `MindLeak ${recording.report.server?.version ?? ""} / run ${recording.report.runId} / ${guide ? `exported ${guide.extractedAt}` : "recorded source evidence"}` : "Durable observation, chain and principle records";
    const head = guide ? principles.find(node => node.chainId === guide.chainId) : null;
    byId("guide-revision").textContent = guide ? head && head.revision !== guide.revision
      ? `Export r${guide.revision} / current r${head.revision} ${head.state}`
      : `Revision ${guide.revision} / ${guide.chainId.slice(0, 8)}`
      : knowledge.lessons?.length ? knowledge.lessons.map(lesson => `${lesson.title} / accepted r${lesson.revision}`).join("; ") : "Not yet accepted";
    const guides = knowledge.guides ?? recording?.report.guides;
    byId("guide-document").textContent = guides?.length ? guides.map(item => item.markdown).join("\n\n") : guide?.markdown ?? knowledge.lessons?.map(lesson => lesson.markdown).join("\n\n") ?? "The agents have not exported a guide yet.";
    byId("download-guide").disabled = !guide && !knowledge.lessons?.length; byId("download-knowledge").disabled = !observations.length;
    byId("storage-operation-count").textContent = `${operations.length} acknowledged writes`;
    const ledger = byId("storage-ledger-body"); ledger.replaceChildren();
    for (const operation of [...operations].reverse()) {
      const row = element("tr");
      for (const value of [operation.savedAt, nameFor(operation.actor), operation.kind, operation.operation, operation.revision ?? "--", operation.memoryId, operation.state]) row.append(element("td", "", String(value)));
      ledger.append(row);
    }
    const proofs = byId("persistence-list"); proofs.replaceChildren();
    for (const proof of durability) proofs.append(element("div", "persistence-proof", `${proof.passed ? "VERIFIED" : "FAILED"} / ${nameFor(proof.actor)}\nPID ${proof.previousPid ?? "?"} → ${proof.currentPid ?? "?"}\n${proof.records} records recovered / ${proof.checkedAt}`));
    byId("persistence-note").textContent = durability.length ? `${durability.at(-1).records} records in latest recovery` : "IDs and content recovered";
    const applied = byId("applied-learnings"); applied.replaceChildren();
    byId("application-count").textContent = `${applications.length} recorded applications`;
    if (!applications.length) applied.append(element("p", "knowledge-empty", "No guide application recorded yet"));
    for (const application of applications) {
      const card = element("article", "knowledge-node");
      card.append(element("h3", "knowledge-node-title", `${nameFor(application.actor)} / ${application.caseId}`),
        element("div", "knowledge-node-meta", `Guide r${application.revision} / ${application.chainId}\n${application.sourceMemoryIds.length} inspected source observations / ${application.recordedAt}`));
      for (const step of application.steps) card.append(element("p", "memory-body", `${step.decision.toUpperCase()}: ${step.quote}\n${step.evidencePath}: ${step.reason}`));
      const source = element("button", "small-command", "Inspect stored application"); source.addEventListener("click", () => inspect(application.memoryId));
      card.append(source); applied.append(card);
    }
    if (inspectedNodeId && all.has(inspectedNodeId)) inspect(inspectedNodeId, false);
    else { inspectedNodeId = null; byId("source-preview").classList.add("hidden"); byId("knowledge-inspector").textContent = "No source selected"; }
    icons();
  }
  function renderHumanReview(knowledge) {
    const queue = knowledgeReviewQueue(knowledge, humanReviews);
    const selected = queue.items.find(item => item.id === byId("knowledge-focus").dataset.nodeId) ?? null;
    if (selected?.snapshot !== currentReviewItem?.snapshot) { byId("review-note").value = ""; byId("review-evidence-check").checked = false; }
    currentReviewItem = selected;
    for (const [id, value] of [["pending", queue.counts.pending], ["approved", queue.counts.approved], ["revision", queue.counts.revisionRequested], ["deferred", queue.counts.deferred], ["total", queue.items.length]]) byId(`review-${id}-count`).textContent = count(value);
    const labels = { pending: "Awaiting your review", approved: "Human approved", revision_requested: "Revision requested", deferred: "Review deferred" };
    for (const button of byId("review-filters").querySelectorAll("button")) button.setAttribute("aria-pressed", String(button.dataset.reviewFilter === reviewFilter));
    const list = byId("review-queue"); list.replaceChildren(); const query = byId("review-search").value.trim().toLowerCase();
    for (const item of queue.items.filter(item => (reviewFilter === "all" || item.status === reviewFilter) && item.claim.toLowerCase().includes(query))) {
      const button = element("button", "review-item"); button.dataset.knowledgeId = item.id; button.dataset.status = item.status; button.setAttribute("aria-pressed", String(item.id === selected?.id));
      button.append(element("strong", "", item.claim), element("small", "", `${item.kind.toUpperCase()} / r${item.revision} / ${item.sourceCount} sources`), element("small", "", item.blockedReasons.length ? "Evidence needs attention" : labels[item.status]));
      button.addEventListener("click", () => { focusedKnowledgeId = item.id; knowledgeKey = ""; renderKnowledge(); }); list.append(button);
    }
    if (!list.childElementCount) list.append(element("p", "review-empty", queue.items.length ? "No knowledge matches this view." : "No chains or principles recorded yet."));
    byId("review-decision-status").textContent = selected ? labels[selected.status] : "Awaiting a claim"; byId("review-decision-status").dataset.status = selected?.status ?? "pending";
    byId("review-selection").textContent = selected ? `${selected.kind.toUpperCase()} / r${selected.revision} / recorded ${selected.agentState}${selected.staleReview ? " / evidence changed since review" : ""}` : "No recorded knowledge selected";
    const blockers = byId("review-blockers"); blockers.replaceChildren(); for (const reason of selected?.blockedReasons ?? []) blockers.append(element("li", "", reason)); blockers.classList.toggle("hidden", !blockers.childElementCount);
    const history = byId("review-history"); history.replaceChildren();
    for (const decision of [...selected?.history ?? []].reverse()) { const entry = element("article"); entry.append(element("strong", "", { approve: "Approved", request_revision: "Revision requested", defer: "Deferred" }[decision.decision]), element("small", "", `${decision.reviewer} / r${decision.revision} / ${decision.reviewedAt}`), element("p", "", decision.note)); history.append(entry); }
    if (!history.childElementCount) history.append(element("p", "review-empty", "No human decision recorded."));
    renderReviewControls();
  }
  const reviewStoragePrefix = () => recording?.report.runId ? `mindleak:human-review:v1:${recording.report.runId}:` : null;
  function readHumanReviews() {
    const prefix = reviewStoragePrefix(); if (!prefix) return [];
    const keys = Object.keys(localStorage).filter(key => key.startsWith(prefix));
    if (keys.length > 200) throw new Error("review_limit");
    let bytes = 0;
    const decisions = keys.map(key => {
      const text = localStorage.getItem(key); if (text === null) return null;
      bytes += new TextEncoder().encode(text).byteLength;
      if (bytes > 4 * 1024 * 1024) throw new Error("review_budget");
      const decision = JSON.parse(text);
      if (decision?.format !== "mindleak-human-review" || decision.version !== 1 || decision.runId !== recording.report.runId
        || key !== `${prefix}${decision.id}`) throw new Error("review_invalid");
      return decision;
    }).filter(Boolean);
    return decisions.sort((left, right) => String(left.reviewedAt).localeCompare(String(right.reviewedAt)) || left.id.localeCompare(right.id));
  }
  function refreshHumanReviews() {
    try { humanReviews = readHumanReviews(); reviewStorageError = null; }
    catch { humanReviews = []; reviewStorageError = "Local review storage is unavailable, damaged, or full."; }
    byId("review-feedback").textContent = reviewStorageError ?? "Local human review / recorded knowledge unchanged";
    byId("review-feedback").dataset.error = String(Boolean(reviewStorageError));
    knowledgeKey = "";
  }
  const reviewIsCurrent = () => Boolean(recording && !playing && !following && !runActive && recording.report.status !== "recording" && position >= recording.durationMs);
  function renderReviewControls() {
    const current = reviewIsCurrent();
    const reviewer = byId("reviewer-name").value.trim(); const note = byId("review-note").value.trim();
    const ready = current && currentReviewItem && !reviewStorageError && reviewer.length > 0 && reviewer.length <= 100 && note.length > 0 && note.length <= 2000;
    byId("review-approve").disabled = !ready || !byId("review-evidence-check").checked || currentReviewItem?.blockedReasons.length > 0 || currentReviewItem?.status === "approved";
    byId("review-revise").disabled = !ready; byId("review-defer").disabled = !ready;
    byId("review-export").disabled = !humanReviews.length;
    byId("review-view-state").textContent = current ? "Latest recorded snapshot" : recording?.report.status === "recording" || runActive ? "Live experiment / review locked" : "Historical playback / review locked";
    byId("review-current").disabled = !recording || runActive || recording.report.status === "recording";
  }
  function beginHumanReview(decision) {
    renderReviewControls();
    const button = byId({ approve: "review-approve", request_revision: "review-revise", defer: "review-defer" }[decision]);
    if (button.disabled) return;
    const reviewId = Array.from(crypto.getRandomValues(new Uint32Array(4)), part => part.toString(16).padStart(8, "0")).join("");
    pendingReview = { format: "mindleak-human-review", version: 1, id: reviewId, runId: recording.report.runId,
      chainId: currentReviewItem.id, revision: currentReviewItem.revision, snapshot: currentReviewItem.snapshot, decision,
      reviewer: byId("reviewer-name").value.trim(), note: byId("review-note").value.trim(), evidenceReviewed: byId("review-evidence-check").checked };
    byId("review-confirm-title").textContent = { approve: "Approve this knowledge?", request_revision: "Request a revision?", defer: "Defer this review?" }[decision];
    byId("review-confirm-claim").textContent = currentReviewItem.claim;
    byId("review-confirm-meta").textContent = `${pendingReview.reviewer} / r${pendingReview.revision} / browser-local decision`;
    byId("review-confirm-note").textContent = pendingReview.note;
    byId("review-confirm-feedback").textContent = "Recorded lab results and MCP knowledge stay unchanged.";
    byId("review-confirm").showModal();
  }
  byId("review-confirm-save").addEventListener("click", () => {
    if (!pendingReview) return;
    const fail = message => { byId("review-confirm-feedback").textContent = message; byId("review-feedback").textContent = message; byId("review-feedback").dataset.error = "true"; };
    const item = knowledgeReviewQueue(recording?.report.knowledge ?? {}, humanReviews).items.find(item => item.id === pendingReview.chainId);
    if (!reviewIsCurrent() || pendingReview.runId !== recording.report.runId || item?.snapshot !== pendingReview.snapshot
      || pendingReview.decision === "approve" && (!pendingReview.evidenceReviewed || item.blockedReasons.length)) {
      fail("Decision not saved. The selected evidence or experiment state changed."); return;
    }
    try {
      const existing = readHumanReviews();
      if (existing.length >= 200 && !existing.some(decision => decision.id === pendingReview.id)) throw new Error("review_limit");
      pendingReview.reviewedAt ??= new Date().toISOString();
      const text = JSON.stringify(pendingReview); const key = `${reviewStoragePrefix()}${pendingReview.id}`;
      if (new TextEncoder().encode(JSON.stringify([...existing, pendingReview])).byteLength > 4 * 1024 * 1024) throw new Error("review_budget");
      const previous = localStorage.getItem(key); if (previous !== null && previous !== text) throw new Error("review_conflict");
      localStorage.setItem(key, text);
      if (localStorage.getItem(key) !== text) throw new Error("review_unverified");
      humanReviews = readHumanReviews(); reviewStorageError = null;
    } catch { fail("Decision not saved or verified. Browser storage is unavailable or full."); return; }
    pendingReview = null; byId("review-confirm").close(); byId("review-note").value = ""; byId("review-evidence-check").checked = false;
    byId("review-feedback").textContent = "Human decision saved locally. Recorded knowledge unchanged."; byId("review-feedback").dataset.error = "false";
    knowledgeKey = ""; render(true);
  });
  byId("review-confirm-cancel").addEventListener("click", () => { pendingReview = null; byId("review-confirm").close(); });
  byId("review-confirm").addEventListener("cancel", () => { pendingReview = null; });
  for (const [id, decision] of [["review-approve", "approve"], ["review-revise", "request_revision"], ["review-defer", "defer"]]) byId(id).addEventListener("click", () => beginHumanReview(decision));
  for (const id of ["reviewer-name", "review-note", "review-evidence-check"]) byId(id).addEventListener("input", renderReviewControls);
  byId("review-export").addEventListener("click", () => {
    if (humanReviews.length) save(JSON.stringify({ format: "mindleak-human-reviews", version: 1, authority: "browser-local", runId: recording.report.runId,
      exportedAt: new Date().toISOString(), decisions: humanReviews }, null, 2), `mindleak-human-reviews-${recording.report.runId}.json`, "application/json");
  });
  window.addEventListener("storage", event => {
    const prefix = reviewStoragePrefix(); if (!prefix || event.key !== null && !event.key.startsWith(prefix)) return;
    refreshHumanReviews(); if (recording) render(true);
  });
  for (const button of byId("review-filters").querySelectorAll("button")) button.addEventListener("click", () => { reviewFilter = button.dataset.reviewFilter; knowledgeKey = ""; renderKnowledge(); });
  byId("review-search").addEventListener("input", () => { knowledgeKey = ""; renderKnowledge(); });
  byId("review-current").addEventListener("click", () => { if (!recording) return; following = false; playing = false; position = recording.durationMs; render(true); });
  function renderMachineRecords(knowledge, inspect) {
    for (const [kind, key, symbol] of [["observations", "memoryId", "file-text"], ["chains", "chainId", "git-branch"], ["principles", "chainId", "book-open-check"]]) {
      const records = [...new Map((knowledge[kind] ?? []).map(record => [record[key], record])).values()];
      const list = byId(`machine-${kind}`); list.replaceChildren();
      byId(`machine-${kind === "observations" ? "observation" : kind === "chains" ? "chain" : "principle"}-count`).textContent = count(records.length);
      for (const [index, record] of records.slice(-3).entries()) {
        const label = record.document?.claim ?? record.fragments?.[0]?.text ?? record.source ?? "Recorded source";
        const button = element("button", "machine-record"); button.dataset.recordId = record[key]; button.title = `${label}\n${record.source ?? record[key]}`;
        if (kind !== "observations") button.setAttribute("aria-pressed", String(record[key] === byId("knowledge-focus").dataset.nodeId));
        const content = element("div");
        content.append(element("strong", "", label),
          element("small", "", `${String(Math.max(0, records.length - 3) + index + 1).padStart(3, "0")} / ${record.state ?? "source"}${record.revision ? ` / r${record.revision}` : ""}`));
        button.append(icon(symbol), content);
        button.addEventListener("click", () => {
          if (kind === "observations") inspect(record[key]);
          else { focusedKnowledgeId = record[key]; knowledgeKey = ""; renderKnowledge(); byId("knowledge-focus").scrollIntoView({ block: "nearest", behavior: "auto" }); }
        });
        list.append(button);
      }
      if (!records.length) list.append(element("p", "machine-empty", { observations: "Awaiting source material", chains: "No chains formed yet", principles: "No principles formed yet" }[kind]));
      const more = byId(`machine-${kind}-more`); more.disabled = !records.length;
      more.querySelector("span").textContent = records.length > 3 ? `${records.length - 3} more in library` : `${records.length} recorded`;
    }
  }
  for (const [kind, target] of [["observations", "observation-nodes"], ["chains", "chain-nodes"], ["principles", "principle-nodes"]]) {
    byId(`machine-${kind}-more`).addEventListener("click", () => {
      const list = byId(target); const library = list.closest("details");
      if (library) library.open = true;
      list.scrollIntoView({ block: "start", behavior: "auto" });
    });
  }
  function renderKnowledgeFocus(knowledge, inspect) {
    const focus = knowledgeFocus(knowledge, focusedKnowledgeId);
    const node = focus.selected; const panel = byId("knowledge-focus");
    const previous = panel.dataset.revisionKey;
    const revisionKey = node ? `${node.id}:${node.revision}:${node.state}` : "";
    panel.dataset.nodeId = node?.id ?? ""; panel.dataset.state = node?.state ?? "empty";
    panel.dataset.revisionKey = revisionKey;
    panel.dataset.arriving = String(Boolean(node && previous !== revisionKey && !reducedMotion.matches && (playing || following)));
    const select = byId("knowledge-focus-select"); select.replaceChildren();
    for (const choice of focus.choices) { const option = element("option", "", choice.claim); option.value = choice.id; select.append(option); }
    select.value = node?.id ?? ""; select.disabled = !focus.choices.length;
    byId("knowledge-focus-empty").classList.toggle("hidden", Boolean(node));
    byId("knowledge-focus-body").classList.toggle("hidden", !node);
    byId("knowledge-focus-lineage").classList.toggle("hidden", !node);
    byId("knowledge-focus-inspect").disabled = !node;
    const born = node && recording?.events.find(event => event.type === "knowledge_written" && event.nodeId === node.id);
    replayKnowledgeAt = born ? Math.max(0, born.atMs - 1200) : null;
    byId("knowledge-focus-replay").disabled = replayKnowledgeAt === null;
    if (!node) {
      const count = knowledge.observations?.length ?? 0;
      byId("knowledge-focus-empty").textContent = count ? `${count} source episodes recorded. No chain or principle has been formed at this point.` : "Awaiting the first source observation";
      return;
    }
    byId("knowledge-focus-status").textContent = `${node.kind === "principle" ? "PRINCIPLE" : "CHAIN OF MEMORY"} / r${node.revision ?? "?"} / ${(node.state ?? "recorded").toUpperCase()}${node.requiresReview ? " / REVIEW REQUIRED" : ""}`;
    byId("knowledge-focus-claim").textContent = node.claim ?? "Recorded knowledge";
    byId("knowledge-focus-conclusion").textContent = node.conclusion ?? "Conclusion not recorded";
    byId("knowledge-focus-applicability").textContent = node.applicability ?? "Conditions not recorded";
    const assumptions = byId("knowledge-focus-assumptions"); assumptions.replaceChildren();
    for (const text of node.assumptions.length ? node.assumptions : ["No explicit assumptions recorded"]) assumptions.append(element("li", "", text));
    byId("knowledge-focus-lineage-count").textContent = `${focus.supports.length} linked chains / ${focus.sources.length} distinct source episodes`;
    byId("evidence-route-sources").textContent = count(focus.sources.length); byId("evidence-route-chains").textContent = count(focus.supports.length);
    byId("evidence-route-revision").textContent = `r${node.revision ?? "?"}`; byId("evidence-route-kind").textContent = node.kind.toUpperCase();
    for (const id of ["evidence-chain-arrow", "evidence-chain-stop"]) byId(id).classList.toggle("hidden", node.kind !== "principle");
    const supports = byId("knowledge-focus-supports"); supports.replaceChildren();
    const inspectSource = id => inspect(id);
    for (const support of focus.supports) {
      const item = element("button", "knowledge-support"); item.disabled = !support.available;
      const label = element("div", "knowledge-support-top"); label.append(icon("git-branch"), document.createTextNode(`CHAIN / PINNED r${support.revision}${support.currentRevision !== support.revision ? ` / CURRENT ${support.currentRevision ?? "UNKNOWN"}` : ""}`));
      item.append(label, element("strong", "", support.claim));
      if (support.conclusion) item.append(element("p", "", support.conclusion));
      item.addEventListener("click", () => inspectSource(support.id)); supports.append(item);
    }
    const sources = byId("knowledge-focus-sources"); sources.replaceChildren();
    for (const [index, source] of focus.sources.entries()) {
      const button = element("button", "knowledge-source-link"); button.append(icon("file-search"), element("span", "", `Source ${index + 1} / ${source.label}`));
      button.title = source.id; button.addEventListener("click", () => inspectSource(source.id)); sources.append(button);
    }
    const counterexamples = byId("knowledge-focus-counterexamples"); counterexamples.replaceChildren();
    byId("knowledge-focus-counter").classList.toggle("hidden", !focus.counterexamples.length);
    for (const counter of focus.counterexamples) {
      const button = element("button", "knowledge-source-link"); button.append(icon("triangle-alert"), element("span", "", counter.reasons.filter(Boolean).join("; ") || "Recorded counterexample"));
      button.disabled = !counter.memoryId; button.title = counter.fragmentId;
      button.addEventListener("click", () => inspectSource(counter.memoryId)); counterexamples.append(button);
    }
    byId("knowledge-focus-caption").textContent = `Latest recorded wording / state at replay position. ${focus.unavailableEvidence ? `${focus.unavailableEvidence} evidence references unavailable. ` : ""}Acceptance is recorded validation, not proof of truth. Source counts are not independent confirmations.`;
  }
  byId("knowledge-focus-select").addEventListener("change", event => { focusedKnowledgeId = event.target.value; knowledgeKey = ""; renderKnowledge(); });
  byId("knowledge-focus-replay").addEventListener("click", () => { if (replayKnowledgeAt === null) return; following = false; playing = !reducedMotion.matches; position = replayKnowledgeAt; render(true); });
  byId("knowledge-focus-inspect").addEventListener("click", () => { const id = byId("knowledge-focus").dataset.nodeId; if (id) knowledgeInspector?.(id); });
  function renderKnowledgeHero(knowledge, inspect) {
    activityKey = "";
    const graph = knowledgeGraphData({ ...recording?.report, knowledge, events: recording?.events.filter(event => event.atMs <= position) ?? [] });
    const metrics = knowledgeMetrics({ ...recording?.report, knowledge });
    const chart = byId("knowledge-hero-graph"); chart.replaceChildren();
    const svg = (tag, attributes, text) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
    const colorsByKind = { observation: "#008655", chain: "#145ee0", principle: "#a16b00" };
    const assembled = !byId("knowledge-page").classList.contains("hidden");
    const width = assembled ? Math.max(300, chart.clientWidth) : 680;
    const height = assembled ? chart.clientHeight || 215 : 310;
    const horizontal = { observation: assembled ? width / 6 : 70, chain: width / 2, principle: assembled ? width * 5 / 6 : 610 };
    chart.setAttribute("viewBox", `0 0 ${width} ${height}`);
    for (const [kind, label] of [["observation", "OBSERVATIONS"], ["chain", "CHAINS"], ["principle", "PRINCIPLES"]]) chart.append(svg("text", { x: horizontal[kind], y: assembled ? 17 : 22, "text-anchor": "middle" }, label));
    const positions = new Map(graph.nodes.map(node => [node.id, { ...node, x: horizontal[node.kind], y: node.y * height / 310 }]));
    const focus = knowledgeFocus(knowledge, byId("knowledge-focus").dataset.nodeId);
    const selected = new Set([focus.selected?.id, ...focus.supports.map(node => node.id), ...focus.sources.map(node => node.id)]);
    for (const edge of graph.edges) {
      const from = positions.get(edge.from); const to = positions.get(edge.to);
      const bend = assembled ? (to.x - from.x) * 100 / 270 : 100;
      const path = svg("path", { d: `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`,
        class: "knowledge-hero-edge", "data-role": edge.role, "data-from": edge.from, "data-to": edge.to, "data-selected": selected.has(edge.from) && selected.has(edge.to), fill: "none", stroke: edge.role === "counterexample" ? "#bd3b35" : "#a9b8cc", "stroke-width": 1.3 });
      path.append(svg("title", {}, `${edge.role}${edge.referenceRevision ? ` / pinned revision ${edge.referenceRevision}` : ""}`)); chart.append(path);
    }
    for (const node of positions.values()) {
      const group = svg("g", { class: "knowledge-hero-node", role: "button", tabindex: 0, "aria-label": `${node.kind}: ${node.label}`, "data-node-id": node.id, "data-arriving": !displayedGraphIds.has(node.id), "data-selected": selected.has(node.id) });
      group.append(svg("circle", { cx: node.x, cy: node.y, r: { observation: 7, chain: 12, principle: 20 }[node.kind] * height / 310, fill: colorsByKind[node.kind], stroke: "#172333", "stroke-width": node.state === "candidate" ? 1 : 2 }),
        svg("title", {}, `${node.kind} / ${node.state}${node.revision ? ` / revision ${node.revision}` : ""}\n${node.label}\n${node.id}`));
      const select = () => inspect(node.id);
      group.addEventListener("click", select); group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
      chart.append(group);
    }
    displayedGraphIds = new Set(graph.nodes.map(node => node.id));
    byId("knowledge-hero-empty").classList.toggle("hidden", graph.nodes.length > 0);
    byId("knowledge-hero-status").textContent = `${graph.nodes.length} visible records / ${graph.edges.length} source links${graph.omitted ? ` / ${graph.omitted} more in the ledger` : ""}${graph.missingReferences ? ` / ${graph.missingReferences} unresolved references` : ""}`;
    byId("hero-reuse").textContent = metrics.reuse.tasks;
    byId("hero-transfer").textContent = metrics.transfer.successful;
    byId("hero-reuse").nextElementSibling.textContent = metrics.reuse.kind === "source_linked" ? "successful tasks with source links" : "successful tasks with linked reuse";
    byId("hero-transfer").nextElementSibling.textContent = metrics.reuse.kind === "source_linked" ? "new-case source-linked applications" : "successful new-case applications";
    byId("hero-principles").textContent = metrics.formation.principles.recordedAccepted;
    const growth = byId("knowledge-growth-graph"); growth.replaceChildren();
    if (!graph.history.length) return;
    const maximum = Math.max(1, ...graph.history.flatMap(point => [point.observations, point.chains, point.principles]));
    const firstWrite = graph.history[0].atMs;
    const duration = Math.max(1, ...graph.history.map(point => point.atMs - firstWrite));
    for (const [field, color] of [["observations", "#008655"], ["chains", "#145ee0"], ["principles", "#a16b00"]]) {
      const points = graph.history.map(point => `${20 + (point.atMs - firstWrite) / duration * 250},${96 - point[field] / maximum * 77}`).join(" ");
      const line = svg("polyline", { points, fill: "none", stroke: color, "stroke-width": 2, "data-series": field });
      line.append(svg("title", {}, `${field}: ${graph.history.at(-1)[field]} logical records`)); growth.append(line);
    }
    growth.append(svg("text", { x: 20, y: 116 }, "First recorded write"), svg("text", { x: 270, y: 116, "text-anchor": "end" }, "Latest"));
  }
  function renderCapital(capital, formation) {
    for (const id of ["capital-panel", "knowledge-capital-panel"]) {
      const panel = byId(id); const field = name => panel.querySelector(`[data-capital="${name}"]`);
      panel.setAttribute("aria-label", "Knowledge Formation");
      const stage = name => panel.querySelector(`[data-formation="${name}"]`);
      stage("status").textContent = { awaiting_observations: "Awaiting observations", observations_captured: "Source experiences captured",
        chains_formed: "Evidence-backed chains formed", principles_formed: "Principles formed / later reuse assessed separately",
        review_metadata_unavailable: "Recorded acceptance / review metadata unavailable" }[formation.status];
      stage("observations").textContent = count(formation.observations.stored);
      stage("sources").textContent = `${count(formation.observations.supporting)} distinct sources supporting accepted chains`;
      for (const [kind, note] of [["chains", "chain-status"], ["principles", "principle-status"]]) {
        const level = formation[kind]; stage(kind).textContent = count(level.recordedAccepted);
        stage(note).textContent = `${level.accepted} ready / ${level.candidates} candidates / ${level.needsReview} need review${level.reviewUnknown ? ` / ${level.reviewUnknown} review unknown` : ""}`;
      }
      field("score").textContent = capital.score === null ? "--" : count(capital.score);
      field("status").textContent = capital.score === null ? "Not measured in this recording" : "Evidence-backed reuse index";
      field("observations").textContent = count(capital.observations);
      field("observations-note").textContent = capital.usedObservations === null ? "Stored sources / use not measured" : `${count(capital.usedObservations)} used in verified work`;
      field("chains").textContent = capital.usefulChains === null ? "--" : count(capital.usefulChains);
      field("principles").textContent = capital.validatedPrinciples === null ? "--" : count(capital.validatedPrinciples);
      field("principles-note").textContent = `${count(capital.acceptedPrinciples)} accepted / later-use validation required`;
      field("growth").textContent = capital.growthPercent === null ? "--" : `${capital.growthPercent > 0 ? "+" : ""}${capital.growthPercent.toFixed(1)}%`;
      field("trend").dataset.trend = capital.growthPercent > 0 ? "positive" : capital.growthPercent < 0 ? "negative" : "neutral";
      field("growth-note").textContent = { not_measured: "Use evidence not recorded", needs_comparison: "First measured checkpoint",
        first_reuse: "First evidenced reuse", no_reuse: "No evidenced reuse yet", comparable: "Since the first verified checkpoint" }[capital.growthStatus];
    }
  }
  function renderCompletion() {
    const summary = labCompletion(recording?.report ?? {});
    const sharing = buildCollaboration(recording?.report ?? {});
    const key = JSON.stringify([summary, sharing]);
    if (key === completionKey) return;
    completionKey = key;
    byId("build-sharing-summary").classList.toggle("hidden", !sharing);
    if (sharing) {
      byId("build-sharing-policy").textContent = sharing.policy === "knowledge-first-handoff-v5" ? "SOURCE-CHECKED HANDOFFS / V5" : sharing.policy === "knowledge-first-handoff-v4" ? "KNOWLEDGE-FIRST HANDOFFS / V4" : sharing.policy === "verified-handoff-v3" ? "VERIFIED TEAM HANDOFFS / V3" : sharing.policy === "optional-use-v2" ? "OPTIONAL SHARING / RECORDED V2" : "RECORDED TEAM SHARING";
      byId("build-sharing-status").textContent = { completed: "Component handoffs stored and received", running: "Component handoffs in progress", incomplete: "Sharing workflow incomplete", optional: "Publication and handoff were optional in this run", not_measured: "Handoff completion was not recorded" }[sharing.status];
      const ratio = (value, required) => value === null ? "Not recorded" : required === null ? count(value) : `${value} / ${required}`;
      byId("build-sharing-published").textContent = ratio(sharing.publishedComponents, sharing.requiredPublications);
      byId("build-sharing-received").textContent = ratio(sharing.receivedDependencyHandoffs, sharing.requiredDependencyHandoffs);
      byId("build-sharing-links").textContent = count(sharing.crossAgentHandoffs);
      byId("build-sharing-code").textContent = ratio(sharing.codePassedComponents, sharing.components);
      byId("build-sharing-startup").textContent = sharing.priorKnowledgeChecked === null ? "Prior-knowledge startup checks were not recorded in this run."
        : `Prior knowledge: ${ratio(sharing.priorKnowledgeChecked, sharing.requiredPublications)} searched / ${ratio(sharing.priorKnowledgeAssessed, sharing.requiredPublications)} assessed.${sharing.checkedDependencySources === null ? "" : ` ${ratio(sharing.checkedDependencySources, sharing.requiredDependencyHandoffs)} dependency implementations checked against published hashes.`} Assessments are recorded decisions, not measured benefit.`;
    }
    byId("verification-execution").textContent = { not_started: "Not started", running: "Running", finished: "Run finished", incomplete: "Run incomplete", stopped: "Run stopped" }[summary.execution.status];
    const requirements = summary.requirements;
    byId("verification-requirements").textContent = requirements.scheduled ? `${requirements.passed}/${requirements.scheduled} passed${requirements.unresolved ? ` / ${requirements.unresolved} unresolved` : ""}` : "Not measured";
    byId("verification-requirements").dataset.verdict = requirements.status;
    byId("verification-quality").textContent = { not_reviewed: "Not reviewed", partial_review: "Partially reviewed", reviewed: "Recorded reviews passed", failed: "Review checks failed" }[summary.quality.status];
    byId("verification-quality").dataset.verdict = summary.quality.status === "failed" ? "failed" : "";
    byId("verification-learning").textContent = "Not established";
    const body = byId("verification-evidence-body"); body.replaceChildren();
    for (const item of requirements.items) {
      const row = element("tr");
      for (const value of [item.label, item.status, `${item.passedTests ?? "--"}/${item.expectedTests ?? "--"}`, item.sourceSha256 ?? "Not recorded"]) row.append(element("td", "", String(value)));
      row.title = item.checks.map(check => `${check.passed ? "Passed" : "Failed"}: ${check.name}`).join("\n");
      body.append(row);
    }
    byId("verification-quality-evidence").textContent = [...summary.quality.checks.map(review => `${review.area}: ${review.passedChecks}/${review.checks} checks / ${review.method} / ${review.artifactSha256}`),
      `Not reviewed: ${summary.quality.unreviewed.join(", ") || "None in the declared review scope"}`].join("\n");
    byId("verification-scope").textContent = `${summary.scope} ${summary.learning.observedUses ? `${summary.learning.observedUses} tasks have recorded prior use; this is not a demonstrated advantage.` : summary.learning.explanation}`;
  }
  function renderKnowledgeOutcomes() {
    renderCompletion();
    const build = recording?.report.kind === "swarm_build" || !recording && ![2, 3].includes(profiles?.experiment);
    byId("knowledge-reuse-results").classList.toggle("hidden", build);
    byId("capital-panel").classList.toggle("hidden", build);
    byId("stage-graph").classList.toggle("hidden", build);
    const metrics = knowledgeMetrics(recording?.report ?? {});
    const key = JSON.stringify(metrics);
    if (key === outcomeKey) return;
    outcomeKey = key;
    renderCapital(metrics.capital, metrics.formation);
    byId("investigation-evidence").classList.toggle("hidden", !metrics.investigation);
    if (metrics.investigation) {
      const learning = metrics.investigation;
      byId("investigation-version").textContent = `v${recording?.report.plan?.protocolVersion ?? 4} / ONE FAMILY`;
      byId("investigation-discoveries").textContent = count(learning.discoveriesRetained);
      byId("investigation-unfinished").textContent = count(learning.unfinishedInvestigationsWithEvidence);
      byId("investigation-predictions").textContent = `${count(learning.correctPredictions)} / ${count(learning.predictions)}`;
      byId("investigation-exceptions").textContent = count(learning.exceptionsRetained);
      const decisions = byId("investigation-decisions"); decisions.replaceChildren();
      const names = { fresh: "Fresh Agent", notebook: "Notebook", original: "Original Knowledge", mindleak: "MindLeak", direct: "Direct / diagnostic" };
      for (const [arm, data] of Object.entries(recording?.report.metrics?.arms ?? {})) {
        const row = element("tr");
        for (const value of [names[arm], `${data.checkedDecisions} / ${data.scheduled}`, `${data.boundaryDecisions} / 2`, `${data.correct} / ${data.scheduled}`]) row.append(element("td", "", value));
        decisions.append(row);
      }
      const validation = byId("investigation-validations"); validation.replaceChildren();
      const checks = recording?.report.plan?.validation?.flatMap(entry => ["mindleak", "notebook"].map(arm =>
        recording.report.validations?.find(item => item.caseId === entry.id && item.arm === arm)
        ?? { caseId: entry.id, arm, status: "not_recorded", correct: null })) ?? recording?.report.validations ?? [];
      if (recording?.report.plan?.profile === "quality") checks.push(...(recording.report.validations ?? [])
        .filter(check => !recording.report.plan.validation.some(entry => entry.id === check.caseId)));
      for (const check of checks) {
        const row = element("tr");
        for (const value of [`${names[check.arm]} / ${check.caseId}`, check.prediction ? check.prediction.expectedPass ? "Pass" : "Fail" : "Not recorded",
          check.status === "not_recorded" ? "Not recorded" : check.status === "execution_failed" ? "Execution failed" : check.verification ? check.verification.passed ? "Pass" : "Fail" : "Not executed",
          check.correct === null ? "Not measured" : check.correct ? "Matched" : "Did not match"]) row.append(element("td", "", value));
        validation.append(row);
      }
    }
    const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--";
    byId("outcome-scope").textContent = metrics.evidenceScope;
    const sourceLinked = metrics.reuse.kind === "source_linked";
    const usage = metrics.usage;
    byId("knowledge-use-summary").classList.toggle("hidden", !usage);
    if (usage) {
      byId("knowledge-use-policy").textContent = usage.policy === "knowledge_first" ? "KNOWLEDGE-FIRST WORKFLOW" : usage.policy === "optional" ? "OPTIONAL-ADOPTION RECORDING" : "RECORDED KNOWLEDGE ACCESS";
      byId("knowledge-use-status").textContent = !usage.lookedUp ? "Prior knowledge was not consulted" : !usage.received ? "Lookup attempted; no prior knowledge delivered"
        : `${usage.verifiedUse} verified knowledge-linked fixes${usage.rejected ? ` / ${usage.rejected} lessons rejected` : ""}`;
      for (const [id, value] of [["lookups", usage.lookedUp], ["received", usage.received], ["assessed", usage.assessed], ["verified", usage.verifiedUse]]) byId(`knowledge-use-${id}`).textContent = value === null ? "Not recorded" : `${value} / ${usage.evaluated}`;
      byId("knowledge-use-note").textContent = `${usage.notConsulted} tasks without a lookup / ${count(usage.misses)} empty results / ${count(usage.errors)} retrieval errors. Formation, task correctness and reuse are separate measurements.`;
    }
    byId("reuse-rate").previousElementSibling.textContent = sourceLinked ? "SOURCE-LINKED APPLICATIONS" : "OBSERVED KNOWLEDGE REUSE";
    byId("transfer-value").previousElementSibling.textContent = sourceLinked ? "NEW-CASE SOURCE LINKS" : "VERIFIED NEW-CASE USE";
    byId("reuse-rate").textContent = usage && !usage.lookedUp ? "Not consulted" : percent(metrics.reuse.rate);
    byId("reuse-rate").title = metrics.reuse.evidence;
    byId("reuse-note").textContent = usage && !usage.lookedUp ? `${metrics.reuse.tasks} / ${usage.evaluated} knowledge-linked fixes; no lookup attempted` : metrics.investigation ? `${metrics.reuse.tasks} / ${recording?.report.metrics?.arms?.mindleak?.scheduled ?? "--"} scheduled tasks / prior evidence before decision`
      : metrics.successfulTasks ? `${metrics.reuse.tasks} / ${metrics.successfulTasks} successful tasks${sourceLinked ? " / quotation evidence" : " with linked application"}` : "No verified applications yet";
    byId("transfer-value").textContent = metrics.transfer.attempts ? count(metrics.transfer.successful) : usage && !usage.received ? "Not exercised" : "--";
    byId("transfer-value").title = metrics.transfer.evidence;
    byId("transfer-note").textContent = metrics.transfer.attempts ? `${metrics.transfer.successful} / ${metrics.transfer.attempts} recorded new-case applications${sourceLinked ? " / not behavioral transfer" : ""}` : usage && !usage.received ? "No prior knowledge delivered to evaluation tasks" : "No new-case applications recorded";
    byId("verified-task-value").textContent = `${metrics.successfulTasks} / ${metrics.evaluatedTasks}`;
    byId("verified-task-note").textContent = recording?.report.kind === "swarm_build" ? "Memory-team components / immutable checks" : "Memory-team decisions / source + runtime checks";
    byId("chain-utility-value").textContent = metrics.chains.rate === null ? "--" : `${metrics.chains.used} / ${metrics.chains.created}`;
    byId("chain-utility-value").title = metrics.chains.evidence;
    byId("chain-utility-note").textContent = metrics.chains.status === "observed" ? "Direct chain inspection before a passing change; principle use is counted separately" : "Not measured";
    const fixTime = metrics.timeToCorrectHypothesis.status === "verified_fix_time_only";
    byId("hypothesis-time-value").previousElementSibling.textContent = fixTime ? "TIME TO VERIFIED FIX" : "TIME TO CORRECT HYPOTHESIS";
    byId("hypothesis-time-value").textContent = Number.isFinite(metrics.timeToCorrectHypothesis.medianMs) ? formatElapsed(metrics.timeToCorrectHypothesis.medianMs) : "--";
    const freshFix = recording?.report.metrics?.arms?.fresh?.firstVerifiedFixMedianMs;
    byId("hypothesis-time-note").textContent = fixTime ? `Median first passing changed candidate${Number.isFinite(freshFix) ? ` / fresh-agent median ${formatElapsed(freshFix)}` : ""}` : "Not measured";
    const knownFailures = metrics.mistakesAvoided.status === "known_failure_candidates_only";
    byId("mistakes-avoided-value").previousElementSibling.textContent = knownFailures ? "KNOWN FAILURE CANDIDATES" : "REPEATED MISTAKES AVOIDED";
    byId("mistakes-avoided-value").textContent = knownFailures && metrics.mistakesAvoided.withMemory !== null ? `${metrics.mistakesAvoided.withMemory} vs ${metrics.mistakesAvoided.withoutMemory}` : "--";
    byId("mistakes-avoided-note").textContent = knownFailures ? "MindLeak / fresh agent; baseline checks excluded" : "Not measured";
    const chart = byId("knowledge-curve"); chart.replaceChildren();
    const legend = byId("knowledge-curve-legend"); legend.replaceChildren();
    chart.classList.toggle("hidden", !metrics.curve.length);
    byId("knowledge-curve-empty").classList.toggle("hidden", metrics.curve.length > 0);
    byId("knowledge-curve-note").textContent = metrics.curve.length ? `${metrics.curve.length} rounds / ${metrics.caseFamilies ?? "unknown"} repeated families / observed correctness, not a causal compounding score` : "";
    if (!metrics.curve.length) return;
    const svg = (tag, attributes, text) => {
      const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
      for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
      if (text !== undefined) node.textContent = text;
      return node;
    };
    const horizontal = index => metrics.curve.length === 1 ? 415 : 55 + index * 710 / (metrics.curve.length - 1);
    const vertical = rate => 152 - rate * 125;
    for (const rate of [0, 0.5, 1]) {
      chart.append(svg("line", { x1: 55, y1: vertical(rate), x2: 765, y2: vertical(rate), stroke: "#bdc9db", "stroke-width": 1 }),
        svg("text", { x: 43, y: vertical(rate) + 4, "text-anchor": "end" }, `${rate * 100}%`));
    }
    const series = [["withMemory", "MindLeak", "#145ee0", ""], ["withoutMemory", recording?.rediscovery ? "Fresh Agent" : "Daleks", "#a33b32", "7 5"],
      ...(recording?.rediscovery ? [["notebook", "Notebook", "#008655", "2 5"]] : [])];
    for (const [field, label, color, dash] of series) {
      const entry = element("span"); const swatch = element("span", "chart-key"); swatch.style.setProperty("--series-color", color); entry.append(swatch, document.createTextNode(label)); legend.append(entry);
      const points = metrics.curve.map((point, index) => `${horizontal(index)},${vertical(point[field])}`).join(" ");
      chart.append(svg("polyline", { points, fill: "none", stroke: color, "stroke-width": dash ? 2 : 4, "stroke-dasharray": dash, "data-series": field }));
      for (const [index, point] of metrics.curve.entries()) {
        const dot = svg("circle", { cx: horizontal(index), cy: vertical(point[field]), r: dash ? 3 : 6, fill: dash ? color : "white", stroke: color, "stroke-width": 2 });
        dot.append(svg("title", {}, `${label}: round ${point.round}, ${percent(point[field])} correct, ${point.tasksPerArm} tasks`)); chart.append(dot);
      }
    }
    for (const [index, point] of metrics.curve.entries()) chart.append(svg("text", { x: horizontal(index), y: 178, "text-anchor": "middle" }, `R${point.round}`));
  }
  function makeAgentFace(control = false) {
    const face = element("span", control ? "dalek-face" : "agent-face");
    face.setAttribute("aria-hidden", "true");
    face.append(element("span", control ? "dalek-eye" : "agent-eye"), element("span", control ? "dalek-base" : "agent-eye"));
    return face;
  }
  function layoutNetwork() {
    const network = byId("network"); const bounds = network.getBoundingClientRect();
    if (!bounds.width || !byId("agents").offsetHeight) return;
    const cards = [...agentElements.values()].filter(view => !view.control).map(view => ({ view, bounds: view.card.getBoundingClientRect() }));
    if (!cards.length) return;
    const hub = network.querySelector(".hub");
    const hubTop = Math.ceil(Math.max(...cards.map(card => card.bounds.bottom - bounds.top)) + 22);
    const height = Math.ceil(hubTop + hub.offsetHeight + 15);
    const positions = cards.map(({ view, bounds: card }) => ({ id: view.card.dataset.agent, x: card.x - bounds.x + card.width / 2, y: card.bottom - bounds.top }));
    const key = JSON.stringify([bounds.width, hubTop, height, positions]); if (key === networkLayoutKey) return; networkLayoutKey = key;
    network.style.height = `${height}px`; hub.style.top = `${hubTop}px`;
    byId("last-transfer").style.top = `${hubTop + hub.offsetHeight / 2 - 6}px`;
    byId("connections").setAttribute("viewBox", `0 0 ${bounds.width} ${height}`); byId("connections").style.height = `${height}px`;
    for (const { id, x, y } of positions) paths.get(id)?.setAttribute("d", `M ${x} ${y} C ${x} ${hubTop - 8}, ${bounds.width / 2} ${hubTop - 14}, ${bounds.width / 2} ${hubTop}`);
    activityKey = "";
    if (recording) renderActivity(replayState(recording, position));
  }
  new ResizeObserver(layoutNetwork).observe(byId("agents"));
  function makeRoster(agents) {
    activityKey = "";
    networkLayoutKey = "";
    stageFeedKey = ""; stageAgents.clear(); byId("stage-roster").replaceChildren();
    const featured = agents.filter(agent => !agent.control);
    byId("stage-roster").style.setProperty("--stage-agents", featured.length);
    for (const agent of featured) {
      const item = element("div", "stage-agent"); item.style.setProperty("--agent-color", agent.color); item.dataset.agent = agent.id;
      const avatar = element("div", "stage-avatar");
      avatar.append(makeAgentFace());
      const action = element("div", "stage-agent-action", "Waiting");
      item.append(avatar, element("div", "stage-agent-name", agent.name), action); byId("stage-roster").append(item); stageAgents.set(agent.id, { item, action });
    }
    agentElements.clear(); laneElements.clear(); paths.clear(); byId("agents").replaceChildren(); byId("control-agents").replaceChildren(); byId("timeline").replaceChildren(); byId("connections").replaceChildren();
    byId("agent-cost-body").replaceChildren();
    const memoryAgents = agents.filter(agent => !agent.control); const controls = agents.filter(agent => agent.control);
    const build = recording?.report.kind === "swarm_build" || !recording && ![2, 3].includes(profiles?.experiment);
    byId("control-section").classList.toggle("hidden", controls.length === 0);
    byId("agents").style.setProperty("--agents", memoryAgents.length); byId("control-agents").style.setProperty("--agents", Math.max(1, controls.length));
    byId("timeline").style.setProperty("--agents", agents.length); byId("timeline").style.height = `${agents.length * 26}px`;
    for (const [index, agent] of agents.entries()) {
      const card = element("article", "agent-card"); card.style.setProperty("--agent-color", agent.color ?? colors[index]); card.dataset.state = "queued"; card.dataset.agent = agent.id;
      const top = element("div", "agent-top"); const symbol = element("span", "agent-symbol");
      symbol.append(makeAgentFace(agent.control));
      if (agent.control) symbol.title = "Dalek control: no MindLeak access";
      const status = element("span", "agent-state", "Queued"); top.append(symbol, status); card.append(top, element("h3", "agent-name", agent.name), element("p", "agent-title", agent.title));
      const model = element("div", "agent-model"); const modelText = element("span", "agent-model-name", modelName(agent.model ?? draft.agentModels[agent.pairedWith ?? agent.id]));
      const select = element("select", "agent-model-select"); select.setAttribute("aria-label", `${agent.name} model for next run`);
      select.title = "Model for the next run"; select.addEventListener("change", () => {
        draft.agentModels[agent.pairedWith ?? agent.id] = select.value;
        if (!recording) {
          modelText.textContent = modelName(select.value);
          for (const view of agentElements.values()) if (view.pairedWith === (agent.pairedWith ?? agent.id)) view.modelText.textContent = modelName(select.value);
        }
      });
      model.append(element("span", "agent-model-label", agent.control ? "MATCHED LLM / NO MEMORY" : "AGENT LLM"), modelText, select); card.append(model);
      const memoryCounts = element("div", "agent-memory-counts"); const stored = element("strong", "", "0"); const used = element("strong", "", agent.control ? "0" : "--");
      for (const [value, label] of [[stored, "RECORDS SAVED"], [used, build ? agent.control ? "NO MEMORY ACCESS" : "HANDOFFS RECEIVED" : "LINKED TASK USES"]]) { const item = element("div"); item.append(value, element("small", "", label)); memoryCounts.append(item); }
      const value = element("td", "agent-token-value", "0"); const inputValue = element("td", "", "0"); const outputValue = element("td", "", "0");
      const costRow = element("tr"); costRow.append(element("td", "", agent.name), inputValue, outputValue, value); byId("agent-cost-body").append(costRow);
      const action = element("div", "agent-action", "Waiting"); card.append(memoryCounts, action); byId(agent.control ? "control-agents" : "agents").append(card);
      agentElements.set(agent.id, { card, status, value, inputValue, outputValue, stored, used, action, modelText, select, control: agent.control === true, pairedWith: agent.pairedWith });
      const lane = element("div", "lane"); const track = element("div", "lane-track"); lane.append(element("span", "lane-label", agent.name), track); byId("timeline").append(lane); laneElements.set(agent.id, track);
      if (!agent.control && agent.connectToMemory !== false) {
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); const start = (memoryAgents.findIndex(item => item.id === agent.id) + .5) * 1000 / memoryAgents.length;
        path.setAttribute("d", `M ${start} 247 C ${start} 277, 500 253, 500 285`); path.setAttribute("class", "connection-path"); path.style.setProperty("--flow-color", agent.color ?? colors[index % colors.length]); byId("connections").append(path); paths.set(agent.id, path);
      }
    }
    configureProfiles(profiles);
    icons();
    layoutNetwork();
  }
  function load(report, live = false) {
    const next = normalizeRecording(report);
    const changed = recording?.report.runId !== report?.runId || recording?.agents.map(agent => agent.id).join() !== next.agents.map(agent => agent.id).join();
    const wasFollowing = following && recording?.report.status === "recording";
    recording = next;
    following = live && report.status === "recording";
    if (changed) {
      position = following || reducedMotion.matches ? next.durationMs : 0;
      playing = !following && !reducedMotion.matches && next.events.length > 0;
      activityProjection = null; displayedGraphIds.clear(); knowledgeKey = ""; timelineKey = "";
      lastEventCount = -1; artifactShown = false; selectedId = null; makeRoster(next.agents);
      refreshHumanReviews();
    }
    if (following) { position = next.durationMs; playing = false; }
    else if (wasFollowing) { position = next.durationMs; playing = false; }
    byId("project-title").textContent = next.memoryLab ? "Knowledge Formation" : next.rediscovery ? report.plan?.profile === "quality" ? "Knowledge Quality" : report.plan?.profile === "mechanism" ? "Investigation Learning" : "Knowledge Reuse"
      : report.title ?? next.source.protocol?.title ?? "Session expiry investigation";
    byId("project-kicker").textContent = next.control ? "LEARNING TRANSFER / A + B + C" : "SHARED BUILD / FIVE AGENTS";
    if (next.memoryLab) byId("project-kicker").textContent = next.agents.some(agent => agent.control) ? "FIVE INVESTIGATORS / FIVE DALEK CONTROLS" : "DURABLE KNOWLEDGE / FIVE INVESTIGATORS";
    if (next.rediscovery) byId("project-kicker").textContent = report.plan?.profile === "quality" ? "OUTCOME QUALITY / FOUR MATCHED ARMS" : "REDISCOVERY / THREE MAIN ARMS + DIAGNOSTIC";
    byId("task-description").textContent = next.control
      ? "Investigate and fix session expiry. A and B work independently; C repeats the task with no memory, A-only memory, and A+B memory. The same immutable checks decide correctness."
      : report.problem ?? "Build a session-expiry app: create named sessions, count down their lifetime, validate inputs, remove sessions, and clear expired entries. Five owners. Eighteen fixed checks.";
    for (const agent of next.agents) agentElements.get(agent.id).modelText.textContent = modelName(agent.model ?? report.agent?.model);
    byId("run-meta").textContent = `${report.agent?.model ?? report.plan?.model ?? "Model not recorded"} / ${String(report.runId ?? "recording").slice(0, 8)}`;
    byId("provenance").textContent = `${report.realMcpProcess && report.realModel !== false ? "MCP CAPTURE" : "TEST DOUBLE / NOT A LIVE-MODEL RESULT"} / ${report.createdAt ?? "Date not recorded"}`;
    byId("fingerprint").textContent = `BINARY ${String(report.binarySha256 ?? "not recorded").slice(0, 16)} / ${next.events.length} EVENTS`;
    byId("comparisons").style.display = next.control ? "block" : "none";
    byId("network-title").textContent = next.rediscovery ? "Fresh Investigation Arms" : next.control ? "Learning Transfer" : next.memoryLab ? "Memory Investigation Relay" : "Build Network";
    byId("app-frame").closest("section").classList.toggle("hidden", next.memoryLab || next.control || next.rediscovery);
    byId("artifact-team").classList.toggle("hidden", next.memoryLab || next.rediscovery || !next.agents.some(agent => agent.control));
    byId("lab2-results").classList.toggle("hidden", !next.memoryLab);
    byId("storage-counts").classList.toggle("hidden", !next.memoryLab && !next.rediscovery);
    byId("run").querySelector("span").textContent = next.memoryLab || next.rediscovery ? "Run experiment" : "Run build";
    byId("download").disabled = false;
    byId("replay-activity").disabled = !next.events.length;
    renderComparisons(); renderKnowledge(); renderKnowledgeOutcomes(); configureStudyMode(); renderStudyProgress(); navigateView(); render(true);
  }
  function renderStudyProgress() {
    const history = recording?.report.study ?? (recording?.report.runId && recording.report.status !== "recording" ? studyProgress(recording.report) : null);
    const key = JSON.stringify(history);
    if (key === studyKey) return;
    studyKey = key;
    byId("study-progress").classList.toggle("hidden", !history?.runs?.length);
    byId("study-cost-summary").classList.toggle("hidden", !history?.runs?.length);
    if (!history?.runs?.length) return;
    byId("study-status").textContent = `Study ${String(history.studyId).slice(0, 8)} / ${history.runs.length} recorded runs`;
    byId("study-note").textContent = ["mechanism", "quality"].includes(recording?.report.plan?.profile) ? "Fresh-case investigation study. Revised principles require new validation cases; this profile does not continue exposed runs."
      : history.taskExposure === "previously_exposed"
      ? "Continued experience with fresh sessions. Repeated tasks are exposed, not independent holdouts; improvement is not guaranteed. All earlier outcomes remain recorded."
      : "Fresh study. Continue learning retains this experience for later fresh agent sessions.";
    const names = { mindleak: "MindLeak", original: "Original Knowledge", fresh: "Fresh agent", notebook: "Notebook", daleks: "Daleks", direct: "Direct diagnostic" };
    const body = byId("study-run-body"); body.replaceChildren();
    for (const [index, run] of history.runs.entries()) {
      const row = element("tr");
      for (const value of [`${index + 1} / ${String(run.runId).slice(0, 8)} / ${run.status}`, Object.entries(run.arms).map(([arm, result]) => `${names[arm] ?? arm}: ${result.correct}/${result.scheduled}`).join("; ") || "No verified outcomes recorded",
        `${run.observations} / ${run.chains} / ${run.principles}`]) row.append(element("td", "", value));
      body.append(row);
    }
    const chart = byId("study-curve"); chart.replaceChildren();
    chart.classList.toggle("hidden", history.runs.length < 2);
    const svg = (tag, attributes, text) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
    if (history.runs.length > 1) {
      for (const rate of [0, .5, 1]) chart.append(svg("line", { x1: 55, x2: 765, y1: 150 - rate * 120, y2: 150 - rate * 120, stroke: "#bdc9db" }), svg("text", { x: 42, y: 154 - rate * 120, "text-anchor": "end" }, `${rate * 100}%`));
      for (const [arm, color] of [["mindleak", "#145ee0"], ["notebook", "#008655"], ["fresh", "#a33b32"], ["daleks", "#a33b32"]]) {
        const points = history.runs.flatMap((run, index) => {
          const result = run.arms[arm];
          return result?.scheduled > 0 ? [`${55 + index * 710 / (history.runs.length - 1)},${150 - result.correct / result.scheduled * 120}`] : [];
        });
        if (points.length) { const line = svg("polyline", { points: points.join(" "), stroke: color, fill: "none", "stroke-width": 3, "data-arm": arm }); line.append(svg("title", {}, names[arm])); chart.append(line); }
      }
      chart.append(svg("text", { x: 55, y: 179 }, "Run 1"), svg("text", { x: 765, y: 179, "text-anchor": "end" }, `Run ${history.runs.length}`));
    }
    byId("study-cost-summary").textContent = `Study totals, all ${history.runs.length} runs: ${count(history.totals.inputTokens)} agent input / ${count(history.totals.outputTokens)} output tokens; ${count(history.totals.memoryInputTokens)} memory input / ${count(history.totals.memoryOutputTokens)} output tokens. Earlier preparation and failed attempts remain included; unknown usage is not estimated.`;
  }
  function renderComparisons() {
    byId("control-costs").classList.toggle("hidden", !recording?.memoryLab || !recording.report.controlExperiment);
    byId("rediscovery-results").classList.toggle("hidden", !recording?.rediscovery);
    byId("rediscovery-costs").classList.toggle("hidden", !recording?.rediscovery);
    const quality = qualityComparison(recording?.report);
    byId("quality-results").classList.toggle("hidden", !quality);
    if (quality) {
      const names = { fresh: "Fresh Agent", notebook: "Notebook", original: "Original Knowledge", mindleak: "Reviewed Knowledge" };
      byId("quality-status").textContent = `${quality.measured} / ${quality.scheduled} measured`;
      const body = byId("quality-result-body"); body.replaceChildren();
      for (const [arm, values] of Object.entries(quality.arms)) {
        const row = element("tr"); row.dataset.arm = arm;
        for (const value of [names[arm] ?? arm, `${values.correct} / ${values.scheduled}`,
          ...["behavior", "boundary", "regression"].map(group => `${values.dimensions[group].passed} / ${values.dimensions[group].scheduled}`),
          `${values.checkedDecisions} / ${values.scheduled}`, values.correctRejections, values.unmeasuredTasks]) row.append(element("td", "", String(value)));
        body.append(row);
      }
      const pairs = byId("quality-pair-body"); pairs.replaceChildren();
      for (const pair of quality.comparisons) {
        const row = element("tr");
        for (const value of [pair.caseId, pair.originalChecks === null ? "--" : `${pair.originalChecks} / 8`,
          pair.revisedChecks === null ? "--" : `${pair.revisedChecks} / 8`, pair.checksDelta === null ? "--" : `${pair.checksDelta > 0 ? "+" : ""}${pair.checksDelta}`]) row.append(element("td", "", value));
        pairs.append(row);
      }
    }
    if (recording?.rediscovery) {
      const report = recording.report; const body = byId("rediscovery-result-body"); body.replaceChildren();
      const names = { fresh: "Fresh Agent", notebook: "Notebook", original: "Original Knowledge", mindleak: "MindLeak", direct: "Direct / diagnostic" };
      byId("rediscovery-protocol-status").textContent = report.plan ? `${report.plan.profile} / ${report.plan.memoryUse === "knowledge_first" ? "knowledge-first" : report.plan.memoryUse === "optional" ? "optional adoption" : "recorded policy"} / ${report.plan.mainSessions} main + ${report.plan.diagnosticSessions} diagnostic / frozen v${report.plan.protocolVersion}` : "Preparing frozen protocol";
      const results = report.outcomes ?? recording.events.filter(event => event.type === "rediscovery_task_finished" && event.phaseScope === "evaluation")
        .map(event => ({ ...event, id: event.caseId, arm: event.agent }));
      for (const outcome of results) {
        const row = element("tr"); row.tabIndex = 0;
        const disposition = outcome.knowledgeWorkflow?.assessment?.decision ?? outcome.knowledgeWorkflow?.decision ?? outcome.decision?.knowledgeDecision;
        for (const value of [outcome.id, names[outcome.arm], outcome.correct ? "Passed" : "Unresolved", outcome.reuseObserved ? disposition === "adapt" ? "Adapted / verified change" : "Before verified change" : ({ reject: "Rejected after assessment", no_match: "Lookup returned no match", unavailable: "Lookup failed / local fix" })[disposition] ?? (outcome.priorKnowledgeDelivered ? "Retrieved only" : "Not consulted"),
          Array.isArray(outcome.knownFailureCandidates) ? outcome.knownFailureCandidates.length : outcome.knownFailureCandidates ?? "--", Number.isFinite(outcome.firstVerifiedFixMs) ? formatElapsed(outcome.firstVerifiedFixMs) : "--"]) row.append(element("td", "", String(value)));
        const inspect = () => {
          byId("rediscovery-inspector").classList.remove("hidden");
          byId("rediscovery-inspector").textContent = JSON.stringify({ id: outcome.id, fixture: outcome.fixtureSha256, correct: outcome.correct,
            decision: outcome.decision, decisionCorrect: outcome.decisionCorrect, observationIds: outcome.observationIds,
            knowledgeWorkflow: outcome.knowledgeWorkflow, quality: outcome.quality, knowledgeVersion: outcome.knowledgeVersion,
            priorKnowledgeDelivered: outcome.priorKnowledgeDelivered, changedConditionAdaptation: outcome.changedConditionAdaptation,
            priorImplementationInvalidated: outcome.priorImplementationInvalidated, staleMistakeObserved: outcome.staleMistakeObserved,
            experienceAccesses: outcome.experienceAccesses, reads: outcome.reads, writes: outcome.writes, probes: outcome.probes, finalTests: outcome.finalTests,
            candidateFiles: report.candidates?.[outcome.id] }, null, 2);
        };
        row.addEventListener("click", inspect); row.addEventListener("keydown", event => { if (event.key === "Enter") inspect(); }); body.append(row);
      }
      const costs = byId("rediscovery-cost-body"); costs.replaceChildren();
      for (const [arm, values] of Object.entries(report.metrics?.arms ?? {})) {
        const row = element("tr");
        for (const value of [names[arm], `${values.correct} / ${values.scheduled}`, `${count(values.totalInputTokens)} / ${count(values.totalOutputTokens)}`,
          Number.isFinite(values.totalElapsedMs) ? formatElapsed(values.totalElapsedMs) : "--", Number.isFinite(values.actualCostUsd) ? `$${values.actualCostUsd.toFixed(4)}` : "Not reported"]) row.append(element("td", "", value));
        costs.append(row);
      }
      const chart = byId("rediscovery-cost-curve"); chart.replaceChildren(); const curve = report.metrics?.curve ?? [];
      const svg = (tag, attributes, text) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text) node.textContent = text; return node; };
      const ceiling = Math.max(1, ...curve.flatMap(point => [point.freshCostMs, point.notebookCostMs, point.mindleakCostMs].filter(Number.isFinite))) / 1000;
      const x = index => curve.length < 2 ? 420 : 62 + index * 700 / (curve.length - 1);
      for (const fraction of [0, .5, 1]) chart.append(svg("text", { x: 52, y: 152 - fraction * 125 + 4, "text-anchor": "end" }, `${Math.round(ceiling * fraction)}s`), svg("line", { x1: 62, x2: 762, y1: 152 - fraction * 125, y2: 152 - fraction * 125, stroke: "#bdc9db" }));
      for (const [arm, color] of [["mindleak", "#145ee0"], ["notebook", "#008655"], ["fresh", "#a33b32"]]) if (curve.length && curve.every(point => Number.isFinite(point[`${arm}CostMs`]))) {
        const line = svg("polyline", { points: curve.map((point, index) => `${x(index)},${152 - point[`${arm}CostMs`] / 1000 / ceiling * 125}`).join(" "), stroke: color, fill: "none", "stroke-width": 3, "data-arm": arm });
        line.append(svg("title", {}, `${names[arm]} cumulative elapsed seconds, including allocated preparation`)); chart.append(line);
      }
      for (const [index, point] of curve.entries()) chart.append(svg("text", { x: x(index), y: 178, "text-anchor": "middle" }, `R${point.round}`));
    }
    const builds = recording?.report.buildComparison;
    byId("build-results").classList.toggle("hidden", !builds);
    if (builds) {
      const body = byId("build-result-body"); body.replaceChildren();
      for (const [condition, label] of [["withMemory", "MindLeak Team"], ["withoutMemory", "Daleks"]]) {
        const team = builds[condition]; const row = element("tr");
        for (const value of [label, `${team.codePassedComponents ?? team.agentsPassed}/5`, `${team.finalTests?.passedTests ?? 0}/18`, team.memoryAccess === "none" ? "None" : "Read + write", formatElapsed(team.elapsedMs)]) row.append(element("td", "", value));
        body.append(row);
      }
    }
    if (recording?.memoryLab) {
      const body = byId("lab2-result-body"); body.replaceChildren();
      const experiment = recording.report.controlExperiment;
      const head = byId("lab2-result-head"); head.replaceChildren();
      const paired = Boolean(experiment || recording.events.some(event => event.type === "control_started"));
      for (const label of paired ? ["Round / Case", "MindLeak", "Dalek", "Runtime M / D", "Guide applied", "Time M / D"]
        : ["Agent / Case", "Without memory", "With guide", "Memory received", "Guide revision", "Time to verified answer"]) head.append(element("th", "", label));
      if (paired) {
        const live = new Map();
        for (const event of recording.events) if (event.type === "control_arm_finished") {
          const key = `${event.round}:${event.caseId}`;
          if (!live.has(key)) live.set(key, { round: event.round, caseId: event.caseId });
          live.get(key)[event.condition] = event;
        }
        const pairs = experiment ? experiment.rounds.flatMap(round => round.pairs) : [...live.values()];
        for (const pair of pairs) {
          const memory = pair.withMemory; const control = pair.withoutMemory;
          const verdict = outcome => outcome ? outcome.passed ? "Passed" : "Failed" : "Running";
          const runtime = outcome => outcome?.verification?.upgradeProbe ? `${outcome.verification.upgradeProbe.passedTests}/${outcome.verification.upgradeProbe.expectedTests}` : "--";
          const row = element("tr");
          for (const value of [`${pair.round} / ${pair.caseId}`, verdict(memory), verdict(control), `${runtime(memory)} / ${runtime(control)}`,
            memory?.guideApplied ? "Yes" : "--", `${memory?.elapsedMs ? formatElapsed(memory.elapsedMs) : "--"} / ${control?.elapsedMs ? formatElapsed(control.elapsedMs) : "--"}`]) row.append(element("td", "", value));
          body.append(row);
        }
      } else for (const actor of recording.report.agents.filter(actor => !actor.control)) {
        const attempts = actor.attempts ?? []; const withMemory = attempts.filter(attempt => attempt.condition === "withMemory").at(-1);
        const without = attempts.filter(attempt => attempt.condition === "withoutMemory").at(-1);
        const revision = recording.report.knowledge?.operations?.filter(operation => operation.actor === actor.id && operation.kind === "principle" && operation.operation === "accept").at(-1)?.revision;
        const row = element("tr");
        for (const value of [actor.name + (withMemory?.caseId ? ` / ${withMemory.caseId}` : ""), without ? without.passed ? "Passed" : "Failed" : "Independent seed", withMemory ? withMemory.passed ? "Passed" : "Failed" : "Pending",
          withMemory?.knowledgeReceived ? "Yes" : "--", revision ?? "--", `${without?.investigationMs ? formatElapsed(without.investigationMs) : "--"} / ${withMemory?.investigationMs ? formatElapsed(withMemory.investigationMs) : "--"}`]) row.append(element("td", "", String(value)));
        body.append(row);
      }
      byId("comparison-scope").textContent = paired ? "Matched models / concurrent starts / immutable checks" : "Guide preparation / verified source evidence";
      byId("control-costs").classList.toggle("hidden", !experiment);
      if (experiment) {
        const summary = experiment.summary; const memory = summary.withMemory; const controls = summary.withoutMemory;
        const cost = byId("control-cost-body"); cost.replaceChildren();
        const tokenPair = (input, output) => `${count(input)} / ${count(output)}`;
        const time = value => Number.isFinite(value) ? formatElapsed(value) : "--";
        for (const values of [
          ["Correct decisions", `${memory.correct} / ${summary.scheduledPairs}`, `${controls.correct} / ${summary.scheduledPairs}`],
          ["Assessment agent input / output", tokenPair(memory.inputTokens, memory.outputTokens), tokenPair(controls.inputTokens, controls.outputTokens)],
          ["Preparation agent input / output", tokenPair(memory.preparationInputTokens, memory.preparationOutputTokens), "0 / 0"],
          ["Review agent input / output", tokenPair(memory.learningInputTokens, memory.learningOutputTokens), "0 / 0"],
          ["Total agent input / output", tokenPair(memory.totalInputTokens, memory.totalOutputTokens), tokenPair(controls.inputTokens, controls.outputTokens)],
          ["Memory SLM input / output", tokenPair(summary.memoryProcessing.inputTokens, summary.memoryProcessing.outputTokens), "0 / 0"],
          ["Assessment wall time", time(memory.wallMs), time(controls.wallMs)],
          ["Wall time including preparation + review", time(memory.totalWallMs), time(controls.wallMs)],
        ]) { const row = element("tr"); for (const value of values) row.append(element("td", "", value)); cost.append(row); }
        const percent = value => Number.isFinite(value) ? `${value.toFixed(1)}%` : "--";
        byId("control-round-savings").textContent = experiment.rounds.map(round => `R${round.number}: ${percent(round.summary?.savings.includingPreparationInputPercent)}`).join(" / ");
        byId("control-cost-note").textContent = summary.savings.eligible
          ? `Agent input savings: ${percent(summary.savings.assessmentInputPercent)} assessment only; ${percent(summary.savings.includingPreparationInputPercent)} including preparation and review. Memory SLM usage is separate. Shared provider contention affects concurrent timing.`
          : "Savings are not comparable across incomplete, incorrect or unexposed pairs. All recorded costs and failures remain included.";
      }
    }
    const body = byId("comparison-body"); body.replaceChildren();
    const trial = recording?.source.trials?.[0];
    if (!recording?.control || !trial) return;
    for (const [key, label] of [["withoutMemory", "No memory"], ["afterAgentA", "Agent A only"], ["afterAgentsAB", "Agents A + B"]]) {
      const result = trial.conditions?.[key]; const comparison = trial.comparisons?.[key]; const row = element("tr");
      const saved = comparison?.completionTimeReductionPercent;
      for (const value of [label, result ? result.success ? "Passed" : "Failed" : "Unmeasured", result ? formatElapsed(result.elapsedMs) : "--",
        count(result?.inputTokens), count(result?.toolCalls), Number.isFinite(saved) ? `${saved.toFixed(1)}%` : "--"]) row.append(element("td", "", value));
      row.lastElementChild.className = Number.isFinite(saved) ? saved >= 0 ? "positive" : "negative" : "";
      row.lastElementChild.title = comparison?.savingsIneligibleReason ?? "Measured on correct, exposed comparisons";
      body.append(row);
    }
  }
  function eventLabel(event) {
    const types = {
      run_started: ["workflow", "Build started", `${event.agents ?? 3} agents`], agent_state: [event.state === "passed" ? "circle-check" : "bot", event.state?.toUpperCase(), ""],
      attempt_started: ["play", `Attempt ${event.attempt}`, ""], inference_started: ["cpu", `${event.workload === "memory" ? "SLM" : "LLM"} inference / ${event.phase ?? "tools"}`, modelName(event.model)],
      inference_finished: [event.errorCode ? "triangle-alert" : "cpu", `${modelName(event.model)} / ${event.finishReason ?? "response"}`, `${count(event.inputTokens)} in + ${count(event.outputTokens)} out / ${((event.elapsedMs ?? 0) / 1000).toFixed(1)}s`],
      memory_saved: ["database", event.replayed ? "Receipt replayed" : "Memory published", `${event.fragments ?? 0} fragments`],
      memory_delivered: ["git-merge", `${nameFor(event.from)} \u2192 ${nameFor(event.agent)}`, `${event.fragments} fragments delivered`],
      collaboration_checked: [event.completed ? "handshake" : "triangle-alert", event.completed ? "Component handoff verified" : "Component handoff incomplete", `${event.published ? "Published" : "Not published"} / ${event.receivedDependencies?.length ?? 0} of ${event.requiredDependencies?.length ?? 0} dependency sources read`],
      memory_delivery: ["git-merge", "Memory exposure verified", `A: ${event.agentA ? "yes" : "no"} / B: ${event.agentB ? "yes" : "no"}`],
      confirmation: ["shield-check", "Independent result confirmed", `${event.confirmedSessionsBefore} \u2192 ${event.confirmedSessionsAfter} confirmations`],
      snapshot: ["copy", "A-only snapshot isolated", `${event.records} records`],
      knowledge_written: ["database", `${event.kind} / ${event.operation}`, `${event.revision ? `revision ${event.revision} / ` : ""}${event.savedAt ?? ""}`],
      persistence_verified: ["shield-check", "Durable memory recovered", `${event.records} records / PID ${event.previousPid ?? "?"} → ${event.currentPid ?? "?"}`],
      guide_extracted: ["book-open-check", "Solution guide extracted from MindLeak", `revision ${event.revision}`],
      guide_applied: ["git-merge", `Guide r${event.revision} applied / ${event.caseId}`, `${event.steps} cited steps / ${event.sourceObservations} source observations`],
      observation_inspected: ["file-search", "Stored source inspected", String(event.fragmentId ?? "").slice(0, 12)],
      guide_phase_started: ["book-open-check", "Guide-authoring phase", event.caseId],
      guide_phase_finished: [event.passed ? "circle-check" : "triangle-alert", "Guide-authoring phase finished", `revision ${event.revision ?? "--"}`],
      evidence_phase_started: ["database", "Evidence-capture phase", event.caseId],
      evidence_phase_finished: [event.passed ? "circle-check" : "triangle-alert", "Case chain stored and accepted", event.chainId ?? "Incomplete"],
      preparation_finished: ["book-open-check", "Guide preparation finished", event.status],
      control_started: ["git-compare-arrows", "Dalek comparison started", `${event.rounds} rounds / 10 agents`],
      control_guide_frozen: ["lock-keyhole", `Round ${event.round} / guide frozen`, `revision ${event.revision} / read-only comparison`],
      control_round_started: ["play", `Round ${event.round} / simultaneous start`, `${event.readySessions} sessions ready`],
      control_arm_finished: [event.passed ? "circle-check" : "triangle-alert", `Round ${event.round} / ${event.caseId}`, `${event.condition} / ${count(event.inputTokens)} input / ${formatElapsed(event.elapsedMs)}`],
      control_round_finished: ["flag", `Round ${event.round} complete`, `${event.correct}/10 correct decisions`],
      round_learning_started: ["book-open-check", `Round ${event.round} / learning review`, "Comparison finished"],
      round_learning_finished: ["book-open-check", `Round ${event.round} / review finished`, `guide revision ${event.revision}`],
      control_finished: ["flag", "Dalek comparison finished", event.status],
      build_team_started: ["workflow", `${event.condition === "withoutMemory" ? "Dalek" : "MindLeak"} build started`, "Isolated Session Desk project"],
      build_team_finished: ["flag", `${event.condition === "withoutMemory" ? "Dalek" : "MindLeak"} build finished`, event.status],
      build_team_tests: [event.passed ? "circle-check" : "flask-conical", `${event.condition === "withoutMemory" ? "Dalek" : "MindLeak"} build checks`, `${event.passedTests}/${event.expectedTests}`],
      control_application_ready: ["panels-top-left", "Dalek application built", String(event.sha256).slice(0, 16)],
      rediscovery_task_started: ["scan-search", "Fresh investigation", event.family],
      rediscovery_task_finished: [event.correct ? "circle-check" : "triangle-alert", event.correct ? "Verified task" : "Unresolved task", `${event.reuseObserved ? "Prior experience before passing change" : "No observed reuse"} / ${event.stage}`],
      rediscovery_round_started: ["lock-keyhole", `Frozen round ${event.round}`, event.stage],
      rediscovery_round_finished: ["shield-check", `Round ${event.round} finished`, event.frozenUnchanged ? "Experience unchanged during comparison" : "Freeze check failed"],
      rediscovery_review_started: ["book-open-check", "Between-round learning review", `Round ${event.round}`],
      rediscovery_review_finished: ["book-open-check", "Learning review finished", event.outcome],
      experience_access: ["book-open", event.tool, `${event.lessonIds?.length ?? 0} lessons / ${event.bytes} bytes`],
      direct_experience_delivered: ["file-input", "Prior lesson supplied directly", `Diagnostic / revision ${event.revision}`],
      candidate_changed: ["file-pen", "Candidate implementation changed", event.path],
      prior_implementation_checked: ["flask-conical", "Old implementation rechecked", event.invalidated ? "Current contract invalidates the old implementation" : "Old implementation still passes"],
      memory_checkpoint: ["list-checks", "Memory checkpoint", event.ready ? "Complete" : (event.nextActions ?? []).join(", ")],
      memory_read: ["database", event.tool, `${count(event.bytes)} bytes / ${Math.round(event.elapsedMs ?? 0)} ms`],
      memory_duplicate_reused: ["copy-check", "Existing memory reused", String(event.memoryId ?? "").slice(0, 12)],
      upgrade_probe: [event.passed ? "circle-check" : "flask-conical", `Upgrade / ${event.targetVersion ?? "unchanged"} / ${event.adapterMode}`, `${event.passedTests}/${event.expectedTests} runtime tests`],
      session_stopped: ["pause", "Model session stopped", event.reason ?? "idle"],
      assessment_finished: [event.passed ? "circle-check" : "triangle-alert", `Assessment / ${event.caseId}`, `${event.condition} / ${event.checksPassed} checks`],
      tests: [event.passed ? "circle-check" : "flask-conical", `${event.passedTests ?? 0} / ${event.expectedTests ?? 0} checks passed`, event.phase ?? ""],
      application_ready: ["panels-top-left", "Application built", String(event.sha256).slice(0, 16)],
      run_finished: ["flag", "Run finished", event.status], stage_started: ["play", "Stage started", event.condition ?? ""], stage_finished: [event.success ? "circle-check" : "triangle-alert", "Stage finished", event.condition ?? event.status],
    };
    if (event.type === "tool_finished") {
      const exhibit = recording?.report.toolExhibits?.find(item => item.toolCallId === event.toolCallId);
      const detail = event.fixturePath ?? exhibit?.arguments?.query ?? event.arguments?.fragmentId ?? event.errorCode
        ?? (event.tool === "run_tests" ? `${event.passedTests ?? "?"}/${event.expectedTests ?? "?"} checks / ${(event.failedTests ?? []).join(", ")}` : `${event.resultBytes ?? "?"} bytes / ${Math.round(event.elapsedMs ?? 0)} ms`);
      return [event.ok ? ({ read_file: "file-code", write_file: "file-pen", search_files: "search", recall_memory: "database", write_memory: "database", run_tests: "flask-conical" })[event.tool] ?? "wrench" : "triangle-alert", event.providerTool ?? event.tool, detail];
    }
    return types[event.type] ?? ["activity", event.type.replaceAll("_", " "), event.reason ?? ""];
  }
  function renderEvents(state, force) {
    const filter = byId("event-filter").value;
    if (!force && lastEventCount === state.visibleEvents.length && lastFilter === filter) return;
    lastEventCount = state.visibleEvents.length; lastFilter = filter;
    const selected = state.visibleEvents.filter(event => event.type !== "tool_started" && (filter === "all"
      || filter === "memory" && (/memory|confirmation|snapshot|knowledge|persistence|guide_|observation_|collaboration/.test(event.type) || event.workload === "memory")
      || filter === "code" && event.type === "tool_finished" && /file|search/.test(event.tool)
      || filter === "tests" && (["tests", "upgrade_probe", "control_arm_finished"].includes(event.type) || event.tool === "run_tests")
      || filter === "llm" && event.type.startsWith("inference") && event.workload !== "memory"
      || filter === "slm" && event.type.startsWith("inference") && event.workload === "memory")).slice(-300);
    const list = byId("events"); const previousScroll = list.scrollTop;
    updatingEvents = true;
    list.replaceChildren(); byId("event-count").textContent = String(state.visibleEvents.length);
    if (!selected.length) list.append(element("div", "event-empty", "Awaiting telemetry"));
    for (const event of selected) {
      const [symbol, title, detail] = eventLabel(event); const row = element("div", `event-row${event.id === selectedId ? " selected" : ""}`); row.tabIndex = 0; row.setAttribute("role", "button");
      row.dataset.eventId = String(event.id);
      row.dataset.kind = event.errorCode || /error/.test(event.type) ? "error" : /memory|confirmation/.test(event.type) ? "memory" : event.type.startsWith("inference") ? event.workload === "memory" ? "slm" : "llm" : "ordinary";
      const glyph = element("span", "event-icon"); glyph.append(icon(symbol)); const body = element("div"); body.append(element("div", "event-title", title), element("div", "event-detail", detail));
      row.append(element("span", "event-time", formatElapsed(event.atMs).slice(0, 5)), glyph, body, element("span", "event-agent", nameFor(event.agent)));
      const inspect = () => {
        selectedId = event.id; const inspector = byId("inspector"); inspector.replaceChildren();
        const exhibit = recording.report.toolExhibits?.find(item => item.toolCallId === event.toolCallId);
        const fields = Object.fromEntries(Object.entries(event).filter(([key]) => ["id", "agent", "type", "condition", "caseId", "providerTool", "tool", "toolCallId", "model", "workload", "phase", "turn", "finishReason", "elapsedMs", "inputTokens", "outputTokens", "cachedInputTokens", "reasoningTokens", "resultBytes", "sourceSha256", "errorCode", "memoryId", "arguments", "failedTests", "savedAt", "revision", "kind", "operation", "previousPid", "currentPid", "checkedIds"].includes(key)));
        if (exhibit) fields.arguments = { ...fields.arguments, ...exhibit.arguments };
        for (const [label, value] of Object.entries(fields)) { const item = element("div", "inspector-item"); item.append(element("strong", "", label), element("span", "", typeof value === "object" ? JSON.stringify(value) : String(value))); inspector.append(item); }
        renderEvents(state, true);
      };
      row.addEventListener("click", inspect); row.addEventListener("keydown", key => { if (key.key === "Enter") inspect(); }); list.append(row);
    }
    list.scrollTop = followEvents ? list.scrollHeight : previousScroll;
    byId("follow-events").setAttribute("aria-pressed", String(followEvents));
    requestAnimationFrame(() => { updatingEvents = false; });
    icons();
  }
  function renderMemories(state) {
    const saved = state.visibleEvents.filter(event => event.type === "memory_saved");
    const unique = [...new Map(saved.map(event => [event.memoryId, event])).values()].slice(-3).reverse();
    const exhibits = recording.report.memoryExhibits ?? [];
    const key = JSON.stringify([unique.map(event => event.id), exhibits.map(record => record.memoryId)]);
    if (key === memoryBoardKey) return;
    memoryBoardKey = key;
    const board = byId("memory-board"); board.replaceChildren();
    byId("memory-board-count").textContent = `${state.memories.size} saved`;
    if (!unique.length) board.append(element("p", "memory-blank", "Awaiting a saved finding"));
    for (const event of unique) {
      const record = exhibits.find(item => item.memoryId === event.memoryId);
      const card = element("article", "memory-card");
      card.style.setProperty("--agent-color", recording.agents.find(agent => agent.id === event.agent)?.color ?? "#168761");
      const header = element("div", "memory-card-header"); header.append(element("span", "memory-owner", nameFor(event.agent)), element("span", "memory-time", formatElapsed(event.atMs)));
      const text = Array.isArray(record?.fragments) ? record.fragments.map(fragment => fragment.text).join("\n") : null;
      card.append(header, element("div", text ? "memory-body" : "memory-receipt", text ?? `${event.fragments} fragments committed`),
        element("span", "memory-id", String(event.memoryId ?? "Receipt not recorded")));
      if (position - event.atMs < 2000) card.classList.add("memory-pulse");
      board.append(card);
    }
  }
  function renderTimeline() {
    if (!recording) return;
    const key = `${recording.events.length}:${Math.floor(recording.durationMs / 1000)}`;
    if (key === timelineKey) { for (const lane of laneElements.values()) if (lane.lastElementChild) lane.lastElementChild.style.left = `${Math.min(100, position / recording.durationMs * 100)}%`; return; }
    timelineKey = key;
    for (const [agentId, lane] of laneElements) {
      lane.replaceChildren(); const metadata = recording.agents.find(agent => agent.id === agentId);
      for (const event of recording.events) if (event.agent === agentId && event.type === "inference_finished") {
        const bar = element("span", "lane-bar"); const duration = event.elapsedMs ?? 0;
        bar.style.left = `${Math.max(0, event.atMs - duration) / recording.durationMs * 100}%`; bar.style.width = `${duration / recording.durationMs * 100}%`; bar.style.background = metadata.color;
        bar.title = `Model / ${(duration / 1000).toFixed(1)}s / ${count(event.inputTokens)} in / ${count(event.outputTokens)} out`; lane.append(bar);
      }
      for (const event of recording.events) if (event.agent === agentId && /memory_saved|memory_delivered|confirmation/.test(event.type)) {
        const mark = element("span", "lane-marker"); mark.style.left = `${event.atMs / recording.durationMs * 100}%`; mark.title = eventLabel(event)[1]; lane.append(mark);
      }
      const cursor = element("span", "lane-cursor"); cursor.style.left = `${Math.min(100, position / recording.durationMs * 100)}%`; lane.append(cursor);
    }
  }
  function renderActivity(state) {
    const advancing = playing || following && recording.report.status === "recording";
    const moving = advancing && !reducedMotion.matches;
    document.documentElement.dataset.motion = moving ? "running" : "paused";
    const activity = memoryActivity(recording, position, advancing, playing ? Number(byId("speed").value) : 1);
    byId("memory-activity").dataset.active = String(moving && activity.active);
    byId("activity-mode").textContent = advancing ? following ? "LIVE" : "RECORDED REPLAY" : position >= recording.durationMs ? "RUN FINISHED" : "PAUSED";
    byId("activity-phase").textContent = activity.forming ? "Forming knowledge" : activity.writing ? "Storing evidence" : activity.reading ? "Retrieving experience"
      : activity.processing ? "Memory model processing" : activity.pulses.length ? "Record acknowledged" : advancing ? "No memory request in flight" : "Replay available";
    for (const [name, count] of [["reading", activity.reading], ["writing", activity.writing], ["forming", activity.forming]]) {
      const item = byId(`activity-${name}`); item.querySelector("strong").textContent = String(count); item.dataset.active = String(count > 0);
    }
    document.querySelector(".hub").dataset.active = String(moving && activity.active);
    for (const [id, view] of agentElements) {
      const actor = state.agents[id];
      view.card.dataset.working = String(moving && actor?.state === "running" && (actor.inference !== null || actor.pendingTools.size > 0));
    }
    const key = JSON.stringify([moving, activity.flows, activity.pulses]);
    if (key === activityKey) return;
    activityKey = key;
    byId("memory-packets")?.remove(); byId("stage-graph-packets")?.remove();
    const pulses = new Set(moving ? activity.pulses.map(pulse => pulse.nodeId).filter(Boolean) : []);
    for (const node of document.querySelectorAll(".knowledge-hero-node")) node.dataset.active = String(pulses.has(node.dataset.nodeId));
    for (const edge of document.querySelectorAll(".knowledge-hero-edge")) edge.dataset.active = String(pulses.has(edge.dataset.to));
    if (!moving) return;
    const graphPackets = document.createElementNS("http://www.w3.org/2000/svg", "g"); graphPackets.id = "stage-graph-packets"; graphPackets.setAttribute("aria-hidden", "true");
    for (const edge of document.querySelectorAll('.knowledge-hero-edge[data-active="true"]')) {
      const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle"); packet.setAttribute("r", "5"); packet.setAttribute("fill", "#145ee0"); packet.setAttribute("class", "stage-graph-packet");
      const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion"); motion.setAttribute("path", edge.getAttribute("d")); motion.setAttribute("dur", "1.1s"); motion.setAttribute("repeatCount", "indefinite");
      packet.append(motion); graphPackets.append(packet);
    }
    byId("knowledge-hero-graph").append(graphPackets);
    const group = document.createElementNS("http://www.w3.org/2000/svg", "g"); group.id = "memory-packets"; group.setAttribute("aria-hidden", "true");
    const signals = [...activity.flows, ...activity.pulses.filter(pulse => !activity.flows.some(flow => flow.agent === pulse.agent))].slice(0, 12);
    for (const signal of signals) {
      const path = paths.get(signal.agent); if (!path) continue;
      const packet = document.createElementNS("http://www.w3.org/2000/svg", "circle");
      packet.setAttribute("r", signal.kind === "form" ? "5" : "4"); packet.setAttribute("fill", signal.kind === "read" ? "#145ee0" : signal.kind === "form" ? "#a16b00" : "#008655"); packet.setAttribute("class", "memory-packet");
      const motion = document.createElementNS("http://www.w3.org/2000/svg", "animateMotion");
      motion.setAttribute("path", path.getAttribute("d")); motion.setAttribute("dur", "0.85s"); motion.setAttribute("repeatCount", activity.flows.some(flow => flow.id === signal.id) ? "indefinite" : "1");
      motion.setAttribute("keyPoints", signal.kind === "read" ? "1;0" : "0;1"); motion.setAttribute("keyTimes", "0;1"); motion.setAttribute("calcMode", "linear");
      packet.append(motion); group.append(packet);
    }
    byId("connections").append(group);
  }
  function renderLab3Story(advancing) {
    const story = lab3Story(recording, position);
    byId("lab3-story").classList.toggle("hidden", !story);
    if (!story) return;
    const key = JSON.stringify(story);
    if (key === lab3StoryKey) return;
    const previousKey = lab3StoryKey; lab3StoryKey = key; lab3NextMoment = story.nextMoment;
    const seek = atMs => { if (!Number.isFinite(atMs)) return; following = false; playing = false; position = atMs; render(true); };
    const chapters = byId("lab3-chapters"); chapters.replaceChildren();
    for (const chapter of story.chapters) {
      const button = element("button", "lab3-chapter"); button.append(icon(chapter.icon), document.createTextNode(chapter.label));
      button.disabled = chapter.atMs === null;
      if (story.phase === chapter.id) button.setAttribute("aria-current", "step");
      button.title = chapter.atMs === null ? "No recorded event yet" : `Jump to ${chapter.label.toLowerCase()} / ${formatElapsed(chapter.atMs)}`;
      button.addEventListener("click", () => seek(chapter.atMs)); chapters.append(button);
    }
    const current = story.cases.find(item => item.id === story.currentCase) ?? story.cases[0];
    const stages = { near: "FAMILIAR PATTERN", generalization: "A NEW ANGLE", changed: "CONTRACT CHANGED", irrelevant: "A DIFFERENT FAULT" };
    const names = { fresh: "Fresh Agent", notebook: "Notebook", original: "Original Knowledge", mindleak: "MindLeak", direct: "Direct / diagnostic" };
    const armColors = { fresh: "#a33b32", notebook: "#008655", original: "#a16b00", mindleak: "#145ee0", direct: "#a16b00" };
    const inCases = story.phase === "transfer" || story.phase === "finished";
    byId("lab3-case-eyebrow").textContent = inCases && current ? `${stages[current.stage] ?? "NEW CASE"} / ${story.cases.indexOf(current) + 1} OF ${story.cases.length}` : "INVESTIGATION IN PROGRESS";
    byId("lab3-case-title").textContent = inCases && current ? current.title : { discover: "Find something worth keeping", form: "Connect the evidence", validate: "Does the rule survive?", review: "What changed what we know?" }[story.phase] ?? "The investigation begins";
    const active = current?.arms.find(actor => actor.state === "working");
    byId("lab3-case-meta").textContent = inCases && current ? `${current.label} / ${active ? `${names[active.arm]} investigating` : `${current.arms.filter(actor => ["passed", "unresolved"].includes(actor.state)).length} of ${current.arms.length} outcomes recorded`}`
      : { discover: "SOURCE EVIDENCE", form: "OBSERVATIONS / CHAINS / PRINCIPLES", validate: "PREDICT / EXECUTE / CHECK", review: "EXCEPTIONS / REVISIONS / NO NEW LEARNING" }[story.phase] ?? "";
    byId("lab3-next-moment").disabled = story.nextMoment === null;
    const lanes = byId("lab3-case-lanes"); lanes.replaceChildren(); lanes.classList.toggle("hidden", !inCases || !current);
    for (const actor of current?.arms ?? []) {
      const lane = element("article", "lab3-lane"); lane.dataset.state = actor.state; lane.style.setProperty("--lane-color", armColors[actor.arm] ?? "#145ee0");
      const title = element("div", "lab3-lane-name"); const avatar = element("span", "agent-symbol"); avatar.append(makeAgentFace());
      title.append(avatar, element("span", "", names[actor.arm] ?? actor.arm));
      lane.append(title, element("strong", "lab3-lane-state", { queued: "On deck", working: "Investigating", passed: "Checks passed", unresolved: "Unresolved" }[actor.state]),
        element("p", "lab3-lane-note", actor.reused ? "Prior evidence before verified change" : actor.retrieval === "received" ? "Prior evidence received" : actor.retrieval === "miss" ? "Search returned no lesson" : actor.state === "queued" ? "No recorded attempt yet" : "No prior evidence recorded"));
      lanes.append(lane);
    }
    const prediction = story.prediction; const predictionPanel = byId("lab3-prediction");
    predictionPanel.classList.toggle("hidden", story.phase !== "validate" || !prediction);
    if (prediction) {
      predictionPanel.dataset.verdict = prediction.verdict ?? "pending";
      predictionPanel.dataset.reveal = String(Boolean(advancing && previousKey && prediction.verdict));
      byId("lab3-prediction-title").textContent = { matched: "Prediction matched the check", mismatch: "The check challenged the prediction", execution_failed: "The check could not complete" }[prediction.verdict] ?? "Prediction locked in";
      byId("lab3-prediction-detail").textContent = `${names[prediction.arm] ?? prediction.arm} / ${prediction.caseId} / expected ${prediction.expectedPass ? "pass" : "failure"}${prediction.actualPass === null ? "" : ` / observed ${prediction.actualPass ? "pass" : "failure"}`}`;
    }
    const caseList = byId("lab3-case-list"); caseList.replaceChildren(); caseList.classList.toggle("hidden", !inCases);
    for (const [index, item] of story.cases.entries()) {
      const button = element("button", "lab3-case-button"); button.append(icon(item.arms.every(actor => actor.state === "passed") ? "circle-check" : "scan-search"), document.createTextNode(`${index + 1} / ${stages[item.stage] ?? item.stage ?? "Case"}`));
      button.disabled = item.firstAt === null; button.setAttribute("aria-pressed", String(current?.id === item.id)); button.title = `${item.title} / ${item.label}`;
      button.addEventListener("click", () => seek(item.lastAt)); caseList.append(button);
    }
    icons();
  }
  byId("lab3-next-moment").addEventListener("click", () => { if (lab3NextMoment === null) return; following = false; playing = false; position = lab3NextMoment; render(true); });
  function renderStage(state, activity) {
    renderReviewControls();
    const build = recording.report.kind === "swarm_build";
    const memoryActors = recording.agents.filter(agent => !agent.control);
    const advancing = playing || following && recording.report.status === "recording";
    const moving = advancing && !reducedMotion.matches;
    renderLab3Story(advancing && !reducedMotion.matches);
    const busy = moving && activity.phase !== "ready" && activity.phase !== "finished";
    const memory = memoryActivity(recording, position, advancing, playing ? Number(byId("speed").value) : 1);
    byId("knowledge-machine").dataset.active = String(moving && memory.active);
    byId("machine-clock").textContent = formatElapsed(position);
    byId("machine-clock-label").textContent = following ? "LIVE ELAPSED" : "RECORDED TIME";
    byId("machine-mode").textContent = advancing ? following ? "LIVE" : "RECORDED REPLAY" : activity.phase === "finished" ? "RUN FINISHED" : "PAUSED";
    const memoryOperation = memory.flows.at(-1);
    const lastRecord = state.visibleEvents.findLast(event => event.type === "knowledge_written");
    byId("machine-operation").textContent = memory.forming ? "Assembling knowledge" : memory.writing ? "Filing source evidence" : memory.reading ? "Following the evidence" : memory.processing ? "Extracting observations"
      : lastRecord ? `${lastRecord.kind === "principle" ? "Principle" : lastRecord.kind === "chain" ? "Chain" : "Source episode"} ${lastRecord.operation === "accept" ? "accepted" : lastRecord.operation === "revise" ? "revised" : "recorded"}` : "Source collection ready";
    byId("machine-operation-detail").textContent = memoryOperation ? `${nameFor(memoryOperation.agent)} / ${memoryOperation.kind} operation`
      : `${activity.knowledge.observations.length} source episodes / ${activity.knowledge.chains.length} chains / ${activity.acceptedPrinciples} accepted principles`;
    byId("machine-ledger-note").textContent = `${activity.gained.observations} new sources / ${activity.gained.chains} new chains / ${activity.gained.principles} new principles / ${advancing ? following ? "live recorded operations" : "replaying recorded operations" : position >= recording.durationMs ? "recording complete" : "recording paused"}`;
    const acknowledged = new Set(moving ? memory.pulses.map(pulse => pulse.nodeId) : []);
    for (const record of document.querySelectorAll(".machine-record")) record.dataset.pulse = String(acknowledged.has(record.dataset.recordId));
    byId("live-stage").dataset.busy = String(busy);
    const memoryActive = activity.activeAgents.filter(agent => !agent.control).length;
    const controlActive = activity.activeAgents.filter(agent => agent.control).length;
    byId("stage-heading").textContent = build && !memoryActive && controlActive ? "Control team building" : { thinking: build ? "Agents building" : "Agents investigating", working: build ? "Build in motion" : "Investigation in motion", capturing: build ? "Publishing verified findings" : "Capturing experience", extracting: "Extracting observations", forming: "Forming new knowledge", retrieving: build ? "Reading dependency handoffs" : "Knowledge in action", finished: "Run captured", ready: "MindLeak at work" }[activity.phase];
    byId("stage-run").textContent = `RUN ${recording.report.study?.sequence ?? 1} / ${String(recording.report.runId ?? "").slice(0, 8)} / ${build ? `${memoryActive} MEMORY + ${controlActive} CONTROL ACTIVE` : `${activity.activeAgents.length} ACTIVE`}`;
    byId("stage-clock").textContent = formatElapsed(position);
    byId("stage-clock-label").textContent = following ? "LIVE ELAPSED" : "RECORDED TIME";
    const number = (id, value) => {
      const field = byId(id); const next = String(value);
      if (field.textContent !== next) {
        field.textContent = next;
        if (moving) field.animate([{ transform: "translateY(-5px)", color: "#008655" }, { transform: "translateY(0)" }], { duration: 450 });
      }
    };
    number("stage-tasks", `${activity.successfulTasks}/${activity.scheduledTasks ?? "?"}`);
    byId("stage-tasks").previousElementSibling.textContent = build ? "OWNERS READY" : "TASKS VERIFIED";
    number("stage-actions", activity.actions); number("stage-sources", activity.knowledge.observations.length); number("stage-principles", build ? state.handoffs.size : activity.acceptedPrinciples);
    byId("stage-principles").previousElementSibling.textContent = build ? "TEAM HANDOFFS" : "PRINCIPLES ACCEPTED";
    byId("stage-task-note").textContent = `${activity.completedTasks} checked / ${activity.completedTasks - activity.successfulTasks} unresolved`;
    byId("stage-source-note").textContent = `+${activity.gained.observations} new / ${activity.inherited.observations} inherited`;
    byId("stage-principle-note").textContent = build ? "Recorded cross-agent deliveries" : `+${activity.gained.principles} new / ${activity.inherited.principles} inherited`;
    byId("stage-progress").max = Math.max(1, activity.scheduledTasks ?? 1);
    byId("stage-progress").value = activity.completedTasks;
    for (const [id, view] of stageAgents) {
      const actor = state.agents[id]; view.item.dataset.busy = String(busy && actor?.state === "running");
      view.action.textContent = actor?.state === "running" ? actor.action : actor?.state ?? "Waiting";
      view.item.title = `${nameFor(id)} / ${modelName(recording.agents.find(agent => agent.id === id)?.model)} / ${view.action.textContent}`;
    }
    const current = activity.currentTools.at(-1);
    const generating = [...state.visibleEvents].reverse().find(event => event.type === "inference_started" && state.agents[event.agent]?.inference === event.atMs);
    const detail = current && recording.report.toolExhibits?.find(item => item.toolCallId === current.toolCallId);
    byId("stage-action").textContent = current ? `${nameFor(current.agent)} / ${current.tool.replaceAll("_", " ")}` : generating ? `${nameFor(generating.agent)} / ${generating.workload === "memory" ? "memory extraction" : "working on the next step"}` : activity.phase === "finished" ? "Recorded run complete" : "Between recorded operations";
    byId("stage-target").textContent = current ? detail?.arguments?.path ?? detail?.arguments?.query ?? `${formatElapsed(position - current.atMs)} request elapsed`
      : generating ? `${modelName(generating.model)} / ${formatElapsed(position - generating.atMs)} elapsed` : build ? `${memoryActors.reduce((total, actor) => total + state.agents[actor.id].storedMemories.size, 0)} agent-published findings / ${state.handoffs.size} cross-agent deliveries` : `${activity.knowledge.chains.length} chains / ${activity.reusedTasks} verified reuses`;
    const memberIds = new Set(memoryActors.map(agent => agent.id));
    const earned = build ? { observations: state.visibleEvents.some(event => memberIds.has(event.agent) && event.type === "tool_finished" && event.tool === "write_file" && event.ok),
      chains: state.visibleEvents.some(event => memberIds.has(event.agent) && (event.type === "tests" && event.passed && event.phase !== "baseline" || event.type === "tool_finished" && event.tool === "run_tests" && event.testsPassed)),
      principles: memoryActors.some(actor => state.agents[actor.id].storedMemories.size > 0), reuse: state.handoffs.size > 0 }
      : { observations: activity.knowledge.observations.length > 0, chains: activity.knowledge.chains.length > 0, principles: activity.acceptedPrinciples > 0, reuse: activity.reusedTasks > 0 };
    const workflow = build ? "build" : "knowledge";
    if (byId("live-stage").dataset.workflow !== workflow) {
      byId("live-stage").dataset.workflow = workflow;
      const labels = { observations: ["file-code", "CODED"], chains: ["flask-conical", "VERIFIED"], principles: ["database", "PUBLISHED"], reuse: ["git-merge", "SHARED"] };
      for (const badge of document.querySelectorAll(".stage-milestone")) {
        if (build) { const [symbol, label] = labels[badge.dataset.stage]; badge.replaceChildren(icon(symbol), document.createTextNode(label)); }
        else badge.replaceChildren(...knowledgeMilestones.get(badge.dataset.stage).map(node => node.cloneNode(true)));
      }
      icons();
    }
    for (const badge of document.querySelectorAll(".stage-milestone")) {
      const next = String(earned[badge.dataset.stage]);
      if (moving && next === "true" && badge.dataset.earned === "false") badge.animate([{ transform: "scale(1)" }, { transform: "scale(1.08)" }, { transform: "scale(1)" }], { duration: 650 });
      badge.dataset.earned = next;
    }
    byId("stage-mode-note").textContent = following ? "LIVE / current run events" : playing ? "RECORDED REPLAY / no new model calls" : "PAUSED / recorded events";
    const feedKey = activity.milestones.map(event => event.id).join(":");
    if (feedKey !== stageFeedKey) {
      stageFeedKey = feedKey; const feed = byId("stage-feed"); feed.replaceChildren();
      for (const event of activity.milestones) {
        const [symbol, title, eventDetail] = eventLabel(event); const row = element("div", "stage-event"); row.dataset.kind = event.kind ?? event.type;
        const copy = element("div"); const node = [...activity.knowledge.principles, ...activity.knowledge.chains].find(node => node.chainId === event.nodeId);
        const label = event.type === "tool_finished" ? ({ read_file: "Source inspected", search_files: "Repository searched", write_file: "Code updated", run_tests: "Checks executed", inspect_observation: "Evidence recovered", inspect_guide_sources: "Knowledge inspected", recall_guide: "Principles retrieved", recall_experience: "Experience retrieved", record_observation: "Observation stored", propose_chain: "Evidence connected", propose_guide: "Principle proposed", accept_knowledge: "Knowledge accepted", retain_lesson: "Principle retained" })[event.tool] ?? title : title;
        copy.append(element("strong", "", event.type === "knowledge_written" ? `${event.kind === "principle" ? "Principle" : event.kind === "chain" ? "Chain" : "Observation"} / ${event.operation}` : label),
          element("small", "", node?.document?.claim ?? `${nameFor(event.agent)} / ${eventDetail || formatElapsed(event.atMs)}`));
        row.append(icon(symbol), copy); feed.append(row);
      }
      if (!activity.milestones.length) feed.append(element("p", "outcome-note", "Awaiting the first recorded action"));
      icons();
    }
  }
  function render(force = false) {
    if (!recording) return;
    const state = replayState(recording, position);
    activityProjection = runActivity(recording, position, state);
    byId("input-tokens").textContent = `${count(state.inputTokens)}${state.unknownInput ? " + ?" : ""}`;
    byId("output-tokens").textContent = `${count(state.outputTokens)}${state.unknownOutput ? " + ?" : ""}`;
    byId("memory-input-tokens").textContent = `${count(state.memoryInputTokens)}${state.unknownMemoryInput ? " + ?" : ""}`;
    byId("memory-output-tokens").textContent = `${count(state.memoryOutputTokens)}${state.unknownMemoryOutput ? " + ?" : ""}`;
    byId("slm-model").textContent = modelName(recording.report.memoryProcessing?.model ?? (recording.report.configuration?.decomposition === "openai" ? recording.report.configuration.decompositionModel : "off"));
    byId("slm-activity").textContent = state.memoryInferences.size ? `${state.memoryInferences.size} extraction in flight` : `${state.memoryCalls} extraction calls`;
    byId("handoffs").textContent = count(state.handoffs.size); byId("memory-note").textContent = `${state.memories.size} published memories`;
    if (recording.memoryLab) byId("memory-note").textContent = `${state.guideApplications.length} guide applications / ${state.inspectedObservations.size} sources read`;
    byId("checks").textContent = `${state.checks} / ${recording.expectedTests}`;
    if (recording.memoryLab) byId("storage-counts").textContent = `${state.storageOperations.length} writes / ${state.observationIds.size} observations / ${state.chainIds.size} chains / ${state.principleIds.size} principles / ${state.persistenceChecks.length} verified restarts / ${state.guideApplications.length} guide applications`;
    const networkAgents = recording.agents.filter(agent => !agent.control);
    const controlAgents = recording.agents.filter(agent => agent.control);
    const active = activityProjection.phase === "finished" ? 0 : networkAgents.filter(agent => state.agents[agent.id]?.state === "running").length;
    const generating = Object.values(state.agents).filter(agent => agent.inference !== null).length;
    byId("token-activity").dataset.active = String(generating > 0); byId("input-note").textContent = generating ? `${generating} inference${generating === 1 ? "" : "s"} in flight` : "Reported consumption";
    byId("output-note").textContent = `${state.toolCalls} tool calls`;
    byId("network-meta").textContent = `${networkAgents.length} agents / ${active} active`;
    const phase = [...state.visibleEvents].reverse().find(event => ["control_round_started", "control_round_finished", "round_learning_started", "round_learning_finished"].includes(event.type));
    byId("control-phase").textContent = phase ? `ROUND ${phase.round} / ${phase.type.startsWith("round_learning") ? "LEARNING REVIEW" : phase.type.endsWith("started") ? "RUNNING" : "FINISHED"} / NO MINDLEAK` : `${controlAgents.length} agents / ${activityProjection.phase === "finished" ? 0 : controlAgents.filter(agent => state.agents[agent.id]?.state === "running").length} active / NO MINDLEAK`;
    byId("hub-count").textContent = `MCP / ${state.memories.size} writes / ${state.handoffs.size} handoffs`;
    byId("last-transfer").textContent = state.lastTransfer ? `${nameFor(state.lastTransfer.from)} \u2192 ${nameFor(state.lastTransfer.agent)}` : "";
    for (const [id, view] of agentElements) {
      const agent = state.agents[id]; view.card.dataset.state = agent.state; view.status.textContent = agent.state;
      view.value.textContent = `${count(agent.inputTokens + agent.outputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.value.title = `${count(agent.inputTokens)} input / ${count(agent.outputTokens)} output`;
      view.inputValue.textContent = `${count(agent.inputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.outputValue.textContent = `${count(agent.outputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.stored.textContent = count(agent.storedMemories.size);
      view.used.textContent = view.control ? "0" : recording.report.kind === "swarm_build" ? count(agent.receivedHandoffs.size) : agent.useMeasured ? count(agent.linkedUses.size) : "--";
      view.action.textContent = agent.inference === null ? agent.action : `Generating / ${((position - agent.inference) / 1000).toFixed(1)}s`;
      paths.get(id)?.classList.toggle("active", state.transfers.some(event => event.agent === id || event.from === id));
    }
    const finished = position >= recording.durationMs && recording.report.status !== "recording";
    const status = finished ? recording.report.status : following ? "live" : playing ? "playing" : "paused";
    byId("state").textContent = status === "completed" ? "RUN FINISHED" : status === "partial" ? "RUN INCOMPLETE" : status === "cancelled" ? "RUN STOPPED" : status.toUpperCase();
    byId("state").dataset.state = status === "completed" ? "finished" : status;
    byId("time-current").textContent = formatElapsed(position); byId("time-total").textContent = formatElapsed(recording.durationMs);
    byId("scrubber").value = String(Math.min(1000, position / recording.durationMs * 1000));
    byId("play").setAttribute("aria-label", playing || following ? "Pause replay" : "Play replay");
    const playIcon = byId("play").firstElementChild;
    const wanted = playing || following ? "pause" : "play";
    if (playIcon?.getAttribute("data-lucide") !== wanted) { byId("play").replaceChildren(icon(wanted)); icons(); }
    renderEvents(state, force); renderTimeline(); renderMemories(state); renderKnowledge(); renderKnowledgeOutcomes(); renderActivity(state); renderStage(state, activityProjection);
    const application = currentApplication();
    const ready = artifactTeam === "daleks" ? state.controlApplicationReady : state.applicationReady;
    const artifactKey = ready && application?.html ? `${artifactTeam}:${application.sha256}` : null;
    if (artifactKey && artifactShown !== artifactKey) {
      const policy = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src data:; style-src data: &#39;unsafe-inline&#39;; img-src data:; font-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">';
      byId("app-frame").srcdoc = policy + application.html; byId("app-frame").style.display = "block"; byId("app-pending").classList.add("hidden");
      byId("app-address").textContent = `session-desk / ${artifactTeam === "daleks" ? "Dalek" : "MindLeak"} verified build`; byId("artifact-meta").textContent = `SHA256 ${application.sha256}`;
      byId("open-app").disabled = false; byId("download-app").disabled = false; artifactShown = artifactKey;
    } else if (!artifactKey && artifactShown) {
      byId("app-frame").srcdoc = ""; byId("app-frame").style.display = "none"; byId("app-pending").classList.remove("hidden"); artifactShown = false;
      byId("open-app").disabled = true; byId("download-app").disabled = true;
    }
  }
  byId("play").addEventListener("click", () => { if (!recording) return; if (following) { following = false; playing = false; } else { if (position >= recording.durationMs) position = 0; playing = !playing; } render(true); });
  byId("reset").addEventListener("click", () => { following = false; playing = false; position = 0; render(true); });
  byId("next").addEventListener("click", () => { if (!recording) return; following = false; playing = false; position = recording.events.find(event => event.atMs > position + .01)?.atMs ?? recording.durationMs; render(true); });
  byId("scrubber").addEventListener("input", () => { if (!recording) return; following = false; playing = false; position = Number(byId("scrubber").value) / 1000 * recording.durationMs; render(true); });
  byId("event-filter").addEventListener("change", () => render(true));
  byId("follow-events").addEventListener("click", () => { followEvents = !followEvents; if (recording) renderEvents(replayState(recording, position), true); });
  byId("events").addEventListener("scroll", () => {
    if (updatingEvents) return;
    const list = byId("events"); followEvents = list.scrollHeight - list.clientHeight - list.scrollTop < 28;
    byId("follow-events").setAttribute("aria-pressed", String(followEvents));
  });
  byId("go-live").addEventListener("click", () => { if (!recording) return; following = recording.report.status === "recording"; playing = false; position = recording.durationMs; followEvents = true; render(true); });
  byId("replay-activity").addEventListener("click", () => {
    if (!recording) return;
    const first = recording.events.find(event => ["memory_saved", "knowledge_written", "experience_access", "memory_delivered"].includes(event.type));
    following = false; playing = true; position = Math.max(0, (first?.atMs ?? 1000) - 1000); followEvents = true; render(true);
  });
  reducedMotion.addEventListener("change", () => { activityKey = ""; if (recording) render(true); });
  byId("problem-input").addEventListener("input", event => { draft.problem = event.target.value; });
  byId("concurrency-input").addEventListener("input", event => { draft.concurrency = Number(event.target.value); });
  byId("attempts-input").addEventListener("input", event => { draft.attempts = Number(event.target.value); });
  byId("rounds-input").addEventListener("input", event => { draft.rounds = Number(event.target.value); });
  byId("rediscovery-profile-select").addEventListener("change", event => { draft.rediscoveryProfile = event.target.value; configureStudyMode(); });
  byId("study-fresh").addEventListener("change", () => { continueLearning = false; configureStudyMode(); });
  byId("study-continue").addEventListener("change", () => { continueLearning = true; configureStudyMode(); });
  for (const team of ["memory", "daleks"]) byId(`artifact-${team}`).addEventListener("click", () => {
    artifactTeam = team;
    for (const candidate of ["memory", "daleks"]) byId(`artifact-${candidate}`).setAttribute("aria-selected", String(candidate === team));
    render(true);
  });
  byId("memory-model-select").addEventListener("change", event => { draft.memoryModel = event.target.value; byId("memory-model-status").textContent = `Next run: ${modelName(draft.memoryModel)}`; });
  byId("download-guide").addEventListener("click", () => {
    const guide = recording?.report.guide ?? recording?.report.knowledge?.guide;
    const guides = recording?.report.knowledge?.guides ?? recording?.report.guides;
    const markdown = guides?.length ? guides.map(item => item.markdown).join("\n\n") : guide?.markdown ?? recording?.report.knowledge?.lessons?.map(lesson => lesson.markdown).join("\n\n");
    if (markdown) save(markdown, "mindleak-solution-guide.md", "text/markdown");
  });
  byId("download-knowledge").addEventListener("click", () => { if (recording?.report.knowledge) save(JSON.stringify(recording.report.knowledge, null, 2), "mindleak-durable-knowledge.json", "application/json"); });
  window.addEventListener("hashchange", navigateView);
  window.addEventListener("resize", () => { if (recording && !byId("knowledge-page").classList.contains("hidden")) { knowledgeKey = ""; render(true); } });
  byId("load").addEventListener("click", () => byId("file-input").click());
  byId("file-input").addEventListener("change", async event => { const file = event.target.files[0]; if (!file) return; try { if (file.size > 16 * 1024 * 1024) throw new Error("Recording exceeds 16 MiB"); load(JSON.parse(await file.text())); } catch { notify("Recording could not be opened"); } event.target.value = ""; });
  byId("download").addEventListener("click", () => { if (recording) save(JSON.stringify(recording.report, null, 2), `mindleak-${recording.report.runId}.json`, "application/json"); });
  byId("download-app").addEventListener("click", () => { const application = currentApplication(); if (application?.html) save(application.html, artifactTeam === "daleks" ? "session-desk-daleks.html" : "session-desk.html", "text/html"); });
  byId("open-app").addEventListener("click", () => { const application = currentApplication(); if (!application?.html) return; const url = URL.createObjectURL(new Blob([sandboxApplicationPage(application.html)], { type: "text/html" })); window.open(url, "_blank", "noopener,noreferrer"); setTimeout(() => URL.revokeObjectURL(url), 30000); });
  const command = async operation => { try { const response = await fetch(`${apiBase}/${operation}`, { method: "POST", headers: { "content-type": "application/json", "x-mindleak-demo": "1" }, body: JSON.stringify(operation === "run" && profiles ? { ...draft, continueFrom: continueLearning ? recording?.report.runId : null } : {}) }); if (!response.ok) throw new Error(); if (operation === "run") { following = true; byId("mission").open = false; } } catch { notify(`Could not ${operation} the demo; check the selected models, parent run and limits or an active run in another lab`); } };
  byId("run").addEventListener("click", () => command("run")); byId("stop").addEventListener("click", () => command("stop"));
  byId("run").classList.toggle("hidden", !initial.live); byId("stop").classList.toggle("hidden", !initial.live); byId("go-live").classList.toggle("hidden", !initial.live); byId("download").disabled = true;
  makeRoster((profiles?.roles ?? defaultAgents).map((agent, index) => ({ ...agent, color: agent.color ?? colors[index % colors.length] })));
  if (profiles?.experiment === 3) {
    byId("project-title").textContent = draft.rediscoveryProfile === "mechanism" ? "Investigation Learning" : "Knowledge Reuse"; byId("project-kicker").textContent = "THREE MAIN ARMS / DIRECT-LESSON DIAGNOSTIC";
    byId("task-description").textContent = draft.problem; byId("run").querySelector("span").textContent = "Run experiment";
    byId("network-title").textContent = "Fresh Investigation Arms"; byId("network-meta").textContent = "Randomized / one session at a time";
    byId("app-frame").closest("section").classList.add("hidden"); byId("rediscovery-results").classList.remove("hidden");
  byId("checks").textContent = `0 / ${draft.rediscoveryProfile === "mechanism" ? 54 : draft.rediscoveryProfile === "pilot" ? 495 : ["learning", "adoption"].includes(draft.rediscoveryProfile) ? 135 : 27}`;
  } else if (profiles?.experiment === 2) {
    byId("project-title").textContent = "Knowledge Formation"; byId("project-kicker").textContent = "FIVE INVESTIGATORS / FIVE DALEK CONTROLS";
    byId("task-description").textContent = draft.problem; byId("run").querySelector("span").textContent = "Run experiment";
    byId("checks").textContent = `0 / ${35 + 70 * (draft.rounds ?? 2)}`;
    byId("network-title").textContent = "Knowledge Formation Relay";
    byId("network-meta").textContent = "5 investigators + 5 Daleks / ready";
    byId("app-frame").closest("section").classList.add("hidden");
    byId("lab2-results").classList.remove("hidden");
    byId("comparison-scope").textContent = "Matched models / concurrent starts / immutable checks";
    byId("storage-counts").classList.remove("hidden");
    byId("storage-counts").textContent = "0 observations / 0 chains / 0 principles";
  } else if (profiles?.roles?.some(role => role.control)) {
    byId("project-kicker").textContent = "FIVE BUILDERS / FIVE DALEK CONTROLS";
    byId("network-meta").textContent = "5 builders + 5 Daleks / ready";
    byId("checks").textContent = "0 / 36";
    byId("artifact-team").classList.remove("hidden");
  }
  if (initial.report) load(initial.report, Boolean(initial.live));
  navigateView(); renderKnowledge(); renderKnowledgeOutcomes();
  if (initial.live) {
    const stream = new EventSource(`${apiBase}/events`);
    stream.onopen = () => { byId("connection").dataset.connected = "true"; byId("connection").textContent = "Live connected"; };
    stream.onerror = () => { byId("connection").dataset.connected = "false"; byId("connection").textContent = "Reconnecting"; };
    stream.addEventListener("snapshot", message => { const data = JSON.parse(message.data); runActive = data.running; byId("run").disabled = data.running; byId("stop").disabled = !data.running; configureProfiles(data.profiles); if (data.report) load(data.report, data.running); });
    stream.addEventListener("record", message => { if (!recording) return; const event = JSON.parse(message.data); if (recording.events.some(existing => existing.id === event.id)) return; if (event.type === "run_started") recording.report.runId = event.runId; recording.events.push(event); recording.report.events = recording.events; recording.durationMs = Math.max(recording.durationMs, event.atMs); if (following) position = recording.durationMs; if (["control_started", "control_arm_finished", "rediscovery_task_finished", "quality_checked"].includes(event.type)) renderComparisons(); render(true); });
    stream.addEventListener("memory", message => { if (!recording) return; const record = JSON.parse(message.data); const exhibits = recording.report.memoryExhibits ??= []; if (!exhibits.some(item => item.memoryId === record.memoryId)) exhibits.push(record); render(true); });
    stream.addEventListener("tool-detail", message => { if (!recording) return; const detail = JSON.parse(message.data); const exhibits = recording.report.toolExhibits ??= []; if (!exhibits.some(item => item.toolCallId === detail.toolCallId)) exhibits.push(detail); });
    stream.addEventListener("knowledge", message => { if (!recording) return; const knowledge = JSON.parse(message.data); recording.report.knowledge = { ...recording.report.knowledge, ...knowledge }; if (knowledge.guide) recording.report.guide = knowledge.guide; renderComparisons(); render(true); });
  }
  function frame(now) {
    const delta = Math.min(1000, now - frameTime); frameTime = now;
    if (recording) {
      const advancing = following || playing;
      if (following && recording.report.status === "recording") { recording.durationMs = Math.max(recording.durationMs, Date.now() - Date.parse(recording.report.createdAt)); position = recording.durationMs; }
      else if (playing) {
        position = Math.min(recording.durationMs, position + delta * Number(byId("speed").value));
        if (position >= recording.durationMs) { if (byId("replay-loop").checked && !reducedMotion.matches) position = 0; else playing = false; }
      }
      if (advancing && now - lastRenderAt >= 80) { lastRenderAt = now; render(); }
    }
    requestAnimationFrame(frame);
  }
  icons(); requestAnimationFrame(frame);
}

if (typeof window !== "undefined" && typeof document !== "undefined") initializeReplay();
