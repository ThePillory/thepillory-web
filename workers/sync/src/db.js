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
import init0019 from "../migrations/0019_promises_auto.sql";
import init0020 from "../migrations/0020_all_states.sql";
import init0021 from "../migrations/0021_ballot_lookups.sql";
import init0022 from "../migrations/0022_candidate_platforms.sql";
import init0023 from "../migrations/0023_plain_summaries.sql";
import init0024 from "../migrations/0024_trades.sql";
import init0025 from "../migrations/0025_executive_trades.sql";
import init0026 from "../migrations/0026_trade_scans.sql";
import init0027 from "../migrations/0027_trade_scans_auto.sql";
import init0028 from "../migrations/0028_form700_lines.sql";
import init0029 from "../migrations/0029_lobbying_more.sql";
import init0030 from "../migrations/0030_dark_money.sql";
import init0031 from "../migrations/0031_gov_money.sql";
import init0032 from "../migrations/0032_bill_number_search.sql";
import init0033 from "../migrations/0033_awards_queue.sql";
import init0034 from "../migrations/0034_source_health.sql";
import init0035 from "../migrations/0035_trade_scan_rows.sql";
import init0036 from "../migrations/0036_networth.sql";
import init0037 from "../migrations/0037_networth_scans.sql";
import init0038 from "../migrations/0038_corrections.sql";
import init0039 from "../migrations/0039_networth_scan_pages.sql";
import init0040 from "../migrations/0040_dark_money_reread.sql";
import init0041 from "../migrations/0041_measure_constitution.sql";
import init0042 from "../migrations/0042_records.sql";
import init0043 from "../migrations/0043_senate_class.sql";
import init0044 from "../migrations/0044_analysis_resolutions.sql";
import init0045 from "../migrations/0045_ai_usage.sql";
import init0046 from "../migrations/0046_usage.sql";
import init0047 from "../migrations/0047_company_taxes.sql";
import init0048 from "../migrations/0048_email.sql";
import init0049 from "../migrations/0049_company_tax_reader.sql";
import init0050 from "../migrations/0050_passages.sql";
import { isHttp, today } from "./util.js";
import { totals } from "./rollcall.js";
import { differs } from "./upsert.js";
export { differs, syncScope } from "./upsert.js";

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
  ["0019_promises_auto.sql", init0019],
  ["0020_all_states.sql", init0020],
  ["0021_ballot_lookups.sql", init0021],
  ["0022_candidate_platforms.sql", init0022],
  ["0023_plain_summaries.sql", init0023],
  ["0024_trades.sql", init0024],
  ["0025_executive_trades.sql", init0025],
  ["0026_trade_scans.sql", init0026],
  ["0027_trade_scans_auto.sql", init0027],
  ["0028_form700_lines.sql", init0028],
  ["0029_lobbying_more.sql", init0029],
  ["0030_dark_money.sql", init0030],
  ["0031_gov_money.sql", init0031],
  ["0032_bill_number_search.sql", init0032],
  ["0033_awards_queue.sql", init0033],
  ["0034_source_health.sql", init0034],
  ["0035_trade_scan_rows.sql", init0035],
  ["0036_networth.sql", init0036],
  ["0037_networth_scans.sql", init0037],
  ["0038_corrections.sql", init0038],
  ["0039_networth_scan_pages.sql", init0039],
  ["0040_dark_money_reread.sql", init0040],
  ["0041_measure_constitution.sql", init0041],
  ["0042_records.sql", init0042],
  ["0043_senate_class.sql", init0043],
  ["0044_analysis_resolutions.sql", init0044],
  ["0045_ai_usage.sql", init0045],
  ["0046_usage.sql", init0046],
  ["0047_company_taxes.sql", init0047],
  ["0048_email.sql", init0048],
  ["0049_company_tax_reader.sql", init0049],
  ["0050_passages.sql", init0050],
];

// Migrations tools/load_trades.py can also apply (the "Load stock trades"
// workflow may run before the Worker). If the change is already there, the
// migration is only recorded: 0025 rebuilds trade_reports and would drop the
// columns it added, and 0026's ALTERs would fail, if run twice.
const hasColumn = async (db, table, column) =>
  (await db.prepare(`PRAGMA table_info(${table})`).all()).results.some((c) => c.name === column);
