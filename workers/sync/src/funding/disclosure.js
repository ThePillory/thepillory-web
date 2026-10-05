// Executive-branch money and disclosures: pure functions (no network), tested
// with saved responses. See docs/funding.md.
//
//   - Outside spenders: whether a group that spends for or against a candidate
//     discloses its donors to the FEC (a political committee does; a group that
//     files as a non-committee spender, FEC committee type I, doesn't have to).
//   - Inaugural committees (FEC Form 13): totals as reported, and the itemized
//     donations summed by organization. Individual donors are never named.
//   - Financial disclosure reports and ethics agreements from the Office of
//     Government Ethics (OGE), matched to an official by name.

// ---------------------------------------------------------------------------
// Outside spenders

/** FEC committee types that don't have to disclose their donors. */
export const UNDISCLOSED_TYPES = new Set(["I"]); // "Independent expenditure filer (not a committee)"

/** true if the spender's donors are disclosed to the FEC; null when unknown. */
export function donorsDisclosed(committeeType) {
  if (!committeeType) return null;
  return !UNDISCLOSED_TYPES.has(committeeType);
}

/**
 * A spender that is a person rather than a group: the FEC files people as
 * "LAST, FIRST". Their names aren't shown (ThePillory never names individuals
 * in money data); pages say "An individual" instead.
 */
const ORG_WORDS = /\b(INC|LLC|L\.L\.C|CORP|CORPORATION|CO|COMPANY|PAC|FUND|COMMITTEE|ACTION|ASSOCIATION|ASSN|UNION|COUNCIL|FOUNDATION|PARTY|CAUCUS|AMERICA|AMERICANS|PROJECT|ALLIANCE|COALITION|LEAGUE|NETWORK|INSTITUTE|CENTER|VOTERS|GROUP|LP|LTD|TRUST|PARTNERS|DBA)\b/i;
export function isPersonName(name) {
  const n = String(name || "").trim();
  return /^[A-Z][A-Z'.\- ]+, [A-Z][A-Z'.\- ]*$/i.test(n) && !ORG_WORDS.test(n);
}

/** /committees/ results → [{committee_id, name, committee_type}]. */
export function committeeTypes(results) {
  return (results || [])
    .filter((c) => c && c.committee_id)
    .map((c) => ({ committee_id: c.committee_id, name: String(c.name || "").trim() || null, committee_type: c.committee_type || null, committee_type_full: c.committee_type_full || null }));
}

// ---------------------------------------------------------------------------
// Inaugural committees (Form 13)

const iso = (d) => (d ? String(d).slice(0, 10) : null);
const addDays = (isoDate, n) => new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

/**
 * The inaugural committee for a presidential term that started on `termStart`:
 * a committee named "inaugural" that first filed between the election season
 * (150 days before the inauguration) and the inauguration itself.
 */
export function pickInauguralCommittee(results, termStart) {
  if (!termStart) return null;
  const from = addDays(termStart, -150);
  const hits = (results || []).filter((c) => /INAUGURAL/i.test(c.name || "") && !/REUNION|ANNIVERSARY|BALL\b/i.test(c.name || "") && c.first_file_date && iso(c.first_file_date) >= from && iso(c.first_file_date) <= termStart);
  hits.sort((a, b) => String(a.first_file_date).localeCompare(String(b.first_file_date)));
  return hits[0] || null;
}

/**
 * /filings/?form_type=F13 → the latest version of each report (an amendment
 * replaces the report it amends): [{report, coverage_start, coverage_end, total_receipts, ...}].
 */
export function latestReports(filings) {
  const by = new Map();
  for (const f of filings || []) {
    if (f.form_type && f.form_type !== "F13") continue;
    const report = String(f.document_description || f.report_type_full || "Form 13 report").trim();
    const k = `${report}|${iso(f.coverage_start_date)}`;
    const cur = by.get(k);
    if (!cur || String(f.receipt_date || "") > String(cur.receipt_date || "") || (f.receipt_date === cur.receipt_date && (f.file_number || 0) > (cur.file_number || 0))) by.set(k, f);
  }
  return [...by.values()]
    .map((f) => ({
      file_number: f.file_number == null ? null : String(f.file_number),
      report: String(f.document_description || "Form 13 report").trim(),
      coverage_start: iso(f.coverage_start_date),
      coverage_end: iso(f.coverage_end_date),
      receipt_date: iso(f.receipt_date),
      total_receipts: f.total_receipts == null ? null : Number(f.total_receipts),
      amended: f.amendment_indicator === "A" ? 1 : 0,
      pdf_url: /^https?:\/\//.test(f.pdf_url || "") ? f.pdf_url : null,
      fec_url: /^https?:\/\//.test(f.fec_url || "") ? f.fec_url : null,
    }))
    .sort((a, b) => String(a.coverage_start).localeCompare(String(b.coverage_start)));
}

