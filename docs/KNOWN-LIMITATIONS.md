# Known Limitations

- One shared trust domain. `agentId` is caller-supplied provenance, not identity
  or tenant isolation. Anyone holding the HTTP token can access all memories.
- Decomposition quality depends on the configured model. JSON validation cannot
  prove that an LLM preserved every qualifier or extracted every fact. Automated
  tests use controlled provider responses, not a claim of model accuracy.
- Models are external prerequisites, not bundled processes. Chat providers must
  support JSON-object responses and embeddings must match configured dimensions.
- Retrieval is exact cosine search without ANN indexing, reranking, decay, RAST,
  synthesis inside the server, or automatic relationship generation.
- The embedding model is fixed per database. Changing weights under the same
  provider model name cannot be detected; operators must keep it stable. There is
  no re-embedding command or model migration in this initial version.
- Writes are atomic but not idempotent. A timeout after commit can leave a saved
  memory without a received ID; blind retries may create duplicates.
- No update, delete, expiry, or retention tools yet. Operators manage backups
  and retention using Postgres; memories are not encrypted at the application layer.
- HTTP uses bearer authentication for trusted MCP clients, not an OAuth
  authorization server. Browser Origin requests are rejected. Use stdio or an
  appropriate trusted client for clients that cannot send custom HTTP headers.
- The three-table schema is bootstrapped on startup. Future schema evolution
  needs an explicit reviewed migration strategy, not edits hidden behind
  `CREATE TABLE IF NOT EXISTS`. No production migration framework is claimed.
