/**
 * Summarize a BI Publisher archive (.xdmz / .xdoz) into a COMPACT structure the agent can reason
 * over WITHOUT the raw XML/SQL. Full SQL is fetched on demand (getDataset). Regex-based, matching
 * the poller's feature-catalog detectors.
 */
import { unzipSync, strFromU8 } from "fflate";

export interface DatasetSummary {
  name: string;
  type: "sql" | "plsql" | "webservice" | "http" | "file" | "olap" | "unknown";
  sqlChars: number;   // 0 for non-SQL
  tables: string[];   // light FROM/JOIN extraction (≤12), no full SQL
}
export interface TriggerSummary { name: string; event: string; source: string }
export interface FileSummary {
  kind: "datamodel" | "report" | "unknown";
  entries: string[];
  // data model
  datasets?: DatasetSummary[];
  parameters?: string[];
  lovCount?: number;
  triggers?: TriggerSummary[];
  bursting?: boolean;
  groups?: number;
  datasetLinks?: boolean;
  // report
  dataModelRef?: string;
  defaultTemplate?: string;
  templates?: { label?: string; url?: string; type?: string; outputFormats?: string; defaultFormat?: string; isDefault: boolean }[];
  layouts?: string[];   // template labels (back-compat)
  formats?: string[];
  note?: string;
}

function datasetType(block: string, attrs: string): DatasetSummary["type"] {
  if (/<webService\b/i.test(block)) return "webservice";
  if (/<httpDataSet\b/i.test(block)) return "http";
  if (/<(fileDataSet|excelDataSet)\b/i.test(block) || /\bfileName=/i.test(attrs)) return "file";
  if (/<(mdxDataSet|olapDataSet)\b/i.test(block)) return "olap";
  if (/<sqlStatement[^>]*type="plsql"/i.test(block) || (/\bbegin\b[\s\S]*\bend\b/i.test(block) && !/\bselect\b/i.test(block))) return "plsql";
  if (/<sql\b/i.test(block) || /\bselect\b/i.test(block)) return "sql";
  return "unknown";
}
function sqlText(block: string): string {
  const cd = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cd) return cd[1];
  const s = block.match(/<sql[^>]*>([\s\S]*?)<\/sql>/i);
  return s ? s[1] : "";
}
function tablesOf(sql: string): string[] {
  const out = new Set<string>();
  const re = /\b(?:from|join)\s+((?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*)(?:\.(?:"[^"]+"|[A-Za-z_][A-Za-z0-9_$]*))*)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    const t = m[1].split(".").pop()!.replace(/"/g, "").toUpperCase();
    if (t.length > 2 && !/^(DUAL|SELECT|WHERE|JOIN)$/.test(t)) out.add(t);
  }
  return [...out].slice(0, 12);
}
function fmtOf(entryNames: string[]): string[] {
  const f = new Set<string>();
  for (const e of entryNames) {
    const l = e.toLowerCase();
    if (l.endsWith(".rtf")) f.add("rtf");
    else if (l.endsWith(".xpt")) f.add("xpt");
    else if (l.endsWith(".xsl")) f.add("xslfo");
    else if (/\.xlsx?$/.test(l) || l.includes(".xls")) f.add("excel");
    else if (/\.(etext|eft)$/.test(l)) f.add("etext");
    else if (l.endsWith(".pdf")) f.add("pdf");
  }
  return [...f];
}

/** Unzip an archive and produce its compact summary. */
export function analyze(bytes: Buffer): FileSummary {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(new Uint8Array(bytes)); } catch { return { kind: "unknown", entries: [], note: "not a zip archive" }; }
  const names = Object.keys(entries);
  const pick = (suffix: string) => { const k = names.find((n) => n.toLowerCase().endsWith(suffix)); return k ? strFromU8(entries[k]) : ""; };

  const xdm = pick("_datamodel.xdm") || pick(".xdm");
  if (xdm) return { kind: "datamodel", entries: names, ...summarizeDataModel(xdm) };
  const xdo = pick("_report.xdo") || pick(".xdo");
  if (xdo) return { kind: "report", entries: names, ...summarizeReport(xdo, names) };
  return { kind: "unknown", entries: names };
}

