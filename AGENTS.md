# MindLeak Light: Agent Guide

## Agent Memory

For nontrivial work with an approved MindLeak connection, read the
[activation policy](.agents/skills/mindleak-memory/references/agent-policy.md)
and use the [mindleak-memory skill](.agents/skills/mindleak-memory/SKILL.md).
This repository's shared project scope is `repo:monk-eee/MindLeak-Light` unless
the user specifies another. Use your actual stable contributor `agentId` for
writes; omit the agent filter for scoped shared recall. Tests use separate,
disposable scopes and databases, never this working-memory scope.

The skill guides evidence reuse and selective writes; it grants no permissions
and does not make stored claims authoritative. If the connection is unavailable,
report that and continue with local evidence. Do not start services, install
credentials, write fixture facts, or change global client settings just to make
memory available. Repository invariants and user instructions still apply.

## Scope

One Rust workspace, one MCP executable, one PostgreSQL database. Read
[the architecture](docs/ARCHITECTURE.md) and [ADRs](adr.d/README.md) before
changing module boundaries. This is not the sibling MindLeak coordination system.

## Invariants

- Only three tools: `write_memory`, `recall_memory`, `decompose_memory`.
- Only three application tables: `memories`, `fragments`, `relationships`.
- Knowledge formation is an explicit opt-in under [ADR-0022](adr.d/0022-opt-in-chains-of-memory.md).
  Preserve ordinary memory calls and recall results. Never return chain source
  fragments in default recall, use derived chains as observation evidence, or
  interpret recorded acceptance/confidence as independent verification.
  Principles pin validated chains; revisions preserve inherited counterevidence.
  Formation previews never persist or accept beliefs. Recheck dependencies after
  model work; keep unknown/missing evidence explicit in retrieval and export.
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
  and pgvector remains the semantic backend for vector and hybrid modes. Lifecycle
  ranking must not replace vectors, change similarity scores, or bypass relevance filters.
- Fact lifecycle follows [ADR-0010](adr.d/0010-contextual-fact-lifecycle.md):
  logical short/long-term tiers, explicit spaced feedback, read-time activation
  decay, and reversible archival. Recall never reinforces or promotes a fact.
- Preserve source episodes, context, and explicit fact relationships. Similarity
  is not evidence. Confirmation, usefulness, and salience are separate claims;
  session and scope IDs are not proof of independence or authorization.
- Only bounded direct relationship reads are supported. Do not implement RAST,
  recursive graph reasoning, event buses, CQRS, workers, or coordination here.
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
- Keep the companion skill and its tested recipes consistent with the MCP
  contract. Edit its canonical activation policy first; update the matching
  README/integration snippets together. Never add client-specific permission
  grants, hardcoded MCP prefixes, or automatic service startup to the skill.
- Keep the README focused on a human's first successful write and recall.
  Put optional model setup and contributor internals in the linked guides.

See [DEVELOPERS.md](DEVELOPERS.md) for commands and release procedures.
