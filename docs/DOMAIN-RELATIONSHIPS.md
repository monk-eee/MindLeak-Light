# Domain Relationships and Verified Imports

**Unreleased after v0.5.0.** These additive `domain` fields use the existing
`write_memory` and `recall_memory` tools. Older binaries reject them. There are
still exactly three application tables and three MCP tools. No graph worker,
recursive traversal, inference engine, or extra model dependency is added.

## Domain Claims Are Not Lifecycle Feedback

A domain edge is a source's directed claim about two identified entities, for
example `package-a depends_on package-b`. Its predicate is an exact, case-sensitive
string, separate from `facts[].links[].relationshipType`. Even the domain predicate
`confirms` creates **no** confirmation, reinforcement, promotion, archive or correction.
Domain writes cannot contain `facts` directives. Reported confidence, source references,
entity type and identity are attributed data, not verified truth or permissions.

An entity is anchored by one memory episode, not by a model's fragment wording or
position. The episode retains the exact `text` and the complete prepared fragment/vector
set. An edge also has its own exact source episode. Entity/edge metadata and a
retry receipt commit in the same transaction as those fragments. An unresolved
endpoint, conflicting identity, enabled provider failure or database failure must
not acknowledge a successful write or leave half an episode behind.

## Stable Identity

Entity and edge identities each consist of `{ "namespace": "...", "id": "..." }`.
An entity ID and an edge ID may have the same spelling; they are different identity
spaces. Within one kind, the namespace/ID pair is unique across the database.
Use a stable source namespace, not an import-run timestamp. IDs and namespaces are
exact, 1..256 UTF-8 bytes, with no surrounding whitespace or control characters.

Every domain write requires `requestId`. Reuse the **same agent ID, request ID and
exact input** to resume. A repeated key returns the original memory/fragment IDs
before calling models. Reusing an identity with another key, changing its payload,
or changing a keyed write's scope is a conflict, not an upsert or silent overwrite.
Parallel edges with different edge IDs are preserved even when endpoints and predicate
are identical; self edges are allowed. No deduplication by tuple or similarity occurs.

This version imports immutable claims, not a mutable graph synchronization protocol.
Represent a revised claim with a new source edge ID or an explicitly versioned source
namespace. There is no edge deletion/update tool. Deleting an entity episode through
administrative SQL cascades its domain links; original edge episodes can remain as
source history. Do not run an older server against the migrated database.

All endpoints and the edge episode must have the same `context.scope`, including
the explicit unscoped case. `namespace`, `scope`, `agentId` and source labels are
not authentication or tenant boundaries; network access still requires auth and TLS.

## Write Through MCP

Create each entity before its edges. Example `write_memory` arguments:

```json
{
  "agentId": "dependency-import",
  "requestId": "718870c7-cd87-4d96-a56b-ea821e350b52",
  "text": "Package A is the billing service component.",
  "context": { "scope": "project:billing" },
  "domain": {
    "kind": "entity",
    "identity": { "namespace": "billing-export", "id": "package-a" },
    "label": "Package A",
    "entityType": "package"
  }
}
```

After creating `package-b` in the same namespace and scope:

```json
{
  "agentId": "dependency-import",
  "requestId": "fc085b42-9cb9-4c46-bbfc-a5d3a30c2657",
  "text": "The manifest reports that Package A depends on Package B.",
  "context": { "scope": "project:billing" },
  "domain": {
    "kind": "edge",
    "identity": { "namespace": "billing-export", "id": "manifest-edge-42" },
    "source": { "namespace": "billing-export", "id": "package-a" },
    "target": { "namespace": "billing-export", "id": "package-b" },
    "predicate": "depends_on",
    "provenance": {
      "sourceReferences": ["repository:billing/manifest.json#dependencies/42"],
      "reportedConfidence": 0.8
    }
  }
}
```

The response remains `{memoryId, fragments}`. These example IDs are illustrative;
generate and retain your actual operation IDs. Labels are 1..1024 bytes; entity
types and predicates are 1..256 bytes. Each edge needs 1..8 nonblank source references
of at most 1024 bytes each. `reportedConfidence` is optional; when present it must
be finite and in `[0,1]`. It never becomes a pgvector score or lifecycle evidence.

