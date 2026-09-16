# ADR-0004: Repository Quality and Releases

- Status: Accepted
- Date: 2026-09-16

## Context

A small runtime still needs the sibling repository's tests, review workflow,
architecture records, changelog fragments, and repeatable releases.

## Decision

Use rustfmt, Clippy with warnings denied, Rust tests, real Postgres integration
tests, and Node's built-in runner for repo scripts. Run the same checks locally
and in CI. Keep one changelog fragment per change; explicitly fold fragments
into a dated release. Require release tags to match the workspace version.

## Consequences

GitHub Actions supplies CI and release packaging but is not a runtime dependency.
No pipeline publishes automatically from ordinary pushes. Hooks require local
installation and do not replace CI. Releases retain checksums and platform names.

## Verification

`make ci`, fixture-based script tests, workflow validation, and release metadata
checks. Publishing requires a configured GitHub remote and an explicit tag push.
