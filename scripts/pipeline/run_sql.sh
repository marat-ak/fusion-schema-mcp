#!/usr/bin/env bash
# run_sql.sh — run ONE pipeline .sql file for ONE release label.
#
#   bash run_sql.sh <file.sql> <ver> [psql args...]        e.g.
#   bash run_sql.sh p5_fill.sql v2026_11
#   bash run_sql.sh p7_own.sql  v2026_11 -v schemas=work,v2026_11 -v owner=fusion_dev
#
# The release .sql files (p5_fill, p5_index, p6_verify, p5_plsql) name the release schema as
# {{V}}; this substitutes the label, stages the file in stack-db and runs it with
# `psql -v ON_ERROR_STOP=1`. Extra arguments go to psql unchanged. DB=<database> selects the
# database (default: fusion_dev, the build database — releases are built there and moved by
# p9_release.sh). Heredocs through the WSL bridge mangle quoting, hence always a staged file.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
F="${1:-}"; V="${2:-}"
[ -n "$F" ] && [ -n "$V" ] || { echo "usage: run_sql.sh <file.sql> <ver> [psql args...]"; exit 2; }
shift 2
[ -f "$F" ] || F="$HERE/$F"
[ -f "$F" ] || { echo "[run_sql] no such file: $F"; exit 2; }
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "[run_sql] label must be v<YYYY_MM> (got '$V')"; exit 2; }
DB="${DB:-fusion_dev}"

STAGE=/tmp/pipeline-sql
mkdir -p "$STAGE"
OUT="$STAGE/${V}-$(basename "$F")"
sed "s/{{V}}/$V/g" "$F" > "$OUT"
docker cp "$OUT" stack-db:/tmp/run_sql.sql >/dev/null
echo "[run_sql] $(basename "$F") for $V on $DB"
docker exec -i stack-db psql -U postgres -d "$DB" -X -v ON_ERROR_STOP=1 -P pager=off "$@" -f /tmp/run_sql.sql
