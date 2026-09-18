# Local MindLeak with VS Code

Run MindLeak locally to form and share evidence-backed knowledge between agents.
The write/recall check below verifies the connection; continue with the
[learning policy](../README.md#give-your-agent-a-memory-policy) and
[first chain workflow](../README.md#form-and-reuse-knowledge) after it succeeds.

The supported trial path is Docker/stdio. Your operating-system account's access
to Docker is the local trust boundary. No token generation, token copying,
secret-store configuration or OAuth registration is required.

The v0.6.0 native packages include these `local` commands and default new trials
to `monkeemagic/mindleak-light:0.6.0`. Use `--image` for a reviewed digest or
another explicit version. Existing containers stay unchanged; the flag never
upgrades their database. Older v0.5.0 launchers retained a pinned v0.4.0 default.

## First Successful Write and Recall

1. Start Docker Desktop with Linux containers. Open the extracted native package
   folder in VS Code, with your agent extension installed.
2. Open VS Code's terminal and run `.\mindleak-light.exe local setup` on Windows,
   or `./mindleak-light local setup` on macOS/Linux.
   A packaged executable needs no Rust, Node or Python runtime. For this source
   checkout, install Rust and run
   `cargo run --locked -p mindleak-mcp --bin mindleak-light -- local setup` instead.
3. Open the Command Palette: `Ctrl+Shift+P` on Windows/Linux or `Cmd+Shift+P` on
   macOS. Run **MCP: List Servers**, select **mindleak-light-local**, and choose
   **Start Server**. Review normal trust approval if shown. The MCP output should
   say **Discovered 3 tools**. Enable all three in the chat tool picker.
4. Ask: **Use write_memory with agentId "quickstart-demo" and context.scope
   "quickstart-demo" to save: LocalTrialBeacon requires a second reviewer.**
   Approve the call. Require a successful response containing `memoryId`.
5. Start a new chat and ask: **Use recall_memory with query "LocalTrialBeacon",
   agentId "quickstart-demo", and scope "quickstart-demo".** Require the saved
   fact and the same memory ID. `decompose_memory` previews; it does not save.
6. Stop the container in Docker Desktop and reload the VS Code window. Run
   **MCP: List Servers -> mindleak-light-local -> Start Server**, then repeat
   the recall. The existing container restarts and the memory ID stays the same.
   Do not assume VS Code automatically restarts an errored server.

This is an explicit connection test. Install the
[agent memory policy](INSTALL.md#automatic-project-setup) for ordinary work with
`agent setup --client vscode --server mindleak-light-local --general`, or use
`--scope repo:your-org/your-project` instead of `--general`. Run it with the
same native executable and workspace used above. Test data is scoped to `quickstart-demo`;
do not treat it as a real policy or preference.

MindLeak does not provide OAuth client registration. Cancel unexpected registration dialogs.

An authentication dialog means you selected an HTTP entry, not the local stdio
entry. Setup leaves existing shared HTTP entries intact. Disable an unwanted
entry in VS Code's server list; do not remove its database to fix a connection.

## Existing Store or Another Workspace

Keep the native executable in a stable location. From the workspace that should
use your **existing all-in-one container**, run:

```sh
mindleak-light local configure --container mindleak-light
```

Use the actual container name from Docker Desktop. Alternatively add
`--workspace "/path/to/project"`; PowerShell accepts a quoted Windows path.
For Podman, add `--engine podman` to setup/configure/status. The generated
configuration retains that choice. Docker Desktop's local socket and Podman's
local VM connection are supported; remote Docker/Podman contexts and TCP engine
endpoints are rejected. Remote agents should use authenticated HTTP with TLS.

Configure preserves other server entries, comments and input definitions. It
adds `mindleak-light-local` atomically, with an absolute executable path and the
full container ID. Repeating it is harmless. A differently configured local
entry causes an error rather than silently switching stores. No credentials
are written into the generated local entry or copied into backup files.

Each client opens `docker exec -i` stdio, without a TTY, as the unprivileged
MindLeak user. It uses that container's explicit `POSTGRES_DB` and internal
PostgreSQL socket. Separate native/app-only or PostgreSQL-only containers,
custom `PGDATA`, and external database overrides are not guessed or rewritten.
For those layouts use [native PostgreSQL stdio](INSTALL.md#native-binary) or
the existing authenticated HTTP service.

Several trusted local clients can connect to the same container. They share
one database and trust domain, not isolated tenants. Keep one connection per
agent session, not one per tool call. After intentionally replacing a container
or moving the launcher, verify the intended volume, remove only the old
`mindleak-light-local` entry, and rerun configure. This explicitly updates the
pinned identity; a same-name replacement is not accepted automatically.

## Setup and Recovery

`local setup` explicitly creates a new trial only when its named container is
absent and its selected volume does not already exist. Defaults are container
`mindleak-light`, volume `mindleak-light-data`, and database `mindleak_light`.
`--container`, `--volume`, `--database`, and `--image` select a new trial; an
existing container is attached unchanged. Use a separate `_test` database and
unique volume/container names for automated tests.

The trial uses `--network none` and publishes no ports. The bundled HTTP worker
still has an automatically generated private token inside the container; no
client needs that token. Enabled model providers require an explicitly
networked deployment, not this isolated trial. Use the advanced deployment
guide before changing network settings; setup never recreates an existing
container just to change its settings.

Run a secret-safe diagnostic from a terminal:

```sh
mindleak-light local status --container mindleak-light
```

It reports the actual container ID, image ID/reference, server binary version,
database and persistent-storage check, not just the launcher's package version.
It does not print environment variables, connection credentials, provider
responses or stored memories. A stopped container is reported, not started by
status. **MCP: List Servers -> Start Server** or `local configure` can restart it.

| Failure | Action |
|---|---|
| Docker is missing or unavailable | Install/start Docker Desktop, choose Linux containers and its local context, then Start Server again. |
| The selected container is missing | Check the context and actual container name. Use configure for an existing store. Setup is only for a deliberate new trial. |
| Existing volume without its container | Recover that deployment explicitly using the backed-up configuration. Setup refuses to attach an unknown volume automatically. Never delete a volume to resolve this error. |
| Stopped container has missing PostgreSQL files | Restore/select the intended volume. Connect refuses to start an empty replacement cluster. |
| Database unavailable or schema not ready after 30 seconds | Check Docker Desktop, the selected database and container health. Fix that service, then reconnect. No substitute database is created. |
| Local entry already differs | Review its executable/container ID. Remove only that entry if intentionally retargeting, then configure the intended store. |

Initial image download/startup has a five-minute bound. Metadata operations and
database readiness have 30-second bounds. A failed setup can leave its named
container/volume available for inspection; nothing is automatically deleted.
Keep backups: a volume is persistence, not protection against deletion or disk loss.

## Optional Local HTTP

Only when the client needs HTTP, the **native macOS or Windows launcher** can
serve an explicitly unauthenticated loopback bridge to the same Docker/stdio
store:

```sh
mindleak-light local http --container mindleak-light --allow-unauthenticated-loopback --listen 127.0.0.1:8090
```

Keep that terminal running and use `http://127.0.0.1:8090/mcp` without an auth
header. This is an opt-in host process, not a container HTTP auth-disable flag.
Linux builds, including every shipped container executable, reject the mode.
Changing Docker `-p` mappings cannot publish this bridge: there is no
unauthenticated container listener to publish. Normal container HTTP remains
token-protected even if its host port mapping changes.

The bridge requires a literal loopback bind, loopback peer and exact numeric
Host header. It rejects browser Origin headers and proxy forwarding headers,
including `Forwarded`, `X-Forwarded-*`, and `Via`. Use the exact printed URL,
not `localhost`. It has no health endpoint or background service installation.
The official MCP SDK handles both transports and request cancellation.

Do not proxy, tunnel or forward this local port. Local users/processes can use
it; these checks do not protect against an administrator intentionally exposing
a service. For multiple machines, use [shared HTTP](INTEGRATION.md#shared-http)
with a private token and TLS. Never use the opt-out for network sharing.
