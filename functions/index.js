// /: Home, the hub, for every visitor (thepillory.co itself). First-time
// visitors get a short intro they can dismiss (remembered in the browser).
// A visitor whose districts are known (the pillory_districts cookie, set by the
// lookup) also gets a link to their briefing at /briefing/. The old ?hub=1 flag
// redirects here; /home/ redirects here.
//
// The hub, top to bottom:
//   headline; a U.S. map (tap a state for its /explore/ page; no zooming or
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
import { chamberIds } from "../workers/sync/src/states.js";
import { icon } from "./_lib/icons.js";
import { page, esc, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "./_lib/render.js";
import { listMeetings, pacificNow, addDays, deadlineParts, meetingHref, when } from "./_lib/meetings.js";
import { districtsFromCookie, describe, STATE_NAME } from "./_lib/districts.js";
import { happeningNow, happeningSection, lookupForm, waitlistCounts } from "./_lib/hub.js";
import { topicGrid, placeTopicsHref } from "./_lib/topics.js";
import { CURRENT, loadElection, ballotFor, ballotHref, electionHref, whenLine, daysUntil, contestRow, courtRow, statewideRow } from "./_lib/elections.js";
import { LIVE, loadIndex, loadPlace, waitlistBy, usMapLinks, smallStateButtons, mapFigure } from "./_lib/geo.js";
import { ASSET_VERSION } from "./_lib/generated.js";
import { executiveOfficials, executiveRows } from "./_lib/executive.js";
import { linkRow } from "./_lib/render.js";
import { turnstileReady, turnstileWidget } from "./_lib/turnstile.js";


const WAITLIST_MESSAGES = {
  joined: "Thank you. We'll email you only when ThePillory launches in your county.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "That's enough sign-ups from this connection for today. Please try again tomorrow.",
  invalid: "Choose a state and county, and enter an email address.",
  closed: "The list isn't open yet.",
};

function takePart(deadlines, loaded) {
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

function stateOptions(selected) {
  return Object.entries(STATE_NAME)
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}"${code === selected ? " selected" : ""}>${esc(name)}</option>`)
    .join("");
}

function communities(env, counts, msg, error) {
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
        <select class="input" name="state" required><option value="">Choose a state</option>${stateOptions("")}</select>
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
function usMap(index, waiting) {
  if (!index) return '<p class="explore-link"><a class="btn btn--block" href="/explore/">Explore the map</a></p>';
  const { links, status } = usMapLinks(index, waiting);
  const live = Object.keys(LIVE).length;
  const counties = Object.keys(waiting.county).filter((f) => !LIVE[f]).length;
  return `
<section class="hub-map stack-xs" aria-labelledby="h-map">
  <h2 class="visually-hidden" id="h-map">Map of the United States</h2>
  ${mapFigure({ id: "us-map", src: "/data/geo/us.json", links, status, label: "Map of the United States: tap a state to explore it", still: true })}
  ${smallStateButtons(index)}
  <div class="hub-map-foot">
    <p class="map-counts small"><span><span class="swatch is-live" aria-hidden="true"></span>${plural(live, "live community", "live communities")}</span><span class="dot"> · </span><span><span class="swatch is-waiting" aria-hidden="true"></span>${plural(counties, "county", "counties")} waiting</span></p>
    <a class="inline-link" href="/explore/">Explore the full map</a>
  </div>
</section>`;
}

// Who represents you: the federal executive for everyone; the visitor's own
// state's statewide offices (California's for visitors whose state isn't known yet).
function whoRepresents(federal, stateExec, d) {
  if (!federal.length && !stateExec.length) return "";
  const st = d ? d.st : "CA";
  const name = STATE_NAME[st] || "Your state";
  const governor = stateExec.filter((o) => o.rank === 1);
  const all = st === "CA" ? linkRow("/bodies/ca-executive/", "California's statewide offices", `${stateExec.length} elected statewide`) : linkRow(`/explore/${st.toLowerCase()}/#h-statewide`, `${name}'s statewide offices`, `${stateExec.length} listed`);
  const state = stateExec.length
    ? `<div class="card stack-xs"><p class="label">${esc(name)}, statewide</p>${governor.map((o) => linkRow(`/reps/${o.slug}/`, o.name, o.office)).join("")}${all}</div>`
    : `<p class="small secondary">${esc(name)}'s governor and statewide offices appear after the data sync loads them (weekly, from Open States).</p>`;
  return `
<section class="brief-section" id="who" aria-labelledby="h-who">
  <div class="section-head"><h2 class="label" id="h-who">Who represents you</h2><a class="section-link" href="/reps/">All reps</a></div>
  ${federal.length ? `<div class="card stack-xs"><p class="label">Everyone in the United States</p>${executiveRows(federal)}</div>` : ""}
  ${state}
  ${d ? linkRow("/briefing/", "Your members of Congress and state legislators", describe(d)) : '<p class="small"><a class="inline-link" href="#find">Find your representatives</a> to add your members of Congress and state legislators.</p>'}
</section>`;
}

// Elections: the next election, and "Your ballot" once the visitor's districts are known.
async function electionsData(env, request, d) {
  const election = await loadElection(env, request, CURRENT);
  if (!election || !d || d.st !== election.election.state) return { election, ballot: null };
  const place = d.co ? await loadPlace(env, request, d.st.toLowerCase()) : null;
  const county = place && place.counties.find((c) => c.fips === d.co);
  return { election, ballot: ballotFor(election, d, county ? county.name : null), county };
}

function electionsSection({ election, ballot, county }, d) {
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
    <a class="btn btn--primary btn--block" href="${ballotHref(id)}">Open your ballot</a>
  </div>`;
  } else if (d) {
    yours = `<p class="small secondary">ThePillory has California's ballot so far. For elections in ${esc(STATE_NAME[d.st] || "your state")}, find your state's election office at <a class="inline-link" href="https://www.usa.gov/state-election-office" target="_blank" rel="noopener">USA.gov ↗</a>.</p>`;
  } else {
    yours = `<p class="small"><a class="inline-link" href="${ballotHref(id)}">Find your ballot</a> by address or ZIP code.</p>`;
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
    <a class="list-row link-row" href="/elections/#how-to-vote"><div><div class="list-title">How to vote</div><div class="list-meta">Registration, deadlines and where to vote, on the official sites</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
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

async function hub(env, request, url, d) {
  const which = url.searchParams.get("now") === "state" ? "state" : "federal";
  const db = env.DB;
  // Each section loads on its own: one that can't load shows a short note, and
  // the rest of the hub still shows.
  const start = pacificNow();
  const [index, now, deadlines, counts, waiting, federalExec, caExec, elections, tPlace] = await Promise.all([
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
    loadSection("hub state executive", db ? () => executiveOfficials(db, chamberIds(d ? d.st : "CA").executive) : async () => [], []),
    loadSection("hub elections", () => electionsData(env, request, d), { election: null, ballot: null }),
    loadSection("hub topic place", () => topicPlace(env, request, d), null),
  ]);
  const joined = url.searchParams.get("waitlist");
  const msg = joined === "joined" ? WAITLIST_MESSAGES.joined : "";
  const error = joined && joined !== "joined" ? WAITLIST_MESSAGES[joined] || "" : "";
  const notFound = url.searchParams.get("lookup") === "notfound";

  // Elections sits near the top until Election Day, then moves down to its usual place.
  const electionsHtml = elections === FAILED ? sectionError("Elections") : electionsSection(elections, d);
  const electionsLate = elections === FAILED || !elections.election || daysUntil(elections.election, start.slice(0, 10)) == null;
  const main = `
<header class="hub-head stack-sm">
  <h1 class="hub-title">Know what your government is doing. <span class="hub-title-soft">Then take part.</span></h1>
  <p class="hub-sub">Votes, bills, and meetings in plain language, measured against the Constitution. Built on evidence, open to every point of view.</p>
</header>
${usMap(index, waiting === FAILED ? { county: {}, state: {} } : waiting)}
${notFound ? '<p class="banner banner--error" role="alert">We couldn\'t find districts for that. Check the address, or try your ZIP code.</p>' : ""}
${lookupForm(d)}
${d ? `<a class="card briefing-link" href="/briefing/"><span class="stack-xs"><span class="label">Your briefing</span><span class="small">${esc(describe(d))}</span></span><span class="chev" aria-hidden="true">›</span></a>` : ""}
${electionsLate ? "" : electionsHtml}
<aside class="intro-banner" data-intro hidden aria-label="Welcome">
  <p><strong>New here?</strong> ThePillory keeps a public, sourced record of what your officials do: every recorded vote, the bills they vote on mapped to the Constitution, local meeting agendas, and the money around them. Facts and sources, no party labels.</p>
  <p><a class="inline-link" href="/about/how-it-works/">How it works</a> · <a class="inline-link" href="/about/principles/">Principles</a></p>
  <button class="intro-dismiss" type="button" data-intro-dismiss aria-label="Dismiss this introduction">×</button>
</aside>
${federalExec === FAILED || caExec === FAILED ? sectionError("Who represents you") : whoRepresents(federalExec, caExec, d)}
${electionsLate ? electionsHtml : ""}
${now === FAILED ? sectionError("Happening now") : happeningSection(now, which, { hrefFor: (v) => (v === "federal" ? "/" : "/?now=state"), loaded: !!db })}
${topicsSection(tPlace === FAILED ? null : tPlace)}
${deadlines === FAILED ? sectionError("Take part") : takePart(deadlines, !!db)}
${communities(env, counts === FAILED ? null : counts, msg, error)}
${understand()}
${index ? `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>` : ""}`;
  // Personal only once the visitor's districts are known; otherwise the same for everyone.
  return page("Know what your government is doing", main, { tab: "home", root: true, personal: !!d, partial: anyFailed(now, deadlines, counts, waiting, federalExec, caExec, elections) });
}

// The hub for a visitor without saved districts is the same for everyone: kept
// at the edge for a few minutes. With districts, it's built for that visitor.
const HUB_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const { request, env } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  // The hub used to need ?hub=1 for visitors with saved districts; it's at / now.
  if (url.searchParams.has("hub")) {
    url.searchParams.delete("hub");
    return Response.redirect(`${url.origin}/${url.search}${url.hash}`, 301);
  }
  const d = districtsFromCookie(request);
  if (d) return hub(env, request, url, d);
  return edgeCached(context, HUB_CACHE_SECONDS, () => hub(env, request, url, null));
}, { tab: "home" });
