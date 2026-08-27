import type { FastifyInstance } from "fastify";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { registerAllTools } from "../../tools/index.js";
import { SERVER_CONFIG } from "../../config/server.js";

export async function registerMcpRoutes(app: FastifyInstance) {
  app.post("/mcp", async (req, reply) => {
    reply.hijack();
    const server = new McpServer(SERVER_CONFIG);
    registerAllTools(server as any);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try { await transport.handleRequest(req.raw, reply.raw, req.body as any); } catch (e) { console.error("mcp POST error", e); if (!reply.raw.headersSent) reply.raw.writeHead(500).end(String(e)); }
  });
  app.get("/mcp", async (req, reply) => {
    reply.hijack();
    const server = new McpServer(SERVER_CONFIG);
    registerAllTools(server as any);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try { await transport.handleRequest(req.raw, reply.raw); } catch (e) { console.error("mcp GET error", e); if (!reply.raw.headersSent) reply.raw.writeHead(500).end(String(e)); }
  });
  app.delete("/mcp", async (req, reply) => {
    reply.hijack();
    const server = new McpServer(SERVER_CONFIG);
    registerAllTools(server as any);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    await server.connect(transport);
    try { await transport.handleRequest(req.raw, reply.raw); } catch (e) { console.error("mcp DELETE error", e); if (!reply.raw.headersSent) reply.raw.writeHead(500).end(String(e)); }
  });
}
