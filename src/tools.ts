/** Registers the 7 grounding tools on an McpServer instance. */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as catalog from "./catalog.js";

const DEBUG = process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";

function reply(name: string, args: unknown, data: unknown) {
  if (DEBUG) {
    console.error(`[mcp>] ${name} ${JSON.stringify(args)}`);
    console.error(`[mcp<] ${name} ${JSON.stringify(data).slice(0, 2000)}`);
  }
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function buildServer(): McpServer {
  const server = new McpServer({
    name: "fusion-schema-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "searchTables",
    {
      title: "Search tables/views by description",
      description:
        "Full-text search over Fusion table/view names, descriptions (REMARKS), and module. " +
        "Use when you do NOT already know the exact object name. Returns ranked matches.",
      inputSchema: {
        query: z.string().describe("Natural-language keywords, e.g. 'supplier invoice'"),
        limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, limit }) => reply("searchTables", { query, limit }, catalog.searchTables(query, limit ?? 20)),
  );

  server.registerTool(
    "getTable",
    {
      title: "Get table/view metadata",
      description:
        "Metadata for one table/view: type, module, description, primary key, column count. " +
        "Returns null if the object does not exist (use validateTable for suggestions).",
      inputSchema: {
        name: z.string().describe("Exact object name (schema prefix optional), e.g. AP_INVOICES_ALL"),
      },
    },
    async ({ name }) => reply("getTable", { name }, catalog.getTable(name)),
  );

  server.registerTool(
    "getColumns",
    {
      title: "List columns of a table/view",
      description:
        "All columns with data type, size, nullability, description and primary-key flag.",
      inputSchema: {
        table: z.string().describe("Exact object name, e.g. AP_INVOICES_ALL"),
      },
    },
    async ({ table }) => reply("getColumns", { table }, catalog.getColumns(table)),
  );

  server.registerTool(
    "validateTable",
    {
      title: "Validate a table/view name",
      description:
        "Check whether a table/view exists in Fusion. If not, returns fuzzy 'did-you-mean' " +
        "suggestions — use this to catch EBS-vs-Fusion name drift in a name you think you know.",
      inputSchema: {
        name: z.string().describe("Candidate object name to validate"),
      },
    },
    async ({ name }) => reply("validateTable", { name }, catalog.validateTable(name)),
  );

  server.registerTool(
    "validateColumns",
    {
      title: "Validate column names against a table",
      description:
        "For a given table, check each candidate column name; returns exists flag and " +
        "did-you-mean suggestions per missing column.",
      inputSchema: {
        table: z.string().describe("Exact object name"),
        columns: z.array(z.string()).describe("Candidate column names to validate"),
      },
    },
    async ({ table, columns }) => reply("validateColumns", { table, columns }, catalog.validateColumns(table, columns)),
  );

  server.registerTool(
    "getIndexes",
    {
      title: "List indexes of a table",
      description: "Indexes with their ordered columns and uniqueness — useful for join/filter planning.",
      inputSchema: {
        table: z.string().describe("Exact object name"),
      },
    },
    async ({ table }) => reply("getIndexes", { table }, catalog.getIndexes(table)),
  );

  server.registerTool(
    "getRelatedTables",
    {
      title: "Get related tables (join paths)",
      description:
        "Real join paths for a table: declared foreign keys PLUS mined relationships " +
        "(from Oracle-report/view SQL), each tagged source=declared|mined with confidence and " +
        "join columns. Use to build correct joins instead of guessing keys.",
      inputSchema: {
        table: z.string().describe("Exact object name"),
      },
    },
    async ({ table }) => reply("getRelatedTables", { table }, catalog.getRelatedTables(table)),
  );

  server.registerTool(
    "findSimilarQueries",
    {
      title: "Find similar real report SQL by intent",
      description:
        "Semantic search over ~100K real Fusion report/view/OTBI SQLs. Given a natural-language " +
        "intent, returns the closest real queries as clean SQL few-shot templates, each with its " +
        "tables, joins, filters and lookup types. Use FIRST when generating SQL from NL, then " +
        "ground the result with validateTable/getColumns/getRelatedTables.",
      inputSchema: {
        intent: z.string().describe("Natural-language description of the query you want"),
        source: z.enum(["otbi", "catalog", "view"]).optional().describe("Restrict to one corpus"),
        limit: z.number().int().min(1).max(20).optional().describe("Max examples (default 5)"),
      },
    },
    async ({ intent, source, limit }) =>
      reply("findSimilarQueries", { intent, source, limit },
        await catalog.findSimilarQueries(intent, { source, limit: limit ?? 5 })),
  );

  server.registerTool(
    "getReportQuery",
    {
      title: "Get the exact SQL behind a report / subject-area table",
      description:
        "Exact lookup of a real query by its title. For OTBI the title is 'SubjectArea.Table' " +
        "(e.g. 'Absence Management - Leave Donations Real Time.Contracts'); for catalog/view it is " +
        "the report path / view name. Returns the ORIGINAL SQL (raw OTBI physical or human SQL) plus " +
        "the clean rewrite, description, tables, joins, filters and lookups. If the title isn't found, " +
        "returns fuzzy suggestions. Use when the user asks 'what is the SELECT behind <subject area> <table>'.",
      inputSchema: {
        title: z.string().describe("Exact title, e.g. 'SubjectArea.Table' or a report path / view name"),
      },
    },
    async ({ title }) => reply("getReportQuery", { title }, catalog.getReportQuery(title)),
  );

  server.registerTool(
    "listQueriesForSubjectArea",
    {
      title: "List all report queries under a subject area",
      description:
        "Lists every real query whose title falls under the given OTBI subject area (or any title " +
        "prefix), returning id/source/title/description for each. Use to discover which tables a " +
        "subject area exposes, then fetch one with getReportQuery.",
      inputSchema: {
        area: z.string().describe("Subject-area name or title prefix, e.g. 'Absence Management - Leave Donations Real Time'"),
        limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
      },
    },
    async ({ area, limit }) =>
      reply("listQueriesForSubjectArea", { area, limit }, catalog.listQueriesForSubjectArea(area, limit ?? 100)),
  );

  return server;
}
