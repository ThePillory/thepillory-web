// The money in one line, at the top of an official's page and in Quick mode's card
// (docs/funding.md, "The money line"). Pure: built from what the Funding tab already loads.
//
// The same rules for every official with money data: what the campaign raised in the period, then,
// only when known, the share from PACs (FEC) and the largest industry (approximate, as the Funding
// tab says). No line without data (never "$0"), no colors, no comparisons, no ranking.

import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";
import { compactMoney } from "./networth.js";
import { raisedParts } from "../../workers/sync/src/funding/committees.js";
import { STATE_NAME } from "./districts.js";
import { termLimit, limitedOffice as termLimitOffice } from "./term-limits.js";

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
 * FEC money for the period shown (fundingFor's result): what the official's campaign committees and the
 * leadership PACs they sponsor raised (src/funding/committees.js; joint fundraising committees never added
 * in). `campaignOnly` (the Vice President's line from the President's ticket) counts the campaign
 * committees alone, named by `lead`. Never the inaugural committee: it isn't a campaign. The PAC share is
 * the campaign committees' and is shown only when the amount is theirs alone.
 */
export function federalMoneyLine(f, lead = "Raised", { campaignOnly = false } = {}) {
  if (!f) return null;
  const t = f.totals;
  const r = raisedParts(t ? t.receipts : null, f.committees);
  const amount = campaignOnly ? r.campaign : r.total;
  if (!(amount > 0)) return null;
  const parts = [`${lead} ${dollars(amount)} in ${span(f.cycle)}`];
  if (t && t.pac != null && t.receipts > 0 && amount === Number(t.receipts)) parts.push(`${Math.round((100 * t.pac) / t.receipts)}% from PACs`);
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
    return text ? { text, source: MONEY_SOURCE.state, amount: funding.money.row.raised } : null;
  }
  if (funding.kind === "county") {
    const text = localMoneyLine(funding.local, o.name);
    return text ? { text, source: MONEY_SOURCE.county, amount: localTotal(funding.local, o.name), itemized: true } : null;
  }
  // The President and the Vice President: their own committees, the same rule as Congress. A Vice President
  // with none of their own who ran on the President's ticket: the ticket's campaign committees, named as such.
  // The Cabinet is appointed and has no line.
  const fed = (f, lead, opts) => {
    const text = federalMoneyLine(f, lead, opts);
    if (!text) return null;
    const r = raisedParts(f.totals ? f.totals.receipts : null, f.committees);
    return { text, source: MONEY_SOURCE.federal, amount: opts && opts.campaignOnly ? r.campaign : r.total };
  };
  if (funding.kind === "president") return fed(funding.campaign);
  if (funding.kind === "vice-president") {
    return fed(funding.own) || (funding.ticket ? fed(funding.campaign, "The President's ticket's campaign committees raised", { campaignOnly: true }) : null);
  }
  if (o.chamber === "us-house" || o.chamber === "us-senate") return fed(funding);
  return null;
}

