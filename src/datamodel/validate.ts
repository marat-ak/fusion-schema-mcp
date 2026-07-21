/** Lightweight DataModelSpec validation, with optional table grounding via the catalog. */
import * as catalog from "../catalog.js";
import type { DataModelSpec } from "./build.js";

export interface Validation { ok: boolean; errors: string[]; warnings: string[] }

const FROM_JOIN = /\b(?:from|join)\s+([A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*)?)/gi;

export function validateSpec(spec: DataModelSpec): Validation {
  const errors: string[] = [], warnings: string[] = [];
  if (!spec?.name) errors.push("name is required");
  if (!spec?.datasets?.length) errors.push("at least one dataset is required");

  const dnames = new Set<string>();
  for (const d of spec.datasets ?? []) {
    if (!d.name) { errors.push("a dataset is missing 'name'"); continue; }
    if (dnames.has(d.name)) errors.push(`duplicate dataset name: ${d.name}`);
    dnames.add(d.name);
    if (!/\bselect\b/i.test(d.sql ?? "")) { errors.push(`dataset '${d.name}': sql must contain a SELECT`); continue; }

    // Ground FROM/JOIN identifiers against the Fusion catalog (warnings only — parser is heuristic,
    // may catch subquery aliases). Skip obvious aliases (already-seen short tokens).
    const tables = new Set<string>();
    let m: RegExpExecArray | null;
    while ((m = FROM_JOIN.exec(d.sql)) !== null) tables.add(m[1]);
    for (const t of tables) {
      try {
        const res: any = catalog.validateTable(t);
        if (res && res.exists === false) {
          const sug = res.suggestions?.length ? ` (did you mean ${res.suggestions[0]}?)` : "";
          warnings.push(`dataset '${d.name}': unknown table '${t}'${sug}`);
        }
      } catch { /* grounding is best-effort */ }
    }
  }

  const pnames = new Set<string>();
  for (const p of spec.parameters ?? []) {
    if (!p.name) errors.push("a parameter is missing 'name'");
    else if (pnames.has(p.name)) errors.push(`duplicate parameter: ${p.name}`);
    pnames.add(p.name);
  }

  return { ok: errors.length === 0, errors, warnings };
}
