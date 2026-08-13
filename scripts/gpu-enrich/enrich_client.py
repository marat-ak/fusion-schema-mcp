"""Round-1 enrichment client (runs ON the GPU box, against local vLLM OpenAI endpoint).

Contract v3.1 (maximal): full JSON per unit; description >=3 business sentences (no cap);
intents >=3 (no cap); semantics label round-0 facts BY predicate seq; fact-check missing/extra.

Resume-safe: appends to enrich_output.jsonl; on start, re-scans done ids and skips them.
Usage:
  python3 enrich_client.py                 # full run
  python3 enrich_client.py --limit 20      # smoke
  PORT=8000 CONC=96 python3 enrich_client.py
"""
import argparse
import asyncio
import json
import os
import sys
import time

import aiohttp

PORT = int(os.environ.get("PORT", "8000"))
NGPU = int(os.environ.get("NGPU", "1"))          # instances on PORT..PORT+NGPU-1 (setup.sh)
MAX_NUM_SEQS = int(os.environ.get("MAX_NUM_SEQS", "96"))   # MUST match vLLM --max-num-seqs
# floating-pool size = server batch capacity × 1.2 — keeps vLLM's queue just primed (a running seq that
# finishes is backfilled with zero client round-trip gap) without dumping a huge backlog into the queue.
CONC = int(os.environ.get("CONC", str(int(NGPU * MAX_NUM_SEQS * 1.2))))
URLS = [f"http://127.0.0.1:{PORT + i}/v1/chat/completions" for i in range(NGPU)]
HEADERS = {}
MODEL_NAME = os.environ.get("MODEL_NAME", "qwen3-coder")
# Remote HF Inference Endpoint (managed vLLM): one authenticated URL replaces the local vLLM ports.
HF_URL = os.environ.get("HF_ENDPOINT_URL", "").rstrip("/")
if HF_URL:
    URLS = [HF_URL + "/v1/chat/completions"]
    HEADERS = {"Authorization": "Bearer " + os.environ.get("HF_TOKEN", "")}
_rr = {"i": 0}
def next_url():
    _rr["i"] = (_rr["i"] + 1) % len(URLS)
    return URLS[_rr["i"]]
IN_F = os.environ.get("IN_F", "enrich_input.jsonl")     # per-wave supervisor overrides these
OUT_F = os.environ.get("OUT_F", "enrich_output.jsonl")

SCHEMA = {
    "type": "object",
    "properties": {
        "rewrittenSql": {"type": "string"},
        "description": {"type": "string"},
        "intents": {"type": "array", "items": {"type": "string"}, "minItems": 3},
        "titleHuman": {"type": "string"},
        "tags": {"type": "array", "items": {"type": "string"}},
        "domain": {"type": "string"},
        "outputGrain": {"type": "string"},
        "tablesConfirmed": {"type": "boolean"},
        "missingTables": {"type": "array", "items": {"type": "string"}},
        "extraTables": {"type": "array", "items": {"type": "string"}},
        "security": {"type": "array", "items": {"type": "object", "properties": {
            "predicateSeqs": {"type": "array", "items": {"type": "integer"}},
            "tables": {"type": "array", "items": {"type": "string"}},
            "mechanism": {"type": "string", "enum": ["data-security-grants", "person-security", "bu-security", "ledger-access-set", "user-own", "other"]},
            "sessionDependent": {"type": "boolean"}},
            "required": ["predicateSeqs", "mechanism", "sessionDependent"]}},
        "currentRow": {"type": "array", "items": {"type": "object", "properties": {
            "predicateSeqs": {"type": "array", "items": {"type": "integer"}},
            "meaning": {"type": "string"}}, "required": ["predicateSeqs", "meaning"]}},
        "language": {"type": "array", "items": {"type": "object", "properties": {
            "predicateSeqs": {"type": "array", "items": {"type": "integer"}},
            "meaning": {"type": "string"}}, "required": ["predicateSeqs", "meaning"]}},
        "grainHandling": {"type": "array", "items": {"type": "object", "properties": {
            "table": {"type": "string"},
            "method": {"type": "string", "enum": ["effective-between", "latest-flag", "max-window", "distinct", "none"]},
            "predicateSeqs": {"type": "array", "items": {"type": "integer"}}},
            "required": ["table", "method"]}},
        "dateLogic": {"type": "array", "items": {"type": "object", "properties": {
            "pattern": {"type": "string", "enum": ["as-of", "aging-buckets", "period-bucket", "effective-range"]},
            "detail": {"type": "string"}}, "required": ["pattern"]}},
        "flexfield": {"type": "array", "items": {"type": "object", "properties": {
            "table": {"type": "string"}, "contextCode": {"type": "string"}, "meaning": {"type": "string"}},
            "required": ["table"]}},
        "plsqlFunctions": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "purpose": {"type": "string"}, "loadBearing": {"type": "boolean"}},
            "required": ["name"]}},
        "computedColumns": {"type": "array", "items": {"type": "object", "properties": {
            "alias": {"type": "string"}, "meaning": {"type": "string"}}, "required": ["alias"]}, "maxItems": 10},
        "qualityFlags": {"type": "array", "items": {"type": "string"}},
        "params": {"type": "array", "items": {"type": "object", "properties": {
            "name": {"type": "string"}, "purpose": {"type": "string"}}, "required": ["name"]}},
        "viewAdvice": {"type": "string"},
        "missingRemarks": {"type": "array", "items": {"type": "string"}},
        "flexMissed": {"type": "array", "items": {"type": "string"}},
    },
    "required": ["rewrittenSql", "description", "intents", "titleHuman", "tags", "domain", "outputGrain",
                 "tablesConfirmed", "missingTables", "extraTables", "security", "currentRow",
                 "language", "grainHandling", "dateLogic", "flexfield", "plsqlFunctions",
                 "computedColumns", "qualityFlags", "params", "viewAdvice", "missingRemarks", "flexMissed"],
}

