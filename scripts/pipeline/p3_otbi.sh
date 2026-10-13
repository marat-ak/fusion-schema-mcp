#!/usr/bin/env bash
# P3o — the OTBI presentation catalog in `work`: stage the sources, derive the entities, write the reports.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'OTBI_SRC=/root/otbi-src bash /mnt/c/.../scripts/pipeline/p3_otbi.sh [stage|derive|report|all]'
#
# OTBI_SRC (REQUIRED, no default) is a directory ON THE DISTRO FS holding the three inputs, copied
# once from C:\Marat\OSaaS\ClaudeShared\Bip\OTBI (the 9p /mnt/c mount cannot be bind-mounted reliably):
#   lineage/r13-26b-{cx,fin,grc,hcm,ppm,scm-and-prc}-otbi-database-mapping-with-viewobjects.xlsx
#     (the HCM "(1)" file is a byte-identical duplicate — not copied)
#   subject_areas.json          <- Bip/OTBI/metadata/subject_areas.json        (SOAP crawl: SA/folder/column/dataType)
#   presentation_tables.jsonl   <- Bip/OTBI/results/kb/presentation_tables.jsonl (probe per folder: status, lineage, physical SQL)
#
# Steps (a work-schema build, no release label; the release projection is p5_otbi.sh <ver>):
#   stage   p3_otbi_load.py (python:3.12-slim + psycopg + openpyxl) -> work.otbi_lineage / otbi_crawl_* / otbi_probe*
#   derive  p3_otbi.sql -> work.otbi_subject_area / otbi_folder / otbi_column / otbi_text (+ work.unit_title)
#   report  p3_otbi_report.sql -> data/otbi_gap_list.md + data/otbi_reconciliation.md (the deliverables)
# Then p4_run.sh embeds work.otbi_text (owner_kind 'otbi').
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/scripts/pipeline"
STEP="${1:-all}"
DB="${DB:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
URL="postgresql://postgres:${PW}@stack-db:5432/${DB}"
pg() { docker exec -i stack-db psql -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -P pager=off "$@"; }

stage() {
  [ -n "${OTBI_SRC:-}" ] || { echo "[p3o] OTBI_SRC is required (a distro-fs dir with lineage/, subject_areas.json, presentation_tables.jsonl)"; exit 2; }
  for f in subject_areas.json presentation_tables.jsonl lineage; do
    [ -e "$OTBI_SRC/$f" ] || { echo "[p3o] $OTBI_SRC/$f missing"; exit 2; }
  done
  STAGE=/tmp/pipeline-p3o
  rm -rf "$STAGE" && mkdir -p "$STAGE"
  cp "$HERE/p3_otbi_load.py" "$STAGE/"
  echo "[p3o] stage: $OTBI_SRC -> work.otbi_* on $DB"
  docker run --rm --network "$NET" \
    -v "$STAGE:/app/scripts" -v "$OTBI_SRC:/data:ro" \
    -e DATABASE_URL="$URL" -e OTBI_SRC=/data -e PARSE_PROCS="${PARSE_PROCS:-}" \
    "$IMAGE" sh -c "pip install -q 'psycopg[binary]' openpyxl && python /app/scripts/p3_otbi_load.py"
}

derive() {
  echo "[p3o] derive: p3_otbi.sql on $DB"
  docker cp "$HERE/p3_otbi.sql" stack-db:/tmp/p3_otbi.sql >/dev/null
  pg -f /tmp/p3_otbi.sql
}

report() {
  echo "[p3o] report: p3_otbi_report.sql -> data/otbi_gap_list.md, data/otbi_reconciliation.md"
  docker cp "$HERE/p3_otbi_report.sql" stack-db:/tmp/p3_otbi_report.sql >/dev/null
  mkdir -p "$REPO/data"
  pg -q -v section=gap -f /tmp/p3_otbi_report.sql > "$REPO/data/otbi_gap_list.md"
  pg -q -v section=reconcile -f /tmp/p3_otbi_report.sql > "$REPO/data/otbi_reconciliation.md"
  wc -l "$REPO/data/otbi_gap_list.md" "$REPO/data/otbi_reconciliation.md"
}

case "$STEP" in
  stage) stage ;;
  derive) derive ;;
  report) report ;;
  all) stage; derive; report ;;
  *) echo "usage: p3_otbi.sh [stage|derive|report|all]"; exit 2 ;;
esac
