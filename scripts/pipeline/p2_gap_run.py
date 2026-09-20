"""P2-gap (b) — run the gap cohort against an OpenAI-compatible endpoint.

The request contract is NOT restated here. `scripts/gpu-enrich/enrich_client.py` is imported
and used as-is: its 23-field strict `SCHEMA`, its `SYSTEM` prompt, its `PREAMBLE`, its
`build_messages()`, and its `one()` — the whole POST, the json_schema response format, the
three-attempt retry with the "keep rewrittenSql under 2000 characters" compaction on retry,
and the failure record it writes when all three attempts fail. Same fields, same minItems
gates, so a record from this run is the same shape as the 23,610 we already hold.

What IS new is the orchestration, and only because the original could not be reused for it:

  * `enrich_client.main()` resolves the model name from the endpoint at startup and carries
    a local-vLLM port scheme. This run takes the endpoint URL and the model id as REQUIRED
    arguments. There is no default URL, no default model, no localhost fallback and no
    "resolve whatever is served" — a missing one is a hard exit naming what is needed.
  * It groups the queue into view waves with barriers. The gap cohort is one pass.
  * It carries `canonical_map.json`, the L2 alias map from the old dedup. `work` is already
    deduped on `sql_hash`, so ids are one-to-one and no alias map exists or is wanted.

PROVENANCE. The original stored no model, no run id and no timestamp per record —
MODEL_NAME was resolved once at startup and never written to a row, leaving `usage` as the
only per-call evidence. Here `model`, `run_id` and `produced_at` go on every line. They are
added by wrapping the output handle `one()` writes through, so the contract fields stay
byte-for-byte what enrich_client produced and nothing in that module is touched. Existing
rows are NOT backfilled: a value invented for a 2026-08 record would be a fabrication.

RESUME. Append-only journal, last line per id wins, exactly as before — but now strictly
grounding-versioned, which is what computing `ghash` for every statement buys: an id counts
as done only when its last line is `ok` AND carries the ghash of the grounding it is about
to be sent. Change a fact, the ghash moves, the statement re-runs. A line that ends on a
failure is never "done" and comes back on the next invocation.

  HF_TOKEN=... python p2_gap_run.py --in enrich_input.gap.jsonl --out enrich_output.gap.jsonl \
      --url https://<endpoint> --model <served-model-id> --conc 256 --auth bearer
"""
import argparse
import asyncio
import json
import os
import sys
import time
import urllib.request
import uuid
from datetime import datetime, timezone

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "gpu-enrich"))

import enrich_client as ec  # noqa: E402  the contract: SCHEMA, SYSTEM, build_messages, one


def log(m):
    print(f"[p2-gap-run] {m}", flush=True)


