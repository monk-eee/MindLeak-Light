import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { benchmarkSettings, runBenchmark, scoreRanking, summarizeQueries, validateDataset } from "./benchmark-recall.mjs";

test("perfect rankings have unit precision, recall, reciprocal rank, and nDCG", () => {
  assert.deepEqual(scoreRanking(["alpha", "beta"], ["alpha", "beta"], 2), {
    returned: 2,
    relevantRetrieved: 2,
    precisionAtK: 1,
    recallAtK: 1,
    reciprocalRankAtK: 1,
    ndcgAtK: 1,
    hitAtK: 1,
    noAnswerCorrect: null,
  });
});

test("cutoffs, missing relevant memories, and rank discounts are applied", () => {
  const result = scoreRanking(["distractor", "beta", "alpha"], ["alpha", "beta", "gamma"], 2);
  assert.equal(result.returned, 2);
  assert.equal(result.precisionAtK, 0.5);
  assert.equal(result.recallAtK, 1 / 3);
  assert.equal(result.reciprocalRankAtK, 0.5);
  const discount = 1 / Math.log2(3);
  assert.equal(result.ndcgAtK, discount / (1 + discount));
});

test("duplicate fragments earn credit once and still occupy result slots", () => {
  const result = scoreRanking(["alpha", "alpha", "beta"], ["alpha", "beta"], 3);
  assert.equal(result.relevantRetrieved, 2);
  assert.equal(result.precisionAtK, 2 / 3);
  assert.equal(result.recallAtK, 1);
  assert.equal(result.ndcgAtK, 1.5 / (1 + 1 / Math.log2(3)));
  assert.equal(scoreRanking(["alpha", "alpha", "beta"], ["alpha", "beta"], 2).recallAtK, 0.5);
});

test("short rankings do not change the precision denominator and misses score zero", () => {
  assert.equal(scoreRanking(["alpha"], ["alpha"], 5).precisionAtK, 0.2);
  for (const ranking of [[], ["distractor"]]) {
    const result = scoreRanking(ranking, ["alpha"], 5);
    for (const field of ["precisionAtK", "recallAtK", "reciprocalRankAtK", "ndcgAtK", "hitAtK"]) {
      assert.equal(result[field], 0);
    }
  }
});

test("unanswerable queries measure abstention separately from ranking quality", () => {
  for (const ranking of [[], ["distractor"]]) {
    const result = scoreRanking(ranking, [], 5);
    assert.equal(result.noAnswerCorrect, ranking.length === 0);
    for (const field of ["precisionAtK", "recallAtK", "reciprocalRankAtK", "ndcgAtK", "hitAtK"]) {
      assert.equal(result[field], null);
    }
  }
});

test("invalid limits and malformed rankings are rejected", () => {
  for (const limit of [0, 51, 1.5, NaN, "5"]) {
    assert.throws(() => scoreRanking([], [], limit), /1\.\.50/);
  }
  for (const identifiers of [null, "alpha", [null], [" "]]) {
    assert.throws(() => scoreRanking(identifiers, [], 5), /IDs/);
    assert.throws(() => scoreRanking([], identifiers, 5), /IDs/);
  }
});

test("macro averages give each query equal weight and exclude unanswerable queries", () => {
  assert.deepEqual(summarizeQueries([
    scoreRanking(["alpha"], ["alpha"], 1),
    scoreRanking([], ["alpha", "beta"], 1),
    scoreRanking([], [], 1),
    scoreRanking(["distractor"], [], 1),
  ]), {
    queries: 4,
    answerableQueries: 2,
    unanswerableQueries: 2,
    precisionAtK: 0.5,
    recallAtK: 0.5,
    mrrAtK: 0.5,
    ndcgAtK: 0.5,
    hitRateAtK: 0.5,
    noAnswerAccuracy: 0.5,
  });
});

test("empty metric populations are reported as null rather than perfect scores", () => {
  const empty = summarizeQueries([]);
  assert.equal(empty.queries, 0);
  assert.equal(empty.recallAtK, null);
  assert.equal(empty.noAnswerAccuracy, null);
  const negativeOnly = summarizeQueries([scoreRanking([], [], 5)]);
  assert.equal(negativeOnly.recallAtK, null);
  assert.equal(negativeOnly.noAnswerAccuracy, 1);
});

const dataset = {
  schemaVersion: 1,
  id: "test-corpus",
  memories: [
    { id: "alpha", text: "The service requires two reviews." },
    { id: "beta", text: "The database is PostgreSQL." },
  ],
  queries: [
    { id: "reviews", category: "paraphrase", query: "How many approvals?", relevantIds: ["alpha"] },
    { id: "postcode", category: "unanswerable", query: "What is the office postcode?", relevantIds: [] },
  ],
};

