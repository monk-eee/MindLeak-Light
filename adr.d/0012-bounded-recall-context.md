# ADR-0012: Bounded Recall Context

- Status: Accepted
- Date: 2026-09-16

## Context

Eight related references per primary result did not bound the total context
delivered to an agent. Six primary results with large related text/context
returned over 200 KB of related JSON despite respecting the per-result limit.
At larger recall limits the payload grows further. Lifecycle activation also
changes ordering while the original retrieval score stays unchanged, leaving
clients to reconstruct the final priority themselves.

## Decision

Keep the three tools/tables, source facts, existing filters, vector similarity,
and RRF semantics. Expose the existing lifecycle adjustment as `rankingPriority`:
`score - abs(score) * 0.25 * (1 - activation)`. Compute it once after candidate
retrieval/fusion; sort by priority descending then fragment UUID ascending. The
`score` field retains its original meaning and value.

Primary results retain at most eight direct references each. Add a shared budget
of 32768 bytes for the serialized relationship arrays across all primary results,
including JSON escaping, array brackets, and separators. Reserve the primary
results first. Allocate complete related objects round-robin in primary ranking
order, preserving each owner's existing relationship-type/UUID order. An object
that cannot fit is omitted rather than shortened; later smaller objects may fit.
Allocation is deterministic for the same ordered candidates, not a guarantee of
equal numbers of references for every primary.

Limit the serialized result array to 524288 bytes. If primaries alone exceed
that limit, return a clear error requesting a smaller recall limit, rather than
silently dropping primary facts or truncating text. Otherwise related data uses
the smaller of its own remaining budget and the total remaining payload budget.
The MCP envelope and duplicate text/structured representations add overhead and
are not claimed to fit this result-array limit. This is a byte budget, not tokens.

Keep `relationshipCount` as the number of eligible links before per-fact/global
limits and add `relationshipsTruncated` when the included count is smaller.
An empty relationship array with a positive count is explicitly partial context,
not proof that the fact has no relationships. No extra model or database call is
introduced. Related facts remain source-attributed context, not inferred evidence.

## Consequences

The fields are additive, but strict client schemas may need updating. Bounded
payloads improve predictable context use, not retrieval accuracy or large-scale
search cost. SQL still counts eligible links and fetches bounded candidate rows;
large-degree query performance needs separate measurement. Existing JSON payload
validation and source-retention invariants remain unchanged.

This branch also clarifies that atomic persistence is not a semantic guarantee.
Model extraction should preserve causal and attributed claims rather than flatten
them into disconnected events. Default decomposition preserves wording and does
not resolve ambiguous pronouns. Neither a prompt, exact text matching, metadata,
nor a relationship proves truth or authority. v0.2.0 already supplies archive,
restore, supersession, and activation; this decision does not add lifecycle state
transitions or overlap retry-safe write work.

## Verification

The real PostgreSQL budget regression returned 203046 related bytes before the
fix, then passed with all six primary facts preserved and truncation exposed.
Tests cover escaping, primary reservation, oversized-primary failure, per-fact
counts, and no-link responses. A ranking regression shows a lower raw score can
correctly sort first while `rankingPriority` explains the order. Real MCP tests
verify both new fields. Semantic-dependency fixtures reject causal loss, invented
referents, lost attribution, and conditions presented as completed events.
Run `make ci` with disposable `_test` PostgreSQL before proposing a merge.