## Bounded Queries

Use `recall_memory` with `domain`, not `query` or `fragmentId`, for an exact lookup:

```json
{
  "scope": "project:billing",
  "limit": 20,
  "domain": {
    "kind": "entity",
    "identity": { "namespace": "billing-export", "id": "package-a" },
    "predicate": "depends_on",
    "direction": "outgoing"
  }
}
```

`incoming` looks up edges whose target is the entity; `outgoing` uses the source.
Omit predicate to get all direct predicates in that direction. Omit direction
for identity/source verification only, which reads **zero** relationship rows.
Predicate and cursor require an explicit direction. To inspect one edge, use
`domain: {kind: "edge", identity: {namespace, id}}`.

The result is `{record, relationships, nextCursor, scannedRelationships}`.
`record` and each relationship contain `memoryId`, `agentId`, exact `rawText`,
context and the complete domain claim. Read-back verifies actual edge columns,
endpoint identities and provenance against the immutable source claim. It does not
merely echo a prior request as proof of a link. Corrupt or mismatched records fail.

Limits are 1..50 returned edges (default 50), at most 128 examined edges plus one
lookahead, and a 512 KiB serialized response. Each response is one read-only
`REPEATABLE READ` snapshot. Copy `nextCursor` into `domain.after`, preserving
identity, predicate, direction, scope and agent filter. Continue through empty
filtered pages while a cursor is returned. A cursor is not authorization or a
cross-page snapshot; concurrent insertions before it require a fresh scan.
There is no full-degree count, OFFSET pagination, recursive expansion or automatic
refill across arbitrarily many rejected edges. Byte limits keep whole records and
advance only past returned/appropriately scanned edges, never truncate source text.

`scope` is optional. Omit it (or use `null`) for general search across scoped and
unscoped records; this is not an "unscoped-only" filter. A supplied scope narrows
matches to that exact scope. Writes without `context.scope` remain unscoped.
Domain namespaces identify source records and do not implicitly set a scope.

`agentId` is an optional provenance filter. Entity adjacency requires the selected
entity, edge episode and neighboring entity to match it. Omit it to read shared
knowledge. Scope equality is always checked for linked entities. Fact lifecycle
filters (`tier`, `includeInactive`) and normal search controls do not apply to
domain inspection: archiving a prose fragment does not delete its entity identity
or change an imported predicate. Domain inspection is model-free and read-only.

## PostgreSQL Performance Design

| Work | Access Path | Bound/Tradeoff |
|---|---|---|
| Find facts/entities/edge claims by words | Existing maintained `fragments.search_vector` GIN | Domain labels, IDs, types, predicates and source references join lower-weight metadata. No second broad JSONB GIN. |
| Semantic candidate discovery | Existing pgvector cosine/vector or hybrid retriever | Original vectors and similarity scores are unchanged. No implicit ANN approximation or model change. |
| Resolve exact entity | Unique B-tree on namespace and external ID | One source episode; no fragment-text matching. |
| Resolve exact edge | Unique B-tree on namespace and external edge ID | Distinct source edges stay distinct, including parallel/self edges. |
| Page incoming/outgoing edges, with or without a predicate | Two partial B-trees on endpoint, predicate and edge UUID | Predicate/UUID keyset range, no degree count or OFFSET. Neighbor ID is included; both query shapes share these indexes. |
| Load source/entity/provenance | Bounded indexed point lookups after the edge window | Wide text/JSON is not carried in adjacency indexes or read for every incident edge. |

The real `EXPLAIN ANALYZE` regression uses a 12,000-edge entity alongside 48,000
unrelated edges and checks both directions, a rare predicate, and a late cursor.
Predicate/UUID ordering avoids a global UUID-index scan that would discard unrelated
edges. It also exposed a full memory
table scan after the limited edge lookup; bounded lateral point lookups removed it.
It now asserts at most 129 edge rows examined and at most one row per endpoint/source
lookup. Exact identity verification skips adjacency entirely. Legacy fact-link
indexes are partial so imported domain rows do not inflate their write cost.

