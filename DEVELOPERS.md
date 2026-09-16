# Developing MindLeak Light

## Prerequisites

- Rust via rustup; `rust-toolchain.toml` pins Rust 1.88 with rustfmt and Clippy.
- Node.js 22+ for repository scripts. No npm dependencies are required.
- Git, Make, and pre-commit 3.5+ for hooks (`pipx install pre-commit`).
- Docker Compose or Podman Compose for PostgreSQL with pgvector.

Run `make setup` in a Git checkout to fetch locked dependencies and install
pre-commit and pre-push hooks. On Windows without Make, run `cargo fetch --locked`
and `pre-commit install --install-hooks` directly; repository checks are Node
commands listed below. The hooks themselves do not require Make.

## Local Development

Use [.env.example](.env.example) for a local `.env`; never commit credentials.
Start the database with `docker compose up -d postgres`. Native model URLs default
to `http://localhost:11434/v1`; Compose defaults to the host gateway at the same
port. For Linux/Podman, ensure your model server listens on a host interface the
container can reach; do not expose an unauthenticated model API publicly.

Shared configuration preserves MindLeak's `MINDLEAK_LLM_URL`, `MINDLEAK_MODEL`,
`MINDLEAK_LLM_API_KEY`, `MINDLEAK_EMBED_URL`, `MINDLEAK_EMBED_MODEL`, and
`MINDLEAK_EMBED_API_KEY`. URLs are API bases, including `/v1`. When overriding
models, set the correct `MINDLEAK_EMBED_DIMENSIONS` before the first start.
Provider URLs must not include credentials, query strings, or fragments.

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
node --test scripts/repository.test.mjs
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
No external LLM calls or API keys are needed. Tests do not erase the database.

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
Ordinary pushes and PRs never publish binaries. Local packaging uses
`node scripts/release.mjs --package <target-triple>` after a matching Cargo build.

GitHub branch protection and remote publishing are repository-owner actions,
not configured automatically by a local scaffold. Require CI checks on the
merge queue as well as pull requests.
