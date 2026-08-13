"""E2E validation — STAGE C: dump every level (base views -> dependent views -> bips) for quality review.

Reads closure.json + the per-level enrich INPUT (filtered) and OUTPUT jsonls produced by the run, and
writes a readable e2e_report.md. For each unit: id, name/title, depth, tables-used (VIEW deps shown with
their grounded card snippet so the base->dependent flow is visible), generated description, intents, and
the narrow semantics (security / currentRow / computedColumns / missingRemarks). Also dumps the ACTUAL
prompt (system once + user per sample) for 1-2 sample units per level, reconstructed with the REAL
enrich_client.build_messages — no reimplementation.

Runs on the bare distro (python3 stdlib only): aiohttp is stubbed so `import enrich_client` succeeds
without the package (build_messages needs only json/string ops; the network client is never called).

Env: DIR (run dir holding closure.json + jsonls + enrich_client.py; default = this file's dir).
"""
import sys, types, os, json, datetime

sys.modules.setdefault("aiohttp", types.ModuleType("aiohttp"))   # enrich_client imports aiohttp at top
DIR = os.environ.get("DIR", os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, DIR)
from enrich_client import build_messages, SYSTEM                 # the REAL prompt builder + system prompt


def load_jsonl(path):
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, encoding="utf-8") as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            if r.get("id"):
                out[r["id"]] = r
    return out


def indent(s, pad="    "):
    return pad + (s or "").replace("\n", "\n" + pad)


man = json.load(open(os.path.join(DIR, "closure.json"), encoding="utf-8"))
depths = sorted(int(d) for d in man["closureUnion"]["byDepth"])

# per-level input (filtered) + output maps
level_in, level_out = {}, {}
for d in depths:
    level_in[d] = load_jsonl(os.path.join(DIR, f"enrich_input.view.w{d}.jsonl"))
    level_out[d] = load_jsonl(os.path.join(DIR, f"enrich_output.view.w{d}.jsonl"))
bip_in = load_jsonl(os.path.join(DIR, "enrich_input.bip.jsonl"))
bip_out = load_jsonl(os.path.join(DIR, "enrich_output.bip.jsonl"))

L = []
def w(s=""):
    L.append(s)


def card_snip(t):
    return (t.get("card") or "").replace("\n", " ")[:160]


def render_unit(uid, inp, outp, depth_label):
    name = (inp or {}).get("name") or (inp or {}).get("title") or uid
    w(f"### `{uid}`  — {name}")
    w(f"- level: {depth_label}")
    if not inp:
        w(f"- (no input row found — was this id exported/filtered?)\n")
        return
    tabs = inp.get("tables", [])
    views = [t for t in tabs if t.get("type") == "VIEW"]
    base = [t for t in tabs if t.get("type") != "VIEW"]
    w(f"- tables used: {len(tabs)} ({len(views)} VIEW, {len(base)} base)")
    if inp.get("binds"):
        w(f"- binds: {', '.join(inp['binds'])}")
    if views:
        w(f"- VIEW dependencies (grounded cards — should be prior-level generated descriptions):")
        for t in views[:20]:
            w(f"    - {t['name']}: {card_snip(t)}")
    if not outp:
        w(f"- **NO ENRICH OUTPUT** for this id\n")
        return
    if not outp.get("ok"):
        w(f"- **ENRICH FAILED**: {str(outp.get('error'))[:300]}\n")
        return
    r = outp["result"]
    w(f"- domain: {r.get('domain')}   outputGrain: {r.get('outputGrain')}   "
      f"tablesConfirmed: {r.get('tablesConfirmed')}")
    w(f"- description:")
    w(indent(r.get("description", "")))
    w(f"- intents:")
    for q in r.get("intents", []):
        w(f"    - {q}")
    for k in ("security", "currentRow", "computedColumns"):
        v = r.get(k)
        if v:
            w(f"- {k}:")
            for item in v:
                w(f"    - {json.dumps(item, ensure_ascii=False)}")
    for k in ("missingRemarks", "missingTables", "extraTables", "qualityFlags", "params",
              "plsqlFunctions", "flexfield", "viewAdvice"):
        v = r.get(k)
        if v:
            w(f"- {k}: {json.dumps(v, ensure_ascii=False)[:400]}")
    w("")


