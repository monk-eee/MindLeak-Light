import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { agentSettings, createAgent } from "./validation-agent.mjs";
import { benchmarkSettings } from "./benchmark-recall.mjs";
import { containerConfiguration, openMemoryDriver } from "./validation-runtime.mjs";
import { runSwarmComparison } from "./swarm-runner.mjs";
import { swarmFixture, swarmRoles, swarmProblem } from "./swarm-fixture.mjs";
import { renderDemoPage, writeDemoReplay, runBuildWithAcceptance } from "./demo-replay.mjs";
import { openCopilotProvider, createCopilotAgent } from "./copilot-agent.mjs";
import { openMemoryUsageObserver } from "./demo-memory.mjs";
import { normalizeRecording, labCompletion, studyProgress } from "./demo-view.mjs";
import { runMemoryLab, memoryLabRoles } from "./memory-lab.mjs";
import { memoryLabProblem } from "./memory-lab-fixture.mjs";
import { controlRoles, runMemoryControl, learnFromControlRound, combineControlReport, preparationEvent, continueMemoryPreparation } from "./memory-control.mjs";
import { rediscoveryArms, rediscoveryPlan, rediscoveryProblem, runRediscoveryLab } from "./rediscovery-lab.mjs";

export function selectDemoParameters(profiles, input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)
    || Object.keys(input).some(key => !["problem", "concurrency", "attempts", "rounds", "agentModels", "memoryModel", "rediscoveryProfile", "querySeed", "continueFrom"].includes(key))) throw new Error("invalid_demo_parameters");
  const parameters = { problem: swarmProblem, concurrency: 2, attempts: 2, rounds: 1, rediscoveryProfile: "smoke", querySeed: 20260917, continueFrom: null, agentModels: {}, memoryModel: "off", ...profiles?.defaults, ...input };
  if (typeof parameters.problem !== "string" || !parameters.problem.trim() || Buffer.byteLength(parameters.problem) > 4096
    || !Number.isInteger(parameters.concurrency) || parameters.concurrency < 1 || parameters.concurrency > 5
    || !Number.isInteger(parameters.attempts) || parameters.attempts < 1 || parameters.attempts > 3
    || !Number.isInteger(parameters.rounds) || parameters.rounds < 1 || parameters.rounds > 3
    || !["smoke", "pilot"].includes(parameters.rediscoveryProfile) || !Number.isSafeInteger(parameters.querySeed) || parameters.querySeed < 0 || parameters.querySeed > 0xffffffff
    || parameters.continueFrom !== null && (typeof parameters.continueFrom !== "string" || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(parameters.continueFrom))
    || !parameters.agentModels || typeof parameters.agentModels !== "object" || Array.isArray(parameters.agentModels)
    || Object.keys(parameters.agentModels).some(id => !swarmRoles.some(role => role.id === id))) throw new Error("invalid_demo_parameters");
  if (profiles) {
    if (profiles.experiment === 2 && parameters.concurrency !== 1) throw new Error("memory_lab_requires_sequential_stages");
    if (profiles.experiment === 3 && (parameters.concurrency !== 1 || parameters.attempts !== 1)) throw new Error("rediscovery_requires_serial_schedule");
    for (const role of swarmRoles) if (!profiles.agents.some(model => model.id === parameters.agentModels[role.id] && model.available !== false)) throw new Error("unavailable_agent_model");
    if (!profiles.memory.some(model => model.id === parameters.memoryModel && model.available !== false)) throw new Error("unavailable_memory_model");
  } else if (Object.keys(parameters.agentModels).length || parameters.memoryModel !== "off") throw new Error("models_not_configured");
  return structuredClone(parameters);
}

