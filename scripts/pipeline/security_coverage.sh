#!/usr/bin/env bash
# SECURITY COVERAGE ANALYSIS (offline, read-only) — every catalog object of a release against the pod's
# data-security export (FND_OBJECTS / privileges / instance sets / grant links) + the corpus.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/security_coverage.sh v2027_03'
#
# Inputs (all read-only):
#   data/security/*.csv            the pod export (01 objects, 02 privileges, 03 instance sets, 04 grant links,
#                                  05 BOSS mapping) — copied to the distro fs first (the 9p mount is not bind-mountable)
#   <ver>.* on DB_SERVE            the release dictionary + security facts (tables/columns/pkeys/fkeys/relationships/
#                                  table_security/table_disallowed)
#   work.* on DB_WORK              the corpus (r_tables usage, f_joins / f_predicates column evidence, view lineage)
#   p5_security_rules.json         the curated exclusions (HCM prefixes, catalog noise) — reused, not re-declared
# Output: data/security/coverage/  (objects.csv, conditions.csv, via_join_columns.csv, direct_privileges.csv,
#                                  customer_layer.csv, summary.json, report_tables.md, samples.sql)
# Nothing is written to any database. The label is REQUIRED (a default would silently analyse the wrong release).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
HERE="$REPO/scripts/pipeline"
V="${1:-}"
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "usage: $(basename "$0") <ver>   (v<YYYY_MM>, REQUIRED)"; exit 2; }
DB_SERVE="${DB_SERVE:-fusion}"
DB_WORK="${DB_WORK:-fusion_dev}"
NET="${NET:-oservices_default}"
IMAGE="${IMAGE:-python:3.12-slim}"
SRC="$REPO/data/security"
RULES="$HERE/p5_security_rules.json"
[ -f "$RULES" ] || { echo "[secx] rules file not found: $RULES"; exit 1; }
ls "$SRC"/*.csv >/dev/null 2>&1 || { echo "[secx] no export CSVs in $SRC"; exit 1; }

PW="$(docker exec stack-db printenv POSTGRES_PASSWORD)"
STAGE=/tmp/pipeline-secx
rm -rf "$STAGE" && mkdir -p "$STAGE/in" "$STAGE/out" "$STAGE/app"
cp "$SRC"/*.csv "$STAGE/in/"
cp "$RULES" "$STAGE/in/rules.json"
cp "$HERE/security_coverage.py" "$STAGE/app/"

echo "[secx] $V: export $(ls "$STAGE/in" | wc -l) files -> analysis (serve $DB_SERVE, work $DB_WORK)"
docker run --rm --network "$NET" \
  -v "$STAGE/app:/app:ro" -v "$STAGE/in:/in:ro" -v "$STAGE/out:/out" \
  -e DATABASE_URL_SERVE="postgresql://postgres:${PW}@stack-db:5432/${DB_SERVE}" \
  -e DATABASE_URL_WORK="postgresql://postgres:${PW}@stack-db:5432/${DB_WORK}" \
  -e RELEASE="$V" -e SEC_SRC=/in -e OUT_DIR=/out -e RULES=/in/rules.json \
  "$IMAGE" sh -c "pip install -q 'psycopg[binary]' && python /app/security_coverage.py"

mkdir -p "$SRC/coverage"
cp -r "$STAGE/out"/. "$SRC/coverage/"
echo "[secx] written: $(ls "$SRC/coverage" | tr '\n' ' ')"
