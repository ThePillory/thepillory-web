// /races/<year>/<st>/          every race in a state with candidate pages
// /races/<year>/<st>/<race>/   every candidate in one race ("senate", "house-<n>",
//                              or a certified contest's id), the same card each, in
//                              ballot order where the certified list gives it,
//                              otherwise alphabetical (functions/_lib/candidates.js).
// The same for everyone: kept at the edge for a few minutes.
import { page, notFound, guard, edgeCached, loadSection } from "../_lib/render.js";
import { asset } from "../_lib/geo.js";
import { STATE_NAME } from "../_lib/districts.js";
import { todayIn } from "../_lib/election-window.js";
import { loadCandidates, certifiedElection, recordsFor, racePage, racesIndexPage, racesHref, YEAR } from "../_lib/candidates.js";

const BACK = ["Open your ballot", "/ballot/"];
const NONE = "No race at this address.";
const noRecords = { officials: [], byFec: {} };
const okObj = (x, test) => (x && typeof x === "object" && test(x) ? x : null);

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}/ballot/`, 302);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const year = Number(parts[0]);
  const st = String(parts[1] || "").toUpperCase();
  if (year !== YEAR || !STATE_NAME[st] || parts.length > 3 || (parts[2] && !/^[a-z0-9-]+$/.test(parts[2]))) return notFound(NONE, "home", BACK);
  if (parts.length === 1) return Response.redirect(`${url.origin}/ballot/`, 302);
  return edgeCached(context, 300, async () => {
    const [data, election, records, dates] = await Promise.all([
      loadSection("race candidates", () => loadCandidates(env, request, st, year), null),
      loadSection("race election", () => certifiedElection(env, request, st), null),
      parts[2] ? loadSection("race records", () => recordsFor(env.DB, st), noRecords) : noRecords,
      loadSection("race dates", () => asset(env, request, "/data/elections/dates.json"), null),
    ]);
    const args = {
      st,
      data: okObj(data, (x) => x.candidates),
      election: okObj(election, (x) => x.contests),
      records: okObj(records, (x) => x.officials) || noRecords,
      dates: okObj(dates, (x) => x.states),
      today: todayIn(st),
    };
    if (!parts[2]) {
      const p = racesIndexPage(args);
      return page(p.title, p.main, { tab: "home", back: [`Open your ballot, ${STATE_NAME[st]}`, `/ballot/${st.toLowerCase()}/`] });
    }
    const p = racePage({ ...args, key: parts[2] });
    if (!p) return notFound(NONE, "home", BACK);
    return page(p.title, p.main, { tab: "home", back: [`Candidates in ${STATE_NAME[st]}`, racesHref(year, st)] });
  });
}, { tab: "home" });
