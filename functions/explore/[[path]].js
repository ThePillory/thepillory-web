// /explore/          the United States map: live communities (navy), states where
//                    people are waiting (light navy), all others; small-state
//                    buttons; a state picker; Live communities and Most requested.
// /explore/<st>/     a state map with layer toggles (Counties, Congressional and
//                    the state's legislative chambers); Find a county; every
//                    district as a list; Statewide officials; the legislature.
// Maps are drawn by /assets/map.js from data/geo/ (Census Bureau boundaries);
// every shape on a map is also a link in a list.
import { page, notFound, esc, fmtDate } from "../_lib/render.js";
import { ASSET_VERSION } from "../_lib/generated.js";
import { billHref } from "../_lib/votes.js";
import {
  LIVE, usMapLinks, smallStateButtons, loadIndex, loadPlace, waitlistBy, officialsFor, repRow, breadcrumb, mapFigure,
  layerName, districtLabel, districtHref, placeHref, stOfFips,
} from "../_lib/geo.js";

const mapScript = `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>`;
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

async function usPage(env, request, url) {
  const index = await loadIndex(env, request);
  if (!index) return notFound("The map data isn't available.", "home", ["Home", "/"]);
  const pick = String(url.searchParams.get("st") || "").toLowerCase();
  if (index.some((s) => s.st.toLowerCase() === pick)) return Response.redirect(`${url.origin}/explore/${pick}/`, 302);

  let waiting = { county: {}, state: {} };
  try {
    waiting = await waitlistBy(env.DB);
  } catch (err) {
    if (!missing(err)) throw err;
  }
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
  return page("Explore the map", main, { tab: "home", back: ["Home", "/"] });
}

async function statePage(env, request, url, st) {
  const place = await loadPlace(env, request, st);
  if (!place) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  const layer = place.layers.includes(url.searchParams.get("layer")) ? url.searchParams.get("layer") : "county";
  const db = env.DB;
  let waiting = { county: {} };
  let officials = { senators: [], house: [], upper: [], lower: [] };
  let activity = null;
  if (db) {
    try {
      waiting = await waitlistBy(db);
      const ids = (l) => Object.keys((place.districts || {})[l] || {});
      officials = await officialsFor(db, place.st, { cd: ids("cd"), sldu: ids("sldu"), sldl: ids("sldl") });
      if (place.st === "CA") {
        activity = (
          await db
            .prepare(
              `SELECT b.id, b.bill_number, b.title, MAX(v.vote_date) AS last_vote FROM bills b JOIN votes v ON v.bill_id = b.id
               WHERE b.level = 'state' AND v.vote_type = 'final_passage' GROUP BY b.id ORDER BY last_vote DESC LIMIT 5`
            )
            .all()
        ).results;
      }
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }

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
    links[l] = Object.fromEntries(Object.keys((place.districts || {})[l] || {}).map((id) => [id, [districtHref(l, id, place), districtLabel(l, id, place)]]));
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
    <ul class="plain-list district-grid">${ids.map((id) => `<li><a class="chip chip--tap" href="${districtHref(l, id, place)}">${esc(id === "0" ? "At large" : /^\d+$/.test(id) ? id : id.toUpperCase())}</a></li>`).join("")}</ul>
  </details>`;
    })
    .join("");

  const legislators = place.st === "CA"
    ? officials.upper.length + officials.lower.length
      ? `<p class="small">${officials.upper.length} state ${officials.upper.length === 1 ? "senator" : "senators"} and ${officials.lower.length} Assembly ${officials.lower.length === 1 ? "member" : "members"}, each linked from their district.</p>`
      : '<p class="small secondary">California\'s legislators appear after the data sync loads them.</p>'
    : `<p class="small secondary">${esc(place.name)}'s state legislators aren't on ThePillory yet. State coverage opens as communities launch.</p>`;
  const legislature = place.st === "CA"
    ? activity && activity.length
      ? `<p class="small">Latest recorded floor vote on a bill: <strong>${fmtDate(activity[0].last_vote)}</strong>. Whether the Legislature is in session or in recess isn't tracked yet; these are its most recent final votes.</p>
         <div class="card">${activity.map((b) => `<a class="list-row link-row" href="${billHref(b.id)}"><div><div class="list-title">${esc(b.bill_number)}: ${esc(b.title)}</div><div class="list-meta">Last final vote ${fmtDate(b.last_vote)}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`).join("")}</div>`
      : '<p class="small secondary">No state floor votes loaded yet.</p>'
    : `<p class="small secondary">${esc(place.name)}'s legislature isn't tracked yet. ThePillory covers California's legislature now.</p>`;

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
  <h2 class="label" id="h-statewide">Statewide</h2>
  <div class="card">${officials.senators.map((o) => repRow(o)).join("") || '<p class="small secondary">U.S. Senators appear after the data sync runs.</p>'}</div>
  <p class="small">${officials.house.length ? `${officials.house.length} House ${officials.house.length === 1 ? "member" : "members"}, each linked from their district. <a class="inline-link" href="/reps/?state=${place.st}#browse">All of ${esc(place.name)}'s members of Congress</a>` : "House members appear after the data sync runs."}</p>
  ${place.st === "DC" ? "" : legislators}
  <p class="small secondary">Statewide offices (the governor and others) aren't on ThePillory yet.</p>
</section>
${place.st === "DC" ? "" : `<section class="stack-sm" aria-labelledby="h-leg"><h2 class="label" id="h-leg">The legislature</h2>${legislature}</section>`}
<p class="hint">Boundaries: U.S. Census Bureau cartographic boundary files (2024): counties, 119th Congress districts and 2024 state legislative districts.</p>
${mapScript}`;
  return page(place.name, main, { tab: "home", back: ["Explore", "/explore/"] });
}

export async function onRequestGet({ request, env, params }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return usPage(env, request, url);
  if (parts.length === 1) {
    const st = parts[0].toLowerCase();
    if (st !== parts[0]) return Response.redirect(`${url.origin}/explore/${st}/${url.search}`, 301);
    return statePage(env, request, url, st);
  }
  return notFound("No page at this address.", "home", ["Explore", "/explore/"]);
}
