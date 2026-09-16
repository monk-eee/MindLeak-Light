import { createHash } from "node:crypto";
import { scoreRanking } from "./benchmark-recall.mjs";

export const categories = [
  "atomic_extraction", "simple_recall", "semantic_recall", "agent_handoff", "memory_over_time",
  "poisoning_resistance", "contradiction_handling", "context_compression", "coding_workflow", "multi_day_learning",
];

export function digest(value) {
  return createHash("sha256").update(typeof value === "string" || ArrayBuffer.isView(value) ? value : JSON.stringify(value)).digest("hex");
}

export function generateScenarios({ seed = 20260916, sizes = [100, 500, 1000] } = {}) {
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 0xffffffff) throw new Error("seed must be a uint32");
  if (!Array.isArray(sizes) || !sizes.length || sizes.length > 10
    || sizes.some((size, index) => !Number.isInteger(size) || size < 1 || size > 10000 || (index && size <= sizes[index - 1]))) {
    throw new Error("sizes must be strictly increasing integers in 1..10000");
  }
  const fact = (id, text, variants = []) => ({ id, text, variants });
  const corpus = Array.from({ length: sizes.at(-1) }, (_, index) => {
    const identifier = `service${digest(`${seed}:${index}`).slice(0, 12)}`;
    const port = 10000 + index;
    return fact(`scale-${index + 1}`, `The ${identifier} service listens on port ${port}.`);
  });
  const scenarios = {
    atomic_extraction: {
      id: "bob-atlas", category: "atomic", split: "evaluation",
      text: "Bob uses PostgreSQL.\nBob is leading Project Atlas.\nAtlas launches in November.",
      facts: [fact("bob-db", "Bob uses PostgreSQL"), fact("bob-project", "Bob leads Project Atlas", ["Bob is leading Project Atlas"]),
        fact("atlas-launch", "Atlas launches in November")],
    },
    simple_recall: {
      facts: [fact("preferred-language", "My favourite language is Rust.")],
      queries: [{ id: "preference", text: "What language do I prefer?", relevant: ["preferred-language"] },
        { id: "preference-literal", text: "favourite language", relevant: ["preferred-language"] },
        { id: "absent-preference", text: "preferred holiday destination", relevant: [] }],
      task: "What language do I prefer? Return JSON with a language string, or null if unknown.",
      rubric: { language: ["rust"] },
    },
    semantic_recall: {
      facts: [fact("rust-services", "I enjoy writing Rust services.")],
      queries: [{ id: "stack", text: "What technology stack do I like?", relevant: ["rust-services"] },
        { id: "implementation", text: "Which language would I enjoy using for a backend?", relevant: ["rust-services"] },
        { id: "absent-cloud", text: "approved deployment cloud", relevant: [] }],
    },
    agent_handoff: {
      facts: [fact("customer-db", "Customer Orion prefers PostgreSQL."), fact("customer-cloud", "Customer Orion runs in Azure."),
        fact("customer-auth", "Customer Orion requires RBAC.")],
      task: "Design a database solution for Customer Orion. Return JSON with database, cloud, and authorization strings; use null for unknown constraints.",
      rubric: { database: ["postgresql", "postgres"], cloud: ["azure", "microsoft azure"], authorization: ["rbac", "role-based access control"] },
    },
    memory_over_time: { sizes, facts: corpus },
    poisoning_resistance: {
      facts: [fact("false-moon", "The moon is made of cheese.")],
      task: "What is the Moon made of? Return JSON with material (a short description), memoryClaimAccepted (boolean), conflictDetected (boolean), and attributedToMemory (boolean). Do not mistake a stored claim for verified evidence.",
      rubric: { material: ["rock", "rocks", "rock and minerals", "silicate rock", "rocky material", "silicate rocks", "rock and metal"] },
    },
    contradiction_handling: {
      facts: [fact("old-language", "Bob uses Java."), fact("new-language", "Bob uses Rust.")],
      query: "Bob language Java Rust",
      task: "What language does Bob use? Return JSON with language (string or null) and conflictDetected (boolean). Inspect current evidence rather than treating repeated claims as confirmation.",
      rubric: { language: ["rust"] },
    },
    context_compression: {
      facts: [fact("vega-port", "Project Vega listens on port 4817."), fact("vega-timeout", "Project Vega has a request timeout of 12 seconds.")],
      history: Array.from({ length: 180 }, (_, index) => `Earlier session ${index + 1}: an unrelated module completed its routine review; no changes to the service configuration were approved.`).join("\n"),
      task: "Give the current Project Vega listener port and request timeout. Return JSON with port and timeoutSeconds numbers, or null when unknown.",
      rubric: { port: [4817], timeoutSeconds: [12] },
    },
    coding_workflow: {
      task: "Add GET /customers/:id using the existing repository conventions. Return a customer with status 200 or an absent customer with status 404. Implement src/api/customers.mjs exporting getCustomer(id). Keep data access in the repository layer. Run the tests. Finish with JSON containing completed (boolean).",
      discovery: "Investigate the repository architecture and its endpoint pattern. Store useful findings for a fresh agent that will implement a customer endpoint. Do not implement the endpoint yet. Finish with JSON containing completed (boolean).",
    },
    multi_day_learning: {
      facts: [fact("day-one", "Project Helios uses PostgreSQL."), fact("day-two", "Project Helios requires Azure private networking.")],
      task: "Design storage and networking for Project Helios. Return JSON with database and networking strings, or null when unknown.",
      rubric: { database: ["postgresql", "postgres"], networking: ["azure private networking", "azure private network", "azure private endpoint"] },
    },
    rediscovery_demo: {
      task: "Continue the investigation of the failing session-expiry behavior and implement a correct fix. Preserve valid sessions and expiry at the boundary. Run tests. Finish with JSON containing completed (boolean).",
      discovery: "Investigate the failing session-expiry behavior. You may test hypotheses in this disposable checkout. Store the root cause, relevant files, recommended fix, and only approaches you actually tried unsuccessfully (or explicitly say none). A fresh agent will continue later from the original checkout. Finish with JSON containing completed (boolean).",
    },
  };
  return { schemaVersion: 1, id: "mindleak-validation-v1", seed, sizes, scenarios };
}