SYSTEM = (
    "You are documenting Oracle Fusion SQL for a grounding knowledge base. You receive one SQL unit "
    "with: TABLE CARDS (authoritative descriptions of every referenced object), deterministic FACTS "
    "(joins; predicates with seq numbers, each annotated with its column's business meaning; a "
    "column-meanings block for the resolved columns; output projection; bind params), and the SQL text. Produce "
    "ONE JSON object per the enforced schema.\n"
    "RULES:\n"
    "- rewrittenSql comes FIRST: rewrite the SQL replacing every machine-generated alias (V123456789, "
    "T1234567, D1, SAWITH0, c1..cN, C123456789, Attr1234, TABLE1) with the REAL table and column names, "
    "resolved from FACTS (joins, predicates, column-meanings, projection) and the innermost sub-selects. Keep "
    "it logically IDENTICAL and compact; drop nothing semantic. If the SQL is very long, fully rewrite the "
    "core SELECT (projection, FROM/joins, WHERE) and compress repeated UNION/branch boilerplate with "
    "'-- repeated for X' comments. HARD LIMIT: rewrittenSql must stay under ~6000 characters — NEVER attempt "
    "a full rewrite of a very long SQL; compress instead. Then base description/semantics on YOUR rewritten "
    "form — it connects the SQL to the TABLE CARDS precisely.\n"
    "- Base every claim on the evidence. Semantic labels reference predicate seq numbers from FACTS — "
    "never restate SQL.\n"
    "- description: >=3 business sentences, as much as the evidence supports (grain, sources+keys, the "
    "MEANING of every pre-applied filter derived from the cards, notable computed outputs). No "
    "padding, no hedging.\n"
    "- intents: >=3 distinct natural-language questions this SQL answers.\n"
    "- SECURITY IS NARROW — only ROW-LEVEL ACCESS CONTROL enforced through a SESSION or GRANT "
    "mechanism: a referenced table/function whose CARD says it holds data-security grants, user/"
    "session roles, or access sets (e.g. FND_GRANTS, FND_SESSION_ROLE_SETS, "
    "FUN_USER_ROLE_DATA_ASGNMNTS, HRC_SESSION_UTIL / GET_USER_PERSONID, ACCESS_SET_ID, FND_GLOBAL.*). "
    "A plain BUSINESS filter (status codes, a *_FLAG='Y', ACTIVE/ENABLED flags, type/basis/category "
    "values) is NOT security — leave `security` EMPTY. If sessionDependent would be false, it is "
    "almost certainly NOT a security entry. Never emit duplicate security entries.\n"
    "- currentRow IS NARROW — a predicate selecting the CURRENT/latest row among RETAINED HISTORY "
    "(submitted_flag='Y' on an order that keeps revisions, a latest/current flag, MAX(version), "
    "SYSDATE BETWEEN effective dates). A generic ACTIVE/ENABLED flag on a table that keeps one row "
    "per key is NOT currentRow.\n"
    "- fact-check: tables visible in the SQL but absent from FACTS -> missingTables; FACTS tables not "
    "actually in the SQL -> extraTables.\n"
    "- tags: include legacy/EBS synonyms where known. Empty arrays where a field truly does not apply.\n"
    "- missingRemarks: BEFORE listing a TABLE.COLUMN, CROSS-CHECK it against BOTH FACTS.predicates (each "
    "predicate is annotated inline with its column's meaning in [brackets]) AND the FACTS.column-meanings "
    "block — list a column ONLY if its meaning is absent from BOTH. Flexfield columns (ATTRIBUTE_CHARn / "
    "GLOBAL_ATTRIBUTEn) are annotated 'flexfield ... by CONTEXT_CODE': select the meaning whose [CONTEXT] "
    "matches the row's CONTEXT_CODE predicate — these ARE explained, do NOT flag them. List only columns you "
    "genuinely needed (a predicate, an output, or a formula input) that appear NOWHERE with a meaning. Empty "
    "when every column you used was explained.\n"
    "- flexMissed: list as TABLE.COLUMN every flexfield-style column you actually used (ATTRIBUTE_CHARn / "
    "ATTRIBUTE_NUMBERn / ATTRIBUTE_DATEn / GLOBAL_ATTRIBUTEn / EXTN_ATTRIBUTE*) that was NOT given a "
    "'flexfield …' meaning — i.e. it is absent from the flexfield annotations (no context matched, or the "
    "flexfield is undefined for that table/context). This is the flexfield-coverage gap, SEPARATE from "
    "missingRemarks. Empty if every attribute column you used carried a flexfield meaning.\n"
    "- DFF vs EFF: a Descriptive-flexfield attribute on a NON-EFF table used WITHOUT a CONTEXT_CODE filter is a "
    "GLOBAL segment — VALID, not a gap; describe it as a global descriptive-flexfield attribute and do NOT put "
    "it in flexMissed. Only Extensible-flexfield attributes (table name ends `_EFF_B` / `_EFF_VL`) REQUIRE a "
    "context; an EFF attribute with no CONTEXT_CODE is unresolved — THAT is the gap to flag."
)

