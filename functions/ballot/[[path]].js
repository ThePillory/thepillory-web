// The ballot preview, for every state (docs/elections.md): "Preview [State]'s ballot"
// before an address, "Your ballot preview" after one.
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
//                   Once an office's primary (and its runoff or convention) has
//                   passed, the FEC list isn't the ballot (it still holds people who
//                   lost a primary or withdrew): that race asks for the address and
//                   links the state's official candidate list instead, with the FEC
//                   list only behind a separate "Filed with the FEC in 2026" link.
//                   POST with an address: every contest, candidate and measure on
//                   that ballot, with polling places and early-voting sites, from
//                   the Google Civic Information API (functions/_lib/civic.js).
//                   POST with a ZIP code alone: the county and districts the ZIP
//                   covers (data/zip/), the statewide races and measures, and a
//                   request for the street address. Never presented as the ballot.
//
// What the visitor enters always wins: a result never uses the saved districts
// cookie, and a failed lookup says so for what they entered instead of showing
// their saved place ("Use my saved place instead" is a link, only when it
// differs). A lookup never changes the cookie; "Make this my place" does.
// The address is sent to Google for that one request and is never stored or
// logged; it's shown back only on that one answer, which is never cached
// (Cache-Control: no-store). Every candidate gets the same layout, in the
// order the official data lists them; no endorsements, polls or predictions.
import { simpleCard } from "../_lib/simple.js";
import { page, esc, notFound, safeUrl, linkRow, loadSection, FAILED, sectionError, guard, fmtDate, partyName } from "../_lib/render.js";
import { districtsFromCookie, STATE_NAME } from "../_lib/districts.js";
import { districtLabel as seatLabel } from "../../workers/sync/src/states.js";
import { visitorState } from "../_lib/visitor-state.js";
import { asset, loadPlace, placeHref, districtHref } from "../_lib/geo.js";
import { loadElection, electionHref, ballotHref, measureHref, measureName, measureTitle, measureHeading, titleNote, contestHref, ballotOrder, ELECTION_BY_STATE, measuresOnly, howToVote, judicialContests, judicialRow } from "../_lib/elections.js";
import { voterInfo, ballotFromVoterInfo, measureFor, CivicError } from "../_lib/civic.js";
import { factsFold } from "../_lib/measure-facts.js";
import { visitorHash } from "../_lib/turnstile.js";
import { fold } from "../_lib/summary.js";
import { statePossessive, RESULT_HEADING, nominations, nominationWords, todayIn } from "../_lib/election-window.js";
import { candidateHref, raceHref, racesHref, YEAR, recordsFor, raceIncumbency, openSeatLine, candFacts } from "../_lib/candidates.js";
import { loadCertified, certifiedRace } from "../_lib/certified.js";

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

/** A ZIP code on its own ("95120", "95120-1234"): looked up in data/zip/, never sent to Google. */
export const ZIP = /^(\d{5})(?:-\d{4})?$/;

/** The saved place (the districts cookie) in words: "Calaveras County, CA", else the state and House district. */
async function savedLabel(env, request, saved) {
  if (saved.co) {
    const place = await loadPlace(env, request, saved.st.toLowerCase()).catch(() => null);
    const county = place && (place.counties || []).find((c) => c.fips === saved.co);
    if (county) return `${county.name}, ${saved.st}`;
  }
  return [STATE_NAME[saved.st], saved.cd && saved.cd !== "0" ? `Congressional District ${saved.cd}` : ""].filter(Boolean).join(", ");
}

/**
 * The line at the top of every result: what it shows (what the visitor entered), and their saved
 * place as a link only when one exists and differs. `same` is true only when the result is known
 * to be the saved place.
 */
async function showingLine(env, request, entered, { same = false } = {}) {
  const saved = districtsFromCookie(request);
  const other = saved && !same ? ` · <a class="inline-link" href="${ballotPath(saved.st)}">${esc(`Use my saved place (${await savedLabel(env, request, saved)}) instead`)}</a>` : "";
  return `<p class="small showing"><strong>Showing:</strong> ${esc(entered)}${other}</p>`;
}

/** "Make this my place": the one way a ballot lookup changes the saved districts (through /api/districts). */
function makeMyPlace(q, st, hint) {
  return `
<form class="stack-xs" method="post" action="/api/districts">
  <input type="hidden" name="q" value="${esc(q)}" />
  <input type="hidden" name="next" value="${ballotPath(st)}" />
  <button class="btn" type="submit">Make this my place</button>
  <p class="hint">${esc(hint)}</p>
</form>`;
}

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
  // Whatever was entered wins: none of these answers reads the saved districts cookie.
  if (address.length < 5 || address.length > 200) return statePage(env, request, st, { message: "Enter a street address with the city and state, or a 5-digit ZIP code.", entered: address });
  const zip = ZIP.exec(address);
  if (zip) return zipPage(env, request, st, zip[1]);
  if (await overLimit(env, request)) return statePage(env, request, st, { message: `That's ${LOOKUPS_PER_DAY} address lookups today from this connection, the daily limit. Your state's official links below work any time.`, entered: address });
  let data;
  try {
    data = await voterInfo(env, address);
  } catch (err) {
    if (!(err instanceof CivicError)) throw err;
    return noData(env, request, st, err.kind, null, address);
  }
  const ballot = ballotFromVoterInfo(data);
  return answerPage(env, request, stateFrom(ballot.stateCode) || st, ballot, address);
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

