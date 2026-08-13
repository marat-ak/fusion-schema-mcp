/**
 * Anthropic Message Batches path for v2 re-enrichment (real API key, 50% discount).
 *
 * Flow: submit(rows, model) puts every row as one SOLO request (batching-in-prompt proved to
 * degrade mechanics — 39% empty; solo Opus is excellent) into ONE Batches API job (cap 100k
 * requests / 256MB — our whole corpus fits). custom_id must be <=64 chars, our row ids aren't,
 * so each job records a custom_id(sha16) -> row_id map in batch_items. The ingest scheduler
 * polls running jobs; when a job ends we stream its JSONL results, parse each message through
 * the SAME parseEnrichReply as the sync path, rewrite rows + vectors, and record EXACT per-row
 * usage (the batch result carries usage per request) under model "<model>@batch" (half-rate
 * pricing in usageStats). Failed/expired/billing-errored requests simply stay in the resumable
 * queue (mechanics IS NULL) — resubmit later loses nothing.
 */
import crypto from "node:crypto";
import Database from "better-sqlite3";
import fs from "node:fs";
import { reportsDbPath } from "../dbPaths.js";
import { buildEnrichPrompt, parseEnrichReply } from "./enrichPrompt.js";
import type { SqlSource } from "./sources.js";
import { embedBulk as embed } from "./embed.js";
import { updateEnrichment, embedTexts, recordUsage, clearBatchUsage } from "./ingestStore.js";

const API = "https://api.anthropic.com/v1/messages/batches";

function apiKey(): string {
  // The batch path is Anthropic-only, so ANTHROPIC_API_KEY is an equally valid home for the key.
  const k = (process.env.ENRICH_API_KEY ?? "").trim()
    || (process.env.ANTHROPIC_API_KEY ?? "").trim()
    || dotEnvKey("ENRICH_API_KEY") || dotEnvKey("ANTHROPIC_API_KEY");
  if (!k.startsWith("sk-ant-api")) throw new Error("Batch path needs a real API key (sk-ant-api…) in ENRICH_API_KEY or ANTHROPIC_API_KEY");
  return k;
}
function dotEnvKey(name: string): string {
  try {
    const m = fs.readFileSync(new URL("../../.env", import.meta.url), "utf8").match(new RegExp(`^${name}=(.+)$`, "m"));
    return (m?.[1] ?? "").trim();
  } catch { return ""; }
}
const HDRS = () => ({ "x-api-key": apiKey(), "anthropic-version": "2023-06-01", "content-type": "application/json" });

function asSource(sql: string, title: string): SqlSource {
  return {
    id: "batch", source: "catalog", title: title || "(untitled)", originalSql: sql,
    sourceHash: crypto.createHash("sha256").update(sql).digest("hex"), raw: {},
  };
}

/** Solo request params — same prompt family as the sync agent path, mechanics-required tail. */
function soloParams(sql: string, title: string, model: string) {
  const p = buildEnrichPrompt(asSource(sql, title));
  return {
    model,
    max_tokens: 8192,
    system: [{ type: "text", text: p.system, cache_control: { type: "ephemeral" } }], // best-effort cache
    messages: [{
      role: "user",
      content: p.user + "\n\nReturn ONLY the JSON object, no prose. The mechanics field is REQUIRED " +
        "and must be substantive: real join bridges (A.col -> B.col), filter idioms, aggregation " +
        "techniques and parameter handling from THIS SQL — empty mechanics on a non-trivial query is a failure.",
    }],
  };
}

// ---- job/item persistence (reports.sqlite) ----
let _db: Database.Database | null = null;
function db(): Database.Database {
  if (_db) return _db;
  const d = new Database(reportsDbPath());
  d.pragma("busy_timeout = 10000");
  d.exec(`
    CREATE TABLE IF NOT EXISTS batch_jobs (
      batch_id TEXT PRIMARY KEY, model TEXT, n INTEGER, submitted_at TEXT,
      status TEXT, completed_at TEXT, note TEXT
    );
    CREATE TABLE IF NOT EXISTS batch_items (
      batch_id TEXT, custom_id TEXT, row_id TEXT,
      PRIMARY KEY (batch_id, custom_id)
    );
  `);
  _db = d;
  return d;
}

const cid = (rowId: string) => crypto.createHash("sha256").update(rowId).digest("hex").slice(0, 32);

