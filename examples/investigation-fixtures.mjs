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

const qualityDefinitions = [
  { id: "quality-ledger-discovery", role: "discovery", sourceGroup: "quality-ledger", rows: ["entry-13", "entry-27"], emptyAt: 1 },
  { id: "quality-audit-discovery", role: "discovery", sourceGroup: "quality-audit", rows: ["audit-38", "audit-49"], emptyAt: 0, nested: true },
  { id: "quality-receipt-validation", role: "validation_positive", sourceGroup: "quality-receipt", rows: ["receipt-51", "receipt-67"], emptyAt: 1 },
  { id: "quality-journal-validation", role: "validation_positive", sourceGroup: "quality-journal", rows: ["journal-72", "journal-83"], emptyAt: 0, nested: true },
  { id: "quality-snapshot-exception", role: "exception", sourceGroup: "quality-snapshot", rows: ["snapshot-94", "snapshot-106"], emptyAt: 1, completion: true },
  { id: "quality-export-exception", role: "exception", sourceGroup: "quality-export", rows: ["export-117", "export-128"], emptyAt: 0, completion: true, nested: true },
  { id: "quality-cursor-revalidation", role: "revision_validation_positive", sourceGroup: "quality-cursor-check", rows: ["cursor-139", "cursor-141"], emptyAt: 1 },
  { id: "quality-boundary-revalidation", role: "revision_validation_boundary", sourceGroup: "quality-boundary-check", rows: ["boundary-152", "boundary-163"], emptyAt: 0, completion: true },
  { id: "quality-ledger-transfer", role: "near", sourceGroup: "quality-ledger-transfer", rows: ["account-174", "account-185"], emptyAt: 1 },
  { id: "quality-archive-transfer", role: "generalization", sourceGroup: "quality-archive-transfer", rows: ["archive-196", "archive-207", "archive-218"], emptyAt: 0, nested: true },
  { id: "quality-snapshot-transfer", role: "changed", sourceGroup: "quality-snapshot-transfer", rows: ["object-229", "object-240"], emptyAt: 1, completion: true },
  { id: "quality-identity-control", role: "irrelevant", sourceGroup: "quality-identity-control", rows: ["record-aB251", "record-Cd262"], emptyAt: 1, scanCorrect: true },
];
const definitionFor = id => [...definitions, ...qualityDefinitions].find(item => item.id === id);

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

export const qualityRuleImplementation = `export async function collect(client) {
  const result = []; const visited = new Set(); let cursor = "start";
  while (cursor !== null) {
    if (visited.has(cursor)) throw new Error("cursor cycle");
    visited.add(cursor);
    const page = await client.page(cursor);
    result.push(...page.items);
    if (client.termination === "complete" && page.complete) break;
    cursor = page.next;
  }
  return result;
}
`;

