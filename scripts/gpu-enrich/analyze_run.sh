#!/bin/bash
# READ-ONLY analysis: compare the v2 catalog vs the bundle DBs. No writes to any DB, no export, no enrich.
set -e
SRC=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/scripts/gpu-enrich
BUN=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/.gpu-backups/box-bundle
V2=/opt/fusion-catalog-v2
R=/root/enrich-run
mkdir -p "$R"

echo "############## V2 CATALOG  (/opt/fusion-catalog-v2, opened read-only) ##############"
python3 "$SRC/analyze_dbs.py" "$V2/sqls.sqlite" "$V2/schema.sqlite"

echo "############## BUNDLE  (decompressed to *.bundle only to inspect) ##############"
[ -f "$R/sqls.sqlite.bundle" ]   || { echo "(gunzip sqls)";   zcat "$BUN/sqls.sqlite.gz"   > "$R/sqls.sqlite.bundle"; }
[ -f "$R/schema.sqlite.bundle" ] || { echo "(gunzip schema)"; zcat "$BUN/schema.sqlite.gz" > "$R/schema.sqlite.bundle"; }
python3 "$SRC/analyze_dbs.py" "$R/sqls.sqlite.bundle" "$R/schema.sqlite.bundle"

echo "############## disk ##############"
df -h "$R" | tail -1
echo "ANALYSIS DONE (nothing enriched, nothing written to any catalog)"
