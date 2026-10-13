#!/usr/bin/env bash
# The per-instance data-access security layer — load ONE pod's export into the SERVED catalog database
# (customer.sec_instance_* — not a release: refreshed independently, an admin action).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/sec_layer_load.sh <instance> <stamp> <dir> <grantee>'
#   e.g. sec_layer_load.sh fa-evbp-test-saasfaprod1.fa.ocs.oraclecloud.com 2026-10-03 \
#          /mnt/c/.../data/security/instances/fa-evbp-test-saasfaprod1.fa.ocs.oraclecloud.com/2026-10-03 FUSION_APPS_OBIA_BIEE_APPID
#
# All four arguments are REQUIRED (no default instance / stamp / grantee). <dir> holds the runSql
# replies of the documented export SQL (README "The customer security layer"), one JSON file per page:
# objects-<n>.json, privileges-<n>.json, u-<n>.json, duties-<n>.json. The loader (dist/securityLayer.js,
# the product's own code) runs in the service image against the service's OWN catalog configuration —
# CATALOG_DB + DATABASE_URL are read from the running fusion-schema-mcp container, never typed here
# and never a new variable — and applies the library migrations first (the layer tables are
# migration v2). Staged on the distro fs (the 9p mount does not bind-mount reliably).
set -euo pipefail

INSTANCE="${1:-}"; STAMP="${2:-}"; SRC="${3:-}"; GRANTEE="${4:-}"
[ -n "$INSTANCE" ] && [ -n "$STAMP" ] && [ -n "$SRC" ] && [ -n "$GRANTEE" ] || { echo "usage: sec_layer_load.sh <instance host> <stamp> <dir> <grantee>   (all four required)"; exit 2; }
[ -d "$SRC" ] || { echo "[seclayer] $SRC is not a directory"; exit 2; }
IMAGE="${IMAGE:-gnimsys/fusion-schema-mcp:latest}"
NET="${NET:-oservices_default}"
SVC="${SVC:-fusion-schema-mcp}"

CATALOG_DB="$(docker inspect "$SVC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^CATALOG_DB=//p' | head -1)"
DATABASE_URL="$(docker inspect "$SVC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p' | head -1)"
[ "$CATALOG_DB" = "postgres" ] && [ -n "$DATABASE_URL" ] || { echo "[seclayer] $SVC is not configured with CATALOG_DB=postgres + DATABASE_URL — nothing to load into"; exit 3; }

STAGE=/tmp/pipeline-seclayer
rm -rf "$STAGE" && mkdir -p "$STAGE/in"
cp "$SRC"/*.json "$STAGE/in/"
echo "[seclayer] $INSTANCE stamp $STAMP: $(ls "$STAGE/in" | tr '\n' ' ')"
docker run --rm --network "$NET" --entrypoint node \
  -v "$STAGE/in:/in:ro" \
  -e CATALOG_DB="$CATALOG_DB" -e DATABASE_URL="$DATABASE_URL" \
  "$IMAGE" dist/securityLayer.js --instance "$INSTANCE" --stamp "$STAMP" --dir /in --grantee "$GRANTEE"
echo "[seclayer] loaded; the serving container reads the layer on its next request (no restart needed)"