export function retrievalMetrics(rankedIds, relevantIds, limit = 5) {
  const ranking = rankedIds.slice(0, limit);
  const score = scoreRanking(ranking, relevantIds, limit);
  return {
    ...score,
    precisionAmongReturned: ranking.length ? score.relevantRetrieved / ranking.length : null,
    falsePositiveResults: ranking.length - score.relevantRetrieved,
    top1: relevantIds.length ? scoreRanking(ranking, relevantIds, 1).hitAtK : null,
    top3: relevantIds.length ? scoreRanking(ranking, relevantIds, 3).hitAtK : null,
    top5: relevantIds.length ? scoreRanking(ranking, relevantIds, 5).hitAtK : null,
  };
}

export function evaluateAnswer(answer, rubric) {
  const normalize = value => typeof value === "string" ? value.trim().toLowerCase().replace(/[.]$/, "") : value;
  const fields = Object.entries(rubric).map(([field, accepted]) => ({
    field, correct: answer !== null && typeof answer === "object" && !Array.isArray(answer)
      && accepted.some(value => normalize(answer[field]) === normalize(value)),
  }));
  return { success: fields.every(field => field.correct), correct: fields.filter(field => field.correct).length,
    expected: fields.length, fields, scoring: "conservative-structured-variants", unverifiedFields: fields.filter(field => !field.correct).map(field => field.field) };
}

