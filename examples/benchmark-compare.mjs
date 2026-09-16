import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { scoreRanking } from "./benchmark-recall.mjs";

const metrics = {
  precisionAtK: "precisionAtK", recallAtK: "recallAtK", mrrAtK: "reciprocalRankAtK",
  ndcgAtK: "ndcgAtK", hitRateAtK: "hitAtK", noAnswerAccuracy: "noAnswerCorrect",
};
const configurationKeys = [
  "decomposition", "retrieval", "minSimilarity", "decompositionModel", "embeddingModel",
  "embeddingDimensions", "relevance", "relevanceModel", "relevanceCandidates", "modelTimeoutSecs",
];
const changeKeys = [...configurationKeys, "binary", "decompositionReasoningEffort", "relevanceReasoningEffort",
  "concurrency", "querySeed", "queryOrder"];
const identifier = (value) => typeof value === "string" && /^[a-z0-9][a-z0-9_.-]{0,127}$/i.test(value);
const digest = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

function configuration(report) {
  const values = Object.fromEntries(configurationKeys.map((key) => [key, report.configuration?.[key] ?? null]));
  values.relevance ??= "off";
  return { ...values, binary: report.binarySha256,
    decompositionReasoningEffort: report.reasoning?.decomposition ?? null,
    relevanceReasoningEffort: report.reasoning?.relevance ?? null,
    concurrency: report.workload?.concurrency ?? 1, querySeed: report.workload?.querySeed ?? null,
    queryOrder: createHash("sha256").update(JSON.stringify(report.queries
      .filter(query => (query.pass ?? 1) === 1).map(query => query.id))).digest("hex") };
}

function observations(report) {
  if (![3, 4].includes(report?.reportVersion) || report.mode !== "recall"
    || report.scoring !== "verified-fact-variants" || !digest(report.dataset?.sha256)
    || !digest(report.binarySha256) || !["all", "calibration", "evaluation"].includes(report.split)
    || !Array.isArray(report.queries) || !report.queries.length
    || !["sentences", "openai"].includes(report.configuration?.decomposition)
    || !["keyword", "vector", "hybrid"].includes(report.configuration?.retrieval)) {
    throw new Error("Comparison requires complete fact-scored recall reports with corpus and binary hashes.");
  }
  scoreRanking([], [], report.limit);
  const passes = report.passes ?? 1;
  if (!Number.isInteger(passes) || passes < 1 || passes > 10) throw new Error("Invalid report pass count.");
  const indexed = Array.from({ length: passes }, () => new Map());
  for (const query of report.queries) {
    const pass = query?.pass ?? 1;
    if (!identifier(query?.id) || !identifier(query.category) || !identifier(query.group ?? query.id)
      || !Number.isInteger(pass) || pass < 1 || pass > passes || indexed[pass - 1].has(query.id)
      || !["calibration", "evaluation", "unspecified"].includes(query.split)
      || (report.split !== "all" && query.split !== report.split)
      || !Number.isFinite(query.recallMs) || query.recallMs < 0
      || !Array.isArray(query.rankedIds) || query.rankedIds.length > report.limit
      || !Array.isArray(query.relevantIds) || new Set(query.relevantIds).size !== query.relevantIds.length
      || !Array.isArray(query.scores) || query.scores.length !== query.rankedIds.length
      || query.scores.some((score) => !Number.isFinite(score) || score < -1 || score > 1)) {
      throw new Error("Invalid, duplicate, or incomplete query observation in comparison report.");
    }
    indexed[pass - 1].set(query.id, { ...query, group: query.group ?? query.id,
      metrics: scoreRanking(query.rankedIds, query.relevantIds, report.limit) });
  }
  const identity = (query) => [query.category, query.split, query.group, [...query.relevantIds].sort()];
  for (const pass of indexed) {
    if (pass.size !== indexed[0].size || [...indexed[0]].some(([id, query]) =>
      !pass.has(id) || !same(identity(query), identity(pass.get(id))))) {
      throw new Error("Every pass must contain the same distinct query IDs and labels.");
    }
  }
  return { passes: indexed, first: indexed[0], identity };
}

function randomIndex(seed) {
  let counter = 0;
  let offset = 32;
  let block;
  return (length) => {
    if (offset === 32) {
      block = createHash("sha256").update(`${seed}:${counter++}`).digest();
      offset = 0;
    }
    const value = block.readUInt32LE(offset);
    offset += 4;
    return Math.floor(value / 0x100000000 * length);
  };
}

