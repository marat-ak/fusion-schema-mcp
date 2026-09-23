#!/usr/bin/env bash
# P5a — create the release schema with the PRODUCT's own DDL.
#
# The shape of a version schema is defined in exactly one place —
# scripts/pg-import/ddl.sql — and `src/db/postgres/schemas.ts` + `PgMeta.verify()`
# are written against it. This script therefore DERIVES the release DDL from that
# file instead of restating it: it takes the `corpus` and `vendor` blocks (the
# `meta` block is skipped — `meta` and `customer` are database-level and outside
# this build's write scope) and substitutes both {{S}} and {{V}} with the version
# schema, which is exactly what a version schema is: corpus + vendor in one place.
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p5_ddl.sh v2026_11'
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
V="${1:-}"
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "usage: $(basename "$0") <ver>   (v<YYYY_MM>, the label is REQUIRED — a default would target a distributed release)"; exit 2; }
DB="${DB:-fusion_dev}"
DDL="$REPO/scripts/pg-import/ddl.sql"
STAGE=/tmp/pipeline-p5
mkdir -p "$STAGE"
OUT="$STAGE/${V}-ddl.sql"

[ -f "$DDL" ] || { echo "[p5a] ddl.sql not found: $DDL"; exit 1; }
DDLV="$(sed -n 's/^-- ddl_version:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$DDL" | head -1)"
[ -n "$DDLV" ] || { echo "[p5a] ddl.sql has no '-- ddl_version:' header"; exit 1; }

{
  echo "\\set ON_ERROR_STOP on"
  echo "DROP SCHEMA IF EXISTS $V CASCADE;"
  # corpus + vendor are the last two blocks of the file, in that order
  awk '/^-- @block corpus/{p=1} p' "$DDL" | sed "s/{{S}}/$V/g; s/{{V}}/$V/g"
  echo "CREATE TABLE IF NOT EXISTS work.build_meta (k text PRIMARY KEY, v text);"
  echo "INSERT INTO work.build_meta (k,v) VALUES ('ddl_version','$DDLV'),('release_schema','$V')"
  echo "  ON CONFLICT (k) DO UPDATE SET v = excluded.v;"
} > "$OUT"

docker cp "$OUT" stack-db:/tmp/p5ddl.sql >/dev/null
docker exec -i stack-db psql -U postgres -d "$DB" -q -v ON_ERROR_STOP=1 -f /tmp/p5ddl.sql
echo "[p5a] $V created from ddl.sql (ddl_version $DDLV)"
docker exec -i stack-db psql -U postgres -d "$DB" -c \
  "SELECT count(*) AS tables_created FROM information_schema.tables WHERE table_schema='$V'"
