/**
 * XML-entity decode for text that reached us through an escaped-XML surface WITHOUT a real XML
 * parser (the pod dictionary export: BIP report -> XML -> CSV kept `&quot;`/`&apos;` in
 * REMARKS/VIEW_TEXT — 2,308 hits in META_TABLES.csv alone).
 *
 * SCOPE IS DELIBERATE: apply ONLY where contamination is systemic (schema CSV text fields, view
 * SQL). NEVER apply to bip-report SQL — its two entity "hits" are string LITERALS inside REPLACE()
 * escaping logic (Irish payroll Revenue models); decoding would change the report's semantics.
 */

/** Decode the five XML named entities + common numeric forms. `&amp;` is decoded LAST so a
 *  double-escaped `&amp;quot;` collapses in one pass without inventing new entities. */
export function decodeXmlEntities(s: string): string {
  if (!s || s.indexOf("&") === -1) return s;
  return s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#34;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** True when the text still contains a decodable entity (verification/counting helper). */
export function hasXmlEntities(s: string | null | undefined): boolean {
  return !!s && /&(quot|apos|lt|gt|amp|#39|#34);/.test(s);
}
