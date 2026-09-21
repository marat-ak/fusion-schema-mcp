/**
 * P4b — embed every L3 statement (and the layout-pattern corpus) into work.embeddings.
 *
 * Runs INSIDE the fusion-schema-mcp build image, which carries the warmed
 * Xenova/bge-small-en-v1.5 cache in node_modules. It IMPORTS the repo's own
 * embedder and its own text builder — nothing here reimplements either:
 *
 *   embedBulk   src/corpus/embed.ts          the bulk worker channel
 *   embedTexts  src/corpus/ingestStore.ts    slot 0 = description + "\nTables: " + tables,
 *                                            slots 1..n = one per non-blank intent
 *
 * Two properties of slot 0, both deliberate:
 *
 *  1. A statement with NO description gets NO vector. `materialize()` — the product's own
 *     writer — drops those rows itself (`/\S/.test(r.description)`), and for good reason:
 *     embedding "" + a table list produces a vector that sits somewhere arbitrary in the
 *     space and matches unrelated questions. Those 2,733 rows ship with facts and no
 *     vectors until the enrich queue reaches them; being unfindable beats being wrong.
 *  2. `tables` comes from work.r_tables — the RECONCILED set (parse + model corrections),
 *     physical tables only — under the same shape import_serving.mjs gave `tablesUsed`:
 *     is_cte=0, parser artifacts dropped, de-duplicated, then JS `.sort()` (sorted in JS,
 *     not SQL, so the order cannot drift with the database collation).
 *
 * Layout patterns use loadLayoutPatterns()'s own text shape: `${name}. ${description}`
 * then one per intent.
 *
 * INCREMENTAL BY text_hash (2026-09-21; it was a full re-embed before). `text_hash` is
 * md5 of the EXACT text that produced a vector, so currency is decidable per slot: a
 * slot is re-embedded only when its text (or the model) differs from the stored row;
 * slots past an owner's new count (intents shrank) and owners that stopped being
 * embeddable (description gone) are DELETED; an untouched slot is left alone. On an
 * empty table this is the full build. Sharding is unchanged, so the comparison map is
 * loaded per shard.
 *
 * Run (one shard per process; shards are disjoint and order-independent). The mount
 * point MUST be /app/scripts/pipeline so the ../../dist imports resolve the same way
 * they do in the repo:
 *   docker run --rm --network oservices_default \
 *     -v <repo>/scripts/pipeline:/app/scripts/pipeline \
 *     -e DATABASE_URL=postgres://postgres:<pw>@stack-db:5432/fusion_dev \
 *     -e SHARD=0 -e SHARDS=8 \
 *     schema-mcp-build:latest npx tsx /app/scripts/pipeline/p4_embed.mts
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import postgres from "postgres";
import { embedBulk } from "../../dist/corpus/embed.js";
import { embedTexts } from "../../dist/corpus/ingestStore.js";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) throw new Error("DATABASE_URL is required — no default");
const SHARD = Number(process.env.SHARD ?? 0);
const SHARDS = Number(process.env.SHARDS ?? 1);
const MODEL = "Xenova/bge-small-en-v1.5";
const PATTERNS = process.env.LAYOUT_PATTERNS_FILE ?? "/app/dist/corpus/layoutPatterns/patterns.jsonl";
const EMBED_CHUNK = 256;
const WRITE_CHUNK = 500;

const md5 = (s: string) => crypto.createHash("md5").update(s, "utf8").digest("hex");
const vecLit = (v: Float32Array) => `[${Array.from(v).join(",")}]`;
const log = (m: string) => console.error(`[p4 shard ${SHARD}/${SHARDS}] ${m}`);

const sql = postgres(DATABASE_URL, { max: 2, connect_timeout: 10, idle_timeout: 20, onnotice: () => {} });
// the embed worker is unref()'d; keep the loop alive while inference runs
const keepAlive = setInterval(() => {}, 1 << 30);

type Row = { owner_kind: string; owner_id: string; slot: number; text_hash: string; model: string; embedding: string };

async function flush(rows: Row[]) {
  for (let i = 0; i < rows.length; i += WRITE_CHUNK) {
    const chunk = rows.slice(i, i + WRITE_CHUNK);
    await sql`INSERT INTO work.embeddings ${sql(chunk, "owner_kind", "owner_id", "slot", "text_hash", "model", "embedding")}
              ON CONFLICT (owner_kind, owner_id, slot) DO UPDATE
                SET text_hash = excluded.text_hash, model = excluded.model, embedding = excluded.embedding`;
  }
}

type Item = { slot: number; text: string };

/** Embed a batch of {ownerKind, ownerId, items} and write exactly those slots. */
async function embedOwners(owners: { kind: string; id: string; items: Item[] }[]): Promise<number> {
  const flat: string[] = [];
  const at: number[] = [];
  for (const o of owners) { at.push(flat.length); flat.push(...o.items.map((it) => it.text)); }
  const out: Row[] = [];
  const vecs: Float32Array[] = [];
  for (let i = 0; i < flat.length; i += EMBED_CHUNK) vecs.push(...(await embedBulk(flat.slice(i, i + EMBED_CHUNK))));
  owners.forEach((o, i) => {
    o.items.forEach((it, k) => {
      out.push({ owner_kind: o.kind, owner_id: o.id, slot: it.slot, text_hash: md5(it.text), model: MODEL, embedding: vecLit(vecs[at[i] + k]) });
    });
  });
  await flush(out);
  return out.length;
}

