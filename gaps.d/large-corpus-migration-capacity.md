- Full reported-count capacity acceptance is unverified for the bounded migration
  coordinator in `crates/mindleak-storage-postgres/src/migrations.rs`. The small
  2,048-memory/22,528-fragment rehearsal passed preservation and twelve actual
  runtime canaries; attempts at 519,422 memories/5,720,005 fragments were cancelled
  for disk/resource safety, not completed within the proposed 30-minute budget.
  A small EXPLAIN regression subsequently caught and fixed whole-table scans
  in bounded updates. Do not extrapolate earlier timings into a capacity claim.
- Close this gap by running the opt-in drill in [the operator guide](../docs/MIGRATIONS.md)
  on dedicated adequately provisioned storage with durability enabled, retaining
  exact candidate/corpus identity, time/resource observations, preservation
  fingerprints, restart checks, and the deployment's complete canary manifest.
  The incident's restored private database and exact timed-out v0.4 statement
  were never available here; synthetic fixtures do not substitute for that
  deployment's acceptance. Clean up only owned test data and record its removal.
