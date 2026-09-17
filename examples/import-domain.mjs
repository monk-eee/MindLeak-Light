import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

export const MAX_IMPORT_BYTES = 64 * 1024 * 1024;
const MAX_RECORDS = 100000;
const hash = text => createHash("sha256").update(text).digest("hex");
const fields = (value, allowed) => value && typeof value === "object" && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key));
const text = (value, maximum) => typeof value === "string" && value.isWellFormed()
  && value.trim().length > 0 && !value.includes("\0") && Buffer.byteLength(value) <= maximum;
const identifier = value => text(value, 256) && value.trim() === value && !/\p{Cc}/u.test(value);

export function domainRequestId(namespace, kind, id) {
  const bytes = createHash("sha256").update(JSON.stringify(["mindleak-domain-v1", namespace, kind, id])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 128;
  bytes[8] = (bytes[8] & 63) | 128;
  const value = bytes.toString("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
}

export function planDomainImport(source) {
  if (typeof source !== "string" || Buffer.byteLength(source) > MAX_IMPORT_BYTES) throw new Error("input_exceeds_64_mib");
  const lines = source.split(/\r?\n/);
  let header;
  try { header = JSON.parse(lines.shift()); } catch { throw new Error("invalid_import_header"); }
  if (!fields(header, ["format", "version", "namespace", "scope"]) || header.format !== "mindleak-domain"
    || header.version !== 1 || !identifier(header.namespace)
    || (header.scope != null && !text(header.scope, 256))) throw new Error("unsupported_import_header");
  header.scope ??= null;
  const identity = id => ({ namespace: header.namespace, id });
  const records = [];
  const identities = new Map();
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    if (records.length >= MAX_RECORDS) throw new Error("input_exceeds_100000_records");
    const item = { line: index + 2, sha256: hash(raw), kind: "unknown", status: "ready" };
    records.push(item);
    let value;
    try { value = JSON.parse(raw); } catch { item.status = "unsupported"; item.reason = "invalid_json"; continue; }
    item.kind = ["entity", "edge"].includes(value?.kind) ? value.kind : "unknown";
    const validCommon = identifier(value?.id) && text(value?.text, 32768);
    if (item.kind === "entity" && validCommon && fields(value, ["kind", "id", "label", "entityType", "text"])
      && text(value.label, 1024) && text(value.entityType, 256)) {
      item.domain = { kind: "entity", identity: identity(value.id), label: value.label, entityType: value.entityType };
    } else if (item.kind === "edge" && validCommon && fields(value, ["kind", "id", "source", "target", "predicate", "provenance", "text"])
      && identifier(value.source) && identifier(value.target) && identifier(value.predicate)
      && fields(value.provenance, ["sourceReferences", "reportedConfidence"])
      && Array.isArray(value.provenance.sourceReferences) && value.provenance.sourceReferences.length >= 1
      && value.provenance.sourceReferences.length <= 8 && value.provenance.sourceReferences.every(reference => text(reference, 1024))
      && (value.provenance.reportedConfidence === undefined || value.provenance.reportedConfidence === null
        || (typeof value.provenance.reportedConfidence === "number" && Number.isFinite(value.provenance.reportedConfidence)
          && value.provenance.reportedConfidence >= 0 && value.provenance.reportedConfidence <= 1))) {
      const provenance = { sourceReferences: value.provenance.sourceReferences };
      if (value.provenance.reportedConfidence != null) provenance.reportedConfidence = value.provenance.reportedConfidence;
      item.domain = { kind: "edge", identity: identity(value.id), source: identity(value.source), target: identity(value.target),
        predicate: value.predicate, provenance };
    } else { item.status = "unsupported"; item.reason = "unsupported_record_or_fields"; continue; }
    item.text = value.text;
    item.requestId = domainRequestId(header.namespace, item.kind, value.id);
    const key = JSON.stringify([item.kind, value.id]);
    const group = identities.get(key) ?? { text: item.text, domain: item.domain, records: [], conflict: false };
    if (!group.conflict && (group.text !== item.text || !isDeepStrictEqual(group.domain, item.domain))) {
      group.conflict = true;
      for (const other of group.records) { other.status = "conflict"; other.reason = "duplicate_identity_changed_payload"; }
    }
    if (group.conflict) { item.status = "conflict"; item.reason = "duplicate_identity_changed_payload"; }
    group.records.push(item);
    identities.set(key, group);
  }
  const entities = new Set(records.filter(item => item.kind === "entity" && item.status === "ready").map(item => item.domain.identity.id));
  for (const item of records.filter(item => item.kind === "edge" && item.status === "ready")) {
    if (!entities.has(item.domain.source.id) || !entities.has(item.domain.target.id)) {
      item.status = "unresolved"; item.reason = "endpoint_missing_or_unsupported_in_input";
    }
  }
  return { format: "mindleak-domain", version: 1, sourceSha256: hash(source), header, records };
}

export function importReport(plan, applied = false, server) {
  const counts = {};
  for (const item of plan.records) counts[item.status] = (counts[item.status] ?? 0) + 1;
  return {
    reportVersion: 1, sourceSha256: plan.sourceSha256, applied, server,
    complete: applied && plan.records.every(item => item.status === "verified"),
    readyForImport: !applied && plan.records.every(item => item.status === "ready"),
    sourceRecords: plan.records.length, sourceEdges: plan.records.filter(item => item.kind === "edge").length,
    counts, records: plan.records.map(({ line, sha256, kind, status, reason, memoryId }) => ({ line, sha256, kind, status, reason, memoryId })),
    caveat: "Verification checks stored identity, direction, source text and reported provenance, not factual truth. No inferred or lifecycle links are created.",
  };
}

async function bounded(items, concurrency, action) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) { const item = items[next++]; await action(item); }
  }));
}

