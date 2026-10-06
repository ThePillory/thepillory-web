// D1 queries for the Pages Functions. Every query only returns rows that carry
// a source URL (the schema requires one), so nothing unsourced can be shown.

export const LEVEL_ORDER = ["county", "state", "federal"];
const CHAMBER_ORDER = ["county-board", "ca-assembly", "ca-senate", "ca-executive", "us-house", "us-senate", "us-executive"];

export const CHAMBER_NAME = {
  "county-board": "Board of Supervisors",
  "ca-assembly": "State Assembly",
  "ca-senate": "State Senate",
  "us-house": "U.S. House",
  "us-senate": "U.S. Senate",
  "us-executive": "Executive Branch",
  "ca-executive": "Executive Branch",
};

export const TYPE_LABELS = {
  final_passage: "Final passage",
  procedural: "Procedural",
  amendment: "Amendment",
  nomination: "Nomination",
  committee: "Committee",
  other: "Other",
};

// D1 allows at most 100 bound values per query: run `fn(chunk)` over chunks of
// `ids` and concatenate the rows.
export async function inChunks(ids, fn, size = 80) {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(...(await fn(ids.slice(i, i + size))));
  return out;
}

// Returns null when D1 isn't bound or the schema doesn't exist yet.
export async function safe(env, fn) {
  if (!env.DB) return null;
  try {
    return await fn(env.DB);
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return null;
    throw err;
  }
}

export async function officialBySlug(db, slug) {
  return db.prepare("SELECT * FROM officials WHERE slug = ? AND active = 1").bind(slug).first();
}

export async function officialsForBody(db, body) {
  const { results } = await db
    .prepare("SELECT * FROM officials WHERE body = ? AND active = 1 ORDER BY COALESCE(rank, 999), state, CAST(district_code AS INTEGER), district, name")
    .bind(body)
    .all();
  return results;
}

export async function voteCounts(db, officialId) {
  // Counted during the sync (official_stats); counted here only before the first build.
  try {
    const row = await db.prepare("SELECT vote_count AS total, final_count AS final FROM official_stats WHERE official_id = ?").bind(officialId).first();
    if (row) return row;
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) throw err;
  }
  return db
    .prepare(
      `SELECT COUNT(*) AS total, SUM(CASE WHEN v.vote_type = 'final_passage' THEN 1 ELSE 0 END) AS final
       FROM vote_positions p JOIN votes v ON v.id = p.vote_id WHERE p.official_id = ?`
    )
    .bind(officialId)
    .first();
}

export async function votesFor(db, officialId, { all = false, limit = 50, offset = 0 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT v.*, p.position, p.raw_position, b.bill_number, b.title AS bill_title
       FROM vote_positions p
       JOIN votes v ON v.id = p.vote_id
       LEFT JOIN bills b ON b.id = v.bill_id
       WHERE p.official_id = ? AND (? = 1 OR v.vote_type = 'final_passage')
       ORDER BY v.vote_date DESC, v.id DESC
       LIMIT ? OFFSET ?`
    )
    .bind(officialId, all ? 1 : 0, limit + 1, offset)
    .all();
  return { rows: results.slice(0, limit), more: results.length > limit };
}

export async function billById(db, id) {
  return db.prepare("SELECT * FROM bills WHERE id = ?").bind(id).first();
}

// Every recorded vote on a bill, newest first, with the positions of the
// given officials only (a visitor's reps); totals are on each vote.
export async function votesOnBill(db, billId, officialIds = []) {
  const { results: votes } = await db
    .prepare("SELECT * FROM votes WHERE bill_id = ? ORDER BY vote_date DESC, id DESC")
    .bind(billId)
    .all();
  for (const v of votes) v.positions = [];
  if (votes.length && officialIds.length) {
    const results = await inChunks(votes.map((v) => v.id), async (ids) =>
      (
        await db
          .prepare(
            `SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district
             FROM vote_positions p JOIN officials o ON o.id = p.official_id
             WHERE p.vote_id IN (${ids.map(() => "?").join(",")}) AND p.official_id IN (${officialIds.map(() => "?").join(",")})
             ORDER BY o.name`
          )
          .bind(...ids, ...officialIds)
          .all()
      ).results, 60);
    for (const v of votes) v.positions = results.filter((p) => p.vote_id === v.id);
  }
  return votes;
}

export const BILLS_PER_PAGE = 20;

/**
 * One page of the Laws list, newest first, from bill_list (built during the
 * sync; never computed from the votes tables on a visit). all: every bill with
 * a recorded vote; otherwise only bills with a final-passage vote. Returns
 * null if the list hasn't been built yet (no table, or an empty table the sync
 * hasn't filled).
 */
export async function billList(db, { level, all = false, limit = BILLS_PER_PAGE, offset = 0 }) {
  const order = all ? "last_vote" : "last_final";
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM bill_list WHERE level = ? ${all ? "" : "AND last_final IS NOT NULL"}
         ORDER BY ${order} DESC, bill_id DESC LIMIT ? OFFSET ?`
      )
      .bind(level, limit + 1, offset)
      .all();
    if (!results.length && !offset && !(await summariesBuilt(db))) return null;
    return { rows: results.slice(0, limit), more: results.length > limit };
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return null;
    throw err;
  }
}

