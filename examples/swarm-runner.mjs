import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { posix } from "node:path";
import { agentTools, createCodingWorkspace, scopedMemory } from "./validation-runtime.mjs";
import { publicExecution } from "./validation-agent.mjs";
import { answerSchemaFor, digest } from "./validation-scenarios.mjs";
import { sessionDeskHtml, swarmFixture, swarmRoles, swarmProblem, controlRoles } from "./swarm-fixture.mjs";

const require = createRequire(import.meta.url);

export function ownedBuildWorkspace(workspace, role) {
  let lastTests = null;
  return {
    ...workspace, editablePaths: [...role.editable],
    get lastTests() { return lastTests; },
    async write(path, content) {
      if (!role.editable.includes(path)) throw new Error("fixture_edit_not_allowed");
      lastTests = null;
      return workspace.write(path, content);
    },
    async test() {
      lastTests = await workspace.test(role.group);
      return lastTests;
    },
  };
}

export async function buildSwarmApplication(workspace) {
  const { build } = await import("esbuild");
  const fixture = swarmFixture();
  const project = Object.fromEntries(await Promise.all(Object.keys(fixture.files).map(async path => [path, await workspace.read(path)])));
  const output = await build({ stdin: { contents: 'import {mount} from "/src/app.mjs"; const refresh=mount(document.getElementById("session-app"),()=>Date.now()); setInterval(refresh,500);',
    sourcefile: "/entry.mjs", resolveDir: "/" }, bundle: true, write: false, format: "iife", platform: "browser", logLevel: "silent",
    plugins: [{ name: "fixture-only", setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => {
        const path = posix.normalize(posix.join(args.path.startsWith("/") ? "/" : posix.dirname(args.importer || "/entry.mjs"), args.path));
        if (!path.startsWith("/src/") || !Object.hasOwn(project, path.slice(1)) || !path.endsWith(".mjs")) throw new Error("application_import_outside_fixture");
        return { path, namespace: "fixture" };
      });
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: project[args.path.slice(1)], loader: "js" }));
    } }] });
  const font = (await readFile(require.resolve("@fontsource/ibm-plex-sans/files/ibm-plex-sans-latin-400-normal.woff2"))).toString("base64");
  const css = `@font-face{font-family:Desk;src:url(data:font/woff2;base64,${font})}html{font-family:Desk,sans-serif}${project["src/style.css"]}`;
  const policy = '<meta http-equiv="Content-Security-Policy" content="default-src &#39;none&#39;; script-src data:; style-src data: &#39;unsafe-inline&#39;; font-src data:; img-src data:; form-action &#39;none&#39;; base-uri &#39;none&#39;">';
  const html = sessionDeskHtml.replace("</head>", `${policy}<link rel="stylesheet" href="data:text/css;base64,${Buffer.from(css).toString("base64")}"></head>`)
    .replace("</body>", `<script src="data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}"></script></body>`);
  return { html, sha256: digest(html), files: Object.fromEntries(Object.entries(project).map(([path, source]) => [path, digest(source)])), project };
}

