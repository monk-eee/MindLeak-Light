# Hardening Review Status

This records the disposition of the 21-item review and the subsequent conceptual
critique. It describes the hardening included in v0.3.0, not the older v0.2.0 packages.
The integration combines recall-contract PR #13 (`716029c`), modular-storage PR
#14 (`545ec5d`), and retry-write PR #15 (`037dbf3`, merged to main as `3703b7a`).
Their individual test runs are not evidence that the combined revision works.

## Review Disposition

"Fixed" means code and regression coverage are present. "Covered" identifies an
existing safeguard, with added coverage where useful. "Boundary" is intentional
and documented, not an implemented feature. "Open" is not a completion claim.

| Item | Disposition | Implementation or Remaining Constraint |
|---|---|---|
| C1: separately tested workstreams | Integrated | Retry lookup, arbitration, and migration live in the refactored storage modules; recall decoding retains both new fields. Cross-feature lifecycle/replay tests exercise the combination. Exact-head CI remains the merge gate. |
| C2: Compose failures | Required gate | Both real two-service startup and all-in-one persistence/upgrade must pass on this revision. Old runs, configuration-only checks, and unrelated tool failures do not establish that result. |
| C3: duplicate writes after ambiguous failure | Fixed | Optional `requestId` replays the immutable receipt without models or lifecycle effects. Concurrent first attempts commit one episode. Unkeyed calls remain non-idempotent. |
| C4: confirmation is not independent proof | Boundary | `confirmed` means caller-reported confirmation. Scope, session IDs, counters, tiers, and pins are not authority or truth. The existing wire enum is retained; there is no independent evidence verifier. |
| H1: directive preparation and validation | Covered | Intrinsic validation precedes lookup/models. One normalized fragment list is used for exact binding, vectors, IDs, and storage. Tests cover reordered/duplicate output and mixed valid/invalid directives. |
| H2: brittle or opaque directive matching | Fixed diagnostic; exact binding retained | An unmatched directive reports `facts[index].text` without revealing text. There is no fuzzy attachment of state-changing actions to different model output; preview is not a reservation of a future extraction. |
| H3: concurrent promotion loses evidence | Covered | Existing sorted target locks serialize counters and promotion. Tests cover same-session deduplication and distinct concurrent sessions crossing the consolidation threshold. |
| H4: opposite target orders deadlock | Covered | Targets lock in UUID order before mutation. A concurrent inverse-input-order regression verifies both targets retain all feedback. |
| H5: relevance selector omissions | Open quality question | Selection is optional, off by default, bounded, and fail-closed on malformed/provider results. A valid empty selection is possible; exact quotations do not prove relevance. No reliable model speed/accuracy gain has been established. |
| H6: old memories lack vectors | Boundary | NULL-vector facts remain in keyword/hybrid recall but not vector-only recall. There is no automatic backfill or re-embedding command. Inspect coverage before changing modes; do not replace historical source facts with a blind rewrite. |
| M1: RRF boundary and ties | Covered | Rank-based scoring, overlap, empty branches, same-episode facts, 50-candidate boundary scores, first omitted results, and branch-order-independent ties have unit coverage. |
| M2: returned score differs from ordering | Fixed | Additive `rankingPriority` exposes actual ordering; raw keyword/cosine/RRF `score` is preserved. |
| M3: lifecycle priority applied too early | Covered | Filters precede branch limits; activation is applied once after raw retrieval or hybrid fusion. It cannot recover a fact outside the candidate pool. |
| M4: unbounded related context | Fixed | Eight links per fact, shared 32 KiB serialized related arrays, 512 KiB result array, whole primary facts reserved first, and explicit truncation metadata. These are not token or entire MCP-envelope limits. |
| M5: query-cache identity | Covered | Cache ownership fixes model/dimensions per retriever; only validated exact-query vectors are cached. Rows and lifecycle state are re-read. No hot model reload or result cache exists. |
| M6: slow provider bodies | Covered, bounded policy | A total provider deadline includes body reads; the shared reader caps responses at 4 MiB. There is no separate idle deadline. |
| M7: omitted embedding model identity | Boundary | Explicit mismatches fail; absent metadata is supported for provider compatibility. Identical model names do not prove unchanged weights. No model fingerprint or alias-resolution guarantee is made. |
| M8: supersession resurrection | Covered | Replacement, link, and state change commit atomically. Superseded is terminal; archiving/restoring cannot reactivate it. Raw history remains. |
| L1: English keyword search | Boundary | English stemming/stop words are explicit. There is no automatic language detection or synonym guarantee. |
| L2: one episode crowds result slots | Boundary | Several independently relevant facts from one episode may occupy slots. Per-episode diversification is not implemented or established as an accuracy improvement. |
| L3: unused importance | Covered | Salience participates in activation and lifecycle-adjusted priority, without changing raw similarity. Tests bound its effects. |

## Concepts and Contracts

Atomic **persistence** is the guarantee: raw source, complete prepared fragments,
vectors, links, receipt, and lifecycle effects commit together. Semantic extraction
is not proven by JSON validation. Causes, attribution, uncertainty, conditions,
and ambiguous references must not be silently discarded or invented. The causal
regression fixture checks known losses; it is not independent population evidence.

Lifecycle and direct relationships are implemented, not placeholders: active,
archived, terminal superseded, short/long-term tiers, explicit feedback, and
read-only decay are separate concepts. Neither retention nor retrieval establishes
truth. Shared recall is one trust domain; use separate deployments for untrusted
writers and verify recalled claims against current evidence before acting.

Bounded candidates/results do not bound exact-vector scan cost. Large-corpus
latency, high-degree relationships, longitudinal learning gains, and independent
semantic accuracy remain unproven. The [measured relevance gap](../gaps.d/recall-relevance-and-semantic-evaluation.md)
stays open. There is no new ANN engine, graph reasoner, evidence authority, or
mandatory chat stage disguised as a fix.

## Verification and Navigation

The integration PR must record `make ci` with a disposable `_test` database,
actual two-service startup, and the all-in-one smoke against its candidate image,
including a pinned published-image upgrade. The smoke checks exact old records,
new ranking metadata, and immutable keyed replay after container recreation.
Only successful checks on the exact combined revision satisfy those gates.

Behavioral coverage lives in [memory tests](../crates/mindleak-memory/src/tests.rs),
[storage tests](../tests/postgres.rs), [lifecycle tests](../tests/lifecycle.rs),
[MCP tests](../tests/mcp.rs), and the [container smoke](../scripts/container-smoke.mjs).
The four [architecture diagrams](ARCHITECTURE.md), [tool contract](INTEGRATION.md#tool-contract),
[lifecycle guide](LIFECYCLE.md), and [known limitations](KNOWN-LIMITATIONS.md)
describe the same source behavior. New source documentation does not upgrade an
installed binary or publish a release.
