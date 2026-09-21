- Status: Formation and review handoff defects resolved locally; full real-agent
  comparison remains unmeasured. Preserve the evidence below rather than treating
  the earlier failures as permanent product limitations or deleting their history.

## Bounded Real-Agent Trials

All trials used GPT-6 Astra, explicit sentence decomposition/keyword storage,
24 turns and 120 seconds per session, with a ten-minute overall study budget.
They used disposable data and left live settings and historical reports unchanged.

- `ef66e92d-bf4c-4090-919d-9a6a3e7ba408`: both discovery tasks passed; both authors
  inspected repeatedly and returned incomplete without candidates. A bounded,
  source-verified formation dossier and decision-only tools replaced that loop.
- `11dbae3f-2c3e-4e9f-8464-91a11ed3804c`: both authors produced candidates, but
  every reserved execution failed before completing its checks. The MindLeak
  hypothesis lacked the required named export; the notebook was invalid JavaScript.
  Explicit standalone-module instructions and pre-persistence syntax/export checks
  now reject these formats before reserved cases are consumed. No automatic repair.
- `767509f2-e61b-4903-a635-4db8e6994a6c`: the notebook formed, passed both reserved
  checks and published. MindLeak accepted its first case chain but left the second
  candidate unaccepted and ended with `completed: false`. No principle or evaluation
  followed. There were no failed formation tool calls. The precise model decision
  is not independently diagnosed by the action trace.

Those trials remain failed formation outcomes, not provider outages or proof that
knowledge revisions cannot help. Formation policy v2 now separates case proposal,
source-backed acceptance of an exact ID/revision, and principle proposal. No phase
accepts automatically; a missing decision or explicit refusal still stops progress.
The deterministic real-MCP regression reproduces a final `completed: false` after
an acknowledged proposal and verifies that a separate acceptance decision resolves
the pending state without replaying or duplicating the proposal.

Trial `eeda82d7-26ba-4916-8d57-5cbb73d20607` then completed all formation and
reserved-validation phases. It exposed a separate bug: a successful no-change
decision for one exception caused a decision for the second case to be refused
as a duplicate. Reviews now retain one receipt per case, return the same receipt
on an identical retry, and require complete case coverage with no unresolved write.
This has a deterministic real-storage regression, including a final completion
claim that disagrees with the already acknowledged decisions.

These changes do not resolve the separate held core extraction-attribution defect
or the GLM-backed review-write failures. Earlier failed trials are never relabelled.

## Verified Repair

Real-agent trial `c8ac5d72-f195-46bd-b13b-f5d4fd87244c` completed both case
proposals, both explicit acceptances, principle proposal and acceptance, both
authors' reserved validations, and both complete two-case no-change reviews.
Neither review had unresolved writes. No chain or principle was accepted by the
runner on behalf of the agent.

The study reached its predeclared ten-minute overall deadline during evaluation.
All four MindLeak tasks passed their eight-check audits, while the fresh,
notebook and original arms retained two, one and one unmeasured tasks respectively.
The run remains cancelled, not completed; those missing results are not failures
and cannot establish a comparative quality advantage. Both reviewers legitimately
retained the original knowledge, so this trial is not evidence of a beneficial
revision. The complete revised and no-change paths are covered by real-storage
deterministic regressions, including hidden audits and failure cases.

Reports, source identities, replay pages and safe summaries are retained under
the quality-learning worktree's ignored `target/quality-model-*` artifacts. No
provider response bodies or source observations belong in diagnostic logs.
