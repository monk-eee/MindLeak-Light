import assert from "node:assert/strict";
import test from "node:test";
import { categories, codingFixture, digest, evaluateAnswer, generateScenarios, pairedMetrics, retrievalMetrics, scaleCharts } from "./validation-scenarios.mjs";
import { agentTools, containerConfiguration, createCodingWorkspace, renderScaleCharts, scopedMemory } from "./validation-runtime.mjs";
import { agentSettings, createAgent, publicExecution, runAgentSession } from "./validation-agent.mjs";
import { runValidation } from "./validation-harness.mjs";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { longitudinalBinding, runLongitudinal } from "./validation-longitudinal.mjs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { once } from "node:events";

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

test("paired savings require both tasks correct and actual comparable measurements", () => {
  const baseline = { success: true, elapsedMs: 100, fileSearches: 10, inputTokens: null };
  assert.equal(pairedMetrics(baseline, { success: true, elapsedMs: 40 }).completionTimeReductionPercent, 60);
  const failed = pairedMetrics(baseline, { success: false, elapsedMs: 1 });
  assert.equal(failed.errorAmplified, true);
  assert.equal(failed.completionTimeReductionPercent, null);
  assert.equal(pairedMetrics(baseline, { success: true, inputTokens: 12 }).inputTokenReductionPercent, null);
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

test("baseline agent tools cannot access memory and malformed provenance fails closed", async () => {
  const memory = scopedMemory({ async call() { return { data: { results: [{ text: "wrong scope" }] } }; } }, "test-scope", "agent-a");
  assert.deepEqual(agentTools(null, null), []);
  assert.deepEqual(agentTools(memory, null, { recall: false, write: true }).map(tool => tool.definition.function.name), ["write_memory"]);
  await assert.rejects(memory.recall("query"), /invalid_recall_provenance/);
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

test("tool traces are measured and gold answers are never sent to the agent", async () => {
  let calls = 0;
  const tools = [{ definition: { type: "function", function: { name: "search_files", parameters: { properties: { query: { type: "string" } }, required: ["query"] } } }, invoke: async () => [{ path: "fixture.mjs" }] }];
  const result = await runAgentSession({ task: "solve", tools, complete: async request => {
    calls += 1;
    if (calls === 1) return { choices: [{ finish_reason: "tool_calls", message: { tool_calls: [{ id: "first", type: "function", function: { name: "search_files", arguments: '{"query":"repository"}' } }] } }] };
    assert.equal(request.messages.at(-1).role, "tool");
    return { choices: [{ finish_reason: "stop", message: { content: '{"completed":true}' } }] };
  } });
  assert.equal(result.status, "completed");
  assert.equal(result.fileSearches, 1);
  assert.equal(result.toolCalls, 1);
  assert.equal(result.inputTokens, null);
  assert.equal(result.trace[0].ok, true);
  assert.equal(Object.hasOwn(result.trace[0], "arguments"), false);
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
        const fragments = args.text.split("\n").map(text => ({ fragmentId: randomUUID(), text, lifecycle: { state: "active" } }));
        const record = { memoryId: randomUUID(), context: args.context, rawText: args.text, fragments };
        memories.push(record);
        for (const directive of args.facts ?? []) for (const link of directive.links) {
          const target = memories.flatMap(memory => memory.fragments).find(fragment => fragment.fragmentId === link.targetFragmentId);
          target.lifecycle.state = "superseded";
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
      return { data, elapsedMs: 1, resultBytes: Buffer.byteLength(JSON.stringify(data)), session: this.session };
    },
  };
}

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