// ---------------------------------------------------------------- units (L3)
// Sharding is a pure function of the hash, so the shards are disjoint, stable
// and order-independent: mod of the first 28 bits (always non-negative).
// `tables_used` is the reconciled r_tables set under import_serving.mjs's own filter:
// is_cte=0 minus the parser artifacts that leak in on the giant truncated SAWITH SQLs
// (same ARTIFACT regex, extended there with TABLE\d+). Unsorted here on purpose — the
// JS `.sort()` below is the one that decides the order, exactly as the importer did.
const units = await sql<{ sql_hash: string; description: string; tables_used: string[] | null; intents: string[] | null }[]>`
  SELECT c.sql_hash,
         c.description,
         t.tables_used,
         CASE WHEN jsonb_typeof(c.intents) = 'array'
              THEN ARRAY(SELECT jsonb_array_elements_text(c.intents)) END AS intents
  FROM   work.clear_sql c
  LEFT   JOIN LATERAL (
           SELECT array_agg(DISTINCT r.table_name) AS tables_used
           FROM   work.r_tables r
           WHERE  r.sql_hash = c.sql_hash
             AND  NOT r.is_cte
             AND  r.table_name !~* '^(XMLTABLE|DUAL|SAWITH[0-9]+|TABLE[0-9]+)$'
         ) t ON TRUE
  WHERE  c.description IS NOT NULL
    AND  mod(('x' || substr(c.sql_hash, 1, 7))::bit(28)::int, ${SHARDS}) = ${SHARD}
  ORDER  BY c.sql_hash`;
// the product's own guard, restated on the same side of the wire it lives on in materialize()
const embeddable = units.filter((u) => /\S/.test(u.description));
log(`units in shard: ${embeddable.length} embeddable (${units.length - embeddable.length} dropped as blank description)`);

// what this shard already holds: owner -> slot -> text_hash (a vector from another model
// is never current, so it is left out of the map and therefore re-embedded)
const have = new Map<string, Map<number, string>>();
for (const r of await sql<{ owner_id: string; slot: number; text_hash: string; model: string }[]>`
  SELECT owner_id, slot, text_hash, model FROM work.embeddings
  WHERE  owner_kind = 'unit'
    AND  mod(('x' || substr(owner_id, 1, 7))::bit(28)::int, ${SHARDS}) = ${SHARD}`) {
  if (r.model !== MODEL) continue;
  let m = have.get(r.owner_id);
  if (!m) have.set(r.owner_id, (m = new Map()));
  m.set(r.slot, r.text_hash);
}
log(`existing in shard: ${have.size} owners`);

