import type { OtbiApi } from "../provider.js";
import type * as T from "../types.js";
import type { BaseProvider } from "./provider.js";

const SA_COLS = "name, pillar, n_folders, n_fact_folders, n_columns, fact_folders, in_lineage, in_crawl, in_corpus, text_hash";
const FOLDER_COLS = "subject_area, name, kind, kind_source, description, desc_source, db_tables, n_columns, n_measures, in_lineage, in_crawl, in_corpus, unit_id, grain_note, nested, ordinal, text_hash";
const COLUMN_COLS = "subject_area, folder, name, data_type, kind, aggregation, expression, db_refs, vo_refs, indexed, description, desc_source, gap_cause, in_lineage, in_crawl, in_probe, ordinal, text_hash";
const VO_COLS = "subject_area, folder, vo_path, vo_def, db_objects, vo_attrs";
const REF_COLS = "subject_area, folder, folder_kind, column_name, table_name, db_column, src, via_expression";
const DUTY_COLS = "subject_area, duty_code, duty_name, guide, guide_release, matched_by, guide_area";
const JOB_COLS = "subject_area, job_code, job_name, matched_by, guide";
/** a JSON-list membership pattern (`["A", "B"]` contains "A"): quoted exact name, LIKE-escaped (`_` is a wildcard) */
const jsonMember = (name: string) => `%"${name.replace(/[\\%_]/g, (c) => `\\${c}`)}"%`;
const ph = (n: number) => Array.from({ length: n }, () => "?").join(",");

/**
 * OTBI presentation catalog — pipeline-built (scripts/pipeline/p3_otbi.* → p5_otbi.sql), never at boot;
 * since ddl_version 9 also the VO hop (otbi_vo), the exposure index (otbi_column_ref) and the
 * subject area -> duty code map from Oracle's TBI guides (otbi_area_duty).
 * Portable SQL for every read; KNN over `otbi_vec` is the one provider-specific statement (vec0 MATCH
 * vs pgvector `<->`), overridden like the layout group's. Names are VERBATIM: callers pass them exactly
 * as the BI presentation layer spells them (`- Invoice Amounts`, `Employee Mailing  Address Line2`).
 */
export class BaseOtbi implements OtbiApi {
  constructor(protected p: BaseProvider) {}

  async subjectArea(name: string): Promise<T.OtbiSubjectAreaRow | null> {
    const rows = await this.p.q<T.OtbiSubjectAreaRow>(`SELECT ${SA_COLS} FROM ${this.p.t("otbi_subject_area")} WHERE name = ?`, [name]);
    return rows[0] ?? null;
  }

  async subjectAreaNames(): Promise<string[]> {
    const rows = await this.p.q<{ name: string }>(`SELECT name FROM ${this.p.t("otbi_subject_area")} ORDER BY name${this.p.coll()}`);
    return rows.map((r) => r.name);
  }

  async folders(subjectArea: string): Promise<T.OtbiFolderRow[]> {
    return this.p.q<T.OtbiFolderRow>(
      `SELECT ${FOLDER_COLS} FROM ${this.p.t("otbi_folder")} WHERE subject_area = ? ORDER BY nested, ordinal, name${this.p.coll()}`, [subjectArea]);
  }

  async folder(subjectArea: string, name: string): Promise<T.OtbiFolderRow | null> {
    const rows = await this.p.q<T.OtbiFolderRow>(`SELECT ${FOLDER_COLS} FROM ${this.p.t("otbi_folder")} WHERE subject_area = ? AND name = ?`, [subjectArea, name]);
    return rows[0] ?? null;
  }

  async columns(subjectArea: string, folder: string): Promise<T.OtbiColumnRow[]> {
    return this.p.q<T.OtbiColumnRow>(
      `SELECT ${COLUMN_COLS} FROM ${this.p.t("otbi_column")} WHERE subject_area = ? AND folder = ? ORDER BY ordinal, name${this.p.coll()}`, [subjectArea, folder]);
  }

  async foldersWithColumn(subjectArea: string, column: string): Promise<string[]> {
    const rows = await this.p.q<{ folder: string }>(
      `SELECT folder FROM ${this.p.t("otbi_column")} WHERE subject_area = ? AND name = ? ORDER BY folder${this.p.coll()}`, [subjectArea, column]);
    return rows.map((r) => r.folder);
  }

