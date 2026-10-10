// /explore/          the United States map: live communities (navy), states where
//                    people are waiting (light navy), all others; small-state
//                    buttons; a state picker; Live communities and Most requested.
// /explore/<st>/     moved: redirects to the state's page, /states/<name>/#map
//                    (its map, counties and districts: functions/_lib/state-map.js).
// Maps are drawn by /assets/map.js from data/geo/ (Census Bureau boundaries);
// every shape on a map is also a link in a list.
import { page, notFound, esc, fmtDate, linkRow, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { ASSET_VERSION } from "../_lib/generated.js";
import { billHref } from "../_lib/votes.js";
import { CHAMBER_NAME } from "../_lib/data.js";
import { coverageFor, votesLoaded, votesComingSoon, votesLoadedNote } from "../_lib/coverage.js";
import { chamberIds } from "../../workers/sync/src/states.js";
import {
  LIVE, usMapLinks, smallStateButtons, executiveRows, loadIndex, loadPlace, waitlistBy, officialsFor, repRow, breadcrumb, mapFigure,
  layerName, districtLabel, districtHref, placeHref, stOfFips, loadDistrictNames, asset,
} from "../_lib/geo.js";
import { ballotWindow, todayIn } from "../_lib/election-window.js";
import { stateFromSlug, statePath } from "../_lib/state-paths.js";

const mapScript = `<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>`;
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

async function usPage(env, request, url) {
  const index = await loadIndex(env, request);
  if (!index) return notFound("The map data isn't available.", "home", ["Home", "/"]);
  const pick = String(url.searchParams.get("st") || "").toLowerCase();
  if (index.some((s) => s.st.toLowerCase() === pick)) return Response.redirect(`${url.origin}${statePath(pick.toUpperCase())}`, 302);

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

// The map pages are the same for every visitor: kept at the edge for a few minutes.
const MAP_CACHE_SECONDS = 300;

export const onRequestGet = guard((context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return edgeCached(context, MAP_CACHE_SECONDS, () => usPage(env, request, url));
  // A state's map page moved to its page, /states/<name>/ (the "<State> map" section).
  if (parts.length === 1 && stateFromSlug(parts[0])) {
    const layer = url.searchParams.get("layer");
    return Response.redirect(`${url.origin}${statePath(stateFromSlug(parts[0]))}${layer ? `?layer=${encodeURIComponent(layer)}` : ""}#map`, 301);
  }
  return notFound("No page at this address.", "home", ["Explore", "/explore/"]);
}, { tab: "home" });
