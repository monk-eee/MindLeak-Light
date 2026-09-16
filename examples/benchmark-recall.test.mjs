import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { benchmarkSettings, calibrateSimilarity, querySetManifest, runBenchmark, runDecompositionBenchmark, scoreDecomposition, scoreRanking, summarizeQueries, validateDataset, withBackground } from "./benchmark-recall.mjs";
import { compareReports } from "./benchmark-compare.mjs";

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

test("useful negative evidence receives relevance credit without rewarding unrelated negatives", () => {
  const corpus = validateDataset(JSON.parse(readFileSync(new URL("./fixtures/recall-evidence-v1.json", import.meta.url), "utf8")));
  const approvedDate = corpus.queries.find((query) => query.id === "ilex-approved-date");
  assert.deepEqual(approvedDate.relevantIds, ["ilex-approval"]);
  for (const category of ["corrective_evidence", "explicit_unknown", "negative_evidence", "direct_answer"]) {
    const queries = corpus.queries.filter((query) => query.category === category);
    assert.ok(queries.length > 0);
    for (const query of queries) {
      const result = scoreRanking(query.relevantIds, query.relevantIds, 5);
      assert.equal(result.recallAtK, 1);
      assert.equal(result.noAnswerCorrect, null);
      assert.equal(scoreRanking([], query.relevantIds, 5).recallAtK, 0);
    }
  }
  for (const query of corpus.queries.filter((query) => query.category === "unanswerable")) {
    assert.equal(scoreRanking([], query.relevantIds, 5).noAnswerCorrect, true);
    assert.equal(scoreRanking(["ilex-approval"], query.relevantIds, 5).noAnswerCorrect, false);
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
            text: dataset.memories.find((memory) => memory.id === identifier)?.text ?? "Unknown fact.",
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

test("calibration and evaluation cannot share a gold target or declared query family", () => {
  const corpus = structuredClone(dataset);
  corpus.queries[0].split = "calibration";
  corpus.queries[1].split = "evaluation";
  corpus.queries[1].relevantIds = ["alpha"];
  assert.throws(() => validateDataset(corpus), /gold targets/);
  corpus.queries[1].relevantIds = ["beta"];
  corpus.queries[0].group = "same-family";
  corpus.queries[1].group = "same-family";
  assert.throws(() => validateDataset(corpus), /query family/);
  corpus.queries[1].group = "other-family";
  assert.equal(validateDataset(corpus), corpus);
});

test("the larger corpus has distinct memories, traceable sources, and disjoint labelled facts", () => {
  const corpus = validateDataset(JSON.parse(readFileSync(new URL("./fixtures/recall-v2.json", import.meta.url), "utf8")));
  assert.ok(corpus.memories.length >= 200);
  assert.equal(new Set(corpus.memories.map((memory) => memory.text.toLowerCase())).size, corpus.memories.length);
  assert.equal(corpus.memories.filter((memory) => memory.id.startsWith("ml-")).length, 24);
  assert.ok(corpus.sources.some((source) => source.repository === "https://github.com/monk-eee/MindLeak"));
  const labels = {};
  for (const split of ["calibration", "evaluation"]) {
    const queries = corpus.queries.filter((query) => query.split === split);
    assert.ok(queries.length >= 52);
    assert.ok(queries.filter((query) => !query.relevantIds.length).length >= 20);
    labels[split] = new Set(queries.flatMap((query) => query.relevantIds));
  }
  assert.ok([...labels.calibration].every((identifier) => !labels.evaluation.has(identifier)));
  assert.equal(new Set(corpus.queries.map((query) => query.query.toLowerCase())).size, corpus.queries.length);
});

test("multi-fact fixtures cover paired extraction risks and label every expected fact", () => {
  const corpus = validateDataset(JSON.parse(readFileSync(new URL("./fixtures/recall-v2.json", import.meta.url), "utf8")));
  assert.equal(corpus.memories.length, 240);
  assert.equal(corpus.queries.length, 176);
  const categories = ["scope_negation", "quantities_units", "exceptions", "uncertainty", "coreference", "ambiguous_entity", "temporal", "identifiers", "list_structure", "duplicate_claims", "untrusted_quotes", "compound_claims"];
  for (const split of ["calibration", "evaluation"]) {
    const memories = corpus.memories.filter((memory) => memory.facts && memory.split === split);
    assert.equal(memories.length, 12);
    assert.deepEqual(new Set(memories.map((memory) => memory.category)), new Set(categories));
    const queries = corpus.queries.filter((query) => query.split === split);
    const referenced = new Set(queries.flatMap((query) => query.relevantIds));
    for (const memory of memories) {
      assert.ok(memory.facts.length >= 2);
      assert.ok(memory.facts.every((fact) => referenced.has(fact.id)));
    }
    assert.equal(queries.filter((query) => !query.relevantIds.length).length, 32);
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

test("repeat passes cannot dilute quality regressions or inflate the query population", async () => {
  const client = mockClient([[], ["beta"], ["alpha"], [], ["alpha"], []]);
  const report = await runBenchmark(client, dataset, { passes: 3 });
  assert.equal(report.summary.queries, 2);
  assert.equal(report.summary.recallAtK, 0);
  assert.equal(report.summary.noAnswerAccuracy, 0);
  assert.equal(report.sourceSummary.queries, 2);
  assert.equal(report.byCategory.paraphrase.recallAtK, 0);
  assert.equal(report.queries.length, 6);
  assert.equal(report.latency.recall.count, 6);
  assert.equal(report.byPass[1].summary.recallAtK, 1);
  assert.equal(report.byPass[2].summary.noAnswerAccuracy, 1);
});

test("bounded concurrent workloads preserve every query and report per-pass throughput", async () => {
  const client = mockClient([["alpha"], [], ["alpha"], []]);
  const original = client.callTool.bind(client);
  let active = 0;
  let peak = 0;
  client.callTool = async (request) => {
    if (request.name === "write_memory") return original(request);
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    const result = await original(request);
    active -= 1;
    return result;
  };
  const report = await runBenchmark(client, dataset, { passes: 2, concurrency: 2 });
  assert.equal(peak, 2);
  assert.equal(report.workload.concurrency, 2);
  assert.equal(report.queries.length, 4);
  assert.equal(report.summary.queries, 2);
  assert.equal(report.summary.recallAtK, 1);
  assert.equal(report.byPass[0].completed, 2);
  assert.ok(report.byPass[0].elapsedMs > 0);
  assert.ok(report.byPass[0].throughputQps > 0);
  assert.ok(report.byPass[0].latency.p99Ms >= report.byPass[0].latency.p95Ms);
});

test("response size measures escaped UTF-8 context without retaining provider text", async () => {
  const client = mockClient([["alpha"], [], ["alpha"], []]);
  const original = client.callTool.bind(client);
  const sizes = [];
  const context = "\u2603 quoted \"value\"\n".repeat(256);
  client.callTool = async request => {
    const response = await original(request);
    if (response.structuredContent.results) {
      for (const result of response.structuredContent.results) {
        result.context = { summary: context };
        result.relationships = [{ text: context }];
      }
      sizes.push(Buffer.byteLength(JSON.stringify(response.structuredContent.results), "utf8"));
    }
    return response;
  };
  const report = await runBenchmark(client, dataset, { passes: 2 });
  assert.deepEqual(report.queries.map(query => query.resultBytes), sizes);
  assert.equal(report.queries[0].primaryTextBytes, Buffer.byteLength(dataset.memories[0].text, "utf8"));
  assert.equal(report.responseSize.count, 2);
  assert.equal(report.responseSize.maxBytes, sizes[0]);
  assert.equal(report.responseSize.totalBytes, sizes[0] + sizes[1]);
  assert.equal(report.byPass[1].responseSize.count, 2);
  assert.equal(report.byPass[1].responseSize.p95Bytes, sizes[2]);
  assert.ok(!JSON.stringify(report).includes("quoted"));
});

test("the right source ID cannot earn fact credit for the wrong number", async () => {
  const client = mockClient([["alpha"], []]);
  const original = client.callTool.bind(client);
  client.callTool = async (request) => {
    const response = await original(request);
    for (const fragment of response.structuredContent.results ?? []) {
      fragment.text = "The service requires one review.";
    }
    return response;
  };
  const report = await runBenchmark(client, dataset);
  assert.equal(report.summary.recallAtK, 0);
  assert.equal(report.sourceSummary.recallAtK, 1);
  assert.equal(report.unverifiedFragments, 1);
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

test("split selection happens before writing and reports only selected queries", async () => {
  const corpus = structuredClone(dataset);
  corpus.queries[0].split = "calibration";
  corpus.queries[1].split = "evaluation";
  const client = mockClient();
  const report = await runBenchmark(client, corpus, { split: "calibration" });
  assert.equal(report.queries.length, 1);
  assert.equal(report.queries[0].id, "reviews");
  assert.equal(report.split, "calibration");
  assert.deepEqual(report.queries[0].scores, [1, 0.5]);
  assert.equal(report.latency.write.count, 2);
  assert.equal(report.latency.recall.count, 1);
  assert.ok(report.latency.recall.p95Ms >= 0);
  const untouched = mockClient();
  await assert.rejects(runBenchmark(untouched, dataset, { split: "evaluation" }), /no queries/);
  assert.equal(untouched.calls.length, 0);
  corpus.queries[1].query = corpus.queries[0].query;
  assert.throws(() => validateDataset(corpus), /different splits/);
});

function calibrationReport() {
  return {
    reportVersion: 3,
    scoring: "verified-fact-variants",
    split: "calibration",
    limit: 50,
    configuration: { retrieval: "vector", minSimilarity: null, embeddingModel: "test-model", embeddingDimensions: 2 },
    dataset: { id: "test-corpus", sha256: "test-digest" },
    queries: [
      { id: "positive", split: "calibration", rankedIds: ["alpha"], scores: [0.86], relevantIds: ["alpha"] },
      { id: "negative", split: "calibration", rankedIds: ["beta"], scores: [0.70], relevantIds: [] },
    ],
  };
}

test("calibration selects a score gap with an explicit recall constraint", () => {
  const result = calibrateSimilarity(calibrationReport(), 1);
  assert.equal(result.minSimilarity, (0.86 + 0.70) / 2);
  assert.equal(result.summary.recallAtK, 1);
  assert.equal(result.summary.noAnswerAccuracy, 1);
  assert.deepEqual(result.queryIds, ["positive", "negative"]);
  assert.equal(result.embeddingModel, "test-model");
});

test("calibration requires a full candidate capture and scores the requested result cutoff", () => {
  const truncated = calibrationReport();
  truncated.limit = 5;
  assert.throws(() => calibrateSimilarity(truncated, 1), /candidate.*50/);
  const captured = calibrationReport();
  captured.queries[0].rankedIds = ["unrelated", "alpha"];
  captured.queries[0].scores = [0.60, 0.86];
  const calibrated = calibrateSimilarity(captured, 1, 1);
  assert.equal(calibrated.limit, 1);
  assert.equal(calibrated.candidateLimit, 50);
  assert.equal(calibrated.summary.precisionAtK, 1);
  assert.equal(calibrated.summary.noAnswerAccuracy, 1);
});

test("v5 calibration refuses observations removed from its planned query set", () => {
  const report = calibrationReport();
  report.reportVersion = 5;
  report.qualityPass = 1;
  report.queries.push({ ...report.queries[1], id: "second-negative" });
  for (const query of report.queries) {
    query.category = query.relevantIds.length ? "positive" : "negative";
    query.querySha256 = createHash("sha256").update(query.id).digest("hex");
  }
  report.querySet = querySetManifest(report.queries);
  assert.equal(calibrateSimilarity(report, 1).summary.noAnswerAccuracy, 1);
  report.queries.pop();
  assert.throws(() => calibrateSimilarity(report, 1), /query-set manifest/);
});

test("calibration rejects held-out leakage, fused scores, filtered runs, and invalid data", () => {
  for (const mutate of [
    (report) => { report.split = "evaluation"; },
    (report) => { report.queries[0].split = "evaluation"; },
    (report) => { report.configuration.retrieval = "hybrid"; },
    (report) => { report.configuration.relevance = "openai"; },
    (report) => { report.passes = 2; },
    (report) => { report.configuration.minSimilarity = 0.7; },
    (report) => { report.queries.pop(); },
    (report) => { report.queries[0].scores = []; },
    (report) => { report.queries[0].scores = [NaN]; },
    (report) => { report.queries[0].scores = [1.1]; },
    (report) => { report.queries[0].relevantIds = ["missing"]; },
  ]) {
    const report = calibrationReport();
    mutate(report);
    assert.throws(() => calibrateSimilarity(report, 1));
  }
});

test("hybrid settings propagate only explicit similarity and quality gates", () => {
  const environment = {
    ...testEnvironment,
    MINDLEAK_EMBED_URL: "http://localhost:1234/v1",
    MINDLEAK_EMBED_MODEL: "test-model",
    MINDLEAK_EMBED_DIMENSIONS: "2",
    MINDLEAK_RECALL_MIN_SIMILARITY: "0.99",
  };
  const settings = benchmarkSettings(environment, { retrieval: "hybrid", "min-similarity": "0.7", "min-no-answer": "0.8", split: "evaluation" });
  assert.equal(settings.serverEnvironment.MINDLEAK_RECALL_MIN_SIMILARITY, "0.7");
  assert.equal(settings.configuration.minSimilarity, 0.7);
  assert.equal(settings.minimumNoAnswer, 0.8);
  assert.equal(benchmarkSettings(environment, { retrieval: "vector" }).serverEnvironment.MINDLEAK_RECALL_MIN_SIMILARITY, undefined);
  for (const options of [
    { "min-similarity": "0.7" },
    { retrieval: "vector", "min-similarity": "" },
    { retrieval: "vector", "min-similarity": "1.1" },
    { "min-no-answer": "NaN" },
    { "min-no-answer": "1.1" },
    { split: "unknown" },
  ]) assert.throws(() => benchmarkSettings(environment, options));
});

const compound = {
  id: "policy",
  category: "negation_and_exception",
  split: "evaluation",
  text: "In test environments, Arbor retains logs for 14 days. Arbor does not export logs unless an operator approves.",
  facts: [
    { id: "retention", text: "In test environments, Arbor retains logs for 14 days", variants: ["Arbor keeps test-environment logs for fourteen days"] },
    { id: "approval", text: "Arbor does not export logs unless an operator approves" },
  ],
};

test("decomposition scoring rejects changed quantities, dropped qualifiers, and reversed negation", () => {
  for (const text of [
    "In test environments, Arbor retains logs for 30 days",
    "Arbor retains logs for 14 days",
    "Arbor exports logs unless an operator approves",
    "Arbor does not export logs",
    "Arbor will retain logs for 14 days in every environment",
  ]) {
    const score = scoreDecomposition(compound, [text]);
    assert.equal(score.verifiedFactRecall, 0);
    assert.equal(score.unverified.length, 1);
    assert.ok(!JSON.stringify(score).includes(text));
  }
});

test("decomposition scoring accepts reviewed variants but does not credit merged or duplicate claims twice", () => {
  const full = scoreDecomposition(compound, ["  Arbor keeps test-environment logs for fourteen days. ", compound.facts[1].text]);
  assert.equal(full.verifiedFactRecall, 1);
  assert.equal(full.verifiedFragmentPrecision, 1);
  const duplicate = scoreDecomposition(compound, [compound.facts[0].text, compound.facts[0].text]);
  assert.equal(duplicate.verifiedFactRecall, 0.5);
  assert.equal(duplicate.duplicateFragments, 1);
  assert.equal(duplicate.verifiedFragmentPrecision, 0.5);
  assert.equal(scoreDecomposition(compound, [compound.text]).verifiedFactRecall, 0);
  assert.equal(scoreDecomposition(compound, []).verifiedFactRecall, 0);
});

test("semantic-dependency cases reject disconnected causes and invented interpretations", () => {
  const corpus = validateDataset(JSON.parse(readFileSync(new URL("./fixtures/semantic-dependencies-v1.json", import.meta.url), "utf8")));
  assert.equal(corpus.memories.length, 6);
  const labelled = new Set(corpus.queries.flatMap((query) => query.relevantIds));
  for (const memory of corpus.memories) {
    assert.ok(memory.facts.every((fact) => labelled.has(fact.id)));
    assert.equal(scoreDecomposition(memory, memory.facts.map((fact) => fact.text)).verifiedFactRecall, 1);
    for (const fragments of memory.rejectedDecompositions) {
      const score = scoreDecomposition(memory, fragments);
      assert.ok(score.verifiedFactRecall < 1, `${memory.id} lost or invented a semantic dependency`);
      assert.ok(score.unverified.length > 0);
    }
  }
});

test("fact verification preserves case-sensitive identifiers and assertion punctuation", () => {
  const memory = { id: "flag", text: "Cirrus enables the allowHTTP flag." };
  assert.equal(scoreDecomposition(memory, ["Cirrus enables the allowHttp flag."]).verifiedFactRecall, 0);
  assert.equal(scoreDecomposition(memory, ["Cirrus enables the allowHTTP flag?"]).verifiedFactRecall, 0);
});

test("extraction-only evaluates selected gold facts without writes or sending labels", async () => {
  const corpus = { schemaVersion: 1, id: "compound", memories: [compound], queries: [
    { id: "retention-query", category: "qualifier", split: "evaluation", query: "test log retention", relevantIds: ["retention"] },
  ] };
  const requests = [];
  const client = { async callTool(request) {
    requests.push(request);
    return { structuredContent: { results: compound.facts.map((fact) => fact.text) } };
  } };
  const report = await runDecompositionBenchmark(client, corpus);
  assert.deepEqual(requests, [{ name: "decompose_memory", arguments: { text: compound.text } }]);
  assert.equal(report.summary.verifiedFactRecall, 1);
  assert.equal(report.summary.missingFacts, 0);
  assert.ok(!JSON.stringify(report).includes(compound.text));
  await assert.rejects(runDecompositionBenchmark({ async callTool() { return { isError: true }; } }, corpus), /failed/);
});

test("multi-fact recall scores the requested fact rather than any fact from the same source", async () => {
  const corpus = { schemaVersion: 1, id: "compound", memories: [compound], queries: [
    { id: "retention-query", category: "qualifier", split: "evaluation", query: "test log retention", relevantIds: ["retention"] },
  ] };
  const client = { async callTool(request) {
    if (request.name === "write_memory") return { structuredContent: { memoryId: "source" } };
    return { structuredContent: { results: [{
      memoryId: "source", fragmentId: "wrong-fact", agentId: request.arguments.agentId,
      text: compound.facts[1].text, score: 0.9,
    }] } };
  } };
  const report = await runBenchmark(client, corpus);
  assert.equal(report.summary.recallAtK, 0);
  assert.equal(report.sourceSummary.recallAtK, 1);
  assert.deepEqual(report.queries[0].rankedIds, ["approval"]);
  assert.deepEqual(report.queries[0].missedIds, ["retention"]);
  assert.equal(report.unverifiedFragments, 0);
});

test("background corpora add distractors without importing exposed query labels", () => {
  const background = { schemaVersion: 1, id: "background", memories: [{ id: "gamma", text: "Background fact." }], queries: [
    { id: "exposed", category: "lexical", query: "background", relevantIds: ["gamma"] },
  ] };
  const combined = withBackground(dataset, background);
  assert.equal(combined.memories.length, 3);
  assert.deepEqual(combined.queries, dataset.queries);
  assert.equal(dataset.memories.length, 2);
  assert.equal(background.queries.length, 1);
  assert.throws(() => withBackground(dataset, dataset), /unique/);
});

test("relevance benchmarking requires explicit settings and does not inherit active service modes", () => {
  const environment = {
    ...testEnvironment,
    MINDLEAK_RELEVANCE: "openai",
    MINDLEAK_RELEVANCE_URL: "http://localhost:11434/v1",
    MINDLEAK_RELEVANCE_MODEL: "relevance-model",
    MINDLEAK_RELEVANCE_API_KEY: "private-relevance-key",
  };
  const defaults = benchmarkSettings(environment);
  assert.equal(defaults.serverEnvironment.MINDLEAK_RELEVANCE, "off");
  assert.equal(defaults.configuration.relevanceModel, null);
  assert.equal(defaults.serverEnvironment.MINDLEAK_RELEVANCE_API_KEY, undefined);
  const enabled = benchmarkSettings(environment, { relevance: "openai", "relevance-candidates": "12" });
  assert.equal(enabled.configuration.relevanceModel, "relevance-model");
  assert.equal(enabled.configuration.relevanceCandidates, 12);
  assert.equal(enabled.serverEnvironment.MINDLEAK_RELEVANCE_CANDIDATES, "12");
  assert.ok(!JSON.stringify(enabled.configuration).includes("private"));
  for (const options of [
    { relevance: "auto" }, { "relevance-candidates": "12" },
    { relevance: "openai", "relevance-candidates": "0" },
    { relevance: "openai", "relevance-candidates": "51" },
    { relevance: "openai", "relevance-candidates": "1.5" },
  ]) assert.throws(() => benchmarkSettings(environment, options));
  assert.throws(() => benchmarkSettings(testEnvironment, { relevance: "openai" }), /MINDLEAK_RELEVANCE_URL/);
});

test("the fresh holdout has new targets and retains the full background as distractors only", () => {
  const fresh = JSON.parse(readFileSync(new URL("./fixtures/recall-v3-holdout.json", import.meta.url), "utf8"));
  const old = JSON.parse(readFileSync(new URL("./fixtures/recall-v2.json", import.meta.url), "utf8"));
  const combined = withBackground(fresh, old);
  assert.equal(fresh.memories.length, 32);
  assert.equal(combined.memories.length, 272);
  assert.equal(combined.queries.length, 32);
  assert.equal(combined.queries.filter((query) => query.relevantIds.length === 0).length, 16);
  assert.ok(combined.queries.every((query) => query.split === "evaluation"));
  const oldFacts = new Set(old.memories.flatMap((memory) => memory.facts?.map((fact) => fact.id) ?? [memory.id]));
  assert.ok(fresh.queries.flatMap((query) => query.relevantIds).every((identifier) => !oldFacts.has(identifier)));
  const oldQueries = new Set(old.queries.map((query) => query.query.toLowerCase()));
  assert.ok(fresh.queries.every((query) => !oldQueries.has(query.query.toLowerCase())));
  assert.equal(fresh.memories.filter((memory) => memory.facts).length, 8);
});

test("benchmark reasoning controls are explicit and absent unless enabled", () => {
  const environment = {
    ...testEnvironment,
    MINDLEAK_RELEVANCE_URL: "http://localhost:11434/v1",
    MINDLEAK_RELEVANCE_MODEL: "test-model",
    MINDLEAK_RELEVANCE_REASONING_EFFORT: "high",
    MINDLEAK_LLM_URL: "http://localhost:11434/v1",
    MINDLEAK_MODEL: "test-model",
    MINDLEAK_LLM_REASONING_EFFORT: "high",
  };
  const defaults = benchmarkSettings(environment, { relevance: "openai", decomposition: "openai" });
  assert.equal(defaults.serverEnvironment.MINDLEAK_RELEVANCE_REASONING_EFFORT, undefined);
  assert.equal(defaults.serverEnvironment.MINDLEAK_LLM_REASONING_EFFORT, undefined);
  const settings = benchmarkSettings(environment, {
    relevance: "openai", "relevance-reasoning-effort": "none",
    decomposition: "openai", "decomposition-reasoning-effort": "low",
  });
  assert.equal(settings.serverEnvironment.MINDLEAK_RELEVANCE_REASONING_EFFORT, "none");
  assert.equal(settings.serverEnvironment.MINDLEAK_LLM_REASONING_EFFORT, "low");
  assert.deepEqual(settings.reasoning, { relevance: "none", decomposition: "low" });
  for (const options of [
    { "relevance-reasoning-effort": "none" },
    { "decomposition-reasoning-effort": "none" },
    { relevance: "openai", "relevance-reasoning-effort": "automatic" },
    { decomposition: "openai", "decomposition-reasoning-effort": "" },
  ]) assert.throws(() => benchmarkSettings(environment, options));
});

test("repeat passes measure cold and warm queries without rewriting memories", async () => {
  const client = mockClient([["beta", "alpha"], [], ["alpha"], [], ["alpha"], []]);
  const report = await runBenchmark(client, dataset, { passes: 3 });
  assert.equal(client.calls.filter((call) => call.name === "write_memory").length, 2);
  assert.equal(client.calls.filter((call) => call.name === "recall_memory").length, 6);
  assert.equal(report.byPass.length, 3);
  assert.deepEqual(report.queries.map((query) => query.pass), [1, 1, 2, 2, 3, 3]);
  assert.equal(report.byPass[0].summary.mrrAtK, 0.5);
  assert.equal(report.byPass[1].summary.mrrAtK, 1);
  assert.equal(report.byPass[2].latency.count, 2);
  const settings = benchmarkSettings(testEnvironment, { passes: "3", "max-warm-p95-ms": "20" });
  assert.equal(settings.passes, 3);
  assert.equal(settings.maxWarmP95, 20);
  for (const options of [{ passes: "0" }, { passes: "11" }, { passes: "1.5" },
    { "max-warm-p95-ms": "20" }, { passes: "2", "max-warm-p95-ms": "0" }]) {
    assert.throws(() => benchmarkSettings(testEnvironment, options));
  }
});

test("workload settings are explicit and invalid values fail before any model or database calls", async () => {
  const settings = benchmarkSettings(testEnvironment, { concurrency: "4", "query-seed": "0" });
  assert.equal(settings.concurrency, 4);
  assert.equal(settings.querySeed, 0);
  for (const options of [{ concurrency: "0" }, { concurrency: "33" }, { concurrency: "1.5" },
    { "query-seed": "-1" }, { "query-seed": "1.5" }, { "query-seed": "4294967296" }]) {
    assert.throws(() => benchmarkSettings(testEnvironment, options));
  }
  for (const options of [{ concurrency: 0 }, { concurrency: 1.5 }, { querySeed: NaN }]) {
    const client = mockClient();
    await assert.rejects(runBenchmark(client, dataset, options));
    assert.equal(client.calls.length, 0);
  }
});

test("seeded schedules are reproducible and query groups never enter model requests", async () => {
  const corpus = structuredClone(dataset);
  corpus.queries = Array.from({ length: 16 }, (_, index) => ({ ...corpus.queries[1], id: `query-${index}`,
    query: `Missing field ${index}?`, group: `source-${index % 4}` }));
  const run = async (querySeed) => {
    const client = mockClient(Array.from({ length: 32 }, () => []));
    const report = await runBenchmark(client, corpus, { passes: 2, concurrency: 3, querySeed });
    assert.ok(client.calls.every(call => call.arguments.group === undefined));
    return report;
  };
  const first = await run(123);
  const repeated = await run(123);
  const other = await run(456);
  assert.deepEqual(first.queries.map(query => [query.id, query.pass, query.group]),
    repeated.queries.map(query => [query.id, query.pass, query.group]));
  assert.notEqual(first.byPass[0].queryOrderSha256, other.byPass[0].queryOrderSha256);
  assert.equal(new Set(first.queries.filter(query => query.pass === 1).map(query => query.id)).size, 16);
  corpus.queries[0].group = "invalid group";
  assert.throws(() => validateDataset(corpus), /groups/);
});

test("concurrent failures drain active calls without scheduling more work or emitting success", async () => {
  const corpus = structuredClone(dataset);
  corpus.queries = Array.from({ length: 5 }, (_, index) => ({ ...corpus.queries[0], id: `query-${index}` }));
  let issued = 0;
  let drained = false;
  const client = mockClient();
  const original = client.callTool.bind(client);
  client.callTool = async request => {
    if (request.name === "write_memory") return original(request);
    issued += 1;
    if (issued === 1) throw new Error("provider body must not leak");
    await Promise.resolve();
    drained = true;
    return { structuredContent: { results: [] } };
  };
  await assert.rejects(runBenchmark(client, corpus, { concurrency: 2 }), error =>
    /failed/.test(error.message) && !error.message.includes("provider body"));
  assert.equal(issued, 2);
  assert.equal(drained, true);
});

function comparableReport() {
  return {
    reportVersion: 3, mode: "recall", scoring: "verified-fact-variants", split: "evaluation", limit: 5,
    binarySha256: "b".repeat(64), dataset: { id: "paired", sha256: "a".repeat(64) },
    configuration: { decomposition: "sentences", retrieval: "keyword", minSimilarity: null },
    queries: [
      { id: "positive-one", category: "paraphrase", split: "evaluation", relevantIds: ["fact-one"], rankedIds: [], scores: [], recallMs: 10 },
      { id: "positive-two", category: "paraphrase", split: "evaluation", relevantIds: ["fact-two"], rankedIds: [], scores: [], recallMs: 20 },
      { id: "negative-one", category: "missing-detail", split: "evaluation", relevantIds: [], rankedIds: ["wrong"], scores: [0.5], recallMs: 30 },
      { id: "negative-two", category: "missing-detail", split: "evaluation", relevantIds: [], rankedIds: ["wrong"], scores: [0.5], recallMs: 40 },
    ],
  };
}

function comparableCorpus() {
  return {
    sha256: "a".repeat(64),
    dataset: {
      schemaVersion: 1, id: "paired",
      memories: [
        { id: "fact-one", text: "The first service requires reviews." },
        { id: "fact-two", text: "The second service uses PostgreSQL." },
        { id: "wrong", text: "An unrelated documented fact." },
      ],
      queries: comparableReport().queries.map(query => ({
        id: query.id, category: query.category, split: query.split,
        relevantIds: query.relevantIds, query: `Question for ${query.id}?`,
      })),
    },
  };
}

function fingerprintedReport() {
  const report = comparableReport();
  report.reportVersion = 5;
  report.qualityPass = 1;
  report.runtime = { platform: "darwin", architecture: "arm64", node: "v22.0.0", availableParallelism: 8 };
  const queries = new Map(comparableCorpus().dataset.queries.map(query => [query.id, query]));
  for (const query of report.queries) {
    query.querySha256 = createHash("sha256").update(queries.get(query.id).query).digest("hex");
    query.resultBytes = query.rankedIds.length ? 128 : 2;
    query.primaryTextBytes = query.rankedIds.length ? 32 : 0;
  }
  report.querySet = querySetManifest(report.queries);
  return report;
}

test("new reports bind exact query text and the planned population without recording text", async () => {
  const report = await runBenchmark(mockClient([["alpha"], [], ["alpha"], []]), dataset, { passes: 2 });
  const first = report.queries.filter(query => query.pass === 1);
  assert.deepEqual(report.querySet, querySetManifest(first));
  assert.equal(report.querySet.count, 2);
  assert.equal(first[0].querySha256, createHash("sha256").update(dataset.queries[0].query).digest("hex"));
  assert.ok(!JSON.stringify(report).includes(dataset.queries[0].query));
  for (const mutate of [
    value => { value.queries.pop(); },
    value => { value.queries[0].querySha256 = "c".repeat(64); },
    value => { delete value.querySet; },
    value => { value.querySet.count += 1; },
    value => { delete value.queries[0].querySha256; },
    value => { value.qualityPass = 2; },
  ]) {
    const baseline = fingerprintedReport();
    mutate(baseline);
    assert.throws(() => compareReports(baseline, structuredClone(baseline), { resamples: 200 }));
  }
});

test("corpus audit verifies query fingerprints and every repeated pass", () => {
  const baseline = fingerprintedReport();
  const candidate = structuredClone(baseline);
  candidate.passes = 2;
  candidate.queries.push(...candidate.queries.map(query => ({ ...query, pass: 2 })));
  const result = compareReports(baseline, candidate, { corpus: comparableCorpus(), resamples: 200 });
  assert.equal(result.audit.corpusVerified, true);
  assert.equal(result.audit.plannedQuerySetsVerified, true);
  assert.equal(result.audit.queryTextVerified, true);
  candidate.queries.at(-1).querySha256 = "f".repeat(64);
  assert.throws(() => compareReports(baseline, candidate, { resamples: 200 }), /Every pass/);
  const edited = fingerprintedReport();
  edited.queries[0].querySha256 = "d".repeat(64);
  edited.querySet = querySetManifest(edited.queries);
  assert.throws(() => compareReports(baseline, edited, { resamples: 200 }), /fingerprints/);
  assert.throws(() => compareReports(edited, structuredClone(edited), { corpus: comparableCorpus(), resamples: 200 }), /fingerprint.*corpus/);
});

test("corpus-audited comparisons reject shared omissions and shared label changes", () => {
  const corpus = comparableCorpus();
  for (const mutate of [
    report => { report.queries.pop(); },
    report => { report.queries[0].relevantIds = ["wrong"]; },
    report => { report.queries[0].category = "different-category"; },
    report => { report.queries[0].group = "different-family"; },
  ]) {
    const baseline = comparableReport();
    mutate(baseline);
    const candidate = structuredClone(baseline);
    assert.throws(() => compareReports(baseline, candidate, { corpus, resamples: 200 }), /corpus/i);
  }
  const complete = compareReports(comparableReport(), comparableReport(), { corpus, resamples: 200 });
  assert.equal(complete.audit.corpusVerified, true);
  assert.equal(complete.audit.queryTextVerified, false);
  assert.equal(complete.uniqueQueries, corpus.dataset.queries.length);
});

test("paired comparisons recompute rankings and report reproducible gains with explicit changes", () => {
  const baseline = comparableReport();
  const candidate = structuredClone(baseline);
  candidate.configuration.retrieval = "hybrid";
  candidate.summary = { recallAtK: -100 };
  for (const query of candidate.queries) {
    query.rankedIds = [...query.relevantIds];
    query.scores = query.rankedIds.map(() => 0.9);
  }
  assert.throws(() => compareReports(baseline, candidate), /Undeclared.*retrieval/);
  const options = { allowChanges: ["retrieval"], resamples: 200, seed: 19 };
  const report = compareReports(baseline, candidate, options);
  assert.deepEqual(report, compareReports(baseline, candidate, options));
  assert.equal(report.uniqueQueries, 4);
  assert.equal(report.metrics.recallAtK.delta, 1);
  assert.equal(report.metrics.recallAtK.improved, 2);
  assert.deepEqual(report.metrics.recallAtK.interval95, [1, 1]);
  assert.equal(report.metrics.noAnswerAccuracy.delta, 1);
  assert.equal(report.byCategory.paraphrase.recallAtK.baseline, 0);
  assert.equal(report.latency.baseline[0].p95Ms, 40);
  assert.equal(report.latency.baseline[0].p99Ms, 40);
  assert.ok(!JSON.stringify(report).includes("-100"));
});

test("payload gates use every pass and cannot pass without byte measurements", () => {
  const baseline = fingerprintedReport();
  const candidate = structuredClone(baseline);
  candidate.passes = 2;
  candidate.queries.push(...candidate.queries.map(query => ({ ...query, pass: 2, resultBytes: 256 })));
  assert.equal(compareReports(baseline, candidate, { resamples: 200, maxResultBytes: 255 }).gates.passed, false);
  const passed = compareReports(baseline, candidate, { resamples: 200, maxResultBytes: 256 });
  assert.equal(passed.gates.passed, true);
  assert.equal(passed.latency.candidate[1].responseSize.maxBytes, 256);
  assert.equal(compareReports(comparableReport(), comparableReport(), { resamples: 200, maxResultBytes: 9999 }).gates.passed, false);
  assert.equal(benchmarkSettings(testEnvironment, { "max-result-bytes": "256" }).maxResultBytes, 256);
  for (const value of ["", "1.5", "-1", "NaN", "67108865"]) {
    assert.throws(() => benchmarkSettings(testEnvironment, { "max-result-bytes": value }));
  }
});

test("comparisons do not count repeat passes or related-query groups as independent samples", () => {
  const baseline = comparableReport();
  baseline.queries[0].group = "same-source";
  baseline.queries[1].group = "same-source";
  const candidate = structuredClone(baseline);
  candidate.passes = 2;
  candidate.queries.push(...candidate.queries.map((query) => ({ ...query, pass: 2,
    rankedIds: [...query.relevantIds], scores: query.relevantIds.map(() => 1) })));
  const report = compareReports(baseline, candidate, { resamples: 200 });
  assert.equal(report.metrics.recallAtK.queries, 2);
  assert.equal(report.metrics.recallAtK.groups, 1);
  assert.equal(report.metrics.recallAtK.interval95, null);
  assert.equal(report.metrics.recallAtK.delta, 0);
  assert.equal(report.latency.candidate[1].changedRankings, 4);
  assert.equal(report.uniqueQueries, 4);
});

test("comparison rejects incompatible provenance and malformed observations", () => {
  for (const mutate of [
    report => { report.dataset.sha256 = "c".repeat(64); },
    report => { report.limit = 1; },
    report => { report.mode = "decomposition"; },
    report => { report.scoring = "source-only"; },
    report => { report.queries.pop(); },
    report => { report.queries.push(structuredClone(report.queries[0])); },
    report => { report.queries[0].relevantIds = ["different-label"]; },
    report => { report.queries[0].category = "different-category"; },
    report => { report.queries[0].recallMs = NaN; },
    report => { report.queries[0].recallMs = -1; },
    report => { report.queries[2].scores = [Infinity]; },
    report => { report.queries[2].scores = []; },
    report => { report.passes = 2; },
    report => { report.binarySha256 = "d".repeat(64); },
  ]) {
    const baseline = comparableReport();
    const candidate = structuredClone(baseline);
    mutate(candidate);
    assert.throws(() => compareReports(baseline, candidate, { resamples: 200 }));
  }
});

test("paired regression gates fail for quality losses and absent metric populations", () => {
  const candidate = comparableReport();
  const baseline = structuredClone(candidate);
  baseline.queries[0].rankedIds = ["fact-one"];
  baseline.queries[0].scores = [1];
  const report = compareReports(baseline, candidate, { resamples: 200, maxRecallDrop: 0 });
  assert.equal(report.gates.passed, false);
  assert.equal(report.metrics.recallAtK.regressed, 1);
  assert.equal(report.metrics.recallAtK.delta, -0.5);
  assert.equal(compareReports(baseline, candidate, { resamples: 200, maxRecallDrop: 0.5 }).gates.passed, true);
  baseline.queries = baseline.queries.slice(0, 2);
  candidate.queries = candidate.queries.slice(0, 2);
  assert.equal(compareReports(baseline, candidate, { resamples: 200, maxNoAnswerDrop: 0 }).gates.passed, false);
});

test("per-query regression gates reject losses hidden by unchanged averages", () => {
  const baseline = comparableReport();
  baseline.queries[0].rankedIds = ["fact-one"];
  baseline.queries[0].scores = [0.9];
  baseline.queries[2].rankedIds = [];
  baseline.queries[2].scores = [];
  const candidate = comparableReport();
  candidate.queries[1].rankedIds = ["fact-two"];
  candidate.queries[1].scores = [0.9];
  candidate.queries[3].rankedIds = [];
  candidate.queries[3].scores = [];
  const options = { resamples: 200, maxRecallDrop: 0, maxNoAnswerDrop: 0, maxRegressedQueries: 0 };
  const result = compareReports(baseline, candidate, options);
  assert.equal(result.metrics.recallAtK.delta, 0);
  assert.equal(result.metrics.noAnswerAccuracy.delta, 0);
  assert.equal(result.gates.passed, false);
  const gate = result.gates.checks.find(check => check.metric === "regressedQueries");
  assert.deepEqual(gate.queryIds, ["negative-one", "positive-one"]);
  assert.equal(gate.observedQueries, 2);
  assert.equal(compareReports(baseline, candidate, { ...options, maxRegressedQueries: 2 }).gates.passed, true);
  assert.equal(compareReports(baseline, baseline, options).gates.passed, true);
  for (const invalid of [-1, 0.5, NaN, Infinity, "0"]) {
    assert.throws(() => compareReports(baseline, candidate, { ...options, maxRegressedQueries: invalid }), /regressed queries/i);
  }
});

test("per-query gates retain fact-level losses even when ranking metrics are identical", () => {
  const baseline = comparableReport();
  baseline.queries[0].relevantIds = ["fact-one", "another-valid-fact"];
  baseline.queries[0].rankedIds = ["fact-one"];
  baseline.queries[0].scores = [0.9];
  const candidate = structuredClone(baseline);
  candidate.queries[0].rankedIds = ["another-valid-fact"];
  const result = compareReports(baseline, candidate, { resamples: 200, maxRegressedQueries: 0 });
  assert.equal(result.metrics.recallAtK.delta, 0);
  assert.equal(result.metrics.mrrAtK.delta, 0);
  assert.equal(result.gates.passed, false);
  const query = result.queries.find(query => query.id === "positive-one");
  assert.deepEqual(query.lostRelevantIds, ["fact-one"]);
  assert.equal(query.regressed, true);
});

test("per-query gates catch repeat-pass failures without inflating the quality population", () => {
  const baseline = comparableReport();
  baseline.queries[0].rankedIds = ["fact-one"];
  baseline.queries[0].scores = [0.9];
  const candidate = structuredClone(baseline);
  candidate.passes = 3;
  for (const pass of [2, 3]) {
    candidate.queries.push(...baseline.queries.map(query => ({
      ...query, pass,
      rankedIds: query.id === "positive-one" ? [] : query.rankedIds,
      scores: query.id === "positive-one" ? [] : query.scores,
    })));
  }
  const result = compareReports(baseline, candidate, { resamples: 200, maxRegressedQueries: 0 });
  assert.equal(result.qualityPass, 1);
  assert.equal(result.uniqueQueries, baseline.queries.length);
  assert.equal(result.metrics.recallAtK.delta, 0);
  assert.equal(result.gates.passed, false, "A good first pass must not conceal broken repeat recall");
  const gate = result.gates.checks.find(check => check.metric === "regressedQueries");
  assert.equal(gate.observedQueries, 1);
  assert.deepEqual(gate.queryIds, ["positive-one"]);
  const query = result.queries.find(query => query.id === "positive-one");
  assert.deepEqual(query.regressedPasses.map(item => [item.pass, item.baselinePass, item.lostRelevantIds]), [
    [2, 1, ["fact-one"]], [3, 1, ["fact-one"]],
  ]);
  assert.equal(compareReports(baseline, candidate, { resamples: 200, maxRegressedQueries: 1 }).gates.passed, true);
  assert.equal(compareReports(candidate, candidate, { resamples: 200, maxRegressedQueries: 0 }).gates.passed, true,
    "Compare corresponding baseline passes when they exist");
});

test("offline comparison CLI emits reports on pass and failure without server credentials", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "mindleak-comparison-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const baseline = comparableReport();
  baseline.queries[0].rankedIds = ["fact-one"];
  baseline.queries[0].scores = [0.9];
  const candidate = structuredClone(baseline);
  const baselinePath = join(directory, "baseline.json");
  const candidatePath = join(directory, "candidate.json");
  const script = fileURLToPath(new URL("./benchmark-compare.mjs", import.meta.url));
  writeFileSync(baselinePath, JSON.stringify(baseline));
  for (const expectedExit of [0, 1]) {
    if (expectedExit === 1) { candidate.queries[0].rankedIds = []; candidate.queries[0].scores = []; }
    writeFileSync(candidatePath, JSON.stringify(candidate));
    const result = spawnSync(process.execPath, [script, "--baseline", baselinePath, "--candidate", candidatePath,
      "--resamples", "200", "--seed", "0", "--max-recall-drop", "0", "--max-regressed-queries", "0"], { encoding: "utf8", timeout: 10000,
      env: { ...process.env, NODE_OPTIONS: "", MINDLEAK_TEST_DATABASE_URL: undefined } });
    assert.equal(result.status, expectedExit, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.gates.passed, expectedExit === 0);
    assert.equal(report.uncertainty.seed, 0);
    assert.equal(report.gates.checks.find(gate => gate.metric === "regressedQueries").observedQueries, expectedExit);
  }
  writeFileSync(candidatePath, "invalid-private-report-content");
  const invalid = spawnSync(process.execPath, [script, "--baseline", baselinePath, "--candidate", candidatePath],
    { encoding: "utf8", timeout: 10000 });
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.ok(!invalid.stderr.includes("invalid-private-report-content"));
  assert.match(execFileSync(process.execPath, [script, "--help"], { encoding: "utf8" }), /No server, model, or database/);
});

test("comparison rejects undeclared workload changes and pairs reordered reports explicitly", () => {
  const baseline = comparableReport();
  const candidate = structuredClone(baseline);
  candidate.workload = { concurrency: 4, querySeed: 12 };
  candidate.queries.reverse();
  assert.throws(() => compareReports(baseline, candidate), /Undeclared comparison changes/);
  const report = compareReports(baseline, candidate, {
    resamples: 200, allowChanges: ["concurrency", "querySeed", "queryOrder"],
  });
  assert.equal(report.metrics.recallAtK.delta, 0);
  assert.deepEqual(report.changes, ["concurrency", "querySeed", "queryOrder"]);
});

test("comparison requires runtime changes to be declared and reports missing legacy provenance", () => {
  const baseline = fingerprintedReport();
  baseline.runtime = { platform: "darwin", architecture: "arm64", node: "v22.0.0", availableParallelism: 8 };
  const candidate = structuredClone(baseline);
  candidate.runtime.node = "v22.1.0";
  assert.throws(() => compareReports(baseline, candidate, { resamples: 200 }), /Undeclared.*runtime/);
  const report = compareReports(baseline, candidate, { resamples: 200, allowChanges: ["runtime"] });
  assert.deepEqual(report.changes, ["runtime"]);
  assert.equal(report.audit.runtimeRecorded, true);
  const legacy = compareReports(comparableReport(), comparableReport(), { resamples: 200 });
  assert.equal(legacy.audit.runtimeRecorded, false);
});

test("offline corpus audit checks background identity, omissions, and byte-budget exit status", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "mindleak-corpus-audit-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const corpus = comparableCorpus().dataset;
  const background = { schemaVersion: 1, id: "background-audit",
    memories: [{ id: "background-fact", text: "An unused background fact." }],
    queries: [{ id: "background-query", category: "background", query: "Unused question?", relevantIds: ["background-fact"] }] };
  const corpusPath = join(directory, "corpus.json");
  const backgroundPath = join(directory, "background.json");
  const reportPath = join(directory, "report.json");
  const script = fileURLToPath(new URL("./benchmark-compare.mjs", import.meta.url));
  writeFileSync(corpusPath, JSON.stringify(corpus));
  writeFileSync(backgroundPath, JSON.stringify(background));
  for (const useBackground of [false, true]) {
    const report = fingerprintedReport();
    const fullCorpus = useBackground ? withBackground(corpus, background) : corpus;
    report.dataset.sha256 = createHash("sha256").update(JSON.stringify(fullCorpus)).digest("hex");
    writeFileSync(reportPath, JSON.stringify(report));
    const args = [script, "--baseline", reportPath, "--candidate", reportPath, "--dataset", corpusPath, "--resamples", "200"];
    if (useBackground) args.push("--background", backgroundPath);
    const run = maximum => spawnSync(process.execPath, [...args, "--max-result-bytes", String(maximum)],
      { encoding: "utf8", timeout: 10000, env: { ...process.env, NODE_OPTIONS: "" } });
    const success = run(128);
    assert.equal(success.status, 0, success.stderr);
    assert.equal(JSON.parse(success.stdout).audit.queryTextVerified, true);
    const oversized = run(127);
    assert.equal(oversized.status, 1);
    assert.equal(JSON.parse(oversized.stdout).gates.passed, false);
    report.queries.pop();
    report.querySet = querySetManifest(report.queries);
    writeFileSync(reportPath, JSON.stringify(report));
    const missing = run(128);
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.match(missing.stderr, /complete corpus query population/);
  }
});

test("new report validation rejects impossible payload measurements and invalid runtime metadata", () => {
  for (const mutate of [
    report => { report.queries[0].resultBytes = 1; },
    report => { report.queries[0].resultBytes = 2.5; },
    report => { report.queries[0].primaryTextBytes = 999; },
    report => { report.queries[0].primaryTextBytes = -1; },
    report => { delete report.queries[0].resultBytes; },
    report => { delete report.runtime; },
    report => { report.runtime.availableParallelism = 0; },
    report => { report.runtime.node = "invalid-version"; },
  ]) {
    const report = fingerprintedReport();
    mutate(report);
    assert.throws(() => compareReports(report, structuredClone(report), { resamples: 200 }));
  }
});