  /** One indexed read of the exposure index (otbi_column_ref, ddl_version 9) — the same folder set the
   *  folders' `db_tables` lists carry (p5_otbi.sql derives both from the columns' db_refs). */
  async foldersOfTable(table: string): Promise<{ subject_area: string; folder: string; kind: string }[]> {
    // DISTINCT in a derived table: Postgres refuses ORDER BY expressions (the collation) outside a DISTINCT select list
    return this.p.q<{ subject_area: string; folder: string; kind: string }>(
      `SELECT subject_area, folder, kind FROM (SELECT DISTINCT subject_area, folder, folder_kind AS kind FROM ${this.p.t("otbi_column_ref")} WHERE table_name = ?) x
       ORDER BY subject_area${this.p.coll()}, folder${this.p.coll()}`, [table]);
  }

  async columnRefsOfTable(table: string, subjectAreas: string[]): Promise<T.OtbiColumnRefExpr[]> {
    if (!subjectAreas.length) return [];
    return this.p.q<T.OtbiColumnRefExpr>(
      `SELECT ${REF_COLS.split(", ").map((c) => `r.${c}`).join(", ")}, c.expression
       FROM ${this.p.t("otbi_column_ref")} r
       JOIN ${this.p.t("otbi_column")} c ON c.subject_area = r.subject_area AND c.folder = r.folder AND c.name = r.column_name
       WHERE r.table_name = ? AND r.subject_area IN (${ph(subjectAreas.length)})
       ORDER BY r.subject_area${this.p.coll()}, r.folder${this.p.coll()}, r.column_name${this.p.coll()}, r.db_column${this.p.coll()}`,
      [table, ...subjectAreas]);
  }

  async exposedIn(table: string): Promise<{ db_column: string; areas: number }[]> {
    const rows = await this.p.q<{ db_column: string; areas: number }>(
      `SELECT db_column, COUNT(DISTINCT subject_area) AS areas FROM ${this.p.t("otbi_column_ref")} WHERE table_name = ?
       GROUP BY db_column ORDER BY db_column${this.p.coll()}`, [table]);
    return rows.map((r) => ({ db_column: r.db_column, areas: Number(r.areas) }));
  }

  async factTablesOfArea(subjectArea: string): Promise<string[]> {
    const rows = await this.p.q<{ table_name: string }>(
      `SELECT table_name FROM (SELECT DISTINCT table_name FROM ${this.p.t("otbi_column_ref")} WHERE subject_area = ? AND folder_kind = 'fact') x
       ORDER BY table_name${this.p.coll()}`, [subjectArea]);
    return rows.map((r) => r.table_name);
  }

  async vosOfTableInArea(table: string, subjectArea: string): Promise<T.OtbiVoRow[]> {
    return this.p.q<T.OtbiVoRow>(
      `SELECT ${VO_COLS} FROM ${this.p.t("otbi_vo")} WHERE subject_area = ? AND db_objects LIKE ? ESCAPE '\\'
       ORDER BY folder${this.p.coll()}, vo_path${this.p.coll()}, vo_def${this.p.coll()}`, [subjectArea, jsonMember(table)]);
  }

  async areaDuties(subjectArea: string): Promise<T.OtbiAreaDutyRow[]> {
    return this.p.q<T.OtbiAreaDutyRow>(
      `SELECT ${DUTY_COLS} FROM ${this.p.t("otbi_area_duty")} WHERE subject_area = ? ORDER BY duty_code${this.p.coll()}`, [subjectArea]);
  }

  async areaJobs(subjectArea: string): Promise<T.OtbiAreaJobRow[]> {
    return this.p.q<T.OtbiAreaJobRow>(
      `SELECT ${JOB_COLS} FROM ${this.p.t("otbi_area_job")} WHERE subject_area = ? ORDER BY job_code${this.p.coll()}`, [subjectArea]);
  }

  async readTableNames(): Promise<string[]> {
    const rows = await this.p.q<{ table_name: string }>(
      `SELECT table_name FROM (SELECT DISTINCT table_name FROM ${this.p.t("otbi_column_ref")}) x ORDER BY table_name${this.p.coll()}`);
    return rows.map((r) => r.table_name);
  }

  async meta(): Promise<Record<string, string>> {
    const rows = await this.p.q<{ k: string; v: string }>(`SELECT k, v FROM ${this.p.t("otbi_meta")}`);
    return Object.fromEntries(rows.map((r) => [r.k, r.v]));
  }

