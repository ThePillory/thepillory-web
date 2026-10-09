// What's loaded for each state (state_coverage, rebuilt by the sync's
// page-summaries step), and the plain notes pages show about it: a state's
// bills and votes either are on ThePillory, with their dates and source, or
// are "coming soon", loaded state by state, the states visitors look up most
// first. See docs/states.md.
import { esc, fmtDate } from "./render.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/** One state's coverage row, or null (nothing loaded, or before migration 0020). */
export async function coverageFor(db, st) {
  if (!db) return null;
  try {
    return await db.prepare("SELECT * FROM state_coverage WHERE st = ?").bind(st).first();
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** Every state's coverage, keyed by state. */
export async function allCoverage(db) {
  if (!db) return {};
  try {
    const { results } = await db.prepare("SELECT * FROM state_coverage").all();
    return Object.fromEntries(results.map((r) => [r.st, r]));
  } catch (err) {
    if (missing(err)) return {};
    throw err;
  }
}

/** True when a state's bills and roll call votes are on ThePillory. */
export const votesLoaded = (st, cov) => st === "CA" || !!(cov && cov.votes);

/** "Coming soon" for a state whose votes aren't loaded, said plainly. */
export function votesComingSoon(name) {
  return `<p class="small secondary">${esc(name)}'s bills and roll call votes are coming soon. They're loaded state by state from Open States' public session files, the states visitors look up most first. Its legislators and statewide officers are here now.</p>`;
}

/** What's loaded for a state with votes: counts, dates and where they come from. */
export function votesLoadedNote(st, name, cov) {
  if (st === "CA" || !cov || !cov.votes) return "";
  return `<p class="hint">${cov.bills.toLocaleString("en-US")} bills and ${cov.votes.toLocaleString("en-US")} recorded votes in ${esc(name)}'s legislature, ${fmtDate(cov.first_vote)} to ${fmtDate(cov.last_vote)}, from Open States (public session files, refreshed monthly, with daily updates for the current session). Each vote links to its official record.</p>`;
}
