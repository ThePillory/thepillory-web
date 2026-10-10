// /states/<name>/: a state's page, the same template as the home page
// (functions/_lib/home.js) filled with that state: "Showing [State] · Change",
// the same sections in the same order, and the national sections in the same
// spot. /states/ goes to the U.S. map; a two-letter code (/states/wa/) or a
// different spelling goes to the page's own address.
import { guard, edgeCached, notFound } from "../_lib/render.js";
import { districtsFromCookie, STATE_NAME } from "../_lib/districts.js";
import { hub, HUB_CACHE_SECONDS } from "../_lib/home.js";
import { stateFromSlug, statePath } from "../_lib/state-paths.js";

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}/explore/`, 302);
  const st = parts.length === 1 ? stateFromSlug(parts[0]) : null;
  if (!st) return notFound("No state at this address.", "home", ["Explore", "/explore/"]);
  if (url.pathname !== statePath(st)) return Response.redirect(`${url.origin}${statePath(st)}${url.search}`, 301);
  const vs = { st, name: STATE_NAME[st], source: "page" };
  const d = districtsFromCookie(request);
  if (d) return hub(env, request, url, d, vs);
  return edgeCached(context, HUB_CACHE_SECONDS, () => hub(env, request, url, null, vs), { variant: `${st}-page` });
}, { tab: "home" });
