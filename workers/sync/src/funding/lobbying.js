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

// ---------------------------------------------------------------------------
// LD-203: contributions reported by registered lobbyists and lobbying
// organizations, twice a year. Each item names a payee (a committee), an
// honoree (the person it honors) and a contributor ("SELF", or the
// organization's PAC). An item is kept for a member of Congress only when its
// honoree matches exactly one current member by name; anything else is left
// out rather than guessed. A lobbyist's own report is kept only as counts and
// totals: no lobbyist's name is stored.

const TITLE = /^(the|hon|honorable|rep|reps|representative|congressman|congresswoman|congressmember|cong|sen|senator|dr|mr|mrs|ms|leader|speaker|whip|chair|chairman|chairwoman|del|delegate|resident|commissioner)$/;
const SUFFIXES = /^(jr|sr|ii|iii|iv|v|md|phd|esq)$/;
// Words that make an honoree a committee, party or event rather than a person.
const NOT_A_PERSON = /\b(pac|committee|cmte|party|fund|victory|caucus|nrcc|dccc|nrsc|dscc|rnc|dnc|congress|senate|house|for|friends|leadership|campaign|association|inc|llc|foundation|club|council|republican|democratic|democrats|republicans|majority|minority|federation|union|team|forward|america|people|action|future)\b/;

const foldName = (s) =>
  String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z\- ,.]/g, " ");

// Common given-name pairs, so "Mike Thompson" matches "Michael Thompson".
const NICK = [
  ["michael", "mike"], ["robert", "bob", "rob", "bobby"], ["william", "bill", "will", "billy"], ["james", "jim", "jimmy", "jamie"], ["thomas", "tom", "tommy"],
  ["charles", "chuck", "charlie"], ["richard", "dick", "rick", "rich"], ["edward", "ed", "ted", "eddie"], ["theodore", "ted"], ["anthony", "tony"],
  ["joseph", "joe", "joey"], ["daniel", "dan", "danny"], ["david", "dave"], ["stephen", "steve"], ["steven", "steve"], ["christopher", "chris"],
  ["patrick", "pat"], ["patricia", "pat", "patty", "tricia"], ["katherine", "kate", "katie", "kathy"], ["kathleen", "kathy", "kate"], ["elizabeth", "liz", "beth", "betsy"],
  ["jennifer", "jen", "jenny"], ["nicholas", "nick"], ["benjamin", "ben"], ["samuel", "sam"], ["timothy", "tim"], ["gregory", "greg"], ["ronald", "ron"],
  ["donald", "don"], ["kenneth", "ken"], ["andrew", "andy", "drew"], ["matthew", "matt"], ["jeffrey", "jeff"], ["gerald", "jerry", "gerry"], ["gerard", "gerry"],
  ["lawrence", "larry"], ["alan", "al"], ["albert", "al"], ["john", "jack"], ["margaret", "maggie", "peggy"], ["deborah", "debbie", "deb"], ["susan", "sue"],
  ["frederick", "fred"], ["raymond", "ray"], ["randall", "randy"], ["douglas", "doug"], ["bradley", "brad"], ["zachary", "zach"], ["joshua", "josh"],
  ["jonathan", "jon"], ["mitchell", "mitch"], ["gary", "gar"], ["harold", "hal"], ["henry", "hank"], ["catherine", "cathy", "kate"], ["rebecca", "becky"],
  ["abigail", "abby"], ["melanie", "mel"], ["vincent", "vince"], ["eugene", "gene"], ["frank", "francis"], ["kristen", "kristin"], ["valerie", "val"],
  ["lisa", "elisa"], ["sanford", "sandy"], ["alexandria", "alex"], ["alexander", "alex"], ["jacob", "jake"], ["jacklyn", "jacky", "jackie"], ["benedict", "ben"],
];
const NICKS = new Map();
for (const group of NICK) for (const a of group) NICKS.set(a, new Set([...(NICKS.get(a) || []), ...group]));

/** Do two given names name the same person? Equal, a nickname pair, or one a 3+ letter start of the other. */
export function sameFirst(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  if (NICKS.get(a)?.has(b)) return true;
  return (a.length > 2 && b.startsWith(a)) || (b.length > 2 && a.startsWith(b));
}

/**
 * An honoree as written ("Rep. Jason Smith", "SMITH, JASON", "Senator Mark
 * Warner", "MAXINE DEXTER") → its words: {first, words}. Null for a committee,
 * party or event ("NRCC", "Mike Thompson for Congress").
 */
