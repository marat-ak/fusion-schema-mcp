/**
 * Curated table rules — the human-override layer for facts the schema AND the corpus can't provide
 * (G1/G8). The motivating case: on this tenant DOO_HEADERS_ALL is safely deduped by
 * `submitted_flag='Y'` — a fact that appears in ~17 of ~98,000 queries and 0 extracted fields, so it
 * is neither mineable nor retrievable. A human records it here once and every grounding call reflects it.
 *
 * Lives in its OWN facts.sqlite on the data volume — NEVER part of a seed, so a schema-version bump
 * (which full-replaces schema.sqlite) can't wipe it (closes G10). Idempotent self-migration at open.
 * Precedence: curated OVERRIDES derived (schema) and mined.
 */
import path from "node:path";
import Database from "better-sqlite3";
import { DATA_DIR } from "../dbPaths.js";

const FACTS_DB = process.env.FACTS_DB ?? path.join(DATA_DIR, "facts.sqlite");
const FACTS_VERSION = 1;

export type RuleKind = "grain" | "note" | "caveat";

export interface TableRule {
  id: number;
  table: string;
  scope: "table" | "column";
  column: string | null;
  kind: RuleKind;
  grain?: string | null;
  dedup?: string | null;
  body: string;
  author: string;
  source: "human" | "agent";
  enabled: boolean;
  updatedAt: string;
}

let _db: Database.Database | null = null;

/** Lazily open (creating + migrating) the curated facts DB. */
function fdb(): Database.Database {
  if (_db) return _db;
  const d = new Database(FACTS_DB);
  d.pragma("journal_mode = WAL");
  d.exec(`
    CREATE TABLE IF NOT EXISTS table_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      table_name  TEXT NOT NULL,
      scope       TEXT NOT NULL DEFAULT 'table',
      column_name TEXT,
      kind        TEXT NOT NULL,
      grain       TEXT,
      dedup       TEXT,
      body        TEXT,
      author      TEXT,
      source      TEXT NOT NULL DEFAULT 'human',
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT
    );
    CREATE INDEX IF NOT EXISTS ix_table_rules ON table_rules(table_name, enabled);
    CREATE TABLE IF NOT EXISTS facts_meta (k TEXT PRIMARY KEY, v TEXT);
  `);
  // idempotent forward-migration hook (guarded ALTERs go here as the shape evolves)
  d.prepare("INSERT INTO facts_meta (k,v) VALUES ('version',?) ON CONFLICT(k) DO UPDATE SET v=excluded.v").run(String(FACTS_VERSION));
  _db = d;
  return d;
}

function rowToRule(r: any): TableRule {
  return {
    id: r.id, table: r.table_name, scope: r.scope, column: r.column_name, kind: r.kind,
    grain: r.grain, dedup: r.dedup, body: r.body ?? "", author: r.author ?? "unknown",
    source: r.source ?? "human", enabled: !!r.enabled, updatedAt: r.updated_at ?? "",
  };
}

export interface UpsertArgs {
  id?: number;
  table: string;
  scope?: "table" | "column";
  column?: string | null;
  kind: RuleKind;
  grain?: string | null;
  dedup?: string | null;
  note?: string;
  author?: string;
  source?: "human" | "agent";
  enabled?: boolean;
}

/** Insert a new curated rule, or update an existing one when `id` is given. Returns the saved rule. */
export function upsertTableRule(a: UpsertArgs, nowIso: string): TableRule {
  const d = fdb();
  const table = a.table.toUpperCase();
  const scope = a.scope ?? (a.column ? "column" : "table");
  const column = a.column ? a.column.toUpperCase() : null;
  const enabled = a.enabled === false ? 0 : 1;
  if (a.id != null) {
    d.prepare(
      `UPDATE table_rules SET table_name=?, scope=?, column_name=?, kind=?, grain=?, dedup=?, body=?,
         author=COALESCE(?,author), source=COALESCE(?,source), enabled=?, updated_at=? WHERE id=?`,
    ).run(table, scope, column, a.kind, a.grain ?? null, a.dedup ?? null, a.note ?? "",
      a.author ?? null, a.source ?? null, enabled, nowIso, a.id);
    return getRuleById(a.id)!;
  }
  const info = d.prepare(
    `INSERT INTO table_rules (table_name, scope, column_name, kind, grain, dedup, body, author, source, enabled, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
  ).run(table, scope, column, a.kind, a.grain ?? null, a.dedup ?? null, a.note ?? "",
    a.author ?? "unknown", a.source ?? "human", enabled, nowIso);
  return getRuleById(Number(info.lastInsertRowid))!;
}

export function getRuleById(id: number): TableRule | null {
  const r = fdb().prepare("SELECT * FROM table_rules WHERE id=?").get(id);
  return r ? rowToRule(r) : null;
}

export function deleteTableRule(id: number): { deleted: boolean } {
  const info = fdb().prepare("DELETE FROM table_rules WHERE id=?").run(id);
  return { deleted: info.changes > 0 };
}

/** Enabled curated rules for a table (case-insensitive), newest first. Safe if the DB has no rules. */
export function getTableRules(table: string): TableRule[] {
  try {
    const rows = fdb().prepare(
      "SELECT * FROM table_rules WHERE table_name=? AND enabled=1 ORDER BY updated_at DESC, id DESC",
    ).all(table.toUpperCase());
    return rows.map(rowToRule);
  } catch { return []; }
}

/** List rules (optionally for one table), including disabled — for management/UI. */
export function listTableRules(table?: string): TableRule[] {
  const d = fdb();
  const rows = table
    ? d.prepare("SELECT * FROM table_rules WHERE table_name=? ORDER BY id DESC").all(table.toUpperCase())
    : d.prepare("SELECT * FROM table_rules ORDER BY table_name, id DESC").all();
  return rows.map(rowToRule);
}
