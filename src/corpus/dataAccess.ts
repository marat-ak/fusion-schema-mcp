/**
 * Data-access security — the RESOLVER behind the pushed `dataSecurity` payload of the table tools, the
 * DEVELOPER plan (getDataAccessPredicate) and the END-USER plan (getSecuredQueryPlan) (spec
 * docs/superpowers/specs/2026-09-29-end-user-mode-design.md §7, analysis docs/data-access-otbi-match-2026-10-03.md,
 * plan 2026-10-04 "secured SQL as OTBI / REST do it": phase 1 = the TABLE-keyed developer plan, phase 2 = the
 * (subject area, VO entity) keying, the subject-area gate input and the column whitelist; revised phase 3 =
 * docs/data-access-replan-2026-10-05.md + the user decisions of 2026-10-05: the job-role consensus, the strictest of
 * candidates, the known area privilege over the module rule, the structural none rule, the filter-only columns and the
 * no-area policy of the end-user plan).
 *
 * NAMES ONLY, TWO LAYERS. The release ships what is the same on every pod: the context column →
 * reference object map (table_security; `is_primary` marks the ONE context the table-keyed plan
 * secures), the disallowed objects, the curated area → (object, privilege) rows (sec_area_privilege,
 * scoped to one instance host or '*', keyed to the (area, entity) their evidence names), sec_meta (context
 * order + each context's evidence objects, HCM prefixes, privilege-prefix aliases, the audited primary
 * contexts per name prefix, the sensitive objects) and the OTBI lineage (otbi_column_ref = which physical
 * columns each subject area exposes, otbi_vo = the view objects behind each folder, otbi_area_duty = the
 * duty role codes Oracle's TBI guides name per subject area, otbi_area_job = the JOB role codes they name per subject
 * area) and table_reference_family (the reference-data tables — lookup, translation, calendar, currency, territory —
 * by name pattern AND reference-shaped columns, each with its evidence). The INSTANCE layer (customer.sec_instance_*,
 * loaded by src/securityLayer.ts from the pod's own FND_OBJECTS + FND_GRANTS names) carries what differs per
 * pod: its registrations with their key columns, every granted (object, privilege) with its grant-set
 * signature, U = the pairs granted to the BI server identity, the FBI / analysis-duty pairs, the customer duty
 * copies and (v4) the (object, privilege) names the seeded job / abstract / discretionary roles hold. No predicate
 * text and no pod id exist here or anywhere in what is served: the condition is produced
 * on the TARGET pod, for the running user, by FND_DATA_SECURITY.GET_SECURITY_PREDICATE through pod-mcp
 * getSecurityPredicate — which also answers the plan's subject-area gate in the same call.
 *
 * The instance is a REQUIRED input wherever the layer is involved — the pod host exactly as runSql
 * reports `instance`; no default instance, no "one layer loaded ⇒ that one".
 *
 * MODE: developer (getDataAccessPredicate, the pushed payload) | end-user (getSecuredQueryPlan) — one resolution;
 * only the END-USER plan applies the strictest of candidates, reads `none` tables by the structural rule, and blocks
 * pool-2 picks and the business tables no subject area reads.
 *
 * Verdict per table, exactly one of:
 *  secured  ONE condition resolved — its object, its privilege(s) and a grade;
 *  blocked  FAIL CLOSED — the condition could not be resolved (ambiguous privileges, nothing granted on the
 *           object, not registered on the instance, a disallowed object, a curated conflict, an undecided
 *           context): nothing is guessed, there is no privilege-less ("any access") call;
 *  none     no context column and not a registered security object with grants — reference data, read
 *           directly (the developer plan). The END-USER plan reads it by the STRUCTURAL rule (user decision 1 of
 *           2026-10-05): readable unless it has a declared (fkeys, as the child) or mined (relationships, as the
 *           from side) relationship to secured data — a table with a context column, or a table the pod registers
 *           as a security object with grants; a reference-family member (table_reference_family) stays readable
 *           even then — a translation only while its base is not secured and no secured relationship goes through
 *           its key columns; grade structural, projected without a condition. A child of secured data that is no
 *           family member (POZ_SUPPLIERS) is blocked. A table NO subject area reads (user decision 6): a business
 *           table is never read by an end user (the plan names a `readInstead` equivalent when one exists); a
 *           reference-family none table is read by the same rule, every non-sensitive column.
 * KEYING:
 *  table  the table's own facts — the developer default and the pushed payload;
 *  area   OTBI's (subject area, VO entity): the table is read as that subject area reads it (it must be in
 *         the area's lineage, otbi_column_ref). Its registered object, or the ONE context whose reference
 *         entity the area binds, first that applies: a curated (area, entity) row naming the context's entity
 *         > the table's only context > the area's VO evidence (a VO of the area that reads the table joins the
 *         reference / evidence objects of exactly one of its contexts, sec_meta.context_evidence_refs) > the
 *         audited primary of the name prefix; otherwise blocked. Inside the context the column is the
 *         release's primary one (or the context's only column).
 * Route, first that applies:
 *  sensitive  a sensitive side table (sec_meta.sensitive_objects: national identifiers, passports, visas,
 *             driver licences, salary, supplier PII, bank accounts) is read ONLY through its own registered
 *             object and its own privilege(s) — it beats the duty map, U and the context;
 *  direct     the instance registers the table itself with a grant to the BI server identity (U) or an
 *             analysis duty (an OTBI-visible security point) — keyed by the registered key columns;
 *  reference  the context column (table keying: the PRIMARY one; a table with more than one context column
 *             only when its name prefix has an audited primary context, sec_meta.primary_audit, and its primary
 *             row IS that context; area keying: the context the area binds, above) through its reference
 *             object (NULL does not restrict: a nullable column gets `is null or …`);
 *  direct     (pool 2) a registered table with neither U / duty grants nor a context column, when its object
 *             carries any active grant on the instance.
 * Privilege of the resolved object, first that applies:
 *  1. a curated row (sec_area_privilege) — area keying: a row of the area keyed to the condition's entity, else
 *     ANY row of the area on the object (user decision 4: the area's KNOWN privilege beats the module rule for
 *     every table of the area on the same object), else the product's (tables.module) row; an exact area name
 *     before the business area it starts with; table keying: a row whose entity key is empty or names the
 *     condition's entity, of the table's product or one of its OTBI subject areas (exact, or the business area the
 *     name starts with; on the reference route only the areas the table is a FACT of, on the direct route any
 *     folder) — grade = the row's source (trace | inferred); it must carry a grant on the instance;
 *  2. the sensitive override (the table's own object): every listed privilege must carry a grant; two or more
 *     = anyOf, OR-ed inside ONE condition — grade sensitive;
 *  3. an HCM object: the duty map — area keying: the area's duties (otbi_area_duty, the guide code mapped to
 *     the pod's name: the code itself, else ORA_<code>_HCM, when the pod's layer carries it) plus the
 *     customer copies of those duties (sec_instance_duty_alias); table keying: the whole duty map, one
 *     grant-set class only — grade duty; never pool 2;
 *  4. U ∩ object, generic read / update / delete / insert excluded, filtered by the product prefix
 *     (+ sec_meta.privilege_prefix_aliases): the table's module, and on the area-keyed reference route also
 *     the modules of the area's fact tables (the area's product) — ONE grant-set class: grade rule;
 *  5. the JOB-ROLE CONSENSUS (area keying, non-HCM; user decision 5): the area's guide job roles (otbi_area_job)
 *     → the named privileges they hold on the object on the pod (customer.sec_instance_role_grant), restricted to
 *     U's named privileges when U holds any on the object, else to its granted pairs (pool 2); per grant-set class
 *     the number of holder job roles — the class every holder holds (unanimous), else a unique majority; a tie
 *     decides nothing — grade consensus. Placed by the validation data (2026-10-05): it never disagreed with the
 *     rule (82 / 0), so the rule stays first; it decides what the rule cannot (several classes, or none of the
 *     product's prefixes);
 *  6. the STRICTEST of candidates (END-USER only; user decision 3): several grant-set classes among U ∩ object ∩
 *     prefixes, no consensus, and the table's module is one of the area's own (fact) modules — one privilege per
 *     class, AND-ed inside the ONE condition (a row shows only when every candidate allows it) — grade strictest.
 *     When one candidate comes back (1=2) the table is empty for the user: "access cannot be confirmed for <table>
 *     (ambiguous privilege, you lack <privilege>)" — never "no data", never plain "no access". The area's known
 *     privilege on the object is applied by rule 1 before this step, so it is never missing from a strictest set;
 *     the developer plan blocks the ambiguity and lists the candidates;
 *  7. pool 2, only when U holds no named privilege of those prefixes on the object and no consensus decides: ALL
 *     granted pairs of the object on the pod by the same filter, accepted only when exactly ONE grant-set class
 *     remains — grade granted (not granted to the BI server identity: not OTBI-proven; the END-USER plan blocks it).
 * Equivalence = identical grant_sig (same grantees, instance types and instance-set NAMES ⇒ the same
 * predicate for every user): the lexicographically first name is used, the rest in `equivalentTo`, and
 * a pick of rule 3 or 4 from a class of several names is graded `equivalent`.
 * Always the isolated form, alias `sec$` (1,282 of 4,213 conditions name columns without
 * &TABLE_ALIAS — splicing them into a joined query is unsafe), inside ONE CTE per table instance over
 * the inner alias `t`, hinted INLINE:
 *   <alias>_sec as (select … t.* from <TABLE> t where t.<col> in (select sec$.<pk> from <object> sec$ where {PRED:<object>|<privilege>}))
 * (the END-USER plan projects the area's exposed columns (allowed) + the join keys (joinOnly) + the corpus filter
 * columns (filterOnly — table_predicates: usable in WHERE / JOIN, never selected; masked and masking-shape columns
 * excluded) instead of t.*) and the query reads `<alias>_sec <alias>` wherever it read `<TABLE> <alias>` (the
 * `rewrite` map).
 * Emitted Oracle text is lowercase-keyworded (the repo's SQL-placement gate reserves uppercase
 * statements for src/db); the pod-mcp side consumes `pairs`, the `{PRED:…}` slots and `gate`.
 */
import { db } from "../db/index.js";
import type { ReferenceFamilyRow, SecAreaPrivilegeRow, SecDutyAliasRow, SecInstanceObjectRow, TableSecurityRow } from "../db/types.js";
import { normName, suggestNames } from "../util.js";
import { nearestNames } from "./otbiLint.js";

/** the alias of the secured object inside its own subquery (spec §7 rule 3) */
export const SEC_ALIAS = "sec$";
/** the alias of the secured table inside its own CTE */
export const CTE_ALIAS = "t";
export type Verdict = "secured" | "blocked" | "none";
export type Route = "direct" | "reference";
/** what a plan is keyed on: the table's own facts, or OTBI's (subject area, VO entity) */
export type Keying = "table" | "area";
/** developer (getDataAccessPredicate, the pushed payload) | end-user (getSecuredQueryPlan) — see the module header */
export type Mode = "developer" | "end-user";
/** where a condition's (object, privilege) came from — one vocabulary for the plans and the payload; `structural` = an
 *  end-user none table read without a condition (the structural rule) */
export type Grade = "trace" | "inferred" | "rule" | "duty" | "granted" | "equivalent" | "sensitive" | "consensus" | "strictest" | "structural";
/** how several privileges of ONE condition combine: any (sensitive anyOf, OR-ed) | all (strictest, AND-ed) */
export type Combine = "any" | "all";
/** the grades a curated sec_area_privilege row may carry (p5_security.sql + the p6 gate enforce it) */
const CURATED_GRADES: ReadonlySet<string> = new Set(["trace", "inferred"]);

