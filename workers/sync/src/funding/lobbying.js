// Lobbying reports (LD-2) from lda.gov that mention a bill. Pure functions; tested.
// API: https://lda.gov/api/redoc/v1/ (formerly lda.senate.gov; no key needed).
//
// Reports describe issues in free text ("H.R. 4, Rescissions Act of 2025 -
// funding for …"), so a bill is found by searching for its number, and every
// mention is then checked here:
//   - the number must be the whole number ("H.R. 4" isn't "H.R. 40");
//   - bill numbers restart every Congress, so a mention next to another Congress
//     ("118th Congress S 1071") is set aside, and so is one followed by a
//     different bill's title ("H.R. 1, Lower Energy Costs Act" when this
//     Congress's H.R. 1 has another title).
// What remains can still be wrong; every report links to the filing itself.
import { classify } from "./industry.js";

export const API = "https://lda.gov/api/v1";

/** Years a Congress spans: the 119th is 2025–2026. */
export function congressYears(congress) {
  const first = 2 * parseInt(congress, 10) + 1787;
  return [first, first + 1];
}

/** The search phrases for a bill number, as reports write it: "H.R. 4" and "H.R.4". */
export function billQueries(billNumber) {
  const n = String(billNumber || "").replace(/\s+/g, " ").trim();
  const tight = n.replace(/\.\s+(?=\d)/, ".");
  return [...new Set([n, tight])].filter(Boolean);
}

/** A regular expression that finds the bill number written any common way. */
export function mentionPattern(billNumber) {
  const m = /^([A-Za-z.\s]+?)\s*(\d+)$/.exec(String(billNumber || "").trim());
  if (!m) return null;
  const letters = m[1].replace(/[\s.]/g, "").split("");
  // "H.J.Res." → H J R e s: each letter may be followed by a period and spaces;
  // "Res" stays one word.
  const prefix = m[1]
    .replace(/\s+/g, "")
    .split(".")
    .filter(Boolean)
    .map((part) => part.split("").join(""))
    .map((part) => `${part.replace(/[^A-Za-z]/g, "")}\\.?\\s*`)
    .join("");
  if (!letters.length) return null;
  return new RegExp(`(?<![A-Za-z.])${prefix}${m[2]}(?![\\d])`, "gi");
}

const STOP = new Set(["act", "acts", "bill", "the", "and", "for", "with", "from", "fiscal", "year", "years", "united", "states", "national", "american", "america", "amend", "certain", "other", "purposes", "this", "that"]);
const words = (s) => new Set(String(s || "").toLowerCase().match(/[a-z]{4,}/g)?.filter((w) => !STOP.has(w)) || []);

/**
 * Is this mention about this Congress's bill? `text` is the report's issue
 * description; `at`/`len` the match. Returns false for a nearby different
 * Congress or a different bill's title right after the number.
 */
export function sameBill(text, at, len, bill, congress) {
  const before = text.slice(Math.max(0, at - 60), at);
  const after = text.slice(at + len, at + len + 160);
  const other = (s) => [...s.matchAll(/(\d{2,3})(?:st|nd|rd|th)\s+Congress/gi)].some((m) => parseInt(m[1], 10) !== parseInt(congress, 10));
  if (other(before.slice(-30)) || other(after.slice(0, 40))) return false;
  // A title right after the number: "H.R. 1, One Big Beautiful Bill Act".
  const t = /^\s*[,:–—-]?\s*\(?\s*(?:the\s+)?((?:[A-Z0-9][\w'’&.-]*\s+){0,14}?(?:Act|Resolution)\b(?:\s+of\s+\d{4})?)/.exec(after);
  if (t) {
    const theirs = words(t[1]);
    const ours = words(bill.title);
    if (theirs.size && ours.size && ![...theirs].some((w) => ours.has(w))) return false;
  }
  return true;
}

/** The report's own words around the mention, for the bill page. */
export function excerpt(text, at, len) {
  const start = Math.max(0, at - 100);
  const end = Math.min(text.length, at + len + 180);
  return `${start > 0 ? "…" : ""}${text.slice(start, end).replace(/\s+/g, " ").trim()}${end < text.length ? "…" : ""}`;
}

/** The activities in one filing that mention the bill: [{issue_code, excerpt}]. */
export function mentionsIn(filing, bill, congress) {
  const re = mentionPattern(bill.bill_number);
  if (!re) return [];
  const out = [];
  for (const a of filing.lobbying_activities || []) {
    const text = String(a.description || "");
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      if (sameBill(text, m.index, m[0].length, bill, congress)) {
        out.push({ issue_code: a.general_issue_code || null, excerpt: excerpt(text, m.index, m[0].length) });
        break;
      }
    }
  }
  return out;
}

const amount = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));

/** A lobbying_filings row. The amount covers the whole report (every issue), not just this bill. */
export function filingRow(f) {
  const client = f.client || {};
  const registrant = f.registrant || {};
  const income = amount(f.income);
  const expenses = amount(f.expenses);
  return {
    filing_uuid: f.filing_uuid,
    client_name: String(client.name || registrant.name || "").trim(),
    client_description: client.general_description || null,
    registrant_name: String(registrant.name || "").trim(),
    filing_year: f.filing_year,
    filing_period: f.filing_period_display || f.filing_period || null,
    filing_type: f.filing_type || null,
    posted_at: f.dt_posted || null,
    registrant_id: registrant.id || null,
    client_id: client.id || null,
    amount: income != null ? income : expenses,
    amount_kind: income != null ? "income" : expenses != null ? "expenses" : null,
    industry: classify(client.name, client.general_description),
    source_url: f.filing_document_url || f.url,
  };
}