/** A county official's NetFile committees: their itemized contributions, added up. */
function localTotal(docs, name) {
  let total = 0;
  for (const doc of docs || []) for (const lid of (doc.officials || {})[name] || []) if (doc.committees && doc.committees[lid]) total += Number(doc.committees[lid].contributions) || 0;
  return total;
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
// Your representatives: the amount raised, short, on the right of each row; read in a few indexed queries.

const ph = (n) => Array(n).fill("?").join(",");
const FEDERAL = new Set(["us-house", "us-senate"]);
const CA = new Set(["ca-assembly", "ca-senate", "ca-executive"]);

/** "$4.2M", "$850K": the short amount for a row or a tile (functions/_lib/networth.js compactMoney). */
export const shortRaised = (n) => compactMoney(n);

/** The list's one label: "Campaign money raised, 2025–2026". */
export const moneyListLabel = (cycle) => `Campaign money raised, ${span(cycle)}`;

/** A county official's NetFile committees: itemized contributions, only when every committee's records fall in the period. */
export function localRaised(docs, name, cycle) {
  const cs = [];
  for (const doc of docs || []) for (const lid of (doc.officials || {})[name] || []) if (doc.committees && doc.committees[lid]) cs.push(doc.committees[lid]);
  if (!cs.length || cs.some((c) => !c.first || c.first < `${cycle - 1}-01-01`)) return null;
  const total = cs.reduce((s, c) => s + (Number(c.contributions) || 0), 0);
  return total > 0 ? total : null;
}

/**
 * { [official id]: entry } for the people in Your representatives and an official's header, by the same rules
 * as each page's money line: members of Congress, the President and the Vice President (FEC: their campaign
 * committees plus the leadership PACs they sponsor; a Vice President with none of their own, on the President's
 * ticket, the ticket's campaign committees), California's officials (Cal-Access: every committee they control),
 * county supervisors (NetFile's itemized contributions). An entry is { amount, text: "$4.2M raised" }, or, with
 * no amount, why, from the records only (docs/funding.md, "When there's no amount"): { reason, text, href? },
 * the first that applies of
 *   appointed office                           "Appointed: no campaign"
 *   money not loaded for their state or office "Campaign money for [State] isn't on ThePillory yet"
 *   filings for the period report $0 raised    "Reported raising $0 in [period]" (href: the latest report)
 *   no committee filed for the period          "No active campaign committee in [period]"
 *   the records show a term limit reached      "Can't run again for this office (term limit)" (href: the source)
 * and nothing when none does (never "$0", never a guess). Order, colors and totals are never changed by it.
 * `history` (optional, async): loads { federalExecutive, california } for the term-limit check, only when needed.
 */
export async function moneyGlances(db, people, { cycle, local = null, history = null } = {}) {
  const list = (people || []).filter(Boolean);
  const out = {};
  if (!db || !list.length) return out;
  const span_ = span(cycle);
  const president = list.find((o) => o.chamber === "us-executive" && o.rank === 1) || null;
  const vp = list.find((o) => o.chamber === "us-executive" && o.rank === 2) || null;
  const ticket = !!(president && vp && president.term_start && president.term_start === vp.term_start);
  const fed = list.filter((o) => FEDERAL.has(o.chamber) || o === president || o === vp);
  const ca = list.filter((o) => CA.has(o.chamber));
  const fedIds = fed.map((o) => o.id);
  const caIds = ca.map((o) => o.id);
  const [fedRows, caRows] = await Promise.all([fedIds.length ? raisedFederal(db, fedIds, cycle) : {}, caIds.length ? raisedCalifornia(db, caIds, cycle) : {}]);
  const put = (id, amount, suffix = "") => {
    if (amount > 0) out[id] = { amount, text: `${shortRaised(amount)} raised${suffix}` };
  };
  const why = (id, reason, href = null) => {
    if (!out[id]) out[id] = { reason, text: reason, ...(href ? { href } : {}) };
  };
  for (const o of fed) put(o.id, fedRows[o.id] && fedRows[o.id].total);
  if (ticket && !out[vp.id]) put(vp.id, fedRows[president.id] && fedRows[president.id].campaign);
  for (const o of ca) put(o.id, caRows[o.id] && caRows[o.id].raised);
  for (const o of list.filter((x) => x.chamber === "county-board")) put(o.id, localRaised(local, o.name, cycle), " (itemized)");

  const limits = [];
  for (const o of list) {
    if (out[o.id]) continue;
    // 1. Appointed (the Cabinet).
    if (o.chamber === "us-executive" && o.rank > 2) {
      why(o.id, "Appointed: no campaign");
      continue;
    }
    // 2. Not loaded for their state or office: state officials outside California.
    if (o.level === "state" && !CA.has(o.chamber)) {
      why(o.id, `Campaign money for ${STATE_NAME[o.state] || o.state || "this state"} isn't on ThePillory yet`);
      continue;
    }
    const f = fedRows[o.id];
    const c = caRows[o.id];
    // 3. Filings for the period that report $0 raised (a filed $0, not a missing value).
    if (f && f.filed && f.receipts === 0) {
      why(o.id, `Reported raising $0 in ${span_}`, f.report);
      continue;
    }
    if (c && c.statements > 0 && c.raised === 0) {
      why(o.id, `Reported raising $0 in ${span_}`, c.report);
      continue;
    }
    // 4. No committee filed for the period: the FEC lists none for the candidate this period (read this period), or
    //    Cal-Access has no statement from a committee they control for it (read this period).
    if ((f && f.noCommittee) || (c && c.checked && !c.statements)) {
      why(o.id, `No active campaign committee in ${span_}`);
      continue;
    }
    limits.push(o);
  }
  // 5. A term limit the records show (the records are loaded only when someone is left to check).
  if (history && limits.some((o) => termLimitOffice(o))) {
    const records = await history();
    for (const o of limits) {
      const t = termLimit(o, records);
      if (t) why(o.id, t.text, t.href);
    }
  }
  return out;
}

/**
 * What each federal official raised in the period, { [id]: { ...raisedParts, receipts, filed, report, noCommittee } }:
 * funding_totals and official_committees, plus what tells "reported $0" from "no committee" (fec_candidates,
 * funding_progress, the latest report in money_filings). A few indexed reads.
 */
async function raisedFederal(db, ids, cycle) {
  const q = (sql) =>
    db
      .prepare(sql)
      .bind(cycle, ...ids)
      .all()
      .catch((err) => {
        if (/no such table|no such column/i.test(String(err && err.message))) return { results: [] };
        throw err;
      });
  const inIds = `IN (${ph(ids.length)})`;
  const [totals, committees, progress, fec, reports] = await Promise.all([
    q(`SELECT official_id, receipts, source_url FROM funding_totals WHERE cycle = ? AND official_id ${inIds}`),
    q(`SELECT official_id, role, receipts FROM official_committees WHERE cycle = ? AND official_id ${inIds}`),
    q(`SELECT official_id, done_at, committees_at FROM funding_progress WHERE cycle = ? AND official_id ${inIds}`),
    db.prepare(`SELECT official_id, candidate_id, committee_id, note FROM fec_candidates WHERE official_id ${inIds}`).bind(...ids).all().catch(() => ({ results: [] })),
    q(`SELECT official_id, MAX(filed) AS filed, source_url FROM money_filings WHERE agency = 'FEC' AND period_end >= (? - 1) || '-01-01' AND official_id ${inIds} GROUP BY official_id`),
  ]);
  const one = (rows) => Object.fromEntries(rows.results.map((r) => [r.official_id, r]));
  const t = one(totals);
  const p = one(progress);
  const fc = one(fec);
  const rep = one(reports);
  const c = committees.results.reduce((m, r) => ((m[r.official_id] ||= []).push(r), m), {});
  return Object.fromEntries(
    ids.map((id) => {
      const parts = raisedParts(t[id] && t[id].receipts, c[id]);
      const read = p[id] && p[id].done_at;
      return [
        id,
        {
          ...parts,
          receipts: t[id] ? Number(t[id].receipts) : null,
          filed: !!t[id],
          report: (rep[id] && rep[id].source_url) || (t[id] && t[id].source_url) || null,
          // Read this period, an FEC candidate ID on record, no principal committee this period and no committee with receipts.
          noCommittee: !!(read && fc[id] && fc[id].candidate_id && !fc[id].committee_id && !t[id] && !(c[id] || []).length && p[id].committees_at),
        },
      ];
    })
  );
}

/** California officials: { [id]: { raised, statements, checked, report } } from state_money_cycles, disclosure_checks and money_filings. */
async function raisedCalifornia(db, ids, cycle) {
  const inIds = `IN (${ph(ids.length)})`;
  const safe = (p) => p.catch((err) => {
    if (/no such table|no such column/i.test(String(err && err.message))) return { results: [] };
    throw err;
  });
  const [cycles, checks, reports] = await Promise.all([
    safe(db.prepare(`SELECT official_id, raised, statements, source_url FROM state_money_cycles WHERE cycle = ? AND official_id ${inIds}`).bind(`${cycle - 1}-${cycle}`, ...ids).all()),
    safe(db.prepare(`SELECT official_id FROM disclosure_checks WHERE source = 'cal-access' AND official_id ${inIds}`).bind(...ids).all()),
    safe(db.prepare(`SELECT official_id, MAX(filed) AS filed, source_url FROM money_filings WHERE agency = 'Cal-Access' AND period_end >= ? AND official_id ${inIds} GROUP BY official_id`).bind(`${cycle - 1}-01-01`, ...ids).all()),
  ]);
  const one = (rows) => Object.fromEntries(rows.results.map((r) => [r.official_id, r]));
  const y = one(cycles);
  const ch = one(checks);
  const rep = one(reports);
  return Object.fromEntries(
    ids.map((id) => [id, { raised: y[id] ? Number(y[id].raised) : null, statements: y[id] ? y[id].statements || 0 : 0, checked: !!ch[id], report: (rep[id] && rep[id].source_url) || (y[id] && y[id].source_url) || null }])
  );
}

const clean = (t) => String(t).replace(/[&<>"]/g, "");

/** A row's status on the right: "$4.2M raised", or why there's no amount (small, gray), or nothing. */
export const amountStatus = (money, id) => {
  const e = money && money[id];
  if (!e) return "";
  return e.amount > 0 ? `<span class="list-status row-amount">${clean(e.text)}</span>` : `<span class="list-status row-reason">${clean(e.text)}</span>`;
};

/** The one small label above a list that shows amounts; "" when none does. */
export const moneyListKey = (money, cycle) => (money && Object.values(money).some((e) => e.amount > 0) ? `<p class="small secondary money-key">${moneyListLabel(cycle)}</p>` : "");
