# Changelog

Notable changes use [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)
sections. Unreleased entries live in [changelog.d](changelog.d/README.md).

## [Unreleased]

## [0.2.0] - 2026-09-16

### Added
- Add per-fact short- and long-term retention, explicit salience and pins, spaced-feedback consolidation, and read-time activation decay without deleting source episodes or changing pgvector embeddings.
- Attach context and typed relationships to facts, with atomic confirmation/usefulness feedback, contradiction markers, corrections, reversible archival, and bounded direct related-fact context in recall.
- Preserve three MCP tools and three tables; recall remains read-only, model-free quickstart remains available, and vector/hybrid retrieval still uses PostgreSQL pgvector.
- Return fragment IDs from writes and support scope, tier, and explicit historical recall filters. Document retention as separate from evidence confidence, with no claim of biological simulation or independently verified truth.
- Add opt-in hybrid keyword/vector rank fusion and a configurable model-specific
  cosine floor for rejecting weak semantic candidates without hiding provider errors.
- Expand recall benchmarking to 240 memories and 176 queries, including 24
  multi-fact edge cases, disjoint calibration/evaluation targets, separate
  source-versus-verified-fact scores, independent extraction previews, latency
  summaries, and a no-answer quality gate. Attribute adapted MindLeak lessons.
- Add optional bounded model-based relevance selection after existing recall,
  preserving stored fragments and surfacing inference failures instead of
  treating them as abstention. Keep model-free defaults unchanged.
- Refine source-grounded extraction instructions to preserve wording,
  references, conditions, and qualifiers. Add fresh held-out retrieval and
  extraction comparisons with background-only distractor corpora and explicit
  relevance-model configuration in benchmark reports.

### Changed
- Make the agent memory policy a visible README setup step before the tool smoke
  test. Document selective evidence-grounded learning, shared recall, stale-memory
  corrections, write verification, and checks that an agent uses memory during
  normal work rather than only when explicitly prompted.
- Align the README and operator guides with independent model options, hybrid
  recall, calibrated similarity thresholds, and fact-level benchmarking.
- Identify features added since v0.1.0 and clarify versioned installation,
  all-in-one environment forwarding, and recall troubleshooting.
- Speed up semantic recall with a bounded validated query-embedding cache and
  concurrent hybrid keyword lookup, always requerying current database rows.
- Add repeat-pass latency reports and an optional warm p95 benchmark gate.
- Keep chat processing opt-in; add provider-supported reasoning-effort controls
  and exact evidence checks for experimental relevance selections without
  treating model outputs as verified truth.
- Prepare the v0.2.0 packages and operator guides as one release, pin the all-in-one
  Compose template to 0.2.0, and keep Docker Hub's latest alias unchanged. Required
  container CI now upgrades the pinned published 0.1.0 image on the same disposable
  volume and verifies exact legacy records, vectors, relationships, embedding
  metadata, lifecycle defaults, and MCP recall. Document backup-first upgrades and
  restore-based rollback; mixed old/new servers and in-place downgrades are unsupported.

### Fixed
- Link directly to Docker Hub from the README and installation guide, with a
  version-pinned standalone-container quickstart before the two-service source
  build, persistent storage, authentication, and MCP connection details.
- Define the all-in-one Compose health check explicitly so Podman waits for MCP
  and PostgreSQL readiness when OCI image health metadata is unavailable.
- Give the JavaScript agent example's write and recall calls an explicit
  660-second request budget so sequential optional-model requests are not cut
  off by the SDK's 60-second default. Preserve provider timeouts and failure
  handling without automatic write retries, and align the integration guide.
- Add isolated CLI regressions for both tool calls without requiring a server,
  model, or installed example dependencies.
- Forward `MINDLEAK_RECALL_MIN_SIMILARITY` through the all-in-one Compose service,
  matching the source stack's unfiltered default. Add configuration-only smoke
  coverage for defaults, `.env` values, and shell overrides, and update setup
  instructions to remove the Compose-override workaround.
- Forward the optional relevance-filter mode, provider settings, and candidate
  count through both Compose deployments while keeping filtering off by default.
- Extend configuration smoke coverage for defaults, `.env` values, and shell
  overrides; keep the full container smoke test explicitly model-free and
  document the experimental filter's setup and limits.
- Build amd64 and arm64 release images on matching native GitHub runners instead of compiling Rust under CPU emulation.
- Smoke-test each pushed image by digest before publishing the combined version tag, and pin CI/build inputs to one validated release commit.
- Allow the current publishing workflow to build an existing release tag without moving it or including newer application changes.
- Reject vector norms that underflow or overflow pgvector's f32 cosine
  arithmetic, and reject non-finite database scores before returning recall
  results or fusing hybrid rankings.
- Validate provider-reported embedding-model IDs against the configured model.
  Matching and omitted/null metadata remain supported; explicit mismatches fail
  before storage or query use, with no implicit alias resolution.
- Bound decomposition, embedding, and relevance response bodies to 4 MiB using
  a shared reader that checks declared lengths and actual streamed bytes before
  JSON parsing. Add regressions for size boundaries, chunked and misleading
  lengths, malformed bodies, provider identity, and atomic MCP failure handling.

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

### Changed
- Update `thiserror` to 2 and `tower-http` to 0.7, retaining the tested memory and HTTP contracts.
- Align local, CI, and container builds on Rust 1.98 while retaining the declared Rust 1.88 minimum.
- Update GitHub Actions and Docker publishing actions to their current major versions, including artifact integrity checks, and group future workflow updates.

### Fixed
- Specify the compiler through the Rust toolchain action's input instead of its generated version tags, preventing invalid Dependabot proposals such as Rust 1.120.0.
