import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { cleanupProjects } from "./container-projects.mjs";

const { values } = parseArgs({ options: { "config-only": { type: "boolean" }, restore: { type: "boolean" } } });
const root = fileURLToPath(new URL("../", import.meta.url));
const engine = process.env.CONTAINER_ENGINE ?? "docker";
assert.ok(["docker", "podman"].includes(engine), "CONTAINER_ENGINE must be docker or podman");
const image = process.env.MINDLEAK_IMAGE;
assert.ok(image, "Set MINDLEAK_IMAGE to a locally built all-in-one image");
const upgradeFrom = process.env.MINDLEAK_UPGRADE_FROM;
const project = `mindleak-light-smoke-${randomUUID()}`;
let activeProject = project;
let composeFiles = ["docker/compose.all-in-one.yml"];
const ownedProjects = new Set([project]);
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
  const output = execFileSync(engine, args, {
    cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    timeout: 180_000, ...options,
  });
  return typeof output === "string" ? output.trim() : output;
}

function composeArguments(args) {
  return ["compose", "--project-name", activeProject, ...composeFiles.flatMap(file => ["--file", file]), ...args];
}

function compose(...args) {
  return run(composeArguments(args));
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

function requestReceipts() {
  return JSON.parse(sql(`SELECT COALESCE(json_agg(receipt ORDER BY id), '[]'::json)
    FROM (SELECT id, request_id, request_payload, write_result FROM public.memories
      WHERE request_id IS NOT NULL) AS receipt`));
}

async function withClient(endpoint, operation) {
  const require = createRequire(new URL("../examples/package.json", import.meta.url));
  const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = require("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const client = new Client({ name: "mindleak-upgrade-test", version: "1.0.0" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`${endpoint}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    }));
    return await operation(client);
  } finally {
    await client.close();
  }
}

async function writeReceipt(client, request) {
  const written = await client.callTool({ name: "write_memory", arguments: request });
  assert.ok(!written.isError, "Keyed write or replay failed");
  assert.equal(typeof written.structuredContent?.memoryId, "string");
  assert.equal(written.structuredContent.fragments.length, 1);
  return written.structuredContent;
}

async function recallPersisted(endpoint, memoryId, retryRequest, expectedRaw) {
  return withClient(endpoint, async (client) => {
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
    const searchSchema = tools.tools.find((tool) => tool.name === "recall_memory").inputSchema.properties;
    for (const control of ["matchMode", "diagnostics", "contextLimit", "groupDuplicates"]) {
      assert.ok(searchSchema[control], `The candidate does not advertise ${control}`);
    }
    const expanded = await client.callTool({
      name: "recall_memory",
      arguments: {
        query: original.context.source === "published-image fixture" ? "reviews fixture" : "reviews",
        agentId: project, limit: 5, matchMode: "all", diagnostics: true,
        contextLimit: 2, groupDuplicates: true, includeInactive: true,
      },
    });
    assert.ok(!expanded.isError, "Document recall controls failed after upgrade or restart");
    assert.ok(expanded.structuredContent?.diagnostics, "Requested search diagnostics are missing");
    const expandedOriginal = expanded.structuredContent.results.find((result) => result.memoryId === memoryId);
    assert.ok(expandedOriginal, "Combined fragment/metadata query lost the original memory");
    assert.equal(expandedOriginal.sourceCount, 1);
    assert.equal(expandedOriginal.relationshipCountExact, true);
    assert.equal(expandedOriginal.documentContext.orderKnown, true);
    assert.equal(expandedOriginal.documentContext.fragments.length, 1);
    assert.equal(expandedOriginal.documentContext.fragments[0].memoryId, memoryId);
    assert.notEqual(expandedOriginal.documentContext.fragments[0].fragmentId, expandedOriginal.fragmentId);
    assert.ok(Number.isInteger(expandedOriginal.documentContext.fragments[0].fragmentIndex));
    assert.equal(sql("SELECT count(*) FROM pg_indexes WHERE schemaname = 'public' AND indexname = 'fragments_document_search_idx'"), "1");
    assert.equal(sql("SELECT count(*) FROM public.fragments WHERE search_vector IS NULL"), "0");
    return writeReceipt(client, retryRequest);
  });
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

let smokeFailure;
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
  const originalMemory = persistedRecords().memories[0];
  const retryRequest = {
    agentId: project,
    requestId: randomUUID(),
    text: "Retry-safe writes survive container recreation.",
  };
  const hadReceipts = sql(`SELECT EXISTS(SELECT 1 FROM pg_attribute
    WHERE attrelid = 'public.memories'::regclass AND attname = 'request_id' AND NOT attisdropped)`) === "t";
  const legacyReceipt = upgradeFrom && hadReceipts
    ? await withClient(endpoint, (client) => writeReceipt(client, retryRequest)) : null;
  const receiptsBefore = hadReceipts ? requestReceipts() : null;
  const before = persistedRecords();
  const lifecycleBefore = hadLifecycle ? lifecycleRecords() : null;
  const counts = snapshot();
  const backup = values.restore ? run(composeArguments([
    "exec", "-T", "mindleak-light", "pg_dump", "--format=custom", "--no-owner", "--no-acl",
    "--username=mindleak_light", `--dbname=${database}`,
  ]), { encoding: "buffer", maxBuffer: 16 * 1024 * 1024 }) : null;
  if (backup) assert.equal(backup.subarray(0, 5).toString("ascii"), "PGDMP", "A real custom-format backup is required");
  compose("down");
  env.MINDLEAK_IMAGE = image;
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(snapshot(), counts, "Recreating the container lost persisted memory");
  assert.deepEqual(persistedRecords(), before, "Upgrade changed original records or embedding metadata");
  if (receiptsBefore) {
    assert.deepEqual(requestReceipts(), receiptsBefore, "Upgrade changed stored requests or receipts");
  }
  if (lifecycleBefore) {
    assert.deepEqual(lifecycleRecords(), lifecycleBefore,
      "Upgrade changed existing context, retention, archival, or feedback metadata");
  } else if (upgradeFrom) {
    assert.equal(sql("SELECT count(*) FROM public.memories WHERE context = '{}'::jsonb"), "1");
    assert.equal(sql("SELECT count(*) FROM public.fragments WHERE tier = 'short_term' AND state = 'active' AND evidence = 'unconfirmed'"), "2");
  }
  const receipt = await recallPersisted(
    `http://${compose("port", "mindleak-light", "8088")}`, originalMemory.id, retryRequest, originalMemory.raw_text);
  if (legacyReceipt) {
    assert.deepEqual(receipt, legacyReceipt, "Retrying a pre-upgrade request changed its original receipt");
    assert.deepEqual(snapshot(), counts, "Retrying a pre-upgrade request created extra rows");
    console.log("Pre-upgrade keyed request: original receipt replayed with unchanged row counts.");
  }
  if (upgradeFrom) {
    console.log("Published-image upgrade: exact records, vectors, links, model metadata, existing lifecycle or legacy defaults, and MCP recall verified.");
  }
  const keyedCounts = snapshot();
  const keyedRecords = persistedRecords();
  const keyedLifecycle = lifecycleRecords();
  const keyedReceipts = requestReceipts();
  compose("down");
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(await recallPersisted(
    `http://${compose("port", "mindleak-light", "8088")}`, originalMemory.id, retryRequest, originalMemory.raw_text),
  receipt, "Replaying after container recreation changed the committed receipt");
  assert.deepEqual(snapshot(), keyedCounts, "A keyed retry created extra rows");
  assert.deepEqual(persistedRecords(), keyedRecords, "A keyed retry changed persisted data");
  assert.deepEqual(lifecycleRecords(), keyedLifecycle, "A keyed retry changed lifecycle metadata");
  assert.deepEqual(requestReceipts(), keyedReceipts, "A keyed retry changed stored request receipts");
  if (backup) {
    const restoreDirectory = mkdtempSync(join(tmpdir(), "mindleak-restore-"));
    const override = join(restoreDirectory, "postgres-only.json");
    writeFileSync(override, JSON.stringify({ services: { "mindleak-light": {
      entrypoint: ["docker-entrypoint.sh"],
      command: ["postgres", "-c", "listen_addresses=", "-c", "unix_socket_directories=/var/run/postgresql",
        "-c", "log_statement=none", "-c", "log_min_error_statement=panic", "-c", "log_error_verbosity=terse"],
      environment: { POSTGRES_HOST_AUTH_METHOD: "trust" },
      healthcheck: { test: ["CMD-SHELL", `pg_isready -U mindleak_light -d ${database}`],
        interval: "2s", timeout: "3s", start_period: "0s", retries: 30 },
    } } }));
    activeProject = `${project}-restore`;
    ownedProjects.add(activeProject);
    composeFiles.push(override);
    try {
      compose("up", "--detach", "--wait", "--wait-timeout", "120");
      assert.equal(sql("SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'"),
        "0", "Restoration must start in a fresh volume without application tables");
      run(composeArguments(["exec", "-T", "mindleak-light", "pg_restore", "--exit-on-error",
        "--no-owner", "--no-acl", "--username=mindleak_light", `--dbname=${database}`]),
      { input: backup, stdio: ["pipe", "pipe", "inherit"] });
      assert.deepEqual(snapshot(), counts, "Restoring the backup changed counts or database settings");
      assert.deepEqual(persistedRecords(), before, "Restoration changed raw text, IDs, vectors, links or model binding");
      if (lifecycleBefore) assert.deepEqual(lifecycleRecords(), lifecycleBefore);
      if (receiptsBefore) assert.deepEqual(requestReceipts(), receiptsBefore);
      composeFiles = ["docker/compose.all-in-one.yml"];
      compose("up", "--detach", "--force-recreate", "--wait", "--wait-timeout", "120");
      assert.deepEqual(persistedRecords(), before, "Starting the candidate after restore changed original data");
      const restoredReceipt = await recallPersisted(
        `http://${compose("port", "mindleak-light", "8088")}`, originalMemory.id, retryRequest, originalMemory.raw_text);
      if (legacyReceipt) {
        assert.deepEqual(restoredReceipt, legacyReceipt, "Restored keyed write did not replay its original receipt");
        assert.deepEqual(snapshot(), counts, "Replaying a restored request created rows");
        assert.deepEqual(requestReceipts(), receiptsBefore);
      }
      if (lifecycleBefore && legacyReceipt) assert.deepEqual(lifecycleRecords(), lifecycleBefore);
      const freshRequest = {
        agentId: `${project}-fresh`, requestId: randomUUID(),
        text: "  FreshRestoreTextMarker persists a newly written episode.  ",
        context: { scope: activeProject, source: "FreshRestoreSourceMarker" },
      };
      const verifyFreshWrite = async expected => withClient(
        `http://${compose("port", "mindleak-light", "8088")}`, async client => {
          const written = await writeReceipt(client, freshRequest);
          assert.notEqual(written.memoryId, restoredReceipt.memoryId, "Fresh write must not replay the historical episode");
          if (expected) assert.deepEqual(written, expected, "New post-restore receipt changed after restart");
          const recalled = await client.callTool({
            name: "recall_memory", arguments: {
              query: "FreshRestoreTextMarker FreshRestoreSourceMarker", matchMode: "all",
              agentId: freshRequest.agentId, scope: freshRequest.context.scope, limit: 5,
            },
          });
          assert.ok(!recalled.isError, "Post-restore keyword search failed");
          const matches = recalled.structuredContent?.results;
          assert.equal(matches?.length, 1, "Fresh post-restore text and metadata must both be indexed");
          assert.equal(matches[0].memoryId, written.memoryId);
          assert.equal(matches[0].fragmentId, written.fragments[0].fragmentId);
          const inspected = await client.callTool({
            name: "recall_memory", arguments: {
              fragmentId: matches[0].fragmentId, agentId: freshRequest.agentId, scope: freshRequest.context.scope,
            },
          });
          assert.ok(!inspected.isError, "Fresh post-restore source inspection failed");
          assert.equal(inspected.structuredContent?.rawText, freshRequest.text);
          assert.equal(inspected.structuredContent?.context.source, freshRequest.context.source);
          return written;
        });
      const beforeFresh = snapshot();
      const freshReceipt = await verifyFreshWrite();
      assert.deepEqual(snapshot(), { ...beforeFresh, memories: beforeFresh.memories + 1, fragments: beforeFresh.fragments + 1 });
      const afterFresh = { counts: snapshot(), records: persistedRecords(), lifecycle: lifecycleRecords(), receipts: requestReceipts() };
      compose("down");
      compose("up", "--detach", "--wait", "--wait-timeout", "120");
      await verifyFreshWrite(freshReceipt);
      assert.deepEqual(snapshot(), afterFresh.counts, "Fresh post-restore retry created extra rows");
      assert.deepEqual(persistedRecords(), afterFresh.records, "Restart changed fresh or restored data");
      assert.deepEqual(lifecycleRecords(), afterFresh.lifecycle);
      assert.deepEqual(requestReceipts(), afterFresh.receipts);
      assert.equal(sql("SELECT count(*) FROM public.memories WHERE context->>'source' = 'FreshRestoreSourceMarker'"),
        "1", "Restoration must verify a fresh indexed write, not only replay an old receipt");
      console.log("Fresh restored write: text/metadata indexing, exact source, restart persistence and duplicate-free keyed replay verified.");
      console.log("Backup restoration: real pg_dump restored into a fresh volume; exact data, lifecycle, receipts and MCP source/document recall verified.");
    } finally {
      composeFiles = ["docker/compose.all-in-one.yml"];
      rmSync(restoreDirectory, { recursive: true, force: true });
    }
  }
  console.log("Integrated contracts: bounded evidence, exact source inspection, document search/context/grouping, ranking metadata and keyed replay verified.");
  console.log("All-in-one image: auth, MCP write/recall, socket-only Postgres, and volume persistence verified.");
} catch (error) {
  smokeFailure = error;
  try { console.error(compose("logs", "--no-color", "--tail", "80")); }
  catch { console.error("Container logs unavailable; preserving the original smoke-test failure."); }
} finally {
  cleanupProjects(ownedProjects, owned => {
    activeProject = owned;
    compose("down", "--volumes");
  }, smokeFailure);
}
