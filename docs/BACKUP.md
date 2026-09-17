# Administrative Backups

**Unreleased development interface.** Published v0.4.0 and v0.5.0 binaries do not contain
these commands. Local PG/restic behavior has executable regression coverage;
[platform acceptance](../gaps.d/backup-platform-acceptance.md) must be completed
before a supported release. Successful upload alone is not verified recovery.

## Prerequisites

- This administrative build, restic 0.19.x, PostgreSQL 16, and matching `psql`,
  `pg_dump`, and `pg_restore`. Container targets use their own PG utilities.
- An explicitly selected running PostgreSQL container or external connection
  reference. No container/account/database discovery or provisioning occurs.
- Read access to the three tables, schema, and cluster metadata; recovery also
  needs `CREATEDB` and the dump's extensions. Cluster identity currently uses
  `pg_control_system()`; explicitly grant that read or use a maintenance role.
- Private staging outside checkouts, repositories, source roots, symlink paths,
  and file-sync folders. Allow room for dump, archive, and extraction, plus the
  recovered database on its PostgreSQL host.
- A protected restic password file outside staging, archived sources, and the
  repository. Keep keys and matching engine artifacts independently off-host.
  Losing the key makes the encrypted repository unrecoverable.

Unix private directories need owner-only `0700` and secrets `0600`. Windows needs
an owner-only ACL (SYSTEM/Administrators also permitted) with container/object
inheritance on staging directories. Configure it for the intended unattended
account. Permission inspection reads the owner and DACL through native Windows
security APIs; it does not start PowerShell or modify the ACL. Archive inputs,
credentials, and configuration refuse hard links,
reparse points, and symlinks. Executable checksum verification permits Cargo's
hard-linked engine artifacts without permitting links in archived inputs.
Configuration contains references, never passwords, SAS tokens, or webhook credentials.

## Configuration

Use explicit absolute paths:

```json
{
  "schemaVersion": 1,
  "repository": {
    "kind": "local",
    "path": "/home/operator/mindleak-backups/repository",
    "passwordFile": "/home/operator/private/restic-password"
  },
  "workDir": "/home/operator/mindleak-backups/work",
  "targets": [{
    "id": "primary",
    "container": "mindleak-postgres",
    "database": "mindleak_light",
    "user": "mindleak_light"
  }],
  "retention": {"last": 3, "daily": 7, "weekly": 4, "monthly": 6},
  "schedule": {"enabled": false, "timezone": "UTC"}
}
```

Unknown fields and duplicate target IDs/selectors fail. `doctor` and `run --all`
also compare actual cluster/database identities. Container database/user default
to its PostgreSQL settings. External targets instead use `connectionFile` and
neither container nor database/user overrides. That private file is strict JSON:

```json
{
  "host": "postgres.example.net",
  "port": 5432,
  "database": "mindleak_light",
  "user": "backup_operator",
  "passwordFile": "/home/operator/private/postgres-password",
  "caFile": "/home/operator/private/postgres-ca.pem"
}
```

Remote connections verify certificates/hostnames. `localPlaintext: true` is only
for loopback development. `enginePath` optionally selects the matching engine.
`tools` overrides `restic`, `container`, `psql`, `pgDump`, and `pgRestore`;
scheduling requires absolute tool paths.

For another recovery host, add `restoreTarget` with `id` and either `container`
(optionally `user`) or `connectionFile`. It selects a maintenance server, not an
existing destination. `--new-db` always names a new database. Never start another
PostgreSQL process on a working data directory.

Policy defaults: `backupMaxAgeHours: 48`, `restoreMaxAgeDays: 8`,
`backupTimeoutSecs: 3600`, `restoreTimeoutSecs: 7200`,
`repositoryTimeoutSecs: 3600`, `stagingReserveBytes: 1073741824`,
`sourcesRequired: false`, `offMachineRequired: false`. Maintenance timeouts are
separate from ordinary recall. Local disk checks do not certify free space on an
external PG host; validate that host's capacity and locale separately.

### Azure

Use `kind: "azure"`, `container`, `prefix`, `passwordFile`, exactly one of
`accountFile`/`accountEnv`, and exactly one of `sasFile`/`sasEnv`. File references
are required for scheduling. The destination is the explicitly configured public
Azure Blob endpoint. No managed identity fallback or resource creation occurs.
Use a dedicated approved existing container and account SAS allowing the required
blob operations and container lease. Coordination is container-wide, including
when a prefix is configured. Encryption keys are independent of Azure credentials.

An off-machine claim needs an actual remote acknowledged backup and current
verification, not configuration alone. Real Azure acceptance remains required.

### Source Assets

A target can declare `sources: [{"root": "/absolute/source", "manifest":
"/absolute/source-manifest.json"}]`. The immutable manifest has `schemaVersion: 1`
and `files: [{"path": "relative/file", "bytes": 123, "sha256": "64 hex digits"}]`.
Only listed regular files are copied; sizes/hashes must match before and after.
At most 10,000 inventory entries, including source manifests, are accepted.

