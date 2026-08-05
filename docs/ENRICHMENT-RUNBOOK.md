# Corpus enrichment v2 — operational runbook

How to (re-)enrich the SQL corpus with `{description, intents[], mechanics}`, at what cost, with
which knobs, and every gotcha we hit. Read this before touching the pipeline again.

## What v2 produces (per corpus row)

Each `report_queries` row is analyzed ONCE and gets three artifacts:

- **description** — 1-2 business sentences (what data it returns). Embedded (retrieval).
- **intents[]** — 3-6 natural-language questions the SQL answers, the phrasings an agent actually
  searches with. Each is embedded as a SEPARATE row in `report_queries_vec_multi` (multi-vector).
- **mechanics** — a reusable engineering playbook (join bridges `A.col->B.col`, filter idioms,
  dedup/aggregation, params, security). NOT embedded — returned to the agent so it learns from a
  1-2 KB digest instead of re-reading an 80-175 KB SQL. Large `cleanSql` (> `CLEAN_SQL_INLINE_CAP`,
  default 6000) is omitted from `findSimilarQueries` output; the agent pulls it via `getReportQuery`.

Storage: `report_queries.{intents,mechanics}` columns + `report_queries_vec_multi` (vec0, one row
per intent phrasing, `+qrowid` aux). All in `reports.sqlite` under the MCP's `/app/data`.

## Two ways to run the model — pick by economics

| Path | Provider | When | Premium models? |
|---|---|---|---|
| **agent** (`ENRICH_PROVIDER=agent`) | Claude **subscription** via `fusion-agent /api/internal/llm` (Agent SDK `query()`) | small/interactive, no cash | YES — this is the ONLY way subscription reaches Opus/Sonnet |
| **API batch** (Message Batches) | Anthropic **API key**, 50% discount, async | BULK (the whole corpus) | YES, direct |
| gemini (`ENRICH_PROVIDER=gemini`) | Gemini API key, native batch | cheapest, lower mechanics quality | n/a |

**HARD FACT (verified):** a subscription OAuth token (`sk-ant-oat*`) is **429'd on the RAW Messages
API for premium models** — via `fetch` AND `@anthropic-ai/sdk`, `apiKey` AND `authToken`, with/without
the oauth beta header. Haiku passes; Opus/Sonnet do not. Only the **Agent SDK `query()`** path
(which spawns the official CLI) reaches them on a subscription. Raw API needs a real `sk-ant-api…`
key. This is a channel policy, not a quota — the 5h window can be at 0% and premium still 429s.

**Economics:** the $200/mo Max subscription ≈ its API-$-equivalent for bulk — the windows are
calibrated so "what you pay ≈ what you get" for heavy models. So: **subscription for interactive,
API key for bulk.** A full-corpus Opus run ≈ $200-260 at API rates, ~half that on Batch.

## Recommended procedure (bulk, all-Opus, from scratch)

Prereqs: `ENRICH_API_KEY` or `ANTHROPIC_API_KEY = sk-ant-api…` in `fusion-schema-mcp/.env`, with
enough prepaid credits (dryRun tells you how much). `ENRICH_PROVIDER=agent` in compose is fine —
the BATCH endpoints use the API key directly regardless of provider.

1. **Estimate first (no spend):**
   `POST /ingest/batch/submit?sources=bip-report,view&dryRun=1` → `{wouldSubmit, estUsd}`.
   Also `?redo=1&dryRun=1` for just the degraded rows.
2. **Micro-test (~$0.25):** `?redo=1&limit=2` → wait for it to end → QA the mechanics on the two
   giants. Proves submit→poll→ingest→quality→usage end-to-end before the big spend.
3. **Submit in chunks** (earlier partial results, easy resubmit): loop
   `POST /ingest/batch/submit?sources=bip-report,view&limit=1000` — the **in-flight guard** excludes
   rows already in an unfinished job, so chunks never overlap. `?redo=1` submits ONLY degraded rows
   (empty mechanics on >3k SQL); a plain submit takes `mechanics IS NULL` (NOT the placeholder rows).
4. **Poll = automatic.** The scheduler polls running jobs every ~minute and ingests finished ones.
   Manual: `POST /ingest/batch/poll`. Status: `GET /ingest/batch/status`.
5. **Watch cost:** `GET /ingest/reenrich/cost?sources=bip-report,view` — per-SQL $, projections.
   Model rows tagged `<model>@batch` price at 50%.
