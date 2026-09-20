import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual, parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { readAdrs, updateIndex } from "./adr-index.mjs";
import { readFragments, releaseChangelog, render } from "./changelog.mjs";
import { checkDocs } from "./check-docs.mjs";
import { packageBinary, releaseNotes, workspaceVersion } from "./release.mjs";
import { captureBenchmark, regressionPlan, runRegression } from "./regression-check.mjs";
import { cleanupProjects } from "./container-projects.mjs";
import { domainRequestId, importDomain, importReport, planDomainImport } from "../examples/import-domain.mjs";

const nativeBaselineAvailable = Object.hasOwn(
  JSON.parse(readFileSync(new URL("./regression-baseline.json", import.meta.url), "utf8")).archives,
  `${process.platform}-${process.arch}`,
);

test("knowledge-first onboarding introduces the hierarchy before setup", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /^# MindLeak$/m);
  assert.match(readme, /Agents Don't Need More Memory\.[\s\S]*They Need To Learn\./);
  const introduction = readme.slice(0, readme.indexOf("## Quickstart"));
  assert.match(introduction, /knowledge formation (system )?for agents/i);
  assert.match(introduction, /Observations[\s\S]*Chains of Memory[\s\S]*Principles/);
  assert.match(introduction, /evidence-backed/i);
  assert.match(introduction, /future agents can reuse/i);
  assert.ok(!introduction.includes("100,000"), "hypothetical compression counts must not appear as measured results");
});

test("README gives a complete agent setup command for the configured local server", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const setup = "agent setup --client vscode --server mindleak-light-local --scope repo:your-org/your-project";
  assert.ok(readme.includes(setup), "agent setup requires a client, an existing server and an explicit memory mode");
  assert.match(readme, /replace `--scope[^`]*`\s+with `--general`/i);
});

test("current release documentation and container defaults match the workspace version", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const version = workspaceVersion(root);
  for (const [file, phrase] of [
    ["README.md", `The v${version} native packages include`],
    ["docs/INSTALL.md", `This guide targets **v${version}**`],
    ["docs/LOCAL.md", `to \`monkeemagic/mindleak-light:${version}\``],
    ["docker/compose.all-in-one.yml", `MINDLEAK_IMAGE:-monkeemagic/mindleak-light:${version}`],
  ]) assert.ok(readFileSync(join(root, file), "utf8").includes(phrase), `${file} must match the current release`);
});

test("lab integration prerequisites fail without retaining MCP children", {
  skip: !process.env.MINDLEAK_LAB2_TEST_BINARY && "Set MINDLEAK_LAB2_TEST_BINARY for the owned child-process probe.",
}, async () => {
  const environment = { ...process.env, MINDLEAK_VALIDATION_CODE_ENGINE: "unavailable" };
  delete environment.NODE_TEST_CONTEXT;
  const result = await captureBenchmark(["--test", "--test-name-pattern=Lab 2 full relay|Lab 3 runs knowledge-first",
    fileURLToPath(new URL("../examples/validation-harness.test.mjs", import.meta.url))], {
    timeout: 15000, env: environment,
  });
  assert.equal(result.error, undefined, "failed setup must exit normally, not require a timeout to kill leaked servers");
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout + result.stderr, /code_engine_must_be_podman_or_docker/);
  assert.match(result.stdout, /(?:tests 2|1\.\.2)/);
});

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "mindleak-light-records-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test("domain importer accounts for unsupported, unresolved and duplicate source edges", () => {
  const header = { format: "mindleak-domain", version: 1, namespace: "test:domain", scope: "test:domain" };
  const entity = { kind: "entity", id: "one", label: "One", entityType: "package", text: "Original entity source." };
  const edge = { kind: "edge", id: "edge-one", source: "one", target: "one", predicate: "confirms",
    provenance: { sourceReferences: ["fixture:edge"], reportedConfidence: 0.4 }, text: "Original edge source." };
  const source = [header, edge, entity, edge, { ...edge, id: "missing", target: "absent" }, { ...edge, id: "extra", verifiedTruth: true }].map(value => JSON.stringify(value)).join("\n");
  const plan = planDomainImport(source);
  const report = importReport(plan);
  assert.equal(report.sourceRecords, 5);
  assert.equal(report.sourceEdges, 4);
  assert.deepEqual(report.counts, { ready: 3, unresolved: 1, unsupported: 1 });
  assert.equal(report.complete, false);
  assert.equal(plan.records[0].requestId, plan.records[2].requestId);
  assert.notEqual(domainRequestId("test:domain", "entity", "one"), domainRequestId("test:domain", "edge", "one"));
  assert.ok(!JSON.stringify(report).includes("Original edge source"));
  const conflicts = planDomainImport([header, entity, { ...entity, label: "Changed" }, edge].map(value => JSON.stringify(value)).join("\n"));
  assert.deepEqual(importReport(conflicts).counts, { conflict: 2, unresolved: 1 });
  const repeated = planDomainImport([header, ...Array(2000).fill(entity), { ...entity, label: "Changed" }, entity, edge].map(value => JSON.stringify(value)).join("\n"));
  assert.deepEqual(importReport(repeated).counts, { conflict: 2002, unresolved: 1 });
});

test("domain importer resumes with stable receipts and verifies every source edge", async () => {
  const header = { format: "mindleak-domain", version: 1, namespace: "test:resume" };
  const entity = { kind: "entity", id: "one", label: "One", entityType: "package", text: "Exact entity source." };
  const edge = { kind: "edge", id: "one", source: "one", target: "one", predicate: "depends_on", provenance: { sourceReferences: ["fixture:one"] }, text: "Exact edge source." };
  const source = [header, edge, entity, { ...edge, id: "two" }, edge].map(value => JSON.stringify(value)).join("\n");
  assert.equal(planDomainImport(source).header.scope, null, "Omitted import scope is valid and leaves records unscoped");
  const records = new Map();
  const calls = [];
  const client = {
    getServerVersion: () => ({ name: "mindleak-light", version: "test" }),
    listTools: async () => ({ tools: ["write_memory", "recall_memory", "decompose_memory"].map(name => ({ name, inputSchema: { properties: { domain: {} } } })) }),
    callTool: async call => {
      calls.push(call);
      const input = call.arguments;
      const key = JSON.stringify([input.domain.kind, input.domain.identity]);
      if (call.name === "write_memory") {
        const previous = records.get(key);
        if (previous && !isDeepStrictEqual(previous.input, input)) throw { code: -32602 };
        if (!previous) records.set(key, { input, memoryId: input.requestId });
        return { structuredContent: { memoryId: records.get(key).memoryId } };
      }
      const { input: saved, memoryId } = records.get(key);
      return { structuredContent: { record: { memoryId, agentId: saved.agentId, rawText: saved.text, context: saved.context, domain: saved.domain } } };
    },
  };
  for (let attempt = 0; attempt < 2; attempt++) {
    const report = await importDomain(planDomainImport(source), client, { agentId: "import-test", concurrency: 2 });
    assert.equal(report.complete, true);
    assert.deepEqual(report.counts, { verified: 4 });
    assert.equal(report.sourceEdges, 3);
    assert.equal(records.size, 3);
  }
  assert.ok(calls.filter(call => call.name === "write_memory").every(call => !call.arguments.facts));
});

