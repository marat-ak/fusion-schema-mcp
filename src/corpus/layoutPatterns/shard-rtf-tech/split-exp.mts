import fs from "node:fs";
import path from "node:path";
const BUILDERS = process.env.BUILDERS_DIR ?? "/app/dist/authoring";
const { buildRtf } = await import(path.join(BUILDERS, "rtfBuild.js"));
const xml = `<DATA_DS>
<G_TICKET><TICKET_NUMBER>TK-501</TICKET_NUMBER><CARRIER_NAME>A</CARRIER_NAME><WEIGHT>1</WEIGHT></G_TICKET>
<G_TICKET><TICKET_NUMBER>TK-502</TICKET_NUMBER><CARRIER_NAME>B</CARRIER_NAME><WEIGHT>2</WEIGHT></G_TICKET>
<G_TICKET><TICKET_NUMBER>TK-503</TICKET_NUMBER><CARRIER_NAME>C</CARRIER_NAME><WEIGHT>3</WEIGHT></G_TICKET>
<G_TICKET><TICKET_NUMBER>TK-504</TICKET_NUMBER><CARRIER_NAME>D</CARRIER_NAME><WEIGHT>4</WEIGHT></G_TICKET>
</DATA_DS>`;
async function render(rtf: string): Promise<Buffer> {
  const url = (process.env.RENDER_URL ?? "http://bip-render:8983").replace(/\/$/, "");
  const res = await fetch(`${url}/render`, { method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.RENDER_TOKEN ?? ""}` },
    body: JSON.stringify({ rtf: Buffer.from(rtf, "latin1").toString("base64"), xml: Buffer.from(xml).toString("base64"), format: "pdf" }) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
const cols = [ { header: "Ticket", field: "TICKET_NUMBER" }, { header: "Carrier", field: "CARRIER_NAME" }, { header: "Weight", field: "WEIGHT", align: "right" } ];
// A: split on the TABLE row loop
const specA: any = { title: "t", blocks: [ { kind: "table", forEach: "/DATA_DS/G_TICKET", splitByPage: true, border: true, columns: cols } ] };
// B: forEach over rows + inner 1-row table, split on the forEach (header re-emitted each page)
const specB: any = { title: "t", blocks: [ { kind: "forEach", group: "/DATA_DS/G_TICKET", splitByPage: true, blocks: [ { kind: "table", columns: cols } ] } ] };
for (const [name, spec] of [["A-table-split", specA], ["B-forEach-split", specB]] as const) {
  const pdf = await render(buildRtf(spec));
  fs.writeFileSync(`/tmp/shard/split-${name}.pdf`, pdf);
  console.log(name, pdf.length + "b");
}