export async function runSwarmBuild({ driver, agent, agentsByRole, code, concurrency = 2, maxAttempts = 2, signal, problem = swarmProblem,
  memoryEnabled = true, parent = null, onEvent = () => {}, onMemory = () => {}, onToolDetail = () => {}, workspaceFactory = createCodingWorkspace, applicationBuilder = buildSwarmApplication } = {}) {
  if (typeof memoryEnabled !== "boolean" || memoryEnabled && !driver || !code || swarmRoles.some(role => !(agentsByRole ? agentsByRole[role.id] : agent)?.run)) throw new Error("swarm_requires_memory_agent_and_container");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 5 || !Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 3) {
    throw new Error("invalid_swarm_budget");
  }
  if (typeof problem !== "string" || !problem.trim() || Buffer.byteLength(problem) > 4096) throw new Error("invalid_swarm_problem");
  const runId = randomUUID();
  const started = performance.now();
  const createdAt = new Date().toISOString();
  const events = [];
  const roles = Object.fromEntries(swarmRoles.map(({ task, ...role }, index) => [role.id, { ...role, name: memoryEnabled ? role.name : controlRoles[index].name,
    model: (agentsByRole?.[role.id] ?? agent)?.configuration?.model ?? null,
    provider: (agentsByRole?.[role.id] ?? agent)?.configuration?.provider ?? null, state: "queued", attempts: [] }]));
  const sourceOwners = new Map();
  const seenMemories = new Set();
  const inherited = memoryEnabled && parent ? structuredClone(parent.memoryExhibits ?? []) : [];
  if (memoryEnabled && parent && (parent.kind !== "swarm_build" || parent.status !== "completed" || !inherited.length
    || new Set(inherited.map(memory => memory.scope)).size !== 1 || typeof inherited[0].scope !== "string")) throw new Error("completed_learning_parent_required");
  const memoryExhibits = [...inherited];
  const toolExhibits = [];
  const memoryUsage = [];
  const transfers = new Map();
  const fixture = swarmFixture();
  const scope = inherited[0]?.scope ?? `swarm-demo-${runId}`;
  const emit = record => {
    if (events.length >= 20000) throw new Error("swarm_event_budget");
    const event = { id: events.length + 1, atMs: performance.now() - started, ...record };
    events.push(event);
    onEvent(structuredClone(event));
  };
  const register = (receipt, owner) => {
    for (const fragment of receipt.fragments) sourceOwners.set(fragment.fragmentId, owner);
    const replayed = seenMemories.has(receipt.memoryId);
    seenMemories.add(receipt.memoryId);
    if (!replayed) {
      const exhibit = { memoryId: receipt.memoryId, agent: owner, scope, fragments: receipt.fragments.map(({ fragmentId, text }) => ({ fragmentId, text })) };
      memoryExhibits.push(exhibit);
      onMemory(structuredClone(exhibit));
    }
    emit({ type: "memory_saved", agent: owner, memoryId: receipt.memoryId, fragments: receipt.fragments.length, replayed });
  };
  const unsubscribeMemory = memoryEnabled ? driver.observeInference?.(event => {
    if (event.type === "inference_finished") memoryUsage.push(event);
    emit(event);
  }) : null;
  emit({ type: "run_started", runId, title: "Session Desk", agents: swarmRoles.length, concurrency, expectedTests: fixture.testCount,
    models: Object.fromEntries(Object.entries(roles).map(([id, role]) => [id, role.model])) });
  let workspace;
  let baselineTests;
  let finalTests;
  let application = null;
  let failure = null;
  try {
    for (const memory of inherited) for (const fragment of memory.fragments) {
      const recovered = (await driver.call("recall_memory", { fragmentId: fragment.fragmentId, scope, includeInactive: true })).data;
      if (recovered.memoryId !== memory.memoryId || recovered.text !== fragment.text || recovered.context?.scope !== scope) throw new Error("inherited_memory_mismatch");
      sourceOwners.set(fragment.fragmentId, memory.agent);
    }
    if (inherited.length) emit({ type: "experience_continued", parentRunId: parent.runId, inheritedMemories: inherited.length });
    workspace = await workspaceFactory("swarm", code, fixture);
    baselineTests = await workspace.test();
    emit({ type: "tests", agent: "system", phase: "baseline", ...baselineTests });
    if (baselineTests.passed || baselineTests.tests !== fixture.testCount) throw new Error("swarm_requires_failing_fixture");
    if (memoryEnabled && !inherited.length) {
      const brief = scopedMemory(driver, scope, `swarm-${runId}-brief`);
      register(await brief.write("Session Desk is a local session-expiry application; the shared implementation contracts and ownership boundaries are recorded in README.md.",
        { requestId: randomUUID(), context: { sessionId: runId, source: "swarm-demo/project-brief" } }), "brief");
    }
    const runRole = async role => {
      const state = roles[role.id];
      const actor = agentsByRole?.[role.id] ?? agent;
      const owned = ownedBuildWorkspace(workspace, role);
      const memory = memoryEnabled ? scopedMemory(driver, scope, `swarm-${runId}-${role.id}`) : null;
      const memorySessionId = randomUUID();
      const requests = new Map();
      const received = new Set();
      const recorded = memoryEnabled ? { ...memory, async write(text) {
        if (!owned.lastTests?.passed) throw new Error("component_tests_required");
        if (seenMemories.size >= 100) throw new Error("memory_exhibit_budget");
        if (typeof text !== "string" || !text.trim() || Buffer.byteLength(text) > 3072) throw new Error("invalid_handoff_brief");
        const key = digest(text);
        if (!requests.has(key)) requests.set(key, randomUUID());
        const receipt = await memory.write(text, { requestId: requests.get(key),
          context: { sessionId: memorySessionId, source: `swarm-demo/${role.id}/tests:${owned.lastTests.sourceSha256 ?? "test-double"}` } });
        register(receipt, role.id);
        return receipt;
      } } : null;
      state.state = "running";
      emit({ type: "agent_state", agent: role.id, state: "running" });
      for (let attempt = 1; attempt <= maxAttempts && !signal?.aborted; attempt += 1) {
        try {
          emit({ type: "attempt_started", agent: role.id, attempt });
          const tools = agentTools(recorded, owned, { recall: memoryEnabled, write: memoryEnabled }).map(tool => ({ ...tool, async invoke(args, invocation = {}) {
            const shownArguments = Object.fromEntries(Object.entries(args).filter(([key]) => ["path", "query", "fragmentId", "includeInactive", "matchMode", "contextLimit", "diagnostics", "groupDuplicates"].includes(key)));
            if (toolExhibits.length < 2000) {
              const detail = { toolCallId: invocation.toolCallId ?? randomUUID(), agent: role.id, tool: tool.definition.function.name,
                arguments: shownArguments, atMs: performance.now() - started };
              toolExhibits.push(detail); onToolDetail(structuredClone(detail));
            }
            const result = await tool.invoke(args);
            if (["recall_memory", "inspect_source"].includes(tool.definition.function.name)) {
              const counts = new Map();
              for (const identifier of memory.observations.exposed) {
                const owner = sourceOwners.get(identifier);
                if (!owner || received.has(identifier)) continue;
                received.add(identifier);
                counts.set(owner, (counts.get(owner) ?? 0) + 1);
              }
              for (const [owner, count] of counts) {
                const key = `${owner}:${role.id}`;
                transfers.set(key, { from: owner, to: role.id, fragments: (transfers.get(key)?.fragments ?? 0) + count });
                emit({ type: "memory_delivered", agent: role.id, from: owner, fragments: count });
              }
            }
            return result;
          } }));
          const memoryTool = tools.find(tool => tool.definition.function.name === "write_memory");
          if (memoryTool) {
            memoryTool.definition.function.parameters.properties.text = { type: "string", minLength: 1, maxLength: 3072 };
            memoryTool.definition.function.description += " Run your component tests first. Start each finding with Session Desk and name the module. Only your own component tests justify your verification claim.";
          }
          const memoryRequirement = !memoryEnabled ? "This is the Dalek control team. No MindLeak tools, past conversations or memory findings are available. The README collaboration section's memory instructions do not apply to this arm. Use only the current files in your team's isolated project; do not attempt memory access or publication."
            : role.dependencies.length
            ? `MindLeak is available for earlier dependency findings (${role.dependencies.join(", ")}). You may recall a relevant finding when useful; inspect it against the current files. Memory use is optional. Search short keywords in the advertised mode and use at most one focused refinement after a miss.`
            : "You have no earlier component dependency. Investigate independently. Memory publication is optional and only useful new verified findings should be retained.";
          const task = `You are ${state.name}, responsible for ${role.title} in a five-agent build of Session Desk. ${role.task}\nRequested problem: ${problem}\nRead README.md and tests/specification.mjs for the shared interfaces and checks. You own only ${role.editable.join(", ")}. Other agents in your team own the other files. The requested problem may refine appearance, not remove the fixed interfaces, tests, ownership restrictions, or safety boundaries. ${memoryRequirement} Use the tools to implement the code and run_tests to verify your component.${memoryEnabled ? " You may then use write_memory for a concise reusable finding. The README collaboration guidance describes available memory mechanisms, not a requirement to retrieve or publish." : ""} Code correctness alone decides success; no lookup, handoff or note is required.\n${attempt > 1 ? `The previous attempt did not meet the completion checks. Current failed checks: ${(state.attempts.at(-1)?.verification?.failedTests ?? []).join(", ") || "verify your component against the immutable tests"}. Continue from the current files; earlier failure is retained in the report.\n` : ""}Finish with JSON containing completed (boolean).`;
          const execution = await actor.run(task, tools, "", answerSchemaFor("rediscovery_demo"), {
            signal, onEvent: event => emit({ ...event, agent: role.id, attempt }),
          });
          const verification = await owned.test();
          const publishedMemories = new Set(memory?.observations.writes.map(receipt => receipt.memoryId) ?? []).size;
          const memoryChecked = memory?.observations.calls.some(call => call.tool === "recall_memory") ?? false;
          const dependencyMemoryReceived = [...memory?.observations.exposed ?? []].some(id => role.dependencies.includes(sourceOwners.get(id)));
          const memoryRequired = false;
          const passed = execution.status === "completed" && verification.passed;
          state.attempts.push({ ...publicExecution(execution), verification, publishedMemories, memoryChecked, memoryRequired, dependencyMemoryReceived, passed });
          emit({ type: "tests", agent: role.id, attempt, phase: "verification", ...verification });
          if (passed) { state.state = "passed"; break; }
        } catch {
          state.attempts.push({ status: "error", reason: "agent_stage_failed", passed: false });
          emit({ type: "agent_error", agent: role.id, attempt, reason: "agent_stage_failed" });
        }
      }
      if (state.state !== "passed") state.state = signal?.aborted ? "cancelled" : "failed";
      emit({ type: "agent_state", agent: role.id, state: state.state });
    };
    const pending = new Set(swarmRoles.map(role => role.id));
    while (pending.size && !signal?.aborted) {
      for (const role of swarmRoles) if (pending.has(role.id) && role.dependencies.some(id => ["failed", "blocked", "cancelled"].includes(roles[id].state))) {
        pending.delete(role.id);
        roles[role.id].state = "blocked";
        emit({ type: "agent_state", agent: role.id, state: "blocked" });
      }
      const ready = swarmRoles.filter(role => pending.has(role.id) && role.dependencies.every(id => roles[id].state === "passed")).slice(0, concurrency);
      if (!ready.length) break;
      for (const role of ready) pending.delete(role.id);
      await Promise.all(ready.map(runRole));
    }
    for (const id of pending) {
      roles[id].state = signal?.aborted ? "cancelled" : "blocked";
      emit({ type: "agent_state", agent: id, state: roles[id].state });
    }
    finalTests = await workspace.test();
    emit({ type: "tests", agent: "system", phase: "final", ...finalTests });
    if (finalTests.passed && Object.values(roles).every(role => role.state === "passed")) {
      application = await applicationBuilder(workspace);
      emit({ type: "application_ready", sha256: application.sha256 });
    }
  } catch {
    failure = signal?.aborted ? "cancelled" : "swarm_execution_failed";
    emit({ type: "run_error", reason: failure });
  } finally { unsubscribeMemory?.(); await workspace?.close(); }
  const executions = Object.values(roles).flatMap(role => role.attempts);
  const tokenTotal = field => executions.length && executions.every(execution => Number.isFinite(execution[field]))
    ? executions.reduce((total, execution) => total + execution[field], 0) : null;
  const status = signal?.aborted ? "cancelled" : !failure && application ? "completed" : "partial";
  emit({ type: "run_finished", status });
  return { reportVersion: 1, kind: "swarm_build", title: "Session Desk", runId, createdAt, status, failure,
    agents: Object.values(roles), events, baselineTests, finalTests, application, handoffs: [...transfers.values()], memoryExhibits, toolExhibits,
    problem, scope: memoryEnabled ? scope : null, inheritedMemories: inherited.length, memoryPolicy: "optional-use-v2", memoryAccess: memoryEnabled ? "read-write" : "none", memoryProcessing: { model: memoryEnabled ? driver.configuration?.decompositionModel ?? null : null,
      mode: memoryEnabled ? driver.configuration?.decomposition ?? "sentences" : "off", workload: "memory", modelClass: "slm", calls: memoryUsage.length,
      inputTokens: memoryUsage.every(call => Number.isSafeInteger(call.inputTokens)) ? memoryUsage.reduce((sum, call) => sum + call.inputTokens, 0) : null,
      outputTokens: memoryUsage.every(call => Number.isSafeInteger(call.outputTokens)) ? memoryUsage.reduce((sum, call) => sum + call.outputTokens, 0) : null },
    summary: { agents: swarmRoles.length, agentsPassed: Object.values(roles).filter(role => role.state === "passed").length,
      inputTokens: tokenTotal("inputTokens"), outputTokens: tokenTotal("outputTokens"),
      toolCalls: executions.reduce((total, execution) => total + (execution.toolCalls ?? 0), 0), memoriesStored: seenMemories.size,
      crossAgentHandoffs: [...transfers.values()].filter(transfer => transfer.from !== "brief" && transfer.from !== transfer.to).length },
    elapsedMs: performance.now() - started, server: memoryEnabled ? driver.server : null, realMcpProcess: memoryEnabled ? driver.realProcess : false,
    binarySha256: memoryEnabled ? driver.binarySha256 : null, fixtureSha256: digest(fixture), agent: agent?.configuration ?? { model: "Mixed frontier models", provider: "copilot" },
    codeContainer: { engine: code.engine, imageId: code.image }, concurrency, maxAttempts,
    interpretation: memoryEnabled ? "Five fresh model sessions build owned modules in one sandbox; later agents can read both shared files and actual MCP memories. This is a collaboration demonstration, not a measured memory-only speedup. Usage is provider-reported after each response; unknown usage remains null. All code tests run in network-disabled containers."
      : "Five fresh Dalek sessions build the same owned modules in a separate sandbox. They share only their team's current files, with no MindLeak driver, tools, findings or previous conversation. Usage is provider-reported and tests run in network-disabled containers." };
}

