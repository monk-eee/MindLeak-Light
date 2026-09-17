import semver from "semver";
import { digest } from "./validation-scenarios.mjs";

export const memoryLabProblem = "Investigate a branch-kit upgrade in a report-export service. Determine the exact shipped dependency, choose the smallest policy-compatible fix, and verify its caller against real sandboxed tests. Similar codebases have different runtime, API and deployment constraints. Build a reusable evidence-backed guide in MindLeak, then test it on separate matched no-memory cases.";

export const assessmentSchema = {
  type: "object", additionalProperties: false,
  properties: {
    productionAffected: { type: "boolean" }, recommendation: { type: "string", enum: ["upgrade", "not_shipped", "blocked"] },
    targetVersion: { type: ["string", "null"] }, targetPath: { type: ["string", "null"] },
    evidencePaths: { type: "array", minItems: 1, maxItems: 12, items: { type: "string", maxLength: 256 } },
  }, required: ["productionAffected", "recommendation", "targetVersion", "targetPath", "evidencePaths"],
};

const runtimePath = "node_modules/export-adapter/node_modules/branch-kit";
const fileNames = {
  lock: "package-lock.json", shipped: "build/production-manifest.json", advisory: "advisories/BRANCH-2026-01.json",
  policy: "policy/upgrade-policy.json", registry: "registry/branch-kit.json",
};

export function packageCases({ split = "learning", round = 1 } = {}) {
  if (!["learning", "evaluation"].includes(split) || !Number.isInteger(round) || round < 1 || round > 3) throw new Error("invalid_case_split");
  const specifications = split === "evaluation" ? [
    { id: "apex", current: "2.17.2", affected: ">=2.17.0 <2.17.8", allowed: "^2.17.0", patch: "2.17.8", safe: "2.17.9", blockedBy: "signature" },
    { id: "brook", current: "2.18.1", affected: ">=2.18.0 <2.18.5", allowed: "~2.18.0", patch: "2.18.5", safe: "2.18.6", blockedBy: "node" },
    { id: "cedar", current: "2.19.1", affected: ">=2.19.0 <2.19.4", allowed: "~2.19.0", patch: "2.19.4", safe: "2.19.6", blockedBy: "signature", second: "2.19.5" },
    { id: "dawn", current: "2.17.2", affected: ">=2.17.0 <2.17.8", allowed: "^2.17.0", patch: "2.17.8", safe: "2.17.9", blockedBy: "signature", notShipped: true },
    { id: "elm", current: "2.16.2", affected: ">=2.16.0 <2.16.8", allowed: "~2.16.0", patch: "2.16.8", safe: "2.17.0", blockedBy: "license" },
  ] : [
    { id: "aurora", current: "2.7.1", affected: ">=2.7.0 <2.7.6", allowed: "^2.7.0", patch: "2.7.6", safe: "2.7.7", blockedBy: "signature" },
    { id: "beacon", current: "2.8.0", affected: ">=2.8.0 <2.8.3", allowed: "~2.8.0", patch: "2.8.3", safe: "2.8.4", blockedBy: "node" },
    { id: "cinder", current: "2.9.0", affected: ">=2.9.0 <2.9.2", allowed: "~2.9.0", patch: "2.9.2", safe: "2.9.4", blockedBy: "signature", second: "2.9.3" },
    { id: "delta", current: "2.7.1", affected: ">=2.7.0 <2.7.6", allowed: "^2.7.0", patch: "2.7.6", safe: "2.7.7", blockedBy: "signature", notShipped: true },
    { id: "ember", current: "2.6.1", affected: ">=2.6.0 <2.6.9", allowed: "~2.6.0", patch: "2.6.9", safe: "2.7.0", blockedBy: "license" },
  ];
  return specifications.map(specification => {
    if (split === "evaluation" && round > 1) {
      const shifted = value => { const version = semver.parse(value); return `${version.major}.${version.minor + (round - 1) * 10}.${version.patch}`; };
      const lowerBound = semver.minVersion(specification.affected);
      specification = { ...specification, id: `${specification.id}-r${round}`, current: shifted(specification.current),
        affected: `>=${shifted(lowerBound.version)} <${shifted(specification.patch)}`, allowed: `${specification.allowed.startsWith("^") ? "^" : "~"}${shifted(semver.minVersion(specification.allowed).version)}`,
        patch: shifted(specification.patch), safe: shifted(specification.safe), ...(specification.second ? { second: shifted(specification.second) } : {}) };
    }
    const release = (version, overrides = {}) => ({ version, license: "MIT", signature: "verified", channel: "stable", engines: { node: ">=18 <22" }, ...overrides });
    const versions = [release(specification.current), release(specification.patch, {
      ...(specification.blockedBy === "signature" ? { signature: "unverified" } : {}),
      ...(specification.blockedBy === "node" ? { engines: { node: ">=22" } } : {}),
      ...(specification.blockedBy === "license" ? { license: "GPL-3.0-only" } : {}),
    }), ...(specification.second ? [release(specification.second, { engines: { node: ">=22" } })] : []), release(specification.safe), release("3.0.0")];
    const documents = {
      [fileNames.lock]: { name: specification.id, lockfileVersion: 3, packages: {
        "": { name: specification.id, dependencies: { "export-adapter": "1.4.0" }, devDependencies: { "branch-kit": specification.current } },
        "node_modules/export-adapter": { version: "1.4.0", dependencies: { "branch-kit": specification.allowed } },
        [runtimePath]: { name: "branch-kit", version: specification.current, dev: false },
        "node_modules/branch-kit": { name: "branch-kit", version: specification.current, dev: true },
      } },
      [fileNames.shipped]: { application: specification.id, artifact: `${specification.id}-runtime.tgz`, nodeVersion: "20.15.0",
        includedPackagePaths: ["node_modules/export-adapter", ...(specification.notShipped ? [] : [runtimePath])],
        excludedPackagePaths: ["node_modules/branch-kit", ...(specification.notShipped ? [runtimePath] : [])] },
      [fileNames.advisory]: { id: "BRANCH-2026-01", package: "branch-kit", affectedRange: specification.affected, severity: "high",
        status: "synthetic-frozen-demo-advisory", description: "The example parser mishandles untrusted branch names in the affected versions." },
      [fileNames.policy]: { status: "current", application: specification.id, package: "branch-kit", allowedRange: specification.allowed,
        allowedLicenses: ["MIT", "Apache-2.0"], requiredSignature: "verified", requiredChannel: "stable",
        scopeRule: "Assess exact installed package paths in the shipped artifact, not every package in the development lockfile.",
        selectionRule: "Choose the lowest non-vulnerable, compatible version with an allowed license, verified signature and stable channel. Do not widen the approved range." },
      [fileNames.registry]: { package: "branch-kit", snapshot: "2026-09-17", versions },
      "reports/dependency-scan.json": { application: specification.id, alert: "BRANCH-2026-01", severity: "high",
        findings: [{ path: "node_modules/branch-kit", version: specification.current }, { path: runtimePath, version: specification.current }],
        suggestedVersion: specification.patch, scope: "entire development lockfile; deployment exposure not evaluated" },
      "policy/archive-2024.json": { status: "superseded", selectionRule: "Old advisory-only policy; use policy/upgrade-policy.json for current decisions." },
    };
    const files = Object.fromEntries(Object.entries(documents).map(([path, value]) => [path, `${JSON.stringify(value, null, 2)}\n`]));
    files["README.md"] = `# ${specification.id} package investigation\n\nThis is a frozen, synthetic package review, not a live vulnerability finding. Investigate reports/dependency-scan.json for branch-kit. Source data, registry metadata and deployment/policy evidence are included. No internet, package installation, or code execution is needed. Files are read-only. Decide whether the shipped application is affected and identify the smallest eligible fix for the exact runtime path, or report not_shipped/blocked. Verify current values even when an earlier guide exists.\n`;
    return { id: specification.id, package: "branch-kit", files, fixtureSha256: digest(files), evidencePaths: Object.values(fileNames) };
  });
}

