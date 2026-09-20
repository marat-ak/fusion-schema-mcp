"""P2-gap (c) — render every request the runner would POST, and check it, with no network.

Reads the payload `p2_gap_export.py` wrote, builds each request body through the SAME
`enrich_client.build_messages()` / `SCHEMA` the runner uses (imported, never restated), and
writes them out. Nothing here contacts an endpoint; this is the gate that has to pass before
one is pointed at.

What it asserts on every row, and fails on:

  * the user message carries all nine blocks in order — PREAMBLE, TABLE CARDS, FACTS.joins,
    FACTS.predicates, FACTS.column meanings, FACTS.projection, FACTS.binds, TITLE, SQL;
  * `ghash` is present AND recomputes from the emitted payload by the export_wave formula
    (md5 over the record minus id/name/title), so the key is the documented function of the
    grounding and not a value someone pasted in;
  * the SQL block honours the 40,000-char clip and `sqlTruncated` agrees with it;
  * the truncation NOTE is present exactly when `sqlTruncated` is set;
  * ids are unique and the strict schema's required key list is the one the run will send.

  python p2_gap_dryrun.py --in enrich_input.gap.jsonl --out gap_requests.jsonl \
                          --sample-out one_prompt.txt --chars-per-token 3.6
"""
import argparse
import hashlib
import json
import os
import statistics
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gpu-enrich"))

import enrich_client as ec  # noqa: E402

# Line-anchored, and searched SEQUENTIALLY from the end of the previous block. Both matter:
# a bare "TITLE:" also occurs mid-prompt inside real column meanings
# (PER_ALL_ASSIGNMENTS_M.BILLING_TITLE: Billing Title for assignment), so a plain find()
# reports the header as out of order on a perfectly well-formed prompt.
NL = chr(10)
BLOCKS = [NL + "TABLE CARDS:" + NL,
          NL * 2 + "FACTS.joins:" + NL,
          NL * 2 + "FACTS.predicates:" + NL,
          NL * 2 + "FACTS.column meanings (resolved columns):" + NL,
          NL * 2 + "FACTS.projection (output interface):" + NL,
          NL * 2 + "FACTS.binds: ",
          NL + "TITLE: ",
          NL + "SQL:" + NL]
TRUNC_NOTE = "NOTE: SQL text below is TRUNCATED"


def log(m):
    print(f"[p2-gap-dryrun] {m}", flush=True)


def body_for(u):
    """Exactly the body enrich_client.one() posts on its first attempt."""
    return {
        "model": ec.MODEL_NAME,
        "messages": ec.build_messages(u),
        "max_tokens": 12000,
        "temperature": 0.1,
        "response_format": {"type": "json_schema",
                            "json_schema": {"name": "enrichment", "schema": ec.SCHEMA,
                                            "strict": True}},
    }


