- Search lower-weight source and summary metadata, including source path terms,
  alongside fragment text through one trigger-maintained PostgreSQL GIN index.
- Add explicit websearch/all/any keyword matching and opt-in PostgreSQL query
  diagnostics without adding model calls or changing vector similarity.
- Add opt-in bounded same-episode context with source provenance, fragment order,
  visibility filters, snapshot consistency, and explicit byte/limit truncation.
- Group exact duplicate text within the returned working set while preserving
  every included source's IDs, context, scores, lifecycle, links, and document
  context. Stored records and evidence counts are never merged.
