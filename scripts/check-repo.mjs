import { execFileSync } from "node:child_process";

for (const args of [
  ["scripts/adr-index.mjs", "--check"],
  ["scripts/changelog.mjs", "--check"],
  ["scripts/check-docs.mjs"],
  ["--test", "scripts/repository.test.mjs"],
]) {
  execFileSync(process.execPath, args, { stdio: "inherit" });
}