6. **Credit runs out mid-run:** failed requests are per-request `invalid_request_error` (credit too
   low); those rows STAY pending (never written) — top up credits and resubmit, nothing lost.

Queue / progress at any time: `GET /ingest/reenrich/status?sources=bip-report,view`
→ `{total, done, pending}` (`done` = mechanics NOT NULL).

## Subscription path (agent provider) — guards

If running through the subscription instead of an API key, the usage guards keep you from locking
yourself out of interactive Claude:

- `GET fusion-agent /api/internal/limits` → `{fiveHour, sevenDay}` utilization % (needs the
  interactive login credential mounted ro — `CLAUDE_CREDENTIALS_FILE`; the container's inference
  token lacks the `user:profile` scope).
- `POST /ingest/reenrich` refuses at `ENRICH_USAGE_STOP` (5h, default 90%) or `ENRICH_WEEKLY_STOP`
  (7d, default 70%), returning `{skipped:"usage-guard"}`. A driver loop backs off and resumes when
  the window reopens.
- Driver durability: run the drain loop as a **background subagent**, NOT a host `wsl.exe bash -c
  '… &'` — those die when wsl.exe returns.

## Retrieval quality (two-stage)

`findSimilarQueries` = KNN over the multi-vector index (bge-small, local CPU) → **cross-encoder
rerank** of the top-50 via the TEI sidecar (`bge-reranker-v2-m3` on GPU) → domain logic → top-N.
Fail-open: `RERANK_URL` unset / timeout (1.5s) / error → pure KNN order. **Runtime stays fully
local** — the only external call at agent-runtime is the customer's own main-model API. A CPU-only
VPS runs the CPU TEI image (`bge-reranker-base`) or skips reranking (unset `RERANK_URL`).

## GOTCHAS (each cost real time — do not rediscover)

1. **mechanics can be a JSON ARRAY, not a string.** ~Half the corpus came back with `mechanics` as
   an array of bullet lines. The parser accepted only strings → discarded 10365 rows to the
   `(no notable mechanics)` placeholder. Fixed by `coerceMechanics()` (join array → bulleted
   string). If you change the prompt, KEEP the coercion.
2. **Prompt-batching (N SQLs per call) DEGRADES mechanics** — 39% empty on non-trivial SQL, model
   attention splits. Batch jobs carry **SOLO** requests only. Do not "optimize" by grouping.
3. **Recovery is FREE.** A batch job's results stay downloadable ~29 days. `POST
   /ingest/batch/reingest` (or `reingestJob(id)` per job to avoid HTTP timeout) re-parses stored
   results with the current code — no model calls. This is how #1 was recovered for $0.
   Re-ingest is idempotent (`clearBatchUsage` before re-recording).
4. **`curl`/`wget` are NOT in the containers.** Drive endpoints with `docker exec … node -e
   'fetch(...)'`, token from `process.env.INGEST_TOKEN`.
5. **`custom_id` ≤ 64 chars** → we map `sha16(row_id)` in `batch_items`; results merge by that.
6. **sqlite-vec KNN**: the `MATCH` must live in a bare subquery with `ORDER BY distance LIMIT k`
   (NO `k=?`, no JOIN/WHERE on the vec0 aux column pushed in) or it throws "illegal WHERE
   constraint on a vec0 auxiliary column".
7. **Output was NOT truncated** at our 8192 `max_tokens` (max observed 5305) — if mechanics is
   missing it's format (#1), not length.

## Verify anytime

```
docker exec -w /app fusion-schema-mcp node -e '
  const D=require("better-sqlite3"); const d=new D("/app/data/reports.sqlite",{readonly:true});
  console.log(d.prepare("SELECT CASE WHEN mechanics IS NULL THEN 0 WHEN mechanics=\"(no notable mechanics)\" THEN 1 ELSE 2 END s, COUNT(*) n FROM report_queries WHERE source IN (\"bip-report\",\"view\") GROUP BY s").all());
'
```
s=0 NULL (never enriched), s=1 placeholder (empty mechanics — genuinely trivial OR a parser miss),
s=2 real. Investigate any BIG (>3k chars) row at s=1 — those should be real.

## Related admin data (not enrichment, same MCP)

Flexfield + custom-object registries feed `getFlexfields` / `getCustomObjects`, loaded via the admin
page → `/ingest/{flexfields,adf-extensions,config-report}`. Separate tables, exact lookup (no
vectors). See the admin page and `corpus/flexStore.ts`.
