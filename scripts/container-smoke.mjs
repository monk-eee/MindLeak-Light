import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: { "config-only": { type: "boolean" } } });
const root = fileURLToPath(new URL("../", import.meta.url));
const engine = process.env.CONTAINER_ENGINE ?? "docker";
assert.ok(["docker", "podman"].includes(engine), "CONTAINER_ENGINE must be docker or podman");
const image = process.env.MINDLEAK_IMAGE;
assert.ok(image, "Set MINDLEAK_IMAGE to a locally built all-in-one image");
const upgradeFrom = process.env.MINDLEAK_UPGRADE_FROM;
const project = `mindleak-light-smoke-${randomUUID()}`;
const token = "mindleak-light-container-test-token";
const database = "mindleak_light_test";
const env = {
  ...process.env,
  MINDLEAK_IMAGE: image,
  MINDLEAK_HTTP_PORT: "0",
  MINDLEAK_HTTP_TOKEN: token,
  MINDLEAK_DECOMPOSITION: "sentences",
  MINDLEAK_RETRIEVAL: "keyword",
  MINDLEAK_RELEVANCE: "off",
  POSTGRES_DB: database,
};

function run(args, options = {}) {
  return execFileSync(engine, args, {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    timeout: 180_000, ...options,
  }).trim();
}

function compose(...args) {
  return run(["compose", "--project-name", project, "--file", "docker/compose.all-in-one.yml", ...args]);
}

function sql(query) {
  return compose("exec", "-T", "mindleak-light", "psql", "-X", "-v", "ON_ERROR_STOP=1", "-U", "mindleak_light", "-d", database, "-tAc", query);
}

function snapshot() {
  return JSON.parse(sql(
    "SELECT json_build_object(" +
    "'memories', (SELECT count(*) FROM public.memories), " +
    "'fragments', (SELECT count(*) FROM public.fragments), " +
    "'vectors', (SELECT count(*) FROM public.fragments WHERE embedding IS NOT NULL), " +
    "'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'), " +
    "'listen', current_setting('listen_addresses'), 'fsync', current_setting('fsync'))"));
}

function persistedRecords() {
  return JSON.parse(sql(`SELECT json_build_object(
    'memories', (SELECT json_agg(saved ORDER BY id) FROM (
      SELECT id, agent_id, created_at, raw_text FROM public.memories) AS saved),
    'fragments', (SELECT json_agg(saved ORDER BY id) FROM (
      SELECT id, memory_id, text, embedding::text, importance FROM public.fragments) AS saved),
    'relationships', (SELECT json_agg(saved ORDER BY source_fragment, target_fragment, relationship_type) FROM (
      SELECT source_fragment, target_fragment, relationship_type FROM public.relationships) AS saved),
    'embedding_type', (SELECT format_type(atttypid, atttypmod) FROM pg_attribute
      WHERE attrelid = 'public.fragments'::regclass AND attname = 'embedding'),
    'embedding_model', obj_description('public.fragments'::regclass, 'pg_class'))`));
}

async function recallPersisted(endpoint, memoryId) {
  const require = createRequire(new URL("../examples/package.json", import.meta.url));
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "mindleak-upgrade-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    const recalled = await client.callTool({
      name: "recall_memory", arguments: { query: "reviews", agentId: project, limit: 5 },
    });
    assert.ok(!recalled.isError, "Recall failed after upgrade");
    assert.ok(recalled.structuredContent?.results?.some((result) => result.memoryId === memoryId),
      "The upgraded server cannot recall the original memory");
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
      ["decompose_memory", "recall_memory", "write_memory"]);
  } finally {
    await client.close();
  }
}

