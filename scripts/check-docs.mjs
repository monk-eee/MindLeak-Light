import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function checkDocs(root) {
  const problems = [];
  const excluded = new Set([".git", "target", "dist", "node_modules", ".venv"]);
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (excluded.has(entry.name) || entry.isSymbolicLink()) continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(path);
      } else if (entry.name.endsWith(".md")) {
        const text = readFileSync(path, "utf8").replace(/^```[^\n]*\n[\s\S]*?^```/gm, "");
        for (const match of text.matchAll(/\[[^\]]*\]\(([^\s)]+)(?:\s+"[^"]*")?\)/g)) {
          const target = match[1];
          if (/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(target)) continue;
          const destination = resolve(dirname(path), decodeURIComponent(target.split(/[?#]/)[0]));
          if (relative(root, destination).startsWith("..") || !existsSync(destination)) {
            problems.push(`${relative(root, path)}: unresolved local link ${target}`);
          }
        }
      }
    }
  }
  visit(root);
  return problems;
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  const problems = checkDocs(realpathSync(process.cwd()));
  if (problems.length) {
    console.error(problems.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("docs: local Markdown links resolve");
  }
}
