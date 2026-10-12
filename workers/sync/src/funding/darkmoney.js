// Dark money: pure functions, tested with responses shaped like the FEC's and
// ProPublica's (workers/sync/test/darkmoney.test.mjs). See docs/funding.md.
//
//   - An outside spender that reports its donors (a super PAC, a PAC, a party):
//     its largest donors that are organizations, from FEC Schedule A, summed by
//     donor. Only contribution lines count: contributions (lines 11A–11C),
//     transfers (12), and "other receipts" (17) the filer itself labels a
//     contribution; never loans, refunds, rebates, interest or dividends.
//     Individuals are never read (the FEC's is_individual=false), and an
//     organization named for a person (a family trust) isn't listed.
//   - Each donor is labeled: a political committee (it reports its own donors
//     to the FEC), an LLC (by its name), a 501(c)(4) or 501(c)(6) (from the
//     IRS record, matched by exact name and state, one match only), or another
//     organization. LLCs, 501(c)(4)s and 501(c)(6)s don't have to disclose who
//     funds them, so their share of the spender's reported money is shown.
//   - Nonprofits' IRS Form 990 figures, as ProPublica's Nonprofit Explorer
//     extracts them from the IRS's files.
//   - Electioneering communications (FEC Form 9), by candidate.
import { isPersonName } from "./disclosure.js";

export const PROPUBLICA = "https://projects.propublica.org/nonprofits/api/v2";
export const FEC_LINES = ["F3X-11AI", "F3X-11B", "F3X-11C", "F3X-12", "F3X-17"];
export const fecCommitteePage = (id) => `https://www.fec.gov/data/committee/${id}/`;
export const irsRecord = (ein) => `https://apps.irs.gov/app/eos/details/?ein=${String(ein).replace(/\D/g, "").padStart(9, "0")}`;
export const nonprofitPage = (ein) => `https://projects.propublica.org/nonprofits/organizations/${String(ein).replace(/\D/g, "")}`;
export const SUBSECTIONS = { 4: "501(c)(4)", 6: "501(c)(6)" };
export const DARK_KINDS = new Set(["llc", "c4", "c6"]);

/** Is this Schedule A row a contribution, by its line and the filer's own label? */
export function isContribution(r) {
  const line = String(r.line_number || "").toUpperCase();
  if (/^11[ABC]/.test(line) || line === "12") return true;
  if (line === "17") return /CONTRIBUTION/i.test(String(r.receipt_type_full || r.receipt_type_desc || ""));
  return false;
}

/** An organization a person's name is on: a family or revocable trust, or a name the FEC files as "LAST, FIRST". */
export function namesAPerson(name, entityType) {
  if (["IND", "CAN"].includes(String(entityType || "").toUpperCase())) return true;
  const n = String(name || "");
  return isPersonName(n) || (/\bTRUST\b/i.test(n) && /\b(FAMILY|REVOCABLE|LIVING|IRREVOCABLE|DECLARATION)\b/i.test(n));
}

export const isLLC = (name) => /\bL\.?\s?L\.?\s?C\.?(?=$|[\s,.)])/i.test(String(name || ""));

/** A name for matching: upper case, punctuation and "Inc", "The", "Corp" dropped. */
export function orgKey(name) {
  return String(name || "")
    .toUpperCase()
    .replace(/&/g, " AND ")
    .replace(/[^A-Z0-9 ]+/g, " ")
    .split(/\s+/)
    .filter((w) => w && !["INC", "INCORPORATED", "CORP", "CORPORATION", "THE", "CO", "LTD", "LLC"].includes(w))
    .join(" ");
}

/**
 * Schedule A rows (organizations) → donors, largest first:
 * [{name, kind, donor_committee_id, state, total, count, first_date, last_date, source_url}].
 * kind is 'committee', 'llc' or 'org' here; 'c4'/'c6' come from the IRS lookup.
 */
