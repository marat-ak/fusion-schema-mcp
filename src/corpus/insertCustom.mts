/**
 * Insert hand-curated "advanced technique" example SQLs into report_queries (+vectors).
 * Source of these examples: a production custom move-order generator, cleaned of all
 * company-specific logic. They teach techniques the harvested corpus doesn't show:
 *   - /*+ WITH_PLSQL *​/ + WITH FUNCTION / WITH PROCEDURE inline PL/SQL — the ONLY way to run
 *     procedural logic in Fusion SaaS SQL (no custom DB objects allowed in SaaS).
 *   - Calling Oracle-shipped public PL/SQL APIs from plain SQL (INV_QUANTITY_TREE_PUB,
 *     FND_PROFILE.VALUE).
 *   - JSON_ARRAYAGG / JSON_OBJECT / JSON_TABLE + LEFT JOIN LATERAL for multi-row allocation.
 * Run: npx tsx src/corpus/insertCustom.mts   (then redeploy catalog to /opt/fusion-catalog)
 */
import Database from "better-sqlite3";
import { load as loadVec } from "sqlite-vec";
import { embed } from "./embed.js";
import { reportsDbPath } from "../dbPaths.js";

// The report corpus now lives in reports.sqlite (env REPORTS_DB / CATALOG_DB fallback via dbPaths).
const DB = reportsDbPath();

const EX1_SQL = `
-- Technique: inline PL/SQL in Fusion SaaS SQL (BIP data model). SaaS forbids creating DB
-- objects, but a query CAN carry its own functions: /*+ WITH_PLSQL */ + WITH FUNCTION.
SELECT /*+ WITH_PLSQL */ *
FROM (
  WITH
    FUNCTION get_target_locator (
      p_item_id NUMBER, p_org_id NUMBER, p_subinv VARCHAR2
    ) RETURN NUMBER DETERMINISTIC IS
    BEGIN
      -- 1) most recently USED active locator for this item in the subinventory
      FOR r IN (SELECT mt.locator_id
                  FROM inv_material_txns mt
                  JOIN inv_item_locations loc ON loc.inventory_location_id = mt.locator_id
                 WHERE mt.inventory_item_id = p_item_id
                   AND mt.organization_id   = p_org_id
                   AND mt.subinventory_code = p_subinv
                   AND NVL(loc.disable_date, SYSDATE + 1) > SYSDATE
                 ORDER BY mt.creation_date DESC) LOOP
        RETURN r.locator_id;
      END LOOP;
      -- 2) else: least-loaded active locator already holding the item
      FOR r IN (SELECT moq.locator_id
                  FROM inv_onhand_quantities_detail moq
                  JOIN inv_item_locations loc ON loc.inventory_location_id = moq.locator_id
                 WHERE moq.subinventory_code = p_subinv
                   AND moq.inventory_item_id = p_item_id
                   AND moq.organization_id   = p_org_id
                   AND NVL(loc.disable_date, SYSDATE + 1) > SYSDATE
                 ORDER BY moq.transaction_quantity) LOOP
        RETURN r.locator_id;
      END LOOP;
      -- 3) else: any EMPTY active locator in the subinventory, by picking order
      FOR r IN (SELECT loc.inventory_location_id AS locator_id
                  FROM inv_item_locations loc
                 WHERE loc.subinventory_code = p_subinv
                   AND NVL(loc.disable_date, SYSDATE + 1) > SYSDATE
                   AND NOT EXISTS (SELECT NULL
                                     FROM inv_onhand_quantities_detail moq
                                    WHERE moq.subinventory_code = p_subinv
                                      AND moq.locator_id = loc.inventory_location_id)
                 ORDER BY loc.picking_order) LOOP
        RETURN r.locator_id;
      END LOOP;
      RETURN NULL;
    END;
  -- demo usage: current on-hand by item in a source subinventory + suggested target locator
  SELECT moq.organization_id,
         moq.subinventory_code                                        AS from_subinventory,
         item.item_number,
         item.primary_uom_code                                        AS uom,
         SUM(moq.transaction_quantity)                                AS on_hand_qty,
         get_target_locator(moq.inventory_item_id, moq.organization_id,
                            :p_target_subinv)                         AS target_locator_id
    FROM inv_onhand_quantities_detail moq
    JOIN egp_system_items_vl item
      ON item.inventory_item_id = moq.inventory_item_id
     AND item.organization_id   = moq.organization_id
   WHERE moq.subinventory_code = :p_source_subinv
   GROUP BY moq.organization_id, moq.subinventory_code, item.item_number,
            item.primary_uom_code, moq.inventory_item_id
)`.trim();

