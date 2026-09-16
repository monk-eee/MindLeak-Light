import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
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

export async function captureBenchmark(args, { cwd, env = process.env, timeout = 600000,
  maxBuffer = 16 * 1024 * 1024, signal } = {}) {
  assert.ok(Number.isSafeInteger(timeout) && timeout > 0, "Benchmark timeout must be a positive integer.");
  assert.ok(Number.isSafeInteger(maxBuffer) && maxBuffer > 0, "Capture buffer must be a positive integer.");
  signal?.throwIfAborted();
  const temporary = await mkdtemp(join(tmpdir(), "mindleak-benchmark-run-"));
  try {
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, args, {
        cwd, env: { ...env, TMPDIR: temporary, TMP: temporary, TEMP: temporary },
        detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
      });
      const output = { stdout: [], stderr: [] };
      const sizes = { stdout: 0, stderr: 0 };
      let failure;
      let termination;
      const terminate = () => {
        if (termination) return termination;
        termination = (async () => {
          if (!child.pid) return;
          if (process.platform !== "win32") {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
            return;
          }
          await new Promise((complete, reject) => {
            const killer = spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
              windowsHide: true, stdio: "ignore",
            });
            const deadline = setTimeout(() => killer.kill("SIGKILL"), 5000);
            killer.once("error", reject);
            killer.once("close", code => {
              clearTimeout(deadline);
              if (code === 0) complete();
              else reject(new Error("Could not terminate the owned benchmark process tree."));
            });
          });
        })().catch(error => {
          failure = new Error("Benchmark process-tree cleanup failed.", { cause: error });
          child.kill("SIGKILL");
        });
        return termination;
      };
      const stop = error => {
        failure ??= error;
        void terminate();
      };
      const abort = () => stop(Object.assign(new Error("Benchmark execution cancelled."), { code: "ABORT_ERR" }));
      const deadline = setTimeout(() => stop(Object.assign(new Error("Benchmark execution timed out."), { code: "ETIMEDOUT" })), timeout);
      for (const stream of ["stdout", "stderr"]) {
        child[stream].on("data", chunk => {
          const available = maxBuffer - sizes[stream];
          if (available > 0) output[stream].push(chunk.subarray(0, available));
          sizes[stream] += chunk.length;
          if (sizes[stream] > maxBuffer) stop(Object.assign(new Error("Benchmark output exceeded its capture bound."), { code: "ENOBUFS" }));
        });
      }
      child.once("error", error => { failure ??= error; });
      child.once("exit", () => {
        if (process.platform !== "win32") void terminate();
      });
      child.once("close", async (status, exitSignal) => {
        clearTimeout(deadline);
        signal?.removeEventListener("abort", abort);
        await termination;
        resolve({ status, signal: exitSignal, error: failure,
          stdout: Buffer.concat(output.stdout).toString("utf8"), stderr: Buffer.concat(output.stderr).toString("utf8") });
      });
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) abort();
    });
  } finally {
    await rm(temporary, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}

export function regressionPlan(environment, options = {}, root = repository) {
  const definition = JSON.parse(readFileSync(join(root, "scripts/regression-baseline.json"), "utf8"));
  assert.equal(definition.schemaVersion, 1);
  assert.match(definition.release, /^v\d+\.\d+\.\d+$/);
  assert.match(definition.source, /^[a-f0-9]{40}$/);
  assert.match(definition.image, /^monkeemagic\/mindleak-light@sha256:[a-f0-9]{64}$/);
  assert.ok(["pr", "load"].includes(options.profile ?? "pr"), "Choose profile pr or load.");
  const profile = options.profile ?? "pr";
  const deadlineSeconds = options["deadline-seconds"] === undefined
    ? (profile === "pr" ? 600 : 900) : Number(options["deadline-seconds"]);
  assert.ok((options["deadline-seconds"] === undefined
    || (typeof options["deadline-seconds"] === "string" && options["deadline-seconds"].trim()))
    && Number.isSafeInteger(deadlineSeconds) && deadlineSeconds >= 1
    && deadlineSeconds <= (profile === "pr" ? 600 : 7200),
  "Runner deadline must be integer seconds in 1..600 for pr or 1..7200 for load.");
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
  return { definition, profile, settings, corpora, deadlineMs: deadlineSeconds * 1000,
    workloads: profile === "pr" ? [{ concurrency: 1, passes: 1 }] : [{ concurrency: 1, passes: 3 }, { concurrency: 4, passes: 3 }] };
}

async function releaseArchive(definition, path, signal, timeout) {
  const archive = definition.archives[`${process.platform}-${process.arch}`];
  assert.ok(archive, "This host has no pinned native baseline archive.");
  assert.match(archive.name, /^mindleak-light-\d+\.\d+\.\d+-[a-z0-9_-]+\.tar\.gz$/);
  assert.match(archive.sha256, /^[a-f0-9]{64}$/);
  let bytes;
  if (path) bytes = await readFile(path, { signal });
  else {
    const response = await fetch(`https://github.com/monk-eee/MindLeak-Light/releases/download/${definition.release}/${archive.name}`,
      { signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]) });
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
    limits: { maxRegressedQueries: plan.definition.maxRegressedQueries, maxResultBytes: plan.definition.maxResultBytes,
      deadlineSeconds: plan.deadlineMs / 1000 },
    caveat: "Frozen, exposed fixtures detect regressions; they do not establish population accuracy. Timings on shared runners are descriptive, not a production guarantee." };
  await save("summary", summary);
  const directory = await mkdtemp(join(tmpdir(), "mindleak-release-regression-"));
  const started = performance.now();
  const expires = started + plan.deadlineMs;
  const cancellation = new AbortController();
  const deadlineError = () => Object.assign(new Error("Regression runner deadline exceeded."), { code: "ETIMEDOUT" });
  const deadline = setTimeout(() => cancellation.abort(deadlineError()), plan.deadlineMs);
  const remaining = maximum => {
    if (cancellation.signal.aborted || performance.now() >= expires) throw deadlineError();
    return Math.max(1, Math.min(maximum, Math.ceil(expires - performance.now())));
  };
  let failure;
  try {
    const { archive, bytes } = await releaseArchive(plan.definition, options["baseline-archive"], cancellation.signal, remaining(120000));
    await writeFile(join(directory, "baseline.tar.gz"), bytes, { flag: "wx", mode: 0o600 });
    const binaryName = process.platform === "win32" ? "mindleak-light.exe" : "mindleak-light";
    execFileSync("tar", ["-xzf", join(directory, "baseline.tar.gz"), "-C", directory, `./${binaryName}`],
      { stdio: ["ignore", "pipe", "pipe"], timeout: remaining(30000), killSignal: "SIGKILL" });
    const baseline = join(directory, binaryName);
    assert.equal(execFileSync(baseline, ["--version"], { cwd: directory, encoding: "utf8", timeout: remaining(10000), killSignal: "SIGKILL" }).trim(),
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
          const execution = await captureBenchmark(args, { cwd: repository,
            timeout: remaining(plan.profile === "pr" ? 600000 : 7200000), signal: cancellation.signal,
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
        remaining(1);
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
    remaining(1);
    summary.complete = true;
    summary.passed = summary.runs.every(run => run.passed);
  } catch (error) {
    failure = error;
    summary.complete = false;
    summary.passed = false;
    summary.error = cancellation.signal.aborted || performance.now() >= expires
      ? "Regression runner deadline exceeded; remaining comparisons were not run."
      : error instanceof assert.AssertionError ? error.message : "Regression execution failed before all comparisons completed.";
  } finally {
    clearTimeout(deadline);
    try { await rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); }
    catch (error) {
      failure = new AggregateError(failure ? [failure, error] : [error], "Regression execution or temporary-file cleanup failed.");
      summary.complete = false;
      summary.passed = false;
      summary.error = "Regression temporary-file cleanup failed.";
    }
    summary.elapsedMs = Math.round(performance.now() - started);
    await save("summary", summary);
  }
  if (failure) throw failure;
  return summary;
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean", short: "h" }, candidate: { type: "string" }, output: { type: "string" },
    "baseline-archive": { type: "string" }, profile: { type: "string" },
    decomposition: { type: "string" }, retrieval: { type: "string" }, relevance: { type: "string" },
    "max-warm-p95-ms": { type: "string" }, "deadline-seconds": { type: "string" },
  } });
  if (values.help) {
    console.log(`Usage: node scripts/regression-check.mjs --candidate BINARY --output NEW_DIRECTORY [options]

Requires distinct MINDLEAK_BASELINE_DATABASE_URL and MINDLEAK_TEST_DATABASE_URL,
both disposable *_test databases. The runner never deletes either database.
Downloads and checks the pinned native release; --baseline-archive PATH allows an offline copy.
  --profile pr|load          pr: one model-free pass; load: three passes at concurrency 1 and 4
  --deadline-seconds N       Whole-run execution budget; pr 1..600 (default 600), load 1..7200 (default 900)
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
