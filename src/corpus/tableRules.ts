/**
 * Curated table rules — the human-override layer for facts the schema AND the corpus can't provide
 * (G1/G8). The motivating case: on this tenant DOO_HEADERS_ALL is safely deduped by
 * `submitted_flag='Y'` — a fact that appears in ~17 of ~98,000 queries and 0 extracted fields, so it
 * is neither mineable nor retrievable. A human records it here once and every grounding call reflects it.
 *
 * Lives in its OWN facts.sqlite on the data volume — NEVER part of a seed, so a schema-version bump
 * (which full-replaces schema.sqlite) can't wipe it (closes G10). Storage: `db().rules`.
 * Precedence: curated OVERRIDES derived (schema) and mined.
 */
import { db, type TableRule, type UpsertArgs, type RuleKind } from "../db/index.js";

export type { TableRule, UpsertArgs, RuleKind };

/** Insert a new curated rule, or update an existing one when `id` is given. Returns the saved rule. */
export async function upsertTableRule(a: UpsertArgs, nowIso: string): Promise<TableRule> {
  return db().rules.upsert(a, nowIso);
}

export async function deleteTableRule(id: number): Promise<{ deleted: boolean }> {
  return { deleted: await db().rules.delete(id) };
}

/** Enabled curated rules for a table (case-insensitive), newest first. */
export async function getTableRules(table: string): Promise<TableRule[]> {
  return db().rules.forTable(table);
}

/** List rules (optionally for one table), including disabled — for management/UI. */
export async function listTableRules(table?: string): Promise<TableRule[]> {
  return db().rules.list(table);
}
