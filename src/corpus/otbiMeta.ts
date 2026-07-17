const SEC = /GET_USER_PERSONID|HRC_SESSION_UTIL|FND_GLOBAL/i;

export function otbiMeta(raw: any) {
  const rel = raw?.relations ?? {};
  const allFilters: string[] = Array.isArray(rel.filters) ? rel.filters : [];
  const securityPredicate = allFilters.find((f) => SEC.test(f)) ?? null;
  const filters = allFilters.filter((f) => !SEC.test(f));
  return {
    tablesUsed: Array.isArray(rel.dbTables) ? rel.dbTables : [],
    lookupTypes: Array.isArray(rel.lookupTypes) ? rel.lookupTypes : [],
    joins: Array.isArray(rel.joins) ? rel.joins : [],
    filters,
    securityPredicate,
  };
}