export async function createDemoServer({ runBuild, outputDirectory, port = 0, model = "Not configured", profiles = null, initialReport = null,
  basePath = "", origin = null, mount = null, navigation = null, beforeRun = () => null, busy = () => false } = {}) {
  if (typeof runBuild !== "function" || !outputDirectory || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_demo_server_configuration");
  if (initialReport) {
    normalizeRecording(initialReport);
    if (!["completed", "partial", "cancelled"].includes(initialReport.status) || Buffer.byteLength(JSON.stringify(initialReport)) > 16 * 1024 * 1024) throw new Error("invalid_saved_demo_recording");
  }
  const output = resolve(outputDirectory);
  await mkdir(output, { recursive: true, mode: 0o700 });
  const clients = new Set();
  let report = initialReport ? structuredClone(initialReport) : null;
  let active = null;
  let lastRun = null;
  let url;
  const snapshot = () => ({ running: Boolean(active), report, profiles });
  const send = (response, type, data) => {
    const message = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
    if (response.writableLength > 256 * 1024) { response.destroy(); clients.delete(response); return; }
    response.write(message);
  };
  const broadcast = (type, data) => { for (const response of clients) send(response, type, data); };
  const continuationParent = parameters => {
    if (parameters.continueFrom === null) return null;
    if (!report || report.runId !== parameters.continueFrom || report.status !== "completed") throw new Error("continuation_parent_mismatch");
    return structuredClone(report);
  };
  async function startRun(input = {}) {
    if (active || busy()) throw new Error("demo_already_running");
    const parameters = selectDemoParameters(profiles, input);
    const parent = continuationParent(parameters);
    const releaseRun = beforeRun();
    const controller = new AbortController();
    const artifactDirectory = join(output, `${new Date().toISOString().replaceAll(":", "-")}-${randomUUID().slice(0, 8)}`);
    const run = { controller, promise: null, directory: artifactDirectory };
    active = run;
    const memoryLab = profiles?.experiment === 2;
    const rediscovery = profiles?.experiment === 3;
    const roles = rediscovery ? rediscoveryArms : [...(memoryLab ? memoryLabRoles : swarmRoles), ...controlRoles];
    report = { reportVersion: 1, kind: rediscovery ? "rediscovery_lab" : memoryLab ? "memory_lab" : "swarm_build", experiment: rediscovery ? 3 : memoryLab ? 2 : 1,
      title: rediscovery ? "Rediscovery" : memoryLab ? "Memory vs Daleks" : "Session Desk / Memory vs Daleks", expectedTests: rediscovery ? (parameters.rediscoveryProfile === "smoke" ? parent ? 24 : 27 : parent ? 480 : 495) : memoryLab ? (parent ? 0 : 35) + parameters.rounds * 70 : 36, runId: randomUUID(), createdAt: new Date().toISOString(),
      status: "recording", agents: roles.map(({ task, ...role }) => ({ ...role, state: "queued", model: parameters.agentModels[role.pairedWith ?? role.id] ?? model })), events: [], elapsedMs: 0,
      problem: parameters.problem, parameters, memoryExhibits: [], toolExhibits: [],
      study: parent?.study ?? null,
      memoryProcessing: { model: parameters.memoryModel === "off" ? null : parameters.memoryModel, mode: parameters.memoryModel === "off" ? "sentences" : "openai" },
      agent: { model }, realMcpProcess: true };
    broadcast("snapshot", snapshot());
    run.promise = (async () => {
      let journal;
      let evidenceJournal;
      let writes = Promise.resolve();
      let recordingError = false;
      const appendEvidence = (kind, data) => {
        const entry = `${JSON.stringify({ kind, recordedAt: new Date().toISOString(), data })}\n`;
        writes = writes.then(() => evidenceJournal.write(entry)).catch(() => { recordingError = true; controller.abort(); });
      };
      try {
        await mkdir(artifactDirectory, { mode: 0o700 });
        journal = await open(join(artifactDirectory, "events.ndjson"), "wx", 0o600);
        evidenceJournal = await open(join(artifactDirectory, "evidence.ndjson"), "wx", 0o600);
        await writeFile(join(artifactDirectory, "run.json"), JSON.stringify({ captureVersion: 1, captureId: report.runId, createdAt: report.createdAt,
          experiment: report.experiment, parameters }, null, 2), { flag: "wx", mode: 0o600 });
        const completed = await runBuild({ signal: controller.signal, parameters, parent, onPlan: async plan => {
          await writeFile(join(artifactDirectory, "frozen-plan.json"), JSON.stringify(plan, null, 2), { flag: "wx", mode: 0o600 });
          report.plan = plan; broadcast("snapshot", snapshot());
        }, onEvent: event => {
          if (event.type === "run_started") report.runId = event.runId;
          report.events.push(event);
          report.elapsedMs = event.atMs;
          writes = writes.then(() => journal.write(`${JSON.stringify(event)}\n`)).catch(() => { recordingError = true; controller.abort(); });
          broadcast("record", event);
        }, onMemory: memory => { appendEvidence("memory", memory); report.memoryExhibits.push(memory); broadcast("memory", memory); },
        onToolDetail: detail => { appendEvidence("tool-detail", detail); report.toolExhibits.push(detail); broadcast("tool-detail", detail); },
        onKnowledge: knowledge => { appendEvidence("knowledge", knowledge); report.knowledge = { ...report.knowledge, ...knowledge }; if (knowledge.guide) report.guide = knowledge.guide; broadcast("knowledge", knowledge); } });
        completed.parameters = parameters;
        completed.verification = labCompletion(completed);
        completed.study = studyProgress(completed, parent);
        report = completed;
        await writes;
        await journal.close(); journal = null;
        await evidenceJournal.close(); evidenceJournal = null;
        if (recordingError) throw new Error("event_recording_failed");
        for (const [key, projectDirectory] of [["application", "project"], ["controlApplication", "dalek-project"]]) if (completed[key]?.project) {
          const fixture = swarmFixture();
          for (const [path, text] of Object.entries(completed[key].project)) {
            if (!Object.hasOwn(fixture.files, path) || typeof text !== "string" || Buffer.byteLength(text) > 32768) throw new Error("invalid_project_artifact");
            const file = join(artifactDirectory, projectDirectory, path);
            await mkdir(dirname(file), { recursive: true });
            await writeFile(file, text, { flag: "wx", mode: 0o600 });
          }
          const { project, ...application } = completed[key];
          completed[key] = application;
        }
        report = completed;
        if (report.memoryExhibits) await writeFile(join(artifactDirectory, "memories.json"), JSON.stringify(report.memoryExhibits, null, 2), { flag: "wx", mode: 0o600 });
        if (report.toolExhibits) await writeFile(join(artifactDirectory, "tool-details.json"), JSON.stringify(report.toolExhibits, null, 2), { flag: "wx", mode: 0o600 });
        if (report.knowledge) await writeFile(join(artifactDirectory, "knowledge.json"), JSON.stringify(report.knowledge, null, 2), { flag: "wx", mode: 0o600 });
        if (report.controlExperiment) await writeFile(join(artifactDirectory, "control-experiment.json"), JSON.stringify(report.controlExperiment, null, 2), { flag: "wx", mode: 0o600 });
        if (report.kind === "rediscovery_lab") {
          await writeFile(join(artifactDirectory, "rediscovery-results.json"), JSON.stringify({ plan: report.plan, metrics: report.metrics, outcomes: report.outcomes, rounds: report.rounds }, null, 2), { flag: "wx", mode: 0o600 });
          await mkdir(join(artifactDirectory, "notebook"), { mode: 0o700 });
          for (const lesson of report.knowledge.lessons) await writeFile(join(artifactDirectory, "notebook", `${lesson.id}.md`), lesson.markdown, { flag: "wx", mode: 0o600 });
        }
        if (report.guide?.markdown) await writeFile(join(artifactDirectory, "solution-guide.md"), report.guide.markdown, { flag: "wx", mode: 0o600 });
        await writeDemoReplay(report, artifactDirectory, { reserved: true });
        lastRun = { directory: artifactDirectory, status: report.status, runId: report.runId, summary: report.summary };
      } catch (error) {
        report = { ...report, status: controller.signal.aborted && !recordingError ? "cancelled" : "partial",
          failure: recordingError ? "event_recording_failed" : error.message === "browser_acceptance_unavailable_run_playwright_install_chromium" ? error.message : "demo_execution_or_recording_failed" };
        report.study = studyProgress(report, parent);
        lastRun = { directory: artifactDirectory, status: report.status, runId: report.runId };
        try { await writeFile(join(artifactDirectory, "partial-report.json"), JSON.stringify(report, null, 2), { flag: "wx", mode: 0o600 }); } catch {}
      } finally {
        await writes;
        if (journal) await journal.close();
        if (evidenceJournal) await evidenceJournal.close();
        active = null;
        releaseRun?.();
        broadcast("snapshot", snapshot());
      }
      return lastRun;
    })();
    return run.promise;
  }
  const handleRequest = async (request, response) => {
    const json = (status, data) => { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(data)); };
    const address = new URL(url);
    if (request.headers.host !== address.host || request.headers.origin && request.headers.origin !== address.origin) { json(403, { error: "local_origin_required" }); return; }
    const path = new URL(request.url, url).pathname.slice(basePath.length) || "/";
    try {
      if (request.method === "GET" && ["/", "/replay", "/learnings"].includes(path)) {
        if (path === "/replay" && (!report || active)) { json(409, { error: "completed_recording_required" }); return; }
        response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff",
          "content-security-policy": "default-src 'none'; script-src 'unsafe-inline' data:; style-src 'unsafe-inline' data:; img-src data:; font-src data:; connect-src 'self'; frame-src 'self' blob:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'" });
        response.end(await renderDemoPage({ report, live: path !== "/replay", profiles: path !== "/replay" ? profiles : null, basePath, navigation }));
      } else if (request.method === "GET" && path === "/state") json(200, snapshot());
      else if (request.method === "GET" && path === "/report.json") {
        if (!report || active) { json(409, { error: "completed_recording_required" }); return; }
        json(200, report);
      }
      else if (request.method === "GET" && path === "/events") {
        if (clients.size >= 12) { json(429, { error: "too_many_viewers" }); return; }
        response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
        clients.add(response); send(response, "snapshot", snapshot());
        request.on("close", () => clients.delete(response));
      } else if (request.method === "POST" && ["/run", "/stop"].includes(path)) {
        if (request.headers["x-mindleak-demo"] !== "1" || request.headers["content-type"]?.split(";")[0] !== "application/json") { json(403, { error: "explicit_demo_command_required" }); return; }
        let body = "";
        for await (const chunk of request) { body += chunk; if (Buffer.byteLength(body) > 8192) { json(413, { error: "command_too_large" }); return; } }
        const command = JSON.parse(body);
        let parameters;
        try { parameters = selectDemoParameters(profiles, command); } catch { json(400, { error: "invalid_demo_parameters" }); return; }
        if (path === "/run") {
          if (active || busy()) { json(409, { error: "demo_already_running" }); return; }
          try { continuationParent(parameters); } catch { json(409, { error: "continuation_parent_mismatch" }); return; }
          void startRun(parameters); json(202, { started: true });
        } else {
          if (!active) { json(409, { error: "no_active_run" }); return; }
          active.controller.abort(); json(202, { stopping: true });
        }
      } else json(404, { error: "not_found" });
    } catch { if (!response.headersSent) json(500, { error: "demo_request_failed" }); else response.end(); }
  };
  let server;
  if (mount) { url = `${origin}${basePath}`; mount(handleRequest); }
  else {
    server = createServer(handleRequest);
    server.requestTimeout = 15000;
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); });
    });
    url = `http://127.0.0.1:${server.address().port}`;
  }
  return { url, startRun, snapshot, get lastRun() { return lastRun; }, async close() {
    if (active) { active.controller.abort(); await active.promise; }
    for (const response of clients) response.end(); clients.clear();
    if (server) { server.closeIdleConnections(); await new Promise(resolveClose => server.close(resolveClose)); }
  } };
}

