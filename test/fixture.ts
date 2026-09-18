/**
 * Shared test fixture — one catalog per suite, on the provider `CATALOG_DB` names (required, no
 * default; the whole point of the contract suite is that BOTH providers satisfy it):
 *
 *   CATALOG_DB=sqlite     a fresh 5-file sqlite catalog in a temp dir.
 *   CATALOG_DB=postgres   a fresh THROWAWAY database on QA_PG_ADMIN_URL (required), seeded with
 *                         scripts/pg-import/ddl.sql (whatever ddl_version its header names) for a test version
 *                         schema + `customer` + `meta`, pointed at by meta.active_version.
 *                         Start the server it needs with:
 *                           docker run -d --name qa-pgv -e POSTGRES_PASSWORD=qa \
 *                             -p 127.0.0.1:5498:5432 gnimsys/stack-db:latest
 *                           QA_PG_ADMIN_URL=postgres://postgres:qa@127.0.0.1:5498/postgres
 */
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import { openCatalogDb, type CatalogDb } from "../src/db/index.js";
import { applyLibraryMigrations } from "../src/db/postgres/migrations.js";

export const PROVIDER = (() => {
  const p = process.env.CATALOG_DB;
  if (p !== "sqlite" && p !== "postgres") throw new Error(`CATALOG_DB must be "sqlite" or "postgres" (got ${p ?? "unset"})`);
  return p;
})();

/** The version schema the postgres fixture creates (a test seed, never a real delivery). */
const TEST_VERSION = "v2999_01";
const createdDbs: string[] = [];

function adminUrl(): string {
  const u = process.env.QA_PG_ADMIN_URL;
  if (!u) throw new Error("QA_PG_ADMIN_URL is required for the postgres contract run — see test/fixture.ts header");
  return u;
}

function ddlBlocks(): { version: string; blocks: Record<string, string> } {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "scripts", "pg-import", "ddl.sql");
  const text = fs.readFileSync(file, "utf8");
  const version = /^-- ddl_version:\s*(\S+)/m.exec(text)?.[1];
  if (!version) throw new Error("scripts/pg-import/ddl.sql: missing '-- ddl_version:' header");
  const blocks: Record<string, string> = {};
  let cur: string | null = null;
  for (const line of text.split("\n")) {
    const m = /^-- @block (\w+)/.exec(line);
    if (m) { cur = m[1]; blocks[cur] = ""; continue; }
    if (cur) blocks[cur] += line + "\n";
  }
  return { version, blocks };
}

async function createScratchDb(): Promise<string> {
  const name = `qa_${crypto.randomBytes(6).toString("hex")}`;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end();
  createdDbs.push(name);
  const url = new URL(adminUrl());
  url.pathname = `/${name}`;
  const sql = postgres(url.toString(), { max: 1, onnotice: () => {} });
  const { version, blocks: b } = ddlBlocks();
  await sql.unsafe(b.meta);
  await sql.unsafe(b.corpus.replaceAll("{{S}}", TEST_VERSION));
  await sql.unsafe(b.corpus.replaceAll("{{S}}", "customer"));
  await sql.unsafe(b.vendor.replaceAll("{{V}}", TEST_VERSION));
  // the seed's stamp comes from the DDL header, never a literal — the provider verifies it matches
  await sql`INSERT INTO meta.seeds (version, embedding_model, ddl_version) VALUES (${TEST_VERSION}, 'bge-small-en-v1.5-384', ${version})`;
  await sql`INSERT INTO meta.active_version (lock, version) VALUES (true, ${TEST_VERSION})`;
  // the fixture plays the upgrade job's part: the SERVING path creates nothing (§0), so the
  // library's customer-side tables are applied HERE, before any provider opens the database.
  await applyLibraryMigrations(sql);
  await sql.end();
  return url.toString();
}

export async function dropScratchDbs(): Promise<void> {
  if (!createdDbs.length) return;
  const admin = postgres(adminUrl(), { max: 1, onnotice: () => {} });
  for (const n of createdDbs.splice(0)) await admin.unsafe(`DROP DATABASE IF EXISTS ${n} WITH (FORCE)`);
  await admin.end();
}

export async function openTempCatalog(prefix = "cat-", register = true): Promise<{ db: CatalogDb; dir: string }> {
  if (PROVIDER === "postgres") {
    const databaseUrl = await createScratchDb();
    const db = await openCatalogDb({ provider: "postgres", databaseUrl }, { register });
    return { db, dir: databaseUrl };
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const f = (n: string) => path.join(dir, n);
  const db = await openCatalogDb(
    { provider: "sqlite", create: true,
      files: { schema: f("schema.sqlite"), reports: f("reports.sqlite"), enrich: f("enrich.sqlite"), cache: f("cache.sqlite"), facts: f("facts.sqlite") } },
    { register },
  );
  return { db, dir };
}
