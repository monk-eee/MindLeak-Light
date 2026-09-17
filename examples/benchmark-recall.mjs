import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { availableParallelism, tmpdir } from "node:os";
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

function factText(text) {
  return text.trim().replace(/\s+/g, " ").replace(/\.$/, "");
}

function memoryFacts(memory) {
  return memory.facts ?? [{ id: memory.id, text: memory.text }];
}

function verifiedFact(memory, text) {
  return memoryFacts(memory).find((fact) => [fact.text, ...fact.variants ?? []]
    .some((variant) => factText(variant) === factText(text)));
}

export function scoreDecomposition(memory, fragments) {
  if (!Array.isArray(fragments) || fragments.some((fragment) => typeof fragment !== "string" || !fragment.trim())) {
    throw new Error("Decomposition returned malformed fragments.");
  }
  const verifiedIds = new Set();
  const unverified = [];
  let duplicates = 0;
  for (const [index, text] of fragments.entries()) {
    const fact = verifiedFact(memory, text);
    if (!fact) {
      unverified.push({ rank: index + 1, sha256: createHash("sha256").update(text).digest("hex") });
    } else if (verifiedIds.has(fact.id)) {
      duplicates += 1;
    } else {
      verifiedIds.add(fact.id);
    }
  }
  return {
    id: memory.id,
    category: memory.category ?? "atomic",
    expectedFacts: memoryFacts(memory).length,
    returnedFragments: fragments.length,
    verifiedIds: [...verifiedIds],
    unverified,
    duplicateFragments: duplicates,
    missingIds: memoryFacts(memory).filter((fact) => !verifiedIds.has(fact.id)).map((fact) => fact.id),
    verifiedFactRecall: verifiedIds.size / memoryFacts(memory).length,
    verifiedFragmentPrecision: fragments.length ? verifiedIds.size / fragments.length : 0,
  };
}

