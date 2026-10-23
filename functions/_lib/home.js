// Home, the hub (thepillory.co itself), and the one template for every state's
// page: functions/index.js renders it for the visitor's state, and
// functions/states/ for /states/<name>/. The same sections in the same order
// for every state, about three phone screens, each fact once:
//   1. the headline
//   2. on /, the U.S. map ("Tap your state to see who represents you"; no
//      zooming or dragging, so scrolling always works) and "Counties and
//      districts ›"; on /states/<name>/, that state's own map with its layers
//      (Counties, Congressional, the state's chambers; a county or district
//      opens its page) and "Every county and district ›", the lists on
//      /states/<name>/map/ (functions/_lib/state-map.js). Both in Quick too.
//   3. the ballot card, from WINDOW_DAYS before the state's next election
//   4. Your representatives: the President, the two U.S. Senators and the
//      Governor; then the House member and state legislators once districts are
//      known, or the address/ZIP box (functions/_lib/quick-home.js)
//   5. This week: one feed with a Congress / [State] switch, five items, See all
//   6. The nation: President & Cabinet, Congress, Supreme Court, one row each
//   7. Topics: one row of chips
//   8. Elections: one line
// then one line for whatever isn't loaded for the state yet ("Coming to [State]:
// … Join the list ›", functions/_lib/state-lead.js). Take part, Communities,
// Understand and the waitlist form live on the You tab and /waitlist/.
//
// First-time visitors get a short intro they can dismiss (remembered in the
// browser). A visitor in a US state (one they picked, their saved districts'
// state, or Cloudflare's approximate state for the connection, never stored)
// gets their state marked "You're here" on the map. Outside the US, or when the
// region is unknown: the national hub. Kept at the edge once per state;
// browsers don't keep it. The old ?hub=1 flag and /home/ redirect here.
import { page, esc, linkRow, loadSection, FAILED, anyFailed, sectionError } from "./render.js";
import { pacificNow, addDays } from "./meetings.js";
import { describe, STATE_NAME } from "./districts.js";
import { lookupForm } from "./hub.js";
import { TOPICS, topicHref, placeTopicsHref } from "./topics.js";
import { ballotWindow, todayIn, onlyIfNeeded, previewLabel } from "./election-window.js";
import { quickHomeData, thisWeek, yourReps, weekFeed, quickLinks, THIS_WEEK_DAYS } from "./quick-home.js";
import { loadElection, ballotFor, ballotHref, electionHref, whenLine, electionIdFor, measuresOnly, ELECTION_BY_STATE } from "./elections.js";
import { LIVE, asset, loadIndex, loadPlace, waitlistBy, usMapLinks, smallStateButtons, mapFigure } from "./geo.js";
import { ASSET_VERSION } from "./generated.js";
import { executiveOfficials } from "./executive.js";
import { stateLeadData, governorOf, liveCounties, comingTo } from "./state-lead.js";
import { statePath } from "./state-paths.js";
import { stateMapLite, stateMapFigure } from "./state-map.js";
import { votesLoaded } from "./coverage.js";

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The U.S. map at the top of the hub: real counts, taps only.
function usMap(index, waiting, vs) {
  // The state's counties and districts are on its own map page; live counties link straight to their briefing.
  const stateLinks = vs
    ? `<div class="card hub-map-links">${linkRow(`${statePath(vs.st)}map/`, "Counties and districts", `${vs.name}'s map, every county and district`)}${liveCounties(vs.st).map(([, c]) => linkRow(c.briefing, c.name, "Live: meetings, agendas and local officials")).join("")}</div>`
    : "";
  if (!index) return '<p class="explore-link"><a class="btn btn--block" href="/explore/">Explore the map</a></p>';
  const { links, status } = usMapLinks(index, waiting);
  // The visitor's state, marked "You're here" (California stays a live community too).
  if (vs && links[vs.st]) {
    status[vs.st] = [status[vs.st], "here"].filter(Boolean).join(" ");
    links[vs.st] = [links[vs.st][0], `${links[vs.st][1]} (you're here)`];
  }
  const live = Object.keys(LIVE).length;
  const counties = Object.keys(waiting.county).filter((f) => !LIVE[f]).length;
  return `
<section class="hub-map stack-xs simple-keep" aria-labelledby="h-map">
  <h2 class="visually-hidden" id="h-map">Map of the United States</h2>
  <p class="small secondary map-hint">Tap your state to see who represents you.</p>
  ${mapFigure({ id: "us-map", src: "/data/geo/us.json", links, status, label: "Map of the United States: tap a state to explore it", still: true })}
  ${smallStateButtons(index)}
  <div class="hub-map-foot">
    <p class="map-counts small">${vs ? `<span><span class="swatch is-here" aria-hidden="true"></span>You're here</span><span class="dot"> · </span>` : ""}<span><span class="swatch is-live" aria-hidden="true"></span>${plural(live, "live community", "live communities")}</span><span class="dot"> · </span><span><span class="swatch is-waiting" aria-hidden="true"></span>${plural(counties, "county", "counties")} waiting</span></p>
    <a class="inline-link" href="/explore/">Explore the full map</a>
  </div>
  ${stateLinks}
</section>`;
}

// A state's own page: the state's map at the top, the "zoom in" from the U.S.
// map. Counties, Congressional and the state's chambers as layers; a county or
// district opens its page. The long lists stay on /states/<name>/map/.
function stateMapTop(vs, lite, waiting) {
  const mapPage = `${statePath(vs.st)}map/`;
  const live = liveCounties(vs.st).map(([, c]) => linkRow(c.briefing, c.name, "Live: meetings, agendas and local officials")).join("");
  const figure = lite
    ? stateMapFigure({ ...lite, waiting }, { noscript: `The map needs JavaScript. <a class="inline-link" href="${mapPage}">Every county and district in ${esc(vs.name)}</a> is listed on its map page.` })
    : "";
  return `
<section class="hub-map stack-xs simple-keep" id="map" aria-labelledby="h-map">
  <div class="section-head"><h2 id="h-map">${esc(vs.name)}</h2></div>
  ${figure || `<p class="small secondary">No map for ${esc(vs.name)} yet.</p>`}
  <div class="card hub-map-links">${linkRow(mapPage, "Every county and district", lite ? `${lite.place.counties.length} ${lite.place.counties.length === 1 ? "county" : "counties"}, and every district, as lists` : "As lists")}${live}</div>
  <p class="small"><a class="inline-link" href="/explore/">← The U.S. map</a></p>
</section>`;
}

// One line with the date and countdown, and a standard-size button: no more.
function ballotHero(vs, win) {
  return `
<section class="card ballot-hero simple-keep" aria-label="${esc(previewLabel(vs.st, vs.name))}">
  <p class="ballot-hero-when">${esc(win.line)}${onlyIfNeeded(win.election) ? '<span class="secondary"> (if needed)</span>' : ""}</p>
  <a class="btn btn--primary" href="/ballot/${vs.st.toLowerCase()}/">${esc(previewLabel(vs.st, vs.name))}</a>
</section>`;
}

/** "Calaveras County, CA" for saved districts (the state's name when there's no county). */
async function placeName(env, request, d) {
  const place = d.co ? await loadPlace(env, request, d.st.toLowerCase()) : null;
  const c = place && place.counties.find((x) => x.fips === d.co);
  return c ? `${c.name}, ${d.st}` : STATE_NAME[d.st];
}

// Topics: every topic as a chip, for the visitor's county when it's known.
async function topicPlace(env, request, d) {
  if (!d || !d.co) return null;
  const place = await loadPlace(env, request, d.st.toLowerCase());
  const c = place && place.counties.find((x) => x.fips === d.co);
  return c ? { st: place.st, slug: c.slug, name: c.name } : null;
}

// Elections, one line: the state's election page where ThePillory has its
// ballot ("Your ballot" once districts are known), else its ballot preview.
// While the ballot card shows, the line doesn't repeat its date or its link.
async function electionsData(env, request, d, st) {
  const election = await loadElection(env, request, electionIdFor(st));
  if (!election || !d || d.st !== election.election.state || measuresOnly(election)) return { election, ballot: null };
  const place = d.co ? await loadPlace(env, request, d.st.toLowerCase()) : null;
  const county = place && place.counties.find((c) => c.fips === d.co);
  return { election, ballot: ballotFor(election, d, county ? county.name : null) };
}

function electionsLine({ election, ballot }, st, today, hero) {
  if (st === "PR") return "";
  const when = hero || !election ? "" : whenLine(election, today);
  const row = election && (!st || ELECTION_BY_STATE[st])
    ? ballot
      ? linkRow(ballotHref(election.election.id), `Your ballot · ${election.election.name}`, when || "Every contest for your districts")
      : linkRow(electionHref(election.election.id), election.election.name, [when, "What's on the ballot, how to vote"].filter(Boolean).join(" · "))
    : st && !hero
      ? linkRow(`/ballot/${st.toLowerCase()}/`, `${STATE_NAME[st]}: General election, November 3, 2026`, "Your federal races, then your whole ballot and where to vote")
      : st
        ? linkRow("/elections/", "All elections", "Every election ThePillory has a ballot for, and how to vote")
        : "";
  if (!row) return "";
  return `
<section class="stack-xs simple-keep" id="elections" aria-labelledby="h-elections">
  <div class="section-head"><h2 class="label" id="h-elections">Elections</h2><a class="section-link" href="/elections/">All</a></div>
  <div class="card">${row}</div>
</section>`;
}

// The nation: one row each, the same on every state's page; the people are one tap further.
function nationSection(vs) {
  return `
<section class="stack-xs" id="nation" aria-labelledby="h-nation">
  <h2 class="label" id="h-nation">The nation</h2>
  <div class="card">
    ${linkRow("/bodies/us-executive/", "President & Cabinet", "The President, the Vice President and the Cabinet")}
    ${linkRow(vs ? `/reps/?state=${vs.st}` : "/reps/?browse=federal", "Congress", vs ? `The Senate and the House, ${vs.name}'s members first` : "The Senate and the House, every member")}
    ${linkRow("/bodies/us-supreme-court/", "Supreme Court", "The justices, this term's cases and decisions")}
  </div>
</section>`;
}

// Topics: one row of chips, for the visitor's county when it's known.
function topicsRow(place) {
  return `
<section class="stack-xs" id="topics" aria-labelledby="h-topics">
  <div class="section-head"><h2 class="label" id="h-topics">Topics</h2><a class="section-link" href="${place ? placeTopicsHref(place) : "/topics/"}">All</a></div>
  <div class="chip-scroll">${TOPICS.map((t) => `<a class="chip chip--tap" href="${topicHref(t.slug, place)}">${esc(t.name)}</a>`).join("")}</div>
</section>`;
}

export async function hub(env, request, url, d, vs) {
  const db = env.DB;
  // Saved districts in another state than the page's: the page shows only its own state,
  // and the visitor's place is one small line at the bottom.
  const mine = d && (!vs || d.st === vs.st) ? d : null;
  const elsewhere = d && !mine ? d : null;
  const lead = vs ? await stateLeadData(db, vs.st) : null;
  const senators = lead && lead.senators !== FAILED ? lead.senators : [];
  // This week's switch: Congress, or the state's legislature once its votes are loaded
  // (California for the national hub).
  const feedSt = vs ? vs.st : "CA";
  const feedName = vs ? vs.name : "California";
  const stateOption = !vs || votesLoaded(vs.st, lead && lead.coverage !== FAILED ? lead.coverage : null)
    ? { value: feedSt === "CA" ? "state" : `state:${feedSt}`, name: feedName }
    : null;
  const which = stateOption && url.searchParams.get("now") === stateOption.value ? stateOption.value : "federal";
  const start = pacificNow();
  const today = start.slice(0, 10);
  const since = addDays(today, -THIS_WEEK_DAYS);
  // Each section loads on its own: one that can't load shows a short note, and the rest still shows.
  // The state's own page (/states/<name>/) leads with the state's map; / with the U.S. map.
  const statePage = !!(vs && vs.source === "page");
  const [index, waiting, federalExec, elections, tPlace, dates, yourPlace, quick, lite] = await Promise.all([
    loadIndex(env, request),
    loadSection("hub waitlist map", db ? () => waitlistBy(db) : async () => ({ county: {}, state: {} }), { county: {}, state: {} }),
    loadSection("hub executive", db ? () => executiveOfficials(db, "us-executive") : async () => [], []),
    loadSection("hub elections", () => electionsData(env, request, mine, vs ? vs.st : null), { election: null, ballot: null }),
    // Topics for the visitor's own county only on their own state's page.
    loadSection("hub topic place", () => topicPlace(env, request, mine), null),
    loadSection("hub election dates", () => asset(env, request, "/data/elections/dates.json"), null),
    elsewhere ? loadSection("hub your place", () => placeName(env, request, elsewhere), null) : null,
    loadSection("hub this week", () => quickHomeData(env, request, { st: feedSt, since, districts: mine, senatorIds: senators.map((o) => o.id) }), null),
    statePage ? loadSection("hub state map", () => stateMapLite(env, request, vs.st, url.searchParams.get("layer")), null) : null,
  ]);
  // Links within the page (This week's switch) stay on this page: the state's own address, or /.
  const here = vs && vs.source === "page" ? statePath(vs.st) : "/";
  // The state's next election (a special election too, in the visitor's own House district).
  const win = vs && dates && dates !== FAILED ? ballotWindow(dates, vs.st, todayIn(vs.st), mine ? mine.cd : null) : null;
  const hero = !!(win && win.open);
  const notFound = url.searchParams.get("lookup") === "notfound";

  // 4. Your representatives: each person once.
  const q = quick && quick !== FAILED ? quick : null;
  const known = mine
    ? `<p class="small">Showing: <strong>${esc(describe(mine))}</strong>. <button class="linkish" type="button" data-forget-districts>Forget this</button></p>
  <div>${linkRow("/briefing/", "Your briefing", "Your reps' latest votes, and what's happening where you live")}</div>
  <details class="lookup-change" id="find"><summary class="inline-link">Use a different address</summary>${lookupForm(null, { id: "find-change", heading: "Street address or ZIP code", bare: true })}</details>`
    : "";
  const repsHtml = yourReps({
    stateName: vs ? vs.name : null,
    president: (federalExec === FAILED ? [] : federalExec).find((o) => o.rank === 1) || null,
    senators,
    governor: lead ? governorOf(lead.executive) : null,
    mine: q ? q.mine : [],
    known,
    lookup: mine ? "" : lookupForm(null, { heading: vs ? "Add your ZIP or address for your House member and state legislators" : "Add your ZIP or address for your senators, House member and state legislators", bare: true }),
    allHref: vs ? `/reps/?state=${vs.st}` : "/reps/",
  });

  // 5. This week: Congress, or the state.
  const federal = which === "federal";
  const items = !q ? [] : thisWeek({
    stateName: feedName,
    votes: federal ? q.congressVotes : q.stateVotes,
    outcomes: q.outcomes.filter((o) => (o.level === "federal") === federal),
    decisions: federal ? q.decisions : [],
    orders: q.orders.filter((o) => !!o.federal === federal),
    plain: q.plain,
  });
  const feed = quick === FAILED ? sectionError("This week") : weekFeed({
    items,
    tabs: stateOption ? [
      { label: "Congress", href: here, current: federal },
      { label: stateOption.name, href: `${here}?now=${stateOption.value}`, current: !federal },
    ] : [],
    seeAll: `/votes/?level=${which}`,
  });

  const main = `<div class="simple-scope">
<header class="hub-head stack-sm simple-keep">
  <h1 class="hub-title">Know what your government is doing. <span class="hub-title-soft">Then take part.</span></h1>
  <p class="hub-sub">Votes, bills, and meetings in plain language, measured against the Constitution. Built on evidence, open to every point of view.</p>
</header>
${statePage ? (lite === FAILED ? sectionError(`${vs.name} map`) : stateMapTop(vs, lite, waiting)) : usMap(index, waiting === FAILED ? { county: {}, state: {} } : waiting, vs)}
${hero ? ballotHero(vs, win) : ""}
${notFound ? '<p class="banner banner--error" role="alert">We couldn\'t find districts for that. Check the address, or try your ZIP code.</p>' : ""}
${repsHtml}
<aside class="intro-banner" data-intro hidden aria-label="Welcome">
  <p><strong>New here?</strong> ThePillory keeps a public, sourced record of what your officials do: every recorded vote, the bills they vote on mapped to the Constitution, local meeting agendas, and the money around them. Facts and sources, no party labels.</p>
  <p><a class="inline-link" href="/about/how-it-works/">How it works</a> · <a class="inline-link" href="/about/principles/">Principles</a></p>
  <button class="intro-dismiss" type="button" data-intro-dismiss aria-label="Dismiss this introduction">×</button>
</aside>
${feed}
${nationSection(vs)}
${topicsRow(tPlace === FAILED ? null : tPlace)}
${elections === FAILED ? sectionError("Elections") : electionsLine(elections, vs ? vs.st : null, today, hero)}
${vs && lead ? comingTo(vs, lead) : ""}
${elsewhere ? `<p class="small secondary your-place">Your place: ${esc(typeof yourPlace === "string" ? yourPlace : STATE_NAME[elsewhere.st])} · <a class="inline-link" href="/briefing/">Your briefing</a></p>` : ""}
${quickLinks()}
</div>
${index || lite ? `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>` : ""}`;
  // Personal only once the visitor's districts are known; otherwise the same for everyone.
  const title = vs && vs.source === "page" ? vs.name : "Know what your government is doing";
  return page(title, main, { tab: "home", root: true, personal: !!d, partial: anyFailed(waiting, federalExec, elections, quick) });
}

// The hub for a visitor without saved districts is the same for everyone: kept
// at the edge for a few minutes. With districts, it's built for that visitor.
export const HUB_CACHE_SECONDS = 300;