PREAMBLE = {
    "view": "Source: Oracle-delivered VIEW definition. Also fill `viewAdvice`: when to use this view vs its base tables (derived from its pre-applied filters and exposed columns).",
    "otbi": "Source: OTBI subject-area physical SQL fragment (auto-generated building block; literals inlined; no binds). viewAdvice: empty string.",
    "bip-report": "Source: hand-written BIP data-model SQL (custom report; may use :bind parameters — explain each param's purpose in `params`). viewAdvice: empty string.",
}

# Card overlay: descriptions generated in earlier waves override baked cards, so wave-N+1 views and
# the otbi/bip phases see fresh view descriptions (the GPU box has no DB — this closes the loop).
OVERLAY = {}


def build_messages(u):
    def card_text(t):
        return OVERLAY.get(t["name"]) or t["card"] or "(no description)"
    cards = "\n".join(f"- {t['name']} [{t['type']}{', ' + t['module'] if t['module'] else ''}]: {card_text(t)}"
                      for t in u["tables"]) or "(none)"
    preds = "\n".join(f"  seq {p['seq']}: {p['t']}.{p['c']} {p['op']} {p['lit']} ({p['in']})"
                      + (f"  [{p['c']}: {p['d']}]" if p.get("d") else "") for p in u["predicates"]) or "  (none)"
    joins = "\n".join(f"  {j}" for j in u["joins"]) or "  (none)"
    proj = "\n".join(f"  [{p['i']}] {p['a']} = {p['e']}" for p in u["projection"]) or "  (none)"
    notes = "\n".join(f"  {', '.join(c['cols'])}: {c['d']}" for c in u.get("columnNotes", [])) or "  (none)"
    binds = ", ".join(u["binds"]) or "(none)"
    trunc = "\nNOTE: SQL text below is TRUNCATED — rely on FACTS for anything past the cut and say so in qualityFlags." if u.get("sqlTruncated") else ""
    # static-first ordering: shared blocks (cards/joins/... identical across sibling units) come BEFORE the
    # unit-specific tail (title+SQL) -> vLLM prefix cache reuses the shared prefix across adjacent requests.
    user = (
        f"{PREAMBLE[u['source']]}\n"
        f"TABLE CARDS:\n{cards}\n\nFACTS.joins:\n{joins}\n\nFACTS.predicates:\n{preds}\n\n"
        f"FACTS.column meanings (resolved columns):\n{notes}\n\n"
        f"FACTS.projection (output interface):\n{proj}\n\nFACTS.binds: {binds}\n\n"
        f"TITLE: {u['title']}\n{trunc}\n"
        f"SQL:\n```sql\n{u['sql']}\n```"
    )
    return [{"role": "system", "content": SYSTEM}, {"role": "user", "content": user}]