class Journal:
    """The output handle `enrich_client.one()` writes through.

    `one()` emits one complete JSON line per unit and then flushes — success and failure
    alike. Intercepting that line is how this run's provenance lands on the record without
    editing the module: the fields enrich_client wrote are preserved exactly as it wrote
    them, and model / run_id / produced_at are added beside them.
    """

    def __init__(self, fh, model, run_id):
        self.fh = fh
        self.model = model
        self.run_id = run_id
        self.written = 0

    def write(self, line):
        rec = json.loads(line)
        rec["model"] = self.model
        rec["run_id"] = self.run_id
        rec["produced_at"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
        self.fh.write(json.dumps(rec, ensure_ascii=False) + "\n")
        self.written += 1

    def flush(self):
        self.fh.flush()


def read_journal(path):
    """id -> last line for that id. Append-only resume log: later lines supersede earlier
    ones, which is why ids are counted here and never lines."""
    last = {}
    if not os.path.exists(path):
        return last
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except Exception:
                continue
            if rec.get("id"):
                last[rec["id"]] = rec
    return last


def preflight(url, model, headers):
    """Fail before the first unit rather than 2,733 times over."""
    req = urllib.request.Request(url.rstrip("/") + "/v1/models", headers=headers)
    try:
        served = [m.get("id") for m in json.load(urllib.request.urlopen(req, timeout=30))["data"]]
    except Exception as e:
        raise SystemExit(f"endpoint /v1/models unreachable: {str(e)[:200]}\n"
                         f"  checked: {url.rstrip('/')}/v1/models")
    if model not in served:
        raise SystemExit(f"--model {model!r} is not served by this endpoint. It serves: {served}")
    log(f"preflight ok — endpoint serves {model}")


async def run(units, journal, conc, stats):
    it = iter(units)
    total = len(units)
    t0 = time.time()
    sem = asyncio.Semaphore(conc)

    async def worker(session):
        while True:
            try:
                u = next(it)
            except StopIteration:
                return
            await ec.one(session, sem, u, journal, stats)
            done = stats["ok"] + stats["err"]
            if done % 100 == 0 or done == total:
                el = time.time() - t0
                rate = done / max(el, 1e-9)
                log(f"{done}/{total} ok={stats['ok']} err={stats['err']} "
                    f"{rate:.2f}/s eta={(total - done) / max(rate, 1e-9) / 60:.0f}min")

    connector = ec.aiohttp.TCPConnector(limit=max(conc + 16, 128))
    async with ec.aiohttp.ClientSession(connector=connector) as session:
        await asyncio.gather(*[worker(session) for _ in range(min(conc, total))])


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--in", dest="inp", required=True, help="prompt payload JSONL from p2_gap_export.py")
    ap.add_argument("--out", required=True, help="append-only journal; resumed from if it exists")
    ap.add_argument("--url", required=True, help="OpenAI-compatible endpoint base URL, no trailing /v1")
    ap.add_argument("--model", required=True, help="the served model id, exactly as /v1/models reports it")
    ap.add_argument("--conc", type=int, required=True,
                    help="in-flight requests; set to the endpoint's batch capacity — there is "
                         "nothing local to derive it from")
    ap.add_argument("--auth", choices=["bearer", "none"], required=True,
                    help="bearer reads the token from $HF_TOKEN and fails if it is empty")
    ap.add_argument("--run-id", help="defaults to gap-<utc>-<8 hex>; recorded on every row")
    ap.add_argument("--limit", type=int, default=0, help="smoke: stop after N units")
    ap.add_argument("--skip-preflight", action="store_true",
                    help="skip the /v1/models check (it is the only startup network call)")
    args = ap.parse_args()

    if not os.path.exists(args.inp):
        raise SystemExit(f"--in {args.inp} does not exist")
    if args.conc < 1:
        raise SystemExit("--conc must be >= 1")

    headers = {}
    if args.auth == "bearer":
        tok = os.environ.get("HF_TOKEN", "")
        if not tok:
            raise SystemExit("--auth bearer needs a non-empty HF_TOKEN in the environment")
        headers = {"Authorization": "Bearer " + tok}

    run_id = args.run_id or f"gap-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{uuid.uuid4().hex[:8]}"

    # point the imported client at THIS endpoint. Module state, set explicitly — not through
    # the env scheme it would otherwise read, so there is exactly one place the URL comes from.
    ec.URLS = [args.url.rstrip("/") + "/v1/chat/completions"]
    ec.HEADERS = headers
    ec.MODEL_NAME = args.model
    ec._rr = {"i": 0}

    if not args.skip_preflight:
        preflight(args.url, args.model, headers)

    all_units = [json.loads(l) for l in open(args.inp, encoding="utf-8") if l.strip()]
    missing = [u["id"] for u in all_units if not u.get("ghash")]
    if missing:
        raise SystemExit(f"{len(missing)} input rows carry no ghash (e.g. {missing[:3]}) — "
                         f"re-export with p2_gap_export.py; resume is grounding-versioned")

    done = read_journal(args.out)
    # rebuild the card overlay from views already enriched in this journal, so a resumed run
    # shows later units the same fresh view descriptions an uninterrupted one would have.
    for u in all_units:
        if u["source"] == "view" and u.get("name"):
            rec = done.get(u["id"])
            if rec and rec.get("ok"):
                ec.OVERLAY[u["name"]] = (rec.get("result", {}).get("description") or "")[:1600]

    def is_done(u):
        rec = done.get(u["id"])
        return bool(rec and rec.get("ok") and rec.get("ghash") == u["ghash"])

    units = [u for u in all_units if not is_done(u)]
    if args.limit:
        units = units[:args.limit]
    log(f"run_id={run_id} model={args.model} conc={args.conc}")
    log(f"pending {len(units)} of {len(all_units)} (journal holds {len(done)} ids, "
        f"overlay {len(ec.OVERLAY)})")
    if not units:
        log("nothing to do")
        return 0

    stats = {"ok": 0, "err": 0}
    t0 = time.time()
    with open(args.out, "a", encoding="utf-8") as fh:
        journal = Journal(fh, args.model, run_id)
        asyncio.run(run(units, journal, args.conc, stats))
    el = time.time() - t0
    log(f"DONE ok={stats['ok']} err={stats['err']} in {el / 60:.1f}min "
        f"({stats['ok'] + stats['err']} rows appended to {args.out})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