/**
 * An electronic Form 13 (.fec, fields separated by \x1c) → its itemized
 * donations (F132 lines) summed: individuals as a count and total only;
 * organizations (and PACs and committees) by name. Refunds of donations (F133
 * lines) are summed separately. A line reads: form type, filer ID, transaction
 * ID, back reference, ..., entity type (IND, ORG, PAC, COM, CCM), organization
 * name, last name, first name, ..., donation date (YYYYMMDD), amount.
 */
const ENTITY = /^(IND|ORG|PAC|COM|CCM|CAN|PTY)$/;
export function parseForm13(text) {
  const out = { individuals: { count: 0, total: 0 }, organizations: new Map(), other: { count: 0, total: 0 }, refunds: { count: 0, total: 0 }, rows: 0, total: 0 };
  for (const line of String(text || "").split(/\r?\n/)) {
    const refund = /^F133\b/.test(line);
    if (!refund && !/^F132\b/.test(line)) continue;
    const f = line.split("\x1c").map((x) => x.replace(/^"|"$/g, "").trim());
    // The entity type sits in field 4 or 5 depending on the format version.
    const at = [4, 5, 3].find((i) => ENTITY.test((f[i] || "").toUpperCase()));
    const entity = at == null ? "" : f[at].toUpperCase();
    const orgName = at == null ? "" : f[at + 1] || "";
    // The amount follows the donation date (YYYYMMDD).
    let amount = null;
    for (let i = 6; i < f.length - 1; i++) {
      if (/^\d{8}$/.test(f[i]) && /^-?\d+(\.\d+)?$/.test(f[i + 1])) {
        amount = Number(f[i + 1]);
        break;
      }
    }
    if (amount == null) continue;
    if (refund) {
      out.refunds.count += 1;
      out.refunds.total = Math.round((out.refunds.total + amount) * 100) / 100;
      continue;
    }
    out.rows += 1;
    out.total = Math.round((out.total + amount) * 100) / 100;
    if (entity === "IND") {
      out.individuals.count += 1;
      out.individuals.total = Math.round((out.individuals.total + amount) * 100) / 100;
    } else if (orgName) {
      const name = orgName.replace(/\s+/g, " ").toUpperCase();
      if (/^UNITEMIZED/.test(name)) {
        out.other.count += 1;
        out.other.total = Math.round((out.other.total + amount) * 100) / 100;
        continue;
      }
      const o = out.organizations.get(name) || { name, total: 0, count: 0, entity };
      o.total = Math.round((o.total + amount) * 100) / 100;
      o.count += 1;
      out.organizations.set(name, o);
    } else {
      out.other.count += 1;
      out.other.total = Math.round((out.other.total + amount) * 100) / 100;
    }
  }
  out.organizations = [...out.organizations.values()].filter((o) => o.total > 0).sort((a, b) => b.total - a.total);
  return out;
}

/** true when the itemized donations add up to the report's own total (within 5%), so the breakdown can be shown. */
export function form13Consistent(parsed, reportTotal) {
  if (!parsed || !parsed.rows || !(reportTotal > 0)) return false;
  return Math.abs(parsed.total - reportTotal) / reportTotal <= 0.05;
}

export const fecCommitteePage = (id) => `https://www.fec.gov/data/committee/${id}/`;

// ---------------------------------------------------------------------------
// Office of Government Ethics (OGE) disclosures

export const OGE_API = "https://extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest";
export const OGE_SEARCH_PAGE = "https://www.oge.gov/web/OGE.nsf/Officials%20Individual%20Disclosures%20Search%20Collection?OpenForm";

const SUFFIX = /^(JR|SR|II|III|IV|V)\.?$/i;
const fold = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z\- ]/g, "").trim();

/** "Robert F. Kennedy Jr." → {first: "robert", last: "kennedy"}; "Lori Chavez-DeRemer" → last "chavez-deremer". */
export function nameParts(name) {
  const words = String(name || "").replace(/,/g, " ").split(/\s+/).filter(Boolean).filter((w) => !SUFFIX.test(w));
  if (words.length < 2) return null;
  return { first: fold(words[0]).replace(/\.$/, ""), last: fold(words[words.length - 1]) };
}

/** OGE's "Last, First M" matches an official named "First ... Last". */
export function ogeNameMatches(ogeName, official) {
  const p = nameParts(official);
  if (!p) return false;
  const [last, rest] = String(ogeName || "").split(",");
  if (!rest) return false;
  const first = fold(rest.trim().split(/\s+/)[0]);
  const lastF = fold(last);
  const lastOk = lastF === p.last || lastF.replace(/-/g, " ").split(" ").includes(p.last) || p.last.replace(/-/g, " ").split(" ").includes(lastF);
  return lastOk && !!first && (first === p.first || (first.length > 2 && p.first.startsWith(first)) || (p.first.length > 2 && first.startsWith(p.first)));
}

const decode = (s) =>
  String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">");

/**
 * One row of OGE's disclosure search → a disclosure row, or null. The "type"
 * cell is HTML: either a link to the document itself ("<a href=...pdf>Ethics
 * Agreement</a>") or the type with a link to OGE's request form ("278
 * Transaction (<a ...>Request this Document</a>)"), sometimes "(Amended 01/15/2026)".
 */
