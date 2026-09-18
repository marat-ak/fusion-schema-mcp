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
)
