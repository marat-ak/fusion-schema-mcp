/** landscape experiment 2: WHERE must page geometry sit for the BIP chain to honor it? */
import fs from "node:fs";
import path from "node:path";
const BUILDERS = process.env.BUILDERS_DIR ?? "/app/dist/authoring";
const { buildRtf } = await import(path.join(BUILDERS, "rtfBuild.js"));

const xml = fs.readFileSync("/tmp/shard/shard-rtf-tech/fixtures/landscape/sample.xml", "utf8");

async function render(rtf: string): Promise<Buffer> {
  const url = (process.env.RENDER_URL ?? "http://bip-render:8983").replace(/\/$/, "");
  const res = await fetch(`${url}/render`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RENDER_TOKEN ?? ""}` },
    body: JSON.stringify({ rtf: Buffer.from(rtf, "latin1").toString("base64"), xml: Buffer.from(xml).toString("base64"), format: "pdf" }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`);
  return Buffer.from(await res.arrayBuffer());
}
const mediaBox = (pdf: Buffer) => (pdf.toString("latin1").match(/MediaBox\s*\[([^\]]+)\]/) || [, "??"])[1];
/** crude text extract from an uncompressed content stream to check fields still merged */
const hasText = (pdf: Buffer, t: string) => pdf.toString("latin1").includes(t);

const table = { kind: "table", forEach: "/DATA_DS/G_LINE", border: true, columns: [
  { header: "Document", field: "DOC_NUMBER" }, { header: "Supplier", field: "SUPPLIER_NAME" }, { header: "Amount", field: "AMOUNT", align: "right" } ] };
const page = { widthTwips: 15840, heightTwips: 12240, marginTwips: 720 };
const base = buildRtf({ title: "t", page, blocks: [table] } as any);

const PAGECTL = "\\paperw15840\\paperh12240\\margl720\\margr720\\margt720\\margb720";
const variants: Array<[string, string]> = [
  // D: move page ctl AFTER the font table (Word-style document-format area)
  ["D-pagectl-after-fonttbl", base.replace(PAGECTL, "").replace("\\pard\\plain\n", PAGECTL + "\\pard\\plain\n")],
  // E: doc-level \landscape keyword added
  ["E-plus-landscape-kw", base.replace(PAGECTL, "").replace("\\pard\\plain\n", PAGECTL + "\\landscape\\pard\\plain\n")],
  // F: full \sectd section geometry right before body (known tag-merge risk - checking both effects)
  ["F-sectd-pgwsxn", base.replace("\\pard\\plain\n", "\\sectd\\lndscpsxn\\pgwsxn15840\\pghsxn12240\\marglsxn720\\margrsxn720\\margtsxn720\\margbsxn720\\pard\\plain\n")],
];
for (const [name, rtf] of variants) {
  try {
    const pdf = await render(rtf);
    console.log(name, "MediaBox:", mediaBox(pdf), "| INV-1001 text visible:", hasText(pdf, "INV-1001"), `(${pdf.length}b)`);
    fs.writeFileSync(`/tmp/shard/land-${name}.pdf`, pdf);
  } catch (e: any) { console.log(name, "FAIL:", e?.message); }
}
