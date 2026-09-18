import { digest } from "./validation-scenarios.mjs";

export const rediscoveryFamilies = [
  { id: "retry-identity", name: "Dispatch Ledger", problem: "A response lost during delivery can cause an operation to be committed twice." },
  { id: "lease-expiry", name: "Lease Cache", problem: "Cached leases disappear before their documented lifetime ends." },
  { id: "page-stream", name: "Archive Scanner", problem: "An archive scan silently omits records after a filtered page." },
  { id: "batch-correlation", name: "Settlement Queue", problem: "A completed batch attaches outcomes to the wrong jobs." },
  { id: "path-boundary", name: "Asset Gateway", problem: "The gateway admits resource names outside the selected namespace." },
];
export const rediscoveryFollowups = ["near", "generalization", "irrelevant", "changed"];

function retryCase(stage) {
  const changed = stage === "changed";
  const concurrent = stage === "generalization";
  const provider = `export const contract = { keyScope: ${JSON.stringify(changed ? "attempt" : "operation")}, attempts: 3 };
export function createServices() {
  const committed = new Map(); const lost = new Set(); const keys = new Set(); let sequence = 0;
  return { calls: 0, commits: 0, key() { return "request-" + (++sequence); }, async send(request) {
    this.calls += 1;
    if (contract.keyScope === "attempt" && keys.has(request.requestKey)) return { ok: false, reason: "attempt key already consumed" };
    keys.add(request.requestKey);
    const identity = contract.keyScope === "attempt" ? request.id : request.requestKey;
    if (committed.has(identity)) return { ok: true, value: committed.get(identity) };
    this.commits += 1; committed.set(identity, request.value);
    if (!lost.has(request.id)) { lost.add(request.id); return { ok: false, reason: "acknowledgement lost" }; }
    return { ok: true, value: request.value };
  } };
}
`;
  const body = mode => `import { contract } from "./provider.mjs";
export async function perform(input, services) {
  const pending = new Map();
  const execute = async operation => {
    ${mode === "operation" ? "const operationKey = services.key();" : ""}
    for (let attempt = 0; attempt < contract.attempts; attempt += 1) {
      const result = await services.send({ ...operation, requestKey: ${mode === "operation" ? "operationKey" : "services.key()"} });
      if (result.ok) return result.value;
    }
    throw new Error("delivery not acknowledged");
  };
  return Promise.all(input.operations.map(operation => {
    ${mode === "deduplicate" ? 'if (!pending.has(operation.id)) pending.set(operation.id, execute(operation)); return pending.get(operation.id);' : "return execute(operation);"}
  }));
}
`;
  const correct = `import { contract } from "./provider.mjs";
export async function perform(input, services) {
  const pending = new Map();
  const execute = async operation => {
    const stable = contract.keyScope === "operation" ? services.key() : null;
    for (let attempt = 0; attempt < contract.attempts; attempt += 1) {
      const result = await services.send({ ...operation, requestKey: stable ?? services.key() });
      if (result.ok) return result.value;
    }
    throw new Error("delivery not acknowledged");
  };
  return Promise.all(input.operations.map(operation => {
    if (!pending.has(operation.id)) pending.set(operation.id, execute(operation));
    return pending.get(operation.id);
  }));
}
`;
  const input = { operations: [{ id: "invoice-17", value: 41 }, ...(concurrent ? [{ id: "invoice-17", value: 41 }] : []), { id: "invoice-23", value: 73 }] };
  return { provider, initial: body(changed || concurrent ? "operation" : "attempt"), correct, input, empty: { operations: [] },
    expected: concurrent ? [41, 41, 73] : [41, 73], checks: "assert.equal(services.commits, 2);",
    edge: 'const services = createServices(); assert.deepEqual(await perform({operations:[{id:"single",value:0}]},services),[0]); assert.equal(services.commits,1);',
    contract: changed ? "A request key is consumed by each transport attempt and cannot be reused. The logical operation id, unchanged across attempts, provides commit deduplication. All successful callers must tolerate an acknowledgement loss."
      : "The provider deduplicates committed requests by request key. A lost acknowledgement may require retrying. Calls representing one logical operation must not produce multiple commits; separate operations must not collapse together.",
    problem: changed ? "After the provider contract changed, retrying a lost acknowledgement exhausts the request budget."
      : concurrent ? "Concurrent entries for one operation create duplicate deliveries even though transport retry tests pass." : rediscoveryFamilies[0].problem };
}

