#!/usr/bin/env python3
"""
SECURITY COVERAGE ANALYSIS — classify EVERY catalog object of one release by how Oracle's data
security can be applied to it, from the pod export (data/security/*.csv) + the release dictionary +
the corpus. Run by security_coverage.sh inside python:3.12-slim (psycopg); every input is REQUIRED
through the environment, nothing is defaulted, nothing is written to a database.

Classes (exactly one per object, in this precedence):
  DIRECT               the object IS a registered FND_OBJECTS object (matched on DATABASE_OBJECT_NAME, or on
                       OBJ_NAME when Oracle registered the base table through its view) with >= 1 active grant
  REGISTERED_NO_GRANT  registered, but no active grant links (no grant at all, or grants without a privilege)
  DISALLOWED           in the release's table_disallowed (unresolved context column on an unused object)
  VIA_JOIN             not registered; >= 1 context column (table_security) whose reference object is registered
                       and granted -> secured through the reference object's condition; strict only when the
                       column is NOT NULL in the dictionary, else leaky (NULL rows escape, `IS NULL OR` form)
  VIA_PARENT           no context column; a FK (NOT NULL = strict) or the dominant parser-mined join to a
                       DIRECT / VIA_JOIN / VIA_PARENT object (lines -> header), up to 3 hops
  UNSECURABLE          none of the above, with the reason (catalog noise / context column whose reference
                       object is not registered / no context column and no parent)

HCM objects (rules.exclude.hcmPrefixes — the p5 exclusion stays for the release facts; here they are classified like
everything else and flagged hcm=Y, user decision 2026-10-01): DIRECT when registered + granted, with the grant mix per
link (GLOBAL / SET_closed = the seeded `<OBJ>_S` placeholder `1=2` / SET_cond = a hand-written seed condition /
SET_profile = a HcmSecurityProfilesUI-compiled HCM_<type>_<id> set) and `closed_on_pod` when nothing but the placeholder
grants it; VIA_JOIN through the curated HCM_CONTEXTS columns (PERSON_ID -> PER_ALL_PEOPLE_F …) with the anchor's Report
privilege and Oracle's `*_SECURED_LIST_V` view; VIA_PARENT / UNSECURABLE as everything else.

Condition SHAPES (every FND_OBJECT_INSTANCE_SETS row): literal_id | constant_true | constant_false |
grant_parameter | urda_direct | urda_derived | datasec_context | session_util | plain_column_filter |
exists_other_object | other — plus the emission verdict for the generic generator: pod_specific
(literal ids) | isolated_required (no &TABLE_ALIAS) | as_is.

Binding rules honoured here: no pod id is written to any output (object / function / instance-set / grant
ids are used only to join the four CSVs in memory; every output names things by OBJ_NAME /
FUNCTION_NAME / INSTANCE_SET_NAME); customer-created instance sets (CREATED_BY <>
SEED_DATA_FROM_APPLICATION) and customer objects are reported as a separate layer and excluded from
every "shipped" figure; every classification carries its evidence; nothing unmapped is defaulted.
"""
import csv
import glob
import json
import os
import re
import sys
from collections import Counter, defaultdict

import psycopg

SERVE = os.environ.get("DATABASE_URL_SERVE")
WORK = os.environ.get("DATABASE_URL_WORK")
REL = os.environ.get("RELEASE")
SRC = os.environ.get("SEC_SRC")
OUT = os.environ.get("OUT_DIR")
RULES = os.environ.get("RULES")
for k, v in {"DATABASE_URL_SERVE": SERVE, "DATABASE_URL_WORK": WORK, "RELEASE": REL, "SEC_SRC": SRC, "OUT_DIR": OUT, "RULES": RULES}.items():
    if not v:
        sys.exit(f"{k} is required")
if not re.fullmatch(r"v\d{4}_\d{2}", REL):
    sys.exit(f"RELEASE must be v<YYYY_MM>, got {REL}")

SEED = "SEED_DATA_FROM_APPLICATION"
TOP_PRODUCTS = ["AP", "AR", "GL", "PO", "POZ", "INV", "CST", "PJF", "PJC", "FA", "XLA", "PER", "PAY", "BEN", "HRT", "CMP", "IRC", "WLF"]
CLASS_ORDER = ["DIRECT", "VIA_JOIN", "VIA_PARENT", "REGISTERED_NO_GRANT", "DISALLOWED", "UNSECURABLE"]

rules = json.load(open(RULES, encoding="utf-8"))
HCM_PREFIXES = set(rules["exclude"]["hcmPrefixes"])
NOISE_RE = re.compile(rules["exclude"]["objectNameRe"])
EXCLUDED_OBJECTS = set(rules["exclude"]["objects"])
SECURED_VIEW_RE = re.compile(rules["exclude"]["securedViewTextRe"], re.I)

# HCM context columns -> the registered anchor that secures them. Curated here because the p5 rules exclude HCM (so
# table_security carries no HCM rows); exact column names, applied to HCM-prefixed objects only. BUSINESS_GROUP_ID is
# NOT a context (one enterprise per pod). secured_list = Oracle's BIP secured list view over the anchor (a plain
# projection in the dictionary that the pod row-secures at run time); report_privilege = the data-security privilege
# Oracle documents for that view (docs: "Business Intelligence Publisher Secured List Views"). Order = priority
# (the first column present is the primary context).
HCM_CONTEXTS = [
    {"column": "PERSON_ID",                 "context": "HCM_PERSON",  "anchor": "PER_ALL_PEOPLE_F",            "secured_list": "PER_PERSON_SECURED_LIST_V",     "report_privilege": "PER_REPORT_PERSON_DATA"},
    {"column": "ASSIGNMENT_ID",             "context": "HCM_ASG",     "anchor": "PER_ALL_ASSIGNMENTS_M",       "secured_list": "PER_ASSIGNMENT_SECURED_LIST_V", "report_privilege": "PER_REPORT_ASSIGNMENT_DATA"},
    {"column": "PAYROLL_RELATIONSHIP_ID",   "context": "HCM_PAYREL",  "anchor": "PAY_PAY_RELATIONSHIPS_DN",    "secured_list": None,                            "report_privilege": "PAY_REPORT_PAYROLL_RELATIONSHIP_DATA"},
    {"column": "PERIOD_OF_SERVICE_ID",      "context": "HCM_WR",      "anchor": "PER_PERIODS_OF_SERVICE",      "secured_list": None,                            "report_privilege": "PER_REPORT_WORK_RELATIONSHIP_DATA"},
    {"column": "ORGANIZATION_ID",           "context": "HCM_ORG",     "anchor": "HR_ALL_ORGANIZATION_UNITS_F", "secured_list": "PER_DEPARTMENT_SECURED_LIST_V", "report_privilege": "PER_REPORT_DEPARTMENT_DATA"},
    {"column": "POSITION_ID",               "context": "HCM_POS",     "anchor": "HR_ALL_POSITIONS_F",          "secured_list": "PER_POSITION_SECURED_LIST_V",   "report_privilege": "PER_REPORT_POSITION_DATA"},
    {"column": "LEGISLATIVE_DATA_GROUP_ID", "context": "HCM_LDG",     "anchor": "PER_LEGISLATIVE_DATA_GROUPS", "secured_list": "PER_LDG_SECURED_LIST_V",        "report_privilege": "PER_REPORT_LEGISLATIVE_DATA_GROUP_DATA"},
    {"column": "PAYROLL_ID",                "context": "HCM_PAYROLL", "anchor": "PAY_ALL_PAYROLLS_F",          "secured_list": "PAY_PAYROLL_SECURED_LIST_V",    "report_privilege": "PAY_REPORT_PAYROLL_DEFINITION_DATA"},
    {"column": "JOB_ID",                    "context": "HCM_JOB",     "anchor": "PER_JOBS_F",                  "secured_list": "PER_JOB_SECURED_LIST_V",        "report_privilege": "PER_REPORT_HR_JOB_DATA"},
    {"column": "GRADE_ID",                  "context": "HCM_GRADE",   "anchor": "PER_GRADES_F",                "secured_list": "PER_GRADE_SECURED_LIST_V",      "report_privilege": "PER_REPORT_ASSIGNMENT_GRADE_DATA"},
    {"column": "LOCATION_ID",               "context": "HCM_LOC",     "anchor": "PER_LOCATIONS",               "secured_list": "PER_LOCATION_SECURED_LIST_V",   "report_privilege": "PER_REPORT_LOCATION_DATA"},
    {"column": "FLOW_ID",                   "context": "HCM_FLOW",    "anchor": "PAY_FLOWS",                   "secured_list": "PAY_FLOWS_SECURED_LIST_V",      "report_privilege": "PAY_REPORT_PAYROLL_FLOW_DATA"},
]
HCM_PROFILE_SET_RE = re.compile(r"^HCM_([A-Z_]+?)_\d{6,}$")  # HcmSecurityProfilesUI output: HCM_<profile type>_<pod id>
HCM_PLACEHOLDER_RE = re.compile(r"_S$")                       # the seeded `<OBJ>_S` set every HCM object carries


def log(*a):
    print("[secx]", *a, flush=True)


