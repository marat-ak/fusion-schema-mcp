#!/usr/bin/env python3
"""Curated rename aliases between the catalog's OTBI subject-area names and Oracle's TBI guide area names.

The catalog's area names come from the r13-26B lineage workbooks + the demo-pod crawl; the guides
(scripts/pipeline/p3_tbi_guides.py -> data/otbi/tbi_guides/<release>/area_duty.jsonl) are a newer
release and rename some areas ("Distributed Order Orchestration - X" -> "Order Management - X",
"Fiscal Document X" -> "Costing - Fiscal Document X", ...). p5_otbi.sql joins on the normalized name
first; this script proposes an alias ONLY for an area pair left unmatched on both sides, from two
kinds of evidence, and writes them with their evidence to scripts/pipeline/otbi_area_aliases.json
(curated data: reviewed, tracked, a change = a new release label):

  name   the names agree once the family prefix ("X - "), the whole family repeated at the head of the
         tail, the "Real Time" suffix, plural "s" and spacing ("Omni Channel" / "Omnichannel") are
         normalized: the tails are EQUAL (or equal up to ONE extra word of either name's family, e.g.
         "Service - CRM Case Management" ~ "CRM/Help Desk - Case Management"), or similar (ratio >= 0.90)
         AND each is the other's unique best;
  duty   the guide area lists >= 1 duty, and when a name has several candidates passing the name
         rule they all carry the IDENTICAL duty set (so the pick cannot change the gate's outcome);
         otherwise every candidate of that name is rejected.

Everything else stays unmatched = no duty list = denied by the subject-area gate (never guessed).
Read-only inputs, one output; no database, pod or network access.

  python3 p3_tbi_aliases.py --guides <dir with area_duty.jsonl> --catalog <file: one catalog area name per line> --out <json>
"""
from __future__ import annotations

import argparse
import collections
import difflib
import json
import re
import sys
import unicodedata

TAIL_SIMILAR = 0.90


def norm(s: str) -> str:
    """the p3_tbi_guides.py catalog-match normalization (NFKC, casefold, dashes, spacing around '-')"""
    s = unicodedata.normalize("NFKC", s).casefold()
    s = re.sub(r"[‐-―−﹘﹣－]", "-", s)
    s = re.sub(r"\s*-\s*", " - ", s)
    return re.sub(r"\s+", " ", s).strip()


def parts(s: str) -> tuple[str, list[str]]:
    """(family, tail words): the family prefix 'X - ', the tail without 'Real Time', plural 's' and spacing normalized"""
    n = norm(s).replace("omni channel", "omnichannel")
    family, rest = (n.split(" - ", 1) if " - " in n else ("", n))
    rest = re.sub(r"\breal time$", "", rest).strip()
    words = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in rest.split()]
    return family, words


def tails(s: str) -> set[str]:
    """the tail, and the tail without the WHOLE family repeated at its head ('Supplier - Supplier Profile ...')"""
    family, words = parts(s)
    fam = [w[:-1] if len(w) > 3 and w.endswith("s") else w for w in family.split()]
    out = {" ".join(words)}
    if fam and words[:len(fam)] == fam:
        out.add(" ".join(words[len(fam):]))
    return out


def tail(s: str) -> str:
    return " ".join(parts(s)[1])


