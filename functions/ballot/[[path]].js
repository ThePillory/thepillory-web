// "Open your ballot", for every state (docs/elections.md):
//
//   /ballot/        the visitor's state's ballot page, or a state picker
//   /ballot/<st>/   before an address: the state's U.S. Senate race and, when the
//                   visitor's district is saved, their U.S. House race, from FEC
//                   filings (data/elections/federal-2026/<st>.json, built daily by
//                   tools/build_federal_races.py); incumbents linked to their Votes
//                   and Funding; the official places to check registration, find
//                   the sample ballot and where to vote (the state's election
//                   office from USA.gov, and Vote.gov); ThePillory's own ballot
//                   pages for the state where it has them.
//                   POST with an address: every contest, candidate and measure on
//                   that ballot, with polling places and early-voting sites, from
//                   the Google Civic Information API (functions/_lib/civic.js).
//
// The address is sent to Google for that one request and is never stored,
// logged or shown back (only the city and state are). The answer is never
// cached (Cache-Control: no-store). Every candidate gets the same layout, in the
// order the official data lists them; no endorsements, polls or predictions.
import { page, esc, notFound, safeUrl, linkRow, loadSection, FAILED, sectionError, guard, fmtDate } from "../_lib/render.js";
import { districtsFromCookie, STATE_NAME } from "../_lib/districts.js";
import { visitorState } from "../_lib/visitor-state.js";
import { asset } from "../_lib/geo.js";
import { loadElection, electionHref, ballotHref, measureHref, measureName, contestHref, ballotOrder, ELECTION_BY_STATE, measuresOnly, howToVote } from "../_lib/elections.js";
import { voterInfo, ballotFromVoterInfo, officialFor, measureFor, CivicError } from "../_lib/civic.js";
import { visitorHash } from "../_lib/turnstile.js";
import { fold } from "../_lib/summary.js";
import { candidateHref, raceHref, racesHref, YEAR } from "../_lib/candidates.js";

const BACK = ["Elections", "/elections/"];
export const CONFIRM = "Always confirm your ballot with your county election office.";
const NEUTRAL = "Every candidate is shown the same way, whatever their party. ThePillory doesn't endorse candidates or measures, and doesn't publish polls or predictions.";
const VOTE_GOV = "https://vote.gov/";
const USA_GOV = "https://www.usa.gov/state-election-office";
/** Address lookups a visitor may make in a day (keeps the Civic API's quota for everyone). */
export const LOOKUPS_PER_DAY = 20;
const PLACES_SHOWN = 3;
/** Places with no federal general election this year: Puerto Rico votes in presidential years. */
export const NO_GENERAL = new Set(["PR"]);

export const ballotPath = (st) => `/ballot/${String(st).toLowerCase()}/`;
const stateFrom = (s) => {
  const st = String(s || "").toUpperCase();
  return /^[A-Z]{2}$/.test(st) && STATE_NAME[st] ? st : null;
};

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) {
    const vs = visitorState(request, districtsFromCookie(request));
    if (vs && !url.searchParams.has("pick")) return Response.redirect(`${url.origin}${ballotPath(vs.st)}`, 302);
    return pickerPage();
  }
  const st = stateFrom(parts[0]);
  if (!st || parts.length > 1) return notFound("No ballot page at this address.", "home", BACK);
  if (parts[0] !== st.toLowerCase()) return Response.redirect(`${url.origin}${ballotPath(st)}`, 301);
  return statePage(env, request, st);
}, { tab: "home" });

export const onRequestPost = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  const st = stateFrom((params.path || [])[0]);
  if (!st) return notFound("No ballot page at this address.", "home", BACK);
  const form = await request.formData();
  const address = String(form.get("address") || "").replace(/\s+/g, " ").trim();
  if (address.length < 5 || address.length > 200) return statePage(env, request, st, { message: "Enter a street address with the city and state (or ZIP code)." });
  if (await overLimit(env, request)) return statePage(env, request, st, { message: `That's ${LOOKUPS_PER_DAY} address lookups today from this connection, the daily limit. Your state's official links below work any time.` });
  let data;
  try {
    data = await voterInfo(env, address);
  } catch (err) {
    if (!(err instanceof CivicError)) throw err;
    return noData(env, request, st, err.kind);
  }
  const ballot = ballotFromVoterInfo(data);
  return answerPage(env, request, stateFrom(ballot.stateCode) || st, ballot);
}, { tab: "home" });

