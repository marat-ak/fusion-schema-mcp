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
import { loadLayoutPatterns } from "./corpus/layoutStore.js";
import { ensureGrainRegistry } from "./corpus/grainRegistry.js";
import { ensureUsageGraph } from "./corpus/usageGraph.js";
import { ensurePredicateRegistry } from "./corpus/predicateMiner.js";

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
  // layout-pattern corpus: (re)load from the repo JSONL when its hash changed (non-fatal)
  void loadLayoutPatterns().catch((e) => console.error("[layout-corpus] load failed:", e?.message ?? e));
  // table-grain registry: build once from schema signals + corpus SQL (non-fatal)
  try { const g = ensureGrainRegistry(); console.error(`[grain] registry ${g.built ? "built" : "present"}: ${g.rows} multi-row tables`); }
  catch (e: any) { console.error("[grain] build failed:", e?.message ?? e); }
  // usage graph: reverse index table -> real queries that use it (table-anchored retrieval)
  try { const u = ensureUsageGraph(); console.error(`[usage] graph ${u.built ? "built" : "present"}: ${u.rows} usages over ${u.tables} tables`); }
  catch (e: any) { console.error("[usage] build failed:", e?.message ?? e); }
  // predicate rollup: most-used hardcoded filters per table (structural + discriminator)
  try { const p = ensurePredicateRegistry(); console.error(`[predicates] rollup ${p.built ? "built" : "present"}: ${p.rows} predicates over ${p.tables} tables`); }
  catch (e: any) { console.error("[predicates] build failed:", e?.message ?? e); }
  // warm the embedder at boot — otherwise the FIRST findSimilarQueries pays the ~30-50s model load
  void import("./corpus/embed.js")
    .then((m) => m.embed(["warm"]))
    .then(() => console.error("[embed] warm"))
    .catch((e) => console.error("[embed] warm failed:", e?.message ?? e));
  console.error(
    `[mcp] fusion-schema-mcp listening on http://${HOST}:${PORT}/mcp ` +
      `(tables=${s.tables} columns=${s.columns} fkeys=${s.fkeys} relationships=${s.relationships})`,
  );
});
