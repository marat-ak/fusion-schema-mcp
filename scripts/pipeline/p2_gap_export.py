"""P2-gap (a) — build the enrichment prompt payload for the L3 statements that carry no
generation-2 record, reading `work` instead of the retired sqlite pair.

This is a PORT of scripts/gpu-enrich/export_wave.py, not a new prompt. That script built
every one of the 23,610 records we already hold; a prompt that differs in any block would
make the new rows a different generation wearing the same label. Everything that shapes the
payload — the FACTS block field set, the remark resolution order, the flexfield/ADF
annotation wording, the 400/4000-char card and remark clips, the 40,000-char SQL clip, the
table-set sort, the `ghash` formula — is carried across verbatim. Only the I/O ends change:

    in    work.clear_sql                       instead of sqls.sqlite sql_units
    facts work.r_tables / f_columns / f_joins  instead of the x_* tables
          work.f_predicates / f_projection / f_params
    dict  work.meta_tables / work.meta_columns instead of schema.sqlite tables/columns
    views work.view_column_remarks             the same derived table, landed by p2_gap_vcr.py
    cards work.clear_sql.description (views)   instead of sql_units.description_generated

WHAT IS NOT THE SAME, and cannot be (report, do not paper over):

  * The FACTS come from the fresh pinned sqlglot 30.18.0 parse (`work.f_*`), not from the
    August extractor that produced `x_*`. That extractor is gone. So a re-export of an
    already-enriched statement yields a DIFFERENT ghash than the stored one — same formula,
    different grounding. ghash compares runs of the same parse, which is exactly what it is
    for; it is not a back-key into the August facts.
  * No view waves: this is one pass, so `wave` is 0 on every row (it was the view-dependency
    depth in the original run and only ever non-zero for views).

The VIEW column remarks ARE carried (decision, 2026-09-20): `p2_gap_vcr.py` lands the 222,510
rows in `work.view_column_remarks` from the run's own sqls.sqlite. Run it before exporting —
without it every VIEW column goes silent, because the vendor dictionary has a remark on 0 of
243,778 of them.

DETERMINISM, AND WHY THE DATABASE IS NOT ASKED TO SORT. `p3_parse.py` wrote every fact list
through Python `sorted()` (`sorted(tables)`, `sorted(set(columns))`, `sorted(set(joins))`,
`sorted(set(params))`; predicates and projection carry an explicit `seq`). That is codepoint
order — the same order sqlite's BINARY collation handed export_wave.py. Postgres' default
collation is linguistic and ignores `_` at the primary level, so `ORDER BY table_name` yields
BEN_BILL_CHARGE_DETAILS before BEN_BILL_CHARGES where byte order yields the reverse; measured,
that reordered the table list on 18 of 199 sampled statements and moved every one of their
ghashes. So each list is fetched unordered and sorted here, in Python, exactly as the parse
sorted it. Order is part of the payload and therefore part of the key.

THE VENDOR DICTIONARY CARRIES THE STRING 'null'. `work.meta_columns.remarks` holds the
four-character text `null` on exactly the 244,409 rows where schema.sqlite had SQL NULL
(17,022 in meta_tables.remarks, 11,426 in application_short_name) — a JSON null stringified
on the way into `raw`. It is mapped back to NULL here; without that the prompt would assert
"COLUMN: null" as a column meaning a quarter of a million times.

Every input is explicit. No default endpoint, path, cohort or instance — a missing one is a
hard failure, never a substituted value.

  python p2_gap_export.py --cohort gap --out enrich_input.gap.jsonl \
                          --curated curated_column_remarks.json --no-flex
"""
import argparse
import hashlib
import json
import os
import re
import sys

import psycopg

