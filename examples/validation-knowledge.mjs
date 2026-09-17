import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { scoreRanking, summarizeQueries } from "./benchmark-recall.mjs";
import { digest } from "./validation-scenarios.mjs";

const fixtureBytes = readFileSync(new URL("./fixtures/knowledge-v1.json", import.meta.url));
const fixture = JSON.parse(fixtureBytes);
export const knowledgeFixtureIdentity = { id: fixture.id, sha256: digest(fixtureBytes), cases: fixture.cases.length, status: fixture.status };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function knowledgeFailure(error) {
  const allowed = ["provider_request_failed", "provider_http_error", "invalid_provider_response", "truncated_provider_output",
    "citation_validation_failed", "formation_validation_failed", "input_or_output_budget", "mcp_protocol_failure"];
  return { status: "error", reason: allowed.includes(error?.code) ? error.code : "formation_failed_not_abstention",
    elapsedMs: Number.isFinite(error?.elapsedMs) ? error.elapsedMs : null };
}

function latency(values) {
  const ordered = [...values].sort((left, right) => left - right);
  return { count: ordered.length, p50Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.5) - 1)] ?? null,
    p95Ms: ordered[Math.max(0, Math.ceil(ordered.length * 0.95) - 1)] ?? null,
    maxMs: ordered.at(-1) ?? null };
}

export function scoreKnowledgeResponse(data, known, relevant, limit = 5) {
  assert.equal(data.kind, "knowledge");
  assert.ok(Array.isArray(data.principles) && Array.isArray(data.chains) && Array.isArray(data.observations));
  const records = [...data.principles, ...data.chains];
  assert.ok(records.length <= limit);
  const evidenceBundle = new Set();
  const checkDocument = (actual, expected) => {
    for (const field of ["kind", "claim", "conclusion", "applicability", "assumptions", "evidence", "supportedBy"]) {
      assert.deepEqual(actual[field], expected[field], `changed knowledge ${field}`);
    }
  };
  const ranked = records.map(record => {
    const expected = known.get(record.chain?.chainId);
    if (!expected) return `unknown-${record.chain?.chainId}`;
    assert.equal(record.requiresReview, false);
    assert.equal(record.chain.snapshot.state, "accepted");
    checkDocument(record.chain.snapshot.document, expected.document);
    evidenceBundle.add(expected.id);
    for (const support of record.supportingChains ?? []) {
      const source = known.get(support.reference?.chainId);
      if (!source || !support.document || support.requiresReview || support.state !== "accepted") continue;
      assert.ok(expected.document.supportedBy.some(reference => reference.chainId === support.reference.chainId && reference.revision === support.reference.revision));
      checkDocument(support.document, source.document);
      evidenceBundle.add(source.id);
    }
    assert.ok(Number.isFinite(record.score));
    return expected.id;
  });
  return { ranked, ...scoreRanking(ranked, relevant, limit),
    evidenceBundleRecall: relevant.length ? relevant.filter(id => evidenceBundle.has(id)).length / new Set(relevant).size : null,
    detailsTruncated: records.some(record => record.evidenceDetailsTruncated) };
}