# ----------------------------------------------------------------------------------------------
# 1. the export
# ----------------------------------------------------------------------------------------------
def load_csv(pattern):
    hits = sorted(glob.glob(os.path.join(SRC, pattern)))
    if len(hits) != 1:
        sys.exit(f"expected exactly one file for {pattern} in {SRC}, found {hits}")
    with open(hits[0], encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


objects = load_csv("_Fusion_data_security_EXPORT*.csv")
privileges = load_csv("_02_*.csv")
isets = load_csv("_03_*.csv")
links = load_csv("_04_*.csv")
boss = load_csv("_05_*.csv")
log(f"export: objects {len(objects)} privileges {len(privileges)} instance sets {len(isets)} grant links {len(links)} boss {len(boss)}")

obj_by_name = {r["OBJ_NAME"]: r for r in objects}
obj_by_db = defaultdict(list)
for r in objects:
    obj_by_db[r["DATABASE_OBJECT_NAME"]].append(r)
privs_by_obj = defaultdict(list)
for r in privileges:
    privs_by_obj[r["OBJ_NAME"]].append(r)
priv_by_obj_name = {(r["OBJ_NAME"], r["PRIVILEGE"]): r for r in privileges}
links_by_obj = defaultdict(list)
for r in links:
    links_by_obj[r["OBJ_NAME"]].append(r)
set_by_id = {r["INSTANCE_SET_ID"]: r for r in isets}
sets_by_obj = defaultdict(list)
for r in isets:
    sets_by_obj[r["OBJ_NAME"]].append(r)
granted_objs = set(links_by_obj)


APOSTROPHE_ARTEFACT = 0


def pred_text(s):
    return s["_pred"]


# The CSV writer prefixed an apostrophe to every predicate that starts with whitespace (Excel-style
# protection); DBMS_LOB.GETLENGTH (PRED_LEN) proves it: the text is exactly one char too long and
# starts with "'". Strip it — kept, it would break the SQL — and count it as an export artefact.
for s in isets:
    p = s["PRED_1"] + s["PRED_2"] + s["PRED_3"]
    want = int(s["PRED_LEN"] or 0)
    if len(p) == want + 1 and p.startswith("'"):
        p = p[1:]
        APOSTROPHE_ARTEFACT += 1
    s["_pred"] = p


def is_customer_set(s):
    return s["CREATED_BY"] != SEED


CUSTOM_OBJ_RE = re.compile(r"_c$|^XX[A-Z0-9]*_")


def is_custom_object(obj_name):
    """a customer object: App Composer `_c` / XX* naming, or every instance set it owns is customer-created"""
    if CUSTOM_OBJ_RE.search(obj_name):
        return True
    own = sets_by_obj.get(obj_name, [])
    return bool(own) and all(is_customer_set(s) for s in own)


# ----------------------------------------------------------------------------------------------
# 2. condition shapes
# ----------------------------------------------------------------------------------------------
LITERAL_ID = re.compile(r"(?<![A-Za-z0-9_$#.])\d{9,}(?![A-Za-z0-9_])")
GRANT_PARAM = re.compile(r"&GRANT_ALIAS\.PARAMETER\d", re.I)
SESSION_UTIL = re.compile(r"HZ_SESSION_UTIL|HRC_SESSION_UTIL|FND_GLOBAL\.|FND_PROFILE\.|SYS_CONTEXT\s*\(|PER_SECURITY_PROFILES|PER_PERSON_SECURED|HR_SECURITY|ACA_TEAM_UTIL_PUB|FND_SESSION_MGMT", re.I)
FROM_TABLES = re.compile(r"\b(?:FROM|JOIN)\s+(?:FUSION\.)?([A-Z][A-Z0-9_$#]*)(?:\s+[A-Z0-9_$#]+)?((?:\s*,\s*(?:FUSION\.)?[A-Z][A-Z0-9_$#]*(?:\s+[A-Z0-9_$#]+)?)*)", re.I)


def hcm_family(s, norm):
    """which HCM mechanism an instance set belongs to: profile_compiled (HcmSecurityProfilesUI output named
    HCM_<profile type>_<pod id>, one per security profile x object, on HCM and non-HCM objects alike), placeholder_S
    (the seeded `<OBJ>_S` constant every HCM object carries — `1=2` on this pod, i.e. closed until a data role's
    profile-compiled set or GLOBAL grant opens the object), seed_condition (a hand-written seed condition on an HCM
    object), '' for anything else"""
    if s["PROGRAM_NAME"] == "HcmSecurityProfilesUI" or HCM_PROFILE_SET_RE.match(s["INSTANCE_SET_NAME"]):
        return "profile_compiled"
    if s["DATABASE_OBJECT_NAME"].split("_")[0] not in HCM_PREFIXES and s["OBJ_NAME"].split("_")[0] not in HCM_PREFIXES:
        return ""
    if HCM_PLACEHOLDER_RE.search(s["INSTANCE_SET_NAME"]) and norm in ("1=1", "(1=1)", "1=2", "(1=2)"):
        return "placeholder_S"
    return "seed_condition"


FND_GRANTS_COLS = {"GRANT_GUID", "GRANTEE_TYPE", "GRANTEE_KEY", "GRANTEE_ORIG_SYSTEM", "GRANTEE_ORIG_SYSTEM_ID", "MENU_ID", "OBJECT_ID",
                   "INSTANCE_TYPE", "INSTANCE_SET_ID", "INSTANCE_PK1_VALUE", "INSTANCE_PK2_VALUE", "INSTANCE_PK3_VALUE", "INSTANCE_PK4_VALUE",
                   "INSTANCE_PK5_VALUE", "START_DATE", "END_DATE", "NAME", "DESCRIPTION", "CREATED_BY", "CREATION_DATE", "LAST_UPDATED_BY",
                   "LAST_UPDATE_DATE", "LAST_UPDATE_LOGIN", "OBJECT_VERSION_NUMBER", "GRANT_TYPE", "ROLE_NAME", "CONTEXT_NAME", "CONTEXT_VALUE",
                   "ENTERPRISE_ID"} | {f"PARAMETER{i}" for i in range(1, 11)}


def grant_scope_collisions(pred):
    """unqualified identifiers at the predicate's TOP level (outside every sub-select) that are also
    FND_GRANTS columns: inside `EXISTS (SELECT … FROM FND_GRANTS gnt WHERE … AND (<pred>))` Oracle binds
    them to gnt, not to the secured table — such a predicate cannot be emitted unqualified"""
    s = re.sub(r"'[^']*'", "''", pred)
    out = set()
    depth = 0
    sub = []
    for m in re.finditer(r"\(|\)|[A-Za-z&][A-Za-z0-9_$#.]*", s):
        tok = m.group(0)
        if tok == "(":
            depth += 1
        elif tok == ")":
            if sub and sub[-1] == depth:
                sub.pop()
            depth -= 1
        elif tok.upper() == "SELECT":
            sub.append(depth)
        elif not sub and "." not in tok and not tok.startswith("&") and tok.upper() in FND_GRANTS_COLS:
            out.add(tok.upper())
    return sorted(out)


def tables_in(P):
    out = set()
    for m in FROM_TABLES.finditer(P):
        out.add(m.group(1).upper())
        for part in (m.group(2) or "").split(","):
            part = part.strip()
            if part:
                out.add(part.split()[0].replace("FUSION.", "").upper())
    return out - {"DUAL"}


def classify_shape(s):
    pred = pred_text(s)
    P = pred.upper()
    norm = re.sub(r"\s+", "", P)
    flags = {
        "literal_id": bool(LITERAL_ID.search(pred)),
        "constant_true": norm in ("1=1", "(1=1)"),
        "constant_false": norm in ("1=2", "(1=2)"),
        "grant_parameter": bool(GRANT_PARAM.search(pred)),
        "grant_alias": "&GRANT_ALIAS" in P,
        "urda": "FUN_USER_ROLE_DATA_ASGNMNTS" in P,
        "datasec_context": "DATASEC_CONTEXT" in P,
        "session_util": bool(SESSION_UTIL.search(pred)),
        "subquery": "SELECT" in P,
        "table_alias": "&TABLE_ALIAS" in P,
        "hcm_family": hcm_family(s, norm),
    }
    others = tables_in(P) - {"FUN_USER_ROLE_DATA_ASGNMNTS"}
    if flags["literal_id"]:
        shape = "literal_id"
    elif flags["constant_true"]:
        shape = "constant_true"
    elif flags["constant_false"]:
        shape = "constant_false"
    elif flags["grant_parameter"]:
        shape = "grant_parameter"
    elif flags["urda"] and not others:
        shape = "urda_direct"
    elif flags["urda"]:
        shape = "urda_derived"
    elif flags["datasec_context"]:
        shape = "datasec_context"
    elif flags["session_util"]:
        shape = "session_util"
    elif not flags["subquery"]:
        shape = "plain_column_filter"
    elif others:
        shape = "exists_other_object"
    else:
        shape = "other"
    if flags["literal_id"]:
        emission = "pod_specific"
    elif not flags["table_alias"]:
        emission = "isolated_required"
    else:
        emission = "as_is"
    return shape, emission, flags, sorted(others)


shape_of = {}
cond_rows = []
pred_len_mismatch = []
for s in isets:
    shape, emission, flags, others = classify_shape(s)
    shape_of[s["INSTANCE_SET_ID"]] = (shape, emission, flags)
    pred = pred_text(s)
    if len(pred) != int(s["PRED_LEN"] or 0):
        pred_len_mismatch.append(int(s["PRED_LEN"] or 0) - len(pred))
    coll = grant_scope_collisions(pred) if emission == "isolated_required" else []
    cond_rows.append({
        "obj_name": s["OBJ_NAME"], "database_object_name": s["DATABASE_OBJECT_NAME"], "instance_set_name": s["INSTANCE_SET_NAME"],
        "layer": "customer" if is_customer_set(s) else "seed", "in_active_grant": s["IN_ACTIVE_GRANT"],
        "shape": shape, "emission": emission, "hcm_family": flags["hcm_family"], "grant_scope_collision": " ".join(coll),
        "uses_table_alias": s["USES_TABLE_ALIAS"], "uses_grant_alias": s["USES_GRANT_ALIAS"], "uses_urda": s["USES_URDA"],
        "uses_grant_parameter": int(flags["grant_parameter"]), "uses_session_util": int(flags["session_util"]),
        "uses_datasec_context": int(flags["datasec_context"]), "uses_grant_alias": int(flags["grant_alias"]),
        "other_objects": " ".join(others), "pred_len": s["PRED_LEN"], "program_name": s["PROGRAM_NAME"],
    })
log(f"shapes: {Counter(r['shape'] for r in cond_rows).most_common()}")

# ----------------------------------------------------------------------------------------------
# 3. the release dictionary + facts (read-only) and the corpus (read-only)
# ----------------------------------------------------------------------------------------------
def q(url, sql, args=None):
    with psycopg.connect(url, autocommit=True) as c, c.cursor() as cur:
        cur.execute("SET default_transaction_read_only = on")
        cur.execute(sql, args)
        return cur.fetchall()


S = REL
tables = {r[0]: {"type": r[1], "module": r[2] or "", "secured_view": bool(r[3] and SECURED_VIEW_RE.search(r[3]))}
          for r in q(SERVE, f"SELECT name, type, module, view_text FROM {S}.tables")}
log(f"dictionary {S}: {len(tables)} objects")
pkeys = defaultdict(list)
for t, c, seq in q(SERVE, f"SELECT table_name, column_name, seq FROM {S}.pkeys ORDER BY table_name, seq"):
    pkeys[t].append(c)
fkeys = defaultdict(list)  # child -> [(parent, child_col, seq, name)]
for ch, pa, col, seq, name in q(SERVE, f"SELECT child_table, parent_table, column_name, seq, name FROM {S}.fkeys ORDER BY child_table, name, seq"):
    fkeys[ch].append((pa, col, seq, name))
sec_rows = defaultdict(list)
for r in q(SERVE, f"SELECT table_name, column_name, context, urda_column, variant, ref_object, ref_column, is_primary, confidence, evidence, reason FROM {S}.table_security ORDER BY table_name, is_primary DESC, column_name"):
    sec_rows[r[0]].append(dict(zip(["table", "column", "context", "urda_column", "variant", "ref_object", "ref_column", "is_primary", "confidence", "evidence", "reason"], r)))
disallowed = {r[0]: r[1] for r in q(SERVE, f"SELECT table_name, reason FROM {S}.table_disallowed")}
rel_rows = q(SERVE, f"SELECT from_table, from_col, to_table, to_col, occurrences FROM {S}.relationships")
log(f"facts: table_security {sum(len(v) for v in sec_rows.values())} rows / {len(sec_rows)} objects, disallowed {len(disallowed)}, relationships {len(rel_rows)}, fkeys {sum(len(v) for v in fkeys.values())}")

# nullability only for the columns the analysis looks at (the dictionary has 1.45M columns)
need = set()
for t, rows in sec_rows.items():
    for r in rows:
        need.add((t, r["column"]))
for ch, fks in fkeys.items():
    for pa, col, _, _ in fks:
        need.add((ch, col))
for ft, fc, tt, tc, _ in rel_rows:
    need.add((ft, fc)); need.add((tt, tc))
for t, cols in pkeys.items():
    for c in cols:
        need.add((t, c))
nullable = {}
with psycopg.connect(SERVE) as c:
    c.execute("SET TRANSACTION READ ONLY")
    cur = c.cursor(name="cols")
    cur.itersize = 50000
    cur.execute(f"SELECT table_name, name, nullable FROM {S}.columns")
    for t, n, nl in cur:
        if (t, n) in need:
            nullable[(t, n)] = nl
log(f"nullability loaded for {len(nullable)} of {len(need)} looked-at columns")

usage = {r[0]: r[1] for r in q(WORK, "SELECT table_name, COUNT(DISTINCT sql_hash) FROM work.r_tables WHERE NOT is_cte GROUP BY 1")}
join_ev = {(r[0], r[1]): r[2] for r in q(WORK, """
  SELECT t, c, COUNT(DISTINCT sql_hash) FROM (
    SELECT from_t t, from_c c, sql_hash FROM work.f_joins WHERE from_t IS NOT NULL AND from_c IS NOT NULL
    UNION ALL SELECT to_t, to_c, sql_hash FROM work.f_joins WHERE to_t IS NOT NULL AND to_c IS NOT NULL) x GROUP BY 1, 2""")}
filter_ev = {(r[0], r[1]): r[2] for r in q(WORK, "SELECT table_name, column_name, COUNT(DISTINCT sql_hash) FROM work.f_predicates GROUP BY 1, 2")}
registered_views = [n for n in tables if tables[n]["type"] == "VIEW" and (n in obj_by_db or n in obj_by_name)]
view_bases = defaultdict(set)
for v, b in q(WORK, """SELECT substr(u.unit_id, 6), r.table_name FROM work.sql_unit u JOIN work.r_tables r ON r.sql_hash = u.sql_hash AND NOT r.is_cte
                       WHERE u.source = 'view' AND substr(u.unit_id, 6) = ANY(%s)""", (registered_views,)):
    if b != v:
        view_bases[v].add(b)
log(f"corpus: usage for {len(usage)} objects, join evidence {len(join_ev)} columns, filter evidence {len(filter_ev)} columns, view bases for {len(view_bases)} registered views")


# ----------------------------------------------------------------------------------------------
# 4. per registered object: privileges with their grant shapes (names only)
# ----------------------------------------------------------------------------------------------
def privilege_facts(obj_name):
    """every privilege of a registered object with its grant types, its instance sets' shapes and the flags"""
    by_priv = defaultdict(list)
    for l in links_by_obj.get(obj_name, []):
        by_priv[l["PRIVILEGE"]].append(l)
    out = []
    for priv, ls in sorted(by_priv.items()):
        p = priv_by_obj_name.get((obj_name, priv), {})
        sets = [set_by_id[l["INSTANCE_SET_ID"]] for l in ls if l["INSTANCE_TYPE"] == "SET"]
        seed_sets = [s for s in sets if not is_customer_set(s)]
        shapes = Counter(shape_of[s["INSTANCE_SET_ID"]][0] for s in seed_sets)
        out.append({
            "privilege": priv, "display_name": p.get("PRIVILEGE_DISPLAY_NAME", ""), "description": p.get("PRIVILEGE_DESCRIPTION", ""),
            "roles": int(p.get("ROLES_DISTINCT") or 0), "grants": sum(int(l["GRANTS"]) for l in ls),
            "grant_types": "+".join(sorted({l["INSTANCE_TYPE"] for l in ls})),
            "instance_sets": sorted({s["INSTANCE_SET_NAME"] for s in seed_sets}),
            "shapes": dict(shapes),
            "needs_isolation": any(shape_of[s["INSTANCE_SET_ID"]][1] == "isolated_required" for s in seed_sets),
            "has_customer_sets": any(is_customer_set(s) for s in sets),
            "has_literal_ids": any(shape_of[s["INSTANCE_SET_ID"]][0] == "literal_id" for s in seed_sets),
            "uses_grant_parameter": any(shape_of[s["INSTANCE_SET_ID"]][2]["grant_parameter"] for s in seed_sets),
            "uses_session_util": any(shape_of[s["INSTANCE_SET_ID"]][2]["session_util"] for s in seed_sets),
            "user_grantees": any(l["GRANTEE_TYPE_SAMPLE"] == "USER" or l["GRANTEE_TYPES"] != "1" for l in ls),
        })
    return out


def pk_columns(o):
    return [(o[f"PK{i}_COLUMN_NAME"], o[f"PK{i}_COLUMN_TYPE"]) for i in range(1, 6) if o[f"PK{i}_COLUMN_NAME"]]


def module_of(name):
    m = tables[name]["module"]
    return m if m else name.split("_")[0]


def is_hcm(name):
    return module_of(name) in HCM_PREFIXES or name.split("_")[0] in HCM_PREFIXES


def ref_registration(ref_object):
    """the registered object that secures a reference object (by DB object name, else by OBJ_NAME), granted or not"""
    cands = obj_by_db.get(ref_object) or ([obj_by_name[ref_object]] if ref_object in obj_by_name else [])
    cands = [c for c in cands if not is_custom_object(c["OBJ_NAME"])]
    granted = [c for c in cands if c["OBJ_NAME"] in granted_objs]
    return (granted[0] if granted else (cands[0] if cands else None)), bool(granted)


def candidate_privileges(ref_obj_name, module, report_only=False):
    """privileges on the reference object whose name carries the table's product prefix — listed, never picked;
    report_only narrows to the `_REPORT_` family (HCM anchors carry hundreds of UI privileges, BIP uses the Report ones)"""
    pf = module + "_"
    return [{"privilege": p["privilege"], "display_name": p["display_name"], "roles": p["roles"], "grant_types": p["grant_types"], "needs_isolation": p["needs_isolation"]}
            for p in privilege_facts(ref_obj_name) if p["privilege"].startswith(pf) and (not report_only or "_REPORT_" in p["privilege"])]


# ----------------------------------------------------------------------------------------------
# 5. classification
# ----------------------------------------------------------------------------------------------
# HCM: context columns on HCM objects (the p5 rules exclude HCM, so table_security has no HCM rows — the curated
# HCM_CONTEXTS map stands in) + Oracle's *_SECURED_LIST_V views over their anchors (plain one-table projections in the
# dictionary; the pod row-secures them at run time — the pattern Oracle's own HCM BIP data models use)
hcm_cols = {}
for t_, n_, nl_ in q(SERVE, f"SELECT table_name, name, nullable FROM {S}.columns WHERE name = ANY(%s)", ([c["column"] for c in HCM_CONTEXTS],)):
    if t_ in tables and is_hcm(t_):
        hcm_cols[(t_, n_)] = nl_
secured_list_of = defaultdict(list)
for v, b in q(WORK, """SELECT substr(u.unit_id, 6), r.table_name FROM work.sql_unit u JOIN work.r_tables r ON r.sql_hash = u.sql_hash AND NOT r.is_cte
                       WHERE u.source = 'view' AND u.unit_id ~ '_SECURED_LIST_V$'"""):
    if b != v:
        secured_list_of[b].append(v)
log(f"hcm: {len(hcm_cols)} context columns on {len({t for t, _ in hcm_cols})} HCM objects; secured list views over {len(secured_list_of)} base tables")


def set_kind(l):
    """one grant link's kind: GLOBAL / INSTANCE / SET_closed (constant false — the HCM `_S` placeholder) / SET_open
    (constant true) / SET_profile (profile-compiled) / SET_cond (a real condition)"""
    if l["INSTANCE_TYPE"] != "SET":
        return l["INSTANCE_TYPE"]
    shape, _, flags = shape_of[l["INSTANCE_SET_ID"]]
    if flags["hcm_family"] == "profile_compiled":
        return "SET_profile"
    return {"constant_false": "SET_closed", "constant_true": "SET_open"}.get(shape, "SET_cond")


def grant_kinds(obj_name):
    return dict(Counter(set_kind(l) for l in links_by_obj.get(obj_name, [])))


def closed_on_pod(obj_name):
    """every active grant link of the object is a SET grant on a constant-false set: on this pod nothing opens the
    object (a data role with a security profile would add GLOBAL or profile-compiled SET links)"""
    k = grant_kinds(obj_name)
    return bool(k) and set(k) == {"SET_closed"}


def profile_sets(obj_name):
    """profile-compiled sets DEFINED on the object (linked or not), by profile type (the HCM_<type>_ prefix)"""
    out = Counter()
    for s in sets_by_obj.get(obj_name, []):
        if shape_of[s["INSTANCE_SET_ID"]][2]["hcm_family"] == "profile_compiled":
            m = HCM_PROFILE_SET_RE.match(s["INSTANCE_SET_NAME"])
            out[m.group(1) if m else "?"] += 1
    return dict(out)


result = {}
priv_cache = {}


def pf(obj_name):
    if obj_name not in priv_cache:
        priv_cache[obj_name] = privilege_facts(obj_name)
    return priv_cache[obj_name]


for name, t in tables.items():
    regs = list(obj_by_db.get(name, []))
    if name in obj_by_name and obj_by_name[name] not in regs:
        regs.append(obj_by_name[name])
    reg_names = [r["OBJ_NAME"] for r in regs]
    granted = [r for r in regs if r["OBJ_NAME"] in granted_objs]
    base = {"table": name, "type": t["type"], "module": module_of(name), "usage": usage.get(name, 0),
            "registered_as": reg_names, "secured_view": t["secured_view"], "hcm": is_hcm(name)}
    if granted:
        seed = [r for r in granted if not is_custom_object(r["OBJ_NAME"])]
        custom = [r for r in granted if is_custom_object(r["OBJ_NAME"])]
        primary = next((r for r in seed if r["DATABASE_OBJECT_NAME"] == name), None) or (seed[0] if seed else custom[0])
        privs = pf(primary["OBJ_NAME"])
        result[name] = {**base, "class": "DIRECT", "evidence": {
            "object": primary["OBJ_NAME"], "database_object": primary["DATABASE_OBJECT_NAME"],
            "db_object_differs": primary["DATABASE_OBJECT_NAME"] != name,
            "object_type": primary["OBJECT_TYPE"], "pk": [c for c, _ in pk_columns(primary)],
            "pk_in_dictionary": all((name, c) in nullable or (primary["DATABASE_OBJECT_NAME"], c) in nullable for c, _ in pk_columns(primary)),
            "customer_only": not seed, "other_registered": [r["OBJ_NAME"] for r in granted if r is not primary],
            "custom_objects_on_same_db_object": [r["OBJ_NAME"] for r in custom],
            "privileges": privs, "privilege_count": len(privs),
            "needs_isolation_any": any(p["needs_isolation"] for p in privs),
            "has_customer_sets": any(p["has_customer_sets"] for p in privs),
            "has_literal_ids": any(p["has_literal_ids"] for p in privs),
            "view_base_tables": sorted(view_bases.get(name, [])) if t["type"] == "VIEW" else None,
            "grant_kinds": grant_kinds(primary["OBJ_NAME"]), "closed_on_pod": closed_on_pod(primary["OBJ_NAME"]),
            "profile_sets_defined": profile_sets(primary["OBJ_NAME"]), "secured_list_views": sorted(secured_list_of.get(name, [])),
        }}
        continue
    if regs:
        why = []
        for r in regs:
            if int(r["GRANTS_ACTIVE"] or 0) == 0:
                why.append(f"{r['OBJ_NAME']}: no active grant")
            else:
                why.append(f"{r['OBJ_NAME']}: {r['GRANTS_ACTIVE']} active grants but {r['PRIVILEGES_REGISTERED']} registered privileges (grants carry no privilege)")
        result[name] = {**base, "class": "REGISTERED_NO_GRANT", "evidence": {"objects": reg_names, "why": why, "pk": [c for c, _ in pk_columns(regs[0])]}}
        continue
    if name in disallowed:
        result[name] = {**base, "class": "DISALLOWED", "evidence": {"reason": disallowed[name]}}
        continue
    if NOISE_RE.search(name) or name in EXCLUDED_OBJECTS:
        result[name] = {**base, "class": "UNSECURABLE", "evidence": {"reason": "excluded catalog noise (MLOG$ / trailing _ / GTG_ copies) or an access list itself", "rule": "exclude.objectNameRe|exclude.objects"}}
        continue
    cols = []
    unregistered_refs = []
    for r in sec_rows.get(name, []):
        reg, granted_ref = ref_registration(r["ref_object"]) if r["ref_object"] else (None, False)
        if not reg or not granted_ref:
            unregistered_refs.append({"column": r["column"], "context": r["context"], "ref_object": r["ref_object"], "registered": bool(reg)})
            continue
        nl = nullable.get((name, r["column"]))
        ref_pk = [c for c, _ in pk_columns(reg)]
        cols.append({
            "column": r["column"], "context": r["context"], "variant": r["variant"], "confidence": r["confidence"], "is_primary": r["is_primary"],
            "ref_object": reg["OBJ_NAME"], "ref_database_object": reg["DATABASE_OBJECT_NAME"], "ref_column": r["ref_column"], "ref_pk": ref_pk,
            "ref_column_is_pk": ref_pk == [r["ref_column"]], "ref_is_hcm": is_hcm(reg["DATABASE_OBJECT_NAME"]) if reg["DATABASE_OBJECT_NAME"] in tables else None,
            "nullable": None if nl is None else bool(nl), "strictness": "unknown" if nl is None else ("strict" if not nl else "leaky"),
            "candidate_privileges": candidate_privileges(reg["OBJ_NAME"], module_of(name)),
            "ref_privileges_total": len(pf(reg["OBJ_NAME"])),
            "corpus_joins": join_ev.get((name, r["column"]), 0), "corpus_filters": filter_ev.get((name, r["column"]), 0),
        })
    if is_hcm(name):
        # HCM context columns (curated map); the first one present is the primary context
        for ctx in HCM_CONTEXTS:
            if (name, ctx["column"]) not in hcm_cols:
                continue
            reg, granted_ref = ref_registration(ctx["anchor"])
            if not reg or not granted_ref:
                unregistered_refs.append({"column": ctx["column"], "context": ctx["context"], "ref_object": ctx["anchor"], "registered": bool(reg)})
                continue
            nl = hcm_cols[(name, ctx["column"])]
            ref_pk = [c for c, _ in pk_columns(reg)]
            rp_links = [l for l in links_by_obj.get(reg["OBJ_NAME"], []) if l["PRIVILEGE"] == ctx["report_privilege"]]
            cols.append({
                "column": ctx["column"], "context": ctx["context"], "variant": "hcm_column", "confidence": "curated", "is_primary": int(not cols),
                "ref_object": reg["OBJ_NAME"], "ref_database_object": reg["DATABASE_OBJECT_NAME"], "ref_column": ctx["column"], "ref_pk": ref_pk,
                "ref_column_is_pk": ref_pk[:1] == [ctx["column"]], "ref_is_hcm": True,
                "nullable": None if nl is None else bool(nl), "strictness": "unknown" if nl is None else ("strict" if not nl else "leaky"),
                "secured_list": ctx["secured_list"], "secured_list_in_dictionary": (ctx["secured_list"] in tables) if ctx["secured_list"] else None,
                "report_privilege": ctx["report_privilege"], "report_privilege_registered": bool(rp_links),
                "report_privilege_grant_kinds": dict(Counter(set_kind(l) for l in rp_links)),
                "candidate_privileges": candidate_privileges(reg["OBJ_NAME"], module_of(name), report_only=True),
                "ref_privileges_total": len(pf(reg["OBJ_NAME"])),
                "corpus_joins": join_ev.get((name, ctx["column"]), 0), "corpus_filters": filter_ev.get((name, ctx["column"]), 0),
            })
    if cols:
        result[name] = {**base, "class": "VIA_JOIN", "evidence": {"columns": cols, "strict_columns": [c["column"] for c in cols if c["strictness"] == "strict"],
                        "leaky_columns": [c["column"] for c in cols if c["strictness"] == "leaky"],
                        "no_product_privilege": [c["column"] for c in cols if not c["candidate_privileges"]], "unregistered_refs": unregistered_refs}}
        continue
    if unregistered_refs:
        result[name] = {**base, "class": "UNSECURABLE", "evidence": {"reason": "context column(s) whose reference object is not a registered+granted FND object", "unregistered_refs": unregistered_refs}}
        continue
    result[name] = {**base, "class": None, "evidence": {}}  # VIA_PARENT candidates, resolved below

# VIA_PARENT: fixpoint over FKs then dominant parser joins, up to 3 hops
rel_by_table = defaultdict(list)
for ft, fc, tt, tc, occ in rel_rows:
    if ft != tt:
        rel_by_table[ft].append((tt, fc, tc, occ or 0))
        rel_by_table[tt].append((ft, tc, fc, occ or 0))


def parent_ok(p):
    return p in result and result[p]["class"] in ("DIRECT", "VIA_JOIN", "VIA_PARENT")


for hop in range(1, 4):
    changed = 0
    for name, r in result.items():
        if r["class"] is not None:
            continue
        # a) foreign keys to a secured parent: NOT NULL first
        fk_c = []
        for pa, col, seq, fkname in fkeys.get(name, []):
            if parent_ok(pa) and seq in (None, 1):
                nl = nullable.get((name, col))
                fk_c.append({"parent": pa, "column": col, "parent_column": (pkeys.get(pa) or [None])[0], "fk": fkname, "nullable": None if nl is None else bool(nl)})
        pick = None
        if fk_c:
            fk_c.sort(key=lambda c: (c["nullable"] is not False, -usage.get(c["parent"], 0)))
            pick = {**fk_c[0], "source": "fk", "alternatives": len(fk_c) - 1}
        else:
            # b) dominant parser-mined join to a secured partner — the join must land on the partner's
            #    single-column PRIMARY KEY (this table is the many side, a child); a join onto a non-key
            #    column, or onto one column of a composite key (lookup codes), makes this table the ONE
            #    side (reference data), which inherits nothing from its users — composite keys are
            #    accepted only through a declared FK (branch a)
            agg = Counter()
            total = 0
            one_side = 0
            for pa, col, pcol, occ in rel_by_table.get(name, []):
                if parent_ok(pa):
                    if pkeys.get(pa) == [pcol]:
                        agg[(pa, col, pcol)] += occ
                        total += occ
                    else:
                        one_side += occ
            r["evidence"]["one_side_joins"] = one_side
            if agg:
                (pa, col, pcol), occ = agg.most_common(1)[0]
                share = occ / total if total else 0
                if occ >= 2 and share >= 0.5:
                    nl = nullable.get((name, col))
                    pick = {"parent": pa, "column": col, "parent_column": pcol, "source": "corpus_join", "occurrences": occ, "share": round(share, 2),
                            "nullable": None if nl is None else bool(nl), "alternatives": len(agg) - 1}
        if pick:
            nl = pick["nullable"]
            pick["strictness"] = "unknown" if nl is None else ("strict" if not nl else "leaky")
            pick["parent_class"] = result[pick["parent"]]["class"]
            pick["parent_strictness"] = result[pick["parent"]]["evidence"].get("chain_strictness", "strict" if pick["parent_class"] == "DIRECT" else ("strict" if result[pick["parent"]]["evidence"].get("strict_columns") else "leaky"))
            pick["hops"] = hop
            pick["chain_strictness"] = "strict" if pick["strictness"] == "strict" and pick["parent_strictness"] == "strict" else ("unknown" if "unknown" in (pick["strictness"], pick["parent_strictness"]) else "leaky")
            r["class"] = "VIA_PARENT"
            r["evidence"] = pick
            changed += 1
    log(f"VIA_PARENT hop {hop}: {changed} objects")
    if not changed:
        break
for name, r in result.items():
    if r["class"] is None:
        r["class"] = "UNSECURABLE"
        one = r["evidence"].get("one_side_joins", 0)
        r["evidence"] = {"reason": ("reference data: secured objects join it only on its own key (one side), no context column, no FK to a secured parent" if one
                                    else "no context column, no FK and no dominant corpus join to a secured object"), "one_side_joins": one}

classes = Counter(r["class"] for r in result.values())
log(f"classes: {classes.most_common()}")


# (the former section 6 — an offline compact FND_GRANTS generator with pod-run samples — is gone: spec 2026-10-02 §7,
#  the condition is produced on the target pod by FND_DATA_SECURITY.GET_SECURITY_PREDICATE from names; nothing is
#  rebuilt offline)

# ----------------------------------------------------------------------------------------------
# 7. outputs
# ----------------------------------------------------------------------------------------------
os.makedirs(OUT, exist_ok=True)


def write_csv(name, rows, fields):
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=fields, extrasaction="ignore")
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v, ensure_ascii=False) if isinstance(v, (list, dict)) else v) for k, v in r.items()})


