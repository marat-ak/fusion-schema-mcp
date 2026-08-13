/** Registers the grounding tools on an McpServer instance (grounding-only MCP). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as catalog from "./catalog.js";
import { queryFlexfields, queryAdfExtensions } from "./corpus/flexStore.js";
import { findLayoutPattern, getLayoutPattern } from "./corpus/layoutStore.js";
import { upsertTableRule, listTableRules, deleteTableRule } from "./corpus/tableRules.js";

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
        // semantic branch must carry the corpus stats too — agents often confirm tables ONLY via search
        ? reply("getColumns", { table, search, limit }, { ...(await catalog.searchColumns(table, search, limit ?? 20)), ...catalog.mostlyUsedStats(table) })
        : reply("getColumns", { table, like, limit }, catalog.getColumns(table, { like, limit })),
  );

  server.registerTool(
    "validateTable",
    {
      title: "Validate table/view name(s)",
      description:
        "Check whether a table/view exists in Fusion. If not, returns fuzzy 'did-you-mean' " +
        "suggestions — use this to catch EBS-vs-Fusion name drift in a name you think you know. " +
        "Pass `names` with your FULL final table list right before writing SQL: each entry returns its " +
        "grain warning (multi-row/revision tables that need a dedup filter) and the filters real reports " +
        "apply — address every hint or state why not.",
      inputSchema: {
        name: z.string().optional().describe("Candidate object name to validate"),
        table: z.string().optional().describe("Alias for `name` (matches getColumns/validateColumns param naming)"),
        names: z.array(z.string()).optional().describe("Validate several tables in one call (the pre-SQL dossier check)"),
      },
    },
    async ({ name, table, names }) => {
      if (names?.length) {
        // COMPACT dossier: full validateTable × N tables blew the token cap (8 tables = 130k chars — the
        // topUsages examples dominate). Keep exists + the decision-critical stats, cap list lengths,
        // drop usage examples (fetch per-table via getTableUsages when needed).
        const out = names.map((x) => {
          const v: any = catalog.validateTable(x);
          const stats: any = catalog.mostlyUsedStats(x);
          return {
            name: x,
            exists: v.exists,
            ...(v.suggestions?.length ? { suggestions: v.suggestions.slice(0, 3) } : {}),
            ...(stats.mostlyUsedFilters ? { mostlyUsedFilters: stats.mostlyUsedFilters.slice(0, 5) } : {}),
            ...(stats.mostlyUsedJoinFilters ? { mostlyUsedJoinFilters: stats.mostlyUsedJoinFilters.slice(0, 5) } : {}),
          };
        });
        return reply("validateTable", { names }, { tables: out });
      }
      const n = name ?? table;
      if (!n) return reply("validateTable", { name: n }, { error: "pass `name`, `table` or `names`" });
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
      title: "Get the exact SQL behind a report / subject-area table (by title OR id)",
      description:
        "Exact lookup of a real query, at FULL SIZE (never clipped). Pass EITHER `id` OR `title`.\n" +
        "- `id` (e.g. 'sql:0b3e…' or 'view:AR_TOTAL_BALANCE_VIEW') returns that EXACT row's full SQL. " +
        "USE THIS to fetch the SQL that findSimilarQueries OMITTED for being large (it returns each " +
        "match's `id` with `cleanSqlOmitted:true` + `sqlChars`) — read the mechanics is NOT a " +
        "substitute for the real SQL when you need to adopt/adapt a big report.\n" +
        "- `title` (OTBI 'SubjectArea.Table', or a report path / view name) returns the report's MAIN " +
        "(largest) dataset. A .xdm often has SEVERAL datasets; the reply then carries a `datasets[]` " +
        "list of the siblings (id + sqlChars) — fetch any of them by `id`. If not found, returns fuzzy " +
        "suggestions.\n" +
        "Returns original + clean SQL, description, tables, joins, filters, lookups, security predicate.",
      inputSchema: {
        id: z.string().optional().describe("Exact corpus id ('sql:…' / 'view:…'), e.g. from a findSimilarQueries match"),
        title: z.string().optional().describe("Exact title: 'SubjectArea.Table' or a report path / view name"),
      },
    },
    async ({ id, title }) =>
      reply("getReportQuery", { id, title }, catalog.getReportQuery(String(id ?? title ?? ""))),
  );

  server.registerTool(
    "getTableGrain",
    {
      title: "Does this table keep ONE row per key or MULTIPLE (history/revisions)?",
      description:
        "Grain hint for a table so you don't GUESS whether a driving table is one-row-per-business-key " +
        "and silently double-count. Returns one of: `effective_dated` (date-tracked `_F`/`_M` table — keeps " +
        "many rows across time; filter SYSDATE/:as_of BETWEEN effective_start_date AND effective_end_date on " +
        "EVERY such table, and add a primary/latest flag if present), `latest_flag` (keeps history; current " +
        "row flagged by latest_rec_flag/latest_flag/current_flag/primary_flag='Y'), `translation` (`_TL` table " +
        "— one row PER LANGUAGE; filter LANGUAGE='US' or use the `_VL` view), `revision_suspect` (has a " +
        "revision column but NO standard flag and the corpus rarely dedups it — e.g. DOO_HEADERS_ALL keeps " +
        "every order revision; you MUST verify grain and dedup via MAX(object_version_number) OVER " +
        "(PARTITION BY <key>), never assume one row), or `single_row` (default). `dedup` gives the exact " +
        "filter; `corpusEvidence` = how many real reports treat it so. " +
        "CALL THIS for every DRIVING/fact table before you write GROUP BY or SUM — validateTable also " +
        "returns a grainWarning when the table is multi-row.",
      inputSchema: { table: z.string().describe("Physical table name, e.g. DOO_HEADERS_ALL") },
    },
    async ({ table }) => {
      const grain = catalog.grainFor(String(table)) ?? { grain: "single_row" };
      // Auto-attach the top real usages (brief) so grain + real filters/joins arrive together.
      const usages = catalog.tableUsages(String(table), { limit: 3, brief: true }).usages;
      return reply("getTableGrain", { table }, { ...grain, ...(usages.length ? { topUsages: usages } : {}) });
    },
  );

  server.registerTool(
    "getTableUsages",
    {
      title: "Real report SQL that USES this table (adopt real joins/filters)",
      description:
        "Table-anchored retrieval — the complement to findSimilarQueries (intent-anchored). Given a " +
        "table you already know, returns the best real report/view/OTBI queries that USE it, ranked " +
        "for ADOPTION (real hand-written reports & delivered views first — they are proper report-grade " +
        "examples; per-column OTBI fragments read the table flat and rank lower — then by SQL " +
        "completeness), each with its filters, joins and SQL (large bodies fetchable by id via " +
        "getReportQuery). USE THIS after validateTable to copy real join keys and filter idioms instead " +
        "of guessing. It reaches bip-report and view SQL that have NO structured joins/filters " +
        "extracted, so it is the only way to see how those real reports actually filter/join a table.",
      inputSchema: {
        table: z.string().describe("Exact physical table/view name, e.g. DOO_HEADERS_ALL"),
        limit: z.number().int().min(1).max(30).optional().describe("Max usages (default 6)"),
      },
    },
    async ({ table, limit }) =>
      reply("getTableUsages", { table, limit }, catalog.tableUsages(String(table), { limit: limit ?? 6 })),
  );

  server.registerTool(
    "upsertTableRule",
    {
      title: "Record/override a curated table rule (human knowledge schema/corpus can't provide)",
      description:
        "Persist a per-table fact neither the schema nor the corpus can teach — e.g. 'on this tenant " +
        "DOO_HEADERS_ALL is safely deduped by submitted_flag=Y' (that idiom appears in ~17 of ~98,000 " +
        "queries and 0 extracted fields, so it is neither mineable nor retrievable). kind='grain' " +
        "OVERRIDES the derived grain/dedup for the table (pass `grain` and/or `dedup`); kind='note' adds " +
        "a clarification; kind='caveat' a warning. Curated rules survive ALL metadata redeployments and " +
        "surface automatically on validateTable + getTableGrain. Pass `id` to update an existing rule; " +
        "tag `author`.",
      inputSchema: {
        id: z.number().int().optional().describe("existing rule id to update; omit to create"),
        table: z.string().describe("physical table name"),
        kind: z.enum(["grain", "note", "caveat"]).describe("grain=override classification+dedup, note=clarification, caveat=warning"),
        column: z.string().optional().describe("column name if column-scoped"),
        grain: z.string().optional().describe("kind=grain: override category (single_row | latest_flag | effective_dated | translation | revision_suspect)"),
        dedup: z.string().optional().describe("kind=grain: the exact dedup filter, e.g. submitted_flag='Y'"),
        note: z.string().optional().describe("free-text body / clarification"),
        author: z.string().optional().describe("who recorded it"),
        source: z.enum(["human", "agent"]).optional().describe("provenance (default human)"),
        enabled: z.boolean().optional().describe("set false to disable without deleting"),
      },
    },
    async (a) => reply("upsertTableRule", a, upsertTableRule(a, new Date().toISOString())),
  );

  server.registerTool(
    "listTableRules",
    {
      title: "List curated table rules",
      description: "List curated table rules (includes disabled). Pass `table` to scope to one table, else all.",
      inputSchema: { table: z.string().optional().describe("physical table name to filter by") },
    },
    async ({ table }) => reply("listTableRules", { table }, listTableRules(table)),
  );

  server.registerTool(
    "deleteTableRule",
    {
      title: "Delete a curated table rule",
      description: "Delete a curated rule by its id (from listTableRules).",
      inputSchema: { id: z.number().int().describe("rule id to delete") },
    },
    async ({ id }) => reply("deleteTableRule", { id }, deleteTableRule(id)),
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
        "the *_c API name — `search` matches de-camelized API words AND real display labels when " +
        "the admin loaded the App Composer Configuration Report ('account owner' finds " +
        "AccountOwner_c labeled 'Account Owner'); try the user's own words first. Empty " +
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

  server.registerTool(
    "findLayoutPattern",
    {
      title: "Find BIP layout patterns (archetypes / techniques / anti-patterns)",
      description:
        "Retrieval over the VERIFIED layout-pattern corpus: report ARCHETYPES (whole-report shapes " +
        "— call at the structure-alignment step, BEFORE building the data model: each archetype's " +
        "`requires.dataShape` tells you what group nesting / pre-aggregation the model must " +
        "provide), TECHNIQUES (render-verified blocks[]/layout-spec recipes you can compose " +
        "directly — corpus language = your emission language), and ANTI-PATTERNS (constructs that " +
        "render broken or unmaintainable, with the correct alternative). Pass the user's own " +
        "wording as intent ('one page per customer with invoice lines and totals', 'pivot by SKU', " +
        "'dashboard chart left, table right'). `format` (rtf|xpt) filters recipes; a format-" +
        "exclusive match under the other format returns WITHOUT its recipe plus formatAdvice — " +
        "resolve the format (ask the user if needed) before building. dslSupport:'unsupported' " +
        "rows describe real BIP capabilities our generator does NOT cover yet — tell the user " +
        "honestly instead of silently changing the deliverable. Compose retrieved recipes; the " +
        "builder validates the composition.",
      inputSchema: {
        intent: z.string().describe("natural-language description of the layout need, user's own words"),
        format: z.enum(["rtf", "xpt"]).optional().describe("target template format, when already chosen"),
        kinds: z.array(z.enum(["archetype", "technique", "antipattern"])).optional()
          .describe("filter row kinds (anti-patterns are always scanned regardless)"),
        limit: z.number().int().min(1).max(8).optional().describe("max patterns (default 4)"),
        sessionKey: z.string().optional().describe("stable per-session key — the grammar card is attached once per key"),
      },
    },
    async ({ intent, format, kinds, limit, sessionKey }) =>
      reply("findLayoutPattern", { intent, format, kinds }, await findLayoutPattern(intent, { format, kinds, limit, sessionKey })),
  );

  server.registerTool(
    "getLayoutPattern",
    {
      title: "Fetch one layout pattern in full (incl. a large recipe)",
      description:
        "Returns the complete corpus row for a pattern id from findLayoutPattern — use when a " +
        "result carried recipeOmitted:true, or to re-read a pattern's full recipe/pitfalls.",
      inputSchema: { id: z.string().describe("pattern id, e.g. 'lp:technique:rtf-multilevel-blocks'") },
    },
    async ({ id }) => reply("getLayoutPattern", { id }, getLayoutPattern(id)),
  );

  // Data-model / file authoring tools have moved to the agent (in-process SDK tools). This MCP is
  // now a pure, stateless GROUNDING server — catalog + corpus search only.

  return server;
}