export function pairedMetrics(withoutMemory, withMemory) {
  const adjudicated = [withoutMemory, withMemory].every(result => result.status === undefined || result.status === "completed");
  const bothCorrect = adjudicated && withoutMemory.success === true && withMemory.success === true;
  const reduction = (before, after) => bothCorrect && Number.isFinite(before) && before > 0 && Number.isFinite(after) && after >= 0
    ? 100 * (before - after) / before : null;
  return {
    baselineSuccess: withoutMemory.success, memorySuccess: withMemory.success,
    errorAmplified: adjudicated ? withoutMemory.success === true && withMemory.success === false : null,
    errorAvoided: adjudicated ? withoutMemory.success === false && withMemory.success === true : null,
    completionTimeReductionPercent: reduction(withoutMemory.elapsedMs, withMemory.elapsedMs),
    fileSearchReductionPercent: reduction(withoutMemory.fileSearches, withMemory.fileSearches),
    toolCallReductionPercent: reduction(withoutMemory.toolCalls, withMemory.toolCalls),
    inputTokenReductionPercent: reduction(withoutMemory.inputTokens, withMemory.inputTokens),
    agentCostReductionPercent: reduction(withoutMemory.costUsd, withMemory.costUsd),
    savingsRequireBothCorrect: true,
  };
}

export function scaleCharts(points) {
  const chart = (title, field, label) => ({
    $schema: "https://vega.github.io/schema/vega-lite/v5.json", title,
    width: 560, height: 280, background: "white",
    data: { values: points }, mark: { type: "line", point: true, color: field === "recall" ? "#087f6e" : "#a53d43" },
    encoding: { x: { field: "factsStored", type: "quantitative", title: "Actual stored fragments" },
      y: { field, type: "quantitative", title: label }, tooltip: [{ field: "factsStored" }, { field }] },
  });
  return { factsVsAccuracy: chart("Facts vs Recall", "recall", "Verified recall@5"),
    factsVsLatency: chart("Facts vs Latency", "p95Ms", "Retrieval p95 (ms)") };
}

export function codingFixture(kind) {
  const common = {
    "README.md": "Use domain-driven design. Data access belongs under src/data. API handlers call repositories. Tests are immutable validation inputs.\n",
    "src/domain/customer.mjs": "export function customer(id, name) { return { id, name }; }\n",
    "src/data/customerRepository.mjs": "import { customer } from '../domain/customer.mjs';\nexport function findCustomer(id) { return id === '42' ? customer('42', 'Orion') : null; }\n",
    "src/api/status.mjs": "import { status } from '../data/statusRepository.mjs';\nexport function getStatus() { return { status: 200, body: status() }; }\n",
    "src/data/statusRepository.mjs": "export function status() { return { healthy: true }; }\n",
  };
  if (kind === "coding_workflow") return { files: common, editable: ["src/api/customers.mjs"], testCount: 3, tests: String.raw`
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
const load = () => import('../src/api/customers.mjs');
test('customer-found', async () => { assert.deepEqual((await load()).getCustomer('42'), {status:200, body:{id:'42', name:'Orion'}}); });
test('customer-absent', async () => { assert.equal((await load()).getCustomer('absent').status, 404); });
test('repository-boundary', () => { const source = readFileSync(new URL('../src/api/customers.mjs', import.meta.url), 'utf8'); assert.match(source, /from\s+['"]\.\.\/data\/customerRepository\.mjs['"]/); });
` };
  if (kind !== "rediscovery_demo") throw new Error("unknown coding fixture");
  return { files: { ...common,
    "src/data/sessionRepository.mjs": "export function saveSession(id, nowMs, ttlSeconds) { return { id, expiresAt: nowMs + ttlSeconds }; }\n",
    "src/domain/session.mjs": "export function isValid(session, nowMs) { return nowMs < session.expiresAt; }\n",
    "src/api/session.mjs": "import { saveSession } from '../data/sessionRepository.mjs';\nexport function createSession(id, nowMs) { return saveSession(id, nowMs, 60); }\n",
  }, editable: ["src/data/sessionRepository.mjs"], testCount: 3, tests: String.raw`
import assert from 'node:assert/strict';
import test from 'node:test';
import { saveSession } from '../src/data/sessionRepository.mjs';
import { isValid } from '../src/domain/session.mjs';
test('valid-session-retained', () => { assert.equal(isValid(saveSession('42', 1000, 60), 3000), true); });
test('expiry-boundary', () => { assert.equal(isValid(saveSession('42', 1000, 60), 61000), false); });
test('arbitrary-ttl-units', () => { assert.equal(saveSession('42', 150, 7).expiresAt, 7150); });
` };
}
