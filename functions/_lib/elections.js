// Elections: what's on the ballot, from official sources only. The data is
// data/elections/<id>.json, built by tools/build_elections.py from the
// California Secretary of State (the Certified List of Candidates, the Official
// Voter Information Guide, the randomized alphabet), the county elections
// office (qualified candidates, the Voter Information Pamphlet) and FEC
// candidate filings. See docs/elections.md.
//
// Pure helpers (ballot order, which contests are on a ballot, matching names)
// are tested in workers/sync/test/elections.test.mjs. Results are read from the
// Secretary of State's results feed only after the polls close; before then the
// feed carries test numbers, which are never shown.
import { fold } from "./summary.js";
import { esc, safeUrl, sourceLink, fmtDate } from "./render.js";
import { asset } from "./geo.js";

// Elections ThePillory has, newest first. One file each in data/elections/.
export const ELECTIONS = ["2026-11-03"];
export const CURRENT = ELECTIONS[0];

export const loadElection = (env, request, id) => (ELECTIONS.includes(id) ? asset(env, request, `/data/elections/${id}.json`) : null);

export const electionHref = (id) => `/elections/${id}/`;
export const contestHref = (id, contestId) => `/elections/${id}/contest/${contestId}/`;
export const measureHref = (id, measureId) => `/elections/${id}/measure/${measureId}/`;
export const ballotHref = (id) => `/elections/${id}/ballot/`;

// ---------------------------------------------------------------------------
// Ballot order. California orders candidates by the Secretary of State's
// randomized alphabet (Elections Code 13112): last name first, letter by letter,
// then first name, then middle name. Statewide offices rotate by Assembly
// district (13111): in District 1 the order is as drawn, and in each later
// district the first name moves to the bottom.

const PARTICLES = new Set(["de", "del", "della", "la", "las", "los", "le", "da", "das", "do", "dos", "di", "du", "van", "von", "der", "den", "st", "st.", "san", "santa", "ter", "ten", "mac", "bin", "ibn", "al", "el"]);
const SUFFIX = /^(jr|sr|ii|iii|iv|v|md|phd|esq)\.?$/i;

/** A ballot name as { last, first, middle } (nicknames in parentheses or quotes are left out). */
export function nameParts(name) {
  const words = String(name || "")
    .replace(/\([^)]*\)|"[^"]*"|“[^”]*”/g, " ")
    .replace(/,/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, a) => !(i === a.length - 1 && SUFFIX.test(w)) && !(i === a.length - 2 && SUFFIX.test(a[a.length - 1]) && SUFFIX.test(w)));
  if (!words.length) return { last: "", first: "", middle: "" };
  let i = words.length - 1;
  while (i > 1 && PARTICLES.has(words[i - 1].toLowerCase())) i--;
  return { last: words.slice(i).join(" "), first: words[0] === words[i] ? "" : words[0], middle: words.slice(1, i).join(" ") };
}

const letters = (s) => String(s || "").toUpperCase().normalize("NFD").replace(/[^A-Z]/g, "");

/** Compare two strings letter by letter in the randomized alphabet; a shorter one that matches so far comes first. */
function compareIn(alphabet, a, b) {
  const rank = Object.fromEntries(alphabet.map((l, i) => [l, i]));
  const x = letters(a);
  const y = letters(b);
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    if (x[i] !== y[i]) return rank[x[i]] - rank[y[i]];
  }
  return x.length - y.length;
}

export function compareNames(alphabet, a, b) {
  const p = nameParts(a);
  const q = nameParts(b);
  return compareIn(alphabet, p.last, q.last) || compareIn(alphabet, p.first, q.first) || compareIn(alphabet, p.middle, q.middle);
}

/** Candidates in randomized-alphabet order (Assembly District 1 for statewide offices). */
export const alphabetOrder = (alphabet, candidates) => [...candidates].sort((a, b) => compareNames(alphabet, a.name, b.name));

