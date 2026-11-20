// /status, kept light. Counting the big tables (votes, vote_positions, state_positions, bills,
// bill_list) on every visit overloaded D1 while a run was going ("D1 DB is overloaded. Requests
// queued for too long.", Nov 14, 2026), so the sync counts them once per round into status_counts
// (migration 0051) and /status reads only that table, with "as of". Its other queries read by an
// index (bill_analyses_current_review, sync_log's primary key) or a small table. If D1 is still
// busy, /status returns what it has with a note instead of failing.

import { summarizeFlags } from "./analysis/flags.js";
import { isTransient } from "./d1retry.js";
import { REVIEW_PROMPT_VERSION } from "./analysis/review.js";

/** The counts the sync records each round. Only this module counts these tables. */
export const COUNTED = [
  ["officials", "SELECT COUNT(*) AS n FROM officials WHERE active = 1"],
  ["bills", "SELECT COUNT(*) AS n FROM bills"],
  ["votes", "SELECT COUNT(*) AS n FROM votes"],
  ["vote_positions", "SELECT COUNT(*) AS n FROM vote_positions"],
  ["state_positions", "SELECT COUNT(*) AS n FROM state_positions"],
  ["laws_page_bills", "SELECT COUNT(*) AS n FROM bill_list"],
  ["bills_skipped_as_ceremonial", "SELECT COUNT(*) AS n FROM bill_relevance WHERE verdict = 'skip' AND override IS NULL"],
];

export const BUSY = "The database is busy with the sync; try again in a minute.";

/** Counts the big tables once (called at the end of each sync round). Each count is its own query. */
export async function recordStatusCounts(db, now = new Date().toISOString()) {
  const stmts = [];
  for (const [name, sql] of COUNTED) {
    try {
      const row = await db.prepare(sql).first();
      stmts.push(
        db
          .prepare("INSERT INTO status_counts (name, value, as_of) VALUES (?, ?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value, as_of = excluded.as_of")
          .bind(name, Number((row && row.n) || 0), now)
      );
    } catch (err) {
      if (!/no such table/i.test(err.message || "")) throw err; // a table a later migration adds
    }
  }
  if (stmts.length) await db.batch(stmts);
  return stmts.length;
}

// What /status reads live: small tables or an index, never a COUNT over the big ones.
export const LIVE = {
  counts: "SELECT name, value, as_of FROM status_counts",
  analyses:
    "SELECT status, ai_review, COUNT(*) AS n FROM bill_analyses WHERE current = 1 AND status IN ('ai_draft', 'reviewed') GROUP BY status, ai_review",
  recent: "SELECT * FROM sync_log ORDER BY id DESC LIMIT 30",
  flags: `SELECT bill_id, ai_review, ai_review_detail FROM bill_analyses
          WHERE current = 1 AND status = 'ai_draft' AND (ai_review = 'flag' OR json_extract(ai_review_detail, '$.previous') IS NOT NULL)`,
};

/** /status's database part: { counts, counts_as_of, recent_log, ai_review_flags, note? }. */
export async function statusReport(db) {
  const out = { counts: null, counts_as_of: null, recent_log: [], ai_review_flags: null };
  let busy = false;
  const read = async (fn) => {
    if (busy) return null;
    try {
      return await fn();
    } catch (err) {
      if (!isTransient(err)) throw err;
      busy = true;
      return null;
    }
  };
  const counts = await read(async () => (await db.prepare(LIVE.counts).all()).results);
  if (counts && counts.length) {
    out.counts = {};
    for (const r of counts) out.counts[r.name] = r.value;
    if (out.counts.vote_positions !== undefined || out.counts.state_positions !== undefined)
      out.counts.positions = (out.counts.vote_positions || 0) + (out.counts.state_positions || 0);
    const times = counts.map((r) => r.as_of).sort();
    out.counts_as_of = times[0] === times[times.length - 1] ? times[0] : { oldest: times[0], newest: times[times.length - 1] };
  } else if (counts) {
    out.counts_note = "Not counted yet: the sync records these counts at the end of each round.";
  }
  const analyses = await read(async () => (await db.prepare(LIVE.analyses).all()).results);
  if (analyses) {
    const n = (status, review) => analyses.filter((r) => r.status === status && (review === undefined || r.ai_review === review)).reduce((s, r) => s + r.n, 0);
    out.counts = {
      ...(out.counts || {}),
      analyses_auto_checked: n("ai_draft", "pass"),
      analyses_flagged_by_ai: n("ai_draft", "flag"),
      analyses_awaiting_ai_review: n("ai_draft", null),
      analyses_reviewed: n("reviewed"),
    };
  }
  const recent = await read(async () => (await db.prepare(LIVE.recent).all()).results);
  if (recent) out.recent_log = recent;
  // Why drafts are flagged: the current flags, and the earlier reviews of drafts re-reviewed
  // under the reviewer's newer rules (with the new outcome).
  const rows = await read(async () =>
    (await db.prepare(LIVE.flags).all()).results.map((r) => ({ bill_id: r.bill_id, verdict: r.ai_review, detail: JSON.parse(r.ai_review_detail || "{}") }))
  );
  if (rows) {
    out.ai_review_flags = flagReport(rows);
  }
  if (busy) out.note = BUSY;
  return out;
}

/**
 * Flagged drafts before and after a re-review under the reviewer's current rules. `rows`: [{bill_id,
 * verdict, detail}]. Before: what the earlier review flagged, by check. After: how many now pass, and
 * the checks the ones still flagged fail now. Waiting: flags from an older reviewer version not yet
 * reviewed again (REVIEW_BACKLOG_DAILY a day). Pure.
 */
export function flagReport(rows, version = REVIEW_PROMPT_VERSION) {
  const flagged = rows.filter((r) => r.verdict === "flag");
  const rereviewed = rows.filter((r) => r.detail && r.detail.previous);
  const still = rereviewed.filter((r) => r.verdict === "flag");
  const old = flagged.filter((r) => String((r.detail && r.detail.version) || "") < version);
  const brief = (sum) => ({ drafts: sum.drafts, by_check: sum.by_check, by_severity: sum.by_severity });
  return {
    reviewer_version: version,
    flagged_now: summarizeFlags(flagged),
    rereviewed_under_new_rules: {
      ...summarizeFlags(rereviewed, { which: "previous" }),
      now_published: rereviewed.length - still.length,
      still_flagged: still.length,
      before: brief(summarizeFlags(rereviewed, { which: "previous" })),
      after_still_flagged: brief(summarizeFlags(still)),
    },
    waiting_for_rereview: { drafts: old.length, ...brief(summarizeFlags(old)) },
  };
}
