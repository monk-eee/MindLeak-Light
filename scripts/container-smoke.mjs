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

function lifecycleRecords() {
  return JSON.parse(sql(`SELECT json_build_object(
    'memories', (SELECT json_agg(saved ORDER BY id) FROM (
      SELECT id, context FROM public.memories) AS saved),
    'fragments', (SELECT json_agg(saved ORDER BY id) FROM (
      SELECT id, tier, state, evidence, pinned, useful_sessions, confirmed_sessions,
        reinforced_at, first_evidence_at FROM public.fragments) AS saved),
    'relationships', (SELECT json_agg(saved ORDER BY source_fragment, target_fragment, relationship_type) FROM (
      SELECT source_fragment, target_fragment, relationship_type, evidence_session
      FROM public.relationships) AS saved))`));
}

async function recallPersisted(endpoint, memoryId, retryRequest, expectedRaw) {
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
    const original = recalled.structuredContent?.results?.find((result) => result.memoryId === memoryId);
    assert.ok(original, "The upgraded server cannot recall the original memory");
    assert.ok(Number.isFinite(original.rankingPriority), "Recall has no finite rankingPriority");
    assert.equal(original.rankingPriority,
      original.score - Math.abs(original.score) * 0.25 * (1 - original.activation));
    assert.equal(original.relationshipCountExact, true, "The small fixture must have an exact link count");
    assert.equal(original.relationshipsTruncated,
      original.relationshipCount > original.relationships.length);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(),
      ["decompose_memory", "recall_memory", "write_memory"]);
    assert.ok(tools.tools.find((tool) => tool.name === "write_memory").inputSchema.properties.requestId,
      "The candidate does not advertise retry-safe writes");
    assert.ok(tools.tools.find((tool) => tool.name === "recall_memory").inputSchema.properties.fragmentId,
      "The candidate does not advertise source inspection");
    const inspected = await client.callTool({
      name: "recall_memory", arguments: { fragmentId: original.fragmentId, agentId: project },
    });
    assert.ok(!inspected.isError, "Source inspection failed after upgrade or restart");
    assert.equal(inspected.structuredContent?.memoryId, memoryId);
    assert.equal(inspected.structuredContent?.rawText, expectedRaw);
    assert.equal(inspected.structuredContent?.fragmentId, original.fragmentId);
    assert.ok(inspected.structuredContent.scannedRelationships <= 128);
    assert.equal(sql("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname IN ('relationships_incoming_context_idx', 'relationships_outgoing_context_idx')"), "2");
    const written = await client.callTool({ name: "write_memory", arguments: retryRequest });
    assert.ok(!written.isError, "Keyed write or replay failed");
    assert.equal(typeof written.structuredContent?.memoryId, "string");
    assert.equal(written.structuredContent.fragments.length, 1);
    return written.structuredContent;
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

  const hadLifecycle = sql(`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.memories'::regclass AND attname = 'context' AND NOT attisdropped)`) === "t";
  if (upgradeFrom) {
    sql(`BEGIN;
      ALTER TABLE public.fragments ALTER COLUMN embedding TYPE vector(2);
      UPDATE public.fragments SET embedding = '[1,0]'::vector;
      COMMENT ON TABLE public.fragments IS '{"model":"container-upgrade-fixture","dimensions":2}';
      INSERT INTO public.relationships (source_fragment, target_fragment, relationship_type)
        SELECT source.id, target.id, 'related' FROM public.fragments AS source
        JOIN public.fragments AS target ON source.id < target.id;
      COMMIT;`);
    if (hadLifecycle) {
      sql(`BEGIN;
        UPDATE public.memories SET context = '{"scope":"container-upgrade","sessionId":"legacy-feedback","source":"published-image fixture","summary":"Preserve existing lifecycle state"}'::jsonb;
        UPDATE public.fragments SET tier = 'long_term', evidence = 'confirmed',
          pinned = position('reviews' IN text) > 0,
          state = CASE WHEN position('reviews' IN text) > 0 THEN 'active' ELSE 'archived' END,
          useful_sessions = 3, confirmed_sessions = 2,
          reinforced_at = now() - interval '1 day', first_evidence_at = now() - interval '3 days';
        COMMIT;`);
    }
  }
  const before = persistedRecords();
  const lifecycleBefore = hadLifecycle ? lifecycleRecords() : null;
  const counts = snapshot();
  compose("down");
  env.MINDLEAK_IMAGE = image;
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(snapshot(), counts, "Recreating the container lost persisted memory");
  assert.deepEqual(persistedRecords(), before, "Upgrade changed original records or embedding metadata");
  if (lifecycleBefore) {
    assert.deepEqual(lifecycleRecords(), lifecycleBefore,
      "Upgrade changed existing context, retention, archival, or feedback metadata");
  } else if (upgradeFrom) {
    assert.equal(sql("SELECT count(*) FROM public.memories WHERE context = '{}'::jsonb"), "1");
    assert.equal(sql("SELECT count(*) FROM public.fragments WHERE tier = 'short_term' AND state = 'active' AND evidence = 'unconfirmed'"), "2");
  }
  const retryRequest = {
    agentId: project,
    requestId: randomUUID(),
    text: "Retry-safe writes survive container recreation.",
  };
  const receipt = await recallPersisted(
    `http://${compose("port", "mindleak-light", "8088")}`, before.memories[0].id, retryRequest, before.memories[0].raw_text);
  if (upgradeFrom) {
    console.log("Published-image upgrade: exact records, vectors, links, model metadata, existing lifecycle or legacy defaults, and MCP recall verified.");
  }
  const keyedCounts = snapshot();
  const keyedRecords = persistedRecords();
  const keyedLifecycle = lifecycleRecords();
  compose("down");
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(await recallPersisted(
    `http://${compose("port", "mindleak-light", "8088")}`, before.memories[0].id, retryRequest, before.memories[0].raw_text),
  receipt, "Replaying after container recreation changed the committed receipt");
  assert.deepEqual(snapshot(), keyedCounts, "A keyed retry created extra rows");
  assert.deepEqual(persistedRecords(), keyedRecords, "A keyed retry changed persisted data");
  assert.deepEqual(lifecycleRecords(), keyedLifecycle, "A keyed retry changed lifecycle metadata");
  console.log("Integrated contracts: bounded evidence indexes, exact source inspection, ranking metadata and keyed replay after recreation verified.");
  console.log("All-in-one image: auth, MCP write/recall, socket-only Postgres, and volume persistence verified.");
} catch (error) {
  console.error(compose("logs", "--no-color", "--tail", "80"));
  throw error;
} finally {
  compose("down", "--volumes");
}
