# Add a Model

The [quickstart](../README.md#quickstart) works without one. Models are recommended
when you want facts extracted from dense prose or recall based on meaning rather
than shared words. They are an upgrade, not a setup prerequisite.

MindLeak's optional models are separate from the model running your agent. You
can keep using Claude or GPT as your agent and use LM Studio for memory processing.

| Feature | Off, the Default | Optional Upgrade |
|---|---|---|
| Decomposition | Split sentences and list items; preserve wording | Chat model extracts independent facts |
| Recall | Indexed PostgreSQL keyword search | Embedding model and pgvector similarity |

Enable either independently. Chat extraction with keyword recall is valid;
sentence decomposition with vector recall needs an embedding model but no chat
model. Enabling both normally adds one chat request and one batched embedding
request per write, and one embedding request per recall.

## LM Studio

1. Open LM Studio's **Developer** tab and load a chat model that supports
   structured JSON output. For vector recall, also load an embedding model.
2. Start its local API server, normally on port `1234`. Copy the exact model IDs
   reported by LM Studio or its `GET /v1/models` endpoint.
3. Create a local `.env` from [.env.example](../.env.example), or edit your existing
   one. Enable the features you want using the settings below.

For chat-based fact extraction with the Compose server:

```dotenv
MINDLEAK_DECOMPOSITION=openai
MINDLEAK_LLM_URL=http://host.docker.internal:1234/v1
MINDLEAK_MODEL=your-loaded-chat-model-id
```

For semantic recall, add:

```dotenv
MINDLEAK_RETRIEVAL=vector
MINDLEAK_EMBED_URL=http://host.docker.internal:1234/v1
MINDLEAK_EMBED_MODEL=your-loaded-embedding-model-id
MINDLEAK_EMBED_DIMENSIONS=768
```

Replace both model IDs and use your embedding model's actual dimension; `768`
is an example, not a universal value. If LM Studio authentication is enabled,
set `MINDLEAK_LLM_API_KEY` and/or `MINDLEAK_EMBED_API_KEY` privately in `.env`.
Do not commit that file.

Apply the configuration:

```sh
docker compose up --detach --wait
```

Use `up`, not just `restart`, so Compose recreates the container with changed
environment values. Then call `decompose_memory` with a short paragraph. If
embeddings are enabled, test a write and recall as well. A healthy container
does not by itself prove either model can answer requests.

### Choose the Right Address

| Where MindLeak Runs | LM Studio API Base | Ollama API Base |
|---|---|---|
| Native binary on your host | `http://localhost:1234/v1` | `http://localhost:11434/v1` |
| Compose container | `http://host.docker.internal:1234/v1` | `http://host.docker.internal:11434/v1` |

Inside a container, `localhost` is the container, not your laptop. LM Studio
may need **Serve on Local Network** enabled to accept traffic from Docker or
Podman's VM. Use firewall rules and authentication so that making the endpoint
reachable does not expose an unprotected model server to your network.

The implementation uses LM Studio's documented
[structured-output format](https://lmstudio.ai/docs/developer/openai-compat/structured-output)
at `/v1/chat/completions` and its
[embeddings endpoint](https://lmstudio.ai/docs/developer/openai-compat/embeddings).
Not every loaded model supports structured output equally well.

## Ollama and Hosted Providers

The same `openai` mode accepts OpenAI-compatible providers; it does not mean you
must use OpenAI's hosted service. Set the API base, exact model ID, and optional
API key for your provider. For hosted OpenAI, the API base is
`https://api.openai.com/v1`. Keep API keys out of URLs.

Chat providers must support `response_format.type=json_schema` and non-streaming
chat completions. Embeddings must return indexed float vectors of the configured
dimension. Unsupported responses produce an error, not guessed fragments or
fake vectors. No automatic model download, provider discovery, or silent fallback
is performed.

## Existing Memories and Switching Modes

Changing to model-free mode keeps all existing memories and vectors. Keyword
search covers fragments whether or not they have embeddings. No model calls
are made when both optional features are disabled.

The first vector-enabled start binds an embedding model and dimension to the
database. You can enable it after model-free writes, but **old unembedded
fragments are not automatically embedded**. Vector recall only searches fragments
with vectors. Keep keyword recall if you need those older entries; there is no
bulk re-embedding command yet.

Once bound, the embedding model and dimension cannot be changed in place. Use
the original model or a new database; do not delete stored memories just to
clear a configuration error. Keep model weights stable even if the provider
allows changing them under the same model ID.

To switch off both features:

```dotenv
MINDLEAK_DECOMPOSITION=sentences
MINDLEAK_RETRIEVAL=keyword
```

Run `docker compose up --detach --wait` again. Disabled provider settings are
ignored. If an enabled provider goes down, operations needing it fail; they do
not secretly switch to model-free behavior.

## Responsiveness

Model-free requests avoid inference latency entirely. For an interactive agent,
keep stored memories short and recall a small number of fragments. With models,
prefer ones that fit your hardware and keep them loaded. The embedding client
sends one batch per memory rather than one request per fragment.

`MINDLEAK_MODEL_TIMEOUT_SECS` bounds each provider request (default 60, range
1..300). Increasing it can help a slow model, but makes a stalled operation take
longer to fail. Give the MCP client enough time for both write-stage requests.
The server does not claim an inference-speed benchmark for your hardware.
