// Page summaries (migration 0010): what the Laws page, the hub's Happening now,
// the state map pages and the Reps lists show, computed here once per change
// instead of from the full votes and vote_positions tables on every visit.
//
//   bill_list       one row per bill with a recorded vote: latest vote dates,
//                   counts, the latest final-passage vote's result and totals,
//                   the final action (bill_outcomes), and whether the relevance
//                   check set it aside as ceremonial or routine.
//   official_stats  each official's recorded votes, counted.
//   state_coverage  per state: legislators and statewide officers loaded, bills
//                   and votes, the dates and sessions they span (docs/states.md).
//
// Rebuilt only when something they're computed from changed (the fingerprint),
// so the step costs one small query on a round with nothing new.

import { getState, setState } from "./util.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

/** Counts and latest timestamps of everything the summaries are computed from. */
export async function fingerprint(db) {
  const one = async (sql) => {
    try {
      return await db.prepare(sql).first();
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  };
  const parts = await Promise.all([
    one("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM votes"),
    one("SELECT COUNT(*) AS n, MAX(updated_at) AS t FROM bills"),
    one("SELECT COUNT(*) AS n, MAX(checked_at) AS t FROM bill_outcomes"),
    one("SELECT COUNT(*) AS n, MAX(checked_at) AS t, MAX(override_at) AS o FROM bill_relevance"),
    one("SELECT COUNT(*) AS n, SUM(active) AS a FROM officials"),
  ]);
  return JSON.stringify(parts);
}

// The bill list in one statement: per-bill aggregates from votes (not
// vote_positions), the latest final-passage vote, the final action and the
// relevance verdict. Run in a batch with the DELETE, so the page never sees an
// empty table.
const BILL_LIST = `
INSERT INTO bill_list (bill_id, level, chamber, bill_number, title, session, last_vote, vote_count,
  last_final, final_count, final_vote_id, final_result, final_chamber, yea, nay, present, not_voting,
  outcome, outcome_date, routine, st)
SELECT b.id, b.level, b.chamber, b.bill_number, b.title, b.session, agg.last_vote, agg.vote_count,
  agg.last_final, agg.final_count, lf.id, lf.result, lf.chamber, lf.yea, lf.nay, lf.present, lf.not_voting,
  o.outcome, o.action_date,
  CASE WHEN r.verdict = 'skip' AND r.override IS NULL THEN 1 ELSE 0 END,
  CASE WHEN b.level = 'state' THEN upper(substr(b.id, 1, 2)) END
FROM (
  SELECT bill_id, MAX(vote_date) AS last_vote, COUNT(*) AS vote_count,
    MAX(CASE WHEN vote_type = 'final_passage' THEN vote_date END) AS last_final,
    SUM(CASE WHEN vote_type = 'final_passage' THEN 1 ELSE 0 END) AS final_count
  FROM votes WHERE bill_id IS NOT NULL GROUP BY bill_id
) agg
JOIN bills b ON b.id = agg.bill_id
LEFT JOIN votes lf ON lf.id = (
  SELECT v2.id FROM votes v2 WHERE v2.bill_id = agg.bill_id AND v2.vote_type = 'final_passage'
  ORDER BY v2.vote_date DESC, v2.id DESC LIMIT 1)
LEFT JOIN bill_outcomes o ON o.bill_id = b.id
LEFT JOIN bill_relevance r ON r.bill_id = b.id`;

// Without the tables an older database may lack (outcomes, relevance).
const BILL_LIST_BASIC = BILL_LIST
  .replace("o.outcome, o.action_date,\n  CASE WHEN r.verdict = 'skip' AND r.override IS NULL THEN 1 ELSE 0 END", "NULL, NULL, 0")
  .replace("LEFT JOIN bill_outcomes o ON o.bill_id = b.id\nLEFT JOIN bill_relevance r ON r.bill_id = b.id", "");

// Official stats, a few officials per statement, so no single statement reads
// more than a few hundred thousand positions. Positions are in vote_positions
// (Congress, California) or the compact state_positions (every other state),
// each read by the member's key.
const STATS = `
INSERT OR REPLACE INTO official_stats (official_id, vote_count, final_count, built_at)
SELECT o.id,
  (SELECT COUNT(*) FROM vote_positions p WHERE p.official_id = o.id)
    + (SELECT COUNT(*) FROM state_positions sp WHERE o.k IS NOT NULL AND sp.member_k = o.k),
  (SELECT COUNT(*) FROM vote_positions p JOIN votes v ON v.id = p.vote_id WHERE p.official_id = o.id AND v.vote_type = 'final_passage')
    + (SELECT COUNT(*) FROM state_positions sp JOIN votes v ON v.k = sp.vote_k WHERE o.k IS NOT NULL AND sp.member_k = o.k AND v.vote_type = 'final_passage'),
  datetime('now')
FROM officials o
WHERE o.id IN (%IDS%)`;
const STATS_CHUNK = 25;

/** What's loaded for each state (state_coverage): officials, bills, votes, their dates and sessions. */
export async function buildStateCoverage(db) {
  const rows = new Map();
  const at = (st) => {
    if (!rows.has(st)) rows.set(st, { st, legislators: 0, executives: 0, bills: 0, votes: 0, first_vote: null, last_vote: null, sessions: null });
    return rows.get(st);
  };
  const { results: off } = await db
    .prepare(
      `SELECT state AS st, SUM(CASE WHEN chamber GLOB '*-executive' THEN 0 ELSE 1 END) AS legislators, SUM(CASE WHEN chamber GLOB '*-executive' THEN 1 ELSE 0 END) AS executives
       FROM officials WHERE active = 1 AND level = 'state' AND state IS NOT NULL GROUP BY state`
    )
    .all();
  for (const r of off) Object.assign(at(r.st), { legislators: r.legislators, executives: r.executives });
  const { results: votes } = await db
    .prepare("SELECT upper(substr(chamber, 1, 2)) AS st, COUNT(*) AS n, MIN(vote_date) AS first, MAX(vote_date) AS last FROM votes WHERE level = 'state' GROUP BY 1")
    .all();
  for (const r of votes) Object.assign(at(r.st), { votes: r.n, first_vote: r.first, last_vote: r.last });
  const { results: bills } = await db.prepare("SELECT st, COUNT(*) AS n, group_concat(DISTINCT session) AS sessions FROM bill_list WHERE level = 'state' AND st IS NOT NULL GROUP BY st").all();
  for (const r of bills) Object.assign(at(r.st), { bills: r.n, sessions: r.sessions });
  const list = [...rows.values()].filter((r) => /^[A-Z]{2}$/.test(r.st));
  const stmts = [db.prepare("DELETE FROM state_coverage")];
  for (const r of list) {
    stmts.push(
      db
        .prepare("INSERT INTO state_coverage (st, legislators, executives, bills, votes, first_vote, last_vote, sessions, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))")
        .bind(r.st, r.legislators, r.executives, r.bills, r.votes, r.first_vote, r.last_vote, r.sessions)
    );
  }
  await db.batch(stmts);
  return list.length;
}

export async function buildSummaries(db, { force = false } = {}) {
  const fp = await fingerprint(db);
  if (!force && fp === (await getState(db, "summaries_fingerprint"))) {
    return { status: "skipped", message: "nothing changed since the last build" };
  }
  const started = Date.now();
  let basic = false;
  try {
    await db.batch([db.prepare("DELETE FROM bill_list"), db.prepare(BILL_LIST)]);
  } catch (err) {
    if (!missing(err)) throw err;
    basic = true;
    await db.batch([db.prepare("DELETE FROM bill_list"), db.prepare(BILL_LIST_BASIC)]);
  }
  const { results: ids } = await db.prepare("SELECT id FROM officials").all();
  for (let i = 0; i < ids.length; i += STATS_CHUNK) {
    const chunk = ids.slice(i, i + STATS_CHUNK).map((r) => r.id);
    await db.prepare(STATS.replace("%IDS%", chunk.map(() => "?").join(","))).bind(...chunk).run();
  }
  await db.prepare("DELETE FROM official_stats WHERE official_id NOT IN (SELECT id FROM officials)").run();
  let states = 0;
  try {
    states = await buildStateCoverage(db);
  } catch (err) {
    if (!missing(err)) throw err;
  }
  const bills = await db.prepare("SELECT COUNT(*) AS n FROM bill_list").first();
  const officials = await db.prepare("SELECT COUNT(*) AS n FROM official_stats").first();
  await setState(db, "summaries_fingerprint", fp);
  return {
    status: "ok",
    message: `bill list: ${bills.n} bills; vote counts: ${officials.n} officials; coverage: ${states} states${basic ? " (without outcomes or relevance checks, not loaded yet)" : ""}; ${Math.round((Date.now() - started) / 100) / 10}s`,
  };
}

/** The sync step. */
export async function syncSummaries(env, db) {
  return buildSummaries(db);
}
