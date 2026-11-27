// The money in one line, at the top of an official's page and in Quick mode's card
// (docs/funding.md, "The money line"). Pure: built from what the Funding tab already loads.
//
// The same rules for every official with money data: what the campaign raised in the period, then,
// only when known, the share from PACs (FEC) and the largest industry (approximate, as the Funding
// tab says). No line without data (never "$0"), no colors, no comparisons, no ranking.

import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";

const dollars = (n) => `$${Math.round(Number(n)).toLocaleString("en-US")}`;
const span = (cycle) => `${cycle - 1}–${cycle}`;
const MONTHS = ["Jan.", "Feb.", "March", "April", "May", "June", "July", "Aug.", "Sept.", "Oct.", "Nov.", "Dec."];
const month = (d) => `${MONTHS[parseInt(d.slice(5, 7), 10) - 1]} ${d.slice(0, 4)}`;

/** The largest industry that matched one (unclassified money is never named as an industry). */
function largestIndustry(rows, amount) {
  const top = (rows || []).filter((r) => r.industry && r.industry !== "other" && amount(r) > 0).sort((a, b) => amount(b) - amount(a))[0];
  return top ? INDUSTRIES[top.industry] || null : null;
}

const industryPart = (name) => (name ? `Largest industry (approximate): ${name}` : "");

/** A member of Congress (fundingFor's result): FEC totals for the period shown. */
export function federalMoneyLine(f) {
  const t = f && f.totals;
  if (!t || !(t.receipts > 0)) return null;
  const parts = [`Raised ${dollars(t.receipts)} in ${span(f.cycle)}`];
  if (t.pac != null) parts.push(`${Math.round((100 * t.pac) / t.receipts)}% from PACs`);
  const ind = industryPart(largestIndustry(f.industries, (r) => (r.pac || 0) + (r.emp || 0)));
  if (ind) parts.push(ind);
  return parts.join(" · ");
}

/** A California official (stateMoneyFor's result): Cal-Access statements summed for the period. */
export function stateMoneyLine(m) {
  const r = m && m.row;
  if (!r || !(r.raised > 0)) return null;
  const parts = [`Raised ${dollars(r.raised)} in ${span(m.cycle)}`];
  const ind = industryPart(largestIndustry(m.industries, (x) => x.total || 0));
  if (ind) parts.push(ind);
  return parts.join(" · ");
}

/**
 * A county official (local-money docs, matched by name in each doc's `officials`): NetFile's itemized
 * contributions, which are all its public data has (no Form 460 totals), so the line says "itemized".
 */
export function localMoneyLine(docs, name) {
  const cs = [];
  for (const doc of docs || []) for (const lid of (doc.officials || {})[name] || []) if (doc.committees && doc.committees[lid]) cs.push(doc.committees[lid]);
  const total = cs.reduce((s, c) => s + (Number(c.contributions) || 0), 0);
  if (!(total > 0)) return null;
  const first = cs.map((c) => c.first).filter(Boolean).sort()[0];
  const last = cs.map((c) => c.last).filter(Boolean).sort().pop();
  const when = first && last ? (month(first) === month(last) ? ` in ${month(first)}` : `, ${month(first)} to ${month(last)}`) : "";
  return `Raised ${dollars(total)} in itemized contributions${when}`;
}

/** Which agency the line comes from, for Quick mode's source note. */
export const MONEY_SOURCE = { federal: "reports filed with the Federal Election Commission", state: "statements filed with the California Secretary of State (Cal-Access)", county: "filings on the county's NetFile site" };

/**
 * The line for an official's page: { text, source } or null. `funding` is what the page loaded for
 * the Funding tab (fundingFor, stateOfficialMoney, or the county's { kind: "county", local }).
 */
export function moneyLine(o, funding) {
  if (!funding) return null;
  if (funding.kind === "state") {
    const text = stateMoneyLine(funding.money);
    return text ? { text, source: MONEY_SOURCE.state } : null;
  }
  if (funding.kind === "county") {
    const text = localMoneyLine(funding.local, o.name);
    return text ? { text, source: MONEY_SOURCE.county } : null;
  }
  if (o.chamber === "us-house" || o.chamber === "us-senate") {
    const text = federalMoneyLine(funding);
    return text ? { text, source: MONEY_SOURCE.federal } : null;
  }
  return null;
}

/**
 * Bill pages, in the summary area: one line when Follow the money lists organizations that lobbied
 * on the bill and also gave (federal: LD-2 and LD-203, by registration ID; California: the
 * organization's own lobbying reports). A count of organizations, never amounts, names or a score.
 * → HTML or "".
 */
export function giversLine(n, { california = false } = {}) {
  if (!(n > 0)) return "";
  const who = california ? "California legislators" : "members of Congress";
  const text = `${n} ${n === 1 ? "organization that lobbied on this bill also gave" : "organizations that lobbied on this bill also gave"} to ${who} ›`;
  return `<p class="summary-line money-glance"><a href="#money">${text}</a></p>`;
}