/** The state's officials in ThePillory's records (recordsFor()), and `filed`: the current ones who have filed with the FEC, by candidate ID. */
async function filedOfficials(db, st) {
  const records = await recordsFor(db, st);
  return { records, filed: Object.fromEntries(Object.entries(records.byFec).filter(([, o]) => o.active)) };
}

/** A candidate's links, as bullets under their facts: the incumbent's record first ("Votes and record ›"), otherwise their votes and funding when they hold another office, and the FEC filing. */
function candLinks(own, me, fecUrl) {
  return [
    me && me.holder ? `<a class="inline-link" href="/reps/${esc(me.holder.slug)}/#votes">Votes and record ›</a>` : own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#votes">Votes</a>` : "",
    own ? `<a class="inline-link" href="/reps/${esc(own.slug)}/#funding">Funding</a>` : "",
    fecUrl && safeUrl(fecUrl) ? `<a class="inline-link" href="${esc(fecUrl)}" target="_blank" rel="noopener">FEC filing ↗</a>` : "",
  ].filter(Boolean);
}
const withIncumbent = (parts, me) => [...parts, me ? "Incumbent" : ""].filter(Boolean);

/** ThePillory's election for the state, when it has one (California's full ballot, Washington's measures). */
const ownElection = (env, request, st) => (ELECTION_BY_STATE[st] ? loadElection(env, request, ELECTION_BY_STATE[st]) : null);

// ---------------------------------------------------------------------------
// Pieces

// "Your exact ballot": the optional next step after the statewide preview. Its own
// wording ("Show my ballot"), never the "Preview [State]'s ballot" label that leads here.
const EXACT = "Your exact ballot";
const EXACT_LINE = "Add your address for local contests and where to vote.";
function addressForm(st, { heading = EXACT } = {}) {
  return `
<section class="card stack-sm lookup simple-keep" id="address" aria-labelledby="h-address">
  <h2 class="label" id="h-address">${esc(heading)}</h2>
  <p class="small">${esc(EXACT_LINE)}</p>
  <form class="lookup-form" action="${ballotPath(st)}" method="post">
    <label class="visually-hidden" for="ballot-address">Street address, city and state</label>
    <div class="stack-sm">
      <input class="input" id="ballot-address" name="address" type="text" autocomplete="street-address" placeholder="Street address, city, state" minlength="5" maxlength="200" required />
      <div><button class="btn btn--primary" type="submit">Show my ballot</button></div>
    </div>
    <p class="hint">An address is sent to Google's Civic Information API for this one lookup; a ZIP code alone is looked up on ThePillory and shows the districts it covers. ThePillory never stores or logs either, and a lookup doesn't change your saved place.</p>
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

/** One FEC candidate. The same layout for everyone: name as filed, party as filed, "Incumbent" only for the seat's holder, links. */
function fecCandidate(c, filed, inc) {
  const me = inc.get(c.id, c.name);
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title"><a class="inline-link" href="${candidateHref(c.id)}">${esc(c.name)}</a></p>
    ${candFacts(withIncumbent([partyName(c.party) || "No party listed"], me), candLinks(filed[c.id], me, c.url))}
  </li>`;
}

function fecRace(title, list, filed, href = null, inc) {
  return `
  <div class="card stack-xs">
    <p class="label">${esc(title)}</p>
    ${openSeatLine(inc.open)}
    ${list.length
      ? `<ul class="plain-list ballot-cands">${list.map((c) => fecCandidate(c, filed, inc)).join("")}</ul>`
      : '<p class="small secondary">No candidates who have reached the FEC\'s filing threshold are listed yet.</p>'}
    ${href && list.length ? `<p class="small"><a class="inline-link" href="${href}">Every candidate's page: the race</a></p>` : ""}
  </div>`;
}

/** One candidate from the certified list: the same layout for everyone, in ballot order. */
function certifiedCandidate(c, filed, inc, contest, election) {
  const own = c.fec && filed[c.fec.id];
  const me = inc.get(c.fec && c.fec.id, c.name);
  // The statement, word for word, is on the candidate's page (or the contest's, for a candidate without an FEC filing).
  const statement = c.statement
    ? `<a class="inline-link" href="${c.fec && c.fec.id ? `${candidateHref(c.fec.id)}#statement` : contestHref(election.election.id, contest.id)}">Read their statement ›</a>`
    : contest.scope === "statewide" ? "No statement in the voter guide" : null;
  const links = [...candLinks(own, me, c.fec && c.fec.url), statement].filter(Boolean);
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title">${c.fec && c.fec.id ? `<a class="inline-link" href="${candidateHref(c.fec.id)}">${esc(c.name)}</a>` : esc(c.name)}</p>
    ${candFacts(withIncumbent([c.party ? `Party preference: ${partyName(c.party)}` : "No party preference listed", c.designation], me), links)}
  </li>`;
}

