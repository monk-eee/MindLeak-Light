- Add identified domain entities and directed edges through the existing MCP tools,
  with independent predicates, stable import keys, per-edge source provenance and
  reported confidence that never reinforces or confirms facts.
- Add indexed, bounded entity/predicate/direction queries and exact physical edge
  verification. Reuse GIN metadata discovery and pgvector without changing similarity.
- Add a versioned JSONL importer with dry-run validation, bounded concurrency,
  restart-safe identities and explicit per-source-record verification/failure reports.