export async function runDecompositionBenchmark(client, dataset, split = "evaluation") {
  validateDataset(dataset);
  if (!["all", "calibration", "evaluation"].includes(split)) throw new Error("Invalid query split.");
  const memories = dataset.memories.filter((memory) => memory.facts && (split === "all" || memory.split === split));
  if (!memories.length) throw new Error("No decomposition cases in the selected split.");
  const cases = [];
  for (const memory of memories) {
    const started = performance.now();
    let response;
    try {
      response = await client.callTool({ name: "decompose_memory", arguments: { text: memory.text } }, undefined, { timeout: 310000 });
    } catch {
      throw new Error(`MCP decompose_memory failed for case ${memory.id}; no extraction report was produced.`);
    }
    if (response?.isError || !Array.isArray(response?.structuredContent?.results)) {
      throw new Error(`MCP decompose_memory failed for case ${memory.id} or returned no structured fragments.`);
    }
    cases.push({ ...scoreDecomposition(memory, response.structuredContent.results), elapsedMs: performance.now() - started });
  }
  const summary = (items) => ({
    cases: items.length,
    verifiedFactRecall: items.reduce((sum, item) => sum + item.verifiedFactRecall, 0) / items.length,
    verifiedFragmentPrecision: items.reduce((sum, item) => sum + item.verifiedFragmentPrecision, 0) / items.length,
    unverifiedFragments: items.reduce((sum, item) => sum + item.unverified.length, 0),
    missingFacts: items.reduce((sum, item) => sum + item.missingIds.length, 0),
  });
  return {
    split,
    scoring: "verified-fact-variants",
    summary: summary(cases),
    byCategory: Object.fromEntries([...new Set(cases.map((item) => item.category))]
      .map((category) => [category, summary(cases.filter((item) => item.category === category))])),
    latency: latencySummary(cases.map((item) => item.elapsedMs)),
    cases,
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
  if (dataset.memories.some((memory) => !text(memory.text))) {
    throw new Error("Memory text must be nonempty and at most 32768 UTF-8 bytes.");
  }
  const facts = new Set();
  for (const memory of dataset.memories) {
    if (memory.facts !== undefined && (!identifier(memory.category) || !["calibration", "evaluation"].includes(memory.split))) {
      throw new Error("Decomposition cases need a category and calibration/evaluation split.");
    }
    if (!Array.isArray(memoryFacts(memory)) || !memoryFacts(memory).length) {
      throw new Error("Every memory needs at least one gold fact.");
    }
    const variants = new Set();
    for (const fact of memoryFacts(memory)) {
      if (!identifier(fact?.id) || facts.has(fact.id) || !text(fact.text)
        || (fact.variants !== undefined && (!Array.isArray(fact.variants) || fact.variants.some((variant) => !text(variant))))) {
        throw new Error("Gold facts need unique IDs, nonempty text, and valid accepted variants.");
      }
      facts.add(fact.id);
      for (const variant of [fact.text, ...fact.variants ?? []]) {
        const normalized = factText(variant);
        if (variants.has(normalized)) throw new Error("Fact variants must be unambiguous within each memory.");
        variants.add(normalized);
      }
    }
  }
  const querySplits = new Map();
  const targetSplits = new Map();
  const familySplits = new Map();
  for (const query of dataset.queries) {
    if (!text(query.query) || !identifier(query.category)) {
      throw new Error("Queries need nonempty text and a valid category.");
    }
    if (query.group !== undefined && !identifier(query.group)) throw new Error("Query groups must be short identifiers.");
    if (!Array.isArray(query.relevantIds)
      || new Set(query.relevantIds).size !== query.relevantIds.length
      || query.relevantIds.some((identifier) => !facts.has(identifier))) {
      throw new Error("Relevance labels must be unique fact IDs from the corpus; use [] for unanswerable queries.");
    }
    if (query.split !== undefined && !["calibration", "evaluation"].includes(query.split)) {
      throw new Error("Query split must be calibration or evaluation.");
    }
    if (query.split !== undefined) {
      for (const target of query.relevantIds) {
        if (targetSplits.has(target) && targetSplits.get(target) !== query.split) {
          throw new Error("Calibration and evaluation gold targets must be disjoint.");
        }
        targetSplits.set(target, query.split);
      }
      if (query.group !== undefined) {
        if (familySplits.has(query.group) && familySplits.get(query.group) !== query.split) {
          throw new Error("A declared query family cannot cross calibration and evaluation splits.");
        }
        familySplits.set(query.group, query.split);
      }
    }
    const normalized = query.query.trim().replace(/\s+/g, " ").toLowerCase();
    if (querySplits.has(normalized) && querySplits.get(normalized) !== query.split) {
      throw new Error("The same query cannot appear in different splits.");
    }
    querySplits.set(normalized, query.split);
  }
  return dataset;
}

export function withBackground(dataset, background) {
  validateDataset(dataset);
  validateDataset(background);
  return validateDataset({
    ...dataset,
    sources: [...dataset.sources ?? [], ...background.sources ?? []],
    memories: [...dataset.memories, ...background.memories],
  });
}

function latencySummary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    count: sorted.length,
    meanMs: sorted.length ? sorted.reduce((sum, value) => sum + value, 0) / sorted.length : null,
    p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Ms: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    minMs: sorted[0] ?? null,
    maxMs: sorted.at(-1) ?? null,
  };
}

export function querySetManifest(queries) {
  const identities = queries.map(query => [query.id, query.querySha256, query.category,
    query.split ?? "unspecified", query.group ?? query.id, [...query.relevantIds].sort()]);
  identities.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return { count: identities.length, sha256: createHash("sha256").update(JSON.stringify(identities)).digest("hex") };
}

export function verifyQuerySet(report) {
  if (report.reportVersion !== 5 && report.querySet === undefined) return false;
  if (!Array.isArray(report.queries) || !report.queries.length
    || (report.reportVersion === 5 && report.qualityPass !== 1)
    || report.queries.some(query => typeof query.querySha256 !== "string" || !/^[a-f0-9]{64}$/.test(query.querySha256))) {
    throw new Error("Report is missing query fingerprints required by its query-set manifest.");
  }
  const actual = querySetManifest(report.queries.filter(query => (query.pass ?? 1) === 1));
  if (report.querySet?.count !== actual.count || report.querySet?.sha256 !== actual.sha256) {
    throw new Error("Report observations do not match the planned query-set manifest.");
  }
  return true;
}

export function responseSizeSummary(values) {
  if (values.some(value => !Number.isSafeInteger(value) || value < 2)) throw new Error("Result sizes must be integer byte counts of JSON arrays.");
  const sorted = [...values].sort((left, right) => left - right);
  const totalBytes = sorted.reduce((sum, value) => sum + value, 0);
  return { count: sorted.length, totalBytes, meanBytes: sorted.length ? totalBytes / sorted.length : null,
    p50Bytes: sorted[Math.ceil(sorted.length * 0.5) - 1] ?? null,
    p95Bytes: sorted[Math.ceil(sorted.length * 0.95) - 1] ?? null,
    p99Bytes: sorted[Math.ceil(sorted.length * 0.99) - 1] ?? null,
    minBytes: sorted[0] ?? null, maxBytes: sorted.at(-1) ?? null };
}

