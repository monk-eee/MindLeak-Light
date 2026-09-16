# Memory That Earns Persistence

Available from **v0.2.0**, this adds a biologically inspired lifecycle while keeping **pgvector**
for semantic search and PostgreSQL keyword search for the model-free quickstart.

## The Three Layers

| Layer | What It Means in Light |
|---|---|
| Working memory | The bounded set of facts returned for the current task; nothing is written by recall |
| Short-term memory | New facts attached to an immutable source episode and its context |
| Long-term memory | Facts explicitly retained or consolidated through spaced feedback, keeping the same IDs and vectors |

These are logical layers in the same database, not separate services. One episode
can contain a durable preference and a temporary observation. Retention is per fact.

## Save Context and a Lasting Preference

Call `write_memory` with:

```json
{
  "agentId": "review-agent",
  "text": "User prefers PRs under 500 LOC. The current build is running.",
  "context": {
    "scope": "project:light",
    "sessionId": "planning-2026-09-16",
    "source": "user conversation",
    "summary": "Pull request policy and current build status"
  },
  "facts": [
    {
      "text": "User prefers PRs under 500 LOC.",
      "tier": "long_term",
      "pinned": true,
      "importance": 0.9
    }
  ]
}
```

The response contains `memoryId` plus a `fragments` array of `fragmentId`, `text`,
and `tier`. The preference is pinned long-term; the build observation remains
short-term. Explicit retention is not confirmation: both initially have
`evidence: "unconfirmed"`.

The original text is stored exactly. Every fragment keeps its episode's context
and memoryId. Source references and summaries are caller-supplied data, not
instructions or authenticated evidence. Timestamps record receipt, not necessarily
the time an external event happened. Omitted context remains valid for quickstart.

`facts[].text` must match one decomposed fragment exactly, including punctuation
after whitespace normalization. A mismatch fails the whole write. With a model,
previewing via `decompose_memory` can help, but another extraction may differ;
Light never silently applies a policy to a different fact. Sentence mode preserves
wording, so writing one fact per sentence makes directives predictable.

## Reinforce or Confirm a Fact

After an actual use or confirmation, save a new evidence episode and link its
specific fragment to the original `fragmentId`:

```json
{
  "agentId": "review-agent",
  "text": "The user confirmed the pull request preference.",
  "context": {
    "scope": "project:light",
    "sessionId": "review-2026-09-17",
    "source": "user confirmation"
  },
  "facts": [
    {
      "text": "The user confirmed the pull request preference.",
      "links": [
        {
          "targetFragmentId": "REPLACE_WITH_THE_ORIGINAL_FRAGMENT_UUID",
          "relationshipType": "confirms"
        }
      ]
    }
  ]
}
```

Use `reinforces` for demonstrated usefulness without confirming accuracy. Use
`confirms` only when the human or agent actually obtained confirming evidence.
Reading a search result, repeating a query, or an LLM repeating its own summary
is neither. Keep one stable session ID for a task; do not create a new ID for
each retry to manufacture additional reinforcement.

## When Promotion Happens

An active, undisputed fact can become long-term when **new explicit feedback**
arrives and either condition is met:

- At least two distinct confirmation sessions.
- At least three distinct usefulness sessions.

