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

  return server;
}