/**
 * Where ThePillory has the state's certified candidate list (California), the U.S. House race from it:
 * only the candidates on the November ballot, in ballot order.
 */
function certifiedSection(st, election, filed, d, records, houseNote = HOUSE_NOTE) {
  const incFor = (c) => raceIncumbency({ st, key: c.scope === "cd" ? `house-${c.district}` : c.scope === "statewide" && /united states senator/i.test(c.office) ? "senate" : c.id, contest: c, ballot: c.candidates, records });
  const cd = d && d.st === st && d.cd != null ? String(Number(d.cd)) : null;
  const contest = cd && election.contests.find((c) => c.scope === "cd" && String(c.district) === cd);
  const senate = election.contests.filter((c) => c.scope === "statewide" && /united states senator/i.test(c.office));
  const race = (c) => {
    const { candidates, note } = ballotOrder(c, election);
    const inc = incFor(c);
    return `
  <div class="card stack-xs">
    <p class="label">${esc(c.office)}</p>
    ${openSeatLine(inc.open)}
    <ul class="plain-list ballot-cands">${candidates.map((x) => certifiedCandidate(x, filed, inc, c, election)).join("")}</ul>
    <p class="hint">${esc(note)} <a class="inline-link" href="${contestHref(election.election.id, c.id)}">Candidate statements</a> · <a class="inline-link" href="${raceHref(YEAR, st, c.scope === "cd" ? `house-${c.district}` : "senate")}">The race</a></p>
  </div>`;
  };
  // Statewide: on every ballot in the state. Each office in ballot order (as in Assembly District 1)
  // and each proposition, linked to its page.
  const offices = election.contests.filter((c) => c.scope === "statewide" && !/united states senator/i.test(c.office));
  const props = (election.measures || []).filter((m) => m.scope === "statewide");
  const id = election.election.id;
  const statewide = offices.length || props.length
    ? `
<section class="stack-sm simple-keep" id="statewide" aria-labelledby="h-statewide">
  <h2 class="label" id="h-statewide">On every ${esc(STATE_NAME[st])} ballot · November 3, 2026</h2>
  ${offices.length ? `<div class="card">${offices.map((c) => { const inc = incFor(c); return linkRow(raceHref(YEAR, st, c.id), c.office, [ballotOrder(c, election).candidates.map((x) => `${x.name}${inc.get(x.fec && x.fec.id, x.name) ? " (Incumbent)" : ""}`).join(" · "), inc.open ? `Open seat: ${inc.open.name} isn't running for this seat` : ""].filter(Boolean).join(". ")); }).join("")}</div>` : ""}
  ${props.length ? `<div class="stack-sm">${props.map((m) => factsFold(election, m, { href: measureHref(id, m.id), ...measureHeading(m) })).join("")}</div>` : ""}
  <p class="hint">Candidates in ballot order as on ballots in Assembly District 1 (statewide offices rotate by district). Each proposition opens to its facts, from the official guide; its page has the rest, including each side's arguments. ${esc(titleNote(props))}</p>
</section>`
    : "";
  return `${statewide}
<section class="stack-sm" id="federal" aria-labelledby="h-federal">
  <h2 class="label" id="h-federal">Federal races · November 3, 2026</h2>
  ${senate.length ? senate.map(race).join("") : `<div class="card"><p class="small">No U.S. Senate seat in ${esc(STATE_NAME[st])} is on this ballot.</p></div>`}
  ${contest ? race(contest) : `<div class="card"><p class="small">${houseNote}</p></div>`}
  <p class="small"><a class="inline-link" href="${racesHref(YEAR, st)}">Every ${YEAR} race in ${esc(STATE_NAME[st])}, Governor and the Legislature too</a></p>
  <p class="hint">From the Secretary of State's Certified List of Candidates: only the candidates on the November ballot. <a class="inline-link" href="${esc(election.election.certified_list)}" target="_blank" rel="noopener">Certified list ↗</a></p>
</section>`;
}

/** A race from the state's own certified candidate list: only who the state certified, as it lists them. */
function stateListRace(title, race, filed, href, inc) {
  const cand = (c) => {
    const own = c.fec && filed[c.fec.id];
    const me = inc.get(c.fec && c.fec.id, c.name);
    const links = candLinks(own, me, c.fec && c.fec.url);
    return `
  <li class="ballot-cand stack-xs">
    <p class="list-title">${c.fec ? `<a class="inline-link" href="${candidateHref(c.fec.id)}">${esc(c.name)}</a>` : esc(c.name)}</p>
    ${candFacts(withIncumbent([partyName(c.party) || "No party listed"], me), links)}
  </li>`;
  };
  return `
  <div class="card stack-xs">
    <p class="label">${esc(title)}</p>
    ${openSeatLine(inc.open)}
    <ul class="plain-list ballot-cands">${race.candidates.map(cand).join("")}</ul>
    <p class="small"><a class="inline-link" href="${href}">The race</a></p>
  </div>`;
}

/**
 * A race whose nominees are settled: no list of names (the FEC's includes people who lost a primary
 * or withdrew), the address box, the state's official candidate list, and the FEC list behind its own link.
 */
