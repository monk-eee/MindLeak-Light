const colors = ["#145ee0", "#d73537", "#008655", "#a16b00", "#953ecc"];
const defaultAgents = [
  { id: "atlas", name: "Atlas", title: "Time Engine", icon: "timer" },
  { id: "iris", name: "Iris", title: "Input Policy", icon: "shield-check" },
  { id: "nova", name: "Nova", title: "Session Store", icon: "database" },
  { id: "vega", name: "Vega", title: "Interface", icon: "panels-top-left" },
  { id: "orion", name: "Orion", title: "Integration", icon: "workflow" },
];

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
    for (let index = 0; index < expectedPreparation; index += 1) {
      const outcome = report.preparation?.[index];
      add(outcome?.id ?? `preparation-${index + 1}`, outcome?.id ?? `Preparation ${index + 1}`, outcome, outcome?.finalTests, outcome?.correct, 3);
    }
    const outcomes = new Map((report.outcomes ?? []).map(outcome => [outcome.id, outcome]));
    for (const planned of report.plan.sessions ?? []) {
      const outcome = outcomes.get(planned.id);
      add(planned.id, `${planned.arm}${planned.diagnostic ? " (diagnostic)" : ""}: ${planned.id}`, outcome, outcome?.finalTests, outcome?.correct, 3);
    }
  } else if (report.kind === "swarm_build") {
    for (const actor of report.agents ?? []) {
      const attempt = actor.attempts?.at(-1);
      add(actor.id, actor.name, attempt, attempt?.verification, actor.state === "passed" && attempt?.passed === true);
    }
    if (report.buildComparison) for (const [condition, label] of [["withMemory", "MindLeak integration"], ["withoutMemory", "Dalek integration"]]) {
      const team = report.buildComparison[condition];
      add(condition, label, team, team?.finalTests, team?.status === "completed", 18);
    }
    else if (report.finalTests) add("integration", "Full application integration", { status: report.status }, report.finalTests, report.finalTests.passed, 18);
  } else if (report.kind === "memory_lab") {
    for (const actor of (report.agents ?? []).filter(actor => !actor.control)) {
      const attempt = actor.attempts?.filter(attempt => attempt.phase !== "control" && attempt.condition === "withMemory").at(-1);
      add(`preparation:${actor.id}`, `${actor.name}: preparation`, attempt, attempt?.verification);
    }
    for (const round of report.controlExperiment?.rounds ?? []) for (const pair of round.pairs) for (const condition of ["withMemory", "withoutMemory"]) {
      const outcome = pair[condition];
      add(`${pair.id}:${condition}`, `Round ${round.number}: ${outcome?.name ?? condition} / ${pair.caseId}`, outcome, outcome?.verification);
    }
    const planned = (report.controlExperiment?.plan?.pairs?.length ?? 0) * 2 + (report.agents ?? []).filter(actor => !actor.control).length;
    while (items.length < planned) add(`unrecorded-${items.length}`, "Unrecorded scheduled task", null, null, false);
  }
  const executionStatus = { recording: "running", completed: "finished", partial: "incomplete", cancelled: "stopped" }[report.status] ?? "not_started";
  const passed = items.filter(item => item.status === "passed").length;
  const failed = items.filter(item => item.status === "failed").length;
  const incomplete = items.filter(item => item.status === "incomplete").length;
  const requirementsStatus = !items.length ? "not_measured" : incomplete ? "incomplete" : failed ? "failed" : "passed";
  const qualityAreas = ["Browser behaviour", "Responsive layout", "Accessibility", "Security", "Maintainability"];
  const qualityChecks = (report.qualityReviews ?? []).filter(review => qualityAreas.includes(review.area) && review.artifactSha256
    && [report.application?.sha256, report.controlApplication?.sha256].includes(review.artifactSha256)
    && typeof review.method === "string" && review.method.length > 0 && Number.isSafeInteger(review.checks) && review.checks > 0
    && Number.isSafeInteger(review.passedChecks) && review.passedChecks >= 0 && review.passedChecks <= review.checks);
  const unreviewed = qualityAreas.filter(area => !qualityChecks.some(review => review.area === area && review.passedChecks === review.checks));
  const observedUses = (report.outcomes ?? []).filter(outcome => outcome.arm === "mindleak" && !outcome.diagnostic && outcome.correct === true && outcome.reuseObserved === true).length;
  return { execution: { status: executionStatus },
    requirements: { status: requirementsStatus, passed, failed, incomplete, scheduled: items.length, unresolved: items.length - passed, items },
    quality: { status: qualityChecks.some(review => review.passedChecks !== review.checks) ? "failed" : !qualityChecks.length ? "not_reviewed" : unreviewed.length ? "partial_review" : "reviewed",
      checks: qualityChecks, unreviewed },
    learning: { status: observedUses ? "observed_use" : "not_established", observedUses, advantage: "not_established",
      explanation: "Observed reuse is separate from passing requirements. These synthetic runs do not establish a general learning advantage." },
    releaseReady: false, scope: "Acceptance checks for these fixtures only; not a production quality or security certification." };
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
    return { evaluatedTasks: memory?.completed ?? 0, successfulTasks: memory?.correct ?? 0,
      reuse: { kind: "temporal_change", tasks: memory?.knowledgeReuse.successful ?? 0, rate: memory?.knowledgeReuse.rate ?? null, evidence: memory?.knowledgeReuse.evidence ?? "Prior exposure before a changed passing candidate" },
      transfer: { attempts: memory?.transfer.attempts ?? 0, successful: memory?.transfer.successful ?? 0, rate: memory?.transfer.attempts ? memory.transfer.successful / memory.transfer.attempts : null,
        evidence: "A new transfer task with prior experience delivered before a changed passing implementation. All retrieval misses remain in the main-arm correctness result." },
      chains: { created: chains.size, used: memory?.usedChainIds.length ?? 0, rate: chains.size && memory ? memory.usedChainIds.length / chains.size : null,
        status: memory ? "observed" : "not_measured", evidence: "Direct chain inspection before a changed passing candidate, not every transitive support." },
      compression: { observations: observations.size, chains: chains.size, principles: principles.size, observationsPerPrinciple: principles.size ? observations.size / principles.size : null, semanticQuality: "not_measured" },
      mistakesAvoided: { rate: null, count: null, status: "known_failure_candidates_only", withMemory: memory?.knownFailureCandidates ?? null, withoutMemory: fresh?.knownFailureCandidates ?? null },
      timeToCorrectHypothesis: { medianMs: memory?.firstVerifiedFixMedianMs ?? null, status: "verified_fix_time_only" },
      capital: knowledgeCapital(report), formation,
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
    tasks = [...new Map(events.filter(event => controls ? event.type === "control_arm_finished" && event.condition === "withMemory"
      : event.type === "assessment_finished" || event.type === "tests" && event.phase === "verification" && event.condition !== "withoutMemory")
      .map(event => [`${event.round ?? 0}:${event.agent}`, { ...event, verification: { passed: event.passed } }])).values()];
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

export function replayState(recording, position) {
  const state = { inputTokens: 0, outputTokens: 0, unknownInput: false, unknownOutput: false, toolCalls: 0, checks: 0,
    memoryInputTokens: 0, memoryOutputTokens: 0, unknownMemoryInput: false, unknownMemoryOutput: false, memoryInferences: new Set(), memoryCalls: 0,
    storageOperations: [], observationIds: new Set(), chainIds: new Set(), principleIds: new Set(), persistenceChecks: [],
    guideApplications: [], inspectedObservations: new Set(),
    memories: new Set(), handoffs: new Set(), transfers: [], lastTransfer: null, visibleEvents: [], applicationReady: false, controlApplicationReady: false,
    agents: Object.fromEntries(recording.agents.map(agent => [agent.id, { state: "queued", inputTokens: 0, outputTokens: 0,
      storedMemories: new Set(), linkedUses: new Set(), useMeasured: false, action: "Waiting", inference: null, unknown: false }])) };
  const tests = new Map();
  const usage = new Set();
  let finalTests = null;
  for (const event of recording.events) {
    if (event.atMs > position) break;
    state.visibleEvents.push(event);
    const agent = state.agents[event.agent];
    if (event.type === "agent_state" && agent) agent.state = event.state;
    if (event.type === "stage_started" && agent) agent.state = "running";
    if (event.type === "stage_finished" && agent) agent.state = event.success ? "passed" : "failed";
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
    if (event.type === "tool_started" && agent) agent.action = event.tool.replaceAll("_", " ");
    if (event.type === "tool_finished") {
      state.toolCalls += 1;
      if (agent) agent.action = event.fixturePath ?? event.tool?.replaceAll("_", " ") ?? "Tool complete";
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
    if (event.type === "observation_inspected") state.inspectedObservations.add(`${event.agent}:${event.memoryId}`);
    if (event.type === "memory_delivered") {
      const key = `${event.from}:${event.agent}`;
      if (event.from !== "brief" && event.from !== event.agent) state.handoffs.add(key);
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
  }
  state.checks = finalTests ?? [...tests.values()].reduce((total, count) => total + count, 0);
  return state;
}

export function formatElapsed(milliseconds) {
  const tenths = Math.max(0, Math.floor(milliseconds / 100));
  return `${String(Math.floor(tenths / 600)).padStart(2, "0")}:${String(Math.floor(tenths / 10) % 60).padStart(2, "0")}.${tenths % 10}`;
}

export function sandboxApplicationPage(html) {
  if (typeof html !== "string" || html.length > 2 * 1024 * 1024) throw new Error("invalid_application_preview");
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src data:; style-src data: &#39;unsafe-inline&#39;; img-src data:; font-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Session Desk</title><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src data:; style-src 'unsafe-inline'; base-uri 'none'"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0;display:block}</style></head><body><iframe title="Agent-built application" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" src="data:text/html;charset=utf-8,${encodeURIComponent(policy + html)}"></iframe></body></html>`;
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
  let inspectedNodeId = null;
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
  for (const id of ["capital-panel", "knowledge-capital-panel"]) byId(id).append(byId("capital-template").content.cloneNode(true));
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
    byId("rediscovery-profile-select").value = draft.rediscoveryProfile ?? "smoke";
    byId("rediscovery-profile-select").disabled = runActive || !initial.live;
    if (profiles.experiment === 3) {
      byId("problem-input").disabled = true; byId("concurrency-input").disabled = true; byId("attempts-input").disabled = true;
      byId("concurrency-input").parentElement.firstChild.textContent = "SERIAL MATCHED SCHEDULE";
      byId("attempts-input").parentElement.firstChild.textContent = "FRESH SESSION ATTEMPTS";
      byId("problem-input").parentElement.firstChild.textContent = "FROZEN EXPERIMENT";
      for (const [id, view] of agentElements) view.select.hidden = id !== "mindleak" || !initial.live;
    }
    if (!recording) byId("slm-model").textContent = modelName(draft.memoryModel);
  }
  function navigateView() {
    const lab = recording?.rediscovery || profiles?.experiment === 3 ? 3 : recording?.memoryLab || profiles?.experiment === 2 ? 2 : 1;
    const learning = location.hash === "#learnings" || !location.hash && location.pathname.endsWith("/learnings");
    byId("experiment-page").classList.toggle("hidden", learning);
    byId("knowledge-page").classList.toggle("hidden", !learning);
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
    if (learning) renderKnowledge();
  }
  function renderKnowledge() {
    const knowledge = recording?.report.knowledge ?? {};
    const observations = knowledge.observations ?? [];
    const chains = knowledge.chains ?? [];
    const principles = knowledge.principles ?? [];
    const operations = knowledge.operations ?? [];
    const durability = knowledge.durability ?? [];
    const applications = knowledge.applications ?? [];
    const guide = recording?.report.guide ?? knowledge.guide;
    const lastOutcome = recording?.events.findLast(event => ["rediscovery_task_finished", "rediscovery_round_finished", "control_arm_finished", "run_finished"].includes(event.type))?.id;
    const key = JSON.stringify([recording?.report.runId, operations.length, observations.length, [...chains, ...principles].map(node => [node.chainId, node.revision, node.state]), durability.length, applications.length, guide?.revision, lastOutcome]);
    if (key === knowledgeKey) return;
    knowledgeKey = key;
    const all = new Map([...observations.map(node => [node.memoryId, { ...node, kind: "observation" }]), ...[...chains, ...principles].map(node => [node.chainId, { ...node, kind: node.document.kind }])]);
    const fragmentOwners = new Map(observations.flatMap(node => node.fragments.map(fragment => [fragment.fragmentId, node.memoryId])));
    const inspect = id => {
      const node = all.get(id); if (!node) return;
      inspectedNodeId = id; byId("inspected-node-kind").textContent = node.kind;
      const content = node.kind === "observation" ? { memoryId: node.memoryId, author: nameFor(node.actor), savedAt: node.savedAt, source: node.source, rawText: node.rawText, fragments: node.fragments }
        : { chainId: node.chainId, revision: node.revision, state: node.state, author: nameFor(node.actor), ...node.document };
      byId("knowledge-inspector").textContent = JSON.stringify(content, null, 2);
    };
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
    byId("guide-document").textContent = guide?.markdown ?? knowledge.lessons?.map(lesson => lesson.markdown).join("\n\n") ?? "The agents have not exported a guide yet.";
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
    if (inspectedNodeId && all.has(inspectedNodeId)) inspect(inspectedNodeId);
    icons();
  }
  function renderKnowledgeHero(knowledge, inspect) {
    const graph = knowledgeGraphData(recording?.report ?? { knowledge });
    const metrics = knowledgeMetrics(recording?.report ?? { knowledge });
    const chart = byId("knowledge-hero-graph"); chart.replaceChildren();
    const svg = (tag, attributes, text) => { const node = document.createElementNS("http://www.w3.org/2000/svg", tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; return node; };
    const colorsByKind = { observation: "#008655", chain: "#145ee0", principle: "#a16b00" };
    for (const [label, x] of [["OBSERVATIONS", 70], ["CHAINS", 340], ["PRINCIPLES", 610]]) chart.append(svg("text", { x, y: 22, "text-anchor": "middle" }, label));
    const positions = new Map(graph.nodes.map(node => [node.id, node]));
    for (const edge of graph.edges) {
      const from = positions.get(edge.from); const to = positions.get(edge.to);
      const path = svg("path", { d: `M ${from.x} ${from.y} C ${from.x + 100} ${from.y}, ${to.x - 100} ${to.y}, ${to.x} ${to.y}`,
        class: "knowledge-hero-edge", "data-role": edge.role, fill: "none", stroke: edge.role === "counterexample" ? "#bd3b35" : "#a9b8cc", "stroke-width": 1.3 });
      path.append(svg("title", {}, `${edge.role}${edge.referenceRevision ? ` / pinned revision ${edge.referenceRevision}` : ""}`)); chart.append(path);
    }
    for (const node of graph.nodes) {
      const group = svg("g", { class: "knowledge-hero-node", role: "button", tabindex: 0, "aria-label": `${node.kind}: ${node.label}`, "data-node-id": node.id });
      group.append(svg("circle", { cx: node.x, cy: node.y, r: { observation: 5, chain: 9, principle: 14 }[node.kind], fill: colorsByKind[node.kind], stroke: "#172333", "stroke-width": node.state === "candidate" ? 1 : 2 }),
        svg("title", {}, `${node.kind} / ${node.state}${node.revision ? ` / revision ${node.revision}` : ""}\n${node.label}\n${node.id}`));
      const select = () => { inspect(node.id); byId("knowledge-inspector").scrollIntoView({ block: "nearest", behavior: "auto" }); };
      group.addEventListener("click", select); group.addEventListener("keydown", event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); select(); } });
      chart.append(group);
    }
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
      field("score").textContent = count(capital.score);
      field("status").textContent = capital.score === null ? "Not measured in this recording" : "Evidence-backed reuse index";
      field("observations").textContent = count(capital.observations);
      field("observations-note").textContent = capital.usedObservations === null ? "Stored sources / use not measured" : `${count(capital.usedObservations)} used in verified work`;
      field("chains").textContent = count(capital.usefulChains);
      field("principles").textContent = count(capital.validatedPrinciples);
      field("principles-note").textContent = `${count(capital.acceptedPrinciples)} accepted / later-use validation required`;
      field("growth").textContent = capital.growthPercent === null ? "--" : `${capital.growthPercent > 0 ? "+" : ""}${capital.growthPercent.toFixed(1)}%`;
      field("trend").dataset.trend = capital.growthPercent > 0 ? "positive" : capital.growthPercent < 0 ? "negative" : "neutral";
      field("growth-note").textContent = { not_measured: "Use evidence not recorded", needs_comparison: "First measured checkpoint",
        first_reuse: "First evidenced reuse", no_reuse: "No evidenced reuse yet", comparable: "Since the first verified checkpoint" }[capital.growthStatus];
    }
  }
  function renderKnowledgeOutcomes() {
    const metrics = knowledgeMetrics(recording?.report ?? {});
    const key = JSON.stringify(metrics);
    if (key === outcomeKey) return;
    outcomeKey = key;
    renderCapital(metrics.capital, metrics.formation);
    const percent = value => Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "--";
    byId("outcome-scope").textContent = metrics.evidenceScope;
    const sourceLinked = metrics.reuse.kind === "source_linked";
    byId("reuse-rate").previousElementSibling.textContent = sourceLinked ? "SOURCE-LINKED APPLICATIONS" : "OBSERVED KNOWLEDGE REUSE";
    byId("transfer-value").previousElementSibling.textContent = sourceLinked ? "NEW-CASE SOURCE LINKS" : "VERIFIED NEW-CASE USE";
    byId("reuse-rate").textContent = percent(metrics.reuse.rate);
    byId("reuse-rate").title = metrics.reuse.evidence;
    byId("reuse-note").textContent = metrics.successfulTasks ? `${metrics.reuse.tasks} / ${metrics.successfulTasks} successful tasks${sourceLinked ? " / quotation evidence" : " with linked application"}` : "No verified applications yet";
    byId("transfer-value").textContent = metrics.transfer.attempts ? count(metrics.transfer.successful) : "--";
    byId("transfer-value").title = metrics.transfer.evidence;
    byId("transfer-note").textContent = metrics.transfer.attempts ? `${metrics.transfer.successful} / ${metrics.transfer.attempts} recorded new-case applications${sourceLinked ? " / not behavioral transfer" : ""}` : "No new-case applications recorded";
    byId("verified-task-value").textContent = `${metrics.successfulTasks} / ${metrics.evaluatedTasks}`;
    byId("verified-task-note").textContent = recording?.report.kind === "swarm_build" ? "Memory-team components / immutable checks" : "Memory-team decisions / source + runtime checks";
    byId("chain-utility-value").textContent = metrics.chains.rate === null ? "--" : `${metrics.chains.used} / ${metrics.chains.created}`;
    byId("chain-utility-value").title = metrics.chains.evidence;
    byId("chain-utility-note").textContent = metrics.chains.status === "observed" ? "Direct inspection before a passing change" : "Not measured";
    const fixTime = metrics.timeToCorrectHypothesis.status === "verified_fix_time_only";
    byId("hypothesis-time-value").previousElementSibling.textContent = fixTime ? "TIME TO VERIFIED FIX" : "TIME TO CORRECT HYPOTHESIS";
    byId("hypothesis-time-value").textContent = Number.isFinite(metrics.timeToCorrectHypothesis.medianMs) ? formatElapsed(metrics.timeToCorrectHypothesis.medianMs) : "--";
    byId("hypothesis-time-note").textContent = fixTime ? "Median first passing changed candidate" : "Not measured";
    const knownFailures = metrics.mistakesAvoided.status === "known_failure_candidates_only";
    byId("mistakes-avoided-value").previousElementSibling.textContent = knownFailures ? "KNOWN FAILURE CANDIDATES" : "REPEATED MISTAKES AVOIDED";
    byId("mistakes-avoided-value").textContent = knownFailures && metrics.mistakesAvoided.withMemory !== null ? `${metrics.mistakesAvoided.withMemory} / ${metrics.mistakesAvoided.withoutMemory}` : "--";
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
  function makeRoster(agents) {
    agentElements.clear(); laneElements.clear(); paths.clear(); byId("agents").replaceChildren(); byId("control-agents").replaceChildren(); byId("timeline").replaceChildren(); byId("connections").replaceChildren();
    byId("agent-cost-body").replaceChildren();
    const memoryAgents = agents.filter(agent => !agent.control); const controls = agents.filter(agent => agent.control);
    byId("control-section").classList.toggle("hidden", controls.length === 0);
    byId("agents").style.setProperty("--agents", memoryAgents.length); byId("control-agents").style.setProperty("--agents", Math.max(1, controls.length));
    byId("timeline").style.setProperty("--agents", agents.length); byId("timeline").style.height = `${agents.length * 26}px`;
    for (const [index, agent] of agents.entries()) {
      const card = element("article", "agent-card"); card.style.setProperty("--agent-color", agent.color ?? colors[index]); card.dataset.state = "queued";
      const top = element("div", "agent-top"); const symbol = element("span", "agent-symbol"); const face = element("span", agent.control ? "dalek-face" : "agent-face");
      face.setAttribute("aria-hidden", "true");
      if (agent.control) { face.append(element("span", "dalek-eye"), element("span", "dalek-base")); symbol.title = "Dalek control: no MindLeak access"; }
      else face.append(element("span", "agent-eye"), element("span", "agent-eye"));
      if (["fresh", "notebook", "mindleak", "direct"].includes(agent.id)) symbol.append(icon(agent.icon)); else symbol.append(face);
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
      for (const [value, label] of [[stored, "RECORDS SAVED"], [used, "LINKED TASK USES"]]) { const item = element("div"); item.append(value, element("small", "", label)); memoryCounts.append(item); }
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
  }
  function load(report, live = false) {
    const next = normalizeRecording(report);
    const changed = recording?.report.runId !== report?.runId || recording?.agents.map(agent => agent.id).join() !== next.agents.map(agent => agent.id).join();
    const wasFollowing = following;
    recording = next;
    if (changed) { position = live ? next.durationMs : 0; lastEventCount = -1; artifactShown = false; selectedId = null; makeRoster(next.agents); }
    if (wasFollowing && !live && report.status !== "recording") position = next.durationMs;
    following = live; playing = false;
    byId("project-title").textContent = next.memoryLab ? "Knowledge Formation" : next.rediscovery ? "Knowledge Reuse"
      : report.title ?? next.source.protocol?.title ?? "Session expiry investigation";
    byId("project-kicker").textContent = next.control ? "LEARNING TRANSFER / A + B + C" : "SHARED BUILD / FIVE AGENTS";
    if (next.memoryLab) byId("project-kicker").textContent = next.agents.some(agent => agent.control) ? "FIVE INVESTIGATORS / FIVE DALEK CONTROLS" : "DURABLE KNOWLEDGE / FIVE INVESTIGATORS";
    if (next.rediscovery) byId("project-kicker").textContent = "REDISCOVERY / THREE MAIN ARMS + DIAGNOSTIC";
    byId("task-description").textContent = next.control
      ? "Investigate and fix session expiry. A and B work independently; C repeats the task with no memory, A-only memory, and A+B memory. The same immutable checks decide correctness."
      : report.problem ?? "Build a session-expiry app: create named sessions, count down their lifetime, validate inputs, remove sessions, and clear expired entries. Five owners. Eighteen fixed checks.";
    for (const agent of next.agents) agentElements.get(agent.id).modelText.textContent = modelName(agent.model ?? report.agent?.model);
    byId("run-meta").textContent = `${report.agent?.model ?? "Model not recorded"} / ${String(report.runId ?? "recording").slice(0, 8)}`;
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
    renderComparisons(); renderKnowledge(); renderKnowledgeOutcomes(); navigateView(); render(true);
  }
  function renderComparisons() {
    byId("control-costs").classList.toggle("hidden", !recording?.memoryLab || !recording.report.controlExperiment);
    byId("rediscovery-results").classList.toggle("hidden", !recording?.rediscovery);
    byId("rediscovery-costs").classList.toggle("hidden", !recording?.rediscovery);
    if (recording?.rediscovery) {
      const report = recording.report; const body = byId("rediscovery-result-body"); body.replaceChildren();
      const names = { fresh: "Fresh Agent", notebook: "Notebook", mindleak: "MindLeak", direct: "Direct / diagnostic" };
      byId("rediscovery-protocol-status").textContent = report.plan ? `${report.plan.profile} / ${report.plan.mainSessions} main + ${report.plan.diagnosticSessions} diagnostic / frozen v${report.plan.protocolVersion}` : "Preparing frozen protocol";
      const results = report.outcomes ?? recording.events.filter(event => event.type === "rediscovery_task_finished" && event.phaseScope === "evaluation")
        .map(event => ({ ...event, id: event.caseId, arm: event.agent }));
      for (const outcome of results) {
        const row = element("tr"); row.tabIndex = 0;
        for (const value of [outcome.id, names[outcome.arm], outcome.correct ? "Passed" : "Unresolved", outcome.reuseObserved ? "Before verified change" : outcome.priorKnowledgeDelivered ? "Retrieved only" : "Not used",
          Array.isArray(outcome.knownFailureCandidates) ? outcome.knownFailureCandidates.length : outcome.knownFailureCandidates ?? "--", Number.isFinite(outcome.firstVerifiedFixMs) ? formatElapsed(outcome.firstVerifiedFixMs) : "--"]) row.append(element("td", "", String(value)));
        const inspect = () => {
          byId("rediscovery-inspector").classList.remove("hidden");
          byId("rediscovery-inspector").textContent = JSON.stringify({ id: outcome.id, fixture: outcome.fixtureSha256, correct: outcome.correct,
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
        for (const value of [label, `${team.agentsPassed}/5`, `${team.finalTests?.passedTests ?? 0}/18`, team.memoryAccess === "none" ? "None" : "Read + write", formatElapsed(team.elapsedMs)]) row.append(element("td", "", value));
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
      || filter === "memory" && (/memory|confirmation|snapshot|knowledge|persistence|guide_|observation_/.test(event.type) || event.workload === "memory")
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
  function render(force = false) {
    if (!recording) return;
    const state = replayState(recording, position);
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
    const active = Object.values(state.agents).filter(agent => agent.state === "running").length;
    const generating = Object.values(state.agents).filter(agent => agent.inference !== null).length;
    byId("token-activity").dataset.active = String(generating > 0); byId("input-note").textContent = generating ? `${generating} inference${generating === 1 ? "" : "s"} in flight` : "Reported consumption";
    byId("output-note").textContent = `${state.toolCalls} tool calls`;
    byId("network-meta").textContent = `${recording.agents.length} agents / ${active} active`;
    const phase = [...state.visibleEvents].reverse().find(event => ["control_round_started", "control_round_finished", "round_learning_started", "round_learning_finished"].includes(event.type));
    byId("control-phase").textContent = phase ? `ROUND ${phase.round} / ${phase.type.startsWith("round_learning") ? "LEARNING REVIEW" : phase.type.endsWith("started") ? "RUNNING" : "FINISHED"} / NO MINDLEAK` : "NO MINDLEAK";
    byId("hub-count").textContent = `MCP / ${state.memories.size} writes / ${state.handoffs.size} handoffs`;
    byId("last-transfer").textContent = state.lastTransfer ? `${nameFor(state.lastTransfer.from)} \u2192 ${nameFor(state.lastTransfer.agent)}` : "";
    for (const [id, view] of agentElements) {
      const agent = state.agents[id]; view.card.dataset.state = agent.state; view.status.textContent = agent.state;
      view.value.textContent = `${count(agent.inputTokens + agent.outputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.value.title = `${count(agent.inputTokens)} input / ${count(agent.outputTokens)} output`;
      view.inputValue.textContent = `${count(agent.inputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.outputValue.textContent = `${count(agent.outputTokens)}${agent.unknown ? " + ?" : ""}`;
      view.stored.textContent = count(agent.storedMemories.size);
      view.used.textContent = view.control ? "0" : agent.useMeasured ? count(agent.linkedUses.size) : "--";
      view.action.textContent = agent.inference === null ? agent.action : `Generating / ${((position - agent.inference) / 1000).toFixed(1)}s`;
      paths.get(id)?.classList.toggle("active", state.transfers.some(event => event.agent === id || event.from === id));
    }
    const finished = position >= recording.durationMs && recording.report.status !== "recording";
    const status = finished ? recording.report.status : following ? "live" : playing ? "playing" : "paused";
    byId("state").textContent = status.toUpperCase(); byId("state").dataset.state = status;
    byId("time-current").textContent = formatElapsed(position); byId("time-total").textContent = formatElapsed(recording.durationMs);
    byId("scrubber").value = String(Math.min(1000, position / recording.durationMs * 1000));
    byId("play").setAttribute("aria-label", playing || following ? "Pause replay" : "Play replay");
    const playIcon = byId("play").firstElementChild;
    const wanted = playing || following ? "pause" : "play";
    if (playIcon?.getAttribute("data-lucide") !== wanted) { byId("play").replaceChildren(icon(wanted)); icons(); }
    renderEvents(state, force); renderTimeline(); renderMemories(state); renderKnowledge(); renderKnowledgeOutcomes();
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
  byId("problem-input").addEventListener("input", event => { draft.problem = event.target.value; });
  byId("concurrency-input").addEventListener("input", event => { draft.concurrency = Number(event.target.value); });
  byId("attempts-input").addEventListener("input", event => { draft.attempts = Number(event.target.value); });
  byId("rounds-input").addEventListener("input", event => { draft.rounds = Number(event.target.value); });
  byId("rediscovery-profile-select").addEventListener("change", event => { draft.rediscoveryProfile = event.target.value; });
  for (const team of ["memory", "daleks"]) byId(`artifact-${team}`).addEventListener("click", () => {
    artifactTeam = team;
    for (const candidate of ["memory", "daleks"]) byId(`artifact-${candidate}`).setAttribute("aria-selected", String(candidate === team));
    render(true);
  });
  byId("memory-model-select").addEventListener("change", event => { draft.memoryModel = event.target.value; byId("memory-model-status").textContent = `Next run: ${modelName(draft.memoryModel)}`; });
  byId("download-guide").addEventListener("click", () => {
    const guide = recording?.report.guide ?? recording?.report.knowledge?.guide;
    const markdown = guide?.markdown ?? recording?.report.knowledge?.lessons?.map(lesson => lesson.markdown).join("\n\n");
    if (markdown) save(markdown, "mindleak-solution-guide.md", "text/markdown");
  });
  byId("download-knowledge").addEventListener("click", () => { if (recording?.report.knowledge) save(JSON.stringify(recording.report.knowledge, null, 2), "mindleak-durable-knowledge.json", "application/json"); });
  window.addEventListener("hashchange", navigateView);
  byId("load").addEventListener("click", () => byId("file-input").click());
  byId("file-input").addEventListener("change", async event => { const file = event.target.files[0]; if (!file) return; try { if (file.size > 16 * 1024 * 1024) throw new Error("Recording exceeds 16 MiB"); load(JSON.parse(await file.text())); } catch { notify("Recording could not be opened"); } event.target.value = ""; });
  byId("download").addEventListener("click", () => { if (recording) save(JSON.stringify(recording.report, null, 2), `mindleak-${recording.report.runId}.json`, "application/json"); });
  byId("download-app").addEventListener("click", () => { const application = currentApplication(); if (application?.html) save(application.html, artifactTeam === "daleks" ? "session-desk-daleks.html" : "session-desk.html", "text/html"); });
  byId("open-app").addEventListener("click", () => { const application = currentApplication(); if (!application?.html) return; const url = URL.createObjectURL(new Blob([sandboxApplicationPage(application.html)], { type: "text/html" })); window.open(url, "_blank", "noopener,noreferrer"); setTimeout(() => URL.revokeObjectURL(url), 30000); });
  const command = async operation => { try { const response = await fetch(`${apiBase}/${operation}`, { method: "POST", headers: { "content-type": "application/json", "x-mindleak-demo": "1" }, body: JSON.stringify(operation === "run" && profiles ? draft : {}) }); if (!response.ok) throw new Error(); if (operation === "run") { following = true; byId("mission").open = false; } } catch { notify(`Could not ${operation} the demo; check the selected models and limits or an active run in another lab`); } };
  byId("run").addEventListener("click", () => command("run")); byId("stop").addEventListener("click", () => command("stop"));
  byId("run").classList.toggle("hidden", !initial.live); byId("stop").classList.toggle("hidden", !initial.live); byId("go-live").classList.toggle("hidden", !initial.live); byId("download").disabled = true;
  makeRoster((profiles?.roles ?? defaultAgents).map((agent, index) => ({ ...agent, color: agent.color ?? colors[index % colors.length] })));
  if (profiles?.experiment === 3) {
    byId("project-title").textContent = "Knowledge Reuse"; byId("project-kicker").textContent = "THREE MAIN ARMS / DIRECT-LESSON DIAGNOSTIC";
    byId("task-description").textContent = draft.problem; byId("run").querySelector("span").textContent = "Run experiment";
    byId("network-title").textContent = "Fresh Investigation Arms"; byId("network-meta").textContent = "Randomized / one session at a time";
    byId("app-frame").closest("section").classList.add("hidden"); byId("rediscovery-results").classList.remove("hidden");
    byId("checks").textContent = `0 / ${draft.rediscoveryProfile === "pilot" ? 495 : 27}`;
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
    stream.addEventListener("record", message => { if (!recording) return; const event = JSON.parse(message.data); if (recording.events.some(existing => existing.id === event.id)) return; recording.events.push(event); recording.report.events = recording.events; recording.durationMs = Math.max(recording.durationMs, event.atMs); if (following) position = recording.durationMs; if (["control_started", "control_arm_finished", "rediscovery_task_finished"].includes(event.type)) renderComparisons(); render(true); });
    stream.addEventListener("memory", message => { if (!recording) return; const record = JSON.parse(message.data); const exhibits = recording.report.memoryExhibits ??= []; if (!exhibits.some(item => item.memoryId === record.memoryId)) exhibits.push(record); render(true); });
    stream.addEventListener("tool-detail", message => { if (!recording) return; const detail = JSON.parse(message.data); const exhibits = recording.report.toolExhibits ??= []; if (!exhibits.some(item => item.toolCallId === detail.toolCallId)) exhibits.push(detail); });
    stream.addEventListener("knowledge", message => { if (!recording) return; const knowledge = JSON.parse(message.data); recording.report.knowledge = { ...recording.report.knowledge, ...knowledge }; if (knowledge.guide) recording.report.guide = knowledge.guide; renderKnowledge(); renderComparisons(); });
  }
  function frame(now) {
    const delta = Math.min(1000, now - frameTime); frameTime = now;
    if (recording) {
      const advancing = following || playing;
      if (following && recording.report.status === "recording") { recording.durationMs = Math.max(recording.durationMs, Date.now() - Date.parse(recording.report.createdAt)); position = recording.durationMs; }
      else if (playing) { position = Math.min(recording.durationMs, position + delta * Number(byId("speed").value)); if (position >= recording.durationMs) playing = false; }
      if (advancing) render();
    }
    requestAnimationFrame(frame);
  }
  icons(); requestAnimationFrame(frame);
}

if (typeof window !== "undefined" && typeof document !== "undefined") initializeReplay();