test("domain importer does not credit failed or mismatched writes and respects concurrency", async () => {
  const header = { format: "mindleak-domain", version: 1, namespace: "test:failures", scope: "test:failures" };
  const entities = Array.from({ length: 8 }, (_, index) => ({ kind: "entity", id: `entity-${index}`, label: "Entity", entityType: "package", text: "Sensitive source canary." }));
  const edge = { kind: "edge", id: "edge", source: entities[0].id, target: entities[1].id, predicate: "depends_on", provenance: { sourceReferences: ["fixture:edge"] }, text: "Sensitive edge canary." };
  const source = [header, ...entities, edge].map(value => JSON.stringify(value)).join("\n");
  let active = 0;
  let peak = 0;
  const client = {
    getServerVersion: () => ({ name: "mindleak-light", version: "test" }),
    listTools: async () => ({ tools: ["write_memory", "recall_memory", "decompose_memory"].map(name => ({ name, inputSchema: { properties: { domain: {} } } })) }),
    callTool: async call => {
      active++;
      peak = Math.max(peak, active);
      await new Promise(resolve => setImmediate(resolve));
      active--;
      assert.equal(call.arguments.domain.kind, "entity", "Edges with unverified endpoints must not be attempted");
      if (call.name === "write_memory") return { structuredContent: { memoryId: "acknowledged" } };
      return { structuredContent: { record: { memoryId: "different", rawText: "Sensitive edge canary." } } };
    },
  };
  const report = await importDomain(planDomainImport(source), client, { agentId: "test", concurrency: 3 });
  assert.equal(report.complete, false);
  assert.deepEqual(report.counts, { failed: 8, unresolved: 1 });
  assert.ok(peak > 1 && peak <= 3);
  assert.ok(!JSON.stringify(report).includes("Sensitive"));
  const cancelled = await importDomain(planDomainImport(source), client, { agentId: "test", signal: AbortSignal.abort() });
  assert.deepEqual(cancelled.counts, { not_imported: 9 });
  await assert.rejects(importDomain(planDomainImport(source), { ...client, getServerVersion: () => ({ name: "other" }) }, { agentId: "test" }), /server_does_not_support/);
});

test("domain importer refuses an existing report before starting a server", {
  skip: !existsSync(new URL("../examples/node_modules/@modelcontextprotocol/sdk/package.json", import.meta.url)) && "Install example SDK dependencies for the CLI child-process probe.",
}, context => {
  const directory = fixture(context);
  const input = join(directory, "input.jsonl");
  const report = join(directory, "report.json");
  const launched = join(directory, "launched");
  writeFileSync(input, JSON.stringify({ format: "mindleak-domain", version: 1, namespace: "test:output", scope: null }) + "\n");
  writeFileSync(report, "prior evidence");
  const child = join(directory, "child.cjs");
  writeFileSync(child, `require("node:child_process").spawn = () => { require("node:fs").writeFileSync(${JSON.stringify(launched)}, "launched"); throw new Error("probe child startup"); }; require("node:module").syncBuiltinESMExports();`);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../examples/import-domain.mjs", import.meta.url)),
    "--input", input, "--apply", "--binary", process.execPath, "--output", report], {
    encoding: "utf8", env: { ...process.env, NODE_OPTIONS: `--require=${JSON.stringify(child)}` }, timeout: 10000,
  });
  assert.equal(result.status, 1);
  assert.equal(readFileSync(report, "utf8"), "prior evidence");
  assert.ok(!existsSync(launched), "Report refusal must precede all MCP startup");
});

test("domain importer preserves real PostgreSQL edges across fresh stdio processes", {
  skip: !process.env.MINDLEAK_DOMAIN_TEST_BINARY && "Set MINDLEAK_DOMAIN_TEST_BINARY and an owned *_test database for the real importer check.",
}, async context => {
  const database = new URL(process.env.MINDLEAK_TEST_DATABASE_URL);
  assert.ok(decodeURIComponent(database.pathname).endsWith("_test"));
  const directory = fixture(context);
  const input = join(directory, "domain.jsonl");
  const namespace = `import-${randomUUID()}`;
  const header = { format: "mindleak-domain", version: 1, namespace, scope: namespace };
  const entities = ["source", "target"].map(id => ({ kind: "entity", id, label: id, entityType: "package", text: `The exported ${id} is a package.` }));
  const edges = ["one", "two", "three"].map((id, index) => ({ kind: "edge", id, source: "source", target: index === 2 ? "source" : "target",
    predicate: index === 1 ? "confirms" : "depends_on", provenance: { sourceReferences: [`fixture:${id}`], reportedConfidence: 0.7 }, text: `The export reports relationship ${id}.` }));
  const unresolved = { ...edges[0], id: "unresolved", target: "absent" };
  const malformed = { ...edges[0], id: "unsupported", silentlyDiscardThis: "private-canary" };
  writeFileSync(input, [header, ...edges, ...entities, edges[0], unresolved, malformed].map(value => JSON.stringify(value)).join("\n"));
  const importer = fileURLToPath(new URL("../examples/import-domain.mjs", import.meta.url));
  const env = { ...process.env, MINDLEAK_DATABASE_URL: database.href, MINDLEAK_DECOMPOSITION: "sentences", MINDLEAK_RETRIEVAL: "keyword", MINDLEAK_RELEVANCE: "off" };
  const invoke = () => spawnSync(process.execPath, [importer, "--input", input, "--apply", "--binary", process.env.MINDLEAK_DOMAIN_TEST_BINARY,
    "--agent-id", namespace, "--concurrency", "4"], { cwd: directory, env, encoding: "utf8", timeout: 60000, maxBuffer: 1024 * 1024 });
  const initial = invoke();
  assert.equal(initial.status, 1);
  assert.ok(!initial.error && !initial.stderr.includes("private-canary"));
  const first = JSON.parse(initial.stdout);
  assert.equal(first.complete, false);
  assert.deepEqual(first.counts, { verified: 6, unresolved: 1, unsupported: 1 });
  assert.equal(first.sourceEdges, 6);
  assert.ok(!initial.stdout.includes("private-canary") && !initial.stdout.includes("The export reports"));
  writeFileSync(input, [header, ...edges, ...entities, edges[0]].map(value => JSON.stringify(value)).join("\n"));
  const resumed = invoke();
  assert.equal(resumed.status, 0, "The valid import must resume through a fresh MCP process");
  const second = JSON.parse(resumed.stdout);
  assert.equal(second.complete, true);
  assert.equal(new Set(second.records.map(record => record.memoryId)).size, 5);
  assert.deepEqual(second.records.map(record => record.memoryId), first.records.slice(0, 6).map(record => record.memoryId));
  const { Client } = await import("../examples/node_modules/@modelcontextprotocol/sdk/dist/esm/client/index.js");
  const { StdioClientTransport } = await import("../examples/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js");
  const client = new Client({ name: "domain-import-readback", version: "1.0.0" });
  try {
    await client.connect(new StdioClientTransport({ command: process.env.MINDLEAK_DOMAIN_TEST_BINARY, args: ["--transport", "stdio"], env, cwd: directory, stderr: "pipe" }));
    const result = await client.callTool({ name: "recall_memory", arguments: { scope: namespace, domain: {
      kind: "entity", identity: { namespace, id: "source" }, direction: "outgoing",
    } } });
    assert.ok(!result.isError);
    const records = result.structuredContent.relationships;
    assert.equal(records.length, 3);
    assert.equal(new Set(records.map(record => record.domain.identity.id)).size, 3);
    assert.ok(records.some(record => record.domain.source.id === record.domain.target.id));
  } finally { await client.close(); }
});

