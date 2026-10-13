import type { SecurityApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

const ROW_COLS = "table_name, column_name, context, urda_column, ref_object, ref_column, is_primary, confidence, evidence, reason";
const AREA_COLS = "area_or_product, ordinal, obj_name, privilege, source, evidence, instance_scope, entity_table, vo_def, context_column";
const FAMILY_COLS = "table_name, family, base_table, evidence";
const LAYER_COLS = "instance, stamp, loaded_at, grantee, counts";
const IOBJ_COLS = "instance, obj_name, database_object_name, pk1_column, pk2_column, pk3_column, pk4_column, pk5_column";
const IPRIV_COLS = "instance, obj_name, privilege, grant_sig, n_grants";
const U_COLS = "instance, obj_name, privilege, instance_type, grant_sig, n_grants";
const DUTY_COLS = "instance, duty_role, obj_name, privilege, grant_sig, n_grants";
const ALIAS_COLS = "instance, duty_role, seeded_role";
const ROLE_COLS = "instance, role_name, obj_name, privilege";
const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");
/** rows per multi-row INSERT of the layer load (an admin action; ~10k rows per pod) */
const CHUNK = 200;

/**
 * Data-access security facts — two layers, both NAMES ONLY (spec 2026-10-02 §7: no predicate text,
 * no pod id):
 *  - the RELEASE facts, pipeline-built (scripts/pipeline/p5_security.sql), never at boot: the
 *    context column → reference object map (table_security), the disallowed objects, the curated
 *    area → (object, privilege) rows (sec_area_privilege, scoped by instance, keyed to the (area,
 *    entity) the evidence names), sec_meta — nothing of any pod (ddl_version 9: the seed export's
 *    sec_object / sec_privilege copies are gone; what differs per pod is the customer layer below);
 *  - the per-INSTANCE customer layer (library migrations v2 + v3 / sqlite factsdb), loaded by
 *    src/securityLayer.ts from the pod's own FND_OBJECTS + FND_GRANTS names: registrations with
 *    their key columns, every granted (object, privilege) with its grant-set signature, U = the
 *    pairs granted to the BI server identity, the FBI/analysis-duty pairs, the customer duty copies
 *    → their seeded twins. One layer per pod host with its export stamp; a re-import replaces it in
 *    ONE transaction.
 * Portable SQL: both providers run it unchanged. Names are stored as the pod spells them
 * (OBJ_NAME is case-sensitive: App Composer objects end in a lowercase `_c`).
 */
export class BaseSecurity implements SecurityApi {
  constructor(protected p: BaseProvider) {}

  async forTable(table: string): Promise<T.TableSecurityRow[]> {
    return this.p.q<T.TableSecurityRow>(
      `SELECT ${ROW_COLS} FROM ${this.p.t("table_security")} WHERE table_name = ?
       ORDER BY is_primary DESC, column_name${this.p.coll()}, context${this.p.coll()}`, [table]);
  }

  async disallowed(table: string): Promise<T.TableDisallowedRow | null> {
    const rows = await this.p.q<T.TableDisallowedRow>(`SELECT table_name, reason FROM ${this.p.t("table_disallowed")} WHERE table_name = ?`, [table]);
    return rows[0] ?? null;
  }

  async areaPrivileges(objName: string, instance: string): Promise<T.SecAreaPrivilegeRow[]> {
    return this.p.q<T.SecAreaPrivilegeRow>(
      `SELECT ${AREA_COLS} FROM ${this.p.t("sec_area_privilege")}
       WHERE obj_name = ? AND (instance_scope = '*' OR instance_scope = ?)
       ORDER BY area_or_product${this.p.coll()}, ordinal`, [objName, instance]);
  }

  async meta(): Promise<Record<string, string>> {
    const rows = await this.p.q<{ k: string; v: string }>(`SELECT k, v FROM ${this.p.t("sec_meta")}`);
    return Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }

  async version(): Promise<string | null> {
    const rows = await this.p.q<{ v: string }>(`SELECT v FROM ${this.p.t("sec_meta")} WHERE k='version'`);
    return rows[0]?.v ?? null;
  }

  async counts() {
    const one = async (sql: string) => Number((await this.p.q<{ c: number }>(sql))[0]?.c ?? 0);
    const [r, d, a, f] = await Promise.all([
      this.p.q<{ c: number; t: number }>(`SELECT COUNT(*) c, COUNT(DISTINCT table_name) t FROM ${this.p.t("table_security")}`),
      one(`SELECT COUNT(*) c FROM ${this.p.t("table_disallowed")}`),
      one(`SELECT COUNT(*) c FROM ${this.p.t("sec_area_privilege")}`),
      one(`SELECT COUNT(*) c FROM ${this.p.t("table_reference_family")}`),
    ]);
    return { rows: Number(r[0]?.c ?? 0), tables: Number(r[0]?.t ?? 0), disallowed: d, areaRows: a, referenceTables: f };
  }

  async referenceFamily(table: string): Promise<T.ReferenceFamilyRow | null> {
    const rows = await this.p.q<T.ReferenceFamilyRow>(`SELECT ${FAMILY_COLS} FROM ${this.p.t("table_reference_family")} WHERE table_name = ?`, [table]);
    return rows[0] ?? null;
  }

  async replaceAll(f: T.SecurityFacts) {
    await this.p.tx(async () => {
      await this.p.exec(
        `DELETE FROM ${this.p.t("table_security")}; DELETE FROM ${this.p.t("table_disallowed")};
         DELETE FROM ${this.p.t("sec_area_privilege")}; DELETE FROM ${this.p.t("table_reference_family")}; DELETE FROM ${this.p.t("sec_meta")};`);
      for (const r of f.rows) {
        await this.p.run(`INSERT INTO ${this.p.t("table_security")} (${ROW_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [r.table_name, r.column_name, r.context, r.urda_column, r.ref_object, r.ref_column, r.is_primary, r.confidence, r.evidence, r.reason]);
      }
      for (const d of f.disallowed) {
        await this.p.run(`INSERT INTO ${this.p.t("table_disallowed")} (table_name, reason) VALUES (?, ?)`, [d.table_name, d.reason]);
      }
      for (const a of f.areaPrivileges) {
        await this.p.run(`INSERT INTO ${this.p.t("sec_area_privilege")} (${AREA_COLS}) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [a.area_or_product, a.ordinal, a.obj_name, a.privilege, a.source, a.evidence, a.instance_scope, a.entity_table, a.vo_def, a.context_column]);
      }
      for (const r of f.referenceFamilies) {
        await this.p.run(`INSERT INTO ${this.p.t("table_reference_family")} (${FAMILY_COLS}) VALUES (?,?,?,?)`, [r.table_name, r.family, r.base_table, r.evidence]);
      }
      for (const [k, v] of Object.entries(f.meta)) {
        await this.p.run(`INSERT INTO ${this.p.t("sec_meta")} (k, v) VALUES (?, ?)`, [k, v]);
      }
    });
    return { rows: f.rows.length, disallowed: f.disallowed.length, areaRows: f.areaPrivileges.length, referenceTables: f.referenceFamilies.length,
      meta: Object.keys(f.meta).length };
  }

  // ---- the per-instance customer layer ----------------------------------------------------------

  async layer(instance: string): Promise<T.SecInstanceRow | null> {
    const rows = await this.p.q<T.SecInstanceRow>(`SELECT ${LAYER_COLS} FROM ${this.p.t("sec_instance")} WHERE instance = ?`, [instance]);
    return rows[0] ?? null;
  }

  async layers(): Promise<T.SecInstanceRow[]> {
    return this.p.q<T.SecInstanceRow>(`SELECT ${LAYER_COLS} FROM ${this.p.t("sec_instance")} ORDER BY instance${this.p.coll()}`);
  }

  async instanceObject(instance: string, objName: string): Promise<T.SecInstanceObjectRow | null> {
    const rows = await this.p.q<T.SecInstanceObjectRow>(
      `SELECT ${IOBJ_COLS} FROM ${this.p.t("sec_instance_object")} WHERE instance = ? AND obj_name = ?`, [instance, objName]);
    return rows[0] ?? null;
  }

  async instanceObjectsForTable(instance: string, table: string): Promise<T.SecInstanceObjectRow[]> {
    return this.p.q<T.SecInstanceObjectRow>(
      `SELECT ${IOBJ_COLS} FROM ${this.p.t("sec_instance_object")}
       WHERE instance = ? AND (obj_name = ? OR database_object_name = ?)
       ORDER BY CASE WHEN obj_name = ? THEN 0 ELSE 1 END, obj_name${this.p.coll()}`, [instance, table, table, table]);
  }

  async instancePrivilegeExists(instance: string, objName: string, privilege: string): Promise<boolean> {
    const rows = await this.p.q<{ c: number }>(
      `SELECT COUNT(*) c FROM ${this.p.t("sec_instance_privilege")} WHERE instance = ? AND obj_name = ? AND privilege = ?`, [instance, objName, privilege]);
    return Number(rows[0]?.c ?? 0) > 0;
  }

  async grantedPairs(instance: string, objName: string): Promise<T.SecInstancePrivilegeRow[]> {
    return this.p.q<T.SecInstancePrivilegeRow>(
      `SELECT ${IPRIV_COLS} FROM ${this.p.t("sec_instance_privilege")} WHERE instance = ? AND obj_name = ?
       ORDER BY privilege${this.p.coll()}`, [instance, objName]);
  }

  async uPairs(instance: string, objName: string): Promise<T.SecUPairRow[]> {
    return this.p.q<T.SecUPairRow>(
      `SELECT ${U_COLS} FROM ${this.p.t("sec_instance_u")} WHERE instance = ? AND obj_name = ?
       ORDER BY privilege${this.p.coll()}, instance_type${this.p.coll()}`, [instance, objName]);
  }

  async dutyPairs(instance: string, objName: string): Promise<T.SecDutyPairRow[]> {
    return this.p.q<T.SecDutyPairRow>(
      `SELECT ${DUTY_COLS} FROM ${this.p.t("sec_instance_duty")} WHERE instance = ? AND obj_name = ?
       ORDER BY duty_role${this.p.coll()}, privilege${this.p.coll()}`, [instance, objName]);
  }

  async dutyAliases(instance: string): Promise<T.SecDutyAliasRow[]> {
    return this.p.q<T.SecDutyAliasRow>(
      `SELECT ${ALIAS_COLS} FROM ${this.p.t("sec_instance_duty_alias")} WHERE instance = ? ORDER BY duty_role${this.p.coll()}`, [instance]);
  }

  async dutyRoles(instance: string): Promise<string[]> {
    const rows = await this.p.q<{ duty_role: string }>(
      `SELECT duty_role FROM (SELECT DISTINCT duty_role FROM ${this.p.t("sec_instance_duty")} WHERE instance = ?) x ORDER BY duty_role${this.p.coll()}`, [instance]);
    return rows.map((r) => r.duty_role);
  }

  async roleGrants(instance: string, objName: string, roles: string[]): Promise<{ role_name: string; privilege: string }[]> {
    if (!roles.length) return [];
    return this.p.q<{ role_name: string; privilege: string }>(
      `SELECT role_name, privilege FROM ${this.p.t("sec_instance_role_grant")} WHERE instance = ? AND obj_name = ? AND role_name IN (${ph(roles.length)})
       ORDER BY role_name${this.p.coll()}, privilege${this.p.coll()}`, [instance, objName, ...roles]);
  }

  async replaceLayer(instance: string, stamp: string, layer: T.SecLayerInput, nowIso: string): Promise<T.SecLayerCounts> {
    const counts: T.SecLayerCounts = { objects: layer.objects.length, privileges: layer.privileges.length, u: layer.u.length, duties: layer.duties.length,
      aliases: layer.aliases.length, roleGrants: layer.roleGrants.length };
    const insert = async (table: Parameters<BaseProvider["t"]>[0], cols: string, width: number, rows: unknown[][]) => {
      for (let i = 0; i < rows.length; i += CHUNK) {
        const part = rows.slice(i, i + CHUNK);
        await this.p.run(`INSERT INTO ${this.p.t(table)} (${cols}) VALUES ${part.map(() => `(${ph(width)})`).join(",")}`, part.flat());
      }
    };
    await this.p.tx(async () => {
      for (const t of ["sec_instance_object", "sec_instance_privilege", "sec_instance_u", "sec_instance_duty", "sec_instance_duty_alias", "sec_instance_role_grant",
        "sec_instance"] as const) {
        await this.p.run(`DELETE FROM ${this.p.t(t)} WHERE instance = ?`, [instance]);
      }
      await insert("sec_instance_object", IOBJ_COLS, 8, layer.objects.map((o) =>
        [instance, o.obj_name, o.database_object_name, o.pk1_column, o.pk2_column, o.pk3_column, o.pk4_column, o.pk5_column]));
      await insert("sec_instance_privilege", IPRIV_COLS, 5, layer.privileges.map((r) => [instance, r.obj_name, r.privilege, r.grant_sig, r.n_grants]));
      await insert("sec_instance_u", U_COLS, 6, layer.u.map((r) => [instance, r.obj_name, r.privilege, r.instance_type, r.grant_sig, r.n_grants]));
      await insert("sec_instance_duty", DUTY_COLS, 6, layer.duties.map((r) => [instance, r.duty_role, r.obj_name, r.privilege, r.grant_sig, r.n_grants]));
      await insert("sec_instance_duty_alias", ALIAS_COLS, 3, layer.aliases.map((r) => [instance, r.duty_role, r.seeded_role]));
      await insert("sec_instance_role_grant", ROLE_COLS, 4, layer.roleGrants.map((r) => [instance, r.role_name, r.obj_name, r.privilege]));
      await this.p.run(`INSERT INTO ${this.p.t("sec_instance")} (${LAYER_COLS}) VALUES (?,?,?,?,?)`, [instance, stamp, nowIso, layer.grantee, JSON.stringify(counts)]);
    });
    return counts;
  }
}
