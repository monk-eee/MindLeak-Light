import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { benchmarkSettings, calibrateSimilarity, runBenchmark, runDecompositionBenchmark, scoreDecomposition, scoreRanking, summarizeQueries, validateDataset, withBackground } from "./benchmark-recall.mjs";

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
    limit: 5,
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