let done = 0, vectors = 0, unchanged = 0, changedOwners = 0;
const trim: { id: string; n: number }[] = [];   // owners whose slot count shrank: delete slot >= n
const BATCH = 200;
for (let i = 0; i < embeddable.length; i += BATCH) {
  const owners: { kind: string; id: string; items: Item[] }[] = [];
  for (const u of embeddable.slice(i, i + BATCH)) {
    // embedTexts() is the repo's own: description(+tables) first, then one per non-blank intent.
    const texts = embedTexts(u.description, [...(u.tables_used ?? [])].sort(), u.intents ?? []);
    const cur = have.get(u.sql_hash);
    const items = texts.map((text, slot) => ({ slot, text })).filter((it) => cur?.get(it.slot) !== md5(it.text));
    const stale = cur ? [...cur.keys()].some((k) => k >= texts.length) : false;
    if (stale) trim.push({ id: u.sql_hash, n: texts.length });
    if (items.length === 0 && !stale) { unchanged++; continue; }
    changedOwners++;
    if (items.length) owners.push({ kind: "unit", id: u.sql_hash, items });
  }
  if (owners.length) vectors += await embedOwners(owners);
  done += Math.min(BATCH, embeddable.length - i);
  if ((i / BATCH) % 5 === 0) log(`units ${done}/${embeddable.length} changed=${changedOwners} unchanged=${unchanged} vectors=${vectors}`);
}
// slots an owner no longer has, and owners that are no longer embeddable at all
let trimmed = 0, gone = 0;
if (trim.length) {
  const r = await sql`DELETE FROM work.embeddings e USING unnest(${sql.array(trim.map((t) => t.id))}::text[], ${sql.array(trim.map((t) => t.n))}::int[]) AS s(id, n)
                      WHERE e.owner_kind = 'unit' AND e.owner_id = s.id AND e.slot >= s.n`;
  trimmed = r.count;
}
const live = new Set(embeddable.map((u) => u.sql_hash));
const goneIds = [...have.keys()].filter((id) => !live.has(id));
if (goneIds.length) {
  const r = await sql`DELETE FROM work.embeddings WHERE owner_kind = 'unit' AND owner_id = ANY(${sql.array(goneIds)}::text[])`;
  gone = r.count;
}
log(`units done: ${embeddable.length} owners — ${changedOwners} changed (${vectors} vectors embedded), ${unchanged} unchanged, ${trimmed} stale slots deleted, ${goneIds.length} owners gone (${gone} rows deleted)`);

// ------------------------------------------------------- layout patterns (shard 0 only)
// The curated corpus is an INPUT to assembly, not a runtime load: 46 human-authored,
// git-versioned rows. They are staged into `work` here (this is already the one place
// that reads and hashes the JSONL) and assembled into the release by p5.
if (SHARD === 0) {
  if (!fs.existsSync(PATTERNS)) throw new Error(`layout patterns JSONL not found: ${PATTERNS}`);
  const raw = fs.readFileSync(PATTERNS, "utf8");
  const jsonlHash = crypto.createHash("sha256").update(raw).digest("hex").slice(0, 16);
  const rows = raw.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  const owners = rows.map((r: any) => ({
    kind: "layout",
    id: r.id as string,
    // loadLayoutPatterns()'s own text shape (src/corpus/layoutStore.ts)
    items: [`${r.name}. ${r.description}`, ...((r.intents ?? []) as string[])].map((text, slot) => ({ slot, text })),
  }));
  const n = await embedOwners(owners);

  // staging shape = the column list BaseLayout.insertParams() binds, in that order;
  // `rid` is the load order, exactly like the SQLite rowids it replaced.
  const J = (v: unknown) => (v == null ? null : JSON.stringify(v));
  const verifiedAt = new Date().toISOString();
  await sql`DROP TABLE IF EXISTS work.layout_pattern`;
  await sql`CREATE TABLE work.layout_pattern (
    rid bigint PRIMARY KEY, id text UNIQUE NOT NULL, kind text NOT NULL, name text NOT NULL,
    format text NOT NULL, format_exclusive integer, dsl_support text NOT NULL, description text NOT NULL,
    when_to_use text NOT NULL, intents text NOT NULL, requires text, composition text, recipe text,
    fixture_ref text, pitfalls text, trigger text, why text, instead text, alternative text,
    source_refs text, verified text NOT NULL, dsl_version text, verified_at text, jsonl_hash text NOT NULL)`;
  const staged = rows.map((r: any, i: number) => ({
    rid: i + 1, id: r.id, kind: r.kind, name: r.name, format: r.format,
    format_exclusive: r.formatExclusive ? 1 : 0, dsl_support: r.dslSupport, description: r.description,
    when_to_use: r.whenToUse, intents: JSON.stringify(r.intents ?? []),
    requires: J(r.requires), composition: J(r.composition), recipe: J(r.recipe),
    fixture_ref: r.fixtureRef ?? null, pitfalls: J(r.pitfalls), trigger: r.trigger ?? null,
    why: r.why ?? null, instead: J(r.instead), alternative: r.alternative ?? null,
    source_refs: J(r.sourceRefs), verified: r.verified, dsl_version: r.dslVersion ?? null,
    verified_at: verifiedAt, jsonl_hash: jsonlHash,
  }));
  await sql`INSERT INTO work.layout_pattern ${sql(staged)}`;
  log(`layout patterns: ${owners.length} owners, ${n} vectors, ${staged.length} rows staged (hash ${jsonlHash}, file ${path.basename(PATTERNS)})`);
}

clearInterval(keepAlive);
await sql.end({ timeout: 5 });
process.exit(0);