def ev_summary(r):
    e = r["evidence"]
    c = r["class"]
    if c == "DIRECT":
        return f"{e['object']}" + (f" (db object {e['database_object']})" if e["db_object_differs"] else "") + f": {e['privilege_count']} privileges, pk {','.join(e['pk'])}" + ("; isolation needed" if e["needs_isolation_any"] else "") + ("; customer-only object" if e["customer_only"] else "") + ("; closed on this pod (every grant = SET on 1=2)" if e.get("closed_on_pod") else "")
    if c == "VIA_JOIN":
        return "; ".join(f"{x['column']} -> {x['ref_object']}.{x['ref_column']} [{x['strictness']}]" + (f" / {x['secured_list']}" if x.get("secured_list") else "")
                         + f" {len(x['candidate_privileges'])} {r['module']}_ privileges" for x in e["columns"])
    if c == "VIA_PARENT":
        return f"{e['column']} -> {e['parent']}.{e['parent_column']} via {e['source']} [{e['strictness']}; chain {e['chain_strictness']}; hops {e['hops']}]"
    if c in ("UNSECURABLE", "DISALLOWED"):
        return e.get("reason", "")
    if c == "REGISTERED_NO_GRANT":
        return "; ".join(e["why"])
    return ""


obj_rows = []
for name in sorted(result):
    r = result[name]
    obj_rows.append({"table": name, "type": r["type"], "module": r["module"], "class": r["class"], "hcm": "Y" if r["hcm"] else "N", "usage": r["usage"],
                     "registered_as": " ".join(r["registered_as"]), "summary": ev_summary(r), "evidence": r["evidence"]})
