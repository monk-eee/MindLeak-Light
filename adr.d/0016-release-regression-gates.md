# ADR-0016: Released-Baseline Regression Gates

- Status: Accepted
- Date: 2026-09-16

## Context

Passing correctness tests alone does not prove that a candidate retains the
released version's useful recall behaviour. Macro improvements can conceal
individual losses. Restarting the same database volume does not test a backup.
We need repeatable PR checks without adding mandatory models or unreliable
shared-runner latency thresholds.

## Decision

Pin the v0.4.0 source, public native archive checksums, multi-architecture image
digest, and two exposed regression corpora in `scripts/regression-baseline.json`.
Use the published binary, not a rebuild labelled as the release. Verify archive
bytes before extracting or executing it. A local archive is allowed only when
it matches the same checksum; downloads fail closed.

Run the existing MCP benchmark against baseline and candidate in independently
named disposable `_test` databases. Use the same runner, complete frozen query
population, cutoff, seed, and settings for both. Snapshot candidate bytes once
and check each report's binary hash and requested workload. Alternate execution
order between cases; this does not establish identical machine conditions.
Compare decoded database names so URL aliases cannot bypass separation.

PR checks use sentence decomposition, keyword recall, no relevance model, one
pass, and concurrency one. The engineering and useful-negative corpora contribute
100 distinct evaluated queries. Exact frozen hashes prevent accidental label or
query changes from silently weakening the check.

Use corpus-audited paired comparisons and reject macro recall/abstention losses,
any executed query losing a previously found relevant fact or worsening a
ranking/abstention metric, and any candidate result over 32 KiB in these fixtures.
The fixture budget is stricter than the server's general response limit, not a
change to the tool contract. Existing comparison commands retain their behaviour
unless the new `--max-regressed-queries` option is supplied.
Compare matching baseline/candidate passes where possible, falling back to the
baseline's first pass only when it lacks that pass. Count distinct affected query
IDs and expose failing-pass details. Headline accuracy remains first-pass-only.

Integrate comparisons into the existing required Postgres and MCP Integration
job. Keep baseline/candidate/comparison JSON, sanitized runner logs, and an
explicit complete/pass summary as workflow artifacts for 30 days, including on
failure. Do not overwrite prior local evidence. Missing or failed executions
must not produce a completed passing summary.
Benchmark deadlines use forced termination rather than relying on a child to
honor SIGTERM. Asynchronous capture uses a new Unix process group or Windows
tree termination, and the parent owns the temporary root inherited through the
child's temp-directory environment. Terminate descendants on forced stop and
remove their temporary executables after process handles close. Output overflow
and cancellation are failures with the same cleanup path. This is not a sandbox;
processes that deliberately escape ownership or a killed orchestrator cannot be
given a general cleanup guarantee.

Use a single monotonic execution budget including archive download, extraction,
version checks, all benchmark invocations and comparisons. PR defaults/maxima are
600 seconds; load defaults to 900 with an explicit maximum of 7200 for controlled
hosts. Pass only the remaining time to each operation and cancel pending work on
expiry. Final success is persisted only after owned temporary-file cleanup.
The CI comparison steps allow 12/17 minutes for the 10/15-minute PR/load runners.
The load job allows 45 minutes overall and caps its build at 15 minutes, reserving
time for setup, failure reporting, cleanup and artifact upload.

Extend the required container job with the pinned released-image upgrade and an
actual pre-upgrade `pg_dump`/`pg_restore` drill. Restore into a separate empty
volume before starting the candidate's normal MCP process. Verify raw records,
IDs, vectors, model metadata, lifecycle, keyed receipts, source inspection and
document recall. Use only test-owned databases/volumes; remove them on completion
or failure. Keep the dump in bounded memory, not an uploaded artifact. Retain the
test log, and use a shell with pipefail so log capture cannot conceal failure.
Always attempt cleanup of every owned project. Aggregate failed removals with
the original test failure; failed log collection must not mask it.
After inspecting and replaying restored historical data, create a fresh keyed
episode. Prove its new text and source metadata are indexed together and raw text
is preserved. Recreate the restored candidate again, verify search/inspection,
and replay this new receipt with no extra rows or changes to old data. Replaying
an old receipt alone does not exercise post-restore insert/index maintenance.

A separately dispatched load workflow runs three passes at concurrency one and
four without models. It records first/repeat latency percentiles, throughput,
payload bytes and ranking changes, but imposes no timing threshold on shared CI
hosts. The same local runner accepts explicit optional model modes and a warm-p95
threshold only in its load profile, for controlled machines and pinned provider
settings. Never inherit model activation from the ambient environment.

## Consequences

No application API, schema, production deployment, release tag or protection
settings change. Required CI takes longer and depends on the pinned public
archive remaining downloadable; offline local verification remains available.
The PostgreSQL integration job is already protected, so no new required-check
name needs an administrative update.

These are exposed regression fixtures, not independent semantic-accuracy or
production-capacity evidence. Useful negatives are relevant when their labels
say so; unrelated facts remain failures. Per-query gates are intentionally
conservative and may require investigation of ties or valid unseen paraphrases.
Repeated passes do not increase the quality population, and timing reports do
not claim statistically equivalent performance.

Advancing the baseline, changing corpus hashes or relaxing a budget requires a
reviewed, explicit policy update with retained before/after evidence. Version
changed fixtures rather than relabelling historical results. New bug reports
still need minimal failing regressions and root-cause fixes; this gate cannot
anticipate every workload.

## Verification

Tests demonstrate offsetting gains masking query regressions and lost gold facts
despite identical aggregate metrics. Verify CLI failure exits, immutable corpus
checks, separate database requirements, checksum refusal, incomplete evidence on
failure, and refusal to overwrite earlier reports. Run real baseline comparisons
and the separate load profile; exercise the actual empty-volume restore with the
published image. Validate workflows and run `make ci` on a disposable database.
Regressions also cover escaped database aliases, later-pass recall failures,
SIGTERM-resistant child processes, and cleanup failures on multiple projects.
Test a descendant and child-created temporary file, a cancelled capture, output
overflow, a stalled download under the whole-run deadline, and the fresh-write
restore drill. Archive-specific tests require a pinned native artifact for that
platform; process ownership tests do not. Keep platform execution evidence explicit.
