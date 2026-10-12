// /reps/            find your reps (address or ZIP), your reps once known, the
//                   governing bodies, and members of Congress by state (?state=CA)
// /reps/<slug>/     one official, five tabs for everyone: About · Promises ·
//                   Votes · Funding · More. The President and Governor: Votes is
//                   bills signed and vetoed; More holds executive orders (and the
//                   President's nominations) and disclosures. The Cabinet: Votes
//                   and Funding say they don't apply, linking to Disclosures in
//                   More. Everyone else: More holds committees and Issues.
// POST /reps/<slug>/promises/<id>/flag   "Something wrong?" on a published promise
import { simpleCard, jobSentence, voteLinePlain, moneyLinePlain, sourceNote, SIMPLE_METHOD } from "../_lib/simple.js";
import { BODIES, LEVEL_NAME, EMPTY_REPORTS } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, kv, card, section, linkRow, sourceLink, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { officialBySlug, officialsWhere, withVoteCounts, voteCounts, votesFor, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe, STATE_NAME } from "../_lib/districts.js";
import { lookupForm } from "../_lib/hub.js";
import { BROWSE, PER_PAGE, chamberPage, personRow, yourRow, yourList, statewideList, repsHref, stateChambers, statePicker, sortSwitch, pagedList } from "../_lib/reps-index.js";
import { searchPeople } from "../_lib/people-search.js";
import { tradeSummary, memberTrades, memberReports, memberCommittees, executivePost, tradesSection, quickTradesLine, tradeRow, committeesList, TRADES_PER_PAGE, TRADES_METHOD } from "../_lib/trades.js";
import { loadJustices } from "../_lib/scotus.js";
import { chamberIds } from "../../workers/sync/src/states.js";
import { visitorState } from "../_lib/visitor-state.js";
import { voteRow, voteFilter } from "../_lib/votes.js";
import { fundingFor, fundingTab } from "../_lib/funding.js";
import { executiveMoney, executiveFundingParts, stateOfficialMoney, stateForm700, form700For } from "../_lib/exec-funding.js";
import { caLobbyingForOfficial, caLegislatorLobbying } from "../_lib/ca-lobbying.js";
import { memberGovMoney, earmarksSection, travelSection, faraSection } from "../_lib/gov-money.js";
import { stateFundingTab } from "../_lib/state-funding.js";
import { promisesFor, ownWordsFor, platformTab, FLAG_REASONS } from "../_lib/promises.js";
import { turnstileReady, verifyTurnstile, visitorHash, actionsToday, recordAction } from "../_lib/turnstile.js";
import { fold } from "../_lib/summary.js";
import { pickYear, yearBar, thisYear, FIRST_YEAR } from "../_lib/history.js";
import { officialPastYear } from "../_lib/history-pages.js";
import { currentCycle } from "../../workers/sync/src/funding/fec.js";
import {
  isExecutive, isPresident, isGovernor, executiveOfficials, ordersFor, billsActedOn, nominationsFor,
  ordersTab, billsTab, nominationsTab, executiveRows,
} from "../_lib/executive.js";
import { statePath } from "../_lib/state-paths.js";

const BODY = Object.fromEntries(BODIES.map((b) => [b.slug, b]));