function settledRace(title, st, events, office, fecHref) {
  const name = STATE_NAME[st];
  return `
  <div class="card stack-sm">
    <h3>${esc(title)}</h3>
    <p class="small">${esc(name)} chose its nominees for this office in ${esc(nominationWords(events))}. Enter your address to see the candidates on your ballot.</p>
    <a class="btn btn--primary" href="#address">Enter your address</a>
    <p class="small">Official candidate list: ${office ? `<a class="inline-link" href="${esc(office.url)}" target="_blank" rel="noopener">${esc(name)}'s election office ↗</a>` : `<a class="inline-link" href="${USA_GOV}" target="_blank" rel="noopener">your state's election office ↗</a>`}</p>
    <p class="small secondary"><a class="inline-link" href="${esc(fecHref)}">Filed with the FEC in 2026</a>: everyone who filed, including candidates who lost a primary or withdrew. Not the ballot.</p>
  </div>`;
}

const HOUSE_NOTE = 'Your U.S. House race: <a class="inline-link" href="#address">add your address below</a>, or <a class="inline-link" href="/#find">find your district</a> by ZIP code.';

function federalSection(st, races, loaded, d, election = null, { dates = null, office = null, today = todayIn(st), certified = null, houseNote = HOUSE_NOTE } = {}) {
  const name = STATE_NAME[st];
  const { records, filed } = loaded === FAILED || !loaded || !loaded.records ? { records: { officials: [], byFec: {} }, filed: {} } : loaded;
  if (election && election.election.state === st && !measuresOnly(election)) return certifiedSection(st, election, filed, d, records, houseNote);
  if (NO_GENERAL.has(st)) return `<div class="card"><p class="small">${esc(name)} holds its general elections in presidential election years, so there's no general election on November 3, 2026. <a class="inline-link" href="#address">Add your address below</a> for anything else on a ballot for it.</p></div>`;
  if (races === FAILED) return sectionError("Federal races");
  if (!races) return `<section class="stack-sm"><h2 class="label">Federal races</h2><div class="card"><p class="small secondary">${esc(name)}'s federal candidate lists appear after the daily election data refresh.</p></div></section>`;
  const filedMap = filed;
  // Who holds each seat now, from the race's list and ThePillory's records.
  const incOf = (key, list, stateList = null) => raceIncumbency({ st, key, ballot: stateList ? stateList.candidates : null, fecList: list, records });
  const cd = d && d.st === st && d.cd != null ? String(Number(d.cd)) : null;
  const districts = Object.keys(races.house || {});
  const atLarge = districts.length === 1 && districts[0] === "0";
  const houseKey = atLarge ? "0" : cd;
  const houseTitle = st === "DC" ? "Delegate to the U.S. House" : atLarge ? "U.S. House, at large" : `U.S. House, District ${houseKey}`;
  // The FEC list stands for the field only while the office's primary is still ahead.
  const senateNom = nominations(dates, st, "U.S. Senate", today, YEAR);
  const houseNom = nominations(dates, st, "U.S. House", today, YEAR);
  const senateTitle = `U.S. Senate · ${name}`;
  // The state's own certified list, where it's loaded, stands for the ballot: never the FEC list.
  const certSenate = certifiedRace(certified, "senate", races.senate || []);
  const certHouse = houseKey == null ? null : certifiedRace(certified, `house-${houseKey}`, (races.house || {})[houseKey] || []);
  const senate = certSenate ? stateListRace(senateTitle, certSenate, filedMap, raceHref(YEAR, st, "senate"), incOf("senate", races.senate || [], certSenate))
    : !races.senate_up
    ? `<div class="card"><p class="small">No U.S. Senate seat in ${esc(name)} is up this year, by the FEC's list of 2026 races.</p></div>`
    : senateNom.open ? fecRace(senateTitle, races.senate || [], filedMap, raceHref(YEAR, st, "senate"), incOf("senate", races.senate || []))
    : settledRace(senateTitle, st, senateNom.events, office, raceHref(YEAR, st, "senate"));
  const house = certHouse ? stateListRace(houseTitle, certHouse, filedMap, raceHref(YEAR, st, `house-${houseKey}`), incOf(`house-${houseKey}`, (races.house || {})[houseKey] || [], certHouse))
    : houseKey == null || !races.house ? ""
    : houseNom.open ? fecRace(houseTitle, races.house[houseKey] || [], filedMap, raceHref(YEAR, st, `house-${houseKey}`), incOf(`house-${houseKey}`, races.house[houseKey] || []))
    : settledRace(houseTitle, st, houseNom.events, office, raceHref(YEAR, st, `house-${houseKey}`));
  const anyOpen = (races.senate_up && !certSenate && senateNom.open) || (house && !certHouse && houseNom.open);
  const src = (certSenate || certHouse || {}).source;
  const certNote = src
    ? `<p class="hint">From ${esc(src.name || `${name}'s certified candidate list`)}${safeUrl(src.url) ? ` <a class="inline-link" href="${esc(src.url)}" target="_blank" rel="noopener">Official list ↗</a>` : ""}${(certSenate || certHouse).read_on ? ` · read ${esc(fmtDate((certSenate || certHouse).read_on))}` : ""}. Names and parties as the state lists them; the order on your ballot may differ. A name links to its FEC filing only when exactly one filer in the race has that name.</p>`
    : "";
  return `
<section class="stack-sm" id="federal" aria-labelledby="h-federal">
  <h2 class="label" id="h-federal">Federal races · November 3, 2026</h2>
  ${senate}
  ${house || `<div class="card"><p class="small">${houseNote}</p></div>`}
  ${certNote}
  ${anyOpen ? `<p class="hint">Before the primary: everyone who has filed with the Federal Election Commission and passed its $5,000 threshold, listed alphabetically, names as filed. Not everyone listed will be on the November ballot (some lose the primary or withdraw). <a class="inline-link" href="${esc(races.source_url)}" target="_blank" rel="noopener">FEC list ↗</a> · updated ${esc(fmtDate(races.built_on))}.</p>` : ""}
</section>`;
}