/** The order for a statewide office in Assembly district `ad`: rotated (ad - 1) places. */
export function rotateFor(list, ad) {
  const n = list.length;
  if (!n || !ad) return list;
  const k = (((parseInt(ad, 10) || 1) - 1) % n + n) % n;
  return [...list.slice(k), ...list.slice(0, k)];
}

/**
 * The candidates in ballot order, and a plain note on how it was set.
 * County contests keep the order of the county's own list (checked in tests
 * to match the randomized alphabet).
 */
export function ballotOrder(contest, election, { ad = null, countyName = null } = {}) {
  const alpha = election.election.alphabet;
  if (contest.scope === "county") {
    return { candidates: contest.candidates, note: `In the order of ${countyName || "the county"}'s list of qualified candidates, which follows the Secretary of State's randomized alphabet.` };
  }
  const base = alphabetOrder(alpha, contest.candidates);
  if (contest.scope === "statewide") {
    return ad
      ? { candidates: rotateFor(base, ad), note: `The order on ballots in Assembly District ${ad}. Statewide offices follow the Secretary of State's randomized alphabet and rotate by Assembly district.` }
      : { candidates: base, note: `The order on ballots in Assembly District 1. Statewide offices follow the Secretary of State's randomized alphabet and rotate by Assembly district, so the order differs by district.` };
  }
  if (contest.scope === "cd") {
    return { candidates: base, note: `The Secretary of State's randomized-alphabet order, as on ballots in the district's lowest-numbered Assembly district. Congressional candidates rotate among the Assembly districts within the district, so your sample ballot may differ.` };
  }
  return { candidates: base, note: `The Secretary of State's randomized-alphabet order. Where a district crosses county lines, each county draws its own order, so your sample ballot may differ.` };
}

// ---------------------------------------------------------------------------
// Which contests are on a ballot.

const SCOPE_ORDER = { statewide: 0, cd: 1, sldu: 2, sldl: 3, boe: 4, judicial: 5, county: 6 };

/** Judicial retention questions grouped by court: { id, name, court, district, counties, questions }. */
export function courtGroups(contests) {
  const groups = new Map();
  for (const c of contests.filter((x) => x.scope === "judicial")) {
    const id = c.court === "supreme" ? "supreme-court" : `court-of-appeal-${c.district}`;
    if (!groups.has(id)) groups.set(id, { id, name: c.court_name, court: c.court, district: c.district, counties: c.counties, questions: [] });
    groups.get(id).questions.push(c);
  }
  return [...groups.values()];
}

/**
 * A ballot's contests for known districts: { contests, courts, measures, partial }.
 * `d` is the districts cookie ({ st, cd, su, sl, co }); `countyName` names the
 * county (for the Courts of Appeal). Local contests are for parts of the
 * county (a supervisor district, a city, a school or water district), so they
 * come back as `partial`: on some ballots in the county.
 */
export function ballotFor(election, d, countyName = null) {
  const empty = { contests: [], courts: [], measures: [], partial: [], partialMeasures: [], boeKnown: false };
  if (!election || !d || d.st !== election.election.state) return empty;
  const county = d.co ? (election.counties || {})[d.co] : null;
  const boe = county ? county.boe : null;
  const contests = election.contests.filter((c) =>
    c.scope === "statewide" ||
    (c.scope === "cd" && d.cd && c.district === d.cd) ||
    (c.scope === "sldu" && d.su && c.district === d.su) ||
    (c.scope === "sldl" && d.sl && c.district === d.sl) ||
    (c.scope === "boe" && boe && c.district === boe));
  contests.sort((a, b) => SCOPE_ORDER[a.scope] - SCOPE_ORDER[b.scope]);
  const courts = courtGroups(election.contests).filter((g) => g.court === "supreme" || (countyName && g.counties.includes(countyName.replace(/ County$/, ""))));
  const measures = election.measures.filter((m) => m.scope === "statewide");
  const partial = d.co ? election.contests.filter((c) => c.scope === "county" && c.county === d.co) : [];
  const partialMeasures = d.co ? election.measures.filter((m) => m.scope === "county" && m.county === d.co) : [];
  return { contests, courts, measures, partial, partialMeasures, boeKnown: !!boe };
}

