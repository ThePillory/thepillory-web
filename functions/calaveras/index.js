// /calaveras/: the Calaveras County briefing, for everyone (the Communities
// card on the hub opens it). A visitor whose districts are in the county
// also gets it at /briefing/.
import { calaverasBriefing } from "../_lib/briefing.js";
import { districtsFromCookie } from "../_lib/districts.js";

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  return calaverasBriefing(env, url, districtsFromCookie(request));
}
