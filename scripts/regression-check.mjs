import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { benchmarkSettings, validateDataset } from "../examples/benchmark-recall.mjs";
import { compareReports } from "../examples/benchmark-compare.mjs";

const repository = fileURLToPath(new URL("../", import.meta.url));
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

export function captureBenchmark(args, options) {
  return spawnSync(process.execPath, args, {
    encoding: "utf8", maxBuffer: 16 * 1024 * 1024, ...options, killSignal: "SIGKILL",
  });
}

export function regressionPlan(environment, options = {}, root = repository) {
  const definition = JSON.parse(readFileSync(join(root, "scripts/regression-baseline.json"), "utf8"));
  assert.equal(definition.schemaVersion, 1);
  assert.match(definition.release, /^v\d+\.\d+\.\d+$/);
  assert.match(definition.source, /^[a-f0-9]{40}$/);
  assert.match(definition.image, /^monkeemagic\/mindleak-light@sha256:[a-f0-9]{64}$/);
  assert.ok(["pr", "load"].includes(options.profile ?? "pr"), "Choose profile pr or load.");
  const profile = options.profile ?? "pr";
  const baseEnvironment = { ...environment, MINDLEAK_TEST_DATABASE_URL: environment.MINDLEAK_BASELINE_DATABASE_URL };
  const configurations = [baseEnvironment, environment].map(env => benchmarkSettings(env, {
    k: String(definition.limit), split: "evaluation", "query-seed": String(definition.querySeed),
    passes: profile === "pr" ? "1" : "3",
    decomposition: options.decomposition ?? "sentences", retrieval: options.retrieval ?? "keyword",
    relevance: options.relevance ?? "off", "max-warm-p95-ms": options["max-warm-p95-ms"],
  }));
  assert.notEqual(decodeURIComponent(new URL(configurations[0].serverEnvironment.MINDLEAK_DATABASE_URL).pathname),
    decodeURIComponent(new URL(configurations[1].serverEnvironment.MINDLEAK_DATABASE_URL).pathname),
    "Use different disposable database names for baseline and candidate.");
  const settings = configurations[1];
  if (profile === "pr") {
    assert.ok(settings.configuration.decomposition === "sentences" && settings.configuration.retrieval === "keyword"
      && settings.configuration.relevance === "off", "Model-backed runs belong in the separate load profile.");
  }
  assert.ok(Number.isSafeInteger(definition.maxRegressedQueries) && definition.maxRegressedQueries >= 0);
  assert.ok(Number.isSafeInteger(definition.maxResultBytes) && definition.maxResultBytes >= 2);
  assert.ok(Array.isArray(definition.corpora) && definition.corpora.length > 0);
  const names = new Set();
  const corpora = definition.corpora.map(entry => {
    assert.match(entry.name, /^[a-z0-9-]+$/);
    assert.ok(!names.has(entry.name), "Regression corpus names must be unique.");
    names.add(entry.name);
    assert.match(entry.path, /^examples\/fixtures\/[a-z0-9-]+\.json$/);
    const source = readFileSync(join(root, entry.path));
    assert.equal(hash(source), entry.sha256, `Frozen corpus changed: ${entry.name}. Review a versioned baseline update.`);
    const dataset = validateDataset(JSON.parse(source.toString("utf8")));
    assert.equal(dataset.queries.filter(query => query.split === "evaluation").length, entry.evaluationQueries);
    return { ...entry, dataset };
  });
  return { definition, profile, settings, corpora,
    workloads: profile === "pr" ? [{ concurrency: 1, passes: 1 }] : [{ concurrency: 1, passes: 3 }, { concurrency: 4, passes: 3 }] };
}

