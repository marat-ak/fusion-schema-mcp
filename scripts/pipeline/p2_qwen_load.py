"""P2a — load the Qwen generation-2 enrichment from its PRIMARY JSONL files.

This is the only door the generation-2 enrichment comes through. It is NOT read back
out of a shipped release schema: doing that made "rebuilt from raw" a fiction, because
the release is itself a lossy projection of these files (4 fields of 23 survive it).

INPUT — exactly these ten files, nothing else:

    enrich_output.view.w0.jsonl … w7   6,077 ids   the eight view waves
    enrich_output.bip.jsonl            6,245 ids
    enrich_output.otbi.jsonl          11,288 ids

`enrich_output.otbi.round1-local-stale.jsonl` is REFUSED by name: it is a superseded
round whose 32,433 ids collapse to 4,133 canonical ones, every one of them present in
the final otbi file.

RECORD SHAPE (enrich_client.py:210) — `{id, source, ok, ghash, result, usage}`:

  id      the OLD unit id: view:<NAME> | sql:<sha256> | otbi:<subject>__<item>.
          Mapped to its sql_hash through work.sql_unit by p2_promote.sql.
  ghash   the grounding hash — the hash of the FACTS the model was shown. It is the
          only true input key any enrichment has ever had and the only thing that can
          make a later run incremental. PRESENT ON otbi ONLY: the view and bip waves
          ran before enrich_client grew the field (`"ghash": u.get("ghash")`), and
          their input files carry no ghash at all. Stored as NULL for those; see the
          README, this is a real gap, not a load bug.
  result  the whole 23-field payload. Stored VERBATIM in work.qwen_record.payload;
          p2_promote.sql promotes columns out of it and drops nothing.
  usage   prompt/completion token counts. Stored.

  model / run_id / produced_at
          NULL on every one of these ten files, and that is the truth about them:
          enrich_client.py resolves MODEL_NAME from the endpoint at startup and never
          writes it per row, so `usage` is the only per-call evidence the 2026-08 run
          left. The columns exist because p2_gap_run.py writes them on rows it
          produces. They are nullable for exactly this reason and are NEVER backfilled,
          inferred or defaulted here — a model name guessed for a 2026-08 record would
          be a fabrication wearing the shape of provenance.

LAST LINE PER ID WINS. The files are append-mode resume logs: a failed call is retried
by appending, and `is_done()` skips on a later run. 406 otbi ids have more than one
line. Counting lines instead of ids is what produced the "388 differing rows" ghost.

EXTRA JOURNALS (2026-09-21). Later runs — the gap run, the recheck run — append to the
same table through the same door: `EXTRA_FILES` is a comma-separated list of absolute
paths (inside the container) read AFTER the ten primaries, in the order given. Last line
per id still wins, now across files too, so a recheck record written under a unit id
supersedes the earlier record for that id — exactly the resume-log semantics. The load
stays a full rebuild of work.qwen_record (DROP + COPY), so it is idempotent by
construction; a rerun with the same file set produces the same table.

THE CLAIMS ARE KEPT FROM EVERY LINE (2026-09-21). `work.qwen_record` is last-line-wins
because the TEXT (description, intents, rewrite) has exactly one current generation. The
model's table claims (`missingTables` / `extraTables`) are not like that: a claim is made
against the FACTS block that record was shown, and a later generation that was shown the
table IN its facts does not repeat the claim — it saw it. Reading claims off the current
record only therefore retracted every accepted addition on its own recheck (measured:
878 → 180). So `work.qwen_claim` holds one row per claim per journal line, every
generation, and p3_reconcile.sql reconciles over that union. Text last-wins; claims union.

Run through p2_qwen.sh (stages the files read-only into a python container), or through
p2_recheck.sh which passes EXTRA_FILES.
"""
import json
import os
import sys

import psycopg

DATABASE_URL = os.environ.get("DATABASE_URL")
if not DATABASE_URL:
    raise SystemExit("DATABASE_URL is required — no default")

DATA_DIR = os.environ.get("ENRICH_DIR")
if not DATA_DIR:
    raise SystemExit("ENRICH_DIR is required — no default")

FILES = [f"enrich_output.view.w{i}.jsonl" for i in range(8)] + [
    "enrich_output.bip.jsonl",
    "enrich_output.otbi.jsonl",
]
REFUSED = "round1-local-stale"

# (label, path): the ten primaries under ENRICH_DIR, then the extra journals as given.
SOURCES = [(f, os.path.join(DATA_DIR, f)) for f in FILES] + [
    (os.path.basename(x.strip()), x.strip())
    for x in os.environ.get("EXTRA_FILES", "").split(",") if x.strip()
]

DDL = """
DROP TABLE IF EXISTS work.qwen_record CASCADE;
CREATE TABLE work.qwen_record (
  unit_id  text PRIMARY KEY,   -- the OLD unit id, verbatim from the JSONL
  src_file text    NOT NULL,   -- which primary file the WINNING line came from
  line_no  integer NOT NULL,   -- 1-based line number of the winning line
  n_lines  integer NOT NULL,   -- how many lines this id has (retries + resumes)
  source   text    NOT NULL,   -- the record's own source label
  ok       boolean NOT NULL,
  error    text,               -- set when ok = false; payload is then NULL
  ghash    text,               -- grounding hash; otbi only (see the module docstring)
  payload  jsonb,              -- the WHOLE result object, 23 fields, verbatim
  usage    jsonb,              -- token counts
  -- run provenance. NULL for all ten 2026-08 files; written by p2_gap_run.py on its rows.
  model       text,
  run_id      text,
  produced_at timestamptz
);

DROP TABLE IF EXISTS work.qwen_claim CASCADE;
CREATE TABLE work.qwen_claim (
  unit_id          text    NOT NULL,   -- the OLD unit id, as on the line
  src_file         text    NOT NULL,
  line_no          integer NOT NULL,
  run_id           text,               -- NULL = the 2026-08 run
  ghash            text,               -- the grounding this claim was made against
  kind             text    NOT NULL,   -- missing | extra
  table_name       text    NOT NULL,   -- upper, trimmed, as the model spelled it
  tables_confirmed boolean             -- the line's own tablesConfirmed
);
"""