test("release regression plans pin corpora and require independent disposable databases", (context) => {
  const environment = {
    MINDLEAK_BASELINE_DATABASE_URL: "postgresql://localhost/baseline_test",
    MINDLEAK_TEST_DATABASE_URL: "postgresql://localhost/candidate_test",
  };
  const plan = regressionPlan(environment);
  assert.equal(plan.definition.release, "v0.4.0");
  assert.equal(plan.corpora.reduce((count, corpus) => count + corpus.evaluationQueries, 0), 100);
  assert.equal(plan.settings.configuration.retrieval, "keyword");
  assert.deepEqual(plan.workloads, [{ concurrency: 1, passes: 1 }]);
  assert.equal(plan.deadlineMs, 600000);
  assert.deepEqual(regressionPlan(environment, { profile: "load" }).workloads, [{ concurrency: 1, passes: 3 }, { concurrency: 4, passes: 3 }]);
  assert.equal(regressionPlan(environment, { profile: "load" }).deadlineMs, 900000);
  assert.equal(regressionPlan(environment, { "deadline-seconds": "1" }).deadlineMs, 1000);
  assert.equal(regressionPlan(environment, { profile: "load", "deadline-seconds": "7200" }).deadlineMs, 7200000);
  for (const value of ["0", "-1", "1.5", "", "NaN", "601"]) {
    assert.throws(() => regressionPlan(environment, { "deadline-seconds": value }), /deadline/i);
  }
  assert.throws(() => regressionPlan(environment, { profile: "load", "deadline-seconds": "7201" }), /deadline/i);
  assert.throws(() => regressionPlan({ ...environment, MINDLEAK_BASELINE_DATABASE_URL: environment.MINDLEAK_TEST_DATABASE_URL }), /different disposable/);
  assert.throws(() => regressionPlan({
    ...environment,
    MINDLEAK_BASELINE_DATABASE_URL: "postgresql://localhost/candidate%5Ftest",
  }), /different disposable/, "URL escaping must not hide that both runs use the same database");
  assert.throws(() => regressionPlan({ ...environment, MINDLEAK_TEST_DATABASE_URL: "postgresql://localhost/production" }), /_test/);
  assert.throws(() => regressionPlan(environment, { profile: "unknown" }), /profile/);
  assert.throws(() => regressionPlan(environment, { "max-warm-p95-ms": "100" }), /two passes/);
  const directory = fixture(context);
  mkdirSync(join(directory, "scripts"));
  mkdirSync(join(directory, "examples/fixtures"), { recursive: true });
  writeFileSync(join(directory, "scripts/regression-baseline.json"), JSON.stringify(plan.definition));
  for (const corpus of plan.corpora) writeFileSync(join(directory, corpus.path), "{}");
  assert.throws(() => regressionPlan(environment, {}, directory), /Frozen corpus changed/);
});

test("release regression failure preserves incomplete evidence without connecting to a database", {
  skip: !nativeBaselineAvailable && "No native release archive is pinned for this platform.",
}, async (context) => {
  const directory = fixture(context);
  const archive = join(directory, "invalid.tar.gz");
  const output = join(directory, "reports");
  writeFileSync(archive, "deliberately-invalid-archive");
  const environment = {
    MINDLEAK_BASELINE_DATABASE_URL: "postgresql://fixture-private-value@localhost/baseline_test",
    MINDLEAK_TEST_DATABASE_URL: "postgresql://fixture-private-value@localhost/candidate_test",
  };
  await assert.rejects(runRegression(environment, {
    candidate: process.execPath, output, "baseline-archive": archive,
  }), /checksum/);
  const source = readFileSync(join(output, "summary.json"), "utf8");
  const summary = JSON.parse(source);
  assert.equal(summary.complete, false);
  assert.equal(summary.passed, false);
  assert.deepEqual(summary.runs, []);
  assert.match(summary.error, /checksum/);
  assert.ok(!source.includes("fixture-private-value"));
  await assert.rejects(runRegression(environment, {
    candidate: process.execPath, output, "baseline-archive": archive,
  }), /EEXIST/);
  assert.equal(readFileSync(join(output, "summary.json"), "utf8"), source);
});

test("runner deadline covers a stalled download and retains a failed summary", {
  skip: !nativeBaselineAvailable && "No native release archive is pinned for this platform.",
}, async (context) => {
  const output = join(fixture(context), "deadline-reports");
  let downloadCancelled = false;
  context.mock.method(globalThis, "fetch", async (_url, options) => new Promise((resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error("fixture fallback expired")), 2000);
    const abort = () => {
      clearTimeout(fallback);
      downloadCancelled = true;
      reject(options.signal.reason);
    };
    options.signal.addEventListener("abort", abort, { once: true });
    if (options.signal.aborted) abort();
  }));
  await assert.rejects(runRegression({
    MINDLEAK_BASELINE_DATABASE_URL: "postgresql://localhost/deadline_baseline_test",
    MINDLEAK_TEST_DATABASE_URL: "postgresql://localhost/deadline_candidate_test",
  }, { candidate: process.execPath, output, "deadline-seconds": "1" }));
  const summary = JSON.parse(readFileSync(join(output, "summary.json"), "utf8"));
  assert.equal(downloadCancelled, true, "the runner-wide deadline must cancel its pending download");
  assert.equal(summary.complete, false);
  assert.equal(summary.passed, false);
  assert.equal(summary.limits.deadlineSeconds, 1);
  assert.match(summary.error, /deadline/i);
  assert.deepEqual(summary.runs, []);
});

