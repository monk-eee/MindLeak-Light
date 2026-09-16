# Changelog

Notable changes use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
sections. Unreleased entries live in [changelog.d](changelog.d/README.md).

## [Unreleased]

## [0.1.0] - 2026-09-16

### Added
- Package native MCP binaries with installation guides, checksums, and ready-to-edit stdio connection templates for Linux, Windows, and macOS.
- Add an all-in-one image containing MindLeak Light and PostgreSQL/pgvector, with a persistent volume, supervised startup/shutdown, required HTTP authentication, and an internal-only database socket.
- Prepare manual multi-architecture publishing to `monkeemagic/mindleak-light` on Docker Hub, gated by release metadata, CI, and configured registry credentials.
- Add container tests for authentication, real MCP write/recall, health checks, and data persistence across recreation. No registry image is published by this change.
- Add the original MindLeak logo and compact icon, Light-specific status badges, and documentation links to the README.
- Include both branding assets in release archives so the packaged README retains its logo.
- Add one Rust MCP server with write, recall, and decomposition tools backed by PostgreSQL and pgvector.
- Extract atomic facts with OpenAI-compatible models and commit each memory with all fragments and vectors atomically.
- Preserve replaceable retrieval and keep RAST, orchestration, and graph reasoning out of the initial runtime.
- Add ADRs, changelog fragments, contributor guidance, hooks, CI, container setup, and release packaging adapted from MindLeak.
- Make all three memory tools usable without a chat or embedding model: sentence/list decomposition and indexed PostgreSQL keyword recall are the defaults.
- Keep models recommended and independently opt-in, with LM Studio-compatible structured output and explicit provider settings; enabled-provider failures never silently fall back.
- Preserve existing memories and vectors when upgrading. Unembedded fragments remain keyword-searchable and are not automatically backfilled into vector recall.
- Add a human-first quickstart, agent integration guide, optional-model guide, and a runnable official JavaScript MCP SDK example.
- Add an opt-in recall benchmark with a labelled synthetic corpus, isolated
  disposable-database MCP runs, Precision@k, Recall@k, MRR, nDCG, hit rate,
  unanswerable-query scoring, per-category JSON reports, and an optional recall
  quality gate. Include model-comparison guidance and scorer tests in repository CI.
