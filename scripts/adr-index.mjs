import { readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export const ADR_DIR = "adr.d";

export function readAdrs(directory = ADR_DIR) {
  const numbers = new Set();
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md") && !["README.md", "TEMPLATE.md"].includes(name))
    .sort()
    .map((file) => {
      const number = /^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.md$/.exec(file)?.[1];
      if (!number || numbers.has(number)) throw new Error(`${file}: invalid or duplicate ADR number`);
      numbers.add(number);
      const text = readFileSync(join(directory, file), "utf8");
      const title = new RegExp(`^# ADR-${number}: (.+)$`, "m").exec(text)?.[1];
      const status = /^- Status: (.+)$/m.exec(text)?.[1];
      const date = /^- Date: (\d{4}-\d{2}-\d{2})$/m.exec(text)?.[1];
      if (!title || !date || Number.isNaN(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
        throw new Error(`${file}: requires a matching title and valid ISO date`);
      }
      if (!/^(Proposed|Accepted|Rejected|Deprecated)$/.test(status ?? "")) {
        const successor = /^Superseded by \[ADR-(\d{4})\]\((\d{4}-[a-z0-9-]+\.md)\)$/.exec(status ?? "");
        if (!successor || successor[1] === number || !successor[2].startsWith(successor[1]) || !readdirSync(directory).includes(successor[2])) {
          throw new Error(`${file}: invalid status or superseding ADR reference`);
        }
      }
      for (const section of ["Context", "Decision", "Consequences", "Verification"]) {
        if (!text.includes(`\n## ${section}\n`)) throw new Error(`${file}: missing ${section}`);
      }
      return { number, file, title, status };
    });
}

export function updateIndex(original, records) {
  const table = [
    "| ADR | Title | Status |",
    "|---|---|---|",
    ...records.map(({ number, file, title, status }) =>
      `| [${number}](${file}) | ${title.replaceAll("|", "\\|")} | ${status.replaceAll("|", "\\|")} |`),
  ].join("\n");
  const pattern = /\| ADR \| Title \| Status \|\r?\n\|---\|---\|---\|(?:\r?\n\|.*)*/;
  if (!pattern.test(original)) throw new Error("ADR index has no generated table");
  return original.replace(pattern, () => table);
}

function main() {
  const args = process.argv.slice(2);
  if (args.some((arg) => arg !== "--check")) throw new Error("usage: adr-index.mjs [--check]");
  const records = readAdrs();
  const path = join(ADR_DIR, "README.md");
  const original = readFileSync(path, "utf8");
  const updated = updateIndex(original, records);
  if (args.includes("--check") && original !== updated) {
    throw new Error("ADR index is stale; run node scripts/adr-index.mjs");
  }
  if (!args.includes("--check") && original !== updated) writeFileSync(path, updated);
  console.log(`adr-index: ${records.length} valid records; index is current`);
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main();
}