In both cases, the first and latest feedback must be at least 24 hours apart.
Waiting after a burst of feedback does not satisfy that spacing. Repeating the
same target/type/session is a no-op for counters, timestamps, and promotion,
including concurrent calls from different agents. The additional raw feedback
episode is still saved for an unkeyed write. From v0.3.0,
replaying the same `requestId` returns the original receipt and
does not create another episode or reapply lifecycle actions. Feedback uniqueness
and whole-write retry safety are different guarantees; see
[retry-safe writes](INTEGRATION.md#retry-safe-writes).

These thresholds are conservative initial policies, not biological constants.
Usefulness-based promotion can leave evidence unconfirmed. A confirmed state
means somebody submitted a confirmation, not that the server independently proved
the statement. A contradiction makes the evidence disputed and blocks automatic
promotion; more confirmations do not silently clear a dispute.

## Relate, Correct, and Retire Facts

| Relationship Type | Meaning and Effect on the Target |
|---|---|
| `related` | Explicit association; no evidence or retention change |
| `supports` | Attributed supporting claim; no automatic confirmation |
| `contradicts` | Marks evidence disputed; does not choose which fact is true |
| `confirms` | Records confirmation once per session; may enable consolidation |
| `reinforces` | Records usefulness once per session, separately from evidence status |
| `supersedes` | New source fact replaces the target in normal recall; history remains |
| `archives` | Excludes the target from normal recall without deletion |
| `restores` | Reactivates an archived fact; cannot resurrect a superseded one |

Links run from a fact in the new episode to an existing target fragment ID.
Both episodes must have the same `context.scope`, including both being unscoped.
Similar vectors do **not** create evidence links. One source fact may link to up
to eight targets, with at most 128 links per write. Each target can receive only
one lifecycle-changing action in the write, avoiding contradictory transitions.

For a correction, write the corrected fact and a `supersedes` link to the old
fact using the same pattern as the confirmation example. The old fact, raw
episode, embedding, and links remain stored. The replacement begins with its own
retention and evidence settings, not inherited truth or popularity. Superseded
facts cannot be strengthened or reactivated; correct the current replacement.

For archival/restoration, the source fragment is the explanation for the action.
All changes commit with that episode. A missing target, invalid transition, or
cross-scope link fails the complete write.

## Recall With Context and History

```json
{
  "query": "pull requests",
  "scope": "project:light",
  "tier": "long_term",
  "limit": 5
}
```

Omit `tier` to search both tiers. Add `agentId` to filter provenance independently
from project scope. All filters are applied before the search candidate limit.
They are not access controls: this remains a shared-trust deployment.

Each result includes its original `score`, `activation`, `context`, and `lifecycle`
(tier, state, evidence status, pin, feedback counters, and timestamps), plus direct
`relationships` and a `relationshipCount`. At most eight related references are
included per result; the count reveals omitted links. Linked facts include their
own source context and state. Historical linked references can be shown as context
even though they are not active relevance matches. No recursive traversal occurs.

Version 0.3.0 additionally returns `rankingPriority` and
`relationshipsTruncated`. Priority is `score - abs(score) * 0.25 * (1 - activation)`;
results sort by that value, then fragment UUID. Do not resort by `score` unless
you deliberately want to ignore the lifecycle adjustment.

Related-context arrays share a 32 KiB serialized JSON budget across the returned
facts, rather than an independent budget for every result. Primary text/context
is reserved first; references are allocated round-robin and included whole.
The primary result array plus links must fit 512 KiB. If primary results alone
exceed that budget, the request fails with guidance to lower `limit`, without
truncating facts. JSON escaping counts toward both limits. These are payload
budgets, not token budgets or the size of the enclosing MCP response.

In v0.3.0, `relationshipCount` is the full eligible-link count. Version 0.4.0
bounds each owner's scan to 128 links plus lookahead and adds
`relationshipCountExact`. False means the reported count is a lower bound;
`relationshipsTruncated` covers both omitted references and unexamined links.
An empty array, even with count zero, does not establish no relationships when
the count is inexact. Check `relationshipCountExact` when upgrading from v0.3.0.

Version 0.4.0 orders explicit supersession, contradiction, archival, and restore
links ahead of support, confirmation, reinforcement, and general association.
That preserves corrective evidence before repeated confirmation history without
deciding which claim is true. Each category uses related UUID and direction for
stable pagination, not an invented authority or confidence score.

Use [source inspection](INTEGRATION.md#inspect-original-sources) through
`recall_memory.fragmentId` to read the exact raw episode and all direct evidence
in bounded pages. Continue with `after: nextCursor` until null, including after
empty filtered pages. The source is historical data, not a set of active claims.

Set `includeInactive: true` to inspect archived or superseded matches explicitly.
That does not reactivate them. A normal recall never mutates facts, counters, or
evidence. The calling agent chooses which facts belong in its working context.

## Forgetting Means Reduced Accessibility

Short-term activation has a seven-day half-life; long-term has a ninety-day
half-life, measured from creation or the last qualifying feedback. Importance
sets salience in the range 0..1 (default 0.5). A pin makes activation constant
while active. Neither long-term status nor a pin overrides archive/supersession.

pgvector still returns semantic candidates using cosine distance. Keyword and
hybrid paths remain available. Within a bounded candidate pool, lower activation
can discount ranking priority by at most 25% of the score's magnitude. The original
score is returned unchanged, separately from activation. This policy favors
recently useful facts without turning retention into similarity or confidence.

Old memories are not automatically deleted or hard-hidden by age. Activation is
computed at read time; there is no decay worker, scheduled replay, or mandatory
LLM. This models some memory processes, not a brain. Temporal recall quality and
better promotion policies still require real longitudinal evaluation.

## Trust and Disagreements

All authorized writers share one trust domain. The service has no per-agent
authority hierarchy and does not determine which conflicting assertion is true.
`agentId`, scope, source, and session IDs are caller claims, not permissions or
independent proof. Long-term retention and importance are not truth confidence.
The existing `confirmed` evidence label means a confirmation was reported.

An agent that finds a disagreement should inspect the exact source and scope,
record a `contradicts` link for conflicting evidence, and seek independent
verification. To quarantine suspect material, record an explanatory `archives`
link; normal recall excludes it while history remains inspectable. Use `restores`
only for an archived fact after review, or write a verified replacement with
`supersedes`. A textual correction without the link does not retire the target.
Superseded facts cannot be revived by archive/restore.

These controls make relationships actionable without automatically inventing
evidence. They do not protect against a malicious client already authorized to
write to the same service. Separate trust domains require separate protected
deployments or authentication/authorization outside this tool contract.
