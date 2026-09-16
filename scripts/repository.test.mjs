import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { readAdrs, updateIndex } from "./adr-index.mjs";
import { readFragments, releaseChangelog, render } from "./changelog.mjs";
import { checkDocs } from "./check-docs.mjs";
import { packageBinary, releaseNotes } from "./release.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "mindleak-light-records-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

const record = "# ADR-0001: Example\n\n- Status: Accepted\n- Date: 2026-09-16\n\n## Context\n\nText\n\n## Decision\n\nText\n\n## Consequences\n\nText\n\n## Verification\n\nTest\n";

test("ADR records produce a stable index without losing surrounding text", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "0001-example.md"), record);
  const original = "Intro\n\n| ADR | Title | Status |\n|---|---|---|\n\nFooter\n";
  const updated = updateIndex(original, readAdrs(directory));
  assert.match(updated, /\[0001\]\(0001-example.md\) \| Example \| Accepted/);
  assert.ok(updated.startsWith("Intro\n"));
  assert.ok(updated.endsWith("\nFooter\n"));
  assert.equal(updateIndex(updated, readAdrs(directory)), updated);
});

test("ADR validation refuses duplicate numbers, missing sections, and invalid statuses", (context) => {
  const directory = fixture(context);
  const path = join(directory, "0001-example.md");
  writeFileSync(path, record);
  writeFileSync(join(directory, "0001-other.md"), record);
  assert.throws(() => readAdrs(directory), /duplicate/);
  rmSync(join(directory, "0001-other.md"));
  for (const invalid of [
    record.replace("Accepted", "Unknown"),
    record.replace("Accepted", "Superseded by [ADR-0002](0002-missing.md)"),
    record.replace("## Verification", "## Missing"),
    record.replace("2026-09-16", "2026-02-31"),
    record.replace("ADR-0001:", "ADR-0002:"),
  ]) {
    writeFileSync(path, invalid);
    assert.throws(() => readAdrs(directory));
  }
});

test("changelog fragments are grouped in canonical section order", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "fixed-example.md"), "- Fix a bug.\n");
  writeFileSync(join(directory, "added-example.md"), "- Add a feature.\n");
  const { grouped, files } = readFragments(directory);
  assert.equal(files.length, 2);
  assert.equal(render(grouped), "### Added\n- Add a feature.\n\n### Fixed\n- Fix a bug.");
  writeFileSync(join(directory, "invalid.md"), "- Invalid name.\n");
  assert.throws(() => readFragments(directory), /invalid/);
});

test("release preserves existing unreleased entries and old release history", () => {
  const original = "# Changelog\n\n## [Unreleased]\n\n### Fixed\n- Existing fix.\n\n## [0.0.1] - 2026-01-01\n\nOld release.\n";
  const grouped = new Map([["fixed", ["- New fix."]], ["added", ["- New feature."]]]);
  const output = releaseChangelog(original, grouped, "0.1.0", "2026-09-16");
  assert.match(output, /## \[0.1.0\] - 2026-09-16/);
  assert.match(output, /- Existing fix.\n- New fix./);
  assert.ok(output.endsWith("## [0.0.1] - 2026-01-01\n\nOld release.\n"));
  assert.throws(() => releaseChangelog(output, grouped, "0.1.0", "2026-09-16"), /already released/);
  assert.throws(() => releaseChangelog(original, grouped, "bad", "2026-09-16"), /semantic version/);
  assert.throws(() => releaseChangelog("## [Unreleased]\n", new Map(), "0.1.0", "2026-09-16"), /nothing/);
});

test("repository record commands validate the actual checkout", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  for (const script of ["adr-index.mjs", "changelog.mjs"]) {
    const output = execFileSync(process.execPath, [join(root, "scripts", script), "--check"], { cwd: root, encoding: "utf8" });
    assert.match(output, /valid/);
  }
  assert.match(readFileSync(join(root, "AGENTS.md"), "utf8"), /MemoryRetriever/);
});

test("local Markdown links are checked but URLs and code samples are excluded", (context) => {
  const directory = fixture(context);
  writeFileSync(join(directory, "target.md"), "# Target\n");
  writeFileSync(join(directory, "README.md"), "[Target](target.md#heading)\n[Web](https://example.com)\n```md\n[Example](not-a-file.md)\n```\n");
  assert.deepEqual(checkDocs(directory), []);
  writeFileSync(join(directory, "bad.md"), "[Missing](missing.md)\n");
  assert.match(checkDocs(directory)[0], /missing.md/);
});

test("release metadata requires matching versions and consumed fragments", () => {
  const changelog = "# Changelog\n\n## [Unreleased]\n\n## [0.1.0] - 2026-09-16\n\n### Added\n- Memory tools.\n";
  assert.equal(releaseNotes(changelog, "0.1.0", "v0.1.0", 0), "### Added\n- Memory tools.");
  assert.throws(() => releaseNotes(changelog, "0.1.0", "v0.2.0", 0), /tag/);
  assert.throws(() => releaseNotes(changelog, "0.1.0", "v0.1.0", 1), /fragments/);
  assert.throws(() => releaseNotes("## [Unreleased]\n", "0.1.0", "v0.1.0", 0), /dated/);
});

test("release packaging includes one executable and verifiable checksums", (context) => {
  const directory = fixture(context);
  const target = "x86_64-unknown-linux-gnu";
  const release = join(directory, "target", target, "release");
  mkdirSync(release, { recursive: true });
  writeFileSync(join(release, "mindleak-light"), "test executable\n");
  for (const name of ["README.md", "LICENSE", "SECURITY.md"]) writeFileSync(join(directory, name), name);
  const archive = packageBinary(directory, target, "0.1.0");
  const contents = execFileSync("tar", ["-tzf", archive], { encoding: "utf8" });
  assert.match(contents, /mindleak-light/);
  assert.match(contents, /LICENSE/);
  const digest = createHash("sha256").update(readFileSync(archive)).digest("hex");
  assert.ok(readFileSync(`${archive}.sha256`, "utf8").startsWith(`${digest}  mindleak-light-0.1.0-`));
  assert.throws(() => packageBinary(directory, "../../invalid", "0.1.0"), /unsupported/);
});
