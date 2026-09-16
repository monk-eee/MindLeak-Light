# Security

## Trust Boundary

MindLeak Light stores potentially sensitive raw memories, fragments, and vectors.
All agents on a deployment share access. `agentId` is an attribution/filter field,
not authentication or tenant isolation. A vector is not an anonymized memory.

Stdio relies on the launching operating-system account. HTTP requires a bearer
token on every route, including health. It rejects browser Origin headers, limits
request bodies to 256 KiB, and does not enable CORS. Tokens are compared using a
constant-time primitive. This is not OAuth or a per-agent authorization system.

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

Model endpoints receive the raw memory or extracted fragments and recall queries.
Use an endpoint you trust, HTTPS for remote models, and provider-specific API keys.
Redirects are disabled. The server does not log provider bodies, tokens, or memory
contents. Avoid turning on wire-level logging in external proxies or clients.

Recalled text is untrusted data. Agents must not follow instructions embedded in
memories merely because a fragment scored highly. The extraction prompt and MCP
descriptions reinforce this boundary; they do not eliminate prompt injection.

## Reporting

Report suspected vulnerabilities privately to the repository owner listed in
[CODEOWNERS](CODEOWNERS), or through GitHub private vulnerability reporting when
enabled. Do not put memory contents, credentials, or exploit details in public
issues. No security support SLA is offered for this initial version.