/** Whether the sync has built the page summaries at least once (an empty bill_list may just be new). */
async function summariesBuilt(db) {
  const row = await db.prepare("SELECT value FROM sync_state WHERE key = 'summaries_fingerprint'").first();
  return Boolean(row && row.value);
}

// Most recent final-passage votes by the given officials (ids), newest first,
// each with those officials' positions. level: "federal" | "state" | null (all).
export async function recentFinalVotes(db, { level = null, limit = 3, offset = 0, officialIds = [] } = {}) {
  if (!officialIds.length) return { rows: [], more: false };
  const ids = officialIds.map(() => "?").join(",");
  const { results } = await db
    .prepare(
      `SELECT v.*, b.bill_number, b.title AS bill_title FROM votes v
       LEFT JOIN bills b ON b.id = v.bill_id
       WHERE v.vote_type = 'final_passage' AND (? IS NULL OR v.level = ?)
         AND EXISTS (SELECT 1 FROM vote_positions p WHERE p.vote_id = v.id AND p.official_id IN (${ids}))
       ORDER BY v.vote_date DESC, v.id DESC LIMIT ? OFFSET ?`
    )
    .bind(level, level, ...officialIds, limit + 1, offset)
    .all();
  const rows = results.slice(0, limit);
  if (rows.length) {
    const { results: pos } = await db
      .prepare(
        `SELECT p.vote_id, p.position, p.raw_position, o.name, o.slug, o.office, o.district FROM vote_positions p
         JOIN officials o ON o.id = p.official_id
         WHERE p.vote_id IN (${rows.map(() => "?").join(",")}) AND p.official_id IN (${ids}) ORDER BY o.name`
      )
      .bind(...rows.map((r) => r.id), ...officialIds)
      .all();
    for (const r of rows) r.positions = pos.filter((p) => p.vote_id === r.id);
  }
  return { rows, more: results.length > limit };
}

// ---------------------------------------------------------------------------
// Whose reps: a visitor's districts (functions/_lib/districts.js), or
// Calaveras County's own districts, which the sync records as "home_districts".

export async function homeDistricts(db) {
  try {
    const row = await db.prepare("SELECT value FROM sync_state WHERE key = 'home_districts'").first();
    const d = row ? JSON.parse(row.value) : null;
    if (d && d.st) return { ...d, co: "06009" };
  } catch (_) {}
  // Before the first sync records them: the county and its state only.
  return { st: "CA", co: "06009" };
}

/** The active officials for a WHERE clause from repsWhere(), in ballot order. */
/**
 * Runs an officials query with each official's recorded-vote count
 * (vote_count) from official_stats, counted during the sync. Before the first
 * build, vote_count is null rather than counted from every position here.
 * `sql(counts)` builds the query from counts.select and counts.join.
 */
export async function withVoteCounts(db, sql, binds = []) {
  const counts = { select: ", s.vote_count AS vote_count", join: "LEFT JOIN official_stats s ON s.official_id = o.id" };
  try {
    return (await db.prepare(sql(counts)).bind(...binds).all()).results;
  } catch (err) {
    if (!/no such table/i.test(String(err && err.message))) throw err;
    return (await db.prepare(sql({ select: ", NULL AS vote_count", join: "" })).bind(...binds).all()).results;
  }
}

export async function officialsWhere(db, where) {
  const results = await withVoteCounts(db, (counts) => `SELECT o.*${counts.select} FROM officials o ${counts.join} WHERE ${where.sql}`, where.binds);
  return results.sort(
    (a, b) =>
      CHAMBER_ORDER.indexOf(b.chamber) - CHAMBER_ORDER.indexOf(a.chamber) ||
      String(a.district || "").localeCompare(String(b.district || ""), undefined, { numeric: true }) ||
      a.name.localeCompare(b.name)
  );
}