test("benchmark deadlines terminate children that ignore graceful shutdown", async () => {
  const result = await captureBenchmark(["-e", `
    process.on("SIGTERM", () => {});
    process.stdout.write("fixture started");
    setTimeout(() => process.exit(0), 2500);
  `], { timeout: 1000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.match(result.stdout, /fixture started/);
  assert.equal(result.error?.code, "ETIMEDOUT");
  if (process.platform !== "win32") assert.equal(result.signal, "SIGKILL");
  else assert.notEqual(result.status, 0, "deadline must not wait for a child that ignores SIGTERM");
});

test("benchmark timeout owns descendant termination and child temporary files", async (context) => {
  const directory = fixture(context);
  let descendant;
  try {
    const result = await captureBenchmark(["-e", `
      const { spawn } = require("node:child_process");
      const { mkdtempSync, writeFileSync } = require("node:fs");
      const { tmpdir } = require("node:os");
      const { join } = require("node:path");
      const temporary = mkdtempSync(join(tmpdir(), "mindleak-recall-"));
      writeFileSync(join(temporary, "temporary-executable"), "test-owned data");
      const child = spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], { stdio: "ignore" });
      child.once("spawn", () => process.stdout.write(JSON.stringify({ pid: child.pid, temporary })));
      setTimeout(() => {}, 5000);
    `], { timeout: 1000, env: { ...process.env, NODE_OPTIONS: "", TMPDIR: directory, TMP: directory, TEMP: directory } });
    const info = JSON.parse(result.stdout);
    descendant = info.pid;
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    assert.equal(result.error?.code, "ETIMEDOUT");
    let running = false;
    try {
      process.kill(descendant, 0);
      if (process.platform === "linux") {
        running = !/^State:\s+Z/m.test(readFileSync(`/proc/${descendant}/status`, "utf8"));
      } else {
        running = process.platform === "win32" || !execFileSync("ps", ["-o", "stat=", "-p", String(descendant)], {
          encoding: "utf8", stdio: ["ignore", "pipe", "ignore"],
        }).trim().startsWith("Z");
      }
    } catch (error) {
      if (!["ESRCH", "ENOENT"].includes(error.code) && error.status !== 1) throw error;
    }
    assert.equal(running, false, "a timed-out wrapper must not leave its descendant running");
    assert.equal(existsSync(info.temporary), false, "parent cleanup must remove child-owned temporary executables");
  } finally {
    if (descendant) {
      try { process.kill(descendant, "SIGKILL"); }
      catch (error) { if (error.code !== "ESRCH") throw error; }
    }
  }
});

test("benchmark capture cleans normal runs and refuses cancelled or oversized output", async () => {
  const normal = await captureBenchmark(["-e", `
    const { writeFileSync } = require("node:fs");
    const { tmpdir } = require("node:os");
    const { join } = require("node:path");
    writeFileSync(join(tmpdir(), "test-output"), "fixture");
    process.stdout.write(JSON.stringify({ temporary: tmpdir() }));
  `], { timeout: 2000 });
  assert.equal(normal.status, 0);
  assert.equal(normal.error, undefined);
  assert.equal(existsSync(JSON.parse(normal.stdout).temporary), false);
  const reason = new Error("already cancelled");
  await assert.rejects(captureBenchmark(["-e", "throw new Error('must not start')"], {
    signal: AbortSignal.abort(reason),
  }), error => error === reason);
  const oversized = await captureBenchmark(["-e", `
    process.stdout.write("x".repeat(65536));
    setTimeout(() => {}, 5000);
  `], { timeout: 2000, maxBuffer: 32 });
  assert.equal(oversized.error?.code, "ENOBUFS");
  assert.equal(Buffer.byteLength(oversized.stdout), 32);
  assert.notEqual(oversized.status, 0);
});

test("runner cancellation interrupts a pending capture and removes its temporary files", async () => {
  const result = await captureBenchmark(["-e", `
    process.stdout.write(JSON.stringify({ temporary: require("node:os").tmpdir() }));
    process.on("SIGTERM", () => {});
    setTimeout(() => {}, 5000);
  `], { timeout: 4000, signal: AbortSignal.timeout(1000) });
  assert.equal(result.error?.code, "ABORT_ERR");
  assert.notEqual(result.status, 0);
  assert.equal(existsSync(JSON.parse(result.stdout).temporary), false);
});

test("required CI includes release comparisons and a fresh-volume restore with retained evidence", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const workflow = read(".github/workflows/ci.yml");
  const integration = workflow.slice(workflow.indexOf("  postgres:"), workflow.indexOf("  hygiene:"));
  assert.match(integration, /name: Postgres and MCP Integration/);
  assert.match(integration, /scripts\/regression-check\.mjs --candidate target\/release\/mindleak-light/);
  assert.match(integration, /--deadline-seconds 600/);
  assert.match(integration, /name: Compare with the pinned released baseline\n\s+timeout-minutes: 12/);
  assert.match(integration, /MINDLEAK_BASELINE_DATABASE_URL:/);
  assert.match(integration, /if: always\(\)[\s\S]*actions\/upload-artifact/);
  const output = "${{ runner.temp }}/mindleak-regression-${{ github.run_id }}-${{ github.run_attempt }}";
  assert.ok(integration.includes(`REGRESSION_OUTPUT: ${output}`),
    "release comparison output must be outside the restored Cargo target cache");
  assert.ok(integration.includes('--output "$REGRESSION_OUTPUT"'));
  assert.ok(integration.includes(`path: ${output}/`), "upload the same per-run evidence directory");
  const container = workflow.slice(workflow.indexOf("  all-in-one:"));
  assert.match(container, /regression-baseline\.json/);
  assert.match(container, /shell: bash[\s\S]*container-smoke\.mjs --restore/);
  assert.match(container, /scripts\/container-smoke\.mjs --restore/);
  assert.match(container, /if: always\(\)[\s\S]*baseline-restore/);
  const load = read(".github/workflows/regression-load.yml");
  assert.match(load, /workflow_dispatch:/);
  assert.ok(!load.includes("pull_request:"));
  assert.match(load, /--profile load/);
  assert.match(load, /--deadline-seconds 900/);
  assert.match(load, /name: Compare first and repeat passes at concurrency one and four\n\s+timeout-minutes: 17/);
  assert.match(load, /timeout-minutes: 45/);
  assert.match(load, /cargo build[^\n]*\n\s+timeout-minutes: 15/);
  assert.ok(!load.includes("--max-warm-p95-ms"));
});

test("container cleanup attempts every owned project and reports all failures", () => {
  const projects = new Set(["smoke-test", "restore-test", "third-test"]);
  const attempted = [];
  const first = new Error("first removal failed");
  const last = new Error("last removal failed");
  let failure;
  try {
    cleanupProjects(projects, project => {
      attempted.push(project);
      if (project === "smoke-test") throw first;
      if (project === "third-test") throw last;
    });
  } catch (error) { failure = error; }
  assert.deepEqual(attempted, [...projects], "one failed removal must not strand another owned volume");
  assert.ok(failure instanceof AggregateError);
  assert.deepEqual(failure.errors.map(error => error.cause), [first, last]);
  assert.ok(failure.errors[0].message.includes("smoke-test"));
  assert.ok(failure.errors[1].message.includes("third-test"));
  const removed = [];
  cleanupProjects(projects, project => removed.push(project));
  assert.deepEqual(removed, [...projects]);
  assert.doesNotThrow(() => cleanupProjects([], () => assert.fail("no project to remove")));
  const original = new Error("restore assertion failed");
  assert.throws(() => cleanupProjects(projects, () => {}, original), error => error === original);
  assert.throws(() => cleanupProjects(projects, project => {
    if (project === "restore-test") throw first;
  }, original), error => error instanceof AggregateError
    && error.errors[0] === original && error.errors[1].cause === first);
});

const record = "# ADR-0001: Example\n\n- Status: Accepted\n- Date: 2026-09-16\n\n## Context\n\nText\n\n## Decision\n\nText\n\n## Consequences\n\nText\n\n## Verification\n\nTest\n";

test("ADR records produce a stable index without losing surrounding text", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "0001-example.md"), record);
  const original = "Intro\n\n| ADR | Title | Status |\n|---|---|---|\n\nFooter\n";
  const updated = updateIndex(original, readAdrs(directory));
  assert.match(updated, /\[0001\]\(0001-example.md\) \| Example \| Accepted/);
  assert.ok(updated.startsWith("Intro\n"));
  assert.ok(updated.endsWith("\nFooter\n"));
  assert.equal(updateIndex(updated, readAdrs(directory)), updated);
});

