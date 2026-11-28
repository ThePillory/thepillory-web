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

/**
 * FEC totals for the period shown (fundingFor's result): a member of Congress ("Raised $X in …"), or the
 * President's campaign committee, named as such (`lead`). Never the inaugural committee: it isn't a campaign.
 */
export function federalMoneyLine(f, lead = "Raised") {
  const t = f && f.totals;
  if (!t || !(t.receipts > 0)) return null;
  const parts = [`${lead} ${dollars(t.receipts)} in ${span(f.cycle)}`];
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

/** The one sentence shown with the line, and where it's explained in full (Methodology, "The money line"). */
export const MONEY_NOTE = "Campaign money as the campaign reported it for the two-year period; it doesn't explain any vote or action in office.";
export const MONEY_HOW = "/about/methodology/#money-line";

/** Under a list with money lines (Your representatives): what the lines are, once. "" when none shows. */
export const moneyHint = (money) =>
  money && Object.keys(money).length
    ? `<p class="hint">Money lines: what each person's campaign reported raising in the two-year period, from the FEC, Cal-Access or the county's filings. Facts about money; they don't explain any vote. <a class="inline-link" href="${MONEY_HOW}">What they count</a></p>`
    : "";

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
  // The President: their own campaign committee. The Vice President: only when they ran on the President's
  // ticket, named as the ticket's committee. The Cabinet is appointed and has no line.
  if (funding.kind === "president" || (funding.kind === "vice-president" && funding.ticket)) {
    const lead = funding.kind === "president" ? "Campaign committee raised" : "The President's ticket's campaign committee raised";
    const text = federalMoneyLine(funding.campaign, lead);
    return text ? { text, source: MONEY_SOURCE.federal } : null;
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

// ---------------------------------------------------------------------------
// Your representatives: the same line for each person listed, read in a few indexed queries.

const ph = (n) => Array(n).fill("?").join(",");
const FEDERAL = new Set(["us-house", "us-senate"]);
const CA = new Set(["ca-assembly", "ca-senate", "ca-executive"]);

/**
 * { [official id]: text } for the people in Your representatives, by the same rules as each page's header:
 * members of Congress and the President (FEC totals), the Vice President only on the President's ticket
 * (the President's numbers, named as the ticket's committee), California's officials (Cal-Access), county
 * supervisors (NetFile, `local` docs), nobody else. People without money get no entry. `cycle`: the
 * two-year period, as the pages default to it.
 */
export async function moneyGlances(db, people, { cycle, local = null } = {}) {
  const list = (people || []).filter(Boolean);
  const out = {};
  if (!db || !list.length) return out;
  const president = list.find((o) => o.chamber === "us-executive" && o.rank === 1) || null;
  const vp = list.find((o) => o.chamber === "us-executive" && o.rank === 2) || null;
  const ticket = !!(president && vp && president.term_start && president.term_start === vp.term_start);
  const fed = list.filter((o) => FEDERAL.has(o.chamber) || o === president);
  const ca = list.filter((o) => CA.has(o.chamber));
  const fedIds = fed.map((o) => o.id);
  const caIds = ca.map((o) => o.id);
  const key = `${cycle - 1}-${cycle}`;
  const [totals, fedInd, caRows, caInd] = await Promise.all([
    fedIds.length ? db.prepare(`SELECT official_id, receipts, pac FROM funding_totals WHERE cycle = ? AND official_id IN (${ph(fedIds.length)})`).bind(cycle, ...fedIds).all() : { results: [] },
    fedIds.length
      ? db.prepare(
          `SELECT official_id, industry, SUM(total) AS pac FROM (
             SELECT official_id, industry, total FROM funding_pacs WHERE cycle = ? AND official_id IN (${ph(fedIds.length)}) AND industry != 'other'
             UNION ALL SELECT official_id, industry, total FROM funding_employers WHERE cycle = ? AND official_id IN (${ph(fedIds.length)}) AND industry != 'other')
           GROUP BY official_id, industry`
        ).bind(cycle, ...fedIds, cycle, ...fedIds).all()
      : { results: [] },
    caIds.length ? db.prepare(`SELECT official_id, raised FROM state_money_cycles WHERE cycle = ? AND official_id IN (${ph(caIds.length)})`).bind(key, ...caIds).all() : { results: [] },
    caIds.length ? db.prepare(`SELECT official_id, industry, total FROM state_money_industries WHERE cycle = ? AND official_id IN (${ph(caIds.length)})`).bind(key, ...caIds).all() : { results: [] },
  ]);
  const by = (rows) => rows.reduce((m, r) => ((m[r.official_id] ||= []).push(r), m), {});
  const tot = Object.fromEntries(totals.results.map((r) => [r.official_id, r]));
  const ind = by(fedInd.results.map((r) => ({ ...r, emp: 0 })));
  for (const o of fed) {
    const lead = o === president ? "Campaign committee raised" : "Raised";
    const text = federalMoneyLine({ cycle, totals: tot[o.id] || null, industries: ind[o.id] || [] }, lead);
    if (text) out[o.id] = text;
  }
  if (ticket && tot[president.id]) {
    const text = federalMoneyLine({ cycle, totals: tot[president.id], industries: ind[president.id] || [] }, "The President's ticket's campaign committee raised");
    if (text) out[vp.id] = text;
  }
  const caRow = Object.fromEntries(caRows.results.map((r) => [r.official_id, r]));
  const caI = by(caInd.results);
  for (const o of ca) {
    const text = stateMoneyLine({ cycle, row: caRow[o.id] || null, industries: caI[o.id] || [] });
    if (text) out[o.id] = text;
  }
  for (const o of list.filter((x) => x.chamber === "county-board")) {
    const text = localMoneyLine(local, o.name);
    if (text) out[o.id] = text;
  }
  return out;
}
