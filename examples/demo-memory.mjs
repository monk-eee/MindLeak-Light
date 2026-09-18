import { createServer } from "node:http";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export async function openMemoryUsageObserver({ endpoint, model, apiKey = "", timeoutMs = 240000, onEvent = () => {} }) {
  const upstream = new URL(endpoint);
  if (!["http:", "https:"].includes(upstream.protocol) || upstream.username || upstream.password || upstream.search || upstream.hash
    || upstream.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname)
    || typeof model !== "string" || !model.trim() || model.length > 256 || !Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300000) {
    throw new Error("invalid_memory_observer_configuration");
  }
  const token = randomBytes(32).toString("hex");
  const target = new URL(`${upstream.href.replace(/\/$/, "")}/chat/completions`);
  const pending = new Set();
  let address;
  const server = createServer(async (request, response) => {
    const supplied = Buffer.from(request.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${token}`);
    const reject = (status, code) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: code })); };
    if (request.method !== "POST" || request.url !== "/v1/chat/completions" || request.headers.host !== address
      || request.headers.origin || request.headers.forwarded || request.headers["x-forwarded-for"]
      || supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) { reject(403, "private_memory_observer"); return; }
    const controller = new AbortController();
    pending.add(controller);
    response.once("close", () => { if (!response.writableEnded) controller.abort(); });
    let started;
    const requestId = randomUUID();
    let emitted = false;
    const emit = (type, data) => onEvent({ type, agent: "memory", workload: "memory", modelClass: "slm", model,
      sessionId: "memory-processing", requestId, turn: requestId, phase: "decomposition", ...data });
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of request) {
        size += chunk.length;
        if (size > 512 * 1024) { reject(413, "memory_request_budget"); return; }
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      const payload = JSON.parse(body);
      if (payload.model !== model || payload.stream === true) { reject(400, "fixed_memory_model_required"); return; }
      started = performance.now();
      emit("inference_started", { startedMs: 0, requestBytes: body.length });
      const result = await fetch(target, { method: "POST", redirect: "error", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]),
        headers: { "content-type": "application/json", ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) }, body });
      const received = [];
      size = 0;
      if (Number(result.headers.get("content-length")) > 4 * 1024 * 1024) { await result.body?.cancel(); throw new Error("memory_response_budget"); }
      if (result.body) for await (const chunk of result.body) {
        size += chunk.length;
        if (size > 4 * 1024 * 1024) { controller.abort(); throw new Error("memory_response_budget"); }
        received.push(chunk);
      }
      const bytes = Buffer.concat(received);
      let data;
      try { data = JSON.parse(bytes); } catch { data = null; }
      const value = count => Number.isSafeInteger(count) && count >= 0 ? count : null;
      const finish = data?.choices?.[0]?.finish_reason;
      emit("inference_finished", { startedMs: 0, elapsedMs: performance.now() - started, httpStatus: result.status,
        inputTokens: value(data?.usage?.prompt_tokens), outputTokens: value(data?.usage?.completion_tokens),
        finishReason: ["stop", "length", "tool_calls", "content_filter"].includes(finish) ? finish : result.ok ? "unknown" : "error",
        ...(result.ok ? {} : { errorCode: "memory_provider_http_error" }), responseBytes: bytes.length });
      emitted = true;
      response.writeHead(result.status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(bytes);
    } catch {
      if (started !== undefined && !emitted) emit("inference_finished", { startedMs: 0, elapsedMs: performance.now() - started,
        inputTokens: null, outputTokens: null, finishReason: "error", errorCode: controller.signal.aborted ? "cancelled" : "memory_provider_failed" });
      if (!response.headersSent && !response.destroyed) reject(502, "memory_provider_failed");
    } finally { pending.delete(controller); }
  });
  server.requestTimeout = timeoutMs + 15000;
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { server.removeListener("error", reject); resolve(); }); });
  address = `127.0.0.1:${server.address().port}`;
  return { endpoint: `http://${address}/v1`, apiKey: token, async close() {
    for (const controller of pending) controller.abort();
    server.closeIdleConnections();
    await new Promise(resolve => server.close(resolve));
  } };
}
