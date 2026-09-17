# ADR-0020: Encrypted Administrative Backups

- Status: Proposed
- Date: 2026-09-17

## Context

Memory persistence is not a recovery plan. Operators need encrypted, coherent
database/source snapshots, independently verified restores, explicit retention,
and observable OS scheduling without extending MCP's three tools or application
tables. Published v0.4.0 and v0.5.0 do not include this administrative interface. Platform
acceptance is a release prerequisite, not an inferred result of compilation.

## Decision

Keep `mindleak-light --transport ...` compatible and add `serve` and `backup` in
the same Clap executable. Administrative routing precedes dotenv, MCP, schema
initialization, and model providers. Use strict JSON configuration and explicit
target selectors and credential references.

Use PostgreSQL 16 utilities and restic 0.19.x repository format 2. A persistent
read-only transaction exports one snapshot for ordered record fingerprints,
schema fingerprints, counts, and custom-format `pg_dump`. PostgreSQL's canonical
deparser normalizes equivalent CHECK-expression grouping. Archive the dump,
manifest, immutable source manifests, and exact listed assets as one `bundle.tar`
inside restic's encrypted snapshot. Do not implement cryptography or MCP framing.

Success requires a full snapshot ID rechecked against repository, target, and
operation tags. Persist operation identity and the prepared bundle hash before
upload. Reconcile lost acknowledgments by exact operation and downloaded bundle;
never promote a known nonzero restic exit to success. Preserve prior success when
later work fails and report cleanup errors alongside the primary failure.

Restore only into a new database with an operation UUID ownership comment. An
explicit recovery server can replace an unavailable source. Match the recorded
engine checksum and PG compatibility profile. `connect_read_only` and
`--database-read-only` skip initialization and enforce read-only sessions for
official-SDK capability, source, keyword, and filter canaries. Compare records
and schema before and after. Verification removes only its owned database;
retained restore keeps the database/assets without switching clients.

Local locks coordinate by canonical repository path across work directories.
Azure uses a container lease across modifying operations and restic's native
locks internally. A lease coordinates cooperating clients, not an administrator
using raw restic. Never automatically break an uncertain lease. Retention is
preview-only without `--apply --yes`; preserve at least two validated complete
bundles and the latest verified recovery point. Record deletion before prune.

Use systemd user timers or Windows Task Scheduler, never a resident worker.
Install explicitly after initial backup/restore and alert checks, with absolute
paths and persistent credentials. One all-target job runs sequentially. Observe
actual definitions and configuration/executable hashes. Local-only storage never
claims off-machine protection. See [the operator guide](../docs/BACKUP.md).

## Consequences

Restic, PG16 tools, maintenance privileges, private storage, and the matching
engine artifact are prerequisites. Same-version text alone is insufficient.
Models, re-ingestion, re-embedding, automatic migrations, in-place restore,
WAL/PITR, cloud provisioning, and client switching are outside this design.

Status files are receipts, not a replacement for the encrypted repository or an
off-host monitor. Host death can leave unresolved operations, leases, locks, or
owned staging. Report them rather than guessing rollback or deleting a database
based on a suffix. Keep keys and the matching engine independently of the source.

## Verification

Real CLI/restic/PG tests cover encrypted creation, exact records/vectors/schema/
sources/receipts, retained restore, working-database refusal, ownership cleanup,
wrong keys, immutable asset failure, reconciliation, and explicit retention.
A deterministic concurrent writer proves the dump uses the exported snapshot.

Offline tests cover CLI compatibility, JSON errors, dry-run, status, bounded
subprocess output, archive inventory/paths, linked files, locks, and error
preservation. Local HTTP doubles check lease ownership/release, not Azure auth.
Native Windows/systemd and approved Azure recovery remain explicit
[release acceptance gates](../gaps.d/backup-platform-acceptance.md).
