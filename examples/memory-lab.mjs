import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { digest } from "./validation-scenarios.mjs";
import { publicExecution } from "./validation-agent.mjs";
import { swarmRoles } from "./swarm-fixture.mjs";
import { upgradeCases, packageWorkspace, assessmentSchema, upgradeAssessmentSchema, adapterModes, checkAssessment, memoryLabProblem } from "./memory-lab-fixture.mjs";

export const memoryLabRoles = swarmRoles.map(({ dependencies, editable, group, task, ...role }, index) => ({ ...role,
  title: ["First Investigation", "Independent Check", "Apply & Extend", "Test the Boundary", "Complete the Guide"][index] }));

const statement = { type: "string", minLength: 1, maxLength: 1500 };
const references = { type: "array", maxItems: 8, items: { type: "object", additionalProperties: false,
  properties: { fragmentId: { type: "string" }, role: { type: "string", enum: ["supports", "counterexample"] }, reason: { ...statement, maxLength: 1024 } },
  required: ["fragmentId", "role", "reason"] } };
const supports = { type: "array", minItems: 2, maxItems: 8, items: { type: "object", additionalProperties: false,
  properties: { chainId: { type: "string" }, revision: { type: "integer", minimum: 1 }, reason: { ...statement, maxLength: 1024 } }, required: ["chainId", "revision", "reason"] } };
const documentProperties = { claim: statement, rationale: statement, conclusion: { type: "string", minLength: 1, maxLength: 2048 },
  applicability: statement, assumptions: { type: "array", maxItems: 8, items: { ...statement, maxLength: 1024 } }, evidence: references };
const documentRequired = Object.keys(documentProperties);
export const memoryProtocol = { version: 3, name: "hierarchy-first-checkpoints", briefingBytes: 16384,
  captureKinds: ["finding", "constraint", "failed_approach", "exception", "decision"], exactDuplicateWrites: "reuse-acknowledged-receipt" };
export function memoryStartPrompt({ mode = "learning", stage = "assessment", independent = false } = {}) {
  const orientation = [
    "Memory hierarchy for this task:",
    "Principles are reusable procedures with applicability, assumptions and a current revision. Use an applicable principle to plan the investigation, not as a previous answer to copy.",
    "Chains connect source evidence to a conclusion, explain reasoning and conditions, and preserve exceptions. Inspect a supporting chain when you need to understand why a principle applies or where it stops applying.",
    "Observations are the original source-backed findings, including failed approaches and constraints. Inspect their actual source when a decision depends on it. Neither acceptance nor similarity proves truth.",
    "Check applicability against the current codebase, deployed path, API and policy. Record material differences instead of forcing this case to match an earlier one.",
  ];
  if (mode === "withoutMemory") orientation.push("No stored knowledge is available in this matched no-memory control. Solve from the same local evidence and correctness checks; no previous answer or conversation has been supplied.");
  else if (independent && stage === "assessment") orientation.push("This is an independent seed investigation. Do not retrieve earlier findings before your assessment passes. You still need to understand the hierarchy: later phases will store your observations and chain for a future principle.");
  else if (stage === "evidence") orientation.push("Start with memory_checkpoint to recover acknowledged observations and your case chain. Store only reusable verified evidence, then connect it in a case-specific chain; do not reconstruct earlier IDs from conversation.");
  else if (stage === "guide") orientation.push("Start with memory_checkpoint and inspect_guide_sources. Recover the accepted chains from MindLeak, then form or revise the principle with their evidence, conditions and exceptions. Explicit acceptance and a final checkpoint complete this phase.");
  else orientation.push("Before investigating, call recall_guide with focused topic keywords. Read the accepted principle's procedure, applicability, revision and review state before choosing your next action. Follow its references progressively: relevant chain first when reasoning is needed, original observations when source verification is needed. An empty search is not proof that no lesson exists.",
    mode === "control" ? "Memory is read-only and frozen for this comparison. No writes, reinforcement or guide revisions are allowed; retrieve only what helps the current decision."
      : "Use memory_checkpoint at phase start and finish. The assessment phase applies the guide; separate capture and guide-authoring phases retain new evidence and exceptions.");
  return orientation.join("\n");
}
const tool = (name, description, properties, required, invoke) => ({ definition: { type: "function", function: { name, description,
  parameters: { type: "object", additionalProperties: false, properties, required } } }, invoke });

export function knowledgeToolView(result) {
  const record = item => ({ chain: { chainId: item.chain.chainId, revision: item.chain.revision,
    memoryId: item.chain.memoryId, snapshot: item.chain.snapshot }, requiresReview: item.requiresReview,
    supportingChains: (item.supportingChains ?? []).map(support => ({ reference: support.reference, state: support.state,
      requiresReview: support.requiresReview, document: support.document })) });
  if (result.chain) return record(result);
  return { kind: "knowledge", principles: (result.principles ?? []).map(record), chains: (result.chains ?? []).map(record),
    observations: (result.observations ?? []).map(({ fragmentId, memoryId, text, context }) => ({ fragmentId, memoryId, text, context })) };
}

export function knowledgeBrief(result) {
  const principles = (result.principles ?? []).filter(record => record.chain?.snapshot?.state === "accepted" && !record.requiresReview).slice(0, 1);
  const chains = principles.length ? [] : (result.chains ?? []).slice(0, 2);
  const sourceReferences = new Map();
  const compact = record => {
    const full = knowledgeToolView(record);
    const sources = full.chain.snapshot.document.kind === "chain"
      ? [{ chainId: full.chain.chainId, revision: full.chain.revision, document: full.chain.snapshot.document }]
      : full.supportingChains.filter(support => support.state === "accepted" && !support.requiresReview && support.document)
        .map(support => ({ chainId: support.reference.chainId, revision: support.reference.revision, document: support.document }));
    for (const source of sources) for (const reference of source.document.evidence ?? []) {
      const key = `${source.chainId}:${source.revision}:${reference.fragmentId}`;
      sourceReferences.set(key, { chainId: source.chainId, revision: source.revision, fragmentId: reference.fragmentId, role: reference.role });
    }
    return { ...full, supportingChains: full.supportingChains.map(({ reference, state, requiresReview }) => ({ reference, state, requiresReview })) };
  };
  const brief = { kind: "knowledge", view: "guide-first", principles: principles.map(compact), chains: chains.map(compact),
    observations: principles.length || chains.length ? [] : (result.observations ?? []).slice(0, 2),
    sourceReferences: [...sourceReferences.values()], fullEvidenceAvailable: true };
  if (Buffer.byteLength(JSON.stringify(brief)) > memoryProtocol.briefingBytes) throw new Error("memory_brief_budget");
  return brief;
}