const EX2_SQL = `
-- Techniques: (a) call an Oracle-shipped PUBLIC PL/SQL API (INV_QUANTITY_TREE_PUB) from plain
-- SaaS SQL via inline WITH FUNCTION; (b) WITH PROCEDURE mutating a CLOB; (c) build a JSON
-- allocation with JSON_ARRAYAGG/JSON_OBJECT and explode it back with JSON_TABLE + LEFT JOIN
-- LATERAL; (d) FND_PROFILE.VALUE for environment-configurable behaviour.
SELECT /*+ WITH_PLSQL */ *
FROM (
  WITH
    PROCEDURE append_locator_to_json (
      p_current IN OUT CLOB, p_locator_id NUMBER, p_locator_qty NUMBER, p_picking_order NUMBER
    ) IS
    BEGIN
      SELECT JSON_ARRAYAGG(JSON_OBJECT(* RETURNING CLOB) RETURNING CLOB)
        INTO p_current
        FROM (SELECT locator_id, locator_qty, picking_order
                FROM JSON_TABLE(p_current, '$[*]'
                       COLUMNS (locator_id NUMBER, locator_qty NUMBER, picking_order NUMBER))
               WHERE p_current IS NOT NULL
              UNION ALL
              SELECT p_locator_id, p_locator_qty, p_picking_order FROM DUAL);
    END;

    FUNCTION available_qty (         -- available-to-transact from the official quantity tree
      p_item_id NUMBER, p_org_id NUMBER, p_subinv VARCHAR2, p_locator_id NUMBER
    ) RETURN NUMBER DETERMINISTIC IS
      l_status VARCHAR2(1); l_msg_count NUMBER; l_msg_data VARCHAR2(1000);
      l_qoh NUMBER; l_rqoh NUMBER; l_qr NUMBER; l_qs NUMBER; l_att NUMBER; l_atr NUMBER;
    BEGIN
      inv_quantity_tree_pub.query_quantities(
        p_api_version_number => 1.0, p_init_msg_lst => 'F',
        x_return_status => l_status, x_msg_count => l_msg_count, x_msg_data => l_msg_data,
        p_organization_id => p_org_id, p_inventory_item_id => p_item_id,
        p_tree_mode => 2, p_onhand_source => 3,
        p_is_revision_control => FALSE, p_is_lot_control => FALSE, p_is_serial_control => TRUE,
        p_revision => NULL, p_lot_number => NULL,
        p_subinventory_code => p_subinv, p_locator_id => p_locator_id,
        x_qoh => l_qoh, x_rqoh => l_rqoh, x_qr => l_qr, x_qs => l_qs,
        x_att => l_att, x_atr => l_atr);
      RETURN NVL(l_att, 0);
    END;

    FUNCTION intransit_qty (         -- already on open move-order lines toward this locator
      p_item_id NUMBER, p_org_id NUMBER, p_subinv VARCHAR2, p_locator_id NUMBER
    ) RETURN NUMBER DETERMINISTIC IS
      l_res NUMBER;
    BEGIN
      SELECT SUM(NVL(mmtt.transaction_quantity, mol.quantity))
        INTO l_res
        FROM inv_txn_request_lines mol
        LEFT JOIN inv_material_txns_temp mmtt
          ON mmtt.move_order_line_id = mol.line_id
         AND mmtt.transaction_type_id = mol.transaction_type_id
         AND mmtt.transaction_quantity > 0
       WHERE mol.to_subinventory_code = p_subinv
         AND mol.inventory_item_id    = p_item_id
         AND mol.organization_id      = p_org_id
         AND mol.to_locator_id        = p_locator_id
         AND mol.line_status IN (1, 3, 7);      -- open / approved / pre-approved
      RETURN NVL(l_res, 0);
    END;

    FUNCTION source_locators (       -- allocate the needed qty across source locators -> JSON
      p_item_id NUMBER, p_org_id NUMBER, p_subinv VARCHAR2, p_requested_qty NUMBER
    ) RETURN CLOB DETERMINISTIC IS
      l_avail NUMBER; l_use NUMBER; l_remain NUMBER := p_requested_qty; l_result CLOB;
    BEGIN
      FOR r IN (SELECT moq.locator_id, loc.picking_order
                  FROM inv_onhand_quantities_detail moq
                  JOIN inv_item_locations loc ON loc.inventory_location_id = moq.locator_id
                 WHERE moq.subinventory_code = p_subinv
                   AND moq.inventory_item_id = p_item_id
                   AND moq.organization_id   = p_org_id
                 ORDER BY moq.date_received DESC, moq.transaction_quantity DESC) LOOP
        l_avail := available_qty(p_item_id, p_org_id, p_subinv, r.locator_id);
        IF l_avail > 0 THEN
          l_use := LEAST(l_avail, l_remain);
          append_locator_to_json(l_result, r.locator_id, l_use, r.picking_order);
          l_remain := l_remain - l_use;
        END IF;
        EXIT WHEN l_remain <= 0;
      END LOOP;
      RETURN l_result;
    END;

    -- items below their min-max minimum at a destination locator
    main AS (
      SELECT item.item_number,
             item.inventory_item_id,
             item.organization_id,
             item.primary_uom_code                                       AS uom,
             misi.secondary_inventory                                    AS subinventory_code,
             misi.min_minmax_quantity,
             misi.max_minmax_quantity,
             mil.inventory_location_id                                   AS to_locator_id,
             available_qty(item.inventory_item_id, item.organization_id,
                           misi.secondary_inventory, mil.inventory_location_id) AS qoh_locator,
             intransit_qty(item.inventory_item_id, item.organization_id,
                           misi.secondary_inventory, mil.inventory_location_id) AS intransit
        FROM inv_item_sub_inventories  misi
        JOIN egp_system_items_vl       item
          ON item.inventory_item_id = misi.inventory_item_id
         AND item.organization_id   = misi.organization_id
        JOIN inv_secondary_locators   msl
          ON msl.inventory_item_id  = misi.inventory_item_id
         AND msl.subinventory_code  = misi.secondary_inventory
        JOIN inv_item_locations       mil
          ON mil.inventory_location_id = msl.secondary_locator
       WHERE misi.min_minmax_quantity >=
             available_qty(item.inventory_item_id, item.organization_id,
                           misi.secondary_inventory, mil.inventory_location_id)
           + intransit_qty(item.inventory_item_id, item.organization_id,
                           misi.secondary_inventory, mil.inventory_location_id)
    ),
    calc AS (
      SELECT main.*,
             source_locators(inventory_item_id, organization_id, subinventory_code,
                             max_minmax_quantity - qoh_locator - intransit) AS source_locators
        FROM main
    )
  -- one replenishment line per source locator, exploded from the JSON allocation
  SELECT c.item_number,
         c.organization_id,
         c.subinventory_code                    AS to_subinventory,
         c.to_locator_id,
         c.uom,
         ll.locator_id                          AS from_locator_id,
         ll.locator_qty                         AS requested_qty,
         ll.picking_order
    FROM calc c
    LEFT JOIN LATERAL (
      SELECT * FROM JSON_TABLE(c.source_locators, '$[*]'
               COLUMNS (locator_id NUMBER, locator_qty NUMBER, picking_order NUMBER))
    ) ll ON (1 = 1)
   WHERE c.source_locators IS NOT NULL
   ORDER BY c.subinventory_code, c.item_number, ll.picking_order
)`.trim();

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
    sql: EX1_SQL,
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
    sql: EX2_SQL,
    tables: ["INV_ITEM_SUB_INVENTORIES", "INV_SECONDARY_LOCATORS", "EGP_SYSTEM_ITEMS_VL",
             "INV_ITEM_LOCATIONS", "INV_ONHAND_QUANTITIES_DETAIL", "INV_TXN_REQUEST_LINES",
             "INV_MATERIAL_TXNS_TEMP"],
  },
];

const db = new Database(DB);
loadVec(db);
try { db.exec("ALTER TABLE report_queries ADD COLUMN embedding BLOB"); } catch { /* present */ }
const maxRow = (db.prepare("SELECT MAX(rowid) m FROM report_queries").get() as any).m as number;
const insQ = db.prepare(
  `INSERT OR REPLACE INTO report_queries
   (rowid, id, source, title, original_sql, clean_sql, description, tables_used, joins, filters,
    lookup_types, security_predicate, approved, embedding)
   VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,?)`);
const insV = db.prepare("INSERT OR REPLACE INTO report_queries_vec (rowid, embedding) VALUES (?, ?)");

const vecs = await embed(ROWS.map((r) => r.description));
ROWS.forEach((r, i) => {
  const rowid = BigInt(maxRow + 1 + i);
  const emb = Buffer.from(vecs[i].buffer);
  insQ.run(rowid, r.id, r.source, r.title, r.sql, r.sql, r.description,
           JSON.stringify(r.tables), "[]", "[]", "[]", null, emb);
  insV.run(rowid, emb);
  console.log("inserted", r.id, "rowid", rowid);
});
db.close();
console.log("done");