export async function runBenchmark(client, dataset, { limit = 5, split = "all", passes = 1,
  concurrency = 1, querySeed = null, agentId = `recall-benchmark-${randomUUID()}` } = {}) {
  validateDataset(dataset);
  validateLimit(limit);
  if (!Number.isInteger(passes) || passes < 1 || passes > 10) throw new Error("Passes must be an integer in 1..10.");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) throw new Error("Concurrency must be an integer in 1..32.");
  if (querySeed !== null && (!Number.isInteger(querySeed) || querySeed < 0 || querySeed > 0xffffffff)) {
    throw new Error("Query seed must be a uint32 integer.");
  }
  if (!["all", "calibration", "evaluation"].includes(split)) throw new Error("Invalid query split.");
  const selectedQueries = dataset.queries.filter((query) => split === "all" || query.split === split);
  if (!selectedQueries.length) throw new Error("The selected split contains no queries.");
  const queryIdentities = new Map(selectedQueries.map(query => [query.id, {
    id: query.id, category: query.category, group: query.group ?? query.id, split: query.split ?? "unspecified",
    relevantIds: query.relevantIds, querySha256: createHash("sha256").update(query.query).digest("hex"),
  }]));
  const querySet = querySetManifest([...queryIdentities.values()]);
  if (typeof agentId !== "string" || !agentId.trim() || Buffer.byteLength(agentId, "utf8") > 256) {
    throw new Error("Benchmark agent ID must be nonempty and at most 256 UTF-8 bytes.");
  }
  const call = async (name, args, identifier) => {
    let response;
    try {
      response = await client.callTool({ name, arguments: args }, undefined, { timeout: 610000 });
    } catch {
      throw new Error(`MCP ${name} failed for ${identifier}; no benchmark report was produced.`);
    }
    if (response?.isError || !response?.structuredContent) {
      throw new Error(`MCP ${name} failed for ${identifier} or returned no structured content.`);
    }
    return response.structuredContent;
  };

  const memoryIds = new Map();
  const factSources = new Map(dataset.memories.flatMap((memory) => memoryFacts(memory).map((fact) => [fact.id, memory.id])));
  const writeTimes = [];
  for (const memory of dataset.memories) {
    const started = performance.now();
    const written = await call("write_memory", { agentId, text: memory.text }, memory.id);
    writeTimes.push(performance.now() - started);
    if (typeof written.memoryId !== "string" || !written.memoryId.trim() || memoryIds.has(written.memoryId)) {
      throw new Error("Memory writes must return distinct, nonempty IDs.");
    }
    memoryIds.set(written.memoryId, memory);
  }

  const executeQuery = async (query, pass) => {
    const started = performance.now();
    const response = await call("recall_memory", { query: query.query, agentId, limit }, query.id);
    const recallMs = performance.now() - started;
    if (!Array.isArray(response.results) || response.results.length > limit) {
      throw new Error("Recall returned a malformed or oversized ranking.");
    }
    const fragments = new Set();
    const unverifiedRanks = [];
    const rankedMemoryIds = [];
    const rankedIds = response.results.map((result, index) => {
      if (!result || result.agentId !== agentId || !memoryIds.has(result.memoryId)) {
        throw new Error("Recall returned a memory outside this benchmark run.");
      }
      if (typeof result.fragmentId !== "string" || !result.fragmentId.trim()
        || fragments.has(result.fragmentId) || !Number.isFinite(result.score)
        || typeof result.text !== "string" || !result.text.trim()) {
        throw new Error("Recall returned malformed or duplicate fragments.");
      }
      fragments.add(result.fragmentId);
      const memory = memoryIds.get(result.memoryId);
      rankedMemoryIds.push(memory.id);
      const matched = verifiedFact(memory, result.text);
      if (matched) return matched.id;
      unverifiedRanks.push(index + 1);
      return `unverified:${index + 1}`;
    });
    return {
      ...queryIdentities.get(query.id),
      pass,
      rankedIds,
      rankedMemoryIds,
      unverifiedRanks,
      sourceMetrics: scoreRanking(rankedMemoryIds, query.relevantIds.map((identifier) => factSources.get(identifier)), limit),
      scores: response.results.map((result) => result.score),
      recallMs,
      resultBytes: Buffer.byteLength(JSON.stringify(response.results), "utf8"),
      primaryTextBytes: response.results.reduce((total, result) => total + Buffer.byteLength(result.text, "utf8"), 0),
      missedIds: query.relevantIds.filter((identifier) => !rankedIds.includes(identifier)),
      ...scoreRanking(rankedIds, query.relevantIds, limit),
    };
  };
  const queries = [];
  const passMeasurements = [];
  for (let pass = 1; pass <= passes; pass += 1) {
    const ordered = querySeed === null ? selectedQueries : selectedQueries
      .map(query => ({ query, key: createHash("sha256").update(`${querySeed}:${pass}:${query.id}`).digest("hex") }))
      .sort((left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0)
      .map(({ query }) => query);
    const rows = new Array(ordered.length);
    let next = 0;
    let failure = null;
    const started = performance.now();
    await Promise.all(Array.from({ length: Math.min(concurrency, ordered.length) }, async () => {
      while (next < ordered.length && failure === null) {
        const position = next++;
        try { rows[position] = await executeQuery(ordered[position], pass); }
        catch (error) { failure ??= error; }
      }
    }));
    if (failure !== null) throw failure;
    const elapsedMs = performance.now() - started;
    passMeasurements.push({ elapsedMs, completed: rows.length,
      throughputQps: elapsedMs > 0 ? rows.length * 1000 / elapsedMs : null,
      queryOrderSha256: createHash("sha256").update(JSON.stringify(ordered.map(query => query.id))).digest("hex") });
    queries.push(...rows);
  }
  const qualityQueries = queries.filter((query) => query.pass === 1);
  const categories = [...new Set(qualityQueries.map((query) => query.category))];
  return {
    agentId,
    limit,
    split,
    passes,
    qualityPass: 1,
    querySet,
    workload: { concurrency, querySeed, ordering: querySeed === null ? "fixture" : "seeded-per-pass" },
    scoring: "verified-fact-variants",
    latency: { write: latencySummary(writeTimes), recall: latencySummary(queries.map((query) => query.recallMs)) },
    responseSize: responseSizeSummary(qualityQueries.map(query => query.resultBytes)),
    summary: summarizeQueries(qualityQueries),
    sourceSummary: summarizeQueries(qualityQueries.map((query) => query.sourceMetrics)),
    unverifiedFragments: qualityQueries.reduce((total, query) => total + query.unverifiedRanks.length, 0),
    byCategory: Object.fromEntries(categories.map((category) => [
      category, summarizeQueries(qualityQueries.filter((query) => query.category === category)),
    ])),
    byPass: Array.from({ length: passes }, (_, index) => {
      const rows = queries.filter((query) => query.pass === index + 1);
      return { pass: index + 1, ...passMeasurements[index], summary: summarizeQueries(rows),
        latency: latencySummary(rows.map((query) => query.recallMs)), responseSize: responseSizeSummary(rows.map(query => query.resultBytes)) };
    }),
    queries,
  };
}

