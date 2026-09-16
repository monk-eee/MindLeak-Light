import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

function validateLimit(limit) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
    throw new Error("Recall limit must be an integer in 1..50.");
  }
}

export function scoreRanking(rankedIds, relevantIds, limit) {
  validateLimit(limit);
  for (const identifiers of [rankedIds, relevantIds]) {
    if (!Array.isArray(identifiers) || identifiers.some((identifier) => typeof identifier !== "string" || !identifier.trim())) {
      throw new Error("Rankings and relevance labels must contain nonempty IDs.");
    }
  }
  const ranking = rankedIds.slice(0, limit);
  const relevant = new Set(relevantIds);
  if (!relevant.size) {
    return {
      returned: ranking.length,
      relevantRetrieved: 0,
      precisionAtK: null,
      recallAtK: null,
      reciprocalRankAtK: null,
      ndcgAtK: null,
      hitAtK: null,
      noAnswerCorrect: ranking.length === 0,
    };
  }

  const credited = new Set();
  let reciprocalRank = 0;
  let discountedGain = 0;
  for (const [index, identifier] of ranking.entries()) {
    if (!relevant.has(identifier) || credited.has(identifier)) continue;
    credited.add(identifier);
    if (!reciprocalRank) reciprocalRank = 1 / (index + 1);
    discountedGain += 1 / Math.log2(index + 2);
  }
  let idealGain = 0;
  for (let index = 0; index < Math.min(relevant.size, limit); index += 1) {
    idealGain += 1 / Math.log2(index + 2);
  }
  return {
    returned: ranking.length,
    relevantRetrieved: credited.size,
    precisionAtK: credited.size / limit,
    recallAtK: credited.size / relevant.size,
    reciprocalRankAtK: reciprocalRank,
    ndcgAtK: discountedGain / idealGain,
    hitAtK: Number(credited.size > 0),
    noAnswerCorrect: null,
  };
}

export function summarizeQueries(results) {
  const answerable = results.filter((result) => result.recallAtK !== null);
  const unanswerable = results.filter((result) => result.noAnswerCorrect !== null);
  const mean = (items, field) => items.length
    ? items.reduce((total, item) => total + Number(item[field]), 0) / items.length
    : null;
  return {
    queries: results.length,
    answerableQueries: answerable.length,
    unanswerableQueries: unanswerable.length,
    precisionAtK: mean(answerable, "precisionAtK"),
    recallAtK: mean(answerable, "recallAtK"),
    mrrAtK: mean(answerable, "reciprocalRankAtK"),
    ndcgAtK: mean(answerable, "ndcgAtK"),
    hitRateAtK: mean(answerable, "hitAtK"),
    noAnswerAccuracy: mean(unanswerable, "noAnswerCorrect"),
  };
}

export function validateDataset(dataset) {
  const identifier = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value);
  const text = (value) => typeof value === "string" && value.trim() && Buffer.byteLength(value, "utf8") <= 32768;
  if (dataset?.schemaVersion !== 1 || !identifier(dataset.id)) {
    throw new Error("Dataset needs schemaVersion 1 and a short identifier.");
  }
  for (const field of ["memories", "queries"]) {
    if (!Array.isArray(dataset[field]) || !dataset[field].length) {
      throw new Error(`Dataset ${field} must be a nonempty array.`);
    }
    const identifiers = new Set();
    for (const entry of dataset[field]) {
      if (!identifier(entry?.id) || identifiers.has(entry.id)) {
        throw new Error(`Dataset ${field} must have unique, valid IDs.`);
      }
      identifiers.add(entry.id);
    }
  }
  const memories = new Set(dataset.memories.map((memory) => memory.id));
  if (dataset.memories.some((memory) => !text(memory.text))) {
    throw new Error("Memory text must be nonempty and at most 32768 UTF-8 bytes.");
  }
  for (const query of dataset.queries) {
    if (!text(query.query) || !identifier(query.category)) {
      throw new Error("Queries need nonempty text and a valid category.");
    }
    if (!Array.isArray(query.relevantIds)
      || new Set(query.relevantIds).size !== query.relevantIds.length
      || query.relevantIds.some((identifier) => !memories.has(identifier))) {
      throw new Error("Relevance labels must be unique IDs from the corpus; use [] for unanswerable queries.");
    }
  }
  return dataset;
}