const directory = mkdtempSync(join(tmpdir(), "mindleak-light-compose-"));
try {
  const envFile = join(directory, ".env");
  const defaults = {
    MINDLEAK_RECALL_MIN_SIMILARITY: "-1",
    MINDLEAK_RELEVANCE: "off",
    MINDLEAK_RELEVANCE_URL: "",
    MINDLEAK_RELEVANCE_MODEL: "",
    MINDLEAK_RELEVANCE_API_KEY: "",
    MINDLEAK_RELEVANCE_CANDIDATES: "20",
  };
  const relevance = {
    MINDLEAK_RELEVANCE: "openai",
    MINDLEAK_RELEVANCE_URL: "http://relevance.example/v1",
    MINDLEAK_RELEVANCE_MODEL: "test-relevance-model",
    MINDLEAK_RELEVANCE_API_KEY: "test-relevance-key",
    MINDLEAK_RELEVANCE_CANDIDATES: "12",
  };
  for (const [file, service] of [
    ["docker-compose.yml", "mcp"],
    ["docker/compose.all-in-one.yml", "mindleak-light"],
  ]) {
    for (const [fileValues, overrides, expected] of [
      [{}, {}, {}],
      [{ MINDLEAK_RECALL_MIN_SIMILARITY: "0.8" }, {}, { MINDLEAK_RECALL_MIN_SIMILARITY: "0.8" }],
      [{ MINDLEAK_RECALL_MIN_SIMILARITY: "" }, {}, {}],
      [{ MINDLEAK_RECALL_MIN_SIMILARITY: "0.8" }, { MINDLEAK_RECALL_MIN_SIMILARITY: "0" }, { MINDLEAK_RECALL_MIN_SIMILARITY: "0" }],
      [relevance, {}, relevance],
      [{ MINDLEAK_RELEVANCE: "", MINDLEAK_RELEVANCE_CANDIDATES: "" }, {}, {}],
      [relevance, { MINDLEAK_RELEVANCE: "off", MINDLEAK_RELEVANCE_CANDIDATES: "7" },
        { ...relevance, MINDLEAK_RELEVANCE: "off", MINDLEAK_RELEVANCE_CANDIDATES: "7" }],
    ]) {
      writeFileSync(envFile, Object.entries(fileValues).map(([key, value]) => `${key}=${value}`).join("\n") + "\n");
      const configurationEnvironment = { ...env };
      for (const key of Object.keys(defaults)) delete configurationEnvironment[key];
      Object.assign(configurationEnvironment, overrides);
      const configuration = JSON.parse(run([
        "compose", "--env-file", envFile, "--project-name", project,
        "--file", file, "config", "--format", "json",
      ], { env: configurationEnvironment }));
      const environment = configuration.services[service].environment;
      for (const [key, expectedValue] of Object.entries({ ...defaults, ...expected })) {
        assert.equal(environment[key], expectedValue, `${file}: ${key} must preserve defaults and explicit settings`);
      }
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
console.log("Both Compose templates: similarity and relevance defaults, .env values, and shell overrides verified.");
if (values["config-only"]) process.exit(0);

const [imageInfo] = JSON.parse(run(["image", "inspect", image]));
const healthcheck = engine === "podman" ? imageInfo.Healthcheck : imageInfo.Config.Healthcheck;
assert.ok(healthcheck?.Test?.length, "Image has no health check; Podman builds need --format docker");
assert.match(run(["run", "--rm", "--network", "none", image, "--version"]), /^mindleak-light \d+\.\d+\.\d+/);
assert.match(run(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/usr/share/doc/mindleak-light/LICENSE"]), /MIT License/);
const refused = spawnSync(engine, ["run", "--rm", "--network", "none", image], { encoding: "utf8", timeout: 30_000 });
assert.equal(refused.status, 64, "Container must refuse to start without an HTTP token");
assert.match(refused.stderr, /Set MINDLEAK_HTTP_TOKEN/);

try {
  if (upgradeFrom) env.MINDLEAK_IMAGE = upgradeFrom;
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  const address = compose("port", "mindleak-light", "8088");
  const endpoint = `http://${address}`;
  assert.equal((await fetch(`${endpoint}/health`, { signal: AbortSignal.timeout(5000) })).status, 401);
  assert.equal((await fetch(`${endpoint}/health`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(5000),
  })).status, 200);
  assert.deepEqual(snapshot(), { memories: 0, fragments: 0, vectors: 0, tables: 3, listen: "", fsync: "on" });

  const output = execFileSync(process.execPath, [join(root, "examples/agent-memory.mjs")], {
    cwd: root,
    env: { ...env, MINDLEAK_MCP_URL: `${endpoint}/mcp`, MINDLEAK_AGENT_ID: project },
    encoding: "utf8", timeout: 30_000,
  });
  assert.match(output, /Recall verified:/);
  const saved = snapshot();
  assert.deepEqual(saved, { memories: 1, fragments: 2, vectors: 0, tables: 3, listen: "", fsync: "on" });

  if (upgradeFrom) {
    sql(`BEGIN;
      ALTER TABLE public.fragments ALTER COLUMN embedding TYPE vector(2);
      UPDATE public.fragments SET embedding = '[1,0]'::vector;
      COMMENT ON TABLE public.fragments IS '{"model":"container-upgrade-fixture","dimensions":2}';
      INSERT INTO public.relationships (source_fragment, target_fragment, relationship_type)
        SELECT source.id, target.id, 'related' FROM public.fragments AS source
        JOIN public.fragments AS target ON source.id < target.id;
      COMMIT;`);
  }
  const before = persistedRecords();
  const counts = snapshot();
  compose("down");
  env.MINDLEAK_IMAGE = image;
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(snapshot(), counts, "Recreating the container lost persisted memory");
  assert.deepEqual(persistedRecords(), before, "Upgrade changed original records or embedding metadata");
  await recallPersisted(`http://${compose("port", "mindleak-light", "8088")}`, before.memories[0].id);
  if (upgradeFrom) {
    assert.equal(sql("SELECT count(*) FROM public.memories WHERE context = '{}'::jsonb"), "1");
    assert.equal(sql("SELECT count(*) FROM public.fragments WHERE tier = 'short_term' AND state = 'active' AND evidence = 'unconfirmed'"), "2");
    console.log("Published-image upgrade: exact raw text, IDs, vectors, links, model metadata, lifecycle defaults, and MCP recall verified.");
  }
  console.log("All-in-one image: auth, MCP write/recall, socket-only Postgres, and volume persistence verified.");
} catch (error) {
  console.error(compose("logs", "--no-color", "--tail", "80"));
  throw error;
} finally {
  compose("down", "--volumes");
}