/** Short label for a contest's place, e.g. "Statewide", "Congressional District 5". */
export function scopeLabel(c) {
  return { statewide: "Statewide", cd: `Congressional District ${c.district}`, sldu: `State Senate District ${c.district}`, sldl: `Assembly District ${c.district}`, boe: `Board of Equalization District ${c.district}` }[c.scope] || "";
}

/** A contest's title as the ballot names the office. County titles are printed in capitals on the county's list. */
export function contestTitle(c) {
  return c.scope === "county" ? titleCase(c.office) : c.office;
}

const KEEP_UPPER = new Set(["CCD", "TA1", "TA2", "TA3", "TA4", "TA5", "FPD", "PUD", "USD", "UHSD", "CSD", "WD", "ID", "II", "III", "IV"]);
export function titleCase(s) {
  return String(s || "").split(/(\s+|-|,)/).map((w) => (KEEP_UPPER.has(w.toUpperCase()) || !/[A-Z]/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase())).join("");
}

/** A candidate's name as the source prints it; the county's capitals become title case (with a note on the page). */
export const displayName = (c, contest) => (contest.scope === "county" ? titleCase(c.name).replace(/\bIii\b/g, "III").replace(/\bIi\b/g, "II") : c.name);

// ---------------------------------------------------------------------------
// Candidates who already hold an office ThePillory follows: matched by name to
// the officials in D1 (California, its statewide offices, its legislature and
// members of Congress, and the live county's supervisors). Both the last name
// and the first name (or the nickname given in parentheses) must match.

const norm = (s) => letters(s).toLowerCase();
export function sameName(candidate, official) {
  const p = nameParts(candidate);
  const q = nameParts(official);
  if (!p.last || norm(p.last) !== norm(q.last)) return false;
  const nick = (/\(([^)]+)\)|"([^"]+)"|“([^”]+)”/.exec(candidate) || []).slice(1).find(Boolean);
  const firsts = [p.first, nick].filter(Boolean).map(norm);
  const of = norm(q.first);
  return firsts.some((f) => f && of && (f === of || (f.length >= 3 && of.startsWith(f)) || (of.length >= 3 && f.startsWith(of))));
}

export async function officeholders(db, state) {
  if (!db) return [];
  const { results } = await db
    .prepare("SELECT id, slug, name, office, district, chamber, level FROM officials WHERE active = 1 AND (state = ? OR chamber IN ('county-board', 'ca-executive'))")
    .bind(state)
    .all();
  return results;
}

export function holderFor(candidate, holders) {
  const hits = holders.filter((o) => sameName(candidate.name, o.name));
  return hits.length === 1 ? hits[0] : null;
}

// ---------------------------------------------------------------------------
// Results: the Secretary of State's results feed (api.sos.ca.gov/returns/),
// read only after the polls close, kept at the edge for two minutes.

export function pollsClosed(election, now = Date.now()) {
  return now >= Date.parse(election.election.polls_close_utc);
}

export async function sosResults(election, path) {
  if (!path || !pollsClosed(election)) return null;
  const url = `${election.election.results_api}${path}`;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(url);
  let res = cache ? await cache.match(key).catch(() => null) : null;
  if (!res) {
    res = await fetch(url, { headers: { Accept: "application/json", "User-Agent": "ThePillory/1.0 (+https://thepillory.co)" }, cf: { cacheTtl: 120 } });
    if (!res.ok) throw new Error(`results feed ${path}: HTTP ${res.status}`);
    const copy = new Response(res.clone().body, res);
    copy.headers.set("Cache-Control", "public, max-age=120");
    if (cache) await cache.put(key, copy).catch(() => {});
  }
  const data = await res.json();
  return Array.isArray(data) ? data[data.length - 1] : data;
}