test("ADR validation refuses duplicate numbers, missing sections, and invalid statuses", (context) => {
  const directory = fixture(context);
  const path = join(directory, "0001-example.md");
  writeFileSync(path, record);
  writeFileSync(join(directory, "0001-other.md"), record);
  assert.throws(() => readAdrs(directory), /duplicate/);
  rmSync(join(directory, "0001-other.md"));
  for (const invalid of [
    record.replace("Accepted", "Unknown"),
    record.replace("Accepted", "Superseded by [ADR-0002](0002-missing.md)"),
    record.replace("## Verification", "## Missing"),
    record.replace("2026-09-16", "2026-02-31"),
    record.replace("ADR-0001:", "ADR-0002:"),
  ]) {
    writeFileSync(path, invalid);
    assert.throws(() => readAdrs(directory));
  }
});

test("changelog fragments are grouped in canonical section order", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "fixed-example.md"), "- Fix a bug.\n");
  writeFileSync(join(directory, "added-example.md"), "- Add a feature.\n");
  const { grouped, files } = readFragments(directory);
  assert.equal(files.length, 2);
  assert.equal(render(grouped), "### Added\n- Add a feature.\n\n### Fixed\n- Fix a bug.");
  writeFileSync(join(directory, "invalid.md"), "- Invalid name.\n");
  assert.throws(() => readFragments(directory), /invalid/);
});

test("release preserves existing unreleased entries and old release history", () => {
  const original = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Existing fix.\n\n## [0.0.1] - 2026-01-01\n\nOld release.\n";
  const grouped = new Map([["fixed", ["- New fix."]], ["added", ["- New feature."]]]);
  const output = releaseChangelog(original, grouped, "0.1.0", "2026-09-16");
  assert.match(output, /## \[0.1.0\] - 2026-09-16/);
  assert.match(output, /- Existing fix.\n- New fix./);
  assert.ok(output.endsWith("## [0.0.1] - 2026-01-01\n\nOld release.\n"));
  assert.throws(() => releaseChangelog(output, grouped, "0.1.0", "2026-09-16"), /already released/);
  assert.throws(() => releaseChangelog(original, grouped, "bad", "2026-09-16"), /semantic version/);
  assert.throws(() => releaseChangelog("## [Unreleased]\n", new Map(), "0.1.0", "2026-09-16"), /nothing/);
});

test("repository record commands validate the actual checkout", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const script of ["adr-index.mjs", "changelog.mjs"]) {
    const output = execFileSync(process.execPath, [join(root, "scripts", script), "--check"], { cwd: root, encoding: "utf8" });
    assert.match(output, /valid/);
  }
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /MemoryRetriever/);
});

test("quickstart documentation and editor config agree on a model-free setup", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const readme = readFileSync(join(root, "README.md"), "utf8");
  const editor = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
  assert.deepEqual(editor, { servers: {} });
  assert.ok(readme.includes("local setup"));
  assert.ok(readme.includes("mindleak-light-local"));
  assert.ok(readme.includes("MCP: List Servers"));
  assert.match(readme, /The v\d+\.\d+\.\d+ native packages include the `local` launcher/);
  const defaults = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
  assert.equal(defaults.MINDLEAK_DECOMPOSITION, "sentences");
  assert.equal(defaults.MINDLEAK_RETRIEVAL, "keyword");
  assert.equal(defaults.MINDLEAK_RELEVANCE, "off");
  assert.equal(defaults.MINDLEAK_FORMATION, "off");
  for (const file of ["docker-compose.yml", "docker/compose.all-in-one.yml"]) {
    assert.ok(readFileSync(join(root, file), "utf8").includes("MINDLEAK_FORMATION: ${MINDLEAK_FORMATION:-off}"));
  }
  assert.equal(defaults.MINDLEAK_MODEL, undefined);
  assert.equal(defaults.MINDLEAK_EMBED_MODEL, undefined);
  assert.equal(defaults.MINDLEAK_RELEVANCE_MODEL, undefined);
});

test("CI retains explicit knowledge benchmark evidence alongside legacy comparisons", () => {
  const workflow = readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes("--category knowledge_workflow"));
  assert.ok(workflow.includes("--formation off"));
  assert.ok(workflow.includes("knowledge-workflow-${{ github.run_id }}"));
  assert.ok(workflow.includes("scripts/regression-check.mjs"));
});

test("native releases publish only binary packages and checksum artifacts", () => {
  const workflow = readFileSync(new URL("../.github/workflows/release.yml", import.meta.url), "utf8");
  const publish = workflow.slice(workflow.indexOf("  publish:\n"));
  assert.ok(publish.includes("pattern: mindleak-light-*"));
  assert.ok(publish.includes("dist/mindleak-light-*.tar.gz\n"));
  assert.ok(publish.includes("dist/mindleak-light-*.tar.gz.sha256"));
  assert.ok(!publish.includes("files: dist/*"));
});

test("README leads with credential-free local setup and separates shared HTTP", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const containerStart = readme.indexOf("\n## Standalone Container\n");
  const sourceStart = readme.indexOf("\n## Quickstart\n");
  assert.ok(sourceStart > 0 && containerStart > sourceStart,
    "credential-free local use must precede shared container configuration");
  const local = readme.slice(sourceStart, containerStart);
  assert.ok(local.includes("local setup"));
  assert.ok(!local.includes("Authorization") && !local.includes("MINDLEAK_HTTP_TOKEN="));
  const section = readme.slice(containerStart, readme.indexOf("\n## Give Your Agent a Memory Policy\n"));
  assert.ok(section.includes("https://hub.docker.com/r/monkeemagic/mindleak-light"));
  assert.match(section, /monkeemagic\/mindleak-light:\d+\.\d+\.\d+/);
  assert.ok(section.includes("TLS") && section.includes("token"));
  assert.match(section, /PostgreSQL.*pgvector/);
  assert.ok(!section.includes("monkeemagic/mindleak-light:latest"));
});

test("README teaches the agent memory policy before the explicit tool smoke test", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const policyStart = readme.indexOf("\n## Give Your Agent a Memory Policy\n");
  const smokeTestStart = readme.indexOf("\n## Try It\n");
  assert.ok(policyStart > 0 && smokeTestStart > policyStart, "the agent policy must be a visible setup step before Try It");
  const section = readme.slice(policyStart, smokeTestStart);
  const policy = /```text\n([\s\S]*?)\n```/.exec(section)?.[1];
  assert.ok(policy, "the README needs a ready-to-use agent policy, not only a link");
  for (const term of ["recall_memory", "write_memory", "memoryId", "agentId"]) {
    assert.ok(policy.includes(term), `the policy must explain ${term}`);
  }
  assert.match(policy, /verify/i);
  assert.match(policy, /secrets/i);
  assert.match(policy, /save nothing/i);
  assert.ok(section.includes("docs/INTEGRATION.md#put-memory-into-the-agents-routine"));
  assert.ok(readme.slice(0, policyStart).includes("#give-your-agent-a-memory-policy"));
});

test("local and shared guides describe the verified authentication boundaries", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const integration = readFileSync(join(root, "docs/INTEGRATION.md"), "utf8");
  const local = readFileSync(join(root, "docs/LOCAL.md"), "utf8");
  const security = readFileSync(join(root, "SECURITY.md"), "utf8");
  const notice = "MindLeak does not provide OAuth client registration. Cancel unexpected registration dialogs.";
  for (const guide of [integration, local, security]) assert.ok(guide.includes(notice));
  assert.ok(integration.includes("## Shared HTTP"));
  assert.ok(integration.includes("TLS") && integration.includes(".env.http"));
  assert.ok(integration.includes("**Edit**") && integration.includes("**Restart Server**"));
  assert.ok(integration.includes("does not suppress"));
  assert.ok(integration.includes("force-recreate"));
  assert.ok(local.includes("--allow-unauthenticated-loopback") && local.includes("Linux"));
  assert.ok(security.includes("native macOS/Windows") && security.includes("port mappings"));
});

