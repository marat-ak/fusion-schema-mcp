"""E2E validation helper — filter an export jsonl down to a set of unit ids.

export_wave.py always emits an ENTIRE phase/wave (all depth-d views, or all bips). For the scoped E2E
test we keep only the closure/chosen ids. This is the "reuse export_wave.py then FILTER" path — the
prompt-building logic in export_wave.py is reused verbatim; this only drops lines.

Env: IN (full export jsonl), IDS (file, one id per line), OUT (filtered jsonl).
"""
import json, os, sys

IN = os.environ["IN"]
IDS = os.environ["IDS"]
OUT = os.environ["OUT"]

want = set()
with open(IDS, encoding="utf-8") as f:
    for line in f:
        s = line.strip()
        if s:
            want.add(s)

kept = total = 0
seen = set()
with open(IN, encoding="utf-8") as fin, open(OUT, "w", encoding="utf-8") as fout:
    for line in fin:
        total += 1
        try:
            uid = json.loads(line).get("id")
        except Exception:
            continue
        if uid in want:
            fout.write(line)
            kept += 1
            seen.add(uid)

missing = want - seen
print(f"[filter] {IN} -> {OUT}: kept {kept}/{total} (wanted {len(want)})"
      + (f"  MISSING {len(missing)}: {', '.join(sorted(missing)[:8])}" if missing else ""))
if missing:
    sys.stderr.write(f"[filter] WARNING: {len(missing)} wanted ids not found in export "
                     f"(excluded_reason? not in phase/wave?): {', '.join(sorted(missing)[:12])}\n")