function mockClient(rankings = [["beta", "alpha"], []]) {
  const calls = [];
  let writes = 0;
  let recalls = 0;
  return {
    calls,
    async callTool(request) {
      calls.push(request);
      if (request.name === "write_memory") {
        const memory = dataset.memories[writes++];
        assert.equal(request.arguments.text, memory.text);
        return { structuredContent: { memoryId: `stored-${memory.id}` } };
      }
      return {
        structuredContent: {
          results: rankings[recalls++].map((identifier, index) => ({
            memoryId: `stored-${identifier}`,
            fragmentId: `fragment-${index}`,
            agentId: request.arguments.agentId,
            text: "This returned fragment must not appear in the report.",
            score: 1 / (index + 1),
          })),
        },
      };
    },
  };
}

test("the checked-in corpus has valid labels and all five query categories", () => {
  const corpus = validateDataset(JSON.parse(readFileSync(new URL("./fixtures/recall-v1.json", import.meta.url), "utf8")));
  assert.equal(corpus.memories.length, 24);
  assert.equal(corpus.queries.length, 32);
  assert.deepEqual(new Set(corpus.queries.map((query) => query.category)), new Set([
    "lexical", "paraphrase", "disambiguation", "multi_answer", "unanswerable",
  ]));
});

test("corpus validation rejects ambiguous IDs, broken labels, and invalid text", () => {
  for (const mutate of [
    (copy) => { copy.schemaVersion = 2; },
    (copy) => { copy.memories = []; },
    (copy) => { copy.memories[1].id = "alpha"; },
    (copy) => { copy.queries[1].id = "reviews"; },
    (copy) => { copy.memories[0].text = " "; },
    (copy) => { copy.memories[0].text = "x".repeat(32769); },
    (copy) => { copy.queries[0].query = ""; },
    (copy) => { copy.queries[0].category = null; },
    (copy) => { copy.queries[0].relevantIds = ["missing"]; },
    (copy) => { copy.queries[0].relevantIds = ["alpha", "alpha"]; },
    (copy) => { delete copy.queries[0].relevantIds; },
  ]) {
    const copy = structuredClone(dataset);
    mutate(copy);
    assert.throws(() => validateDataset(copy));
  }
});

test("the runner writes once, filters every query, and keeps gold labels out of requests", async () => {
  const client = mockClient();
  const result = await runBenchmark(client, dataset, { limit: 2, agentId: "isolated-test-run" });
  assert.equal(client.calls.length, 4);
  assert.ok(client.calls.every((call) => call.arguments.agentId === "isolated-test-run"));
  assert.deepEqual(client.calls[2], {
    name: "recall_memory",
    arguments: { query: dataset.queries[0].query, agentId: "isolated-test-run", limit: 2 },
  });
  assert.deepEqual(result.queries[0].rankedIds, ["beta", "alpha"]);
  assert.deepEqual(result.queries[0].missedIds, []);
  assert.equal(result.summary.mrrAtK, 0.5);
  assert.equal(result.summary.recallAtK, 1);
  assert.equal(result.byCategory.unanswerable.noAnswerAccuracy, 1);
  const serialized = JSON.stringify(result);
  for (const memory of dataset.memories) assert.ok(!serialized.includes(memory.text));
  for (const query of dataset.queries) assert.ok(!serialized.includes(query.query));
  assert.ok(!serialized.includes("This returned fragment"));
});

test("the runner gives each invocation a fresh namespace", async () => {
  const first = await runBenchmark(mockClient(), dataset);
  const second = await runBenchmark(mockClient(), dataset);
  assert.notEqual(first.agentId, second.agentId);
});

test("invalid datasets and cutoffs fail before any MCP calls", async () => {
  const client = mockClient();
  await assert.rejects(runBenchmark(client, {}, { limit: 5 }));
  await assert.rejects(runBenchmark(client, dataset, { limit: 0 }));
  assert.equal(client.calls.length, 0);
});

test("tool and transport failures abort evaluation without exposing provider content", async () => {
  for (const failure of ["write_memory", "recall_memory"]) {
    for (const throws of [true, false]) {
      const client = mockClient();
      const original = client.callTool.bind(client);
      client.callTool = async (request) => {
        if (request.name !== failure) return original(request);
        if (throws) throw new Error("private provider response");
        return { isError: true, content: [{ type: "text", text: "private provider response" }] };
      };
      await assert.rejects(runBenchmark(client, dataset), (error) => {
        assert.match(error.message, /MCP .* failed/);
        assert.ok(!error.message.includes("private provider response"));
        return true;
      });
    }
  }
});

test("foreign memories, incorrect provenance, and malformed rankings are never scored", async () => {
  for (const mutate of [
    (response) => { response.structuredContent.results[0].memoryId = "foreign-memory"; },
    (response) => { response.structuredContent.results[0].agentId = "another-run"; },
    (response) => { response.structuredContent.results[0].score = NaN; },
    (response) => { response.structuredContent.results[0].fragmentId = ""; },
    (response) => { response.structuredContent.results[1].fragmentId = "fragment-0"; },
    (response) => { response.structuredContent.results = null; },
    (response) => { response.structuredContent.results.push(...response.structuredContent.results); },
  ]) {
    const client = mockClient();
    const original = client.callTool.bind(client);
    client.callTool = async (request) => {
      const response = await original(request);
      if (request.name === "recall_memory") mutate(response);
      return response;
    };
    await assert.rejects(runBenchmark(client, dataset, { limit: 2 }), /Recall returned/);
  }
});