/** Counts this lookup; true once the visitor is past the daily limit. Without the table yet (before the sync's migration), no limit. */
async function overLimit(env, request) {
  if (!env.DB) return false;
  try {
    const visitor = await visitorHash(env, request);
    const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM ballot_lookups WHERE visitor = ? AND created_at > datetime('now', '-1 day')").bind(visitor).first();
    if (r && r.n >= LOOKUPS_PER_DAY) return true;
    await env.DB.prepare("INSERT INTO ballot_lookups (visitor) VALUES (?)").bind(visitor).run();
    return false;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return false;
    throw err;
  }
}

/** A personal page that's never kept anywhere: it may come from an address. */
function privatePage(title, main, back) {
  const res = page(title, main, { tab: "home", back, personal: true });
  res.headers.set("Cache-Control", "private, no-store");
  return res;
}

// ---------------------------------------------------------------------------
// Data

const loadRaces = (env, request, st) => asset(env, request, `/data/elections/federal-2026/${st.toLowerCase()}.json`);

async function stateOffice(env, request, st) {
  const all = await asset(env, request, "/data/states/election-offices.json");
  const o = all && all.offices && all.offices[st];
  return o && safeUrl(o.url) ? { ...o, source: all.source } : null;
}

/** ThePillory's pages for the state's officials who have filed with the FEC, by candidate ID. */
async function filedOfficials(db, st) {
  if (!db) return {};
  const { results } = await db
    .prepare("SELECT f.candidate_id, o.slug, o.name, o.office FROM fec_candidates f JOIN officials o ON o.id = f.official_id WHERE o.active = 1 AND o.state = ? AND f.candidate_id IS NOT NULL")
    .bind(st)
    .all();
  return Object.fromEntries(results.map((r) => [r.candidate_id, r]));
}

/** The state's current officials, to link names on an address's ballot to their pages. */
async function stateOfficials(db, st) {
  if (!db) return [];
  return (await db.prepare("SELECT slug, name, last_name, office FROM officials WHERE active = 1 AND state = ?").bind(st).all()).results;
}

/** ThePillory's election for the state, when it has one (California's full ballot, Washington's measures). */
const ownElection = (env, request, st) => (ELECTION_BY_STATE[st] ? loadElection(env, request, ELECTION_BY_STATE[st]) : null);

// ---------------------------------------------------------------------------
// Pieces

function addressForm(st, { heading = "Open your ballot" } = {}) {
  return `
<section class="card stack-sm lookup" id="address" aria-labelledby="h-address">
  <h2 class="label" id="h-address">${esc(heading)}</h2>
  <p class="small">Every contest, candidate and measure on your ballot, with where to vote.</p>
  <form class="lookup-form" action="${ballotPath(st)}" method="post">
    <label class="visually-hidden" for="ballot-address">Street address, city and state</label>
    <div class="lookup-row">
      <input class="input" id="ballot-address" name="address" type="text" autocomplete="street-address" placeholder="Street address, city, state" minlength="5" maxlength="200" required />
      <button class="btn btn--primary" type="submit">Open</button>
    </div>
    <p class="hint">Sent to Google's Civic Information API for this one lookup, which answers with what election offices publish. ThePillory never stores or logs your address.</p>
  </form>
</section>`;
}

const outRow = (href, title, meta) =>
  safeUrl(href)
    ? `<a class="list-row link-row" href="${esc(href)}" target="_blank" rel="noopener"><div><div class="list-title">${esc(title)}</div>${meta ? `<div class="list-meta">${esc(meta)}</div>` : ""}</div><span class="row-end"><span aria-hidden="true">↗</span></span></a>`
    : "";

