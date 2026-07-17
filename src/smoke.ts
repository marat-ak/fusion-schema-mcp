/**
 * Live smoke test: connect to the running HTTP MCP server as a real MCP client,
 * list tools, exercise each, assert the acceptance criteria. Exits non-zero on failure.
 * Env: MCP_URL (default http://127.0.0.1:8979/mcp)
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const URL_STR = process.env.MCP_URL ?? "http://127.0.0.1:8979/mcp";

let failures = 0;
function check(name: string, cond: boolean, detail?: unknown) {
  const ok = cond ? "PASS" : "FAIL";
  if (!cond) failures++;
  console.log(`  [${ok}] ${name}${detail !== undefined ? " -> " + JSON.stringify(detail) : ""}`);
}

async function main() {
  const client = new Client({ name: "smoke", version: "0.1.0" });
  const transport = new StreamableHTTPClientTransport(new URL(URL_STR));
  await client.connect(transport);
  console.log(`connected to ${URL_STR}`);

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name).sort();
  console.log("tools:", names.join(", "));
  const expected = [
    "getColumns",
    "getIndexes",
    "getRelatedTables",
    "getTable",
    "searchTables",
    "validateColumns",
    "validateTable",
  ];
  check("7 tools present", expected.every((e) => names.includes(e)), names);

  const call = async (name: string, args: Record<string, unknown>) => {
    const r: any = await client.callTool({ name, arguments: args });
    return JSON.parse(r.content[0].text);
  };

  // validateTable — known Fusion table
  const vt = await call("validateTable", { name: "AP_INVOICES_ALL" });
  check("validateTable(AP_INVOICES_ALL).exists", vt.exists === true);

  // validateTable — misspelled -> did-you-mean
  const vtBad = await call("validateTable", { name: "AP_INVOICE_ALL" });
  check(
    "validateTable(misspelled) suggests",
    vtBad.exists === false && Array.isArray(vtBad.suggestions) && vtBad.suggestions.length > 0,
    vtBad.suggestions,
  );

  // searchTables — by description
  const st = await call("searchTables", { query: "supplier invoice", limit: 10 });
  check("searchTables('supplier invoice') returns rows", Array.isArray(st) && st.length > 0, st.slice(0, 3).map((x: any) => x.name));

  // pick a real table from search (fallback to AP_INVOICES_ALL)
  const probe = vt.exists ? "AP_INVOICES_ALL" : st[0]?.name;

  const gt = await call("getTable", { name: probe });
  check("getTable returns metadata + columnCount", gt && gt.columnCount > 0, { name: gt?.name, columnCount: gt?.columnCount, pk: gt?.primaryKey });

  const gc = await call("getColumns", { table: probe });
  check("getColumns returns columns", gc.tableExists && gc.columns.length > 0, gc.columns.length);

  // validateColumns — one real, one fake
  const realCol = gc.columns[0]?.name;
  const vc = await call("validateColumns", { table: probe, columns: [realCol, "NOT_A_REAL_COLUMN_XYZ"] });
  const realOk = vc.results.find((r: any) => r.column === realCol)?.exists === true;
  const fakeMiss = vc.results.find((r: any) => r.column === "NOT_A_REAL_COLUMN_XYZ")?.exists === false;
  check("validateColumns real=exists, fake=missing", realOk && fakeMiss);

  const gi = await call("getIndexes", { table: probe });
  check("getIndexes returns indexes", gi.tableExists && Array.isArray(gi.indexes), gi.indexes?.length);

  const gr = await call("getRelatedTables", { table: probe });
  const hasDeclared = gr.related?.some((r: any) => r.source === "declared");
  const hasMined = gr.related?.some((r: any) => r.source === "mined");
  check("getRelatedTables returns join paths", gr.tableExists && (gr.related?.length ?? 0) > 0, {
    total: gr.related?.length,
    declared: hasDeclared,
    mined: hasMined,
  });

  await client.close();
  console.log(failures === 0 ? "\nSMOKE: ALL PASS" : `\nSMOKE: ${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("smoke error", e);
  process.exit(1);
});