  /** Portable pgvector shape; providers override (sqlite MATCH, pg `::vector`). */
  async knn(vec: Float32Array, k: number): Promise<T.OtbiVecHit[]> {
    return this.p.q<T.OtbiVecHit>(
      `SELECT text_hash, kind, embedding <-> ? AS distance FROM ${this.p.t("otbi_vec")} ORDER BY distance LIMIT ?`, [this.p.vec(vec), k]);
  }

  /** The columns behind a set of text hashes, at most `perHash` per hash (a column text is shared by
   *  every subject area that carries the column), optionally restricted to one subject area. */
  async columnsByHash(hashes: string[], subjectArea: string | undefined, perHash: number): Promise<T.OtbiColumnRow[]> {
    if (!hashes.length) return [];
    const sa = subjectArea ? " AND subject_area = ?" : "";
    return this.p.q<T.OtbiColumnRow>(
      `SELECT ${COLUMN_COLS} FROM (
         SELECT ${COLUMN_COLS}, ROW_NUMBER() OVER (PARTITION BY text_hash ORDER BY subject_area${this.p.coll()}, folder${this.p.coll()}) AS rn
         FROM ${this.p.t("otbi_column")} WHERE text_hash IN (${ph(hashes.length)})${sa}) x
       WHERE rn <= ? ORDER BY subject_area${this.p.coll()}, folder${this.p.coll()}, name${this.p.coll()}`,
      subjectArea ? [...hashes, subjectArea, perHash] : [...hashes, perHash]);
  }

  async foldersByHash(hashes: string[], subjectArea: string | undefined): Promise<T.OtbiFolderRow[]> {
    if (!hashes.length) return [];
    const sa = subjectArea ? " AND subject_area = ?" : "";
    return this.p.q<T.OtbiFolderRow>(
      `SELECT ${FOLDER_COLS} FROM ${this.p.t("otbi_folder")} WHERE text_hash IN (${ph(hashes.length)})${sa} ORDER BY subject_area${this.p.coll()}, name${this.p.coll()}`,
      subjectArea ? [...hashes, subjectArea] : hashes);
  }

  async subjectAreasByHash(hashes: string[]): Promise<T.OtbiSubjectAreaRow[]> {
    if (!hashes.length) return [];
    return this.p.q<T.OtbiSubjectAreaRow>(`SELECT ${SA_COLS} FROM ${this.p.t("otbi_subject_area")} WHERE text_hash IN (${ph(hashes.length)}) ORDER BY name${this.p.coll()}`, hashes);
  }

  async counts(): Promise<T.OtbiCounts> {
    const one = async (table: Parameters<BaseProvider["t"]>[0]) => Number((await this.p.q<{ c: number }>(`SELECT COUNT(*) c FROM ${this.p.t(table)}`))[0]?.c ?? 0);
    const [subjectAreas, folders, columns, vectors, vos, columnRefs, areaDuties, areaJobs] = await Promise.all([
      one("otbi_subject_area"), one("otbi_folder"), one("otbi_column"), one("otbi_vec"), one("otbi_vo"), one("otbi_column_ref"), one("otbi_area_duty"),
      one("otbi_area_job")]);
    return { subjectAreas, folders, columns, vectors, vos, columnRefs, areaDuties, areaJobs };
  }

  async version(): Promise<string | null> {
    const rows = await this.p.q<{ v: string }>(`SELECT v FROM ${this.p.t("otbi_meta")} WHERE k='version'`);
    return rows[0]?.v ?? null;
  }

