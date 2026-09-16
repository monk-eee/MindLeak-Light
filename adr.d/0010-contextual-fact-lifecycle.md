# ADR-0010: Contextual Fact Lifecycle

- Status: Accepted
- Date: 2026-09-16

## Context

The user wants biologically inspired short- and long-term memory, where facts
earn persistence, remain attached to source context, and relate to other facts.
pgvector must remain the semantic retrieval backend. This explicitly revises
the earlier no-decay boundary without adopting the sibling coordination system.

## Decision

Keep one executable, PostgreSQL, three tables, and the three existing MCP tools.
Treat raw memories as immutable recorded episodes and fragments as facts with
logical `short_term` or `long_term` retention. Recall assembles a temporary
working set; it does not create a fourth store. Promotion changes metadata on a
fact, not its text, identity, embedding, or source episode.

Store optional scope, session ID, source reference, and contextual summary on
the episode. Related facts share an episode through memoryId or have explicit
typed links in relationships. Writes can attach per-fact retention and links
using exact decomposed text, so changed model output cannot misattach a link.
Return fragment IDs after commit. Preserve the existing basic write arguments.

Only explicit `confirms` or `reinforces` links count as feedback. Count a given
target/type/session once across agents; concurrent duplicate feedback must not
increase counters or refresh timestamps. On new feedback, an active, undisputed
fact can consolidate after two confirmation sessions or three useful sessions,
with at least 24 hours between its first and latest feedback. A retrieved result
is never evidence. Long-term retention through usefulness does not imply confirmation.

`supports` and `related` are reference claims only. `contradicts` marks a target
disputed and blocks automatic consolidation. `supersedes` records a replacement
and removes the old fact from normal recall without deleting it. `archives` and
`restores` provide reversible exclusion; superseded state is terminal. A write
can change each target's lifecycle at most once. Cross-scope links are rejected.

Compute activation at recall time. Initial policy half-lives are seven days for
short-term and ninety days for long-term, anchored to creation or last feedback.
Importance controls salience, not truth. Pinned facts do not decay. Fetch bounded
keyword/pgvector candidates with scope, agent, tier, and state filters applied
before the limit, then apply a bounded activation discount to ranking priority.
Expose the original similarity/rank score and activation separately. Include at
most eight direct related-fact references per result with a total link count;
do not traverse recursively or treat a link as another relevance match.

Persist the episode, full fragment/vector set, explicit links, and resulting
lifecycle changes in one transaction. Lock targets in UUID order, enforce feedback
uniqueness in SQL, and keep the model-free quickstart. Add an idempotent migration
without rewriting existing memory text or vectors; old facts receive the default tier.

## Consequences

This mimics encoding, consolidation, reconsolidation, and reduced accessibility,
not neurons or measured biological parameters. The initial timing/count policies
are engineering defaults, not validated cognitive constants or recall-quality gains.
There is no sleep worker, LLM-generated consolidation summary, automatic deduplication,
truth inference, recursive graph reasoning, or automatic deletion.

Agent-supplied sessions are claims, not verified independent observations. A
trusted client can mislabel feedback or pin incorrect facts; the system exposes
the provenance and separates retention from evidence status rather than claiming
to solve trust. Supersession and archive operations share the existing write tool,
which must advertise potentially destructive changes to normal recall visibility.

Candidate limits mean lifecycle cannot recover a fact outside the initial search
pool. Supplied fact directives must match extraction output exactly; model preview
and write may differ, in which case the write fails instead of guessing.

## Verification

Use simulated clocks for activation and consolidation. Database regressions cover
spaced feedback versus bursts, concurrent duplicate sessions, read-only recall,
context filters and direct relationships, atomic rollback, correction history,
archival/restoration, and preservation of pgvector embeddings through promotion.
The real MCP subprocess test covers these controls with no model attached while
retaining exactly three tools. Run `make ci` against a disposable `_test` database.
