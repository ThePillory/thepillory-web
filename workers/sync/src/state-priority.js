// The order states are loaded in: the states visitors look up most first.
// Interest is what this site can see without keeping anything about a person:
// how many times reps were looked up in each state (state_interest: counts per
// state and day, from /api/districts; no address, ZIP or visitor is kept)
// over the last 90 days, plus waitlist signups (each counts as 10 lookups: a
// signup is a stronger signal than a visit). Ties go to the larger state.
// STATE_PRIORITY (comma-separated, e.g. "TX,NY") puts states first by hand.
import { ALL_JURISDICTIONS, BY_POPULATION, FIPS_STATE } from "./states.js";
import { setState } from "./util.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));
const SIGNUP_WEIGHT = 10;

/** Scores by state from the two counts. Pure; tested. */
export function rankStates({ lookups = {}, signups = {}, manual = [] } = {}) {
  const score = (st) => (lookups[st] || 0) + SIGNUP_WEIGHT * (signups[st] || 0);
  const pop = (st) => {
    const i = BY_POPULATION.indexOf(st);
    return i < 0 ? 999 : i;
  };
  const first = manual.filter((st) => ALL_JURISDICTIONS.includes(st));
  const rest = ALL_JURISDICTIONS.filter((st) => !first.includes(st)).sort((a, b) => score(b) - score(a) || pop(a) - pop(b));
  return { order: [...new Set([...first, ...rest])], scores: Object.fromEntries(ALL_JURISDICTIONS.map((st) => [st, score(st)])) };
}

export async function stateCounts(db) {
  const lookups = {};
  const signups = {};
  try {
    const { results } = await db.prepare("SELECT st, SUM(lookups) AS n FROM state_interest WHERE day >= date('now', '-90 days') GROUP BY st").all();
    for (const r of results) lookups[r.st] = r.n;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  try {
    const { results } = await db.prepare("SELECT substr(county_fips, 1, 2) AS fp, COUNT(*) AS n FROM waitlist GROUP BY 1").all();
    for (const r of results) if (FIPS_STATE[r.fp]) signups[FIPS_STATE[r.fp]] = (signups[FIPS_STATE[r.fp]] || 0) + r.n;
  } catch (err) {
    if (!missing(err)) throw err;
  }
  return { lookups, signups };
}

/** Every state and territory in loading order; the order and its counts are kept in sync_state for the loaders and /status. */
export async function statePriority(db, env = {}) {
  const counts = await stateCounts(db);
  const manual = String(env.STATE_PRIORITY || "").toUpperCase().split(/[\s,]+/).filter(Boolean);
  const r = rankStates({ ...counts, manual });
  await setState(db, "state_priority", JSON.stringify({ order: r.order, lookups: counts.lookups, signups: counts.signups, manual, at: new Date().toISOString() }));
  return r.order;
}

/** Which bills the analysis round considers, and in what order: Congress and California first, then passed bills
 * (a final-passage vote that passed) in the `top` states visitors look up most. SQL over bills b. Pure; tested. */
export function stateBillScope(order, top) {
  const states = order.filter((st) => st !== "CA").slice(0, top).map((st) => st.toLowerCase());
  const list = states.map((st) => `'${st.replace(/[^a-z]/g, "")}'`).join(",") || "''";
  return {
    where: `(b.level = 'federal' OR substr(b.id, 1, 3) = 'ca-' OR (substr(b.id, 1, 2) IN (${list})
             AND EXISTS (SELECT 1 FROM votes pv WHERE pv.bill_id = b.id AND pv.vote_type = 'final_passage' AND pv.result = 'Passed')))`,
    rank: `CASE WHEN b.level = 'federal' OR substr(b.id, 1, 3) = 'ca-' THEN 0 ${states.map((st, i) => `WHEN substr(b.id, 1, 2) = '${st}' THEN ${i + 1}`).join(" ")} ELSE 99 END`,
  };
}