# ---------------- report body ----------------
w(f"# E2E enrichment validation report")
w(f"_generated {datetime.datetime.now().isoformat(timespec='seconds')}_  ")
w(f"select_by=**{man['params']['select_by']}**  n_bips={man['params']['n_bips']}  "
  f"closure: {man['closureUnion']['totalViews']} views "
  f"(enrichable {man['closureUnion']['enrichableCount']}, unenrichable {len(man['closureUnion']['unenrichable'])})")
w("")
w("Ordering below flows base views (depth 0) -> dependent views -> BIP reports, so a reviewer can check "
  "that each level's description is grounded by the prior level's generated descriptions (shown inline as "
  "the VIEW-dependency card snippets).")
w("")
w("## Closure summary")
for d in depths:
    ok = sum(1 for u in level_out[d].values() if u.get("ok"))
    err = sum(1 for u in level_out[d].values() if not u.get("ok"))
    w(f"- depth {d}: {len(man['closureUnion']['byDepth'][str(d)])} views  (enriched ok={ok} err={err})")
bok = sum(1 for u in bip_out.values() if u.get("ok"))
berr = sum(1 for u in bip_out.values() if not u.get("ok"))
w(f"- bips: {len(man['bips'])}  (enriched ok={bok} err={berr})")
if man["closureUnion"]["unenrichable"]:
    w(f"- unenrichable views (schema VIEW, no wave/sql_unit — carried as schema-remark cards, NOT enriched): "
      f"{', '.join(man['closureUnion']['unenrichable'])}")
w("")

for d in depths:
    ids = ["view:" + v for v in man["closureUnion"]["byDepth"][str(d)]]
    w(f"## Level depth={d}  ({'base views' if d == 0 else 'dependent views'}) — {len(ids)} views")
    w("")
    for uid in sorted(ids):
        render_unit(uid, level_in[d].get(uid), level_out[d].get(uid), f"view depth {d}")

w(f"## BIP reports — {len(man['bips'])}")
w("")
for b in man["bips"]:
    uid = b["id"]
    inp = bip_in.get(uid)
    w(f"### {b['title']}")
    w(f"- id: `{uid}`")
    w(f"- sqllen={b['sqllen']}  directViews={b['directViewCount']}  closureViews={b['closureViewCount']}  "
      f"maxDepth={b['maxDepth']}")
    render_unit(uid, inp, bip_out.get(uid), "bip")

# ---------------- appendix: actual prompts ----------------
w("## Appendix: actual prompts (grounding visible)")
w("")
w("The SYSTEM message is identical for every unit; it is shown once. Each sample then shows the USER "
  "message built by the REAL `enrich_client.build_messages` — the TABLE CARDS block is the grounding "
  "(for depth>=1 views and bips, the VIEW cards are the generated descriptions persisted from lower levels).")
w("")
w("<details><summary>SYSTEM message</summary>\n")
w("```")
w(SYSTEM)
w("```")
w("</details>")
w("")


def pick_samples(inmap, k):
    # prefer units with the most VIEW cards (most grounding to eyeball)
    units = list(inmap.values())
    units.sort(key=lambda u: sum(1 for t in u.get("tables", []) if t.get("type") == "VIEW"), reverse=True)
    return units[:k]


def dump_prompt(u, label):
    msgs = build_messages(u)
    w(f"<details><summary>USER prompt — {label}: {u.get('id')}</summary>\n")
    w("```")
    w(msgs[1]["content"])
    w("```")
    w("</details>")
    w("")


for d in depths:
    for u in pick_samples(level_in[d], 1):
        dump_prompt(u, f"view depth {d}")
for u in pick_samples(bip_in, 2):
    dump_prompt(u, "bip")

report = os.path.join(DIR, "e2e_report.md")
with open(report, "w", encoding="utf-8") as f:
    f.write("\n".join(L) + "\n")

# console summary
print(f"[dump] wrote {report}")
print(f"[dump] levels: " + ", ".join(f"d{d}={len(man['closureUnion']['byDepth'][str(d)])}" for d in depths)
      + f", bips={len(man['bips'])}")
tot_ok = sum(sum(1 for u in level_out[d].values() if u.get('ok')) for d in depths) + bok
tot_err = sum(sum(1 for u in level_out[d].values() if not u.get('ok')) for d in depths) + berr
print(f"[dump] enriched ok={tot_ok} err={tot_err}")
