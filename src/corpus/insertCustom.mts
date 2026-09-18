/**
 * Insert hand-curated "advanced technique" example SQLs into the report corpus (+vectors).
 * Source of these examples: a production custom move-order generator, cleaned of all
 * company-specific logic. They teach techniques the harvested corpus doesn't show:
 *   - /*+ WITH_PLSQL *​/ + WITH FUNCTION / WITH PROCEDURE inline PL/SQL — the ONLY way to run
 *     procedural logic in Fusion SaaS SQL (no custom DB objects allowed in SaaS).
 *   - Calling Oracle-shipped public PL/SQL APIs from plain SQL (INV_QUANTITY_TREE_PUB,
 *     FND_PROFILE.VALUE).
 *   - JSON_ARRAYAGG / JSON_OBJECT / JSON_TABLE + LEFT JOIN LATERAL for multi-row allocation.
 * The Oracle SQL bodies live beside this file in customExamples/*.sql (corpus DATA, not DB access).
 * Run: CATALOG_DB=sqlite DATA_DIR=<dir> npx tsx src/corpus/insertCustom.mts   (then redeploy the catalog)
 */
import fs from "node:fs";
import { openCatalogDb, configFromEnv } from "../db/index.js";
import { materialize } from "./ingestStore.js";

const sqlOf = (name: string) => fs.readFileSync(new URL(`./customExamples/${name}.sql`, import.meta.url), "utf8").trim();

const ROWS = [
  {
    id: "custom:technique:inline-plsql-with-function",
    source: "custom",
    title: "Technique - Inline PL/SQL (WITH FUNCTION) in SaaS SQL - pick putaway locator",
    description:
      "Advanced Oracle Fusion SaaS SQL technique: embed PL/SQL functions directly inside a query " +
      "using the /*+ WITH_PLSQL */ hint and a WITH FUNCTION clause - the only way to run " +
      "procedural logic (loops, multi-step fallback rules) in SaaS BIP data models where creating " +
      "database objects is not allowed. Business case: suggest the best putaway/target locator " +
      "for an item in a subinventory with a 3-level fallback - most recently used active locator, " +
      "else least-loaded locator holding the item, else first empty active locator by picking " +
      "order. Uses inventory on-hand (INV_ONHAND_QUANTITIES_DETAIL), material transactions " +
      "(INV_MATERIAL_TXNS), locator definitions (INV_ITEM_LOCATIONS, disable_date check) and " +
      "item master (EGP_SYSTEM_ITEMS_VL).",
    sql: sqlOf("inline-plsql-with-function"),
    tables: ["INV_MATERIAL_TXNS", "INV_ITEM_LOCATIONS", "INV_ONHAND_QUANTITIES_DETAIL",
             "EGP_SYSTEM_ITEMS_VL"],
  },
  {
    id: "custom:technique:public-plsql-api-json-allocation",
    source: "custom",
    title: "Technique - Call public PL/SQL API + JSON allocation - min-max fill locators",
    description:
      "Advanced Oracle Fusion SaaS SQL techniques in one working report: (1) call an " +
      "Oracle-shipped PUBLIC PL/SQL API from plain SQL - INV_QUANTITY_TREE_PUB.QUERY_QUANTITIES " +
      "returns true available-to-transact (ATT) quantity per item/subinventory/locator, the same " +
      "number the application UI shows; (2) inline WITH PROCEDURE that mutates a CLOB; (3) build " +
      "a multi-row allocation as JSON with JSON_ARRAYAGG/JSON_OBJECT and explode it back into " +
      "rows with JSON_TABLE + LEFT JOIN LATERAL; (4) FND_PROFILE.VALUE for configurable " +
      "behaviour. Business case: min-max replenishment ('fill locators') - find item/locator " +
      "combinations below their min-max minimum (INV_ITEM_SUB_INVENTORIES, " +
      "INV_SECONDARY_LOCATORS), subtract quantity already in transit on open move-order lines " +
      "(INV_TXN_REQUEST_LINES, INV_MATERIAL_TXNS_TEMP), then allocate the shortfall across " +
      "source locators newest-stock-first and emit one replenishment line per source locator.",
    sql: sqlOf("public-plsql-api-json-allocation"),
    tables: ["INV_ITEM_SUB_INVENTORIES", "INV_SECONDARY_LOCATORS", "EGP_SYSTEM_ITEMS_VL",
             "INV_ITEM_LOCATIONS", "INV_ONHAND_QUANTITIES_DETAIL", "INV_TXN_REQUEST_LINES",
             "INV_MATERIAL_TXNS_TEMP"],
  },
];

const db = await openCatalogDb(configFromEnv());
const res = await materialize(ROWS.map((r) => ({
  id: r.id, source: r.source, title: r.title, originalSql: r.sql, cleanSql: r.sql,
  description: r.description, tablesUsed: r.tables, lookupTypes: [],
})));
for (const r of ROWS) console.log("materialized", r.id);
console.log("done", res);
await db.close();