function leaseCase(stage) {
  const changed = stage === "changed"; const general = stage === "generalization";
  const input = { now: 10000, leases: [{ id: "alpha", ttl: changed ? 2000 : 2 }], steps: general
    ? [{ elapsed: 1500, renew: { id: "alpha", ttl: 2 } }, { elapsed: 2000 }]
    : [{ elapsed: 1999 }, { elapsed: 1 }] };
  const source = fixed => `import { contract } from "./provider.mjs";
export async function perform(input) {
  const scale = ${fixed ? 'contract.ttlUnit === "seconds" ? 1000 : 1' : changed || general ? "1000" : "1"};
  let now = input.now;
  const leases = new Map(input.leases.map(lease => [lease.id, now + lease.ttl * scale]));
  const snapshots = [];
  for (const step of input.steps) {
    now += step.elapsed;
    if (step.renew && leases.has(step.renew.id)) leases.set(step.renew.id, ${fixed ? "now" : "leases.get(step.renew.id)"} + step.renew.ttl * scale);
    snapshots.push([...leases].filter(([, deadline]) => now < deadline).map(([identity]) => identity));
  }
  return snapshots;
}
`;
  return { provider: `export const contract = { ttlUnit: ${JSON.stringify(changed ? "milliseconds" : "seconds")} };\nexport const createServices = () => ({});\n`,
    initial: source(false), correct: source(true), input, empty: { now: 0, leases: [], steps: [] }, expected: [["alpha"], []], checks: "",
    edge: `assert.deepEqual(await perform({now:0,leases:[{id:"edge",ttl:${changed ? 1000 : 1}}],steps:[{elapsed:1000}]},createServices()),[[]]);`,
    contract: `Clock and elapsed values are milliseconds. TTL values are ${changed ? "milliseconds" : "seconds"}. A lease is inactive exactly at its deadline. Renewal starts a new duration from the renewal time, not from the previous deadline. Input objects belong to the caller.`,
    problem: changed ? "The upgraded lease provider changed its duration contract and expired records now remain visible."
      : general ? "Renewed leases disappear too early even though initial lease durations are correct." : rediscoveryFamilies[1].problem };
}

function pageCase(stage) {
  const changed = stage === "changed"; const general = stage === "generalization";
  const source = fixed => `import { contract } from "./provider.mjs";
export async function perform(input, services) {
  let cursor = input.cursor; const output = []; const visited = new Set();
  while (cursor !== null) {
    ${fixed ? 'if (visited.has(cursor)) throw new Error("cursor cycle"); visited.add(cursor);' : ""}
    const page = await services.page(cursor); output.push(...page.items);
    ${fixed ? 'if (contract.termination === "complete" && page.complete) break;' : !general && !changed ? "if (!page.items.length) break;" : ""}
    cursor = page.next;
  }
  return output;
}
`;
  const provider = `export const contract = { termination: ${JSON.stringify(changed ? "complete" : "null-cursor")} };
export function createServices(cycle = false) {
  const pages = { start: {items:["one"],next:"filtered",complete:false}, filtered:{items:[],next:"last",complete:false},
    last:{items:["two"],next:${changed ? '"checkpoint"' : "null"},complete:true} };
  return { calls:0, async page(cursor) {
    this.calls += 1;
    if (this.calls > 6) throw new Error("request budget exceeded");
    if (cycle) return {items:[],next:cursor,complete:false};
    if (!pages[cursor]) throw new Error("completed snapshot cannot be continued");
    return pages[cursor];
  } };
}
`;
  return { provider, initial: source(false), correct: source(true), input: { cursor: "start" }, empty: { cursor: null }, expected: ["one", "two"], checks: "assert.equal(services.calls,3);",
    edge: general ? 'const services=createServices(true); await assert.rejects(perform({cursor:"start"},services),/cursor/); assert.ok(services.calls<=2);'
      : 'assert.deepEqual(await perform({cursor:"last"},createServices()),["two"]);',
    contract: changed ? "The complete flag is authoritative. A completed page can carry a non-null checkpoint for a future snapshot; continuing it now is invalid. Empty pages may precede completion. The null initial cursor means no work."
      : "The scan ends at a null continuation cursor. A filtered page may be empty but still have later records. The service can repeat a cursor on a stale snapshot; reject cycles within two requests rather than consuming the six-request budget.",
    problem: changed ? "A provider upgrade causes successful scans to issue an invalid extra request."
      : general ? "A stale snapshot causes a scan to keep requesting the same page until the budget is exhausted." : rediscoveryFamilies[2].problem };
}

