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
- Vector retrieval is exact cosine search without ANN indexing, reranking, decay,
  RAST, synthesis inside the server, or automatic relationship generation.
- The embedding model is fixed per database. Changing weights under the same
  provider model name cannot be detected; operators must keep it stable. There is
  no re-embedding command or model migration in this initial version. Entries
  written without vectors remain keyword-searchable but are not automatically
  included in vector-only recall after enabling a model.
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
