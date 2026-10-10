// "Your state" at the top of the home page, for the visitor's state
// (functions/_lib/visitor-state.js): its U.S. Senators and House members with
// their latest final-passage votes, its governor and statewide offices, its
// legislature (legislators, and recent bills once its votes are loaded), its
// statewide ballot measures for the next election, and Find your reps for exact
// districts. What isn't loaded for the state says so, with "join the list".
// The same for everyone in the state: cached per state at the edge.
import { esc, fmtDate, linkRow, loadSection, FAILED, sectionError } from "./render.js";
import { recentFinalVotes } from "./data.js";
import { coverageFor, votesLoaded, votesComingSoon } from "./coverage.js";
import { executiveOfficials } from "./executive.js";
import { billHref } from "./votes.js";
import { compactRow } from "./summary.js";
import { measureRow, electionHref } from "./elections.js";
import { chamberIds, chamberName, parseChamber } from "../../workers/sync/src/states.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const MEASURES_SHOWN = 4;

async function congressOf(db, st) {
  const { results } = await db
    .prepare("SELECT id, slug, name, office, chamber, district FROM officials WHERE active = 1 AND state = ? AND chamber IN ('us-senate', 'us-house') ORDER BY name")
    .bind(st)
    .all();
  return { senators: results.filter((o) => o.chamber === "us-senate"), house: results.filter((o) => o.chamber === "us-house") };
}

async function legislatorCounts(db, st) {
  const ids = chamberIds(st);
  const chambers = [ids.upper, ids.lower].filter(Boolean);
  const { results } = await db
    .prepare(`SELECT chamber, COUNT(*) AS n FROM officials WHERE active = 1 AND chamber IN (${chambers.map(() => "?").join(",")}) GROUP BY chamber`)
    .bind(...chambers)
    .all();
  return chambers.map((c) => ({ chamber: c, n: (results.find((r) => r.chamber === c) || {}).n || 0 }));
}