function summarizeDataModel(xml: string): Partial<FileSummary> {
  const datasets: DatasetSummary[] = [];
  let m: RegExpExecArray | null;
  const re = /<dataSet\b([^>]*)>([\s\S]*?)<\/dataSet>/gi;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1], block = m[2];
    const name = attrs.match(/name="([^"]*)"/i)?.[1] ?? "";
    const type = datasetType(block, attrs);
    const sql = type === "sql" || type === "plsql" ? sqlText(block) : "";
    datasets.push({ name, type, sqlChars: sql.trim().length, tables: sql ? tablesOf(sql) : [] });
  }
  const self = /<dataSet\b([^>]*?)\/>/gi;
  while ((m = self.exec(xml)) !== null) {
    datasets.push({ name: m[1].match(/name="([^"]*)"/i)?.[1] ?? "", type: datasetType("", m[1]), sqlChars: 0, tables: [] });
  }
  const parameters = [...xml.matchAll(/<parameter\b[^>]*\bname="([^"]+)"/gi)].map((x) => x[1]);
  const lovCount = (xml.match(/<valueSet\b/gi) || []).length;
  const triggers: TriggerSummary[] = [...xml.matchAll(/<eventTrigger\b([^>]*)>([\s\S]*?)<\/eventTrigger>/gi)].map((t) => ({
    name: t[1].match(/name="([^"]*)"/i)?.[1] ?? "",
    event: t[1].match(/type="([^"]*)"/i)?.[1] ?? "",
    source: t[2].match(/<source>([\s\S]*?)<\/source>/i)?.[1]?.trim() ?? "",
  }));
  const burstBlock = xml.match(/<bursting>[\s\S]*?<\/bursting>/i)?.[0] ?? "";
  const dsBlock = xml.match(/<dataStructure\b[\s\S]*?<\/dataStructure>/i)?.[0] ?? "";
  return {
    datasets, parameters, lovCount, triggers,
    bursting: /<burst\b/i.test(burstBlock),
    groups: (dsBlock.match(/<group\b/gi) || []).length,
    datasetLinks: /<link\b|<dataSetLink\b/i.test(xml),
  };
}

/** On-demand: the full SQL of ONE dataset (so the model never gets all SQL up front). */
export function getDatasetSql(bytes: Buffer, dataset: string): { name: string; type: DatasetSummary["type"]; sql: string } | null {
  let entries: Record<string, Uint8Array>;
  try { entries = unzipSync(new Uint8Array(bytes)); } catch { return null; }
  const names = Object.keys(entries);
  const k = names.find((n) => n.toLowerCase().endsWith("_datamodel.xdm")) ?? names.find((n) => n.toLowerCase().endsWith(".xdm"));
  if (!k) return null;
  const xml = strFromU8(entries[k]);
  let m: RegExpExecArray | null;
  const re = /<dataSet\b([^>]*)>([\s\S]*?)<\/dataSet>/gi;
  while ((m = re.exec(xml)) !== null) {
    const name = m[1].match(/name="([^"]*)"/i)?.[1] ?? "";
    if (name === dataset) return { name, type: datasetType(m[2], m[1]), sql: sqlText(m[2]).trim() };
  }
  return null;
}

function summarizeReport(xml: string, names: string[]): Partial<FileSummary> {
  const dataModelRef = xml.match(/<dataModel[^>]*\burl="([^"]+)"/i)?.[1] ?? xml.match(/\burl="([^"]+\.xdm)"/i)?.[1];
  // Fusion _report.xdo lists layouts under <templates default="…">/<template …>, NOT <layout>.
  const defaultTemplate = xml.match(/<templates\b[^>]*\bdefault="([^"]+)"/i)?.[1];
  const templates = [...xml.matchAll(/<template\b([^>]*?)\/?>/gi)]
    .map((m) => {
      const a = m[1];
      const label = a.match(/\blabel="([^"]*)"/i)?.[1];
      return {
        label,
        url: a.match(/\burl="([^"]*)"/i)?.[1],
        type: a.match(/\btype="([^"]*)"/i)?.[1],
        outputFormats: a.match(/\boutputFormat="([^"]*)"/i)?.[1],
        defaultFormat: a.match(/\bdefaultFormat="([^"]*)"/i)?.[1],
        isDefault: !!label && label === defaultTemplate,
      };
    })
    .filter((t) => t.label || t.url);
  // formats = the union of declared template output formats, else fall back to file extensions.
  const declared = new Set<string>();
  for (const t of templates) (t.outputFormats ?? "").split(",").map((s) => s.trim()).filter(Boolean).forEach((f) => declared.add(f));
  const formats = declared.size ? [...declared] : fmtOf(names);
  return { dataModelRef, defaultTemplate, templates, layouts: templates.map((t) => t.label || t.url || ""), formats };
}
