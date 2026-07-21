/**
 * Extract PHYSICAL report SQL from a raw BI Publisher catalog archive at runtime.
 *
 * Accepts a single data-model zip (.xdmz), a report zip (.xdoz), or a .zip of a catalog
 * folder. We unzip (fflate), recurse into nested archives, find every `_datamodel.xdm`
 * (or any `.xdm`) entry, and pull the physical `<dataSet ... dataSourceRef=...>` SQL —
 * dropping OTBI-*logical* SQL (dataSourceRef ~ "oracle bi ee", datasetName "Oracle BI EE::",
 * or three-part quoted "SubjectArea"."Table"."Column").
 *
 * Logic ported/adapted from ../bip-catalog-poller/src/extract.ts (unzipArchive +
 * extractDataModel). Copied in-repo on purpose (no cross-repo import).
 */
import { unzipSync } from "fflate";
import path from "node:path";

/** Unzip archive bytes -> entries by name. Throws if `bytes` is not a valid zip. */
export function unzipArchive(bytes: Buffer): Record<string, Buffer> {
  const files = unzipSync(new Uint8Array(bytes));
  const out: Record<string, Buffer> = {};
  for (const [name, data] of Object.entries(files)) out[name] = Buffer.from(data);
  return out;
}

const OTBI_DS = /oracle\s*bi\s*ee/i;
const THREE_PART_QUOTED = /"[^"]+"\."[^"]+"\."[^"]+"/;

function isLogical(name: string, dataSourceRef: string | undefined, sql: string | undefined): boolean {
  if (dataSourceRef && OTBI_DS.test(dataSourceRef)) return true;
  if (/^oracle\s*bi\s*ee::/i.test(name)) return true;
  if (sql && THREE_PART_QUOTED.test(sql)) return true;
  return false;
}

function sqlFromBlock(block: string): string | undefined {
  const cdata = block.match(/<!\[CDATA\[([\s\S]*?)\]\]>/);
  if (cdata && /select/i.test(cdata[1])) return cdata[1].trim();
  const sqlTag = block.match(/<sql[^>]*>([\s\S]*?)<\/sql>/i);
  if (sqlTag && /select/i.test(sqlTag[1])) return sqlTag[1].replace(/<!\[CDATA\[|\]\]>/g, "").trim();
  return undefined;
}

/** Physical (non-OTBI-logical) SQL from one `_datamodel.xdm` XML string, deduped. */
export function physicalSqlsFromXml(xml: string): string[] {
  const physical = new Set<string>();
  const dsRe = /<dataSet\b([^>]*)>([\s\S]*?)<\/dataSet>/gi;
  let m: RegExpExecArray | null;
  while ((m = dsRe.exec(xml)) !== null) {
    const attrs = m[1], block = m[2];
    const name = attrs.match(/name="([^"]*)"/i)?.[1] ?? "";
    const dataSourceRef = attrs.match(/dataSourceRef="([^"]*)"/i)?.[1];
    const sql = sqlFromBlock(block);
    if (sql && !isLogical(name, dataSourceRef, sql)) physical.add(sql);
  }
  return [...physical];
}

export interface ExtractedModel {
  modelPath: string;       // path of the .xdm within the (possibly nested) archive
  physicalSqls: string[];
}

/**
 * Walk an archive (recursing into nested .xdmz/.xdoz/.zip) and return the physical SQL of
 * every data model found. If `bytes` is a raw `_datamodel.xdm` (not a zip) it is parsed directly.
 */
export function extractModels(bytes: Buffer, rootName = ""): ExtractedModel[] {
  const out: ExtractedModel[] = [];
  let entries: Record<string, Buffer>;
  try {
    entries = unzipArchive(bytes);
  } catch {
    // Not a zip — maybe a raw .xdm XML upload.
    const head = bytes.subarray(0, 512).toString("utf8");
    if (/<dataModel|<dataSet\b/i.test(head)) {
      const sqls = physicalSqlsFromXml(bytes.toString("utf8"));
      if (sqls.length) out.push({ modelPath: rootName || "datamodel.xdm", physicalSqls: sqls });
    }
    return out;
  }
  for (const [name, buf] of Object.entries(entries)) {
    const lower = name.toLowerCase();
    const full = rootName ? path.posix.join(rootName, name) : name;
    if (lower.endsWith(".xdm")) {
      const sqls = physicalSqlsFromXml(buf.toString("utf8"));
      if (sqls.length) out.push({ modelPath: full, physicalSqls: sqls });
    } else if (lower.endsWith(".xdmz") || lower.endsWith(".xdoz") || lower.endsWith(".zip")) {
      out.push(...extractModels(buf, full));
    }
  }
  return out;
}