/** "Test Representative Gamma" -> "TG": the first and last name's initials. */
function initials(name) {
  const parts = String(name || "").replace(/,?\s+(Jr|Sr|II|III|IV)\.?$/, "").split(/\s+/).filter((w) => /^[A-Za-z]/.test(w));
  return parts.length ? (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() : "";
}

function who(o) {
  // Party is plain text, identical styling for every party.
  return [o.office, o.district, o.party ? `Party: ${o.party}` : null].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// The Reps tab (functions/_lib/reps-index.js): Your representatives, Search,
// then Browse (Federal / State / Courts). The same layout for every state.

const SEARCH_GROUPS = [["officials", "Officials"], ["justices", "Supreme Court"], ["candidates", "Candidates"]];

function searchResults(found) {
  if (!found) return "";
  const groups = SEARCH_GROUPS.filter(([k]) => found[k].length);
  if (!groups.length) return `<p class="small secondary">No one named “${esc(found.query)}” found.</p>`;
  return groups
    .map(([k, label]) => `<p class="label">${esc(label)}</p><div class="card">${found[k].map((r) => linkRow(r.href, r.name, r.sub)).join("")}</div>`)
    .join("");
}

function searchSection(q, found) {
  return `
<section class="stack-sm simple-keep" id="search" aria-labelledby="h-search">
  <form class="card stack-sm lookup-form" method="get" action="/reps/" role="search" data-rollcall="people-results">
    <h2 class="label" id="h-search">Search</h2>
    <label class="visually-hidden" for="people-q">Name of an official, justice or candidate</label>
    <div class="lookup-row">
      <input class="input" id="people-q" name="q" type="search" value="${esc(q || "")}" placeholder="Name of an official, justice or candidate" autocomplete="off" />
      <button class="btn btn--primary" type="submit">Search</button>
    </div>
  </form>
  <div class="stack-sm" id="people-results" aria-live="polite">${searchResults(found)}</div>
</section>`;
}

function yoursSection({ d, vs, people = [], failed = false }) {
  const rows = failed ? sectionError("") : people.length ? `<div class="card">${people.map(yourRow).join("")}</div>` : '<p class="secondary small">Not loaded yet.</p>';
  if (d) {
    return `
<section class="stack-sm simple-keep" id="yours" aria-labelledby="h-yours">
  <h2 class="label" id="h-yours">Your representatives</h2>
  ${rows}
  ${lookupForm(d, { heading: "Change your location", next: "/reps/" })}
</section>`;
  }
  if (vs) {
    return `
<section class="stack-sm simple-keep" id="yours" aria-labelledby="h-yours">
  <h2 class="label" id="h-yours">Your representatives</h2>
  <p class="list-title">${esc(vs.name)}</p>
  ${rows}
  <p class="small">Add your ZIP or address to see your House member and state legislators.</p>
  ${lookupForm(null, { next: "/reps/" })}
</section>`;
  }
  return `<div class="simple-keep">${lookupForm(null, { next: "/reps/" })}</div>`;
}

const BROWSE_EMPTY = "None loaded yet.";

/** Senators and House members show their state when the list covers every state. */
const congressRow = (o) => personRow({ ...o, district: o.district || STATE_NAME[o.state] || null });

async function browseSection(db, env, request, { browse, st, sort, federalExec }) {
  const nav = `<nav class="segmented browse-switch" aria-label="Browse">${Object.entries(BROWSE)
    .map(([k, label]) => `<a class="toggle" href="${esc(repsHref({ browse: k, state: k === "courts" ? null : st }))}#browse"${k === browse ? ' aria-current="true"' : ""}>${label}</a>`)
    .join("")}</nav>`;
  const list = async (name, chamber, href, row, extra = "") => {
    const pg = await loadSection(`reps ${chamber}`, () => chamberPage(db, { chamber, state: browse === "federal" ? st : null, sort }));
    if (pg === FAILED) return sectionError(name);
    return `<h3 class="label">${esc(name)}</h3>${extra}${pagedList({ id: `list-${chamber}`, page: pg, href: repsHref({ ...href, chamber, offset: PER_PAGE }), empty: BROWSE_EMPTY, row })}`;
  };
  let body = "";
  if (browse === "federal") {
    const base = { browse, state: st, sort, anchor: "browse" };
    const [senate, house] = await Promise.all([
      list("U.S. Senate", "us-senate", base, congressRow),
      list("U.S. House", "us-house", base, congressRow, sortSwitch(base, sort)),
    ]);
    body = `
  ${statePicker({ browse, state: st, all: true, label: "Filter by state" })}
  <div class="card">${linkRow("/trades/", "Stock trades", "Trades members of Congress report under the STOCK Act, newest first")}</div>
  <h3 class="label">The President and Cabinet</h3>
  <div class="card">${federalExec === FAILED ? sectionError("") : federalExec.map((o) => personRow(o, { office: true })).join("") || `<p class="secondary small">${BROWSE_EMPTY}</p>`}</div>
  ${senate}
  ${house}`;
  } else if (browse === "state") {
    if (!st) {
      body = statePicker({ browse, state: null, label: "Choose a state" });
    } else {
      const base = { browse, state: st, sort, anchor: "browse" };
      const exec = await loadSection("reps state executive", () => executiveOfficials(db, chamberIds(st).executive), []);
      const chambers = stateChambers(st);
      const lists = await Promise.all(chambers.map((c) => list(c.name, c.id, base, personRow)));
      body = `
  ${statePicker({ browse, state: st })}
  <h3 class="label">Statewide offices</h3>
  <div class="card">${exec === FAILED ? sectionError("") : exec.map((o) => personRow(o, { office: true })).join("") || `<p class="secondary small">${BROWSE_EMPTY}</p>`}</div>
  <h3 class="label">The legislature</h3>
  ${sortSwitch(base, sort)}
  ${lists.join("")}
  <p class="small"><a class="inline-link" href="${statePath(st)}">${esc(STATE_NAME[st])}'s page</a>: its map, districts, counties and recent votes.</p>`;
    }
  } else {
    const justices = await loadSection("reps justices", () => loadJustices(env, request), null);
    const rows = justices && justices !== FAILED ? justices.justices || [] : [];
    body = `
  <h3 class="label">The Supreme Court</h3>
  <div class="card">${justices === FAILED ? sectionError("") : rows.map((j) => linkRow(`/justices/${j.slug}/`, j.name, j.title)).join("") || `<p class="secondary small">${BROWSE_EMPTY}</p>`}</div>
  <p class="small"><a class="inline-link" href="/bodies/us-supreme-court/">The Court</a> · <a class="inline-link" href="/court/term/">This term</a></p>`;
  }
  return `
<section class="stack-sm" id="browse" aria-labelledby="h-browse">
  <span id="state-list"></span>
  <h2 class="label" id="h-browse">Browse</h2>
  ${nav}
  ${body}
</section>`;
}

/** Old and current addresses: ?state=XX alone means members of Congress for that state. */
export function browseParams(url, vs, d) {
  const p = url.searchParams;
  const raw = String(p.get("state") || "").toUpperCase();
  const given = STATE_NAME[raw] ? raw : null;
  const browse = BROWSE[p.get("browse")] ? p.get("browse") : "federal";
  const st = given || (browse === "state" ? (vs && vs.st) || (d && d.st) || null : null);
  const sort = p.get("sort") === "district" ? "district" : "name";
  const chamber = /^[a-z]{2}-[a-z]+$/.test(p.get("chamber") || "") ? p.get("chamber") : null;
  const offset = Math.max(0, parseInt(p.get("offset") || "0", 10) || 0);
  return { browse, st, sort, chamber, offset };
}

async function list(env, url, request, vs) {
  const d = districtsFromCookie(request);
  if (!env.DB) return notLoaded("Reps", "reps", true);
  const db = env.DB;
  const { browse, st, sort, chamber, offset } = browseParams(url, vs, d);

  // "Load more": the next page of one list (app.js appends it in place).
  if (chamber && offset) {
    const pg = await loadSection(`reps ${chamber} more`, () => chamberPage(db, { chamber, state: browse === "federal" ? st : null, sort, offset }));
    const name = CHAMBER_NAME[chamber] || "Members";
    const main = `
<header class="page-head"><h1>${esc(name)}</h1><p class="subtitle">From number ${offset + 1}${browse === "federal" && st ? `, ${esc(STATE_NAME[st])}` : ""}.</p></header>
${pg === FAILED ? sectionError("") : pagedList({ id: `list-${chamber}`, page: pg, href: repsHref({ browse, state: st, chamber, sort, offset: offset + PER_PAGE }), row: chamber.startsWith("us-") ? congressRow : personRow })}`;
    return page(`Reps: ${name}`, main, { tab: "reps", back: ["Reps", repsHref({ browse, state: st, sort })], partial: pg === FAILED });
  }

  const home = d ? d.st : vs ? vs.st : null;
  const [federalExec, reps, stateExec, senators, found] = await Promise.all([
    loadSection("reps executive", () => executiveOfficials(db, "us-executive"), []),
    d ? loadSection("reps mine", () => officialsWhere(db, repsWhere(d)), []) : [],
    home ? loadSection("reps state executive (yours)", () => executiveOfficials(db, chamberIds(home).executive), []) : [],
    !d && vs ? loadSection("reps senators", () => chamberPage(db, { chamber: "us-senate", state: vs.st }).then((r) => r.rows), []) : [],
    url.searchParams.get("q") ? searchPeople(env, request, url.searchParams.get("q")).catch(() => null) : null,
  ]);
  const ok = (x) => (x === FAILED ? [] : x);
  const people = d
    ? yourList({ federalExec: ok(federalExec), reps: ok(reps), stateExec: ok(stateExec) })
    : vs ? statewideList({ federalExec: ok(federalExec), senators: ok(senators), stateExec: ok(stateExec) }) : [];
  const main = `<div class="simple-scope">
<header class="page-head">
  <h1>Reps</h1>
  <p class="subtitle">Everyone who represents you, from the President to your county, with the record they keep. The same layout for every state.</p>
</header>
${(d || vs) ? yoursSection({ d, vs, people, failed: reps === FAILED || senators === FAILED }) : yoursSection({})}
${searchSection(url.searchParams.get("q"), found)}
<div class="simple-only simple-keep"><button class="btn" type="button" data-mode-set="detailed" data-mode-jump="browse">Browse all</button></div>
${await browseSection(db, env, request, { browse, st, sort, federalExec })}
<p class="hint">Every official here is loaded from an official source, linked on their page, with the date it was last checked.</p>
</div>`;
  return page("Reps", main, { tab: "reps", root: true, personal: !!d, partial: anyFailed(federalExec, reps, stateExec, senators) });
}

// The executive's "Record at a glance": what's loaded, counted, never scored.
function execGlance(o, orders, bills, nominations) {
  if (!orders && !bills) {
    return `<section class="card stack-sm">
  <h2 class="label">Record</h2>
  <p class="small">${esc(o.office)}${o.chamber === "ca-executive" ? ", elected statewide" : o.rank === 2 ? ", elected with the President" : ", a member of the President's Cabinet"}. ThePillory tracks the President's and the Governor's executive orders and bill actions; other executive offices have no separate record here yet.</p>
</section>`;
  }
  const b = (bills && bills.counts) || {};
  const stats = [
    [orders ? (orders.counts.executive_order || 0) : null, "Executive orders"],
    [bills ? (b.signed || 0) + (b.without_signature || 0) + (b.became_law || 0) : null, "Bills became law"],
    [bills ? b.vetoed || 0 : null, "Vetoes"],
    [nominations ? Object.values(nominations.counts).reduce((s, n) => s + n, 0) : null, "Civilian nominations"],
  ].filter(([n]) => n != null);
  return `<section class="card stack">
  <h2 class="label">Record at a glance</h2>
  <div class="grid-2">${stats.map(([n, label]) => `<div class="stat"><div class="stat-num">${n}</div><div class="stat-label">${label}</div></div>`).join("")}</div>
  <p class="hint">Counts of what's loaded from official records. ThePillory doesn't score or grade officials.</p>
</section>`;
}

// The California legislative committees an official sits on (Open States,
// refreshed weekly by the state-hearings step).
async function committeesFor(db, officialId) {
  const { results } = await db
    .prepare(
      `SELECT name, chamber, source_url FROM state_committees
       WHERE EXISTS (SELECT 1 FROM json_each(member_ids) WHERE value = ?) ORDER BY name`
    )
    .bind(officialId)
    .all();
  return results;
}

// Which kind of office: decides what the Votes, Funding and More tabs hold.
function roleOf(o) {
  if (isPresident(o)) return "president";
  if (isGovernor(o)) return "governor";
  if (o.chamber === "us-executive") return o.rank === 2 ? "vice-president" : "appointed";
  if (isExecutive(o)) return "statewide";
  return "legislator";
}

async function profile(env, slug, url, request) {
  if (!env.DB) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  const db = env.DB;
  const o = await loadSection("official", () => officialBySlug(db, slug), undefined);
  if (o === undefined) return notLoaded("Reps", "reps", false, ["Reps", "/reps/"]);
  if (o === FAILED) throw new Error(`official ${slug} couldn't load`);
  // The Time Machine: ?year= shows the official in that year. Past officeholders
  // (no longer in office) have pages only for the years they served.
  const year = pickYear(url);
  if (!o || year) {
    const any = await db.prepare("SELECT * FROM officials WHERE slug = ?").bind(slug).first();
    if (!any) return notFound("No official at this address.", "reps", ["Reps", "/reps/"]);
    if (year) return officialPastYear(env, request, url, any, year);
    const last = Math.max(FIRST_YEAR, Math.min(thisYear() - 1, (parseInt(String(any.term_end || "").slice(0, 4), 10) || thisYear()) - 1));
    return Response.redirect(`${url.origin}/reps/${any.slug}/?year=${last}`, 302);
  }
  const all = url.searchParams.get("votes") === "all";
  const pageNum = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  const cycle = parseInt(url.searchParams.get("cycle") || "", 10) || currentCycle();
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const show = ["signed", "vetoed"].includes(url.searchParams.get("show")) ? url.searchParams.get("show") : "all";
  const status = url.searchParams.get("status") || "all";
  const exec = isExecutive(o);
  const stateLegislator = o.chamber === "ca-assembly" || o.chamber === "ca-senate";
  // County supervisors file Form 700s too (the county forwards them to the FPPC).
  const supervisor = o.chamber === "county-board";
  // Another state's official: campaign money comes from each state's own agency, not loaded yet.
  const otherState = o.level === "state" && o.state && o.state !== "CA";
  // Members of Congress file STOCK Act trade reports.
  const congress = o.chamber === "us-house" || o.chamber === "us-senate";
  // The President, Vice President and Cabinet file OGE Form 278-T.
  const tradesOn = congress || o.chamber === "us-executive";
  // Each tab loads on its own: one that can't load shows a short note there.
  const loaded = await Promise.all([
    exec ? {} : loadSection("rep vote counts", () => voteCounts(db, o.id), {}),
    exec ? { rows: [], more: false } : loadSection("rep votes", () => votesFor(db, o.id, { all, limit: 50, offset: (pageNum - 1) * 50 }), { rows: [], more: false }),
    otherState ? null
      : exec ? loadSection("rep funding", () => executiveMoney(db, o, cycle), null)
      : o.level === "federal" ? loadSection("rep funding", () => fundingFor(db, o, cycle), null)
      : stateLegislator ? loadSection("rep funding", () => stateOfficialMoney(db, o, cycle), null)
      : supervisor ? loadSection("rep form 700", async () => ({ kind: "county", form700: await form700For(db, o.id) }), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep orders", () => ordersFor(db, o.id, { offset }), null) : null,
    isPresident(o) || isGovernor(o) ? loadSection("rep bills", () => billsActedOn(db, o.id, { show, offset }), null) : null,
    isPresident(o) ? loadSection("rep nominations", () => nominationsFor(db, o.id, { status, offset }), null) : null,
    o.level === "state" && !exec ? loadSection("rep committees", () => committeesFor(db, o.id), []) : [],
    loadSection("rep promises", () => promisesFor(db, o.id), null),
    loadSection("rep own words", () => ownWordsFor(db, o.id), null),
    tradesOn ? loadSection("rep trades", async () => {
      const [summary, firstPage, reports, assignments, post] = await Promise.all([
        tradeSummary(db, o.id), memberTrades(db, o.id), memberReports(db, o.id),
        congress ? memberCommittees(db, o.id) : [], congress ? null : executivePost(db, o.id),
      ]);
      return { summary, page: firstPage, reports, committees: assignments, post };
    }, null) : null,
    stateLegislator ? loadSection("rep California lobbying", () => caLobbyingForOfficial(db, o.id), null) : null,
    congress ? loadSection("rep government money", () => memberGovMoney(db, o.id), null) : null,
  ]);
  const [countsLoaded, votes, funding, orders, bills, nominations, committees, promises, ownWords, trades, caLobbying, govMoney] = loaded;
  const partial = anyFailed(countsLoaded, votes, funding, orders, bills, nominations, committees, promises, ownWords, trades, caLobbying, govMoney);
  const counts = countsLoaded === FAILED ? null : countsLoaded || {};
  const ok = (v) => (v === FAILED ? null : v);

  const body = BODY[o.body];
  const photo = safeUrl(o.photo_url);
  // Summary first: the record in one line, as counts and the latest recorded fact.
  const latest = votes !== FAILED && !all && pageNum === 1 ? votes.rows[0] : null;
  const glanceLine = exec
    ? (isPresident(o) || isGovernor(o)) && ok(orders) && ok(bills)
      ? `${ok(orders).counts.executive_order || 0} executive orders and ${ok(bills).counts.signed || 0} bills signed are on record${ok(bills).counts.vetoed ? `; ${ok(bills).counts.vetoed} vetoed` : ""}.`
      : ""
    : counts && counts.final
      ? `${counts.final} final-passage ${counts.final === 1 ? "vote" : "votes"} on record${latest ? `; the latest, ${fmtDate(latest.vote_date)}: ${latest.position} on ${latest.bill_number || latest.question}` : ""}.`
      : "";
  const head = `
<header class="page-head rep-head">
  ${photo
    ? `<img class="rep-photo" src="${esc(photo)}" alt="Official photo of ${esc(o.name)}" width="88" height="88" loading="lazy" onerror="this.remove()" />`
    : `<span class="rep-initials" aria-hidden="true">${esc(initials(o.name))}</span>`}
  <div class="stack-sm">
    <p class="label">${LEVEL_NAME[o.level]} · ${CHAMBER_NAME[o.chamber]}</p>
    <h1>${esc(o.name)}</h1>
    <p class="secondary">${esc(who(o))}</p>
    ${glanceLine ? `<p class="summary-text small">${esc(glanceLine)}</p>` : ""}
    ${body ? `<div class="chips">${body.chip}</div>` : ""}
    ${safeUrl(o.website) ? `<div class="chips"><a class="chip chip--tap" href="${esc(o.website)}" target="_blank" rel="noopener">Official site ↗</a></div>` : ""}
  </div>
</header>`;

  const term =
    o.term_start && o.term_end ? `${esc(o.term_start)} to ${esc(o.term_end)}`
      : o.term_start ? `Since ${esc(o.term_start)}` : null;
  const overview = `
${exec ? execGlance(o, ok(orders), ok(bills), ok(nominations)) : !counts ? sectionError("Record at a glance") : `<section class="card stack">
  <h2 class="label">Record at a glance</h2>
  <div class="grid-2">
    <div class="stat"><div class="stat-num">${counts.final || 0}</div><div class="stat-label">Final-passage votes</div></div>
    <div class="stat"><div class="stat-num">${counts.total || 0}</div><div class="stat-label">All recorded votes</div></div>
  </div>
  <p class="hint">Counts of recorded votes only. ThePillory doesn't score or grade officials.</p>
</section>`}
${fold("office", "Office", kv([
    ["Office", esc(o.office)],
    ["District", exec ? null : o.district ? esc(o.district) : "Statewide"],
    ["Party", o.party ? esc(o.party) : null],
    ["Term", term],
    ["Body", body ? `<a class="inline-link" href="/bodies/${esc(body.slug)}/">${esc(body.name)}</a>` : null],
    ["Website", safeUrl(o.website) ? `<a class="inline-link" href="${esc(o.website)}" target="_blank" rel="noopener">Official site ↗</a>` : null],
  ]), { meta: o.party || "" })}
${congress && trades && trades !== FAILED && trades.committees.length ? fold("congress-committees", "Committee assignments", committeesList(trades.committees), { meta: `${trades.committees.filter((c) => !c.parent).length} committees` }) : ""}
${fold("source", "Source", `<p class="small">Last verified ${fmtDate(o.last_verified)}.</p>
  ${sourceLink(o.source_url, "Official source")}
  ${o.photo_credit ? `<p class="hint">Photo: ${esc(o.photo_credit)}</p>` : ""}`, { meta: fmtDate(o.last_verified) })}
${yearBar(url, null, { label: `See ${o.name} in an earlier year` })}`;

  const base = `/reps/${o.slug}/`;
  const more = votes !== FAILED && votes.more
    ? `<a class="btn btn--block" href="${base}?${all ? "votes=all&" : ""}page=${pageNum + 1}#votes">Older votes</a>`
    : "";
  const voteList = votes === FAILED ? sectionError("") : votes.rows.length
    ? `<ul class="plain-list vote-list card">${votes.rows.map(voteRow).join("")}</ul>${more}`
    : `<p class="secondary small">${
        o.level === "county"
          ? "County votes aren't loaded yet."
          : all ? "No recorded votes yet." : "No final-passage votes recorded yet. Try “All votes”."
      }</p>`;

  // Five tabs for every official: About · Promises · Votes · Funding · More.
  // What Votes, Funding and More hold depends on the office (roleOf).
  const role = roleOf(o);
  const money = exec && !otherState && funding !== FAILED ? executiveFundingParts(o, funding, base) : null;
  // More: each part collapsed until tapped (a link to its id opens it).
  const sub = (id, label, html) => fold(id, label, html);
  const appointedNote = (what) =>
    `<section class="card stack-sm"><p class="small">${what}</p><p class="small"><a class="inline-link" href="#disclosures">See financial disclosures and ethics agreements under More</a></p></section>`;

  let votesHtml;
  if (role === "president" || role === "governor") {
    votesHtml = `<p class="small secondary">The ${role === "president" ? "President" : "Governor"} doesn't vote on bills. Instead, the bills that passed are signed or vetoed:</p>
  <div class="stack" id="bills">${bills === FAILED ? sectionError("") : billsTab(o, bills, base, show, offset)}</div>`;
  } else if (role === "appointed") {
    votesHtml = appointedNote(`${esc(o.office)} is an appointed office, so there are no votes to show: votes are recorded for members of Congress and the California Legislature.`);
  } else if (exec) {
    votesHtml = '<p class="secondary small">No votes are recorded for this office. ThePillory records votes in Congress and in state legislatures.</p>';
  } else {
    votesHtml = `${voteFilter(base, all, counts)}
    ${voteList}`;
  }

  let fundingHtml;
  if (funding === FAILED) fundingHtml = sectionError("");
  else if (role === "appointed") fundingHtml = appointedNote(`${esc(o.office)} is an appointed office, so there's no campaign money to show: appointed officials don't run campaigns.`);
  else if (otherState) fundingHtml = `<section class="card stack-sm"><p class="small">Campaign money for ${esc(STATE_NAME[o.state] || o.state)}'s officials isn't on ThePillory yet. It comes from each state's own campaign finance agency, and will be added state by state.</p><p class="hint">Members of Congress: Federal Election Commission. California: Cal-Access.</p></section>`;
  else if (exec) fundingHtml = money.funding || '<p class="secondary small">No campaign money to show for this office.</p>';
  else if (stateLegislator) fundingHtml = stateFundingTab(o, funding && funding.money, base);
  else fundingHtml = fundingTab(o, supervisor ? null : funding, base);

  // More: everything else, in sections.
  const moreParts = [];
  if (trades) moreParts.push(sub("more-trades", "Stock trades", trades === FAILED ? sectionError("") : tradesSection(o, trades)));
  if (congress) {
    const gm = govMoney === FAILED ? null : govMoney;
    moreParts.push(sub("more-earmarks", "Earmarks", govMoney === FAILED ? sectionError("") : earmarksSection(o, gm)));
    moreParts.push(sub("more-travel", "Privately paid travel", govMoney === FAILED ? sectionError("") : travelSection(o, gm)));
    moreParts.push(sub("more-foreign-agents", "Contacts reported by foreign agents", govMoney === FAILED ? sectionError("") : faraSection(o, gm)));
  }
  if (orders) moreParts.push(sub("orders", "Executive orders", orders === FAILED ? sectionError("") : ordersTab(o, orders, base, offset)));
  if (nominations) moreParts.push(sub("nominations", "Nominations", nominations === FAILED ? sectionError("") : nominationsTab(o, nominations, base, status, offset)));
  if (exec && !otherState) moreParts.push(sub("more-disclosures", "Disclosures", funding === FAILED ? sectionError("") : money.disclosures));
  if (stateLegislator) moreParts.push(sub("more-lobbying", "Lobbying", caLobbying === FAILED ? sectionError("") : caLegislatorLobbying(o, caLobbying)));
  if (stateLegislator || supervisor) moreParts.push(sub("more-disclosures", "Disclosures", funding === FAILED ? sectionError("") : funding ? stateForm700(funding) : ""));
  if (o.level === "state" && !exec) {
    moreParts.push(sub("committees", "Committees", committees === FAILED ? sectionError("") : committees.length
      ? `<div class="card"><ul class="plain-list">${committees.map((c) => `<li class="list-row"><span class="list-title">${esc(c.name)}</span><span class="row-end">${sourceLink(c.source_url)}</span></li>`).join("")}</ul></div><p class="hint">From Open States, refreshed weekly.</p>`
      : '<p class="secondary small">No committee assignments loaded for this legislator.</p>'));
  }
  // Reports and issues open with accounts; none exist yet.
  moreParts.push(sub("issues", "Issues", EMPTY_REPORTS));

  // Quick mode: who they are, the job, the latest votes, their own words, the money in one line.
  const recent = votes !== FAILED && votes.rows ? votes.rows.slice(0, 3) : [];
  const excerpt = ownWords && ownWords !== FAILED && ownWords.pages && ownWords.pages[0];
  const fundingOk = funding && funding !== FAILED && funding.totals ? funding : null;
  const moneyLine = o.level === "federal" && !exec && fundingOk ? moneyLinePlain(fundingOk.totals, `${fundingOk.cycle - 1}–${fundingOk.cycle}`) : null;
  const simple = simpleCard({
    lines: [
      ["Their job", esc(jobSentence(o, STATE_NAME[o.state] || ""))],
      ["Latest votes", recent.length ? `<ul class="simple-list">${recent.map((v) => `<li>${voteLinePlain(v)}</li>`).join("")}</ul>` : ""],
      ["In their own words", excerpt ? `<div class="stack-xs"><p class="promise-quote">“${esc(excerpt.excerpt)}”</p><p class="small">${sourceNote(excerpt.url, excerpt.title || "Their issues page")}</p></div>` : ""],
      ["Stock trades", trades && trades !== FAILED ? quickTradesLine(trades.summary) : ""],
      ["Money", moneyLine ? `${esc(moneyLine)} <a class="inline-link" href="#funding" data-mode-set="detailed">The full Funding tab</a>` : ""],
    ],
    source: `Votes from the official record of each vote${moneyLine ? "; money from reports filed with the Federal Election Commission" : ""}. <a class="inline-link" href="${SIMPLE_METHOD}">How Quick mode works</a>`,
    jump: "about",
  });
  const tab = (k, label) => `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}</a>`;
  const main = `<div class="simple-scope">${head}
${simple}
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs tabs--five" role="tablist" aria-label="Sections">
    ${tab("about", "About")}${tab("platform", "Platform")}${tab("votes", "Votes")}${tab("funding", "Funding")}${tab("more", "More")}
  </nav>
  <div class="stack" role="tabpanel" id="about" aria-labelledby="tab-about">${overview}</div>
  <div class="stack" role="tabpanel" id="platform" aria-labelledby="tab-platform">${promises === FAILED || ownWords === FAILED ? sectionError("") : platformTab(o, promises, ownWords, { env, url })}</div>
  <div class="stack" role="tabpanel" id="votes" aria-labelledby="tab-votes">${votesHtml}</div>
  <div class="stack" role="tabpanel" id="funding" aria-labelledby="tab-funding">${fundingHtml}</div>
  <div class="stack" role="tabpanel" id="more" aria-labelledby="tab-more">${moreParts.join("")}</div>
</div>
</div>`;
  return page(o.name, main, { tab: "reps", back: ["Reps", "/reps/"], partial });
}

// A rep's page is the same for every visitor: kept at the edge for a few
// minutes. The Reps list is too, for visitors without saved districts.
const REPS_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) {
    const d = districtsFromCookie(context.request);
    const vs = visitorState(context.request, d);
    if (d) return list(context.env, url, context.request, vs);
    // One copy per state "Your representatives" shows (and one without), never kept by browsers.
    return edgeCached(context, REPS_CACHE_SECONDS, () => list(context.env, url, context.request, vs), {
      variant: vs ? vs.st : "none",
      clientCache: "private, no-cache",
    });
  }
  if (parts.length === 1) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return edgeCached(context, REPS_CACHE_SECONDS, () => profile(context.env, parts[0], url, context.request));
  }
  if (parts.length === 2 && parts[1] === "trades") {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return edgeCached(context, REPS_CACHE_SECONDS, () => tradesPage(context.env, parts[0], url));
  }
  return notFound("No page at this address.", "reps", ["Reps", "/reps/"]);
}, { tab: "reps" });