export function createKnowledgeLedger({ driver, runId, scope, emit, onMemory = () => {}, onKnowledge = () => {}, seed = null }) {
  const observations = structuredClone(seed?.observations ?? []);
  const nodes = new Map(structuredClone([...(seed?.chains ?? []), ...(seed?.principles ?? [])]).map(node => [node.chainId, node]));
  const operations = structuredClone(seed?.operations ?? []);
  const durability = structuredClone(seed?.durability ?? []);
  const applications = structuredClone(seed?.applications ?? []);
  const acknowledged = new Set(operations.map(operation => operation.memoryId));
  const expectedSources = new Map(observations.map(observation => [observation.memoryId, observation]));
  const requests = new Map();
  let guideId = seed?.guide?.chainId ?? seed?.guideId ?? null;
  const snapshot = () => structuredClone({ observations, chains: [...nodes.values()].filter(node => node.document.kind === "chain"),
    principles: [...nodes.values()].filter(node => node.document.kind === "principle"), operations: structuredClone(operations),
    durability: structuredClone(durability), applications: structuredClone(applications), guideId });
  const publish = () => onKnowledge(snapshot());
  const call = async (name, args) => {
    const result = await driver.call(name, args);
    if (result.resultBytes > 512 * 1024) throw new Error("knowledge_response_budget");
    return result.data;
  };
  const write = async (actor, text, chain = null, source = "verification", metadata = {}) => {
    const payload = { agentId: `lab2-${runId}-${actor}`, text, context: { scope, sessionId: `lab2-${runId}-${actor}`, source: `synthetic:package-guide/${source}`,
      ...(metadata.kind ? { summary: `${metadata.kind}: ${metadata.claim}` } : {}) }, ...(chain ? { chain } : {}) };
    const key = digest(payload);
    if (!requests.has(key)) requests.set(key, randomUUID());
    const result = await call("write_memory", { ...payload, requestId: requests.get(key) });
    if (typeof result.memoryId !== "string" || !Array.isArray(result.fragments) || !result.fragments.length) throw new Error("invalid_knowledge_write_receipt");
    if (acknowledged.has(result.memoryId)) {
      emit({ type: "memory_receipt_replayed", agent: actor, memoryId: result.memoryId });
      return result;
    }
    acknowledged.add(result.memoryId);
    const savedAt = new Date().toISOString();
    const operation = { actor, memoryId: result.memoryId, nodeId: result.chainId ?? result.memoryId, kind: chain ? chain.document?.kind ?? nodes.get(chain.chainId)?.document.kind ?? "chain" : "observation",
      operation: chain?.operation ?? "write", revision: result.revision ?? null, state: result.state ?? "stored", fragments: result.fragments.length, savedAt, requestId: requests.get(key) };
    operations.push(operation);
    if (!chain) {
      const item = { actor, memoryId: result.memoryId, source, savedAt, rawText: text, fragments: result.fragments, ...metadata };
      observations.push(item); expectedSources.set(result.memoryId, item);
    }
    onMemory({ agent: actor, memoryId: result.memoryId, kind: operation.kind, savedAt, scope,
      fragments: result.fragments.map(({ fragmentId, text }) => ({ fragmentId, text })) });
    emit({ type: "memory_saved", agent: actor, memoryId: result.memoryId, fragments: result.fragments.length, kind: operation.kind, savedAt });
    emit({ type: "knowledge_written", agent: actor, ...operation });
    publish();
    return result;
  };
  return {
    observations, nodes, operations, durability, applications, snapshot, get guideId() { return guideId; },
    async record(actor, specification, text, source, metadata = {}) {
      if (observations.length >= 64 || typeof text !== "string" || Buffer.byteLength(text) > 12000) throw new Error("observation_budget");
      return write(actor, text, null, `${specification.id}/${source}`, metadata);
    },
    async propose(actor, document, previous = null) {
      if (!document.claim.toLowerCase().includes("branch-kit")) throw new Error("guide_topic_required");
      if (document.kind === "chain" && [...nodes.values()].some(node => node.actor === actor && node.document.kind === "chain")) {
        throw new Error("case_chain_already_stored");
      }
      if (document.kind === "chain" && !document.evidence.some(reference => reference.role === "supports"
        && observations.some(observation => observation.actor === actor && observation.fragments.some(fragment => fragment.fragmentId === reference.fragmentId)))) {
        throw new Error("own_observation_evidence_required");
      }
      if (document.kind === "principle") {
        if (document.supportedBy.some(reference => { const node = nodes.get(reference.chainId); return !node || node.document.kind !== "chain" || node.state !== "accepted" || node.revision !== reference.revision; })) {
          throw new Error("current_accepted_chains_required");
        }
        const accepted = [...nodes.values()].filter(node => node.document.kind === "chain" && node.state === "accepted");
        if (accepted.some(node => !document.supportedBy.some(reference => reference.chainId === node.chainId))) throw new Error("retain_all_case_chains_in_guide");
        if (guideId && (!previous || previous.chainId !== guideId)) throw new Error("revise_the_existing_guide");
      }
      const chainId = previous?.chainId ?? randomUUID();
      if (previous && nodes.get(chainId)?.revision !== previous.expectedRevision) throw new Error("stale_guide_revision");
      const receipt = await write(actor, `Branch-kit guide: ${actor} proposed ${document.kind === "principle" ? "a reusable solution guide" : "an evidence-backed investigation"} for explicit review.`,
        { operation: previous ? "revise" : "propose", chainId, ...(previous ? { expectedRevision: previous.expectedRevision } : {}), document });
      nodes.set(chainId, { chainId, actor, revision: receipt.revision, state: receipt.state, document: structuredClone(document), memoryId: receipt.memoryId });
      if (document.kind === "principle") guideId = chainId;
      publish(); return receipt;
    },
    async accept(actor, chainId, expectedRevision, specification, verification) {
      const node = nodes.get(chainId);
      if (!verification?.passed || !node || node.actor !== actor || node.revision !== expectedRevision || node.state !== "candidate") throw new Error("verified_current_candidate_required");
      const counterEvidenceReviewed = node.document.evidence.filter(reference => reference.role === "counterexample").map(reference => reference.fragmentId);
      const count = verification.expectedTests ?? 5;
      const receipt = await write(actor, `Branch-kit guide: ${actor} accepted the candidate after all ${count} frozen ${specification.id} assessment checks passed and its stored sources were reviewed.`,
        { operation: "accept", chainId, expectedRevision, validation: { method: "Check frozen shipped paths, advisory ranges, registry candidates and compatibility policy with semver, then inspect cited observations and any recorded sandbox upgrade probe.",
          result: `${count} assessment checks passed for this synthetic case; a blocked decision preserves unresolved runtime failures. Guide reasoning remains an attributed agent claim.`, source: `synthetic:package-guide/${specification.id}/verified-assessment`, counterEvidenceReviewed } });
      node.state = receipt.state; node.revision = receipt.revision; node.memoryId = receipt.memoryId;
      publish(); return receipt;
    },
    async inspect(chainId) {
      if (!nodes.has(chainId)) throw new Error("unknown_guide");
      const result = await call("recall_memory", { chain: { operation: "inspect", chainId }, scope, limit: 2 });
      if (result.chain?.chainId !== chainId || result.chain.revision !== nodes.get(chainId).revision) throw new Error("guide_identity_mismatch");
      return knowledgeToolView(result);
    },
    async search(query, { brief = false } = {}) {
      const result = await call("recall_memory", { knowledge: { operation: "search", query }, scope, limit: 2 });
      if (result.kind !== "knowledge") throw new Error("knowledge_schema_required");
      return brief ? knowledgeBrief(result) : knowledgeToolView(result);
    },
    async guideSources() {
      const result = { kind: "knowledge", principles: [], chains: [], observations: [] };
      for (const node of nodes.values()) {
        const recovered = await call("recall_memory", { chain: { operation: "inspect", chainId: node.chainId }, scope, limit: 1 });
        if (recovered.chain?.chainId !== node.chainId || recovered.chain.revision !== node.revision) throw new Error("guide_identity_mismatch");
        result[node.document.kind === "principle" ? "principles" : "chains"].push(knowledgeToolView(recovered));
      }
      return result;
    },
    async inspectObservation(fragmentId) {
      const expected = observations.find(observation => observation.fragments.some(fragment => fragment.fragmentId === fragmentId));
      if (!expected) throw new Error("unknown_observation");
      const recovered = await call("recall_memory", { fragmentId, scope });
      if (recovered.memoryId !== expected.memoryId || recovered.rawText !== expected.rawText) throw new Error("observation_persistence_mismatch");
      return { fragmentId, memoryId: recovered.memoryId, actor: expected.actor, text: recovered.text, rawText: recovered.rawText, source: expected.source };
    },
    async recordApplication(actor, specification, detail) {
      const receipt = await write(actor, `Branch-kit ${specification.id}: the investigator applied the stored solution guide to this verified case.\n${JSON.stringify(detail)}`, null, `${specification.id}/guide-application`);
      if (!applications.some(application => application.memoryId === receipt.memoryId)) {
        applications.push({ actor, caseId: specification.id, memoryId: receipt.memoryId, recordedAt: new Date().toISOString(), ...structuredClone(detail) });
        emit({ type: "guide_applied", agent: actor, caseId: specification.id, chainId: detail.chainId, revision: detail.revision,
          steps: detail.steps.length, sourceObservations: detail.sourceMemoryIds.length, memoryId: receipt.memoryId });
        publish();
      }
      return receipt;
    },
    async provePersistence(actor) {
      const transition = await driver.restart();
      if (transition.previous === transition.current) throw new Error("memory_server_did_not_restart");
      if (transition.previousPid && transition.currentPid && transition.previousPid === transition.currentPid) throw new Error("memory_server_did_not_restart");
      const checked = [];
      for (const observation of expectedSources.values()) {
        const recovered = await call("recall_memory", { fragmentId: observation.fragments[0].fragmentId, scope });
        if (recovered.memoryId !== observation.memoryId || recovered.rawText !== observation.rawText) throw new Error("observation_persistence_mismatch");
        checked.push(observation.memoryId);
      }
      for (const node of nodes.values()) {
        const recovered = await call("recall_memory", { chain: { operation: "inspect", chainId: node.chainId }, scope, limit: 1 });
        if (recovered.chain?.chainId !== node.chainId || recovered.chain.revision !== node.revision || recovered.chain.snapshot.state !== node.state
          || !isDeepStrictEqual(recovered.chain.snapshot.document, node.document)) throw new Error("chain_persistence_mismatch");
        checked.push(node.chainId);
      }
      const proof = { actor, checkedAt: new Date().toISOString(), ...transition, checkedIds: checked, records: checked.length, passed: true };
      durability.push(proof); emit({ type: "persistence_verified", agent: actor, ...proof }); publish();
      return proof;
    },
    async exportGuide() {
      if (!guideId || nodes.get(guideId)?.state !== "accepted") return null;
      const snapshot = await call("recall_memory", { knowledge: { operation: "export", chainId: guideId, format: "json" }, scope, limit: 8 });
      const markdown = await call("recall_memory", { knowledge: { operation: "export", chainId: guideId, format: "markdown" }, scope, limit: 8 });
      if (snapshot.snapshot?.chain?.chainId !== guideId || typeof markdown.markdown !== "string") throw new Error("guide_export_mismatch");
      return { chainId: guideId, revision: snapshot.snapshot.chain.revision, extractedAt: new Date().toISOString(),
        snapshot: snapshot.snapshot, markdown: markdown.markdown, source: "MindLeak recall_memory knowledge.export" };
    },
  };
}

