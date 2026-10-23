// /states/<name>/: a state's page, the same template as the home page
// (functions/_lib/home.js) filled with that state: "Showing [State] · Change",
// the same sections in the same order, and the national sections in the same
// spot. /states/ goes to the U.S. map; a two-letter code (/states/wa/) or a
// different spelling goes to the page's own address.
// /states/<name>/map/: the state's map with its layers, every county, every
// district, its statewide offices and its legislature's latest final votes
// (functions/_lib/state-map.js). The state's page shows the same map at the
// top (?layer= picks the layer there too), without the lists.
import { page, guard, edgeCached, notFound, loadSection, FAILED, sectionError } from "../_lib/render.js";
import { districtsFromCookie, STATE_NAME } from "../_lib/districts.js";
import { hub, HUB_CACHE_SECONDS } from "../_lib/home.js";
import { stateFromSlug, statePath } from "../_lib/state-paths.js";
import { stateMapData, stateMapSection } from "../_lib/state-map.js";
import { ASSET_VERSION } from "../_lib/generated.js";

const MAP_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}/explore/`, 302);
  const st = parts.length <= 2 && (parts.length === 1 || parts[1] === "map") ? stateFromSlug(parts[0]) : null;
  if (!st) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  const isMap = parts.length === 2;
  const own = isMap ? `${statePath(st)}map/` : statePath(st);
  if (url.pathname !== own) return Response.redirect(`${url.origin}${own}${url.search}`, 301);
  if (isMap) return edgeCached(context, MAP_CACHE_SECONDS, () => mapPage(env, request, url, st));
  const vs = { st, name: STATE_NAME[st], source: "page" };
  const d = districtsFromCookie(request);
  if (d) return hub(env, request, url, d, vs);
  return edgeCached(context, HUB_CACHE_SECONDS, () => hub(env, request, url, null, vs), { variant: `${st}-page` });
}, { tab: "home" });

async function mapPage(env, request, url, st) {
  const name = STATE_NAME[st];
  const data = await loadSection(`${st} map`, () => stateMapData(env, request, st, url.searchParams.get("layer")), null);
  const main = `
<header class="page-head stack-xs">
  <h1>${name}: counties and districts</h1>
  <p class="subtitle">Tap a county or district on the map, or use the lists.</p>
</header>
${data === FAILED ? sectionError(`${name} map`) : data ? stateMapSection(data) : `<p class="small secondary">No map for ${name} yet.</p>`}
<script src="/assets/map.js?v=${ASSET_VERSION}" defer></script>`;
  return page(`${name}: counties and districts`, main, { tab: "home", back: [name, statePath(st)], partial: data === FAILED });
}
