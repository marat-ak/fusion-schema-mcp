#!/bin/bash
# Periodic backup of the live enrichment outputs -> Windows disk. Runs until DONE.flag or container gone.
BK=/mnt/c/Marat/OSaaS/ClaudeShared/oservices/fusion-schema-mcp/.gpu-backups/run-live
mkdir -p "$BK"
while true; do
  cp /root/enrich-run/enrich_output.*.jsonl "$BK/" 2>/dev/null
  cp /root/enrich-run/run.log "$BK/" 2>/dev/null
  echo "$(date -u +%FT%TZ) backed up $(cat /root/enrich-run/enrich_output.*.jsonl 2>/dev/null | wc -l) rows" >> "$BK/backup.log"
  [ -f /root/enrich-run/DONE.flag ] && { cp /root/enrich-run/DONE.flag "$BK/" 2>/dev/null; echo "DONE seen" >> "$BK/backup.log"; break; }
  docker ps --filter name=enrich --format '{{.Names}}' | grep -q enrich || { echo "container gone" >> "$BK/backup.log"; break; }
  sleep 900
done
