## Problem

## Change

## Risk and Rollback

## Verification

Include exact commands and results. State explicitly when a database or transport
check was not run. Bug fixes need a regression that failed before the fix.

## Checklist

- [ ] Scoped to one outcome; no runtime orchestration or extra services.
- [ ] `make ci` passes, including real Postgres and MCP transport tests.
- [ ] Changelog fragment added for user/operator changes, or not applicable.
- [ ] ADR added or updated for durable decisions; index regenerated.
- [ ] Setup and security docs reflect the change.
- [ ] No secrets, memory data, or unrelated edits included.
