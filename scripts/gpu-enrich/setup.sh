#!/bin/bash
# vLLM launch. DP=1 -> ONE endpoint via --data-parallel-size N (load-balanced replicas, recommended);
# DP=0 -> N manual instances on PORT..PORT+N-1 (client round-robins). Idempotent.
set -e
MODEL=${MODEL:-Qwen/Qwen3-Coder-30B-A3B-Instruct-FP8}
PORT=${PORT:-8000}
NGPU=${NGPU:-$(nvidia-smi -L | wc -l)}
MAXSEQ=${MAX_NUM_SEQS:-256}
MAXLEN=${MAX_MODEL_LEN:-49152}
UTIL=${GPU_UTIL:-0.92}
DP=${DP:-1}

echo "=== [1/3] deps (no pip cache — small disk) ==="
python3 -c "import vllm" 2>/dev/null && echo "vllm present" || pip install -q -U --no-cache-dir vllm
python3 -c "import aiohttp" 2>/dev/null || pip install -q --no-cache-dir aiohttp

echo "=== [2/3] model (FP8; resumable; disk-safe) ==="
# keep HF's staging cache on the SAME dir as the download so it isn't duplicated elsewhere, then drop it
export HF_HUB_ENABLE_HF_TRANSFER=1
if [ ! -f ./model/config.json ]; then
  hf download "$MODEL" --local-dir ./model 2>/dev/null || huggingface-cli download "$MODEL" --local-dir ./model
  rm -rf ~/.cache/huggingface/hub 2>/dev/null   # ./model is a full copy; reclaim the staging cache (~30 GB) on the 100 GB disk
else echo "model present"; fi
df -h . | tail -1   # show remaining disk after the model lands

echo "=== [3/3] serve (DP=$DP, NGPU=$NGPU, max-model-len=$MAXLEN, max-num-seqs=$MAXSEQ) ==="
if [ "$DP" = 1 ]; then
  if curl -sf "localhost:$PORT/v1/models" >/dev/null 2>&1; then echo "already serving on :$PORT"; exit 0; fi
  nohup vllm serve ./model --served-model-name qwen3-coder --port "$PORT" \
    --data-parallel-size "$NGPU" --max-model-len "$MAXLEN" --max-num-seqs "$MAXSEQ" \
    --enable-prefix-caching --gpu-memory-utilization "$UTIL" > vllm.log 2>&1 &
  echo "  DP endpoint :$PORT ($NGPU replicas) PID $!"
else
  for i in $(seq 0 $((NGPU-1))); do
    if curl -sf "localhost:$((PORT+i))/v1/models" >/dev/null 2>&1; then echo "  gpu$i already serving"; continue; fi
    CUDA_VISIBLE_DEVICES=$i nohup vllm serve ./model --served-model-name qwen3-coder --port "$((PORT+i))" \
      --max-model-len "$MAXLEN" --max-num-seqs "$MAXSEQ" --enable-prefix-caching --gpu-memory-utilization "$UTIL" \
      > "vllm_$i.log" 2>&1 &
    echo "  gpu$i -> :$((PORT+i)) PID $!"
  done
fi
echo "ready when each vllm*.log shows 'Application startup complete'."
