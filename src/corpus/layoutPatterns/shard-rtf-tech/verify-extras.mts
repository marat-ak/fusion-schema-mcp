/**
 * verify-extras.mts — supplemental FULL-SPEC render verification for this shard.
 *
 * The main harness (scripts/verify-layout-patterns.mts) compiles only recipe.blocks /
 * recipe.tableFragment / single-block recipes: it DROPS the `page` and `imports` keys of a
 * full-spec recipe and never sends `subtemplates` to bip-render. Four techniques in this shard
 * live exactly in those keys, so this script re-renders them with the COMPLETE spec through the
 * same builders + render service:
 *   - rtf-page-header-footer  (page.header/page.footer running bands)
 *   - rtf-landscape           (page geometry widthTwips > heightTwips)
 *   - rtf-raw-page-x-of-y     (page.footer with raw PAGE/NUMPAGES fields)
 *   - rtf-subtemplate-call    (imports[] + bip-render subtemplates[] contract, fixture sub.json)
 * plus the column-guard flag-Y counter-render (sample-on.xml).
 *
 * Usage (inside the fusion-agent container):
 *   npx tsx verify-extras.mts <shardDir> <outDir>
 */
import fs from "node:fs";
import path from "node:path";

const BUILDERS = process.env.BUILDERS_DIR ?? (fs.existsSync("/app/dist/authoring") ? "/app/dist/authoring" : new URL("../../../../fusion-agent/src/authoring", import.meta.url).pathname);
const { buildRtf, buildSubtemplateRtf } = await import(path.join(BUILDERS, "rtfBuild.js"));

const [shardDir, outDir] = process.argv.slice(2);
if (!shardDir || !outDir) { console.error("usage: verify-extras.mts <shardDir> <outDir>"); process.exit(2); }
fs.mkdirSync(outDir, { recursive: true });

const rows: any[] = fs.readFileSync(path.join(shardDir, "patterns.jsonl"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const byId: Record<string, any> = Object.fromEntries(rows.map((r) => [r.id, r]));

async function render(rtf: string, xml: string, subs?: Array<{ importUrl?: string; rtf: string }>): Promise<Buffer> {
  const url = (process.env.RENDER_URL ?? "http://bip-render:8983").replace(/\/$/, "");
  const res = await fetch(`${url}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RENDER_TOKEN ?? ""}` },
    body: JSON.stringify({
      rtf: Buffer.from(rtf, "latin1").toString("base64"),
      xml: Buffer.from(xml).toString("base64"),
      format: "pdf",
      ...(subs?.length ? { subtemplates: subs } : {}),
    }),
  });
  if (!res.ok) throw new Error(`render HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Full RtfSpec from a corpus recipe — KEEPS page + imports (what the main harness drops). */
const fullSpec = (recipe: any) => ({ title: "verify-full", page: recipe.page, imports: recipe.imports, blocks: recipe.blocks });
const fixture = (r: any, f = "sample.xml") => fs.readFileSync(path.join(shardDir, r.fixtureRef, f), "utf8");

let fail = 0;
async function run(name: string, fn: () => Promise<Buffer>): Promise<void> {
  try {
    const pdf = await fn();
    if (!pdf || pdf.length < 500) throw new Error(`empty render (${pdf?.length ?? 0} bytes)`);
    fs.writeFileSync(path.join(outDir, name + ".pdf"), pdf);
    console.log(`PASS(full) ${name} (${pdf.length}b)`);
  } catch (e: any) {
    console.log(`FAIL(full) ${name}: ${String(e?.message).slice(0, 240)}`);
    fail++;
  }
}

for (const id of ["lp:technique:rtf-page-header-footer", "lp:technique:rtf-landscape", "lp:technique:rtf-raw-page-x-of-y"]) {
  const r = byId[id];
  await run(id.replace("lp:technique:", ""), () => render(buildRtf(fullSpec(r.recipe)), fixture(r)));
}

{ // column guard: counter-render with the flag ON — the Cost column must appear
  const r = byId["lp:technique:rtf-column-guard"];
  await run("rtf-column-guard-flag-on", () => render(buildRtf({ title: "verify", blocks: [r.recipe.tableFragment] }), fixture(r, "sample-on.xml")));
}

{ // subtemplate call: build the .xsb source from the fixture's sub.json, render main+sub together
  const r = byId["lp:technique:rtf-subtemplate-call"];
  const sub = JSON.parse(fs.readFileSync(path.join(shardDir, r.fixtureRef, "sub.json"), "utf8"));
  const subRtf = buildSubtemplateRtf(sub);
  await run("rtf-subtemplate-call", () =>
    render(buildRtf(fullSpec(r.recipe)), fixture(r, "data.xml"), [{ importUrl: r.recipe.imports[0], rtf: Buffer.from(subRtf, "latin1").toString("base64") }]));
}

process.exit(fail ? 1 : 0);