export function investigatorTools({ driver, scope, actor, specification, ledger, condition, index, emit, code,
  memoryEnabled = condition === "withMemory", stage = "assessment", priorAssessment = null, onToolDetail = () => {} }) {
  const workspace = packageWorkspace(specification, { code });
  const schema = specification.fixtureVersion === 2 ? upgradeAssessmentSchema : assessmentSchema;
  const seen = new Set();
  const accessedKnowledge = new Set();
  const receivedOwners = new Set();
  const retrieved = new Map();
  const sourceObservations = new Set();
  const memoryReads = [];
  let guideAtAssessment = null;
  let application = null;
  let verification = stage !== "assessment" ? priorAssessment?.verification ?? null : null;
  let verifiedAt = null;
  let answer = stage !== "assessment" ? priorAssessment?.answer ?? null : null;
  const stageStarted = performance.now();
  const storeEnabled = memoryEnabled;
  const canRecall = () => {
    if (!storeEnabled || index < 2 && !verification?.passed) throw new Error("independent_assessment_first");
  };
  const expose = result => {
    if (Buffer.byteLength(JSON.stringify(result)) > 64 * 1024) throw new Error("agent_tool_result_budget");
    const records = result.kind === "knowledge" ? [...result.principles, ...result.chains] : result.chain ? [result] : [];
    const owners = new Map();
    for (const record of records) {
      if (record.chain?.snapshot?.state === "accepted") retrieved.set(record.chain.chainId, structuredClone(record.chain));
      const ids = [record.chain?.chainId, ...(record.supportingChains ?? []).filter(support => support.document).map(support => support.reference?.chainId)];
      for (const id of ids) if (ledger.nodes.has(id)) {
        accessedKnowledge.add(id);
        const source = ledger.nodes.get(id);
        if (source.actor !== actor && !seen.has(id)) { seen.add(id); owners.set(source.actor, (owners.get(source.actor) ?? 0) + 1); receivedOwners.add(source.actor); }
      }
    }
    for (const [owner, records] of owners) emit({ type: "memory_delivered", agent: actor, condition, from: owner, fragments: records, records, kind: "knowledge" });
    return result;
  };
  const checkpoint = () => {
    const nextActions = [];
    const ownObservations = ledger.observations.filter(observation => observation.actor === actor && !observation.source?.endsWith("/guide-application"));
    const ownChain = [...ledger.nodes.values()].find(node => node.actor === actor && node.document.kind === "chain");
    const currentGuide = ledger.guideId ? ledger.nodes.get(ledger.guideId) : null;
    if (stage === "assessment") {
      if (index >= 2) {
        if (![...retrieved.values()].some(record => record.snapshot.document.kind === "principle")) nextActions.push("recall_guide");
        if (sourceObservations.size < 2) nextActions.push("inspect_observation");
      }
      if (specification.fixtureVersion === 2 && !workspace.probes.length) nextActions.push("probe_upgrade");
      if (!verification?.passed) nextActions.push("verify_assessment");
      if (index >= 2 && !application) nextActions.push("apply_guide");
    } else if (stage === "evidence") {
      if (!ownObservations.length) nextActions.push("record_observation");
      if (!ownChain) nextActions.push("propose_chain");
      if (ownChain?.state !== "accepted") nextActions.push("accept_knowledge");
    } else {
      if (currentGuide?.actor !== actor || !currentGuide) nextActions.push("propose_guide");
      if (currentGuide?.actor !== actor || currentGuide?.state !== "accepted") nextActions.push("accept_knowledge");
    }
    const summary = node => node ? { chainId: node.chainId, revision: node.revision, state: node.state } : null;
    return { stage, ready: nextActions.length === 0, nextActions, assessmentVerified: Boolean(verification?.passed),
      ...(stage === "assessment" ? { guideReceived: index >= 2 && retrieved.size > 0, sourceObservationsRead: sourceObservations.size,
        guideApplied: Boolean(application) } : { observations: ownObservations.map(observation => ({ memoryId: observation.memoryId,
        source: observation.source, fragmentIds: observation.fragments.map(fragment => fragment.fragmentId) })), caseChain: summary(ownChain),
        ...(stage === "guide" ? { guide: summary(currentGuide) } : {}) }) };
  };
  const tools = [
    tool("list_files", "List the read-only frozen package investigation files.", {}, [], () => workspace.list()),
    tool("read_file", "Read one exact frozen source path. Required assessment evidence must be read.", { path: { type: "string" } }, ["path"], ({ path }) => workspace.read(path)),
    tool("search_files", "Search literal text in the frozen package snapshot.", { query: { type: "string", maxLength: 128 } }, ["query"], ({ query }) => workspace.search(query)),
    tool("verify_assessment", `Check your assessment against the frozen evidence, returning pass/fail per field, never expected answers. Read these required evidence files: ${specification.evidencePaths.join(", ")}.${specification.fixtureVersion === 2 ? " Run probe_upgrade for this exact version, path and adapterMode first. A blocked decision must preserve the failing unchanged probe, not claim a working fix." : ""} Stores nothing.`,
      schema.properties, schema.required, candidate => {
        verification = checkAssessment(specification, candidate, workspace.filesRead, workspace.probes);
        if (verification.passed && verifiedAt === null) {
          verifiedAt = performance.now() - stageStarted; answer = structuredClone(candidate);
          guideAtAssessment = [...retrieved.values()].find(record => record.snapshot.document.kind === "principle") ?? null;
        }
        emit({ type: "tests", agent: actor, condition, phase: "assessment", passed: verification.passed, passedTests: verification.passedTests,
          expectedTests: verification.expectedTests, checks: verification.checks, sourceSha256: verification.sourceSha256 });
        return verification;
      }),
  ];
  if (specification.fixtureVersion === 2) tools.push(tool("probe_upgrade", "Execute the same three immutable exporter tests in a fresh network-disabled container. Choose an installed branch-kit path and a vendored version, or null targetVersion to preserve it. Apply one transparent caller patch: unchanged, await-string, or await-value. Returns the actual caller source, test counts, failures and source hash. The original case stays read-only. Maximum eight probes per session; policy eligibility is checked separately by verify_assessment.",
    { targetPath: { type: ["string", "null"] }, targetVersion: { type: ["string", "null"] }, adapterMode: { type: "string", enum: adapterModes } },
    ["targetPath", "targetVersion", "adapterMode"], async selection => {
      const result = await workspace.probeUpgrade(selection);
      emit({ type: "upgrade_probe", agent: actor, condition, targetPath: result.targetPath, targetVersion: result.targetVersion, adapterMode: result.adapterMode,
        passed: result.passed, passedTests: result.passedTests, expectedTests: result.expectedTests, sourceSha256: result.sourceSha256, failedTests: result.failedTests });
      return result;
    }));
  if (storeEnabled) tools.push(
    tool("memory_checkpoint", "Check the current phase's remaining memory actions without reading earlier answers or writing anything. Call at phase start and before finishing. Reuse returned saved IDs; do not create duplicate observations or candidates. ready=true means the tracked actions are complete, not that a claim is universally true.",
      {}, [], () => {
        const status = checkpoint(); emit({ type: "memory_checkpoint", agent: actor, condition, phase: stage, ready: status.ready, nextActions: status.nextActions });
        return status;
      }),
    tool("record_observation", "Save a reusable finding, constraint, failed approach, exception or decision in MindLeak. Requires a passing assessment and an exact source quote from a file you read. State the conditions, outcome and what a later investigator should do. Label a failed approach only if it was actually tested. An exact duplicate returns the existing receipt without another write. Use memory_checkpoint to recover earlier IDs.",
      { kind: { type: "string", enum: memoryProtocol.captureKinds }, claim: statement, path: { type: "string" }, quote: { type: "string", minLength: 4, maxLength: 1800 } }, ["claim", "path", "quote"], async ({ kind = "finding", claim, path, quote }) => {
        if (!memoryProtocol.captureKinds.includes(kind)) throw new Error("invalid_observation_kind");
        if (!verification?.passed || !workspace.filesRead.has(path) || !specification.files[path]?.includes(quote)) throw new Error("verified_source_quote_required");
        const text = `Branch-kit ${specification.id} ${kind}: ${claim}\nSource: ${path}\nExact source excerpt: ${quote}`;
        const existing = ledger.observations.find(observation => observation.actor === actor && observation.rawText === text);
        if (existing) {
          emit({ type: "memory_duplicate_reused", agent: actor, memoryId: existing.memoryId, kind });
          return { memoryId: existing.memoryId, fragments: existing.fragments, existing: true };
        }
        return ledger.record(actor, specification, text, path, { kind, claim });
      }),
    tool("recall_guide", "Retrieve a compact current guide from MindLeak using short topic keywords. Assessment responses preserve one accepted principle and sourceReferences for targeted inspection, rather than repeating every chain. Check applicability, revision and current evidence. The first two investigators must complete their independent assessment before reading earlier work. No search proves an exhaustive review.",
      { query: { type: "string", minLength: 1, maxLength: 256 } }, ["query"], async ({ query }) => { canRecall(); return expose(await ledger.search(query, { brief: stage === "assessment" })); }),
    tool("inspect_knowledge", "Inspect a recalled chain or principle, including its stored source and revision. Do not infer persistence from the current conversation.",
      { chainId: { type: "string" } }, ["chainId"], async ({ chainId }) => { canRecall(); return expose(await ledger.inspect(chainId)); }),
    tool("inspect_guide_sources", "Read all stored case chains and the current solution principle from MindLeak by their stable IDs. Returns exact current documents and revisions without duplicate source/history payloads. Use this after your assessment to gather the accepted support IDs for the guide, including any of your own work already saved. Requires independent assessment for the first two investigators.",
      {}, [], async () => { canRecall(); return expose(await ledger.guideSources()); }),
    tool("inspect_observation", "Read an exact source observation cited by a stored chain. Use the actual evidence fragment ID, not the chain ID. The response comes from MindLeak and includes the original source text.",
      { fragmentId: { type: "string" } }, ["fragmentId"], async ({ fragmentId }) => {
        canRecall(); const recovered = await ledger.inspectObservation(fragmentId); sourceObservations.add(recovered.memoryId);
        emit({ type: "observation_inspected", agent: actor, condition, from: recovered.actor, memoryId: recovered.memoryId, fragmentId });
        return recovered;
      }),
    tool("apply_guide", "After verifying your answer, record how you used the guide retrieved BEFORE the assessment. Quote two distinct steps exactly from its conclusion, name current case evidence, and explain whether each applies or is an exception. Inspect at least two distinct source observations cited by the guide's supporting chains first. This records use against a checked case, not proof that every guide statement is true.",
      { chainId: { type: "string" }, revision: { type: "integer", minimum: 1 }, steps: { type: "array", minItems: 2, maxItems: 4,
        items: { type: "object", additionalProperties: false, properties: { quote: { type: "string", minLength: 12, maxLength: 700 },
          decision: { type: "string", enum: ["applies", "exception"] }, evidencePath: { type: "string" }, reason: { ...statement, maxLength: 700 } },
        required: ["quote", "decision", "evidencePath", "reason"] } } }, ["chainId", "revision", "steps"], async detail => {
        if (!verification?.passed || !guideAtAssessment || detail.chainId !== guideAtAssessment.chainId || detail.revision !== guideAtAssessment.revision) throw new Error("guide_must_precede_verified_assessment");
        const current = await ledger.inspect(detail.chainId);
        if (current.chain.revision !== detail.revision) throw new Error("stale_guide_revision");
        const guideDocument = guideAtAssessment.snapshot.document;
        const sourceIds = new Set(guideDocument.supportedBy.flatMap(reference => ledger.nodes.get(reference.chainId)?.document.evidence ?? [])
          .map(reference => ledger.observations.find(observation => observation.fragments.some(fragment => fragment.fragmentId === reference.fragmentId))?.memoryId).filter(Boolean));
        const sourceMemoryIds = [...sourceObservations].filter(id => sourceIds.has(id));
        if (sourceMemoryIds.length < 2) throw new Error("inspect_two_guide_sources");
        if (new Set(detail.steps.map(step => step.quote)).size !== detail.steps.length || detail.steps.some(step => !guideDocument.conclusion.includes(step.quote)
          || !workspace.filesRead.has(step.evidencePath))) throw new Error("exact_guide_steps_and_current_evidence_required");
        const receipt = await ledger.recordApplication(actor, specification, { ...detail, sourceMemoryIds, verifiedAssessment: answer });
        application = { memoryId: receipt.memoryId, chainId: detail.chainId, revision: detail.revision, steps: detail.steps.length, sourceMemoryIds };
        return receipt;
      }),
    tool("propose_chain", `Propose your evidence-backed branch-kit investigation chain. Name case ${specification.id} and its outcome in the claim, so it is distinct from other cases. Requires a passing assessment and real observation fragment IDs from this case. This creates a candidate, not an accepted guide.`,
      documentProperties, documentRequired, async document => {
        if (!verification?.passed) throw new Error("assessment_required");
        if (!document.claim.toLowerCase().includes(specification.id)) throw new Error("case_identity_required_in_claim");
        return ledger.propose(actor, { ...document, kind: "chain", supportedBy: [] });
      }),
    tool("propose_guide", "Build or revise the reusable branch-kit solution guide as a principle supported by all current accepted case chains (at least two). Include your new chain and preserve earlier case support. Use null chainId/expectedRevision only for the first guide; otherwise revise the existing ID/revision. Keep the complete procedure, applicability and exceptions. The candidate still requires accept_knowledge.",
      { ...documentProperties, supportedBy: supports, chainId: { type: ["string", "null"] }, expectedRevision: { type: ["integer", "null"], minimum: 1 } },
      [...documentRequired, "supportedBy", "chainId", "expectedRevision"], async ({ chainId, expectedRevision, ...document }) => {
        if (!verification?.passed) throw new Error("assessment_required");
        return ledger.propose(actor, { ...document, kind: "principle" }, chainId ? { chainId, expectedRevision } : null);
      }),
    tool("accept_knowledge", "Explicitly accept your candidate after checking the assessment and reviewing its cited sources. Preserves its ID and adds a validation revision in MindLeak. This records your validation, not a universal truth claim.",
      { chainId: { type: "string" }, expectedRevision: { type: "integer", minimum: 1 } }, ["chainId", "expectedRevision"],
      ({ chainId, expectedRevision }) => ledger.accept(actor, chainId, expectedRevision, specification, verification)),
  );
  const guideTools = new Set(["memory_checkpoint", "recall_guide", "inspect_knowledge", "inspect_guide_sources", "inspect_observation", "propose_guide", "accept_knowledge"]);
  const evidenceTools = new Set(["memory_checkpoint", "list_files", "read_file", "search_files", "record_observation", "inspect_guide_sources", "inspect_observation", "propose_chain", "accept_knowledge"]);
  const assessmentTools = new Set(["memory_checkpoint", "list_files", "read_file", "search_files", "verify_assessment", "probe_upgrade", "recall_guide", "inspect_knowledge", "inspect_observation", "apply_guide"]);
  const selected = tools.filter(entry => stage === "guide" ? guideTools.has(entry.definition.function.name)
    : stage === "evidence" ? evidenceTools.has(entry.definition.function.name)
      : assessmentTools.has(entry.definition.function.name) && (index >= 2 || entry.definition.function.name !== "apply_guide"));
  const wrapped = selected.map(entry => ({ ...entry, invoke: async (args, context = {}) => {
    onToolDetail({ toolCallId: context.toolCallId ?? randomUUID(), agent: actor, condition, tool: entry.definition.function.name,
      arguments: Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "query", "chainId", "expectedRevision", "targetPath", "targetVersion", "adapterMode"].includes(key))) });
    const started = performance.now();
    const result = await entry.invoke(args);
    if (["recall_guide", "inspect_knowledge", "inspect_guide_sources", "inspect_observation"].includes(entry.definition.function.name)) {
      const read = { tool: entry.definition.function.name, bytes: Buffer.byteLength(JSON.stringify(result)), elapsedMs: performance.now() - started,
        view: result.view ?? "detail", distinctKnowledgeReceived: accessedKnowledge.size, distinctSourcesInspected: sourceObservations.size };
      memoryReads.push(read); emit({ type: "memory_read", agent: actor, condition, phase: stage, ...read });
    }
    return result;
  } }));
  return { tools: wrapped, workspace, accessedKnowledge, receivedOwners, sourceObservations, checkpoint, memoryReads,
    get application() { return application; },
    get verification() { return verification; }, get answer() { return answer; }, get investigationMs() { return verifiedAt; } };
}