# --- verbatim from export_wave.py -------------------------------------------------------
ARTIFACT = re.compile(r'^(XMLTABLE|DUAL|SAWITH\d+)$')
PSEUDO = {"ROWNUM", "ROWID", "LEVEL", "ORA_ROWSCN", "CONNECT_BY_ISLEAF", "CONNECT_BY_ISCYCLE"}
ATTR = re.compile(r'^(ATTRIBUTE|GLOBAL_ATTRIBUTE)(_CHAR|_NUMBER|_DATE|_TIMESTAMP)?\d+$')
SQL_CLIP = {"view": 40000, "otbi": 40000, "bip-report": 40000}
CTXCOL = re.compile(r'CONTEXT|CATEGORY')
_SUFX = re.compile(r'_(B|VL|TL|ALL|F|ADD_INFO|ADD_IN)$')
# ----------------------------------------------------------------------------------------

#: the dictionary's spelling of "no remark" after the raw import stringified JSON null
NULLTEXT = "null"


def nn(v):
    """Vendor-dictionary text -> None when it carries no meaning."""
    if v is None:
        return None
    v = v.strip()
    return None if (v == "" or v == NULLTEXT) else v


def log(m):
    print(f"[p2-gap-export] {m}", flush=True)


def _codes_for_table(t):
    t = (t or "").upper()
    return {t, _SUFX.sub("", t)}


