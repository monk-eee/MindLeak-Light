import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { inflateSync } from "node:zlib";
import test from "node:test";
import { readAdrs, updateIndex } from "./adr-index.mjs";
import { readFragments, releaseChangelog, render } from "./changelog.mjs";
import { checkDocs } from "./check-docs.mjs";
import { packageBinary, releaseNotes } from "./release.mjs";
import { captureBenchmark, regressionPlan, runRegression } from "./regression-check.mjs";
import { cleanupProjects } from "./container-projects.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "mindleak-light-records-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

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
  assert.deepEqual(regressionPlan(environment, { profile: "load" }).workloads, [{ concurrency: 1, passes: 3 }, { concurrency: 4, passes: 3 }]);
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

test("release regression failure preserves incomplete evidence without connecting to a database", async (context) => {
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

test("benchmark deadlines terminate children that ignore graceful shutdown", () => {
  const result = captureBenchmark(["-e", `
    process.on("SIGTERM", () => {});
    process.stdout.write("fixture started");
    setTimeout(() => process.exit(0), 2500);
  `], { timeout: 1000, env: { ...process.env, NODE_OPTIONS: "" } });
  assert.match(result.stdout, /fixture started/);
  assert.equal(result.error?.code, "ETIMEDOUT");
  assert.equal(result.signal, "SIGKILL", "deadline must not wait for a child that ignores SIGTERM");
});

test("required CI includes release comparisons and a fresh-volume restore with retained evidence", () => {
  const read = path => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");
  const workflow = read(".github/workflows/ci.yml");
  const integration = workflow.slice(workflow.indexOf("  postgres:"), workflow.indexOf("  hygiene:"));
  assert.match(integration, /name: Postgres and MCP Integration/);
  assert.match(integration, /scripts\/regression-check\.mjs --candidate target\/release\/mindleak-light/);
  assert.match(integration, /MINDLEAK_BASELINE_DATABASE_URL:/);
  assert.match(integration, /if: always\(\)[\s\S]*actions\/upload-artifact/);
  const container = workflow.slice(workflow.indexOf("  all-in-one:"));
  assert.match(container, /regression-baseline\.json/);
  assert.match(container, /shell: bash[\s\S]*container-smoke\.mjs --restore/);
  assert.match(container, /scripts\/container-smoke\.mjs --restore/);
  assert.match(container, /if: always\(\)[\s\S]*baseline-restore/);
  const load = read(".github/workflows/regression-load.yml");
  assert.match(load, /workflow_dispatch:/);
  assert.ok(!load.includes("pull_request:"));
  assert.match(load, /--profile load/);
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
  const configurations = [...readme.matchAll(/```json\n([\s\S]*?)\n```/g)].map((match) => JSON.parse(match[1]));
  const editor = JSON.parse(readFileSync(join(root, ".vscode/mcp.json"), "utf8"));
  assert.deepEqual(configurations.find((config) => config.servers), editor);
  assert.equal(editor.servers["mindleak-light"].type, "http");
  const defaults = parseEnv(readFileSync(join(root, ".env.example"), "utf8"));
  assert.equal(defaults.MINDLEAK_DECOMPOSITION, "sentences");
  assert.equal(defaults.MINDLEAK_RETRIEVAL, "keyword");
  assert.equal(defaults.MINDLEAK_RELEVANCE, "off");
  assert.equal(defaults.MINDLEAK_MODEL, undefined);
  assert.equal(defaults.MINDLEAK_EMBED_MODEL, undefined);
  assert.equal(defaults.MINDLEAK_RELEVANCE_MODEL, undefined);
});

test("README points directly to a versioned standalone Docker Hub container", () => {
  const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
  const containerStart = readme.indexOf("\n## Standalone Container\n");
  const sourceStart = readme.indexOf("\n## Quickstart\n");
  assert.ok(containerStart > 0 && sourceStart > containerStart,
    "the standalone container must be discoverable before the source build");
  const section = readme.slice(containerStart, sourceStart);
  assert.ok(section.includes("https://hub.docker.com/r/monkeemagic/mindleak-light"));
  assert.match(section, /docker run[^\n]*monkeemagic\/mindleak-light:\d+\.\d+\.\d+/);
  assert.ok(section.includes("127.0.0.1:8088:8088"));
  assert.ok(section.includes("mindleak-light-data:/var/lib/postgresql/data"));
  assert.ok(section.includes("MINDLEAK_HTTP_TOKEN="));
  assert.ok(section.includes("http://127.0.0.1:8088/mcp"));
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
  for (const name of ["README.md", "LICENSE", "SECURITY.md"]) writeFileSync(join(directory, name), name);
  const branding = [
    "mindleak_logo.png", "mindleak_128x128.png", "architecture.excalidraw",
    "architecture-overview.svg", "architecture-write.svg", "architecture-recall.svg",
    "architecture-lifecycle.svg",
  ];
  mkdirSync(join(directory, "assets"));
  for (const name of branding) writeFileSync(join(directory, "assets", name), `test image: ${name}\n`);
  mkdirSync(join(directory, "docs"));
  const guides = ["INSTALL.md", "INTEGRATION.md", "MODELS.md", "LIFECYCLE.md", "ARCHITECTURE.md"];
  for (const name of guides) {
    writeFileSync(join(directory, "docs", name), `# ${name}\n`);
  }
  const archive = packageBinary(directory, target, "0.1.0");
  const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(contents, /mindleak-light/);
  assert.match(contents, /LICENSE/);
  for (const name of branding) {
    assert.ok(contents.includes(`assets/${name}`), `release archive is missing ${name}`);
    const packaged = execFileSync("tar", ["-xOf", archive, `./assets/${name}`]);
    assert.deepEqual(packaged, readFileSync(join(directory, "assets", name)));
  }
  for (const name of guides) {
    assert.ok(contents.includes(`docs/${name}`), `release archive is missing ${name}`);
  }
  const mcp = JSON.parse(execFileSync("tar", ["-xOf", archive, "./mcp.example.json"], { encoding: "utf8" }));
  assert.equal(mcp.mcpServers["mindleak-light"].command, "mindleak-light");
  assert.deepEqual(mcp.mcpServers["mindleak-light"].args, ["--transport", "stdio"]);
  assert.ok(mcp.mcpServers["mindleak-light"].env.MINDLEAK_DATABASE_URL);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.ok(readFileSync(`${archive}.sha256`, "utf8").startsWith(`${digest}  mindleak-light-0.1.0-`));
  assert.throws(() => packageBinary(directory, "../../invalid", "0.1.0"), /unsupported/);
  const windowsTarget = "x86_64-pc-windows-msvc";
  const windowsRelease = join(directory, "target", windowsTarget, "release");
  mkdirSync(windowsRelease, { recursive: true });
  writeFileSync(join(windowsRelease, "mindleak-light.exe"), "test executable\n");
  const windowsArchive = packageBinary(directory, windowsTarget, "0.1.0");
  const windowsConfig = JSON.parse(execFileSync("tar", ["-xOf", windowsArchive, "./mcp.example.json"], { encoding: "utf8" }));
  assert.equal(windowsConfig.mcpServers["mindleak-light"].command, "mindleak-light.exe");
});
