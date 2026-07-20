/**
 * Deterministic business-domain classifier for a report query, used to make findSimilarQueries
 * domain-aware: detect when the corpus matches for a request split across domains (the ambiguity
 * trap, e.g. "department" -> HCM org unit vs Financials COA segment; "invoice" -> AP supplier
 * invoice vs AR customer invoice) so the agent is forced to disambiguate instead of guessing.
 *
 * Classification key is `Domain` or `Domain/Sub` (sub-domain = Fusion module, currently only for
 * Financials where sub-ledger splits are genuine ambiguity: AP vs AR vs GL vs Budgetary ...).
 *
 * PRIMARY signal: the table's application module from the catalog (`tables.module`, loaded from
 * META_TABLES.APPLICATION_SHORT_NAME) via the `moduleOf` lookup the caller provides.
 * FALLBACK: table-name prefix rules (tables missing from META_TABLES), then title keywords.
 */

// Fusion application module -> domain key. Modules not listed are treated as non-determining.
const MODULE_DOMAIN: Record<string, string> = {
  // --- Financials (sub-domain per sub-ledger — these splits ARE user-facing ambiguity) ---
  AP: "Financials/AP", AR: "Financials/AR", GL: "Financials/GL", XCC: "Financials/Budgetary",
  FA: "Financials/FA", FAI: "Financials/FA", CE: "Financials/Cash", ZX: "Financials/Tax",
  IBY: "Financials/Payments", XLA: "Financials/SLA", IEX: "Financials/Collections",
  FUN: "Financials/Intercompany", EXM: "Financials/Expenses", FV: "Financials/GL",
  JA: "Financials/Regional", JE: "Financials/Regional", JG: "Financials/Regional",
  JL: "Financials/Regional", JV: "Financials/Regional", JMF: "Financials/Regional",
  // --- HCM ---
  PER: "HCM", HRC: "HCM", HRT: "HCM", HRA: "HCM", HRD: "HCM", HRE: "HCM", HRG: "HCM",
  HRL: "HCM", HRM: "HCM", HRQ: "HCM", HRR: "HCM", HRS: "HCM", HRW: "HCM", HRX: "HCM",
  HRY: "HCM", HHR: "HCM", HCO: "HCM", HMO: "HCM", HNS: "HCM", HQZ: "HCM", HTS: "HCM",
  HWM: "HCM", HWP: "HCM", HWR: "HCM", HWR_HQZ: "HCM", HXT: "HCM", CMP: "HCM", BEN: "HCM",
  ANC: "HCM", IRC: "HCM", WLF: "HCM", ACA: "HCM",
  // --- Payroll ---
  PAY: "Payroll", FF: "Payroll", FFS: "Payroll",
  // --- Procurement ---
  PO: "Procurement", POI: "Procurement", PON: "Procurement", POQ: "Procurement",
  POR: "Procurement", POS: "Procurement", POZ: "Procurement",
  // --- SCM ---
  INV: "SCM", EGI: "SCM", EGO: "SCM", EGP: "SCM", EGS: "SCM", MSC: "SCM", CST: "SCM",
  CTO: "SCM", DOO: "SCM", DOS: "SCM", WIE: "SCM", WIS: "SCM", WSH: "SCM", RCV: "SCM",
  QP: "SCM", QA: "SCM", CMR: "SCM", VCS: "SCM", LCM: "SCM", MNT: "SCM", CJM: "SCM",
  CZ: "SCM", GTR: "SCM",
  // --- Projects (+ Grants) ---
  PJB: "Projects", PJC: "Projects", PJE: "Projects", PJF: "Projects", PJG: "Projects",
  PJL: "Projects", PJO: "Projects", PJR: "Projects", PJS: "Projects", PJT: "Projects",
  GMS: "Projects",
  // --- CRM ---
  SVC: "CRM-Service", CSO: "CRM-Service", CSE: "CRM-Service",
  ZCA: "CRM-Sales", ZBS: "CRM-Sales", ZCC: "CRM-Sales", ZCH: "CRM-Sales", ZCQ: "CRM-Sales",
  ZCX: "CRM-Sales", ZMM: "CRM-Sales", ZMS: "CRM-Sales", ZOC: "CRM-Sales", ZOE: "CRM-Sales",
  ZPM: "CRM-Sales", ZPS: "CRM-Sales", ZPS_365: "CRM-Sales", ZSF: "CRM-Sales", ZSO: "CRM-Sales",
  ZSP: "CRM-Sales", MKL: "CRM-Sales", MKT: "CRM-Sales", CMK: "CRM-Sales", MOO: "CRM-Sales",
  MOW: "CRM-Sales", CN: "CRM-Sales", CPQ: "CRM-Sales", OKC: "CRM-Sales", LOY: "CRM-Sales",
  // --- Higher Education / Public Sector ---
  HEA: "Higher-Education", HED: "Higher-Education", HEF: "Higher-Education",
  HEQ: "Higher-Education", HER: "Higher-Education", HES: "Higher-Education",
  HEX: "Higher-Education", HEY: "Higher-Education", HEY_OBJECT: "Higher-Education",
  PSC: "Public-Sector", PSC_BL: "Public-Sector", PSC_CC: "Public-Sector",
  PSC_CE: "Public-Sector", PSC_COM: "Public-Sector", PSC_E: "Public-Sector",
  PSC_PER: "Public-Sector", PSC_PZ: "Public-Sector", PSC_TS: "Public-Sector",
};
// shared/technical modules that do NOT determine a domain (FND, TCA parties, legal entities, ...)
const GENERIC_MODULES = new Set(["FND", "HZ", "XLE", "ATK", "FUSION", "ADF", "ECSF", "GTG"]);