write_csv("objects.csv", obj_rows, ["table", "type", "module", "class", "hcm", "usage", "registered_as", "summary", "evidence"])
write_csv("conditions.csv", cond_rows, list(cond_rows[0].keys()))

vj_rows = []
for name, r in result.items():
    if r["class"] != "VIA_JOIN":
        continue
    for c in r["evidence"]["columns"]:
        vj_rows.append({"table": name, "type": r["type"], "module": r["module"], "usage": r["usage"], **{k: v for k, v in c.items() if k != "candidate_privileges"},
                        "candidate_privileges": [p["privilege"] for p in c["candidate_privileges"]]})
write_csv("via_join_columns.csv", vj_rows, ["table", "type", "module", "usage", "column", "context", "variant", "confidence", "is_primary", "ref_object", "ref_database_object", "ref_column", "ref_pk", "ref_column_is_pk", "ref_is_hcm", "nullable", "strictness", "corpus_joins", "corpus_filters", "ref_privileges_total", "candidate_privileges", "secured_list", "secured_list_in_dictionary", "report_privilege", "report_privilege_registered", "report_privilege_grant_kinds"])

dp_rows = []
for name, r in result.items():
    if r["class"] != "DIRECT":
        continue
    for p in r["evidence"]["privileges"]:
        dp_rows.append({"table": name, "object": r["evidence"]["object"], "database_object": r["evidence"]["database_object"], **p})
