// The analysis pipeline. Runs in the SyncRunner Durable Object after each sync
// (and on /analyze). Each round:
//
//   1. relevance: bills that could be analyzed get a cheap claude-haiku-4-5 check
//      (relevance.js). Ceremonial and routine measures are skipped (logged with
//      the reason); the rest are rated for local relevance.
//   2. backlog: drafts the AI reviewer hasn't looked at yet (drafts from before
//      the reviewer existed, or whose review failed) are reviewed now. Drafts of
//      bills the check skipped are rejected automatically.
//   3. drafting, in this order, up to ANALYSIS_DAILY_LIMIT a day:
//      - requests: from /admin/review (regenerate, full analysis) and from
//        readers ("Request full analysis" on a bill page)
//      - bills an approved issue link now needs a full analysis of
//      - new bills: linked to an issue, or with a final-passage vote by one of
//        our officials that the check didn't skip, ranked by local relevance,
//        then by the latest vote
//      For each: fetch the text, draft a card (or a full analysis when an issue
//      links to the bill or someone asked), check every quote against the stored
//      Constitution and every case against CourtListener, then the AI reviewer
//      (review.js). Pass: published as "AI-drafted, auto-checked" (a random
//      SPOT_CHECK_RATE also goes to the review queue). Flag: kept off public
//      pages and sent to the review queue with the reasons.
//
// Every earlier version is kept. Tokens are logged per call.
import { log } from "../db.js";
import { Budget, BudgetExhausted, getState, setState, redact } from "../util.js";
import { loadConstitution, PROVISIONS } from "../constitution.js";
import { fetchBillText } from "./billtext.js";
import { draftAnalysis, DraftRefused } from "./claude.js";
import { verifyQuotes, verifyCitations, sameCase } from "./verify.js";
import { makeLookup } from "./courtlistener.js";
import { PROMPT_VERSION, CARD_PROMPT_VERSION } from "./prompt.js";
import { checkRelevance, BATCH, RELEVANCE_PROMPT_VERSION } from "./relevance.js";
import { reviewDraft } from "./review.js";
import { withD1Retry } from "../d1retry.js";
import { runAgendaWatch } from "./agenda.js";

const RETRY_AFTER_DAYS = 7; // a bill that couldn't be drafted waits this long before another try
const MIN_TIME_PER_BILL_MS = 4 * 60 * 1000; // don't start a bill without this much time left in the round
const MAX_RELEVANCE_BATCHES = 4; // per round
const J = (x) => JSON.stringify(x);

function day() {
  return new Date().toISOString().slice(0, 10);
}

// A final-passage vote on the bill by one of our officials.
const FINAL_VOTE = `EXISTS (SELECT 1 FROM votes v JOIN vote_positions p ON p.vote_id = v.id JOIN officials o ON o.id = p.official_id
                   WHERE v.bill_id = b.id AND v.vote_type = 'final_passage')`;
// An issue on the site links to the bill (approved links only).
const LINKED = "EXISTS (SELECT 1 FROM issue_bill_links l WHERE l.bill_id = b.id AND l.status = 'approved')";
// TODO: once residents can follow bills, a bill with followers is eligible too
// (OR EXISTS (SELECT 1 FROM bill_follows f WHERE f.bill_id = b.id)).

// ---------------------------------------------------------------------------
// 1. Relevance

