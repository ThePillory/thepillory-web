// Page summaries (migration 0010): what the Laws page, the hub's Happening now,
// the state map pages and the Reps lists show, computed here once per change
// instead of from the full votes and vote_positions tables on every visit.
//
//   bill_list       one row per bill with a recorded vote: latest vote dates,
//                   counts, the latest final-passage vote's result and totals,
//                   the final action (bill_outcomes), and whether the relevance
//                   check set it aside as ceremonial or routine.
//   official_stats  each official's recorded votes, counted.
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
    one("SELECT COUNT(*) AS n FROM officials"),
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
  outcome, outcome_date, routine)
SELECT b.id, b.level, b.chamber, b.bill_number, b.title, b.session, agg.last_vote, agg.vote_count,
  agg.last_final, agg.final_count, lf.id, lf.result, lf.chamber, lf.yea, lf.nay, lf.present, lf.not_voting,
  o.outcome, o.action_date,
  CASE WHEN r.verdict = 'skip' AND r.override IS NULL THEN 1 ELSE 0 END
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
// more than a few hundred thousand positions.
const STATS = `
INSERT OR REPLACE INTO official_stats (official_id, vote_count, final_count, built_at)
SELECT o.id, COUNT(p.vote_id), COALESCE(SUM(CASE WHEN v.vote_type = 'final_passage' THEN 1 ELSE 0 END), 0), datetime('now')
FROM officials o
LEFT JOIN vote_positions p ON p.official_id = o.id
LEFT JOIN votes v ON v.id = p.vote_id
WHERE o.id IN (%IDS%)
GROUP BY o.id`;
const STATS_CHUNK = 10;

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
  const bills = await db.prepare("SELECT COUNT(*) AS n FROM bill_list").first();
  const officials = await db.prepare("SELECT COUNT(*) AS n FROM official_stats").first();
  await setState(db, "summaries_fingerprint", fp);
  return {
    status: "ok",
    message: `bill list: ${bills.n} bills; vote counts: ${officials.n} officials${basic ? " (without outcomes or relevance checks, not loaded yet)" : ""}; ${Math.round((Date.now() - started) / 100) / 10}s`,
  };
}

/** The sync step. */
export async function syncSummaries(env, db) {
  return buildSummaries(db);
}
