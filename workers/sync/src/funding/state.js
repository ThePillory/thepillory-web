// California campaign finance from data/ca-campaign.json (Cal-Access, built
// weekly in GitHub Actions; see tools/build_ca_campaign.py): which entry is
// whose, and the rows to load. Pure; tested in test/state-money.test.mjs.
//
// Statewide officers are listed by office (the same key as
// data/state-executive-officials.json). Legislators are listed by seat
// ("ASM-8", "SEN-4"), every candidate with a statement since 2025; a sitting
// legislator is matched to their seat's entry by last name and first name.
import { nameParts } from "./disclosure.js";

const SEAT_PREFIX = { "ca-assembly": "ASM", "ca-senate": "SEN" };
const MIN_EMPLOYER_DONORS = 3;

/** "ASM-8" for a California legislator, or null. */
export function seatOf(o) {
  const prefix = SEAT_PREFIX[o.chamber];
  const n = parseInt(String(o.district_code || ""), 10);
  return prefix && n > 0 ? `${prefix}-${n}` : null;
}

const firstMatches = (a, b) => Boolean(a && b) && (a === b || (a.length > 2 && b.startsWith(a)) || (b.length > 2 && a.startsWith(b)));

/** The seat entry for this legislator: same last name, a first name that matches. */
export function matchSeat(entries, o) {
  const me = nameParts(o.name);
  if (!me) return null;
  const found = (entries || []).filter((p) => {
    const them = nameParts(p.name);
    return them && them.last === me.last && firstMatches(them.first, me.first);
  });
  return found.length === 1 ? found[0] : null;
}

/** The Cal-Access page an official's money links to: their first (newest) committee. */
export const mainSource = (person) => (person.committees && person.committees[0] && person.committees[0].source_url) || null;

/**
 * Rows for state_money_* from one entry. Individuals arrive only as totals and
 * by employer; an employer is kept only when at least 3 people gave.
 */
export function moneyRows(officialId, person) {
  const source = mainSource(person);
  const out = { cycles: [], industries: [], employers: [], orgs: [], ie: [] };
  if (!source) return out;
  for (const [cycle, c] of Object.entries(person.cycles || {})) {
    out.cycles.push({
      official_id: officialId, cycle, raised: c.raised ?? null, spent: c.spent ?? null, statements: c.statements || 0,
      individuals_total: c.individuals ? c.individuals.total : null, individuals_count: c.individuals ? c.individuals.count : null,
      not_employed_total: c.not_employed ? c.not_employed.total : null, not_employed_count: c.not_employed ? c.not_employed.count : null,
      source_url: source,
    });
    for (const i of c.industries || []) out.industries.push({ official_id: officialId, cycle, industry: i.industry, total: i.total });
    for (const e of c.employers || []) {
      if (e.count >= MIN_EMPLOYER_DONORS) out.employers.push({ official_id: officialId, cycle, employer: e.employer, industry: e.industry, total: e.total, count: e.count });
    }
    for (const o of c.organizations || []) {
      out.orgs.push({ official_id: officialId, cycle, name: o.name, kind: o.kind, industry: o.industry, total: o.total, count: o.count, filer_id: o.filer_id || null });
    }
    for (const x of c.ie || []) {
      if (!/^https?:\/\//.test(x.source_url || "")) continue;
      out.ie.push({
        official_id: officialId, cycle, spender: x.spender, filer_id: String(x.filer_id), support_oppose: x.support_oppose, race: x.race || "",
        total: x.total, filings: x.filings, first_date: x.first || null, last_date: x.last || null, source_url: x.source_url,
      });
    }
  }
  return out;
}