Recovery keeps files under `assets/<source-index>/files/` and the exact manifest
at `assets/<source-index>/source-manifest.json`. The encrypted recovery manifest
lists every included file/hash. `externalSources` records references **not** backed
up. `sourcesRequired` refuses targets with no declared sources. Archives never
execute source files or use pickle/deserialization code.

## Commands

Use `--config /absolute/backup.json --json --non-interactive`. JSON emits one
object with `formatVersion`, `operationId`, `state`, and `result` or sanitized
`error`. Help/version/argument validation never starts MCP, dotenv, DBs, or models.

```sh
mindleak-light backup doctor --config /absolute/backup.json --json
mindleak-light backup init --config /absolute/backup.json --json
mindleak-light backup create --target primary --config /absolute/backup.json --json
mindleak-light backup verify --target primary --snapshot latest --config /absolute/backup.json --json
mindleak-light backup run --all --verify --config /absolute/backup.json --json
mindleak-light backup list --target primary --config /absolute/backup.json --json
mindleak-light backup check --read-data --config /absolute/backup.json --json
mindleak-light backup restore --target primary --snapshot latest --new-db recovered_memory --config /absolute/backup.json --json
mindleak-light backup retention --target primary --config /absolute/backup.json --json
mindleak-light backup retention --target primary --apply --yes --config /absolute/backup.json --json
mindleak-light backup status --check --config /absolute/backup.json --json
```

`doctor` supports uninitialized repositories and read-only preflight. `init`
refuses existing/nonempty destinations. `create` needs an exact restic
acknowledgment and identity check; it does not claim restore verification.
`run --all` is sequential, keeps individual and partial results, and never prunes.
`latest` resolves once to a full target-scoped snapshot ID.

`verify` creates an owned database and compares records (including vectors,
binding, lifecycle, relationships, raw sources, and retry receipts), canonical
schema, and assets; official-SDK canaries use an explicitly read-only MCP store
connection with no initialization. It removes only its owned resources. `restore`
keeps the verified database/assets and removes plaintext dump/tar staging. It does
not switch clients or remove the working database. Compatibility requires PG16
and the **same engine checksum**, not merely a version. Unknown/cross-architecture
engine combinations fail closed.

Retention is the union of last/daily/weekly/monthly buckets, not an exact count.
Apply requires the latest matching backup/restore receipt, two validated complete
recovery points, and a fresh plan check. Confirmed deletions are recorded before
prune; later failure never claims they were rolled back.

State-changing commands accept genuine no-side-effect `--dry-run`. It validates
configuration/action arguments, not live prerequisites; its
`runtimePrerequisitesChecked: false` is explicit. Run `doctor` separately.
Conflicting/unused flags fail, and missing secrets never prompt.

Exit codes: `0` success; `2` arguments/configuration/prerequisites; `3` backup or
repository failure; `4` partial all-target or required alert failure; `5` restore/
data/retrieval verification failure; `6` concurrency/unresolved ownership;
`130` cancellation. Cancellation can coexist with a committed snapshot; inspect
operation state and snapshot ID instead of assuming rollback.

## Scheduling And Status

Preferences never activate jobs. After initial backup/restore, configure `alerts`
with `webhookFile` (or manual-only `webhookEnv`) and/or `osEvent: true`.
`required: true` fails the operation when delivery fails. Webhooks require an
approved HTTPS destination and no redirects. Payloads contain only target ID,
stage, safe error code, and time. No secret is put into job definitions.

Set `schedule.enabled: true`, explicit `timezone`, `daily` (`02:00` default), and
`weekly` (`03:00`, Sunday). All configured targets run sequentially; schedule a
subset with a separate configuration. Linux requires a systemd user manager and
operator-enabled lingering. Windows uses the current account's S4U principal and
requires the configured Windows time-zone ID to match the host. S4U credential/
network behavior needs native acceptance; the CLI never collects passwords or
escalates privileges. macOS scheduling is unsupported.

```sh
mindleak-light backup schedule install --yes --config /absolute/backup.json --json
mindleak-light backup schedule status --config /absolute/backup.json --json
mindleak-light backup schedule remove --yes --config /absolute/backup.json --json
```

Installation checks alerts and receipts. Status observes actual jobs and
definition/configuration/binary hashes, not just preferences. Investigate edited/
missing jobs, overdue backups/restore checks, failed/unresolved operations, and
failed alerts. A powered-off host cannot alert locally: use an independent
off-host monitor with `status --check`. Local-only jobs never mean off-machine
protection. Plain status reads local receipts without opening database secrets.

Private state files are atomically replaced. Do not erase unresolved records to
force retries. Uncertain uploads reconcile by operation UUID/prepared bundle hash;
zero/multiple matches or known nonzero tool exits need operator review. Azure's
`azure-lease.json` identifies proposed/held leases: verify the original process
has stopped before approved maintenance releases that exact lease. Never blindly
break leases or run `restic unlock --remove-all`. A `_test` suffix alone never
proves ownership of a database.