test("companion skill is self-contained, discoverable, and permission-neutral", () => {
  const directory = fileURLToPath(new URL("../.agents/skills/mindleak-memory/", import.meta.url));
  const skill = readFileSync(join(directory, "SKILL.md"), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---\n/.exec(skill)?.[1];
  assert.ok(frontmatter, "the skill requires first-line YAML frontmatter");
  assert.match(frontmatter, /^name: mindleak-memory$/m);
  const description = JSON.parse(/^description: (".*")$/m.exec(frontmatter)?.[1] ?? "null");
  assert.ok(typeof description === "string" && description.length <= 1024 && description.includes("agents"));
  assert.match(frontmatter, /version: "1\.5\.0"/);
  assert.doesNotMatch(frontmatter, /^(?:allowed-tools|hooks|context|agent|model):/m);
  assert.doesNotMatch(skill, /^!`|^```!/m);
  assert.ok(skill.split("\n").length < 250, "keep the on-demand workflow compact");
  assert.ok(skill.includes("./references/agent-policy.md"));
  assert.ok(skill.includes("./references/tool-recipes.json"));
  assert.deepEqual(checkDocs(directory), [], "the installed bundle cannot depend on external repository files");
  for (const term of ["untrusted", "requestId", "nextCursor", "supersedes", "sessionId", "agentId", "scope"]) {
    assert.ok(skill.includes(term), `missing workflow boundary: ${term}`);
  }
  const recipes = JSON.parse(readFileSync(join(directory, "references/tool-recipes.json"), "utf8"));
  assert.equal(recipes.schemaVersion, 1);
  assert.equal(recipes.skillVersion, "1.5.0");
  for (const term of ["formation", "principle", "requiresReview", "counterEvidenceReviewed", "supportedBy"]) assert.ok(skill.includes(term));
  assert.equal(recipes.minimumServerVersion, "0.4.0");
  assert.match(recipes.learningAvailability, /^Available from 0\.7\.0:.*advertised/);
  assert.deepEqual(Object.keys(recipes.learningCalls).sort(), ["capabilities", "compact_search"]);
  assert.deepEqual(recipes.learningCalls.capabilities.arguments, {knowledge: {operation: "capabilities"}});
  assert.deepEqual(recipes.learningCalls.compact_search.arguments, {
    knowledge: {operation: "search", query: "$QUERY", view: "compact"}, scope: "$SCOPE", limit: 5,
  });
  for (const recipe of Object.values(recipes.learningCalls)) assert.equal(recipe.name, "recall_memory");
  assert.deepEqual(Object.keys(recipes.captureCalls).sort(), ["general", "project"]);
  for (const [mode, recipe] of Object.entries(recipes.captureCalls)) {
    assert.equal(recipe.name, "write_memory");
    assert.deepEqual(recipe.arguments, {
      agentId: "$AGENT_ID", requestId: "$REQUEST_ID", text: "$FACT_TEXT",
      context: {...(mode === "project" ? {scope: "$SCOPE"} : {}), sessionId: "$SESSION_ID", source: "$SOURCE", summary: "$RETRIEVAL_CUES"},
    });
  }
  for (const term of ["Evidence Checkpoints", "before handoff", "captureCalls.project", "retrieval cues", "No quota"]) {
    assert.ok(skill.includes(term), `missing checkpoint boundary: ${term}`);
  }
  assert.ok(skill.includes("General recall searches across all scopes"));
  assert.ok(skill.includes("Two unscoped facts may be linked"));
  for (const recipe of Object.values(recipes.generalCalls)) {
    assert.equal(recipe.arguments.scope, undefined, "general recall must not set a project filter");
    assert.equal(recipe.arguments.context?.scope, undefined, "general writes must not create a synthetic scope");
    if (recipe.name === "recall_memory") assert.equal(recipe.arguments.agentId, undefined);
    if (recipe.name === "write_memory") {
      assert.equal(recipe.arguments.agentId, "$AGENT_ID");
      assert.equal(recipe.arguments.requestId, "$REQUEST_ID");
      assert.equal(recipe.arguments.context.sessionId, "$SESSION_ID");
    }
  }
  for (const recipe of Object.values(recipes.calls)) {
    assert.ok(["write_memory", "recall_memory", "decompose_memory"].includes(recipe.name));
    assert.ok(recipe.arguments && typeof recipe.arguments === "object");
    if (recipe.name === "write_memory") {
      assert.equal(recipe.arguments.requestId, "$REQUEST_ID");
      assert.equal(recipe.arguments.context.scope, "$SCOPE");
    }
    if (recipe.name === "recall_memory") {
      assert.equal(recipe.arguments.scope, "$SCOPE");
      assert.equal(recipe.arguments.agentId, undefined, "shared examples must not hide other agents");
    }
  }
});

test("memory activation closes the capture and reuse loop without requiring note quotas", () => {
  const directory = fileURLToPath(new URL("../.agents/skills/mindleak-memory/", import.meta.url));
  const policy = readFileSync(join(directory, "references/agent-policy.md"), "utf8");
  const skill = readFileSync(join(directory, "SKILL.md"), "utf8");
  for (const phrase of ["Evidence Checkpoints", "verified result, failure, exception, or decision", "new reusable evidence", "no new learning", "Record later application outcomes"]) {
    assert.ok(policy.includes(phrase), `missing memory activation trigger: ${phrase}`);
  }
  for (const phrase of ["Inspect chains and source observations as needed", "Capture At Evidence Checkpoints", "applicability", "revision", "resend that exact request with the same ID", "No quota", "acknowledged IDs or an unresolved write", "keep memory frozen until paired arms finish"]) {
    assert.ok(skill.includes(phrase), `missing concrete memory practice: ${phrase}`);
  }
  for (const phrase of ["observations", "Chains of Memory", "Principles", "Use applicable principles", "Validate before accepting", "Repeated runs alone"]) {
    assert.ok(policy.includes(phrase), `missing task-start knowledge orientation: ${phrase}`);
  }
  for (const phrase of ["Before nontrivial work", "make one focused recall_memory search", "active retrieval mode", "one focused refinement"]) {
    assert.ok(policy.includes(phrase), `missing measured recall guidance: ${phrase}`);
  }
  assert.ok(!policy.includes("Memory use is optional"), "approved prior-knowledge checks must not be optional at task start");
  assert.ok(!skill.includes("Memory use is optional"));
  assert.ok(policy.includes("explicitly chosen general mode"));
  assert.ok(policy.includes("Recall alone is not confirmation"));
  assert.ok(policy.includes("Respect tool approvals"));
});

test("agent instructions and onboarding use the same companion activation policy", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const policy = readFileSync(join(root, ".agents/skills/mindleak-memory/references/agent-policy.md"), "utf8");
  const block = /```text\n([\s\S]*?)\n```/.exec(policy)?.[1];
  assert.ok(block);
  for (const concept of ["knowledge formation", "observations", "Chains of Memory", "Principles", "Validate before accepting", "counterevidence", "no new learning"]) {
    assert.ok(block.includes(concept), `missing knowledge workflow: ${concept}`);
  }
  for (const file of ["README.md", "docs/INTEGRATION.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(text.includes(`\x60\x60\x60text\n${block}\n\x60\x60\x60`), `${file} has a stale activation policy`);
    assert.ok(text.includes(".agents/skills/mindleak-memory/SKILL.md"));
  }
  for (const file of ["AGENTS.md", ".github/copilot-instructions.md", "CLAUDE.md"]) {
    const text = readFileSync(join(root, file), "utf8");
    assert.ok(text.includes(".agents/skills/mindleak-memory/SKILL.md"), `${file} must route to the canonical workflow`);
    assert.ok(text.includes(".agents/skills/mindleak-memory/references/agent-policy.md"));
  }
  const guide = readFileSync(join(root, "docs/INSTALL.md"), "utf8");
  for (const location of [".agents/skills/mindleak-memory/", ".claude/skills/mindleak-memory/", ".github/copilot-instructions.md", "CLAUDE.md", "AGENTS.md"]) {
    assert.ok(guide.includes(location), `missing client installation location: ${location}`);
  }
  assert.ok(guide.includes("already-published v0.4.0"));
});

test("architecture diagrams cover the integrated write and recall contracts", () => {
  const architecture = readFileSync(new URL("../docs/ARCHITECTURE.md", import.meta.url), "utf8");
  const source = readFileSync(new URL("../assets/architecture.excalidraw", import.meta.url), "utf8");
  const scene = JSON.parse(source);
  assert.equal(scene.type, "excalidraw");
  assert.equal(scene.version, 2);
  assert.ok(architecture.includes("../assets/architecture.excalidraw"));
  assert.ok(!architecture.includes("```mermaid"));
  const elements = new Map(scene.elements.map((element) => [element.id, element]));
  assert.equal(elements.size, scene.elements.length, "Excalidraw element IDs must be unique");
  assert.equal(scene.elements.filter((element) => element.type === "frame").length, 4);
  for (const [name, terms] of [
    ["overview", ["MemoryService", "MemoryStore", "MemoryRetriever", "PostgreSQL", "memories", "fragments", "relationships", "source inspection"]],
    ["write", ["requestId", "committed receipt", "Rollback", "lifecycle"]],
    ["recall", ["rankingPriority", "bounded related context", "32 KiB", "512 KiB", "relationshipCountExact", "rawText", "nextCursor", "useful negatives"]],
    ["lifecycle", ["Active", "Archived", "Superseded", "confirmation", "not truth"]],
  ]) {
    const frameId = `architecture-${name}`;
    assert.equal(elements.get(frameId)?.type, "frame", `missing ${name} frame`);
    const members = scene.elements.filter((element) => element.frameId === frameId);
    const labels = members.filter((element) => element.type === "text").map((element) => element.text).join("\n");
    for (const term of terms) assert.ok(labels.includes(term), `${name} must explain ${term}`);
    for (const label of members.filter((element) => element.type === "text" && element.containerId)) {
      const container = elements.get(label.containerId);
      if (container.type === "arrow") continue;
      assert.equal(label.textAlign, "center");
      assert.equal(label.verticalAlign, "middle");
      assert.ok(Math.abs(label.x + label.width / 2 - container.x - container.width / 2) < 0.1,
        `${label.containerId} label must be horizontally centred`);
      assert.ok(Math.abs(label.y + label.height / 2 - container.y - container.height / 2) < 0.1,
        `${label.containerId} label must be vertically centred`);
      assert.ok(label.width <= container.width - 16 && label.height <= container.height - 10,
        `${label.containerId} label needs padding`);
    }
    const arrows = members.filter((element) => element.type === "arrow");
    assert.ok(arrows.length > 0, `${name} must contain editable connections`);
    for (const arrow of arrows) {
      for (const binding of [arrow.startBinding, arrow.endBinding]) {
        assert.equal(elements.get(binding?.elementId)?.frameId, frameId, `${arrow.id} must connect within its frame`);
      }
    }
    const preview = `architecture-${name}.svg`;
    assert.ok(architecture.includes(`../assets/${preview}`), `missing ${name} preview`);
    const svg = readFileSync(new URL(`../assets/${preview}`, import.meta.url), "utf8");
    assert.match(svg, /svg-source:excalidraw/);
    assert.doesNotMatch(svg, /<(?:script|foreignObject)\b/);
    const payload = /<!-- payload-start -->(.*?)<!-- payload-end -->/s.exec(svg)?.[1];
    assert.ok(payload, `${name} SVG must include its editable scene`);
    const encoded = JSON.parse(Buffer.from(payload, "base64").toString("latin1"));
    assert.equal(encoded.encoding, "bstring");
    assert.equal(encoded.compressed, true);
    const embedded = JSON.parse(inflateSync(Buffer.from(encoded.encoded, "latin1")).toString("utf8"));
    const exported = embedded.elements.filter((element) => element.frameId === frameId);
    assert.equal(exported.length, members.length, `re-export stale ${name} preview`);
    for (const actual of exported) {
      const expected = elements.get(actual.id);
      assert.ok(expected, `${actual.id} is missing from the editable board`);
      for (const field of ["type", "frameId", "text", "fontSize", "fontFamily", "textAlign", "verticalAlign", "containerId", "strokeColor", "backgroundColor"]) {
        assert.equal(actual[field], expected[field], `re-export ${name}: ${actual.id}.${field} differs`);
      }
      if (actual.type === "arrow") {
        assert.equal(actual.startBinding?.elementId, expected.startBinding?.elementId);
        assert.equal(actual.endBinding?.elementId, expected.endBinding?.elementId);
      } else {
        for (const field of ["x", "y", "width", "height"]) {
          assert.equal(actual[field], expected[field], `re-export ${name}: ${actual.id}.${field} differs`);
        }
      }
    }
  }
  assert.match(architecture, /persistence\.rs.*receipt lookup\/replay/);
});

for (const operation of ["write_memory", "recall_memory"]) {
  test(`agent example budgets ${operation} for sequential model requests`, (context) => {
    const directory = fixture(context);
    const sdk = join(directory, "node_modules", "@modelcontextprotocol", "sdk");
    mkdirSync(sdk, { recursive: true });
    writeFileSync(join(sdk, "package.json"), JSON.stringify({
      type: "module",
      exports: {
        "./client/index.js": "./client.js",
        "./client/streamableHttp.js": "./transport.js",
      },
    }));
    writeFileSync(join(sdk, "transport.js"), "export class StreamableHTTPClientTransport {}\n");
    writeFileSync(join(sdk, "client.js"), `
      import assert from "node:assert/strict";
      export class Client {
        async connect() {}
        async listTools() {
          return { tools: ["write_memory", "recall_memory", "decompose_memory"].map(name => ({ name })) };
        }
        async callTool(request, schema, options) {
          if (request.name === ${JSON.stringify(operation)}) {
            assert.equal(options?.timeout, 660000, request.name + " must allow the server request budget");
          }
          if (request.name === "write_memory") {
            this.agentId = request.arguments.agentId;
            return { structuredContent: { memoryId: "test-memory" } };
          }
          assert.equal(request.name, "recall_memory");
          assert.equal(request.arguments.agentId, this.agentId);
          return { structuredContent: { results: [{ memoryId: "test-memory" }] } };
        }
        async close() { console.log("Mock MCP client closed."); }
      }
    `);
    const example = join(directory, "agent-memory.mjs");
    writeFileSync(example, readFileSync(new URL("../examples/agent-memory.mjs", import.meta.url)));
    const output = execFileSync(process.execPath, [example], {
      cwd: directory,
      env: {
        ...process.env,
        NODE_OPTIONS: "",
        MINDLEAK_MCP_URL: "http://127.0.0.1:8088/mcp",
        MINDLEAK_HTTP_TOKEN: "example-test-token",
        MINDLEAK_AGENT_ID: "example-test-agent",
      },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
    });
    assert.match(output, /Connected: 3 memory tools available\./);
    assert.match(output, /Saved memory: test-memory/);
    assert.match(output, /Recall verified: 1 matching fragment\(s\)\./);
    assert.match(output, /Mock MCP client closed\./);
  });
}

test("local Markdown links are checked but URLs and code samples are excluded", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "target.md"), "# Target\n");
  writeFileSync(join(directory, "README.md"), "[Target](target.md#heading)\n[Web](https://example.com)\n```md\n[Example](not-a-file.md)\n```\n");
  assert.deepEqual(checkDocs(directory), []);
  writeFileSync(join(directory, "bad.md"), "[Missing](missing.md)\n");
  assert.match(checkDocs(directory)[0], /missing.md/);
});