/**
 * "On every [State] ballot" for a state where ThePillory has the statewide measures (and, for North
 * Carolina, the appellate court races) but not every contest: the same section, in the same place and
 * style, as California's. Races are one row each with the candidates on one line; each measure folds
 * open to its facts.
 */
function statewideSection(st, election) {
  if (!election || election.election.state !== st || !measuresOnly(election)) return "";
  const id = election.election.id;
  const courts = judicialContests(election);
  const props = election.measures.filter((m) => m.scope === "statewide");
  const args = props.some((m) => (m.arguments || []).length || (m.argument_links || []).length);
  return `
<section class="stack-sm simple-keep" id="statewide" aria-labelledby="h-statewide">
  <h2 class="label" id="h-statewide">On every ${esc(STATE_NAME[st])} ballot · November 3, 2026</h2>
  ${courts.length ? `<div class="card">${courts.map((c) => judicialRow(id, c)).join("")}</div>` : ""}
  ${props.length ? `<div class="stack-sm">${props.map((m) => factsFold(election, m, { href: measureHref(id, m.id), ...measureHeading(m) })).join("")}</div>` : ""}
  <p class="hint">${courts.length ? "Court candidates in ballot order, from the State Board of Elections' Judicial Voter Guide. " : ""}Each measure opens to its facts, from the official sources; its page has the rest${args ? ", including each side's arguments" : ""}. ${esc(titleNote(props))}</p>
</section>`;
}

/** ThePillory's own pages for California's full ballot. */
function ownSection(st, election) {
  if (!election || election.election.state !== st || measuresOnly(election)) return "";
  const id = election.election.id;
  return `
<section class="stack-sm" aria-labelledby="h-own">
  <h2 class="label" id="h-own">On ThePillory</h2>
  <div class="card">${linkRow(ballotHref(id), "Your ballot on ThePillory", "Every contest for your districts, with candidate statements word for word")}${linkRow(electionHref(id), "Everything on the ballot", "Statewide offices, propositions with their facts, courts")}</div>
</section>`;
}

// ---------------------------------------------------------------------------
// /ballot/

function pickerPage() {
  const states = Object.entries(STATE_NAME).filter(([st]) => !["AS", "GU", "MP", "VI"].includes(st));
  const main = `
<header class="page-head stack-xs">
  <h1>Preview your state's ballot</h1>
  <p class="subtitle">Pick your state for its federal races and official voting links, then enter your address for your whole ballot.</p>
</header>
<ul class="card plain-list">${states.map(([st, name]) => `<li>${linkRow(ballotPath(st), name, "")}</li>`).join("")}</ul>
<p class="hint">${esc(CONFIRM)}</p>`;
  return page("Preview your state's ballot", main, { tab: "home", back: BACK });
}

// ---------------------------------------------------------------------------
// /ballot/<st>/ before an address

