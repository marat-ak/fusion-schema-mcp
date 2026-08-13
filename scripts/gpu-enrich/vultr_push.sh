#!/bin/bash
# Pack the enrichment run dir (current DBs w/ persisted views + outputs + scripts) -> tar.gz -> Vultr -> unpack.
# Runs in the CloudBeaver distro. Doesn't touch the live Vultr stack (lands in deploy's ~/enrich-run).
set -e
K=/root/.ssh/fusion_deploy
R=/root/enrich-run
A=/root/enrich-run.tar.gz
HOST=deploy@136.244.90.237
SRC_ENV=/mnt/c/Marat/OSaaS/ClaudeShared/CloudBeaver/fusion-schema-mcp/.env

# minimal enrich .env (HF creds only) travels with the archive; HF_ENDPOINT_URL is updated on Vultr for the new endpoint
grep -E '^(HF_ENDPOINT_URL|HF_TOKEN|HF_DP|MAX_NUM_SEQS)=' "$SRC_ENV" > "$R/.env" || true

echo "== packing $R =="
rm -f "$A"
tar czf "$A" -C "$R" --exclude=__pycache__ --exclude='*.bundle*' --exclude='test*.jsonl' .
ls -lh "$A"

echo "== scp -> $HOST:~/enrich-run.tar.gz =="
scp -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$K" "$A" "$HOST":~/enrich-run.tar.gz

echo "== unpack on Vultr =="
ssh -i "$K" "$HOST" 'rm -rf ~/enrich-run && mkdir -p ~/enrich-run && tar xzf ~/enrich-run.tar.gz -C ~/enrich-run && rm -f ~/enrich-run.tar.gz && echo "== unpacked ~/enrich-run ==" && ls -lh ~/enrich-run && echo "total:" && du -sh ~/enrich-run && echo "docker + python:" && docker --version && python3 --version'

rm -f "$A"
echo "PUSH DONE — run dir is on Vultr at ~/enrich-run"
