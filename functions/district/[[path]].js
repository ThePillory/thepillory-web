// /district/<type>/<st>-<id>/   one district: its representative, the counties
// it covers (fully or partly), recent votes and Funding.
//   <type>: congressional, state-senate, assembly, state-house,
//           house-of-delegates, general-assembly, legislature (Nebraska)
// e.g. /district/congressional/ca-5/, /district/assembly/ca-8/.
import { page, notFound, esc, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { recentFinalVotes } from "../_lib/data.js";
import { voteRows } from "../_lib/briefing.js";
import { CURRENT, loadElection, onTheBallot, statewideRow, contestRow, electionHref } from "../_lib/elections.js";
import { pacificNow } from "../_lib/meetings.js";
import { LAYER_OF_TYPE, typeOf, loadPlace, officialsFor, repRow, breadcrumb, districtLabel, placeHref } from "../_lib/geo.js";


// A district page is the same for every visitor: kept at the edge for a few minutes.
const DISTRICT_CACHE_SECONDS = 300;

export const onRequestGet = guard((context) => edgeCached(context, DISTRICT_CACHE_SECONDS, () => districtPage(context)), { tab: "home" });

async function districtPage({ request, env, params }) {
  const url = new URL(request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const [type, key, extra] = (params.path || []).filter(Boolean).map((s) => s.toLowerCase());
  const m = /^([a-z]{2})-([a-z0-9-]+)$/.exec(key || "");
  const layer = LAYER_OF_TYPE[type];
  if (!layer || !m || extra) return notFound("No district at this address.", "home", ["Explore", "/explore/"]);
  const place = await loadPlace(env, request, m[1]);
  const id = m[2];
  const counties = place && place.districts && place.districts[layer] && place.districts[layer][id];
  if (!counties) return notFound("No district at this address.", "home", ["Explore", "/explore/"]);
  // One canonical type per chamber (e.g. California's lower chamber is "assembly").
  const canonical = typeOf(layer, place.chambers);
  if (canonical !== type) return Response.redirect(`${url.origin}/district/${canonical}/${m[1]}-${id}/`, 301);

  const label = districtLabel(layer, id, place);
  const db = env.DB;
  // Each section loads on its own: one that can't load shows a short note.
  const repsLoaded = db
    ? await loadSection("district reps", async () => {
        const o = await officialsFor(db, place.st, { senators: false, cd: layer === "cd" ? [id] : [], sldu: layer === "sldu" ? [id] : [], sldl: layer === "sldl" ? [id] : [] });
        return [...o.house, ...o.upper, ...o.lower];
      }, [])
    : [];
  const reps = repsLoaded === FAILED ? [] : repsLoaded;
  const votes = db && reps.length ? await loadSection("district votes", () => recentFinalVotes(db, { limit: 5, officialIds: reps.map((r) => r.id) }), { rows: [] }) : { rows: [] };
  const stateLoaded = layer === "cd" || place.st === "CA";
  const repHtml = repsLoaded === FAILED ? sectionError("") : reps.length
    ? `<div class="card">${reps.map((r) => repRow(r)).join("")}</div>`
    : `<p class="small secondary">${stateLoaded ? "The representative appears after the data sync runs." : `${esc(place.name)}'s state legislators aren't on ThePillory yet. State coverage opens as communities launch.`}</p>`;
  const countyRows = counties
    .map(([fips, full]) => {
      const c = place.counties.find((x) => x.fips === fips);
      if (!c) return "";
      return `<a class="list-row link-row" href="${placeHref(place.st, c.slug)}"><div><div class="list-title">${esc(c.name)}</div><div class="list-meta">${full ? "Entirely in this district" : "Part of the county"}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`;
    })
    .join("");
  const rows = votes === FAILED ? "" : voteRows(votes.rows, 5);
  const electionLoaded = await loadSection("district election", () => loadElection(env, request, CURRENT), null);
  const election = electionLoaded && electionLoaded !== FAILED && electionLoaded.election.state === place.st ? electionLoaded : null;
  const contest = election && election.contests.find((x) => x.scope === layer && x.district === id);
  const ballot = !election
    ? ""
    : contest
      ? onTheBallot(election, { rows: [contestRow(election.election.id, contest), statewideRow(election)], today: pacificNow().slice(0, 10) })
      : `<section class="stack-sm" aria-labelledby="h-elections"><h2 class="label" id="h-elections">Elections</h2><p class="small secondary">This seat isn't on the Secretary of State's certified list of candidates for the ${esc(election.election.name)}. <a class="inline-link" href="${electionHref(election.election.id)}">What's on the ballot</a></p></section>`;
  const federal = reps.filter((r) => r.level === "federal");

  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, `/explore/${m[1]}/`], [label, null]])}
<header class="page-head stack-xs">
  <p class="label">${esc(layer === "cd" ? "U.S. House" : place.chambers[layer])}</p>
  <h1>${esc(label)}</h1>
  <p class="secondary">${esc(place.name)} · ${counties.length} ${counties.length === 1 ? "county" : "counties"}</p>
</header>
<section class="stack-sm" aria-labelledby="h-rep">
  <h2 class="label" id="h-rep">Representative</h2>
  ${repHtml}
</section>
${electionLoaded === FAILED ? sectionError("Elections") : ballot}
<section class="stack-sm" aria-labelledby="h-counties">
  <h2 class="label" id="h-counties">Counties it covers</h2>
  <div class="card">${countyRows}</div>
  <p class="hint">From the U.S. Census Bureau's 2020 census blocks: a county is "entirely in" the district when all of its blocks are.</p>
</section>
<section class="stack-sm" aria-labelledby="h-votes">
  <h2 class="label" id="h-votes">Recent votes</h2>
  ${votes === FAILED ? sectionError("") : rows ? `<ul class="card plain-list brief-votes">${rows}</ul>` : `<p class="small secondary">${reps.length ? "No final-passage votes loaded yet." : "Votes appear once the representative is loaded."}</p>`}
</section>
${federal.length ? `<section class="stack-sm" aria-labelledby="h-funding"><h2 class="label" id="h-funding">Funding</h2><div class="chips">${federal.map((r) => `<a class="chip chip--tap" href="/reps/${esc(r.slug)}/#funding">${esc(r.name)}</a>`).join("")}</div><p class="hint">Campaign funding, from the Federal Election Commission.</p></section>` : ""}`;
  return page(`${label}, ${place.name}`, main, { tab: "home", back: [place.name, `/explore/${m[1]}/`], partial: anyFailed(repsLoaded, votes, electionLoaded) });
}
