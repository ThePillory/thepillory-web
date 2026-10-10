// Candidates not yet in office, and the races they're in (docs/candidates.md).
//
//   /candidates/<FEC id>/                 a candidate for Congress, from FEC filings
//                                         (data/candidates/<year>/<st>.json, built by
//                                         tools/build_candidates.mjs)
//   /candidates/ca/<contest>/<name>/      a candidate on California's certified list
//                                         for a state office (Governor, Legislature, …)
//   /races/<year>/<st>/<race>/            every candidate in one race: "senate",
//                                         "house-<n>", or a certified contest's id
//
// One rule for everyone: every candidate the FEC lists as an active statutory
// candidate (or the state's certified list names) is included, nobody is picked
// by hand, and every candidate gets the same card and the same page. Ballot
// order where the state's certified list gives it, otherwise alphabetical. No
// polls, predictions, rankings or contact details; individual donors are never
// named. Party is plain text, as filed.
import { esc, safeUrl, kv, fmtDate, linkRow, sourceLink } from "./render.js";
import { asset } from "./geo.js";
import { STATE_NAME } from "./districts.js";
import { fold, outLink } from "./summary.js";
import { breakdownBar } from "./charts.js";
import { money, period } from "./funding.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";
import { officialFor } from "./civic.js";
import { loadElection, ballotOrder, contestHref, ELECTION_BY_STATE, measuresOnly } from "./elections.js";
import { statePath } from "./state-paths.js";

export const YEAR = 2026;
export const METHOD = "/about/methodology/#candidates";
export const INCLUDED =
  "Every candidate who has filed with the Federal Election Commission, passed its $5,000 threshold and is listed as active in the race, by one rule for everyone; nobody is added or left out by hand. Where a state's certified candidate list is loaded (California), the race shows that list, in ballot order.";
export const INCLUDED_CERTIFIED =
  "Every candidate on the Secretary of State's Certified List of Candidates for this office, in ballot order, by one rule for everyone; nobody is added or left out by hand.";
export const NEUTRAL = "Every candidate gets the same card and the same page. ThePillory doesn't endorse candidates, and doesn't publish polls, predictions or contact details.";

const industryName = (k) => INDUSTRIES[k] || INDUSTRIES.other;

// ---------------------------------------------------------------------------
// Names, races and links (pure)

const HONORIFICS = new Set(["MR", "MRS", "MS", "MISS", "DR", "SEN", "SENATOR", "REP", "HON", "PROF", "REV", "GEN", "COL", "MAJ", "CAPT", "LT", "SGT"]);
const SUFFIXES = { JR: "Jr.", SR: "Sr.", II: "II", III: "III", IV: "IV", V: "V" };

