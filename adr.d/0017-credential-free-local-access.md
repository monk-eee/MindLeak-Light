# ADR-0017: Credential-Free Local Access

- Status: Accepted
- Date: 2026-09-17

## Context

A Windows VS Code client received 401 from a static-token HTTP endpoint and
attempted unsupported OAuth registration. A correct bearer token and Docker/stdio
both worked, but the exact cause of the rejected token remains unknown. Local
trials should not require copying credentials. Network sharing must remain
authenticated, and process-loopback checks alone do not establish Docker host
exposure safety. Existing memories must never be silently replaced by an empty
store when a container, volume or database is unavailable.

## Decision

Use the existing executable as a native local launcher. `local setup` explicitly
creates a network-isolated trial with a named volume and automatically generated
internal HTTP token; clients use Docker/stdio and never handle that token.
`configure` and `connect` select an existing all-in-one container/database. Generated
VS Code JSONC pins its full container ID and absolute launcher path, preserving
other server entries and refusing implicit retargeting. A stopped container's
PostgreSQL files are checked before startup. New-volume creation has a unique
ownership marker checked before container startup. No operation deletes volumes
or creates an empty replacement as connection recovery.

Reject remote/TCP container engine endpoints. Diagnose actual image/binary/database
identity without emitting environment credentials, provider responses or memory
contents. The local commands do not load workspace `.env` files. Keep MCP stdout
reserved for the official SDK's protocol messages.

Offer an explicitly unauthenticated HTTP-to-stdio bridge only on native
macOS/Windows, with loopback bind and peer, exact numeric Host, and no Origin or
proxy forwarding headers. Linux builds, including every shipped container,
refuse this option before binding. This removes unauthenticated container port
publishing from the supported configuration space rather than trusting a label
or a container's bind address to prove host exposure. Do not proxy the bridge.

Ordinary shared HTTP retains bearer authentication on every route and requires
TLS at network ingress. Return a fixed secret-safe 401 explanation, bearer
challenge and no-store directive. Do not implement OAuth registration or pretend
that the error body suppresses a client's OAuth fallback. Document protected
token-file/secret-manager storage, scoped cached-input editing, connection restart
and rotation with the same data volume.

## Consequences

The default trial is model-free and network-isolated. Optional providers require
an explicitly networked deployment. Docker socket access is the local trust
boundary; this is not tenant isolation or protection against a privileged operator
intentionally forwarding a host port. Native Linux clients use stdio or authenticated
HTTP, not the unauthenticated bridge. Container replacement or launcher relocation
requires explicit reconfiguration instead of silently following a reused name.

The native launcher and attached server may have different versions. New source
commands work with the pinned released v0.4.0 image without republishing that image.
Old native archives do not acquire the commands from documentation changes. No new
application tables, MCP tools, background workers or authentication protocol are added.

## Verification

Unit and subprocess regressions cover persistent target validation, JSONC preservation,
local endpoint selection including Docker context precedence, no retargeting, missing
PostgreSQL files, volume-creation races, and fixed HTTP recovery semantics. Each
identified unsafe behavior was observed failing before its fix.

`scripts/local-access-smoke.mjs` uses an owned `_test` database and official MCP
clients for setup, discovery of exactly three tools, write/recall, exact-source and
receipt persistence across stopped-container restarts, database failure/recovery,
and host-only HTTP guards. CI runs the test against the candidate container.

Actual VS Code 1.138.0 on macOS discovered the generated stdio entry without auth
prompts and completed write/recall after reload and explicit server restart. Its
HTTP client attempted registration for missing, wrong, malformed and cached-old
credentials; scoped Edit of the masked input plus restart recovered the connection.
The old value survived a full client restart before replacement. MCP diagnostic
canary scans found neither tokens nor memory text. Windows real-client execution
is still required; portable config and unit checks alone do not prove that result.
