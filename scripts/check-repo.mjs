import { execFileSync } from "node:child_process";

for (const args of [
  ["--check", "examples/agent-memory.mjs"],
  ["--check", "scripts/container-smoke.mjs"],
  ["scripts/adr-index.mjs", "--check"],
  ["scripts/changelog.mjs", "--check"],
  ["scripts/check-docs.mjs"],
  ["--test", "scripts/repository.test.mjs", "examples/benchmark-recall.test.mjs", "examples/validation-harness.test.mjs"],
]) {
  execFileSync(process.execPath, args, { stdio: "inherit" });
}