// /reps/<slug>/trades/?offset=N: the next page of a member's trades ("Load more" appends it in place).
async function tradesPage(env, slug, url) {
  if (!env.DB) return notLoaded("Stock trades", "reps");
  const o = await officialBySlug(env.DB, slug);
  if (!o || !["us-house", "us-senate", "us-executive"].includes(o.chamber)) return notFound("No member of Congress or the executive branch at this address.", "reps", ["Reps", "/reps/"]);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const pg = await loadSection("rep trades page", () => memberTrades(env.DB, o.id, offset), null);
  const more = pg && pg !== FAILED && pg.more ? `<a class="btn btn--block load-more" href="/reps/${esc(o.slug)}/trades/?offset=${offset + TRADES_PER_PAGE}" data-load-more="trade-list">Load more</a>` : "";
  const main = `
<header class="page-head"><h1>Stock trades</h1><p class="subtitle">${esc(o.name)}${offset ? `, from number ${offset + 1}` : ""}, newest first.</p></header>
${pg === FAILED || !pg ? sectionError("") : `<div class="card compact-list" id="trade-list">${pg.rows.map((t) => tradeRow(t)).join("") || '<p class="secondary small cr-empty">No more trades.</p>'}</div>`}
${more}
<p class="hint"><a class="inline-link" href="${TRADES_METHOD}">How trades are recorded</a></p>`;
  return page(`${o.name}: stock trades`, main, { tab: "reps", back: [o.name, `/reps/${o.slug}/#more-trades`], partial: pg === FAILED });
}

