// FEC API responses → rows for funding_totals, funding_pacs, funding_outside and
// funding_employers. Pure functions (no network); tested with saved responses.
// API: https://api.open.fec.gov/developers/ (an api.data.gov key).
//
// Every amount is the FEC's own figure for one two-year period ("cycle" 2026 =
// January 1, 2025 to December 31, 2026). Nothing here names an individual donor:
// individual giving is read only as totals, by size, and by employer.
import { classify, classifyCommittee, NOT_EMPLOYED } from "./industry.js";

export const API = "https://api.open.fec.gov/v1";

/** The current two-year period: the next even year (2025 → 2026). */
export function currentCycle(date = new Date()) {
  const y = date.getUTCFullYear();
  return y % 2 ? y + 1 : y;
}

/**
 * A member's FEC candidate IDs for their current office, in the crosswalk's
 * order (most recent first): House IDs start with H, Senate with S, and the next
 * two letters are the state after the year digit (H8CA04152 → CA).
 */
export function candidateIdsFor(fecIds, chamber, state) {
  const prefix = chamber === "us-senate" ? "S" : "H";
  return (fecIds || []).filter((id) => /^[HS]\d[A-Z]{2}/.test(id) && id[0] === prefix && (!state || id.slice(2, 4) === state));
}

export const candidatePage = (candidateId, cycle) => `https://www.fec.gov/data/candidate/${candidateId}/?cycle=${cycle}&election_full=false`;
export const pacReceiptsPage = (committeeId, cycle) =>
  `https://www.fec.gov/data/receipts/?committee_id=${committeeId}&two_year_transaction_period=${cycle}&line_number=F3-11C`;

const num = (x) => (Number.isFinite(Number(x)) ? Number(x) : 0);

/** /candidate/{id}/totals/?cycle= → a funding_totals row (without official_id). */
export function parseTotals(r, candidateId, cycle) {
  if (!r) return null;
  const receipts = num(r.receipts);
  const unitemized = num(r.individual_unitemized_contributions);
  const itemized = num(r.individual_itemized_contributions);
  const pac = num(r.other_political_committee_contributions);
  const party = num(r.political_party_committee_contributions);
  const self = num(r.candidate_contribution) + num(r.loans_made_by_candidate);
  return {
    candidate_id: candidateId,
    cycle,
    receipts,
    disbursements: num(r.disbursements),
    cash_on_hand: r.last_cash_on_hand_end_period == null ? null : num(r.last_cash_on_hand_end_period),
    individual_unitemized: unitemized,
    individual_itemized: itemized,
    pac,
    party,
    self_funding: self,
    // Transfers from other authorized committees, other loans, offsets and other receipts.
    other: Math.max(0, Math.round((receipts - unitemized - itemized - pac - party - self) * 100) / 100),
    coverage_end: r.coverage_end_date ? String(r.coverage_end_date).slice(0, 10) : null,
    last_report: [r.last_report_type_full, r.last_report_year].filter(Boolean).join(" ") || null,
    source_url: candidatePage(candidateId, cycle),
  };
}

/**
 * Schedule A line 11C rows (contributions from PACs and other political
 * committees) summed by giving committee. Memo entries (memo_code X) aren't
 * counted; refunds (negative amounts) are.
 */
export function aggregatePacs(rows, committeeId, cycle) {
  const by = new Map();
  for (const r of rows || []) {
    if (r.memo_code === "X") continue;
    const id = r.contributor_id || (r.contributor && r.contributor.committee_id);
    if (!id) continue;
    const c = r.contributor || {};
    const name = String(r.contributor_name || c.name || "").replace(/[\s,.]+$/, "").trim();
    let a = by.get(id);
    if (!a) by.set(id, (a = { committee_id: id, name, committee_type: c.committee_type || null, designation: c.designation || null, total: 0, count: 0 }));
    if (!a.name && name) a.name = name;
    a.total = Math.round((a.total + num(r.contribution_receipt_amount)) * 100) / 100;
    a.count += 1;
  }
  return [...by.values()]
    .filter((a) => a.name && a.total > 0)
    .map(({ designation, ...a }) => ({ ...a, industry: classifyCommittee({ name: a.name, designation, committee_type: a.committee_type }), source_url: pacReceiptsPage(committeeId, cycle) }))
    .sort((a, b) => b.total - a.total);
}

/** /schedules/schedule_a/by_employer/ rows. Employers that aren't one ("Retired", "None") are dropped. */
export function parseEmployers(rows, candidateId, cycle) {
  const by = new Map();
  for (const r of rows || []) {
    const employer = String(r.employer || "").replace(/\s+/g, " ").trim().toUpperCase();
    if (!employer || NOT_EMPLOYED.test(employer)) continue;
    const a = by.get(employer) || { employer, total: 0, count: 0 };
    a.total = Math.round((a.total + num(r.total)) * 100) / 100;
    a.count += num(r.count);
    by.set(employer, a);
  }
  return [...by.values()]
    .filter((a) => a.total > 0)
    .map((a) => ({ ...a, industry: classify(a.employer), source_url: candidatePage(candidateId, cycle) }))
    .sort((a, b) => b.total - a.total);
}

/** /schedules/schedule_e/by_candidate/ rows: spending for (S) or against (O) the candidate, by spender. */
export function parseOutside(rows, candidateId, cycle) {
  const by = new Map();
  for (const r of rows || []) {
    const so = r.support_oppose_indicator;
    if (!r.committee_id || (so !== "S" && so !== "O")) continue;
    const k = `${r.committee_id}|${so}`;
    const a = by.get(k) || { committee_id: r.committee_id, name: String(r.committee_name || r.committee_id).trim(), support_oppose: so, total: 0, count: 0 };
    a.total = Math.round((a.total + num(r.total)) * 100) / 100;
    a.count += num(r.count);
    by.set(k, a);
  }
  return [...by.values()].filter((a) => a.total > 0).map((a) => ({ ...a, source_url: candidatePage(candidateId, cycle) })).sort((a, b) => b.total - a.total);
}