const testEnvironment = {
  MINDLEAK_TEST_DATABASE_URL: "postgresql://tester:private-password@localhost/benchmark_test?sslmode=disable",
};

test("benchmark startup requires a disposable database and rejects database overrides", () => {
  for (const databaseUrl of [
    undefined,
    "not a URL",
    "postgresql://localhost/production",
    "https://localhost/benchmark_test",
    "postgresql://localhost/benchmark_test?dbname=production",
    "postgresql://localhost/benchmark_test?host=elsewhere",
    "postgresql://localhost/benchmark_test#production",
    "postgresql://localhost/production%2Fbenchmark_test",
    "postgresql://localhost/%invalid_test",
  ]) {
    assert.throws(() => benchmarkSettings({ MINDLEAK_TEST_DATABASE_URL: databaseUrl }), /_test/);
  }
});

test("default settings override inherited production and model modes without reporting secrets", () => {
  const settings = benchmarkSettings({
    ...testEnvironment,
    MINDLEAK_DATABASE_URL: "postgresql://localhost/production",
    MINDLEAK_DECOMPOSITION: "openai",
    MINDLEAK_RETRIEVAL: "vector",
    MINDLEAK_LLM_API_KEY: "private-key",
  });
  assert.equal(settings.serverEnvironment.MINDLEAK_DATABASE_URL, testEnvironment.MINDLEAK_TEST_DATABASE_URL);
  assert.equal(settings.serverEnvironment.MINDLEAK_DECOMPOSITION, "sentences");
  assert.equal(settings.serverEnvironment.MINDLEAK_RETRIEVAL, "keyword");
  assert.equal(settings.serverEnvironment.MINDLEAK_LLM_API_KEY, undefined);
  assert.equal(settings.configuration.decompositionModel, null);
  assert.equal(settings.configuration.embeddingModel, null);
  assert.ok(!JSON.stringify(settings.configuration).includes("private"));
});

test("enabled providers require explicit settings and reports identify models without credentials", () => {
  assert.throws(() => benchmarkSettings(testEnvironment, { retrieval: "vector" }), /MINDLEAK_EMBED_URL/);
  assert.throws(() => benchmarkSettings(testEnvironment, { decomposition: "openai" }), /MINDLEAK_LLM_URL/);
  const environment = {
    ...testEnvironment,
    MINDLEAK_LLM_URL: "http://localhost:1234/v1",
    MINDLEAK_MODEL: "chat-model",
    MINDLEAK_LLM_API_KEY: "private-chat-key",
    MINDLEAK_EMBED_URL: "http://localhost:1234/v1",
    MINDLEAK_EMBED_MODEL: "embedding-model",
    MINDLEAK_EMBED_API_KEY: "private-embed-key",
    MINDLEAK_EMBED_DIMENSIONS: "768",
  };
  const settings = benchmarkSettings(environment, { decomposition: "openai", retrieval: "vector", label: "model-comparison" });
  assert.equal(settings.configuration.decompositionModel, "chat-model");
  assert.equal(settings.configuration.embeddingModel, "embedding-model");
  assert.equal(settings.configuration.embeddingDimensions, 768);
  assert.equal(settings.serverEnvironment.MINDLEAK_EMBED_API_KEY, "private-embed-key");
  assert.ok(!JSON.stringify(settings.configuration).includes("private"));
  for (const dimensions of [undefined, "0", "2001", "1.5"]) {
    assert.throws(() => benchmarkSettings({ ...environment, MINDLEAK_EMBED_DIMENSIONS: dimensions }, { retrieval: "vector" }), /DIMENSIONS/);
  }
  assert.throws(() => benchmarkSettings({ ...environment, MINDLEAK_EMBED_URL: "https://user:secret@example.com/v1" }, { retrieval: "vector" }), /without credentials/);
});

test("invalid modes and quality gates fail before starting a server", () => {
  for (const options of [
    { retrieval: "automatic" },
    { decomposition: "fallback" },
    { k: "0" },
    { k: "51" },
    { label: "not a short identifier" },
    { "min-recall": "" },
    { "min-recall": " " },
    { "min-recall": "NaN" },
    { "min-recall": "1.1" },
    { "min-recall": "-0.1" },
  ]) {
    assert.throws(() => benchmarkSettings(testEnvironment, options));
  }
  assert.equal(benchmarkSettings(testEnvironment, { "min-recall": "0.8" }).minimumRecall, 0.8);
});

test("CLI help works without a server, database, or installed MCP dependencies", () => {
  const script = fileURLToPath(new URL("./benchmark-recall.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" });
  assert.match(output, /MINDLEAK_TEST_DATABASE_URL/);
  assert.match(output, /--min-recall/);
  assert.match(output, /JSON reports go to stdout/);
});
