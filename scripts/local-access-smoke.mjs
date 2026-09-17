import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const require = createRequire(new URL("../examples/package.json", import.meta.url));
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
const engine = process.env.CONTAINER_ENGINE ?? "docker";
assert.ok(["docker", "podman"].includes(engine), "Choose docker or podman");
const binary = resolve(process.env.MINDLEAK_BINARY ?? `target/debug/mindleak-light${process.platform === "win32" ? ".exe" : ""}`);
const identity = randomUUID();
const container = `mindleak-local-${identity}`;
const volume = `${container}-data`;
const database = `mindleak_local_${identity.replaceAll("-", "")}_test`;
const workspace = mkdtempSync(join(tmpdir(), "mindleak-local-workspace-"));
const secondWorkspace = mkdtempSync(join(tmpdir(), "mindleak-local-other-"));
const target = ["--engine", engine, "--container", container];
const report = {
  launcherSha256: createHash("sha256").update(readFileSync(binary)).digest("hex"),
  engine, checks: [],
};
let bridge;
let primaryFailure;

function run(args) {
  try {
    return execFileSync(engine, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 }).trim();
  } catch {
    throw new Error(`Container test operation failed: ${args[0]}`);
  }
}

function launcher(args, extraEnv = {}) {
  return spawnSync(binary, ["local", ...args], {
    env: { ...process.env, ...extraEnv }, cwd: workspace, encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"], timeout: 330_000, maxBuffer: 128 * 1024,
  });
}

function succeeds(result, phase) {
  assert.equal(result.status, 0, `${phase} failed (diagnostics withheld)`);
  assert.ok(!result.error, `${phase} could not execute`);
}

function fails(result, diagnostic) {
  assert.ok(result.status !== 0 && !result.error, "Expected a completed, rejected operation");
  assert.equal(result.stdout, "", "Failure must leave stdout empty");
  assert.ok(result.stderr.includes(diagnostic), "Expected actionable diagnostic was absent");
  assert.ok(!result.stderr.includes(rawText), "Memory text leaked into diagnostics");
}

function check(name) { report.checks.push(name); console.log(`local access: ${name}`); }

async function withClient(transport, action) {
  const client = new Client({ name: "mindleak-local-onboarding-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ["decompose_memory", "recall_memory", "write_memory"]);
    report.mcpServerVersion = client.getServerVersion();
    return await action(client);
  } finally {
    await client.close();
  }
}

function stdio(configuration) {
  return new StdioClientTransport({ command: configuration.command, args: configuration.args, stderr: "pipe" });
}

async function call(client, name, argumentsValue) {
  const result = await client.callTool({ name, arguments: argumentsValue }, undefined, { timeout: 60_000 });
  assert.ok(!result.isError && result.structuredContent, `${name} failed (content withheld)`);
  return result.structuredContent;
}

const rawText = `  LocalTrialBeacon ${identity} keeps the setup verification record.\n`;
const request = { text: rawText, agentId: container, requestId: identity, context: { scope: container } };
let receipt;

async function verifyMemory(client) {
  const recalled = await call(client, "recall_memory", { query: "LocalTrialBeacon", agentId: container, scope: container });
  assert.ok(recalled.results.some(result => result.memoryId === receipt.memoryId), "Existing memory was not recalled");
  const source = await call(client, "recall_memory", { fragmentId: receipt.fragments[0].fragmentId, agentId: container });
  assert.ok(source.rawText === rawText, "Exact original source was not preserved");
  const replayed = await call(client, "write_memory", request);
  assert.ok(JSON.stringify(replayed) === JSON.stringify(receipt), "Restart changed the original write receipt");
}

async function stopBridge() {
  if (!bridge || bridge.exitCode !== null) return;
  await new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => { bridge.kill("SIGKILL"); reject(new Error("HTTP bridge did not stop")); }, 10_000);
    bridge.once("exit", () => { clearTimeout(timer); resolveExit(); });
    bridge.kill("SIGINT");
  });
}

