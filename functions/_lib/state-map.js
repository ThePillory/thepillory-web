// "State map" on every state's page (functions/_lib/home.js): the state's map
// with layer toggles (Counties, Congressional and its legislative chambers),
// Find a county, every district, all its statewide offices, and its
// legislature's latest final votes. This was the /explore/<st>/ page, which now
// redirects to /states/<name>/#map. Shapes come from Census Bureau files in data/geo/.
import { esc, fmtDate, loadSection, FAILED, sectionError } from "./render.js";
import { billHref } from "./votes.js";
import { coverageFor, votesLoaded, votesComingSoon, votesLoadedNote } from "./coverage.js";
import { fold } from "./summary.js";
import {
  LIVE, loadPlace, waitlistBy, officialsFor, repRow, executiveRows, mapFigure, layerName, districtLabel, districtHref, placeHref, loadDistrictNames,
} from "./geo.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

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

const emptyOfficials = { senators: [], house: [], upper: [], lower: [], executive: [], stateExecutive: [] };

/** Everything the section needs, each part loaded on its own. Null when there's no map data for the state. */
export async function stateMapData(env, request, st, layerParam) {
  const place = await loadPlace(env, request, st.toLowerCase());
  if (!place) return null;
  const db = env.DB;
  const ids = (l) => Object.keys((place.districts || {})[l] || {});
  const names = await loadDistrictNames(env, request, place.st);
  const [waiting, officials, coverage] = await Promise.all([
    db ? loadSection("state map waitlist", () => waitlistBy(db), { county: {} }) : { county: {} },
    db ? loadSection("state map officials", () => officialsFor(db, place.st, { cd: ids("cd"), sldu: ids("sldu"), sldl: ids("sldl") }, names), emptyOfficials) : emptyOfficials,
    db ? loadSection("state map coverage", () => coverageFor(db, place.st), null) : null,
  ]);
  const cov = coverage === FAILED ? null : coverage;
  const activity = db && votesLoaded(place.st, cov) ? await loadSection("state map legislature", () => latestStateBills(db, place.st), null) : null;
  const layer = place.layers.includes(layerParam) ? layerParam : "county";
  return { place, names, layer, waiting, officials, coverage: cov, activity };
}

/** The section, under "State map" (id "map"). */
export function stateMapSection(data) {
  if (!data) return "";
  const { place, names, layer, activity, coverage } = data;
  const waiting = data.waiting === FAILED ? { county: {} } : data.waiting;
  const officials = data.officials === FAILED ? emptyOfficials : data.officials;

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
  const statewide = place.st === "CA"
    ? executiveRows(officials.stateExecutive, { href: "/bodies/ca-executive/", label: "California's other statewide offices" }).join("")
    : officials.stateExecutive.map((o) => repRow(o)).join("");
  const legislature = !votesLoaded(place.st, coverage)
    ? votesComingSoon(place.name, officials.upper.length + officials.lower.length > 0)
    : activity === FAILED ? sectionError("The legislature") : activity && activity.length
      ? `<div class="card">${activity.map((b) => `<a class="list-row link-row" href="${billHref(b.id)}"><div><div class="list-title">${esc(b.bill_number)}: ${esc(b.title)}</div><div class="list-meta">Last final vote ${fmtDate(b.last_vote)}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`).join("")}</div>
         ${votesLoadedNote(place.st, place.name, coverage)}`
      : '<p class="small secondary">No state floor votes loaded yet.</p>';

  return `
<section class="brief-section" id="map" aria-labelledby="h-state-map">
  <div class="section-head"><h2 class="label" id="h-state-map">${esc(place.name)} map</h2></div>
  <p class="small secondary">${place.counties.length} ${place.counties.length === 1 ? "county" : "counties"}. Tap a county or district, or use the lists below.</p>
  ${mapFigure({ id: "state-map", src: `/data/geo/shapes/${place.st.toLowerCase()}-{layer}.json`, links, status, layers, active: layer, label: `Map of ${place.name}`, legend, still: true })}
  ${fold("h-find", `Every county in ${place.name}`, `
  <input class="input" type="search" placeholder="County name" aria-label="Find a county" data-filter-list="county-list" data-filter-none="county-none" hidden />
  <ul class="card plain-list county-list" id="county-list">${countyList}</ul>
  <p class="small secondary" id="county-none" hidden>No county by that name.</p>`, { meta: String(place.counties.length) })}
  ${districtLists ? `<h3 class="label" id="h-districts">Districts</h3>${districtLists}` : ""}
  ${fold("h-statewide", `${place.name}'s statewide offices`, statewide
    ? `<div class="card">${statewide}</div>${place.st === "CA" ? "" : `<p class="hint">As Open States lists them; an office not listed here isn't recorded there yet.</p>`}`
    : `<p class="small secondary">Coming soon for ${esc(place.name)}.</p>`, { meta: statewide ? `${officials.stateExecutive.length}` : "" })}
  ${place.st === "DC" ? "" : fold("h-leg", "The legislature's latest final votes", legislature)}
  <p class="hint">Boundaries: U.S. Census Bureau cartographic boundary files (2024): counties, 119th Congress districts and 2024 state legislative districts.</p>
</section>`;
}