/** The official places to check: the state's election office and Vote.gov (and, where ThePillory has the election, its links). */
function officialLinks(st, office, election) {
  const name = STATE_NAME[st];
  return `
<section class="stack-sm" id="official" aria-labelledby="h-official">
  <h2 class="label" id="h-official">Check with the official sources</h2>
  <div class="card">
    ${office ? outRow(office.url, `${name}'s election office`, `${office.name === name ? "" : `${office.name}: `}your registration, sample ballot, where to vote and deadlines`) : outRow(USA_GOV, `Find ${name}'s election office`, "USA.gov")}
    ${outRow(VOTE_GOV, "Vote.gov", "Register or check your registration, and your state's deadlines")}
  </div>
  ${election && election.election.state === st ? howToVote(election, null, { heading: false }) : ""}
  <p class="hint">${office ? `${esc(name)}'s election office is as USA.gov lists it.` : ""}</p>
</section>`;
}

/** One FEC candidate. The same layout for everyone: name as filed, party as filed, incumbent, links. */
function fecCandidate(c, filed) {
  const own = filed[c.id];
  const links = [
    own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#votes">Votes</a>` : "",
    own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#funding">Funding</a>` : "",
    `<a class="inline-link" href="${esc(c.url)}" target="_blank" rel="noopener">FEC filing ↗</a>`,
  ].filter(Boolean).join(" · ");
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title"><a class="inline-link" href="${candidateHref(c.id)}">${esc(c.name)}</a></p>
    <p class="list-meta">${esc([c.party || "No party listed", c.incumbent ? "Incumbent" : ""].filter(Boolean).join(" · "))}</p>
    <p class="small">${links}</p>
  </li>`;
}

function fecRace(title, list, filed, href = null) {
  return `
  <div class="card stack-xs">
    <p class="label">${esc(title)}</p>
    ${list.length
      ? `<ul class="plain-list ballot-cands">${list.map((c) => fecCandidate(c, filed)).join("")}</ul>`
      : '<p class="small secondary">No candidates who have reached the FEC\'s filing threshold are listed yet.</p>'}
    ${href && list.length ? `<p class="small"><a class="inline-link" href="${href}">Every candidate's page: the race</a></p>` : ""}
  </div>`;
}

/** One candidate from the certified list: the same layout for everyone, in ballot order. */
function certifiedCandidate(c, filed) {
  const own = c.fec && filed[c.fec.id];
  const links = [
    own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#votes">Votes</a>` : "",
    own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#funding">Funding</a>` : "",
    c.fec && safeUrl(c.fec.url) ? `<a class="inline-link" href="${esc(c.fec.url)}" target="_blank" rel="noopener">FEC filing ↗</a>` : "",
  ].filter(Boolean).join(" · ");
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title">${c.fec && c.fec.id ? `<a class="inline-link" href="${candidateHref(c.fec.id)}">${esc(c.name)}</a>` : esc(c.name)}</p>
    <p class="list-meta">${esc([c.party ? `Party preference: ${c.party}` : "No party preference listed", c.designation].filter(Boolean).join(" · "))}</p>
    ${links ? `<p class="small">${links}</p>` : ""}
  </li>`;
}

/**
 * Where ThePillory has the state's certified candidate list (California), the U.S. House race from it:
 * only the candidates on the November ballot, in ballot order.
 */
function certifiedSection(st, election, filed, d) {
  const cd = d && d.st === st && d.cd != null ? String(Number(d.cd)) : null;
  const contest = cd && election.contests.find((c) => c.scope === "cd" && String(c.district) === cd);
  const senate = election.contests.filter((c) => c.scope === "statewide" && /united states senator/i.test(c.office));
  const race = (c) => {
    const { candidates, note } = ballotOrder(c, election);
    return `
  <div class="card stack-xs">
    <p class="label">${esc(c.office)}</p>
    <ul class="plain-list ballot-cands">${candidates.map((x) => certifiedCandidate(x, filed)).join("")}</ul>
    <p class="hint">${esc(note)} <a class="inline-link" href="${contestHref(election.election.id, c.id)}">Candidate statements</a> · <a class="inline-link" href="${raceHref(YEAR, st, c.scope === "cd" ? `house-${c.district}` : "senate")}">The race</a></p>
  </div>`;
  };
  return `
<section class="stack-sm" id="federal" aria-labelledby="h-federal">
  <h2 class="label" id="h-federal">Federal races · November 3, 2026</h2>
  ${senate.length ? senate.map(race).join("") : `<div class="card"><p class="small">No U.S. Senate seat in ${esc(STATE_NAME[st])} is on this ballot.</p></div>`}
  ${contest ? race(contest) : `<div class="card"><p class="small">Your U.S. House race: enter your address above, or <a class="inline-link" href="/#find">find your district</a> by ZIP code.</p></div>`}
  <p class="small"><a class="inline-link" href="${racesHref(YEAR, st)}">Every ${YEAR} race in ${esc(STATE_NAME[st])}, Governor and the Legislature too</a></p>
  <p class="hint">From the Secretary of State's Certified List of Candidates: only the candidates on the November ballot. <a class="inline-link" href="${esc(election.election.certified_list)}" target="_blank" rel="noopener">Certified list ↗</a></p>