async function uncheckedBills(db, limit) {
  return (
    await db
      .prepare(
        `SELECT b.* FROM bills b
         WHERE NOT EXISTS (SELECT 1 FROM bill_relevance r WHERE r.bill_id = b.id)
           AND (${FINAL_VOTE}
                OR EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = b.id AND a.current = 1 AND a.status = 'ai_draft' AND a.ai_review IS NULL))
         ORDER BY (SELECT MAX(v.vote_date) FROM votes v WHERE v.bill_id = b.id) DESC, b.id LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results;
}

async function runRelevance(env, db, budget, run) {
  let checked = 0;
  let skipped = 0;
  for (let i = 0; i < MAX_RELEVANCE_BATCHES; i++) {
    const bills = await uncheckedBills(db, BATCH);
    if (!bills.length || budget.timeLeft() < MIN_TIME_PER_BILL_MS) break;
    const t0 = new Date().toISOString();
    budget.take("relevance check");
    let result;
    try {
      result = await checkRelevance(env, bills);
    } catch (err) {
      await log(db, run, "relevance", "error", 1, redact(`${err.name}: ${err.message}`), t0);
      break;
    }
    const { verdicts, model, usage } = result;
    const stmts = verdicts.map((v) =>
      db
        .prepare(
          `INSERT INTO bill_relevance (bill_id, verdict, category, reason, local, local_reason, model, prompt_version)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(bill_id) DO UPDATE SET verdict = excluded.verdict, category = excluded.category, reason = excluded.reason,
             local = excluded.local, local_reason = excluded.local_reason, model = excluded.model,
             prompt_version = excluded.prompt_version, checked_at = datetime('now')`
        )
        .bind(v.bill_id, v.verdict, v.category, v.reason, v.local, v.local_reason, model, RELEVANCE_PROMPT_VERSION)
    );
    if (stmts.length) await db.batch(stmts);
    const skips = verdicts.filter((v) => v.verdict === "skip");
    for (const v of skips) await log(db, run, "relevance-skip", "skipped", 0, `${v.bill_id}: ${v.category}: ${v.reason}`, t0);
    checked += verdicts.length;
    skipped += skips.length;
    const missing = bills.length - verdicts.length;
    await log(
      db,
      run,
      "relevance",
      "ok",
      1,
      `${verdicts.length} bill(s) checked, ${skips.length} skipped as ceremonial or routine${missing ? `, ${missing} not answered (tried again next round)` : ""}; model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}`,
      t0
    );
    if (missing === bills.length) break; // nothing usable came back; don't loop
  }
  return { checked, skipped };
}

// ---------------------------------------------------------------------------
// Saving

function spotCheck(env) {
  const rate = Math.min(1, Math.max(0, parseFloat(env.SPOT_CHECK_RATE || "0.1") || 0));
  const r = crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
  return r < rate ? 1 : 0;
}

function reviewColumns(env, review) {
  if (!review) return [null, "{}", null, null, null, 0];
  const pass = review.verdict === "pass";
  return [
    review.verdict,
    J({ verdict: review.verdict, checks: review.checks, reasons: review.reasons }),
    review.model,
    J({ input: review.usage.input_tokens, output: review.usage.output_tokens, cache_read: review.usage.cache_read_tokens }),
    new Date().toISOString().replace("T", " ").slice(0, 19),
    pass ? spotCheck(env) : 0,
  ];
}

async function save(env, db, bill, source, draft, meta) {
  const prev = await db.prepare("SELECT * FROM bill_analyses WHERE bill_id = ? AND current = 1").bind(bill.id).first();
  const basisNote =
    source.basis === "summary_only"
      ? "limited: based on summary only."
      : source.basis === "partial_text"
        ? `limited: based on ${source.note} of the bill text.`
        : null;
  const insert = db
    .prepare(
      `INSERT INTO bill_analyses (bill_id, current, status, depth, basis, basis_note, text_version, text_source_url,
         plain_summary, clauses, aligns, tension, departure, article_v, readings, citations, uncertainty,
         model, prompt_version, quote_check, citation_check,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         ai_review, ai_review_detail, ai_review_model, ai_review_tokens, ai_reviewed_at, spot_check)
       VALUES (?, 1, 'ai_draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      bill.id,
      meta.depth,
      source.basis,
      basisNote,
      source.version || null,
      source.source_url,
      draft.plain_summary || "",
      J(draft.clauses || []),
      J(draft.aligns || []),
      J(draft.tension || []),
      J(draft.departure || []),
      draft.article_v || "",
      J(draft.readings || []),
      J(draft.citations || []),
      draft.uncertainty || "",
      meta.model,
      meta.depth === "card" ? CARD_PROMPT_VERSION : PROMPT_VERSION,
      J(meta.quoteCheck),
      J(meta.citationCheck),
      meta.usage.input_tokens,
      meta.usage.output_tokens,
      meta.usage.cache_read_tokens,
      meta.usage.cache_write_tokens,
      ...reviewColumns(env, meta.review)
    );
  const stmts = [];
  if (prev) {
    // Every current draft of this bill, not just prev.id, so that a batch
    // repeated after a temporary D1 error still leaves exactly one current draft.
    stmts.push(db.prepare("UPDATE bill_analyses SET current = 0 WHERE bill_id = ? AND current = 1").bind(bill.id));
    stmts.push(
      db
        .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, 'superseded', 'pipeline', ?, ?)")
        .bind(prev.id, bill.id, meta.depth !== prev.depth ? `replaced by a ${meta.depth === "full" ? "full analysis" : "card"}` : "replaced by a regenerated draft", J(prev))
    );
    // Reader flags were about the old version.
    stmts.push(
      db
        .prepare("UPDATE analysis_flags SET status = 'resolved', resolution = 'superseded', resolved_by = 'pipeline', resolved_at = datetime('now') WHERE bill_id = ? AND status = 'open'")
        .bind(bill.id)
    );
  }
  stmts.push(insert);
  await db.batch(stmts);
  const row = await db.prepare("SELECT * FROM bill_analyses WHERE bill_id = ? AND current = 1").bind(bill.id).first();
  const why = bill.request_id ? (bill.request_source === "reader" ? "a reader asked for a full analysis" : "requested at /admin/review") : bill.upgrade ? "an issue now links to this bill" : null;
  await db
    .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, 'created', 'pipeline', ?, ?)")
    .bind(row.id, bill.id, why, J(row))
    .run();
  return row;
}

