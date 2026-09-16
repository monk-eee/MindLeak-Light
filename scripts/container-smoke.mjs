import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const root = fileURLToPath(new URL("../", import.meta.url));
const engine = process.env.CONTAINER_ENGINE ?? "docker";
assert.ok(["docker", "podman"].includes(engine), "CONTAINER_ENGINE must be docker or podman");
const image = process.env.MINDLEAK_IMAGE;
assert.ok(image, "Set MINDLEAK_IMAGE to a locally built all-in-one image");
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

function snapshot() {
  return JSON.parse(compose("exec", "-T", "mindleak-light", "psql", "-X", "-U", "mindleak_light", "-d", database, "-tAc",
    "SELECT json_build_object(" +
    "'memories', (SELECT count(*) FROM public.memories), " +
    "'fragments', (SELECT count(*) FROM public.fragments), " +
    "'vectors', (SELECT count(*) FROM public.fragments WHERE embedding IS NOT NULL), " +
    "'tables', (SELECT count(*) FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE'), " +
    "'listen', current_setting('listen_addresses'), 'fsync', current_setting('fsync'))"));
}

const [imageInfo] = JSON.parse(run(["image", "inspect", image]));
const healthcheck = engine === "podman" ? imageInfo.Healthcheck : imageInfo.Config.Healthcheck;
assert.ok(healthcheck?.Test?.length, "Image has no health check; Podman builds need --format docker");
assert.match(run(["run", "--rm", "--network", "none", image, "--version"]), /^mindleak-light \d+\.\d+\.\d+/);
assert.match(run(["run", "--rm", "--network", "none", "--entrypoint", "cat", image, "/usr/share/doc/mindleak-light/LICENSE"]), /MIT License/);
const refused = spawnSync(engine, ["run", "--rm", "--network", "none", image], { encoding: "utf8", timeout: 30_000 });
assert.equal(refused.status, 64, "Container must refuse to start without an HTTP token");
assert.match(refused.stderr, /Set MINDLEAK_HTTP_TOKEN/);

try {
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

  compose("down");
  compose("up", "--detach", "--wait", "--wait-timeout", "120");
  assert.deepEqual(snapshot(), saved, "Recreating the container lost persisted memory");
  console.log("All-in-one image: auth, MCP write/recall, socket-only Postgres, and volume persistence verified.");
} catch (error) {
  console.error(compose("logs", "--no-color", "--tail", "80"));
  throw error;
} finally {
  compose("down", "--volumes");
}