export function aggregateDonors(rows, spenderId, cycle) {
  const by = new Map();
  let counted = 0;
  for (const r of rows || []) {
    if (r.is_individual === true || !isContribution(r) || r.memo_code === "X") continue;
    const name = String(r.contributor_name || "").replace(/\s+/g, " ").trim();
    if (!name || namesAPerson(name, r.entity_type)) continue;
    const amount = Number(r.contribution_receipt_amount) || 0;
    if (amount <= 0) continue;
    counted += amount;
    const committeeId = /^C\d{8}$/.test(r.contributor_id || "") ? r.contributor_id : null;
    const state = String(r.contributor_state || "").toUpperCase() || null;
    const key = committeeId || `${orgKey(name)}|${state || ""}`;
    const d = by.get(key) || {
      name,
      kind: committeeId ? "committee" : isLLC(name) ? "llc" : "org",
      donor_committee_id: committeeId,
      state,
      total: 0,
      count: 0,
      first_date: null,
      last_date: null,
      largest: 0,
      source_url: committeeId ? fecCommitteePage(committeeId) : null,
    };
    d.total = Math.round((d.total + amount) * 100) / 100;
    d.count += 1;
    const date = String(r.contribution_receipt_date || "").slice(0, 10) || null;
    if (date && (!d.first_date || date < d.first_date)) d.first_date = date;
    if (date && (!d.last_date || date > d.last_date)) d.last_date = date;
    // Not a committee: link the report page with its largest receipt.
    if (!committeeId && amount > d.largest && /^https?:/.test(r.pdf_url || "")) {
      d.largest = amount;
      d.source_url = r.pdf_url;
    }
    by.set(key, d);
  }
  const donors = [...by.values()]
    .map(({ largest, ...d }) => ({ ...d, source_url: d.source_url || `https://www.fec.gov/data/receipts/?committee_id=${spenderId}&two_year_transaction_period=${cycle}` }))
    .sort((a, b) => b.total - a.total);
  return { donors, counted: Math.round(counted * 100) / 100 };
}

/**
 * ProPublica search results → the one organization with exactly this name (and
 * this state, when the donor's state is known), or null. Never guessed: two
 * matches, or none, is null.
 */
export function pickNonprofit(organizations, name, state) {
  const key = orgKey(name);
  const hits = (organizations || []).filter((o) => orgKey(o.name) === key && (!state || !o.state || String(o.state).toUpperCase() === state));
  if (hits.length !== 1) return null;
  return { ein: String(hits[0].ein), subsection: hits[0].subseccd == null ? null : Number(hits[0].subseccd), state: hits[0].state || null, name: hits[0].name };
}

/** The share of a spender's reported receipts that came from LLCs, 501(c)(4)s and 501(c)(6)s, in whole percent. */
export function darkShare(darkTotal, receipts) {
  if (!receipts || receipts <= 0) return null;
  return Math.round((100 * darkTotal) / receipts);
}

/** ProPublica's organization record → a nonprofits row (Form 990 figures as extracted from the IRS's files). */
export function nonprofitRow(d) {
  const o = (d && d.organization) || {};
  if (!o.ein) return null;
  const f = ((d.filings_with_data || []).slice().sort((a, b) => (b.tax_prd || 0) - (a.tax_prd || 0)))[0] || null;
  const num = (x) => (x == null || x === "" || !Number.isFinite(Number(x)) ? null : Number(x));
  return {
    ein: String(o.ein),
    name: String(o.name || "").trim(),
    subsection: o.subsection_code == null ? null : Number(o.subsection_code),
    state: o.state || null,
    tax_year: f ? num(f.tax_prd_yr) : null,
    period_end: f && f.tax_prd ? `${String(f.tax_prd).slice(0, 4)}-${String(f.tax_prd).slice(4, 6)}` : null,
    revenue: f ? num(f.totrevenue) : null,
    expenses: f ? num(f.totfuncexpns) : null,
    filing_url: f && /^https?:/.test(f.pdf_url || "") ? f.pdf_url : null,
    source_url: nonprofitPage(o.ein),
  };
}

/** FEC /electioneering/ results → electioneering rows (one per disbursement and candidate). */
export function electioneeringRows(results, cycle) {
  const out = [];
  for (const r of results || []) {
    const amount = Number(r.calculated_candidate_share ?? r.disbursement_amount);
    if (!r.sub_id || !r.committee_id || !Number.isFinite(amount) || amount <= 0) continue;
    out.push({
      sub_id: String(r.sub_id),
      cycle,
      committee_id: r.committee_id,
      committee_name: String(r.committee_name || r.committee_id).trim(),
      candidate_id: r.candidate_id || null,
      amount: Math.round(amount * 100) / 100,
      disbursement_date: r.disbursement_date ? String(r.disbursement_date).slice(0, 10) : null,
      distribution_date: (r.public_distribution_date || r.communication_date) ? String(r.public_distribution_date || r.communication_date).slice(0, 10) : null,
      file_number: r.file_number ? Number(r.file_number) : null,
      source_url: /^https?:/.test(r.pdf_url || "") ? r.pdf_url : `https://www.fec.gov/data/electioneering-communications/?committee_id=${r.committee_id}`,
    });
  }
  return out;
}