// ---------------------------------------------------------------------------
// "Something wrong?" on a promise: no account; Turnstile plus a daily limit per
// visitor (a daily-rotating hash, never the address). The flag goes to the
// review queue and the promise shows "Under review" until a person resolves it.

const FLAGS_PER_VISITOR = 5; // per day, shared with the analysis flags

async function promiseFlag(context, slug, id) {
  const { request, env } = context;
  const url = new URL(request.url);
  const back = (q) => Response.redirect(`${url.origin}/reps/${encodeURIComponent(slug)}/?${q}#promise-${id}`, 303);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  if (!env.DB || !turnstileReady(env)) return back("error=closed");
  const form = await request.formData();
  if (!(await verifyTurnstile(env, form.get("cf-turnstile-response"), request.headers.get("CF-Connecting-IP")))) return back("error=turnstile");
  const reason = String(form.get("reason") || "");
  if (!FLAG_REASONS.some(([v]) => v === reason)) return back("error=invalid");
  const db = env.DB;
  const p = await db
    .prepare("SELECT p.id FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.id = ? AND o.slug = ? AND p.review IN ('auto', 'approved')")
    .bind(id, slug)
    .first();
  if (!p) return back("error=invalid");
  const visitor = await visitorHash(env, request);
  if ((await actionsToday(db, "flag", visitor)) >= FLAGS_PER_VISITOR) return back("error=limit");
  const note = String(form.get("note") || "").replace(/\s+/g, " ").trim().slice(0, 1000);
  await db.batch([db.prepare("INSERT INTO promise_flags (promise_id, reason, note) VALUES (?, ?, ?)").bind(id, reason, note), recordAction(db, "flag", visitor)]);
  return back("sent=promise-flag");
}

export async function onRequestPost(context) {
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 4 && parts[1] === "promises" && /^\d+$/.test(parts[2]) && parts[3] === "flag") {
    try {
      return await promiseFlag(context, decodeURIComponent(parts[0]), parseInt(parts[2], 10));
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return new Response("Not available yet", { status: 503 });
      throw err;
    }
  }
  return new Response("Not found", { status: 404 });
}
