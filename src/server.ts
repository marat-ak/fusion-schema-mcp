/**
 * HTTP MCP server (Streamable HTTP transport, stateless).
 * Endpoint: POST /mcp   Health: GET /health
 * Env: MCP_PORT (default 8979), MCP_HOST (default 0.0.0.0)
 */
import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { buildServer } from "./tools.js";
import { stats } from "./catalog.js";
import { createIngestRouter, ingestAuthWarning, startIngestScheduler } from "./ingest.js";

const PORT = Number(process.env.MCP_PORT ?? 8979);
const HOST = process.env.MCP_HOST ?? "0.0.0.0";

const app = express();

app.get("/health", (_req, res) => {
  res.json({ status: "ok", catalog: stats() });
});

// Runtime corpus ingest API (own body parsers per route so large uploads aren't capped here).
app.use(createIngestRouter());

// MCP transport gets its own JSON parser (kept small — MCP requests are tiny).
app.use("/mcp", express.json({ limit: "4mb" }));

// Stateless: a fresh server + transport per request (no session persistence needed).
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("[mcp] request error", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// Stateless transport does not use GET (SSE) / DELETE sessions.
const methodNotAllowed = (_req: express.Request, res: express.Response) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (stateless server)." },
    id: null,
  });
};
app.get("/mcp", methodNotAllowed);
app.delete("/mcp", methodNotAllowed);

app.listen(PORT, HOST, () => {
  const s = stats();
  ingestAuthWarning();
  startIngestScheduler();
  console.error(
    `[mcp] fusion-schema-mcp listening on http://${HOST}:${PORT}/mcp ` +
      `(tables=${s.tables} columns=${s.columns} fkeys=${s.fkeys} relationships=${s.relationships})`,
  );
});
