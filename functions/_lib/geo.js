// Map data for /explore/, /place/ and /district/: what data/geo/ holds (built
// from Census Bureau files by tools/build_geo.mjs), the officials for a place,
// and the shared bits of those pages. Every map has a list beside it, so
// everything on a map can be reached without it.
import { esc } from "./render.js";

// Live communities, by county FIPS. More open as communities launch.
export const LIVE = { "06009": { briefing: "/calaveras/" } };
export const liveStates = () => [...new Set(Object.keys(LIVE).map((f) => FIPS_ST[f.slice(0, 2)]))];
const FIPS_ST = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO", "09": "CT", "10": "DE", "11": "DC", "12": "FL", "13": "GA", "15": "HI", "16": "ID", "17": "IL",
  "18": "IN", "19": "IA", "20": "KS", "21": "KY", "22": "LA", "23": "ME", "24": "MD", "25": "MA", "26": "MI", "27": "MN", "28": "MS", "29": "MO", "30": "MT", "31": "NE",
  "32": "NV", "33": "NH", "34": "NJ", "35": "NM", "36": "NY", "37": "NC", "38": "ND", "39": "OH", "40": "OK", "41": "OR", "42": "PA", "44": "RI", "45": "SC", "46": "SD",
  "47": "TN", "48": "TX", "49": "UT", "50": "VT", "51": "VA", "53": "WA", "54": "WV", "55": "WI", "56": "WY",
};
export const stOfFips = (fips) => FIPS_ST[String(fips).slice(0, 2)];

// Small states get buttons beside the U.S. map, easier to tap than their shapes.
export const SMALL_STATES = ["RI", "DE", "CT", "NJ", "MD", "DC", "MA", "VT", "NH"];

// District types in URLs: /district/<type>/<st>-<id>/.
export const LAYER_OF_TYPE = { congressional: "cd", "state-senate": "sldu", legislature: "sldu", assembly: "sldl", "general-assembly": "sldl", "house-of-delegates": "sldl", "state-house": "sldl" };
export function typeOf(layer, chambers) {
  if (layer === "cd") return "congressional";
  return String(chambers[layer] || "").toLowerCase().replace(/[^a-z]+/g, "-");
}
export function layerName(layer, chambers) {
  return layer === "cd" ? "Congressional" : layer === "county" ? "Counties" : chambers[layer];
}
export function districtLabel(layer, id, place) {
  if (layer === "cd") return id === "0" ? "At-large congressional district" : `Congressional District ${id}`;
  const n = /^\d+$/.test(id) ? id : id.toUpperCase();
  return place.st === "NE" ? `Legislative District ${n}` : `${place.chambers[layer]} District ${n}`;
}
export const districtHref = (layer, id, place) => `/district/${typeOf(layer, place.chambers)}/${place.st.toLowerCase()}-${id}/`;
export const placeHref = (st, slug) => `/place/${st.toLowerCase()}/${slug}/`;

const cache = new Map();
async function asset(env, request, path) {
  if (cache.has(path)) return cache.get(path);
  if (!env.ASSETS) return null;
  const res = await env.ASSETS.fetch(new URL(path, request.url));
  if (!res.ok) return null;
  const data = await res.json();
  cache.set(path, data);
  return data;
}
export const loadIndex = (env, request) => asset(env, request, "/data/geo/index.json");
export const loadPlace = (env, request, st) => (/^[a-z]{2}$/.test(st) ? asset(env, request, `/data/geo/places/${st}.json`) : null);

/** Waitlist signups by county and by state (totals only). */
export async function waitlistBy(db) {
  const out = { county: {}, state: {} };
  if (!db) return out;
  try {
    const { results } = await db.prepare("SELECT county_fips, COUNT(*) AS n FROM waitlist GROUP BY county_fips").all();
    for (const r of results) {
      out.county[r.county_fips] = r.n;
      const st = stOfFips(r.county_fips);
      if (st) out.state[st] = (out.state[st] || 0) + r.n;
    }
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) throw err;
  }
  return out;
}

/**
 * The U.S. map's links and colors: each state goes to its /explore/ page;
 * live community states are "live", states with waitlist signups "waiting".
 */
export function usMapLinks(index, waiting) {
  const live = liveStates();
  const status = {};
  for (const s of index) status[s.st] = live.includes(s.st) ? "live" : waiting.state[s.st] ? "waiting" : "";
  const note = (st) => (status[st] === "live" ? " (live community)" : status[st] === "waiting" ? ` (${waiting.state[st]} waiting)` : "");
  const links = Object.fromEntries(index.map((s) => [s.st, [`/explore/${s.st.toLowerCase()}/`, `${s.name}${note(s.st)}`]]));
  return { links, status };
}

/** Buttons for the small states, easier to tap than their shapes. */
export function smallStateButtons(index) {
  return `<div class="chips small-states">${index
    .filter((s) => SMALL_STATES.includes(s.st))
    .map((s) => `<a class="chip chip--tap" href="/explore/${s.st.toLowerCase()}/">${esc(s.st)}<span class="visually-hidden"> ${esc(s.name)}</span></a>`)
    .join("")}</div>`;
}

/**
 * Officials for districts in a state: {senators, house, upper, lower, county}.
 * `d` is {cd: [ids], sldu: [ids], sldl: [ids], county: fips?}. State
 * legislators are loaded for California only so far.
 */
