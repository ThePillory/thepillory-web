// /justices/<slug>/: one Supreme Court justice, About · Record · Disclosures ·
// More (functions/_lib/scotus.js, from data/scotus/). The same for everyone:
// kept at the edge for a few minutes.
import { page, notFound, guard, edgeCached } from "../_lib/render.js";
import { justicePage, COURT_HREF } from "../_lib/scotus.js";

const BACK = ["The Supreme Court", COURT_HREF];

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}${COURT_HREF}`, 302);
  if (parts.length !== 1 || !/^[a-z-]+$/.test(parts[0])) return notFound("No justice at this address.", "reps", BACK);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  return edgeCached(context, 300, async () => {
    const p = await justicePage(env, request, parts[0], url);
    return p ? page(p.title, p.main, { tab: "reps", back: BACK }) : notFound("No justice at this address.", "reps", BACK);
  });
}, { tab: "reps" });