// fallback: table-name prefix -> domain key (first match wins; order = specificity)
const PREFIX_DOMAIN: [RegExp, string][] = [
  [/^AP_/, "Financials/AP"],
  [/^(AR_|RA_)/, "Financials/AR"],
  [/^GL_/, "Financials/GL"],
  [/^XCC_/, "Financials/Budgetary"],
  [/^FA_/, "Financials/FA"],
  [/^CE_/, "Financials/Cash"],
  [/^ZX_/, "Financials/Tax"],
  [/^IBY_/, "Financials/Payments"],
  [/^XLA_/, "Financials/SLA"],
  [/^IEX_/, "Financials/Collections"],
  [/^FUN_/, "Financials/Intercompany"],
  [/^(PER_|HR_|HRT_|HRG_|HRC_|CMP_|ANC_|IRC_|HRA_|HRY_|HCM_|BEN_)/, "HCM"],
  [/^PAY_/, "Payroll"],
  [/^(PO_|POZ_|PON_|PRC_|POR_|POQ_)/, "Procurement"],
  [/^(INV_|EGP_|EGO_|MSC_|WIE_|WIS_|WSH_|DOO_|QP_|CST_|RCV_|CMR_|VCS_)/, "SCM"],
  [/^PJ[A-Z]_/, "Projects"],
  [/^(SVC_|CS_|CSO_|CSF_|CSR_)/, "CRM-Service"],
  [/^(ZCA_|ZCX_|ZSP_|MOO_|MOW_|MKL_|MKT_|ZPM_)/, "CRM-Sales"],
];

// generic/shared tables that do NOT by themselves determine a domain
const GENERIC_PREFIX = /^(FND_|HZ_|XLE_|GHR_|ATK_|ESS_)/i;
// flexfield / value-set / tree tables — in report context these are chart-of-accounts (GL)
const FLEXFIELD = /(FND_VS_|FND_ID_FLEX|FND_FLEX_|FND_SEGMENT_ATTR|FND_TREE)/i;

function stripSchema(t: string): string {
  return t.replace(/^[a-z0-9_]+\./i, "").toUpperCase();
}

/** Top-level part of a domain key ("Financials/AP" -> "Financials"). */
export function topDomain(key: string): string {
  return key.split("/")[0];
}

/**
 * Domain key for a single report query. `moduleOf` resolves a table name to its Fusion
 * application module from the catalog (authoritative); omit to rely on prefix rules only.
 */
export function classifyDomain(
  tablesUsed: string[], title = "", moduleOf?: (table: string) => string | undefined,
): string {
  const counts: Record<string, number> = {};
  let flex = false;
  for (const raw of tablesUsed ?? []) {
    const t = stripSchema(raw);
    if (FLEXFIELD.test(t)) flex = true;

    // primary: catalog module
    const mod = moduleOf?.(t)?.toUpperCase();
    if (mod) {
      if (GENERIC_MODULES.has(mod)) continue;
      const dom = MODULE_DOMAIN[mod];
      if (dom) { counts[dom] = (counts[dom] ?? 0) + 1; continue; }
    }

    // fallback: name prefix
    if (GENERIC_PREFIX.test(t)) continue;
    for (const [re, dom] of PREFIX_DOMAIN) {
      if (re.test(t)) { counts[dom] = (counts[dom] ?? 0) + 1; break; }
    }
  }
  const doms = Object.keys(counts);
  if (doms.length) return doms.sort((a, b) => counts[b] - counts[a])[0];

  // only generic/flexfield tables -> flexfield => chart-of-accounts (Financials/GL)
  if (flex) return "Financials/GL";

  // fallback: subject-area / report title keywords
  const s = (title || "").toUpperCase();
  if (/\bHCM\b|HUMAN CAPITAL|ABSENCE|WORKFORCE|TALENT|GOAL|ASSIGNMENT|EMPLOYEE|WORKER|PERSON/.test(s)) return "HCM";
  if (/PAYROLL/.test(s)) return "Payroll";
  if (/PAYABLE/.test(s)) return "Financials/AP";
  if (/RECEIVABLE/.test(s)) return "Financials/AR";
  if (/BUDGETARY/.test(s)) return "Financials/Budgetary";
  if (/GENERAL LEDGER|LEDGER|JOURNAL/.test(s)) return "Financials/GL";
  if (/FINANCIAL|\bCASH\b|\bTAX\b|ASSET/.test(s)) return "Financials";
  if (/PROCUREMENT|PURCHAS|SUPPLIER|\bSPEND\b|REQUISITION/.test(s)) return "Procurement";
  if (/INVENTORY|MANUFACTUR|\bCOST\b|ORDER MANAGE|SUPPLY CHAIN|SHIPMENT|RECEIPT/.test(s)) return "SCM";
  if (/\bPROJECT\b/.test(s)) return "Projects";
  if (/SERVICE|HELP DESK|\bCRM\b|CASE\b/.test(s)) return "CRM-Service";
  if (/SALES|OPPORTUNIT|LEAD\b|CAMPAIGN/.test(s)) return "CRM-Sales";
  return "Other";
}