/** the generic CRUD privilege names — never a candidate of the rule (a GLOBAL grant on them is `(1=1)`) */
const GENERIC = new Set(["read", "update", "delete", "insert"]);
const IDENT = /^[A-Za-z][A-Za-z0-9_$#]{0,123}$/;
/** the hidden-column listing per table instance is capped (the CTE projection enforces the whole set) */
const HIDDEN_CAP = 60;
/** other subject areas offered to the gate as alternates (each reads every table of the query) */
const ALTERNATES = 5;
/** candidate subject areas listed when the end-user plan is called without subjectAreas */
const CANDIDATES = 10;
/** corpus join columns of a table admitted as join keys of the end-user projection */
const JOIN_COLUMNS = 12;

type Masked = { column: string; use: string };
interface SensitiveObject { object: string; privileges: string[]; masked: Masked[]; evidence: string }
interface PrimaryAudit { contexts: string[]; source: string; evidence: string }
interface SecMeta {
  contextOrder: string[]; hcmPrefixes: string[]; prefixAliases: Record<string, string[]>;
  /** name prefix → its audited primary context(s) (the only prefixes whose multi-context tables the table-keyed plan secures) */
  primaryAudit: Record<string, PrimaryAudit>;
  /** table → the own (object, privilege(s)) it is read through, plus its masked-column twins */
  sensitive: Record<string, SensitiveObject>;
  /** context → its reference object + evidence objects (a VO joining one of them evidences the context) */
  contextEvidenceRefs: Record<string, string[]>;
}

const META_KEYS = ["context_order", "context_evidence_refs", "hcm_prefixes", "privilege_prefix_aliases", "primary_audit", "sensitive_objects"];

/** sec_meta of the served catalog, or null when the facts are not built. Incomplete facts throw. */
async function secMeta(): Promise<SecMeta | null> {
  const m = await db().security.meta();
  if (!m.version) return null;
  const missing = META_KEYS.filter((k) => !m[k]);
  if (missing.length) throw new Error(`sec_meta (version ${m.version}) is missing ${missing.join(", ")} — rebuild the release with scripts/pipeline/p5_security.sh`);
  return {
    contextOrder: JSON.parse(m.context_order) as string[],
    hcmPrefixes: JSON.parse(m.hcm_prefixes) as string[],
    prefixAliases: JSON.parse(m.privilege_prefix_aliases) as Record<string, string[]>,
    primaryAudit: JSON.parse(m.primary_audit) as Record<string, PrimaryAudit>,
    sensitive: JSON.parse(m.sensitive_objects) as Record<string, SensitiveObject>,
    contextEvidenceRefs: JSON.parse(m.context_evidence_refs) as Record<string, string[]>,
  };
}

export interface Layer { instance: string; stamp: string; grantee: string }

/** The loaded layer of the instance — REQUIRED and known, or an error naming what is loaded. */
export async function requireLayer(instance: unknown): Promise<Layer> {
  const inst = typeof instance === "string" ? instance.trim() : "";
  if (!inst) throw new Error("`instance` is required: the pod host exactly as runSql reports `instance` — there is no default instance");
  const row = await db().security.layer(inst);
  if (!row) {
    const have = (await db().security.layers()).map((l) => l.instance);
    throw new Error(`no data-access security layer is loaded for ${inst} (loaded: ${have.length ? have.join(", ") : "none"}) — load it with scripts/pipeline/sec_layer_load.sh`);
  }
  return { instance: row.instance, stamp: row.stamp, grantee: row.grantee };
}

function ordered(rows: TableSecurityRow[], contextOrder: string[]): TableSecurityRow[] {
  const ord = (c: string) => { const i = contextOrder.indexOf(c); return i < 0 ? contextOrder.length : i; };
  return [...rows].sort((a, b) => b.is_primary - a.is_primary || ord(a.context) - ord(b.context) || (a.column_name < b.column_name ? -1 : a.column_name > b.column_name ? 1 : 0));
}

/** a curated row's area matches the subject area: the exact name, or the business area the name starts with */
const areaMatches = (rowArea: string, area: string) => rowArea === area || area.startsWith(`${rowArea} `);
const uniq = <T>(xs: T[]) => [...new Set(xs)];
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---- the subject area's duty codes (the gate input + the HCM area-duty route) ----------------------

/** One subject area's duty roles as the gate and the HCM privilege route need them. */
export interface AreaDuties {
  area: string;
  /** the area's codes as Oracle's TBI guide names them (admin-class roles excluded at build) */
  guideCodes: string[];
  /** the GATE input: the codes as the pod names them — HCM: the guide code, else ORA_<code>_HCM, when the pod's
   *  layer carries it; other pillars: the guide code verbatim. Empty = never held (the gate denies the area). */
  duties: string[];
  /** HCM guide codes the pod's layer carries under neither name */
  unmapped: string[];
  /** customer copies of the mapped duties (sec_instance_duty_alias) — the HCM privilege choice only, never the gate */
  copies: string[];
  hcm: boolean;
  /** why the area can never be held, when `duties` is empty */
  reason?: string;
}

/** Per-call memo of the area facts one plan reads repeatedly (one plan = one instance, one mode). */
class Ctx {
  private modules = new Map<string, Promise<string[]>>();
  private duties = new Map<string, Promise<AreaDuties>>();
  private jobs = new Map<string, Promise<string[]>>();
  private secured = new Map<string, Promise<boolean>>();
  private podDuties?: Promise<Set<string>>;
  private copies?: Promise<SecDutyAliasRow[]>;
  private otbiMeta?: Promise<Record<string, string>>;
  private stems?: Promise<Map<string, string[]>>;
  constructor(readonly layer: Layer, readonly mode: Mode) {}

  /** the area's guide JOB role codes (otbi_area_job) — the voters of the job-role consensus */
  areaJobs(area: string): Promise<string[]> {
    let p = this.jobs.get(area);
    if (!p) { p = db().otbi.areaJobs(area).then((rows) => uniq(rows.map((r) => r.job_code)).sort()); this.jobs.set(area, p); }
    return p;
  }

  /** secured data for the structural none rule: a table with a context column, or a table the pod registers as a
   *  security object with any active grant */
  securedTable(name: string): Promise<boolean> {
    let p = this.secured.get(name);
    if (!p) {
      p = (async () => {
        if ((await db().security.forTable(name)).length) return true;
        for (const r of await db().security.instanceObjectsForTable(this.layer.instance, name)) {
          if ((await db().security.grantedPairs(this.layer.instance, r.obj_name)).length) return true;
        }
        return false;
      })();
      this.secured.set(name, p);
    }
    return p;
  }

  /** every table some subject area reads, by name stem (the no-area `readInstead` candidates) */
  readStems(): Promise<Map<string, string[]>> {
    this.stems ??= db().otbi.readTableNames().then((names) => {
      const m = new Map<string, string[]>();
      for (const n of names) m.set(stemOf(n), [...(m.get(stemOf(n)) ?? []), n]);
      return m;
    });
    return this.stems;
  }

  /** the modules (tables.module) of the area's FACT tables — the area's product prefixes */
  areaModules(area: string): Promise<string[]> {
    let p = this.modules.get(area);
    if (!p) {
      p = (async () => {
        const out = new Set<string>();
        for (const t of await db().otbi.factTablesOfArea(area)) { const m = await db().schema.moduleOf(t); if (m) out.add(m); }
        return [...out].sort();
      })();
      this.modules.set(area, p);
    }
    return p;
  }

  areaDuties(area: string): Promise<AreaDuties> {
    let p = this.duties.get(area);
    if (!p) { p = this.computeDuties(area); this.duties.set(area, p); }
    return p;
  }

  private async computeDuties(area: string): Promise<AreaDuties> {
    const [rows, sa] = await Promise.all([db().otbi.areaDuties(area), db().otbi.subjectArea(area)]);
    if (!sa) throw new Error(`subject area "${area}" is not in the catalog`);
    const hcm = sa.pillar === "hcm";
    const guideCodes = uniq(rows.map((r) => r.duty_code)).sort();
    if (!guideCodes.length) {
      this.otbiMeta ??= db().otbi.meta();
      const raw = (await this.otbiMeta).area_duty_unmapped;
      if (raw === undefined) throw new Error("otbi_meta.area_duty_unmapped is missing — the served release predates ddl_version 9; rebuild it");
      const why = (JSON.parse(raw) as Record<string, string>)[area];
      if (!why) throw new Error(`subject area ${area} has no duty code and is not listed in otbi_meta.area_duty_unmapped — the served release is broken (the p6 gate forbids it); rebuild it`);
      return { area, guideCodes, duties: [], unmapped: [], copies: [], hcm, reason: why };
    }
    let duties = guideCodes;
    const unmapped: string[] = [];
    if (hcm) {
      this.podDuties ??= db().security.dutyRoles(this.layer.instance).then((r) => new Set(r));
      const pod = await this.podDuties;
      duties = [];
      for (const c of guideCodes) {
        if (pod.has(c)) duties.push(c);
        else if (pod.has(`ORA_${c}_HCM`)) duties.push(`ORA_${c}_HCM`);
        else unmapped.push(c);
      }
      duties = uniq(duties).sort();
    }
    this.copies ??= db().security.dutyAliases(this.layer.instance);
    const mapped = new Set(duties);
    const copies = uniq((await this.copies).filter((a) => mapped.has(a.seeded_role)).map((a) => a.duty_role)).sort();
    return { area, guideCodes, duties, unmapped, copies, hcm,
      ...(duties.length ? {} : { reason: `the HCM guide code(s) ${unmapped.join(", ")} of ${area} exist on ${this.layer.instance} under neither the guide's name nor ORA_<code>_HCM — unmapped, never held` }) };
  }
}

// ---- the facts of one table ------------------------------------------------------------------------

interface AreaKey { name: string; modules: string[] }
interface Facts {
  meta: SecMeta;
  table: string;
  /** the name prefix (primaryByPrefix / the primary audit key) */
  prefix: string;
  module: string | null;
  rows: TableSecurityRow[];
  disallowed: { reason: string } | null;
  /** the OTBI subject areas whose folders read the table (any folder kind — the table as a fact OR a dimension) */
  subjectAreas: string[];
  /** the subject areas whose FACT folders read the table (the areas the table is a fact of) */
  factSubjectAreas: string[];
  hcmTable: boolean;
  sensitive: SensitiveObject | null;
  /** the area keying (null = table-keyed): the subject area + the modules of its fact tables */
  area: AreaKey | null;
}

async function tableFacts(table: string, meta: SecMeta, area: AreaKey | null): Promise<Facts> {
  const [rows, disallowed, t, folders] = await Promise.all([
    db().security.forTable(table), db().security.disallowed(table), db().schema.getTable(table), db().otbi.foldersOfTable(table),
  ]);
  const amb = [...new Set(rows.filter((r) => r.confidence === "ambiguous").map((r) => r.column_name))];
  if (amb.length) {
    throw new Error(`${table}: unresolved data-access column(s) ${amb.join(", ")} in the served release — the p6 gate forbids that; rebuild the release (scripts/pipeline/p5_security.sql)`);
  }
  return {
    meta, table, prefix: table.split("_")[0], module: t?.module ?? null, rows: ordered(rows, meta.contextOrder), disallowed,
    subjectAreas: [...new Set(folders.map((f) => f.subject_area))],
    factSubjectAreas: [...new Set(folders.filter((f) => f.kind === "fact").map((f) => f.subject_area))],
    hcmTable: isHcm(table, meta),
    sensitive: meta.sensitive[table] ?? null,
    area,
  };
}

/** The subject areas a curated row may be matched against for this table and route on the TABLE keying: on
 *  the direct route the row names the table's OWN object, so any folder counts (the Item entity is secured even
 *  as a dimension); on the reference route the row speaks for the area's FACTS — a table that merely appears as
 *  a dimension of the area must not inherit the area's privilege on the reference object. */
const areasFor = (f: Facts, route: Route) => (route === "direct" ? f.subjectAreas : f.factSubjectAreas);

/** a context's entities: its reference object(s) on the table + its evidence objects (sec_meta.context_evidence_refs) */
const entitiesOf = (f: Facts, context: string) =>
  uniq([...f.rows.filter((r) => r.context === context && r.ref_object).map((r) => r.ref_object as string), ...(f.meta.contextEvidenceRefs[context] ?? [])]);

const isHcm = (name: string, meta: SecMeta) => meta.hcmPrefixes.includes(name.split("_")[0]);
const prefixOf = (privilege: string) => privilege.split("_")[0].toUpperCase();
const byName = <T extends { privilege: string }>(a: T, b: T) => (a.privilege < b.privilege ? -1 : a.privilege > b.privilege ? 1 : 0);
/** a name list for a reason text, capped (the count is always stated) */
const names = (xs: { privilege: string }[], cap = 12) =>
  xs.length <= cap ? xs.map((x) => x.privilege).join(", ") : `${xs.slice(0, cap).map((x) => x.privilege).join(", ")}, … (${xs.length} in all)`;

// ---- the privilege choice -------------------------------------------------------------------------

type Pair = { object: string; privilege: string };
type Choice =
  | { ok: true; privileges: string[]; combine: Combine; grade: Grade; evidence: string; equivalentTo?: string[] }
  | { ok: false; reason: string; candidates?: Pair[] };

/** Candidates → one equivalence class (identical grant sets) = the first by name, else the sorted list. */
function classes<T extends { privilege: string; grant_sig: string }>(cand: T[]): { one: T; rest: T[] } | { many: T[] } {
  const sorted = [...cand].sort(byName);
  return new Set(sorted.map((c) => c.grant_sig)).size === 1 ? { one: sorted[0], rest: sorted.slice(1) } : { many: sorted };
}

/** The curated rows that apply to the condition (module header, privilege order 1). */
function curatedRows(f: Facts, all: SecAreaPrivilegeRow[], entities: string[], route: Route): { rows: SecAreaPrivilegeRow[]; key: string } {
  const entityOk = (r: SecAreaPrivilegeRow) => !r.entity_table || entities.includes(r.entity_table);
  if (!f.area) {
    const areas = areasFor(f, route);
    return { rows: all.filter((r) => entityOk(r) && (r.area_or_product === f.module || areas.some((sa) => areaMatches(r.area_or_product, sa)))), key: "" };
  }
  // area keying: a row of the area keyed to the condition's entity first; else ANY row of the area on this object —
  // the area's KNOWN privilege beats the module rule for every table of the area on the same object (decision 4)
  const A = f.area.name;
  const inArea = all.filter((r) => areaMatches(r.area_or_product, A));
  const keyed = inArea.filter((r) => !!r.entity_table && entities.includes(r.entity_table));
  const tier = keyed.length ? keyed : inArea;
  const exact = tier.filter((r) => r.area_or_product === A);
  if (tier.length) return { rows: exact.length ? exact : tier, key: keyed.length ? " (area, entity)" : " (the area's known privilege on the object)" };
  return { rows: all.filter((r) => entityOk(r) && r.area_or_product === f.module), key: " (product)" };
}

/** The privilege order of the module header: curated > sensitive > HCM duty map > U ∩ product > pool 2. */
async function choosePrivilege(f: Facts, ctx: Ctx, object: string, entities: string[], hcm: boolean, route: Route): Promise<Choice> {
  const layer = ctx.layer;
  const { rows, key } = curatedRows(f, await db().security.areaPrivileges(object, layer.instance), entities, route);
  if (rows.length) {
    const privs = [...new Set(rows.map((r) => r.privilege))].sort();
    if (privs.length > 1) {
      return { ok: false, candidates: privs.map((privilege) => ({ object, privilege })),
        reason: `the curated rows that apply to ${f.table} disagree on the privilege of ${object}: ${rows.map((r) => `${r.area_or_product} → ${r.privilege} (${r.source})`).join("; ")} — no silent pick` };
    }
    const r = rows[0];
    if (!CURATED_GRADES.has(r.source)) throw new Error(`sec_area_privilege ${r.area_or_product} / ${object} carries source ${r.source}, not trace | inferred — the served release is broken; rebuild it`);
    if (!(await db().security.instancePrivilegeExists(layer.instance, object, r.privilege))) {
      return { ok: false, candidates: [{ object, privilege: r.privilege }],
        reason: `the curated privilege ${r.privilege} of ${object} (${r.area_or_product}, ${r.source}) carries no active grant on ${layer.instance}` };
    }
    return { ok: true, privileges: [r.privilege], combine: "any", grade: r.source as Grade, evidence: `curated row ${r.area_or_product}${key} (${r.source}): ${r.evidence}` };
  }
  if (f.sensitive && f.sensitive.object === object) return sensitiveChoice(f, layer, f.sensitive);
  return hcm ? dutyChoice(f, ctx, object) : ruleChoice(f, ctx, object, route);
}

async function sensitiveChoice(f: Facts, layer: Layer, s: SensitiveObject): Promise<Choice> {
  const missing: string[] = [];
  for (const p of s.privileges) if (!(await db().security.instancePrivilegeExists(layer.instance, s.object, p))) missing.push(p);
  if (missing.length) {
    return { ok: false, candidates: s.privileges.map((privilege) => ({ object: s.object, privilege })),
      reason: `${f.table} is sensitive — read only through ${s.object} / ${s.privileges.join(" | ")} — and ${missing.join(", ")} carr${missing.length === 1 ? "ies" : "y"} no active grant on ${layer.instance}` };
  }
  return { ok: true, privileges: [...s.privileges], combine: "any", grade: "sensitive",
    evidence: `sensitive object (sec_meta.sensitive_objects)${s.privileges.length > 1 ? ", any of the privileges (OR-ed in one condition)" : ""}: ${s.evidence}` };
}

async function ruleChoice(f: Facts, ctx: Ctx, object: string, route: Route): Promise<Choice> {
  const layer = ctx.layer;
  const u = await db().security.uPairs(layer.instance, object);
  const seen = new Map<string, { privilege: string; grant_sig: string }>();
  for (const p of u) if (!seen.has(p.privilege)) seen.set(p.privilege, { privilege: p.privilege, grant_sig: p.grant_sig });
  const uNamed = [...seen.values()].filter((p) => !GENERIC.has(p.privilege.toLowerCase())).sort(byName);
  // the product prefixes: the table's module; on the area-keyed reference route also the area's (its fact tables' modules)
  const areaMods = f.area && route === "reference" ? f.area.modules : [];
  const modules = uniq([...(f.module ? [f.module] : []), ...areaMods]);
  if (!modules.length) {
    return { ok: false, ...(uNamed.length ? { candidates: uNamed.map((p) => ({ object, privilege: p.privilege })) } : {}),
      reason: `${f.table} has no module in the catalog: the privilege of ${object} cannot be chosen by module prefix (${uNamed.length} named candidate(s) granted to ${layer.grantee})` };
  }
  const label = areaMods.length ? `module ${modules.join("/")} (the table's${f.module ? ` ${f.module}` : ""} + the fact modules of ${f.area!.name})` : `module ${f.module}`;
  const prefixes = uniq(modules.flatMap((m) => [m, ...(f.meta.prefixAliases[m] ?? [])]));
  const cand = uNamed.filter((p) => prefixes.includes(prefixOf(p.privilege)));
  // the job-role consensus decides what the rule cannot (area keying only: the area's guide job roles vote)
  const consensus = async (): Promise<Consensus | null> => (f.area ? consensusChoice(ctx, f.area.name, object, uNamed) : null);
  if (!cand.length) {
    const cons = await consensus();
    if (cons?.ok) return cons.choice;
    return pool2Choice(f, layer, object, prefixes, label, uNamed, cons ? cons.why : null);
  }
  const c = classes(cand);
  if ("one" in c) {
    return { ok: true, privileges: [c.one.privilege], combine: "any", grade: c.rest.length ? "equivalent" : "rule", ...(c.rest.length ? { equivalentTo: c.rest.map((r) => r.privilege) } : {}),
      evidence: c.rest.length
        ? `U ∩ ${object} for ${label}: ${cand.length} privileges with the identical grant set on ${layer.instance} — equivalent, ${c.one.privilege} chosen (first by name)`
        : `U ∩ ${object} for ${label}: the only named candidate granted to ${layer.grantee} on ${layer.instance}` };
  }
  const cons = await consensus();
  if (cons?.ok) return cons.choice;
  const amb = `${c.many.length} privileges of ${label} on ${object} granted to ${layer.grantee} with distinct grant sets on ${layer.instance} — ambiguous: ${names(c.many)}`;
  const consNote = cons ? `; the job-role consensus decides nothing (${cons.why})` : "";
  const candidates = c.many.map((p) => ({ object, privilege: p.privilege }));
  if (ctx.mode === "end-user") {
    if (f.area && f.module && f.area.modules.includes(f.module)) {
      // one privilege per grant-set class (identical signatures = the same predicate), AND-ed in the one condition
      const reps: { privilege: string; grant_sig: string }[] = [];
      for (const p of c.many) if (!reps.some((r) => r.grant_sig === p.grant_sig)) reps.push(p);
      return { ok: true, privileges: reps.map((p) => p.privilege), combine: "all", grade: "strictest",
        evidence: `strictest of candidates: ${amb}${consNote} — the ${reps.length} grant-set classes are AND-ed (${reps.map((p) => p.privilege).join(" AND ")}): ` +
          `a row shows only when the user holds every one; one (1=2) empties ${f.table} ("access cannot be confirmed — ambiguous privilege, you lack <privilege>")` };
    }
    return { ok: false, candidates,
      reason: `${amb}${consNote}; the strictest of candidates applies only to a table of ${f.area ? `${f.area.name}'s own modules (${f.area.modules.join("/") || "none"})` : "a subject area's own modules"}, ` +
        `and ${f.table} is ${f.module ? `a ${f.module} table` : "module-less"} — a foreign dimension of the area, not read` };
  }
  return { ok: false, candidates,
    reason: `${amb}${consNote}; a curated row (p5_security_rules.json areaPrivileges, scoped to this instance or *) or a LOGLEVEL-7 trace decides` };
}

type Consensus = { ok: true; choice: Choice } | { ok: false; why: string };

/** The job-role consensus of (subject area, object) on one pod, whatever the rule decides — the coverage report
 *  compares it with the rule's pick (scripts/pipeline/security_coverage_resolver.mts). */
export async function jobConsensus(instance: string, subjectArea: string, object: string): Promise<{ privilege: string; equivalentTo: string[]; evidence: string } | { why: string }> {
  const ctx = new Ctx(await requireLayer(instance), "developer");
  const seen = new Map<string, { privilege: string; grant_sig: string }>();
  for (const p of await db().security.uPairs(ctx.layer.instance, object)) if (!seen.has(p.privilege) && !GENERIC.has(p.privilege.toLowerCase())) seen.set(p.privilege, { privilege: p.privilege, grant_sig: p.grant_sig });
  const c = await consensusChoice(ctx, subjectArea, object, [...seen.values()]);
  if (!c.ok) return { why: c.why };
  const ch = c.choice as Extract<Choice, { ok: true }>;
  return { privilege: ch.privileges[0], equivalentTo: ch.equivalentTo ?? [], evidence: ch.evidence };
}

/** The job-role consensus (area keying, non-HCM; module header rule 5): the privileges the area's guide job roles hold
 *  on the object on the pod, U's when U holds any named privilege on the object (OTBI's privileges are the BI identity's),
 *  else the granted pairs; per grant-set class the holder job roles — unanimous, else a unique majority. */
async function consensusChoice(ctx: Ctx, A: string, object: string, uNamed: { privilege: string; grant_sig: string }[]): Promise<Consensus> {
  const layer = ctx.layer;
  const jobs = await ctx.areaJobs(A);
  if (!jobs.length) return { ok: false, why: `${A} names no guide job role (otbi_area_job)` };
  const held = new Map<string, Set<string>>();
  const holders = new Set<string>();
  for (const g of await db().security.roleGrants(layer.instance, object, jobs)) {
    if (GENERIC.has(g.privilege.toLowerCase())) continue;
    holders.add(g.role_name);
    held.set(g.privilege, (held.get(g.privilege) ?? new Set<string>()).add(g.role_name));
  }
  if (!holders.size) return { ok: false, why: `none of the ${jobs.length} guide job role(s) of ${A} holds a named privilege on ${object} on ${layer.instance}` };
  const fromU = uNamed.length > 0;
  const sig = new Map<string, string>(fromU
    ? uNamed.map((p) => [p.privilege, p.grant_sig] as [string, string])
    : (await db().security.grantedPairs(layer.instance, object)).map((p) => [p.privilege, p.grant_sig] as [string, string]));
  const src = fromU ? `U's named privileges (${layer.grantee})` : "the granted pairs (pool 2 — U holds no named privilege on the object)";
  const cand = [...held.keys()].filter((p) => sig.has(p)).sort();
  if (!cand.length) return { ok: false, why: `the ${holders.size} job role(s) of ${A} holding grants on ${object} hold none of ${src}` };
  const byClass = new Map<string, { names: string[]; jobs: Set<string> }>();
  for (const p of cand) {
    const k = sig.get(p) as string;
    const e = byClass.get(k) ?? { names: [], jobs: new Set<string>() };
    e.names.push(p);
    for (const j of held.get(p) as Set<string>) e.jobs.add(j);
    byClass.set(k, e);
  }
  const list = [...byClass.values()].sort((a, b) => b.jobs.size - a.jobs.size || (a.names[0] < b.names[0] ? -1 : 1));
  const n = holders.size;
  const unanimous = list.filter((e) => e.jobs.size === n);
  let pick: { names: string[]; jobs: Set<string> } | null = null;
  let how = "";
  if (unanimous.length === 1) { pick = unanimous[0]; how = `unanimous — all ${n} holder job role(s)`; }
  else if (list.length === 1 || list[0].jobs.size > list[1].jobs.size) { pick = list[0]; how = `majority — ${list[0].jobs.size} of ${n} holder job role(s), ${list.length} grant-set classes`; }
  if (!pick) {
    return { ok: false, why: `the ${n} holder job role(s) of ${A} split over ${list.length} classes of ${src} (${list.slice(0, 4).map((e) => `${e.names[0]} [${e.jobs.size}]`).join(", ")}) — a tie` };
  }
  return { ok: true, choice: { ok: true, privileges: [pick.names[0]], combine: "any", grade: "consensus", ...(pick.names.length > 1 ? { equivalentTo: pick.names.slice(1) } : {}),
    evidence: `job-role consensus of ${A} on ${object} on ${layer.instance}: ${pick.names[0]} — ${how}, among ${src}; voters = the ${jobs.length} job role(s) Oracle's TBI guides name for the area` } };
}

/** Pool 2: every granted pair of the object on the pod (any grantee), same prefix filter, ONE grant-set class only. */
async function pool2Choice(f: Facts, layer: Layer, object: string, prefixes: string[], label: string, uNamed: { privilege: string }[], consensusWhy: string | null): Promise<Choice> {
  const why = (uNamed.length
    ? `none of the ${uNamed.length} named privilege(s) granted to ${layer.grantee} on ${object} (${names(uNamed)}) belongs to ${label} (prefix ${prefixes.join("/")})`
    : `${object} carries no named grant to ${layer.grantee} on ${layer.instance}`) + (consensusWhy ? ` and the job-role consensus decides nothing (${consensusWhy})` : "");
  const all = (await db().security.grantedPairs(layer.instance, object)).filter((p) => !GENERIC.has(p.privilege.toLowerCase())).sort(byName);
  if (!all.length) return { ok: false, reason: `${why}, and no named privilege of ${object} carries an active grant on ${layer.instance} — no condition can be generated` };
  const cand = all.filter((p) => prefixes.includes(prefixOf(p.privilege)));
  if (!cand.length) {
    return { ok: false, candidates: all.slice(0, 20).map((p) => ({ object, privilege: p.privilege })),
      reason: `${why}; of all ${all.length} named privilege(s) granted on ${object} on ${layer.instance} (${names(all)}) none belongs to ${label} either — a curated row (p5_security_rules.json areaPrivileges) must name the pair` };
  }
  const c = classes(cand);
  if ("one" in c) {
    return { ok: true, privileges: [c.one.privilege], combine: "any", grade: "granted", ...(c.rest.length ? { equivalentTo: c.rest.map((r) => r.privilege) } : {}),
      evidence: `pool 2 (${why}): of all grants on ${object} on ${layer.instance}, ${c.one.privilege}${c.rest.length ? ` and ${c.rest.length} other name(s) with the identical grant set` : ""} = the only grant-set class of ${label} — not granted to the BI server identity, so not OTBI-proven` };
  }
  return { ok: false, candidates: c.many.map((p) => ({ object, privilege: p.privilege })),
    reason: `${why}; among all granted pairs on ${layer.instance}, ${c.many.length} privileges of ${label} on ${object} carry distinct grant sets — ambiguous: ${names(c.many)}; a curated row (p5_security_rules.json areaPrivileges) or a LOGLEVEL-7 trace decides` };
}

/** The HCM route: area keying = the area's duties (+ their customer copies); table keying = the whole duty map. */
async function dutyChoice(f: Facts, ctx: Ctx, object: string): Promise<Choice> {
  const layer = ctx.layer;
  const d = await db().security.dutyPairs(layer.instance, object);
  if (!d.length) return { ok: false, reason: `${object} is an HCM object and no FBI / analysis duty holds a privilege on it on ${layer.instance} — the duty map cannot secure ${f.table}` };
  const group = (rows: typeof d) => {
    const byPriv = new Map<string, { privilege: string; grant_sig: string; duties: string[] }>();
    for (const r of rows) {
      const e = byPriv.get(r.privilege) ?? { privilege: r.privilege, grant_sig: r.grant_sig, duties: [] };
      e.duties.push(r.duty_role);
      byPriv.set(r.privilege, e);
    }
    return [...byPriv.values()].sort(byName);
  };
  const pick = (cand: ReturnType<typeof group>, how: string): Choice | null => {
    const c = classes(cand);
    if (!("one" in c)) return null;
    return { ok: true, privileges: [c.one.privilege], combine: "any", grade: c.rest.length ? "equivalent" : "duty", ...(c.rest.length ? { equivalentTo: c.rest.map((r) => r.privilege) } : {}),
      evidence: `${how}: ${c.one.privilege} held by ${c.one.duties.length} dut${c.one.duties.length === 1 ? "y" : "ies"}${c.rest.length ? `, ${c.rest.length} other name(s) with the identical grant set` : ""}` };
  };
  const all = group(d);
  const listed = (xs: ReturnType<typeof group>) => xs.map((p) => `${p.privilege} [${p.duties.length}]`).join(", ");
  if (f.area) {
    const ad = await ctx.areaDuties(f.area.name);
    if (!ad.duties.length) return { ok: false, reason: `${f.table} is read in ${f.area.name}, whose duty roles cannot be named on ${layer.instance}: ${ad.reason} — the area-duty route cannot secure ${f.table}` };
    const held = new Set([...ad.duties, ...ad.copies]);
    const mine = group(d.filter((r) => held.has(r.duty_role)));
    const dutyList = `${ad.duties.join(", ")}${ad.copies.length ? ` + ${ad.copies.length} customer cop${ad.copies.length === 1 ? "y" : "ies"}` : ""}`;
    if (!mine.length) {
      return { ok: false, candidates: all.slice(0, 20).map((p) => ({ object, privilege: p.privilege })),
        reason: `none of the duties of ${f.area.name} (${dutyList}) holds a privilege on ${object} on ${layer.instance} (the duty map holds ${listed(all)}) — the area-duty route cannot secure ${f.table}` };
    }
    const p = pick(mine, `the duties of ${f.area.name} (Oracle TBI guide; ${dutyList}) on ${object} on ${layer.instance}`);
    if (p) return p;
    return { ok: false, candidates: mine.map((x) => ({ object, privilege: x.privilege })),
      reason: `the duties of ${f.area.name} (${dutyList}) hold ${mine.length} privileges with distinct grant sets on ${object} on ${layer.instance} (${listed(mine)}) — ambiguous; a curated row (p5_security_rules.json areaPrivileges) or a LOGLEVEL-7 trace decides` };
  }
  const whole = pick(all, `duty map of ${object} on ${layer.instance} (${new Set(d.map((x) => x.duty_role)).size} duties)`);
  if (whole) return whole;
  return { ok: false, candidates: all.map((p) => ({ object, privilege: p.privilege })),
    reason: `${object} carries ${all.length} privileges across the analysis duties on ${layer.instance} (${listed(all)}) — the table-keyed plan cannot choose among them; key the plan on the subject area the query reads (subjectArea: that area's duties from Oracle's TBI guides decide)` };
}

// ---- the context of a multi-context table ---------------------------------------------------------

type ContextPick = { row: TableSecurityRow; how: string } | { reason: string; column?: string; context?: string };

/** Table keying: the PRIMARY context; several context columns need the prefix's audited primary. */
function tableContext(f: Facts): ContextPick {
  const primary = f.rows.find((r) => r.is_primary === 1);
  if (!primary) return { reason: `${f.table} carries context columns but no primary one in the served release — broken facts (the p6 gate requires exactly one); rebuild the release` };
  if (f.rows.length === 1) return { row: primary, how: "" };
  const others = f.rows.filter((r) => r !== primary).map((r) => `${r.column_name} (${r.context})`).join(", ");
  const audit = f.meta.primaryAudit[f.prefix];
  const head = `${f.table} carries ${f.rows.length} context columns — the primary ${primary.column_name} (${primary.context}) and ${others}; the table-keyed plan secures the primary one only`;
  if (!audit) {
    return { column: primary.column_name, context: primary.context,
      reason: `${head}, which is allowed only for a name prefix whose primary context is audited — ${f.prefix} is not audited (sec_meta.primary_audit; p5_security_rules.json primaryByPrefix.${f.prefix}.audit needs an OTBI LOGLEVEL-7 trace); keyed on a subject area (subjectArea) the area may decide` };
  }
  if (!audit.contexts.includes(primary.context)) {
    return { column: primary.column_name, context: primary.context,
      reason: `${head}, and ${primary.context} is not the audited primary context of ${f.prefix} (${audit.contexts.join(" then ")}, ${audit.source})` };
  }
  return { row: primary, how: `primary context audited for ${f.prefix} (${audit.source}: ${audit.evidence}) — ${others} not applied, as OTBI does` };
}

/** Area keying: the ONE context whose reference entity the subject area binds (module header, KEYING). */
async function areaContext(f: Facts, layer: Layer): Promise<ContextPick> {
  const A = f.area!.name;
  const primary = f.rows.find((r) => r.is_primary === 1);
  if (!primary) return { reason: `${f.table} carries context columns but no primary one in the served release — broken facts (the p6 gate requires exactly one); rebuild the release` };
  const contexts = uniq(f.rows.map((r) => r.context));
  // the column a curated row of the area names for THIS table (TABLE.COLUMN — a LOGLEVEL-7 trace names it), per context
  const traced = new Map<string, Set<string>>();
  const rowOf = (context: string, how: string): ContextPick => {
    const inCtx = f.rows.filter((r) => r.context === context);
    const named = [...(traced.get(context) ?? [])];
    if (named.length > 1) {
      return { context, reason: `${f.table}: curated rows of ${A} name ${named.length} different ${context} columns of ${f.table} (${named.join(", ")}) — conflicting curation, no silent pick` };
    }
    const row = named.length ? (inCtx.find((r) => r.column_name === named[0]) ?? null) : primary.context === context ? primary : inCtx.length === 1 ? inCtx[0] : null;
    if (!row) {
      return { context, reason: `${f.table}: in ${A} the ${context} entity applies (${how}), but ${f.table} carries ${inCtx.length} ${context} columns (${inCtx.map((r) => r.column_name).join(", ")}) and none is the release's primary one — no silent pick` };
    }
    const skipped = f.rows.filter((r) => r !== row).map((r) => `${r.column_name} (${r.context})`);
    const which = named.length ? `; ${row.column_name} = the column the trace names` : inCtx.length > 1 ? `; ${row.column_name} = the release's primary of the ${inCtx.length} ${context} columns` : "";
    return { row, how: `entity of ${A}: ${how}${which}${skipped.length ? ` — ${skipped.join(", ")} not applied, as OTBI does` : ""}` };
  };
  // 1. a curated row of the area naming one context's entity, or naming one of its columns of this table
  const keyed = new Map<string, string[]>();
  for (const c of contexts) {
    const ents = entitiesOf(f, c);
    const cols = new Set(f.rows.filter((r) => r.context === c).map((r) => r.column_name));
    for (const o of uniq(f.rows.filter((r) => r.context === c && r.ref_object).map((r) => r.ref_object as string))) {
      for (const a of await db().security.areaPrivileges(o, layer.instance)) {
        if (!areaMatches(a.area_or_product, A)) continue;
        const col = a.context_column && a.context_column.startsWith(`${f.table}.`) ? a.context_column.slice(f.table.length + 1) : null;
        const namesCol = !!col && cols.has(col);
        if (namesCol) traced.set(c, new Set([...(traced.get(c) ?? []), col as string]));
        if (namesCol || (a.entity_table && ents.includes(a.entity_table))) {
          keyed.set(c, uniq([...(keyed.get(c) ?? []), `${a.area_or_product} → ${namesCol ? a.context_column : a.entity_table} (${a.source})`]));
        }
      }
    }
  }
  if (keyed.size === 1) { const [c, why] = [...keyed][0]; return rowOf(c, `curated (area, entity) row ${why.join("; ")}`); }
  if (keyed.size > 1) {
    return { column: primary.column_name, context: primary.context,
      reason: `${f.table}: curated (area, entity) rows of ${A} name the entities of ${keyed.size} of its contexts (${[...keyed].map(([c, w]) => `${c}: ${w.join("; ")}`).join(" | ")}) — conflicting curation, no silent pick` };
  }
  // 2. the table's only context
  if (contexts.length === 1) return rowOf(contexts[0], `the only context of ${f.table}`);
  // 3. the area's VO evidence: a VO reading the table joins the entities of exactly one context
  const vos = await db().otbi.vosOfTableInArea(f.table, A);
  const joined = new Map<string, string[]>();
  for (const v of vos) for (const o of JSON.parse(v.db_objects) as string[]) if (o !== f.table) joined.set(o, uniq([...(joined.get(o) ?? []), v.vo_def]));
  const evidenced = contexts.filter((c) => entitiesOf(f, c).some((o) => joined.has(o)));
  if (evidenced.length === 1) {
    const c = evidenced[0];
    const o = entitiesOf(f, c).find((x) => joined.has(x)) as string;
    const defs = joined.get(o) as string[];
    return rowOf(c, `VO evidence — ${defs.slice(0, 3).join(", ")}${defs.length > 3 ? ` (+${defs.length - 3})` : ""} of ${A} read${defs.length === 1 ? "s" : ""} ${f.table} with ${o}`);
  }
  // 4. the audited primary of the name prefix
  const audit = f.meta.primaryAudit[f.prefix];
  if (audit && audit.contexts.includes(primary.context)) return rowOf(primary.context, `the audited primary context of ${f.prefix} (${audit.source}: ${audit.evidence})`);
  return { column: primary.column_name, context: primary.context,
    reason: `${f.table} carries ${contexts.length} contexts (${contexts.join(", ")}) and ${A} decides none of them: no curated (area, entity) row names one, ` +
      (vos.length ? `the area's ${vos.length} VO(s) reading ${f.table} join ${evidenced.length ? `the entities of several (${evidenced.join(", ")})` : "none of their entities"}` : `no VO of the area reads ${f.table} in the lineage`) +
      `, and ${audit ? `the audited primary of ${f.prefix} (${audit.contexts.join(" then ")}) is not ${primary.context}` : `${f.prefix} has no audited primary context`} — an OTBI LOGLEVEL-7 trace or a curated (area, entity) row decides` };
}

// ---- the resolution of one table -------------------------------------------------------------------

export interface Condition {
  /** the context column (reference route); null on the direct route */
  column: string | null;
  context: string | null;
  route: Route;
  /** FND_OBJECTS.OBJ_NAME the condition is generated on (the API input) */
  object: string;
  /** the registered database object the isolated subquery selects from */
  dbObject: string;
  /** the subquery's key column(s) (reference: the reference key; direct: the registered key columns) */
  pk: string[];
  /** the table's column(s) compared to them */
  joinColumns: string[];
  nullable: boolean;
  /** one privilege, or several: combine any = anyOf (OR-ed, sensitive) | all = the strictest (AND-ed) inside the one condition */
  privileges: string[];
  combine: Combine;
  grade: Grade;
  evidence: string;
  equivalentTo?: string[];
}
export interface Blocked { column?: string; context?: string; object?: string; reason: string; candidates?: Pair[] }
export interface Resolution {
  table: string; hcm: boolean; verdict: Verdict; keying: Keying;
  /** area keying: the subject area the table was resolved in */
  subjectArea: string | null;
  /** the ONE condition of a secured table (null otherwise) */
  condition: Condition | null;
  blocked: Blocked[];
  reason: string | null;
  /** the raw columns that must never be selected, with the masked twin to read instead (sensitive facts) */
  masked: Masked[];
}

async function resolveTable(f: Facts, ctx: Ctx): Promise<Resolution> {
  const layer = ctx.layer;
  const hcmObj = (o: SecInstanceObjectRow) => f.hcmTable || isHcm(o.obj_name, f.meta) || isHcm(o.database_object_name, f.meta);
  let condition: Condition | null = null;
  const blocked: Blocked[] = [];
  const finish = (reason: string | null = null): Resolution => ({
    table: f.table, verdict: blocked.length ? "blocked" : condition ? "secured" : "none", keying: f.area ? "area" : "table", subjectArea: f.area?.name ?? null,
    condition: blocked.length ? null : condition, blocked, reason,
    hcm: f.hcmTable || (!!condition && isHcm(condition.object, f.meta)) || blocked.some((b) => !!b.object && isHcm(b.object, f.meta)),
    masked: f.sensitive?.masked ?? [],
  });
  /** the registered object keyed by its own key columns (sensitive / direct / pool 2) */
  const direct = async (obj: SecInstanceObjectRow): Promise<Resolution> => {
    const pk = [obj.pk1_column, obj.pk2_column, obj.pk3_column, obj.pk4_column, obj.pk5_column].filter((c): c is string => !!c);
    if (!pk.length) {
      blocked.push({ object: obj.obj_name, reason: `${obj.obj_name} has no key column registered in FND_OBJECTS on ${layer.instance}: the isolated form cannot be keyed` });
      return finish();
    }
    const cols = new Set((await db().schema.columns(f.table)).map((c) => c.name));
    const missing = pk.filter((c) => !cols.has(c));
    if (missing.length) {
      blocked.push({ object: obj.obj_name, reason: `the registered key column(s) ${missing.join(", ")} of ${obj.obj_name} are not columns of ${f.table} — the direct form cannot be joined` });
      return finish();
    }
    const choice = await choosePrivilege(f, ctx, obj.obj_name, uniq([f.table, obj.obj_name, obj.database_object_name]), hcmObj(obj), "direct");
    if (!choice.ok) blocked.push({ object: obj.obj_name, reason: choice.reason, ...(choice.candidates?.length ? { candidates: choice.candidates } : {}) });
    else condition = { column: null, context: null, route: "direct", object: obj.obj_name, dbObject: obj.database_object_name, pk, joinColumns: pk, nullable: false,
      privileges: choice.privileges, combine: choice.combine, grade: choice.grade, evidence: choice.evidence, ...(choice.equivalentTo ? { equivalentTo: choice.equivalentTo } : {}) };
    return finish();
  };
  /** one registration among several granted ones: the one named like the table, or the only one */
  const single = (granted: SecInstanceObjectRow[], what: string): SecInstanceObjectRow | null => {
    const obj = granted.find((r) => r.obj_name === f.table) ?? (granted.length === 1 ? granted[0] : null);
    if (!obj) blocked.push({ reason: `${f.table} is registered under ${granted.length} ${what} security objects on ${layer.instance} (${granted.map((r) => r.obj_name).join(", ")}) and none is named ${f.table} — no silent pick` });
    return obj;
  };

  if (f.disallowed) {
    blocked.push({ reason: `${f.table} is DISALLOWED in secured SQL: ${f.disallowed.reason}` });
    return finish();
  }
  if (f.area && !f.subjectAreas.includes(f.area.name)) {
    blocked.push({ reason: `${f.table} is read by no folder of subject area ${f.area.name} (OTBI lineage)` +
      (f.subjectAreas.length ? ` — it is read by ${f.subjectAreas.length} other subject area(s), e.g. ${f.subjectAreas.slice(0, 3).join("; ")}` : " — it is read by no OTBI subject area of the catalog") });
    return finish();
  }
  const regs = await db().security.instanceObjectsForTable(layer.instance, f.table);

  // SENSITIVE: the table is read only through its own registered object and privilege(s)
  if (f.sensitive) {
    const obj = regs.find((r) => r.obj_name === f.sensitive!.object);
    if (!obj) {
      blocked.push({ object: f.sensitive.object, reason: `${f.table} is sensitive — read only through ${f.sensitive.object} / ${f.sensitive.privileges.join(" | ")} — and ${f.sensitive.object} is not registered as a security object on ${layer.instance}` });
      return finish();
    }
    return direct(obj);
  }

  // DIRECT: the instance registers the table itself with a grant to the BI server identity (U) or an analysis duty
  const visible: SecInstanceObjectRow[] = [];
  for (const r of regs) {
    const [u, d] = await Promise.all([db().security.uPairs(layer.instance, r.obj_name), db().security.dutyPairs(layer.instance, r.obj_name)]);
    if (u.length || d.length) visible.push(r);
  }
  if (visible.length) {
    const obj = single(visible, "granted");
    return obj ? direct(obj) : finish();
  }

  // REFERENCE: the context column (table keying: the primary + audit; area keying: the context the area binds)
  if (f.rows.length) {
    const pick = f.area ? await areaContext(f, layer) : tableContext(f);
    if ("reason" in pick) {
      blocked.push({ ...(pick.column ? { column: pick.column } : {}), ...(pick.context ? { context: pick.context } : {}), reason: pick.reason });
      return finish();
    }
    const row = pick.row;
    if (!row.ref_object || !row.ref_column) {
      blocked.push({ column: row.column_name, context: row.context, reason: `${f.table}.${row.column_name} (${row.context}) has no reference object in the release — broken facts, rebuild the release` });
      return finish();
    }
    const ref = await db().security.instanceObject(layer.instance, row.ref_object);
    if (!ref) {
      blocked.push({ column: row.column_name, context: row.context, object: row.ref_object,
        reason: `${row.ref_object} (the ${row.context} reference of ${f.table}.${row.column_name}) is not registered as a security object on ${layer.instance}` });
      return finish();
    }
    const choice = await choosePrivilege(f, ctx, ref.obj_name, uniq([ref.obj_name, ref.database_object_name, ...entitiesOf(f, row.context)]), hcmObj(ref), "reference");
    if (!choice.ok) {
      blocked.push({ column: row.column_name, context: row.context, object: ref.obj_name, reason: choice.reason, ...(choice.candidates?.length ? { candidates: choice.candidates } : {}) });
      return finish();
    }
    const nullable = (await db().schema.columns(f.table)).find((c) => c.name === row.column_name)?.nullable === 1;
    condition = { column: row.column_name, context: row.context, route: "reference", object: ref.obj_name, dbObject: ref.database_object_name,
      pk: [row.ref_column], joinColumns: [row.column_name], nullable, privileges: choice.privileges, combine: choice.combine, grade: choice.grade,
      evidence: choice.evidence + (pick.how ? `; ${pick.how}` : ""), ...(choice.equivalentTo ? { equivalentTo: choice.equivalentTo } : {}) };
    return finish();
  }

  // DIRECT on pool 2: registered, no context column, any active grant on the instance
  const pooled: SecInstanceObjectRow[] = [];
  for (const r of regs) if ((await db().security.grantedPairs(layer.instance, r.obj_name)).length) pooled.push(r);
  if (pooled.length) {
    const obj = single(pooled, "granted");
    return obj ? direct(obj) : finish();
  }
  if (regs.length) {
    blocked.push({ reason: `${f.table} is registered as ${regs.map((r) => r.obj_name).join(", ")} but carries no active grant on ${layer.instance}, and it has no context column — nothing can generate its condition` });
    return finish();
  }
  return finish(`no context column and not a security object with grants on ${layer.instance} — reference data, read directly`);
}

/** The isolated-form condition over the CTE's inner alias `t`; several privileges are OR-ed (anyOf) or AND-ed (the
 *  strictest) inside the one subquery over the same `sec$` row. */
function conditionSql(c: Condition): string {
  const outer = c.joinColumns.map((k) => `${CTE_ALIAS}.${k}`);
  const inner = c.pk.map((k) => `${SEC_ALIAS}.${k}`).join(", ");
  const lhs = outer.length > 1 ? `(${outer.join(", ")})` : outer[0];
  const slots = c.privileges.map((p) => `{PRED:${c.object}|${p}}`);
  const where = slots.length > 1 ? slots.map((s) => `(${s})`).join(c.combine === "all" ? " and " : " or ") : slots[0];
  const sub = `${lhs} in (select ${inner} from ${c.dbObject} ${SEC_ALIAS} where ${where})`;
  return c.nullable ? `(${outer[0]} is null or ${sub})` : sub;
}

// ---- the column whitelist (what the subject area exposes) ----------------------------------------

/** Functions / keywords an OTBI presentation expression may apply to a physical column without masking it:
 *  a lookup, a cast, a null default, a case on it, plain arithmetic / concatenation, date arithmetic. Any other
 *  call (SUBSTR, LPAD, REGEXP_*, a scalar subquery, an aggregate, an analytic) or a mask-like literal
 *  ('XXXX', '****') = a masking or unknown shape — its inputs stay hidden ("unknown shapes hide"). */
const SAFE_CALLS = new Set([
  "NVL", "NVL2", "COALESCE", "NULLIF", "DECODE", "CAST", "CONCAT", "TRIM", "LTRIM", "RTRIM", "UPPER", "LOWER", "INITCAP",
  "TO_CHAR", "TO_NUMBER", "TO_DATE", "TO_TIMESTAMP", "TRUNC", "ROUND", "FLOOR", "CEIL", "ABS", "SIGN", "MOD",
  "MONTHS_BETWEEN", "ADD_MONTHS", "EXTRACT", "FROM_TZ", "NUMTODSINTERVAL", "GREATEST", "LEAST",
  // keywords the BI expression text writes before a parenthesis
  "CASE", "WHEN", "THEN", "ELSE", "END", "AND", "OR", "NOT", "IN", "IS", "AS", "ZONE",
  "VARCHAR", "VARCHAR2", "CHARACTER", "CHAR", "INTEGER", "INT", "NUMBER", "NUMERIC", "DECIMAL", "DOUBLE", "FLOAT", "DATE", "TIMESTAMP",
]);

/** Does an OTBI presentation expression expose its input columns as they are (true), or mask / hide them (false)? */
export function exposesInputs(expression: string): boolean {
  let masked = false;
  const e = expression.replace(/'(?:[^']|'')*'/g, (lit) => { if (/\*{2,}|X{3,}|#{3,}/i.test(lit)) masked = true; return "''"; });
  if (masked || /\bselect\b/i.test(e)) return false;
  for (const m of e.matchAll(/([A-Za-z_][A-Za-z0-9_$#]*)\s*\(/g)) if (!SAFE_CALLS.has(m[1].toUpperCase())) return false;
  return true;
}

export interface ColumnScope {
  /** the columns the subject area(s) expose — the only ones the answer may select */
  allowed: string[];
  /** keys projected for joins / filters only (primary key, foreign keys, corpus join columns) — never selected */
  joinOnly: string[];
  /** the corpus FILTER columns (table_predicates) the area does not expose — usable in WHERE / JOIN only, never
   *  selected (correct SQL needs them: a lookup join without LOOKUP_TYPE is wrong); masked / masking-shape excluded */
  filterOnly: string[];
  /** the rest of the table's columns (capped listing; the projection enforces the whole set) */
  hidden: string[];
  hiddenCount: number;
  /** exposed only through a masking / unknown-shape expression — hidden */
  maskingShapes?: string[];
}

/** The column whitelist of one table in the given subject areas (union over the areas that read it). */
async function columnScope(table: string, areas: string[], masked: Masked[]): Promise<ColumnScope> {
  const cols = (await db().schema.columns(table)).map((c) => c.name);
  const colSet = new Set(cols);
  const raw = new Set(masked.map((m) => m.column));
  const allowed = new Set<string>();
  const shapes = new Set<string>();
  for (const r of await db().otbi.columnRefsOfTable(table, areas)) {
    if (!colSet.has(r.db_column)) continue;
    if (r.via_expression === 1 && !exposesInputs(r.expression ?? "")) { shapes.add(r.db_column); continue; }
    allowed.add(r.db_column);
  }
  for (const c of raw) allowed.delete(c);
  const [pk, fk, joins, preds] = await Promise.all([db().schema.primaryKey(table), db().schema.fkeys(table), db().corpus.joinColumnStats(table, JOIN_COLUMNS),
    db().registries.predicateColumns(table)]);
  const keys = uniq([...pk, ...fk.out.map((r) => r.col).filter((c): c is string => !!c), ...joins.map((j) => j.column)]);
  const joinOnly = keys.filter((c) => colSet.has(c) && !allowed.has(c) && !raw.has(c)).sort();
  const filterOnly = preds.filter((c) => colSet.has(c) && !allowed.has(c) && !joinOnly.includes(c) && !raw.has(c) && !shapes.has(c)).sort();
  const hiddenAll = cols.filter((c) => !allowed.has(c) && !joinOnly.includes(c) && !filterOnly.includes(c)).sort();
  const maskingShapes = [...shapes].filter((c) => !allowed.has(c)).sort();
  return { allowed: [...allowed].sort(), joinOnly, filterOnly, hidden: hiddenAll.slice(0, HIDDEN_CAP), hiddenCount: hiddenAll.length, ...(maskingShapes.length ? { maskingShapes } : {}) };
}

/** The column scope of a reference table NO subject area reads (user decision 6): every non-sensitive column. */
async function fullScope(table: string, masked: Masked[]): Promise<ColumnScope> {
  const cols = (await db().schema.columns(table)).map((c) => c.name);
  const raw = new Set(masked.map((m) => m.column));
  const hiddenAll = cols.filter((c) => raw.has(c)).sort();
  return { allowed: cols.filter((c) => !raw.has(c)).sort(), joinOnly: [], filterOnly: [], hidden: hiddenAll.slice(0, HIDDEN_CAP), hiddenCount: hiddenAll.length };
}

// ---- the structural none rule + the no-area equivalents (end-user plan) ------------------------------------

type Structural = { readable: true; how: string } | { readable: false; reason: string };
const listed = (xs: string[], cap = 6) => (xs.length <= cap ? xs.join(", ") : `${xs.slice(0, cap).join(", ")}, … (${xs.length} in all)`);

/** The STRUCTURAL rule for an end user's none table (module header, verdict none; user decision 1): readable unless a
 *  declared FK (the table as the child) or a mined relationship (the table as the from side) reaches secured data; a
 *  reference-family member stays readable even then — a translation only while its base is not secured and no secured
 *  relationship goes through its key columns. */
async function structuralCheck(table: string, ctx: Ctx): Promise<Structural> {
  const [fk, rel, fam] = await Promise.all([db().schema.fkeys(table), db().schema.relationships(table), db().security.referenceFamily(table)]);
  const links = [
    ...fk.out.filter((r) => r.other !== table).map((r) => ({ other: r.other, col: r.col, kind: "declared FK" })),
    ...rel.from.filter((r) => r.other !== table).map((r) => ({ other: r.other, col: r.from_col, kind: "mined relationship" })),
  ];
  const secured: typeof links = [];
  for (const l of links) if (await ctx.securedTable(l.other)) secured.push(l);
  const famText = (x: ReferenceFamilyRow) => `${x.family} reference data (${x.evidence})`;
  if (!secured.length) {
    return { readable: true, how: `${fam ? `${famText(fam)}; ` : ""}no declared or mined relationship to secured data (${uniq(links.map((l) => l.other)).length} related table(s) checked on ${ctx.layer.instance})` };
  }
  const parents = uniq(secured.map((l) => l.other)).sort();
  if (fam && fam.family !== "translation") {
    return { readable: true, how: `${famText(fam)} — related to secured ${listed(parents)}, and reference data stays readable` };
  }
  if (fam) {
    if (fam.base_table && (await ctx.securedTable(fam.base_table))) {
      return { readable: false, reason: `${table} translates ${fam.base_table}, which is secured on ${ctx.layer.instance} — a translation of secured data, not reference data` };
    }
    const tl = table.replace(/_VL$/, "_TL");
    const keys = uniq([...(await db().schema.primaryKey(table)), ...(tl !== table ? await db().schema.primaryKey(tl) : []),
      ...(fam.base_table ? await db().schema.primaryKey(fam.base_table) : [])]).filter((k) => k !== "LANGUAGE" && k !== "SOURCE_LANG");
    const viaKey = secured.filter((l) => !!l.col && keys.includes(l.col));
    if (viaKey.length) {
      return { readable: false, reason: `${table} is a translation whose key ${uniq(viaKey.map((l) => l.col as string)).join(", ")} relates to secured ${listed(uniq(viaKey.map((l) => l.other)).sort())} — a translation of secured data, not reference data` };
    }
    return { readable: true, how: `${famText(fam)} — related to secured ${listed(parents)} only through non-key columns, its base ${fam.base_table ?? "(none in the dictionary)"} not secured` };
  }
  const kinds = uniq(secured.map((l) => l.kind)).join(" / ");
  return { readable: false, reason: `${table} has no context column and is no security object, but a ${kinds} reaches secured ${listed(parents)} — a child of secured data that is no reference-family member (lookup / translation / calendar / currency / territory) is not read by an end user` };
}

/** the name stem of a table: _TL / _VL / _V / _B / _F / _M / _ALL suffixes cut, an _ALL_ infix dropped */
function stemOf(name: string): string {
  let s = name;
  for (;;) { const n = s.replace(/_(TL|VL|V|B|F|M|ALL)$/, ""); if (n === s || !n.includes("_")) break; s = n; }
  return s.replace(/_ALL_/g, "_");
}

/** A no-area table's equivalents an end user CAN read: the tables of the same name stem some subject area reads, and
 *  (a view) the area-read tables its text reads. */
async function readInsteadOf(table: string, ctx: Ctx): Promise<{ table: string; how: string }[]> {
  const stems = await ctx.readStems();
  const out = (stems.get(stemOf(table)) ?? []).filter((x) => x !== table).sort().map((x) => ({ table: x, how: `the same entity (name stem ${stemOf(table)}), read by OTBI subject areas` }));
  const row = await db().schema.getTable(table);
  if (row?.view_text) {
    const read = new Set([...stems.values()].flat());
    for (const id of uniq(row.view_text.toUpperCase().match(/[A-Z][A-Z0-9_$#]{2,}/g) ?? [])) {
      if (id !== table && read.has(id) && !out.some((o) => o.table === id)) out.push({ table: id, how: `the view ${table} reads it` });
    }
  }
  return out.slice(0, 5);
}

// ---- the pushed payload (table tools) ------------------------------------------------------------

export interface DataSecurity {
  /** the release facts: every detected context column and its reference object; `primary` = the one the table-keyed plan secures */
  columns: { column: string; context: string; primary: boolean; confidence: string; evidence: number; reference: string | null }[];
  disallowed: { reason: string } | null;
  hcm: boolean;
  /** sensitive facts: the table's own pair(s) and the raw columns never to select, with the masked twin to read instead */
  sensitive?: { object: string; privileges: string[] };
  masked?: Masked[];
  /** OTBI exposure (facts only): how many subject areas read the table, and the ones it is a fact of */
  exposure?: { areas: number; factAreas: string[]; factAreaCount: number };
  /** without `instance`: how to get the verdict */
  note?: string;
  /** with `instance`: the resolver's verdict on that pod */
  instance?: string;
  layerStamp?: string;
  keying?: Keying;
  subjectArea?: string;
  verdict?: Verdict;
  conditions?: { column: string | null; context: string | null; object: string; privileges: string[]; pk: string; route: Route; grade: Grade; equivalentTo?: string[] }[];
  blocked?: Blocked[];
  reason?: string;
}

/** The pushed `dataSecurity` payload of one existing object; null when the object is unknown or the
 *  catalog carries no data-access facts (absent facts are never reported as `none`). With `instance`
 *  (required to be a loaded layer — an unknown host throws) the verdict on that pod is included, keyed on the
 *  table — or, with `subjectArea`, on that subject area (the coverage report; the end-user plan's keying). */
export async function dataSecurityFor(table: string, instance?: string, subjectArea?: string): Promise<DataSecurity | null> {
  const n = normName(table);
  if (!db().schema.tableNames().has(n)) return null;
  const meta = await secMeta();
  if (!meta) return null;
  if (subjectArea !== undefined && instance === undefined) throw new Error("subjectArea keying needs `instance` (the pod host as runSql reports it)");
  let area: AreaKey | null = null;
  let ctx: Ctx | null = null;
  if (instance !== undefined) {
    ctx = new Ctx(await requireLayer(instance), "developer");
    if (subjectArea !== undefined) {
      if (!(await db().otbi.subjectArea(subjectArea))) throw new Error(`subject area "${subjectArea}" is not in the catalog`);
      area = { name: subjectArea, modules: await ctx.areaModules(subjectArea) };
    }
  }
  const f = await tableFacts(n, meta, area);
  const base: DataSecurity = {
    columns: f.rows.map((r) => ({ column: r.column_name, context: r.context, primary: r.is_primary === 1, confidence: r.confidence, evidence: r.evidence,
      reference: r.ref_object && r.ref_column ? `${r.ref_object}.${r.ref_column}` : null })),
    disallowed: f.disallowed ? { reason: f.disallowed.reason } : null,
    hcm: f.hcmTable,
    ...(f.sensitive ? { sensitive: { object: f.sensitive.object, privileges: f.sensitive.privileges } } : {}),
    ...(f.sensitive?.masked.length ? { masked: f.sensitive.masked } : {}),
    ...(f.subjectAreas.length ? { exposure: { areas: f.subjectAreas.length, factAreas: f.factSubjectAreas.slice(0, 10), factAreaCount: f.factSubjectAreas.length } } : {}),
  };
  if (!ctx) {
    return { ...base, note: "pass `instance` (the pod host as runSql reports it) for the data-access verdict on that pod, or call getDataAccessPredicate({instance, tables})" };
  }
  const r = await resolveTable(f, ctx);
  const c = r.condition;
  return {
    ...base, hcm: r.hcm, instance: ctx.layer.instance, layerStamp: ctx.layer.stamp, keying: r.keying, ...(r.subjectArea ? { subjectArea: r.subjectArea } : {}), verdict: r.verdict,
    conditions: c ? [{ column: c.column, context: c.context, object: c.object, privileges: c.privileges, pk: c.pk.join(", "), route: c.route, grade: c.grade,
      ...(c.equivalentTo ? { equivalentTo: c.equivalentTo } : {}) }] : [],
    blocked: r.blocked,
    ...(r.reason ? { reason: r.reason } : {}),
  };
}

/** The compact form the validateTable names[] dossier carries. */
export function compactDataSecurity(d: DataSecurity) {
  return {
    ...(d.verdict ? { verdict: d.verdict } : {}),
    columns: d.columns.map((c) => ({ column: c.column, context: c.context, primary: c.primary, reference: c.reference })),
    disallowed: d.disallowed,
    hcm: d.hcm,
    ...(d.sensitive ? { sensitive: d.sensitive } : {}),
    ...(d.masked?.length ? { masked: d.masked } : {}),
    ...(d.exposure ? { exposure: { areas: d.exposure.areas, factAreas: d.exposure.factAreas.slice(0, 5), factAreaCount: d.exposure.factAreaCount } } : {}),
    ...(d.conditions?.length ? { conditions: d.conditions.map((c) => ({ column: c.column, object: c.object, privileges: c.privileges, route: c.route, grade: c.grade })) } : {}),
    ...(d.blocked?.length ? { blocked: d.blocked.map((b) => ({ ...(b.column ? { column: b.column } : {}), reason: b.reason, ...(b.candidates?.length ? { candidates: b.candidates } : {}) })) } : {}),
    ...(d.reason ? { reason: d.reason } : {}),
    ...(d.note ? { note: d.note } : {}),
  };
}

// ---- the plans ------------------------------------------------------------------------------------

type SecPair = { object: string; privilege: string; alias: typeof SEC_ALIAS };
export interface PlanCte {
  table: string; alias: string;
  /** `<alias>_sec` — the name the query reads instead of the table */
  cteName: string;
  /** `<alias>_sec as (select … from <TABLE> t where <condition>)` with `{PRED:<object>|<privilege>}` slot(s) to fill */
  cte: string;
  /** the pair(s) of this CTE's condition (several = anyOf, OR-ed) */
  pairs: SecPair[];
  keying: Keying;
  /** area keying: the subject area the table is read through */
  subjectArea?: string;
  grade: Grade;
  /** null = a structural read (an end user's none table: no condition) */
  route: Route | null;
  /** the secured context column (reference route) — null on the direct route */
  column: string | null;
  context: string | null;
  evidence: string;
  equivalentTo?: string[];
  /** sensitive: the raw columns never to select, with the masked twin to read instead */
  masked?: Masked[];
  /** grade strictest: the AND-ed privileges, and what the answer says when one of them comes back (1=2) */
  strictest?: { privileges: string[]; onEmpty: string };
}
type PlanBlocked = { table: string; alias: string; column?: string; reason: string; candidates?: Pair[]; readInstead?: { table: string; how: string }[] };
export interface Plan {
  instance: string;
  layerStamp: string;
  keying: Keying;
  /** area keying (developer): the subject area every table is keyed on */
  subjectArea?: string;
  /** one secured CTE per secured table instance */
  ctes: PlanCte[];
  /** read `to` wherever the query reads `from` — every FROM / JOIN / subquery / UNION arm */
  rewrite: { from: string; to: string }[];
  /** the distinct pairs to fetch with ONE pod-mcp getSecurityPredicate({pairs}) */
  pairs: SecPair[];
  blocked: PlanBlocked[];
  unsecured: { table: string; alias: string; reason: string }[];
  /** area keying (developer): the columns the area does NOT expose, per alias — ADVICE; the projection stays t.* */
  columns?: Record<string, { hidden: string[]; hiddenCount: number; maskingShapes?: string[] }>;
  /** area keying (developer): the subject-area gate is not applied to an author's plan, and the plan says so */
  gate?: { applied: false; note: string };
}

interface Item { table: string; alias: string }

/** every table instance as {table, alias} — validated: a real table, an identifier alias, one alias per instance */
function parseTables(tables: unknown): { items: Item[] } | { error: string; suggestions?: string[] } {
  if (!Array.isArray(tables) || !tables.length) {
    return { error: "`tables` is required: every table instance of the query as [{table, alias}] — an empty plan secures nothing" };
  }
  const known = db().schema.tableNames();
  const items: Item[] = [];
  const aliases = new Set<string>();
  for (const t of tables as { table?: unknown; alias?: unknown }[]) {
    const table = normName(String(t?.table ?? ""));
    const alias = String(t?.alias ?? "").trim();
    if (!IDENT.test(alias)) return { error: `alias of ${table || "(empty table)"} is required: the alias of that table instance in your FROM clause (letters, digits, _ $ #; e.g. ap)` };
    if (aliases.has(alias.toUpperCase())) return { error: `alias ${alias} is used twice — one entry per table INSTANCE, each with its own alias` };
    aliases.add(alias.toUpperCase());
    if (!known.has(table)) return { error: `${table || "(empty)"} does not exist in the catalog`, suggestions: suggestNames(table, [...known], 5) };
    items.push({ table, alias });
  }
  return { items };
}

const NO_FACTS = "this catalog carries no data-access facts (sec_meta has no version) — no plan can be produced; tell the user data access cannot be applied";
/** the OTBI subject-area lineage is served: a stamped OTBI build with at least one subject area */
const otbiServed = async () => (await db().otbi.version()) !== null && (await db().otbi.subjectAreaNames()).length > 0;

/** the secured CTE of one resolved table instance (projection = t.* or the given columns) */
function cteOf(it: Item, r: Resolution, projection: string[] | null): PlanCte {
  const c = r.condition as Condition;
  const cteName = `${it.alias}_sec`;
  const pairs = c.privileges.map((privilege): SecPair => ({ object: c.object, privilege, alias: SEC_ALIAS }));
  const proj = projection ? projection.map((k) => `${CTE_ALIAS}.${k}`).join(", ") : `${CTE_ALIAS}.*`;
  return {
    table: it.table, alias: it.alias, cteName,
    cte: `${cteName} as (select /*+ INLINE */ ${proj} from ${it.table} ${CTE_ALIAS} where ${conditionSql(c)})`,
    pairs, keying: r.keying, ...(r.subjectArea ? { subjectArea: r.subjectArea } : {}), grade: c.grade, route: c.route, column: c.column, context: c.context, evidence: c.evidence,
    ...(c.equivalentTo ? { equivalentTo: c.equivalentTo } : {}), ...(r.masked.length ? { masked: r.masked } : {}),
    ...(c.grade === "strictest" ? { strictest: { privileges: c.privileges,
      onEmpty: `access cannot be confirmed for ${it.table} (ambiguous privilege, you lack <the privilege whose predicate came back (1=2)>)` } } : {}),
  };
}

/** the CTE of an end user's structural read: the projection only, no condition */
function structuralCteOf(it: Item, area: string | null, scope: ColumnScope, how: string): PlanCte {
  const cteName = `${it.alias}_sec`;
  const proj = [...scope.allowed, ...scope.joinOnly, ...scope.filterOnly].map((k) => `${CTE_ALIAS}.${k}`).join(", ");
  return {
    table: it.table, alias: it.alias, cteName, cte: `${cteName} as (select /*+ INLINE */ ${proj} from ${it.table} ${CTE_ALIAS})`,
    pairs: [], keying: area ? "area" : "table", ...(area ? { subjectArea: area } : {}), grade: "structural", route: null, column: null, context: null,
    evidence: `structural none rule (end user): ${how}`,
  };
}

const addPairs = (into: SecPair[], from: SecPair[]) => { for (const p of from) if (!into.some((x) => x.object === p.object && x.privilege === p.privilege)) into.push(p); };
const blockedOf = (it: Item, r: Resolution): PlanBlocked[] =>
  r.blocked.map((b) => ({ table: it.table, alias: it.alias, ...(b.column ? { column: b.column } : {}), reason: b.reason, ...(b.candidates?.length ? { candidates: b.candidates } : {}) }));

/** getDataAccessPredicate({instance, tables:[{table, alias}], subjectArea?}) — the DEVELOPER plan for every table
 *  instance of ONE query on ONE pod: table-keyed, or keyed on one subject area (the area's columns as advice). */
export async function getDataAccessPredicate(args: { instance?: unknown; tables?: unknown; subjectArea?: unknown }): Promise<Plan | { error: string; suggestions?: string[] }> {
  let layer: Layer;
  try { layer = await requireLayer(args.instance); } catch (e) { return { error: errText(e) }; }
  const parsed = parseTables(args.tables);
  if ("error" in parsed) return parsed;
  const meta = await secMeta();
  if (!meta) return { error: NO_FACTS };
  const ctx = new Ctx(layer, "developer");
  let area: AreaKey | null = null;
  if (args.subjectArea !== undefined) {
    const sa = typeof args.subjectArea === "string" ? args.subjectArea : "";
    if (!(await otbiServed())) return { error: "subjectArea keying needs the OTBI catalog, and this catalog carries none (no otbi_* facts) — omit subjectArea for the table-keyed plan" };
    if (!sa || !(await db().otbi.subjectArea(sa))) {
      return { error: `subject area "${sa}" is not in the catalog — pass the name exactly as the BI presentation layer spells it`, suggestions: nearestNames(sa, await db().otbi.subjectAreaNames()) };
    }
    area = { name: sa, modules: await ctx.areaModules(sa) };
  }
  const plan: Plan = { instance: layer.instance, layerStamp: layer.stamp, keying: area ? "area" : "table", ...(area ? { subjectArea: area.name } : {}),
    ctes: [], rewrite: [], pairs: [], blocked: [], unsecured: [] };
  for (const it of parsed.items) {
    const r = await resolveTable(await tableFacts(it.table, meta, area), ctx);
    if (area && r.verdict !== "blocked") {
      const s = await columnScope(it.table, [area.name], r.masked);
      if (s.hiddenCount) (plan.columns ??= {})[it.alias] = { hidden: s.hidden, hiddenCount: s.hiddenCount, ...(s.maskingShapes ? { maskingShapes: s.maskingShapes } : {}) };
    }
    if (r.verdict === "blocked") plan.blocked.push(...blockedOf(it, r));
    else if (r.verdict === "none") plan.unsecured.push({ table: it.table, alias: it.alias, reason: r.reason ?? "" });
    else {
      const cte = cteOf(it, r, null);
      plan.ctes.push(cte);
      plan.rewrite.push({ from: `${it.table} ${it.alias}`, to: `${cte.cteName} ${it.alias}` });
      addPairs(plan.pairs, cte.pairs);
    }
  }
  if (area) {
    plan.gate = { applied: false, note: `developer mode: the subject-area gate (does the running user hold ${area.name}?) is not applied — the conditions are the author's own; ` +
      "`columns` lists what the area does not expose, as advice (an OTBI user of that area could not see them)" };
  }
  return plan;
}

/** One subject area offered to the end user's query: what it reads of the table set and its gate input. */
export interface CandidateArea { area: string; factOf: string[]; alsoReads: string[]; duties: number; hcm: boolean; neverHeld?: string }
export interface CandidatePlan {
  instance: string; layerStamp: string; mode: "end-user";
  /** the subject areas that read EVERY table of the query, best first (facts of the area, then a nameable gate, then name) */
  candidateAreas: CandidateArea[];
  /** when no single area reads them all: per table, the areas that read it (first ones) */
  perTable?: Record<string, string[]>;
  /** the tables NO subject area reads — left out of the candidate ranking; the no-area policy decides them */
  noArea?: string[];
  next: string;
}
export interface GateArea { area: string; duties: string[]; neverHeld?: string }
export interface SecuredPlan {
  mode: "end-user";
  /** the end-user tool mount is prompt-steered until the engine's per-mode mount lands (plan decision 14) */
  enforcement: "prompt";
  instance: string; layerStamp: string;
  /** the served catalog release and the TBI-guide release the area → duty codes come from */
  catalogRelease: string; guideRelease: string;
  keying: "area";
  subjectAreas: string[];
  /** the pod-mcp getSecurityPredicate `gate` input: every area a table is keyed on (all must be held), plus
   *  `alternates` = other areas that read every table (a held one is re-planned when a settled area is not held) */
  gate: { areas: GateArea[]; alternates: GateArea[] };
  ctes: PlanCte[];
  rewrite: { from: string; to: string }[];
  pairs: SecPair[];
  blocked: PlanBlocked[];
  /** per alias: the area's exposed columns (allowed), keys for joins only (joinOnly), filter columns for WHERE / JOIN
   *  only (filterOnly), the rest (hidden) */
  columns: Record<string, ColumnScope>;
  limits: string;
}

/** The candidate areas of a table set: the areas reading every table some area reads (a table no area reads is left
 *  to the no-area policy), ranked (facts, nameable gate, name). */
async function candidates(all: string[], ctx: Ctx, exclude: Set<string>, limit: number): Promise<CandidateArea[]> {
  const reads = new Map<string, Map<string, boolean>>();
  for (const t of all) {
    const m = new Map<string, boolean>();
    for (const f of await db().otbi.foldersOfTable(t)) m.set(f.subject_area, (m.get(f.subject_area) ?? false) || f.kind === "fact");
    reads.set(t, m);
  }
  const tables = all.filter((t) => (reads.get(t) as Map<string, boolean>).size > 0);
  if (!tables.length) return [];
  const [first, ...rest] = tables.map((t) => reads.get(t) as Map<string, boolean>);
  const common = [...first.keys()].filter((a) => !exclude.has(a) && rest.every((m) => m.has(a)));
  const facts = (a: string) => tables.filter((t) => reads.get(t)?.get(a));
  const ranked = common.sort((a, b) => facts(b).length - facts(a).length || (a < b ? -1 : a > b ? 1 : 0)).slice(0, limit * 2);
  const out: CandidateArea[] = [];
  for (const a of ranked) {
    const d = await ctx.areaDuties(a);
    out.push({ area: a, factOf: facts(a), alsoReads: tables.filter((t) => !reads.get(t)?.get(a)), duties: d.duties.length, hcm: d.hcm, ...(d.duties.length ? {} : { neverHeld: d.reason as string }) });
  }
  return out.sort((a, b) => b.factOf.length - a.factOf.length || (b.duties > 0 ? 1 : 0) - (a.duties > 0 ? 1 : 0) || (a.area < b.area ? -1 : a.area > b.area ? 1 : 0)).slice(0, limit);
}

const gateArea = (d: AreaDuties): GateArea => ({ area: d.area, duties: d.duties, ...(d.duties.length ? {} : { neverHeld: d.reason as string }) });

/** getSecuredQueryPlan({instance, tables:[{table, alias}], subjectAreas?}) — the END-USER plan: without
 *  subjectAreas the candidate areas (and stop); with them every table keyed on the first given area that reads
 *  it, projected to that area's exposed columns + join keys, and the gate input of pod-mcp getSecurityPredicate. */
export async function getSecuredQueryPlan(args: { instance?: unknown; tables?: unknown; subjectAreas?: unknown }): Promise<SecuredPlan | CandidatePlan | { error: string; suggestions?: string[] }> {
  let layer: Layer;
  try { layer = await requireLayer(args.instance); } catch (e) { return { error: errText(e) }; }
  const parsed = parseTables(args.tables);
  if ("error" in parsed) return parsed;
  const meta = await secMeta();
  if (!meta) return { error: NO_FACTS };
  if (!(await otbiServed())) {
    return { error: "OTBI catalog unavailable: this catalog carries no OTBI subject-area lineage (otbi_* facts — e.g. a sqlite catalog without the presentation layer), and the end-user plan reads tables only as a subject area reads them — refuse the question; nothing may be read" };
  }
  const ctx = new Ctx(layer, "end-user");
  const tables = uniq(parsed.items.map((i) => i.table));
  const given = args.subjectAreas;
  if (given === undefined || (Array.isArray(given) && !given.length)) {
    const cands = await candidates(tables, ctx, new Set(), CANDIDATES);
    const plan: CandidatePlan = { instance: layer.instance, layerStamp: layer.stamp, mode: "end-user", candidateAreas: cands,
      next: cands.length
        ? "settle the subject area(s) yourself (the first candidate whose name fits the question; never ask the end user for an area) and call getSecuredQueryPlan again with subjectAreas"
        : "no single subject area reads all these tables — pass several subjectAreas (each table is keyed on the first one that reads it; the column whitelist is their union), or narrow the question" };
    const perTable: Record<string, string[]> = {};
    for (const t of tables) perTable[t] = uniq((await db().otbi.foldersOfTable(t)).map((f) => f.subject_area)).slice(0, 5);
    const noArea = tables.filter((t) => !perTable[t].length);
    if (noArea.length) plan.noArea = noArea;
    if (!cands.length) plan.perTable = perTable;
    return plan;
  }
  if (!Array.isArray(given) || given.some((a) => typeof a !== "string" || !a)) return { error: "`subjectAreas` must be a list of subject-area names exactly as the BI presentation layer spells them" };
  const areas = uniq(given as string[]);
  for (const a of areas) {
    if (!(await db().otbi.subjectArea(a))) return { error: `subject area "${a}" is not in the catalog`, suggestions: nearestNames(a, await db().otbi.subjectAreaNames()) };
  }
  const guideRelease = (await db().otbi.meta()).guide_release;
  if (!guideRelease) return { error: "otbi_meta.guide_release is missing — the served release predates ddl_version 9 (no area → duty codes); it cannot gate an end user — rebuild the release" };
  const plan: SecuredPlan = {
    mode: "end-user", enforcement: "prompt", instance: layer.instance, layerStamp: layer.stamp,
    catalogRelease: db().meta.activeVersion(), guideRelease,
    keying: "area", subjectAreas: areas, gate: { areas: [], alternates: [] }, ctes: [], rewrite: [], pairs: [], blocked: [], columns: {}, limits: "",
  };
  const keyedOn: string[] = [];
  for (const it of parsed.items) {
    const out = await endUserTable(it, areas, ctx, meta);
    if (out.area && !keyedOn.includes(out.area)) keyedOn.push(out.area);
    if (out.kind === "blocked") { plan.blocked.push(...out.blocked); continue; }
    plan.columns[it.alias] = out.scope;
    plan.ctes.push(out.cte);
    plan.rewrite.push({ from: `${it.table} ${it.alias}`, to: `${out.cte.cteName} ${it.alias}` });
    addPairs(plan.pairs, out.cte.pairs);
  }
  for (const a of keyedOn) plan.gate.areas.push(gateArea(await ctx.areaDuties(a)));
  for (const c of await candidates(tables, ctx, new Set(areas), ALTERNATES * 3)) {
    if (plan.gate.alternates.length >= ALTERNATES) break;
    if (c.duties) plan.gate.alternates.push(gateArea(await ctx.areaDuties(c.area)));
  }
  const hiddenTotal = Object.values(plan.columns).reduce((s, c) => s + c.hiddenCount, 0);
  const filterTotal = Object.values(plan.columns).reduce((s, c) => s + c.filterOnly.length, 0);
  const byGrade = (g: Grade) => plan.ctes.filter((c) => c.grade === g).map((c) => c.table);
  const strictest = byGrade("strictest");
  const structural = byGrade("structural");
  const consensus = byGrade("consensus");
  plan.limits = `Read as OTBI subject area${keyedOn.length === 1 ? "" : "s"} ${keyedOn.join("; ") || areas.join("; ")} for the signed-in user: ` +
    `${plan.ctes.length - structural.length} table(s) filtered by ${plan.pairs.length} data-access pair(s) (${plan.pairs.map((p) => `${p.object} / ${p.privilege}`).join("; ") || "none"})` +
    `${consensus.length ? ` — ${consensus.join(", ")} by the job-role consensus of the area` : ""}` +
    `${strictest.length ? ` — ${strictest.join(", ")} by the strictest of candidates (ambiguous privilege: rows show only when you hold every candidate)` : ""}, ` +
    `${structural.length ? `${structural.length} reference table(s) read without a condition by the structural rule (${structural.join(", ")}), ` : ""}` +
    `${hiddenTotal} column(s) the area does not expose withheld${filterTotal ? ` (${filterTotal} filter-only column(s) used in conditions, never shown)` : ""}, ` +
    `${plan.blocked.length} table instance(s) not readable; ` +
    `security layer ${layer.stamp}, catalog ${plan.catalogRelease}, TBI guides ${plan.guideRelease}; enforcement: prompt (the per-mode tool mount is not in place yet).`;
  return plan;
}

type EndUserTable =
  | { kind: "read"; area: string | null; cte: PlanCte; scope: ColumnScope }
  | { kind: "blocked"; area: string | null; blocked: PlanBlocked[] };

/** One table instance of an END-USER question: keyed on the first given area that reads it and projected to that
 *  area's columns; a none table by the structural rule; a table no subject area reads by the no-area policy. */
async function endUserTable(it: Item, areas: string[], ctx: Ctx, meta: SecMeta): Promise<EndUserTable> {
  const no = (area: string | null, reason: string, extra: Partial<PlanBlocked> = {}): EndUserTable =>
    ({ kind: "blocked", area, blocked: [{ table: it.table, alias: it.alias, reason, ...extra }] });
  const readBy = uniq((await db().otbi.foldersOfTable(it.table)).map((f) => f.subject_area));
  const reading = areas.filter((a) => readBy.includes(a));
  if (!reading.length) {
    if (readBy.length) {
      return no(null, `${it.table} is read by none of the subject areas ${areas.join("; ") || "(none given)"} (OTBI lineage) — it is read by ${readBy.length} other subject area(s), e.g. ${readBy.slice(0, 3).join("; ")}; an end user reads a table only as a subject area exposes it`);
    }
    // NO subject area reads it (user decision 6): a reference-family none table by the structural rule, a business table never
    const fam = await db().security.referenceFamily(it.table);
    const instead = await readInsteadOf(it.table, ctx);
    const insteadText = instead.length ? ` — read instead: ${instead.map((x) => `${x.table} (${x.how})`).join("; ")}` : " — no equivalent table that a subject area reads";
    const withInstead = instead.length ? { readInstead: instead } : {};
    if (!fam) return no(null, `${it.table} is a business table no OTBI subject area reads — an end user never reads it${insteadText}`, withInstead);
    const r = await resolveTable(await tableFacts(it.table, meta, null), ctx);
    if (r.verdict !== "none") {
      return no(null, `${it.table} is ${fam.family} reference data but carries data-access security (${r.condition ? `${r.condition.object} / ${r.condition.privileges.join(" | ")}` : r.blocked.map((b) => b.reason).join("; ")}) and no subject area reads it — without an area only a none reference table is read${insteadText}`, withInstead);
    }
    const s = await structuralCheck(it.table, ctx);
    if (!s.readable) return no(null, `${s.reason}${insteadText}`, withInstead);
    const scope = await fullScope(it.table, r.masked);
    return { kind: "read", area: null, scope, cte: structuralCteOf(it, null, scope, `${s.how}; no subject area reads it — every non-sensitive column (user decision 6)`) };
  }
  const a = reading[0];
  const r = await resolveTable(await tableFacts(it.table, meta, { name: a, modules: await ctx.areaModules(a) }), ctx);
  if (r.verdict === "blocked") return { kind: "blocked", area: a, blocked: blockedOf(it, r) };
  if (r.condition?.grade === "granted") {
    return no(a, `${it.table}: the only condition found is a pool-2 pick (${r.condition.object} / ${r.condition.privileges.join(" | ")}, grade granted — not granted to the BI server identity, not OTBI-proven); the end-user plan does not read on it`,
      r.condition.column ? { column: r.condition.column } : {});
  }
  let structural: string | null = null;
  if (r.verdict === "none") {
    const s = await structuralCheck(it.table, ctx);
    if (!s.readable) return no(a, s.reason);
    structural = s.how;
  }
  const scope = await columnScope(it.table, reading, r.masked);
  const projection = [...scope.allowed, ...scope.joinOnly, ...scope.filterOnly];
  if (!projection.length) return no(a, `${it.table}: ${reading.join("; ")} expose${reading.length === 1 ? "s" : ""} none of its columns as they are — nothing can be selected`);
  return { kind: "read", area: a, scope, cte: structural !== null ? structuralCteOf(it, a, scope, structural) : cteOf(it, r, projection) };
}

/** The END-USER verdict of ONE table read in ONE subject area — or, `subjectArea` null, under the no-area policy —
 *  exactly as getSecuredQueryPlan decides it (the coverage report reads it; scripts/pipeline/security_coverage_resolver.mts). */
export async function endUserAccess(table: string, instance: string, subjectArea: string | null): Promise<
  { readable: true; grade: Grade; route: Route | null; detail: string; filterOnly: number } | { readable: false; reason: string; readInstead?: { table: string; how: string }[] }> {
  const ctx = new Ctx(await requireLayer(instance), "end-user");
  const meta = await secMeta();
  if (!meta) throw new Error(NO_FACTS);
  const out = await endUserTable({ table: normName(table), alias: "t" }, subjectArea === null ? [] : [subjectArea], ctx, meta);
  if (out.kind === "blocked") return { readable: false, reason: out.blocked[0].reason, ...(out.blocked[0].readInstead ? { readInstead: out.blocked[0].readInstead } : {}) };
  const c = out.cte;
  return { readable: true, grade: c.grade, route: c.route, filterOnly: out.scope.filterOnly.length,
    detail: c.route === null ? c.evidence : `${c.column ? `${c.column} -> ` : ""}${c.pairs.map((p) => `${p.object}/${p.privilege}`).join(c.grade === "strictest" ? " AND " : " | ")}` };
}