export async function createLabHub({ labs, port = 54584 } = {}) {
  if (!Array.isArray(labs) || !labs.length || labs.some(lab => ![1, 2, 3].includes(lab.id))
    || new Set(labs.map(lab => lab.id)).size !== labs.length || !Number.isInteger(port) || port < 0 || port > 65535) throw new Error("invalid_lab_hub");
  const handlers = new Map(); const applications = new Map();
  let url; let activeLab = null;
  const server = createServer((request, response) => {
    if (request.headers.host !== new URL(url).host || request.headers.origin && request.headers.origin !== url) { response.writeHead(403); response.end(); return; }
    const path = new URL(request.url, url).pathname;
    if (path === "/" || path === "/learnings") {
      response.writeHead(302, { location: path === "/learnings" ? "/lab2/learnings" : `/lab${applications.has(2) ? 2 : labs[0].id}/` }); response.end(); return;
    }
    const prefix = /^\/lab[123](?=\/|$)/.exec(path)?.[0];
    const handle = handlers.get(prefix);
    if (!handle) { response.writeHead(404); response.end(); return; }
    void handle(request, response);
  });
  server.requestTimeout = 15000;
  await new Promise((resolveListen, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => { server.removeListener("error", reject); resolveListen(); }); });
  url = `http://127.0.0.1:${server.address().port}`;
  const navigation = Object.fromEntries(labs.map(lab => [`lab${lab.id}`, `${url}/lab${lab.id}/`]));
  const close = async () => {
    for (const application of applications.values()) await application.close();
    server.closeIdleConnections(); await new Promise(resolveClose => server.close(resolveClose));
  };
  try {
    for (const lab of labs) applications.set(lab.id, await createDemoServer({ ...lab, basePath: `/lab${lab.id}`, origin: url, navigation,
      profiles: lab.profiles ? { ...lab.profiles, navigation } : null, mount: handle => handlers.set(`/lab${lab.id}`, handle), busy: () => activeLab !== null,
      beforeRun: () => { if (activeLab !== null) throw new Error("demo_already_running"); activeLab = lab.id; return () => { activeLab = null; }; } }));
  } catch (error) { await close(); throw error; }
  return { url, labs: applications, close };
}

