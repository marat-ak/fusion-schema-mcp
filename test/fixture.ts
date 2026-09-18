/** Shared test fixture: a fresh 5-file sqlite catalog in a temp dir, opened through the library. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openCatalogDb, type CatalogDb } from "../src/db/index.js";

export async function openTempCatalog(prefix = "cat-", register = true): Promise<{ db: CatalogDb; dir: string }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const f = (n: string) => path.join(dir, n);
  const db = await openCatalogDb(
    { provider: "sqlite", create: true,
      files: { schema: f("schema.sqlite"), reports: f("reports.sqlite"), enrich: f("enrich.sqlite"), cache: f("cache.sqlite"), facts: f("facts.sqlite") } },
    { register },
  );
  return { db, dir };
}
