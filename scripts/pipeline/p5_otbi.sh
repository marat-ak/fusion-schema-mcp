#!/usr/bin/env bash
# P5e — fill the OTBI presentation catalog of a release schema from `work` (after p3_otbi.sh + p4_run.sh) and,
# since ddl_version 9, the VO hop, the exposure index and the subject area -> duty map from Oracle's TBI guides.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_otbi.sh v2027_07 26d'
#
# A step of the chain for the release being BUILT (after p5_fill.sql, before p5_index.sql): the
# otbi_* tables come from p5_ddl.sh (ddl.sql). NEVER run against a release that is already built —
# fusion_dev.v<ver> is immutable after p7_own.sql; a content change is a new label through the full
# chain. One transaction, DELETE + INSERT.
# Both arguments are REQUIRED: <ver> = the release label; <tbi release> = the guide crawl directory
# data/otbi/tbi_guides/<tbi release>/ (p3_tbi_guides.py) whose area_duty.jsonl / duty.jsonl / job.jsonl are
# staged in stack-db at /tmp/p5tbi.jsonl, /tmp/p5tbiduty.jsonl, /tmp/p5tbijob.jsonl (ddl_version 10: the job
# roles per area — otbi_area_job); the curated rename aliases (otbi_area_aliases.json, next to this script) are
# spliced into the staged SQL verbatim.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
V="${1:-}"; TBI="${2:-}"
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] && [[ "$TBI" =~ ^[0-9a-z]+$ ]] || {
  echo "usage: $(basename "$0") <ver> <tbi release>   (v<YYYY_MM> and the guide crawl dir, e.g. 26d — both REQUIRED, no default)"; exit 2; }
DB="${DB:-fusion_dev}"
GUIDES="$REPO/data/otbi/tbi_guides/$TBI/area_duty.jsonl"
DUTIES="$REPO/data/otbi/tbi_guides/$TBI/duty.jsonl"
JOBS="$REPO/data/otbi/tbi_guides/$TBI/job.jsonl"
ALIASES="$HERE/otbi_area_aliases.json"
for f in "$GUIDES" "$DUTIES" "$JOBS"; do [ -f "$f" ] || { echo "[p5e] guide crawl file not found: $f (run p3_tbi_guides.py)"; exit 1; }; done
[ -f "$ALIASES" ] || { echo "[p5e] rename aliases not found: $ALIASES (run p3_tbi_aliases.py)"; exit 1; }
STAGE=/tmp/pipeline-p5
mkdir -p "$STAGE"
OUT="$STAGE/${V}-otbi.sql"

sed -e "s/{{V}}/$V/g" -e "s/{{TBI_RELEASE}}/$TBI/g" -e "/^{{ALIASES}}\$/{r $ALIASES" -e 'd' -e '}' "$HERE/p5_otbi.sql" > "$OUT"
grep -qx '{{ALIASES}}' "$OUT" && { echo "[p5e] aliases were not spliced into $OUT"; exit 1; }
docker cp "$GUIDES" stack-db:/tmp/p5tbi.jsonl >/dev/null
docker cp "$DUTIES" stack-db:/tmp/p5tbiduty.jsonl >/dev/null
docker cp "$JOBS" stack-db:/tmp/p5tbijob.jsonl >/dev/null
docker cp "$OUT" stack-db:/tmp/p5otbi.sql >/dev/null
docker exec -i stack-db psql -U postgres -d "$DB" -v ON_ERROR_STOP=1 -f /tmp/p5otbi.sql
echo "[p5e] $V.otbi_* filled from work + the TBI guides $TBI (db $DB)"
