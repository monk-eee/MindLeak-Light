- Index dot-separated components alongside qualified PostgreSQL keyword tokens,
  so `TargetInvocationException` finds stored
  `System.Reflection.TargetInvocationException` facts in keyword and hybrid
  recall without rewriting source text, IDs, or embeddings. Fully qualified
  queries retain their qualified token requirement; numeric literals and email
  tokens are unchanged.
- Build one combined fragment/metadata GIN index for existing rows during the
    next startup, with no model calls or re-ingestion. The one-time backfill and
    build can block writes and need disk space; later startups skip migration DDL.