export async function runSwarmComparison(options = {}) {
  const started = performance.now(); const runId = randomUUID(); const createdAt = new Date().toISOString();
  const events = []; const toolExhibits = []; const memoryExhibits = [];
  const mapAgent = (id, condition) => condition === "withoutMemory" ? controlRoles.find(role => role.pairedWith === id)?.id ?? id : id;
  const emit = record => { const event = { ...record, id: events.length + 1, atMs: performance.now() - started }; events.push(event); options.onEvent?.(structuredClone(event)); };
  emit({ type: "run_started", runId, title: "Session Desk / Memory vs Daleks", agents: 10, expectedTests: 36, concurrency: (options.concurrency ?? 2) * 2 });
  const outcomes = await Promise.all(["withMemory", "withoutMemory"].map(condition => runSwarmBuild({ ...options,
    driver: condition === "withMemory" ? options.driver : null, memoryEnabled: condition === "withMemory",
    parent: condition === "withMemory" ? options.parent : null,
    onEvent: event => {
      const type = event.type === "run_started" ? "build_team_started" : event.type === "run_finished" ? "build_team_finished"
        : event.type === "tests" && event.agent === "system" && event.phase === "final" ? "build_team_tests"
          : condition === "withoutMemory" && event.type === "application_ready" ? "control_application_ready" : event.type;
      emit({ ...event, type, condition, agent: mapAgent(event.agent, condition), from: mapAgent(event.from, condition) });
    },
    onMemory: memory => { memoryExhibits.push(memory); options.onMemory?.(memory); },
    onToolDetail: detail => { const item = { ...detail, condition, agent: mapAgent(detail.agent, condition) }; toolExhibits.push(item); options.onToolDetail?.(item); },
  })));
  const [withMemory, withoutMemory] = outcomes;
  const agents = [...withMemory.agents, ...withoutMemory.agents.map(actor => ({ ...actor, ...controlRoles.find(role => role.pairedWith === actor.id),
    title: `${actor.title} / No Memory`, dependencies: actor.dependencies.map(id => mapAgent(id, "withoutMemory")), memoryAccess: "none" }))];
  const total = field => outcomes.every(report => Number.isFinite(report.summary[field])) ? outcomes.reduce((sum, report) => sum + report.summary[field], 0) : null;
  const status = outcomes.some(report => report.status === "cancelled") ? "cancelled" : outcomes.every(report => report.status === "completed") ? "completed" : "partial";
  const finalTests = { passed: outcomes.every(report => report.finalTests?.passed), passedTests: outcomes.reduce((sum, report) => sum + (report.finalTests?.passedTests ?? 0), 0), expectedTests: 36 };
  emit({ type: "tests", agent: "system", phase: "final", ...finalTests }); emit({ type: "run_finished", status });
  const result = report => ({ ...report.summary, elapsedMs: report.elapsedMs, status: report.status, memoryAccess: report.memoryAccess,
    finalTests: report.finalTests, fixtureSha256: report.fixtureSha256, memoryProcessing: report.memoryProcessing, inheritedMemories: report.inheritedMemories });
  return { ...withMemory, reportVersion: 2, experiment: 1, title: "Session Desk / Memory vs Daleks", runId, createdAt, status,
    failure: status === "partial" ? "one_or_both_builds_incomplete" : null, agents, events, toolExhibits, memoryExhibits, finalTests,
    controlApplication: withoutMemory.application, elapsedMs: performance.now() - started,
    summary: { ...withMemory.summary, agents: 10, agentsPassed: agents.filter(actor => actor.state === "passed").length,
      inputTokens: total("inputTokens"), outputTokens: total("outputTokens"), toolCalls: total("toolCalls") },
    buildComparison: { withMemory: result(withMemory), withoutMemory: result(withoutMemory), concurrentTeams: true,
      identicalFixture: withMemory.fixtureSha256 === withoutMemory.fixtureSha256, matchingModels: swarmRoles.every((role, index) => withMemory.agents[index].model === withoutMemory.agents[index].model),
      concurrencyPerTeam: options.concurrency ?? 2, maxAttemptsPerAgent: options.maxAttempts ?? 2 },
    interpretation: "Two five-agent teams build isolated copies of the same Session Desk fixture with matched roles, models, dependencies, budgets and eighteen identical tests each. Only the memory team has optional MindLeak tools. Neither lookup nor publication is required for correctness. Both teams can read their own team's evolving files. Reported costs include memory writes and failed attempts; shared provider contention limits causal speedup claims." };
}