export function honoreeParts(raw) {
  let s = foldName(String(raw || "").replace(/\([^)]*\)/g, " "));
  if (!s.trim()) return null;
  if (s.includes(",")) {
    const [last, ...rest] = s.split(",");
    s = `${rest.join(" ")} ${last}`;
  }
  const words = s.replace(/\./g, " ").split(/\s+/).filter(Boolean).filter((w) => !TITLE.test(w) && !SUFFIXES.test(w));
  if (!words.length || NOT_A_PERSON.test(words.join(" "))) return null;
  // Middle initials don't count.
  const kept = words.filter((w, i) => i === 0 || i === words.length - 1 || w.replace(/-/g, "").length > 1);
  return { first: kept.length > 1 ? kept[0] : null, words: kept };
}

/** Members of Congress → a lookup by last word of the last name. members: [{id, name, last_name}]. */
export function memberIndex(members) {
  const index = new Map();
  for (const m of members) {
    const name = foldName(m.name).replace(/\./g, " ").split(/\s+/).filter(Boolean).filter((w) => !SUFFIXES.test(w));
    const last = foldName(m.last_name || name[name.length - 1] || "").replace(/\./g, " ").split(/\s+/).filter(Boolean);
    if (!last.length || !name.length) continue;
    const entry = { id: m.id, first: name[0], last };
    const key = last[last.length - 1];
    index.set(key, [...(index.get(key) || []), entry]);
  }
  return index;
}

/**
 * The one member of Congress an honoree names, or null. The honoree's last
 * words must be the member's last name, and their first word the member's
 * given name (or a nickname of it). A bare last name counts only when exactly
 * one member has it.
 */
export function matchHonoree(raw, index) {
  const p = honoreeParts(raw);
  if (!p) return null;
  const key = p.words[p.words.length - 1];
  const candidates = (index.get(key) || []).filter((m) => m.last.every((w, i) => p.words[p.words.length - m.last.length + i] === w) && p.words.length >= m.last.length);
  const hits = p.words.length === candidates[0]?.last.length ? candidates : candidates.filter((m) => sameFirst(p.words[0], m.first));
  return hits.length === 1 ? hits[0].id : null;
}

/** A lobby_contrib_filings row from one LD-203 report. */
export function contribFilingRow(f) {
  const registrant = f.registrant || {};
  const lobbyist = f.filer_type === "lobbyist" ? f.lobbyist || {} : null;
  return {
    filing_uuid: f.filing_uuid,
    filer_type: f.filer_type === "lobbyist" ? "lobbyist" : "organization",
    registrant_id: registrant.id || null,
    registrant_name: String(registrant.name || "").trim(),
    lobbyist_id: lobbyist ? lobbyist.id || null : null,
    filing_year: f.filing_year,
    filing_period: f.filing_period || null,
    filing_type: f.filing_type || null,
    posted_at: f.dt_posted || null,
    source_url: f.filing_document_url || f.url,
  };
}

/**
 * The items in one LD-203 report that honor a member of Congress:
 * [{n, official_id, contribution_type, contributor_name, payee_name, honoree_name, amount, date}].
 * On a lobbyist's own report the contributor (the lobbyist) isn't kept.
 */
export function contributionItems(f, index) {
  const lobbyist = f.filer_type === "lobbyist";
  const out = [];
  (f.contribution_items || []).forEach((it, i) => {
    const id = matchHonoree(it.honoree_name, index);
    if (!id) return;
    const amt = amount(it.amount);
    out.push({
      n: i + 1,
      official_id: id,
      contribution_type: it.contribution_type || null,
      contributor_name: lobbyist ? null : String(it.contributor_name || "").trim() || null,
      payee_name: String(it.payee_name || "").trim() || null,
      honoree_name: String(it.honoree_name || "").trim() || null,
      amount: amt,
      date: /^\d{4}-\d{2}-\d{2}/.test(it.date || "") ? it.date.slice(0, 10) : null,
    });
  });
  return out;
}

/** The last name to search an honoree by: the last word of the member's last name. */
export function honoreeQuery(member) {
  const last = String(member.last_name || "").trim() || String(member.name || "").trim().split(/\s+/).filter((w) => !/^(jr|sr|ii|iii|iv)\.?$/i.test(w)).pop();
  return String(last || "").split(/\s+/).pop();
}

/** Congress.gov committee relationships that are a committee acting on a bill (not referral). */
export function committeeActed(relationship) {
  return /^(Reported By|Reported Original Measure|Markup By|Hearings By|Discharged From)/i.test(String(relationship || ""));
}
