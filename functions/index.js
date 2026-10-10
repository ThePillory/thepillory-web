// /: Home. The visitor's state's page (functions/_lib/home.js, the same
// template as /states/<name>/): a state they picked, their saved districts'
// state, or Cloudflare's approximate state for the connection (never stored).
// Outside the US, or when the region is unknown: the national hub. The old
// ?hub=1 flag redirects here; /home/ redirects here.
import { guard, edgeCached } from "./_lib/render.js";
import { districtsFromCookie } from "./_lib/districts.js";
import { visitorState } from "./_lib/visitor-state.js";
import { hub, HUB_CACHE_SECONDS } from "./_lib/home.js";

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
  const vs = visitorState(request, d);
  if (d) return hub(env, request, url, d, vs);
  // One copy per state (and per how the state was found, which the page says),
  // and one national copy. Browsers don't keep it, so a change of state shows at once.
  return edgeCached(context, HUB_CACHE_SECONDS, () => hub(env, request, url, null, vs), {
    variant: vs ? `${vs.st}-${vs.source}` : "us",
    clientCache: "private, no-cache",
  });
}, { tab: "home" });
