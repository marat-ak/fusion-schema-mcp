"""DB-driven per-phase/wave export for the per-wave supervisor. Runs on the box (python3 + sqlite3 stdlib).

  PHASE=view WAVE=0  python export_wave.py      -> enrich_input.view.w0.jsonl  (only depth-0 views)
  PHASE=otbi         python export_wave.py      -> enrich_input.otbi.jsonl
  PHASE=bip          python export_wave.py      -> enrich_input.bip.jsonl      (+ flexfield ATTRIBUTEn if FLEX set)

View CARDS come from sql_units.description_generated (populated by persist_wave.py after each earlier wave),
so wave N sees wave <N's FULL generated descriptions — no runtime overlay, no clip. Column remarks come from
view_column_remarks (base+inherited+computed) / schema / curated. Env: SQLS, SCH, CURATED, FLEX, OUT.
"""
import sqlite3, json, re, os, hashlib
SQLS = os.environ.get("SQLS", "sqls.sqlite")
SCH  = os.environ.get("SCH", "schema.sqlite")
CURATEDF = os.environ.get("CURATED", "curated_column_remarks.json")
FLEXF = os.environ.get("FLEX", "")                      # optional bip flexfield registry (json: col -> [{context,label}])
PHASE = os.environ.get("PHASE", "view")
WAVE = int(os.environ.get("WAVE", "0"))
OUT = os.environ.get("OUT", f"enrich_input.{PHASE}" + (f".w{WAVE}" if PHASE == "view" else "") + ".jsonl")
ARTIFACT = re.compile(r'^(XMLTABLE|DUAL|SAWITH\d+)$')
PSEUDO = {"ROWNUM", "ROWID", "LEVEL", "ORA_ROWSCN", "CONNECT_BY_ISLEAF", "CONNECT_BY_ISCYCLE"}
ATTR = re.compile(r'^(ATTRIBUTE|GLOBAL_ATTRIBUTE)(_CHAR|_NUMBER|_DATE|_TIMESTAMP)?\d+$')
SQL_CLIP = {"view": 40000, "otbi": 40000, "bip-report": 40000}

sch = sqlite3.connect(SCH)
tmeta = {n: (t, m, (r or "").strip()) for n, t, m, r in sch.execute("SELECT name,type,module,remarks FROM tables")}
crem = {(t, n): r.strip() for t, n, r in sch.execute("SELECT table_name,name,remarks FROM columns") if r and r.strip()}
VIEWSET = set(n for n, m in tmeta.items() if m[0] == "VIEW")
con = sqlite3.connect(SQLS); q = con.cursor()
try: con.execute("ALTER TABLE sql_units ADD COLUMN description_generated TEXT")
except Exception: pass
descgen = dict(con.execute("SELECT name, description_generated FROM sql_units WHERE source='view' AND description_generated IS NOT NULL").fetchall())
vrem = {}
for v, c, rm in con.execute("SELECT view,column,remark FROM view_column_remarks WHERE remark IS NOT NULL"):
    vrem[(v, c)] = rm
CURATED = {tuple(k.split("|", 1)): v for k, v in json.load(open(CURATEDF, encoding="utf-8")).items()} if os.path.exists(CURATEDF) else {}
_flexraw = json.load(open(FLEXF, encoding="utf-8")) if FLEXF and os.path.exists(FLEXF) else {}
FLEX = _flexraw.get("columns", _flexraw)     # {COLUMN: [{context,label,code}]}  (old flat format still accepted)
ADF = _flexraw.get("adf", {})                # {TABLE: {EXTN_COLUMN: label}} — physical-table keyed, direct lookup

CTXCOL = re.compile(r'CONTEXT|CATEGORY')                       # predicate columns that carry the flexfield context value
_SUFX = re.compile(r'_(B|VL|TL|ALL|F|ADD_INFO|ADD_IN)$')
def _codes_for_table(t):                                       # table -> candidate flexfield_code(s) (Fusion suffix convention: EGO_ITEM_EFF_B -> EGO_ITEM_EFF)
    t = (t or "").upper()
    return {t, _SUFX.sub("", t)}

