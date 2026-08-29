#!/bin/bash
# v2 pipeline orchestrator: tsc -> compile-v2 (clean schema) -> build-sqls-db -> sqlglot round-0.
# All output to stdout (captured by the caller) and mirrored to /opt/fusion-catalog-v2/build.log.
set -e
exec > >(tee /opt/fusion-catalog-v2/build.log) 2>&1

SRC=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp
IMG=gnimsys/fusion-schema-mcp:latest
V2=/opt/fusion-catalog-v2

echo "=== [1/4] tsc (typecheck + emit with decode hooks) ==="
rm -rf /opt/patchout && mkdir -p /opt/patchout
docker run --rm \
  -v "$SRC/src":/app/src \
  -v "$SRC/tsconfig.json":/app/tsconfig.json \
  -v /opt/patchout:/patchout \
  --entrypoint sh "$IMG" -c "cd /app && node_modules/.bin/tsc -p tsconfig.json --outDir /patchout && echo TSC_OK"

echo "=== [2/4] compile-v2: CSVs -> clean schema.sqlite ==="
if [ -f "$V2/schema.sqlite" ]; then
  echo "schema.sqlite already built — skipping compile"
else
docker run --rm \
  -v "$SRC/data":/mnt/data:ro \
  -v /opt/patchout:/app/patch \
  -v "$V2":/app/v2 \
  -e DATA_DIR=/mnt/data \
  -e SCHEMA_DB=/app/v2/schema.sqlite \
  -e REPORTS_DB=/app/v2/reports-skel.sqlite \
  -e ENRICH_DB=/nonexistent/enrich.sqlite \
  --entrypoint node "$IMG" /app/patch/compile.js
fi

echo "=== [3/4] build-sqls-db: sql_units from schema-v2 views + old otbi/bip ==="
echo "snapshotting old reports.sqlite (isolation from v1)..."
cp /opt/fusion-catalog-test/reports.sqlite "$V2/_old_reports_snapshot.sqlite"
docker run --rm \
  -v "$V2":/app/v2 \
  --entrypoint node "$IMG" /app/v2/build-sqls-db.mjs
rm -f "$V2/_old_reports_snapshot.sqlite"

echo "=== [4/4] sqlglot round-0 extraction (multiprocess, resumable) ==="
docker run --rm \
  -v "$V2":/data \
  python:3.12-slim sh -c "pip install -q sqlglot >/dev/null 2>&1; python /data/sqlglot_extract.py"

echo "=== V2 PIPELINE DONE ==="
ls -la "$V2"
