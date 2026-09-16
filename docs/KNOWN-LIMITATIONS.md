# Known Limitations

- One shared trust domain. `agentId` is caller-supplied provenance, not identity
  or tenant isolation. Anyone holding the HTTP token can access all memories.
- Model-free decomposition splits sentences and list items, not every semantic
  claim. It does not resolve pronouns or rewrite facts. A model is recommended
  for richer extraction, but JSON validation still cannot prove semantic accuracy.
- Keyword recall uses English stemming and stop words, with no synonym inference.
  Natural-language questions work better with the optional embedding model.
- Models are optional external providers, not bundled processes. Enabled chat
  providers must support JSON-schema responses; embeddings must match configured
  dimensions. An enabled provider failure does not fall back to model-free mode.
- Provider response bodies are capped at 4 MiB, including metadata, even if the
  provider would otherwise return valid facts or vectors. Embeddings with squared
  norms unsafe for f32 cosine arithmetic are rejected. Existing invalid database
  scores cause recall errors; this validation does not rewrite stored vectors.
- Vector retrieval is exact cosine search without ANN indexing, reranking, decay,
  RAST, synthesis inside the server, or automatic relationship generation.
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
  rows. Concurrent cold misses may duplicate embedding work. Benchmarks on small
  corpora do not establish latency at large scale or under concurrent load.
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
- Writes are atomic but not idempotent. A timeout after commit can leave a saved
  memory without a received ID; blind retries may create duplicates.
- No update, delete, expiry, or retention tools yet. Operators manage backups
  and retention using Postgres; memories are not encrypted at the application layer.
- HTTP uses bearer authentication for trusted MCP clients, not an OAuth
  authorization server. Browser Origin requests are rejected. Use stdio or an
  appropriate trusted client for clients that cannot send custom HTTP headers.
- Startup applies the initial schema and the explicit nullable-vector/keyword
  migration transactionally. It needs permission to alter tables and create the
  index. This is not a general-purpose migration framework; future changes need
  explicit reviewed migrations, and operators should back up before upgrades.
