import { BaseSchema } from "../base/schema.js";
import type * as T from "../types.js";
import type { PostgresProvider } from "./provider.js";

/**
 * Schema catalog on Postgres. Two overrides:
 *  - `searchTables`: FTS5 → the STORED `tables.search` tsvector (weights name A / module B /
 *    remarks C, `'simple'` config) + GIN.
 *  - `bulkLoad`: COPY FROM STDIN for the append-only targets; `tables` keeps its upsert (the
 *    "FUSION row wins" rule is a statement, not a stream).
 */
export class PgSchema extends BaseSchema {
  constructor(protected p: PostgresProvider) { super(p); }

  /**
   * FTS5 parity: `AP_INVOICES_ALL*` is a PHRASE of the underscore-split tokens with a prefix on the
   * last one, so each caller token becomes `ap <-> invoices <-> all:*`; tokens are joined by `&`
   * (AND) or `|` (OR), exactly as catalog.ts asks for them.
   *
   * Ranking is NOT bm25: `ts_rank(search, q, 1)` scores weight × frequency, length-normalized —
   * measured as the closest of the pg rankings to FTS5's bm25 order (`ts_rank_cd` adds cover
   * density, which reorders multi-word queries much more). The exact-name boost fixes the case
   * that matters: a query whose tokens rejoin into a real table name puts that table first
   * (`AP_INVOICES_ALL` ranked 4th behind `AP_INVOICES_ALL_` on FTS5). Below the boost the two
   * engines still order differently for multi-word queries — a documented delta; the MATCH SET is
   * the same, only the slice that survives `LIMIT` can differ.
   */
  async searchTables(tokens: string[], mode: "and" | "or", limit: number): Promise<T.TableHit[]> {
    const terms = tokens.map(tsTerm).filter(Boolean);
    if (!terms.length) return [];
    const query = terms.join(mode === "and" ? " & " : " | ");
    const exact = tokens.join("_").toUpperCase();
    // OR queries only: how MANY of the terms a row matches outranks how strongly it matches one of
    // them. Without it a row carrying just the commonest word in its NAME (weight A) beats a row
    // carrying the two rare words in its remarks (weight C) — bm25 avoids that through IDF, which
    // ts_rank has no notion of. Under AND every row matches every term, so the term is constant.
    const hits = mode === "or" && terms.length > 1
      ? terms.map(() => `(t.search @@ to_tsquery('simple', ?))::int`).join(" + ")
      : null;
    return this.p.q<T.TableHit>(
      `SELECT t.name, t.type, t.module, t.remarks
       FROM ${this.p.t("tables")} t, to_tsquery('simple', ?) q
       WHERE t.search @@ q
       ORDER BY (t.name = ?) DESC, ${hits ? `(${hits}) DESC, ` : ""}ts_rank(t.search, q, 1) DESC, LENGTH(t.name), t.name COLLATE "C"
       LIMIT ?`, hits ? [query, exact, ...terms, limit] : [query, exact, limit]);
  }

  async bulkLoad(table: T.SchemaLoadTable, rows: unknown[]): Promise<number> {
    if (!rows.length) return 0;
    if (table === "tables") return super.bulkLoad(table, rows); // upsert semantics, not a stream
    const [schema] = this.p.schemasOf(PHYSICAL[table]);
    return this.p.copyIn(schema, PHYSICAL[table], COLS[table], rows.map((r) => COPY_ROW[table](r)));
  }
}

/** `AP_INVOICES_ALL` → `ap <-> invoices <-> all:*` (empty when the token holds no lexeme). */
function tsTerm(token: string): string {
  const lex = token.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (!lex.length) return "";
  return lex.map((l, i) => (i === lex.length - 1 ? `${l}:*` : l)).join(" <-> ");
}

const PHYSICAL = {
  columns: "columns", pkeys: "pkeys", fkeys: "fkeys", indexes: "indexes",
  relationships_mined: "relationships", relationships_otbi: "relationships", tables: "tables",
} as const;

const COLS: Record<T.SchemaLoadTable, string[]> = {
  tables: ["name", "schema", "type", "module", "remarks", "view_text"],
  columns: ["table_name", "name", "data_type", "size", "nullable", "remarks", "ordinal"],
  pkeys: ["table_name", "column_name", "seq"],
  fkeys: ["child_table", "parent_table", "column_name", "seq", "name"],
  indexes: ["table_name", "index_name", "is_unique", "ordinal", "column_name"],
  relationships_mined: ["from_table", "from_col", "to_table", "to_col", "evidence", "occurrences", "confidence", "source"],
  relationships_otbi: ["from_table", "from_col", "to_table", "to_col", "predicate", "source"],
};

/** The constant `source` the sqlite INSERTs carry becomes a column value in the COPY stream. */
const COPY_ROW: Record<T.SchemaLoadTable, (r: unknown) => unknown[]> = {
  tables: (r) => r as unknown[],
  columns: (r) => r as unknown[],
  pkeys: (r) => r as unknown[],
  fkeys: (r) => r as unknown[],
  indexes: (r) => r as unknown[],
  relationships_mined: (r) => [...(r as unknown[]), "mined"],
  relationships_otbi: (r) => [...(r as unknown[]), "otbi"],
};
