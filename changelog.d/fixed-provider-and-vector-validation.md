- Reject vector norms that underflow or overflow pgvector's f32 cosine
  arithmetic, and reject non-finite database scores before returning recall
  results or fusing hybrid rankings.
- Validate provider-reported embedding-model IDs against the configured model.
  Matching and omitted/null metadata remain supported; explicit mismatches fail
  before storage or query use, with no implicit alias resolution.
- Bound decomposition, embedding, and relevance response bodies to 4 MiB using
  a shared reader that checks declared lengths and actual streamed bytes before
  JSON parsing. Add regressions for size boundaries, chunked and misleading
  lengths, malformed bodies, provider identity, and atomic MCP failure handling.
