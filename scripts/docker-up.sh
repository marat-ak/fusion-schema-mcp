#!/usr/bin/env bash
# Build the image and run via compose in the CloudBeaver WSL Docker host, then health-check.
set -euo pipefail
cd /mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp

echo "=== docker compose build ==="
docker compose build

echo "=== docker compose up -d ==="
docker compose up -d

echo "=== wait for health ==="
ok=0
for i in $(seq 1 30); do
  if curl -sf http://127.0.0.1:8979/health > /tmp/mcp-docker-health.json 2>/dev/null; then
    ok=1; break
  fi
  sleep 2
done

echo "--- container ---"
docker ps --filter name=fusion-schema-mcp --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'
echo "--- /health ---"
cat /tmp/mcp-docker-health.json; echo
if [ "$ok" != "1" ]; then
  echo "HEALTH FAILED"; docker logs --tail 40 fusion-schema-mcp; exit 1
fi
echo DOCKER_UP_OK