function percentile(sorted, probability) {
  return sorted[Math.max(0, Math.ceil(sorted.length * probability) - 1)] ?? null;
}

function pairedMetric(pairs, field, resamples, seed) {
  const rows = pairs.filter(({ baseline }) => baseline.metrics[field] !== null);
  if (!rows.length) return { queries: 0, groups: 0, baseline: null, candidate: null, delta: null,
    improved: 0, regressed: 0, unchanged: 0, interval95: null };
  const grouped = new Map();
  let baseline = 0;
  let candidate = 0;
  let improved = 0;
  let regressed = 0;
  for (const pair of rows) {
    const before = Number(pair.baseline.metrics[field]);
    const after = Number(pair.candidate.metrics[field]);
    baseline += before;
    candidate += after;
    if (after > before + 1e-12) improved += 1;
    if (after < before - 1e-12) regressed += 1;
    const group = grouped.get(pair.baseline.group) ?? { total: 0, count: 0 };
    group.total += after - before;
    group.count += 1;
    grouped.set(pair.baseline.group, group);
  }
  const groups = [...grouped.values()];
  let interval95 = null;
  if (groups.length >= 2) {
    const draw = randomIndex(`${seed}:${field}`);
    const deltas = [];
    for (let iteration = 0; iteration < resamples; iteration += 1) {
      let total = 0;
      let count = 0;
      for (let sample = 0; sample < groups.length; sample += 1) {
        const group = groups[draw(groups.length)];
        total += group.total;
        count += group.count;
      }
      deltas.push(total / count);
    }
    deltas.sort((left, right) => left - right);
    interval95 = [percentile(deltas, 0.025), percentile(deltas, 0.975)];
  }
  return { queries: rows.length, groups: groups.length, baseline: baseline / rows.length,
    candidate: candidate / rows.length, delta: (candidate - baseline) / rows.length,
    improved, regressed, unchanged: rows.length - improved - regressed, interval95 };
}

function passDiagnostics(indexed) {
  return indexed.passes.map((pass, index) => {
    const times = [...pass.values()].map((query) => query.recallMs).sort((left, right) => left - right);
    return { pass: index + 1, queries: pass.size,
      meanMs: times.reduce((sum, time) => sum + time, 0) / times.length,
      p50Ms: percentile(times, 0.5), p95Ms: percentile(times, 0.95), p99Ms: percentile(times, 0.99),
      changedRankings: [...pass].filter(([id, query]) => !same(query.rankedIds, indexed.first.get(id).rankedIds)).length };
  });
}

