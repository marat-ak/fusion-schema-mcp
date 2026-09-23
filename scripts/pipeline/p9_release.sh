#!/usr/bin/env bash
# P9 — move a built release from the build database into a served database and switch to it.
#
#   bash p9_release.sh <ver> <target-db> <owner>
#   bash p9_release.sh v2026_11 fusion fusion          # the real thing: served DB, serving role
#   bash p9_release.sh v2026_11 fusion_rehearsal fusion # a throwaway copy, same shape
#
# What it does, in order (every step loud, nothing defaulted, nothing typed by hand):
#   0. refuses unless: the release exists in the build DB with its own stamps, the target is a
#      served catalog DB (has `meta.seeds` + `meta.active_version`), the owner role exists, and
#      the target does NOT already hold v<ver> (a re-run against a released version is a no-op
#      with a message when it is the active one; refused when it is a leftover — drop by hand).
#   1. `pg_dump -Fc -n v<ver>` from the build DB and `pg_restore --no-owner --exit-on-error`
#      into the target ALONGSIDE whatever is served — the previous version schema is never
#      dropped; rollback is one pointer update (printed at the end).
#   2. `p7_own.sql` on v<ver> with the target's role.
#   3. reads `ddl_version` + `embedding_version` FROM THE RESTORED SCHEMA's catalog_meta (the
#      stamps p5_fill wrote from work.build_meta), gates ddl_version against the repo's
#      scripts/pg-import/ddl.sql header (what the serving image speaks), ANALYZEs the schema.
#   4. ONE transaction: upsert meta.seeds(v<ver>) from those stamps, then — last — point
#      meta.active_version at v<ver> (`refreshIfMoved()` in the provider follows it).
#   5. `p6_verify.sql` against the target (release-only sections) and the served-version line.
#
# Build database: fusion_dev (SRC_DB to override). Runs from the CloudBeaver distro:
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/p9_release.sh v2026_11 fusion fusion'
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
V="${1:-}"; TDB="${2:-}"; OWNER="${3:-}"
[ -n "$V" ] && [ -n "$TDB" ] && [ -n "$OWNER" ] || { echo "usage: p9_release.sh <ver> <target-db> <owner>   (all three required)"; exit 2; }
[[ "$V" =~ ^v[0-9]{4}_[0-9]{2}$ ]] || { echo "[p9] label must be v<YYYY_MM> (got '$V')"; exit 2; }
SRC_DB="${SRC_DB:-fusion_dev}"
[ "$SRC_DB" != "$TDB" ] || { echo "[p9] target must differ from the build database ($SRC_DB)"; exit 2; }
DDL="$REPO/scripts/pg-import/ddl.sql"
STAGE=/tmp/pipeline-p9
mkdir -p "$STAGE"

pg()  { docker exec -i stack-db psql -U postgres -X -v ON_ERROR_STOP=1 -P pager=off "$@"; }
t1()  { pg -d "$TDB" -Atc "$1"; }            # scalar from the target
s1()  { pg -d "$SRC_DB" -Atc "$1"; }         # scalar from the build DB
die() { echo "[p9] $*"; exit 3; }

echo "[p9] release $V: $SRC_DB -> $TDB (owner $OWNER)"

# ---------------------------------------------------------------- 0. preconditions
[ "$(pg -Atc "SELECT count(*) FROM pg_database WHERE datname = '$TDB'")" = 1 ] || die "target database $TDB does not exist — not creating it"
[ "$(s1 "SELECT count(*) FROM pg_namespace WHERE nspname = '$V'")" = 1 ] || die "$SRC_DB has no schema $V — build it first (p5_ddl.sh … p7_own.sql)"
SRC_DDLV="$(s1 "SELECT value FROM $V.catalog_meta WHERE key = 'ddl_version'")"
SRC_EMB="$(s1 "SELECT value FROM $V.catalog_meta WHERE key = 'embedding_version'")"
[ -n "$SRC_DDLV" ] && [ -n "$SRC_EMB" ] || die "$SRC_DB.$V.catalog_meta lacks ddl_version / embedding_version — not a finished release"
[ "$(t1 "SELECT count(*) FROM information_schema.tables WHERE table_schema = 'meta' AND table_name IN ('seeds','active_version')")" = 2 ] \
  || die "$TDB has no meta.seeds / meta.active_version — it is not a served catalog database"
[ "$(pg -Atc "SELECT count(*) FROM pg_roles WHERE rolname = '$OWNER'")" = 1 ] || die "role $OWNER does not exist"
ACTIVE="$(t1 "SELECT version FROM meta.active_version")"
if [ "$(t1 "SELECT count(*) FROM pg_namespace WHERE nspname = '$V'")" = 1 ]; then
  if [ "$ACTIVE" = "$V" ] && [ "$(t1 "SELECT count(*) FROM meta.seeds WHERE version = '$V'")" = 1 ]; then
    echo "[p9] $TDB already holds $V, registered in meta.seeds and serving as meta.active_version — nothing to do"
    t1 "SELECT 'served: db=' || current_database() || ' active_version=' || a.version || ' ddl_version=' || s.ddl_version || ' embedding_model=' || s.embedding_model || ' switched_at=' || a.switched_at FROM meta.active_version a JOIN meta.seeds s ON s.version = a.version"
    exit 0
  fi
  die "$TDB already has a schema $V but it is not the registered active version (active = ${ACTIVE:-none}) — a previous run left it; inspect, then DROP SCHEMA $V CASCADE by hand before re-running"