async function statePage(env, request, st, { message = "", entered = null } = {}) {
  // After a lookup (entered), the saved districts never stand in for what was entered.
  const saved = districtsFromCookie(request);
  const d = entered == null ? saved : null;
  const showing = entered != null
    ? await showingLine(env, request, entered)
    : saved && saved.st === st
    ? `<p class="small showing"><strong>Showing:</strong> ${esc(`your saved place (${await savedLabel(env, request, saved)})`)} · <a class="inline-link" href="#address">a different address or ZIP</a></p>`
    : "";
  const name = STATE_NAME[st];
  const [races, filed, office, election, dates, stateList] = await Promise.all([
    loadSection("ballot races", () => loadRaces(env, request, st), null),
    loadSection("ballot filed officials", () => filedOfficials(env.DB, st), {}),
    loadSection("ballot office", () => stateOffice(env, request, st), null),
    loadSection("ballot election", () => ownElection(env, request, st), null),
    loadSection("ballot dates", () => asset(env, request, "/data/elections/dates.json"), null),
    loadSection("ballot certified list", () => loadCertified(env, request, st), null),
  ]);
  // Quick mode: what's on it in a sentence, then the statewide list and the address card.
  const e = election === FAILED ? null : election;
  const certified = e && e.election.state === st && !measuresOnly(e);
  const offices = certified ? e.contests.filter((c) => c.scope === "statewide").length : 0;
  const props = e && e.election.state === st ? e.measures.filter((m) => m.scope === "statewide").length : 0;
  const courts = e && e.election.state === st ? judicialContests(e).length : 0;
  const onIt = certified
    ? `On every ${esc(name)} ballot: ${offices} statewide ${offices === 1 ? "office" : "offices"}${props ? ` and ${props} ${props === 1 ? "proposition" : "propositions"}` : ""}. Your races for Congress and the Legislature depend on where you live.`
    : NO_GENERAL.has(st) ? `${esc(name)} has no general election on November 3, 2026.`
    : courts || props
    ? `On every ${esc(name)} ballot: ${[courts ? `${courts} court ${courts === 1 ? "race" : "races"}` : "", props ? `${props} statewide ${props === 1 ? "measure" : "measures"}` : ""].filter(Boolean).join(" and ")}. Your race for the U.S. House depends on where you live.`
    : "Races for Congress. Your exact ballot depends on where you live.";
  const simple = simpleCard({
    lines: [
      ["What's on it", onIt],
      ["Your exact ballot", '<a class="inline-link" href="#address">Add your address below</a> to see every race for where you live, and where to vote.'],
    ],
    source: esc(CONFIRM),
    jump: e && e.election.state === st ? "statewide" : "federal",
  });
  const main = `<div class="simple-scope">
<header class="page-head stack-xs">
  <p class="label">${esc(name)}${NO_GENERAL.has(st) ? "" : " · Nov 3, 2026"}</p>
  <h1>${esc(statePossessive(st, name))} ballot</h1>
</header>
${showing}
${simple}
${message ? `<p class="banner banner--error" role="alert">${esc(message)}</p>` : ""}
<p class="small"><a class="inline-link jump-link" href="#address">Add your address for your exact ballot ↓</a></p>
${statewideSection(st, e)}
${federalSection(st, races, filed, d, election === FAILED ? null : election, { dates: dates === FAILED ? null : dates, office: office === FAILED ? null : office, certified: stateList === FAILED ? null : stateList })}
${entered == null ? ownSection(st, election === FAILED ? null : election) : ""}
${addressForm(st)}
<p class="small secondary">${esc(CONFIRM)}</p>
${officialLinks(st, office === FAILED ? null : office, election === FAILED ? null : election)}
<p class="small"><a class="inline-link" href="/ballot/?pick=1">A different state</a></p>
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>
</div>`;
  return privatePage(`${statePossessive(st, name)} ballot`, main, BACK);
}

// ---------------------------------------------------------------------------
// With an address

const NO_DATA = {
  "not-found": (x) => `There's no ballot information for ${x} yet. Election offices publish their ballot data in the weeks before an election, and not every county does.`,
  address: (x) => `${x} couldn't be read as an address. Check the street, city and state, and try again.`,
  unavailable: () => "The ballot lookup didn't answer just now. Try again in a minute.",
  "no-key": () => "The address lookup isn't switched on yet.",
};

/** What a failed lookup says, for what the visitor entered. Pure. */
export const noDataMessage = (kind, entered) => (NO_DATA[kind] || NO_DATA["not-found"])(entered ? `"${entered}"` : "this address");

async function noData(env, request, st, kind, ballot = null, entered = "") {
  const name = STATE_NAME[st];
  const [office, election] = await Promise.all([
    loadSection("ballot office", () => stateOffice(env, request, st), null),
    loadSection("ballot election", () => ownElection(env, request, st), null),
  ]);
  // ThePillory's "Your ballot" pages read the saved districts, so they aren't offered on a lookup's answer.
  const o = office === FAILED ? null : office;
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(name)}</p>
  <h1>${RESULT_HEADING}</h1>
</header>
${await showingLine(env, request, entered)}
<p class="banner">${esc(CONFIRM)}</p>
<section class="card stack-sm">
  <p>${esc(noDataMessage(kind, entered))}</p>
  <p class="small">Your sample ballot is on ${o ? `<a class="inline-link" href="${esc(o.url)}" target="_blank" rel="noopener">${esc(name)}'s election office website ↗</a>` : `<a class="inline-link" href="${USA_GOV}" target="_blank" rel="noopener">your state's election office ↗</a>`}, and your county election office mails it before Election Day.</p>
</section>
${ballot ? placesSections(ballot) : ""}
${addressForm(st, { heading: "Try another address" })}
${officialLinks(st, o, election === FAILED ? null : election)}
<p class="small"><a class="inline-link" href="${ballotPath(st)}">${esc(name)}'s federal races</a></p>`;
  return privatePage(RESULT_HEADING, main, [`${statePossessive(st, name)} ballot`, ballotPath(st)]);
}

// No link to an official's page: the Civic Information API gives a name only,
// and a name alone isn't enough to say it's the same person.
function civicCandidate(c) {
  return `
  <li class="ballot-cand stack-xs">
    <p class="list-title">${esc(c.name)}</p>
    ${candFacts([partyName(c.party) || "No party listed"])}
  </li>`;
}

