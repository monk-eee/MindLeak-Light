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
MCP configuration connects to the Compose HTTP server without invoking Cargo.

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
and `MINDLEAK_LISTEN`. The binary reads `.env` before resolving CLI defaults.
HTTP always requires a token of at least 32 non-whitespace ASCII characters.

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
node --test scripts/repository.test.mjs examples/benchmark-recall.test.mjs
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
