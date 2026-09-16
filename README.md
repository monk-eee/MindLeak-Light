<p align="center">
  <img src="assets/mindleak_logo.png" alt="MindLeak logo" width="420">
</p>

# MindLeak Light

<p align="center">
  <a href="https://github.com/monk-eee/MindLeak-Light/actions/workflows/ci.yml"><img src="https://github.com/monk-eee/MindLeak-Light/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/monk-eee/MindLeak-Light/actions/workflows/security.yml"><img src="https://github.com/monk-eee/MindLeak-Light/actions/workflows/security.yml/badge.svg" alt="Dependency security"></a>
  <a href="https://github.com/monk-eee/MindLeak-Light/actions/workflows/release.yml"><img src="https://github.com/monk-eee/MindLeak-Light/actions/workflows/release.yml/badge.svg" alt="Release"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT"></a>
  <img src="https://img.shields.io/badge/rust-1.88%2B-orange.svg" alt="Rust 1.88+">
  <img src="https://img.shields.io/badge/protocol-MCP-8A2BE2.svg" alt="Model Context Protocol">
  <img src="https://img.shields.io/badge/storage-PostgreSQL%20%2B%20pgvector-336791.svg" alt="PostgreSQL with pgvector">
</p>

**Shared agent memory. One MCP server. One PostgreSQL database.**

[Quickstart](#quickstart) | [Binary and container installs](docs/INSTALL.md) | [Connect your agent](docs/INTEGRATION.md) | [Add a model](docs/MODELS.md)

Give your agents somewhere to remember preferences, decisions, and confirmed
facts between sessions. Connect over MCP, save a memory, and recall it later
from the same agent or another one. Keep your existing agent framework and model.

**Models are recommended, not required.** Start with sentence/list fragments and
keyword search, with no model calls. Add LM Studio, Ollama, or another
OpenAI-compatible provider for richer fact extraction and semantic recall.

Prefer a download to a source build? Native archives plug into MCP over stdio.
The all-in-one container bundles the server and PostgreSQL. See
[installation options](docs/INSTALL.md) for current release availability,
connection templates, persistent volumes, and local image builds.

## Quickstart

You need Git and Docker with Compose, or Podman with Compose. No Rust toolchain,
API key, or model download is needed for this path.

```sh
git clone https://github.com/monk-eee/MindLeak-Light.git
cd MindLeak-Light
docker compose up --build --detach --wait
```

With Podman, replace `docker compose` with `podman compose`. The first build
downloads dependencies and can take a few minutes. Later starts reuse the image.
No `.env` file is necessary unless you want to change settings.

The MCP endpoint is **`http://127.0.0.1:8088/mcp`**. It is an API, not a web UI.
The quickstart binds to your machine only and uses public development credentials.
See [security](SECURITY.md) before sharing it over a network.

## Connect Your Agent

For **VS Code / GitHub Copilot**, this repo already includes
[.vscode/mcp.json](.vscode/mcp.json). Open the folder, run **MCP: List Servers**,
select **mindleak-light**, and start it. Review the trust prompt if shown and
enable its three tools in chat.

To use it from your own project's VS Code workspace, add this entry to its
`.vscode/mcp.json`, preserving any existing servers:

```json
{
  "servers": {
    "mindleak-light": {
      "type": "http",
      "url": "http://127.0.0.1:8088/mcp",
      "headers": {
        "Authorization": "Bearer mindleak-light-development-token-not-for-production"
      }
    }
  }
}
```

For **Claude Code**, other MCP clients, or your own application, see
[Connect Your Agent](docs/INTEGRATION.md). A [runnable JavaScript example](examples/agent-memory.mjs)
uses the official MCP SDK and needs no agent model to verify storage and recall.

## Try It

Ask your connected agent:

> Use MindLeak Light to remember this with agentId "quickstart": The user prefers
> pull requests under 500 LOC. The team requires reviews.

Look for a successful `write_memory` call with a `memoryId`. Then start a new
chat with the server connected and ask:

> Use MindLeak Light to recall "reviews" for agentId "quickstart".

You should get the review fragment with the saved memory's ID. In default keyword
mode, use short terms such as `reviews` or `pull requests`, not a long question.
Your agent may require approval before making tool calls.

## Add Models When Ready

| Setup | Decomposition | Recall |
|---|---|---|
| Quickstart, no models | Sentences and list items, wording preserved | Indexed keyword search |
| Optional chat model | Independent facts extracted from prose | Keyword search still available |
| Optional embedding model | Either decomposition mode | Semantic vector or hybrid keyword/vector search |

Chat extraction and embeddings are independent options. Add embeddings for
natural-language recall; enable chat extraction when sentence/list splitting is
insufficient. Each adds inference time and needs a working provider.
[Set up LM Studio or another provider](docs/MODELS.md).

Existing memories stay stored when switching modes. Hybrid recall can include
older unembedded memories through keyword search; vector-only recall cannot.
Semantic search returns nearest neighbours by default, even for unrelated
queries. An optional similarity threshold filters semantic candidates, but needs
calibration on your data and does not filter hybrid's keyword matches.

Hybrid recall and similarity thresholds are **unreleased** and require a source
build containing these changes; they are not included in v0.1.0 downloads.

## Documentation

| I Want To... | Start Here |
|---|---|
| Install a pluggable binary or an all-in-one container | [Installation](docs/INSTALL.md) |
| Connect an agent, understand the tools, or troubleshoot | [Agent integration](docs/INTEGRATION.md) |
| Add LM Studio, Ollama, or hosted models | [Optional models](docs/MODELS.md) |
| Measure recall quality and compare configurations | [Benchmark guide](docs/BENCHMARKS.md), [measured results and limits](docs/BENCHMARK-RESULTS.md) |
| Build, test, or contribute | [Developer guide](DEVELOPERS.md) |
| Understand storage and design decisions | [Architecture](docs/ARCHITECTURE.md), [ADRs](adr.d/README.md) |
| Deploy beyond my laptop | [Security](SECURITY.md), [limitations](docs/KNOWN-LIMITATIONS.md) |
| See what's changed | [Changelog](CHANGELOG.md), [unreleased notes](changelog.d/README.md) |

Stop the stack with `docker compose down`; the database volume is retained.
Do not add `--volumes` unless you intend to delete your memories.

Built from [MindLeak](https://github.com/monk-eee/MindLeak)'s Rust and repository
conventions, without its coordination runtime. The original
[logo](assets/mindleak_logo.png) and [icon](assets/mindleak_128x128.png) are included
in release archives.
