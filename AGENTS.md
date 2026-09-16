# MindLeak Light: Agent Guide

## Scope

One Rust workspace, one MCP executable, one PostgreSQL database. Read
[the architecture](docs/ARCHITECTURE.md) and [ADRs](adr.d/README.md) before
changing module boundaries. This is not the sibling MindLeak coordination system.

## Invariants

- Only three tools: `write_memory`, `recall_memory`, `decompose_memory`.
- Only three application tables: `memories`, `fragments`, `relationships`.
- Every successful write stores the exact raw text and complete fragment set
  atomically, including validated vectors when embeddings are enabled. Provider
  or database failures must not report success.
- The default and quickstart need no chat or embedding model: use deterministic
  sentence/list decomposition and PostgreSQL keyword recall. Models are
  recommended opt-ins for richer extraction and semantic recall, not prerequisites.
- Optional model decomposition extracts independent facts through an
  OpenAI-compatible provider such as LM Studio. Never substitute sentence
  splitting or the original paragraph when an enabled provider fails.
- Recall is behind `MemoryRetriever`; PostgreSQL keyword search is the default
  and pgvector is optional. Do not implement
  RAST, graph traversal, decay, event buses, CQRS, workers, or coordination here.
- Do not mix embedding models or dimensions in one database. `agentId` is
  provenance and an optional filter, not an authentication or tenant boundary.
- Never log memory text, credentials, or provider response bodies. Stdio stdout
  belongs exclusively to MCP. Remote exposure requires authentication and TLS.

## Working Practice

Search the owning crate and neighboring tests before adding code. Reuse the
existing abstraction rather than adding parallel helpers. Keep modules focused;
do not add compatibility shims or silent fallbacks. Prefer deleting complexity.

Run a focused test immediately after each behavioral edit. Add regression tests
for fixes and verify their failure before the fix. Run `make ci` before proposing
a merge; database tests must run against a disposable database ending in `_test`.
Never report an unrun database suite as passing.

Preserve changes made by others. Concurrent writers use separate worktrees.
Do not commit, create branches, publish, or change remote settings unless asked.
Use Conventional Commits, explicit staging, and never `--no-verify`.

## Repository Records

- Hard-to-reverse decisions need a numbered record in `adr.d/`, including status,
  context, decision, consequences, and verification. Run `make adr-index`; CI
  rejects duplicate numbers, malformed records, and stale indexes.
- User/operator changes need a `changelog.d/<section>-<slug>.md` fragment. Do not
  append to `CHANGELOG.md` directly during ordinary development.
- Record fixable outstanding defects in `gaps.d/`; record deliberate boundaries
  in [known limitations](docs/KNOWN-LIMITATIONS.md). Do not claim unverified work.
- Keep setup, tool contracts, and deployment docs current with code changes.
- Keep the README focused on a human's first successful write and recall.
  Put optional model setup and contributor internals in the linked guides.

See [DEVELOPERS.md](DEVELOPERS.md) for commands and release procedures.
