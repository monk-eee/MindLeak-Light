import { readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const SECTIONS = ["added", "changed", "deprecated", "removed", "fixed", "security"];

export function readFragments(directory = "changelog.d") {
  const files = readdirSync(directory).filter((name) => name !== "README.md").sort();
  const grouped = new Map();
  for (const file of files) {
    const section = /^([a-z]+)-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(file)?.[1];
    if (!SECTIONS.includes(section)) throw new Error(`${file}: invalid changelog section or filename`);
    const body = readFileSync(join(directory, file), "utf8").trim();
    if (!body.startsWith("- ") || /^#/m.test(body)) throw new Error(`${file}: expected bullets without headings`);
    if (!grouped.has(section)) grouped.set(section, []);
    grouped.get(section).push(body);
  }
  return { files, grouped };
}

export function render(grouped) {
  return SECTIONS.filter((section) => grouped.get(section)?.length)
    .map((section) => `### ${section[0].toUpperCase()}${section.slice(1)}\n${grouped.get(section).join("\n")}`)
    .join("\n\n");
}

export function releaseChangelog(original, grouped, version, date) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("release version must be a semantic version");
  }
  if (original.includes(`## [${version}]`)) throw new Error(`version ${version} is already released`);
  const heading = "## [Unreleased]";
  const start = original.indexOf(heading);
  if (start < 0) throw new Error("CHANGELOG.md has no Unreleased section");
  const next = original.indexOf("\n## [", start + heading.length);
  const unreleased = original.slice(start + heading.length, next < 0 ? undefined : next).trim();
  const merged = new Map(SECTIONS.map((section) => [section, []]));
  let section;
  for (const line of unreleased.split(/\r?\n/)) {
    const match = /^### (.+)$/.exec(line);
    if (match) {
      section = match[1].toLowerCase();
      if (!SECTIONS.includes(section)) throw new Error(`unknown Unreleased section: ${section}`);
    } else if (line.trim()) {
      if (!section) throw new Error("Unreleased text must be inside a changelog section");
      merged.get(section).push(line);
    }
  }
  for (const [section, entries] of grouped) merged.get(section).push(...entries);
  const body = render(merged);
  if (!body) throw new Error("nothing to release");
  const tail = next < 0 ? "" : original.slice(next + 1);
  return `${original.slice(0, start)}${heading}\n\n## [${version}] - ${date}\n\n${body}\n\n${tail}`;
}

function main() {
  const args = process.argv.slice(2);
  const { files, grouped } = readFragments();
  if (args.length === 1 && args[0] === "--check") {
    if (!readFileSync("CHANGELOG.md", "utf8").includes("## [Unreleased]")) throw new Error("missing Unreleased heading");
    console.log(`changelog: ${files.length} valid fragments`);
  } else if (!args.length || (args.length === 1 && args[0] === "--preview")) {
    console.log(render(grouped) || "No unreleased fragments.");
  } else if (args.length === 2 && args[0] === "--release") {
    const updated = releaseChangelog(readFileSync("CHANGELOG.md", "utf8"), grouped, args[1], new Date().toISOString().slice(0, 10));
    writeFileSync("CHANGELOG.md", updated);
    for (const file of files) rmSync(join("changelog.d", file));
    console.log(`changelog: released ${args[1]} from ${files.length} fragments`);
  } else {
    throw new Error("usage: changelog.mjs [--check | --preview | --release VERSION]");
  }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main();
}
