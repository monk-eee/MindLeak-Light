import { randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const url = new URL(process.env.MINDLEAK_MCP_URL ?? "http://127.0.0.1:8088/mcp");
const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
if ((!local && url.protocol !== "https:") || url.username || url.password) {
  throw new Error("Remote MCP requires HTTPS; do not put credentials in the URL.");
}
const token = process.env.MINDLEAK_HTTP_TOKEN ?? (local
  ? "mindleak-light-development-token-not-for-production"
  : undefined);
if (!token) throw new Error("Set MINDLEAK_HTTP_TOKEN for your server.");

const agentId = process.env.MINDLEAK_AGENT_ID ?? `quickstart-${randomUUID()}`;
const client = new Client({ name: "mindleak-light-example", version: "1.0.0" });
const transport = new StreamableHTTPClientTransport(url, {
  requestInit: { headers: { Authorization: `Bearer ${token}` } },
});

try {
  await client.connect(transport);
  const { tools } = await client.listTools();
  for (const name of ["write_memory", "recall_memory", "decompose_memory"]) {
    if (!tools.some((tool) => tool.name === name)) throw new Error(`Missing MCP tool: ${name}`);
  }
  console.log(`Connected: ${tools.length} memory tools available.`);

  const written = await client.callTool({
    name: "write_memory",
    arguments: {
      agentId,
      text: "The user prefers pull requests under 500 LOC. The team requires reviews.",
    },
  });
  if (written.isError || !written.structuredContent?.memoryId) {
    throw new Error("Memory write failed. Check server status and any enabled model configuration.");
  }
  const memoryId = written.structuredContent.memoryId;
  console.log(`Saved memory: ${memoryId}`);

  const recalled = await client.callTool({
    name: "recall_memory",
    arguments: { query: "reviews", agentId, limit: 5 },
  });
  if (recalled.isError || !Array.isArray(recalled.structuredContent?.results)) {
    throw new Error("Memory recall failed.");
  }
  const fragments = recalled.structuredContent.results;
  if (!fragments.some((fragment) => fragment.memoryId === memoryId)) {
    throw new Error("The saved memory was not returned. Check the query and retrieval mode.");
  }
  console.log(`Recall verified: ${fragments.length} matching fragment(s).`);
} finally {
  await client.close();
}