export function assessPackage(specification) {
  const parsed = key => JSON.parse(specification.files[fileNames[key]]);
  const lock = parsed("lock"); const shipped = parsed("shipped"); const advisory = parsed("advisory"); const policy = parsed("policy");
  const withCaller = answer => specification.fixtureVersion !== 2 ? answer : { ...answer, adapterMode: answer.recommendation !== "upgrade" ? "unchanged"
    : parsed("registry").versions.find(release => release.version === answer.targetVersion)?.api.returnType === "Promise<{value:string}>" ? "await-value" : "await-string" };
  const affectedPaths = shipped.includedPackagePaths.filter(path => lock.packages[path]?.name === advisory.package
    && semver.satisfies(lock.packages[path].version, advisory.affectedRange));
  if (!affectedPaths.length) return withCaller({ productionAffected: false, recommendation: "not_shipped", targetVersion: null, targetPath: null });
  const eligible = parsed("registry").versions.filter(release => semver.valid(release.version)
    && semver.satisfies(release.version, policy.allowedRange) && !semver.satisfies(release.version, advisory.affectedRange)
    && policy.allowedLicenses.includes(release.license) && release.signature === policy.requiredSignature
    && release.channel === policy.requiredChannel && semver.satisfies(shipped.nodeVersion, release.engines.node));
  eligible.sort((left, right) => semver.compare(left.version, right.version));
  return withCaller({ productionAffected: true, recommendation: eligible.length ? "upgrade" : "blocked", targetVersion: eligible[0]?.version ?? null, targetPath: affectedPaths[0] });
}