function capWord(w) {
  return w
    .toLowerCase()
    .replace(/(^|[-'’])([a-z])/g, (m, p, c) => p + c.toUpperCase())
    .replace(/^Mc([a-z])/, (m, c) => `Mc${c.toUpperCase()}`);
}

/** "ALLRED, COLIN Z MR" → "Colin Z Allred": the FEC's "LAST, FIRST" in reading order, without titles. Pure. */
export function fecDisplayName(raw) {
  const s = String(raw || "").trim();
  const [last, rest = ""] = s.split(/,(.*)/s).map((x) => x.trim());
  const words = rest.split(/\s+/).filter(Boolean).map((w) => w.replace(/\.$/, ""));
  const suffix = [];
  const first = [];
  for (const w of words) {
    const u = w.toUpperCase();
    if (HONORIFICS.has(u)) continue;
    if (SUFFIXES[u]) suffix.push(SUFFIXES[u]);
    else first.push(w.length === 1 ? `${w.toUpperCase()}.` : capWord(w));
  }
  const lastWords = last.split(/\s+/).filter(Boolean);
  const lastOut = lastWords.filter((w) => !SUFFIXES[w.toUpperCase().replace(/\.$/, "")]).map(capWord);
  for (const w of lastWords) if (SUFFIXES[w.toUpperCase().replace(/\.$/, "")]) suffix.push(SUFFIXES[w.toUpperCase().replace(/\.$/, "")]);
  return [...first, ...lastOut].join(" ") + (suffix.length ? `, ${suffix.join(" ")}` : "");
}

/** The state of an FEC House or Senate candidate ID ("S4TX00722" → "TX"). Pure. */
export function stateOfId(id) {
  const m = /^[HS]\d([A-Z]{2})\d{5}$/.exec(String(id || ""));
  return m ? m[1] : null;
}

export const candidateHref = (id) => `/candidates/${id}/`;
export const stateCandidateHref = (contestId, slug) => `/candidates/ca/${contestId}/${slug}/`;
export const raceHref = (year, st, key) => `/races/${year}/${String(st).toLowerCase()}/${key}/`;
export const nameSlug = (name) => String(name).toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** The race key for an FEC candidate: "senate" or "house-<n>". Pure. */
export const raceKey = (c) => (c.office === "S" ? "senate" : `house-${Number(c.district || 0)}`);

/** "U.S. Senate", "U.S. House, District 12", "U.S. House, at large", "Delegate to the U.S. House". Pure. */
export function officeName(st, key, data = null) {
  if (key === "senate") return "U.S. Senate";
  const m = /^house-(\d+)$/.exec(key);
  if (!m) return null;
  if (st === "DC") return "Delegate to the U.S. House";
  if (st === "PR") return "Resident Commissioner";
  const districts = data ? new Set(Object.values(data.candidates || {}).filter((c) => c.office === "H").map((c) => String(Number(c.district || 0)))) : null;
  const atLarge = m[1] === "0" || (districts && districts.size === 1 && districts.has("0"));
  return atLarge ? "U.S. House, at large" : `U.S. House, District ${m[1]}`;
}

export const loadCandidates = (env, request, st, year = YEAR) =>
  /^[A-Z]{2}$/.test(st) ? asset(env, request, `/data/candidates/${year}/${st.toLowerCase()}.json`) : null;

/** The state's certified-list election, when ThePillory has one with candidates (California). */
export async function certifiedElection(env, request, st) {
  if (!ELECTION_BY_STATE[st]) return null;
  const e = await loadElection(env, request, ELECTION_BY_STATE[st]);
  return e && e.election.state === st && !measuresOnly(e) ? e : null;
}

/** The certified contest for an FEC race key, in a certified-list election. Pure. */
export function certifiedContest(election, key) {
  if (!election) return null;
  if (key === "senate") return election.contests.find((c) => c.scope === "statewide" && /united states senator/i.test(c.office)) || null;
  const m = /^house-(\d+)$/.exec(key);
  if (m) return election.contests.find((c) => c.scope === "cd" && String(c.district) === m[1]) || null;
  return election.contests.find((c) => c.id === key && STATE_SCOPES.has(c.scope)) || null;
}
/** Certified contests that get candidate pages without an FEC filing (state offices). */
export const STATE_SCOPES = new Set(["statewide", "boe", "sldu", "sldl"]);

/** The general election date for a state's year (from data/elections/dates.json). Pure. */
export function generalDate(dates, st, year = YEAR) {
  const list = (dates && dates.states && dates.states[st]) || [];
  const g = list.find((e) => e.type === "G" && e.date.startsWith(String(year)) && !e.district);
  return g ? g.date : `${year}-11-03`;
}

/**
 * Where a candidate stands, in plain words. Pure.
 *   office, year:  "U.S. Senate", 2026
 *   certified:     the state's certified list is loaded; onBallot: they're on it
 *   after:         the general election has passed
 *   inOffice:      { slug, office } when they hold office now (from ThePillory's records)
 * Returns { label, line }: the label above the name, and the line under it.
 */
export function standing({ office, year, state, certified, onBallot, after, inOffice, listed = true, lastListed = null }) {
  const where = `${office}, ${year}${state ? ` · ${state}` : ""}`;
  if (inOffice) return { label: `In office · ${inOffice.office}`, line: `Candidate for ${where}` };
  if (after) {
    if (certified && onBallot) return { label: `Ran for ${office}, ${year}`, line: state || "" };
    return { label: `Filed for ${office}, ${year}`, line: state || "" };
  }
  if (certified && !onBallot) return { label: `Filed for ${office}, ${year}`, line: `Not on the November ballot (Secretary of State's certified list)${state ? ` · ${state}` : ""}` };
  if (!listed) return { label: `Filed for ${office}, ${year}`, line: `No longer on the FEC's list of active candidates${lastListed ? ` (last listed ${fmtDate(lastListed)})` : ""}` };
  return { label: "Candidate · Not yet in office", line: `${certified ? "Running for" : "Filed for"} ${where}` };
}

/** Candidates in a race, in order: the certified list's ballot order where loaded, else alphabetical by last name. Pure. */
export function inOrder(list) {
  return [...list].sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

// ---------------------------------------------------------------------------
// Records in ThePillory's data

/**
 * Officials in this state (current and former) and the FEC IDs ThePillory has
 * linked to officials, to link a candidate to an office they hold or held.
 */
export async function recordsFor(db, st) {
  if (!db) return { officials: [], byFec: {} };
  const [o, f] = await Promise.all([
    db.prepare("SELECT slug, name, last_name, office, district, level, chamber, active, state FROM officials WHERE state = ?").bind(st).all(),
    db
      .prepare("SELECT f.candidate_id, o.slug, o.name, o.office, o.district, o.active, o.level FROM fec_candidates f JOIN officials o ON o.id = f.official_id WHERE f.candidate_id IS NOT NULL AND o.state = ?")
      .bind(st)
      .all(),
  ]);
  return { officials: o.results || [], byFec: Object.fromEntries((f.results || []).map((r) => [r.candidate_id, r])) };
}

/**
 * The offices a candidate holds or held in ThePillory's records: by their FEC ID
 * (members of Congress) and by name among the state's officials, only when
 * exactly one official in the state has that first and last name. Pure.
 */
export function officesHeld(c, records, displayName) {
  const out = [];
  const byId = c.id && records.byFec[c.id];
  if (byId) out.push({ ...byId, how: "fec" });
  const others = records.officials.filter((o) => !byId || o.slug !== byId.slug);
  const hit = officialFor(displayName, others);
  if (hit && !out.some((x) => x.slug === hit.slug)) out.push({ ...hit, how: "name" });
  return out;
}

// ---------------------------------------------------------------------------
// Pieces

/** The same card for every candidate in a race. */
export function candidateCard({ href, name, meta, held }) {
  return `
  <li class="ballot-cand">
    <a class="list-row link-row" href="${esc(href)}">
      <div><div class="list-title">${esc(name)}</div><div class="list-meta">${esc(meta)}</div>${held ? `<div class="list-meta">${esc(held)}</div>` : ""}</div>
      <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
    </a>
  </li>`;
}

const heldLine = (h) => `${h.active ? "Holds" : "Held"}: ${h.office}${h.district ? `, ${h.district}` : ""}`;

function moneyRow(left, right, meta = "") {
  return `<li class="money-row"><div class="money-name">${left}${meta ? `<div class="list-meta">${meta}</div>` : ""}</div><div class="money-amt">${right}</div></li>`;
}

/** The Funding tab for an FEC candidate: totals and organizations by name. Never individual donors. */
export function candidateFunding(c, name) {
  const cycle = c.cycle || YEAR;
  const span = period(cycle);
  const t = c.totals;
  if (!c.funding_checked) {
    return `<div class="card empty-state stack-sm"><p>Funding data is loading.</p><p class="small secondary">FEC reports are read for a few hundred candidates a day, oldest first, so every candidate is refreshed in turn. This candidate's appear here once they're read.</p>${sourceLink(c.fec_url, "This candidate at the FEC")}</div>`;
  }
  if (!t) return `<p class="secondary small">No FEC financial reports for ${span} yet.</p>${sourceLink(c.fec_url, "This candidate at the FEC")}`;
  const parts = [
    ["Small individual donors ($200 or less)", t.individual_unitemized],
    ["Larger individual donors (more than $200)", t.individual_itemized],
    ["PACs and other political committees", t.pac],
    ["Political party committees", t.party],
    ["The candidate (own money and loans)", t.self_funding],
    ["Other (transfers, refunds, interest)", t.other],
  ];
  const o = c.organizations;
  const orgs = !o
    ? '<p class="secondary small">No principal campaign committee is listed in the FEC filing, so contributions from committees can\'t be read.</p>'
    : o.items.length
      ? `<ul class="plain-list money-list">${o.items.map((p) => moneyRow(esc(p.name), money(p.total), `${p.count} contribution${p.count === 1 ? "" : "s"} · ${esc(industryName(p.industry))}`)).join("")}</ul>
       <p class="hint">${o.items.length < o.count ? `The ${o.items.length} largest of ${o.count} committees` : `${o.count} ${o.count === 1 ? "committee" : "committees"}`}, ${money(o.total)} in all${o.complete ? "" : " (from the largest contributions only)"}. Industries are approximate, by keywords in each committee's name. <a class="tap" href="${esc(o.source_url)}" target="_blank" rel="noopener">Every committee contribution at the FEC ↗</a></p>`
      : `<p class="secondary small">No contributions from PACs or other committees reported in ${span}.</p>`;
  return `
<section class="card hero-stat">
  <p class="label">Raised · ${span}</p>
  <p class="hero-num">${money(t.receipts)}</p>
  <p class="small secondary">Spent ${money(t.disbursements)} · Cash on hand ${money(t.cash_on_hand)}${t.coverage_end ? ` as of ${fmtDate(t.coverage_end)}` : ""}</p>
</section>
<p class="small">Money raised by ${esc(name)}'s campaign committees in ${span}${t.coverage_end ? `, through ${fmtDate(t.coverage_end)}` : ""}, as reported to the Federal Election Commission. These are facts about money; they don't predict the race.</p>
<section class="card stack">
  <h3>Where it came from</h3>
  ${breakdownBar(parts.map(([label, value]) => ({ label, value })), { total: t.receipts, format: money, label: "Where the money came from" })}
</section>
<section class="card stack-sm">
  <h3>From PACs and other committees</h3>
  ${orgs}
</section>
<p class="hint">Source: Federal Election Commission (${sourceLink(t.source_url, `${name} at the FEC`)}), ${span}. Read ${fmtDate(c.funding_checked)}. Individual donors are never named; federal law bars using contributor information from FEC reports to ask for contributions or for commercial purposes. <a class="tap" href="/about/methodology/#funding">How funding is shown</a></p>`;
}

/** The candidate's row in candidate_platforms (null before migration 0022 or before the first search). */
export async function platformFor(db, candidateId) {
  if (!db) return null;
  try {
    return await db
      .prepare("SELECT site_url, result, page_url, title, excerpt, excerpt_at, excerpt_by, checked_at FROM candidate_platforms WHERE candidate_id = ?")
      .bind(candidateId)
      .first();
  } catch (err) {
    if (/no such (table|column)/i.test(String(err && err.message))) return null;
    throw err;
  }
}

const HOW_PLATFORM = '<a class="inline-link" href="/about/methodology/#candidates">How the platform is recorded</a>';

/**
 * The Platform tab: "In their own words", a short excerpt, word for word, from
 * the issues page on the campaign website in the candidate's FEC filing, found
 * and checked by the same rules as officials'. Otherwise, what the search found.
 */
export function candidatePlatform(name, website, row, { state = false } = {}) {
  const site = website ? `<p class="small">${outLink(website, "Campaign website")}</p>` : "";
  let body;
  if (row && row.excerpt && row.excerpt_by !== "hidden" && safeUrl(row.page_url)) {
    const by = String(row.excerpt_by || "");
    body = `<article class="card stack-sm own-words">
  <p class="label">Campaign website · as of ${fmtDate(String(row.excerpt_at || "").slice(0, 10))}</p>
  <blockquote class="promise-quote">“${esc(row.excerpt)}”</blockquote>
  <p class="hint">${outLink(row.page_url, row.title || "Issues page")}</p>
  <p class="hint">${by.startsWith("person:") ? `Excerpt chosen by ${esc(by.slice(7))}` : "Excerpt picked automatically and checked word for word against the page"}; refreshed monthly. The whole page is at the link.</p>
</article>`;
  } else if (row && row.result === "found" && safeUrl(row.page_url)) {
    body = `<div class="card stack-sm"><p class="small">An issues page was found on ${esc(name)}'s campaign website. No excerpt from it is shown yet.</p><p class="small">${outLink(row.page_url, row.title || "Issues page")}</p></div>`;
  } else if (row && row.checked_at && row.result !== "error") {
    body = `<div class="card stack-sm"><p class="small"><strong>No issues page found</strong> on ${esc(name)}'s campaign website (searched ${fmtDate(String(row.checked_at).slice(0, 10))}).</p>${site}</div>`;
  } else if (website) {
    body = `<div class="card stack-sm"><p class="small">${esc(name)}'s campaign website hasn't been searched for an issues page yet. Sites are searched a few dozen a day, in turn.</p>${site}</div>`;
  } else {
    body = `<div class="card stack-sm"><p class="small">${state ? "The certified candidate list doesn't include campaign websites, so there's no issues page to excerpt." : "No campaign website is listed in the campaign's FEC filing, so there's no issues page to excerpt."}</p></div>`;
  }
  return `<section class="stack-sm">
  <h2 class="label">In their own words</h2>
  ${body}
</section>
<p class="hint">A short excerpt, word for word, from the issues page on the campaign website listed in the candidate's filing, picked by the same rules for every candidate and official and checked word for word in code. ${HOW_PLATFORM}</p>`;
}

const included = (text = INCLUDED) => `<p class="hint">${esc(text)} <a class="inline-link" href="${METHOD}">How candidates are included</a></p>`;

function tabs(about, platform, record, funding, more) {
  const tab = (k, label) => `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}</a>`;
  return `
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs tabs--five" role="tablist" aria-label="Sections">
    ${tab("about", "About")}${tab("platform", "Platform")}${tab("votes", "Votes")}${tab("funding", "Funding")}${tab("more", "More")}
  </nav>
  <div class="stack" role="tabpanel" id="about" aria-labelledby="tab-about">${about}</div>
  <div class="stack" role="tabpanel" id="platform" aria-labelledby="tab-platform">${platform}</div>
  <div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">${record}</div>
  <div class="stack" role="tabpanel" id="funding" aria-labelledby="tab-funding">${funding}</div>
  <div class="stack" role="tabpanel" id="more" aria-labelledby="tab-more">${more}</div>
</div>`;
}

function recordTab(name, held) {
  if (!held.length) {
    return `<p class="secondary small">${esc(name)} doesn't hold, and hasn't held, an office in ThePillory's records, so there are no votes to show. ThePillory records votes in Congress and state legislatures, and the actions of executive offices.</p>`;
  }
  return `
<div class="card">${held.map((h) => linkRow(`/reps/${h.slug}/#votes`, `${h.active ? "" : "Former "}${h.office}${h.district ? `, ${h.district}` : ""}`, `${h.name}: record and votes on ThePillory`)).join("")}</div>
${held.some((h) => h.how === "name") ? `<p class="hint">Matched by name: the only official in ThePillory's records for this state with this first and last name.</p>` : ""}`;
}

function initialsOf(name) {
  return String(name).split(/\s+/).filter((w) => /^[A-Za-z]/.test(w)).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
}

function head({ label, name, line, chips = "" }) {
  return `
<header class="page-head rep-head">
  <span class="rep-initials" aria-hidden="true">${esc(initialsOf(name))}</span>
  <div class="stack-sm">
    <p class="label">${esc(label)}</p>
    <h1>${esc(name)}</h1>
    ${line ? `<p class="secondary">${esc(line)}</p>` : ""}
    ${chips ? `<div class="chips">${chips}</div>` : ""}
  </div>
</header>`;
}

// ---------------------------------------------------------------------------
// Pages

/** An FEC candidate's page, or null when the ID isn't in the data. */
export function fecCandidatePage({ c, st, data, election, records, dates, today, platform = null }) {
  const stateName = STATE_NAME[st] || st;
  const key = raceKey(c);
  const office = officeName(st, key, data);
  const contest = certifiedContest(election, key);
  const onCert = contest ? contest.candidates.find((x) => x.fec && x.fec.id === c.id) : null;
  const display = onCert ? onCert.name : fecDisplayName(c.name);
  const held = officesHeld(c, records, display);
  const now = held.find((h) => h.active && h.how === "fec");
  const after = today > generalDate(dates, st);
  const s = standing({ office, year: data.year, state: stateName, certified: !!contest, onBallot: !!onCert, after, inOffice: now, listed: c.listed, lastListed: c.last_listed });
  const website = c.website && safeUrl(c.website.url);
  const race = raceHref(data.year, st, key);
  const chips = [
    `<a class="chip chip--tap" href="${race}">The race: ${esc(office)}</a>`,
    now ? `<a class="chip chip--tap" href="/reps/${esc(now.slug)}/">Official page</a>` : "",
    website ? `<a class="chip chip--tap" href="${esc(website)}" target="_blank" rel="noopener">Campaign website ↗</a>` : "",
  ].join("");

  const about = `
${fold("race", "The race", kv([
    ["Office", esc(office)],
    ["State", `<a class="inline-link" href="${statePath(st)}">${esc(stateName)}</a>`],
    ["Election", `General election, ${esc(fmtDate(generalDate(dates, st)))}`],
    ["Everyone in it", `<a class="inline-link" href="${race}">${esc(office)} candidates</a>`],
  ]), { open: true })}
${fold("filing", "As filed", kv([
    ["Name as filed", esc(c.name)],
    ["Party", c.party ? esc(c.party) : "None listed"],
    ["Incumbent", c.incumbent ? "Yes" : "No"],
    onCert ? ["On the ballot as", esc([onCert.party ? `Party preference: ${onCert.party}` : "", onCert.designation].filter(Boolean).join(" · ") || onCert.name)] : null,
    ["Campaign website", website ? `${outLink(website, website.replace(/^https?:\/\//, "").replace(/\/$/, ""))} <span class="secondary small">(as listed in the campaign's FEC filing)</span>` : c.website ? "None listed in the FEC filing" : null],
    ["First listed", c.first_listed ? esc(fmtDate(c.first_listed)) : null],
  ].filter(Boolean)), { meta: c.party || "" })}
${fold("source", "Sources", `<p class="small">${sourceLink(c.fec_url, "FEC candidate record")}${c.website && c.website.source_url ? ` · ${sourceLink(c.website.source_url, "Campaign committee at the FEC")}` : ""}${contest ? ` · ${sourceLink(contest.source_url, "Certified List of Candidates")}` : ""}</p>
  <p class="hint">FEC list read ${fmtDate(data.list_built_on || data.built_on)}.</p>`)}
${included()}`;

  const more = `
${onCert ? fold("statement", "Candidate statement", `<p class="small"><a class="inline-link" href="${contestHref(election.election.id, contest.id)}">Statements in the official voter guide, word for word</a></p>`) : ""}
${fold("how", "How candidates are included", `<p class="small">${esc(INCLUDED)}</p><p class="small">${esc(NEUTRAL)}</p><a class="inline-link" href="${METHOD}">Methodology</a>`)}`;

  const main = `${head({ label: s.label, name: display, line: s.line, chips })}
${tabs(about, candidatePlatform(display, website, platform), recordTab(display, held), candidateFunding(c, display), more)}`;
  return { title: display, main };
}

/** A certified-list candidate for a state office (no FEC filing). */
export function stateCandidatePage({ cand, contest, election, records, today }) {
  const st = election.election.state;
  const stateName = STATE_NAME[st];
  const held = officesHeld({}, records, cand.name);
  const now = held.find((h) => h.active);
  const after = today > election.election.date;
  const office = contest.office;
  const s = standing({ office, year: Number(election.election.date.slice(0, 4)), state: stateName, certified: true, onBallot: true, after, inOffice: null });
  const race = raceHref(Number(election.election.date.slice(0, 4)), st, contest.id);
  const label = now && !after ? `${s.label} · Holds another office` : s.label;
  const chips = `<a class="chip chip--tap" href="${race}">The race: ${esc(office)}</a>${now ? `<a class="chip chip--tap" href="/reps/${esc(now.slug)}/">Current office: record</a>` : ""}`;
  const about = `
${fold("race", "The race", kv([
    ["Office", esc(office)],
    ["Election", esc(election.election.name)],
    ["Everyone in it", `<a class="inline-link" href="${race}">${esc(office)} candidates</a>`],
  ]), { open: true })}
${fold("filing", "As certified", kv([
    ["Name", esc(cand.name)],
    ["Party preference", cand.party ? esc(cand.party) : "None listed"],
    ["Ballot designation", cand.designation ? esc(cand.designation) : null],
    ["Incumbent", cand.incumbent ? "Yes" : "No"],
  ]), { meta: cand.party || "" })}
${fold("source", "Sources", `<p class="small">${sourceLink(contest.source_url, "Certified List of Candidates")}</p>`)}
${included(INCLUDED_CERTIFIED)}`;
  const funding = `<section class="card stack-sm"><p class="small">Campaign money for candidates for ${esc(stateName)}'s state offices is reported to the Secretary of State (Cal-Access). ThePillory shows it for current officials and doesn't load it for other candidates yet.</p>${now ? `<p class="small"><a class="inline-link" href="/reps/${esc(now.slug)}/#funding">Funding for ${esc(now.office)}</a></p>` : ""}${outLink("https://cal-access.sos.ca.gov/Campaign/Candidates/", "Cal-Access candidate search")}</section>`;
  const more = `
${fold("statement", "Candidate statement", `<p class="small"><a class="inline-link" href="${contestHref(election.election.id, contest.id)}">Statements in the official voter guide, word for word</a></p>`)}
${fold("how", "How candidates are included", `<p class="small">Every candidate on the Secretary of State's Certified List of Candidates, in ballot order. ${esc(NEUTRAL)}</p><a class="inline-link" href="${METHOD}">Methodology</a>`)}`;
  const main = `${head({ label, name: cand.name, line: s.line, chips })}
${tabs(about, candidatePlatform(cand.name, null, null, { state: true }), recordTab(cand.name, held), funding, more)}`;
  return { title: cand.name, main };
}

/** A race page: every candidate, the same card each, in ballot order or alphabetically. */
export function racePage({ st, key, data, election, records, dates, today }) {
  const stateName = STATE_NAME[st] || st;
  const year = data ? data.year : YEAR;
  const contest = certifiedContest(election, key);
  const fecOffice = officeName(st, key, data);
  const office = fecOffice || (contest && contest.office);
  if (!office) return null;
  const date = contest ? election.election.date : generalDate(dates, st, year);
  const after = today > date;
  const fecList = data ? Object.values(data.candidates).filter((c) => raceKey(c) === key) : [];
  const byFec = Object.fromEntries(fecList.map((c) => [c.id, c]));
  if (!contest && !fecList.length) return null;

  const fecCard = (c) => {
    const name = fecDisplayName(c.name);
    const held = officesHeld(c, records, name);
    const now = held.find((h) => h.active && h.how === "fec");
    return candidateCard({
      href: candidateHref(c.id),
      name,
      meta: [c.party || "No party listed", c.incumbent ? "Incumbent" : ""].filter(Boolean).join(" · "),
      held: now ? heldLine(now) : held[0] ? heldLine(held[0]) : "",
    });
  };
  let ballot = "";
  let rest = fecList;
  if (contest) {
    const { candidates, note } = ballotOrder(contest, election);
    const cards = candidates.map((x) => {
      const f = x.fec && byFec[x.fec.id];
      const held = officesHeld(f || {}, records, x.name);
      return candidateCard({
        href: f ? candidateHref(f.id) : stateCandidateHref(contest.id, nameSlug(x.name)),
        name: x.name,
        meta: [x.party ? `Party preference: ${x.party}` : "No party preference listed", x.designation].filter(Boolean).join(" · "),
        held: held[0] ? heldLine(held[0]) : "",
      });
    });
    ballot = `
<section class="stack-sm" aria-labelledby="h-ballot">
  <h2 class="label" id="h-ballot">On the ballot · ${esc(fmtDate(date))}</h2>
  <ul class="card plain-list ballot-cands">${cards.join("")}</ul>
  <p class="hint">${esc(note)} From the Secretary of State's ${sourceLink(contest.source_url, "Certified List of Candidates")}.</p>
</section>`;
    const onList = new Set(contest.candidates.map((x) => x.fec && x.fec.id).filter(Boolean));
    rest = fecList.filter((c) => !onList.has(c.id));
  }
  const listed = inOrder(rest.filter((c) => c.listed));
  const gone = inOrder(rest.filter((c) => !c.listed));
  const fecSection = listed.length || gone.length
    ? `
<section class="stack-sm" aria-labelledby="h-fec">
  <h2 class="label" id="h-fec">${contest ? "Also filed with the FEC (not on the November ballot)" : `Filed with the FEC · ${esc(stateName)}`}</h2>
  ${listed.length ? `<ul class="card plain-list ballot-cands">${listed.map(fecCard).join("")}</ul>` : ""}
  ${gone.length ? fold("gone", "No longer listed as active by the FEC", `<ul class="card plain-list ballot-cands">${gone.map(fecCard).join("")}</ul>`, { meta: String(gone.length) }) : ""}
  <p class="hint">Alphabetical by last name, names as filed. ${contest ? "" : "Not everyone listed will be on the November ballot (some lose a primary or withdraw); your sample ballot is final. "}${data ? `${sourceLink(data.source_url, "FEC list")} · read ${esc(fmtDate(data.list_built_on || data.built_on))}.` : ""}</p>
</section>`
    : "";
  const main = `
<header class="page-head stack-xs">
  <p class="label">${after ? "Race (held)" : "Race"} · ${esc(stateName)}</p>
  <h1>${esc(office)}</h1>
  <p class="subtitle">General election, ${esc(fmtDate(date))}${after ? " (held)" : ""}.</p>
</header>
${ballot}
${fecSection}
<section class="card stack-sm" aria-labelledby="h-included">
  <h2 class="label" id="h-included">How candidates are included</h2>
  <p class="small">${esc(fecOffice ? INCLUDED : INCLUDED_CERTIFIED)}</p>
  <p class="small">${esc(NEUTRAL)}</p>
  <a class="inline-link" href="${METHOD}">Methodology</a>
</section>
<div class="card">${linkRow(`/ballot/${st.toLowerCase()}/`, "Open your ballot", `Your races in ${stateName}, and where to vote`)}${linkRow(racesHref(year, st), `Every ${year} race in ${stateName}`, "")}</div>`;
  return { title: `${office}, ${stateName}`, main };
}

export const racesHref = (year, st) => `/races/${year}/${String(st).toLowerCase()}/`;

/** Every race in a state: U.S. Senate, each U.S. House district, and certified state contests. Pure. */
export function raceList(st, data, election) {
  const keys = new Map();
  for (const c of Object.values((data && data.candidates) || {})) {
    const k = raceKey(c);
    keys.set(k, (keys.get(k) || 0) + (c.listed ? 1 : 0));
  }
  const fed = [...keys.entries()].sort(([a], [b]) => (a === "senate" ? -1 : b === "senate" ? 1 : Number(a.split("-")[1]) - Number(b.split("-")[1])));
  const state = election ? election.contests.filter((c) => STATE_SCOPES.has(c.scope)) : [];
  return { federal: fed.map(([key, n]) => ({ key, title: officeName(st, key, data), n })), state: state.map((c) => ({ key: c.id, title: c.office, n: c.candidates.length })) };
}

/** /races/<year>/<st>/: every race in the state. */
export function racesIndexPage({ st, data, election }) {
  const stateName = STATE_NAME[st] || st;
  const year = data ? data.year : YEAR;
  const { federal, state } = raceList(st, data, election);
  const row = (r) => linkRow(raceHref(year, st, r.key), r.title, `${r.n} ${r.n === 1 ? "candidate" : "candidates"}`);
  const main = `
<header class="page-head stack-xs">
  <p class="label">${year} races · ${esc(stateName)}</p>
  <h1>Candidates in ${esc(stateName)}</h1>
  <p class="subtitle">Every candidate gets the same page: the race, their filings, money raised and the record of any office they hold.</p>
</header>
${federal.length ? `<section class="stack-sm"><h2 class="label">Congress</h2><div class="card">${federal.map(row).join("")}</div></section>` : `<div class="card"><p class="small secondary">${esc(stateName)}'s federal candidate list appears after the daily election data refresh.</p></div>`}
${state.length ? `<section class="stack-sm"><h2 class="label">State offices</h2><div class="card">${state.map(row).join("")}</div><p class="hint">From the Secretary of State's Certified List of Candidates.</p></section>` : ""}
${included()}`;
  return { title: `${year} races, ${stateName}`, main };
}