export async function runKnowledgeValidation(driver, { passes = 3, formationCases = 2, onProgress = () => {} } = {}) {
  if (!driver.capabilities?.knowledge || !driver.capabilities?.chains || !driver.capabilities?.formation) {
    return { status: "error", reason: "knowledge_schema_required", fixture: knowledgeFixtureIdentity };
  }
  assert.ok(Number.isInteger(passes) && passes >= 1 && passes <= 5);
  assert.ok(Number.isInteger(formationCases) && formationCases >= 0 && formationCases <= fixture.cases.length);
  const scope = `knowledge-eval-${randomUUID()}`;
  const agentId = `knowledge-evaluator-${randomUUID()}`;
  const context = { scope, sessionId: randomUUID(), source: `synthetic:${fixture.id}` };
  const measurements = [];
  const operations = [];
  const checks = [];
  const formations = [];
  const known = new Map();
  const episodes = new Map();
  const cases = [];
  const started = performance.now();
  const check = (name, condition) => { checks.push({ name, passed: condition }); assert.ok(condition, name); };
  const call = async (name, arguments_) => {
    const result = await driver.call(name, arguments_);
    operations.push({ tool: name, operation: arguments_.chain?.operation ?? arguments_.knowledge?.operation ?? (arguments_.formation ? "formation" : "ordinary"),
      elapsedMs: result.elapsedMs, resultBytes: result.resultBytes });
    assert.ok(result.resultBytes <= 512 * 1024);
    return result;
  };
  const write = async chain => {
    const arguments_ = { agentId, context, text: "Recorded synthetic knowledge evaluation decision.", requestId: randomUUID(), chain };
    const { data } = await call("write_memory", arguments_);
    assert.ok(uuid.test(data.memoryId) && data.chainId === chain.chainId);
    return { arguments: arguments_, receipt: data };
  };
  const validation = reviewed => ({ method: "Compare the fixed synthetic fixture and stated conditions.",
    result: "Accepted within the fixture, not a real-world claim.", source: `synthetic:${fixture.id}/validation`, counterEvidenceReviewed: reviewed });
  const search = query => call("recall_memory", { knowledge: { operation: "search", query }, scope, limit: 5 });
  try {
    for (const specification of fixture.cases) {
      const observations = [];
      for (const [index, text] of [...specification.observations, specification.counterexample].entries()) {
        const { data } = await call("write_memory", { agentId, context, text, requestId: randomUUID() });
        assert.equal(data.fragments.length, 1);
        observations.push(data);
        episodes.set(data.fragments[0].fragmentId, `${specification.id}/observation-${index}`);
      }
      const chains = [];
      const documents = [];
      for (const [index, observation] of observations.slice(0, 2).entries()) {
        const document = { kind: "chain", claim: `${specification.subject} comparison ${index + 1}: ${specification.claim}`,
          rationale: "This recorded observation supports the conditional conclusion, not an unrestricted generalization.",
          conclusion: specification.conclusion, applicability: specification.applicability,
          assumptions: [specification.assumption], supportedBy: [], evidence: [{ fragmentId: observation.fragments[0].fragmentId, role: "supports", reason: "Recorded controlled fixture outcome." }] };
        const chainId = randomUUID();
        await write({ operation: "propose", chainId, document });
        await write({ operation: "accept", chainId, expectedRevision: 1, validation: validation([]) });
        known.set(chainId, { id: `${specification.id}/chain-${index}`, document });
        chains.push({ chainId, revision: 2, reason: "Validated controlled fixture comparison." });
        documents.push(document);
      }
      const document = { kind: "principle", claim: specification.claim, rationale: "Two validated comparisons support this bounded generalization.",
        conclusion: specification.conclusion, applicability: specification.applicability,
        assumptions: [specification.assumption], evidence: [], supportedBy: chains };
      const chainId = randomUUID();
      const proposed = await write({ operation: "propose", chainId, document });
      const candidateSearch = await search(specification.keywords);
      check(`${specification.id}/candidate-excluded`, ![...candidateSearch.data.principles, ...candidateSearch.data.chains].some(result => result.chain.chainId === chainId));
      await write({ operation: "accept", chainId, expectedRevision: 1, validation: validation([]) });
      known.set(chainId, { id: `${specification.id}/principle`, document });
      cases.push({ specification, observations, chains, documents, document, chainId, proposed });
    }
    const restart = await driver.restart();
    for (let pass = 1; pass <= passes; pass += 1) {
      for (const entry of cases) {
        for (const queryKind of ["keywords", "paraphrase", "missing"]) {
          const query = entry.specification[queryKind];
          const relevant = queryKind === "missing" ? [] : [`${entry.specification.id}/principle`, `${entry.specification.id}/chain-0`, `${entry.specification.id}/chain-1`];
          const observationRelevant = queryKind === "missing" ? [] : entry.observations.map(observation => episodes.get(observation.fragments[0].fragmentId));
          const order = pass % 2 ? ["knowledge", "ordinary"] : ["ordinary", "knowledge"];
          for (const mode of order) {
            const result = mode === "knowledge" ? await search(query) : await call("recall_memory", { query, scope, limit: 5 });
            const score = mode === "knowledge" ? scoreKnowledgeResponse(result.data, known, relevant)
              : scoreRanking(result.data.results.map(record => episodes.get(record.fragmentId) ?? `unknown-${record.fragmentId}`), observationRelevant, 5);
            measurements.push({ id: `${entry.specification.id}/${queryKind}`, querySha256: digest(query), pass, mode, ...score,
              elapsedMs: result.elapsedMs, resultBytes: result.resultBytes });
          }
        }
      }
      onProgress({ event: "knowledge_pass", pass, queries: fixture.cases.length * 3 * 2 });
    }
    for (const [index, entry] of cases.entries()) {
      const { specification, chainId, chains, documents, observations } = entry;
      const counterId = observations[2].fragments[0].fragmentId;
      const counter = { fragmentId: counterId, role: "counterexample", reason: "The gamma observation limits wider application." };
      await write({ operation: "challenge", chainId: chains[0].chainId, expectedRevision: 2, evidence: [counter] });
      const invalidated = await search(specification.keywords);
      check(`${specification.id}/stale-principle-excluded`, !invalidated.data.principles.some(result => result.chain.chainId === chainId));
      const inspected = await call("recall_memory", { chain: { operation: "inspect", chainId }, scope, limit: 2 });
      check(`${specification.id}/acceptance-not-rewritten`, inspected.data.requiresReview && inspected.data.chain.revision === 2 && inspected.data.chain.snapshot.state === "accepted");
      const dependents = await call("recall_memory", { knowledge: { operation: "dependents", chainId: chains[0].chainId }, scope });
      check(`${specification.id}/dependent-visible`, dependents.data.entries.some(record => record.chain.chainId === chainId && record.requiresReview));
      documents[0] = { ...documents[0], applicability: `${specification.applicability} Gamma is excluded by its counterexample.`, evidence: [...documents[0].evidence, counter] };
      await write({ operation: "revise", chainId: chains[0].chainId, expectedRevision: 3, document: documents[0] });
      await write({ operation: "accept", chainId: chains[0].chainId, expectedRevision: 4, validation: validation([counterId]) });
      const revisedDocument = { ...entry.document, applicability: `${specification.applicability} Gamma is excluded.`, supportedBy: [{ ...chains[0], revision: 5 }, chains[1]] };
      await write({ operation: "revise", chainId, expectedRevision: 2, document: revisedDocument });
      await write({ operation: "accept", chainId, expectedRevision: 3, validation: validation([]) });
      const exported = await call("recall_memory", { knowledge: { operation: "export", chainId, format: "json" }, scope, limit: 2 });
      check(`${specification.id}/revision-export`, exported.data.snapshot.chain.revision === 4 && exported.data.snapshot.nextRevision === 2 && !exported.data.snapshot.requiresReview);
      check(`${specification.id}/inherited-counterevidence`, exported.data.snapshot.supportingChains.some(source => source.evidence.some(reference => reference.reference.fragmentId === counterId)));
      check(`${specification.id}/independent-source-count`, exported.data.snapshot.observationSources.length === 3);
      const markdown = await call("recall_memory", { knowledge: { operation: "export", chainId, format: "markdown", afterRevision: 2 }, scope, limit: 2 });
      check(`${specification.id}/markdown-history`, typeof markdown.data.markdown === "string" && markdown.data.snapshot.nextRevision === null && markdown.data.snapshot.history.length === 2);
      const replay = await call("write_memory", entry.proposed.arguments);
      check(`${specification.id}/original-receipt`, JSON.stringify(replay.data) === JSON.stringify(entry.proposed.receipt));
      if (driver.configuration?.formation === "openai" && index < formationCases) {
        for (const kind of ["chain", "principle"]) {
          try {
            const formation = kind === "chain" ? { kind, fragmentIds: observations.map(observation => observation.fragments[0].fragmentId), scope }
              : { kind, chains: revisedDocument.supportedBy, fragmentIds: [counterId], scope };
            const result = await call("decompose_memory", { text: `What conditional lesson is supported for ${specification.subject}, and what evidence limits it?`, formation });
            assert.equal(result.data.status, "candidate");
            const projection = await call("recall_memory", { chain: { operation: "inspect", chainId }, scope, limit: 1 });
            check(`${specification.id}/${kind}-preview-read-only`, projection.data.chain.revision === 4);
            formations.push({ id: specification.id, kind, status: "completed", model: result.data.model,
              candidates: result.data.proposal.documents.length, citations: result.data.proposal.citations.length, gaps: result.data.proposal.gaps.length,
              sourceAndCitationChecks: true, semanticAccuracy: null, semanticAccuracyReason: "requires_independent_adjudication",
              elapsedMs: result.elapsedMs, resultBytes: result.resultBytes,
              outputSha256: digest(result.data.proposal) });
          } catch (error) { formations.push({ id: specification.id, kind, ...knowledgeFailure(error) }); }
        }
      }
      await write({ operation: "retire", chainId, expectedRevision: 4 });
      const retired = await search(specification.keywords);
      check(`${specification.id}/retired-excluded`, !retired.data.principles.some(result => result.chain.chainId === chainId));
    }
    const modes = Object.fromEntries(["ordinary", "knowledge"].map(mode => [mode,
      Array.from({ length: passes }, (_, index) => {
        const rows = measurements.filter(row => row.mode === mode && row.pass === index + 1);
        return { pass: index + 1, ...summarizeQueries(rows), latency: latency(rows.map(row => row.elapsedMs)),
          ...(mode === "knowledge" ? { evidenceBundleRecall: rows.filter(row => row.evidenceBundleRecall !== null)
            .reduce((total, row) => total + row.evidenceBundleRecall, 0) / rows.filter(row => row.evidenceBundleRecall !== null).length } : {}),
          maxResultBytes: Math.max(...rows.map(row => row.resultBytes)),
          meanResultBytes: rows.reduce((total, row) => total + row.resultBytes, 0) / rows.length };
      })]));
    return { status: formations.some(result => result.status === "error") ? "error" : "measured", fixture: knowledgeFixtureIdentity,
      scopeSha256: digest(scope), cases: cases.length, passes, restart, realServerProcess: driver.realProcess,
      queryCount: measurements.length, measurements, modes, checks, operations,
      formation: { status: formations.length ? "measured" : "not_measured", reason: formations.length ? null : "requires_explicit_formation_openai",
        cases: formations, tokenUsage: null, tokenUsageReason: "memory_provider_usage_not_reported" },
      elapsedMs: performance.now() - started,
      interpretation: "Exposed synthetic retrieval and lifecycle evaluation. Manual candidates have fixed source labels. Modes have different target types, so their recall scores are not interchangeable. Bytes are not tokens; repeated passes are not independent tasks. No semantic accuracy or learning benefit is inferred." };
  } catch {
    return { status: "error", reason: "knowledge_execution_failed", fixture: knowledgeFixtureIdentity, measurements, checks, operations,
      formation: { cases: formations }, elapsedMs: performance.now() - started };
  }
}