async function saveReview(env, db, row, review) {
  const [verdict, detail, model, tokens, at, spot] = reviewColumns(env, review);
  await db
    .prepare("UPDATE bill_analyses SET ai_review = ?, ai_review_detail = ?, ai_review_model = ?, ai_review_tokens = ?, ai_reviewed_at = ?, spot_check = ? WHERE id = ?")
    .bind(verdict, detail, model, tokens, at, spot, row.id)
    .run();
  return spot;
}

function reviewNote(review, spot) {
  if (!review) return "AI review pending (tried again next run)";
  if (review.verdict === "pass") return `AI reviewer: pass (published as auto-checked${spot ? "; picked for a spot check" : ""})`;
  return `AI reviewer: flag, sent to the review queue (${review.reasons.length} reason(s))`;
}

// ---------------------------------------------------------------------------
// 2. Backlog: drafts the AI reviewer hasn't seen

async function reviewBacklog(env, db, budget, run) {
  const limit = parseInt(env.REVIEW_BACKLOG_DAILY || "10", 10);
  const key = `review_backlog_${day()}`;
  let used = parseInt((await getState(db, key)) || "0", 10);
  const rows = (
    await db
      .prepare(
        `SELECT a.*, b.bill_number, b.title, b.level, b.session, b.chamber, b.official_url, b.summary AS bill_summary, b.source_url AS bill_source_url,
                r.verdict AS rel_verdict, r.category AS rel_category, r.reason AS rel_reason, r.override AS rel_override
         FROM bill_analyses a JOIN bills b ON b.id = a.bill_id LEFT JOIN bill_relevance r ON r.bill_id = a.bill_id
         WHERE a.current = 1 AND a.status = 'ai_draft' AND a.ai_review IS NULL
         ORDER BY a.created_at, a.id LIMIT 25`
      )
      .all()
  ).results;
  let rejected = 0;
  let reviewed = 0;
  for (const row of rows) {
    const t0 = new Date().toISOString();
    // Ceremonial or routine: rejected without a review call.
    if (row.rel_verdict === "skip" && row.rel_override !== "unskip") {
      const { rel_verdict, rel_category, rel_reason, rel_override, bill_number, title, level, session, chamber, official_url, bill_summary, bill_source_url, ...snapshot } = row;
      await db.batch([
        db
          .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, 'rejected', 'pipeline', ?, ?)")
          .bind(row.id, row.bill_id, `Rejected automatically by the relevance check (${rel_category}): ${rel_reason}`, J(snapshot)),
        db.prepare("UPDATE bill_analyses SET status = 'rejected', reviewed_at = datetime('now') WHERE id = ?").bind(row.id),
      ]);
      rejected += 1;
      await log(db, run, "analysis-backlog", "ok", 0, `${row.bill_id}: analysis ${row.id} rejected automatically: ${rel_category}: ${rel_reason}`, t0);
      continue;
    }
    if (!row.rel_verdict) continue; // relevance not checked yet; next round
    if (used >= limit || budget.timeLeft() < MIN_TIME_PER_BILL_MS) break;
    const bill = { id: row.bill_id, bill_number: row.bill_number, title: row.title, level: row.level, session: row.session, chamber: row.chamber, official_url: row.official_url, summary: row.bill_summary || "", source_url: row.bill_source_url };
    const before = budget.used;
    try {
      const source = await fetchBillText(env, budget, bill);
      if (!source) {
        await log(db, run, "analysis-backlog", "skipped", budget.used - before, `${row.bill_id}: no bill text to review against; tried again tomorrow`, t0);
        continue;
      }
      budget.take(`AI reviewer ${row.bill_id}`);
      const draft = {
        plain_summary: row.plain_summary,
        clauses: JSON.parse(row.clauses || "[]"),
        aligns: JSON.parse(row.aligns || "[]"),
        tension: JSON.parse(row.tension || "[]"),
        departure: JSON.parse(row.departure || "[]"),
        article_v: row.article_v,
        readings: JSON.parse(row.readings || "[]"),
        citations: JSON.parse(row.citations || "[]"),
        uncertainty: row.uncertainty,
      };
      const review = await reviewDraft(env, bill, source, draft, row.depth || "full");
      const spot = await saveReview(env, db, row, review);
      used += 1;
      await setState(db, key, String(used));
      reviewed += 1;
      await log(db, run, "analysis-backlog", "ok", budget.used - before, `${row.bill_id}: analysis ${row.id}: ${reviewNote(review, spot)}; model ${review.model}; tokens in ${review.usage.input_tokens}, out ${review.usage.output_tokens}`, t0);
    } catch (err) {
      if (err instanceof BudgetExhausted) break;
      await log(db, run, "analysis-backlog", "error", budget.used - before, `${row.bill_id}: ${redact(`${err.name}: ${err.message}`)}`, t0);
    }
  }
  return { rejected, reviewed };
}