write_csv("direct_privileges.csv", dp_rows, ["table", "object", "database_object", "privilege", "display_name", "description", "roles", "grants", "grant_types", "instance_sets", "shapes", "needs_isolation", "has_customer_sets", "has_literal_ids", "uses_grant_parameter", "uses_session_util", "user_grantees"])

cust_rows = []
for s in isets:
    if not is_customer_set(s):
        continue
    ls = [l for l in links if l["INSTANCE_SET_ID"] == s["INSTANCE_SET_ID"]]
    cust_rows.append({"obj_name": s["OBJ_NAME"], "database_object_name": s["DATABASE_OBJECT_NAME"], "instance_set_name": s["INSTANCE_SET_NAME"], "created_by": s["CREATED_BY"],
                      "in_active_grant": s["IN_ACTIVE_GRANT"], "links": len(ls), "privileges": sorted({l["PRIVILEGE"] for l in ls}), "shape": shape_of[s["INSTANCE_SET_ID"]][0],
                      "custom_object": is_custom_object(s["OBJ_NAME"]), "in_catalog": s["DATABASE_OBJECT_NAME"] in tables, "pred_len": s["PRED_LEN"]})
write_csv("customer_layer.csv", cust_rows, ["obj_name", "database_object_name", "instance_set_name", "created_by", "in_active_grant", "links", "privileges", "shape", "custom_object", "in_catalog", "pred_len"])

# ---- summary + report tables ----------------------------------------------------------------
active = [r for r in cond_rows if r["in_active_grant"] == "Y"]
seed_active = [r for r in active if r["layer"] == "seed"]
by_class_type = defaultdict(Counter)
for r in result.values():
    by_class_type[r["class"]][r["type"]] += 1
custom_objects = sorted({r["OBJ_NAME"] for r in objects if is_custom_object(r["OBJ_NAME"])})


# ---- HCM summary (the hcm=Y objects + the HCM mechanisms in the export) ----------------------------
def template_of(pred):
    """a predicate's shape with column names, string literals and numbers masked (groups the HCM seed conditions)"""
    t = re.sub(r"\s+", " ", pred.upper()).strip()
    t = re.sub(r"'[^']*'", "'$S'", t)
    t = re.sub(r"&TABLE_ALIAS\.[A-Z0-9_$#]+", "&TABLE_ALIAS.$COL", t)
    return re.sub(r"(?<![A-Z0-9_$#.])\d+(?![A-Z0-9_])", "$N", t)


HCM_REF_RE = re.compile(r"\b((?:HRC_SESSION_UTIL|HZ_SESSION_UTIL|FND_GLOBAL|FND_PROFILE)\.[A-Z0-9_]+|(?:PER|PAY|HR|HRC|HRT|HRM|IRC|BEN|CMP|WLF|HEY|ANC|HWM|HRG)_[A-Z0-9_]+)\b", re.I)


def prof_type(s):
    m = HCM_PROFILE_SET_RE.match(s["INSTANCE_SET_NAME"])
    return m.group(1) if m else "?"


def fam_of(s):
    return shape_of[s["INSTANCE_SET_ID"]][2]["hcm_family"]


linked_set_ids = {l["INSTANCE_SET_ID"] for l in links if l["INSTANCE_TYPE"] == "SET"}
hcm_linked_sets = [s for s in isets if s["INSTANCE_SET_ID"] in linked_set_ids and fam_of(s)]
hcm_templates = defaultdict(list)
for s in hcm_linked_sets:
    hcm_templates[template_of(pred_text(s))].append(s)
hcm_template_rows = []
for tpl, ss in sorted(hcm_templates.items(), key=lambda kv: -len(kv[1])):
    ex = next((s for s in ss if fam_of(s) != "profile_compiled"), None)
    hcm_template_rows.append({"template": tpl, "sets": len(ss), "objects": len({s["OBJ_NAME"] for s in ss}), "families": dict(Counter(fam_of(s) for s in ss)),
                              "example_set": ex["INSTANCE_SET_NAME"] if ex else f"HCM_{prof_type(ss[0])}_<id>", "example_object": ss[0]["OBJ_NAME"],
                              "verbatim": re.sub(r"\s+", " ", pred_text(ss[0])).strip(),
                              "references": sorted({m.group(1).upper() for s in ss for m in HCM_REF_RE.finditer(pred_text(s))}),
                              "shape": Counter(shape_of[s["INSTANCE_SET_ID"]][0] for s in ss).most_common(1)[0][0],
                              "emission": Counter(shape_of[s["INSTANCE_SET_ID"]][1] for s in ss).most_common(1)[0][0]})
hcm_refs = Counter()
for s in hcm_linked_sets:
    for ref in {m.group(1).upper() for m in HCM_REF_RE.finditer(pred_text(s))}:
        hcm_refs[ref] += 1
