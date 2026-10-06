// /briefing/: the visitor's own briefing, from the districts saved in their
// browser (the pillory_districts cookie; never an address):
//   in Calaveras County   the full county briefing (also at /calaveras/)
//   anywhere else         their reps, their reps' latest votes, Happening now
// No saved districts: back to the hub's lookup.
import { guard } from "../_lib/render.js";
import { calaverasBriefing, personalBriefing } from "../_lib/briefing.js";
import { districtsFromCookie, isCalaveras } from "../_lib/districts.js";

export const onRequestGet = guard(async ({ request, env }) => {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const d = districtsFromCookie(request);
  if (!d) return new Response(null, { status: 302, headers: { Location: "/#find", "Cache-Control": "private, no-store" } });
  return isCalaveras(d) ? calaverasBriefing(env, url, d) : personalBriefing(env, url, d);
}, { tab: "home" });