async function latestStateBills(db, st) {
  try {
    return (
      await db
        .prepare("SELECT bill_id AS id, bill_number, title, last_final, final_result FROM bill_list WHERE level = 'state' AND COALESCE(st, 'CA') = ? AND last_final IS NOT NULL ORDER BY last_final DESC, bill_id DESC LIMIT 4")
        .bind(st)
        .all()
    ).results;
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** Everything the section needs, each part loaded on its own. */
export async function stateLeadData(db, st) {
  const empty = { congress: { senators: [], house: [] }, votes: { rows: [] }, executive: [], counts: [], coverage: null, bills: [] };
  if (!db) return empty;
  const [congress, executive, counts, coverage, bills] = await Promise.all([
    loadSection("state lead congress", () => congressOf(db, st), empty.congress),
    loadSection("state lead executive", () => executiveOfficials(db, chamberIds(st).executive), []),
    loadSection("state lead legislators", () => legislatorCounts(db, st), []),
    st === "CA" ? null : loadSection("state lead coverage", () => coverageFor(db, st), null),
    loadSection("state lead bills", () => latestStateBills(db, st), []),
  ]);
  const senators = congress === FAILED ? [] : congress.senators;
  // The senators' latest final-passage votes (House members: once the visitor's district is known).
  const votes = senators.length
    ? await loadSection("state lead votes", () => recentFinalVotes(db, { level: "federal", limit: 3, officialIds: senators.map((o) => o.id) }), { rows: [] })
    : { rows: [] };
  return { congress, votes, executive, counts, coverage, bills };
}

const joinList = (name) =>
  `<a class="inline-link" href="#communities">Join the list for ${esc(name)}</a> and we'll email you when more of it opens.`;

function congressCard(st, name, { congress, votes }) {
  if (congress === FAILED) return sectionError("Congress");
  const { senators, house } = congress;
  if (!senators.length && !house.length) {
    return `<div class="card"><p class="small secondary">${esc(name)}'s members of Congress appear after the data sync runs.</p></div>`;
  }
  const voteRows = votes === FAILED ? sectionError("Recent votes") : (votes.rows || [])
    .map((v) =>
      compactRow({
        href: v.bill_id ? `${billHref(v.bill_id)}#votes` : v.source_url,
        type: v.bill_number || "Vote",
        title: v.bill_title || v.question,
        status: `${v.result}${v.yea != null && v.nay != null ? ` · Yes ${v.yea}, No ${v.nay}` : ""}`,
        meta: [fmtDate(v.vote_date), (v.positions || []).map((p) => `${p.name} ${p.position}`).join(", ")].filter(Boolean).join(" · "),
      })
    )
    .join("");
  return `
  <div class="card stack-xs">
    <p class="label">In Congress</p>
    ${senators.map((o) => linkRow(`/reps/${o.slug}/`, o.name, "U.S. Senator")).join("")}
    ${house.length ? linkRow(`/reps/?state=${st}#browse`, plural(house.length, "House member", "House members"), "Your own House member: find your reps below") : ""}
    ${voteRows ? `<p class="label">Latest final-passage votes${senators.length ? `, with ${senators.length === 1 ? "the senator's position" : "both senators' positions"}` : ""}</p><div class="compact-list">${voteRows}</div>` : ""}
  </div>`;
}

function executiveCard(st, name, executive) {
  if (executive === FAILED) return sectionError("Statewide offices");
  if (!executive.length) {
    return `<div class="card"><p class="small secondary">${esc(name)}'s governor and statewide offices appear after the data sync loads them (weekly, from Open States).</p></div>`;
  }
  const lead = executive.filter((o) => o.rank === 1);
  const all = st === "CA" ? "/bodies/ca-executive/" : `/explore/${st.toLowerCase()}/#h-statewide`;
  return `
  <div class="card stack-xs">
    <p class="label">${esc(name)}, statewide</p>
    ${lead.map((o) => linkRow(`/reps/${o.slug}/`, o.name, o.office)).join("")}
    ${linkRow(all, `${name}'s statewide offices`, `${executive.length} ${st === "CA" ? "elected statewide" : "listed"}`)}
  </div>`;
}

function legislatureCard(st, name, { counts, coverage, bills }) {
  const loadedCounts = counts === FAILED ? [] : counts.filter((c) => c.n);
  const members = loadedCounts.map((c, i) => `${c.n} ${i ? "in" : c.n === 1 ? "member of" : "members of"} the ${chamberName(st, parseChamber(c.chamber).type, name)}`).join(" and ");
  const loaded = votesLoaded(st, coverage === FAILED ? null : coverage);
  const billRows = loaded && bills !== FAILED
    ? bills.map((b) => compactRow({ href: billHref(b.id), type: b.bill_number, title: b.title, status: b.final_result || "", meta: `Last final vote ${fmtDate(b.last_final)}` })).join("")
    : "";
  return `
  <div class="card stack-xs">
    <p class="label">${esc(st === "DC" ? "The Council" : "The legislature")}</p>
    <p class="small">${members ? `${esc(members)}. ` : ""}${members ? "Yours are on your briefing once you find your reps." : `${esc(name)}'s legislators appear after the data sync loads them (weekly, from Open States).`}</p>
    ${loaded
      ? billRows
        ? `<div class="compact-list">${billRows}</div>${linkRow(`/explore/${st.toLowerCase()}/#h-leg`, "More from the legislature", "")}`
        : '<p class="small secondary">No final floor votes recorded yet this session.</p>'
      : `${votesComingSoon(name, !!members)}<p class="small">${joinList(name)}</p>`}
  </div>`;
}

function ballotCard(st, name, election) {
  if (election === FAILED) return sectionError("Ballot measures");
  if (election && election.election.state === st) {
    const id = election.election.id;
    const measures = election.measures.filter((m) => m.scope === "statewide");
    return `
  <div class="card stack-xs">
    <p class="label">On the ballot statewide · ${esc(election.election.name)}</p>
    ${measures.slice(0, MEASURES_SHOWN).map((m) => measureRow(id, m)).join("") || '<p class="small secondary">No statewide measures on this ballot.</p>'}
    ${measures.length > MEASURES_SHOWN ? linkRow(electionHref(id), `All ${measures.length} statewide measures`, "And statewide offices") : ""}
  </div>`;
  }
  return `
  <div class="card stack-xs">
    <p class="label">Ballot measures</p>
    <p class="small secondary">${esc(name)}'s statewide ballot measures aren't on ThePillory yet. Your state's election office has the official list: <a class="inline-link" href="https://www.usa.gov/state-election-office" target="_blank" rel="noopener">find it on USA.gov ↗</a>.</p>
    <p class="small">${joinList(name)}</p>
  </div>`;
}

/** The section. `vs`: { st, name }; `data`: stateLeadData(); `election`: the next election (or null). */
export function stateLead(vs, data, election) {
  const { st, name } = vs;
  return `
<section class="brief-section" id="your-state" aria-labelledby="h-your-state">
  <div class="section-head"><h2 class="label" id="h-your-state">${esc(name)}</h2><a class="section-link" href="/explore/${st.toLowerCase()}/">State page</a></div>
  <a class="btn btn--primary btn--block" href="/ballot/${st.toLowerCase()}/">Open your ballot</a>
  ${congressCard(st, name, data)}
  ${executiveCard(st, name, data.executive)}
  ${legislatureCard(st, name, data)}
  ${ballotCard(st, name, election)}
  <p class="small"><a class="inline-link" href="#find">Find your reps</a> with an address or ZIP code for your own House member, state legislators and ballot.</p>
</section>`;
}