export async function submitBatch(rows: { id: string; title: string; sql: string }[], model: string): Promise<{ batchId: string; count: number }> {
  if (!rows.length) throw new Error("nothing to submit");
  const requests = rows.map((r) => ({ custom_id: cid(r.id), params: soloParams(r.sql, r.title, model) }));
  const res = await fetch(API, { method: "POST", headers: HDRS(), body: JSON.stringify({ requests }) });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`batch submit HTTP ${res.status}: ${JSON.stringify(j).slice(0, 300)}`);
  const d = db();
  const tx = d.transaction(() => {
    d.prepare("INSERT INTO batch_jobs (batch_id, model, n, submitted_at, status) VALUES (?,?,?,?,?)")
      .run(j.id, model, rows.length, new Date().toISOString(), j.processing_status ?? "in_progress");
    const ins = d.prepare("INSERT OR REPLACE INTO batch_items (batch_id, custom_id, row_id) VALUES (?,?,?)");
    for (const r of rows) ins.run(j.id, cid(r.id), r.id);
  });
  tx();
  return { batchId: j.id, count: rows.length };
}

export function runningJobs(): { batch_id: string; model: string; n: number; status: string; submitted_at: string }[] {
  return db().prepare("SELECT batch_id, model, n, status, submitted_at FROM batch_jobs WHERE status NOT IN ('done','failed','canceled')").all() as any[];
}
export function finishedJobs(): { batch_id: string }[] {
  return db().prepare("SELECT batch_id FROM batch_jobs WHERE status = 'done'").all() as any[];
}

/** Re-fetch a FINISHED job's results and re-run ingest with the current parser (results_url stays
 *  valid ~29 days). Free — no model calls. Recovers rows a past parser bug wrote as placeholders. */
export async function reingestJob(batchId: string): Promise<Record<string, unknown>> {
  db().prepare("UPDATE batch_jobs SET status = 'ended' WHERE batch_id = ?").run(batchId); // let pollJob re-ingest
  return pollJob(batchId);
}

export function allJobs(): unknown[] {
  return db().prepare("SELECT * FROM batch_jobs ORDER BY submitted_at DESC LIMIT 20").all();
}

/** Poll one job; when ended, ingest its results. Returns a status summary. */
export async function pollJob(batchId: string): Promise<Record<string, unknown>> {
  const d = db();
  const res = await fetch(`${API}/${batchId}`, { headers: HDRS() });
  const j: any = await res.json();
  if (!res.ok) throw new Error(`batch poll HTTP ${res.status}: ${JSON.stringify(j).slice(0, 200)}`);
  const status = j.processing_status;
  d.prepare("UPDATE batch_jobs SET status = ? WHERE batch_id = ?").run(status, batchId);
  if (status !== "ended") return { batchId, status, counts: j.request_counts };

  // ended -> stream results and ingest
  const rr = await fetch(j.results_url, { headers: HDRS() });
  if (!rr.ok) throw new Error(`results fetch HTTP ${rr.status}`);
  const text = await rr.text();
  const map = new Map<string, string>(
    (d.prepare("SELECT custom_id, row_id FROM batch_items WHERE batch_id = ?").all(batchId) as any[]).map((x) => [x.custom_id, x.row_id]),
  );
  const model = (d.prepare("SELECT model FROM batch_jobs WHERE batch_id = ?").get(batchId) as any)?.model ?? "claude-opus-5";
  clearBatchUsage(batchId); // replaying results after a mid-ingest crash must not double-count usage
  let ok = 0, failed = 0;
  const nowIso = new Date().toISOString();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { failed++; continue; }
    const rowId = map.get(entry.custom_id);
    if (!rowId) { failed++; continue; }
    const r = entry.result;
    if (r?.type !== "succeeded") { failed++; continue; }
    try {
      const msg = r.message;
      const body = (msg.content ?? []).map((c: any) => c.text ?? "").join("");
      const e = parseEnrichReply(body, asSource("", rowId));
      const vecs = await embed(embedTexts(e.description, e.tablesUsed ?? [], e.intents ?? []));
      updateEnrichment(rowId, { description: e.description, intents: e.intents ?? [], mechanics: e.mechanics ?? "(no notable mechanics)" }, vecs);
      const u = msg.usage ?? {};
      recordUsage({
        ts: nowIso, model: `${model}@batch`, source: "batch", nItems: 1, batchId,
        inputTokens: Number(u.input_tokens ?? 0), outputTokens: Number(u.output_tokens ?? 0),
        cacheReadTokens: Number(u.cache_read_input_tokens ?? 0), cacheCreationTokens: Number(u.cache_creation_input_tokens ?? 0),
      });
      ok++;
    } catch { failed++; }
  }
  d.prepare("UPDATE batch_jobs SET status = 'done', completed_at = ?, note = ? WHERE batch_id = ?")
    .run(new Date().toISOString(), `ok=${ok} failed=${failed}`, batchId);
  return { batchId, status: "done", ingested: ok, failed };
}
