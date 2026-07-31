/**
 * Build-time helper: zip the compiled seed DBs (schema.sqlite / reports.sqlite) into single-entry
 * zips (schema.sqlite.zip / reports.sqlite.zip) that the Dockerfile COPYs into /app/seed and
 * provision.ts unzips at start. Uses fflate so no system `zip` is required.
 *
 * Run: node dist/zip-seed.js   (after npm run compile)
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const targets: { name: string; env: string }[] = [
  { name: "schema.sqlite", env: "SCHEMA_DB" },
  { name: "reports.sqlite", env: "REPORTS_DB" },
];

for (const { name, env } of targets) {
  const src = process.env[env] ?? path.join(ROOT, name);
  if (!fs.existsSync(src)) { console.error(`[zip-seed] ${src} missing — skipping ${name}`); continue; }
  const data = fs.readFileSync(src);
  const zipped = zipSync({ [name]: new Uint8Array(data) }, { level: 6 });
  const out = path.join(ROOT, `${name}.zip`);
  fs.writeFileSync(out, zipped);
  console.error(`[zip-seed] ${src} (${(data.length / 1048576).toFixed(1)} MB) -> ${out} (${(zipped.length / 1048576).toFixed(1)} MB)`);
}