prof_sets = [s for s in isets if fam_of(s) == "profile_compiled"]
prof_by_type = defaultdict(list)
for s in prof_sets:
    prof_by_type[prof_type(s)].append(s)
prof_rows = []
for ptype, ss in sorted(prof_by_type.items(), key=lambda kv: -len(kv[1])):
    tpls = Counter(template_of(pred_text(s)) for s in ss)
    prof_rows.append({"profile_type": ptype, "sets": len(ss), "objects": len({s["OBJ_NAME"] for s in ss}),
                      "objects_non_hcm_prefix": len({s["OBJ_NAME"] for s in ss if s["DATABASE_OBJECT_NAME"].split("_")[0] not in HCM_PREFIXES and s["OBJ_NAME"].split("_")[0] not in HCM_PREFIXES}),
                      "linked": sum(1 for s in ss if s["INSTANCE_SET_ID"] in linked_set_ids), "active": sum(1 for s in ss if s["IN_ACTIVE_GRANT"] == "Y"),
                      "distinct_templates": len(tpls), "constant_true": sum(1 for s in ss if shape_of[s["INSTANCE_SET_ID"]][0] == "constant_true"),
                      "with_literal_id": sum(1 for s in ss if shape_of[s["INSTANCE_SET_ID"]][0] == "literal_id"),
                      "profiles": sorted({re.sub(r"^HCM:[A-Z_]+:[A-Z0-9_]+:", "", s["INSTANCE_SET_DESCRIPTION"] or "") for s in ss})[:10],
                      "dominant_template": tpls.most_common(1)[0][0][:400]})
hcm_rows = [r for r in result.values() if r["hcm"]]
hcm_direct = [r for r in hcm_rows if r["class"] == "DIRECT"]
hcm_vj = [r for r in hcm_rows if r["class"] == "VIA_JOIN"]
hcm_vj_cols = [c for r in hcm_vj for c in r["evidence"]["columns"]]
hcm_anchors = {}
for ctx in HCM_CONTEXTS:
    reg, granted_ref = ref_registration(ctx["anchor"])
    rp = [l for l in links_by_obj.get(ctx["anchor"], []) if l["PRIVILEGE"] == ctx["report_privilege"]]
    hcm_anchors[ctx["anchor"]] = {
        "context": ctx["context"], "column": ctx["column"], "registered": bool(reg), "granted": granted_ref,
        "class": result[ctx["anchor"]]["class"] if ctx["anchor"] in result else "not in dictionary", "anchor_usage": usage.get(ctx["anchor"], 0),
        "grant_kinds": grant_kinds(ctx["anchor"]), "privileges": len(pf(ctx["anchor"])) if reg else 0,
        "report_privilege": ctx["report_privilege"], "report_privilege_registered": bool(rp),
        "report_privilege_kinds": dict(Counter(set_kind(l) for l in rp)), "report_privilege_roles": sum(int(l["ROLES_DISTINCT"]) for l in rp),
        "secured_list": ctx["secured_list"], "secured_list_in_dictionary": bool(ctx["secured_list"] and ctx["secured_list"] in tables),
        "secured_list_lineage_ok": bool(ctx["secured_list"] and ctx["secured_list"] in secured_list_of.get(ctx["anchor"], [])),
        "secured_list_corpus_usage": usage.get(ctx["secured_list"], 0) if ctx["secured_list"] else 0,
        "via_join_columns": sum(1 for c in hcm_vj_cols if c["ref_object"] == ctx["anchor"]),
        "via_join_primary_tables": sum(1 for c in hcm_vj_cols if c["ref_object"] == ctx["anchor"] and c["is_primary"]),
    }
hcm_summary = {
    "objects": len(hcm_rows), "classes": dict(Counter(r["class"] for r in hcm_rows)),
    "classes_by_type": {c: dict(Counter(r["type"] for r in hcm_rows if r["class"] == c)) for c in CLASS_ORDER},
    "corpus_used_by_class": {c: sum(1 for r in hcm_rows if r["class"] == c and r["usage"] > 0) for c in CLASS_ORDER},
    "by_prefix_class": {p: dict(Counter(r["class"] for r in hcm_rows if r["module"] == p)) for p in sorted({r["module"] for r in hcm_rows})},
    "direct": {"objects": len(hcm_direct), "grant_mix": dict(Counter("+".join(sorted(r["evidence"]["grant_kinds"])) for r in hcm_direct)),
               "links_by_kind": dict(sum((Counter(r["evidence"]["grant_kinds"]) for r in hcm_direct), Counter())),
               "closed_on_pod": sorted(r["table"] for r in hcm_direct if r["evidence"]["closed_on_pod"]),
               "with_profile_sets_defined": sum(1 for r in hcm_direct if r["evidence"]["profile_sets_defined"]),
               "with_secured_list_view": sorted(r["table"] for r in hcm_direct if r["evidence"]["secured_list_views"]),
               "needs_isolation_any": sum(1 for r in hcm_direct if r["evidence"]["needs_isolation_any"]),
               "read_privilege": sum(1 for r in hcm_direct if any(p["privilege"] == "read" for p in r["evidence"]["privileges"])),
               "views": sum(1 for r in hcm_direct if r["type"] == "VIEW"),
               "with_hcm_context_column": sum(1 for r in hcm_direct if any((r["table"], c["column"]) in hcm_cols for c in HCM_CONTEXTS)),
               "without_hcm_context_column": sorted((r["table"] for r in hcm_direct if not any((r["table"], c["column"]) in hcm_cols for c in HCM_CONTEXTS)),
                                                    key=lambda n: -usage.get(n, 0))},
    "linked_sets": {"total": len(hcm_linked_sets), "by_family": dict(Counter(fam_of(s) for s in hcm_linked_sets)),
                    "by_shape": dict(Counter(shape_of[s["INSTANCE_SET_ID"]][0] for s in hcm_linked_sets)),
                    "by_emission": dict(Counter(shape_of[s["INSTANCE_SET_ID"]][1] for s in hcm_linked_sets)),
                    "with_grant_alias": sum(1 for s in hcm_linked_sets if shape_of[s["INSTANCE_SET_ID"]][2]["grant_alias"]),
                    "templates": len(hcm_templates)},
    "linked_templates": hcm_template_rows[:30],
    "references_in_linked_sets": hcm_refs.most_common(40),
    "profile_compiled_sets": {"total": len(prof_sets), "linked": sum(1 for s in prof_sets if s["INSTANCE_SET_ID"] in linked_set_ids),
                              "active": sum(1 for s in prof_sets if s["IN_ACTIVE_GRANT"] == "Y"), "objects": len({s["OBJ_NAME"] for s in prof_sets}),
                              "with_literal_id": sum(1 for s in prof_sets if shape_of[s["INSTANCE_SET_ID"]][0] == "literal_id"), "by_type": prof_rows},
    "via_join": {"tables": len(hcm_vj), "columns": len(hcm_vj_cols), "corpus_used": sum(1 for r in hcm_vj if r["usage"] > 0),
                 "by_context": dict(Counter(c["context"] for c in hcm_vj_cols)), "primary_context_tables": dict(Counter(c["context"] for c in hcm_vj_cols if c["is_primary"])),
                 "strict": sum(1 for c in hcm_vj_cols if c["strictness"] == "strict"), "leaky": sum(1 for c in hcm_vj_cols if c["strictness"] == "leaky"),
                 "unknown": sum(1 for c in hcm_vj_cols if c["strictness"] == "unknown"),
                 "tables_all_strict": sum(1 for r in hcm_vj if not r["evidence"]["leaky_columns"]), "tables_any_leaky": sum(1 for r in hcm_vj if r["evidence"]["leaky_columns"]),
                 "tables_primary_strict": sum(1 for r in hcm_vj if r["evidence"]["columns"][0]["strictness"] == "strict"),
                 "tables_primary_strict_corpus_used": sum(1 for r in hcm_vj if r["evidence"]["columns"][0]["strictness"] == "strict" and r["usage"] > 0),
                 "primary_without_secured_list": sum(1 for r in hcm_vj if not r["evidence"]["columns"][0].get("secured_list")),
                 "by_prefix": dict(Counter(r["module"] for r in hcm_vj))},
    "via_parent": {"objects": sum(1 for r in hcm_rows if r["class"] == "VIA_PARENT"),
                   "by_source": dict(Counter(r["evidence"]["source"] for r in hcm_rows if r["class"] == "VIA_PARENT")),
                   "by_chain_strictness": dict(Counter(r["evidence"]["chain_strictness"] for r in hcm_rows if r["class"] == "VIA_PARENT")),
                   "corpus_used": sum(1 for r in hcm_rows if r["class"] == "VIA_PARENT" and r["usage"] > 0)},
    "unsecurable": {"objects": sum(1 for r in hcm_rows if r["class"] == "UNSECURABLE"),
                    "reasons": dict(Counter(r["evidence"]["reason"] for r in hcm_rows if r["class"] == "UNSECURABLE")),
                    "corpus_used": sum(1 for r in hcm_rows if r["class"] == "UNSECURABLE" and r["usage"] > 0),
                    "unregistered_refs": dict(Counter(u["ref_object"] for r in hcm_rows for u in r["evidence"].get("unregistered_refs", [])))},
    "anchors": hcm_anchors,
}
registered_in_catalog = {r["DATABASE_OBJECT_NAME"] for r in objects if r["DATABASE_OBJECT_NAME"] in tables} | {r["OBJ_NAME"] for r in objects if r["OBJ_NAME"] in tables}


def granted_disposition(obj_name):
    """where one granted FND object landed: the catalog class of its DB object, or why it has none"""
    o = obj_by_name[obj_name]
    t = o["DATABASE_OBJECT_NAME"] if o["DATABASE_OBJECT_NAME"] in tables else (obj_name if obj_name in tables else None)
    if is_custom_object(obj_name):
        return "custom object (customer layer)" + ("" if t else ", DB object not in dictionary")
    if not t:
        return "DB object not in dictionary"
    return result[t]["class"]