function readSource(path) {
  const descriptor = openSync(path, "r");
  const chunks = [];
  const buffer = Buffer.alloc(65536);
  let total = 0;
  try {
    while (true) {
      const length = readSync(descriptor, buffer, 0, Math.min(buffer.length, MAX_IMPORT_BYTES - total + 1), null);
      if (!length) break;
      total += length;
      if (total > MAX_IMPORT_BYTES) throw new Error("input_exceeds_64_mib");
      chunks.push(Buffer.from(buffer.subarray(0, length)));
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total));
  } finally { closeSync(descriptor); }
}

export async function importDomain(plan, client, { agentId, concurrency = 4, signal } = {}) {
  if (!text(agentId, 256) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("invalid_import_options");
  const server = client.getServerVersion();
  const { tools } = await client.listTools();
  if (server?.name !== "mindleak-light" || tools.length !== 3
    || !tools.some(tool => tool.name === "decompose_memory")
    || !tools.find(tool => tool.name === "write_memory")?.inputSchema?.properties?.domain
    || !tools.find(tool => tool.name === "recall_memory")?.inputSchema?.properties?.domain) throw new Error("server_does_not_support_domain_contract");
  const verifiedEntities = new Set();
  for (const kind of ["entity", "edge"]) {
    await bounded(plan.records.filter(item => item.kind === kind && item.status === "ready"), concurrency, async item => {
      if (signal?.aborted) { item.status = "not_imported"; item.reason = "cancelled"; return; }
      if (kind === "edge" && (!verifiedEntities.has(item.domain.source.id) || !verifiedEntities.has(item.domain.target.id))) {
        item.status = "unresolved"; item.reason = "endpoint_not_verified"; return;
      }
      const options = { timeout: 660000, signal };
      try {
        const written = await client.callTool({ name: "write_memory", arguments: {
          agentId, requestId: item.requestId, text: item.text, context: { scope: plan.header.scope }, domain: item.domain,
        } }, undefined, options);
        if (written.isError || typeof written.structuredContent?.memoryId !== "string") throw new Error("write_not_acknowledged");
        item.memoryId = written.structuredContent.memoryId;
        const domain = { kind, identity: item.domain.identity };
        const inspected = await client.callTool({ name: "recall_memory", arguments: {
          domain, agentId, scope: plan.header.scope, limit: 1,
        } }, undefined, options);
        const stored = inspected.structuredContent?.record;
        if (inspected.isError || !stored || stored.memoryId !== item.memoryId || stored.agentId !== agentId
          || stored.rawText !== item.text || (stored.context?.scope ?? null) !== plan.header.scope
          || !isDeepStrictEqual(stored.domain, item.domain)) throw new Error("verification_mismatch");
        item.status = "verified";
        if (kind === "entity") verifiedEntities.add(item.domain.identity.id);
      } catch (error) {
        item.status = "failed";
        item.reason = error?.code === -32602 ? "identity_or_input_conflict"
          : ["write_not_acknowledged", "verification_mismatch"].includes(error?.message) ? error.message
            : "mcp_request_failed_or_outcome_unknown";
      }
    });
  }
  return importReport(plan, true, server);
}

async function main() {
  const { values } = parseArgs({ options: {
    help: { type: "boolean" }, input: { type: "string" }, output: { type: "string" }, apply: { type: "boolean" },
    binary: { type: "string" }, url: { type: "string" }, "token-env": { type: "string", default: "MINDLEAK_HTTP_TOKEN" },
    "agent-id": { type: "string", default: "mindleak-domain-import" }, concurrency: { type: "string", default: "4" },
  } });
  if (values.help) {
    console.log("Usage: node examples/import-domain.mjs --input export.jsonl [--apply --binary PATH | --apply --url URL] [--output NEW_REPORT.json] [--agent-id ID] [--concurrency 1..8]\nWithout --apply, validates and reports only; no server or model is called. Uses the versioned mindleak-domain v1 JSONL contract. HTTP needs a private token via --token-env NAME and TLS off loopback. Reports never overwrite existing files.");
    return;
  }
  if (!values.input) throw new Error("input_required");
  const concurrency = Number(values.concurrency);
  if (!text(values["agent-id"], 256) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error("invalid_import_options");
  const source = readSource(values.input);
  const plan = planDomainImport(source);
  let report = importReport(plan);
  const outputFile = values.output ? openSync(values.output, "wx", 0o600) : undefined;
  try {
  if (values.apply) {
    try {
    if (Boolean(values.binary) === Boolean(values.url)) throw new Error("choose_one_explicit_mcp_transport");
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const client = new Client({ name: "mindleak-domain-import", version: "1.0.0" });
    let transport;
    if (values.binary) {
      const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
      transport = new StdioClientTransport({ command: realpathSync(values.binary), args: ["--transport", "stdio"],
        env: Object.fromEntries(Object.entries(process.env).filter(([, value]) => value !== undefined)), stderr: "pipe" });
      transport.stderr?.resume();
    } else {
      const endpoint = new URL(values.url);
      if (!["http:", "https:"].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || (!["127.0.0.1", "localhost", "[::1]"].includes(endpoint.hostname) && endpoint.protocol !== "https:")) throw new Error("http_requires_tls_and_no_url_credentials");
      const token = process.env[values["token-env"]];
      if (!token || token.length < 32 || !/^[\x21-\x7e]+$/.test(token)) throw new Error("private_http_token_required");
      const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
      transport = new StreamableHTTPClientTransport(endpoint, {
        requestInit: { headers: { Authorization: `Bearer ${token}` }, redirect: "error" },
      });
    }
    try {
      await client.connect(transport, { timeout: 30000 });
      report = await importDomain(plan, client, { agentId: values["agent-id"], concurrency });
    } finally { await client.close(); }
    } catch {
      for (const record of plan.records) {
        if (record.status === "ready") { record.status = "not_imported"; record.reason = "connection_or_setup_failed"; }
      }
      report = { ...importReport(plan, true), complete: false, error: "connection_or_setup_failed" };
    }
  }
  const output = JSON.stringify(report, null, 2) + "\n";
  if (outputFile !== undefined) writeFileSync(outputFile, output);
  else process.stdout.write(output);
  if (values.apply ? !report.complete : !report.readyForImport) process.exitCode = 1;
  } finally { if (outputFile !== undefined) closeSync(outputFile); }
}

if (process.argv[1] && pathToFileURL(realpathSync(process.argv[1])).href === import.meta.url) {
  main().catch(() => { console.error("Domain import did not complete. Check the explicit input, transport, server contract and report destination. Do not assume any unverified write succeeded; resume with the same input, namespace and agent ID."); process.exitCode = 1; });
}
