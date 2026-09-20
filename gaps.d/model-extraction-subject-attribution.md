- Optional model decomposition in `crates/mindleak-decomposition/src/lib.rs`
  can reassign a caller's side effects to the function it calls. In Lab 1 run
  `fc96bd63-a1b5-4673-995e-1ab681c7c2d1` (2026-09-18), GLM 4.7 Flash extracted
  claims that `parseSessionInput` clears input fields and adds sessions from a
  source note describing those actions in `mount`. The retained original source
  and generated modules were compared directly: validation returns a result;
  integration performs the UI/store mutations. The six sources produced 142
  fragments, but fragment count is not semantic fidelity.

Original text remains intact, and startup source inspection limits reliance on
the derived claims; it does not fix extraction or establish their truth. A fix
needs a source-grounded caller/callee attribution regression and real-provider
evaluation retaining both accurate and inaccurate outcomes. Do not overwrite
the historical run or silently fall back to sentence splitting when a configured
provider fails. Structured-response validation alone cannot prove entailment.

## Held Experiment: 2026-09-18

The same defect was observed in run `9d917897-89c8-4dc4-88c5-bb578f9bbe77`:
a derived fragment attributed the renderer's `expired` text to the numeric
`remainingSeconds` helper. A prompt-only candidate still changed ownership and
omitted an alternative in the preserved source. Stronger instructions alone
were therefore not accepted as a fix.

An isolated core draft tested exact quoted support, then bounded source-passage
references and explicit subjects. Invalid grounding failed before persistence.
The final draft allowed one repair with complete, source-private validation
feedback; malformed JSON, provider errors and truncation still failed directly.
In five real GLM 4.7 Flash cases, four completed but the original rendering note
still failed after both calls, taking 83.2 seconds. Passing parser tests did not
establish usable extraction for that normal handoff.

The operator explicitly chose **hold core; deploy the verified lab fixes**.
Production extraction code and its public contract remain unchanged. The unready
draft, tests and every successful/failed trial are retained locally under ignored
`target/core-grounding-draft-815adf60.patch` and
`target/extraction-fidelity-check-*.json`; the final trial is
`70b8048e-725e-4d67-a1f2-6eb611bc3a68`. None of these experiments changed the
original observations or historical run reports. Revisit the extraction design
or model with a frozen fidelity set before deploying the draft; do not add
unbounded retries or relabel refusal as successful extraction.
