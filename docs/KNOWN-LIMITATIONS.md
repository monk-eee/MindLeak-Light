# Known Limitations

- One shared trust domain. `agentId` is caller-supplied provenance, not identity
  or tenant isolation. Anyone holding the HTTP token can access all memories.
- Model-free decomposition splits sentences and list items, not every semantic
  claim. It does not resolve pronouns or rewrite facts. A model is recommended
  for richer extraction, but JSON validation still cannot prove semantic accuracy.
- Atomic persistence guarantees all-or-nothing storage, not atomic semantic facts.
  Model extraction can lose causes, qualifiers, or attribution. Default sentence
  splitting preserves causal wording but leaves ambiguous references unresolved.
  Shorter or more numerous fragments are not a substitute for faithful meaning.
- Keyword recall uses English stemming and stop words, with no synonym inference.
  Natural-language questions work better with the optional embedding model.
  Dotted-identifier aliases in v0.4.0 follow PostgreSQL hostname tokenization,
  not a programming-language parser, and do not preserve source phrase positions.
  Source path splitting does not decode percent-encoded URLs. Lower-weight source
  and summary matches broaden candidates, but are not proof of relevance.
- Several facts from the same source episode can occupy result slots. There is
  no per-episode diversity cap; imposing one can discard relevant independent
  facts and needs workload-specific evaluation.
- Duplicate grouping covers only the returned working set, after the
  original fragment limit and optional relevance selection. It retains every
  included source, but does not report every matching occurrence in the corpus,
  refill result slots, merge records, or prove independent evidence.
- Document context is bounded to the same stored episode, not all
  memories sharing a source URL. It can omit steps due to visibility filters,
  the eight-fragment per-primary maximum, or the shared context byte budget.
  Legacy order is unknown when literal source positions cannot be recovered.
  Context is not a scored match, a procedure-validity check, or recursive retrieval.
- Query diagnostics expose parsing and strategy, not exhaustive match
  counts or relevance confidence. All/any modes affect only the keyword branch;
  hybrid semantic candidates remain eligible independently.
- Models are optional external providers, not bundled processes. Enabled chat
  providers must support JSON-schema responses; embeddings must match configured
  dimensions. An enabled provider failure does not fall back to model-free mode.
- Provider response bodies are capped at 4 MiB, including metadata, even if the
  provider would otherwise return valid facts or vectors. Embeddings with squared
  norms unsafe for f32 cosine arithmetic are rejected. Existing invalid database
  scores cause recall errors; this validation does not rewrite stored vectors.
- Vector retrieval is exact cosine search without ANN indexing,
  RAST, synthesis inside the server, or automatic relationship generation.
- Current diagnostic benchmarks do not establish recall precision or latency at
  tens of thousands to millions of memories. A bounded result set does not bound
  exact-vector scan cost; realistic scale and high-degree relationship testing
  is required before capacity claims.
- A configured cosine floor trades recall for rejection; it is model/corpus
  specific and cannot prove relevance. Hybrid fuses bounded keyword/vector ranks
  but does not verify truth, resolve contradictory facts, or automatically retire
  outdated memories. Unset floors leave nearest-neighbour results unfiltered.
- Optional model-based relevance selection adds recall-time latency and another
  provider failure path. It cannot recover facts outside its candidate pool or
  repair incorrect extraction. Model selection is not proof of truth, relevance,
  or prompt-injection resistance; candidates remain untrusted reference data.
  Inputs exceeding its explicit text budget fail rather than being truncated.
- Semantic query caching is bounded to 128 exact query strings per process and
  retriever. It speeds repeat queries, not unseen ones, and never caches result
  rows. Overlapping callers share initialization while their slot remains cached;
  eviction, cancellation, or a failed initializer can require another attempt.
  Unfinished slots also occupy capacity. This is not a global provider-concurrency
  limit, and small-corpus benchmarks do not establish latency at large scale.
- Benchmark fact verification uses reviewed canonical wording and accepted
  variants. Valid unseen paraphrases are unverified, not necessarily wrong. The
  synthetic corpus and small per-category samples do not establish population
  accuracy; independent label review and larger domain-specific holdouts remain
  necessary for deployment claims.