</section>`;
}

function federalSection(st, races, filed, d, election = null) {
  const name = STATE_NAME[st];
  if (election && election.election.state === st && !measuresOnly(election)) return certifiedSection(st, election, filed === FAILED ? {} : filed, d);
  if (NO_GENERAL.has(st)) return `<div class="card"><p class="small">${esc(name)} holds its general elections in presidential election years, so there's no general election on November 3, 2026. Enter your address above for anything else on a ballot for it.</p></div>`;
  if (races === FAILED) return sectionError("Federal races");
  if (!races) return `<section class="stack-sm"><h2 class="label">Federal races</h2><div class="card"><p class="small secondary">${esc(name)}'s federal candidate lists appear after the daily election data refresh.</p></div></section>`;
  const filedMap = filed === FAILED ? {} : filed;
  const cd = d && d.st === st && d.cd != null ? String(Number(d.cd)) : null;
  const districts = Object.keys(races.house || {});
  const atLarge = districts.length === 1 && districts[0] === "0";
  const houseKey = atLarge ? "0" : cd;
  const houseTitle = st === "DC" ? "Delegate to the U.S. House" : atLarge ? "U.S. House, at large" : `U.S. House, District ${houseKey}`;
  const house = houseKey != null && races.house ? fecRace(houseTitle, races.house[houseKey] || [], filedMap, raceHref(YEAR, st, `house-${houseKey}`)) : "";
  return `
<section class="stack-sm" id="federal" aria-labelledby="h-federal">
  <h2 class="label" id="h-federal">Federal races · November 3, 2026</h2>
  ${races.senate_up ? fecRace(`U.S. Senate · ${name}`, races.senate || [], filedMap, raceHref(YEAR, st, "senate")) : `<div class="card"><p class="small">No U.S. Senate seat in ${esc(name)} is up this year, by the FEC's list of 2026 races.</p></div>`}
  ${house || `<div class="card"><p class="small">Your U.S. House race: enter your address above, or <a class="inline-link" href="/#find">find your district</a> by ZIP code.</p></div>`}
  <p class="small"><a class="inline-link" href="${racesHref(YEAR, st)}">Every ${YEAR} race in ${esc(name)}</a></p>
  <p class="hint">Candidates who have filed with the Federal Election Commission and passed its $5,000 threshold, listed alphabetically, names as filed. Not everyone listed will be on your ballot (some lose a primary or withdraw); your sample ballot is final. <a class="inline-link" href="${esc(races.source_url)}" target="_blank" rel="noopener">FEC list ↗</a> · updated ${esc(fmtDate(races.built_on))}.</p>
</section>`;
}

/** ThePillory's own pages for this state's election, where it has them. */
function ownSection(st, election) {
  if (!election || election.election.state !== st) return "";
  const id = election.election.id;
  const rows = measuresOnly(election)
    ? election.measures.filter((m) => m.scope === "statewide").map((m) => linkRow(measureHref(id, m.id), measureName(m), "Official arguments for and against, word for word")).join("")
    : `${linkRow(ballotHref(id), "Your ballot on ThePillory", "Every contest for your districts, with candidate statements word for word")}${linkRow(electionHref(id), "Everything on the ballot", "Statewide offices, propositions with official arguments, courts")}`;
  return `
<section class="stack-sm" aria-labelledby="h-own">
  <h2 class="label" id="h-own">On ThePillory</h2>
  <div class="card">${rows}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// /ballot/

function pickerPage() {
  const states = Object.entries(STATE_NAME).filter(([st]) => !["AS", "GU", "MP", "VI"].includes(st));
  const main = `
<header class="page-head stack-xs">
  <h1>Open your ballot</h1>
  <p class="subtitle">Pick your state for its federal races and official voting links, then enter your address for your whole ballot.</p>
</header>
<ul class="card plain-list">${states.map(([st, name]) => `<li>${linkRow(ballotPath(st), name, "")}</li>`).join("")}</ul>
<p class="hint">${esc(CONFIRM)}</p>`;
  return page("Open your ballot", main, { tab: "home", back: BACK });
}

// ---------------------------------------------------------------------------
// /ballot/<st>/ before an address