export function compareReports(baseline, candidate, { allowChanges = [], resamples = 2000,
  seed = 20260916, maxRecallDrop = null, maxNoAnswerDrop = null } = {}) {
  if (!Number.isInteger(resamples) || resamples < 200 || resamples > 10000
    || !Number.isInteger(seed) || seed < 0 || seed > 0xffffffff
    || !Array.isArray(allowChanges) || allowChanges.some((key) => !changeKeys.includes(key))) {
    throw new Error("Use 200..10000 resamples, a uint32 seed, and supported explicit configuration changes.");
  }
  for (const threshold of [maxRecallDrop, maxNoAnswerDrop]) {
    if (threshold !== null && (!Number.isFinite(threshold) || threshold < 0 || threshold > 1)) {
      throw new Error("Maximum quality drops must be finite numbers in 0..1.");
    }
  }
  const before = observations(baseline);
  const after = observations(candidate);
  if (baseline.dataset.sha256 !== candidate.dataset.sha256 || baseline.limit !== candidate.limit
    || baseline.split !== candidate.split || before.first.size !== after.first.size) {
    throw new Error("Comparisons require the same corpus hash, cutoff, split, and query population.");
  }
  const pairs = [...before.first].sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([id, query]) => {
    const matched = after.first.get(id);
    if (!matched || !same(before.identity(query), after.identity(matched))) {
      throw new Error("Paired query IDs, labels, categories, splits, and groups must match.");
    }
    return { baseline: query, candidate: matched };
  });
  const baselineConfiguration = configuration(baseline);
  const candidateConfiguration = configuration(candidate);
  const changes = Object.keys(baselineConfiguration).filter((key) => !same(baselineConfiguration[key], candidateConfiguration[key]));
  if (changes.some((key) => !allowChanges.includes(key))) {
    throw new Error(`Undeclared comparison changes: ${changes.filter((key) => !allowChanges.includes(key)).join(", ")}.`);
  }
  const measured = Object.fromEntries(Object.entries(metrics).map(([name, field]) =>
    [name, pairedMetric(pairs, field, resamples, seed)]));
  const categories = [...new Set(pairs.map((pair) => pair.baseline.category))].sort();
  const gates = [["recallAtK", maxRecallDrop], ["noAnswerAccuracy", maxNoAnswerDrop]]
    .filter(([, maximumDrop]) => maximumDrop !== null)
    .map(([metric, maximumDrop]) => ({ metric, maximumDrop, delta: measured[metric].delta,
      passed: measured[metric].delta !== null && measured[metric].delta >= -maximumDrop - 1e-12 }));
  return {
    comparisonVersion: 1, scoring: baseline.scoring, datasetSha256: baseline.dataset.sha256,
    split: baseline.split, limit: baseline.limit, qualityPass: 1, uniqueQueries: pairs.length,
    baseline: baselineConfiguration, candidate: candidateConfiguration, changes,
    uncertainty: { method: "paired-group-percentile-bootstrap", resamples, seed, confidence: 0.95,
      caveat: "Conditional on this corpus. Groups must represent independent units; repeated passes are not new evidence. Fewer than two groups yields no interval." },
    metrics: measured,
    byCategory: Object.fromEntries(categories.map((category) => [category,
      Object.fromEntries(Object.entries(metrics).map(([name, field]) => [name,
        pairedMetric(pairs.filter((pair) => pair.baseline.category === category), field, resamples, seed)]))])),
    latency: { baseline: passDiagnostics(before), candidate: passDiagnostics(after),
      caveat: "Descriptive timings only; compare identical hosts, provider settings, query order, and cache state. p99 on small populations is effectively the maximum." },
    queries: pairs.map((pair) => ({ id: pair.baseline.id, category: pair.baseline.category, group: pair.baseline.group,
      deltas: Object.fromEntries(Object.entries(metrics).map(([name, field]) => [name,
        pair.baseline.metrics[field] === null ? null : Number(pair.candidate.metrics[field]) - Number(pair.baseline.metrics[field])])),
      missingBefore: pair.baseline.relevantIds.filter((id) => !pair.baseline.rankedIds.includes(id)),
      missingAfter: pair.candidate.relevantIds.filter((id) => !pair.candidate.rankedIds.includes(id)),
      returnedBefore: pair.baseline.rankedIds.length, returnedAfter: pair.candidate.rankedIds.length })),
    gates: { passed: gates.every((gate) => gate.passed), checks: gates },
  };
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, baseline: { type: "string" }, candidate: { type: "string" },
    "allow-change": { type: "string", multiple: true }, resamples: { type: "string" }, seed: { type: "string" },
    "max-recall-drop": { type: "string" }, "max-no-answer-drop": { type: "string" },
  } });
  if (values.help) {
    console.log(`Usage: node examples/benchmark-compare.mjs --baseline REPORT --candidate REPORT [options]

Offline paired comparison. No server, model, or database is required.
  --allow-change NAME         Declare each changed configuration field (repeatable)
  --resamples N               Paired group bootstrap draws, 200..10000 (default: 2000)
  --seed N                    Reproducible uint32 sampling seed (default: 20260916)
  --max-recall-drop N          Fail on a first-pass macro recall drop larger than N
  --max-no-answer-drop N       Fail on an abstention-accuracy drop larger than N
Allowed changes: ${changeKeys.join(", ")}.
JSON goes to stdout. Gates use observed deltas, not a statistical guarantee.`);
    return;
  }
  if (!values.baseline || !values.candidate) throw new Error("Set both --baseline and --candidate report paths.");
  const reports = [];
  for (const path of [values.baseline, values.candidate]) {
    try { reports.push(JSON.parse(await readFile(path, "utf8"))); }
    catch { throw new Error("Cannot read a comparison report as JSON."); }
  }
  const number = (name, fallback) => values[name] === undefined ? fallback : values[name].trim() ? Number(values[name]) : NaN;
  const result = compareReports(...reports, { allowChanges: values["allow-change"] ?? [],
    resamples: number("resamples", 2000), seed: number("seed", 20260916),
    maxRecallDrop: number("max-recall-drop", null), maxNoAnswerDrop: number("max-no-answer-drop", null) });
  console.log(JSON.stringify(result, null, 2));
  if (!result.gates.passed) { console.error("Comparison quality regression gate failed."); process.exitCode = 1; }
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
