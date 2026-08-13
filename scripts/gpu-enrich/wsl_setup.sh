#!/bin/bash
# Prepare a WSL-native run dir for orchestrating the enrichment against a REMOTE HF endpoint.
set -e
R=/home/marat/gpu-run
mkdir -p "$R"
BUN=/mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/.gpu-backups/box-bundle
SRC=/mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/scripts/gpu-enrich
[ -f "$R/sqls.sqlite" ]   || { echo "gunzip sqls...";   zcat "$BUN/sqls.sqlite.gz"   > "$R/sqls.sqlite"; }
[ -f "$R/schema.sqlite" ] || { echo "gunzip schema..."; zcat "$BUN/schema.sqlite.gz" > "$R/schema.sqlite"; }
cp "$BUN/curated_column_remarks.json" "$R/"
cp "$SRC/enrich_client.py" "$R/"                       # HF-aware version (edited this session)
for f in export_wave.py persist_wave.py; do
  if [ -f "$SRC/$f" ]; then cp "$SRC/$f" "$R/"; else cp "$BUN/$f" "$R/"; fi
done
echo "--- run dir ($R) ---"
ls -lh "$R"
echo "--- deps ---"
python3 -c "import aiohttp,sqlite3;print('aiohttp',aiohttp.__version__)" 2>/dev/null || {
  echo "installing aiohttp...";
  pip install --break-system-packages -q aiohttp 2>&1 | tail -3;
  python3 -c "import aiohttp;print('aiohttp now',aiohttp.__version__)";
}
echo "SETUP OK"
