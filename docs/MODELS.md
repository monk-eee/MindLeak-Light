# Add a Model

The [quickstart](../README.md#quickstart) works without one. Models are recommended
when you want facts extracted from dense prose or recall based on meaning rather
than shared words. They are an upgrade, not a setup prerequisite.

MindLeak's optional models are separate from the model running your agent. You
can keep using Claude or GPT as your agent and use LM Studio for memory processing.

| Feature | Off, the Default | Optional Upgrade |
|---|---|---|
| Decomposition | Split sentences and list items; preserve wording | Chat model extracts independent facts |
| Recall | Indexed PostgreSQL keyword search | Embedding model with vector or hybrid recall |
| Relevance filtering | Return ranked candidates without a selection model | Chat model selects existing fragments that may answer the query |

Decomposition and embeddings are independent. Chat extraction with keyword recall is valid;
sentence decomposition with vector recall needs an embedding model but no chat
model. With relevance filtering off, enabling both normally adds one chat request
and one batched embedding request per write, and one embedding request per recall.
The optional relevance stage is independent and adds a recall-time chat request
when candidates are available.

## What Decomposition Guarantees

"Atomic" storage means the source text and its complete prepared fragment set
commit together or fail together. It does not guarantee that each fragment is
one faithful semantic fact. The default sentence/list path does not need a model
and preserves wording, but cannot resolve references or identify every claim.
Model extraction is an optional interpretation step, not a factual validator.

For example, `John approved the PR because Sarah requested it.` should not be
reduced to `John approved the PR.` and `Sarah requested the PR.` and called
equivalent. That drops the stated causal relationship and chooses what "it"
means without sufficient context. Preserve the original causal claim when its
reference is ambiguous. If the source identifies the request as approval, a
standalone claim can name that request explicitly without losing "because".

The extraction prompt requires causal, conditional, temporal, and attributed
relationships to survive. "After" does not establish "because"; "Tess reported"
must not silently become an unqualified assertion. Shorter fragments are not
automatically better. A related-fact link also does not reconstruct a missing
causal claim, and similarity never supplies missing evidence.

Use [semantic-dependency cases](../examples/fixtures/semantic-dependencies-v1.json)
with the separate extraction benchmark before enabling a model for your data.
Canonical wording tests catch specified losses; they do not prove arbitrary
paraphrase equivalence or general model accuracy. Keep source text, preview
important writes, and do not store speculative conclusions as established facts.

## Relevance and Hybrid Recall

For fast semantic recall, use vector or hybrid mode with relevance filtering
off. Each retriever caches at most 128 exact query embeddings in process memory;
repeated queries avoid the model call while PostgreSQL still reads fresh data.
New queries still incur embedding latency. Hybrid keyword lookup overlaps the
vector work. Optional chat extraction can improve write-time fact preparation
without adding a chat request to recall.

Hybrid recall and similarity thresholds require v0.2.0 or newer. For the
source Compose stack, rebuild with `docker compose up --build --detach --wait`
after upgrading source. See [installation](INSTALL.md) for package availability
and all-in-one container configuration.

`MINDLEAK_RETRIEVAL=hybrid` combines keyword and vector candidates by reciprocal
rank fusion. It keeps exact keyword matches, including memories written before
embeddings were enabled. It requires the same embedding settings as `vector`.
Neither mode alone adds a chat call to recall. A failed embedding request is an
error even if keyword results would have been available.

Set `MINDLEAK_RECALL_MIN_SIMILARITY` to a finite number in [-1, 1] to filter
semantic candidates. Unset or -1 preserves unfiltered nearest-neighbour recall;
an empty value passed directly to the binary is invalid when vector or hybrid
retrieval is enabled. Both Compose templates substitute -1 for unset or empty
values. The setting is ignored in keyword mode.
There is deliberately no universal cutoff: calibrate on representative positive
and negative queries using the [benchmark guide](BENCHMARKS.md), then evaluate
on held-out queries. Higher floors can reject useful facts too. The floor does
not gate keyword candidates in hybrid mode, including unembedded memories.

Hybrid scores are normalized fused ranks, not cosine scores. None of these
scores is a probability of relevance or truth. An empty successful recall means
no candidate met the configured retrieval rules, not that a fact is disproven.
Chat extraction remains an independent opt-in for messy prose; use the separate
extraction benchmark to test qualifiers and atomicity before enabling it.

## Experimental Relevance Filter

`MINDLEAK_RELEVANCE=openai` adds model-based selection after keyword, vector, or
hybrid retrieval. It is off by default and available from v0.2.0.
Its accuracy and latency are still being
evaluated, so enabling it is not a guarantee of better recall or correct answers.

For a Compose deployment, set:

```dotenv
MINDLEAK_RELEVANCE=openai
MINDLEAK_RELEVANCE_URL=http://host.docker.internal:1234/v1
MINDLEAK_RELEVANCE_MODEL=your-loaded-relevance-model-id
MINDLEAK_RELEVANCE_CANDIDATES=20
```

Use your provider's actual model ID and API base. Set
`MINDLEAK_RELEVANCE_API_KEY` privately if required; it is independent of the
decomposition and embedding credentials. Both Compose templates forward these
settings from the shell or `.env`. Recreate the container after changing them,
and use `localhost` instead of `host.docker.internal` for a native binary.

The provider receives the query and candidate text and must support structured
JSON chat responses. It identifies the requested detail and selects indices with
exact quotations from their source text. Invented quotations are rejected;
existing quotations do not automatically prove the fragment answers the question.
It never returns replacement memory text. Returned fragments
retain their original text, provenance, scores, and order. An empty selection is
valid. Provider failures or invalid selections fail recall rather than returning
unfiltered candidates. No selection request is made for an empty candidate list.

Version 0.4.0 also accepts directly useful negative evidence: explicit unknowns,
unapproved status, prohibitions, failed approaches, and missing prerequisites.
For example, "the rollout is not approved" is useful for a question asking its
approved date, without supplying or inventing a date. Mere topic overlap remains
irrelevant. Older releases use the earlier direct-answer policy. Use the
[versioned evidence fixture](../examples/fixtures/recall-evidence-v1.json) as a
regression check, not an independent quality estimate. Exact source inspection
by fragment ID bypasses this optional selector entirely.

The candidate setting defaults to 20 and accepts 1..50. A recall request for more
results raises the candidate count to at least that request's limit, still at
most 50. Query and candidate text together have a 32768-byte budget; exceeding
it returns an error, not silently truncated context. Keep candidates and queries
short, and reduce the candidate count for larger fragments.

Filtering can reject useful facts and cannot recover facts outside the candidate
pool. With vector or hybrid retrieval, a prior cosine floor can already have
removed useful candidates. Evaluate the combined settings on fresh held-out
queries; the model's selection is not independent verification of truth.

### Reasoning Controls

Compatible chat providers may accept `reasoning_effort`. The optional
`MINDLEAK_LLM_REASONING_EFFORT` and `MINDLEAK_RELEVANCE_REASONING_EFFORT` settings
independently accept `none`, `low`, `medium`, `high`, or `max`; unset/empty omits
the field. Disabled chat stages ignore their settings. Check your provider and
model support; unsupported requests fail without changing modes.

[Ollama documents these controls](https://docs.ollama.com/api/openai-compatibility).
Disabling thinking made the installed GLM much faster, but its relevance
accuracy deteriorated. Do not equate speed with quality or enable this setting
universally. Benchmark extraction and relevance independently. See
[recorded results](BENCHMARK-RESULTS.md) for successful and failed experiments.

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
dimension with numerically safe f32 norms. Unsupported responses produce an error, not guessed fragments or
fake vectors. No automatic model download, provider discovery, or silent fallback
is performed.

If an embedding response includes a non-null `model`, it must exactly match
`MINDLEAK_EMBED_MODEL`. Use the provider's canonical ID; aliases are not resolved
automatically. A disagreement fails the operation rather than mixing embedding
spaces. Providers that omit or return null model metadata remain supported, but
their actual model identity cannot be checked.

Chat, embedding, and relevance responses are each limited to **4 MiB
(4,194,304 bytes)**, including metadata. The limit is enforced while reading the
body, including chunked responses, before JSON parsing. Oversized responses fail
without saving partial memories or returning unfiltered recall results. Reducing
the request size or configuring the provider to omit excessive metadata may help;
increasing the model timeout does not change this byte limit.

## Existing Memories and Switching Modes

Changing to model-free mode keeps all existing memories and vectors. Keyword
search covers fragments whether or not they have embeddings. No model calls
are made with sentence decomposition, keyword retrieval, and relevance filtering off.

The first vector or hybrid start binds an embedding model and dimension to the
database. You can enable it after model-free writes, but **old unembedded
fragments are not automatically embedded**. Vector recall only searches fragments
with vectors. Use keyword or hybrid recall for those older entries; there is no
bulk re-embedding command yet.

Once bound, the embedding model and dimension cannot be changed in place. Use
the original model or a new database; do not delete stored memories just to
clear a configuration error. Keep model weights stable even if the provider
allows changing them under the same model ID.

To switch off all model use:

```dotenv
MINDLEAK_DECOMPOSITION=sentences
MINDLEAK_RETRIEVAL=keyword
MINDLEAK_RELEVANCE=off
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
Vector or hybrid recall with relevance filtering can also make two sequential
provider requests: query embedding, then candidate selection.
The server does not claim an inference-speed benchmark for your hardware.