export async function runMemoryLab({ driver, agentsByRole, onEvent = () => {}, onMemory = () => {}, onKnowledge = () => {}, onToolDetail = () => {},
  maxAttempts = 2, signal, code, problem = memoryLabProblem } = {}) {
  if (!driver?.capabilities?.knowledge || !driver.capabilities.chains) throw new Error("Lab_2_requires_MindLeak_v0_6_knowledge_tools");
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3 || memoryLabRoles.some(role => !agentsByRole?.[role.id]?.run)) throw new Error("invalid_memory_lab_configuration");
  const runId = randomUUID(); const scope = `memory-lab-${runId}`; const createdAt = new Date().toISOString(); const started = performance.now();
  if (!code) throw new Error("code_execution_requires_explicit_container");
  const events = []; const memoryExhibits = []; const toolExhibits = []; const memoryUsage = []; const cases = upgradeCases(); const comparisons = [];
  const expectedTests = 35;
  const agents = memoryLabRoles.map(role => ({ ...role, model: agentsByRole[role.id].configuration.model, state: "queued", attempts: [], evidenceAttempts: [], guideAttempts: [] }));
  const emit = record => { if (events.length >= 20000) throw new Error("memory_lab_event_budget"); const event = { id: events.length + 1, atMs: performance.now() - started, ...record }; events.push(event); onEvent(structuredClone(event)); };
  const ledger = createKnowledgeLedger({ driver, runId, scope, emit, onMemory: record => { memoryExhibits.push(record); onMemory(record); }, onKnowledge });
  const unsubscribe = driver.observeInference?.(event => { if (event.type === "inference_finished") memoryUsage.push(event); emit(event); });
  let guide = null; let failure = null;
  emit({ type: "run_started", runId, title: "The Package Investigation Guide", experiment: 2, agents: 5, expectedTests });
  try {
    for (let index = 0; index < agents.length && !signal?.aborted; index += 1) {
      const actor = agents[index]; const specification = cases[index]; const agent = agentsByRole[actor.id];
      actor.state = "running"; emit({ type: "agent_state", agent: actor.id, state: "running", caseId: specification.id });
      const controls = ["withMemory"];
      const results = {};
      for (const condition of controls) {
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
          const session = investigatorTools({ driver, scope, actor: actor.id, specification, ledger, condition, index, emit, code,
            onToolDetail: detail => { toolExhibits.push(detail); onToolDetail(detail); } });
          const reused = index >= 2 && condition === "withMemory";
          const instructions = [
            memoryStartPrompt({ mode: condition === "withMemory" ? "learning" : "withoutMemory", independent: index < 2 }),
            `You are ${actor.name}. This is the ASSESSMENT phase for the frozen branch-kit case ${specification.id}. Overall experiment brief: ${problem}`,
            `Files and advisories are synthetic. Read the required evidence: ${specification.evidencePaths.join(", ")}. Inspect extra module/release code as needed. Choose the exact installed path, eligible version and caller adapterMode. Run probe_upgrade, then verify_assessment; correct failed fields from source evidence, not guesses. A patched dependency can still break its caller. A blocked decision must retain the unchanged failing code rather than invent an eligible fix.`,
            reused ? "FIRST call memory_checkpoint, then recall_guide with short branch-kit terms. Use the compact CURRENT accepted principle to plan the investigation; do not request all chain histories. From sourceReferences choose evidence from at least TWO DISTINCT source episodes and inspect those observation fragments. Read more only when needed to resolve an exception. Apply the procedure to this NEW case before verify_assessment; never copy an earlier version or outcome. Then apply_guide with two exact guide-step quotations, current evidence paths and how each step applies or needs an exception. This explicitly stores the verified guide-use record."
              : index < 2 ? "Complete the assessment independently before reading any earlier investigation."
                : "This is the no-memory control. No earlier guide is available.",
            condition === "withMemory" ? "Stop after the verified assessment and, for later investigators, the apply_guide record. Separate evidence-capture and guide-authoring phases follow this one. You do NOT need to record observations, create a case chain or revise the principle in this assessment phase. Those tools are deliberately unavailable."
              : "Finish once verify_assessment passes. Do not store anything.",
            index < 2 && condition === "withMemory" ? "There is no existing principle to apply in this independent seed assessment. Finish when verify_assessment passes; do not attempt any memory writes in this phase." : "",
            condition === "withMemory" ? "Before finishing, call memory_checkpoint and complete its remaining actions. A checkpoint is read-only; an empty or repeated result is not new knowledge." : "",
            attempt > 1 && condition === "withMemory" ? "This is an explicit retry. Use memory_checkpoint to identify unfinished assessment actions; evidence capture and guide authoring belong to later phases." : "",
            'Finish with JSON {"completed":true} only after the required tool operations succeed; otherwise {"completed":false}.',
          ].filter(Boolean).join("\n");
          emit({ type: "attempt_started", agent: actor.id, condition, attempt, caseId: specification.id });
          const execution = await agent.run(instructions, session.tools, "", { type: "object", properties: { completed: { type: "boolean" } }, required: ["completed"], additionalProperties: false },
            { signal, onEvent: event => emit({ ...event, agent: actor.id, condition, attempt }) });
          const received = session.receivedOwners.size > 0;
          const applied = Boolean(session.application);
          const passed = execution.status === "completed" && session.verification?.passed && (!reused || received && applied);
          const result = { ...publicExecution(execution), condition, attempt, caseId: specification.id, verification: session.verification,
            selfReportedComplete: execution.answer?.completed === true,
            answer: session.answer, investigationMs: session.investigationMs, upgradeProbes: session.workspace.probes, knowledgeReceived: received, caseChainPublished: false,
            guideApplied: applied, guideApplication: session.application, knowledgeRecordsReceived: session.accessedKnowledge.size,
            sourceObservationsRead: session.sourceObservations.size, memoryReads: session.memoryReads, memoryCheckpoint: session.checkpoint(), guidePublished: false, passed: Boolean(passed) };
          actor.attempts.push(result); results[condition] = result;
          emit({ type: "assessment_finished", agent: actor.id, condition, attempt, caseId: specification.id, passed: Boolean(passed), investigationMs: session.investigationMs,
            knowledgeReceived: received, guideApplied: applied, checksPassed: session.verification?.passedTests ?? 0 });
          if (passed || signal?.aborted) break;
        }
      }
      let caseChainPublished = false;
      if (results.withMemory?.passed) {
        for (let attempt = 1; attempt <= maxAttempts && !signal?.aborted; attempt += 1) {
          const author = investigatorTools({ driver, scope, actor: actor.id, specification, ledger, condition: "withMemory", index, emit, code,
            stage: "evidence", priorAssessment: results.withMemory, onToolDetail: detail => { toolExhibits.push(detail); onToolDetail(detail); } });
          const instructions = [
            memoryStartPrompt({ stage: "evidence" }),
            `You are ${actor.name}. This is the EVIDENCE-CAPTURE phase for branch-kit case ${specification.id}. The source-grounded assessment passed: ${JSON.stringify(results.withMemory.answer)}.`,
            `Actual probe receipts from that assessment: ${JSON.stringify(results.withMemory.upgradeProbes.map(({ callerSource, ...probe }) => probe))}. A probe that was not run is not a failed approach you may claim to have tested.`,
            "FIRST call memory_checkpoint to recover already-saved IDs. Read relevant frozen sources and retain the useful finding, constraint, failed option, exception or decision with record_observation, its kind and an exact source quotation. State the condition, observed outcome and next action. Group related evidence; do not save each JSON line or every file as a separate note. Preserve unknowns and no-upgrade/not-shipped outcomes. Reuse equivalent observations instead of rewording duplicates. Then cite the returned IDs in ONE case-specific chain naming this case and checked outcome, and explicitly accept it.",
            "You do not need to repeat verify_assessment or author a principle in this phase; those tools are deliberately unavailable. The next phase will build the shared guide from your accepted case chain and earlier chains.",
            attempt > 1 ? "First inspect_guide_sources to find your already-stored candidate or accepted chain. Reuse it and finish any pending acceptance; do not create duplicates." : "",
            "Before finishing, call memory_checkpoint and resolve missing actions. Do not increase the write count for its own sake.",
            'Finish with JSON {"completed":true} after the case chain is accepted, otherwise {"completed":false}.',
          ].filter(Boolean).join("\n");
          emit({ type: "evidence_phase_started", agent: actor.id, attempt, caseId: specification.id });
          const execution = await agent.run(instructions, author.tools, "", { type: "object", properties: { completed: { type: "boolean" } }, required: ["completed"], additionalProperties: false },
            { signal, onEvent: event => emit({ ...event, agent: actor.id, condition: "evidence", attempt }) });
          const ownChain = [...ledger.nodes.values()].find(node => node.actor === actor.id && node.document.kind === "chain" && node.state === "accepted");
          caseChainPublished = execution.status === "completed" && Boolean(ownChain);
          actor.evidenceAttempts.push({ ...publicExecution(execution), phase: "evidence", attempt, passed: caseChainPublished,
            selfReportedComplete: execution.answer?.completed === true, chainId: ownChain?.chainId ?? null, revision: ownChain?.revision ?? null,
            memoryReads: author.memoryReads, memoryCheckpoint: author.checkpoint() });
          emit({ type: "evidence_phase_finished", agent: actor.id, attempt, passed: caseChainPublished, chainId: ownChain?.chainId });
          if (caseChainPublished) break;
        }
        results.withMemory.caseChainPublished = caseChainPublished;
      }
      let guidePublished = index === 0 && caseChainPublished;
      if (caseChainPublished && index > 0) {
        for (let attempt = 1; attempt <= maxAttempts && !signal?.aborted; attempt += 1) {
          const author = investigatorTools({ driver, scope, actor: actor.id, specification, ledger, condition: "withMemory", index, emit, code,
            stage: "guide", priorAssessment: results.withMemory, onToolDetail: detail => { toolExhibits.push(detail); onToolDetail(detail); } });
          const instructions = [
            memoryStartPrompt({ stage: "guide" }),
            `You are ${actor.name}, continuing as the guide author for branch-kit case ${specification.id}. Your independent case assessment passed and your case chain is already accepted in MindLeak.`,
            "No earlier conversation is available. FIRST call memory_checkpoint, then inspect_guide_sources to retrieve current accepted case chains and the existing principle from MindLeak. Recover the findings and evidence from storage, not a previous conversation.",
            "Use propose_guide to author a complete reusable solution principle with ALL current accepted case chains in supportedBy, including your own. If a principle exists, retain its chainId and use its current revision as expectedRevision; otherwise use null for both. Preserve the earlier supported procedure and add the current case's lesson or exception.",
            "Put a concise ordered procedure in conclusion (under 1800 characters), a branch-kit claim, auditable rationale, applicability and assumptions. Direct evidence may only be counterexamples; positive support comes from accepted chains. Do not fabricate certainty or independent corroboration.",
            "Then explicitly call accept_knowledge on the returned candidate ID/revision. A proposed-but-unaccepted guide is unfinished. Do not just repeat the previous guide or describe an action without executing it.",
            "Finish with memory_checkpoint. Preserve an actionable short guide and the exceptions learned; raw observations stay in the source records rather than being copied into the procedure.",
            'Finish with JSON {"completed":true} only after the guide acceptance succeeds, otherwise {"completed":false}.',
          ].join("\n");
          emit({ type: "guide_phase_started", agent: actor.id, attempt, caseId: specification.id });
          const execution = await agent.run(instructions, author.tools, "", { type: "object", properties: { completed: { type: "boolean" } }, required: ["completed"], additionalProperties: false },
            { signal, onEvent: event => emit({ ...event, agent: actor.id, condition: "guide", attempt }) });
          const current = ledger.guideId ? ledger.nodes.get(ledger.guideId) : null;
          guidePublished = execution.status === "completed" && current?.actor === actor.id && current.state === "accepted";
          actor.guideAttempts.push({ ...publicExecution(execution), phase: "guide", attempt, passed: Boolean(guidePublished),
            selfReportedComplete: execution.answer?.completed === true,
            chainId: current?.chainId ?? null, revision: current?.revision ?? null, memoryReads: author.memoryReads, memoryCheckpoint: author.checkpoint() });
          emit({ type: "guide_phase_finished", agent: actor.id, attempt, passed: Boolean(guidePublished), revision: current?.revision });
          if (guidePublished) break;
        }
        results.withMemory.guidePublished = Boolean(guidePublished);
      }
      actor.state = results.withMemory?.passed && caseChainPublished && guidePublished ? "passed" : "failed";
      emit({ type: "agent_state", agent: actor.id, state: actor.state });
      if (actor.state !== "passed") { failure = "investigation_or_guide_not_verified"; break; }
      await ledger.provePersistence(actor.id);
      guide = await ledger.exportGuide();
      if (guide) { onKnowledge({ guide }); emit({ type: "guide_extracted", agent: actor.id, chainId: guide.chainId, revision: guide.revision, extractedAt: guide.extractedAt }); }
    }
  } catch (error) {
    const allowed = ["observation_persistence_mismatch", "chain_persistence_mismatch", "memory_server_did_not_restart", "guide_export_mismatch", "mcp_tool_failed", "mcp_invalid_result"];
    failure = allowed.includes(error?.message) ? error.message : "memory_lab_execution_failed";
    emit({ type: "run_error", reason: failure });
  } finally { unsubscribe?.(); }
  for (const actor of agents) if (["queued", "running"].includes(actor.state)) { actor.state = signal?.aborted ? "cancelled" : "blocked"; emit({ type: "agent_state", agent: actor.id, state: actor.state }); }
  const executions = agents.flatMap(actor => [...actor.attempts, ...actor.evidenceAttempts, ...actor.guideAttempts]);
  const sum = (records, field) => records.every(record => Number.isSafeInteger(record[field])) ? records.reduce((total, record) => total + record[field], 0) : null;
  const passed = !failure && !signal?.aborted && agents.every(actor => actor.state === "passed") && Boolean(guide);
  const status = signal?.aborted ? "cancelled" : passed ? "completed" : "partial";
  const checksPassed = agents.reduce((total, actor) => total + [...new Map(actor.attempts.map(attempt => [attempt.condition, attempt])).values()].reduce((sum, attempt) => sum + (attempt.verification?.passedTests ?? 0), 0), 0);
  emit({ type: "tests", agent: "system", phase: "final", passed, passedTests: checksPassed, expectedTests });
  emit({ type: "run_finished", status });
  return { reportVersion: 1, kind: "memory_lab", experiment: 2, title: "The Package Investigation Guide", runId, createdAt, status, failure, problem, memoryProtocol,
    agents, events, elapsedMs: performance.now() - started, server: driver.server, binarySha256: driver.binarySha256, realMcpProcess: driver.realProcess, code,
    comparisons, memoryExhibits, toolExhibits, scope, guide,
    knowledge: { observations: ledger.observations, chains: [...ledger.nodes.values()].filter(node => node.document.kind === "chain"),
      principles: [...ledger.nodes.values()].filter(node => node.document.kind === "principle"), operations: ledger.operations, durability: ledger.durability, applications: ledger.applications, guide },
    summary: { agents: 5, agentsPassed: agents.filter(actor => actor.state === "passed").length, inputTokens: sum(executions, "inputTokens"), outputTokens: sum(executions, "outputTokens"),
      toolCalls: executions.reduce((total, execution) => total + execution.toolCalls, 0), memoriesStored: ledger.operations.length,
      observationsStored: ledger.observations.length, chainsStored: [...ledger.nodes.values()].filter(node => node.document.kind === "chain").length,
      principlesStored: [...ledger.nodes.values()].filter(node => node.document.kind === "principle").length, restartsVerified: ledger.durability.length,
      crossAgentHandoffs: events.filter(event => event.type === "memory_delivered").length,
      guideApplications: ledger.applications.length, sourceObservationsInspected: events.filter(event => event.type === "observation_inspected").length,
      retrievalToolCalls: events.filter(event => event.type === "memory_read").length,
      retrievalBytes: events.filter(event => event.type === "memory_read").reduce((total, event) => total + event.bytes, 0),
      duplicateWritesAvoided: events.filter(event => event.type === "memory_duplicate_reused").length },
    memoryProcessing: { workload: "memory", modelClass: "slm", model: driver.configuration?.decompositionModel ?? null, mode: driver.configuration?.decomposition ?? "sentences",
      calls: memoryUsage.length, inputTokens: sum(memoryUsage, "inputTokens"), outputTokens: sum(memoryUsage, "outputTokens") },
    finalTests: { passed, passedTests: checksPassed, expectedTests }, fixtureVersion: 2,
    cases: cases.map(({ id, family, split, fixtureSha256 }) => ({ id, family, split, fixtureSha256 })), fixtureSha256: digest(cases.map(specification => specification.fixtureSha256)),
    agent: { model: "Mixed frontier models", provider: "copilot" },
    interpretation: "Five fresh investigators prepare a guide using frozen report-export upgrades with real sandboxed caller tests and transparent bounded patch options. Correctly blocked decisions retain unresolved test failures. Observations, accepted chains and a revisioned principle are stored in MindLeak and recovered after actual MCP-server restarts. This preparation is charged in full to the memory side; simultaneous Dalek controls run separately on new cases. Guide prose is agent-authored, not an independently adjudicated truth proof." };
}