export function checkAssessment(specification, answer, filesRead, probes = []) {
  const expected = assessPackage(specification);
  const checks = Object.entries(expected).map(([field, value]) => ({ name: field, passed: answer?.[field] === value }));
  checks.push({ name: "source-evidence", passed: Array.isArray(answer?.evidencePaths)
    && specification.evidencePaths.every(path => answer.evidencePaths.includes(path) && filesRead.has(path))
    && answer.evidencePaths.every(path => Object.hasOwn(specification.files, path) && filesRead.has(path)) });
  const upgradeProbe = probes.findLast(probe => ["targetPath", "targetVersion", "adapterMode"].every(field => probe[field] === answer?.[field]));
  if (specification.fixtureVersion === 2) checks.push({ name: "executable-upgrade", passed: Boolean(upgradeProbe && upgradeProbe.tests === 3
    && upgradeProbe.expectedTests === 3 && upgradeProbe.passed === (expected.recommendation !== "blocked")) });
  return { passed: checks.every(check => check.passed), tests: checks.length, expectedTests: checks.length,
    passedTests: checks.filter(check => check.passed).length, checks, sourceSha256: specification.fixtureSha256,
    ...(specification.fixtureVersion === 2 ? { upgradeProbe: upgradeProbe ?? null } : {}) };
}

export const adapterModes = ["unchanged", "await-string", "await-value"];
export const upgradeAssessmentSchema = { ...assessmentSchema, properties: { ...assessmentSchema.properties,
  adapterMode: { type: "string", enum: adapterModes } }, required: [...assessmentSchema.required, "adapterMode"] };

function callerSource(mode, fallback) {
  const expression = { unchanged: "encodeBranch(report.branch)", "await-string": "await encodeBranch(report.branch)",
    "await-value": "(await encodeBranch(report.branch)).value" }[mode];
  return `import { encodeBranch } from ${JSON.stringify(fallback ? "./branch-fallback.mjs" : "export-adapter")};\n\nexport async function exportReport(report) {\n  const encoded = ${expression};\n  return { contentType: "text/plain", body: report.title + ":" + encoded };\n}\n`;
}

const reportTests = `import assert from "node:assert/strict";
import test from "node:test";
import { exportReport } from "../src/export-report.mjs";

test("report/ordinary branch", async () => {
  assert.deepEqual(await exportReport({ title: "Daily", branch: "main" }), { contentType: "text/plain", body: "Daily:main" });
});
test("report/path segments stay encoded", async () => {
  assert.equal((await exportReport({ title: "Weekly", branch: "feature/release" })).body, "Weekly:feature%2Frelease");
});
test("report/UTF-8 branch encoding", async () => {
  assert.equal((await exportReport({ title: "Monthly", branch: "caf\\u00e9" })).body, "Monthly:caf%C3%A9");
});
`;