summary = {
    "release": REL, "catalog_objects": len(tables),
    "export": {"objects": len(objects), "privileges": len(privileges), "instance_sets": len(isets), "grant_links": len(links), "boss_mapping_rows": len(boss),
               "objects_in_catalog": len(registered_in_catalog), "objects_not_in_catalog": sorted({r["OBJ_NAME"] for r in objects if r["DATABASE_OBJECT_NAME"] not in tables and r["OBJ_NAME"] not in tables}),
               "obj_name_ne_db_object": sum(1 for r in objects if r["OBJ_NAME"] != r["DATABASE_OBJECT_NAME"]),
               "object_types": dict(Counter(r["OBJECT_TYPE"] or "(table/view)" for r in objects)),
               "registered_without_links": sorted(set(obj_by_name) - granted_objs),
               "custom_objects": custom_objects,
               "apostrophe_artefact_stripped": APOSTROPHE_ARTEFACT,
               "pred_len_mismatches_after_strip": {"count": len(pred_len_mismatch), "deltas": dict(Counter(pred_len_mismatch))},
               "granted_objects_disposition": dict(Counter(granted_disposition(n) for n in granted_objs)),
               "disallowed_claimed_by_other_class": {n: result[n]["class"] for n in disallowed if result[n]["class"] != "DISALLOWED"},
               "direct_pk_not_in_dictionary": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and not r["evidence"]["pk_in_dictionary"]),
               "links_by_instance_type": dict(Counter(l["INSTANCE_TYPE"] for l in links)),
               "grants_vs_pk_value": {t: [sum(int(l["GRANTS"]) for l in links if l["INSTANCE_TYPE"] == t), sum(int(l["GRANTS_WITH_PK_VALUE"]) for l in links if l["INSTANCE_TYPE"] == t)] for t in ("GLOBAL", "SET", "INSTANCE")},
               "links_with_context": sum(1 for l in links if l["GRANTS_WITH_CONTEXT"] != "0"),
               "links_with_parameters": sum(1 for l in links if l["GRANTS_WITH_PARAMETERS"] != "0"),
               "links_with_user_grantees": sum(1 for l in links if l["GRANTEE_TYPE_SAMPLE"] == "USER" or l["GRANTEE_TYPES"] != "1"),
               "active_sets_without_links": [s["INSTANCE_SET_NAME"] + "@" + s["OBJ_NAME"] for s in isets if s["IN_ACTIVE_GRANT"] == "Y" and s["INSTANCE_SET_ID"] not in {l["INSTANCE_SET_ID"] for l in links}],
               "read_privileges": sum(1 for p in privileges if p["PRIVILEGE"] == "read"), "objects_with_read": len({p["OBJ_NAME"] for p in privileges if p["PRIVILEGE"] == "read"})},
    "classes": dict(classes), "classes_by_type": {k: dict(v) for k, v in by_class_type.items()},
    "hcm": hcm_summary,
    "direct": {"customer_only_objects": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["evidence"]["customer_only"]),
               "db_object_differs": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["evidence"]["db_object_differs"]),
               "needs_isolation_any": sum(1 for r in result.values() if r["class"] == "DIRECT" and r["evidence"]["needs_isolation_any"]),
               "has_customer_sets": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["evidence"]["has_customer_sets"]),
               "has_literal_ids": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["evidence"]["has_literal_ids"]),
               "views": sum(1 for r in result.values() if r["class"] == "DIRECT" and r["type"] == "VIEW"),
               "views_without_base_lineage": sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["type"] == "VIEW" and not r["evidence"]["view_base_tables"])},
    "via_join": {"columns": len(vj_rows), "strict": sum(1 for c in vj_rows if c["strictness"] == "strict"), "leaky": sum(1 for c in vj_rows if c["strictness"] == "leaky"), "unknown": sum(1 for c in vj_rows if c["strictness"] == "unknown"),
                 "tables_all_strict": sum(1 for r in result.values() if r["class"] == "VIA_JOIN" and not r["evidence"]["leaky_columns"]),
                 "tables_any_leaky": sum(1 for r in result.values() if r["class"] == "VIA_JOIN" and r["evidence"]["leaky_columns"]),
                 "tables_no_product_privilege_on_every_column": sum(1 for r in result.values() if r["class"] == "VIA_JOIN" and len(r["evidence"]["no_product_privilege"]) == len(r["evidence"]["columns"])),
                 "by_context": dict(Counter(c["context"] for c in vj_rows)), "by_ref_object": dict(Counter(c["ref_object"] for c in vj_rows)),
                 "ref_column_not_pk": dict(Counter(f"{c['ref_object']}.{c['ref_column']} (pk {','.join(c['ref_pk'])})" for c in vj_rows if not c["ref_column_is_pk"])),
                 "unregistered_refs_total": sum(len(r["evidence"].get("unregistered_refs", [])) for r in result.values() if r["class"] in ("VIA_JOIN", "UNSECURABLE"))},
    "via_parent": {"by_source": dict(Counter(r["evidence"]["source"] for r in result.values() if r["class"] == "VIA_PARENT")),
                   "by_chain_strictness": dict(Counter(r["evidence"]["chain_strictness"] for r in result.values() if r["class"] == "VIA_PARENT")),
                   "by_hops": dict(Counter(r["evidence"]["hops"] for r in result.values() if r["class"] == "VIA_PARENT"))},
    "unsecurable_reasons": dict(Counter(r["evidence"]["reason"] for r in result.values() if r["class"] == "UNSECURABLE")),
    "shapes": {"all": dict(Counter(r["shape"] for r in cond_rows)), "active": dict(Counter(r["shape"] for r in active)), "active_seed": dict(Counter(r["shape"] for r in seed_active)),
               "emission_active_seed": dict(Counter(r["emission"] for r in seed_active)),
               "hcm_family": dict(Counter(r["hcm_family"] or "none" for r in cond_rows)), "hcm_family_active_seed": dict(Counter(r["hcm_family"] or "none" for r in seed_active)),
               "grant_scope_collisions_active_seed": [{"object": r["obj_name"], "set": r["instance_set_name"], "columns": r["grant_scope_collision"]} for r in seed_active if r["grant_scope_collision"]],
               "shape_x_emission_active_seed": {f"{s}|{e}": n for (s, e), n in Counter((r["shape"], r["emission"]) for r in seed_active).items()}},
    "customer_layer": {"sets": len(cust_rows), "active": sum(1 for r in cust_rows if r["in_active_grant"] == "Y"), "links": sum(r["links"] for r in cust_rows),
                       "objects": len({r["obj_name"] for r in cust_rows}), "objects_in_catalog": sorted({r["database_object_name"] for r in cust_rows if r["in_catalog"]}),
                       "created_by": dict(Counter(r["created_by"] for r in cust_rows))},
    "literal_id_sets": [{"object": r["obj_name"], "set": r["instance_set_name"], "layer": r["layer"], "active": r["in_active_grant"]} for r in cond_rows if r["shape"] == "literal_id"],
}
json.dump(summary, open(os.path.join(OUT, "summary.json"), "w", encoding="utf-8"), indent=1, ensure_ascii=False, default=str)


# ---- report tables (markdown) ------------------------------------------------------------------
def md_table(headers, rows):
    out = ["| " + " | ".join(headers) + " |", "|" + "|".join("---" for _ in headers) + "|"]
    for r in rows:
        out.append("| " + " | ".join(str(x).replace("|", "\\|").replace("\n", " ") for x in r) + " |")
    return "\n".join(out) + "\n"


L = []
order = CLASS_ORDER
L.append("### Totals per class\n")
L.append(md_table(["class", "objects", "TABLE", "VIEW", "corpus-used (>=1 statement)"],
                  [(c, classes.get(c, 0), by_class_type[c]["TABLE"], by_class_type[c]["VIEW"], sum(1 for r in result.values() if r["class"] == c and r["usage"] > 0)) for c in order]
                  + [("TOTAL", len(result), sum(1 for r in result.values() if r["type"] == "TABLE"), sum(1 for r in result.values() if r["type"] == "VIEW"), sum(1 for r in result.values() if r["usage"] > 0))]))
L.append("\n### Top-20 modules by catalog objects, per class\n")
mods = Counter(r["module"] for r in result.values()).most_common(20)
L.append(md_table(["module", "objects"] + order, [(m, n, *[sum(1 for r in result.values() if r["module"] == m and r["class"] == c) for c in order]) for m, n in mods]))
L.append("\n### Examples per class (top corpus usage)\n")
ex = []
for c in order:
    rows = sorted((r for r in result.values() if r["class"] == c), key=lambda r: -r["usage"])[:5]
    for r in rows:
        ex.append((c, r["table"], r["type"], r["usage"], ev_summary(r)[:220]))
L.append(md_table(["class", "object", "type", "usage", "evidence"], ex))
L.append("\n### Condition shapes (FND_OBJECT_INSTANCE_SETS)\n")
shp = ["literal_id", "constant_true", "constant_false", "grant_parameter", "urda_direct", "urda_derived", "datasec_context", "session_util", "plain_column_filter", "exists_other_object", "other"]
L.append(md_table(["shape", "all sets", "in active grant", "active seed", "as_is", "isolated_required", "pod_specific", "HCM profile-compiled", "HCM placeholder _S", "HCM seed condition"],
                  [(s, summary["shapes"]["all"].get(s, 0), summary["shapes"]["active"].get(s, 0), summary["shapes"]["active_seed"].get(s, 0),
                    summary["shapes"]["shape_x_emission_active_seed"].get(f"{s}|as_is", 0), summary["shapes"]["shape_x_emission_active_seed"].get(f"{s}|isolated_required", 0),
                    summary["shapes"]["shape_x_emission_active_seed"].get(f"{s}|pod_specific", 0),
                    *[sum(1 for r in cond_rows if r["shape"] == s and r["hcm_family"] == f) for f in ("profile_compiled", "placeholder_S", "seed_condition")]) for s in shp]
                  + [("TOTAL", len(cond_rows), len(active), len(seed_active), summary["shapes"]["emission_active_seed"].get("as_is", 0), summary["shapes"]["emission_active_seed"].get("isolated_required", 0), summary["shapes"]["emission_active_seed"].get("pod_specific", 0),
                      *[summary["shapes"]["hcm_family"].get(f, 0) for f in ("profile_compiled", "placeholder_S", "seed_condition")])]))