// ---------------------------------------------------------------------------
// 3. Drafting

const RANK = "CASE r.local WHEN 'high' THEN 3 WHEN 'medium' THEN 2 WHEN 'low' THEN 1 ELSE 0 END";

async function nextBills(db, limit) {
  // Requests first: yours from /admin/review, then readers', oldest first.
  const requested = (
    await db
      .prepare(
        `SELECT r.id AS request_id, r.depth AS request_depth, r.source AS request_source, b.*,
                (SELECT a.depth FROM bill_analyses a WHERE a.bill_id = b.id AND a.current = 1) AS current_depth,
                ${LINKED} AS linked
         FROM analysis_requests r JOIN bills b ON b.id = r.bill_id
         WHERE r.status = 'pending' ORDER BY r.source = 'reader', r.requested_at LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results.map((b) => ({ ...b, depth: b.request_depth || b.current_depth || (b.linked ? "full" : "card") }));
  if (requested.length >= limit) return requested;
  const retry = `NOT EXISTS (SELECT 1 FROM analysis_attempts t WHERE t.bill_id = b.id AND t.last_attempt > datetime('now', '-${RETRY_AFTER_DAYS} days'))`;
  // Bills an issue now links to, whose current analysis is only a card.
  const upgrades = (
    await db
      .prepare(
        `SELECT b.* FROM bills b JOIN bill_analyses a ON a.bill_id = b.id AND a.current = 1
         WHERE a.depth = 'card' AND a.status != 'rejected' AND ${LINKED} AND ${retry} LIMIT ?`
      )
      .bind(limit - requested.length)
      .all()
  ).results.map((b) => ({ ...b, depth: "full", upgrade: true }));
  const fresh = (
    await db
      .prepare(
        `SELECT b.*, ${LINKED} AS linked, ${RANK} AS local_rank,
                (SELECT MAX(v.vote_date) FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage') AS last_vote
         FROM bills b LEFT JOIN bill_relevance r ON r.bill_id = b.id
         WHERE NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = b.id)
           AND ${retry}
           AND (${LINKED} OR (${FINAL_VOTE} AND (r.verdict = 'analyze' OR r.override = 'unskip')))
         ORDER BY linked DESC, local_rank DESC, last_vote DESC, b.id LIMIT ?`
      )
      .bind(Math.max(0, limit - requested.length - upgrades.length))
      .all()
  ).results.map((b) => ({ ...b, depth: b.linked ? "full" : "card" }));
  const seen = new Set();
  return [...requested, ...upgrades, ...fresh].filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));
}

async function noteAttempt(db, billId, error) {
  await db
    .prepare(
      `INSERT INTO analysis_attempts (bill_id, attempts, last_attempt, last_error) VALUES (?, 1, datetime('now'), ?)
       ON CONFLICT(bill_id) DO UPDATE SET attempts = attempts + 1, last_attempt = excluded.last_attempt, last_error = excluded.last_error`
    )
    .bind(billId, error)
    .run();
}

async function finishRequest(db, bill, status, message) {
  if (!bill.request_id) return;
  await db
    .prepare("UPDATE analysis_requests SET status = ?, handled_at = datetime('now'), message = ? WHERE id = ?")
    .bind(status, message, bill.request_id)
    .run();
}

/** Draft, verify, review and save one bill. `bill.depth` is "card" or "full". Returns a log entry. */
export async function analyzeBill(env, db, budget, bill) {
  const depth = bill.depth === "full" ? "full" : "card";
  const source = await fetchBillText(env, budget, bill);
  if (!source) {
    const msg = "no bill text or official summary available";
    await noteAttempt(db, bill.id, msg);
    await finishRequest(db, bill, "failed", msg);
    return { status: "skipped", message: `${bill.id}: ${msg}`, counted: false };
  }
  budget.take(`Claude API ${bill.id}`);
  let result;
  try {
    result = await draftAnalysis(env, bill, source, depth);
  } catch (err) {
    const tokens = err.usage ? ` (tokens in ${err.usage.input_tokens}, out ${err.usage.output_tokens})` : "";
    const msg = redact(`${err.name}: ${err.message}`) + tokens;
    await noteAttempt(db, bill.id, msg);
    await finishRequest(db, bill, "failed", msg);
    return { status: err instanceof DraftRefused ? "skipped" : "error", message: `${bill.id}: ${msg}`, counted: true };
  }
  const { draft, model, usage, trimmed } = result;
  const quoteCheck = verifyQuotes(draft, PROVISIONS);
  for (const id of trimmed) quoteCheck.dropped.push({ id, reason: "a card keeps only the 3 most relevant provisions" });
  const citationCheck = await verifyCitations(draft, makeLookup(env, budget, sameCase));

  // The AI reviewer reads the checked draft. If the call fails, the draft is
  // saved unreviewed (so not public) and reviewed on the next run.
  let review = null;
  let reviewError = "";
  try {
    budget.take(`AI reviewer ${bill.id}`);
    review = await reviewDraft(env, bill, source, draft, depth);
  } catch (err) {
    if (err instanceof BudgetExhausted) reviewError = "; AI review waits for the next run";
    else reviewError = `; AI review failed (${redact(`${err.name}: ${err.message}`)}), tried again next run`;
  }
  const row = await save(env, db, bill, source, draft, { depth, model, usage, quoteCheck, citationCheck, review });
  await finishRequest(db, bill, "done", `analysis ${row.id}`);
  const fixes = [
    `${quoteCheck.checked} quotes checked, ${quoteCheck.replaced.length} replaced with stored text`,
    `${citationCheck.checked.length - citationCheck.removed_citations.length} of ${citationCheck.checked.length} citations verified`,
    citationCheck.removed_sentences.length ? `${citationCheck.removed_sentences.length} sentences removed` : null,
  ].filter(Boolean);
  const reviewTokens = review ? `; reviewer ${review.model}, tokens in ${review.usage.input_tokens}, out ${review.usage.output_tokens}` : "";
  return {
    status: "ok",
    counted: true,
    message:
      `${bill.id}: ${depth === "card" ? "card" : "full analysis"} ${row.id} saved (${source.basis}); model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, ` +
      `cache read ${usage.cache_read_tokens}, cache write ${usage.cache_write_tokens}; ${fixes.join("; ")}; ${reviewNote(review, row.spot_check)}${reviewTokens}${reviewError}`,
  };
}

/**
 * One round of analysis. Returns {status, analyzed, more_now}: more_now means
 * bills are waiting and today's cap isn't reached, but the round ran out of time.
 */
export async function runAnalysis(rawEnv, { deadlineMs, runId, trigger }) {
  const env = withD1Retry(rawEnv); // temporary D1 errors are retried (src/d1retry.js)
  const db = env.DB;
  const run = { id: runId, trigger };
  const started = new Date().toISOString();
  await loadConstitution(db);
  if (!env.ANTHROPIC_API_KEY) {
    await log(db, run, "analysis", "skipped", 0, "ANTHROPIC_API_KEY is not set", started);
    return { status: "skipped", analyzed: 0, more_now: false };
  }
  const limit = parseInt(env.ANALYSIS_DAILY_LIMIT || "20", 10);
  const key = `analyses_${day()}`;
  let used = parseInt((await getState(db, key)) || "0", 10);
  const budget = new Budget(env, deadlineMs);

  let relevance = { checked: 0, skipped: 0 };
  let backlog = { rejected: 0, reviewed: 0 };
  try {
    relevance = await runRelevance(env, db, budget, run);
    backlog = await reviewBacklog(env, db, budget, run);
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
  }

  let analyzed = 0;
  let stoppedEarly = false;
  const bills = used < limit ? await nextBills(db, limit - used) : [];
  for (const bill of bills) {
    if (used >= limit) break;
    if (budget.timeLeft() < MIN_TIME_PER_BILL_MS) {
      stoppedEarly = true;
      break;
    }
    const t0 = new Date().toISOString();
    const before = budget.used;
    let r;
    try {
      r = await analyzeBill(env, db, budget, bill);
    } catch (err) {
      if (err instanceof BudgetExhausted) {
        stoppedEarly = true;
        break;
      }
      r = { status: "error", message: `${bill.id}: ${redact(`${err.name}: ${err.message}`)}`, counted: false };
      await noteAttempt(db, bill.id, r.message);
      await finishRequest(db, bill, "failed", r.message);
    }
    if (r.counted) {
      used += 1;
      await setState(db, key, String(used));
    }
    if (r.status === "ok") analyzed += 1;
    console.log(`[${runId}] analysis ${r.status}: ${r.message}`);
    await log(db, run, "analysis", r.status, budget.used - before, r.message, t0);
  }
  // More relevance checks wait only if this round's check made progress (a failing check doesn't loop).
  const unchecked = relevance.checked > 0 && (await uncheckedBills(db, 1)).length > 0;
  const waiting = used < limit && (stoppedEarly || unchecked || (await nextBills(db, 1)).length > 0);
  const summary =
    used >= limit
      ? `daily limit of ${limit} drafts reached; the rest wait for tomorrow`
      : waiting
        ? "more bills waiting; continuing"
        : "no bills waiting";
  await log(
    db,
    run,
    "analysis-round",
    "ok",
    budget.used,
    `${relevance.checked} bill(s) checked for relevance (${relevance.skipped} skipped); ${backlog.reviewed} earlier draft(s) reviewed, ${backlog.rejected} rejected as ceremonial; ${analyzed} drafted this round; ${used} of ${limit} today; ${summary}`,
    started
  );
  // Agenda watch: county agenda summaries, with their own daily cap.
  const agendas = await runAgendaWatch(env, db, { run, deadline: budget.deadline });
  return { status: "ok", analyzed, used, limit, agendas, more_now: (waiting && (stoppedEarly || unchecked)) || agendas.more_now };
}