- The embedding model is fixed per database. Changing weights under the same
  provider model name cannot be detected; operators must keep it stable. There is
  no re-embedding command or model migration in this initial version. Entries
  written without vectors remain keyword-searchable but are not automatically
  included in vector-only recall after enabling a model.
- Reported embedding-model IDs must match configuration exactly; implicit alias
  resolution is not supported. Providers may omit model metadata, so identity
  cannot always be verified from their response.
- Unkeyed writes are atomic but not idempotent; blind retries can duplicate a
  committed memory. The `requestId` option, available from v0.3.0, protects matching retries
  only when the client retains its original ID, agent ID, and payload. Receipts
  live with their memory rows and report original write-time tiers, not current
  lifecycle state. Concurrent first attempts can duplicate provider work even
  though only one episode commits. This is not a general exactly-once guarantee.
- Lifecycle retention, evidence links, and read-time decay are implemented features,
  not a biological simulation or a measured longitudinal quality improvement.
  The half-lives, spaced-feedback thresholds, and priority discount are explicit
  initial policies. No automatic episodic replay, summary generation, or deletion.
- Scope/session/source IDs are caller-supplied. Distinct session labels do not
  prove independent evidence, and trusted clients can submit mistaken feedback.
  Long-term/pinned means retained, not true; confirmed means a confirmation was
  recorded. Superseding a disputed fact requires an explicit correction.
- Direct related-fact context is bounded to eight links per result and, from
  v0.3.0, 32 KiB across serialized relationship arrays. A 512 KiB result-array
  budget preserves primary facts or rejects an oversized request; it is not a
  token limit or a limit on the enclosing MCP wire message. Omitted context is
  reported by `relationshipsTruncated` and `relationshipCount`. This is not a
  recursive graph. Lifecycle cannot rescue facts outside the retrieval candidate
  pool. No automatic deduplication or re-embedding accompanies consolidation.
  Document context shares that 32 KiB budget after links are allocated;
  grouped provenance and requested diagnostics also fit the final 512 KiB payload.
- Writes can archive, restore, or supersede existing facts through explicit
  links; original episodes/text remain immutable. There is no destructive delete
  or automatic expiry tool. Operators manage backups and data erasure in Postgres;
  memories are not encrypted at the application layer.
- MCP cancellation drops pending work but cannot undo a commit already sent to
  PostgreSQL or guarantee that a remote model stops computing. Reconcile an
  ambiguous keyed write with its original request ID and payload.
- Final primary metadata and related context share a read-only snapshot, but
  earlier candidate searches and later client actions do not. Concurrently
  filtered candidates are not refilled; recall is not a reservation of facts.
- Version 0.4.0 prioritizes corrective links, bounds scans, and exposes
  provider-free source/evidence inspection. `relationshipCountExact: false`
  means a lower bound, not a total. Sparse filters can produce empty pages with
  `nextCursor`; continue until null. Each page is a new snapshot, so concurrent
  inserts before its cursor require a fresh audit. These features do not imply
  complete evidence in a normal search result or independently verified truth.
- The optional selector now treats explicit unknowns, prohibitions, and relevant
  false-premise corrections as useful evidence. Prompt compliance still depends
  on the model. Older benchmarks used stricter direct-answer labels and must not
  be presented as measurements of this revised policy.
- HTTP uses bearer authentication for trusted MCP clients, not an OAuth
  authorization server. Browser Origin requests are rejected. Use stdio or an
  appropriate trusted client for clients that cannot send custom HTTP headers.
- The unreleased [bounded migration path](MIGRATIONS.md) preserves completed
  data batches after interruption but restarts an interrupted index build or
  validation statement. Stop all older servers and other writers; this is not a
  rolling upgrade. Preserve checkpoint column comments with partial backups.
  Supply deployment-specific canaries before claiming retrieval acceptance;
  built-in verification and synthetic tests do not validate private corpora.
- Published v0.4.0 startup applies the initial schema and explicit keyword, lifecycle, and
  idempotency/evidence-index migrations transactionally. It needs permission to alter tables
  and create indexes, functions, and triggers. The v0.4.0 document-search
  migration backfills derived search vectors and recoverable fragment order,
  builds one replacement GIN index, and can block writes during that upgrade.
  This is not a general-purpose migration framework; future changes need
  explicit reviewed migrations, and operators should back up before upgrades.
