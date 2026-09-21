import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { readFragments } from "./changelog.mjs";

export const TARGETS = new Set([
  "x86_64-unknown-linux-gnu", "x86_64-pc-windows-msvc",
  "x86_64-apple-darwin", "aarch64-apple-darwin",
]);

export function workspaceVersion(root) {
  const metadata = JSON.parse(execFileSync("cargo", ["metadata", "--locked", "--no-deps", "--format-version", "1"], {
    cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
  }));
  const packages = metadata.packages.filter((entry) => metadata.workspace_members.includes(entry.id));
  const versions = new Set(packages.map((entry) => entry.version));
  if (versions.size !== 1) throw new Error("workspace packages must share one release version");
  return [...versions][0];
}

export function releaseNotes(changelog, version, tag, fragmentCount) {
  if (tag !== `v${version}`) throw new Error("release tag must match the Cargo workspace version");
  if (fragmentCount !== 0) throw new Error("fold changelog fragments before tagging a release");
  const lines = changelog.split(/\r?\n/);
  const start = lines.findIndex((line) => line.startsWith(`## [${version}] - `));
  if (start < 0) throw new Error("release has no dated changelog entry");
  const date = lines[start].slice(`## [${version}] - `.length);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("release date must be a valid ISO date");
  }
  const remaining = lines.slice(start + 1);
  const next = remaining.findIndex((line) => line.startsWith("## ["));
  const notes = remaining.slice(0, next < 0 ? undefined : next).join("\n").trim();
  if (!notes) throw new Error("release notes must not be empty");
  return notes;
}

export function packageBinary(root, target, version) {
  if (!TARGETS.has(target)) throw new Error("unsupported release target");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error("invalid version");
  const binaryName = `mindleak-light${target.includes("windows") ? ".exe" : ""}`;
  const binary = join(root, "target", target, "release", binaryName);
  if (!existsSync(binary)) throw new Error(`build the ${target} release binary first`);
  const staging = mkdtempSync(join(tmpdir(), "mindleak-light-release-"));
  const output = join(root, "dist");
  mkdirSync(output, { recursive: true });
  const archive = join(output, `mindleak-light-${version}-${target}.tar.gz`);
  try {
    copyFileSync(binary, join(staging, binaryName));
    if (!target.includes("windows")) chmodSync(join(staging, binaryName), 0o755);
    for (const name of [
      "README.md", "LICENSE", "SECURITY.md", "RATIONALE.md",
  "docs/INSTALL.md", "docs/INTEGRATION.md", "docs/MODELS.md", "docs/LIFECYCLE.md", "docs/ARCHITECTURE.md", "docs/LOCAL.md", "docs/CHAINS.md",
  "docs/BACKUP.md", "adr.d/0021-encrypted-administrative-backups.md", "gaps.d/backup-platform-acceptance.md",
  "docs/DOMAIN-RELATIONSHIPS.md", "docs/MIGRATIONS.md",
      "docs/VALIDATION.md", "docs/BENCHMARKS.md", "docs/BENCHMARK-RESULTS.md",
      "docs/KNOWN-LIMITATIONS.md", "docs/REVIEW-STATUS.md", "adr.d/0024-knowledge-formation-product.md",
      "adr.d/0025-investigation-learning-protocol.md", "adr.d/0026-quality-first-learning-evaluation.md",
      "gaps.d/model-extraction-subject-attribution.md", "gaps.d/quality-study-authoring-completion.md",
      "assets/mindleak_logo.png", "assets/mindleak_128x128.png",
      "assets/architecture.excalidraw", "assets/architecture-overview.svg",
      "assets/architecture-write.svg", "assets/architecture-recall.svg", "assets/architecture-lifecycle.svg",
      ".agents/skills/mindleak-memory/SKILL.md",
      ".agents/skills/mindleak-memory/references/agent-policy.md",
      ".agents/skills/mindleak-memory/references/tool-recipes.json",
    ]) {
      const destination = join(staging, name);
      mkdirSync(dirname(destination), { recursive: true });
      copyFileSync(join(root, name), destination);
    }
    const local = { command: binaryName, args: ["local", "connect", "--container", "mindleak-light"] };
    writeFileSync(join(staging, "mcp.example.json"), `${JSON.stringify({
      mcpServers: { "mindleak-light-local": local },
    }, null, 2)}\n`);
    writeFileSync(join(staging, "mcp.vscode.example.json"), `${JSON.stringify({
      servers: { "mindleak-light-local": { type: "stdio", ...local } },
    }, null, 2)}\n`);
    writeFileSync(join(staging, "mcp.postgres.example.json"), `${JSON.stringify({
      mcpServers: {
        "mindleak-light": {
          command: binaryName,
          args: ["--transport", "stdio"],
          env: {
            MINDLEAK_DATABASE_URL: "postgresql://USER:PASSWORD@HOST:5432/mindleak_light?sslmode=require",
          },
        },
      },
    }, null, 2)}\n`);
    execFileSync("tar", ["-czf", archive, "-C", staging, "."], { stdio: "inherit" });
    const checksum = createHash("sha256").update(readFileSync(archive)).digest("hex");
    writeFileSync(`${archive}.sha256`, `${checksum}  ${basename(archive)}\n`);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return archive;
}

function main() {
  const [operation, value, ...extra] = process.argv.slice(2);
  if (extra.length || !value || !["--check", "--notes", "--package"].includes(operation)) {
    throw new Error("usage: release.mjs --check TAG | --notes TAG | --package TARGET");
  }
  const root = resolve(process.cwd());
  const version = workspaceVersion(root);
  if (operation === "--package") {
    console.log(packageBinary(root, value, version));
    return;
  }
  const notes = releaseNotes(readFileSync(join(root, "CHANGELOG.md"), "utf8"), version, value, readFragments(join(root, "changelog.d")).files.length);
  console.log(operation === "--notes" ? notes : `release: ${value} metadata is valid`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main();
}
