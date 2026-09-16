# ADR-0001: Record Architecture Decisions

- Status: Accepted
- Date: 2026-09-16

## Context

MindLeak Light needs the sibling repository's engineering discipline without
its coordination services. Decisions should be reviewable alongside the code.

## Decision

Keep numbered Markdown ADRs in `adr.d/`. Valid statuses are Proposed, Accepted,
Rejected, Deprecated, and Superseded by a linked ADR. Generate the index from
the records and validate it locally and in CI. Start numbering fresh here.

## Consequences

No external design board, leases, database, or agent orchestration is required.
Parallel branches can choose the same number; the duplicate check forces a
resolution during integration. Git preserves the decision history.

## Verification

`node --test scripts/repository.test.mjs` and `node scripts/adr-index.mjs --check`.