export function upgradeCases({ split = "learning", round = 1 } = {}) {
  return packageCases({ split, round }).map((specification, index) => {
    const files = { ...specification.files };
    const lock = JSON.parse(files[fileNames.lock]);
    const shipped = JSON.parse(files[fileNames.shipped]);
    const advisory = JSON.parse(files[fileNames.advisory]);
    const registry = JSON.parse(files[fileNames.registry]);
    const fallback = !shipped.includedPackagePaths.includes(runtimePath);
    for (const release of registry.versions) {
      const oldApi = semver.satisfies(release.version, advisory.affectedRange);
      release.api = { export: "encodeBranch", returnType: oldApi ? "string" : index === 2 ? "Promise<{value:string}>" : "Promise<string>" };
      const expression = oldApi ? "String(branch)" : index === 2 ? "{ value: encodeURIComponent(String(branch)) }" : "encodeURIComponent(String(branch))";
      files[`vendor/branch-kit/${release.version}/index.mjs`] = `export ${oldApi ? "" : "async "}function encodeBranch(branch) {\n  return ${expression};\n}\n`;
    }
    files[fileNames.registry] = `${JSON.stringify(registry, null, 2)}\n`;
    files["package.json"] = `${JSON.stringify({ name: specification.id, type: "module", private: true, dependencies: { "export-adapter": "1.4.0" } }, null, 2)}\n`;
    files["node_modules/export-adapter/package.json"] = JSON.stringify({ name: "export-adapter", type: "module", exports: "./index.mjs" });
    files["node_modules/export-adapter/index.mjs"] = 'export { encodeBranch } from "branch-kit";\n';
    for (const path of [runtimePath, "node_modules/branch-kit"]) {
      files[`${path}/package.json`] = JSON.stringify({ name: "branch-kit", version: lock.packages[path].version, type: "module", exports: "./index.mjs" });
      files[`${path}/index.mjs`] = files[`vendor/branch-kit/${lock.packages[path].version}/index.mjs`];
    }
    files["src/export-report.mjs"] = callerSource("unchanged", fallback);
    files["src/branch-fallback.mjs"] = 'export function encodeBranch(branch) { return encodeURIComponent(String(branch)); }\n';
    files["tests/report.test.mjs"] = reportTests;
    files["docs/upgrade-contract.md"] = "# Export compatibility\n\nThe public exportReport API is asynchronous and returns {contentType, body}. Branch path segments and UTF-8 must remain encoded. The adapter resolves its own nested branch-kit, not the root development copy. Inspect the current registry API and vendored release implementation. A patched version may change the result to a Promise of a string or an object; the caller must consume the actual value.\n\nprobe_upgrade runs a fresh, network-disabled container with the exact selected package path and one transparent caller patch: unchanged, await-string, or await-value. It does not install from a network, edit policy, or mutate the source repository. Null targetVersion preserves installed code. A not-shipped result must still verify the deployed fallback. A blocked result must retain the unresolved test failures; do not invent an eligible release or change the policy.\n";
    files["README.md"] = `# ${specification.id} report-export service\n\nFrozen synthetic upgrade investigation, fixture v2 (${split}). Review the branch-kit alert, actual shipped path, current policy, release metadata and caller code. Choose the smallest eligible upgrade and caller adaptation; verify it with probe_upgrade before verify_assessment. Report not_shipped or blocked when appropriate. Read the source evidence listed by the task, and inspect additional modules or releases as needed. No shell or internet is available. The three fixed exporter tests run in an isolated container.\n`;
    return { ...specification, files, fixtureVersion: 2, split, round, family: ["nested-signature", "node-compatibility", "async-result-shape", "not-shipped", "policy-blocked"][index],
      evidencePaths: [...specification.evidencePaths, "src/export-report.mjs", "docs/upgrade-contract.md", "tests/report.test.mjs"], fixtureSha256: digest(files) };
  });
}

export function packageWorkspace(specification, { code } = {}) {
  const filesRead = new Set();
  const probes = [];
  return { filesRead, probes, fixtureSha256: specification.fixtureSha256,
    async probeUpgrade({ targetPath, targetVersion, adapterMode }) {
      const lock = JSON.parse(specification.files[fileNames.lock]);
      const releasePath = `vendor/branch-kit/${targetVersion}/index.mjs`;
      if (specification.fixtureVersion !== 2 || !adapterModes.includes(adapterMode) || probes.length >= 8
        || targetPath !== null && lock.packages[targetPath]?.name !== "branch-kit"
        || targetVersion !== null && (targetPath === null || !Object.hasOwn(specification.files, releasePath))) throw new Error("invalid_upgrade_probe");
      if (!code) throw new Error("code_execution_requires_explicit_container");
      const files = { ...specification.files };
      const fallback = !JSON.parse(files[fileNames.shipped]).includedPackagePaths.includes(runtimePath);
      files["src/export-report.mjs"] = callerSource(adapterMode, fallback);
      if (targetVersion !== null) {
        files[`${targetPath}/index.mjs`] = files[releasePath];
        files[`${targetPath}/package.json`] = JSON.stringify({ ...JSON.parse(files[`${targetPath}/package.json`]), version: targetVersion });
      }
      const { createCodingWorkspace } = await import("./validation-runtime.mjs");
      const workspace = await createCodingWorkspace("package-upgrade", code, { files, editable: [], tests: reportTests, testCount: 3,
        testNames: ["report/ordinary branch", "report/path segments stay encoded", "report/UTF-8 branch encoding"] });
      try {
        const result = { ...await workspace.test(), targetPath, targetVersion, adapterMode, fixtureSha256: specification.fixtureSha256,
          callerSource: files["src/export-report.mjs"] };
        probes.push(result);
        return result;
      } finally { await workspace.close(); }
    },
    async list() { return Object.keys(specification.files).sort(); },
    async read(path) {
      if (!Object.hasOwn(specification.files, path)) throw new Error("fixture_path_not_allowed");
      filesRead.add(path); return specification.files[path];
    },
    async search(query) {
      if (typeof query !== "string" || !query.trim() || query.length > 128) throw new Error("invalid_search_query");
      const matches = [];
      for (const [path, text] of Object.entries(specification.files)) for (const [index, line] of text.split("\n").entries()) {
        if (line.toLowerCase().includes(query.toLowerCase())) matches.push({ path, line: index + 1, text: line });
        if (matches.length >= 40) return matches;
      }
      return matches;
    },
  };
}