async def one(session, sem, u, out, stats):
    async with sem:
        body = {
            "model": MODEL_NAME,
            "messages": build_messages(u),
            "max_tokens": 12000,    # rewrittenSql adds ~1-1.5k output tokens (mean); giant SQLs need headroom
            "temperature": 0.1,
            # vLLM 0.26 structured output = OpenAI response_format json_schema (strict enforces EVERY
            # required key — the top-level guided_json param is ignored in this version).
            "response_format": {"type": "json_schema",
                                "json_schema": {"name": "enrichment", "schema": SCHEMA, "strict": True}},
        }
        msgs0 = body["messages"]
        for attempt in range(3):
            try:
                if attempt:     # a failed 1st try is usually a too-long rewrittenSql (JSON truncated at max_tokens) -> force compact rewrite on retries
                    body = {**body, "messages": [msgs0[0], {"role": "user", "content": msgs0[1]["content"] +
                        "\n\nIMPORTANT: keep rewrittenSql UNDER 2000 characters — outer SELECT only with real names; "
                        "compress everything else with '-- ...' comments."}]}
                async with session.post(next_url(), json=body, headers=HEADERS, timeout=aiohttp.ClientTimeout(total=600)) as r:
                    j = await r.json()
                    if r.status != 200:
                        raise RuntimeError(str(j)[:200])
                    txt = j["choices"][0]["message"]["content"]
                    parsed = json.loads(txt)
                    rec = {"id": u["id"], "source": u["source"], "ok": True, "ghash": u.get("ghash"),
                           "result": parsed, "usage": j.get("usage", {})}
                    out.write(json.dumps(rec, ensure_ascii=False) + "\n")
                    out.flush()
                    # feed the overlay: this view's fresh description becomes a card for later units
                    if u["source"] == "view" and u.get("name"):
                        OVERLAY[u["name"]] = (parsed.get("description") or "")[:1600]
                    stats["ok"] += 1
                    return
            except Exception as e:
                if attempt == 2:
                    out.write(json.dumps({"id": u["id"], "source": u["source"], "ok": False, "error": str(e)[:300]}) + "\n")
                    out.flush()
                    stats["err"] += 1
                else:
                    await asyncio.sleep(2 * (attempt + 1))