class Exporter:
    def __init__(self, conn, dconn, curated, flexraw):
        self.conn = conn        # autocommit; short per-statement reads
        self.dconn = dconn      # transactional; server-side cursors for the 1.45M-row load
        self.CURATED = curated
        self.FLEX = flexraw.get("columns", flexraw) if flexraw else {}
        self.ADF = flexraw.get("adf", {}) if flexraw else {}
        self.tmeta = {}
        self.crem = {}
        self.vrem = {}
        self.VIEWSET = set()
        self.descgen = {}

    # -- dictionary -----------------------------------------------------------------
    def load(self):
        # schema.sqlite held TABLE and VIEW only. meta_tables also carries PACKAGE /
        # FUNCTION / PROCEDURE rows; including them would hand a referenced package a
        # typed card where the original emitted UNKNOWN, so the filter is part of the
        # port, not a tidy-up.
        n = 0
        with self.dconn.cursor(name="tmeta") as cur:
            cur.itersize = 50_000
            cur.execute("SELECT table_name, table_type, application_short_name, remarks "
                        "FROM work.meta_tables WHERE table_type IN ('TABLE','VIEW')")
            for name, typ, module, remarks in cur:
                self.tmeta[sys.intern(name)] = (typ, nn(module), (nn(remarks) or "").strip())
                n += 1
        self.VIEWSET = {k for k, v in self.tmeta.items() if v[0] == "VIEW"}
        log(f"dictionary: {n} objects ({len(self.VIEWSET)} views)")

        c = 0
        with self.dconn.cursor(name="crem") as cur:
            cur.itersize = 100_000
            cur.execute("SELECT table_name, column_name, remarks FROM work.meta_columns "
                        "WHERE remarks IS NOT NULL AND remarks <> %s", (NULLTEXT,))
            for t, col, r in cur:
                r = r.strip()
                if r:
                    self.crem[(sys.intern(t), sys.intern(col))] = r
                    c += 1
        log(f"column remarks: {c}")

        # VIEW column meanings — the derived table, landed by p2_gap_vcr.py. The dictionary has
        # none for views (0 of 243,778 columns), so this is the whole of it. Replayed in `seq`
        # (sqlite rowid) order because export_wave.py's `vrem[(v, c)] = rm` is LAST WINS and two
        # (view, column) pairs have duplicate rows that disagree.
        if not self.dconn.execute("SELECT to_regclass('work.view_column_remarks')").fetchone()[0]:
            raise SystemExit(
                "work.view_column_remarks is missing — run `p2_gap.sh vcr` first.\n"
                "  Exporting without it silently drops every VIEW column meaning "
                "(the dictionary has none), which is a different prompt, not a smaller one.")
        v = 0
        with self.dconn.cursor(name="vrem") as cur:
            cur.itersize = 100_000
            cur.execute("SELECT view_name, column_name, remark FROM work.view_column_remarks "
                        "WHERE remark IS NOT NULL ORDER BY seq")
            for vn, col, r in cur:
                self.vrem[(sys.intern(vn), sys.intern(col))] = r
                v += 1
        log(f"view column remarks: {v} rows -> {len(self.vrem)} (view,column) keys")

        # the card overlay. In the original run this was sql_units.description_generated,
        # written back by persist_wave.py after each view wave. Its analogue in `work` is
        # the promoted generation-2 description on the view's own L3 row.
        rows = self.dconn.execute(
            "SELECT substring(u.unit_id from 6), c.description "
            "FROM work.sql_unit u JOIN work.clear_sql c ON c.sql_hash = u.sql_hash "
            "WHERE u.source = 'view' AND u.unit_id LIKE 'view:%' AND c.description IS NOT NULL"
        ).fetchall()
        self.descgen = {n: d for n, d in rows}
        log(f"view cards from generation-2 descriptions: {len(self.descgen)}")

    # -- verbatim port of export_wave.remark() --------------------------------------
    def remark(self, t, c, ctxset=()):
        cu = (c or "").upper()
        if self.ADF and cu.startswith("EXTN_"):
            lbl = self.ADF.get((t or "").upper(), {}).get(cu)
            if lbl:
                return "ADF extension field: " + lbl
        if self.FLEX and ATTR.match(cu):
            segs = self.FLEX.get(cu)
            if segs:
                hit = [s for s in segs if (s.get("context") or "").strip().upper() in ctxset] if ctxset else []
                if hit:
                    seen = set(); u = []
                    for s in hit:
                        k = (s.get("context"), s.get("label"))
                        if k not in seen:
                            seen.add(k); u.append(s)
                    return "flexfield (value by CONTEXT_CODE): " + "; ".join(f"[{s['context']}] {s['label']}" for s in u[:16])
                cand = _codes_for_table(t)
                byc = [s for s in segs if (s.get("code") or "").upper() in cand]
                if byc:
                    if "_EFF" in (t or "").upper():
                        return f"extensible flexfield: no CONTEXT_CODE in query — meaning unresolved ({len({s.get('context') for s in byc})} contexts defined)"
                    labels = {s["label"] for s in byc}
                    if len(labels) == 1:
                        return "flexfield (global segment): " + next(iter(labels))
                    return f"descriptive flexfield global segment (context omitted; {len(labels)} configured meanings — customer/global-defined)"
        # export_wave.py:71 — an EITHER/OR, not a chain: a VIEW column is resolved from the
        # derived table ONLY, a table column from the dictionary ONLY. Both then fall to CURATED.
        r = (self.vrem.get((t, c)) if t in self.VIEWSET else self.crem.get((t, c)))
        if r and re.sub(r"[\s_]+", "", r.strip().upper()) == re.sub(r"[\s_]+", "", (c or "").upper()):
            r = None
        return r or self.CURATED.get((t, c))

    # -- verbatim port of export_wave.card() ----------------------------------------
    def card(self, name):
        if name in self.VIEWSET and name in self.descgen:
            return {"name": name, "type": "VIEW", "module": self.tmeta.get(name, (None, None))[1],
                    "card": self.descgen[name][:4000]}
        m = self.tmeta.get(name)
        return ({"name": name, "type": m[0], "module": m[1], "card": (m[2] or "")[:400]} if m
                else {"name": name, "type": "UNKNOWN", "module": None, "card": ""})

    # -- cohort ---------------------------------------------------------------------
    def cohort(self, mode, ids_file):
        if mode == "gap":
            # `excluded_reason IS NULL` is export_wave.py's own selection, kept deliberately.
            # It removes the 151 `dynamic_lexical` statements — the ones whose `&LEXICAL`
            # parameters only parse after substitution. They are excluded because the FACTS
            # would misdescribe them, not because they are hard: `p3_parse.py` substitutes
            # `&X -> NULL`, so 71 of the 151 carry a literal NULL in their projection facts
            # while the SQL text still shows the `&` token, and nothing in the prompt says a
            # substitution happened. Fixing that means re-parsing with a placeholder that
            # survives (`&X -> X_LEXICAL`), which changes `work.f_*` — the frozen parse of
            # record — and is a p3 decision, not an export flag. Deferred, not forgotten.
            sql = ("SELECT c.sql_hash, c.source, c.primary_unit_id, c.title, c.sql_text, "
                   "       c.parse_quality "
                   "FROM work.clear_sql c "
                   "WHERE c.description IS NULL AND c.excluded_reason IS NULL")
            args = ()
        else:
            want = [x.strip() for x in open(ids_file, encoding="utf-8").read().splitlines() if x.strip()]
            if not want:
                raise SystemExit(f"--ids {ids_file} is empty")
            # an id may be given as a sql_hash or as any L2 unit_id that lands on it
            sql = ("SELECT c.sql_hash, c.source, c.primary_unit_id, c.title, c.sql_text, "
                   "       c.parse_quality "
                   "FROM work.clear_sql c WHERE c.sql_hash = ANY(%s) OR c.sql_hash IN "
                   "  (SELECT u.sql_hash FROM work.sql_unit u WHERE u.unit_id = ANY(%s))")
            args = (want, want)
        rows = self.conn.execute(sql, args).fetchall()

        # sort by table-set so statements sharing an identical TABLE CARDS block are
        # adjacent -> the server's prefix cache reuses the shared prefix (export_wave.py:99).
        tm = {}
        for h, t in self.conn.execute(
                "SELECT r.sql_hash, r.table_name FROM work.r_tables r "
                "WHERE NOT r.is_cte AND r.sql_hash = ANY(%s)", ([r[0] for r in rows],)):
            tm.setdefault(h, []).append(t)
        rows.sort(key=lambda r: (tuple(sorted(tm.get(r[0], []))), r[0]))
        return rows

    # -- the payload ----------------------------------------------------------------
    def build(self, row):
        sql_hash, source, unit_id, title, sql, pq = row
        name = unit_id[5:] if unit_id.startswith("view:") else None

        # ORDERING IS PART OF THE PAYLOAD, so it is done in Python, never by the database.
        # p3_parse.py wrote every fact list through Python `sorted()` — codepoint order, the
        # same order sqlite's BINARY collation returned to export_wave.py. Postgres' default
        # collation is linguistic and ignores punctuation at the primary level, so an
        # `ORDER BY table_name` there returns BEN_BILL_CHARGE_DETAILS before BEN_BILL_CHARGES
        # while byte order puts them the other way round. That silently moves `ghash` on
        # roughly one statement in ten. sorted() here reproduces the parse's own order exactly.
        tabs = [t for t in sorted(t for (t,) in self.conn.execute(
            "SELECT table_name FROM work.r_tables WHERE sql_hash=%s AND NOT is_cte",
            (sql_hash,))) if not ARTIFACT.match(t)]

        ctxset = set()
        for cc, lv in self.conn.execute(
                "SELECT column_name, literal FROM work.f_predicates "
                "WHERE sql_hash=%s AND literal IS NOT NULL ORDER BY seq", (sql_hash,)):
            if cc and CTXCOL.search(cc.upper()) and lv:
                ctxset.add(lv.strip().strip("'\"").upper())

        preds = []
        for seq, t, c, op, lit, fi in self.conn.execute(
                "SELECT seq, table_name, column_name, op, literal, found_in "
                "FROM work.f_predicates WHERE sql_hash=%s ORDER BY seq", (sql_hash,)):
            if (c or "").upper() in PSEUDO:
                continue
            d = self.remark(t, c, ctxset)
            preds.append({"seq": seq, "t": t, "c": c, "op": op, "lit": lit, "in": fi,
                          "d": (d[:400] if d else None)})

        seen = set(); by_rem = {}
        for t, c in sorted(set(self.conn.execute(
                "SELECT DISTINCT table_name, column_name FROM work.f_columns "
                "WHERE sql_hash=%s AND context IN ('select','join','where')", (sql_hash,)))):
            if (t, c) in seen:
                continue
            seen.add((t, c))
            d = self.remark(t, c, ctxset)
            if d:
                by_rem.setdefault(d[:400], []).append(f"{t}.{c}")
        notes = [{"cols": cols[:24], "d": d} for d, cols in list(by_rem.items())[:120]]

        clip = SQL_CLIP.get(source, 12000)
        sql = sql or ""
        joins = [f"{a}.{b}={cc}.{dd}[{e}]" for a, b, cc, dd, e in sorted(set(self.conn.execute(
            "SELECT from_t, from_c, to_t, to_c, join_type FROM work.f_joins WHERE sql_hash=%s",
            (sql_hash,))))]
        proj = [{"i": s, "a": al, "e": (ex or "")[:120]} for s, al, ex in self.conn.execute(
            "SELECT seq, alias, source_expr FROM work.f_projection WHERE sql_hash=%s "
            "ORDER BY seq LIMIT 60", (sql_hash,))]
        binds = sorted({b for (b,) in self.conn.execute(
            "SELECT DISTINCT name FROM work.f_params WHERE sql_hash=%s AND kind='bind'",
            (sql_hash,))})

        row_out = {
            "id": unit_id, "source": source,
            "phase": 0 if source == "view" else 1 if source == "otbi" else 2,
            "wave": 0,
            "name": name, "title": title, "parseQuality": pq,
            "sql": sql[:clip], "sqlTruncated": len(sql) > clip,
            "tables": [self.card(t) for t in tabs],
            "joins": joins,
            "predicates": preds,
            "projection": proj,
            "columnNotes": notes,
            "binds": binds,
        }
        # ghash — export_wave.py:138, formula unchanged: md5 over the payload with the three
        # identity fields removed, so the same grounding hashes the same whichever unit
        # carries it. Computed BEFORE the key is added, exactly as there.
        row_out["ghash"] = hashlib.md5(
            json.dumps({k: v for k, v in row_out.items() if k not in ("id", "name", "title")},
                       sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        return row_out


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--cohort", choices=["gap", "ids"], required=True,
                    help="gap = every L3 statement with description IS NULL; ids = --ids file")
    ap.add_argument("--ids", help="file of sql_hash or unit_id, one per line (--cohort ids)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--curated", required=True, help="curated_column_remarks.json")
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--flex", help="flex_map.json — flexfield + ADF annotations ON")
    g.add_argument("--no-flex", action="store_true",
                   help="no flexfield map: matches the view/bip waves of the original run")
    args = ap.parse_args()

    if args.cohort == "ids" and not args.ids:
        raise SystemExit("--cohort ids requires --ids <file>")

    url = os.environ.get("DATABASE_URL")
    if not url:
        raise SystemExit("DATABASE_URL is required — no default")
    if not os.path.exists(args.curated):
        raise SystemExit(f"--curated {args.curated} does not exist")
    if args.flex and not os.path.exists(args.flex):
        raise SystemExit(f"--flex {args.flex} does not exist")

    curated = {tuple(k.split("|", 1)): v
               for k, v in json.load(open(args.curated, encoding="utf-8")).items()}
    flexraw = json.load(open(args.flex, encoding="utf-8")) if args.flex else {}
    log(f"curated remarks: {len(curated)} · flex map: "
        f"{args.flex if args.flex else 'OFF (--no-flex)'}")

    # two connections on purpose: the dictionary load needs server-side cursors (1.45M rows,
    # bounded memory) and therefore a transaction, and that snapshot is closed the moment the
    # load finishes — two other agents are writing this database and a long-open read
    # transaction would pin its vacuum horizon for the whole export.
    dconn = psycopg.connect(url, autocommit=False)
    dconn.execute("SET statement_timeout = 0")
    conn = psycopg.connect(url, autocommit=True)
    conn.execute("SET statement_timeout = 0")
    ex = Exporter(conn, dconn, curated, flexraw)
    ex.load()
    dconn.rollback()
    dconn.close()

    rows = ex.cohort(args.cohort, args.ids)
    log(f"cohort {args.cohort}: {len(rows)} statements")

    n = 0
    with open(args.out, "w", encoding="utf-8") as out:
        for r in rows:
            out.write(json.dumps(ex.build(r), ensure_ascii=False) + "\n")
            n += 1
            if n % 250 == 0:
                log(f"{n}/{len(rows)}")
    log(f"wrote {args.out} ({n} units)")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
