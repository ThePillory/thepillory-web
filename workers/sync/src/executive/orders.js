// Executive orders' text, the authority each claims, and court records that
// mention them. Pure: no network (orders-sync.js fetches). Nothing is
// paraphrased: the text and the authority clause are the order's own words, and
// court records are listed as CourtListener and the courts record them.

const decode = (s) =>
  String(s || "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");

/**
 * The text of a Federal Register document from its "raw text" page (a <pre>
 * block of the printed page): the order from its "Executive Order N of …"
 * heading to the signature, with page markers and printing notes removed and
 * each paragraph on one line. The Register's `` and '' quotation marks become “ ”.
 */
export function cleanFrText(raw) {
  let t = String(raw || "");
  const pre = /<pre>([\s\S]*?)<\/pre>/i.exec(t);
  if (pre) t = pre[1];
  t = decode(t.replace(/<[^>]+>/g, "")).replace(/\u0000/g, "");
  const start = t.search(/^\s*Executive Order \d+ of /m);
  if (start > 0) t = t.slice(start);
  const end = t.search(/\[FR Doc\./);
  if (end > 0) t = t.slice(0, end);
  t = t
    .replace(/\[\[Page \d+\]\]/g, "")
    .replace(/<GRAPHIC\(S\) NOT AVAILABLE IN TIFF FORMAT>/g, "")
    .replace(/\(Presidential Sig\.\)/g, "")
    .replace(/``/g, "“")
    .replace(/''/g, "”");
  return t
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

/** The text of a Governor's signed order, from the PDF's pages: paragraphs kept, lines joined. */
export function cleanPdfText(pages) {
  return (pages || [])
    .join("\n\n")
    .replace(/\r/g, "")
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s*\n\s*/g, " ").replace(/[ \t]+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

const flat = (s) => String(s || "").replace(/\s+/g, " ").trim();

/**
 * The authority an order claims, word for word from its text, or null:
 *   the President's: "By the authority vested in me as President by the
 *     Constitution and the laws of the United States of America, [including …,]
 *     it is hereby ordered:"
 *   the Governor's: "NOW, THEREFORE, I, [name], Governor of the State of
 *     California, in accordance with the authority vested in me by …, do hereby
 *     issue the following Order …:"
 */
export function authorityClause(text) {
  const t = flat(text);
  const fed = /By (?:virtue of )?the authority vested in me[^:]{0,1500}?(?:hereby (?:ordered|order)|ordered as follows|I hereby (?:order|direct))[^:.]{0,80}[:.]/i.exec(t);
  if (fed) return fed[0];
  const ca = /NOW,? THEREFORE,? I,[^:]{0,1500}?(?:do hereby|hereby) (?:issue|order|proclaim|direct)[^:]{0,200}:/i.exec(t);
  if (ca) return ca[0];
  // Older orders: "By the authority vested in me …, I hereby …" ending a sentence.
  const any = /By (?:virtue of )?the authority vested in me[^.]{0,1500}\./i.exec(t);
  return any ? any[0] : null;
}

/** The search for court records that mention an order (CourtListener's query syntax). */
export function courtQuery(action) {
  const n = String(action.number || "").trim();
  if (!n) return null;
  if (String(action.id).startsWith("fr:")) return `"Executive Order ${n}" OR "Exec. Order No. ${n}" OR "E.O. ${n}"`;
  return `"Executive Order ${n}"`;
}

const CL = "https://www.courtlistener.com";
const clUrl = (path) => (/^\/[\w/-]+\/?$/.test(String(path || "")) ? `${CL}${path}` : null);

/** Dockets from a CourtListener RECAP search (type=r): each case and the matching filings, as docketed. */
export function parseDockets(json, max = 10) {
  const out = [];
  for (const r of (json && json.results) || []) {
    const url = clUrl(r.docket_absolute_url);
    if (!url || !r.caseName) continue;
    const entries = (r.recap_documents || [])
      .map((d) => ({ description: flat(d.description || d.short_description).slice(0, 300), date: d.entry_date_filed || null, url: clUrl(d.absolute_url) }))
      .filter((e) => e.description && e.url)
      .slice(0, 3);
    out.push({ kind: "docket", cl_id: String(r.docket_id || url), case_name: flat(r.caseName), court: r.court || null, date_filed: r.dateFiled || null, docket_number: r.docketNumber || null, url, entries });
    if (out.length >= max) break;
  }
  return out;
}

/** Opinions from a CourtListener opinion search (type=o). */
export function parseOpinions(json, max = 10) {
  const out = [];
  for (const r of (json && json.results) || []) {
    const url = clUrl(r.absolute_url);
    if (!url || !r.caseName) continue;
    out.push({ kind: "opinion", cl_id: String(r.cluster_id || url), case_name: flat(r.caseName), court: r.court || null, date_filed: r.dateFiled || null, docket_number: r.docketNumber || null, url, entries: [] });
    if (out.length >= max) break;
  }
  return out;
}