fi
echo "[p9] currently served in $TDB: ${ACTIVE:-none}; version schemas present: $(t1 "SELECT string_agg(nspname, ', ' ORDER BY nspname) FROM pg_namespace WHERE nspname ~ '^v[0-9]{4}_[0-9]{2}$'")"
echo "[p9] release stamps in $SRC_DB.$V: ddl_version=$SRC_DDLV embedding_version=$SRC_EMB"

# ---------------------------------------------------------------- 1. dump + restore alongside
echo "[p9] pg_dump -Fc -n $V $SRC_DB"
docker exec -i stack-db bash -c "pg_dump -U postgres -Fc -n $V -f /tmp/p9-$V.dump $SRC_DB && ls -la /tmp/p9-$V.dump"
echo "[p9] pg_restore --no-owner --exit-on-error -d $TDB (HNSW indexes rebuild single-threaded: a parallel build needs more shared memory than the container's /dev/shm has — 'could not resize shared memory segment')"
if ! docker exec -i -e PGOPTIONS='-c max_parallel_maintenance_workers=0 -c maintenance_work_mem=1GB' \
     stack-db pg_restore -U postgres --no-owner --exit-on-error -d "$TDB" "/tmp/p9-$V.dump"; then
  die "restore failed; the partial schema $V is left in $TDB for inspection — DROP SCHEMA $V CASCADE by hand before re-running"
fi

# ---------------------------------------------------------------- 2. ownership
DB="$TDB" bash "$HERE/run_sql.sh" p7_own.sql "$V" -v schemas="$V" -v owner="$OWNER"
LEFT="$(t1 "SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$V' AND c.relkind IN ('r','v','m','S','p') AND pg_get_userbyid(c.relowner) <> '$OWNER'")"
[ "$LEFT" = 0 ] || die "$LEFT objects in $TDB.$V are not owned by $OWNER"

# ---------------------------------------------------------------- 3. stamps FROM THE RESTORED RELEASE
DDLV="$(t1 "SELECT value FROM $V.catalog_meta WHERE key = 'ddl_version'")"
EMB="$(t1 "SELECT value FROM $V.catalog_meta WHERE key = 'embedding_version'")"
[ -n "$DDLV" ] && [ -n "$EMB" ] || die "restored $TDB.$V.catalog_meta lacks ddl_version / embedding_version"
HDR="$(sed -n 's/^-- ddl_version:[[:space:]]*\([^[:space:]]*\).*/\1/p' "$DDL" | head -1)"
[ -n "$HDR" ] || die "$DDL has no '-- ddl_version:' header"
[ "$DDLV" = "$HDR" ] || die "release is stamped ddl_version $DDLV but scripts/pg-import/ddl.sql says $HDR — the serving image (EXPECTED_DDL_VERSION) would refuse it; not registering, not switching (schema $V left in $TDB — drop it by hand)"
echo "[p9] stamps read from $TDB.$V: ddl_version=$DDLV (ddl.sql header $HDR: OK) embedding_model=$EMB"
echo "[p9] ANALYZE $V (a restore carries no statistics; the planner must see the HNSW indexes)"
pg -d "$TDB" -q -Atc "SELECT format('ANALYZE %I.%I;', n.nspname, c.relname) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = '$V' AND c.relkind = 'r' ORDER BY 1" > "$STAGE/analyze.sql"
docker cp "$STAGE/analyze.sql" stack-db:/tmp/p9-analyze.sql >/dev/null
pg -d "$TDB" -q -f /tmp/p9-analyze.sql

# ---------------------------------------------------------------- 4. register, then switch (last)
cat > "$STAGE/register.sql" <<'SQL'
\set ON_ERROR_STOP on
BEGIN;
INSERT INTO meta.seeds (version, embedding_model, ddl_version, restored_at, activated_at)
VALUES (:'ver', :'emb', :'ddlv', now(), now())
ON CONFLICT (version) DO UPDATE
  SET embedding_model = EXCLUDED.embedding_model, ddl_version = EXCLUDED.ddl_version,
      restored_at = now(), activated_at = now();
INSERT INTO meta.active_version (lock, version) VALUES (true, :'ver')
ON CONFLICT (lock) DO UPDATE SET version = EXCLUDED.version, switched_at = now();
COMMIT;
SELECT version, embedding_model, ddl_version, restored_at, activated_at FROM meta.seeds ORDER BY version;
SELECT version, switched_at FROM meta.active_version;
SQL
docker cp "$STAGE/register.sql" stack-db:/tmp/p9-register.sql >/dev/null
pg -d "$TDB" -v ver="$V" -v emb="$EMB" -v ddlv="$DDLV" -f /tmp/p9-register.sql

# ---------------------------------------------------------------- 5. gate + the served line
DB="$TDB" bash "$HERE/run_sql.sh" p6_verify.sql "$V"
PREV="$(t1 "SELECT string_agg(nspname, ', ' ORDER BY nspname) FROM pg_namespace WHERE nspname ~ '^v[0-9]{4}_[0-9]{2}$' AND nspname <> '$V'")"
t1 "SELECT 'served: db=' || current_database() || ' active_version=' || a.version || ' ddl_version=' || s.ddl_version || ' embedding_model=' || s.embedding_model || ' switched_at=' || a.switched_at FROM meta.active_version a JOIN meta.seeds s ON s.version = a.version"
echo "[p9] kept alongside: ${PREV:-none}${PREV:+  (rollback = UPDATE meta.active_version SET version = '<previous>', switched_at = now(); the provider follows the pointer)}"
echo "[p9] the serving image must speak ddl_version $DDLV (src/db/postgres/meta.ts EXPECTED_DDL_VERSION) — rebuild + restart fusion-schema-mcp if it does not"