function civicContest(c, { election }) {
  if (c.kind === "referendum") {
    const r = c.referendum;
    const ours = measureFor(r, election);
    return `
  <div class="card stack-xs">
    <p class="label">Measure</p>
    <h3>${esc(r.title || c.title)}</h3>
    ${r.subtitle ? `<p class="small">${esc(r.subtitle)}</p>` : ""}
    ${r.brief ? `<p class="small secondary">${esc(r.brief)}</p>` : ""}
    ${ours ? factsFold(election, ours, { href: measureHref(election.election.id, ours.id), name: `Just the facts: ${measureName(ours)}` }) : ""}
    ${r.url ? `<p class="small"><a class="inline-link" href="${esc(r.url)}" target="_blank" rel="noopener">Official text ↗</a></p>` : ""}
  </div>`;
  }
  const meta = [c.district, c.office && c.office !== c.title ? c.office : ""].filter(Boolean).join(" · ");
  return `
  <div class="card stack-xs">
    <h3>${esc(c.title)}</h3>
    ${meta ? `<p class="small secondary">${esc(meta)}</p>` : ""}
    ${c.candidates.length
      ? `<ul class="plain-list ballot-cands">${c.candidates.map((x) => civicCandidate(x)).join("")}</ul>`
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

/** True only when the address's ZIP (as Google read it) lies wholly in the saved place. */
async function addressIsSaved(env, request, b) {
  const saved = districtsFromCookie(request);
  if (!saved || !b.zip) return false;
  const file = await asset(env, request, `/data/zip/${b.zip.slice(0, 3)}.json`).catch(() => null);
  return zipIsSaved(file && file[b.zip], saved);
}

async function answerPage(env, request, st, b, entered) {
  if (!b.contests.length) return noData(env, request, st, "not-found", b, entered);
  const name = STATE_NAME[st];
  const [election, office] = await Promise.all([
    loadSection("ballot election", () => ownElection(env, request, st), null),
    loadSection("ballot office", () => stateOffice(env, request, st), null),
  ]);
  const ctx = { election: election === FAILED ? null : election };
  const sourceNames = [...new Set(b.contests.flatMap((c) => c.sources.map((s) => s.name)).filter(Boolean))];
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(b.election.name || "Your ballot")}${b.election.day ? ` · ${esc(fmtDate(b.election.day))}` : ""}</p>
  <h1>${RESULT_HEADING}</h1>
  <p class="subtitle">${esc(`Your ballot preview for ${entered}`)}</p>
</header>
${await showingLine(env, request, entered, { same: await addressIsSaved(env, request, b) })}
<p class="banner">${esc(CONFIRM)}</p>
<section class="stack-sm" id="contests" aria-labelledby="h-contests">
  <h2 class="label" id="h-contests">${b.contests.length} ${b.contests.length === 1 ? "contest" : "contests and measures"}</h2>
  ${b.contests.map((c) => civicContest(c, ctx)).join("")}
  <p class="hint">In the order the official data lists them, with each candidate's party as listed. Every candidate is shown the same way. From the Google Civic Information API${sourceNames.length ? `, which carries ${esc(sourceNames.join(", "))}` : ""}: what state and county election offices publish.</p>
</section>
${placesSections(b)}
${civicLinks(b)}
${b.otherElections.length ? `<p class="small secondary">Also for this address: ${esc(b.otherElections.map((e) => `${e.name}${e.day ? ` (${fmtDate(e.day)})` : ""}`).join("; "))}.</p>` : ""}
<section class="card stack-sm">${makeMyPlace(entered, st, "Saves this address's districts in your browser only, never the address. Until then, your saved place stays as it is.")}</section>
${addressForm(st, { heading: "Look up another address" })}
${officialLinks(st, office === FAILED ? null : office, ctx.election)}
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>`;
  return privatePage(RESULT_HEADING, main, [`${statePossessive(st, name)} ballot`, ballotPath(st)]);
}

// ---------------------------------------------------------------------------
// A ZIP code alone

/**
 * What a ZIP covers, from data/zip/ ([st, cd, su, sl, county, share] for each part): its state (the
 * largest part's), its counties and districts, largest first, and the House district only when the
 * whole ZIP is in one. Pure.
 */
export function zipCoverage(options) {
  if (!options || !options.length) return null;
  const order = [...options].sort((a, b) => (Number(b[5]) || 0) - (Number(a[5]) || 0));
  const st = order[0][0];
  const parts = order.filter((o) => o[0] === st);
  const uniq = (i) => [...new Set(parts.map((o) => o[i]).filter((v) => v != null && v !== ""))];
  const cds = uniq(1);
  return { st, states: [...new Set(order.map((o) => o[0]))], counties: uniq(4), cd: cds, su: uniq(2), sl: uniq(3), houseCd: cds.length === 1 ? cds[0] : null };
}

/** True only when every part of the ZIP is the saved place (the same state and districts, and county where one is saved). Pure. */
export function zipIsSaved(options, saved) {
  if (!saved || !options || !options.length) return false;
  return options.every(([st, cd, su, sl, co]) => st === saved.st && (!saved.cd || String(cd) === saved.cd) && (!saved.su || String(su) === saved.su) && (!saved.sl || String(sl) === saved.sl) && (!saved.co || co === saved.co));
}

