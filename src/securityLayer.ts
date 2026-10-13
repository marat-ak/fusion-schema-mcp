/**
 * LOADER of the per-instance data-access security layer (customer.sec_instance_* on Postgres,
 * factsdb on sqlite) — an ADMIN ACTION, never boot. Ingests the six result sets exported from ONE
 * pod with the documented read-only SQL (scripts/pipeline/README.md, "The customer security
 * layer"): objects (FND_OBJECTS registrations + key columns), privileges (every granted
 * (object, privilege) with the grant-set signature), u (the pairs granted to the BI server identity,
 * same signature), duties (the FBI / analysis-duty pairs, same signature), aliases (the customer
 * copies of those duties → the seeded duty each copies), role_grants (v4: every (role, object,
 * privilege) of the seeded job / abstract / discretionary roles — the job-role consensus). NAMES
 * ONLY: no predicate text and no pod id are read or stored.
 *
 *   node dist/securityLayer.js --instance <pod host> --stamp <export stamp> --dir <dir> --grantee <role>
 *
 * Every argument is REQUIRED (no default instance, no default stamp): `instance` is the pod host
 * exactly as runSql reports `instance`; `dir` holds the runSql JSON replies saved page by page as
 * objects-<n>.json, privileges-<n>.json, u-<n>.json, duties-<n>.json, aliases-<n>.json, role_grants-<n>.json (n = 1..N,
 * the page order of the documented OFFSET … FETCH paging; an empty result is still one page);
 * `grantee` names the role whose grants the `u` pages were exported for (recorded with the layer).
 * Each file must have been exported from THAT instance (its `instance` field is checked), carry every
 * row inline (`rows.length == rowCount`, no `rowsInline` marker) and pages must not overlap; the pages
 * must agree with each other (one export moment): every U / duty pair is a granted pair with the SAME
 * signature, every alias names a duty of the duty pages, every role grant is a granted pair. The DB is
 * the service's own configuration (CATALOG_DB + DATABASE_URL / the sqlite files); on Postgres the
 * library migrations are applied first (the layer tables are migrations v2 + v3 + v4). Idempotent: a re-import replaces the instance's
 * layer in one transaction and records the new stamp.
 */
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { configFromEnv, openCatalogDb, closeCatalogDb, db } from "./db/index.js";
import type { SecLayerInput } from "./db/types.js";

type Reply = { instance?: string; rows?: Record<string, unknown>[]; rowCount?: number; rowsInline?: number; fileId?: string };

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  if (!v || v.startsWith("--")) throw new Error(`--${name} is required (no default)`);
  return v;
}

const str = (r: Record<string, unknown>, col: string, file: string): string => {
  const v = r[col];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${file}: a row lacks ${col}: ${JSON.stringify(r)}`);
  return v.trim();
};
const opt = (r: Record<string, unknown>, col: string): string | null => {
  const v = r[col];
  return typeof v === "string" && v.trim() ? v.trim().toUpperCase() : null;
};
const num = (r: Record<string, unknown>, col: string, file: string): number => {
  const v = r[col];
  if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${file}: a row lacks numeric ${col}: ${JSON.stringify(r)}`);
  return v;
};

/** The pages of one kind, in page order, every page verified; the concatenated rows. */
function pages(dir: string, kind: string, instance: string, cols: string[]): Record<string, unknown>[] {
  const files = fs.readdirSync(dir).filter((f) => new RegExp(`^${kind}-\\d+\\.json$`).test(f))
    .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]));
  if (!files.length) throw new Error(`${dir}: no ${kind}-<n>.json page — export it first (scripts/pipeline/README.md, "The customer security layer")`);
  files.forEach((f, i) => { if (Number(f.match(/\d+/)![0]) !== i + 1) throw new Error(`${dir}: ${kind} pages are not 1..N (found ${files.join(", ")})`); });
  const out: Record<string, unknown>[] = [];
  for (const f of files) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")) as Reply;
    if (j.instance !== instance) throw new Error(`${f} was exported from ${j.instance ?? "(no instance field)"}, not ${instance} — refusing to mix pods`);
    if (!Array.isArray(j.rows) || j.rows.length !== j.rowCount) throw new Error(`${f}: rows (${j.rows?.length ?? 0}) do not match rowCount (${j.rowCount}) — the reply is not complete inline`);
    if (j.rowsInline !== undefined || j.fileId !== undefined) throw new Error(`${f}: the reply was spilled to a session file (rowsInline/fileId present) — page smaller`);
    for (const c of cols) if (j.rows.length && !(c in j.rows[0])) throw new Error(`${f}: column ${c} missing — export with the documented SQL (aliases matter)`);
    out.push(...j.rows);
  }
  return out;
}