export async function runBenchmark(client, dataset, { limit = 5, agentId = `recall-benchmark-${randomUUID()}` } = {}) {
  validateDataset(dataset);
  validateLimit(limit);
  if (typeof agentId !== "string" || !agentId.trim() || Buffer.byteLength(agentId, "utf8") > 256) {
    throw new Error("Benchmark agent ID must be nonempty and at most 256 UTF-8 bytes.");
  }
  const call = async (name, args) => {
    let response;
    try {
      response = await client.callTool({ name, arguments: args }, undefined, { timeout: 610000 });
    } catch {
      throw new Error(`MCP ${name} failed; no benchmark report was produced.`);
    }
    if (response?.isError || !response?.structuredContent) {
      throw new Error(`MCP ${name} failed or returned no structured content.`);
    }
    return response.structuredContent;
  };

  const memoryIds = new Map();
  for (const memory of dataset.memories) {
    const written = await call("write_memory", { agentId, text: memory.text });
    if (typeof written.memoryId !== "string" || !written.memoryId.trim() || memoryIds.has(written.memoryId)) {
      throw new Error("Memory writes must return distinct, nonempty IDs.");
    }
    memoryIds.set(written.memoryId, memory.id);
  }

  const queries = [];
  for (const query of dataset.queries) {
    const response = await call("recall_memory", { query: query.query, agentId, limit });
    if (!Array.isArray(response.results) || response.results.length > limit) {
      throw new Error("Recall returned a malformed or oversized ranking.");
    }
    const fragments = new Set();
    const rankedIds = response.results.map((result) => {
      if (!result || result.agentId !== agentId || !memoryIds.has(result.memoryId)) {
        throw new Error("Recall returned a memory outside this benchmark run.");
      }
      if (typeof result.fragmentId !== "string" || !result.fragmentId.trim()
        || fragments.has(result.fragmentId) || !Number.isFinite(result.score)) {
        throw new Error("Recall returned malformed or duplicate fragments.");
      }
      fragments.add(result.fragmentId);
      return memoryIds.get(result.memoryId);
    });
    queries.push({
      id: query.id,
      category: query.category,
      relevantIds: query.relevantIds,
      rankedIds,
      missedIds: query.relevantIds.filter((identifier) => !rankedIds.includes(identifier)),
      ...scoreRanking(rankedIds, query.relevantIds, limit),
    });
  }
  const categories = [...new Set(queries.map((query) => query.category))];
  return {
    agentId,
    limit,
    summary: summarizeQueries(queries),
    byCategory: Object.fromEntries(categories.map((category) => [
      category, summarizeQueries(queries.filter((query) => query.category === category)),
    ])),
    queries,
  };
}

