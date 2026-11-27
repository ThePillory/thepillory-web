// Campaign finance reports as events (migration 0053, docs/funding.md "Filings as events").
// Pure: no D1, no fetch. Used by the funding steps (rows), This week (functions/_lib/quick-home.js)
// and the weekly email (src/email/edition.js) for the one sentence they show.
//
// The wording is fixed and neutral: who filed, what the report states it raised and spent, the
// period, the agency. Never a donor, a comparison, a ranking or anything tying money to a vote.

const iso = (d) => (d ? String(d).slice(0, 10) : null);
const isHttp = (u) => /^https?:\/\//.test(String(u || ""));

// FEC report types that are a campaign's regular reports: quarterly, year-end, and the pre- and
// post-election reports (12-day pre-primary/general/runoff/special/convention, 30-day post).
// Not 48-hour notices (a separate form), monthly reports or termination reports.
export const FEC_REPORT_TYPES = new Set(["Q1", "Q2", "Q3", "YE", "12P", "12G", "12R", "12S", "12C", "30G", "30R", "30S", "30P"]);

/**
 * FEC /filings/ rows (Form 3, the principal campaign committee) → the latest version of each regular
 * report (an amendment replaces the report it amends): rows for money_filings, keyed by period.
 */
export function fecFilingRows(results, officialId, committeeId) {
  const by = new Map();
  for (const f of results || []) {
    if (f.form_type && !/^F3P?$/.test(f.form_type)) continue;
    if (!FEC_REPORT_TYPES.has(String(f.report_type || "").toUpperCase())) continue;
    const start = iso(f.coverage_start_date);
    const end = iso(f.coverage_end_date);
    const filed = iso(f.receipt_date);
    if (!start || !end || !filed) continue;
    if (f.total_receipts == null && f.total_disbursements == null) continue;
    const k = `${start}|${end}`;
    const cur = by.get(k);
    if (!cur || filed > cur.filed || (filed === cur.filed && Number(f.file_number || 0) > Number(cur.file_number || 0))) {
      const url = isHttp(f.pdf_url) ? f.pdf_url : isHttp(f.fec_url) ? f.fec_url : `https://www.fec.gov/data/committee/${committeeId}/?tab=filings`;
      by.set(k, {
        official_id: officialId,
        agency: "FEC",
        committee_id: committeeId,
        period_start: start,
        period_end: end,
        report: String(f.report_type_full || f.document_description || "").replace(/\s*\{.*\}\s*$/, "").trim() || null,
        raised: f.total_receipts == null ? null : Number(f.total_receipts),
        spent: f.total_disbursements == null ? null : Number(f.total_disbursements),
        filed,
        source_url: url,
        file_number: f.file_number,
      });
    }
  }
  return [...by.values()].map(({ file_number, ...r }) => r);
}

/**
 * One California official's committees from data/ca-campaign.json → money_filings rows, one per
 * statement (Form 460) with a filed date; an amendment replaces the statement it amends.
 */
export function calAccessFilingRows(officialId, entry) {
  const by = new Map();
  for (const c of (entry && entry.committees) || []) {
    if (!c.filer_id) continue;
    for (const r of c.reports || []) {
      const start = iso(r.from);
      const end = iso(r.thru);
      const filed = iso(r.filed);
      if (!start || !end || !filed || !isHttp(r.source_url)) continue;
      if (r.contributions == null && r.expenditures == null) continue;
      const k = `${c.filer_id}|${start}|${end}`;
      const cur = by.get(k);
      if (cur && (cur.amend > (r.amend_id || 0) || (cur.amend === (r.amend_id || 0) && cur.filed >= filed))) continue;
      by.set(k, {
        official_id: officialId,
        agency: "Cal-Access",
        committee_id: String(c.filer_id),
        period_start: start,
        period_end: end,
        report: null,
        raised: r.contributions == null ? null : Number(r.contributions),
        spent: r.expenditures == null ? null : Number(r.expenditures),
        filed,
        source_url: r.source_url,
        amend: r.amend_id || 0,
      });
    }
  }
  return [...by.values()].map(({ amend, ...r }) => r);
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const day = (d) => `${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${parseInt(d.slice(8, 10), 10)}`;

/** "April 1 to June 30, 2026" (or "October 1, 2025 to March 31, 2026" across a year). */
export function periodWords(start, end) {
  if (!start || !end) return "";
  return start.slice(0, 4) === end.slice(0, 4) ? `${day(start)} to ${day(end)}, ${end.slice(0, 4)}` : `${day(start)}, ${start.slice(0, 4)} to ${day(end)}, ${end.slice(0, 4)}`;
}

const dollars = (n) => `$${Math.round(Number(n)).toLocaleString("en-US")}`;

/**
 * The filings of one official for one period from one agency, combined: a California official can
 * control several committees, each filing its own statement. → { raised, spent, url, count }.
 */
export function combine(rows) {
  const sum = (k) => (rows.some((r) => r[k] != null) ? rows.reduce((s, r) => s + (r[k] || 0), 0) : null);
  return { raised: sum("raised"), spent: sum("spent"), url: rows.length === 1 ? rows[0].source_url : null, count: rows.length, filed: rows.reduce((m, r) => (r.filed > m ? r.filed : m), "") };
}

/**
 * The one sentence: "[Name]'s campaign reported raising $X and spending $Y, April 1 to June 30, 2026 (FEC)."
 * Several California committees in one period: "[Name]'s campaign committees reported …". A figure
 * the report doesn't state is left out rather than shown as $0.
 */
export function filingSentence(name, agency, start, end, c) {
  const who = `${name}'s campaign${c.count > 1 ? " committees" : ""}`;
  const parts = [c.raised != null ? `raising ${dollars(c.raised)}` : "", c.spent != null ? `spending ${dollars(c.spent)}` : ""].filter(Boolean);
  if (!parts.length) return null;
  return `${who} reported ${parts.join(" and ")}, ${periodWords(start, end)} (${agency}).`;
}

/**
 * money_filings rows (with each official's name and slug) → events, one per official, agency and
 * period, newest filed first: { official_id, slug, name, agency, date, text, href }. A combined event
 * with several committees links to the official's Funding tab, where every statement is listed.
 */
export function filingEvents(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    const k = `${r.official_id}|${r.agency}|${r.period_start}|${r.period_end}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const out = [];
  for (const g of groups.values()) {
    const r = g[0];
    const c = combine(g);
    const text = filingSentence(r.name, r.agency, r.period_start, r.period_end, c);
    if (!text) continue;
    out.push({ official_id: r.official_id, slug: r.slug, name: r.name, agency: r.agency, date: c.filed, text, href: c.url || `/reps/${r.slug}/#funding` });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
}

/** The query for a set of officials' filings received in [since, until]: bind since, until, ...ids. */
export const filingsSql = (n) =>
  `SELECT f.official_id, f.agency, f.committee_id, f.period_start, f.period_end, f.raised, f.spent, f.filed, f.source_url, o.name, o.slug
   FROM money_filings f JOIN officials o ON o.id = f.official_id
   WHERE f.filed >= ? AND f.filed <= ? AND f.official_id IN (${Array(n).fill("?").join(",")})`;
