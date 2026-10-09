// /explore/          the United States map: live communities (navy), states where
//                    people are waiting (light navy), all others; small-state
//                    buttons; a state picker; Live communities and Most requested.
// /explore/<st>/     a state map with layer toggles (Counties, Congressional and
//                    the state's legislative chambers); Find a county; every
//                    district as a list; Statewide officials; the legislature.
// Maps are drawn by /assets/map.js from data/geo/ (Census Bureau boundaries);
// every shape on a map is also a link in a list.
import { page, notFound, esc, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { ASSET_VERSION } from "../_lib/generated.js";
import { billHref } from "../_lib/votes.js";
import { CHAMBER_NAME } from "../_lib/data.js";
import { coverageFor, votesLoaded, votesComingSoon, votesLoadedNote } from "../_lib/coverage.js";
import { chamberIds } from "../../workers/sync/src/states.js";
import {
  LIVE, usMapLinks, smallStateButtons, executiveRows, loadIndex, loadPlace, waitlistBy, officialsFor, repRow, breadcrumb, mapFigure,
  layerName, districtLabel, districtHref, placeHref, stOfFips, loadDistrictNames,
} from "../_lib/geo.js";

const mapScript = `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>`;
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

async function usPage(env, request, url) {
  const index = await loadIndex(env, request);
  if (!index) return notFound("The map data isn't available.", "home", ["Home", "/"]);
  const pick = String(url.searchParams.get("st") || "").toLowerCase();
  if (index.some((s) => s.st.toLowerCase() === pick)) return Response.redirect(`${url.origin}/explore/${pick}/`, 302);

  const waitingLoaded = env.DB ? await loadSection("map waitlist", () => waitlistBy(env.DB), { county: {}, state: {} }) : { county: {}, state: {} };
  const waiting = waitingLoaded === FAILED ? { county: {}, state: {} } : waitingLoaded;
  const { links, status } = usMapLinks(index, waiting);
  const legend = `
  <ul class="map-legend plain-list small">
    <li><span class="swatch is-live" aria-hidden="true"></span>Live community</li>
    <li><span class="swatch is-waiting" aria-hidden="true"></span>People waiting</li>
    <li><span class="swatch" aria-hidden="true"></span>Federal data only</li>
  </ul>`;

  // Live communities and the most-requested counties (waitlist totals only).
  const liveRows = [];
  for (const fips of Object.keys(LIVE)) {
    const place = await loadPlace(env, request, stOfFips(fips).toLowerCase());
    const c = place && place.counties.find((x) => x.fips === fips);
    if (c) liveRows.push(`<a class="list-row link-row" href="${placeHref(place.st, c.slug)}"><div><div class="list-title">${esc(c.name)}, ${esc(place.name)} <span class="live-tag">Live</span></div><div class="list-meta">Meetings, agendas, comment deadlines and the votes of every official who represents it</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`);
  }
  const top = Object.entries(waiting.county).filter(([f]) => !LIVE[f]).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const topRows = [];
  for (const [fips, n] of top) {
    const st = stOfFips(fips);
    const place = st && (await loadPlace(env, request, st.toLowerCase()));
    const c = place && place.counties.find((x) => x.fips === fips);
    if (c) topRows.push(`<a class="list-row link-row" href="${placeHref(st, c.slug)}"><div><div class="list-title">${esc(c.name)}, ${esc(place.name)}</div><div class="list-meta">${n} ${n === 1 ? "person" : "people"} waiting</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`);
  }

  const main = `
<header class="page-head stack-xs">
  <h1>Explore the map</h1>
  <p class="secondary">Pick a state to see its counties and districts, who represents them, and their votes.</p>
</header>
${mapFigure({ id: "map", src: "/data/geo/us.json", links, status, label: "Map of the United States: tap a state", legend })}
<section class="stack-sm" aria-labelledby="h-small">
  <h2 class="label" id="h-small">Smaller states</h2>
  ${smallStateButtons(index)}
</section>
<section class="card stack-sm" aria-labelledby="h-pick">
  <h2 class="label" id="h-pick">Choose a state</h2>
  <form class="field-row" method="get" action="/explore/">
    <label class="visually-hidden" for="st">State</label>
    <select class="input" id="st" name="st" required>
      <option value="">Choose a state</option>
      ${index.map((s) => `<option value="${s.st.toLowerCase()}">${esc(s.name)}</option>`).join("")}
    </select>
    <button class="btn btn--primary" type="submit">Go</button>
  </form>
</section>
<section class="stack-sm" aria-labelledby="h-live">
  <h2 class="label" id="h-live">Live communities</h2>
  <div class="card">${liveRows.join("")}</div>
</section>
<section class="stack-sm" aria-labelledby="h-requested">
  <h2 class="label" id="h-requested">Most requested next</h2>
  ${topRows.length ? `<div class="card">${topRows.join("")}</div>` : '<p class="small secondary">No one is on the list yet.</p>'}
  <p class="small"><a class="inline-link" href="/#communities">Bring ThePillory to your county</a></p>
</section>
<p class="hint">Boundaries: U.S. Census Bureau cartographic boundary files (2024), simplified for the web. Every state's federal representatives, and their votes, are on ThePillory now; local coverage opens one county at a time.</p>
${mapScript}`;
  return page("Explore the map", main, { tab: "home", back: ["Home", "/"], partial: waitingLoaded === FAILED });
}

// A state's latest bills with a final vote: from bill_list (built during the
// sync); before the first build (or while it's empty), from the votes table.
async function latestStateBills(db, st) {
  try {
    const { results } = await db
      .prepare("SELECT bill_id AS id, bill_number, title, last_final AS last_vote FROM bill_list WHERE level = 'state' AND st = ? AND last_final IS NOT NULL ORDER BY last_final DESC, bill_id DESC LIMIT 5")
      .bind(st)
      .all();
    if (results.length) return results;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return (
    await db
      .prepare(
        `SELECT b.id, b.bill_number, b.title, MAX(v.vote_date) AS last_vote FROM bills b JOIN votes v ON v.bill_id = b.id
         WHERE b.level = 'state' AND substr(v.chamber, 1, 3) = lower(?) || '-' AND v.vote_type = 'final_passage' GROUP BY b.id ORDER BY last_vote DESC LIMIT 5`
      )
      .bind(st)
      .all()
  ).results;
}

async function statePage(env, request, url, st) {
  const place = await loadPlace(env, request, st);
  if (!place) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  const layer = place.layers.includes(url.searchParams.get("layer")) ? url.searchParams.get("layer") : "county";
  const db = env.DB;
  const emptyOfficials = { senators: [], house: [], upper: [], lower: [], executive: [], stateExecutive: [] };
  const ids = (l) => Object.keys((place.districts || {})[l] || {});
  const names = await loadDistrictNames(env, request, place.st);
  // Each section loads on its own: one that can't load shows a short note.
  const [waitingLoaded, officialsLoaded, coverageLoaded] = await Promise.all([
    db ? loadSection("state waitlist", () => waitlistBy(db), { county: {} }) : { county: {} },
    db ? loadSection("state officials", () => officialsFor(db, place.st, { cd: ids("cd"), sldu: ids("sldu"), sldl: ids("sldl") }, names), emptyOfficials) : emptyOfficials,
    db ? loadSection("state coverage", () => coverageFor(db, place.st), null) : null,
  ]);
  const coverage = coverageLoaded === FAILED ? null : coverageLoaded;
  const activity = db && votesLoaded(place.st, coverage) ? await loadSection("state legislature", () => latestStateBills(db, place.st), null) : null;
  const waiting = waitingLoaded === FAILED ? { county: {} } : waitingLoaded;
  const officials = officialsLoaded === FAILED ? emptyOfficials : officialsLoaded;

  // Where each shape on the map goes.
  const links = { county: {} };
  const status = {};
  for (const c of place.counties) {
    links.county[c.fips] = [placeHref(place.st, c.slug), `${c.name}${LIVE[c.fips] ? " (live community)" : ""}`];
    if (LIVE[c.fips]) status[c.fips] = "live";
    else if (waiting.county[c.fips]) status[c.fips] = "waiting";
  }
  for (const l of ["cd", "sldu", "sldl"]) {
    if (!place.layers.includes(l)) continue;
    links[l] = Object.fromEntries(Object.keys((place.districts || {})[l] || {}).map((id) => [id, [districtHref(l, id, place), districtLabel(l, id, place, names)]]));
  }
  const layers = place.layers.map((l) => [l, layerName(l, place.chambers)]);
  const legend = `
  <ul class="map-legend plain-list small">
    <li><span class="swatch is-live" aria-hidden="true"></span>Live community</li>
    <li><span class="swatch is-waiting" aria-hidden="true"></span>People waiting</li>
  </ul>`;

  const countyList = place.counties
    .map((c) => `<li><a class="list-row link-row" href="${placeHref(place.st, c.slug)}"><span class="list-title">${esc(c.name)}${LIVE[c.fips] ? ' <span class="live-tag">Live</span>' : ""}</span><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a></li>`)
    .join("");
  const districtLists = ["cd", "sldu", "sldl"]
    .filter((l) => place.layers.includes(l) && place.districts[l])
    .map((l) => {
      const ids = Object.keys(place.districts[l]);
      return `<details class="list-card-group">
    <summary class="list-card-row"><span>${esc(layerName(l, place.chambers))} districts</span><span class="secondary">${ids.length}</span></summary>
    <ul class="plain-list district-grid">${ids.map((id) => {
      const name = names && names[l] && names[l][id];
      return `<li><a class="chip chip--tap" href="${districtHref(l, id, place)}">${esc(name || (id === "0" ? "At large" : /^\d+$/.test(id) ? id : id.toUpperCase()))}</a></li>`;
    }).join("")}</ul>
  </details>`;
    })
    .join("");

  const cids = chamberIds(place.st);
  const members = (n, chamber) => `${n} ${n === 1 ? "member" : "members"} of the ${CHAMBER_NAME[chamber] || "legislature"}`;
  const legislators = officials.upper.length + officials.lower.length
    ? `<p class="small">${[officials.upper.length ? members(officials.upper.length, cids.upper) : null, officials.lower.length && cids.lower ? members(officials.lower.length, cids.lower) : null].filter(Boolean).join(" and ")}, each linked from their district.</p>`
    : `<p class="small secondary">${esc(place.name)}'s state legislators appear after the data sync loads them (weekly, from Open States).</p>`;
  const legislature = !votesLoaded(place.st, coverage)
    ? votesComingSoon(place.name)
    : activity === FAILED ? sectionError("") : activity && activity.length
      ? `<p class="small">Latest recorded floor vote on a bill: <strong>${fmtDate(activity[0].last_vote)}</strong>. Whether the legislature is in session or in recess isn't tracked yet; these are its most recent final votes.</p>
         <div class="card">${activity.map((b) => `<a class="list-row link-row" href="${billHref(b.id)}"><div><div class="list-title">${esc(b.bill_number)}: ${esc(b.title)}</div><div class="list-meta">Last final vote ${fmtDate(b.last_vote)}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`).join("")}</div>
         ${votesLoadedNote(place.st, place.name, coverage)}`
      : '<p class="small secondary">No state floor votes loaded yet.</p>';
  const statewide = place.st === "CA"
    ? executiveRows(officials.stateExecutive, { href: "/bodies/ca-executive/", label: "California's other statewide offices" }).join("")
    : officials.stateExecutive.map((o) => repRow(o)).join("");

  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, null]])}
