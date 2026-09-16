# ADR-0006: Native and All-in-One Distribution

- Status: Accepted
- Date: 2026-09-16

## Context

Developers should be able to plug a downloaded binary into their MCP client
without installing a language runtime. The requested container distribution
literally bundles PostgreSQL and the MCP server into one container. Docker Hub
namespace `monkeemagic` is supplied; publishing should be prepared, not performed.

## Decision

Package native executables for Linux x86-64, Windows x86-64, and both Mac
architectures, including checksums, installation guides, and stdio MCP templates.
Check each executable on its native build host before packaging.

Add an `all-in-one` Docker target based on the pinned pgvector/PostgreSQL image.
Use PostgreSQL's official initialization and Supervisor for process lifecycle.
Keep database files on a named volume, PostgreSQL on an internal Unix socket,
and the MCP worker on an unprivileged account. Require a supplied HTTP token.
Health checks verify MCP and its database. Source Compose retains a separate
database via the `app` image target.

Prepare a manual Docker Hub workflow targeting `monkeemagic/mindleak-light` for
Linux amd64 and arm64. Require a version tag matching Cargo and the changelog,
passing CI, and a registry token stored in Actions secrets. Only explicitly
requested stable promotions update `latest`. Do not publish during setup.

## Consequences

The bundled image has one application and one database, but more than one OS
process. The supervisor is packaging infrastructure, not an agent scheduler or
application worker. Initialization needs root inside the container; runtime
workers use separate accounts. This is not an arbitrary-UID/read-only image.

Database and app image upgrades are coupled in this convenience package. A
volume survives recreation but is not a backup. PostgreSQL major upgrades need
an explicit data upgrade. Use the native/app-only path for an independently
managed database. Models remain recommended but optional in both distributions.

## Verification

Archive tests inspect install guides, checksums, and Unix/Windows MCP templates.
The container smoke test refuses missing auth, requires an actual health check,
exercises the official SDK against MCP, checks socket-only PostgreSQL and the
three-table schema, and verifies data survives container recreation. It uses a
disposable `*_test` database and deletes only its own volume.
