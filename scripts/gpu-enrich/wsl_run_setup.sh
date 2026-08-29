#!/bin/bash
# Unpack the bundle into ONE self-contained run folder (like scp+gunzip on a box), using the EDITED scripts.
# Then validate export wave 0 with NO endpoint. Idempotent.
set -e
SRC=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/scripts/gpu-enrich
BUN=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/.gpu-backups/box-bundle
R=/root/enrich-run
mkdir -p "$R"

# DBs = the BUNDLE (carry view_column_remarks). Prefer the already-decompressed *.bundle (fast mv), else gunzip.
if [ -f "$R/sqls.sqlite.bundle" ];   then mv -f "$R/sqls.sqlite.bundle"   "$R/sqls.sqlite";   else zcat "$BUN/sqls.sqlite.gz"   > "$R/sqls.sqlite";   fi
if [ -f "$R/schema.sqlite.bundle" ]; then mv -f "$R/schema.sqlite.bundle" "$R/schema.sqlite"; else zcat "$BUN/schema.sqlite.gz" > "$R/schema.sqlite"; fi

# Scripts the run needs (edited enrich_client.py + run_waves.sh come from SRC; fall back to bundle otherwise).
for f in enrich_client.py run_waves.sh export_wave.py persist_wave.py setup.sh curated_column_remarks.json status.sh sample.sh; do
  cp "$SRC/$f" "$R/" 2>/dev/null || cp "$BUN/$f" "$R/"
done
sed -i 's/\r$//' "$R"/*.sh
# drop stale run artifacts + any leftover wrong copies
rm -f "$R"/enrich_input*.jsonl "$R"/enrich_output*.jsonl "$R"/done.* "$R"/DONE.flag "$R"/_probe.jsonl "$R"/run.log 2>/dev/null || true

echo "=== run folder ($R) ==="
ls -lh "$R"

echo "=== validate export wave 0 (NO endpoint) ==="
cd "$R"
PHASE=view WAVE=0 OUT=_probe.jsonl python3 export_wave.py 2>&1 | tail -3
echo "probe lines: $(wc -l < _probe.jsonl 2>/dev/null || echo 0)"
echo "first row (400 chars):"; head -c 400 _probe.jsonl 2>/dev/null; echo
rm -f _probe.jsonl
echo "READY"