  async replaceAll(sas: T.OtbiSubjectAreaRow[], folders: T.OtbiFolderRow[], columns: T.OtbiColumnRow[], vecs: T.OtbiVecRow[], version: string,
    lineage: T.OtbiLineageInput): Promise<T.OtbiCounts> {
    // the exposure index, derived exactly as p5_otbi.sql derives it: one row per (column, distinct (table, column) ref)
    const kindOf = new Map(folders.map((f) => [`${f.subject_area}\u0000${f.name}`, f.kind]));
    const refs = new Map<string, T.OtbiColumnRefRow>();
    for (const c of columns) {
      if (!c.db_refs) continue;
      const kind = kindOf.get(`${c.subject_area}\u0000${c.folder}`);
      if (!kind) throw new Error(`otbi column ${c.subject_area} / ${c.folder} / ${c.name} names a folder the folders list lacks`);
      for (const r of JSON.parse(c.db_refs) as { t: string; c: string; src?: string[] }[]) {
        const key = [c.subject_area, c.folder, c.name, r.t, r.c].join("\u0000");
        const prev = refs.get(key);
        const src = [...new Set([...(prev ? prev.src.split(",") : []), ...(r.src ?? [])])].sort().join(",");
        refs.set(key, { subject_area: c.subject_area, folder: c.folder, folder_kind: kind, column_name: c.name, table_name: r.t, db_column: r.c, src,
          via_expression: c.expression && c.expression.trim() ? 1 : 0 });
      }
    }
    await this.p.tx(async () => {
      await this.p.exec(`DELETE FROM ${this.p.t("otbi_vec")}; DELETE FROM ${this.p.t("otbi_column_ref")}; DELETE FROM ${this.p.t("otbi_vo")}; DELETE FROM ${this.p.t("otbi_area_duty")};
        DELETE FROM ${this.p.t("otbi_area_job")};
        DELETE FROM ${this.p.t("otbi_column")}; DELETE FROM ${this.p.t("otbi_folder")}; DELETE FROM ${this.p.t("otbi_subject_area")}; DELETE FROM ${this.p.t("otbi_meta")};`);
      for (const r of sas) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_subject_area")} (${SA_COLS}) VALUES (${ph(10)})`,
          [r.name, r.pillar, r.n_folders, r.n_fact_folders, r.n_columns, r.fact_folders, r.in_lineage, r.in_crawl, r.in_corpus, r.text_hash]);
      }
      for (const r of folders) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_folder")} (${FOLDER_COLS}) VALUES (${ph(17)})`,
          [r.subject_area, r.name, r.kind, r.kind_source, r.description, r.desc_source, r.db_tables, r.n_columns, r.n_measures,
           r.in_lineage, r.in_crawl, r.in_corpus, r.unit_id, r.grain_note, r.nested, r.ordinal, r.text_hash]);
      }
      for (const r of columns) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_column")} (${COLUMN_COLS}) VALUES (${ph(18)})`,
          [r.subject_area, r.folder, r.name, r.data_type, r.kind, r.aggregation, r.expression, r.db_refs, r.vo_refs, r.indexed, r.description,
           r.desc_source, r.gap_cause, r.in_lineage, r.in_crawl, r.in_probe, r.ordinal, r.text_hash]);
      }
      for (const v of vecs) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_vec")} (text_hash, kind, embedding) VALUES (?, ?, ?)`, [v.text_hash, v.kind, this.p.vec(v.vec)]);
      }
      for (const r of refs.values()) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_column_ref")} (${REF_COLS}) VALUES (${ph(8)})`,
          [r.subject_area, r.folder, r.folder_kind, r.column_name, r.table_name, r.db_column, r.src, r.via_expression]);
      }
      for (const v of lineage.vos) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_vo")} (${VO_COLS}) VALUES (${ph(6)})`, [v.subject_area, v.folder, v.vo_path, v.vo_def, v.db_objects, v.vo_attrs]);
      }
      for (const d of lineage.areaDuties) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_area_duty")} (${DUTY_COLS}) VALUES (${ph(7)})`,
          [d.subject_area, d.duty_code, d.duty_name, d.guide, d.guide_release, d.matched_by, d.guide_area]);
      }
      for (const j of lineage.areaJobs) {
        await this.p.run(`INSERT INTO ${this.p.t("otbi_area_job")} (${JOB_COLS}) VALUES (${ph(5)})`, [j.subject_area, j.job_code, j.job_name, j.matched_by, j.guide]);
      }
      await this.p.run(`INSERT INTO ${this.p.t("otbi_meta")} (k, v) VALUES ('version', ?), ('guide_release', ?), ('area_duty_unmapped', ?)`,
        [version, lineage.guideRelease, JSON.stringify(lineage.unmappedAreas)]);
    });
    return { subjectAreas: sas.length, folders: folders.length, columns: columns.length, vectors: vecs.length, vos: lineage.vos.length,
      columnRefs: refs.size, areaDuties: lineage.areaDuties.length, areaJobs: lineage.areaJobs.length };
  }
}
