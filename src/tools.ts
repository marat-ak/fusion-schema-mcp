/** Registers the grounding tools on an McpServer instance (grounding-only MCP). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as catalog from "./catalog.js";
import { queryFlexfields, queryAdfExtensions } from "./corpus/flexStore.js";

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
        "Columns with data type, size, nullability, a short description and primary-key flag. Wide " +
        "Fusion tables have 100+ columns — narrow instead of dumping all:\n" +
        "- `search`: SEMANTIC — ranks columns by name + description against a concept " +
        "(e.g. search:'amount owed to supplier' → GROSS_AMOUNT, AMOUNT_PAID, ...). Best when you " +
        "know the meaning but not the exact name.\n" +
        "- `like`: exact name substring (e.g. like:'AMOUNT').\n" +
        "Plain (no filter) is capped at 120 with a note; remarks truncated. For a few known names " +
        "prefer validateColumns.",
      inputSchema: {
        table: z.string().describe("Exact object name, e.g. AP_INVOICES_ALL"),
        search: z.string().optional().describe("semantic concept to rank columns by (uses name + description embeddings)"),
        like: z.string().optional().describe("only columns whose name contains this substring (case-insensitive)"),
        limit: z.number().int().min(1).max(400).optional().describe("max columns to return (default 120; 20 for search)"),
      },
    },
    async ({ table, search, like, limit }) =>
      search
        ? reply("getColumns", { table, search, limit }, await catalog.searchColumns(table, search, limit ?? 20))
        : reply("getColumns", { table, like, limit }, catalog.getColumns(table, { like, limit })),
  );

  server.registerTool(
    "validateTable",
    {
      title: "Validate a table/view name",
      description:
        "Check whether a table/view exists in Fusion. If not, returns fuzzy 'did-you-mean' " +
        "suggestions — use this to catch EBS-vs-Fusion name drift in a name you think you know.",
      inputSchema: {
        name: z.string().optional().describe("Candidate object name to validate"),
        table: z.string().optional().describe("Alias for `name` (matches getColumns/validateColumns param naming)"),
      },
    },
    async ({ name, table }) => {
      const n = name ?? table;
      if (!n) return reply("validateTable", { name: n }, { error: "pass `name` (or `table`)" });
      return reply("validateTable", { name: n }, catalog.validateTable(n));
    },
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
      title: "Find similar real report SQL by intent (domain-aware)",
      description:
        "Semantic search over ~100K real Fusion report/view/OTBI SQLs. Use FIRST when generating " +
        "SQL from NL. DOMAIN-AWARE: it classifies the closest real reports into business-domain " +
        "keys by each table's Fusion application module — top level (HCM / Procurement / SCM / " +
        "Payroll / Projects / CRM...) and, within Financials, sub-ledger level (Financials/AP, " +
        "Financials/AR, Financials/GL, Financials/Budgetary, Financials/FA, Financials/Cash...). \n" +
        "- If the matches split across >=2 near-tied domains — cross-domain ('department' = HCM " +
        "org unit vs Financials COA segment) OR sub-ledger ('invoice' = Financials/AP supplier " +
        "invoice vs Financials/AR customer invoice) — it returns {ambiguous:true, domainBreakdown, " +
        "guidance, candidates} WITH NO SQL. You MUST resolve the domain before you can get example " +
        "SQL: if it is the SAME term read two ways, ASK the user which domain and emit no SQL this " +
        "turn; if the request genuinely spans domains, call this tool once per domain (see `domain`). \n" +
        "- Otherwise returns {ambiguous:false, domain, matches} where each match has clean SQL, " +
        "tables, joins, filters, lookups — ground it with validateTable/getColumns/getRelatedTables.",
      inputSchema: {
        intent: z.string().describe("Natural-language description of the query you want"),
        source: z.enum(["otbi", "catalog", "view"]).optional().describe("Restrict to one corpus"),
        domain: z.string().optional().describe(
          "Resolve to ONE business domain to get full example SQL for that domain only. Accepts a " +
          "top level ('Financials', 'HCM'), a sub-domain ('AP', 'AR'), or a full key " +
          "('Financials/AP'). Use after an ambiguous result — pass a domain from its " +
          "domainBreakdown — or on the first call when the user's words already pin the domain."),
        limit: z.number().int().min(1).max(20).optional().describe("Max examples (default 5)"),
      },
    },
    async ({ intent, source, domain, limit }) =>
      reply("findSimilarQueries", { intent, source, domain, limit },
        await catalog.findSimilarQueries(intent, { source, domain, limit: limit ?? 5 })),
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

  server.registerTool(
    "getFlexfields",
    {
      title: "DFF/EFF flexfield registry lookup",
      description:
        "The customer's descriptive (DFF) and extensible (EFF) flexfield registry: which contexts " +
        "exist on which flexfield, and each segment's business name -> physical column " +
        "(ATTRIBUTE_CHARn / GLOBAL_ATTRIBUTEn) + value set + required flag. USE THIS to resolve an " +
        "EFF/DFF context_code and attribute column BEFORE writing SQL against *_EFF_B / ATTRIBUTE " +
        "columns — never guess a context or ship a placeholder when the registry can answer. " +
        "Filter by flexfieldCode (e.g. 'DOO_FULFILL_LINES', 'AP_INVOICES'), context, or free-text " +
        "search over business names ('pallet', 'dealer'). Empty result = registry has no such " +
        "field: ask the user/admin instead of guessing.",
      inputSchema: {
        flexfieldCode: z.string().optional().describe("flexfield/table-family filter, substring match, e.g. 'DOO_FULFILL_LINES'"),
        context: z.string().optional().describe("context_code filter, substring match"),
        search: z.string().optional().describe("free text over segment names / prompts / codes, e.g. 'pallet qty'"),
        type: z.enum(["DFF", "EFF"]).optional(),
        limit: z.number().int().min(1).max(1000).optional().describe("max segment rows scanned (default 200)"),
      },
    },
    async (args) => reply("getFlexfields", args, queryFlexfields(args)),
  );

  server.registerTool(
    "getCustomObjects",
    {
      title: "ADF custom objects & custom fields registry (CRM/CX)",
      description:
        "The customer's ADF extension registry — application-composer CUSTOM OBJECTS (names ending " +
        "_c: Ticket_c, ContractRequest_c...) and CUSTOM FIELDS added to built-in objects. For a " +
        "custom OBJECT it returns the exact access recipe: which GENERIC table stores it (e.g. " +
        "HZ_REF_ENTITIES), the row filter (context column = object name), and each business " +
        "attribute's physical EXTN_ATTRIBUTE_* column. For a custom FIELD on a built-in object it " +
        "returns the object's dedicated extension table + attribute->column mapping (no filter). " +
        "USE THIS whenever a request mentions a *_c object/field or a custom attribute that " +
        "getColumns doesn't show on the standard table. Users normally say the DISPLAY name, not " +
        "the *_c API name — `search` also matches de-camelized human words ('ticket contact' finds " +
        "TicketContact_c, 'net price' finds NetPrice_c); try the user's own words first. Empty " +
        "result => the registry has no such object/field: ASK the user which object/field they " +
        "mean (or for its API name) — never guess and never silently fall back to a standard " +
        "column. SEVERAL plausible matches => ask the user to pick (offer the candidate API names " +
        "as options); only a single unambiguous match may be used without confirmation.",
      inputSchema: {
        object: z.string().optional().describe("custom object name, substring, e.g. 'Ticket' or 'Ticket_c'"),
        table: z.string().optional().describe("generic-store or extension table filter, e.g. 'SVC_SERVICE_REQUESTS'"),
        search: z.string().optional().describe("free text over attribute/object/table names, e.g. 'grade'"),
        limit: z.number().int().min(1).max(1000).optional().describe("max rows scanned (default 200)"),
      },
    },
    async (args) => reply("getCustomObjects", args, queryAdfExtensions(args)),
  );

  // Data-model / file authoring tools have moved to the agent (in-process SDK tools). This MCP is
  // now a pure, stateless GROUNDING server — catalog + corpus search only.

  return server;
}
