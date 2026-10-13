#!/usr/bin/env bash
# Data-access coverage THROUGH THE RESOLVER on one pod's loaded security layer (read-only; served database).
#
#   wsl -d CloudBeaver -u root -e bash -lc 'bash /mnt/c/.../scripts/pipeline/security_coverage_resolver.sh <pod host>'
#
# Runs security_coverage_resolver.mts in the build-stage image (dist/ = the product code) against the
# service's OWN catalog configuration (CATALOG_DB + DATABASE_URL read from the running fusion-schema-mcp
# container — never typed here). Writes data/security/coverage/resolver-<pod host>.csv (per-table verdicts)
# and prints the summary tables (markdown) for the report. The host is REQUIRED (no default instance).
set -euo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
INSTANCE="${1:-}"
[ -n "$INSTANCE" ] || { echo "usage: security_coverage_resolver.sh <pod host>   (REQUIRED, exactly as runSql reports \`instance\`)"; exit 2; }
IMAGE="${IMAGE:-schema-mcp-build:latest}"
NET="${NET:-oservices_default}"
SVC="${SVC:-fusion-schema-mcp}"
DATABASE_URL="$(docker inspect "$SVC" --format '{{range .Config.Env}}{{println .}}{{end}}' | sed -n 's/^DATABASE_URL=//p' | head -1)"
[ -n "$DATABASE_URL" ] || { echo "[secx-r] $SVC carries no DATABASE_URL — not a postgres-served catalog"; exit 3; }

STAGE=/tmp/pipeline-secx-r
rm -rf "$STAGE" && mkdir -p "$STAGE"
cp "$REPO/scripts/pipeline"/*.mts "$STAGE/"
docker run --rm --network "$NET" -v "$STAGE:/app/scripts/pipeline" \
  -e DATABASE_URL="$DATABASE_URL" -e CATALOG_DB=postgres -e INSTANCE="$INSTANCE" -e OUT=/app/scripts/pipeline/out.csv \
  "$IMAGE" npx tsx /app/scripts/pipeline/security_coverage_resolver.mts
mkdir -p "$REPO/data/security/coverage"
cp "$STAGE/out.csv" "$REPO/data/security/coverage/resolver-$INSTANCE.csv"
echo "[secx-r] per-table verdicts: data/security/coverage/resolver-$INSTANCE.csv"