export function calibrateSimilarity(report, minimumRecall = 0.8, limit = 5) {
  if (!Number.isFinite(minimumRecall) || minimumRecall < 0 || minimumRecall > 1) {
    throw new Error("Calibration minimum recall must be in 0..1.");
  }
  if (![3, 4, 5].includes(report?.reportVersion) || report.scoring !== "verified-fact-variants" || report.split !== "calibration"
    || report.configuration?.retrieval !== "vector" || report.configuration.minSimilarity !== null
    || (report.configuration.relevance ?? "off") !== "off"
    || (report.passes ?? 1) !== 1
    || !Array.isArray(report.queries) || !report.queries.length) {
    throw new Error("Calibration requires an unfiltered vector report from the calibration split only.");
  }
  validateLimit(limit);
  if (report.limit !== 50) throw new Error("Calibration requires the full candidate capture: run with --k 50.");
  const scores = new Set();
  const queryIds = new Set();
  for (const query of report.queries) {
    if (query.split !== "calibration" || (query.pass ?? 1) !== 1 || typeof query.id !== "string"
      || !query.id.trim() || queryIds.has(query.id) || !Array.isArray(query.scores)
      || query.scores.length !== query.rankedIds?.length
      || query.rankedIds.length > 50
      || query.scores.some((score) => !Number.isFinite(score) || score < -1 || score > 1)) {
      throw new Error("Calibration report contains invalid scores or non-calibration queries.");
    }
    queryIds.add(query.id);
    scoreRanking(query.rankedIds, query.relevantIds, report.limit);
    for (const score of query.scores) scores.add(score);
  }
  verifyQuerySet(report);
  if (!report.queries.some((query) => query.relevantIds.length)
    || !report.queries.some((query) => !query.relevantIds.length)) {
    throw new Error("Calibration needs both answerable and unanswerable queries.");
  }
  const ordered = [...scores].sort((left, right) => left - right);
  const thresholds = [-1, ...ordered.slice(1).map((score, index) => (score + ordered[index]) / 2), 1];
  const candidates = thresholds.map((minimum) => ({
    minSimilarity: minimum,
    summary: summarizeQueries(report.queries.map((query) => scoreRanking(
      query.rankedIds.filter((identifier, index) => query.scores[index] >= minimum),
      query.relevantIds,
      limit,
    ))),
  }));
  const eligible = candidates.filter((candidate) => candidate.summary.recallAtK >= minimumRecall);
  eligible.sort((left, right) => right.summary.noAnswerAccuracy - left.summary.noAnswerAccuracy
    || right.summary.recallAtK - left.summary.recallAtK
    || right.summary.mrrAtK - left.summary.mrrAtK
    || left.minSimilarity - right.minSimilarity);
  if (!eligible.length) throw new Error("No calibration threshold meets the requested recall floor.");
  return {
    calibrationVersion: 2,
    dataset: report.dataset,
    binarySha256: report.binarySha256,
    embeddingModel: report.configuration.embeddingModel,
    embeddingDimensions: report.configuration.embeddingDimensions,
    limit,
    candidateLimit: report.limit,
    minimumRecall,
    queryIds: report.queries.map((query) => query.id),
    ...eligible[0],
    candidates,
  };
}