This proves the tested access plans and work bounds, not million-node throughput
or general semantic accuracy. pgvector remains **exact** here; GIN is for keyword
discovery, not vector similarity. Importing graph metadata does not justify changing
similarity thresholds or silently replacing vectors with lexical scores. Measure
ANN recall loss, filtered-query behavior and capacity separately before adding it.

The migration adds metadata/edge columns, unique and directional indexes, and makes
legacy relationship indexes partial. Existing fact links, feedback, raw text, vectors
and receipts are preserved. Index creation/rebuild needs disk space and can block
writes on the first upgrade; use a maintenance window and a tested backup for large
stores. This checkout retains the existing transactional migration mechanism;
background/online migration is separate work. Later startups skip completed DDL.

## Verified JSONL Importer

From a source checkout with Node.js 22+, install the example's pinned SDK once
with `npm ci --prefix examples --ignore-scripts`.
The input is UTF-8 JSONL. First line is a versioned header with a stable namespace
and optional scope (string or `null`). Omitted scope defaults to general mode;
imported records have no scope. Following lines are entity or edge records:

```jsonl
{"format":"mindleak-domain","version":1,"namespace":"billing-export","scope":"project:billing"}
{"kind":"entity","id":"package-a","label":"Package A","entityType":"package","text":"Package A is the billing service component."}
{"kind":"entity","id":"package-b","label":"Package B","entityType":"package","text":"Package B is the reporting component."}
{"kind":"edge","id":"manifest-edge-42","source":"package-a","target":"package-b","predicate":"depends_on","provenance":{"sourceReferences":["repository:billing/manifest.json#dependencies/42"],"reportedConfidence":0.8},"text":"The manifest reports that Package A depends on Package B."}
```

Validate without starting a server or model:

```sh
node examples/import-domain.mjs --input export.jsonl --output plan.json
```

Apply to an explicitly configured native stdio binary:

```sh
node examples/import-domain.mjs --input export.jsonl --apply --binary /path/to/mindleak-light --agent-id dependency-import --output import-report.json
```

The binary uses your existing database/model environment. For HTTP instead, supply
`--url https://memory.example.com/mcp` and a private token in `MINDLEAK_HTTP_TOKEN`
(or `--token-env NAME`); redirects and URL credentials are rejected. Do not pass a
token on the command line. Do not run synthetic imports against a working store.

The importer validates first, writes entities before edges, and verifies every
acknowledged record through the existing MCP tool. Input order need not put entities
first. Default concurrency is 4, configurable 1..8; duplicate-ID validation is linear
in input size. Input is bounded to 64 MiB and 100,000 nonblank records. Server text,
fragment, provider and response limits still apply. Keep decomposed source text within
those limits; an enabled model failure is not replaced with sentence splitting.

All endpoints must be represented by valid entities in this input. Unsupported fields,
malformed records, missing endpoints and changed duplicate identities are reported,
not silently stripped. Identical repeated edge IDs represent the same source edge
and keep separate report entries; distinct IDs never collapse by endpoints/predicate.
The exact `text` string and every supported metadata field are preserved; JSON object
formatting is not a stored episode. The report retains source-file and per-line hashes
to bind results to the original file without logging its content.

Resume with the same input/namespace and agent ID. Request UUIDs are deterministic
version-8 IDs derived from SHA-256 of `["mindleak-domain-v1", namespace, kind, id]`
(first 16 bytes, standard version/variant bits). Changed payloads conflict instead of
overwriting prior claims. Provider calls are skipped on committed retries. Read-back
still verifies the stored source, metadata and physical edge each time.

Reports enumerate every source row by line/hash/kind with `verified`, `unsupported`,
`unresolved`, `conflict`, `failed`, or `not_imported`. Unsupported/unresolved records
do not prevent independent valid records from being imported, but the report is
incomplete and the exit code is nonzero. A lost response is an unknown outcome, not
a failed commit; same-input rerun is safe through the stable key. An import is not
one giant transaction: each record is atomic, and a failed run can contain verified
commits. `complete: true` requires every source record to be verified. No true/false
confidence adjudication is implied. Output files are created exclusively before
server startup; choose a new report filename for each run. They contain no raw memory
text, credentials or provider bodies. Keep the source export and reports protected.