const ALREADY_APPLIED = {
  "0025_executive_trades.sql": (db) => hasColumn(db, "trade_reports", "request_url"),
  "0026_trade_scans.sql": (db) => hasColumn(db, "trade_reports", "transcribed_by"),
  "0027_trade_scans_auto.sql": (db) => hasColumn(db, "trade_scans", "spot_check"),
  "0030_dark_money.sql": (db) => hasColumn(db, "fec_committees", "ein"),
  "0035_trade_scan_rows.sql": (db) => hasColumn(db, "trade_scans", "rows_total"),
  // Applied by hand (`wrangler d1 migrations apply`) before the Worker runs: only record it.
  "0043_senate_class.sql": (db) => hasColumn(db, "officials", "senate_class"),
  // Its ALTER can't run twice; the column there means the whole migration was applied.
  "0048_email.sql": (db) => hasColumn(db, "waitlist", "email_invited_at"),
  // tools/build_company_taxes.py may apply it first (the "Refresh company taxes" workflow).
  "0049_company_tax_reader.sql": (db) => hasColumn(db, "company_tax_filings", "reader"),
  // Its ALTERs can't run twice; the last column there means the whole migration was applied.
  "0050_passages.sql": (db) => hasColumn(db, "bill_list", "passage_date"),
};

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
    if (ALREADY_APPLIED[name] && (await ALREADY_APPLIED[name](db))) {
      await db.prepare("INSERT OR IGNORE INTO d1_migrations (name) VALUES (?)").bind(name).run();
      continue;
    }
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
         rank = excluded.rank, active = 1, updated_at = excluded.updated_at
       WHERE officials.active IS NOT 1 OR officials.last_verified IS NOT excluded.last_verified
         OR excluded.detail_checked IS NOT NULL AND officials.detail_checked IS NOT excluded.detail_checked
         OR ${differs("officials", ["name", "last_name", "office", "level", "chamber", "body", "district", "party", "term_start", "term_end", "website", "photo_url", "photo_credit", "source_url", "bioguide_id", "openstates_id", "state", "district_code", "rank"])}`
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
         source_url = excluded.source_url, updated_at = excluded.updated_at
       WHERE ${differs("bills", ["title", "official_url", "source_url"])}`
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
           updated_at = excluded.updated_at
         WHERE ${differs("votes", ["bill_id", "subject", "vote_date", "question", "vote_type", "result", "source_url", "yea", "nay", "present", "not_voting"])}`
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
           ON CONFLICT(vote_id, official_id) DO UPDATE SET position = excluded.position, raw_position = excluded.raw_position
           WHERE ${differs("vote_positions", ["position", "raw_position"])}`
        )
        .bind(v.id, p.official_id, p.position, p.raw_position)
    );
  }
  await db.batch(stmts);
}

/**
 * One vote of a state outside California (src/state-votes-api.js), stored like the bulk
 * loader's (tools/load_state_votes.py): the vote with its stable integer key (v.k), and each
 * member's position in the compact state_positions table ({member_k, position: 0-3, raw}).
 * A row is written only when a value changed (D1 bills every row written).
 */
export async function saveStateVote(db, v, positions) {
  requireSource("vote", v.id, v.source_url);
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay, present, not_voting, k, updated_at)
         VALUES (?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, vote_date = excluded.vote_date, question = excluded.question,
           vote_type = excluded.vote_type, result = excluded.result, source_url = excluded.source_url, yea = excluded.yea,
           nay = excluded.nay, present = excluded.present, not_voting = excluded.not_voting, k = excluded.k, updated_at = excluded.updated_at
         WHERE votes.bill_id IS NOT excluded.bill_id OR votes.vote_date IS NOT excluded.vote_date OR votes.question IS NOT excluded.question
           OR votes.vote_type IS NOT excluded.vote_type OR votes.result IS NOT excluded.result OR votes.source_url IS NOT excluded.source_url
           OR votes.yea IS NOT excluded.yea OR votes.nay IS NOT excluded.nay OR votes.present IS NOT excluded.present
           OR votes.not_voting IS NOT excluded.not_voting OR votes.k IS NOT excluded.k`
      )
      .bind(v.id, v.bill_id || null, v.chamber, v.vote_date, v.question, v.vote_type, v.result, v.source_url, ...totals(v.totals), v.k),
  ];
  for (const p of positions) {
    if (p.position == null || p.member_k == null) continue; // a position that isn't Yes, No, Present or Not voting isn't stored
    stmts.push(
      db
        .prepare(
          `INSERT INTO state_positions (vote_k, member_k, position, raw) VALUES (?, ?, ?, ?)
           ON CONFLICT(vote_k, member_k) DO UPDATE SET position = excluded.position, raw = excluded.raw
           WHERE state_positions.position IS NOT excluded.position OR state_positions.raw IS NOT excluded.raw`
        )
        .bind(v.k, p.member_k, p.position, p.raw ?? null)
    );
  }
  await db.batch(stmts);
}

// Vote IDs already saved with their totals. Votes saved before totals were
// read (yea IS NULL) aren't included, so they are fetched once more: that
// fills in the totals and every member's position.
export async function existingVoteIds(db, prefix) {
  // A key range, not LIKE: SQLite's LIKE ignores case, so it can't use the primary key and read
  // every row of votes (every state's) on each call; the range reads only this session's votes.
  const { results } = await db.prepare("SELECT id FROM votes WHERE id >= ? AND id < ? AND yea IS NOT NULL").bind(prefix, `${prefix}\uffff`).all();
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