<header class="page-head stack-xs">
  <h1>${esc(place.name)}</h1>
  <p class="secondary">${place.counties.length} ${place.counties.length === 1 ? "county" : "counties"}. Tap a county or district, or use the lists below.</p>
</header>
${mapFigure({ id: "map", src: `/data/geo/shapes/${place.st.toLowerCase()}-{layer}.json`, links, status, layers, active: layer, label: `Map of ${place.name}`, legend })}
<section class="stack-sm" aria-labelledby="h-find">
  <h2 class="label" id="h-find">Find a county</h2>
  <input class="input" type="search" placeholder="County name" aria-label="Find a county" data-filter-list="county-list" data-filter-none="county-none" hidden />
  <ul class="card plain-list county-list" id="county-list">${countyList}</ul>
  <p class="small secondary" id="county-none" hidden>No county by that name.</p>
</section>
${districtLists ? `<section class="stack-sm" aria-labelledby="h-districts"><h2 class="label" id="h-districts">Districts</h2>${districtLists}</section>` : ""}
<section class="stack-sm" aria-labelledby="h-statewide">
  <h2 class="label" id="h-statewide">Who represents ${esc(place.name)}</h2>
  ${officials.executive.length ? `<div class="card">${executiveRows(officials.executive, { href: "/bodies/us-executive/", label: "The Cabinet" }).join("")}</div>` : ""}
  ${officials.stateExecutive.length ? `<div class="card">${statewide}</div>` : ""}
  ${officialsLoaded === FAILED ? sectionError("") : ""}
  <div class="card">${officials.senators.map((o) => repRow(o)).join("") || '<p class="small secondary">U.S. Senators appear after the data sync runs.</p>'}</div>
  <p class="small">${officials.house.length ? `${officials.house.length} House ${officials.house.length === 1 ? "member" : "members"}, each linked from their district. <a class="inline-link" href="/reps/?state=${place.st}#browse">All of ${esc(place.name)}'s members of Congress</a>` : "House members appear after the data sync runs."}</p>
  ${place.st === "DC" ? "" : legislators}
  ${place.st === "CA" ? "" : officials.stateExecutive.length
    ? `<p class="hint">${esc(place.name)}'s statewide officers as Open States lists them; an office not listed here isn't recorded there yet.</p>`
    : `<p class="small secondary">${esc(place.name)}'s governor and statewide offices appear after the data sync loads them (weekly, from Open States).</p>`}
</section>
${place.st === "DC" ? "" : `<section class="stack-sm" aria-labelledby="h-leg"><h2 class="label" id="h-leg">The legislature</h2>${legislature}</section>`}
<p class="hint">Boundaries: U.S. Census Bureau cartographic boundary files (2024): counties, 119th Congress districts and 2024 state legislative districts.</p>
${mapScript}`;
  return page(place.name, main, { tab: "home", back: ["Explore", "/explore/"], partial: anyFailed(waitingLoaded, officialsLoaded, coverageLoaded, activity) });
}

// The map pages are the same for every visitor: kept at the edge for a few minutes.
const MAP_CACHE_SECONDS = 300;

export const onRequestGet = guard((context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return edgeCached(context, MAP_CACHE_SECONDS, () => usPage(env, request, url));
  if (parts.length === 1) {
    const st = parts[0].toLowerCase();
    if (st !== parts[0]) return Response.redirect(`${url.origin}/explore/${st}/${url.search}`, 301);
    return edgeCached(context, MAP_CACHE_SECONDS, () => statePage(env, request, url, st));
  }
  return notFound("No page at this address.", "home", ["Explore", "/explore/"]);
}, { tab: "home" });
