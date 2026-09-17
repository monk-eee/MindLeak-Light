# Architecture Decision Records

MindLeak Light carries over MindLeak's numbered ADR convention, using `adr.d/`
in this repository. Start new decisions from [the template](TEMPLATE.md).
Choose the next unused four-digit number and a descriptive kebab-case name.
CI rejects duplicate numbers. Parallel branches must resolve numbering collisions
before merge; do not treat a local next number as a reservation.

Generate this index with `node scripts/adr-index.mjs`. Check it with `--check`.
Accepted records are historical decisions; supersede them with a linked new
record when the design changes instead of silently rewriting their rationale.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-record-architecture-decisions.md) | Record Architecture Decisions | Accepted |
| [0002](0002-one-server-one-database.md) | One Server, One Database | Accepted |
| [0003](0003-atomic-decomposed-memory.md) | Atomic Decomposed Memory | Superseded by [ADR-0005](0005-optional-models-and-model-free-quickstart.md) |
| [0004](0004-repository-quality-and-releases.md) | Repository Quality and Releases | Accepted |
| [0005](0005-optional-models-and-model-free-quickstart.md) | Optional Models and Model-Free Quickstart | Accepted |
| [0006](0006-native-and-all-in-one-distribution.md) | Native and All-in-One Distribution | Accepted |
| [0007](0007-hybrid-recall-and-calibrated-relevance.md) | Hybrid Recall and Calibrated Relevance | Accepted |
| [0008](0008-bounded-model-relevance-selection.md) | Bounded Model Relevance Selection | Accepted |
| [0009](0009-fast-recall-and-optional-model-controls.md) | Fast Recall and Optional Model Controls | Accepted |
| [0010](0010-contextual-fact-lifecycle.md) | Contextual Fact Lifecycle | Accepted |
| [0011](0011-idempotent-memory-writes.md) | Idempotent Memory Writes | Accepted |
| [0012](0012-bounded-recall-context.md) | Bounded Recall Context | Accepted |
| [0013](0013-cancellation-and-recall-snapshots.md) | Cancellation and Final Recall Snapshots | Accepted |
| [0014](0014-bounded-evidence-inspection.md) | Bounded Evidence and Source Inspection | Accepted |
| [0015](0015-document-keyword-recall.md) | Document Keyword Recall and Bounded Context | Accepted |
| [0016](0016-release-regression-gates.md) | Released-Baseline Regression Gates | Accepted |
| [0017](0017-credential-free-local-access.md) | Credential-Free Local Access | Accepted |
| [0018](0018-project-memory-instructions.md) | Project Memory Instruction Installation | Accepted |
| [0019](0019-bounded-resumable-migrations.md) | Bounded Resumable Migrations | Accepted |
| [0020](0020-domain-relationships.md) | Indexed Domain Relationships and Verified Imports | Accepted |
| [0021](0021-encrypted-administrative-backups.md) | Encrypted Administrative Backups | Proposed |
