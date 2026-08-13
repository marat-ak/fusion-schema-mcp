"""Local proof (no GPU): assemble the exact round-1 prompt for one view, one otbi, one bip unit
from enrich_input.jsonl and print it — verifies cards + facts + SQL + preamble are all present."""
import json, sys

PREAMBLE = {
    "view": "Source: Oracle-delivered VIEW definition. Also fill `viewAdvice`.",
    "otbi": "Source: OTBI subject-area physical SQL fragment (literals inlined; no binds).",
    "bip-report": "Source: hand-written BIP data-model SQL (custom report; may use :bind parameters).",
}

def build(u):
    cards = "\n".join(f"- {t['name']} [{t['type']}{', '+t['module'] if t.get('module') else ''}]: {t.get('card') or '(no description)'}" for t in u["tables"]) or "(none)"
    preds = "\n".join(f"  seq {p['seq']}: {p['t']}.{p['c']} {p['op']} {p['lit']} ({p['in']})" for p in u["predicates"]) or "  (none)"
    joins = "\n".join("  "+j for j in u["joins"]) or "  (none)"
    proj = "\n".join(f"  [{p['i']}] {p['a']} = {p['e']}" for p in u["projection"]) or "  (none)"
    binds = ", ".join(u["binds"]) or "(none)"
    return (f"{PREAMBLE[u['source']]}\nTITLE: {u['title']}\n\nTABLE CARDS:\n{cards}\n\n"
            f"FACTS.joins:\n{joins}\n\nFACTS.predicates:\n{preds}\n\nFACTS.projection:\n{proj}\n\n"
            f"FACTS.binds: {binds}\n\nSQL:\n```sql\n{u['sql'][:1500]}\n...(clipped for dry-run)\n```")

want = {"view": None, "otbi": None, "bip-report": None}
for line in open("/data/enrich_input.jsonl", encoding="utf-8"):
    u = json.loads(line)
    s = u["source"]
    if s in want and want[s] is None and len(u["tables"]) >= 2 and u["predicates"]:
        want[s] = u
    if all(want.values()):
        break

for s, u in want.items():
    print("#" * 100)
    print(f"### SAMPLE {s.upper()}  id={u['id'] if u else 'NONE FOUND'}  phase={u.get('phase') if u else '-'} wave={u.get('wave') if u else '-'}")
    print("#" * 100)
    if u:
        print(build(u))
        # card coverage check
        described = sum(1 for t in u["tables"] if t.get("card"))
        print(f"\n>>> card coverage: {described}/{len(u['tables'])} referenced objects have a description")
    print()