L.append("\n### Customer layer (CREATED_BY <> SEED_DATA_FROM_APPLICATION)\n")
L.append(md_table(["object", "db object", "in catalog", "custom object", "instance set", "created by", "active", "links", "privileges", "shape"],
                  [(r["obj_name"], r["database_object_name"], "Y" if r["in_catalog"] else "N", "Y" if r["custom_object"] else "N", r["instance_set_name"], r["created_by"], r["in_active_grant"], r["links"], ", ".join(r["privileges"]), r["shape"]) for r in sorted(cust_rows, key=lambda r: (r["obj_name"], r["instance_set_name"]))]))
L.append("\n### Leaky / strict columns — top-50 corpus-used VIA_JOIN tables\n")
top_vj = sorted((r for r in result.values() if r["class"] == "VIA_JOIN"), key=lambda r: -r["usage"])[:50]
L.append(md_table(["table", "usage", "column", "context", "reference object", "NOT NULL", "verdict", "corpus joins", "corpus filters", "product privileges on reference"],
                  [(r["table"], r["usage"], c["column"], c["context"], f"{c['ref_object']}.{c['ref_column']}", "no" if c["nullable"] else ("yes" if c["nullable"] is False else "?"), c["strictness"], c["corpus_joins"], c["corpus_filters"],
                    f"{len(c['candidate_privileges'])} ({', '.join(p['privilege'] for p in c['candidate_privileges'][:3])}{'…' if len(c['candidate_privileges']) > 3 else ''})") for r in top_vj for c in r["evidence"]["columns"]]))
L.append("\n### module -> reference object -> privilege candidates (top products)\n")
mp = []
for prod in TOP_PRODUCTS:
    pairs = Counter()
    tabs = Counter()
    for r in result.values():
        if r["class"] != "VIA_JOIN" or r["module"] != prod:
            continue
        for c in r["evidence"]["columns"]:
            pairs[(c["context"], c["ref_object"])] += 1
            tabs[(c["context"], c["ref_object"])] += 1
    direct_n = sum(1 for r in result.values() if r["class"] == "DIRECT" and r["module"] == prod)
    for (ctx, ref), n in pairs.most_common():
        cands = candidate_privileges(ref, prod, report_only=prod in HCM_PREFIXES)
        mp.append((prod, ctx, ref, n, len(cands), ", ".join(f"{p['privilege']} ({p['roles']} roles{', iso' if p['needs_isolation'] else ''})" for p in cands[:6]) + ("…" if len(cands) > 6 else "") or "(none with prefix " + prod + "_ — unmapped)"))
    mp.append((prod, "(DIRECT objects)", "-", direct_n, "-", ", ".join(sorted(n for n, r in result.items() if r["class"] == "DIRECT" and r["module"] == prod)[:8]) + ("…" if direct_n > 8 else "")))
L.append(md_table(["product", "context", "reference object", "VIA_JOIN columns", "candidates", "privileges (roles)"], mp))
L.append("\n### DIRECT objects — privileges per object (top-30 by corpus usage)\n")
top_d = sorted((r for r in result.values() if r["class"] == "DIRECT"), key=lambda r: -r["usage"])[:30]
L.append(md_table(["object", "type", "usage", "registered as", "pk", "privileges", "isolation needed", "customer sets", "literal ids", "view base tables"],
                  [(r["table"], r["type"], r["usage"], r["evidence"]["object"] + (f" -> {r['evidence']['database_object']}" if r["evidence"]["db_object_differs"] else ""), ",".join(r["evidence"]["pk"]),
                    f"{r['evidence']['privilege_count']}: " + ", ".join(p["privilege"] for p in r["evidence"]["privileges"][:5]) + ("…" if r["evidence"]["privilege_count"] > 5 else ""),
                    "yes" if r["evidence"]["needs_isolation_any"] else "no", "yes" if r["evidence"]["has_customer_sets"] else "no", "yes" if r["evidence"]["has_literal_ids"] else "no",
                    ", ".join((r["evidence"]["view_base_tables"] or [])[:6]) if r["type"] == "VIEW" else "-") for r in top_d]))
L.append("\n### VIA_PARENT — examples (top-20 by corpus usage)\n")
top_p = sorted((r for r in result.values() if r["class"] == "VIA_PARENT"), key=lambda r: -r["usage"])[:20]
L.append(md_table(["table", "usage", "join column", "parent", "parent class", "source", "NOT NULL", "chain verdict", "hops"],
                  [(r["table"], r["usage"], r["evidence"]["column"], f"{r['evidence']['parent']}.{r['evidence']['parent_column']}", r["evidence"]["parent_class"], r["evidence"]["source"] + (f" ({r['evidence']['occurrences']} stmts, {int(r['evidence']['share']*100)}%)" if r["evidence"]["source"] == "corpus_join" else ""),
                    "no" if r["evidence"]["nullable"] else ("yes" if r["evidence"]["nullable"] is False else "?"), r["evidence"]["chain_strictness"], r["evidence"]["hops"]) for r in top_p]))
L.append("\n### HCM — totals per class (hcm=Y: HCM-prefixed objects, classified like everything else)\n")
L.append(md_table(["class", "objects", "TABLE", "VIEW", "corpus-used (>=1 statement)"],
                  [(c, hcm_summary["classes"].get(c, 0), hcm_summary["classes_by_type"][c].get("TABLE", 0), hcm_summary["classes_by_type"][c].get("VIEW", 0), hcm_summary["corpus_used_by_class"][c]) for c in order]
                  + [("TOTAL", len(hcm_rows), sum(1 for r in hcm_rows if r["type"] == "TABLE"), sum(1 for r in hcm_rows if r["type"] == "VIEW"), sum(1 for r in hcm_rows if r["usage"] > 0))]))
L.append("\n### HCM — anchors (context column -> registered object; Report privilege; Oracle's secured list view)\n")
L.append(md_table(["context column", "anchor", "class", "usage", "grant kinds (links)", "report privilege", "report-privilege links (kinds) / roles", "secured list view", "in dictionary", "lineage = anchor", "secured-list corpus usage", "VIA_JOIN columns (primary tables)"],
                  [(a["column"], n, a["class"], a["anchor_usage"], json.dumps(a["grant_kinds"]), a["report_privilege"] + ("" if a["report_privilege_registered"] else " (NOT registered)"),
                    f"{json.dumps(a['report_privilege_kinds'])} / {a['report_privilege_roles']}", a["secured_list"] or "-",
                    "yes" if a["secured_list_in_dictionary"] else ("-" if not a["secured_list"] else "NO"), "yes" if a["secured_list_lineage_ok"] else "-",
                    a["secured_list_corpus_usage"], f"{a['via_join_columns']} ({a['via_join_primary_tables']})") for n, a in hcm_anchors.items()]))
L.append("\n### HCM — DIRECT objects by grant mix (kinds of the object's active grant links)\n")
L.append(md_table(["grant mix", "objects", "corpus-used", "examples (top usage)"],
                  [(mix, n, sum(1 for r in hcm_direct if "+".join(sorted(r["evidence"]["grant_kinds"])) == mix and r["usage"] > 0),
                    ", ".join(r["table"] for r in sorted((r for r in hcm_direct if "+".join(sorted(r["evidence"]["grant_kinds"])) == mix), key=lambda r: -r["usage"])[:6]))
                   for mix, n in sorted(hcm_summary["direct"]["grant_mix"].items(), key=lambda kv: -kv[1])]))
L.append("\n### HCM — linked seed conditions by template (instance sets in an active grant on HCM objects)\n")
L.append(md_table(["sets", "objects", "family", "example set", "shape", "emission", "references", "template"],
                  [(t["sets"], t["objects"], "+".join(sorted(t["families"])), t["example_set"], t["shape"], t["emission"], ", ".join(t["references"][:6]), t["template"][:260]) for t in hcm_template_rows[:30]]))
L.append("\n### HCM — profile-compiled sets (HcmSecurityProfilesUI) by profile type\n")
L.append(md_table(["profile type (HCM_<type>_<id>)", "sets", "objects", "non-HCM-prefix objects", "linked", "active", "templates", "constant 1=1", "literal ids", "profiles (set descriptions)", "dominant template"],
                  [(p["profile_type"], p["sets"], p["objects"], p["objects_non_hcm_prefix"], p["linked"], p["active"], p["distinct_templates"], p["constant_true"], p["with_literal_id"], "; ".join(p["profiles"]), p["dominant_template"][:200]) for p in prof_rows]))
L.append("\n### HCM — VIA_JOIN tables (top-40 by corpus usage)\n")
top_hvj = sorted(hcm_vj, key=lambda r: -r["usage"])[:40]
L.append(md_table(["table", "type", "usage", "HCM context columns [verdict]", "primary anchor", "secured list view", "report privilege (links)", "report candidates"],
                  [(r["table"], r["type"], r["usage"], "; ".join(f"{c['column']} [{c['strictness']}]" for c in r["evidence"]["columns"]), r["evidence"]["columns"][0]["ref_object"],
                    r["evidence"]["columns"][0].get("secured_list") or "-", f"{r['evidence']['columns'][0].get('report_privilege')} {json.dumps(r['evidence']['columns'][0].get('report_privilege_grant_kinds'))}",
                    len(r["evidence"]["columns"][0]["candidate_privileges"])) for r in top_hvj]))
L.append("\n### HCM — the rest (top-30 corpus-used VIA_PARENT / UNSECURABLE / REGISTERED_NO_GRANT)\n")
rest = sorted((r for r in hcm_rows if r["class"] in ("UNSECURABLE", "VIA_PARENT", "REGISTERED_NO_GRANT")), key=lambda r: -r["usage"])[:30]
L.append(md_table(["table", "type", "usage", "class", "evidence"], [(r["table"], r["type"], r["usage"], r["class"], ev_summary(r)[:200]) for r in rest]))
open(os.path.join(OUT, "report_tables.md"), "w", encoding="utf-8").write("\n".join(L))
# the same tables one file each, so the report can interleave them with its prose
os.makedirs(os.path.join(OUT, "tables"), exist_ok=True)
for block in ("\n" + "\n".join(L)).split("\n### ")[1:]:
    title, _, body = block.partition("\n")
    slug = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_")[:60]
    open(os.path.join(OUT, "tables", slug + ".md"), "w", encoding="utf-8").write(body.strip() + "\n")
log("done:", ", ".join(sorted(os.listdir(OUT))))