test("release metadata requires matching versions and consumed fragments", () => {
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-16\n\n### Added\n- Memory tools.\n";
  assert.equal(releaseNotes(changelog, "0.1.0", "v0.1.0", 0), "### Added\n- Memory tools.");
  assert.throws(() => releaseNotes(changelog, "0.1.0", "v0.2.0", 0), /tag/);
  assert.throws(() => releaseNotes(changelog, "0.1.0", "v0.1.0", 1), /fragments/);
  assert.throws(() => releaseNotes("## [Unreleased]\n", "0.1.0", "v0.1.0", 0), /dated/);
});

test("release packaging includes a pluggable binary, installation guide, branding, and checksums", (context) => {
  const directory = fixture(context);
  const target = "x86_64-unknown-linux-gnu";
  const release = join(directory, "target", target, "release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "mindleak-light"), "test executable\n");
  for (const name of ["README.md", "LICENSE", "SECURITY.md", "RATIONALE.md"]) writeFileSync(join(directory, name), name);
  const branding = [
    "mindleak_logo.png", "mindleak_128x128.png", "architecture.excalidraw",
    "architecture-overview.svg", "architecture-write.svg", "architecture-recall.svg",
    "architecture-lifecycle.svg",
  ];
  mkdirSync(join(directory, "assets"));
  for (const name of branding) writeFileSync(join(directory, "assets", name), `test image: ${name}\n`);
  mkdirSync(join(directory, "docs"));
  const guides = ["INSTALL.md", "INTEGRATION.md", "MODELS.md", "LIFECYCLE.md", "ARCHITECTURE.md", "LOCAL.md", "BACKUP.md", "DOMAIN-RELATIONSHIPS.md", "MIGRATIONS.md", "CHAINS.md",
    "VALIDATION.md", "BENCHMARKS.md", "BENCHMARK-RESULTS.md", "KNOWN-LIMITATIONS.md", "REVIEW-STATUS.md"];
  for (const name of guides) {
    writeFileSync(join(directory, "docs", name), `# ${name}\n`);
  }
  const backupRecords = ["adr.d/0021-encrypted-administrative-backups.md", "gaps.d/backup-platform-acceptance.md", "adr.d/0024-knowledge-formation-product.md"];
  for (const name of backupRecords) {
    mkdirSync(dirname(join(directory, name)), { recursive: true });
    writeFileSync(join(directory, name), `# ${name}\n`);
  }
  const skillDirectory = ".agents/skills/mindleak-memory";
  const skillFiles = ["SKILL.md", "references/agent-policy.md", "references/tool-recipes.json"];
  mkdirSync(join(directory, skillDirectory, "references"), { recursive: true });
  for (const name of skillFiles) {
    writeFileSync(join(directory, skillDirectory, name), `test skill resource: ${name}\n`);
  }
  const archive = packageBinary(directory, target, "0.1.0");
  const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(contents, /mindleak-light/);
  assert.match(contents, /LICENSE/);
  assert.ok(contents.includes("RATIONALE.md"), "native users need the product thesis alongside setup");
  assert.deepEqual(execFileSync("tar", ["-xOf", archive, "./RATIONALE.md"]), readFileSync(join(directory, "RATIONALE.md")));
  for (const name of branding) {
    assert.ok(contents.includes(`assets/${name}`), `release archive is missing ${name}`);
    const packaged = execFileSync("tar", ["-xOf", archive, `./assets/${name}`]);
    assert.deepEqual(packaged, readFileSync(join(directory, "assets", name)));
  }
  for (const name of guides) {
    assert.ok(contents.includes(`docs/${name}`), `release archive is missing ${name}`);
  }
  for (const name of backupRecords) {
    assert.ok(contents.includes(name), `release archive is missing ${name}`);
  }
  for (const name of skillFiles) {
    assert.ok(contents.includes(`${skillDirectory}/${name}`), `release archive is missing the companion skill ${name}`);
    assert.deepEqual(execFileSync("tar", ["-xOf", archive, `./${skillDirectory}/${name}`]),
      readFileSync(join(directory, skillDirectory, name)));
  }
  const mcp = JSON.parse(execFileSync("tar", ["-xOf", archive, "./mcp.example.json"], { encoding: "utf8" }));
  assert.equal(mcp.mcpServers["mindleak-light-local"].command, "mindleak-light");
  assert.deepEqual(mcp.mcpServers["mindleak-light-local"].args, ["local", "connect", "--container", "mindleak-light"]);
  assert.equal(mcp.mcpServers["mindleak-light-local"].env, undefined);
  const vscode = JSON.parse(execFileSync("tar", ["-xOf", archive, "./mcp.vscode.example.json"], { encoding: "utf8" }));
  assert.deepEqual(vscode.servers["mindleak-light-local"], { type: "stdio", ...mcp.mcpServers["mindleak-light-local"] });
  const postgres = JSON.parse(execFileSync("tar", ["-xOf", archive, "./mcp.postgres.example.json"], { encoding: "utf8" }));
  assert.ok(postgres.mcpServers["mindleak-light"].env.MINDLEAK_DATABASE_URL);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.ok(readFileSync(`${archive}.sha256`, "utf8").startsWith(`${digest}  mindleak-light-0.1.0-`));
  assert.throws(() => packageBinary(directory, "../../invalid", "0.1.0"), /unsupported/);
  const windowsTarget = "x86_64-pc-windows-msvc";
  const windowsRelease = join(directory, "target", windowsTarget, "release");
  mkdirSync(windowsRelease, { recursive: true });
  writeFileSync(join(windowsRelease, "mindleak-light.exe"), "test executable\n");
  const windowsArchive = packageBinary(directory, windowsTarget, "0.1.0");
  const windowsConfig = JSON.parse(execFileSync("tar", ["-xOf", windowsArchive, "./mcp.example.json"], { encoding: "utf8" }));
  assert.equal(windowsConfig.mcpServers["mindleak-light-local"].command, "mindleak-light.exe");
});