const num = (v) => {
  const n = parseInt(String(v == null ? "" : v).replace(/[^0-9]/g, ""), 10);
  return Number.isFinite(n) ? n : null;
};

/** The feed's numbers for each candidate, in ballot order: [{ name, votes, percent }] (null where the feed has no row). */
export function candidateResults(feed, candidates) {
  const rows = (feed && feed.candidates) || [];
  return candidates.map((c) => {
    const r = rows.find((x) => sameName(c.name, x.Name) || norm(x.Name) === norm(c.name));
    return { name: c.name, votes: r ? num(r.Votes) : null, percent: r ? String(r.Percent) : null };
  });
}

export function measureResult(feed, number) {
  const rows = (feed && feed["ballot-measures"]) || [];
  const r = rows.find((x) => String(x.Number).replace(/^0+/, "") === String(number).replace(/^0+/, ""));
  return r ? { yes: num(r.yesVotes), yesPercent: String(r.yesPercent), no: num(r.noVotes), noPercent: String(r.noPercent) } : null;
}

// ---------------------------------------------------------------------------
// Shared bits of the pages.

const fmtInt = (n) => (n == null ? "—" : n.toLocaleString("en-US"));

export function resultsBlock(feed, rows, election, { pathLink }) {
  if (!feed) return "";
  return `
<div class="results stack-sm">
  <p class="label">Results so far</p>
  <ul class="plain-list results-list">${rows
    .map((r) => `<li class="result-row"><span class="result-name">${esc(r.name)}</span><span class="result-num">${fmtInt(r.votes)} votes · ${r.percent == null ? "—" : `${esc(r.percent)}%`}</span></li>`)
    .join("")}</ul>
  <p class="hint">${esc(feed.Reporting || "")}${feed.ReportingTime ? ` · as of ${esc(feed.ReportingTime)}` : ""}. Counting continues after Election Day until each county certifies its results. ThePillory doesn't call races. ${sourceLink(pathLink || election.election.results_page, "Secretary of State results")}</p>
</div>`;
}

/** Days from today (Pacific) to the election, or null once it's past. */
export function daysUntil(election, todayIso) {
  const a = Date.parse(`${todayIso}T00:00:00Z`);
  const b = Date.parse(`${election.election.date}T00:00:00Z`);
  const n = Math.round((b - a) / 86400000);
  return n >= 0 ? n : null;
}

export function whenLine(election, todayIso) {
  const n = daysUntil(election, todayIso);
  return `${fmtDate(election.election.date)}${n == null ? "" : n === 0 ? " · today" : n === 1 ? " · tomorrow" : ` · in ${n} days`}`;
}

/** "How to vote": official pages only, linked rather than restated. */
export function howToVote(election, countyFips = null, { heading = true } = {}) {
  const groups = [["California Secretary of State", election.how_to_vote.state]];
  const county = countyFips && election.how_to_vote[countyFips];
  if (county) groups.push([(election.counties[countyFips] || {}).name || "Your county", county]);
  return `
<section class="stack-sm" id="how-to-vote" aria-labelledby="h-how">
  ${heading ? '<h2 class="label" id="h-how">How to vote</h2>' : ""}
  ${groups
    .map(([name, links]) => `<div class="card stack-xs"><p class="label">${esc(name)}</p>${links
      .map((l) => (safeUrl(l.url) ? `<a class="list-row link-row" href="${esc(l.url)}" target="_blank" rel="noopener"><div><div class="list-title">${esc(l.label)}</div><div class="list-meta">${esc(l.by)}</div></div><span class="row-end"><span aria-hidden="true">↗</span></span></a>` : ""))
      .join("")}</div>`)
    .join("")}
  <p class="hint">Deadlines, vote centers and drop boxes can change, so ThePillory links to the official pages rather than repeating them.</p>
</section>`;
}