export async function officialsFor(db, st, d) {
  const out = { senators: [], house: [], upper: [], lower: [], county: [], executive: [], stateExecutive: [] };
  if (!db) return out;
  // The executive branch: the President, Vice President and Cabinet for every
  // place; California's statewide offices for California.
  const exec = async (chamber) => {
    try {
      return (await db.prepare("SELECT * FROM officials WHERE chamber = ? AND active = 1 ORDER BY rank, name").bind(chamber).all()).results;
    } catch (err) {
      if (/no such column|no such table/i.test(String(err && err.message))) return [];
      throw err;
    }
  };
  out.executive = await exec("us-executive");
  if (st === "CA") out.stateExecutive = await exec("ca-executive");
  const q = async (sql, binds) => (await db.prepare(`SELECT o.* FROM officials o WHERE o.active = 1 AND ${sql}`).bind(...binds).all()).results;
  const ph = (a) => a.map(() => "?").join(",");
  const sortD = (a, b) => String(a.district_code || "").localeCompare(String(b.district_code || ""), undefined, { numeric: true }) || a.name.localeCompare(b.name);
  if (d.senators !== false) out.senators = (await q("o.chamber = 'us-senate' AND o.state = ?", [st])).sort((a, b) => a.name.localeCompare(b.name));
  if (d.cd && d.cd.length) out.house = (await q(`o.chamber = 'us-house' AND o.state = ? AND o.district_code IN (${ph(d.cd)})`, [st, ...d.cd])).sort(sortD);
  if (st === "CA") {
    if (d.sldu && d.sldu.length) out.upper = (await q(`o.chamber = 'ca-senate' AND o.district_code IN (${ph(d.sldu)})`, d.sldu)).sort(sortD);
    if (d.sldl && d.sldl.length) out.lower = (await q(`o.chamber = 'ca-assembly' AND o.district_code IN (${ph(d.sldl)})`, d.sldl)).sort(sortD);
  }
  if (d.county && LIVE[d.county]) out.county = (await q("o.chamber = 'county-board'", [])).sort(sortD);
  return out;
}

export const allIds = (o) => [...o.county, ...o.upper, ...o.lower, ...o.house, ...o.senators].map((x) => x.id);

/** The executive rows for "Who represents": the President and Vice President (or the Governor), then a link to the rest. */
export function executiveRows(list, { href, label }) {
  const lead = list.filter((o) => o.rank && o.rank <= (o.chamber === "ca-executive" ? 1 : 2));
  const rest = list.length - lead.length;
  return [
    ...lead.map((o) => repRow(o)),
    ...(rest > 0
      ? [`<a class="list-row link-row" href="${href}"><div><div class="list-title">${esc(label)}</div><div class="list-meta">${rest} more</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`]
      : []),
  ];
}

/** One official as a list row: name, office · district, and an optional note. */
export function repRow(o, note = "") {
  return `
<a class="list-row link-row" href="/reps/${esc(o.slug)}/">
  <div><div class="list-title">${esc(o.name)}</div><div class="list-meta">${esc([o.office, o.district].filter(Boolean).join(" · "))}${note ? ` · ${esc(note)}` : ""}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function breadcrumb(items) {
  return `<nav class="breadcrumb small" aria-label="Breadcrumb"><ol>${items
    .map(([label, href], i) => `<li>${href && i < items.length - 1 ? `<a class="inline-link" href="${esc(href)}">${esc(label)}</a>` : `<span aria-current="page">${esc(label)}</span>`}</li>`)
    .join("")}</ol></nav>`;
}

/**
 * A map: the SVG is drawn by /assets/map.js from `src`; `links` says where each
 * shape goes. `still`: no zooming or dragging (the hub), so a swipe always
 * scrolls the page.
 */
export function mapFigure({ id, src, links, status = {}, layers = null, active = null, label, legend = "", still = false }) {
  const toggles = layers && layers.length > 1
    ? `<div class="pill-filter map-layers" role="group" aria-label="Map layers">${layers
        .map(([key, name]) => `<a class="toggle" href="?layer=${key}#map" data-layer="${key}"${key === active ? ' aria-current="true"' : ""}>${esc(name)}</a>`)
        .join("")}</div>`
    : "";
  return `
<figure class="map-figure${still ? " map-figure--still" : ""}" id="${id}" data-map${still ? " data-still" : ""} data-src="${esc(src)}" data-layer="${esc(active || "")}" aria-label="${esc(label)}">
  ${toggles}
  <div class="map-stage">
    <div class="map-canvas" data-map-canvas><p class="small secondary map-loading">Loading the map…</p></div>
    ${still ? "" : `<div class="map-zoom" data-map-zoom hidden>
      <button type="button" class="btn btn--small" data-zoom="in" aria-label="Zoom in">+</button>
      <button type="button" class="btn btn--small" data-zoom="out" aria-label="Zoom out">−</button>
      <button type="button" class="btn btn--small" data-zoom="reset">Reset</button>
    </div>`}
  </div>
  ${legend}
  <script type="application/json" data-map-links>${JSON.stringify({ links, status }).replace(/</g, "\\u003c")}</script>
  <noscript><p class="small secondary">The map needs JavaScript. Everything on it is in the lists below.</p></noscript>
</figure>`;
}