const listWords = (xs) => (xs.length < 2 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

async function zipPage(env, request, st, zip) {
  const file = await asset(env, request, `/data/zip/${zip.slice(0, 3)}.json`).catch(() => null);
  const options = file && file[zip];
  const cov = zipCoverage(options);
  if (!cov || !STATE_NAME[cov.st]) return statePage(env, request, st, { message: `${zip} isn't one of the Census Bureau's ZIP code areas. Try your street address.`, entered: zip });
  const zst = cov.st;
  const name = STATE_NAME[zst];
  const saved = districtsFromCookie(request);
  const [races, filed, office, election, dates, stateList, place] = await Promise.all([
    loadSection("ballot races", () => loadRaces(env, request, zst), null),
    loadSection("ballot filed officials", () => filedOfficials(env.DB, zst), {}),
    loadSection("ballot office", () => stateOffice(env, request, zst), null),
    loadSection("ballot election", () => ownElection(env, request, zst), null),
    loadSection("ballot dates", () => asset(env, request, "/data/elections/dates.json"), null),
    loadSection("ballot certified list", () => loadCertified(env, request, zst), null),
    loadSection("ballot place", () => loadPlace(env, request, zst.toLowerCase()), null),
  ]);
  const p = place === FAILED ? null : place;
  const e = election === FAILED ? null : election;
  const countyOf = (fips) => p && (p.counties || []).find((c) => c.fips === fips);
  const counties = cov.counties.map((f) => {
    const c = countyOf(f);
    return c ? `<a class="inline-link" href="${placeHref(zst, c.slug)}">${esc(c.name)}</a>` : esc(`county ${f}`);
  });
  const whole = (xs) => xs.length === 1;
  // "State Senate", so it isn't read as the U.S. Senate beside the House districts.
  const seat = (type, id) => esc(String(seatLabel(zst, type, id) || id).replace(/^Senate\b/, "State Senate"));
  const lower = p && p.chambers && p.chambers.sldl;
  const rows = [
    cov.cd.length ? `<li>${cov.cd.map((id) => (p ? `<a class="inline-link" href="${districtHref("cd", id, p)}">${esc(id === "0" ? "U.S. House, at large" : `U.S. House District ${id}`)}</a>` : esc(`U.S. House District ${id}`))).join(" · ")}</li>` : "",
    cov.su.length ? `<li>${cov.su.map((id) => seat(lower ? "upper" : "legislature", id)).join(" · ")}</li>` : "",
    cov.sl.length && lower ? `<li>${cov.sl.map((id) => seat("lower", id)).join(" · ")}</li>` : "",
  ].filter(Boolean).join("");
  const split = !whole(cov.cd) || !whole(cov.su) || !whole(cov.sl) || cov.counties.length > 1 || cov.states.length > 1;
  const lead = `${esc(zip)} ${cov.counties.length > 1 ? `spans parts of ${listWords(counties)}` : `is in ${counties[0]}`}${cov.states.length > 1 ? ` (most of it in ${esc(name)})` : ""} and ${split ? "covers parts of these districts" : "is in these districts"}:`;
  const houseNote = cov.houseCd
    ? HOUSE_NOTE
    : `${esc(zip)} covers parts of ${esc(listWords(cov.cd.map((id) => `District ${id}`)))} of the U.S. House. <a class="inline-link" href="#address">Add your street address below</a> for yours.`;
  const d = cov.houseCd ? { st: zst, cd: String(Number(cov.houseCd)) } : null;
  const same = zipIsSaved(options, saved);
  const main = `<div class="simple-scope">
<header class="page-head stack-xs">
  <p class="label">${esc(name)}${NO_GENERAL.has(zst) ? "" : " · Nov 3, 2026"}</p>
  <h1>${esc(`What's on ballots in ${zip}`)}</h1>
</header>
${await showingLine(env, request, zip, { same })}
<section class="card stack-sm simple-keep" id="zip" aria-labelledby="h-zip">
  <h2 class="label" id="h-zip">${esc(`ZIP code ${zip}`)}</h2>
  <p>${lead}</p>
  <ul class="plain-list stack-xs small">${rows}</ul>
  <p class="banner">A ZIP can span several districts; add your street address for your exact ballot.</p>
  <p class="hint">This isn't your ballot: below are the races and measures on every ${esc(name)} ballot. From the Census Bureau's ZIP code areas and district maps.</p>
  ${same ? "" : makeMyPlace(zip, zst, split ? "Saves this ZIP's districts in your browser only; where it's split, you choose which. Until then, your saved place stays as it is." : "Saves this ZIP's districts in your browser only. Until then, your saved place stays as it is.")}
</section>
${addressForm(zst)}
${statewideSection(zst, e)}
${federalSection(zst, races, filed, d, e, { dates: dates === FAILED ? null : dates, office: office === FAILED ? null : office, certified: stateList === FAILED ? null : stateList, houseNote })}
<p class="small secondary">${esc(CONFIRM)}</p>
${officialLinks(zst, office === FAILED ? null : office, e)}
<p class="hint">${esc(NEUTRAL)} <a class="inline-link" href="/about/methodology/#elections">How ThePillory builds this</a></p>
</div>`;
  return privatePage(`What's on ballots in ${zip}`, main, [`${statePossessive(zst, name)} ballot`, ballotPath(zst)]);
}