/** One contest as a list row (office, place, number of candidates). */
export function contestRow(electionId, c, note = "") {
  const n = c.candidates.length;
  const meta = [c.scope === "county" ? "" : scopeLabel(c), `${n} ${n === 1 ? "candidate" : "candidates"}`, note].filter(Boolean).join(" · ");
  return `
<a class="list-row link-row" href="${contestHref(electionId, c.id)}">
  <div><div class="list-title">${esc(contestTitle(c))}</div><div class="list-meta">${esc(meta)}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function measureRow(electionId, m, note = "") {
  const title = m.scope === "statewide" ? `Proposition ${m.number}` : `${m.title}${m.jurisdiction ? ` · ${m.jurisdiction}` : ""}`;
  const sub = m.scope === "statewide" ? titleCase(m.title) : note;
  return `
<a class="list-row link-row" href="${measureHref(electionId, m.id)}">
  <div><div class="list-title">${esc(title)}</div>${sub ? `<div class="list-meta">${esc(sub)}</div>` : ""}</div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function courtRow(electionId, g) {
  const n = g.questions.length;
  return `
<a class="list-row link-row" href="${contestHref(electionId, g.id)}">
  <div><div class="list-title">${esc(g.name)}</div><div class="list-meta">${n} ${n === 1 ? "justice" : "justices"} · yes or no on each</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

/**
 * "On the ballot" for a county or district page (the same for every visitor):
 * the contests for this place, with "covers part of" notes where a district
 * only covers part of it, and a "Your ballot" link that the browser shows only
 * when it has saved districts (data-if-districts, in assets/app.js).
 */
export function onTheBallot(election, { rows, intro = "", today = null, folded = false }) {
  const id = election.election.id;
  // folded: a collapsed section (summary-first pages), with the date beside its title.
  if (folded) {
    return fold("elections", "On the ballot", `<a class="out-link" href="${electionHref(id)}">Whole ballot</a>
  ${intro ? `<p class="small secondary">${esc(intro)}</p>` : ""}
  <div class="card">${rows.join("")}</div>
  <a class="btn btn--primary btn--block" href="${ballotHref(id)}" data-if-districts hidden>Your ballot</a>
  <p class="small" data-unless-districts><a class="inline-link" href="${ballotHref(id)}">Find your ballot</a> by address or ZIP code.</p>
  ${today ? `<p class="hint"><a class="inline-link" href="/elections/#how-to-vote">How to vote</a></p>` : ""}`, { meta: today ? whenLine(election, today) : fmtDate(election.election.date) });
  }
  return `
<section class="stack-sm" id="elections" aria-labelledby="h-elections">
  <div class="section-head"><h2 class="label" id="h-elections">On the ballot · ${esc(fmtDate(election.election.date))}</h2><a class="section-link" href="${electionHref(id)}">Whole ballot</a></div>
  ${intro ? `<p class="small secondary">${esc(intro)}</p>` : ""}
  <div class="card">${rows.join("")}</div>
  <a class="btn btn--primary btn--block" href="${ballotHref(id)}" data-if-districts hidden>Your ballot</a>
  <p class="small" data-unless-districts><a class="inline-link" href="${ballotHref(id)}">Find your ballot</a> by address or ZIP code.</p>
  ${today ? `<p class="hint">Election Day: ${esc(whenLine(election, today))}. <a class="inline-link" href="/elections/#how-to-vote">How to vote</a></p>` : ""}
</section>`;
}

/** A row linking to the whole statewide part of the ballot. */
export function statewideRow(election) {
  const offices = election.contests.filter((c) => c.scope === "statewide").length;
  const props = election.measures.filter((m) => m.scope === "statewide").length;
  return `
<a class="list-row link-row" href="${electionHref(election.election.id)}">
  <div><div class="list-title">Statewide offices and propositions</div><div class="list-meta">${offices} offices · ${props} propositions · on every ballot in ${esc(election.election.state === "CA" ? "California" : election.election.state)}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}