export function ogeRow(r) {
  if (!r || !r.name) return null;
  const html = decode(r.type);
  const href = (html.match(/href=['"]([^'"]+)['"]/) || [])[1] || null;
  const text = html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
  const amended = (text.match(/\(Amended ([0-9/]+)\)/) || [])[1] || null;
  const docType = text.replace(/\(Request this Document\)/i, "").replace(/\(Amended [0-9/]+\)/i, "").trim();
  if (!docType) return null;
  const url = href && /^https?:\/\//.test(href) ? href.replace(/\\\//g, "/") : null;
  const direct = !!url && !/201%20Request|201 Request/i.test(url);
  return {
    doc_type: docType,
    kind: /ethics agreement/i.test(docType) ? "ethics" : /278|financial disclosure/i.test(docType) ? "financial" : "other",
    name: String(r.name).trim(),
    agency: r.agency ? decode(r.agency).trim() : null,
    title: r.title ? decode(r.title).trim() : null,
    added_on: iso(r.docDate),
    amended_on: amended,
    document_url: direct ? url : null,
    request_url: direct ? null : url,
  };
}

/** A stable key for a disclosure row (OGE gives no ID). */
export function ogeKey(d) {
  return [d.name, d.doc_type, d.added_on, d.agency, d.title].map((x) => String(x || "")).join("|");
}

// ---------------------------------------------------------------------------
// California Form 700 (Statement of Economic Interests), from the FPPC's search
// (form700search.fppc.ca.gov). The search answers with each statement's filer,
// positions, filing type and year; the PDF link it gives is temporary, so the
// site asks for a fresh one when a reader opens a statement (/api/form700/<id>).

export const FPPC_SEARCH = "https://form700search.fppc.ca.gov";

/** The search request for every statement filed under a last name. */
export function fppcSearchBody(lastName) {
  return { searchFieldQueryInfos: [{ queryField: "FilerLastName", queryType: "Exact Match", filterValue: String(lastName || "").trim() }], showOnlyHeldPositions: false };
}

const officeKey = (s) =>
  fold(s)
    .replace(/^(state of california |california |state )/, "")
    .replace(/\s+/g, " ")
    .trim();

/**
 * The search's documents → disclosure rows for one official: the filer's first
 * and last name match, and one of the statement's positions is the official's
 * office (the position or the agency, e.g. "Governor"). Statements filed only
 * for other boards the official sits on are left out.
 */
export function fppcRows(documents, official) {
  const p = nameParts(official.name);
  if (!p) return [];
  const office = officeKey(official.office);
  const out = [];
  for (const d of documents || []) {
    const f = d && d.filer;
    if (!f || fold(f.lastName) !== p.last) continue;
    const first = fold(String(f.firstName || "").split(/\s+/)[0]);
    if (!(first === p.first || (first.length > 2 && p.first.startsWith(first)) || (p.first.length > 2 && first.startsWith(p.first)))) continue;
    const pos = (d.filingPositions || []).find((x) => officeKey(x.position) === office || officeKey(x.agency) === office);
    if (!pos || !d.indexID) continue;
    const info = d.filingInfo || {};
    out.push({
      index_id: String(d.indexID),
      doc_type: `Form 700, ${pos.filingType || "statement"}`,
      filing_type: pos.filingType || null,
      period: pos.filingYear ? String(pos.filingYear) : null,
      filed_on: iso(info.filedDate),
      amended: !!info.isAmendment,
      position: pos.position || null,
      agency: pos.agency || null,
      no_interests: !!info.noReportableInterests,
      // What the FPPC needs to hand out the statement's PDF (see /api/form700/<id>).
      pdf: {
        "fileNameInfo.LastName": f.lastName, "fileNameInfo.FirstName": f.firstName, "fileNameInfo.FilingYear": pos.filingYear,
        "fileNameInfo.Agency": pos.agency, "fileNameInfo.Position": pos.position, "fileNameInfo.FilingType": pos.filingType,
        "fileNameInfo.IsAmendment": info.isAmendment ? "true" : "false", "fileNameInfo.FilingDate": info.filedDate,
      },
    });
  }
  return out.sort((a, b) => String(b.filed_on).localeCompare(String(a.filed_on)));
}

/** The FPPC request for a fresh PDF link, from a stored row's index ID and details. */
export function fppcPdfUrl(indexId, pdf, base = FPPC_SEARCH) {
  const q = new URLSearchParams({ indexID: indexId });
  for (const [k, v] of Object.entries(pdf || {})) q.set(k, v == null ? "" : String(v));
  return `${base.replace(/\/$/, "")}/Home/GetRedactedFormPdf?${q}`;
}

/** The search's answer is JSON, sometimes encoded twice (a JSON string of JSON). */
export function fppcParse(text) {
  let d = JSON.parse(text);
  if (typeof d === "string") d = JSON.parse(d);
  return d || {};
}