function numericOption(value, name, minimum, maximum) {
  if (value === undefined) return null;
  const number = Number(value);
  if (typeof value !== "string" || !value.trim() || !Number.isFinite(number)
    || number < minimum || number > maximum) {
    throw new Error(`${name} must be a number in ${minimum}..${maximum}.`);
  }
  return number;
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
  const passes = numericOption(options.passes, "--passes", 1, 10) ?? 1;
  if (!Number.isInteger(passes)) throw new Error("Passes must be an integer in 1..10.");
  const concurrency = numericOption(options.concurrency, "--concurrency", 1, 32) ?? 1;
  const querySeed = numericOption(options["query-seed"], "--query-seed", 0, 0xffffffff);
  if (!Number.isInteger(concurrency) || (querySeed !== null && !Number.isInteger(querySeed))) {
    throw new Error("Concurrency and query seed must be integers.");
  }
  const maxWarmP95 = numericOption(options["max-warm-p95-ms"], "--max-warm-p95-ms", 0.01, 600000);
  if (maxWarmP95 !== null && passes < 2) throw new Error("A warm latency gate requires at least two passes.");
  const decomposition = options.decomposition ?? "sentences";
  const retrieval = options.retrieval ?? "keyword";
  if (!["sentences", "openai"].includes(decomposition) || !["keyword", "vector", "hybrid"].includes(retrieval)) {
    throw new Error("Choose --decomposition sentences|openai and --retrieval keyword|vector|hybrid.");
  }
  const relevance = options.relevance ?? "off";
  if (!["off", "openai"].includes(relevance)) throw new Error("Choose --relevance off|openai.");
  const formation = options.formation ?? "off";
  if (!["off", "openai"].includes(formation)) throw new Error("Choose --formation off|openai.");
  const relevanceCandidates = numericOption(options["relevance-candidates"], "--relevance-candidates", 1, 50) ?? 20;
  if (!Number.isInteger(relevanceCandidates)) throw new Error("Relevance candidate count must be an integer.");
  if (options["relevance-candidates"] !== undefined && relevance === "off") {
    throw new Error("--relevance-candidates requires --relevance openai.");
  }
  const reasoningEffort = (name, enabled) => {
    const value = options[name];
    if (value === undefined) return null;
    if (!enabled || !["none", "low", "medium", "high", "max"].includes(value)) {
      throw new Error(`--${name} requires an enabled chat provider and none|low|medium|high|max.`);
    }
    return value;
  };
  const decompositionReasoningEffort = reasoningEffort("decomposition-reasoning-effort", decomposition === "openai");
  const relevanceReasoningEffort = reasoningEffort("relevance-reasoning-effort", relevance === "openai");
  const formationReasoningEffort = reasoningEffort("formation-reasoning-effort", formation === "openai");
  if (formationReasoningEffort !== null && decompositionReasoningEffort !== null && formationReasoningEffort !== decompositionReasoningEffort) {
    throw new Error("Formation and decomposition share one provider reasoning setting; conflicting options are invalid.");
  }
  const label = options.label ?? `${decomposition}-${retrieval}`;
  if (!/^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(label)) {
    throw new Error("Benchmark label must be a short identifier.");
  }
  const minimumRecall = numericOption(options["min-recall"], "--min-recall", 0, 1);
  const minimumNoAnswer = numericOption(options["min-no-answer"], "--min-no-answer", 0, 1);
  const maxResultBytes = numericOption(options["max-result-bytes"], "--max-result-bytes", 0, 64 * 1024 * 1024);
  if (maxResultBytes !== null && !Number.isSafeInteger(maxResultBytes)) throw new Error("Result byte budget must be an integer.");
  const minSimilarity = numericOption(options["min-similarity"], "--min-similarity", -1, 1);
  if (minSimilarity !== null && retrieval === "keyword") throw new Error("A similarity floor requires vector or hybrid retrieval.");
  const split = options.split ?? "evaluation";
  if (!["all", "calibration", "evaluation"].includes(split)) throw new Error("Invalid query split.");
  const timeout = Number(environment.MINDLEAK_MODEL_TIMEOUT_SECS ?? 60);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 300) {
    throw new Error("MINDLEAK_MODEL_TIMEOUT_SECS must be an integer in 1..300.");
  }
  const serverEnvironment = {
    MINDLEAK_DATABASE_URL: databaseUrl,
    MINDLEAK_DECOMPOSITION: decomposition,
    MINDLEAK_RETRIEVAL: retrieval,
    MINDLEAK_RELEVANCE: relevance,
    MINDLEAK_DB_POOL_SIZE: "8",
    MINDLEAK_MODEL_TIMEOUT_SECS: String(timeout),
  };
  if (minSimilarity !== null) serverEnvironment.MINDLEAK_RECALL_MIN_SIMILARITY = String(minSimilarity);
  if (decompositionReasoningEffort !== null) serverEnvironment.MINDLEAK_LLM_REASONING_EFFORT = decompositionReasoningEffort;
  if (relevanceReasoningEffort !== null) serverEnvironment.MINDLEAK_RELEVANCE_REASONING_EFFORT = relevanceReasoningEffort;
  if (formationReasoningEffort !== null) serverEnvironment.MINDLEAK_LLM_REASONING_EFFORT = formationReasoningEffort;
  if (options.formation !== undefined) serverEnvironment.MINDLEAK_FORMATION = formation;
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
  const formationModel = formation === "openai"
    ? provider("MINDLEAK_LLM_URL", "MINDLEAK_MODEL", "MINDLEAK_LLM_API_KEY") : null;
  const relevanceModel = relevance === "openai"
    ? provider("MINDLEAK_RELEVANCE_URL", "MINDLEAK_RELEVANCE_MODEL", "MINDLEAK_RELEVANCE_API_KEY")
    : null;
  if (relevanceModel) serverEnvironment.MINDLEAK_RELEVANCE_CANDIDATES = String(relevanceCandidates);
  let embeddingModel = null;
  let embeddingDimensions = null;
  if (retrieval !== "keyword") {
    embeddingModel = provider("MINDLEAK_EMBED_URL", "MINDLEAK_EMBED_MODEL", "MINDLEAK_EMBED_API_KEY");
    embeddingDimensions = Number(environment.MINDLEAK_EMBED_DIMENSIONS);
    if (!Number.isInteger(embeddingDimensions) || embeddingDimensions < 1 || embeddingDimensions > 2000) {
      throw new Error("MINDLEAK_EMBED_DIMENSIONS must be an integer in 1..2000.");
    }
    serverEnvironment.MINDLEAK_EMBED_DIMENSIONS = String(embeddingDimensions);
  }
  return {
    limit,
    split,
    passes,
    concurrency,
    querySeed,
    maxWarmP95,
    minimumRecall,
    minimumNoAnswer,
    maxResultBytes,
    serverEnvironment,
    configuration: { label, decomposition, retrieval, minSimilarity, decompositionModel, embeddingModel, embeddingDimensions,
      relevance, relevanceModel, relevanceCandidates: relevanceModel ? relevanceCandidates : null, modelTimeoutSecs: timeout,
      ...(options.formation !== undefined ? { formation, formationModel } : {}) },
    reasoning: { decomposition: decompositionReasoningEffort, relevance: relevanceReasoningEffort,
      ...(options.formation !== undefined ? { formation: formationReasoningEffort } : {}) },
  };
}

