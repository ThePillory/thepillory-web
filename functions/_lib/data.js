// D1 queries for the Pages Functions. Every query only returns rows that carry
// a source URL (the schema requires one), so nothing unsourced can be shown.

export const LEVEL_ORDER = ["county", "state", "federal"];
const CHAMBER_ORDER = ["county-board", "ca-assembly", "ca-senate", "us-house", "us-senate"];

export const CHAMBER_NAME = {
  "county-board": "Board of Supervisors",
  "ca-assembly": "State Assembly",
  "ca-senate": "State Senate",
  "us-house": "U.S. House",
  "us-senate": "U.S. Senate",
};

export const TYPE_LABELS = {
  final_passage: "Final passage",
  procedural: "Procedural",
  amendment: "Amendment",
  nomination: "Nomination",
  committee: "Committee",
  other: "Other",
};

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

export async function listOfficials(db) {
  const { results } = await db.prepare(
    `SELECT o.*, (SELECT COUNT(*) FROM vote_positions p WHERE p.official_id = o.id) AS vote_count
     FROM officials o WHERE o.active = 1`
  ).all();
  return results.sort(
    (a, b) =>
      CHAMBER_ORDER.indexOf(a.chamber) - CHAMBER_ORDER.indexOf(b.chamber) ||
      String(a.district || "").localeCompare(String(b.district || ""), undefined, { numeric: true }) ||
      a.name.localeCompare(b.name)
  );
}

export async function officialBySlug(db, slug) {
  return db.prepare("SELECT * FROM officials WHERE slug = ? AND active = 1").bind(slug).first();
}

export async function officialsForBody(db, body) {
  const { results } = await db
    .prepare("SELECT * FROM officials WHERE body = ? AND active = 1 ORDER BY district, name")
    .bind(body)
    .all();
  return results;
}

export async function voteCounts(db, officialId) {
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

// Every recorded vote on a bill, with our officials' positions.
export async function votesOnBill(db, billId) {
  const { results } = await db
    .prepare(
      `SELECT v.*, p.position, p.raw_position, o.name, o.slug, o.office, o.district, o.party, o.chamber AS official_chamber
       FROM votes v
       JOIN vote_positions p ON p.vote_id = v.id
       JOIN officials o ON o.id = p.official_id
       WHERE v.bill_id = ?
       ORDER BY v.vote_date DESC, v.id DESC, o.name`
    )
    .bind(billId)
    .all();
  const byVote = new Map();
  for (const r of results) {
    if (!byVote.has(r.id)) byVote.set(r.id, { ...r, positions: [] });
    byVote.get(r.id).positions.push(r);
  }
  return [...byVote.values()];
}

export async function recentBills(db, { level = null, all = false, limit = 40 } = {}) {
  const { results } = await db
    .prepare(
      `SELECT b.*, MAX(v.vote_date) AS last_vote, COUNT(DISTINCT v.id) AS vote_count
       FROM bills b
       JOIN votes v ON v.bill_id = b.id
       JOIN vote_positions p ON p.vote_id = v.id
       WHERE (? IS NULL OR b.level = ?) AND (? = 1 OR v.vote_type = 'final_passage')
       GROUP BY b.id
       ORDER BY last_vote DESC
       LIMIT ?`
    )
    .bind(level, level, all ? 1 : 0, limit)
    .all();
  return results;
}

// Issue ↔ bill links: only approved ones are ever shown.
export async function approvedIssuesForBill(db, billId) {
  const { results } = await db
    .prepare("SELECT issue_slug, reason FROM issue_bill_links WHERE bill_id = ? AND status = 'approved'")
    .bind(billId)
    .all();
  return results;
}

export async function approvedIssuesForOfficial(db, officialId) {
  const { results } = await db
    .prepare(
      `SELECT DISTINCT l.issue_slug FROM issue_bill_links l
       JOIN votes v ON v.bill_id = l.bill_id
       JOIN vote_positions p ON p.vote_id = v.id
       WHERE l.status = 'approved' AND p.official_id = ?`
    )
    .bind(officialId)
    .all();
  return results.map((r) => r.issue_slug);
}