def remark(t, c, ctxset=()):
    cu = (c or "").upper()
    if ADF and cu.startswith("EXTN_"):                         # ADF extension: exact (table, column) -> real display name
        lbl = ADF.get((t or "").upper(), {}).get(cu)
        if lbl:
            return "ADF extension field: " + lbl
    if FLEX and ATTR.match(cu):                                # flexfield column: send the REAL per-context meanings, not the generic 'Descriptive Flexfield' placeholder
        segs = FLEX.get(cu)
        if segs:
            hit = [s for s in segs if (s.get("context") or "").strip().upper() in ctxset] if ctxset else []
            if hit:                                            # unit filters context(s): pass ALL matching values so the model picks by the row's CONTEXT_CODE
                seen = set(); u = []
                for s in hit:
                    k = (s.get("context"), s.get("label"))
                    if k not in seen: seen.add(k); u.append(s)
                return "flexfield (value by CONTEXT_CODE): " + "; ".join(f"[{s['context']}] {s['label']}" for s in u[:16])
            cand = _codes_for_table(t)                         # no CONTEXT_CODE predicate in the SQL
            byc = [s for s in segs if (s.get("code") or "").upper() in cand]
            if byc:                                            # (else fall through to the base remark — don't show an unrelated flexfield's contexts)
                if "_EFF" in (t or "").upper():                # EFF is meaningless without a context (~1% anomaly) — mark unresolved so the model flags it via flexMissed
                    return f"extensible flexfield: no CONTEXT_CODE in query — meaning unresolved ({len({s.get('context') for s in byc})} contexts defined)"
                labels = {s["label"] for s in byc}             # DFF with omitted context = GLOBAL segment (valid Oracle usage), NOT an error
                if len(labels) == 1:
                    return "flexfield (global segment): " + next(iter(labels))
                return f"descriptive flexfield global segment (context omitted; {len(labels)} configured meanings — customer/global-defined)"
    r = (vrem.get((t, c)) if t in VIEWSET else crem.get((t, c)))
    if r and re.sub(r"[\s_]+", "", r.strip().upper()) == re.sub(r"[\s_]+", "", (c or "").upper()):
        r = None                                               # junk dictionary remark (= the column name itself, e.g. 'LOOKUP_TYPE: LOOKUP_TYPE') -> fall to CURATED
    return r or CURATED.get((t, c))

def card(name):
    if name in VIEWSET and name in descgen:      # generated description from a prior wave's persist
        return {"name": name, "type": "VIEW", "module": tmeta.get(name, (None, None))[1], "card": descgen[name][:4000]}
    m = tmeta.get(name)
    return ({"name": name, "type": m[0], "module": m[1], "card": (m[2] or "")[:400]} if m
            else {"name": name, "type": "UNKNOWN", "module": None, "card": ""})

# unit selection by phase/wave
if PHASE == "view":
    depth = dict(con.execute("SELECT view_name,depth FROM view_waves").fetchall())
    rows = con.execute("SELECT id,source,name,title,COALESCE(sql_for_parse,original_sql),parse_quality FROM sql_units "
                       "WHERE source='view' AND excluded_reason IS NULL").fetchall()
    rows = [r for r in rows if depth.get(r[2], 0) == WAVE]
else:
    src = "otbi" if PHASE == "otbi" else "bip-report"
    rows = con.execute("SELECT id,source,name,title,COALESCE(sql_for_parse,original_sql),parse_quality FROM sql_units "
                       "WHERE source=? AND excluded_reason IS NULL", (src,)).fetchall()

IDS = os.environ.get("IDS", "")                                # optional: restrict to specific unit ids (file of ids, or comma list) — for A/B re-export of a subset
if IDS:
    want = set(x.strip() for x in (open(IDS, encoding="utf-8").read().splitlines() if os.path.exists(IDS) else IDS.split(",")) if x.strip())
    rows = [r for r in rows if str(r[0]) in want]

