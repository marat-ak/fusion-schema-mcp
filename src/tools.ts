/** Registers the grounding tools on an McpServer instance (grounding-only MCP). */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as catalog from "./catalog.js";
import { queryFlexfields, queryAdfExtensions } from "./corpus/flexStore.js";
import { findLayoutPattern, getLayoutPattern } from "./corpus/layoutStore.js";
import { upsertTableRule, listTableRules, deleteTableRule } from "./corpus/tableRules.js";
import { searchOtbi, describeOtbiFolder, checkOtbiSql } from "./corpus/otbiStore.js";
import { getDataAccessPredicate, getSecuredQueryPlan, compactDataSecurity } from "./corpus/dataAccess.js";

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
    async ({ query, limit }) => reply("searchTables", { query, limit }, await catalog.searchTables(query, limit ?? 20)),
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
        instance: z.string().optional().describe("the pod host exactly as runSql reports `instance` — with it, dataSecurity carries the data-access verdict (secured | blocked | none) on that pod"),
      },
    },
    async ({ name, instance }) => reply("getTable", { name, instance }, await catalog.getTable(name, instance)),
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
        instance: z.string().optional().describe("the pod host exactly as runSql reports `instance` — with it, dataSecurity carries the data-access verdict on that pod"),
      },
    },
    async ({ table, search, like, limit, instance }) =>
      search
        // semantic branch must carry the corpus stats too — agents often confirm tables ONLY via search
        ? reply("getColumns", { table, search, limit, instance }, { ...(await catalog.searchColumns(table, search, limit ?? 20)), ...(await catalog.mostlyUsedStats(table, instance)) })
        : reply("getColumns", { table, like, limit, instance }, await catalog.getColumns(table, { like, limit, instance })),
  );

  server.registerTool(
    "validateTable",
    {
      title: "Validate table/view name(s)",
      description:
        "Check whether a table/view exists in Fusion. If not, returns fuzzy 'did-you-mean' " +
        "suggestions — use this to catch EBS-vs-Fusion name drift in a name you think you know. " +
        "Pass `names` with your FULL final table list right before writing SQL: each entry returns the " +
        "filters and join columns real reports apply, the PL/SQL APIs read alongside, and `dataSecurity` — the " +
        "data-access context columns of the table and, when you pass `instance` (the pod host as runSql reports " +
        "it), the verdict on that pod: secured (the (object, privilege) conditions) | blocked (cannot be resolved: " +
        "the reason + candidates; in end-user mode the table cannot be read) | none (reference data) — address " +
        "every hint or state why not.",
      inputSchema: {
        name: z.string().optional().describe("Candidate object name to validate"),
        table: z.string().optional().describe("Alias for `name` (matches getColumns/validateColumns param naming)"),
        names: z.array(z.string()).optional().describe("Validate several tables in one call (the pre-SQL dossier check)"),
        instance: z.string().optional().describe("the pod host exactly as runSql reports `instance` — with it, dataSecurity carries the data-access verdict on that pod"),
      },
    },
    async ({ name, table, names, instance }) => {
      if (names?.length) {
        // COMPACT dossier: full validateTable × N tables blew the token cap (8 tables = 130k chars — the
        // topUsages examples dominate). Keep exists + the decision-critical stats, cap list lengths,
        // drop usage examples (fetch per-table via getTableUsages when needed).
        const out = [];
        for (const x of names) {
          const v: any = await catalog.validateTable(x);
          const stats: any = await catalog.mostlyUsedStats(x, instance);
          out.push({
            name: x,
            exists: v.exists,
            ...(v.suggestions?.length ? { suggestions: v.suggestions.slice(0, 3) } : {}),
            ...(stats.mostlyUsedFilters ? { mostlyUsedFilters: stats.mostlyUsedFilters.slice(0, 5) } : {}),
            ...(stats.mostlyUsedJoinFilters ? { mostlyUsedJoinFilters: stats.mostlyUsedJoinFilters.slice(0, 5) } : {}),
            ...(stats.mostlyUsedApis ? { mostlyUsedApis: stats.mostlyUsedApis.slice(0, 3) } : {}),
            ...(stats.dataSecurity ? { dataSecurity: compactDataSecurity(stats.dataSecurity) } : {}),
          });
        }
        return reply("validateTable", { names, instance }, { tables: out });
      }
      const n = name ?? table;
      if (!n) return reply("validateTable", { name: n }, { error: "pass `name`, `table` or `names`" });
      return reply("validateTable", { name: n, instance }, await catalog.validateTable(n, instance));
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
        instance: z.string().optional().describe("the pod host exactly as runSql reports `instance` — with it, dataSecurity carries the data-access verdict on that pod"),
      },
    },
    async ({ table, columns, instance }) => reply("validateColumns", { table, columns, instance }, await catalog.validateColumns(table, columns, instance)),
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
    async ({ table }) => reply("getIndexes", { table }, await catalog.getIndexes(table)),
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
    async ({ table }) => reply("getRelatedTables", { table }, await catalog.getRelatedTables(table)),
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
        "- `id` (e.g. 'sql:0b3e…') returns that EXACT row's full SQL. " +
        "USE THIS to fetch the SQL that findSimilarQueries OMITTED for being large (it returns each " +
        "match's `id` with `cleanSqlOmitted:true` + `sqlChars`) — read the mechanics is NOT a " +
        "substitute for the real SQL when you need to adopt/adapt a big report.\n" +
        "- `title` (OTBI 'SubjectArea.Folder' — folder name verbatim, e.g. 'General Ledger - Balances Real " +
        "Time.- Currency' — or a report path / view name) returns the report's MAIN (largest) dataset. " +
        "Every unit title resolves, also when several OTBI folders share one physical SQL: the reply " +
        "then carries `requestedTitle` (yours) and `title` (the row's canonical one). A .xdm often has " +
        "SEVERAL datasets; the reply then carries a `datasets[]` list of the siblings (id + sqlChars) — " +
        "fetch any of them by `id`. If not found, returns fuzzy suggestions.\n" +
        "Returns original + clean SQL, description, tables, joins, filters, lookups, security predicate.",
      inputSchema: {
        id: z.string().optional().describe("Exact corpus id ('sql:…'), e.g. from a findSimilarQueries match"),
        title: z.string().optional().describe("Exact title: 'SubjectArea.Folder' or a report path / view name"),
      },
    },
    async ({ id, title }) =>
      reply("getReportQuery", { id, title }, await catalog.getReportQuery(String(id ?? title ?? ""))),
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
      const grain = (await catalog.grainFor(String(table))) ?? { grain: "single_row" };
      // Auto-attach the top real usages (brief) so grain + real filters/joins arrive together.
      const usages = (await catalog.tableUsages(String(table), { limit: 3, brief: true })).usages;
      return reply("getTableGrain", { table }, { ...grain, ...(usages.length ? { topUsages: usages } : {}) });
    },
  );

  server.registerTool(
    "findPlsqlApi",
    {
      title: "Which Oracle-shipped PL/SQL package/function does the job? (real-corpus inventory)",
      description:
        "Inventory of the PL/SQL packages and functions that REAL Fusion report SQL calls (451 packages, " +
        "~2,900 functions, from ~26K statements) plus the pod's full package dictionary (6,935 names). " +
        "Use BEFORE re-deriving a business computation with joins — quantities, UOM/currency conversion, " +
        "rates, formatted names/addresses/phones, profile/session/security context, flexfield " +
        "concatenation, status text — an official package usually exists and is the correct answer. " +
        "Three lookups, combinable: `query` = words of the computation matched against PACKAGE.FUNCTION " +
        "names (e.g. 'convert qty', 'format address', 'closest rate', 'user partyid'); `package` = all " +
        "functions of one package (+ exists/inDictionary even when the corpus never calls it); `table` = " +
        "apis real reports call alongside that table (the pushed `mostlyUsedApis` of validateTable/" +
        "getColumns, unbounded). Each api returns statements/units/reports counts, argument-count " +
        "samples, top co-read tables and 1-2 real call snippets with the corpus id of their statement " +
        "(getReportQuery({id}) gives the full SQL). Call the api from SQL directly, or from an inline " +
        "`/*+ WITH_PLSQL */ WITH FUNCTION` wrapper when it has OUT parameters.",
      inputSchema: {
        query: z.string().optional().describe("words of the business computation (matched against package/function names)"),
        package: z.string().optional().describe("exact package name, e.g. INV_CONVERT"),
        table: z.string().optional().describe("exact table/view name — apis real reports call together with it"),
        limit: z.number().int().min(1).max(40).optional().describe("max apis per lookup (default 12)"),
      },
    },
    async ({ query, package: pkg, table, limit }) =>
      reply("findPlsqlApi", { query, package: pkg, table, limit }, await catalog.findPlsqlApi({ query, package: pkg, table, limit })),
  );

  server.registerTool(
    "getDataAccessPredicate",
    {
      title: "Fusion data-access PLAN (developer) for the tables of ONE query on ONE pod: one secured CTE per table + the rewrite map",
      description:
        "The DEVELOPER plan that secures every table instance of a query the way Fusion does — names only, no SQL " +
        "condition text: each condition is generated on the user's pod by FND_DATA_SECURITY.GET_SECURITY_PREDICATE " +
        "through the pod tool getSecurityPredicate({pairs}) (ONE call with the plan's `pairs`); splice each returned " +
        "`predicate` VERBATIM into its `{PRED:<object>|<privilege>}` slot. `instance` is REQUIRED — the pod host " +
        "exactly as runSql reports `instance`; the plan is built from THAT pod's loaded security layer (registered " +
        "objects, every grant with its grant-set signature, the pairs granted to the BI server identity, its analysis " +
        "duties) — there is no default instance. KEYING: without `subjectArea` = `table` — each table is secured on " +
        "its OWN registered object, or on its PRIMARY context column (business unit, ledger, book, inventory / item / " +
        "cost / manufacturing / project org, intercompany, budget, access set, reference set) through the reference " +
        "object; a table with several context columns only when its name prefix's primary context is audited against " +
        "an OTBI trace (else blocked, the reason says so). With `subjectArea` (an OTBI subject area exactly as the BI " +
        "presentation layer spells it) = `area` — each table is read as that subject area reads it (OTBI's one " +
        "reference entity per (area, table): a curated (area, entity) row, the table's only context, the area's VO " +
        "evidence, or the audited primary; a table the area does not read is blocked), the area's known (curated) " +
        "privilege on an object applies to every table of the area on that object, the HCM privilege comes from the " +
        "area's duties (Oracle's TBI guides), `columns` lists per alias what the area does NOT expose (ADVICE — " +
        "the projection stays t.*), and `gate.applied` is false: the subject-area gate is an end-user rule. Sensitive " +
        "side tables (national identifiers, passports, visas, licences, salary, supplier PII, bank accounts) ONLY " +
        "through their own pair(s). Output {instance, layerStamp, keying, subjectArea?, ctes[], rewrite[], pairs[], " +
        "blocked[], unsecured[], columns?, gate?}: `ctes` = one per secured table instance — {table, alias, cteName " +
        "(<alias>_sec), cte (`<alias>_sec as (select /*+ INLINE */ t.* from <TABLE> t where t.<col> in (select " +
        "sec$.<pk> from <object> sec$ where {PRED:<object>|<privilege>}))` — a tuple for a composite key, `(t.<col> is " +
        "null or …)` for a nullable column, several pairs OR-ed inside ONE condition = anyOf), pairs, keying, " +
        "subjectArea?, grade, route (direct | reference), column / context (the secured context column, null on " +
        "direct), evidence, equivalentTo? (names with the identical grant set = the same predicate), masked? (raw " +
        "columns never to select, with the masked twin to read instead)}; GRADE = where the pair came from: trace " +
        "(an OTBI LOGLEVEL-7 trace) | inferred (curated from the demo crawl, untraced) | rule (the only privilege of " +
        "the product granted to the BI server identity) | duty (the HCM analysis-duty map; keyed on an area: that " +
        "area's duties) | equivalent (a rule / duty pick among names with one grant set) | consensus (keyed on an " +
        "area: what the job roles Oracle's TBI guides name for the area hold on the object — unanimous or a unique " +
        "majority) | granted (pool 2: the only grant-set class of the product among ALL the pod's grants — not " +
        "granted to the BI identity, not OTBI-proven) | sensitive (the table's own sensitive pair); state it on the " +
        "`Data access:` line together with the keying. " +
        "`rewrite` = {from: '<TABLE> <alias>', to: '<alias>_sec <alias>'} — put every cte in ONE leading WITH and read " +
        "`to` wherever the query reads `from` (every FROM / JOIN / subquery / UNION arm); `pairs` = the distinct " +
        "{object, privilege, alias:\"sec$\"} for getSecurityPredicate; `blocked` = {table, alias, column?, reason, " +
        "candidates?} — fail closed, nothing is guessed and no privilege-less call exists (the developer asks the " +
        "user, or writes unsecured SQL only on the user's explicit word, labelled); `unsecured` = {table, alias, " +
        "reason} — no context column and not a security object: reference data, read directly. Every condition is " +
        "the generating user's own (ad-hoc runSql = exact; a data model authored for others embeds the author's " +
        "condition — state it). The table-keyed verdict arrives pushed as `dataSecurity` on getTable / getColumns / " +
        "validateColumns / validateTable when they are called with `instance`. End users (no developer role) use " +
        "getSecuredQueryPlan instead.",
      inputSchema: {
        instance: z.string().describe("the pod host exactly as runSql reports `instance` (the value of `instance` in any runSql reply) — required"),
        tables: z.array(z.object({
          table: z.string().describe("exact table/view name, e.g. AP_INVOICES_ALL"),
          alias: z.string().describe("the alias of this table INSTANCE in your FROM clause, e.g. ap (one entry per instance)"),
        })).min(1).describe("every table instance of the query"),
        subjectArea: z.string().optional().describe("an OTBI subject area exactly as the presentation layer spells it (e.g. 'Payables Invoices - Transactions Real Time') — keys every table on that area (OTBI's entity per (area, table)); omit for the table-keyed plan"),
      },
    },
    async ({ instance, tables, subjectArea }) =>
      reply("getDataAccessPredicate", { instance, tables, subjectArea }, await getDataAccessPredicate({ instance, tables, ...(subjectArea !== undefined ? { subjectArea } : {}) })),
  );

  server.registerTool(
    "getSecuredQueryPlan",
    {
      title: "END-USER secured plan: the tables of ONE question read as an OTBI subject area reads them, for the signed-in user",
      description:
        "The END-USER plan (a user without the developer role asks a business question; the answer is the data, never " +
        "the SQL). Names only: the conditions are generated on the user's pod by pod-mcp getSecurityPredicate. " +
        "`instance` is REQUIRED (the pod host exactly as runSql reports `instance`; no default). Call it in two steps. " +
        "(1) WITHOUT `subjectAreas` → {candidateAreas[]: {area, factOf[], alsoReads[], duties, hcm, neverHeld?}, " +
        "perTable?, noArea?, next} — the OTBI subject areas that read EVERY table some area reads, best first (`noArea` = " +
        "tables no subject area reads; the no-area policy decides them); settle the area yourself from the question " +
        "(never ask the end user for an area, a context or a privilege). (2) WITH `subjectAreas` → {mode: " +
        "'end-user', enforcement: 'prompt', instance, layerStamp, catalogRelease, guideRelease, keying: 'area', " +
        "subjectAreas, gate {areas[{area, duties, neverHeld?}], alternates[...]}, ctes[], rewrite[], pairs[], blocked[], " +
        "columns{<alias>: {allowed, joinOnly, filterOnly, hidden, hiddenCount, maskingShapes?}}, limits}: each table is " +
        "keyed on the first given area that reads it (OTBI's one reference entity per (area, table)); each CTE projects " +
        "ONLY the area's exposed columns + the join keys + the filter columns (`<alias>_sec as (select /*+ INLINE */ " +
        "t.<col>, … from <TABLE> t where <condition with {PRED:<object>|<privilege>} slots>)`); select only `allowed` " +
        "columns, use `joinOnly` columns in joins and `filterOnly` columns in WHERE / JOIN conditions only (never in the " +
        "select list), never `hidden` ones (they are not in the projection). CTE grades: trace | inferred | rule | duty | " +
        "equivalent | sensitive | consensus (the area's guide job roles agree on the privilege) | strictest (an " +
        "ambiguous privilege: every candidate AND-ed — `strictest.privileges`; when ONE of them comes back access " +
        "none the table is empty for the user and the answer says `access cannot be confirmed for <table> (ambiguous " +
        "privilege, you lack <privilege>)`, never 'no data', never plain 'no access') | structural (a reference table " +
        "with no security of its own and no relationship to secured data, or a lookup / translation / calendar / " +
        "currency / territory table — read without a condition, no pair). Then make ONE getSecurityPredicate " +
        "call with {pairs, gate: {areas: [...gate.areas, ...gate.alternates]}}: every settled area must come back " +
        "held — if one is not held, re-plan with a held alternate that reads every table, else refuse 'no access to " +
        "subject area <area>'; a gate error = refuse; nothing is read without a held area. Splice each predicate " +
        "verbatim, put the ctes in ONE leading WITH, read `to` wherever the query reads `from` (every FROM / JOIN / " +
        "subquery / UNION arm; LEFT JOIN a dimension CTE so a no-access dimension blanks instead of dropping rows), " +
        "run it with runSql in the same session, and answer with the rows plus ONE sentence built from `limits` " +
        "(areas, pairs, withheld columns, releases, enforcement). A predicate `(1=2)` (access none) = 'no access to " +
        "<object> for <privilege>', never 'no data'. `blocked` tables (undecided context, ambiguous privilege outside " +
        "the area's own modules, a child of secured data that is no reference table, a pool-2-only pick, a table no " +
        "given area reads, a business table NO subject area reads — `readInstead` names the equivalent an area reads) " +
        "are NOT read — say so; there is no unsecured path for an end user. Sensitive side tables only through their " +
        "own pair(s). A catalog without the OTBI lineage returns an error: refuse the question.",
      inputSchema: {
        instance: z.string().describe("the pod host exactly as runSql reports `instance` — required"),
        tables: z.array(z.object({
          table: z.string().describe("exact table/view name"),
          alias: z.string().describe("the alias of this table INSTANCE in the FROM clause (one entry per instance)"),
        })).min(1).describe("every table instance of the query"),
        subjectAreas: z.array(z.string()).optional().describe("the OTBI subject area(s) the question reads, exactly as the presentation layer spells them — omit on the first call to get the candidates"),
      },
    },
    async ({ instance, tables, subjectAreas }) =>
      reply("getSecuredQueryPlan", { instance, tables, subjectAreas }, await getSecuredQueryPlan({ instance, tables, ...(subjectAreas !== undefined ? { subjectAreas } : {}) })),
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
      reply("getTableUsages", { table, limit }, await catalog.tableUsages(String(table), { limit: limit ?? 6 })),
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
    async (a) => reply("upsertTableRule", a, await upsertTableRule(a, new Date().toISOString())),
  );

  server.registerTool(
    "listTableRules",
    {
      title: "List curated table rules",
      description: "List curated table rules (includes disabled). Pass `table` to scope to one table, else all.",
      inputSchema: { table: z.string().optional().describe("physical table name to filter by") },
    },
    async ({ table }) => reply("listTableRules", { table }, await listTableRules(table)),
  );

  server.registerTool(
    "deleteTableRule",
    {
      title: "Delete a curated table rule",
      description: "Delete a curated rule by its id (from listTableRules).",
      inputSchema: { id: z.number().int().describe("rule id to delete") },
    },
    async ({ id }) => reply("deleteTableRule", { id }, await deleteTableRule(id)),
  );

  server.registerTool(
    "listQueriesForSubjectArea",
    {
      title: "List all report queries under a subject area",
      description:
        "Lists every real query whose title falls under the given OTBI subject area (or any title " +
        "prefix), returning id/source/title/canonicalTitle/description for each — one row per folder " +
        "title, also when several folders share one physical SQL (`canonicalTitle` names the row that " +
        "carries it). Use to discover which folders a subject area exposes physically, then fetch one " +
        "with getReportQuery({title}). For the PRESENTATION layer (folders, columns, measures) use " +
        "describeOtbiFolder.",
      inputSchema: {
        area: z.string().describe("Subject-area name or title prefix, e.g. 'Absence Management - Leave Donations Real Time'"),
        limit: z.number().int().min(1).max(500).optional().describe("Max results (default 100)"),
      },
    },
    async ({ area, limit }) =>
      reply("listQueriesForSubjectArea", { area, limit }, await catalog.listQueriesForSubjectArea(area, limit ?? 100)),
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
    async (args) => reply("getFlexfields", args, await queryFlexfields(args)),
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
    async (args) => reply("getCustomObjects", args, await queryAdfExtensions(args)),
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
    async ({ id }) => reply("getLayoutPattern", { id }, await getLayoutPattern(id)),
  );

  server.registerTool(
    "searchOtbi",
    {
      title: "Search the OTBI presentation catalog (subject areas / folders / columns) by meaning",
      description:
        "Semantic search over the OTBI PRESENTATION layer — the names a business user sees and logical " +
        "SQL uses: subject areas, presentation folders and presentation columns, each with kind " +
        "(fact/dimension, attribute/measure + aggregation), dataType, a description derived from the " +
        "physical dictionary, and the physical tables behind it (dbRefs / dbTables — for validateTable, " +
        "getTableGrain, getReportQuery). USE THIS FIRST when writing logical SQL from a business " +
        "question: it tells you WHICH subject area and folders hold the columns. A column hit lists " +
        "its `locations` (subject area + folder) — the same column often exists in many subject areas; " +
        "pass `subjectArea` (verbatim) once you know it to narrow. Names are VERBATIM (double spaces, " +
        "`- ` child-folder prefixes) — copy them exactly into the SQL. Then describeOtbiFolder for the " +
        "folder's full column list and checkOtbiSql before running.",
      inputSchema: {
        query: z.string().describe("business words, e.g. 'supplier invoice amount unpaid', 'employee department job'"),
        subjectArea: z.string().optional().describe("exact subject area name to restrict to, e.g. 'Payables Invoices - Transactions Real Time'"),
        limit: z.number().int().min(1).max(40).optional().describe("max hits (default 10)"),
      },
    },
    async ({ query, subjectArea, limit }) => reply("searchOtbi", { query, subjectArea, limit }, await searchOtbi(query, { subjectArea, limit })),
  );

  server.registerTool(
    "describeOtbiFolder",
    {
      title: "OTBI subject area folder tree, or one folder's columns",
      description:
        "Without `folder`: the subject area's folder tree — fact folders (measures) and dimension " +
        "folders with column counts, plus coverage flags. With `folder`: every column of that folder " +
        "with dataType, attribute/measure + aggregation, the resolved physical expression, description, " +
        "dbRefs (physical TABLE.COLUMN), and the folder's dbTables + grainNote (multi-row tables behind " +
        "it) and `physicalSql` hint (getReportQuery title) for physical depth. Names must be verbatim; " +
        "a miss returns nearest-name suggestions. Reference forms: `\"SA\".\"Folder\".\"Column\"` in " +
        "the select-list with `FROM \"SA\"`, or `\"Column\"` selected from `\"SA\".\"Folder\"`; one subject area per query; " +
        "measures are aggregated by the BI server — never wrap them in SUM()/COUNT().",
      inputSchema: {
        subjectArea: z.string().describe("exact subject area name"),
        folder: z.string().optional().describe("exact presentation folder name (verbatim, incl. a leading '- ' when it has one)"),
      },
    },
    async ({ subjectArea, folder }) => reply("describeOtbiFolder", { subjectArea, folder }, await describeOtbiFolder(subjectArea, folder)),
  );

  server.registerTool(
    "checkOtbiSql",
    {
      title: "Lint OTBI logical SQL against the presentation catalog (offline, no execution)",
      description:
        "Checks a logical SQL statement BEFORE it is run: every referenced subject area / folder / " +
        "column must exist (verbatim; a case/space mismatch is a warning with the canonical spelling; a " +
        "miss returns nearest-name suggestions and the folders that do carry the column), exactly ONE " +
        "subject area in FROM, no `select *`, and aggregate functions (SUM/COUNT/…) are flagged — the BI " +
        "server aggregates measures at the grain of the selected attributes. Accepts both reference " +
        "forms (three-part `\"SA\".\"Folder\".\"Column\"`, and `\"Column\"` / `\"Folder\".\"Column\"` with " +
        "`FROM \"SA\".\"Folder\"`), :BIND parameters, DESCRIPTOR_IDOF(), FETCH FIRST. Returns ok, errors, " +
        "warnings, the resolved references (with kind / dataType / aggregation) and which selected " +
        "columns are measures. Fix every error before running; treat a warning as a question to answer.",
      inputSchema: { sql: z.string().describe("the logical SQL statement") },
    },
    async ({ sql }) => reply("checkOtbiSql", { sqlChars: sql.length }, await checkOtbiSql(sql)),
  );

  // Data-model / file authoring tools have moved to the agent (in-process SDK tools). This MCP is
  // now a pure, stateless GROUNDING server — catalog + corpus search only.

  return server;
}
