# Why MindLeak

## Agents Don't Need More Memory. They Need To Learn.

Most AI memory systems focus on storing more information.
MindLeak asks a different question: **What if agents could actually learn?**

MindLeak transforms agent observations into evidence-backed Chains of Memory and
higher-level Principles that future agents can reuse. Instead of accumulating
endless memories, MindLeak accumulates knowledge.

One agent discovers. MindLeak learns. Future agents inherit the knowledge.

We're not building agent memory. We're building knowledge formation for agents.

## What Learning Means Here

A frontier model may already solve the task without saved context. The product
question is whether experience helps a later agent choose, verify, or revise a
better approach. Learning here means durable, revisable knowledge available to
agents, not training the underlying model's weights.

| Level | Product Meaning | Required Evidence |
|---|---|---|
| Observation | A recorded experience, including a failure or exception | Exact source, conditions, outcome, contributor and actual verification |
| Chain of Memory | A justified, conditional belief | Claim, source references, concise rationale, conclusion, applicability, assumptions, counterevidence and validation history |
| Principle | Reusable expertise across supported cases | Multiple current validated chain revisions, their source lineage and justified common conditions |

An observation is evidence, not established knowledge. A candidate chain is not
an accepted belief. An accepted principle is not proof of successful transfer.
Two chains citing one episode are not independent corroboration. Reported
confidence, such as 0.91, needs its method; it is not a measured truth probability.

Agents author and validate knowledge through the existing MCP tools. Optional
models assist formation; they do not decide acceptance. New evidence can challenge
a chain, invalidate a principle's pinned support, or narrow its applicability.
History and counterexamples survive revision. Recall itself never teaches the store.

## Knowledge Density

The aim is more reusable expertise per unit of experience, not more stored notes.
The illustrative progression of 100,000 observations to 5,000 chains to 200
principles expresses that aim; it is not a benchmark, target quota, or measured
compression ratio. Source observations are preserved, not deleted to improve a count.

Measure supported knowledge, distinct source episodes, later verified reuse,
generalization and appropriate rejection separately. A smaller record count can
also mean lost conditions. A larger knowledge inventory can coexist with no
performance advantage. Neither is a success criterion on its own.

## Shared Learning

Agent A records a discovery and its evidence. An agent explicitly forms and
validates the chain. Agent B retrieves its applicable conclusion without inheriting
A's conversation. Agent C can inspect its history and avoid a known failed approach.
Each new outcome may strengthen the evidence, reveal an exception, or add nothing.
No new reusable evidence means no new write or revision.

The goal is that every future agent benefits. Demonstrating that goal requires
matched tasks, observed knowledge delivery before action, complete correctness
checks, and independent held-out evaluation. Memory access alone is not benefit.
The [learning labs](docs/VALIDATION.md) separate discovery, formation, and reuse;
the [results](docs/BENCHMARK-RESULTS.md) retain negative and inconclusive outcomes.

## A Small Operational Foundation

One Rust executable, three MCP tools, and three PostgreSQL tables serve the whole
workflow. PostgreSQL supplies durability, keyword search, and optional pgvector.
Agent-authored chains need no server-side model. Existing observation-only calls,
package names and deployment commands stay compatible; `mindleak-light` remains
the executable and image name, while MindLeak is the product.

This is not the sibling MindLeak coordination runtime. There is no worker,
recursive graph engine, autonomous acceptance loop, or client-specific extension.
See [the architecture](docs/ARCHITECTURE.md), [knowledge contract](docs/CHAINS.md),
and [product decision](adr.d/0024-knowledge-formation-product.md).