function unique<T>(rows: T[], key: (r: T) => string, what: string): T[] {
  const seen = new Set<string>();
  for (const r of rows) {
    const k = key(r);
    if (seen.has(k)) throw new Error(`${what}: ${k} appears twice across the pages — the paging overlapped (data changed between pages?); export again`);
    seen.add(k);
  }
  return rows;
}

/** Read + verify one export directory into the layer input (pure: no DB). */
export function readLayerDir(dir: string, instance: string, grantee: string): SecLayerInput {
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  const objects = unique(pages(dir, "objects", instance, ["OBJ_NAME", "DATABASE_OBJECT_NAME", "PK1_COLUMN_NAME"]).map((r) => ({
    obj_name: str(r, "OBJ_NAME", "objects"), database_object_name: str(r, "DATABASE_OBJECT_NAME", "objects"),
    pk1_column: opt(r, "PK1_COLUMN_NAME"), pk2_column: opt(r, "PK2_COLUMN_NAME"), pk3_column: opt(r, "PK3_COLUMN_NAME"),
    pk4_column: opt(r, "PK4_COLUMN_NAME"), pk5_column: opt(r, "PK5_COLUMN_NAME"),
  })), (o) => o.obj_name, "objects");
  const privileges = unique(pages(dir, "privileges", instance, ["OBJ_NAME", "PRIVILEGE", "GRANT_SIG", "N_GRANTS"]).map((r) => ({
    obj_name: str(r, "OBJ_NAME", "privileges"), privilege: str(r, "PRIVILEGE", "privileges"),
    grant_sig: String(num(r, "GRANT_SIG", "privileges")), n_grants: num(r, "N_GRANTS", "privileges"),
  })), (p) => `${p.obj_name}/${p.privilege}`, "privileges");
  const u = unique(pages(dir, "u", instance, ["OBJ_NAME", "PRIVILEGE", "INSTANCE_TYPE", "GRANT_SIG", "N_GRANTS"]).map((r) => ({
    obj_name: str(r, "OBJ_NAME", "u"), privilege: str(r, "PRIVILEGE", "u"), instance_type: str(r, "INSTANCE_TYPE", "u"),
    grant_sig: String(num(r, "GRANT_SIG", "u")), n_grants: num(r, "N_GRANTS", "u"),
  })), (x) => `${x.obj_name}/${x.privilege}/${x.instance_type}`, "u");
  const duties = unique(pages(dir, "duties", instance, ["DUTY_ROLE", "OBJ_NAME", "PRIVILEGE", "GRANT_SIG", "N_GRANTS"]).map((r) => ({
    duty_role: str(r, "DUTY_ROLE", "duties"), obj_name: str(r, "OBJ_NAME", "duties"), privilege: str(r, "PRIVILEGE", "duties"),
    grant_sig: String(num(r, "GRANT_SIG", "duties")), n_grants: num(r, "N_GRANTS", "duties"),
  })), (x) => `${x.duty_role}/${x.obj_name}/${x.privilege}`, "duties");
  const aliases = unique(pages(dir, "aliases", instance, ["DUTY_ROLE", "SEEDED_ROLE"]).map((r) => ({
    duty_role: str(r, "DUTY_ROLE", "aliases"), seeded_role: str(r, "SEEDED_ROLE", "aliases"),
  })), (x) => x.duty_role, "aliases");
  const roleGrants = unique(pages(dir, "role_grants", instance, ["ROLE_NAME", "OBJ_NAME", "PRIVILEGE"]).map((r) => ({
    role_name: str(r, "ROLE_NAME", "role_grants"), obj_name: str(r, "OBJ_NAME", "role_grants"), privilege: str(r, "PRIVILEGE", "role_grants"),
  })), (x) => `${x.role_name}/${x.obj_name}/${x.privilege}`, "role_grants");

  // every granted pair names a registered object; U and the duty map are subsets of the granted pairs and
  // carry the SAME grant-set signature (one export moment); every alias links two duties of the duty pages
  const objNames = new Set(objects.map((o) => o.obj_name));
  const sig = new Map(privileges.map((p) => [`${p.obj_name}/${p.privilege}`, p.grant_sig]));
  const dutyRoles = new Set(duties.map((x) => x.duty_role));
  const sigCheck = (what: string, x: { obj_name: string; privilege: string; grant_sig: string }) => {
    const s = sig.get(`${x.obj_name}/${x.privilege}`);
    return s === undefined ? `${what} ${x.obj_name}/${x.privilege} is not among the granted pairs`
      : s !== x.grant_sig ? `${what} ${x.obj_name}/${x.privilege} carries grant_sig ${x.grant_sig}, the privileges pages ${s}` : null;
  };
  const bad = [
    ...privileges.filter((p) => !objNames.has(p.obj_name)).map((p) => `privilege ${p.obj_name}/${p.privilege} names an object the objects pages lack`),
    ...u.map((x) => sigCheck("u pair", x)),
    ...duties.map((x) => sigCheck(`duty pair ${x.duty_role}`, x)),
    ...aliases.filter((a) => !dutyRoles.has(a.duty_role) || !dutyRoles.has(a.seeded_role) || a.duty_role === a.seeded_role)
      .map((a) => `alias ${a.duty_role} -> ${a.seeded_role} does not link two different duties of the duty pages`),
    ...roleGrants.filter((g) => !sig.has(`${g.obj_name}/${g.privilege}`))
      .map((g) => `role grant ${g.role_name} ${g.obj_name}/${g.privilege} is not among the granted pairs`),
  ].filter((m): m is string => !!m);
  if (bad.length) throw new Error(`the export is inconsistent (exported at different moments?):\n${bad.slice(0, 20).join("\n")}${bad.length > 20 ? `\n… ${bad.length} in all` : ""}`);
  return { grantee, objects, privileges, u, duties, aliases, roleGrants };
}