async def main():
    global MODEL_NAME
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    args = ap.parse_args()

    if HF_URL:                       # HF vLLM validates the model field -> resolve the exact served name once
        try:
            import urllib.request
            req = urllib.request.Request(HF_URL + "/v1/models", headers=HEADERS)
            MODEL_NAME = json.load(urllib.request.urlopen(req, timeout=30))["data"][0]["id"]
            print(f"[client] HF endpoint model={MODEL_NAME}", flush=True)
        except Exception as e:
            print(f"[client] WARN model-resolve failed ({str(e)[:120]}); using {MODEL_NAME}", flush=True)

    CANONF = os.environ.get("CANON_MAP", "canonical_map.json")
    CANON = json.load(open(CANONF, encoding="utf-8")) if os.path.exists(CANONF) else {}   # old alias id -> canonical id (dedup_units.py)
    canon = lambda i: CANON.get(i, i)
    done_map = {}                                # canonical id -> ghash of the grounding it was enriched with (None = legacy pre-ghash row)
    if os.path.exists(OUT_F):
        with open(OUT_F, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    if rec.get("ok"):
                        done_map[canon(rec["id"])] = rec.get("ghash")   # FAILED rows are NOT 'done' -> retried on resume (import dedups by id)
                except Exception:
                    pass
    all_units = []
    with open(IN_F, encoding="utf-8") as f:
        for line in f:
            all_units.append(json.loads(line))
    # resume: overlay from already-done views (match input rows by id)
    done_views = {u["id"]: u for u in all_units if u["source"] == "view" and canon(u["id"]) in done_map}
    if done_views and os.path.exists(OUT_F):
        with open(OUT_F, encoding="utf-8") as f:
            for line in f:
                try:
                    rec = json.loads(line)
                    u = done_views.get(rec.get("id"))
                    if u and rec.get("ok") and u.get("name"):
                        OVERLAY[u["name"]] = (rec["result"].get("description") or "")[:1600]
                except Exception:
                    pass
    # grounding-versioned skip: a unit is done only if enriched WITH the same grounding (ghash). Legacy rows
    # (no ghash stored) count as done unless their grounding gained flexfield meanings since (the only change).
    REDO_FLEX = os.environ.get("REDO_FLEX", "1") == "1"
    def is_done(u):
        cid = canon(u["id"])
        if cid not in done_map:
            return False
        old = done_map[cid]
        if old is not None:
            return old == u.get("ghash")
        return not (REDO_FLEX and "flexfield" in json.dumps(u, ensure_ascii=False))
    units = [u for u in all_units if not is_done(u)]
    if args.limit:
        units = units[:args.limit]
    print(f"[client] pending {len(units)} (done {len(done_map)}, overlay {len(OVERLAY)}, canon-map {len(CANON)})  conc={CONC}", flush=True)

    # PHASED RUN WITH BARRIERS: views wave 0..7 (each wave completes before the next starts, so the
    # overlay carries fresh dependency descriptions), then otbi, then bip.
    groups = {}
    for u in units:
        groups.setdefault((u.get("phase", 1), u.get("wave", 0)), []).append(u)
    order = sorted(groups.keys())

    stats = {"ok": 0, "err": 0}
    t0 = time.time()
    total = len(units)
    out = open(OUT_F, "a", encoding="utf-8")
    async with aiohttp.ClientSession(connector=aiohttp.TCPConnector(limit=max(CONC + 16, 128))) as session:
        for key in order:
            batch = groups[key]
            label = {0: "views", 1: "otbi", 2: "bip"}[key[0]] + (f"/wave{key[1]}" if key[0] == 0 else "")
            print(f"[client] === phase {label}: {len(batch)} units ===", flush=True)
            # WORKER POOL: exactly CONC worker coroutines pull units from ONE shared iterator, so only CONC
            # coroutines are alive at any time — not len(batch) (an otbi wave is ~85k). Each worker fires one
            # POST, writes its row, loops to the next unit. `next(it)` is atomic between awaits (single-thread
            # event loop), so no two workers grab the same unit. The wave barrier is gather() draining.
            sem = asyncio.Semaphore(CONC)          # kept for one()'s signature; workers already bound to CONC
            it = iter(batch)

            async def worker():
                while True:
                    try:
                        u = next(it)
                    except StopIteration:
                        return
                    await one(session, sem, u, out, stats)
                    donec = stats["ok"] + stats["err"]
                    if donec % 500 == 0 or donec == total:
                        el = time.time() - t0
                        rate = donec / max(el, 1e-9)
                        eta = (total - donec) / max(rate, 1e-9) / 3600
                        print(f"[client] {donec}/{total} ok={stats['ok']} err={stats['err']} "
                              f"{rate:.1f}/s eta={eta:.1f}h overlay={len(OVERLAY)}", flush=True)

            await asyncio.gather(*[worker() for _ in range(min(CONC, len(batch)))])
    out.close()
    print(f"[client] DONE ok={stats['ok']} err={stats['err']}", flush=True)


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