def tails_match(c: str, g: str) -> bool:
    """equal tails (any variant), or equal up to ONE extra token that is a word of either name's family"""
    if tails(c) & tails(g):
        return True
    fams = set(re.split(r"[\s/]+", parts(c)[0] + " " + parts(g)[0]))
    for x in tails(c):
        for y in tails(g):
            a, b = x.split(), y.split()
            longer, shorter = (a, b) if len(a) > len(b) else (b, a)
            if len(longer) == len(shorter) + 1:
                for i, w in enumerate(longer):
                    if w in fams and longer[:i] + longer[i + 1:] == shorter:
                        return True
    return False


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--guides", required=True)
    ap.add_argument("--catalog", required=True)
    ap.add_argument("--out", required=True)
    a = ap.parse_args()

    rows = [json.loads(l) for l in open(f"{a.guides}/area_duty.jsonl", encoding="utf-8")]
    releases = sorted({r["guide_release"] for r in rows})
    duties = collections.defaultdict(set)
    for r in rows:
        duties[r["subject_area"]].add(r["duty_code"])
    catalog = [l.rstrip("\n") for l in open(a.catalog, encoding="utf-8") if l.strip()]
    gnorm = {norm(g) for g in duties}
    cnorm = {norm(c) for c in catalog}
    unc = sorted(c for c in catalog if norm(c) not in gnorm)
    ung = sorted(g for g in duties if norm(g) not in cnorm)

    def ratio(x: str, y: str) -> float:
        return difflib.SequenceMatcher(None, x, y).ratio()

    # name evidence: equal tails, or similar tails that are each other's unique best
    best_g = {c: max(ung, key=lambda g: ratio(tail(c), tail(g))) for c in unc} if ung else {}
    best_c = {g: max(unc, key=lambda c: ratio(tail(c), tail(g))) for g in ung} if unc else {}
    cands = []
    for c in unc:
        for g in ung:
            tr = ratio(tail(c), tail(g))
            if tails_match(c, g):
                cands.append((c, g, "tail-equal", tr))
            elif tr >= TAIL_SIMILAR and best_g[c] == g and best_c[g] == c:
                cands.append((c, g, "tail-similar", tr))
    by_c = collections.defaultdict(list)
    by_g = collections.defaultdict(list)
    for x in cands:
        by_c[x[0]].append(x)
        by_g[x[1]].append(x)

    aliases, rejected = [], []
    for c, g, rule, tr in cands:
        comp = {y[1] for y in by_c[c]} | {y[0] for y in by_g[g]}
        dsets = {frozenset(duties[y[1]]) for y in by_c[c]} | {frozenset(duties[g])}
        if not duties[g]:
            rejected.append({"catalog": c, "guide": g, "reason": "the guide page lists no duty role"})
        elif len(dsets) > 1:
            rejected.append({"catalog": c, "guide": g, "reason": f"{len(by_c[c])} guide candidates with different duty sets"})
        else:
            aliases.append({"catalog": c, "guide": g, "evidence": {
                "name": rule, "tailRatio": round(tr, 3), "nameRatio": round(ratio(norm(c), norm(g)), 3),
                "candidates": len(comp) - 1, "dutyCodes": sorted(duties[g])}})
    aliased_c = {x["catalog"] for x in aliases}
    aliased_g = {x["guide"] for x in aliases}
    for g in ung:
        if g not in aliased_g and not any(r["guide"] == g for r in rejected):
            rejected.append({"guide": g, "best_catalog": best_c.get(g), "tailRatio": round(ratio(tail(best_c[g]), tail(g)), 3) if g in best_c else None,
                             "reason": "no catalog area passes the name rule"})
    out = {
        "_doc": "Curated rename aliases catalog area -> TBI guide area, built by scripts/pipeline/p3_tbi_aliases.py from the guide crawl "
                "(area_duty.jsonl) and the catalog's area names; read by p5_otbi.sql (otbi_area_duty.matched_by = 'alias'). Evidence per row: "
                "name (tail-equal | tail-similar >= 0.90 and mutual best, after the family prefix / repeated family word / 'Real Time' / plural / "
                "'Omni Channel' normalization) and duty (the guide area lists >= 1 duty; several name candidates are accepted only with an "
                "IDENTICAL duty set). Unmatched areas have no duty list and are denied by the subject-area gate.",
        "guideRelease": ",".join(releases),
        "catalogUnmatched": len(unc), "guideUnmatched": len(ung),
        "aliases": sorted(aliases, key=lambda x: x["catalog"]),
        "rejected": sorted(rejected, key=lambda x: (x.get("catalog") or "", x["guide"])),
    }
    with open(a.out, "w", encoding="utf-8", newline="\n") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print(f"[tbi-aliases] catalog unmatched {len(unc)}, guide unmatched {len(ung)}: {len(aliases)} aliases, {len(rejected)} rejected -> {a.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
