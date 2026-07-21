/**
 * MCP file tools — MECHANICAL operations on uploaded / generated archives (by fileId). The model
 * is the intelligence: it reads summaries, grounds SQL with the schema tools, WRITES the new SQL,
 * then calls setDatasetSql to apply it. No LLM inside these tools.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { listFiles, getFile, putFile } from "./store.js";
import { analyze, getDatasetSql } from "./analyze.js";
import { buildXdmz, updateXdmzWithPatch, type DataModelSpec, type DmPatch } from "../datamodel/build.js";
import { zSpec, zPatch } from "../datamodel/tools.js";

const DEBUG = process.env.MCP_DEBUG === "1" || process.env.MCP_DEBUG === "true";
function reply(name: string, data: unknown) {
  if (DEBUG) console.error(`[mcp] ${name} <- ${JSON.stringify(data).slice(0, 300)}`);
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

export function registerFileTools(server: McpServer): void {
  server.registerTool(
    "listUploadedFiles",
    {
      title: "List uploaded/generated files with summaries",
      description:
        "The user's uploaded (and any generated) BI Publisher archives, each with a COMPACT summary " +
        "(kind, datasets + types + tables, parameters, triggers, bursting, layouts/formats). Start " +
        "here to see what you're working with — do NOT ask for full SQL; fetch it per dataset with " +
        "getDataset only when you actually need it.",
      inputSchema: { fileIds: z.array(z.string()).optional().describe("restrict to these fileIds (default: all)") },
    },
    async ({ fileIds }) => reply("listUploadedFiles", { files: listFiles(fileIds) }),
  );

  server.registerTool(
    "getDataset",
    {
      title: "Get one dataset's full SQL from a file",
      description:
        "The full physical SQL of ONE dataset in an uploaded data model. Use to read a query before " +
        "explaining or modifying it. Ground the tables/columns with validateTable/getColumns before " +
        "you rewrite.",
      inputSchema: {
        fileId: z.string(),
        dataset: z.string().describe("dataset name (from the file summary's datasets[])"),
      },
    },
    async ({ fileId, dataset }) => {
      const f = getFile(fileId);
      if (!f) return reply("getDataset", { error: "file not found or expired" });
      const ds = getDatasetSql(f.bytes, dataset);
      if (!ds) return reply("getDataset", { error: `dataset '${dataset}' not found`, datasets: f.summary.datasets?.map((d) => d.name) ?? [] });
      return reply("getDataset", ds);
    },
  );

  server.registerTool(
    "setDatasetSql",
    {
      title: "Apply new SQL to a dataset (returns a new file)",
      description:
        "Replace a dataset's SQL with SQL YOU have already written and grounded against the Fusion " +
        "schema. Produces a NEW file (the original is unchanged) and returns its fileId — give the " +
        "user that file to download. Does not invent SQL; it only applies what you pass.",
      inputSchema: {
        fileId: z.string(),
        dataset: z.string(),
        sql: z.string().describe("the complete new SQL for this dataset"),
      },
    },
    async ({ fileId, dataset, sql }) => {
      const f = getFile(fileId);
      if (!f) return reply("setDatasetSql", { error: "file not found or expired" });
      const before = getDatasetSql(f.bytes, dataset);
      const { bytes, applied, warnings } = updateXdmzWithPatch(f.bytes, { setDatasetSql: [{ dataset, sql }] });
      if (!applied.length) return reply("setDatasetSql", { error: `dataset '${dataset}' not found`, warnings });
      const buf = Buffer.from(bytes);
      const meta = putFile(f.name.replace(/(\.xdmz)?$/i, "") + ".modified.xdmz", "datamodel", buf, analyze(buf), fileId);
      return reply("setDatasetSql", { fileId: meta.id, name: meta.name, dataset, oldSql: before?.sql ?? null, newSql: sql, downloadHint: `offer /api/files/${meta.id}/download` });
    },
  );

  server.registerTool(
    "createDataModelFile",
    {
      title: "Create a data model file from a spec (returns a new file)",
      description:
        "Build a NEW BI Publisher data model (.xdmz) from a DataModelSpec (SQL datasets, parameters, " +
        "structure, event triggers, bursting) and store it — returns a fileId to download. Ground " +
        "every table/column with the schema tools and findSimilarQueries first.",
      inputSchema: { spec: zSpec },
    },
    async ({ spec }) => {
      const s = spec as DataModelSpec;
      const bytes = Buffer.from(buildXdmz(s));
      const meta = putFile(`${s.name}.xdmz`, "datamodel", bytes, analyze(bytes));
      return reply("createDataModelFile", { fileId: meta.id, name: meta.name, summary: meta.summary, downloadHint: `offer /api/files/${meta.id}/download` });
    },
  );

  server.registerTool(
    "updateDataModelFile",
    {
      title: "Update a data model file with a patch (returns a new file)",
      description:
        "Apply a targeted patch to an uploaded/generated data model: setDatasetSql, addParameters, " +
        "addTriggers, setBursting, setDefaultDataSource. Produces a NEW file (returns its fileId).",
      inputSchema: { fileId: z.string(), patch: zPatch },
    },
    async ({ fileId, patch }) => {
      const f = getFile(fileId);
      if (!f) return reply("updateDataModelFile", { error: "file not found or expired" });
      const { bytes, applied, warnings } = updateXdmzWithPatch(f.bytes, patch as DmPatch);
      if (!applied.length) return reply("updateDataModelFile", { error: "nothing applied", warnings });
      const buf = Buffer.from(bytes);
      const meta = putFile(f.name.replace(/(\.xdmz)?$/i, "") + ".modified.xdmz", "datamodel", buf, analyze(buf), fileId);
      return reply("updateDataModelFile", { fileId: meta.id, name: meta.name, applied, warnings, downloadHint: `offer /api/files/${meta.id}/download` });
    },
  );
}