export async function main(): Promise<void> {
  const instance = arg("instance"), stamp = arg("stamp"), dir = arg("dir"), grantee = arg("grantee");
  const layer = readLayerDir(dir, instance, grantee);
  const cfg = configFromEnv();
  await openCatalogDb(cfg.provider === "postgres" ? { ...cfg, migrate: true } : cfg);
  try {
    const counts = await db().security.replaceLayer(instance, stamp, layer, new Date().toISOString());
    console.error(`[securityLayer] ${instance} stamp ${stamp} (grantee ${grantee}): objects ${counts.objects}, granted pairs ${counts.privileges} ` +
      `(${new Set(layer.privileges.map((x) => `${x.obj_name}/${x.grant_sig}`)).size} grant-set classes), ` +
      `u ${counts.u} (${new Set(layer.u.map((x) => x.obj_name)).size} objects), duty pairs ${counts.duties} (${new Set(layer.duties.map((x) => x.duty_role)).size} duties), ` +
      `duty aliases ${counts.aliases}, role grants ${counts.roleGrants} (${new Set(layer.roleGrants.map((x) => x.role_name)).size} roles)`);
  } finally {
    await closeCatalogDb();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => { console.error(`[securityLayer] ${e instanceof Error ? e.message : String(e)}`); process.exit(1); });
}
