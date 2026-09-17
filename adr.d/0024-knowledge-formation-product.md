# ADR-0024: Knowledge Formation as the Product

- Status: Accepted
- Date: 2026-09-18

## Context

The product pitch has changed from shared agent memory to knowledge formation
for agents. ADR-0022 already supplies observations, evidence-backed chains,
principles, revisions and explicit acceptance. ADR-0023 supplies compact learning
context and capability discovery. Product, onboarding and lab presentation still
foreground storage, extraction, and weighted inventory/reuse scores.

## Decision

Present MindLeak as a system that transforms experience into reusable knowledge.
Organize the product, design, agent policy and labs around observation, formation,
validation, generalization, reuse and revision. The product name is MindLeak;
existing repository, binary, image, tool, crate and skill identifiers stay unchanged.

Installing the updated learning policy explicitly selects knowledge formation on
a capable approved server. Prefer knowledge search when prior experience is useful;
inspect conditions and current support before applying a conclusion. Preserve
observations and record new evidence, not routine notes or revision quotas.
Models remain optional. Unsupported capabilities are reported, never simulated.

Keep ADR-0022/0023's runtime boundaries: exactly three tools and tables, ordinary
call defaults unchanged, agent-authored candidates, explicit attributed validation,
bounded source lineage, immutable revisions, and no read-time reinforcement.
No background learner, automatic acceptance, model fine-tuning, or global client
configuration is introduced by this product change.

Lab 1 covers discovery; Lab 2 covers knowledge formation; Lab 3 covers later reuse.
Lead with source observations and recorded accepted chains/principles whose source
references and supporting revisions are available. Candidates and review-required
records are separate. Keep the existing weighted reuse index as a secondary,
versioned diagnostic, never as measured intelligence or compounding benefit.

Require distinct source accounting without treating different IDs as independence.
Preserve original reports, frozen tasks, baseline arms, contrary evidence, failures,
and zero/no-use results. Record formation integrity, observed later use, and
comparative improvement separately. Numerical compression examples are explicitly
illustrative, not measured ratios or deletion targets.

## Consequences

The product's first experience and contributor priorities now match its knowledge
contracts. The operational memory engine and compatibility tests remain necessary
foundations. Selecting this policy is not a permission grant or proof of automatic
client behavior. Source preservation may grow storage even as reusable knowledge
becomes more concise. More accepted records do not imply a better agent.

The thesis that future agents improve remains an evaluation goal. Existing
synthetic diagnostic results are not relabeled as successful transfer or causal
benefit. Full held-out agent evaluation and production scale remain separately
tracked work, not consequences inferred from repositioning.

## Verification

- Focused onboarding tests require the hierarchy before setup and exact policy parity.
- Lab projection tests reject candidates, unknown sources and stale/duplicate supports;
  repeated receipts do not inflate observation or knowledge counts.
- Existing rendered-page, replay, privacy, sandbox and route-isolation tests remain.
- Existing fresh-session MCP knowledge recipes verify proposal, acceptance, revision,
  counterevidence, source inspection and provider-free authoring.
- Existing frozen recall and database integrity gates remain unchanged; run `make ci`
  with an owned disposable `_test` database before proposing a merge.
- Browser checks cover desktop/mobile hierarchy, navigation and source inspection;
  tests and replays do not stand in for new real-agent improvement measurements.
