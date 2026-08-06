import fs from "node:fs";
import path from "node:path";
const BUILDERS = process.env.BUILDERS_DIR ?? "/app/dist/authoring";
const { buildRtf } = await import(path.join(BUILDERS, "rtfBuild.js"));
const xml = fs.readFileSync("/tmp/shard/shard-rtf-tech/fixtures/landscape/sample.xml", "utf8");
async function render(rtf: string): Promise<Buffer> {
  const url = (process.env.RENDER_URL ?? "http://bip-render:8983").replace(/\/$/, "");
  const res = await fetch(`${url}/render`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RENDER_TOKEN ?? ""}` },
    body: JSON.stringify({ rtf: Buffer.from(rtf, "latin1").toString("base64"), xml: Buffer.from(xml).toString("base64"), format: "pdf" }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const mediaBox = (pdf: Buffer) => (pdf.toString("latin1").match(/MediaBox\s*\[([^\]]+)\]/) || [,"??"])[1];
const table = { kind: "table", forEach: "/DATA_DS/G_LINE", border: true, columns: [
  { header: "Document", field: "DOC_NUMBER" }, { header: "Supplier", field: "SUPPLIER_NAME" }, { header: "Amount", field: "AMOUNT", align: "right" } ] };
const page = { widthTwips: 15840, heightTwips: 12240, marginTwips: 720 };
// G: raw doc-format words as FIRST body content (recipe-expressible!)
const specG: any = { title: "t", page, blocks: [
  { kind: "paragraph", runs: [{ raw: "\paperw15840\paperh12240\margl720\margr720\margt720\margb720" }] }, table] };
const pdfG = await render(buildRtf(specG));
console.log("G-raw-paperw-in-body MediaBox:", mediaBox(pdfG), `(${pdfG.length}b)`);
fs.writeFileSync("/tmp/shard/land-G.pdf", pdfG);