def pct(vals, p):
    vals = sorted(vals)
    if not vals:
        return 0
    k = max(0, min(len(vals) - 1, int(round((p / 100.0) * (len(vals) - 1)))))
    return vals[k]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="inp", required=True)
    ap.add_argument("--out", required=True, help="the rendered request bodies, one JSON per line")
    ap.add_argument("--sample-out", help="write one complete mid-sized prompt here, verbatim")
    ap.add_argument("--chars-per-token", type=float, required=True,
                    help="measured user-message chars per prompt token for this prompt shape "
                         "and model — calibrate it, do not guess")
    ap.add_argument("--model", default="(dry-run)",
                    help="only stamped into the rendered body's model field")
    args = ap.parse_args()

    ec.MODEL_NAME = args.model
    rows = [json.loads(l) for l in open(args.inp, encoding="utf-8") if l.strip()]
    log(f"{len(rows)} payload rows from {args.inp}")

    ids = [r["id"] for r in rows]
    if len(set(ids)) != len(ids):
        raise SystemExit(f"duplicate ids in payload: {len(ids) - len(set(ids))}")

    fails = []
    sizes, sqlsizes, sysbytes = [], [], []
    by_source, trunc, noblocks = {}, 0, 0
    per_row = []

    with open(args.out, "w", encoding="utf-8") as out:
        for u in rows:
            b = body_for(u)
            sysmsg, usermsg = b["messages"][0]["content"], b["messages"][1]["content"]

            pos, ok_order = 0, True
            for blk in BLOCKS:
                i = usermsg.find(blk, pos)
                if i < 0:
                    fails.append((u["id"], f"missing block {blk!r} after offset {pos}"))
                    ok_order = False
                    break
                pos = i + len(blk)
            if not ok_order:
                noblocks += 1
            if not usermsg.startswith(ec.PREAMBLE[u["source"]]):
                fails.append((u["id"], "preamble missing or not first"))

            gh = u.get("ghash")
            if not gh:
                fails.append((u["id"], "no ghash"))
            else:
                recomputed = hashlib.md5(json.dumps(
                    {k: v for k, v in u.items() if k not in ("id", "name", "title", "ghash")},
                    sort_keys=True, ensure_ascii=False).encode()).hexdigest()
                if recomputed != gh:
                    fails.append((u["id"], f"ghash mismatch {gh[:8]} != {recomputed[:8]}"))

            if len(u["sql"]) > 40000:
                fails.append((u["id"], f"sql not clipped: {len(u['sql'])}"))
            note = TRUNC_NOTE in usermsg
            if note != bool(u.get("sqlTruncated")):
                fails.append((u["id"], f"truncation note {note} != sqlTruncated {u.get('sqlTruncated')}"))
            if u.get("sqlTruncated"):
                trunc += 1

            sizes.append(len(usermsg))
            sqlsizes.append(len(u["sql"]))
            sysbytes.append(len(sysmsg))
            st = by_source.setdefault(u["source"], {"n": 0, "chars": 0, "trunc": 0})
            st["n"] += 1
            st["chars"] += len(usermsg) + len(sysmsg)
            st["trunc"] += 1 if u.get("sqlTruncated") else 0
            per_row.append((len(usermsg), u["id"], b))
            out.write(json.dumps({"id": u["id"], "body": b}, ensure_ascii=False) + "\n")

    if set(ec.SCHEMA["required"]) != set(ec.SCHEMA["properties"]):
        raise SystemExit("SCHEMA required list does not cover every property — contract drift")

    log(f"schema: {len(ec.SCHEMA['properties'])} fields, all required, strict=True")
    log(f"system prompt: {sysbytes[0]} chars (identical on every row: "
        f"{len(set(sysbytes)) == 1})")
    log(f"blocks ok on {len(rows) - noblocks}/{len(rows)} rows · sqlTruncated on {trunc}")
    for src, st in sorted(by_source.items()):
        log(f"  {src:12s} n={st['n']:5d}  prompt chars={st['chars']:12,d}  "
            f"median={st['chars'] // max(st['n'], 1):7,d}  sqlTruncated={st['trunc']}")

    tot = sum(sizes) + sum(sysbytes)
    log("user-message chars  min=%d p25=%d median=%d p75=%d p95=%d max=%d"
        % (min(sizes), pct(sizes, 25), int(statistics.median(sizes)), pct(sizes, 75),
           pct(sizes, 95), max(sizes)))
    log("sql-block chars     min=%d median=%d p95=%d max=%d"
        % (min(sqlsizes), int(statistics.median(sqlsizes)), pct(sqlsizes, 95), max(sqlsizes)))
    log(f"total prompt chars (system + user, all rows): {tot:,} "
        f"≈ {tot / args.chars_per_token / 1e6:.2f}M prompt tokens at "
        f"{args.chars_per_token} chars/token")

    if fails:
        log(f"FAIL {len(fails)} checks:")
        for uid, why in fails[:20]:
            log(f"  {uid}: {why}")
        return 1

    if args.sample_out:
        per_row.sort(key=lambda x: x[0])
        mid = per_row[len(per_row) // 2]
        with open(args.sample_out, "w", encoding="utf-8") as f:
            f.write(f"### id: {mid[1]}   user-message chars: {mid[0]}\n")
            f.write("### ---------- system ----------\n")
            f.write(mid[2]["messages"][0]["content"] + "\n")
            f.write("### ---------- user ----------\n")
            f.write(mid[2]["messages"][1]["content"] + "\n")
        log(f"median-sized prompt written to {args.sample_out} (id {mid[1]}, {mid[0]} chars)")

    log(f"OK — {len(rows)} requests rendered to {args.out}, no check failed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
