// /candidates/<FEC id>/ and /candidates/ca/<contest>/<name>/: one candidate not
// yet in office, with the same layout as an official's page (About · Platform ·
// Votes · Funding · More; functions/_lib/candidates.js). The same for everyone:
// kept at the edge for a few minutes. /candidates/ goes to Open your ballot.
import { page, notFound, guard, edgeCached, loadSection } from "../_lib/render.js";
import { asset } from "../_lib/geo.js";
import { STATE_NAME } from "../_lib/districts.js";
import { todayIn } from "../_lib/election-window.js";
import {
  loadCandidates, certifiedElection, platformFor, recordsFor, fecCandidatePage, stateCandidatePage, stateOfId, nameSlug, racesHref, YEAR, STATE_SCOPES,
} from "../_lib/candidates.js";

const BACK = ["Open your ballot", "/ballot/"];
const NONE = "No candidate at this address.";
const noRecords = { officials: [], byFec: {} };

export const onRequestGet = guard(async (context) => {
  const { request, env, params } = context;
  const url = new URL(request.url);
  const parts = (params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}/ballot/`, 302);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);

  // A certified-list candidate for a state office.
  if (parts[0] === "ca" && parts.length === 3) {
    return edgeCached(context, 300, async () => {
      const election = await certifiedElection(env, request, "CA");
      const contest = election && election.contests.find((c) => c.id === parts[1] && STATE_SCOPES.has(c.scope));
      const cand = contest && contest.candidates.find((x) => nameSlug(x.name) === parts[2]);
      if (!cand) return notFound(NONE, "home", BACK);
      const records = await loadSection("candidate records", () => recordsFor(env.DB, "CA"), noRecords);
      const p = stateCandidatePage({ cand, contest, election, records: records && records.officials ? records : noRecords, today: todayIn("CA") });
      return page(p.title, p.main, { tab: "home", back: ["Candidates in California", racesHref(Number(election.election.date.slice(0, 4)), "CA")] });
    });
  }

  const id = parts.length === 1 ? parts[0].toUpperCase() : "";
  const st = stateOfId(id);
  if (!st) return notFound(NONE, "home", BACK);
  if (parts[0] !== id) return Response.redirect(`${url.origin}/candidates/${id}/`, 301);
  return edgeCached(context, 300, async () => {
    const data = await loadCandidates(env, request, st, YEAR);
    const c = data && data.candidates[id];
    if (!c) return notFound(NONE, "home", BACK);
    const [election, records, dates, platform] = await Promise.all([
      loadSection("candidate election", () => certifiedElection(env, request, st), null),
      loadSection("candidate records", () => recordsFor(env.DB, st), noRecords),
      loadSection("candidate dates", () => asset(env, request, "/data/elections/dates.json"), null),
      loadSection("candidate platform", () => platformFor(env.DB, id), null),
    ]);
    const p = fecCandidatePage({
      c, st, data,
      election: election && election.contests ? election : null,
      records: records && records.officials ? records : noRecords,
      dates: dates && dates.states ? dates : null,
      today: todayIn(st),
      platform: platform && typeof platform === "object" ? platform : null,
    });
    return page(p.title, p.main, { tab: "home", back: [`Candidates in ${STATE_NAME[st] || st}`, racesHref(data.year, st)] });
  });
}, { tab: "home" });
