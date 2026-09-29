// Schema setup and the upserts every sync step shares.
import init0001 from "../migrations/0001_init.sql";
import init0002 from "../migrations/0002_analysis.sql";
import { isHttp, today } from "./util.js";

const MIGRATIONS = [
  ["0001_init.sql", init0001],
  ["0002_analysis.sql", init0002],
];

function statements(sql) {
  return sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * Apply any migrations not yet applied. Uses the same d1_migrations table as
 * `wrangler d1 migrations apply`, so either way of applying them works.
 */
export async function ensureSchema(db) {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    )
    .run();
  const { results } = await db.prepare("SELECT name FROM d1_migrations").all();
  const done = new Set(results.map((r) => r.name));
  for (const [name, sql] of MIGRATIONS) {
    if (done.has(name)) continue;
    await db.batch([
      ...statements(sql).map((q) => db.prepare(q)),
      db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").bind(name),
    ]);
  }
}

export async function log(db, run, step, status, requests, message, startedAt) {
  await db
    .prepare(
      "INSERT INTO sync_log (run_id, trigger, step, status, requests, message, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
    )
    .bind(run.id, run.trigger, step, status, requests, message || null, startedAt, new Date().toISOString())
    .run();
}

function requireSource(kind, id, url) {
  if (!isHttp(url)) throw new Error(`${kind} ${id} has no http(s) source URL; not saved`);
}

async function uniqueSlug(db, id, base) {
  let slug = base || "official";
  for (let n = 2; ; n++) {
    const row = await db.prepare("SELECT id FROM officials WHERE slug = ?").bind(slug).first();
    if (!row || row.id === id) return slug;
    slug = `${base}-${n}`;
  }
}

export async function upsertOfficial(db, o) {
  requireSource("official", o.id, o.source_url);
  const existing = await db.prepare("SELECT slug FROM officials WHERE id = ?").bind(o.id).first();
  const slug = existing ? existing.slug : await uniqueSlug(db, o.id, o.slug);
  await db
    .prepare(
      `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party,
         term_start, term_end, website, photo_url, photo_credit, source_url, last_verified,
         bioguide_id, openstates_id, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, last_name = excluded.last_name, office = excluded.office,
         level = excluded.level, chamber = excluded.chamber, body = excluded.body,
         district = excluded.district, party = excluded.party, term_start = excluded.term_start,
         term_end = excluded.term_end, website = excluded.website, photo_url = excluded.photo_url,
         photo_credit = excluded.photo_credit, source_url = excluded.source_url,
         last_verified = excluded.last_verified, bioguide_id = excluded.bioguide_id,
         openstates_id = excluded.openstates_id, active = 1, updated_at = excluded.updated_at`
    )
    .bind(
      o.id, slug, o.name, o.last_name || null, o.office, o.level, o.chamber, o.body,
      o.district || null, o.party || null, o.term_start || null, o.term_end || null,
      o.website || null, o.photo_url || null, o.photo_credit || null, o.source_url,
      o.last_verified || today(), o.bioguide_id || null, o.openstates_id || null
    )
    .run();
}

// Mark officials for a chamber inactive unless they're in `keepIds` (e.g. after an election).
export async function deactivateOthers(db, chamber, keepIds) {
  const placeholders = keepIds.map(() => "?").join(",") || "''";
  await db
    .prepare(`UPDATE officials SET active = 0, updated_at = datetime('now') WHERE chamber = ? AND id NOT IN (${placeholders})`)
    .bind(chamber, ...keepIds)
    .run();
}

export async function activeOfficials(db, chamber) {
  const { results } = await db
    .prepare("SELECT * FROM officials WHERE chamber = ? AND active = 1")
    .bind(chamber)
    .all();
  return results;
}

export async function upsertBill(db, b) {
  requireSource("bill", b.id, b.source_url);
  // summary is written by people; a sync never overwrites it.
  await db
    .prepare(
      `INSERT INTO bills (id, level, chamber, bill_number, session, title, official_url, source_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET title = excluded.title, official_url = excluded.official_url,
         source_url = excluded.source_url, updated_at = excluded.updated_at`
    )
    .bind(b.id, b.level, b.chamber, b.bill_number, b.session, b.title, b.official_url || null, b.source_url)
    .run();
}

export async function billExists(db, id) {
  return !!(await db.prepare("SELECT 1 AS x FROM bills WHERE id = ?").bind(id).first());
}

/** Save a vote and our officials' positions on it, in one batch. */
export async function saveVote(db, v, positions) {
  requireSource("vote", v.id, v.source_url);
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (id, bill_id, subject, level, chamber, vote_date, question, vote_type, result, source_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, subject = excluded.subject,
           vote_date = excluded.vote_date, question = excluded.question, vote_type = excluded.vote_type,
           result = excluded.result, source_url = excluded.source_url, updated_at = excluded.updated_at`
      )
      .bind(v.id, v.bill_id || null, v.subject || null, v.level, v.chamber, v.vote_date, v.question, v.vote_type, v.result, v.source_url),
  ];
  for (const p of positions) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, ?, ?, ?)
           ON CONFLICT(vote_id, official_id) DO UPDATE SET position = excluded.position, raw_position = excluded.raw_position`
        )
        .bind(v.id, p.official_id, p.position, p.raw_position)
    );
  }
  await db.batch(stmts);
}

export async function existingVoteIds(db, prefix) {
  const { results } = await db.prepare("SELECT id FROM votes WHERE id LIKE ?").bind(`${prefix}%`).all();
  return new Set(results.map((r) => r.id));
}
