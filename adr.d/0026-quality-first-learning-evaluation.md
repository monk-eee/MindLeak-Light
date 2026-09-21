# ADR-0026: Quality-First Learning Evaluation

- Status: Accepted
- Date: 2026-09-21

## Context

MindLeak's primary goal is better agent outcomes and knowledge quality, not lower
latency or token usage. The Learning study `881c1dbe` passed all 135 coding checks,
but every arm reached the correctness ceiling and all three learning reviews
remained incomplete. Observed application and appropriate rejection are useful
mechanism evidence, but neither alone establishes better final outcomes.

[ADR-0025](0025-investigation-learning-protocol.md) introduced separate discovery,
validation and evaluation. Its mechanism profile leaves post-comparison revisions
unaccepted until fresh validation exists. A quality comparison needs those fresh
cases and an immutable original knowledge version for a matched comparison.

## Decision

Add an explicit Lab 3 `quality` profile, protocol v6, in the existing investigation
runner. Keep other profiles, fixtures, defaults and recorded results unchanged.
No core tool, table, worker, provider mode or authorization boundary changes.

- Use twelve disjoint constructed cases: two discovery, two initial validation,
  two exceptions, two fresh revision-validation, and four held-out evaluation.
- Preserve source observations from executed probes and exact inspected quotations.
  A failed capture never becomes evidence; explicit same-payload retries retain
  the request key. Missing initial knowledge makes the study incomplete.
- Form the initial principle from two separately constructed case chains. Verify
  prospective predictions and require explicit acceptance through existing MCP.
  Independently author and validate a notebook using the same source evidence.
- Give both authors the same bounded, source-verified formation packet with
  decision-only tools. Check the executable hypothesis's JavaScript syntax and
  named `collect` export before persistence without executing it or repairing it.
  Invalid formats may be corrected only within the existing authoring session;
  reserved validation remains the separate behavioral gate.
- Version the formation decisions independently. Each MindLeak case proposal,
  exact-ID/revision acceptance, and generalized principle proposal is a separate
  bounded decision. Successful acknowledged state completes that phase even if
  the model's generic final answer says otherwise. An error, missing operation or
  source-backed explicit refusal keeps it incomplete; nothing accepts automatically.
- Read back and archive the original accepted knowledge before exception review.
  This historical snapshot is labelled original, not represented as current after
  the active principle is challenged.
- Prepare bounded exception dossiers from executions of each arm's own unchanged
  hypothesis. Reviewers can explicitly retain a justified no-change outcome, or
  preserve measured counterexamples and propose a revision. A successful final
  answer alone is not a review decision. No automatic acceptance or revision quota.
- No-change decisions name individual exception cases and exact source quotations.
  Identical repeats return the earlier receipt; conflicting replacements fail.
  Every case needs a decision. A different decision cannot clear a failed write;
  unresolved persistence remains visible until that exact operation succeeds.
- Revised knowledge must predict and pass its applicable fresh reserved checks
  before explicit acceptance. Old validation cases cannot validate a new revision.
  Keep original validation history, source episodes and every counterexample.
- Compare fresh, independently authored notebook, original knowledge and reviewed
  MindLeak knowledge across the same four evaluation cases and model settings.
  Deliver the three knowledge briefs under the same 2,048-byte bound, without
  executable hypotheses or future-task repairs. Freeze all knowledge during the
  sixteen fresh evaluation sessions. No evaluation results enter revision work.
- Measure required behavior, boundary handling, regression safety and source-backed
  decisions separately. Appropriate rejection is not application. Boundary-rejection
  credit requires an executed failure of the supplied procedure on the same fixture,
  or a correctly diagnosed irrelevant task, followed by a passing current solution.
- Give evaluation agents the ordinary three public checks. After their session
  ends, copy the frozen candidate into a separate read-only sandbox for the
  complete eight-check quality audit. Additional audit code/results cannot enter
  that agent's file tools, test loop or subsequent edits. Retain both receipts.
- Keep scheduled denominators and explicitly unmeasured receipts. A bare success
  or failure claim cannot earn quality credit. Report gains, ties and regressions;
  do not predeclare a positive result or combine dimensions into a weighted score.

## Consequences

The comparison isolates the content of original versus reviewed knowledge using
matched delivery. It does not measure search quality, spontaneous adoption or
general population benefit. One synthetic family and scripted regression agents
cannot demonstrate real-model quality improvement.

The eight checks per task cover required records and nonterminal empty pages,
authoritative completion, consecutive empty pages, cursor cycles, case-sensitive
identity, unchanged source pages, and record order/duplicates. Exact source
quotations establish provenance, not semantic entailment of an authored claim.
The optional model-extraction attribution defect remains open and its held draft
stays excluded. Model/provider failure is not replaced with a silent fallback.

Costs remain secondary diagnostics. Actual run totals count each model session
once. Original knowledge is allocated initial authoring/validation, while reviewed
knowledge and notebook also include their own exception review and revalidation.
Current profiles remain available; historical studies are never rescored in place.

## Verification

- Red/green plan and routing regressions enforce separate arms, disjoint case sets,
  deterministic schedules, fresh-only runs and plan-only operation without services.
- Sandbox checks reject broken and obsolete procedures and verify the reference
  repairs against all eight checks, without exposing repairs to model agents.
- The end-to-end agent inspects its visible test file and cannot see the hidden
  audit. Public receipts contain three checks; final frozen-candidate receipts
  contain eight. Incomplete audits remain explicit study failures.
- Ledger regressions preserve original snapshots and counterevidence, reject exposed
  validation reuse, and require fresh predictions plus explicit revised acceptance.
- Real MCP/PostgreSQL/container regression executes the complete comparison with
  deterministic agents, verifies frozen knowledge, and preserves a failed-capture
  study with its unmeasured evaluation denominator.
- Capture/scoring regressions reject altered quotations, failed writes, fabricated
  receipt fields and a different fixture's probe. Successful capture reuses its
  acknowledged receipt; correct rejection remains distinct from application.
- Desktop/mobile browser checks use the actual deterministic report, verify all
  four arms and fresh validation rows, and reject missing-data credit, page errors,
  horizontal page overflow and continuation of exposed quality cases.
- Run the full repository and real-database gates before proposing publication.
  Report paid model results separately; never present the deterministic fixture's
  expected score difference as an observed real-agent improvement.
