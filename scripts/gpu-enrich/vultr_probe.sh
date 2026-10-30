#!/bin/bash
# READ-ONLY probe of the Vultr prod server (find the deploy key, verify SSH + docker + disk + what's deployed).
K=/mnt/e/Marat/Vultr/deploy_user.key   # prod deploy key lives on the Windows host (E:/Marat/Vultr)
[ -f "$K" ] || { echo "deploy key NOT found: $K"; exit 1; }
echo "using key: $K"
ssh -o StrictHostKeyChecking=accept-new -o ConnectTimeout=20 -i "$K" deploy@136.244.90.237 'echo "== CONNECTED =="; whoami; hostname; uname -sr; echo "-- docker --"; docker --version; echo "running containers:"; docker ps --format "  {{.Names}} ({{.Status}})"; echo "-- disk --"; df -h / /srv 2>/dev/null | tail -3; echo "-- mem (GB) --"; free -g | head -2; echo "-- stack dir --"; ls ~/stack 2>/dev/null | head; echo "-- /srv --"; ls -la /srv 2>/dev/null'