export function investigationFixture(id) {
  const definition = definitionFor(id);
  if (!definition) throw new Error("unknown_investigation_case");
  const quality = qualityDefinitions.includes(definition);
  const termination = definition.completion ? "complete" : "cursor";
  const pages = definition.rows.map(value => [value]);
  pages.splice(definition.emptyAt, 0, []);
  const records = pages.map((items, index) => ({ items, next: index < pages.length - 1 ? `page-${index + 1}` : definition.completion ? "resume-later" : null,
    complete: index === pages.length - 1 }));
  const provider = `export function createClient() {
  const pages = ${JSON.stringify(records)}; let calls = 0;
  return { ${quality ? `termination: ${JSON.stringify(termination)}, ` : ""}async page(cursor) {
    if (++calls > pages.length + 2) throw new Error("request budget exhausted");
    const index = cursor === "start" ? 0 : Number(cursor.replace("page-", ""));
    if (!Number.isInteger(index) || index < 0 || index >= pages.length) throw new Error("invalid continuation cursor");
    return structuredClone(pages[index]);
  } };
}
`;
  const scanner = definition.scanCorrect ? quality ? qualityRuleImplementation : cursorRuleImplementation : definition.nested
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
  if (quality) files["docs/service-contract.md"] += "The client.termination field names the authoritative completion contract: cursor or complete. Ignore incidental completion flags in cursor mode. Reject repeated cursors before requesting the same page twice. Never mutate source pages or change record spelling, order or duplicate occurrences.\n";
  let tests = `import assert from "node:assert/strict";
import test from "node:test";
import { collect } from "../src/scan.mjs";
import { identify } from "../src/identity.mjs";
import { createClient } from "../src/provider.mjs";
test("behavior/complete records", async () => assert.deepEqual(await collect(createClient()), ${JSON.stringify(definition.rows)}));
test("behavior/empty page is not terminal", async () => {
  let calls = 0;
  const client = { async page() { return calls++ === 0 ? {items:[],next:"remaining",complete:false} : {items:["last"],next:${definition.completion ? '"resume-later"' : "null"},complete:true}; } };
  const guarded = { ${quality ? `termination: ${JSON.stringify(termination)}, ` : ""}async page(cursor) { if (calls > 2) throw new Error("completed snapshot was continued"); return client.page(cursor); } };
  assert.deepEqual(await collect(guarded), ["last"]);
});
test("regression/record identity", () => assert.equal(identify("record-aB"), "record-aB"));
`;
  const publicTests = tests;
  if (quality) tests += `test("boundary/authoritative completion", async () => {
  let calls = 0;
  const client = { termination: ${JSON.stringify(termination)}, async page() {
    calls += 1;
    if (calls > ${definition.completion ? 1 : 2}) throw new Error("unexpected continuation");
    return calls === 1 ? {items:["first"],next:"next",complete:true} : {items:["second"],next:null,complete:true};
  } };
  assert.deepEqual(await collect(client), ${definition.completion ? '["first"]' : '["first","second"]'});
});
test("boundary/consecutive empty pages", async () => {
  let calls = 0;
  const client = { termination: ${JSON.stringify(termination)}, async page() {
    calls += 1;
    if (calls > 4) throw new Error("unexpected continuation");
    return calls < 4 ? {items:[],next:"empty-"+calls,complete:false} : {items:["retained"],next:${definition.completion ? '"later-snapshot"' : "null"},complete:true};
  } };
  assert.deepEqual(await collect(client), ["retained"]);
});
test("boundary/cursor cycle", async () => {
  let calls = 0;
  const client = { termination: ${JSON.stringify(termination)}, async page(cursor) {
    calls += 1;
    if (calls > 3) throw new Error("request budget exhausted");
    return {items:[],next:cursor,complete:false};
  } };
  await assert.rejects(collect(client), /cursor|cycle/i);
  assert.equal(calls, 1);
});
test("regression/source pages unchanged", async () => {
  const page = {items:["unaltered"],next:null,complete:true};
  const original = structuredClone(page);
  assert.deepEqual(await collect({termination:${JSON.stringify(termination)},async page(){return page;}}), ["unaltered"]);
  assert.deepEqual(page, original);
});
test("regression/record order and duplicates", async () => {
  const items = ["same", "MiXeD", "same"];
  assert.deepEqual(await collect({termination:${JSON.stringify(termination)},async page(){return {items,next:null,complete:true};}}), items);
});
`;
  const fixture = { id, role: definition.role, sourceGroup: definition.sourceGroup, family: "continuation-contract", files, tests,
    editable: ["src/scan.mjs", "src/identity.mjs"], modulePath: "src/scan.mjs", testCount: 3,
    testGroups: { behavior: 2, regression: 1 }, testNames: ["behavior/complete records", "behavior/empty page is not terminal", "regression/record identity"],
    problem: "Investigate missing or changed records. Establish the continuation and identity requirements, test the smallest suitable changes, and retain verified evidence even if the task remains unfinished." };
  if (quality) Object.assign(fixture, { quality: true, publicTests, publicTestCount: 3, publicTestNames: [...fixture.testNames],
    publicTestGroups: { behavior: 2, regression: 1 }, testCount: 8, testGroups: { behavior: 2, boundary: 3, regression: 3 },
    testNames: [...fixture.testNames, "boundary/authoritative completion", "boundary/consecutive empty pages", "boundary/cursor cycle",
      "regression/source pages unchanged", "regression/record order and duplicates"] });
  return { ...fixture, fixtureSha256: digest(fixture) };
}

export function investigationCases(profile = "mechanism") {
  if (!["mechanism", "quality"].includes(profile)) throw new Error("unknown_investigation_profile");
  return (profile === "quality" ? qualityDefinitions : definitions).map(({ id }) => {
    const { role, sourceGroup, fixtureSha256 } = investigationFixture(id);
    return { id, role, sourceGroup, fixtureSha256 };
  });
}

export function investigationRepair(id) {
  const definition = definitionFor(id);
  if (!definition) throw new Error("unknown_investigation_case");
  if (qualityDefinitions.includes(definition)) return qualityRuleImplementation;
  return definition.completion ? cursorRuleImplementation.replace("cursor = page.next;", "if (page.complete) break;\n    cursor = page.next;") : cursorRuleImplementation;
}

export function investigationDecision(id) {
  const definition = definitionFor(id);
  if (!definition) throw new Error("unknown_investigation_case");
  return { cause: definition.role === "irrelevant" ? "identity" : "continuation",
    stopSignal: definition.role === "irrelevant" ? "not_applicable" : definition.completion ? "completion" : "cursor",
    applicable: !definition.completion && definition.role !== "irrelevant" };
}
