// The state's part of the home page (functions/_lib/home.js): its U.S. Senators
// and Governor for "Your representatives", whether its legislature's votes are
// loaded, and one line for everything not loaded yet: "Coming to [State]:
// bills and votes, ballot measures, county meetings. Join the list ›".
// The same for everyone in the state: cached per state at the edge.
import { esc, loadSection, FAILED } from "./render.js";
import { coverageFor, votesLoaded } from "./coverage.js";
import { executiveOfficials } from "./executive.js";
import { LIVE, stOfFips } from "./geo.js";
import { waitlistHref } from "./waitlist.js";
import { ELECTION_BY_STATE } from "./elections.js";
import { chamberIds } from "../../workers/sync/src/states.js";

async function senatorsOf(db, st) {
  const { results } = await db
    .prepare("SELECT id, slug, name, office, chamber, district FROM officials WHERE active = 1 AND state = ? AND chamber = 'us-senate' ORDER BY name")
    .bind(st)
    .all();
  return results;
}

/** What the state's part of the page needs, each part loaded on its own. */
export async function stateLeadData(db, st) {
  const empty = { senators: [], executive: [], coverage: null };
  if (!db) return empty;
  const [senators, executive, coverage] = await Promise.all([
    loadSection("state lead senators", () => senatorsOf(db, st), []),
    loadSection("state lead executive", () => executiveOfficials(db, chamberIds(st).executive), []),
    st === "CA" ? null : loadSection("state lead coverage", () => coverageFor(db, st), null),
  ]);
  return { senators, executive, coverage };
}

/** The state's Governor (or its first-ranked statewide office). */
export function governorOf(executive) {
  if (!executive || executive === FAILED) return null;
  return executive.find((o) => /^governor$/i.test(o.office || "")) || executive.find((o) => o.rank === 1) || null;
}

/** The state's live communities: [[fips, {name, briefing}]]. */
export const liveCounties = (st) => Object.entries(LIVE).filter(([fips]) => stOfFips(fips) === st);

/**
 * What isn't loaded for the state yet, in one line; "" when everything is.
 */
export function comingTo(vs, { executive, coverage }) {
  const { st, name } = vs;
  const soon = [];
  if (st !== "DC" && !votesLoaded(st, coverage === FAILED ? null : coverage)) soon.push("bills and votes in the legislature");
  if (executive !== FAILED && !(executive || []).length) soon.push("statewide offices");
  if (!ELECTION_BY_STATE[st]) soon.push("ballot measures");
  if (!liveCounties(st).length) soon.push("county meetings");
  if (!soon.length) return "";
  return `<p class="small secondary coming-to">Coming to ${esc(name)}: ${esc(soon.join(", "))}. <a class="inline-link" href="${waitlistHref(st)}">Join the list ›</a></p>`;
}
