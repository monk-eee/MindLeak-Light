import assert from "node:assert/strict";
import test from "node:test";
import { answerSchemaFor, categories, codingFixture, digest, evaluateAnswer, generateScenarios, pairedMetrics, retrievalMetrics, scaleCharts, verifyCodingPreparation } from "./validation-scenarios.mjs";
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
