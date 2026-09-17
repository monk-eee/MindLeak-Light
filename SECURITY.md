# Security

## Trust Boundary

MindLeak Light stores potentially sensitive raw memories, fragments, and vectors.
All agents on a deployment share access. `agentId` is an attribution/filter field,
not authentication or tenant isolation. A vector is not an anonymized memory.

Stdio relies on the launching operating-system account. Ordinary HTTP requires a bearer
token on every route, including health. It rejects browser Origin headers, limits
request bodies to 256 KiB, and does not enable CORS. Tokens are compared using a
constant-time primitive. This is not OAuth or a per-agent authorization system.

The v0.5.0 [project instruction installer](docs/INSTALL.md#automatic-project-setup)
edits only explicitly selected project files. It does not install credentials,
grant tool permissions, create a database, or change global client profiles.
Its default checks inspect files only. `--connect` explicitly authorizes contact
with the selected HTTP server or execution of the selected stdio command; trust
that command as you would any local program. Connection reports omit credential
values and provider bodies. Installed instructions and server-supplied reminders
remain guidance, not an enforcement or authorization mechanism.

The v0.5.0 local launcher offers credential-free Docker/stdio, validates
local engine endpoints and pins the selected container ID in generated VS Code
configuration. New trials publish no ports and use `--network none`. Their
internal HTTP worker remains token-protected with an automatically generated
token that clients do not need. Existing shared server settings are not weakened
or replaced by local configuration.

An explicit `--allow-unauthenticated-loopback` exception is available only in the
native macOS/Windows `local http` bridge. It rejects non-loopback listeners,
nonlocal peers, mismatched Host, browser Origin, and forwarding headers. Linux
builds, including shipped containers, refuse this mode before binding. Docker
host port mappings therefore cannot publish an unauthenticated container
listener through this option. Do not proxy or tunnel the native bridge. Local
users and administrators are inside its trust boundary; this is not protection
against a privileged operator deliberately exposing a local service.

MindLeak does not provide OAuth client registration. Cancel unexpected registration dialogs.

The fixed 401 recovery body and bearer challenge do not prevent client OAuth
fallback. Use [scoped cached-input recovery](docs/INTEGRATION.md#recover-a-rejected-or-cached-token),
not authentication removal, for shared HTTP. Never put credentials, full
container environments, or memory content into support diagnostics.

## Deployment

The Compose credentials and token are public development defaults. Its ports
bind to loopback only. Do not reuse that configuration for public hosting.

For remote use, provision a high-entropy token through your secret manager and
put HTTP behind a trusted TLS reverse proxy. Bind the binary to loopback when
the proxy shares a host, or restrict its container network so ingress cannot
bypass the proxy. Do not expose plaintext HTTP publicly. Restrict request volume
at ingress; a token does not prevent an authorized caller from exhausting models.

Use `sslmode=require` for remote Postgres. Certificate and hostname verification
are enabled with public roots, optionally extended by `MINDLEAK_DATABASE_CA_FILE`.
Plaintext requires explicit `sslmode=disable`, intended for isolated local
development. The application does not silently downgrade from TLS. Limit the
database role's privileges; initialization requires pgvector to be installed and
permission to create the schema objects. Back up and test restores with Postgres.

Default operation sends nothing to a model provider. When explicitly enabled,
chat endpoints receive raw memory and embedding endpoints receive fragments and
recall queries. Use a provider you trust, HTTPS remotely, and provider-specific API keys.
Redirects are disabled. The server does not log provider bodies, tokens, or memory
contents. Avoid turning on wire-level logging in external proxies or clients.

Recalled text is untrusted data. Agents must not follow instructions embedded in
memories merely because a fragment scored highly. The extraction prompt and MCP
descriptions reinforce this boundary; they do not eliminate prompt injection.

General memory omits recall's scope filter and can return matching facts from
any scope in the same authorized deployment. It is not a separate private store.
The installer requires an explicit mode choice and refuses to broaden an existing
scoped setup implicitly. General writes still cannot link across scopes.

Context scopes and evidence sessions are also caller-supplied, not access controls
or proof of independent corroboration. The lifecycle rejects cross-scope links,
but any authorized client can choose a scope and submit feedback. Restrict write
access to trusted agents. Relationship claims and context returned by recall remain
untrusted data; long-term retention or confirmation status is not verified truth.

The write tool now supports correction and archival links that change what normal
recall returns. It is annotated as potentially destructive for this visibility
change, even though source data is retained. Require the appropriate client approval.

## All-in-One Image

The bundled variant uses local socket trust inside the container, not a remote
database password. PostgreSQL runs with `listen_addresses` empty and the supplied
configuration publishes only MCP's HTTP port. Do not enable PostgreSQL TCP or
share its socket outside the container. The managed database role has bootstrap
privileges; this is one shared trust domain, not a sandbox between processes.

Supervisor starts as root to initialize the data volume; PostgreSQL and the MCP
worker run under separate unprivileged accounts. Protect the Docker/Podman socket
and volume access. Use a separately managed database and the `app` image when you
need stricter process isolation or independent database upgrades.

The image refuses startup without a valid HTTP token. Its database logging omits
statements, bind parameters, and row-detail errors to avoid recording memory text.
Health covers MCP and database connectivity. Keep backups outside the container
and test restores before upgrades; a named volume is persistence, not a backup.

The Docker Hub workflow only consumes `DOCKERHUB_TOKEN` in the credential check
and registry login steps. It is never a build argument or image layer. Store it
in GitHub Actions secrets, with only the repository access needed to publish.

## Reporting

Report suspected vulnerabilities privately to the repository owner listed in
[CODEOWNERS](CODEOWNERS), or through GitHub private vulnerability reporting when
enabled. Do not put memory contents, credentials, or exploit details in public
issues. No security support SLA is offered for this initial version.