async function releaseArchive(definition, path) {
  const archive = definition.archives[`${process.platform}-${process.arch}`];
  assert.ok(archive, "This host has no pinned native baseline archive.");
  assert.match(archive.name, /^mindleak-light-\d+\.\d+\.\d+-[a-z0-9_-]+\.tar\.gz$/);
  assert.match(archive.sha256, /^[a-f0-9]{64}$/);
  let bytes;
  if (path) bytes = await readFile(path);
  else {
    const response = await fetch(`https://github.com/monk-eee/MindLeak-Light/releases/download/${definition.release}/${archive.name}`,
      { signal: AbortSignal.timeout(120000) });
    assert.ok(response.ok && response.body, `Baseline archive download failed: HTTP ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      assert.ok(size <= 32 * 1024 * 1024, "Baseline archive exceeds the download bound.");
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  }
  assert.equal(hash(bytes), archive.sha256, "Baseline archive checksum differs from the pinned release.");
  return { archive, bytes };
}

export async function runRegression(environment, options = {}) {
  const plan = regressionPlan(environment, options);
  const candidate = resolve(options.candidate ?? join(repository, "target/release", process.platform === "win32" ? "mindleak-light.exe" : "mindleak-light"));
  const candidateBytes = await readFile(candidate);
  const output = resolve(options.output ?? join(repository, "target/regression"));
  await mkdir(dirname(output), { recursive: true });
  await mkdir(output);
  const save = (name, value) => writeFile(join(output, `${name}.json`), JSON.stringify(value, null, 2) + "\n");
  const summary = { regressionVersion: 1, baseline: { release: plan.definition.release, source: plan.definition.source },
    candidateSha256: hash(candidateBytes), profile: plan.profile, complete: false, passed: false, runs: [],
    limits: { maxRegressedQueries: plan.definition.maxRegressedQueries, maxResultBytes: plan.definition.maxResultBytes },
    caveat: "Frozen, exposed fixtures detect regressions; they do not establish population accuracy. Timings on shared runners are descriptive, not a production guarantee." };
  await save("summary", summary);
  const directory = await mkdtemp(join(tmpdir(), "mindleak-release-regression-"));
  try {
    const { archive, bytes } = await releaseArchive(plan.definition, options["baseline-archive"]);
    await writeFile(join(directory, "baseline.tar.gz"), bytes, { flag: "wx", mode: 0o600 });
    const binaryName = process.platform === "win32" ? "mindleak-light.exe" : "mindleak-light";
    execFileSync("tar", ["-xzf", join(directory, "baseline.tar.gz"), "-C", directory, `./${binaryName}`],
      { stdio: ["ignore", "pipe", "pipe"], timeout: 30000, killSignal: "SIGKILL" });
    const baseline = join(directory, binaryName);
    assert.equal(execFileSync(baseline, ["--version"], { cwd: directory, encoding: "utf8", timeout: 10000, killSignal: "SIGKILL" }).trim(),
      `mindleak-light ${plan.definition.release.slice(1)}`, "Baseline version does not match its pinned release.");
    const snapshot = join(directory, process.platform === "win32" ? "candidate.exe" : "candidate");
    await writeFile(snapshot, candidateBytes, { mode: 0o700, flag: "wx" });
    summary.baseline.archive = archive.name;
    summary.baseline.archiveSha256 = archive.sha256;
    summary.baseline.binarySha256 = hash(await readFile(baseline));
    await save("summary", summary);
    for (const corpus of plan.corpora) {
      for (const workload of plan.workloads) {
        const name = `${corpus.name}-c${workload.concurrency}`;
        const reports = {};
        const order = summary.runs.length % 2 === 0 ? ["baseline", "candidate"] : ["candidate", "baseline"];
        for (const role of order) {
          const args = [join(repository, "examples/benchmark-recall.mjs"), "--binary", role === "baseline" ? baseline : snapshot,
            "--dataset", join(repository, corpus.path), "--k", String(plan.definition.limit), "--split", "evaluation",
            "--query-seed", String(plan.definition.querySeed), "--passes", String(workload.passes), "--concurrency", String(workload.concurrency),
            "--decomposition", plan.settings.configuration.decomposition, "--retrieval", plan.settings.configuration.retrieval,
            "--relevance", plan.settings.configuration.relevance, "--label", `${name}-${role}`];
          const execution = captureBenchmark(args, { cwd: repository,
            timeout: plan.profile === "pr" ? 600000 : 7200000,
            env: { ...environment, NODE_OPTIONS: "", MINDLEAK_TEST_DATABASE_URL: role === "baseline"
              ? environment.MINDLEAK_BASELINE_DATABASE_URL : environment.MINDLEAK_TEST_DATABASE_URL } });
          await writeFile(join(output, `${name}-${role}.stderr.log`), execution.stderr ?? "");
          if (execution.stdout?.trim()) await writeFile(join(output, `${name}-${role}.json`), execution.stdout);
          assert.ok(!execution.error && execution.status === 0, `Benchmark ${name}-${role} failed; inspect its retained log. No passing comparison is claimed.`);
          reports[role] = JSON.parse(execution.stdout);
          assert.equal(reports[role].binarySha256, role === "baseline" ? summary.baseline.binarySha256 : summary.candidateSha256);
          assert.equal(reports[role].passes, workload.passes, "The runner did not execute the planned pass count.");
          assert.equal(reports[role].workload.concurrency, workload.concurrency, "The runner changed the planned concurrency.");
          assert.equal(reports[role].workload.querySeed, plan.definition.querySeed, "The runner changed the planned query seed.");
        }
        const comparison = compareReports(reports.baseline, reports.candidate, {
          corpus: { dataset: corpus.dataset, sha256: corpus.sha256 }, allowChanges: ["binary"],
          maxRecallDrop: 0, maxNoAnswerDrop: 0, maxRegressedQueries: plan.definition.maxRegressedQueries,
          maxResultBytes: plan.definition.maxResultBytes,
        });
        assert.ok(comparison.audit.corpusVerified && comparison.audit.queryTextVerified && comparison.audit.plannedQuerySetsVerified);
        assert.equal(comparison.uniqueQueries, corpus.evaluationQueries, "The comparison lost planned queries.");
        if (plan.settings.maxWarmP95 !== null) {
          const observed = Math.max(...comparison.latency.candidate.slice(1).map(pass => pass.p95Ms));
          comparison.gates.checks.push({ metric: "warmP95Ms", maximumMs: plan.settings.maxWarmP95, observedMs: observed,
            passed: observed <= plan.settings.maxWarmP95 });
          comparison.gates.passed = comparison.gates.checks.every(gate => gate.passed);
        }
        await save(`${name}-comparison`, comparison);
        summary.runs.push({ name, corpusSha256: corpus.sha256, executionOrder: order, ...workload,
          uniqueQueries: comparison.uniqueQueries, passed: comparison.gates.passed });
        await save("summary", summary);
        console.log(`${name}: ${comparison.gates.passed ? "PASS" : "FAIL"}, ${comparison.uniqueQueries} paired queries; reports in ${output}`);
      }
    }
    summary.complete = true;
    summary.passed = summary.runs.every(run => run.passed);
    await save("summary", summary);
    return summary;
  } catch (error) {
    summary.error = error instanceof assert.AssertionError ? error.message : "Regression execution failed before all comparisons completed.";
    await save("summary", summary);
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, candidate: { type: "string" }, output: { type: "string" },
    "baseline-archive": { type: "string" }, profile: { type: "string" },
    decomposition: { type: "string" }, retrieval: { type: "string" }, relevance: { type: "string" },
    "max-warm-p95-ms": { type: "string" },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/regression-check.mjs --candidate BINARY --output NEW_DIRECTORY [options]

Requires distinct MINDLEAK_BASELINE_DATABASE_URL and MINDLEAK_TEST_DATABASE_URL,
both disposable *_test databases. The runner never deletes either database.
Downloads and checks the pinned native release; --baseline-archive PATH allows an offline copy.
  --profile pr|load          pr: one model-free pass; load: three passes at concurrency 1 and 4
  --max-warm-p95-ms N        Optional load-only latency gate for a controlled host
  --decomposition MODE      load only: sentences|openai
  --retrieval MODE          load only: keyword|vector|hybrid
  --relevance MODE          load only: off|openai
Models need explicit provider settings. No models or latency thresholds are enabled in PR CI.
Reports, comparison verdicts and failure logs are retained in the new output directory.`);
    return;
  }
  const summary = await runRegression(process.env, values);
  if (!summary.passed) process.exitCode = 1;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  main().catch(() => { console.error("Release regression check failed; inspect retained reports and validate the explicit inputs with --help."); process.exitCode = 1; });
}
