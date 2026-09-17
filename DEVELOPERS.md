# Developing MindLeak Light

Want to use MindLeak in an agent rather than work on its source? Start with the
[quickstart](README.md#quickstart) and [agent integration](docs/INTEGRATION.md).

## Prerequisites

- Rust via rustup; `rust-toolchain.toml` pins Rust 1.98 with rustfmt and Clippy.
	The manifest's minimum supported Rust version remains 1.88.
- Node.js 22+ for repository scripts. No npm dependencies are required.
- Git, Make, and pre-commit 3.5+ for hooks (`pipx install pre-commit`).
- Docker Compose or Podman Compose for PostgreSQL with pgvector.

Run `make setup` in a Git checkout to fetch locked dependencies and install
pre-commit and pre-push hooks. On Windows without Make, run `cargo fetch --locked`
and `pre-commit install --install-hooks` directly; repository checks are Node
commands listed below. The hooks themselves do not require Make.

## Local Development

Use [.env.example](.env.example) for a local `.env`; never commit credentials.
Start the database with `docker compose up -d postgres`. By default, sentence/list
decomposition and keyword recall need no model settings. The checked-in VS Code
MCP configuration is initially empty. For the credential-free all-in-one trial,
run `cargo run --locked -p mindleak-mcp --bin mindleak-light -- local setup`;
it generates a pinned Docker/stdio entry. For the two-service development stack,
configure authenticated HTTP as described in [integration](docs/INTEGRATION.md#shared-http).

Shared configuration preserves MindLeak's `MINDLEAK_LLM_URL`, `MINDLEAK_MODEL`,
`MINDLEAK_LLM_API_KEY`, `MINDLEAK_EMBED_URL`, `MINDLEAK_EMBED_MODEL`, and
`MINDLEAK_EMBED_API_KEY`. They are only used when `MINDLEAK_DECOMPOSITION=openai`
or `MINDLEAK_RETRIEVAL=vector`/`hybrid` explicitly enables the corresponding provider.
Enabled providers require an API base including `/v1`, a model ID, and for
embeddings, `MINDLEAK_EMBED_DIMENSIONS`. The optional
`MINDLEAK_RECALL_MIN_SIMILARITY` is a calibrated cosine floor, not confidence.
See [optional models](docs/MODELS.md)
for LM Studio, Ollama, native/container addresses, and upgrade behavior.

Experimental recall-time selection uses `MINDLEAK_RELEVANCE=openai` (default
`off`), with independent `MINDLEAK_RELEVANCE_URL`, `MINDLEAK_RELEVANCE_MODEL`, and
optional `MINDLEAK_RELEVANCE_API_KEY`. `MINDLEAK_RELEVANCE_CANDIDATES` defaults
to 20 and accepts 1..50; the caller's recall limit can raise the candidate count.
Both Compose templates forward these settings without enabling the filter by default.

Other settings are `MINDLEAK_DATABASE_URL`, `MINDLEAK_DATABASE_CA_FILE`,
`MINDLEAK_DB_POOL_SIZE` (1..64, default 8), `MINDLEAK_MODEL_TIMEOUT_SECS`
(1..300, default 60), `MINDLEAK_HTTP_TOKEN`, `MINDLEAK_TRANSPORT` (stdio/http),
and `MINDLEAK_LISTEN`. Ordinary server mode reads `.env` before resolving CLI
defaults. `local` subcommands do not load a workspace `.env` or require a native
database URL. Ordinary HTTP always requires a token of at least 32 non-whitespace
ASCII characters; the explicit host-only bridge has a separate guarded entry point.

Run `cargo run --locked -p mindleak-mcp -- --transport http` for native HTTP.
The [debug configuration](.vscode/launch.json) uses port 8089 to avoid the Compose
server on 8088. Install the recommended Rust Analyzer and CodeLLDB extensions,
then select **MindLeak Light: Debug HTTP MCP** in VS Code.

Use `make up COMPOSE="podman compose"` with Podman. Stopping Compose retains the
database volume; `down -v` destroys it and is never part of routine test cleanup.

## Checks

```sh
cargo fmt --all -- --check
cargo clippy --workspace --all-targets --all-features --locked -- -D warnings
cargo test --workspace --locked
node scripts/adr-index.mjs --check
node scripts/changelog.mjs --check
node scripts/check-docs.mjs
node --test scripts/repository.test.mjs examples/benchmark-recall.test.mjs examples/validation-harness.test.mjs
```

`cargo test` alone does not run database tests. For the required integration gate,
create a separate database on the local instance, then set its URL:

```sh
docker compose exec postgres createdb -U mindleak_light mindleak_light_test
export MINDLEAK_TEST_DATABASE_URL='postgresql://mindleak_light:mindleak-light-development-only@127.0.0.1:55432/mindleak_light_test?sslmode=disable'
make ci
```

On PowerShell, use `$env:MINDLEAK_TEST_DATABASE_URL = '...'` and run the commands
individually, ending with `cargo test --workspace --all-features --locked`.
The test database must end in `_test`. The suite uses the fixed `test-model`
embedding space, namespaced records, real pgvector, and local mock model servers.
No external LLM calls or API keys are needed. The zero-provider regression runs
all three MCP tools while its provider mock is unavailable and checks that it
received no requests. Upgrade tests create and remove their own UUID-named
`*_test` databases, so the test role needs `CREATEDB`. Tests never erase the
configured test database or a development database.

The JavaScript integration example is optional and isolated from the server:
`npm ci --prefix examples` installs its dependencies. Run it against a disposable
test server by setting `MINDLEAK_MCP_URL` and `MINDLEAK_HTTP_TOKEN`, then
`npm --prefix examples run memory`. It writes one sample memory per run.

### Backup Administration

See [the operator guide](docs/BACKUP.md) and
[ADR-0019](adr.d/0019-encrypted-administrative-backups.md). Offline CLI/safety
tests run with the ordinary Rust suite. To run real encryption/restore and
concurrent-capture tests, install restic 0.19.x and select a disposable PG16
container, in addition to the test database URL above:

```sh
export MINDLEAK_BACKUP_TEST_CONTAINER=mindleak-light-test-postgres
export MINDLEAK_BACKUP_CONTAINER_TOOL=podman
make backup-test
```

The suite creates fresh UUID-named databases and a temporary restic repository;
a name suffix is never cleanup ownership. `make ci` remains required, with
`backup-test` additional. Never report an omitted integration as passing. This
fixture installs no OS jobs and uses no Azure account.

### Local Access Acceptance

```sh
cargo build --locked -p mindleak-mcp --bin mindleak-light
npm ci --prefix examples --ignore-scripts
node scripts/local-access-smoke.mjs
```

Use `CONTAINER_ENGINE=podman` for Podman, `MINDLEAK_BINARY` for an absolute
launcher path, and `MINDLEAK_IMAGE` for the candidate all-in-one image. The test
creates unique containers, volumes and a `_test` database, exercises the generated
configuration with the official MCP SDK, and removes only its own resources.
It checks three tools, exact source and keyed receipt persistence after restart,
idempotent configuration, missing engine/container, remote contexts, existing
volume refusal, unavailable database recovery and diagnostic privacy. On native
macOS/Windows it also tests the loopback HTTP bridge; on Linux it verifies that
the opt-out is refused. CI runs this against the built all-in-one image.

SDK checks are not a substitute for a real client check. The
[VS Code happy path](docs/LOCAL.md#first-successful-write-and-recall) and
[cached-input recovery](docs/INTEGRATION.md#recover-a-rejected-or-cached-token)
were exercised in an isolated VS Code 1.138.0 macOS profile with disposable data.
The test used VS Code's own MCP tool discovery and `vscode.lm.invokeTool`, with
normal tool confirmations, not an inferred success from an HTTP response body.
Missing/wrong/malformed/cached-old credentials all produced 401 and the unsupported
registration dialog; editing the specific stored input and restarting recovered
three tools and write/recall. A window reload can leave the server stopped, so
the documented Start Server step is explicit. Windows UI acceptance must still
run on a Windows host before claiming that platform was client-tested.

Record both `local status` and the client's advertised server version. The
published-image local checks used v0.4.0, image reference
`docker.io/monkeemagic/mindleak-light@sha256:b0686294b22c31ea0b6bef64cb139947b04edc27fb2e196923fa5e1f554e381c`,
ARM64 image ID `8c0b4b8ca0e002d65dff29f332187410c54e365777852a12cb4c57cd03e593b7`.
The native launcher is new source, not a republished v0.4.0 artifact. Preserve
only safe metadata and results; do not retain raw headers, memory text or client
secret storage in CI artifacts.

### Companion Skill

The canonical agent workflow lives in
[the skill bundle](.agents/skills/mindleak-memory/SKILL.md), with one
[activation policy](.agents/skills/mindleak-memory/references/agent-policy.md)
and versioned [tool recipes](.agents/skills/mindleak-memory/references/tool-recipes.json).
The agent guide, Copilot instructions, and Claude entry point route to those
files; README and integration snippets are checked against the policy. Keep
`metadata.version` and `skillVersion` aligned when behaviour changes, and update
recipes with the actual advertised MCP contract. No runtime inference or new
tool permissions are part of installing this bundle.

The repository suite checks discovery metadata, self-contained references,
instruction routing, and byte-for-byte native package inclusion. The database
MCP suite runs the shipped recipes across fresh client processes with separate
writer IDs, shared scope, source inspection, correction, history, and failure
checks. Use a disposable `_test` database for it. These are protocol-contract
checks, not model-behaviour or native Copilot/Claude/Codex activation evidence;
record those separately using the [acceptance checklist](docs/INTEGRATION.md#verify-the-agent-behaviour).
Never turn an unrun client combination into a compatibility claim.

The unreleased [project installer](docs/INSTALL.md#automatic-project-setup) lives
in [agent_setup.rs](crates/mindleak-mcp/src/agent_setup.rs); its
[connection probe](crates/mindleak-mcp/src/agent_setup/probe.rs) uses the official
SDK rather than hand-written MCP requests. Both run before server environment
loading. The binary embeds the existing skill resources, so packaging and Docker
builds must include their source paths. Keep installation in this owning module
when integrating other setup commands; do not add another instruction writer.

Focused checks are `cargo test -p mindleak-mcp --bin mindleak-light agent_` and
the existing MCP HTTP test plus
`mcp_lifecycle::agent_setup_installs_and_checks_real_stdio_without_writes` in the
database suite. Cover unchanged project configuration, stable memory modes/scopes, repeated
installation, edited managed blocks/resources, symlinks, credential privacy,
actual SDK discovery, and honest unmeasured client behaviour. Schema discovery
does not authorize tool use or prove that an agent invoked memory.

### Released-Baseline Gate

The required PostgreSQL CI job also runs
[regression-check.mjs](scripts/regression-check.mjs) against the published native
release pinned in [regression-baseline.json](scripts/regression-baseline.json).
Both corpus hashes are frozen. The default model-free run evaluates 100 queries,
fails individual regressions even when averages improve, and applies a 32 KiB
result budget for these fixtures. No production latency target is inferred.

Database names are compared after URL decoding, so differently escaped names
cannot send both runs to the same database. Each benchmark runs in an owned Unix
process group, or a Windows process tree terminated with `taskkill /T /F` on a
forced stop. The parent gives each invocation a private temporary directory and
removes it after the processes close, including after timeouts and output overflow.
This is process cleanup, not a sandbox for untrusted binaries; hard termination
of the orchestrator or host can still interrupt cleanup.

For a local run, create two independent disposable databases, then:

```sh
cargo build --release --locked -p mindleak-mcp --bin mindleak-light
npm ci --prefix examples --ignore-scripts
export MINDLEAK_BASELINE_DATABASE_URL='postgresql://mindleak_light:mindleak-light-development-only@127.0.0.1:55432/mindleak_baseline_regression_test?sslmode=disable'
export MINDLEAK_TEST_DATABASE_URL='postgresql://mindleak_light:mindleak-light-development-only@127.0.0.1:55432/mindleak_candidate_regression_test?sslmode=disable'
node scripts/regression-check.mjs --candidate target/release/mindleak-light --output target/regression-local
```

The output directory must not already exist. The runner downloads and verifies
the pinned native archive, or accepts the same verified archive through
`--baseline-archive PATH`. It does not delete databases; remove only those you
created after preserving reports. Ordinary `make ci` remains the core local
gate; this additional published-baseline check runs automatically in PR CI.
CI uploads JSON comparisons and logs even when a gate fails, for 30 days.

`--deadline-seconds N` sets one execution budget covering archive download,
extraction, version checks, every benchmark invocation, and comparisons. PR runs
default to 600 seconds and accept 1..600; load runs default to 900 seconds and
accept 1..7200 for explicit longer controlled-host evaluations. Each operation
receives only the remaining budget. Deadline expiry cancels pending work, stops
scheduling new comparisons, and leaves a failed, incomplete summary. Success is
written only after temporary-file cleanup; `elapsedMs` includes that cleanup.
CI allows 12 minutes for the 10-minute PR runner and 17 minutes for the 15-minute
load runner. The load job allows 45 minutes overall with a 15-minute build limit,
leaving time for setup, cleanup and the always-run artifact upload.

Use `--profile load` for three passes at concurrency one and four. The **Release
Regression Load Report** workflow is manual, not a PR timing gate. On a controlled
host only, add `--max-warm-p95-ms N` with a justified budget. Model modes require
explicit `--decomposition`, `--retrieval`, or `--relevance` flags in this profile
and matching provider settings; the dispatched GitHub workflow remains model-free.
Pin model weights/provider versions separately. See [benchmark guidance](docs/BENCHMARKS.md)
and [ADR-0016](adr.d/0016-release-regression-gates.md).

The per-query gate checks every executed candidate pass, comparing the matching
baseline pass when present and baseline pass 1 otherwise. An affected query is
counted once even if it fails repeatedly; `regressedPasses` identifies the failing
passes and lost facts. Headline quality and confidence intervals still use only
pass 1, so repeated runs are not additional accuracy observations.

### Architecture Diagrams

The [architecture board](assets/architecture.excalidraw) contains four editable
Excalidraw frames: overview, write, recall, and lifecycle. Open it in
[Excalidraw](https://excalidraw.com) or a compatible editor. Keep labels bound
to their shapes with horizontal centre and vertical middle alignment; wait for
the Excalifont font to load before adjusting text or exporting.

Save the board and export each changed frame as SVG with background and
**Embed scene** enabled, replacing its matching preview linked from the
[architecture page](docs/ARCHITECTURE.md). SVG previews embed their fonts and
remain readable without loading a CDN. They also retain editable scene data.
Run the focused check after saving both source and previews:

```sh
node --test --test-name-pattern='architecture diagrams' scripts/repository.test.mjs
```

The check covers required concepts, bindings, centred labels, padding, and the
embedded previews' agreement with the editable board. Preview the SVGs as well;
font rendering and line crossings need a visual check.

### Distribution Checks

The Dockerfile has two runtime targets: `app` for an external database and
`all-in-one` for managed PostgreSQL plus MCP. Source Compose selects `app`.
To test the single-container package locally:

```sh
npm ci --prefix examples --ignore-scripts
docker build --target all-in-one -f docker/Dockerfile -t mindleak-light:all-in-one-test .
MINDLEAK_IMAGE=mindleak-light:all-in-one-test node scripts/container-smoke.mjs
```

With Podman, add `--format docker` to the build command so HEALTHCHECK is retained,
and set `CONTAINER_ENGINE=podman` plus the exact local image tag for the script.
PowerShell users can set those variables with `$env:NAME = 'value'` first.
The test creates a unique Compose project with a `mindleak_light_test` database,
checks auth and real MCP calls, recreates the container, verifies persisted rows,
then deletes only its own volume. Set `MINDLEAK_UPGRADE_FROM` to an older published
image to test replacing it with the candidate on that same volume. Required CI
pins published 0.1.0, 0.2.0, and 0.3.0 image digests and checks exact raw records,
IDs, vectors, links, embedding metadata, and post-upgrade MCP recall. The 0.1.0
path checks lifecycle defaults; the 0.2.0 path also preserves existing context,
pins, archival state, tiers, and feedback counters/timestamps. The 0.3.0 path
also verifies a keyed receipt created before the upgrade.
The candidate must also advertise retry-safe writes and return ranking/truncation
metadata, `relationshipCountExact`, and model-free original-source inspection.
The built image also exercises all-term matching, diagnostics, grouped provenance,
same-episode context, and the migrated combined fragment/metadata search index.
A second recreation replays a keyed write and verifies its original
receipt and unchanged row counts. See [review status](docs/REVIEW-STATUS.md) for
the integrated contracts and remaining quality questions.

CI additionally tests the pinned v0.4.0 image and restores its real pre-upgrade
backup into a fresh volume. To run that drill locally after building the image:

```sh
export MINDLEAK_UPGRADE_FROM="$(node -p 'require("./scripts/regression-baseline.json").image')"
MINDLEAK_IMAGE=mindleak-light:all-in-one-test node scripts/container-smoke.mjs --restore
```

The restore target starts with PostgreSQL alone and no application tables. After
`pg_restore`, the normal candidate starts and must recall the exact original
source and replay the pre-upgrade keyed receipt. It must then create a new keyed
episode, find it with an all-term query spanning new text and source metadata,
and inspect its exact raw text. Another restart must retain that new search
result and replay its new receipt without creating rows or changing lifecycle,
vector metadata, or old data. The test then deletes only its two own projects/volumes. This does not
replace testing your deployment's off-machine backup storage, retention, or
recovery time. The dump is not logged or uploaded.
Cleanup attempts every owned project even if one removal fails. Test, log, or
cleanup failures cannot turn the drill into a pass; the original test error and
any failed removals are retained together. A stopped local process does not
guarantee a remote provider stopped computing.

To check Compose environment forwarding before building an image:

```sh
MINDLEAK_IMAGE=mindleak-light:all-in-one-test node scripts/container-smoke.mjs --config-only
```

This renders Compose configuration only; the named image need not exist and no
container, database, or model is started. It checks both templates for similarity
and relevance defaults, explicit `.env` values, and shell overrides. These checks
also run before the full smoke test, which explicitly disables relevance
filtering to remain model-free even when the caller has enabled it locally.
Set `CONTAINER_ENGINE=podman` to use Podman Compose.

## Recall Benchmarks

Use the [recall benchmark guide](docs/BENCHMARKS.md) to measure ranked retrieval
on a labelled 240-memory corpus, calibrate rejection on separate queries, compare
keyword/vector/hybrid configurations, and evaluate multi-fact extraction without
confusing source hits with verified facts. The runner uses the optional example SDK
dependencies and a native server against an explicit disposable `*_test`
database; it never writes to the running quickstart HTTP server. Scoring tests
need no npm packages, model, or database and run in `make script-test` and `make ci`.

The [Validation Harness v1](docs/VALIDATION.md) extends these deterministic
scoring helpers with fresh MCP sessions, agent comparisons, sandboxed coding
tasks, scale charts, and a real-time longitudinal journal. Its unit tests run in
the same gates without a model. For the optional actual container/chart tests:

```sh
npm ci --prefix examples
podman pull docker.io/library/node:22-bookworm-slim
MINDLEAK_VALIDATION_CODE_ENGINE=podman node --test examples/validation-harness.test.mjs
```

The ordinary gate reports that integration test as skipped unless explicitly
enabled. Agent inference and the full 100/500/1000-fact harness are opt-in,
separate from ordinary unit tests. They require the documented disposable
database and never target a running user's memory service.

## Changes and Releases

Use focused Conventional Commits and separate worktrees for concurrent work.
Do not bypass hooks. Add a changelog fragment for user/operator changes and an
ADR for durable decisions. `make adr-index` regenerates the index; `make changelog`
previews release notes. The PR template records risk, rollback, and test evidence.

To prepare a release:

1. Set the workspace version in `Cargo.toml` and refresh `Cargo.lock` with Cargo.
2. Run `node scripts/changelog.mjs --release X.Y.Z` and review consumed fragments.
3. Run `make ci` and `node scripts/release.mjs --check vX.Y.Z`.
4. Commit and merge the release preparation; only then create and push `vX.Y.Z`.

Tagging triggers the release workflow, which validates metadata, tests against
Postgres, and packages the single executable for Linux, Windows, and both Mac
architectures with SHA-256 checksums. Releases remain drafts until reviewed.
Each archive includes installation/model guides and a platform-correct
`mcp.example.json`; each build host checks the binary's `--version` before packaging.
Ordinary pushes and PRs never publish binaries. Local packaging uses
`node scripts/release.mjs --package <target-triple>` after a matching Cargo build.

### Docker Hub Publishing

The destination is **`monkeemagic/mindleak-light`**. Publishing is manual and
independent from native draft releases; ordinary pushes and tag builds do not
send an image to Docker Hub.

1. Create that repository on Docker Hub with the visibility you intend.
2. In this GitHub repository's Actions secrets, set `DOCKERHUB_TOKEN` to a Docker
	Hub access token with write access to that repository. Do not paste tokens into
	source files or chat. The login defaults to `monkeemagic`; use the Actions
	variable `DOCKERHUB_USERNAME` if a different authorized account owns the token.
3. Prepare and push a version tag using the release procedure above.
4. Run **Publish Docker Hub Image** from `main` with `release_tag=vX.Y.Z`, or use
	`gh workflow run docker-hub.yml --ref main -f release_tag=vX.Y.Z -f publish_latest=false`.

The workflow resolves the existing release tag to one immutable commit and rejects
missing credentials or tag/changelog mismatch. It runs CI on that commit, builds
the all-in-one target on native `linux/amd64` and `linux/arm64` hosts, and smoke-tests
each pushed digest before assembling the versioned image manifest. Images include
provenance and an SBOM. `vX.Y.Z` becomes image tag `X.Y.Z`.
`latest` only moves when `publish_latest=true` is explicitly selected, and never
for a prerelease. Review the built digest and deployment backup before upgrading.

GitHub branch protection and remote publishing are repository-owner actions,
not configured automatically by a local scaffold. Require CI checks on the
merge queue as well as pull requests.