function batchCase(stage) {
  const changed = stage === "changed"; const general = stage === "generalization";
  const provider = `export const contract = { identity: ${JSON.stringify(changed ? "source-index" : "job-id")} };
export function createServices() {
  const accepted = new Set(); let retried = false;
  return { duplicates:0, async settle(jobs) {
    return jobs.map((job,index) => {
      const ok = ${general ? 'job.id !== "job-b" || retried' : "true"};
      if (!ok) retried = true;
      if (ok) { if (accepted.has(job.id)) this.duplicates += 1; accepted.add(job.id); }
      return { ${changed ? "sourceIndex:index,attemptId:" : "id:"}job.id, value:job.value * 2, ok };
    }).reverse();
  } };
}
`;
  const initial = `import { contract } from "./provider.mjs";
export async function perform(input, services) {
  let results = await services.settle(input.jobs);
  if (results.some(result => !result.ok)) results = await services.settle(input.jobs);
  return input.jobs.map((job,index) => ${changed || general ? "results.find(result => result.id === job.id)?.value" : "results[index]?.value"});
}
`;
  const correct = `import { contract } from "./provider.mjs";
export async function perform(input, services) {
  const values = new Map(); let pending = [...input.jobs];
  for (let attempt=0; pending.length && attempt<3; attempt+=1) {
    const results = await services.settle(pending);
    for (const result of results) if (result.ok) {
      const identity = contract.identity === "source-index" ? pending[result.sourceIndex].id : result.id;
      values.set(identity,result.value);
    }
    pending = pending.filter(job => !values.has(job.id));
  }
  if (pending.length) throw new Error("unresolved jobs");
  return input.jobs.map(job => values.get(job.id));
}
`;
  return { provider, initial, correct, input: { jobs: [{ id: "job-a", value: 7 }, { id: "job-b", value: 19 }] }, empty: { jobs: [] }, expected: [14, 38],
    checks: "assert.equal(services.duplicates,0);", edge: 'assert.deepEqual(await perform({jobs:[{id:"single",value:0}]},createServices()),[0]);',
    contract: changed ? "Results may arrive in any order. sourceIndex refers to the submitted batch, not the original workload. attemptId is not a stable job identifier. Return values in original job order. Retry only unresolved jobs."
      : "Results may arrive in any order and carry the stable job id. Preserve the original requested order. Accepted jobs cannot be settled a second time; retry only unresolved jobs. Input belongs to the caller.",
    problem: changed ? "After the result-envelope upgrade, completed jobs return missing values."
      : general ? "Recovering a partially accepted batch settles already-completed jobs again." : rediscoveryFamilies[3].problem };
}

function pathCase(stage) {
  const changed = stage === "changed"; const general = stage === "generalization";
  const initial = `import { posix } from "node:path";
import { contract } from "./provider.mjs";
export async function perform(input) {
  return input.paths.filter(value => {
    const candidate = ${changed || general ? "posix.normalize(value)" : "value"};
    return ${changed || general ? 'candidate === input.root || candidate.startsWith(input.root + "/")' : "candidate.startsWith(input.root)"};
  });
}
`;
  const correct = `import { posix } from "node:path";
import { contract } from "./provider.mjs";
export async function perform(input) {
  return input.paths.filter(value => {
    let candidate;
    try { candidate = contract.namespace === "opaque" ? value : posix.normalize(decodeURIComponent(value)); } catch { return false; }
    return candidate === input.root || candidate.startsWith(input.root + "/");
  });
}
`;
  const paths = ["/team/app/report", "/team/application/other", ...(general ? ["/team/app/%2e%2e/private"] : []), ...(changed ? ["/team/app/../literal"] : [])];
  return { provider: `export const contract = {namespace:${JSON.stringify(changed ? "opaque" : "filesystem")}};\nexport const createServices=()=>({});\n`, initial, correct,
    input: { root: "/team/app", paths }, empty: { root: "/team/app", paths: [] }, expected: ["/team/app/report", ...(changed ? ["/team/app/../literal"] : [])], checks: "",
    edge: 'assert.deepEqual(await perform({root:"/team/app",paths:["/team/app","/team/other"]},createServices()),["/team/app"]);',
    contract: changed ? "Resource names are opaque object keys, not filesystem or URL paths. Dot segments and percent sequences are literal. A namespace includes its exact root and names starting with root followed by a slash, not a different prefix-sharing name."
      : "Resource names are URL-encoded filesystem paths. Decode them, then apply POSIX path semantics. A namespace includes its exact root and descendants, not neighboring names with the same prefix. Malformed encodings must be rejected.",
    problem: changed ? "The new object store rejects valid literal keys after the gateway reuses filesystem normalization."
      : general ? "Encoded resource names bypass the namespace check despite ordinary path tests passing." : rediscoveryFamilies[4].problem };
}

