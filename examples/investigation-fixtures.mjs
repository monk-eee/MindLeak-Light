import { digest } from "./validation-scenarios.mjs";

const definitions = [
  { id: "ledger-discovery", role: "discovery", sourceGroup: "ledger-service", rows: ["account-17", "account-29"], emptyAt: 1 },
  { id: "audit-discovery", role: "discovery", sourceGroup: "audit-service", rows: ["event-41", "event-62", "event-88"], emptyAt: 2, nested: true },
  { id: "receipt-validation", role: "validation_positive", sourceGroup: "receipt-service", rows: ["receipt-5", "receipt-9"], emptyAt: 0 },
  { id: "snapshot-validation", role: "validation_boundary", sourceGroup: "snapshot-service", rows: ["snapshot-3", "snapshot-7"], emptyAt: 1, completion: true },
  { id: "account-transfer", role: "near", sourceGroup: "account-service", rows: ["account-102", "account-204"], emptyAt: 1 },
  { id: "archive-transfer", role: "generalization", sourceGroup: "archive-service", rows: ["archive-12", "archive-18", "archive-24"], emptyAt: 0, nested: true },
  { id: "export-change", role: "changed", sourceGroup: "export-service", rows: ["export-30", "export-60"], emptyAt: 2, completion: true },
  { id: "identity-control", role: "irrelevant", sourceGroup: "identity-service", rows: ["record-04", "record-08"], emptyAt: 1, scanCorrect: true },
];

export const cursorRuleImplementation = `export async function collect(client) {
  const result = []; let cursor = "start";
  while (cursor !== null) {
    const page = await client.page(cursor);
    result.push(...page.items);
    cursor = page.next;
  }
  return result;
}
`;

export function investigationFixture(id) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error("unknown_investigation_case");
  const pages = definition.rows.map(value => [value]);
  pages.splice(definition.emptyAt, 0, []);
  const records = pages.map((items, index) => ({ items, next: index < pages.length - 1 ? `page-${index + 1}` : definition.completion ? "resume-later" : null,
    complete: index === pages.length - 1 }));
  const provider = `export function createClient() {
  const pages = ${JSON.stringify(records)}; let calls = 0;
  return { async page(cursor) {
    if (++calls > pages.length + 2) throw new Error("request budget exhausted");
    const index = cursor === "start" ? 0 : Number(cursor.replace("page-", ""));
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error("invalid continuation cursor");
    return structuredClone(pages[index]);
  } };
}
`;
  const scanner = definition.scanCorrect ? cursorRuleImplementation : definition.nested
    ? `async function consume(client, cursor, result) {
  const page = await client.page(cursor);
  if (!page.items.length) return result;
  result.push(...page.items);
  return page.next === null ? result : consume(client, page.next, result);
}
export const collect = client => consume(client, "start", []);
`
    : `export async function collect(client) {
  const result = []; let cursor = "start";
  while (cursor !== null) {
    const page = await client.page(cursor);
    if (!page.items.length) break;
    result.push(...page.items); cursor = page.next;
  }
  return result;
}
`;
  const render = definition.role === "discovery" || definition.role === "irrelevant"
    ? "export const identify = value => value.toUpperCase();\n" : "export const identify = value => value;\n";
  const files = {
    "README.md": `# ${definition.sourceGroup}\nThe export drops or changes records. Establish the cause and preserve exact record identities. Report verified findings even if other checks remain unresolved.\n`,
    "docs/service-contract.md": definition.completion
      ? "This snapshot is complete only when page.complete is true. A completed page can return a non-null cursor reserved for a later snapshot. Empty pages are possible. Record identities are case-sensitive.\n"
      : "A null next cursor marks completion. A non-null next cursor must be followed even when the page contains no records. Record identities are case-sensitive.\n",
    "src/provider.mjs": provider,
    "src/scan.mjs": scanner,
    "src/identity.mjs": render,
  };
  const tests = `import assert from "node:assert/strict";
import test from "node:test";
import { collect } from "../src/scan.mjs";
import { identify } from "../src/identity.mjs";
import { createClient } from "../src/provider.mjs";
test("behavior/complete records", async () => assert.deepEqual(await collect(createClient()), ${JSON.stringify(definition.rows)}));
test("behavior/empty page is not terminal", async () => {
  let calls = 0;
  const client = { async page() { return calls++ === 0 ? {items:[],next:"remaining",complete:false} : {items:["last"],next:${definition.completion ? '"resume-later"' : "null"},complete:true}; } };
  const guarded = { async page(cursor) { if (calls > 2) throw new Error("completed snapshot was continued"); return client.page(cursor); } };
  assert.deepEqual(await collect(guarded), ["last"]);
});
test("regression/record identity", () => assert.equal(identify("record-aB"), "record-aB"));
`;
  const fixture = { id, role: definition.role, sourceGroup: definition.sourceGroup, family: "continuation-contract", files, tests,
    editable: ["src/scan.mjs", "src/identity.mjs"], modulePath: "src/scan.mjs", testCount: 3,
    testGroups: { behavior: 2, regression: 1 }, testNames: ["behavior/complete records", "behavior/empty page is not terminal", "regression/record identity"],
    problem: "Investigate missing or changed records. Establish the continuation and identity requirements, test the smallest suitable changes, and retain verified evidence even if the task remains unfinished." };
  return { ...fixture, fixtureSha256: digest(fixture) };
}

export function investigationCases() {
  return definitions.map(({ id }) => {
    const { role, sourceGroup, fixtureSha256 } = investigationFixture(id);
    return { id, role, sourceGroup, fixtureSha256 };
  });
}

export function investigationRepair(id) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error("unknown_investigation_case");
  return definition.completion ? cursorRuleImplementation.replace("cursor = page.next;", "if (page.complete) break;\n    cursor = page.next;") : cursorRuleImplementation;
}

export function investigationDecision(id) {
  const definition = definitions.find(item => item.id === id);
  if (!definition) throw new Error("unknown_investigation_case");
  return { cause: definition.role === "irrelevant" ? "identity" : "continuation",
    stopSignal: definition.role === "irrelevant" ? "not_applicable" : definition.completion ? "completion" : "cursor",
    applicable: !definition.completion && definition.role !== "irrelevant" };
}