try {
  const setup = launcher(["setup", ...target, "--volume", volume, "--database", database, "--workspace", workspace,
    ...(process.env.MINDLEAK_IMAGE ? ["--image", process.env.MINDLEAK_IMAGE] : [])]);
  succeeds(setup, "Fresh setup");
  const configPath = join(workspace, ".vscode", "mcp.json");
  const configText = readFileSync(configPath, "utf8");
  const config = JSON.parse(configText).servers["mindleak-light-local"];
  assert.equal(config.type, "stdio");
  assert.ok(!configText.includes("Authorization") && !configText.includes("input:"), "Local config contains credentials");
  const details = JSON.parse(run(["container", "inspect", container]))[0];
  assert.equal(details.HostConfig.NetworkMode, "none");
  assert.equal(Object.keys(details.HostConfig.PortBindings ?? {}).length, 0);
  assert.equal(config.args[3], details.Id);
  const status = launcher(["status", ...target]);
  succeeds(status, "Status");
  report.runtime = JSON.parse(status.stdout);
  assert.equal(report.runtime.database, database);
  assert.equal(report.runtime.imageId, details.Image);
  const token = details.Config.Env.find(entry => entry.startsWith("MINDLEAK_HTTP_TOKEN=")).split("=")[1];
  assert.ok(token.length >= 32);
  assert.ok(!`${status.stdout}${status.stderr}${setup.stdout}${setup.stderr}${configText}`.includes(token), "Token leaked into diagnostics/config");
  if (process.env.MINDLEAK_IMAGE) {
    for (const listen of ["127.0.0.1:8090", "0.0.0.0:8090"]) {
      const refused = spawnSync(engine, ["run", "--rm", "--name", `${container}-exposure`,
        "--publish", "0.0.0.0::8090", "--entrypoint", "/usr/local/bin/mindleak-light",
        "--mount", `type=volume,source=${volume},target=/var/lib/postgresql/data,readonly`,
        details.Image, "local", "http", "--allow-unauthenticated-loopback", "--listen", listen],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 30_000, maxBuffer: 128 * 1024 });
      fails(refused, "never the Linux/container executable");
    }
    check("candidate container refuses HTTP opt-out even with a network-wide host port mapping");
  }
  await withClient(stdio(config), async client => {
    receipt = await call(client, "write_memory", request);
    await verifyMemory(client);
  });
  check("credential-free setup, three tools, write/recall and source inspection");

  run(["stop", "--time", "10", container]);
  await withClient(stdio(config), verifyMemory);
  succeeds(launcher(["configure", ...target, "--workspace", workspace]), "Reconfigure");
  assert.equal(readFileSync(configPath, "utf8"), configText);
  await withClient(stdio(config), verifyMemory);
  check("stopped-container restart and fresh client connections preserve the original data/config");

  fails(launcher(["connect", "--container", "missing"], { PATH: workspace, DOCKER_HOST: "", DOCKER_CONTEXT: "" }), "Install and start Docker Desktop");
  fails(launcher(["connect", "--container", "missing"], { DOCKER_HOST: "tcp://127.0.0.1:2375", DOCKER_CONTEXT: "" }), "refuses remote or TCP");
  fails(launcher(["connect", "--engine", engine, "--container", `${container}-missing`]), "No replacement was created");
  fails(launcher(["setup", "--engine", engine, "--container", `${container}-missing`, "--volume", volume]), "already pinned");
  fails(launcher(["setup", "--engine", engine, "--container", `${container}-missing`, "--volume", volume, "--workspace", secondWorkspace]), "volume already exists");
  check("missing engine/container, remote context and implicit volume replacement fail closed");

  fails(launcher(["http", ...target]), "requires --allow-unauthenticated-loopback");
  fails(launcher(["http", ...target, "--allow-unauthenticated-loopback", "--listen", "0.0.0.0:8090"]),
    process.platform === "linux" ? "never the Linux/container executable" : "requires a literal loopback");
  if (["darwin", "win32"].includes(process.platform)) {
    bridge = spawn(binary, ["local", "http", ...target, "--allow-unauthenticated-loopback", "--listen", "127.0.0.1:0"], { stdio: ["ignore", "pipe", "pipe"] });
    const endpoint = await new Promise((resolveEndpoint, reject) => {
      let diagnostic = "";
      const timer = setTimeout(() => reject(new Error("Local HTTP startup timed out")), 45_000);
      bridge.once("error", () => { clearTimeout(timer); reject(new Error("Cannot start local HTTP")); });
      bridge.once("exit", () => { clearTimeout(timer); reject(new Error("Local HTTP exited before readiness")); });
      bridge.stderr.on("data", chunk => {
        diagnostic += chunk.toString();
        const match = diagnostic.match(/Local-only HTTP: (http:\/\/127\.0\.0\.1:\d+\/mcp)/);
        if (match) { clearTimeout(timer); resolveEndpoint(match[1]); }
      });
    });
    await withClient(new StreamableHTTPClientTransport(new URL(endpoint)), verifyMemory);
    for (const headers of [
      { Origin: "https://example.invalid" }, { Host: "example.invalid" },
      { "X-Forwarded-For": "192.0.2.1" }, { Forwarded: "for=192.0.2.1" },
    ]) {
      const responseStatus = await new Promise((resolveStatus, reject) => {
        const request = httpRequest(endpoint, { headers, signal: AbortSignal.timeout(10_000) }, response => {
          response.resume();
          response.once("end", () => resolveStatus(response.statusCode));
        });
        request.once("error", reject);
        request.end();
      });
      assert.equal(responseStatus, 403, `The ${Object.keys(headers)[0]} guard did not reject the request`);
    }
    await stopBridge();
    check("host-only HTTP uses the same store and rejects browser/proxy/rebinding requests");
  } else {
    fails(launcher(["http", ...target, "--allow-unauthenticated-loopback"]), "never the Linux/container executable");
    check("Linux/container executable refuses unauthenticated HTTP regardless of port publishing");
  }

  run(["exec", container, "psql", "-X", "-U", "mindleak_light", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", `ALTER DATABASE ${database} ALLOW_CONNECTIONS false`]);
  fails(launcher(["connect", ...target]), "database is unavailable");
  run(["exec", container, "psql", "-X", "-U", "mindleak_light", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-Atc", `ALTER DATABASE ${database} ALLOW_CONNECTIONS true`]);
  await withClient(stdio(config), verifyMemory);
  assert.equal(run(["exec", container, "psql", "-X", "-U", "mindleak_light", "-d", database, "-Atc", "SELECT count(*) FROM public.memories"]), "1");
  check("unavailable database reports failure, then recovers without a replacement or duplicate write");
} catch (error) {
  primaryFailure = error;
} finally {
  const failures = primaryFailure ? [primaryFailure] : [];
  try { await stopBridge(); } catch (error) { failures.push(error); }
  const exposure = spawnSync(engine, ["container", "inspect", `${container}-exposure`], { stdio: "ignore", timeout: 10_000 });
  if (exposure.status === 0) {
    try { run(["rm", "--force", `${container}-exposure`]); } catch (error) { failures.push(error); }
  }
  for (const args of [["rm", "--force", container], ["volume", "rm", volume]]) {
    try { run(args); } catch (error) { failures.push(error); }
  }
  rmSync(workspace, { recursive: true, force: true });
  rmSync(secondWorkspace, { recursive: true, force: true });
  if (failures.length === 1) throw failures[0];
  if (failures.length) throw new AggregateError(failures, "Local smoke failed; original and cleanup errors are retained");
}
console.log(JSON.stringify({ ...report, passed: true }, null, 2));