function unrelatedCase(family) {
  const variants = {
    "retry-identity": { initial: 'return input.records.sort((left,right)=>left.rank-right.rank).map(record=>record.id);', correct: 'return [...input.records].sort((left,right)=>left.rank-right.rank).map(record=>record.id);', input: { records: [{ id: "later", rank: 2 }, { id: "first", rank: 1 }] }, expected: ["first", "later"], empty: { records: [] }, contract: "Return record identities in ascending rank. Never mutate the caller-owned records array.", problem: "Rendering a priority summary changes the caller's original record order." },
    "lease-expiry": { initial: 'return [...new Map(input.records.map(record=>[record.id.toLowerCase(),record.value])).values()];', correct: 'return [...new Map(input.records.map(record=>[record.id,record.value])).values()];', input: { records: [{ id: "Asset", value: 4 }, { id: "asset", value: 9 }] }, expected: [4, 9], empty: { records: [] }, contract: "Record identities are case-sensitive. Keep the latest value per exact identity in first-seen identity order.", problem: "A label summary loses entries whose identifiers differ only in case." },
    "page-stream": { initial: 'return input.labels.map(label=>label.length);', correct: 'return input.labels.map(label=>Buffer.byteLength(label,"utf8"));', input: { labels: ["ascii", "caf\u00e9"] }, expected: [5, 5], empty: { labels: [] }, contract: "Report UTF-8 byte lengths, not character or UTF-16 code-unit counts.", problem: "The export manifest reports incorrect byte counts for non-ASCII labels." },
    "batch-correlation": { initial: 'return input.labels.map(label=>label.replace("&","&amp;").replace("<","&lt;"));', correct: 'return input.labels.map(label=>label.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;"));', input: { labels: ["A&B&C", "<x><y>"] }, expected: ["A&amp;B&amp;C", "&lt;x&gt;&lt;y&gt;"], empty: { labels: [] }, contract: "Encode every ampersand, less-than and greater-than sign exactly once for plain HTML text.", problem: "The batch report escapes the first punctuation mark but leaves later ones unescaped." },
    "path-boundary": { initial: 'return input.values.filter(Boolean);', correct: 'return input.values.filter(value=>value!==null&&value!==undefined);', input: { values: [0, false, "", null, 9] }, expected: [0, false, "", 9], empty: { values: [] }, contract: "Remove only null or undefined report values; zero, false and empty strings are valid values.", problem: "A settings report silently removes valid zero and false values." },
  };
  const variant = variants[family];
  return { ...variant, initial: `export async function perform(input) { ${variant.initial} }\n`, correct: `export async function perform(input) { ${variant.correct} }\n`,
    provider: "export const createServices=()=>({});\n", edge: "assert.deepEqual(await perform(emptyInput,createServices()),[]);", checks: "" };
}

function definition(family, stage) {
  if (stage === "irrelevant") return unrelatedCase(family);
  return { "retry-identity": retryCase, "lease-expiry": leaseCase, "page-stream": pageCase, "batch-correlation": batchCase, "path-boundary": pathCase }[family](stage);
}

export function rediscoveryFixture(family, stage = "preparation") {
  const selected = rediscoveryFamilies.find(item => item.id === family);
  if (!selected || !["preparation", ...rediscoveryFollowups].includes(stage)) throw new Error("invalid_rediscovery_fixture");
  const spec = definition(family, stage);
  const modulePath = `src/${stage === "preparation" ? "worker" : stage === "near" ? "consumer" : stage === "generalization" ? "coordinator" : stage === "irrelevant" ? "report" : "adapter"}.mjs`;
  const tests = `import assert from "node:assert/strict";
import test from "node:test";
import {perform} from "../${modulePath}";
import {createServices} from "../src/provider.mjs";
const input=${JSON.stringify(spec.input)};
const emptyInput=${JSON.stringify(spec.empty)};
test("behavior/required outcome",async()=>{ const services=createServices(); assert.deepEqual(await perform(structuredClone(input),services),${JSON.stringify(spec.expected)}); ${spec.checks} });
test("behavior/edge conditions",async()=>{ ${spec.edge} });
test("regression/input ownership",async()=>{ const copy=structuredClone(input); await perform(copy,createServices()); assert.deepEqual(copy,input); });
`;
  const fixture = { files: { "package.json": '{"name":"relay-dock","private":true,"type":"module"}\n',
    "README.md": `# Relay Dock / ${selected.name}\n\nThis private fixture implements a repository-specific adapter. The public perform(input, services) function is asynchronous. Read ordinary repository documentation and source as needed. Implementation changes are limited to ${modulePath}. The contract, provider and test files are immutable.\n\nCurrent issue: ${spec.problem}\n`,
    "docs/current-contract.md": `# Current Contract\n\n${spec.contract}\n`, "src/provider.mjs": spec.provider, [modulePath]: spec.initial },
    editable: [modulePath], tests, testCount: 3, testNames: ["behavior/required outcome", "behavior/edge conditions", "regression/input ownership"] };
  return { ...fixture, id: `${family}/${stage}`, family, stage, modulePath, problem: spec.problem, fixtureVersion: 1, fixtureSha256: digest(fixture) };
}

export function rediscoveryFixtureRepair(family, stage = "preparation") {
  return definition(family, stage).correct;
}
