// The Supreme Court's terms and decisions (functions/_lib/scotus.js):
//   /court/                          → the Court's page, /bodies/us-supreme-court/
//   /court/term/                     This term: cases granted, argument dates, questions presented, decisions
//   /court/cases/<term>/<docket>/    one decision
// The same for everyone: kept at the edge for a few minutes.
import { page, notFound, guard, edgeCached } from "../_lib/render.js";
import { termPage, casePage, COURT_HREF, TERM_HREF } from "../_lib/scotus.js";

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}${COURT_HREF}`, 302);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  if (parts.length === 1 && parts[0] === "term") {
    return edgeCached(context, 300, async () => {
      const main = await termPage(env, request);
      return main ? page("This term at the Supreme Court", main, { tab: "laws", back: ["The Supreme Court", COURT_HREF] }) : notFound("This term's cases appear after the Supreme Court data refresh.", "laws", ["Laws", "/laws/"]);
    });
  }
  if (parts.length === 3 && parts[0] === "cases" && /^\d{4}$/.test(parts[1])) {
    return edgeCached(context, 300, async () => {
      const p = await casePage(env, request, parts[1], decodeURIComponent(parts[2]));
      return p ? page(p.title, p.main, { tab: "laws", back: ["This term", TERM_HREF] }) : notFound("No decision at this address.", "laws", ["This term", TERM_HREF]);
    });
  }
  return notFound("No page at this address.", "laws", ["This term", TERM_HREF]);
}, { tab: "laws" });
