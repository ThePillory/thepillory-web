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

// Candidates on the Secretary of State's certified list (data/elections/2026-11-03.json):
// statewide ones by contest ("candidates" in the file), legislative and Board of
// Equalization ones by seat; each stored under its own key, the same rows as officials'.

/** A candidate's key in state_money_* and disclosures: "ca-cand:<contest>:<name slug>" (the slug of /candidates/ca/<contest>/<slug>/). */
export const candidateKey = (contestId, name) =>
  `ca-cand:${contestId}:${String(name).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

const CONTEST_SEAT = { sldl: "ASM", sldu: "SEN", boe: "BOE" };
/** "ASM-8" for an Assembly contest, and the like; null for a statewide one. */
export function contestSeat(contest) {
  const prefix = CONTEST_SEAT[contest && contest.scope];
  const n = parseInt(String(contest && contest.district), 10);
  return prefix && n > 0 ? `${prefix}-${n}` : null;
}

// Common short forms of first names, the same for everyone ("Tom Patti" on the ballot, "Thomas Patti" on the filing).
export const NICKNAMES = {
  tom: "thomas", bill: "william", will: "william", mike: "michael", bob: "robert", rob: "robert", jim: "james", joe: "joseph",
  dave: "david", dan: "daniel", steve: "stephen", chris: "christopher", tony: "anthony", ed: "edward", kathy: "katherine",
  liz: "elizabeth", sam: "samuel", rick: "richard", dick: "richard", pat: "patrick", matt: "matthew", nick: "nicholas",
  ben: "benjamin", alex: "alexander", andy: "andrew", greg: "gregory", jeff: "jeffrey", ken: "kenneth", larry: "lawrence",
  ron: "ronald", tim: "timothy", don: "donald", jon: "jonathan", phil: "philip", fred: "frederick", gerry: "gerald",
};
const fullName = (first) => NICKNAMES[first] || first;
const firstOrNickname = (a, b) => firstMatches(a, b) || firstMatches(fullName(a), fullName(b)) || (fullName(a) === "stephen" && fullName(b) === "steven") || (fullName(a) === "steven" && fullName(b) === "stephen");

/** The names to try for a certified name: as listed, then with the nickname in parentheses or quotes as the first name ("Donald P. (Don) Wagner", 'Nicholas "Nick" Schultz'). */
function namesToTry(name) {
  const plain = String(name || "").replace(/\([^)]*\)|"[^"]*"/g, " ").replace(/\s+/g, " ").trim();
  const m = String(name || "").match(/\(([^)]+)\)|"([^"]+)"/);
  const nick = m && (m[1] || m[2]);
  const last = plain.split(" ").pop();
  return [plain, nick ? `${nick.trim()} ${last}` : null].filter(Boolean);
}

/** The one entry for this candidate (same last name, a first name, nickname or common short form that matches), or null when none or more than one does. */
export function matchCandidate(entries, name) {
  const found = new Set();
  for (const n of namesToTry(name)) {
    const me = nameParts(n);
    if (!me) continue;
    for (const p of entries || []) {
      const them = nameParts(String(p.name || "").replace(/\([^)]*\)/g, " "));
      if (them && them.last === me.last && firstOrNickname(them.first, me.first)) found.add(p);
    }
  }
  return found.size === 1 ? [...found][0] : null;
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