export function benchmarkSettings(environment, options = {}) {
  const databaseUrl = environment.MINDLEAK_TEST_DATABASE_URL;
  let database;
  let databaseName;
  try {
    database = new URL(databaseUrl);
    databaseName = decodeURIComponent(database.pathname.slice(1));
  } catch {
    throw new Error("Set MINDLEAK_TEST_DATABASE_URL to a disposable PostgreSQL database ending in _test.");
  }
  if (!["postgres:", "postgresql:"].includes(database.protocol) || !database.hostname
    || !/^[a-z0-9_-]+_test$/i.test(databaseName) || database.hash
    || [...database.searchParams.keys()].some((key) => !["sslmode", "connect_timeout"].includes(key))) {
    throw new Error("Benchmark database must end in _test; URL parameters may only set sslmode or connect_timeout.");
  }
  const limit = Number(options.k ?? 5);
  validateLimit(limit);
  const decomposition = options.decomposition ?? "sentences";
  const retrieval = options.retrieval ?? "keyword";
  if (!["sentences", "openai"].includes(decomposition) || !["keyword", "vector"].includes(retrieval)) {
    throw new Error("Choose --decomposition sentences|openai and --retrieval keyword|vector.");
  }
  const label = options.label ?? `${decomposition}-${retrieval}`;
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(label)) {
    throw new Error("Benchmark label must be a short identifier.");
  }
  const minimumRecall = options["min-recall"] === undefined ? null : Number(options["min-recall"]);
  if (minimumRecall !== null && (typeof options["min-recall"] !== "string" || !options["min-recall"].trim()
    || !Number.isFinite(minimumRecall) || minimumRecall < 0 || minimumRecall > 1)) {
    throw new Error("--min-recall must be a number in 0..1.");
  }
  const timeout = Number(environment.MINDLEAK_MODEL_TIMEOUT_SECS ?? 60);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("MINDLEAK_MODEL_TIMEOUT_SECS must be an integer in 1..300.");
  }
  const serverEnvironment = {
    MINDLEAK_DATABASE_URL: databaseUrl,
    MINDLEAK_DECOMPOSITION: decomposition,
    MINDLEAK_RETRIEVAL: retrieval,
    MINDLEAK_DB_POOL_SIZE: "8",
    MINDLEAK_MODEL_TIMEOUT_SECS: String(timeout),
  };
  for (const key of ["MINDLEAK_DATABASE_CA_FILE", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"]) {
    if (environment[key]) serverEnvironment[key] = environment[key];
  }
  const provider = (urlKey, modelKey, apiKey) => {
    let endpoint;
    try {
      endpoint = new URL(environment[urlKey]);
    } catch {
      throw new Error(`Set ${urlKey} explicitly for the enabled model mode.`);
    }
    if (!["http:", "https:"].includes(endpoint.protocol) || !endpoint.hostname
      || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
      throw new Error(`${urlKey} must be HTTP(S), without credentials, query, or fragment.`);
    }
    if (typeof environment[modelKey] !== "string" || !environment[modelKey].trim()) {
      throw new Error(`Set ${modelKey} explicitly for the enabled model mode.`);
    }
    serverEnvironment[urlKey] = environment[urlKey];
    serverEnvironment[modelKey] = environment[modelKey];
    serverEnvironment[apiKey] = environment[apiKey] ?? "";
    return environment[modelKey];
  };
  const decompositionModel = decomposition === "openai"
    ? provider("MINDLEAK_LLM_URL", "MINDLEAK_MODEL", "MINDLEAK_LLM_API_KEY")
    : null;
  let embeddingModel = null;
  let embeddingDimensions = null;
  if (retrieval === "vector") {
    embeddingModel = provider("MINDLEAK_EMBED_URL", "MINDLEAK_EMBED_MODEL", "MINDLEAK_EMBED_API_KEY");
    embeddingDimensions = Number(environment.MINDLEAK_EMBED_DIMENSIONS);
    if (!Number.isInteger(embeddingDimensions) || embeddingDimensions < 1 || embeddingDimensions > 2000) {
      throw new Error("MINDLEAK_EMBED_DIMENSIONS must be an integer in 1..2000.");
    }
    serverEnvironment.MINDLEAK_EMBED_DIMENSIONS = String(embeddingDimensions);
  }
  return {
    limit,
    minimumRecall,
    serverEnvironment,
    configuration: { label, decomposition, retrieval, decompositionModel, embeddingModel, embeddingDimensions, modelTimeoutSecs: timeout },
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        dataset: { type: "string" },
        binary: { type: "string" },
        k: { type: "string" },
        decomposition: { type: "string" },
        retrieval: { type: "string" },
        label: { type: "string" },
        "min-recall": { type: "string" },
      },
    }));
  } catch {
    throw new Error("Invalid benchmark options; use --help.");
  }
  if (values.help) {
    console.log(`Usage: node examples/benchmark-recall.mjs [options]

Requires MINDLEAK_TEST_DATABASE_URL naming a disposable *_test database.
Starts its own stdio server; does not use the running HTTP server or workspace .env.
Writes namespaced benchmark records which remain until the database is cleaned up.

  --dataset PATH              Labelled JSON corpus (default: fixtures/recall-v1.json)
  --binary PATH               Native server executable (default: target/debug/mindleak-light)
  --k NUMBER                  Ranking cutoff, 1..50 (default: 5)
  --decomposition MODE        sentences (default) or openai
  --retrieval MODE            keyword (default) or vector
  --label NAME                Identifier recorded in the report
  --min-recall NUMBER         Exit nonzero if macro Recall@k is below this value

Enabled model modes require their MINDLEAK_* provider variables explicitly.
JSON reports go to stdout; progress and errors go to stderr. See docs/BENCHMARKS.md.`);
    return;
  }

  const settings = benchmarkSettings(process.env, values);
  const corpusPath = values.dataset ?? new URL("./fixtures/recall-v1.json", import.meta.url);
  const corpusSource = await readFile(corpusPath);
  let dataset;
  try {
    dataset = JSON.parse(corpusSource.toString("utf8"));
  } catch {
    throw new Error("Cannot parse benchmark dataset JSON.");
  }
  validateDataset(dataset);
  const root = fileURLToPath(new URL("../", import.meta.url));
  const binary = resolve(values.binary ?? join(root, "target", "debug", `mindleak-light${process.platform === "win32" ? ".exe" : ""}`));
  let binaryDigest;
  try {
    binaryDigest = createHash("sha256").update(await readFile(binary)).digest("hex");
  } catch {
    throw new Error("Cannot read the server executable; run cargo build --workspace --locked or set --binary.");
  }
  let Client;
  let StdioClientTransport;
  try {
    ({ Client } = await import("@modelcontextprotocol/sdk/client/index.js"));
    ({ StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js"));
  } catch {
    throw new Error("Install benchmark client dependencies with npm ci --prefix examples.");
  }
  const directory = await mkdtemp(join(tmpdir(), "mindleak-recall-"));
  const client = new Client({ name: "mindleak-light-recall-benchmark", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: binary,
    args: ["--transport", "stdio"],
    cwd: directory,
    env: settings.serverEnvironment,
    stderr: "ignore",
  });
  let report;
  try {
    await writeFile(join(directory, ".env"), "");
    try {
      await client.connect(transport, { timeout: 30000 });
    } catch {
      throw new Error("Could not start the benchmark MCP server; check the binary and explicit test database settings.");
    }
    const agentId = `recall-benchmark-${randomUUID()}`;
    console.error(`Benchmark ${settings.configuration.label}: ${dataset.memories.length} memories, ${dataset.queries.length} queries; namespace ${agentId}.`);
    const result = await runBenchmark(client, dataset, { limit: settings.limit, agentId });
    report = {
      reportVersion: 1,
      createdAt: new Date().toISOString(),
      dataset: {
        id: dataset.id,
        sha256: createHash("sha256").update(corpusSource).digest("hex"),
        memories: dataset.memories.length,
        queries: dataset.queries.length,
      },
      server: client.getServerVersion(),
      binarySha256: binaryDigest,
      configuration: settings.configuration,
      ...result,
    };
  } finally {
    try {
      await client.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
  console.log(JSON.stringify(report, null, 2));
  if (settings.minimumRecall !== null
    && (report.summary.recallAtK === null || report.summary.recallAtK < settings.minimumRecall)) {
    console.error(`Recall@${settings.limit} did not meet --min-recall ${settings.minimumRecall}.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
