// Home, the hub (thepillory.co itself), and the one template for every state's
// page: functions/index.js renders it for the visitor's state, and
// functions/states/ for /states/<name>/. The same sections in the same order
// for every state; a section without data says "Coming soon for [State]".
//
// For every visitor. First-time
// visitors get a short intro they can dismiss (remembered in the browser).
// A visitor whose districts are known (the pillory_districts cookie, set by the
// lookup) also gets a link to their briefing at /briefing/. The old ?hub=1 flag
// redirects here; /home/ redirects here.
//
// The hub, top to bottom:
//   headline; a U.S. map (tap a state for its /states/<name>/ page; no zooming or
//   dragging here, so scrolling always works), the small-state buttons, live and
//   waiting counts, and Explore the full map; Find your representatives (address
//   or ZIP; nothing stored); Who represents you (the President, Vice President
//   and Cabinet; California's Governor and statewide offices);
//   Elections (the next election; Your ballot once districts are known; How to vote);
//   Happening now (Congress / California: latest final-passage votes, ?now=state);
//   Topics (every topic, for the visitor's county when known);
//   Take part (Calaveras comment deadlines, contacting your reps);
//   Communities (Calaveras, live; the county waitlist with real counts);
//   Understand (explainers).
//
// A visitor in a US state (one they picked, their saved districts' state, or
// Cloudflare's approximate state for the connection, never stored) gets
// "Showing [State] · Change" at the top, their state marked "You're here" on
// the map, and "Your state" leading the page (functions/_lib/state-lead.js);
// the national sections follow. Outside the US, or when the region is unknown:
// the national hub. Kept at the edge once per state; browsers don't keep it.
import { icon } from "./icons.js";
import { page, esc, linkRow, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "./render.js";
import { listMeetings, pacificNow, addDays, deadlineParts, meetingHref, when } from "./meetings.js";
import { districtsFromCookie, describe, STATE_NAME } from "./districts.js";
import { happeningNow, happeningSection, lookupForm, waitlistCounts } from "./hub.js";
import { topicGrid, placeTopicsHref } from "./topics.js";
import { ballotWindow, todayIn, onlyIfNeeded } from "./election-window.js";
import { racesHref, YEAR } from "./candidates.js";
import { loadElection, ballotFor, ballotHref, electionHref, whenLine, daysUntil, contestRow, courtRow, statewideRow, electionIdFor, measuresOnly, ELECTION_BY_STATE } from "./elections.js";
import { LIVE, asset, loadIndex, loadPlace, waitlistBy, usMapLinks, smallStateButtons, mapFigure } from "./geo.js";
import { ASSET_VERSION } from "./generated.js";
import { executiveOfficials, executiveRows } from "./executive.js";
import { turnstileReady, turnstileWidget } from "./turnstile.js";
import { visitorState } from "./visitor-state.js";
import { stateLead, stateLeadData } from "./state-lead.js";
import { stateMapData, stateMapSection } from "./state-map.js";
import { statePath } from "./state-paths.js";
import { courtCard, loadJustices } from "./scotus.js";
import { votesLoaded } from "./coverage.js";


const WAITLIST_MESSAGES = {
  joined: "Thank you. We'll email you only when ThePillory launches in your county.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "That's enough sign-ups from this connection for today. Please try again tomorrow.",
  invalid: "Choose a state and county, and enter an email address.",
  closed: "The list isn't open yet.",
};

function takePart(deadlines, loaded, vs = null) {
  // County comment deadlines are Calaveras's for now (the live community, in California).
  if (vs && vs.st !== "CA") return takePartSoon(vs);
  const rows = deadlines.length
    ? deadlines
        .map(({ m, d }) => {
          const w = when(m.starts_at);
          return `
<a class="list-row link-row" href="${meetingHref(m.id)}#weigh-in">
  <div><div class="list-title">Written comments by ${esc(d.label)}</div><div class="list-meta">${esc(m.body)} · meets ${esc([w.day, w.time].filter(Boolean).join(", "))}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
        })
        .join("")
    : `<p class="small secondary">${
        loaded ? "No written-comment deadlines posted for the next 30 days. Public comment is also taken at each meeting." : "Comment deadlines appear here once the data sync has run."
      }</p>`;
  // TODO: federal agency comment periods (Regulations.gov). Not built yet.
  return `
<section class="brief-section" id="take-part" aria-labelledby="h-take-part">
  <div class="section-head"><h2 class="label" id="h-take-part">Take part</h2><a class="section-link" href="/meetings/?level=county">County meetings</a></div>
  <div class="card stack-sm">
    <p class="label">Calaveras County comment deadlines</p>
    <div>${rows}</div>
  </div>
  <div class="card">
    <a class="list-row link-row" href="/reps/">
      <div><div class="list-title">Contact your representatives</div><div class="list-meta">Each rep's page links to their official website and office.</div></div>
      <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
    </a>
  </div>
</section>`;
}

function takePartSoon(vs) {
  return `
<section class="brief-section" id="take-part" aria-labelledby="h-take-part">
  <div class="section-head"><h2 class="label" id="h-take-part">Take part</h2></div>
  <div class="card stack-sm">
    <p class="label">County comment deadlines</p>
    <p class="small secondary">Coming soon for ${esc(vs.name)}. <a class="inline-link" href="#communities">Join the list</a> for your county and we'll email you when it opens.</p>
  </div>
  <div class="card">${linkRow("/reps/", "Contact your representatives", "Each rep's page links to their official website and office.")}</div>
</section>`;
}

function stateOptions(selected) {
  return Object.entries(STATE_NAME)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === selected ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
}

function communities(env, counts, msg, error, st = "") {
  const ready = turnstileReady(env);
  const countLine = counts
    ? counts.people
      ? `<p class="small"><strong>${counts.people}</strong> ${counts.people === 1 ? "person is" : "people are"} waiting in <strong>${counts.counties}</strong> ${counts.counties === 1 ? "county" : "counties"}.</p>`
      : '<p class="small secondary">No one is on the list yet.</p>'
    : "";
  const form = ready
    ? `
  <form class="stack-sm waitlist-form" method="post" action="/api/waitlist" data-county-picker>
    <div class="field-row">
      <label class="field"><span class="label">State</span>
        <select class="input" name="state" required><option value="">Choose a state</option>${stateOptions(st)}</select>
      </label>
      <label class="field"><span class="label">County</span>
        <select class="input" name="county" required><option value="">Choose a state first</option></select>
      </label>
    </div>
    <label class="field"><span class="label">Email</span>
      <input class="input" type="email" name="email" autocomplete="email" required maxlength="254" />
    </label>
    <p class="hint">Your email is used only to announce your county's launch. It's never shown or shared.</p>
    ${turnstileWidget(env)}
    <button class="btn btn--primary" type="submit">Join the list</button>
    <noscript><p class="small secondary">Choosing a county needs JavaScript.</p></noscript>
  </form>`
    : '<p class="small secondary">The list isn\'t open yet.</p>';
  return `
<section class="brief-section" id="communities" aria-labelledby="h-communities">
  <div class="section-head"><h2 class="label" id="h-communities">Communities</h2></div>
  <a class="card community-card icon-row" href="/calaveras/">
    <span class="icon-badge">${icon("community")}</span>
    <div class="stack-xs">
      <h3>Calaveras County, CA</h3>
      <p class="small secondary">Meetings, agenda watch, comment deadlines, and every recorded vote by the officials who represent the county.</p>
    </div>
    <span class="live-tag">Live</span>
  </a>
  <div class="card stack-sm">
    <h3>Bring ThePillory to your county</h3>
    <p class="small">Communities open one county at a time. Tell us where you are, and we'll let you know when yours opens.</p>
    ${msg ? `<p class="banner" role="status">${esc(msg)}</p>` : ""}
    ${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
    ${form}
    ${countLine}
  </div>
</section>`;
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

// The U.S. map at the top of the hub: real counts, taps only.
function usMap(index, waiting, vs) {
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
<section class="hub-map stack-xs" aria-labelledby="h-map">
  <h2 class="visually-hidden" id="h-map">Map of the United States</h2>
  ${mapFigure({ id: "us-map", src: "/data/geo/us.json", links, status, label: "Map of the United States: tap a state to explore it", still: true })}
  ${smallStateButtons(index)}
  <div class="hub-map-foot">
    <p class="map-counts small">${vs ? `<span><span class="swatch is-here" aria-hidden="true"></span>You're here</span><span class="dot"> · </span>` : ""}<span><span class="swatch is-live" aria-hidden="true"></span>${plural(live, "live community", "live communities")}</span><span class="dot"> · </span><span><span class="swatch is-waiting" aria-hidden="true"></span>${plural(counties, "county", "counties")} waiting</span></p>
    <a class="inline-link" href="/explore/">Explore the full map</a>
  </div>
</section>`;
}

// "Showing [State] · Change": where the state came from, and a picker that
// saves another one in this browser (POST /api/state). Works without JavaScript.
function showingBar(vs) {
  const why = vs.source === "page" ? "" : vs.source === "picked" ? "you chose it" : vs.source === "districts" ? "from your saved districts" : "based on your connection";
  return `
<details class="showing-bar card">
  <summary><span>Showing <strong>${esc(vs.name)}</strong>${why ? ` <span class="secondary">· ${why}</span>` : ""}</span><span class="inline-link">Change</span></summary>
  <form class="stack-sm" method="post" action="/api/state">
    <label class="field"><span class="label">State</span>
      <select class="input" name="st" required>${stateOptions(vs.st)}</select>
    </label>
    <button class="btn btn--primary" type="submit">Show this state</button>
  </form>
  ${vs.source === "picked" ? `<form method="post" action="/api/state"><input type="hidden" name="st" value="" /><button class="btn btn--block" type="submit">Use my connection's location instead</button></form>` : ""}
  <p class="hint">Your approximate state comes from your connection and isn't stored. A state you choose is saved only in this browser. For your exact districts, <a class="inline-link" href="#find">find your reps</a> with an address or ZIP code.</p>
</details>`;
}

// The nation: the same section in the same spot on every state's page. The
// President, Vice President and Cabinet; Congress; the Supreme Court (coming soon).
function nationalSection(federal, vs, justices) {
  return `
<section class="brief-section" id="nation" aria-labelledby="h-nation">
  <div class="section-head"><h2 class="label" id="h-nation">The nation</h2><a class="section-link" href="/reps/">All reps</a></div>
  <div class="card stack-xs">
    <p class="label">The President and the Cabinet</p>
    ${federal === FAILED ? sectionError("The executive branch") : federal.length ? executiveRows(federal) : '<p class="small secondary">Appears after the data sync runs.</p>'}
  </div>
  <div class="card stack-xs">
    <p class="label">Congress</p>
    ${vs
      ? `${linkRow(`/bodies/us-senate/?state=${vs.st}`, "U.S. Senate", `${vs.name}'s senators first, then every state`)}${linkRow(`/bodies/us-house/?state=${vs.st}`, "U.S. House", `${vs.name}'s representatives first, then every state`)}`
      : `${linkRow("/bodies/us-senate/", "U.S. Senate", "100 senators, two from each state, and their votes")}${linkRow("/bodies/us-house/", "U.S. House", "435 representatives and their votes")}`}
  </div>
  ${justices === FAILED ? sectionError("The Supreme Court") : courtCard(justices)}
</section>`;
}

// "Open your ballot": the top card from WINDOW_DAYS before the state's next election through
// Election Day (functions/_lib/election-window.js), a regular link the rest of the year.
const ballotLink = (st) =>
  linkRow(st ? `/ballot/${st.toLowerCase()}/` : "/ballot/", "Open your ballot", "Your federal races, then your whole ballot and where to vote");

// Every candidate in the state's 2026 races, the same page each (functions/_lib/candidates.js).
const racesLink = (st) => (st ? linkRow(racesHref(YEAR, st), `Candidates in ${STATE_NAME[st]}`, "Every race, the same page for every candidate") : "");

function ballotHero(vs, win) {
  return `
<section class="card stack-xs ballot-hero" aria-labelledby="h-ballot-hero">
  <p class="label" id="h-ballot-hero">Your ballot · ${esc(vs.name)}</p>
  <p class="ballot-hero-when">${esc(win.line)}</p>
  ${onlyIfNeeded(win.election) ? '<p class="small secondary">Held only for races no one won outright.</p>' : ""}
  <a class="btn btn--primary btn--block" href="/ballot/${vs.st.toLowerCase()}/">Open your ballot</a>
</section>`;
}

// Elections: the next election, and "Your ballot" once the visitor's districts are known.
async function electionsData(env, request, d, st) {
  // The visitor's state's election when ThePillory has one; otherwise California's.
  const election = await loadElection(env, request, electionIdFor(st));
  if (!election || !d || d.st !== election.election.state || measuresOnly(election)) return { election, ballot: null };
  const place = d.co ? await loadPlace(env, request, d.st.toLowerCase()) : null;
  const county = place && place.counties.find((c) => c.fips === d.co);
  return { election, ballot: ballotFor(election, d, county ? county.name : null), county };
}

function electionsSection({ election, ballot, county }, d, st = null) {
  // A state ThePillory has no ballot pages for yet: its federal races and the ballot for an address.
  if (st === "PR") return "";
  if (st && !ELECTION_BY_STATE[st]) return `
<section class="brief-section" id="elections" aria-labelledby="h-elections">
  <div class="section-head"><h2 class="label" id="h-elections">Elections</h2><a class="section-link" href="/elections/">All elections</a></div>
  <div class="card stack-xs">
    <p class="label">${esc(STATE_NAME[st])}</p>
    <h3>General election, November 3, 2026</h3>
    <p class="small secondary">Your federal races, then every contest and measure for your address, with where to vote.</p>
  </div>
  <div class="card">${ballotLink(st)}${racesLink(st)}</div>
</section>`;
  if (!election) return "";
  const id = election.election.id;
  const today = pacificNow().slice(0, 10);
  let yours;
  if (ballot) {
    const district = ballot.contests.filter((c) => c.scope !== "statewide");
    const local = ballot.partial.length + ballot.partialMeasures.length;
    yours = `
  <div class="card stack-xs">
    <p class="label">Your ballot</p>
    ${district.map((c) => contestRow(id, c)).join("")}${ballot.courts.map((g) => courtRow(id, g)).join("")}${statewideRow(election)}
    ${local ? `<a class="list-row link-row" href="${ballotHref(id)}#h-yl"><div><div class="list-title">Local contests and measures</div><div class="list-meta">${local} on some ballots in ${esc(county ? county.name : "your county")}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>` : ""}
    ${linkRow(ballotHref(id), "Open your ballot", "Every contest for your districts")}
  </div>`;
  } else if (measuresOnly(election)) {
    yours = `<p class="small secondary">The statewide measures, on every ballot in ${esc(STATE_NAME[election.election.state])}.</p>
  <div class="card">${ballotLink(election.election.state)}</div>`;
  } else {
    // Every state: the federal races, then the whole ballot for an address (/ballot/<st>/).
    yours = `<div class="card">${ballotLink(st)}</div>`;
  }
  return `
<section class="brief-section" id="elections" aria-labelledby="h-elections">
  <div class="section-head"><h2 class="label" id="h-elections">Elections</h2><a class="section-link" href="/elections/">All elections</a></div>
  <a class="card stack-xs" href="${electionHref(id)}">
    <p class="label">${esc(STATE_NAME[election.election.state])}</p>
    <h3>${esc(election.election.name)}</h3>
    <p class="small secondary">${esc(whenLine(election, today))}</p>
    <span class="inline-link">What's on the ballot</span>
  </a>
  ${yours}
  <div class="card">
    <a class="list-row link-row" href="${electionHref(id)}#how-to-vote"><div><div class="list-title">How to vote</div><div class="list-meta">Registration, deadlines and where to vote, on the official sites</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
    ${racesLink(st || election.election.state)}
  </div>
</section>`;
}

// Topics: every topic as a chip, for the visitor's county when it's known.
async function topicPlace(env, request, d) {
  if (!d || !d.co) return null;
  const place = await loadPlace(env, request, d.st.toLowerCase());
  const c = place && place.counties.find((x) => x.fips === d.co);
  return c ? { st: place.st, slug: c.slug, name: c.name } : null;
}

function topicsSection(place) {
  return `
<section class="brief-section" id="topics" aria-labelledby="h-topics">
  <div class="section-head"><h2 class="label" id="h-topics">Topics</h2><a class="section-link" href="${place ? placeTopicsHref(place) : "/topics/"}">All topics</a></div>
  <p class="small secondary">${place ? `One subject at a time for ${esc(place.name)}: bills and how your representatives voted, county meetings, executive actions, officials' own words and campaign money, side by side.` : "One subject at a time: bills and votes, county meetings, executive actions, officials' own words and campaign money, side by side."}</p>
  ${topicGrid(place)}
</section>`;
}

const UNDERSTAND = [
  ["/laws/constitution/", "The Constitution", "The full text, and how every analysis starts from it."],
  ["/about/how-a-bill-becomes-law/", "How a bill becomes law", "From introduction to signature, in Congress and in California."],
  ["/about/how-to-read-a-vote/", "How to read a vote", "Final passage, cloture, motions and nominations."],
  ["/about/how-it-works/", "How ThePillory works", "Evidence first, protected identities, no party labels."],
  ["/finances/", "Public finances by term", "Debt, spending and deficits by President, and California's budget by Governor."],
];

function understand() {
  return `
<section class="brief-section" id="understand" aria-labelledby="h-understand">
  <div class="section-head"><h2 class="label" id="h-understand">Understand</h2></div>
  <div class="tile-grid">
    ${UNDERSTAND.map(([href, title, sub]) => `<a class="card tile" href="${href}"><h3>${esc(title)}</h3><p class="small secondary">${esc(sub)}</p></a>`).join("")}
  </div>
</section>`;
}

export async function hub(env, request, url, d, vs) {
  const db = env.DB;
  const lead = vs ? await stateLeadData(db, vs.st) : null;
  // Happening now: Congress, or the state's legislature once its votes are loaded
  // (California for the national hub).
  const leadCov = lead && lead.coverage !== FAILED ? lead.coverage : null;
  const stateOption = !vs
    ? { value: "state", name: "California" }
    : votesLoaded(vs.st, leadCov)
      ? { value: vs.st === "CA" ? "state" : `state:${vs.st}`, name: vs.name }
      : null;
  const which = stateOption && url.searchParams.get("now") === stateOption.value ? stateOption.value : "federal";
  // Each section loads on its own: one that can't load shows a short note, and
  // the rest of the hub still shows.
  const start = pacificNow();
  const [index, now, deadlines, counts, waiting, federalExec, elections, tPlace, dates, mapData, justices] = await Promise.all([
    loadIndex(env, request),
    loadSection("hub happening now", db ? () => happeningNow(db, which, { limit: 4 }) : async () => [], []),
    loadSection("hub deadlines", db ? async () =>
      (await listMeetings(db, { from: start, to: `${addDays(start.slice(0, 10), 30)}T23:59`, level: "county", limit: 30 }))
        .filter((m) => m.status !== "cancelled")
        .map((m) => ({ m, d: deadlineParts(m) }))
        .filter((x) => x.d && x.d.date >= start.slice(0, 10))
        .slice(0, 4) : async () => [], []),
    loadSection("hub waitlist counts", db ? () => waitlistCounts(db) : async () => null, null),
    loadSection("hub waitlist map", db ? () => waitlistBy(db) : async () => ({ county: {}, state: {} }), { county: {}, state: {} }),
    loadSection("hub executive", db ? () => executiveOfficials(db, "us-executive") : async () => [], []),
    loadSection("hub elections", () => electionsData(env, request, d, vs ? vs.st : d ? d.st : null), { election: null, ballot: null }),
    // Topics for the visitor's own county only on their own state's page.
    loadSection("hub topic place", () => topicPlace(env, request, d && (!vs || d.st === vs.st) ? d : null), null),
    loadSection("hub election dates", () => asset(env, request, "/data/elections/dates.json"), null),
    vs ? loadSection("hub state map", () => stateMapData(env, request, vs.st, url.searchParams.get("layer")), null) : null,
    loadSection("hub justices", () => loadJustices(env, request), null),
  ]);
  // Links within the page (Happening now's switch) stay on this page: the state's own address, or /.
  const here = vs && vs.source === "page" ? statePath(vs.st) : "/";
  // The state's next election (a special election too, in the visitor's own House district).
  const win = vs && dates && dates !== FAILED ? ballotWindow(dates, vs.st, todayIn(vs.st), d && d.st === vs.st ? d.cd : null) : null;
  const hero = !!(win && win.open);
  const joined = url.searchParams.get("waitlist");
  const msg = joined === "joined" ? WAITLIST_MESSAGES.joined : "";
  const error = joined && joined !== "joined" ? WAITLIST_MESSAGES[joined] || "" : "";
  const notFound = url.searchParams.get("lookup") === "notfound";

  // Elections sits near the top until Election Day, then moves down to its usual place.
  const electionsHtml = elections === FAILED ? sectionError("Elections") : electionsSection(elections, d, vs ? vs.st : d ? d.st : null);
  const electionsLate = elections === FAILED || !elections.election || daysUntil(elections.election, start.slice(0, 10)) == null;
  const main = `
${vs ? showingBar(vs) : ""}
${hero ? ballotHero(vs, win) : ""}
<header class="hub-head stack-sm">
  <h1 class="hub-title">Know what your government is doing. <span class="hub-title-soft">Then take part.</span></h1>
  <p class="hub-sub">Votes, bills, and meetings in plain language, measured against the Constitution. Built on evidence, open to every point of view.</p>
</header>
${usMap(index, waiting === FAILED ? { county: {}, state: {} } : waiting, vs)}
${vs ? stateLead(vs, lead, elections === FAILED ? FAILED : elections.election, { ballotLink: !hero }) : ""}
${notFound ? '<p class="banner banner--error" role="alert">We couldn\'t find districts for that. Check the address, or try your ZIP code.</p>' : ""}
${lookupForm(d)}
${d ? `<a class="card briefing-link" href="/briefing/"><span class="stack-xs"><span class="label">Your briefing</span><span class="small">${esc(describe(d))}</span></span><span class="chev" aria-hidden="true">›</span></a>` : ""}
${electionsLate ? "" : electionsHtml}
<aside class="intro-banner" data-intro hidden aria-label="Welcome">
  <p><strong>New here?</strong> ThePillory keeps a public, sourced record of what your officials do: every recorded vote, the bills they vote on mapped to the Constitution, local meeting agendas, and the money around them. Facts and sources, no party labels.</p>
  <p><a class="inline-link" href="/about/how-it-works/">How it works</a> · <a class="inline-link" href="/about/principles/">Principles</a></p>
  <button class="intro-dismiss" type="button" data-intro-dismiss aria-label="Dismiss this introduction">×</button>
</aside>
${nationalSection(federalExec, vs, justices)}
${vs ? (mapData === FAILED ? sectionError(`${vs.name} map`) : stateMapSection(mapData)) : ""}
${electionsLate ? electionsHtml : ""}
${now === FAILED ? sectionError("Happening now") : happeningSection(now, which, { hrefFor: (v) => (v === "federal" ? here : `${here}?now=${v}`), loaded: !!db, state: stateOption })}
${vs && !stateOption ? `<p class="small secondary">${esc(vs.name)}'s legislature: coming soon for ${esc(vs.name)}.</p>` : ""}
${topicsSection(tPlace === FAILED ? null : tPlace)}
${deadlines === FAILED ? sectionError("Take part") : takePart(deadlines, !!db, vs)}
${communities(env, counts === FAILED ? null : counts, msg, error, vs ? vs.st : "")}
${understand()}
${index ? `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>` : ""}`;
  // Personal only once the visitor's districts are known; otherwise the same for everyone.
  const title = vs && vs.source === "page" ? vs.name : "Know what your government is doing";
  return page(title, main, { tab: "home", root: true, personal: !!d, partial: anyFailed(now, deadlines, counts, waiting, federalExec, elections, mapData) });
}

// The hub for a visitor without saved districts is the same for everyone: kept
// at the edge for a few minutes. With districts, it's built for that visitor.
export const HUB_CACHE_SECONDS = 300;
