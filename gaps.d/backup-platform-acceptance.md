# Backup Platform Acceptance

Status: Open release gate. Administration is unreleased.

Real macOS/restic 0.19.1/PG16 tests cover manual local backup, independent recovery
selection, concurrent snapshot capture, records/schema/assets, retained restore,
owned cleanup, lost acknowledgment, immutable asset failure, and retention.
Portable tests and HTTP doubles do not certify every deployment.

Before accepting [ADR-0021](../adr.d/0021-encrypted-administrative-backups.md) or
shipping this interface as supported, retain evidence for:

- Native Windows ACL inheritance, tree cancellation, logged-out S4U execution,
  key/provider access in that identity, failed/missing/edited jobs, and owned
  removal, including interrupted installation recovery.
- Native systemd user-manager/lingering execution, calendar/time-zone behavior,
  missed jobs, alert observability, and interrupted install/remove recovery.
  A rendered unit definition is not execution evidence.
- An approved Azure repository's real SAS permissions, lease exclusion/recovery,
  encrypted create/check/retention, and recovery on another host without original
  source access or local receipts.
- Required HTTPS/OS-event delivery failures, independent offline monitoring, and
  interruptions during snapshot commit, deletion, and scheduler installation.
- External PG host disk/locale prerequisites and remote container exec cleanup;
  killing the local CLI is not proof every remote descendant exited.

No Azure resources or actual OS jobs were provisioned by development. No
production backup, retention, scheduling, release, or client switch is implied.
`make ci` and the explicit backup suite must pass; ignored tests are not passes.