async function statePage(env, request, st, { message = "" } = {}) {
  const d = districtsFromCookie(request);
  const name = STATE_NAME[st];
  const [races, filed, office, election] = await Promise.all([
    loadSection("ballot races", () => loadRaces(env, request, st), null),
    loadSection("ballot filed officials", () => filedOfficials(env.DB, st), {}),
    loadSection("ballot office", () => stateOffice(env, request, st), null),
    loadSection("ballot election", () => ownElection(env, request, st), null),
  ]);
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(name)}${NO_GENERAL.has(st) ? "" : " · General election, November 3, 2026"}</p>
  <h1>Your ballot</h1>
  <p class="subtitle">What's on your ballot, from official sources.</p>
</header>
${message ? `<p class="banner banner--error" role="alert">${esc(message)}</p>` : ""}
<p class="banner">${esc(CONFIRM)}</p>
${addressForm(st)}
${federalSection(st, races, filed, d, election === FAILED ? null : election)}
${ownSection(st, election === FAILED ? null : election)}
${officialLinks(st, office === FAILED ? null : office, election === FAILED ? null : election)}
<p class="small"><a class="inline-link" href="/ballot/?pick=1">A different state</a></p>
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>`;
  return privatePage(`Your ballot, ${name}`, main, BACK);
}

// ---------------------------------------------------------------------------
// With an address

const NO_DATA = {
  "not-found": "There's no ballot information for this address yet. Election offices publish their ballot data in the weeks before an election, and not every county does.",
  address: "That address couldn't be read. Check the street, city and state, and try again.",
  unavailable: "The ballot lookup didn't answer just now. Try again in a minute.",
  "no-key": "The address lookup isn't switched on yet.",
};

async function noData(env, request, st, kind, ballot = null) {
  const name = STATE_NAME[st];
  const [office, election] = await Promise.all([
    loadSection("ballot office", () => stateOffice(env, request, st), null),
    loadSection("ballot election", () => ownElection(env, request, st), null),
  ]);
  const o = office === FAILED ? null : office;
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(name)}</p>
  <h1>Your ballot</h1>
</header>
<p class="banner">${esc(CONFIRM)}</p>
<section class="card stack-sm">
  <p>${esc(NO_DATA[kind] || NO_DATA["not-found"])}</p>
  <p class="small">Your sample ballot is on ${o ? `<a class="inline-link" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(name)}'s election office website ↗</a>` : `<a class="inline-link" href="${USA_GOV}" target="_blank" rel="noopener">your state's election office ↗</a>`}, and your county election office mails it before Election Day.</p>
</section>
${ballot ? placesSections(ballot) : ""}
${addressForm(st, { heading: "Try another address" })}
${ownSection(st, election === FAILED ? null : election)}
${officialLinks(st, o, election === FAILED ? null : election)}
<p class="small"><a class="inline-link" href="${ballotPath(st)}">${esc(name)}'s federal races</a></p>`;
  return privatePage("Your ballot", main, [`${name} ballot`, ballotPath(st)]);
}

