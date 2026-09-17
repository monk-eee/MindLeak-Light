# Install MindLeak Light

Choose the package that fits your agent stack. Neither requires a chat or
embedding model; [models are a recommended optional upgrade](MODELS.md).

**Start here for a local trial:** the [VS Code local guide](LOCAL.md) uses a
native launcher with Docker/stdio and no client credentials. Its `local` commands
are included in v0.5.0 native archives, alongside the `agent` instruction
installer. Published v0.4.0 native archives do not include those commands.
No published image or old executable is upgraded by new settings.

| Package | Best For | You Supply |
|---|---|---|
| Local launcher | Trying memory in VS Code; sharing one store among trusted local clients | v0.5.0 native package and Docker Desktop; no manual token |
| Native binary | Plugging into a desktop or coding agent over stdio | PostgreSQL with pgvector |
| All-in-one container | One container to run and back up | Docker/Podman, a persistent volume, and an HTTP token |
| Source Compose stack | Developing MindLeak itself | Git and Docker/Podman Compose |

This guide targets **v0.5.0**: local onboarding, general/scoped agent setup,
model-free keyword recall, optional pgvector or
hybrid recall, contextual fact lifecycle, retry-safe writes, bounded corrective
evidence, exact original-source inspection, and document recall controls.
Models remain optional. Download versioned
archives from [GitHub Releases](https://github.com/monk-eee/MindLeak-Light/releases)
or get the full all-in-one image from
[Docker Hub](https://hub.docker.com/r/monkeemagic/mindleak-light), pinned as
`monkeemagic/mindleak-light:0.5.0`. The
[publishing workflow](https://github.com/monk-eee/MindLeak-Light/actions/workflows/docker-hub.yml)
records image verification. Older binaries do not gain features from new settings.

The [administrative backup CLI](BACKUP.md) is an unreleased source feature with
separate restic/PG prerequisites and platform acceptance gates. Published v0.4.0 and v0.5.0
packages do not include it.

## Native Binary

For credential-free local use, follow [local setup](LOCAL.md) instead. The
direct PostgreSQL instructions below are for an existing separately managed
database and advanced deployments.

Download your platform's archive and its `.sha256` file from
[GitHub Releases](https://github.com/monk-eee/MindLeak-Light/releases).

| Platform | Archive Target |
|---|---|
| Linux x86-64 | `x86_64-unknown-linux-gnu` (glibc 2.35 or newer) |
| Windows x86-64 | `x86_64-pc-windows-msvc` |
| macOS Intel | `x86_64-apple-darwin` |
| macOS Apple Silicon | `aarch64-apple-darwin` |

1. Verify the archive against its checksum. On Linux, use `sha256sum -c`; on
   macOS, use `shasum -a 256 -c`. On Windows, compare `Get-FileHash -Algorithm SHA256`
   with the downloaded checksum. Checksums detect corruption; they are not signatures.
2. Extract the archive and run `./mindleak-light --version`, or
   `.\mindleak-light.exe --version` in PowerShell. No Rust, Node, or Python runtime
   is needed to run the executable.
3. Have PostgreSQL with pgvector available. Set its connection string in the
   archive's `mcp.postgres.example.json` (`mcp.example.json` in published v0.4.0
   archives), and replace `command` with the absolute binary
   path unless it is already on your client's PATH.
4. Add that server entry to your MCP client's configuration. VS Code calls the
   top-level key `servers`; Claude Desktop-style clients use `mcpServers`.

The client starts the binary with `--transport stdio`. It initializes the three
tables and waits for MCP requests; silence in a terminal is normal. See
[agent integration](INTEGRATION.md) for calls, permissions, and the memory policy.
Each archive also includes the editable architecture board, four self-contained
SVG previews, and the architecture guide.

The v0.5.0 package includes credential-free `mcp.example.json` and
`mcp.vscode.example.json` plus the local guide. Prefer `local setup` or
`local configure` to generate VS Code configuration with the absolute launcher
path and immutable container ID rather than manually copying the name-based
examples. An old executable that rejects `local --help` must be upgraded/built;
it is not requesting a token or an OAuth registration.

Remote PostgreSQL should use `sslmode=require`; a private CA can be supplied via
`MINDLEAK_DATABASE_CA_FILE`. Use `sslmode=disable` only for trusted local setups.
The database role needs schema initialization/migration permissions.

For shared HTTP instead, set `MINDLEAK_DATABASE_URL` and `MINDLEAK_HTTP_TOKEN`,
then run `mindleak-light --transport http --listen 127.0.0.1:8088`.
The binary uses your configured database; it does not bundle PostgreSQL.

## Companion Agent Skill

The [mindleak-memory bundle](../.agents/skills/mindleak-memory/SKILL.md), version
1.1.0, is included in v0.5.0 native archives and embedded in the installer. The
already-published v0.4.0 archives do not include it. It works with v0.4.0 and
newer servers; no model is required. Native archives include the complete
`.agents/skills/mindleak-memory` folder. Container users install the skill
on their agent's side, not inside the database container.

Obtain the entire folder, including `references`, from one reviewed source
revision or a release that lists the companion. Retain its revision and
`metadata.version`; do not assemble resources from different versions. The MCP
connection and the skill are separate: first configure the approved server and
tool access in each client, then install the bundle and activation policy.

| Client | Project Skill Directory | Always-On Project Instructions |
|---|---|---|
| GitHub Copilot in VS Code | `.agents/skills/mindleak-memory/` (also supports `.github/skills/` and `.claude/skills/`) | `.github/copilot-instructions.md` |
| Codex CLI or IDE | `.agents/skills/mindleak-memory/` | `AGENTS.md` |
| Claude Code | `.claude/skills/mindleak-memory/` | `CLAUDE.md` |
| Other MCP agents | The client's documented skill or reference location | Its persistent instruction context |

These paths describe client conventions, not a tested guarantee for every
version, cloud runner, or desktop client. Claude Code is not the same product
as every Claude Desktop integration. An MCP-capable client need not support
skills. The recipe tests do not prove native skill discovery in these clients.
Official references: [VS Code](https://code.visualstudio.com/docs/agent-customization/agent-skills),
[Claude Code](https://code.claude.com/docs/en/skills), and
[Codex](https://developers.openai.com/codex/skills).

Install the entire `mindleak-memory` directory in the appropriate project path,
preserving existing customizations. For shared projects, keep `.agents` as the
canonical source and use a reviewed copy or a supported local symlink for a
client that needs another location. Avoid multiple divergent skills with the
same name. This repository's [Claude entry point](../CLAUDE.md) explicitly reads
the canonical file when working in this source repository. When installing just
the companion bundle elsewhere, reference the installed SKILL.md from that
project's own instructions; native menu discovery still depends on its supported path.

Add the short [activation block](../.agents/skills/mindleak-memory/references/agent-policy.md)
to the always-on instructions the client actually loads. Preserve existing
rules, choose general memory or a stable shared project scope, and give each
contributor a truthful stable `agentId`. General memory requires no scope label.
Reopen the client session after installing new skill locations.
Check the skill listing; invoke `mindleak-memory` explicitly for the first check
using the client's picker (`/mindleak-memory` in VS Code or Claude Code,
`/skills` or `$mindleak-memory` in Codex). If native discovery is unsupported,
explicitly provide the canonical workflow as task context and test that path.

The bundle has no tool allowlist, injected shell commands, auto-approval rules,
credentials, or hardcoded endpoint. It does not synchronize identities, install
MCP, or enforce a lookup on every task. Follow the
[fresh-session acceptance checklist](INTEGRATION.md#verify-the-agent-behaviour)
before claiming a client works automatically. Do not edit global profiles or
other projects as a side effect of this repository's setup.

### Automatic Project Setup

`agent setup` and `agent check` are included in the v0.5.0 native binary, not
the already-published v0.4.0 binary. Run them on the client machine,
not inside the database container. The selected server can remain on v0.4.0.

First configure the intended MCP connection in your project. For general shared
memory without a project filter, preview installation with:

```sh
mindleak-light agent setup --client vscode --server mindleak-light --general --workspace . --dry-run
```

For project-filtered memory, choose a stable scope instead:

```sh
mindleak-light agent setup --client vscode --server mindleak-light --scope repo:your-org/your-project --workspace . --dry-run
```

Remove `--dry-run` to install. Add `--connect` to verify the selected server before
writing the files; `--dry-run` never connects and cannot be combined with it.
From a source checkout, build with `cargo build --locked -p mindleak-mcp` and use
the resulting `target/debug/mindleak-light` executable (or `.exe` on Windows).

| `--client` | Existing Project Connection | Installed Instructions |
|---|---|---|
| `vscode` | `.vscode/mcp.json`, under `servers` | `.github/copilot-instructions.md` |
| `claude` | `.mcp.json`, under `mcpServers` | `CLAUDE.md` |
| `codex` | `.codex/config.toml`, under `mcp_servers` | `AGENTS.md` |

Use the exact configured server name, not a tool's client-specific prefix.
This first version reads project configuration only, not global profiles or a
client's merged runtime configuration. JSONC comments and TOML are parsed without
rewriting the connection file. Trust the project and enable the tools in the
client normally; the installer does not change approval settings.

Choose exactly one of `--general` or `--scope`; omitting both is an error.
General mode tells agents to omit `context.scope` on writes and the `scope`
filter on recall. **General recall searches across all scopes**, not only facts
saved without scope. It still applies normal relevance and lifecycle filters.
Project mode includes its exact scope on writes and recall; it does not also
include unscoped facts. Neither mode moves or relabels existing memories, creates
a new store, or grants access to other deployments.

The files still install in the selected workspace, even in general mode. Other
workspaces and clients need their own setup pointing at the same intended store.
Reuse the chosen mode across cooperating clients; in project mode, reuse its
scope too. Scope and server labels accept 1..256 ASCII letters, digits, `.`, `_`,
`:`, `/`, `@`, and `-`; do not use credentials or a machine-specific checkout path.
Scope is not authorization and does not prove that two connections share a database.

The command installs the complete bundled skill in the client-specific directory
shown above and inserts a marked MindLeak block into the instruction file.
Text outside the block and existing line endings are preserved. Installer state
in `.mindleak/agent-setup.json` records the explicit mode, optional scope,
connection identity hashes, and owned-content hashes, not credentials. General
mode is stored as `general: true` and `scope: null`; a missing scope is never
interpreted as consent to broaden an existing installation. Older scoped state
remains scoped. Keep state with the installed files for safe repeat updates.

Rerunning the same command makes no duplicate blocks. It refuses an implicit
mode/scope/server change, conflicting skill content, malformed markers, or symlinked
destinations. Review conflicts explicitly; it does not overwrite them with a
force option. Copies in different client locations must be updated by running
setup for each installed client. Global customizations are never changed.

Check an existing installation without contacting its server:

```sh
mindleak-light agent check --client vscode --workspace .
```

To check the connection too, add `--connect`. This explicitly contacts the HTTP
endpoint or **launches the configured stdio command**; review and trust that
command first. The official MCP SDK checks server identity and the three tools'
required fields, then closes the connection. It calls no memory tools and makes
no model requests itself. A configured stdio program can perform its own startup
work, including migrations; this command is not a sandbox. The connection check
has a 15-second handshake/discovery budget and a separate bounded close phase.
Use HTTPS for non-loopback HTTP endpoints; redirects are not followed.

Client-only secret inputs such as `${input:token}` cannot be read from the CLI.
For HTTP bearer authentication, provide the value through your environment or
secret manager, then name the variable, not the token:

```sh
mindleak-light agent check --client vscode --workspace . --connect --token-env MINDLEAK_HTTP_TOKEN
```

The token is never written into the policy or installer state. Existing literal
headers, `${env:NAME}`/`${NAME}` variables, and Codex's `bearer_token_env_var`
are also supported. The probe does not load `.env`, VS Code `envFile`, saved
client inputs, or OAuth sessions; supply the equivalent environment explicitly
or check those connections in the actual client. There is no development-token
fallback and unresolved variables fail before connection.

The JSON report includes `mode` (`general` or `scoped`) and `scope` (`null` in
general mode). It distinguishes `instructionsInstalled`, `serverConfigured`, and
`connection.status` (`not_checked`, `verified`, or `failed`). `clientPermissions`
remains `not_checked`; `agentBehaviour` remains `not_measured`. A successful SDK
connection cannot establish client tool permissions, native skill discovery,
database health, or automatic agent use. Restart the client session and use the
[fresh-session acceptance checklist](INTEGRATION.md#verify-the-agent-behaviour).

Files are replaced atomically one at a time, with installer state written last;
the whole installation is not a filesystem transaction. An interrupted run can
leave a partial installation. Review `--dry-run` before retrying. If
`.mindleak/agent-setup.lock` remains after a crash, confirm no installer is active
before removing that empty lock directory. Never remove a database volume as
part of instruction repair.

Provenance and evidence rules apply in both modes. Unscoped facts can link to
other unscoped facts, but a general write cannot supersede or reinforce a scoped
target. Use an explicitly approved scoped operation for that target; never drop
a corrective link or scope restriction to force a write through.

## All-in-One Container

For a local trial, [let the launcher manage setup](LOCAL.md). The commands below
are the advanced authenticated HTTP deployment path. Read
[token creation, recovery and rotation](INTEGRATION.md#shared-http) before
sharing with other users or machines.

This variant bundles the MCP binary and PostgreSQL/pgvector in one container.
The database is reachable only through an internal Unix socket; only MCP's
HTTP port is exposed. A process supervisor manages startup and shutdown.

Pin the version tag so upgrades are deliberate:

```sh
docker run --detach --name mindleak-light --restart unless-stopped -p 127.0.0.1:8088:8088 -e MINDLEAK_HTTP_TOKEN=mindleak-light-development-token-not-for-production -v mindleak-light-data:/var/lib/postgresql/data monkeemagic/mindleak-light:0.5.0
```

That token is a public local-development example. For anything shared, use your
secret manager to inject a strong token and put the HTTP endpoint behind TLS.
Connect your MCP client to `http://127.0.0.1:8088/mcp` with the matching bearer
header. No separate database container or model server is needed.

To build the revision in your checkout locally:

```sh
docker build -f docker/Dockerfile --target all-in-one -t mindleak-light:all-in-one .
```

Use `mindleak-light:all-in-one` in the run command. With Podman, build with
`podman build --format docker` and the same remaining options; its default OCI
build format drops Docker health-check metadata. Podman accepts the run options.
The existing source Compose file explicitly builds the `app` target and still
runs the app and database separately for development.

For a Compose-managed single container, use
[docker/compose.all-in-one.yml](../docker/compose.all-in-one.yml). Set
`MINDLEAK_IMAGE` to your built or published image and `MINDLEAK_HTTP_TOKEN` to
your token, then run:

```sh
docker compose -f docker/compose.all-in-one.yml up --detach --wait
```

This starts one container, not the two-service development stack. The file
defaults to `monkeemagic/mindleak-light:0.5.0`. This release does not promote the
`latest` alias. Override `MINDLEAK_IMAGE` to pin a digest or another version.
Podman may not expose embedded health metadata from published OCI images. The
Compose template defines its own health check so `up --wait` still verifies
MCP and database readiness; use that template for health-managed Podman startup.

### Data and Operations

Keep the named volume. Recreating the container with the same volume preserves
memories. Deleting the volume deletes the database. Do not point the all-in-one
image at an unrelated existing PostgreSQL data directory.

Check health with `docker inspect --format '{{.State.Health.Status}}' mindleak-light`.
Health verifies both MCP and its database; `docker logs mindleak-light` reports
startup problems. A failed configuration can leave the container unhealthy until
you correct it; Docker's restart policy alone does not restart unhealthy containers.
The MCP worker runs as an unprivileged user. The supervisor starts as root to
initialize the volume and launch PostgreSQL under its own account. The image is
not intended for read-only-root-filesystem or arbitrary-UID execution.

Back up using PostgreSQL's tools before an image upgrade:

```sh
docker exec mindleak-light pg_dump -U mindleak_light -d mindleak_light -Fc > mindleak-light.dump
```

Test restores to a separate volume. Stop the old container before attaching its
volume to a replacement; never run two PostgreSQL processes on the same volume.
PostgreSQL major-version upgrades require a database upgrade procedure, not just
changing the image tag. This single-container package is convenient for a laptop
or small deployment, not a high-availability database service.

### Upgrade from 0.1.0, 0.2.0, 0.3.0, or 0.4.0

Back up and test the restore first. Stop all old MCP processes, then replace the
binary or container with 0.5.0 using the same database or volume. Startup applies
the required migrations atomically under the existing database advisory lock.
Existing raw text, IDs, fragments, vectors, relationships, and embedding model
metadata are preserved. Existing context, lifecycle states, tiers, pins,
feedback history, and 0.3.0 keyed-write receipts are retained. Facts from 0.1.0
acquire empty context and active, unconfirmed, short-term lifecycle defaults.
Unkeyed memories stay unkeyed. No re-embedding or model download is required.
An existing v0.4.0 database needs no new schema migration for v0.5.0. Keep its
retrieval, decomposition, embedding model, dimensions, and credentials unchanged.

Upgrading from before v0.4.0 creates two relationship indexes, backfills a derived combined
fragment/metadata search vector and recoverable fragment order, and builds a
replacement GIN index. The database role needs function/trigger privileges as
well as schema privileges. The first backfill and index build need additional
disk space and can block writes; allow time for initialization and schedule
upgrades appropriately for larger databases. Existing text and embeddings are
not rewritten. Unknown legacy fragment order stays explicitly unknown.

Keyword candidates now include lower-weight source and summary metadata;
qualified identifiers can also match their dotted components. Other new search
controls are opt-in. Default MCP text-array responses remain unchanged;
`diagnostics: true` returns an object containing results and diagnostics.
Existing search responses gain `relationshipCountExact`: false means the count
is a lower bound, not the full total. Clients must not treat a capped count as
complete. Use the new `fragmentId` inspection mode for paged evidence and exact
original text; see the [tool contract](INTEGRATION.md#tool-contract).

Keep the original embedding model and dimensions when enabling vector or hybrid
recall. Avoid running mixed server versions during the upgrade: older servers
do not support the new retry and response contracts, and 0.1.0 also ignores
lifecycle visibility. Rollback means stopping 0.5.0, restoring the pre-upgrade
backup to a separate database or volume, and pointing the previous binary at
that restored copy. An in-place downgrade is not supported. Clients must check
the server's advertised tool schema before using `requestId` or `fragmentId`.

After replacing an all-in-one container, its ID changes even if its name does
not. Review the data volume, remove only the stale `mindleak-light-local` client
entry, and run `local configure` to pin the replacement. A relocated native
launcher similarly requires configuration refresh. Agent setup never changes a
previously selected store silently; review its managed instruction/state files
when intentionally changing that connection. See [local recovery](LOCAL.md#existing-store-or-another-workspace).

For optional models, pass the [model settings](MODELS.md) as container environment
variables. For a calibrated similarity threshold in the all-in-one
image, set `MINDLEAK_RECALL_MIN_SIMILARITY` in your shell or `.env`. Both Compose
templates forward it, defaulting to `-1` (unfiltered) when unset or empty.
Recreate the all-in-one container with
`docker compose -f docker/compose.all-in-one.yml up --detach --wait` after changing
the setting. With `docker run`, pass it explicitly using `--env`.

A host model server may require
`--add-host host.docker.internal:host-gateway` and local network access. Keep the
database managed internally; use the native binary or app-only image when you
want a separately managed PostgreSQL service.