async function main() {
  let values;
  try {
    ({ values } = parseArgs({
      options: {
        help: { type: "boolean", short: "h" },
        dataset: { type: "string" },
        background: { type: "string" },
        binary: { type: "string" },
        k: { type: "string" },
        decomposition: { type: "string" },
        retrieval: { type: "string" },
        relevance: { type: "string" },
        "relevance-candidates": { type: "string" },
        "decomposition-reasoning-effort": { type: "string" },
        "relevance-reasoning-effort": { type: "string" },
        passes: { type: "string" },
        concurrency: { type: "string" },
        "query-seed": { type: "string" },
        "max-warm-p95-ms": { type: "string" },
        label: { type: "string" },
        "min-recall": { type: "string" },
        "min-no-answer": { type: "string" },
        "max-result-bytes": { type: "string" },
        "min-similarity": { type: "string" },
        split: { type: "string" },
        calibrate: { type: "string" },
        "calibration-min-recall": { type: "string" },
        "calibration-k": { type: "string" },
        "extraction-only": { type: "boolean" },
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

  --dataset PATH              Labelled JSON corpus (default: fixtures/recall-v2.json)
  --background PATH           Additional distractor memories; its queries are never executed
  --binary PATH               Native server executable (default: target/debug/mindleak-light)
  --k NUMBER                  Ranking cutoff, 1..50 (default: 5)
  --decomposition MODE        sentences (default) or openai
  --retrieval MODE            keyword (default), vector, or hybrid
  --relevance MODE            off (default) or openai candidate relevance filtering
  --relevance-candidates N    Candidate budget, 1..50 (default: 20; at least k)
  --decomposition-reasoning-effort MODE  Explicit chat reasoning effort (provider support required)
  --relevance-reasoning-effort MODE      none, low, medium, high, or max; omitted by default
  --passes N                 Repeat the selected queries without reingesting, 1..10 (default: 1)
  --concurrency N            In-flight recall requests, 1..32 (default: 1)
  --query-seed N             Reproducible uint32 per-pass query order (default: fixture order)
  --max-warm-p95-ms N         Fail if any pass after the first exceeds this p95 latency
  --split NAME                evaluation (default), calibration, or all
  --min-similarity NUMBER     Explicit cosine floor for vector candidates, -1..1
  --label NAME                Identifier recorded in the report
  --min-recall NUMBER         Exit nonzero if macro Recall@k is below this value
  --min-no-answer NUMBER      Exit nonzero if no-answer accuracy is below this value
  --max-result-bytes N        Fail if any result array exceeds this UTF-8 JSON byte budget
  --calibrate REPORT          Select a cosine floor from a calibration vector report; no server needed
  --calibration-min-recall N   Recall floor during calibration (default: 0.8)
  --calibration-k N           Deployment cutoff, 1..50 (default: 5); capture input with --k 50
  --extraction-only           Preview labelled multi-fact cases without writing memories

Enabled model modes require their MINDLEAK_* provider variables explicitly.
JSON reports go to stdout; progress and errors go to stderr. See docs/BENCHMARKS.md.`);
    return;
  }

  if (values.calibrate) {
    if (Object.keys(values).some((key) => !["calibrate", "calibration-min-recall", "calibration-k"].includes(key))) {
      throw new Error("--calibrate only accepts --calibration-min-recall and --calibration-k alongside it.");
    }
    const minimum = numericOption(values["calibration-min-recall"], "--calibration-min-recall", 0, 1) ?? 0.8;
    const limit = numericOption(values["calibration-k"], "--calibration-k", 1, 50) ?? 5;
    let report;
    try {
      report = JSON.parse(await readFile(values.calibrate, "utf8"));
    } catch {
      throw new Error("Cannot read calibration report JSON.");
    }
    console.log(JSON.stringify(calibrateSimilarity(report, minimum, limit), null, 2));
    return;
  }
  if (values["calibration-min-recall"] !== undefined) throw new Error("--calibration-min-recall requires --calibrate.");
  if (values["calibration-k"] !== undefined) throw new Error("--calibration-k requires --calibrate.");
  if (values["extraction-only"] && (values.retrieval && values.retrieval !== "keyword"
    || values["min-recall"] !== undefined || values["min-no-answer"] !== undefined || values["min-similarity"] !== undefined
    || values["max-result-bytes"] !== undefined
    || values.background !== undefined || values.relevance !== undefined || values["relevance-candidates"] !== undefined)) {
    throw new Error("--extraction-only does not accept retrieval modes or ranking quality gates.");
  }
  const settings = benchmarkSettings(process.env, values);
  if (values["extraction-only"] && (values.passes !== undefined || values["max-warm-p95-ms"] !== undefined
    || values.concurrency !== undefined || values["query-seed"] !== undefined)) {
    throw new Error("Extraction-only mode does not accept recall pass or latency settings.");
  }
  const corpusPath = values.dataset ?? new URL("./fixtures/recall-v2.json", import.meta.url);
  let corpusSource = await readFile(corpusPath);
  let dataset;
  try {
    dataset = JSON.parse(corpusSource.toString("utf8"));
  } catch {
    throw new Error("Cannot parse benchmark dataset JSON.");
  }
  validateDataset(dataset);
  const inputs = [{ id: dataset.id, sha256: createHash("sha256").update(corpusSource).digest("hex") }];
  if (values.background) {
    let background;
    let source;
    try {
      source = await readFile(values.background);
      background = JSON.parse(source.toString("utf8"));
    } catch {
      throw new Error("Cannot read background corpus JSON.");
    }
    dataset = withBackground(dataset, background);
    inputs.push({ id: background.id, sha256: createHash("sha256").update(source).digest("hex") });
    corpusSource = Buffer.from(JSON.stringify(dataset));
  }
  const root = fileURLToPath(new URL("../", import.meta.url));
  const binary = resolve(values.binary ?? join(root, "target", "debug", `mindleak-light${process.platform === "win32" ? ".exe" : ""}`));
  let binaryDigest;
  let binaryBytes;
  try {
    binaryBytes = await readFile(binary);
    binaryDigest = createHash("sha256").update(binaryBytes).digest("hex");
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
  const executable = join(directory, process.platform === "win32" ? "mindleak-benchmark.exe" : "mindleak-benchmark");
  const client = new Client({ name: "mindleak-light-recall-benchmark", version: "1.0.0" });
  const transport = new StdioClientTransport({
    command: executable,
    args: ["--transport", "stdio"],
    cwd: directory,
    env: settings.serverEnvironment,
    stderr: "ignore",
  });
  let report;
  try {
    await writeFile(executable, binaryBytes, { mode: 0o700, flag: "wx" });
    await writeFile(join(directory, ".env"), "");
    try {
      await client.connect(transport, { timeout: 30000 });
    } catch {
      throw new Error("Could not start the benchmark MCP server; check the binary and explicit test database settings.");
    }
    const agentId = `recall-benchmark-${randomUUID()}`;
    console.error(`Benchmark ${settings.configuration.label}: ${dataset.memories.length} memories, ${dataset.queries.length} queries; namespace ${agentId}.`);
    const result = values["extraction-only"]
      ? await runDecompositionBenchmark(client, dataset, settings.split)
      : await runBenchmark(client, dataset, { limit: settings.limit, split: settings.split, passes: settings.passes,
        concurrency: settings.concurrency, querySeed: settings.querySeed, agentId });
    report = {
      reportVersion: 5,
      mode: values["extraction-only"] ? "decomposition" : "recall",
      createdAt: new Date().toISOString(),
      dataset: {
        id: dataset.id,
        sha256: createHash("sha256").update(corpusSource).digest("hex"),
        memories: dataset.memories.length,
        queries: dataset.queries.length,
        inputs,
      },
      server: client.getServerVersion(),
      binarySha256: binaryDigest,
      runtime: { platform: process.platform, architecture: process.arch, node: process.version,
        availableParallelism: availableParallelism() },
      configuration: settings.configuration,
      reasoning: settings.reasoning,
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
  if (settings.minimumNoAnswer !== null
    && (report.summary.noAnswerAccuracy === null || report.summary.noAnswerAccuracy < settings.minimumNoAnswer)) {
    console.error(`No-answer accuracy did not meet --min-no-answer ${settings.minimumNoAnswer}.`);
    process.exitCode = 1;
  }
  if (settings.maxWarmP95 !== null && report.byPass.slice(1).some((pass) =>
    pass.latency.p95Ms === null || pass.latency.p95Ms > settings.maxWarmP95)) {
    console.error(`Warm recall p95 exceeded ${settings.maxWarmP95} ms.`);
    process.exitCode = 1;
  }
  if (settings.maxResultBytes !== null && report.queries.some(query => query.resultBytes > settings.maxResultBytes)) {
    console.error(`Recall result size exceeded ${settings.maxResultBytes} bytes.`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
