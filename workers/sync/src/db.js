// Schema setup and the upserts every sync step shares.
import init0001 from "../migrations/0001_init.sql";
import init0002 from "../migrations/0002_analysis.sql";
import init0003 from "../migrations/0003_meetings.sql";
import init0004 from "../migrations/0004_review_load.sql";
import init0005 from "../migrations/0005_nationwide.sql";
import init0006 from "../migrations/0006_bill_summaries.sql";
import init0007 from "../migrations/0007_funding.sql";
import init0008 from "../migrations/0008_executive.sql";
import init0009 from "../migrations/0009_executive_funding.sql";
import init0010 from "../migrations/0010_page_summaries.sql";
import init0011 from "../migrations/0011_promises.sql";
import init0012 from "../migrations/0012_state_money.sql";
import init0013 from "../migrations/0013_promise_sources.sql";
import init0014 from "../migrations/0014_platform.sql";
import init0015 from "../migrations/0015_topics.sql";
import init0016 from "../migrations/0016_history.sql";
import init0017 from "../migrations/0017_issues_pages.sql";
import init0018 from "../migrations/0018_orders.sql";
import { isHttp, today } from "./util.js";
import { totals } from "./rollcall.js";

const MIGRATIONS = [
  ["0001_init.sql", init0001],
  ["0002_analysis.sql", init0002],
  ["0003_meetings.sql", init0003],
  ["0004_review_load.sql", init0004],
  ["0005_nationwide.sql", init0005],
  ["0006_bill_summaries.sql", init0006],
  ["0007_funding.sql", init0007],
  ["0008_executive.sql", init0008],
  ["0009_executive_funding.sql", init0009],
  ["0010_page_summaries.sql", init0010],
  ["0011_promises.sql", init0011],
  ["0012_state_money.sql", init0012],
  ["0013_promise_sources.sql", init0013],
  ["0014_platform.sql", init0014],
  ["0015_topics.sql", init0015],
  ["0016_history.sql", init0016],
  ["0017_issues_pages.sql", init0017],
  ["0018_orders.sql", init0018],
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
      db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name),
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
  // claimSlug: a former officeholder's inactive row (no page of its own) gives up
  // the plain name slug, e.g. a former senator now in the Cabinet.
  if (!existing && o.claimSlug && o.slug) {
    const other = await db.prepare("SELECT id, chamber FROM officials WHERE slug = ? AND active = 0").bind(o.slug).first();
    if (other && other.id !== o.id) {
      const moved = await uniqueSlug(db, other.id, `${o.slug}-${other.chamber}`);
      await db.prepare("UPDATE officials SET slug = ? WHERE id = ?").bind(moved, other.id).run();
    }
  }
  const slug = existing ? existing.slug : await uniqueSlug(db, o.id, o.slug);
  await db
    .prepare(
      `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party,
         term_start, term_end, website, photo_url, photo_credit, source_url, last_verified,
         bioguide_id, openstates_id, state, district_code, detail_checked, rank, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name, last_name = excluded.last_name, office = excluded.office,
         level = excluded.level, chamber = excluded.chamber, body = excluded.body,
         district = excluded.district, party = excluded.party, term_start = excluded.term_start,
         term_end = excluded.term_end, website = excluded.website, photo_url = excluded.photo_url,
         photo_credit = excluded.photo_credit, source_url = excluded.source_url,
         last_verified = excluded.last_verified, bioguide_id = excluded.bioguide_id,
         openstates_id = excluded.openstates_id, state = excluded.state, district_code = excluded.district_code,
         detail_checked = COALESCE(excluded.detail_checked, officials.detail_checked),
         rank = excluded.rank, active = 1, updated_at = excluded.updated_at`
    )
    .bind(
      o.id, slug, o.name, o.last_name || null, o.office, o.level, o.chamber, o.body,
      o.district || null, o.party || null, o.term_start || null, o.term_end || null,
      o.website || null, o.photo_url || null, o.photo_credit || null, o.source_url,
      o.last_verified || today(), o.bioguide_id || null, o.openstates_id || null,
      o.state || null, o.district_code == null ? null : String(o.district_code), o.detail_checked || null,
      o.rank == null ? null : o.rank
    )
    .run();
}

// Mark officials for a chamber inactive unless they're in `keepIds` (e.g. after
// an election). D1 allows at most 100 bound values per query, and the House has
// about 440 members, so the IDs to drop are worked out here and updated in chunks.
export async function deactivateOthers(db, chamber, keepIds) {
  const keep = new Set(keepIds);
  const { results } = await db.prepare("SELECT id FROM officials WHERE chamber = ? AND active = 1").bind(chamber).all();
  const drop = results.map((r) => r.id).filter((id) => !keep.has(id));
  const stmts = [];
  for (let i = 0; i < drop.length; i += 50) {
    const chunk = drop.slice(i, i + 50);
    stmts.push(
      db
        .prepare(`UPDATE officials SET active = 0, updated_at = datetime('now') WHERE id IN (${chunk.map(() => "?").join(",")})`)
        .bind(...chunk)
    );
  }
  if (stmts.length) await db.batch(stmts);
  return drop.length;
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

/** Save a vote, its totals, and every loaded member's position on it, in one batch. */
export async function saveVote(db, v, positions) {
  requireSource("vote", v.id, v.source_url);
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (id, bill_id, subject, level, chamber, vote_date, question, vote_type, result, source_url,
           yea, nay, present, not_voting, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, subject = excluded.subject,
           vote_date = excluded.vote_date, question = excluded.question, vote_type = excluded.vote_type,
           result = excluded.result, source_url = excluded.source_url,
           yea = excluded.yea, nay = excluded.nay, present = excluded.present, not_voting = excluded.not_voting,
           updated_at = excluded.updated_at`
      )
      .bind(
        v.id, v.bill_id || null, v.subject || null, v.level, v.chamber, v.vote_date, v.question, v.vote_type, v.result, v.source_url,
        ...totals(v.totals)
      ),
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

// Vote IDs already saved with their totals. Votes saved before totals were
// read (yea IS NULL) aren't included, so they are fetched once more: that
// fills in the totals and every member's position.
export async function existingVoteIds(db, prefix) {
  const { results } = await db.prepare("SELECT id FROM votes WHERE id LIKE ? AND yea IS NOT NULL").bind(`${prefix}%`).all();
  return new Set(results.map((r) => r.id));
}

/** Map of a key (bioguide_id, lis_id, openstates_id) to official id, for matching a whole roll call. */
export async function officialIndex(db, chambers, column) {
  const { results } = await db
    .prepare(`SELECT * FROM officials WHERE active = 1 AND chamber IN (${chambers.map(() => "?").join(",")})`)
    .bind(...chambers)
    .all();
  return { all: results, by: new Map(results.filter((o) => o[column]).map((o) => [o[column], o])) };
}
