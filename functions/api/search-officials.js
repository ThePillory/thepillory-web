// /api/search-officials?q=…: matches for a search, as JSON: officials, Supreme
// Court justices and candidates by name (the Reps tab's search), and bills (by
// number or title) and meetings for the search box at the top of every page.
// Called only as someone types (assets/app.js); every query is bounded
// (functions/_lib/people-search.js), and answers are kept at the edge for five
// minutes. The static part of search (governing bodies, the Constitution,
// topics) is assets/search-index.js.
import { edgeCached } from "../_lib/render.js";
import { searchAll } from "../_lib/people-search.js";

const EMPTY = { query: null, officials: [], justices: [], candidates: [], bills: [], meetings: [] };
const json = (body, cache) =>
  new Response(JSON.stringify(body), { headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": cache } });

export async function onRequestGet(context) {
  const q = new URL(context.request.url).searchParams.get("q");
  // Without a query: pages built before this change loaded this address as a
  // script (the old full list). Answer them with an empty script.
  if (q == null) {
    return new Response("// Search asks as you type now (assets/app.js).\n", {
      headers: { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "public, max-age=86400" },
    });
  }
  return edgeCached(context, 300, async () => {
    try {
      return json((await searchAll(context.env, context.request, q)) || EMPTY, "public, max-age=300");
    } catch (err) {
      console.error(`search: ${err && err.message}`);
      // Not kept at the edge, so the next search tries again.
      return json(EMPTY, "no-store");
    }
  });
}
