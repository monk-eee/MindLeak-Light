- Prioritize correction and contradiction links before confirmation history in
  recalled context. Bound directional relationship scans and report lower-bound
  counts explicitly with `relationshipCountExact`.
- Add provider-free `recall_memory` inspection by `fragmentId`, preserving exact
  raw source text and paginating direct evidence with `after`/`nextCursor`.
- Retain useful negative, unknown, and corrective evidence in the optional
  relevance policy; add a separate policy fixture without changing historical
  benchmark labels or results.