async function main() {
  const { values } = parseArgs({ options: { help: { type: "boolean" }, binary: { type: "string" }, "output-dir": { type: "string" },
    port: { type: "string" }, run: { type: "boolean" }, once: { type: "boolean" }, concurrency: { type: "string" }, attempts: { type: "string" },
    "code-engine": { type: "string" }, "code-image": { type: "string" }, "agent-max-steps": { type: "string" },
    "agent-timeout-ms": { type: "string" }, "agent-reasoning-effort": { type: "string" }, "agent-max-output-tokens": { type: "string" },
    "input-usd-per-million": { type: "string" }, "output-usd-per-million": { type: "string" },
    "agent-provider": { type: "string" }, "agent-model": { type: "string" }, "memory-model": { type: "string" }, recording: { type: "string" },
    lab: { type: "string" }, rounds: { type: "string" }, "lab-one-recording": { type: "string" }, "lab-two-recording": { type: "string" }, "lab-three-recording": { type: "string" },
    "rediscovery-profile": { type: "string" }, "query-seed": { type: "string" }, plan: { type: "boolean" },
    "lab-one-url": { type: "string" }, "lab-two-url": { type: "string" } } });
  if (values.help) { console.log("Set MINDLEAK_TEST_DATABASE_URL and use your Copilot login. Run node examples/swarm-demo.mjs --binary PATH --code-engine podman --port 54584 --output-dir target/swarm-labs. One dashboard serves /lab1, /lab2, /lab3 and /learnings. Labs 1 and 2 include five matched Dalek controls with no MindLeak access. Lab 3 compares fresh, notebook and MindLeak arms with a separate direct-lesson diagnostic; --rediscovery-profile smoke|pilot defaults to smoke (6 main + 2 diagnostic), while pilot schedules 120 main + 40 diagnostic sessions. --plan prints the frozen Lab 3 plan without inference or database access. --rounds 1..3 controls Lab 2. --lab 1|2|3 selects a standalone lab; --run starts Lab 2 in the shared dashboard. Use --lab-one-recording, --lab-two-recording and --lab-three-recording to reopen saved reports. Lab 1/2 models default to three GPT-6 Astra and two Claude Opus 5 with matched Daleks; all Lab 3 arms use one selected model. Memory extraction defaults to local glm-4.7-flash:latest. Only 127.0.0.1 is bound; learning outcomes lead the page and recorded costs remain available."); return; }
  if (values.plan) { console.log(JSON.stringify(rediscoveryPlan({ profile: values["rediscovery-profile"] ?? "pilot", seed: Number(values["query-seed"] ?? 20260917), model: values["agent-model"] ?? "gpt-6-astra" }), null, 2)); return; }
  benchmarkSettings(process.env, {});
  const selectedLab = values.lab ?? "all";
  if (!["all", "1", "2", "3"].includes(selectedLab)) throw new Error("invalid_lab");
  const labIds = selectedLab === "all" ? [1, 2, 3] : [Number(selectedLab)];
  const providerKind = values["agent-provider"] ?? "copilot";
  if (!["copilot", "openai"].includes(providerKind)) throw new Error("invalid_agent_provider");
  const provider = providerKind === "copilot" ? await openCopilotProvider() : null;
  const available = provider ? provider.models.filter(model => ["gpt-6-astra", "claude-opus-5", "mai-code-1.1-flash"].includes(model.id))
    : [{ id: values["agent-model"] ?? process.env.MINDLEAK_VALIDATION_AGENT_MODEL, name: values["agent-model"] ?? process.env.MINDLEAK_VALIDATION_AGENT_MODEL, provider: "openai-compatible" }];
  const memoryEndpoint = process.env.MINDLEAK_DEMO_MEMORY_URL ?? "http://127.0.0.1:11434/v1";
  const memoryModel = values["memory-model"] ?? "glm-4.7-flash:latest";
  const code = await containerConfiguration(values["code-engine"] ?? "podman", values["code-image"]);
  const binary = values.binary ?? fileURLToPath(new URL(`../target/debug/mindleak-light${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
  const output = values["output-dir"] ?? fileURLToPath(new URL("../target/swarm-labs", import.meta.url));
  const labs = [];
  for (const lab of labIds) {
  const profiles = { experiment: lab, agents: available, roles: lab === 3 ? rediscoveryArms : [...(lab === 2 ? memoryLabRoles : swarmRoles.map(({ task, ...role }) => role)), ...controlRoles],
    navigation: { lab1: values["lab-one-url"] ?? "/lab1/", lab2: values["lab-two-url"] ?? "/lab2/" },
    memory: [{ id: memoryModel, name: memoryModel, provider: "local", modelClass: "slm" }, { id: "off", name: "Model-free", provider: "none" }],
    defaults: { problem: lab === 3 ? rediscoveryProblem : lab === 2 ? memoryLabProblem : swarmProblem, concurrency: Number(values.concurrency ?? (lab >= 2 ? 1 : 2)), attempts: lab === 3 ? 1 : Number(values.attempts ?? 2), rounds: Number(values.rounds ?? (lab === 2 ? 2 : 1)), memoryModel,
      rediscoveryProfile: values["rediscovery-profile"] ?? "smoke", querySeed: Number(values["query-seed"] ?? 20260917),
      agentModels: Object.fromEntries(swarmRoles.map((role, index) => [role.id, values["agent-model"] ?? (provider ? index < 3 ? "gpt-6-astra" : "claude-opus-5" : available[0].id)])) } };
  selectDemoParameters(profiles);
  let initialReport = null;
  const recordingPath = values[lab === 1 ? "lab-one-recording" : lab === 2 ? "lab-two-recording" : "lab-three-recording"] ?? (selectedLab === "all" ? null : values.recording);
  if (recordingPath) {
    const bytes = await readFile(resolve(recordingPath));
    if (bytes.length > 16 * 1024 * 1024) throw new Error("replay_report_budget");
    initialReport = JSON.parse(bytes);
  }
  labs.push({ id: lab, outputDirectory: selectedLab === "all" ? join(output, `lab${lab}`) : output, profiles, initialReport,
    model: provider ? "Mixed frontier models" : available[0].name, runBuild: async options => {
      const { parameters } = options;
      const listeners = new Set();
      const observer = parameters.memoryModel === "off" ? null : await openMemoryUsageObserver({ endpoint: memoryEndpoint,
        model: parameters.memoryModel, apiKey: process.env.MINDLEAK_DEMO_MEMORY_API_KEY ?? "", onEvent: event => { for (const listener of listeners) listener(event); } });
      let driver;
      try {
        const settings = benchmarkSettings({ ...process.env, MINDLEAK_MODEL_TIMEOUT_SECS: "240", ...(observer ? {
          MINDLEAK_LLM_URL: observer.endpoint, MINDLEAK_MODEL: parameters.memoryModel, MINDLEAK_LLM_API_KEY: observer.apiKey } : {}) },
        observer ? { decomposition: "openai", "decomposition-reasoning-effort": "none" } : {});
        driver = await openMemoryDriver(binary, settings);
        driver.observeInference = listener => { listeners.add(listener); return () => listeners.delete(listener); };
        const actors = {};
        for (const role of swarmRoles) {
          const selectedModel = parameters.agentModels[role.id];
          actors[role.id] = provider ? createCopilotAgent(provider, { model: selectedModel, maxSteps: Number(values["agent-max-steps"] ?? (lab === 2 ? 24 : 20)),
            timeoutMs: Number(values["agent-timeout-ms"] ?? (lab === 2 ? 600000 : 300000)), reasoningEffort: values["agent-reasoning-effort"] ?? "low" })
            : await createAgent(agentSettings({ ...process.env, MINDLEAK_VALIDATION_AGENT_MODEL: selectedModel }, {
              maxSteps: Number(values["agent-max-steps"] ?? 20), timeoutMs: Number(values["agent-timeout-ms"] ?? 120000),
              maxOutputTokens: Number(values["agent-max-output-tokens"] ?? 4096), reasoningEffort: values["agent-reasoning-effort"] ?? null }));
        }
        const execute = lab === 3 ? runRediscoveryLab : lab === 2 ? runMemoryLab : runSwarmComparison;
        const executionOptions = { driver, agent: actors.atlas, agentsByRole: actors, code, concurrency: parameters.concurrency,
          profile: parameters.rediscoveryProfile, seed: parameters.querySeed,
          maxAttempts: parameters.attempts, problem: parameters.problem, ...options,
          onEvent: lab === 2 ? event => options.onEvent(preparationEvent(event)) : options.onEvent };
        let report = lab === 1 ? await runBuildWithAcceptance(onEvent => execute({ ...executionOptions, onEvent }), { onEvent: options.onEvent, signal: options.signal })
          : lab === 2 && options.parent ? continueMemoryPreparation(options.parent) : await execute(executionOptions);
        if (lab === 2 && options.parent) {
          const event = { id: 1, atMs: 0, type: "run_started", runId: report.runId, parentRunId: options.parent.runId, expectedTests: parameters.rounds * 70 };
          report.events.push(event); options.onEvent(event); options.onKnowledge(report.knowledge);
        }
        if (lab === 2 && report.status === "completed" && !options.signal.aborted) {
          const preparation = report; const memoryExhibits = [];
          const control = await runMemoryControl({ driver, preparation, agentsByRole: actors, code, rounds: parameters.rounds, signal: options.signal,
            onEvent: event => options.onEvent({ ...event, id: preparation.events.length + event.id, atMs: preparation.elapsedMs + event.atMs }),
            onToolDetail: options.onToolDetail,
            learn: settings => learnFromControlRound({ ...settings, driver, agent: actors.orion, code, maxAttempts: parameters.attempts,
              onMemory: memory => { memoryExhibits.push(memory); options.onMemory(memory); }, onKnowledge: options.onKnowledge }) });
          control.memoryExhibits = memoryExhibits;
          report = combineControlReport(preparation, control);
          for (const event of report.events.slice(preparation.events.length + control.events.length)) options.onEvent(event);
        }
        report.configuration = settings.configuration;
        return report;
      } finally { if (driver) await driver.close(); if (observer) await observer.close(); }
    } });
  }
  const server = selectedLab === "all" ? await createLabHub({ labs, port: Number(values.port ?? 54584) })
    : await createDemoServer({ ...labs[0], port: Number(values.port ?? 54584) });
  console.log(`MindLeak Swarm Labs: ${server.url}`);
  let closing = false;
  const close = async () => { if (closing) return; closing = true; try { await server.close(); } finally { if (provider) await provider.close(); } };
  process.once("SIGINT", () => { void close(); }); process.once("SIGTERM", () => { void close(); });
  if (values.run || values.once) {
    const result = await (server.labs?.get(2) ?? server).startRun();
    console.log(JSON.stringify(result));
    if (values.once) { await close(); if (result.status !== "completed") process.exitCode = 1; }
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error("swarm_demo_startup_failed_check_explicit_test_database_model_and_container_settings"); process.exitCode = 1; });
}
