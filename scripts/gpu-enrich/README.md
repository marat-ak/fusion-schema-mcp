# GPU round-1 enrichment — VIEWS (waves) + otbi + bip (contract v3.1)

Enriches ~98k units with the maximal v3.1 contract using Qwen3-Coder-30B-A3B (FP8) on a single
48GB GPU (L40S class). **Phase order (client enforces barriers): views wave 0→7 FIRST** — each
generated view description immediately becomes an in-memory overlay CARD for later waves and for
otbi/bip (the box has no DB; the overlay closes the dependency loop) — **then otbi, then bip.**
Views already enriched by the (paused) subscription run are skipped at export (semantics_json set).
Resume-safe end to end (overlay is rebuilt from enrich_output.jsonl on restart).

## 0. Prereqs
- v2 pipeline done (`sqls.sqlite` + `schema.sqlite` in `/opt/fusion-catalog-v2/`, round-0 extracted).
- GPU box: Ubuntu + CUDA container, ports open for SSH; ~60GB disk free (model 31GB + data).

## 1. Export (local WSL) — builds the self-contained input (SQL + facts + cards)
```bash
# stage export_units.mjs to /opt/fusion-catalog-v2/ (base64 pattern), then:
docker run --rm -v /opt/fusion-catalog-v2:/app/v2 --entrypoint node \
  gnimsys/fusion-schema-mcp:latest /app/v2/export_units.mjs
gzip -k /opt/fusion-catalog-v2/enrich_input.jsonl        # ~80-120MB gz
```
Also flags `excluded_reason='dynamic_lexical'` (step-5 prelude) and drops artifact aliases
(XMLTABLE/DUAL/SAWITHn) from facts.

## 2. Ship + serve (GPU box)
```bash
scp enrich_input.jsonl.gz setup.sh enrich_client.py <box>:~/work/
ssh <box> 'cd work && gunzip -k enrich_input.jsonl.gz && bash setup.sh'
# wait for "Uvicorn running" in vllm.log; smoke: curl -s localhost:8000/v1/models
```

## 3. Smoke then full run (GPU box, tmux/nohup)
```bash
NGPU=4 python3 enrich_client.py --limit 20     # smoke; inspect enrich_output.jsonl
NGPU=4 python3 enrich_client.py                # full run (conc auto = 96×NGPU)
# resume after any interruption: just re-run (skips done ids; overlay rebuilt from output)
```
Multi-GPU: `setup.sh` starts one vLLM per GPU (ports 8000..8003 on a 4×L40S box); the client
round-robins with ONE shared overlay, so wave barriers stay globally correct.
Expected: 4×L40S FP8 → ~12-20 units/s aggregate → **~2-3 h, ~$4-6 total** (vast 4×L40S $1.89/hr).
Single L40S: ~5-9 h, ~$6-10.

## 4. Import + gates (local WSL)
```bash
scp <box>:~/work/enrich_output.jsonl /tmp/ && mv /tmp/enrich_output.jsonl /opt/fusion-catalog-v2/
docker run --rm -v /opt/fusion-catalog-v2:/app/v2 --entrypoint node \
  gnimsys/fusion-schema-mcp:latest /app/v2/import_validate.mjs
```
Gates: schema keys, description ≥3 sentences, intents ≥3, **predicateSeq refs must exist**,
table-name sanity. Output: `semantics_json` + `description_v2` + `needs_review` on `sql_units`;
`convergence_missing.json` = round-2 input (model-spotted objects sqlglot missed → card them →
re-enrich affected units — same loop as the view pass).

## 5. Then
- Convergence round-2 for flagged units; destroy the GPU box (hourly billing).
- Old paid v1 fields (`description`, `intents`, `mechanics`) remain untouched — carry-vs-redo
  decision happens at serving-flip time with A/B data in hand.

## Notes
- Model fallback: setup.sh drops to AWQ automatically if the FP8 repo is unavailable.
- Never send bip rows through any entity decode (Irish-payroll REPLACE literals).
- Customer-side bip enrichment later = same client + their provider; input pack build is identical.