# sort by table-set so units sharing an identical TABLE CARDS block are adjacent -> vLLM prefix-cache reuse
_tm = {}
for _u, _t in con.execute("SELECT unit_id,table_name FROM x_tables WHERE is_cte=0"):
    _tm.setdefault(_u, []).append(_t)
rows.sort(key=lambda r: (tuple(sorted(_tm.get(r[0], []))), r[0]))

qTab = con.cursor(); qPre = con.cursor(); qJoin = con.cursor(); qProj = con.cursor(); qCol = con.cursor(); qBind = con.cursor(); qCtx = con.cursor()
out = open(OUT, "w", encoding="utf-8"); n = 0
for uid, source, name, title, sql, pq in rows:
    tabs = [r[0] for r in qTab.execute("SELECT table_name FROM x_tables WHERE unit_id=? AND is_cte=0 ORDER BY table_name", (uid,)) if not ARTIFACT.match(r[0])]
    ctxset = set()                                              # flexfield context value(s) the unit filters -> picks the right ATTRIBUTE_CHARn meaning
    for cc, lv in qCtx.execute("SELECT column_name,literal FROM x_predicates WHERE unit_id=? AND literal IS NOT NULL", (uid,)):
        if cc and CTXCOL.search(cc.upper()) and lv:
            ctxset.add(lv.strip().strip("'\"").upper())
    preds = []
    for seq, t, c, op, lit, fi in qPre.execute("SELECT seq,table_name,column_name,op,literal,found_in FROM x_predicates WHERE unit_id=? ORDER BY seq", (uid,)):
        if (c or "").upper() in PSEUDO: continue
        d = remark(t, c, ctxset)
        preds.append({"seq": seq, "t": t, "c": c, "op": op, "lit": lit, "in": fi, "d": (d[:400] if d else None)})
    seen = set(); by_rem = {}
    for t, c in qCol.execute("SELECT DISTINCT table_name,column_name FROM x_columns WHERE unit_id=? AND context IN ('select','join','where')", (uid,)):
        if (t, c) in seen: continue
        seen.add((t, c)); d = remark(t, c, ctxset)
        if d: by_rem.setdefault(d[:400], []).append(f"{t}.{c}")
    notes = [{"cols": cols[:24], "d": d} for d, cols in list(by_rem.items())[:120]]
    clip = SQL_CLIP.get(source, 12000); sql = sql or ""
    row = {
        "id": uid, "source": source,
        "phase": 0 if source == "view" else 1 if source == "otbi" else 2,
        "wave": WAVE if source == "view" else 0,
        "name": name, "title": title, "parseQuality": pq,
        "sql": sql[:clip], "sqlTruncated": len(sql) > clip,
        "tables": [card(t) for t in tabs],
        "joins": [f"{a}.{b}={cc}.{dd}[{e}]" for a, b, cc, dd, e in qJoin.execute("SELECT from_t,from_c,to_t,to_c,join_type FROM x_joins WHERE unit_id=?", (uid,))],
        "predicates": preds,
        "projection": [{"i": s, "a": al, "e": (ex or "")[:120]} for s, al, ex in qProj.execute("SELECT seq,alias,source_expr FROM x_projection WHERE unit_id=? ORDER BY seq LIMIT 60", (uid,))],
        "columnNotes": notes,
        "binds": [b[0] for b in qBind.execute("SELECT DISTINCT name FROM x_params WHERE unit_id=? AND kind='bind'", (uid,))],
    }
    row["ghash"] = hashlib.md5(json.dumps({k: v for k, v in row.items() if k not in ("id", "name", "title")},
                                          sort_keys=True, ensure_ascii=False).encode()).hexdigest()  # grounding version: same grounding => same hash; changed grounding => client re-runs
    out.write(json.dumps(row, ensure_ascii=False) + "\n"); n += 1
out.close()
print(f"[export] PHASE={PHASE}" + (f" WAVE={WAVE}" if PHASE == "view" else "") + f" -> {OUT} ({n} units)")