def log(m):
    print(f"[p2-qwen] {m}", flush=True)


def main():
    for f, p in SOURCES:
        if REFUSED in f:
            raise SystemExit(f"refusing superseded file {f}")
        if not os.path.exists(p):
            raise SystemExit(f"missing input {p} — refusing a partial load")
    log(f"sources: {len(FILES)} primary + {len(SOURCES) - len(FILES)} extra "
        f"({', '.join(f for f, _ in SOURCES[len(FILES):]) or 'none'})")

    # id -> winning record; insertion order preserved, last write wins.
    best: dict = {}
    counts: dict = {}
    claims: list = []   # every claim on every ok line, no generation dropped
    for f, p in SOURCES:
        lines = ok = bad = unparsable = 0
        with open(p, encoding="utf-8") as fh:
            for n, raw in enumerate(fh, 1):
                raw = raw.strip()
                if not raw:
                    continue
                lines += 1
                try:
                    d = json.loads(raw)
                except Exception:
                    unparsable += 1
                    continue
                uid = d.get("id")
                if not uid:
                    unparsable += 1
                    continue
                is_ok = bool(d.get("ok"))
                ok += is_ok
                bad += not is_ok
                res = d.get("result") if isinstance(d.get("result"), dict) else None
                if is_ok and res:
                    tc = res.get("tablesConfirmed")
                    tc = tc if isinstance(tc, bool) else None
                    for kind, key in (("missing", "missingTables"), ("extra", "extraTables")):
                        names = res.get(key)
                        for t in (names if isinstance(names, list) else []):
                            t = str(t).strip().upper()
                            if t:
                                claims.append((uid, f, n, d.get("run_id"), d.get("ghash"), kind, t, tc))
                prev = best.get(uid)
                best[uid] = {
                    "unit_id": uid,
                    "src_file": f,
                    "line_no": n,
                    "n_lines": (prev["n_lines"] + 1) if prev else 1,
                    "source": d.get("source") or "",
                    "ok": is_ok,
                    "error": d.get("error"),
                    "ghash": d.get("ghash"),
                    "payload": d.get("result") if isinstance(d.get("result"), dict) else None,
                    "usage": d.get("usage") if isinstance(d.get("usage"), dict) else None,
                    # absent from the ten primary files, present on p2_gap_run.py's rows
                    "model": d.get("model"),
                    "run_id": d.get("run_id"),
                    "produced_at": d.get("produced_at"),
                }
        counts[f] = (lines, ok, bad, unparsable)
        log(f"{f}: lines={lines} ok={ok} failed={bad} unparsable={unparsable}")

    retried = sum(1 for r in best.values() if r["n_lines"] > 1)
    superseded = sum(r["n_lines"] - 1 for r in best.values())
    ends_failed = sum(1 for r in best.values() if not r["ok"])
    with_ghash = sum(1 for r in best.values() if r["ghash"])
    with_model = sum(1 for r in best.values() if r["model"])
    log(f"distinct ids={len(best)} retried_ids={retried} superseded_lines={superseded} "
        f"ends_on_failure={ends_failed} with_ghash={with_ghash} with_model={with_model}")

    conn = psycopg.connect(DATABASE_URL, autocommit=False)
    conn.execute("SET statement_timeout = 0")
    conn.execute(DDL)
    with conn.cursor() as cur:
        with cur.copy("COPY work.qwen_record (unit_id, src_file, line_no, n_lines, source, "
                      "ok, error, ghash, payload, usage, model, run_id, produced_at) "
                      "FROM STDIN") as cp:
            for r in best.values():
                cp.write_row((
                    r["unit_id"], r["src_file"], r["line_no"], r["n_lines"], r["source"],
                    r["ok"], r["error"], r["ghash"],
                    json.dumps(r["payload"], ensure_ascii=False) if r["payload"] is not None else None,
                    json.dumps(r["usage"], ensure_ascii=False) if r["usage"] is not None else None,
                    r["model"], r["run_id"], r["produced_at"],
                ))
    with conn.cursor() as cur:
        with cur.copy("COPY work.qwen_claim (unit_id, src_file, line_no, run_id, ghash, kind, "
                      "table_name, tables_confirmed) FROM STDIN") as cp:
            for row in claims:
                cp.write_row(row)
    conn.execute("CREATE INDEX ix_qwen_claim_unit ON work.qwen_claim (unit_id)")
    log(f"work.qwen_claim: {len(claims)} claim rows "
        f"({sum(1 for c in claims if c[5] == 'missing')} missing, "
        f"{sum(1 for c in claims if c[3])} from run_id-stamped lines)")
    conn.execute("CREATE INDEX ix_qwen_record_source ON work.qwen_record (source)")
    conn.execute("CREATE INDEX ix_qwen_record_ghash  ON work.qwen_record (ghash) WHERE ghash IS NOT NULL")
    conn.execute("ANALYZE work.qwen_record")
    conn.commit()

    n = conn.execute("SELECT count(*) FROM work.qwen_record").fetchone()[0]
    log(f"work.qwen_record: {n} rows")
    if n != len(best):
        raise SystemExit(f"load mismatch: staged {len(best)} but table holds {n}")
    conn.close()


if __name__ == "__main__":
    sys.exit(main())
