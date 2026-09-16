# MindLeak Light

Shared agent memory. One MCP server. One PostgreSQL database.

Raw memory becomes independent fact fragments, each with an embedding and a
link back to its source. Recall retrieves fragments using pgvector; the calling
agent synthesizes the answer. No RAST, graph reasoning, event bus, or orchestration.

## Run

Requires Docker Compose (or Podman Compose) and an existing OpenAI-compatible
chat and embedding endpoint. Defaults use Ollama on the host with `glm4:9b`
and `nomic-embed-text` (768 dimensions). Install those models separately; the
server never downloads models or silently substitutes another one.

```sh
cp .env.example .env
docker compose up -d --build
```

The shared endpoint is `http://127.0.0.1:8088/mcp`. Send
`Authorization: Bearer <MINDLEAK_HTTP_TOKEN>` on every HTTP request.
The default token and database password are local-development values only.
`/health` checks database connectivity, not model readiness. Containers are
healthy even if the model endpoint is unavailable; memory tools then fail clearly.

For a native stdio server, install Rust through rustup, start only the database,
and use the supplied [VS Code MCP configuration](.vscode/mcp.json):

```sh
docker compose up -d postgres
cargo run --locked -p mindleak-mcp --bin mindleak-light -- --transport stdio
```

Logs go to stderr. Do not launch a stdio server in a terminal expecting a chat
interface: the MCP client sends its requests over stdin. Multiple stdio clients
can share this database; HTTP lets them share one server process as well.

## Tools

| Tool | Input | Result |
|---|---|---|
| `write_memory` | `{"agentId":"claude","text":"User prefers PRs under 500 LOC"}` | `{"memoryId":"<uuid>"}` |
| `recall_memory` | `{"query":"PR preferences?","limit":10}` | Array of fragments with `memoryId`, `fragmentId`, `agentId`, `score`, `text` |
| `decompose_memory` | `{"text":"The user dislikes huge PRs. The team requires reviews."}` | Array of independent fact strings; preview only |

`write_memory` always decomposes, embeds, and persists the fragments. It returns
only after the raw text and every fragment/vector commit together. A model or
database failure leaves no partial memory. Previewing decomposition does not
store anything.

Recall's optional `agentId` filters provenance; omit it for shared recall.
Scores are cosine similarity in `[-1, 1]`, not probabilities. Results are
fragment-level, so a memory can appear more than once. Importance is stored
with default 0.5 but does not alter ranking. Relationships accept `supports`,
`contradicts`, and `related`; none are inferred automatically.

MCP text content contains the JSON shown above. For client compatibility,
`structuredContent` contains the write object or `{"results":[...]}` for arrays.

## Repository

```text
crates/
  mindleak-mcp/                One deployable: mindleak-light
  mindleak-memory/             Memory API and replaceable MemoryRetriever
  mindleak-storage-postgres/   Three-table schema, transactions, vector search
  mindleak-decomposition/      Atomic-fact extraction
  mindleak-embeddings/         OpenAI-compatible embeddings
docker/                       Container build
tests/                        Real PostgreSQL and MCP integration tests
adr.d/                        Numbered decisions and generated index
changelog.d/                  Per-change release notes
gaps.d/                       Actionable outstanding defects
scripts/                      Repository checks and release tooling
.github/                      CI, release, security, and review configuration
```

The layout, dependency choices, model configuration, pool design, ADR process,
changelog fragments, and quality gates are adapted from the sibling MindLeak.
There are no runtime or path dependencies on that repository.

Read [DEVELOPERS.md](DEVELOPERS.md), [AGENTS.md](AGENTS.md),
[architecture](docs/ARCHITECTURE.md), [security](SECURITY.md), and
[known limitations](docs/KNOWN-LIMITATIONS.md).
