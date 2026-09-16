- Add an optional UUID requestId to write_memory for durable, agent-scoped retry
  protection. Matching requests replay the original committed memory and fragment
  result across process restarts without repeat model calls or lifecycle effects.
- Reject conflicting payloads, preserve unkeyed write behaviour, and arbitrate
  concurrent writers through the existing memories table. Failed transactions
  leave no request receipt. Document client obligations and concurrent inference
  limits, with service, PostgreSQL, and real MCP regression coverage.
- Skip redundant idempotency column/index DDL on an already-current schema, with
  a regression proving that this migration can rerun while an active reader holds
  a transaction open.