function civicCandidate(c, officials) {
  const own = officialFor(c.name, officials);
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title">${esc(c.name)}</p>
    <p class="list-meta">${esc(c.party || "No party listed")}</p>
    ${own ? `<p class="small"><a class="inline-link" href="/reps/${esc(own.slug)}/">${esc(own.office)} now · on ThePillory</a></p>` : ""}
  </li>`;
}

function civicContest(c, { officials, election }) {
  if (c.kind === "referendum") {
    const r = c.referendum;
    const ours = measureFor(r, election);
    return `
  <div class="card stack-xs">
    <p class="label">Measure</p>
    <h3>${esc(r.title || c.title)}</h3>
    ${r.subtitle ? `<p class="small">${esc(r.subtitle)}</p>` : ""}
    ${r.brief ? `<p class="small secondary">${esc(r.brief)}</p>` : ""}
    ${ours ? `<p class="small"><a class="inline-link" href="${measureHref(election.election.id, ours.id)}">Official arguments for and against, on ThePillory</a></p>` : ""}
    ${r.url ? `<p class="small"><a class="inline-link" href="${esc(r.url)}" target="_blank" rel="noopener">Official text ↗</a></p>` : ""}
  </div>`;
  }
  const meta = [c.district, c.office && c.office !== c.title ? c.office : ""].filter(Boolean).join(" · ");
  return `
  <div class="card stack-xs">
    <h3>${esc(c.title)}</h3>
    ${meta ? `<p class="small secondary">${esc(meta)}</p>` : ""}
    ${c.candidates.length
      ? `<ul class="plain-list ballot-cands">${c.candidates.map((x) => civicCandidate(x, officials)).join("")}</ul>`
      : '<p class="small secondary">No candidates listed in the official data.</p>'}
  </div>`;
}

function placeItem(p) {
  return `
  <li class="list-row"><div>
    <div class="list-title">${esc(p.name || p.address)}</div>
    <div class="list-meta">${esc([p.name ? p.address : "", p.city].filter(Boolean).join(", "))}</div>
    ${p.dates.length || p.hours ? `<div class="list-meta">${esc([p.dates.map((x) => (/^\d{4}-\d{2}-\d{2}$/.test(x) ? fmtDate(x) : x)).join(" to "), p.hours].filter(Boolean).join(" · "))}</div>` : ""}
  </div></li>`;
}

function placeList(id, title, list) {
  if (!list.length) return "";
  const first = `<ul class="card plain-list">${list.slice(0, PLACES_SHOWN).map(placeItem).join("")}</ul>`;
  const rest = list.length > PLACES_SHOWN ? fold(`${id}-more`, `${list.length - PLACES_SHOWN} more`, `<ul class="card plain-list">${list.slice(PLACES_SHOWN).map(placeItem).join("")}</ul>`) : "";
  return `<section class="stack-sm" id="${id}" aria-labelledby="h-${id}"><h2 class="label" id="h-${id}">${esc(title)}</h2>${first}${rest}</section>`;
}

function placesSections(b) {
  return `
${b.mailOnly ? '<p class="small">This address votes by mail: your ballot comes by mail, with how to return it.</p>' : ""}
${placeList("polling", "Where to vote on Election Day", b.polling)}
${placeList("early", "Early voting", b.early)}
${placeList("dropoff", "Ballot drop-off", b.dropOff)}`;
}

function civicLinks(b) {
  const groups = [b.county, b.state].filter((g) => g && g.links.length);
  if (!groups.length) return "";
  return `
<section class="stack-sm" aria-labelledby="h-civic-links">
  <h2 class="label" id="h-civic-links">Official links for this address</h2>
  ${groups.map((g) => `<div class="card stack-xs">${g.name ? `<p class="label">${esc(g.name)}</p>` : ""}${g.links.map((l) => outRow(l.url, l.label, "")).join("")}</div>`).join("")}
</section>`;
}

async function answerPage(env, request, st, b) {
  if (!b.contests.length) return noData(env, request, st, "not-found", b);
  const name = STATE_NAME[st];
  const [officials, election, office] = await Promise.all([
    loadSection("ballot officials", () => stateOfficials(env.DB, st), []),
    loadSection("ballot election", () => ownElection(env, request, st), null),
    loadSection("ballot office", () => stateOffice(env, request, st), null),
  ]);
  const ctx = { officials: officials === FAILED ? [] : officials, election: election === FAILED ? null : election };
  const sourceNames = [...new Set(b.contests.flatMap((c) => c.sources.map((s) => s.name)).filter(Boolean))];
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(b.election.name || "Your ballot")}${b.election.day ? ` · ${esc(fmtDate(b.election.day))}` : ""}</p>
  <h1>Your ballot</h1>
  ${b.where ? `<p class="subtitle">For an address in ${esc(b.where)}</p>` : ""}
</header>
<p class="banner">${esc(CONFIRM)}</p>
<section class="stack-sm" id="contests" aria-labelledby="h-contests">
  <h2 class="label" id="h-contests">${b.contests.length} ${b.contests.length === 1 ? "contest" : "contests and measures"}</h2>
  ${b.contests.map((c) => civicContest(c, ctx)).join("")}
  <p class="hint">In the order the official data lists them, with each candidate's party as listed. Every candidate is shown the same way. From the Google Civic Information API${sourceNames.length ? `, which carries ${esc(sourceNames.join(", "))}` : ""}: what state and county election offices publish.</p>
</section>
${placesSections(b)}
${civicLinks(b)}
${b.otherElections.length ? `<p class="small secondary">Also for this address: ${esc(b.otherElections.map((e) => `${e.name}${e.day ? ` (${fmtDate(e.day)})` : ""}`).join("; "))}.</p>` : ""}
${addressForm(st, { heading: "Look up another address" })}
${officialLinks(st, office === FAILED ? null : office, ctx.election)}
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>`;
  return privatePage("Your ballot", main, [`${name} ballot`, ballotPath(st)]);
}
