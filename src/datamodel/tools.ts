/** MCP tools for authoring BI Publisher data models: createDataModel + updateDataModel. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import { buildXdmz, unzipXdmz, updateXdmzWithPatch, updateXdmzWithSpec, type DataModelSpec, type DmPatch } from "./build.js";
import { validateSpec } from "./validate.js";

const DEBUG = process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";
function reply(name: string, args: unknown, data: unknown) {
  if (DEBUG) console.error(`[mcp] ${name} <- ${JSON.stringify(data).slice(0, 400)}`);
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// ---- zod shapes -------------------------------------------------------------------------------

const zType = z.enum(["string", "integer", "float", "number", "date", "boolean"]);
const zColumn = z.object({
  name: z.string(), value: z.string().optional(), dataType: zType.optional(), label: z.string().optional(),
});
const zDataset = z.object({
  name: z.string().describe("dataset name, e.g. Q_MAIN"),
  sql: z.string().describe("physical SQL SELECT"),
  dataSource: z.string().optional().describe("JDBC connection name (defaults to defaultDataSource)"),
  columns: z.array(zColumn).optional().describe("output elements; if omitted, parsed from the SELECT list"),
});
const zParameter = z.object({
  name: z.string(), dataType: zType.optional(), defaultValue: z.string().optional(), label: z.string().optional(),
});
const zTrigger = z.object({
  name: z.string(),
  type: z.enum(["before-data", "after-data"]),
  language: z.enum(["PLSQL", "Java"]).optional(),
  source: z.string().describe("PLSQL: PACKAGE.FUNCTION ; Java: fully-qualified class"),
});
const zBursting = z.object({
  name: z.string(),
  splitBy: z.string().describe("BURSTING_NODE xpath, e.g. /DATA/LIST_G1/G1/CUSTOMER_ID"),
  deliveryKey: z.string().optional().describe("DELIVERY_KEY xpath (defaults to splitBy)"),
  consolidated: z.boolean().optional(),
  ucmDataSource: z.string().optional(),
  dataSource: z.string().optional(),
  burstQuery: z.string().describe("SQL returning KEY, TEMPLATE, TEMPLATE_FORMAT, OUTPUT_FORMAT, output_name, DEL_CHANNEL, PARAMETER1..N"),
});
const zSpec = z.object({
  name: z.string().describe("data model name (also the file base name)"),
  defaultDataSource: z.string().optional().describe("default JDBC connection, e.g. ApplicationDB_HCM"),
  description: z.string().optional(),
  path: z.string().optional().describe("catalog path, e.g. /Custom/AI/MyModel.xdm"),
  rootName: z.string().optional().describe("output root tag (default DATA_DS)"),
  datasets: z.array(zDataset).min(1),
  parameters: z.array(zParameter).optional(),
  triggers: z.array(zTrigger).optional().describe("event triggers (before-data/after-data PLSQL) — near-universal in real Fusion models"),
  bursting: zBursting.optional().describe("bursting definition — near-universal in real Fusion models"),
  properties: z.record(z.string()).optional(),
});
const zPatch = z.object({
  setDatasetSql: z.array(z.object({ dataset: z.string(), sql: z.string() })).optional(),
  setDefaultDataSource: z.string().optional(),
  addParameters: z.array(zParameter).optional(),
  addTriggers: z.array(zTrigger).optional(),
  setBursting: zBursting.nullable().optional().describe("object = set/replace; null = clear"),
  rename: z.string().optional(),
});

function summarize(spec: DataModelSpec) {
  return {
    datasets: spec.datasets.length,
    parameters: spec.parameters?.length ?? 0,
    datasetNames: spec.datasets.map((d) => d.name),
  };
}

/** Resolve the base .xdmz bytes for update: uploaded base64, or a poller corpus path. */
function loadBase(base: { xdmzBase64?: string; corpusPath?: string; reportAbsolutePath?: string }): Uint8Array {
  if (base.xdmzBase64) return new Uint8Array(Buffer.from(base.xdmzBase64, "base64"));
  if (base.corpusPath) {
    const root = process.env.CORPUS_DIR ?? "/data/corpus";
    const rel = base.corpusPath.replace(/^\/+/, "");
    const abs = rel.startsWith("objects/") ? path.join(root, rel) : path.join(root, "objects", rel);
    return new Uint8Array(fs.readFileSync(abs));
  }
  if (base.reportAbsolutePath) throw new Error("base.reportAbsolutePath is not wired yet — supply xdmzBase64 (uploaded) or corpusPath");
  throw new Error("update requires base.xdmzBase64 or base.corpusPath");
}

export function registerDataModelTools(server: McpServer): void {
  server.registerTool(
    "createDataModel",
    {
      title: "Create a BI Publisher data model (.xdmz)",
      description:
        "Build a NEW Fusion BI Publisher data model from a spec and return a downloadable .xdmz " +
        "(base64). Covers SQL datasets, parameters, output data structure, event triggers " +
        "(before-data/after-data PLSQL) and bursting. Ground every table/column with the " +
        "fusion-schema tools first; validation runs before returning.",
      inputSchema: { spec: zSpec },
    },
    async ({ spec }) => {
      const s = spec as DataModelSpec;
      const validation = validateSpec(s);
      const bytes = buildXdmz(s);
      return reply("createDataModel", { name: s.name }, {
        ok: validation.ok,
        fileName: `${s.name}.xdmz`,
        xdmzBase64: Buffer.from(bytes).toString("base64"),
        summary: summarize(s),
        validation,
      });
    },
  );

  server.registerTool(
    "updateDataModel",
    {
      title: "Update a BI Publisher data model (.xdmz)",
      description:
        "Modify an EXISTING data model and return a new downloadable .xdmz (base64). Base = an " +
        "uploaded archive (xdmzBase64) or a poller corpus path (corpusPath). Apply either a full " +
        "'spec' (replace) or a targeted 'patch' (e.g. setDatasetSql). Everything not mentioned is " +
        "preserved.",
      inputSchema: {
        base: z.object({
          xdmzBase64: z.string().optional().describe("uploaded .xdmz as base64"),
          corpusPath: z.string().optional().describe("path under the poller corpus, e.g. objects/Custom/BABS/X.xdmz"),
          reportAbsolutePath: z.string().optional().describe("Fusion catalog path (not wired yet)"),
        }),
        spec: zSpec.optional().describe("full replacement spec"),
        patch: zPatch.optional().describe("targeted change (preferred for small edits)"),
      },
    },
    async ({ base, spec, patch }) => {
      const baseBytes = loadBase(base);
      if (spec) {
        const s = spec as DataModelSpec;
        const validation = validateSpec(s);
        const bytes = updateXdmzWithSpec(baseBytes, s);
        return reply("updateDataModel", { mode: "spec", name: s.name }, {
          ok: validation.ok, mode: "spec", fileName: `${s.name}.xdmz`,
          xdmzBase64: Buffer.from(bytes).toString("base64"), summary: summarize(s), validation,
        });
      }
      if (patch) {
        const { bytes, applied, warnings } = updateXdmzWithPatch(baseBytes, patch as DmPatch);
        const entries = Object.keys(unzipXdmz(bytes));
        return reply("updateDataModel", { mode: "patch" }, {
          ok: applied.length > 0, mode: "patch",
          fileName: `${patch.rename ?? "datamodel"}.xdmz`,
          xdmzBase64: Buffer.from(bytes).toString("base64"),
          applied, warnings, entries,
        });
      }
      throw new Error("updateDataModel requires either 'spec' or 'patch'");
    },
  );
}
