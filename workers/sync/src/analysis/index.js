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
import { fetchBillText, cardSource, officialSummary } from "./billtext.js";
import { draftAnalysis, DraftRefused } from "./claude.js";
import { verifyQuotes, verifyCitations, sameCase } from "./verify.js";
import { makeLookup } from "./courtlistener.js";
import { PROMPT_VERSION, CARD_PROMPT_VERSION } from "./prompt.js";
import { checkRelevance, BATCH, RELEVANCE_PROMPT_VERSION } from "./relevance.js";
import { reviewDraft, draftForReview, REVIEW_PROMPT_VERSION } from "./review.js";
import { lintDraft } from "./lint.js";
import { withD1Retry } from "../d1retry.js";
import { runAgendaWatch } from "./agenda.js";
import { runPromises } from "../promises/index.js";
import { runTopics } from "../topics/index.js";
import { statePriority, stateBillScope } from "../state-priority.js";

const RETRY_AFTER_DAYS = 7; // a bill that couldn't be drafted waits this long before another try
const MIN_TIME_PER_BILL_MS = 4 * 60 * 1000; // don't start a bill without this much time left in the round
const MAX_RELEVANCE_BATCHES = 4; // per round
const J = (x) => JSON.stringify(x);

function day() {
  return new Date().toISOString().slice(0, 10);
}

// A final-passage vote on the bill by one of our officials.
const FINAL_VOTE = `EXISTS (SELECT 1 FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage'
                   AND (EXISTS (SELECT 1 FROM vote_positions p JOIN officials o ON o.id = p.official_id WHERE p.vote_id = v.id)
                     OR EXISTS (SELECT 1 FROM state_positions sp WHERE sp.vote_k = v.k)))`;
// An issue on the site links to the bill (approved links only).
const LINKED = "EXISTS (SELECT 1 FROM issue_bill_links l WHERE l.bill_id = b.id AND l.status = 'approved')";
// TODO: once residents can follow bills, a bill with followers is eligible too
// (OR EXISTS (SELECT 1 FROM bill_follows f WHERE f.bill_id = b.id)).

// Every other state's bills (docs/states.md): within the same daily caps, only
// bills that passed a final-passage vote, in the ANALYSIS_STATES (10) states
// visitors look up most, ranked in that order. Congress and California as before.
let scopeCache = null; // { at, scope }: worked out once per round
async function billScope(db, env) {
  if (!scopeCache || Date.now() - scopeCache.at > 10 * 60 * 1000) {
    scopeCache = { at: Date.now(), scope: stateBillScope(await statePriority(db, env), parseInt(env.ANALYSIS_STATES || "10", 10)) };
  }
  return scopeCache.scope;
}

// ---------------------------------------------------------------------------
// 1. Relevance

async function uncheckedBills(db, limit, env = {}) {
  const scope = await billScope(db, env);
  return (
    await db
      .prepare(
        `SELECT b.* FROM bills b
         -- Not checked yet, or set aside under an earlier version of the rules
         -- (and not un-skipped by a person): checked again with the current rules.
         WHERE NOT EXISTS (SELECT 1 FROM bill_relevance r WHERE r.bill_id = b.id
                             AND NOT (r.verdict = 'skip' AND r.override IS NULL AND r.prompt_version != ?))
           AND (${FINAL_VOTE}
                OR EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = b.id AND a.current = 1 AND a.status = 'ai_draft' AND a.ai_review IS NULL))
           AND ${scope.where}
         ORDER BY ${scope.rank}, (SELECT MAX(v.vote_date) FROM votes v WHERE v.bill_id = b.id) DESC, b.id LIMIT ?`
      )
      .bind(RELEVANCE_PROMPT_VERSION, limit)
      .all()
  ).results;
}

/**
 * The official description of each bill not looked up yet (once per bill; see
 * officialSummary). A lookup that fails is noted and not retried: the check
 * never skips a bill for lack of a description.
 */
async function fillSummaries(env, db, budget, bills) {
  const failed = [];
  for (const b of bills) {
    if (b.official_summary_checked_at) continue;
    let s = null;
    try {
      s = await officialSummary(env, budget, b);
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      failed.push(`${b.id} (${redact(err.message).slice(0, 120)})`);
    }
    await db
      .prepare("UPDATE bills SET official_summary = ?, official_summary_label = ?, official_summary_url = ?, official_summary_checked_at = datetime('now') WHERE id = ?")
      .bind(s ? s.text : null, s ? s.label : null, s ? s.url : null, b.id)
      .run();
    Object.assign(b, { official_summary: s ? s.text : null, official_summary_label: s ? s.label : null });
  }
  return failed;
}

async function runRelevance(env, db, budget, run) {
  let checked = 0;
  let skipped = 0;
  for (let i = 0; i < MAX_RELEVANCE_BATCHES; i++) {
    const bills = await uncheckedBills(db, BATCH, env);
    if (!bills.length || budget.timeLeft() < MIN_TIME_PER_BILL_MS) break;
    const t0 = new Date().toISOString();
    let lookupFailed;
    try {
      lookupFailed = await fillSummaries(env, db, budget, bills);
    } catch (err) {
      if (!(err instanceof BudgetExhausted)) throw err;
      break; // the rest are looked up next round
    }
    const described = bills.filter((b) => b.official_summary).length;
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
      `${verdicts.length} bill(s) checked (${described} with an official summary or title), ${skips.length} skipped as ceremonial or routine${missing ? `, ${missing} not answered (tried again next round)` : ""}` +
        `${lookupFailed.length ? `; description lookup failed for ${lookupFailed.join(", ")}` : ""}; model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}`,
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
    J({
      verdict: review.verdict, checks: review.checks, reasons: review.reasons, notes: review.notes || [], version: review.version || null,
      ...(review.first ? { revised: true, first_review: review.first } : {}),
      ...(review.kept_first ? { kept_first: true } : {}),
      ...(review.previous ? { previous: review.previous } : {}),
    }),
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
        ? `limited: based on ${source.note} of the ${bill.kind === "order" ? "order's" : "bill"} text.`
        : null;
  const insert = db
    .prepare(
      `INSERT INTO bill_analyses (bill_id, current, status, depth, basis, basis_note, text_version, text_source_url,
         plain_summary, clauses, aligns, tension, departure, article_v, readings, citations, uncertainty,
         model, prompt_version, quote_check, citation_check,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         ai_review, ai_review_detail, ai_review_model, ai_review_tokens, ai_reviewed_at, spot_check, supporters, critics)
       VALUES (?, 1, 'ai_draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      ...reviewColumns(env, meta.review),
      draft.supporters || "",
      draft.critics || ""
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
  const why = bill.request_id ? (bill.request_source === "reader" ? "a reader asked for a full analysis" : "requested at /admin/review") : bill.upgrade ? "an issue now links to this bill" : bill.redraft ? "redrafted under the current drafting prompt" : null;
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
  const notes = review.notes && review.notes.length ? `, with ${review.notes.length} minor note(s)` : "";
  const published = `published as auto-checked${notes}${spot ? "; picked for a spot check" : ""}`;
  if (review.kept_first) return `the revision added a major problem, so the first draft was kept (${published})`;
  if (review.first) {
    const before = `revised once after the AI reviewer noted ${review.first.checks.filter((c) => !c.ok).length} problem(s)`;
    return review.verdict === "pass" ? `${before}; the revision passed (${published})` : `${before}; the revision still has ${review.reasons.length} major problem(s), sent to the review queue`;
  }
  if (review.verdict === "pass") return `AI reviewer: pass (${published})`;
  return `AI reviewer: ${review.reasons.length} major problem(s), sent to the review queue`;
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
                r.verdict AS rel_verdict, r.category AS rel_category, r.reason AS rel_reason, r.override AS rel_override,
                x.id IS NOT NULL AS is_order
         FROM bill_analyses a LEFT JOIN bills b ON b.id = a.bill_id LEFT JOIN executive_actions x ON x.id = a.bill_id
           LEFT JOIN bill_relevance r ON r.bill_id = a.bill_id
         -- Not reviewed yet, or flagged under an earlier version of the reviewer's
         -- rules (and no person has decided yet): reviewed again with the current rules.
         WHERE a.current = 1 AND a.status = 'ai_draft' AND (b.id IS NOT NULL OR x.id IS NOT NULL)
           AND (a.ai_review IS NULL OR (a.ai_review = 'flag' AND COALESCE(json_extract(a.ai_review_detail, '$.version'), '') != ?))
         ORDER BY a.ai_review IS NOT NULL, a.created_at, a.id LIMIT 25`
      )
      .bind(REVIEW_PROMPT_VERSION)
      .all()
  ).results;
  let rejected = 0;
  let reviewed = 0;
  for (const row of rows) {
    const t0 = new Date().toISOString();
    // Ceremonial or routine: rejected without a review call.
    if (!row.is_order && row.rel_verdict === "skip" && row.rel_override !== "unskip") {
      const { rel_verdict, rel_category, rel_reason, rel_override, bill_number, title, level, session, chamber, official_url, bill_summary, bill_source_url, is_order, ...snapshot } = row;
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
    if (!row.is_order && !row.rel_verdict) continue; // relevance not checked yet; next round
    if (used >= limit || budget.timeLeft() < MIN_TIME_PER_BILL_MS) break;
    const bill = row.is_order
      ? await orderSubject(db, row.bill_id)
      : { id: row.bill_id, bill_number: row.bill_number, title: row.title, level: row.level, session: row.session, chamber: row.chamber, official_url: row.official_url, summary: row.bill_summary || "", source_url: row.bill_source_url };
    if (!bill) continue;
    const before = budget.used;
    try {
      const source = await subjectSource(env, db, budget, bill, row.depth || "full");
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
        supporters: row.supporters || "",
        critics: row.critics || "",
      };
      let review = await reviewDraft(env, bill, source, draft, row.depth || "full");
      // A re-review keeps the earlier review (and its reasons) beside the new one.
      if (row.ai_review) {
        const prev = JSON.parse(row.ai_review_detail || "{}");
        review = { ...review, previous: { verdict: prev.verdict, checks: prev.checks, reasons: prev.reasons, version: prev.version || null, reviewed_at: row.ai_reviewed_at } };
      }
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

async function nextBills(db, limit, env = {}, redraftRoom = 0) {
  const scope = await billScope(db, env);
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
  if (requested.length >= limit && redraftRoom <= 0) return requested;
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
  // Drafts the AI reviewer flagged that no person has decided on yet, written
  // under an earlier version of the drafting prompt: drafted again with the
  // current one (the flagged draft stays in the history).
  const redrafts = (
    await db
      .prepare(
        `SELECT b.*, a.depth AS redraft_depth FROM bills b JOIN bill_analyses a ON a.bill_id = b.id AND a.current = 1
         WHERE a.status = 'ai_draft' AND a.ai_review = 'flag'
           AND COALESCE(a.prompt_version, '') != CASE WHEN a.depth = 'card' THEN ? ELSE ? END
           AND NOT EXISTS (SELECT 1 FROM bill_analysis_revisions v WHERE v.analysis_id = a.id AND v.actor != 'pipeline')
           AND ${retry}
         ORDER BY a.id LIMIT ?`
      )
      .bind(CARD_PROMPT_VERSION, PROMPT_VERSION, Math.max(0, redraftRoom))
      .all()
  ).results.map((b) => ({ ...b, depth: b.redraft_depth === "full" ? "full" : "card", redraft: true }));
  const fresh = (
    await db
      .prepare(
        `SELECT b.*, ${LINKED} AS linked, ${RANK} AS local_rank,
                (SELECT MAX(v.vote_date) FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage') AS last_vote
         FROM bills b LEFT JOIN bill_relevance r ON r.bill_id = b.id
         -- No draft yet, or only drafts the relevance check rejected automatically
         -- (a bill it now finds substantive gets drafted; a person's rejection stands).
         WHERE NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = b.id
                             AND NOT (a.status = 'rejected' AND EXISTS (SELECT 1 FROM bill_analysis_revisions v
                                       WHERE v.analysis_id = a.id AND v.action = 'rejected' AND v.actor = 'pipeline')))
           AND ${retry}
           AND (${LINKED} OR (${FINAL_VOTE} AND (r.verdict = 'analyze' OR r.override = 'unskip') AND ${scope.where}))
         ORDER BY linked DESC, local_rank DESC, ${scope.rank}, last_vote DESC, b.id LIMIT ?`
      )
      .bind(Math.max(0, limit - requested.length - upgrades.length))
      .all()
  ).results.map((b) => ({ ...b, depth: b.linked ? "full" : "card" }));
  const seen = new Set();
  return [...requested, ...upgrades, ...redrafts, ...fresh].filter((b) => (seen.has(b.id) ? false : seen.add(b.id)));
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

// ---------------------------------------------------------------------------
// Executive orders: the same drafting, checks and review as bills, from the
// order's own text (read by the order-texts step, src/executive/orders-sync.js).

const MAX_ORDER_CHARS = 150000;

/** An executive order as the pipeline's subject: what the prompt and the log need. */
export async function orderSubject(db, id) {
  const x = await db
    .prepare("SELECT a.*, o.office AS issuer FROM executive_actions a LEFT JOIN officials o ON o.id = a.official_id WHERE a.id = ?")
    .bind(id)
    .first();
  if (!x) return null;
  return {
    id: x.id,
    kind: "order",
    bill_number: x.number ? `Executive Order ${x.number}` : "Executive order",
    title: x.title,
    issuer: x.issuer || (x.id.startsWith("fr:") ? "President of the United States" : "Governor of California"),
    level: x.id.startsWith("fr:") ? "federal" : "state",
    signed_on: x.signed_on,
    published_on: x.published_on,
    source_url: x.source_url,
  };
}

/**
 * The text a draft is based on: a bill's text (a card of a long bill is
 * drafted from a condensed text, billtext.js), or an order's stored text.
 */
async function subjectSource(env, db, budget, subject, depth) {
  if (subject.kind === "order") {
    const t = await db.prepare("SELECT text, text_url FROM executive_action_texts WHERE action_id = ? AND status = 'ok'").bind(subject.id).first();
    if (!t || !t.text) return null;
    const long = t.text.length > MAX_ORDER_CHARS;
    return {
      basis: long ? "partial_text" : "full_text",
      note: long ? `the first ${MAX_ORDER_CHARS.toLocaleString("en-US")} characters` : null,
      text: long ? t.text.slice(0, MAX_ORDER_CHARS) : t.text,
      source_url: t.text_url || subject.source_url,
      version: subject.id.startsWith("fr:") ? "the Federal Register's text" : "the signed order",
    };
  }
  const fetched = await fetchBillText(env, budget, subject);
  return depth === "card" ? await cardSource(env, budget, subject, fetched) : fetched;
}

/** Orders to draft, up to `limit`: requests first, then redrafts after a prompt change, then the newest orders not yet analyzed. */
async function nextOrders(db, limit) {
  if (limit <= 0) return [];
  const retry = `NOT EXISTS (SELECT 1 FROM analysis_attempts t WHERE t.bill_id = x.id AND t.last_attempt > datetime('now', '-${RETRY_AFTER_DAYS} days'))`;
  const ids = [];
  const requested = (
    await db
      .prepare(
        `SELECT r.id AS request_id, r.depth AS request_depth, r.source AS request_source, x.id,
                (SELECT a.depth FROM bill_analyses a WHERE a.bill_id = x.id AND a.current = 1) AS current_depth
         FROM analysis_requests r JOIN executive_actions x ON x.id = r.bill_id
         WHERE r.status = 'pending' ORDER BY r.source = 'reader', r.requested_at LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results.map((r) => ({ id: r.id, request_id: r.request_id, request_source: r.request_source, depth: r.request_depth || r.current_depth || "card" }));
  ids.push(...requested);
  const redrafts = (
    await db
      .prepare(
        `SELECT x.id, a.depth FROM executive_actions x JOIN bill_analyses a ON a.bill_id = x.id AND a.current = 1
         WHERE a.status = 'ai_draft' AND a.ai_review = 'flag'
           AND COALESCE(a.prompt_version, '') != CASE WHEN a.depth = 'card' THEN ? ELSE ? END
           AND NOT EXISTS (SELECT 1 FROM bill_analysis_revisions v WHERE v.analysis_id = a.id AND v.actor != 'pipeline')
           AND ${retry} ORDER BY a.id LIMIT ?`
      )
      .bind(CARD_PROMPT_VERSION, PROMPT_VERSION, Math.max(0, limit - ids.length))
      .all()
  ).results.map((r) => ({ id: r.id, depth: r.depth === "full" ? "full" : "card", redraft: true }));
  ids.push(...redrafts);
  const fresh = (
    await db
      .prepare(
        `SELECT x.id FROM executive_actions x JOIN executive_action_texts t ON t.action_id = x.id AND t.status = 'ok'
         WHERE x.kind = 'executive_order' AND NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = x.id) AND ${retry}
         ORDER BY COALESCE(x.signed_on, x.published_on) DESC, x.id DESC LIMIT ?`
      )
      .bind(Math.max(0, limit - ids.length))
      .all()
  ).results.map((r) => ({ id: r.id, depth: "card" }));
  ids.push(...fresh);
  const seen = new Set();
  const out = [];
  for (const o of ids) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    const subject = await orderSubject(db, o.id);
    if (subject) out.push({ ...subject, ...o, kind: "order" });
  }
  return out;
}

/** Draft, verify, review and save one bill. `bill.depth` is "card" or "full". Returns a log entry. */
export async function analyzeBill(env, db, budget, bill) {
  const depth = bill.depth === "full" ? "full" : "card";
  const source = await subjectSource(env, db, budget, bill, depth);
  if (!source) {
    const msg = bill.kind === "order" ? "no readable text of the order" : "no bill text or official summary available";
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
  let { draft, model, usage, trimmed } = result;
  const checks = async (d, t) => {
    const quoteCheck = verifyQuotes(d, PROVISIONS);
    for (const id of t) quoteCheck.dropped.push({ id, reason: "a card keeps only the 3 most relevant provisions" });
    return { quoteCheck, citationCheck: await verifyCitations(d, makeLookup(env, budget, sameCase)) };
  };
  let { quoteCheck, citationCheck } = await checks(draft, trimmed);
  const addUsage = (u) => {
    usage = {
      input_tokens: usage.input_tokens + u.input_tokens,
      output_tokens: usage.output_tokens + u.output_tokens,
      cache_read_tokens: usage.cache_read_tokens + u.cache_read_tokens,
      cache_write_tokens: usage.cache_write_tokens + u.cache_write_tokens,
    };
  };

  // The wording check (lint.js), before the reviewer: verdicts in a panel,
  // panels not in parallel form or of very different lengths, and a partly
  // read bill that doesn't say so. Any problem goes back to the drafter once.
  let lintNote = "";
  const lintFirst = lintDraft(draft, { basis: source.basis, depth });
  if (lintFirst.length && parseInt(env.WORDING_FIXES_PER_DRAFT || "1", 10) > 0) {
    try {
      budget.take(`wording fix ${bill.id}`);
      const fixed = await draftAnalysis(env, bill, source, depth, { draft: draftForReview(draft, depth), reasons: lintFirst });
      addUsage(fixed.usage);
      const left = lintDraft(fixed.draft, { basis: source.basis, depth });
      if (left.length < lintFirst.length) {
        draft = fixed.draft;
        ({ quoteCheck, citationCheck } = await checks(draft, fixed.trimmed));
      }
      lintNote = `; wording check: ${lintFirst.length} problem(s), ${Math.min(left.length, lintFirst.length)} left after one fix`;
    } catch (err) {
      lintNote = err instanceof BudgetExhausted ? `; wording check: ${lintFirst.length} problem(s), no budget left to fix` : `; wording fix failed (${redact(`${err.name}: ${err.message}`)})`;
    }
  }

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

  // The revision step: when the reviewer names problems (major or minor; not
  // when its own call failed), the drafter gets one chance to fix them. The
  // revision goes through the same checks and a second review. A major problem
  // left sends it to the queue with both reviews kept; minor ones left are
  // published as notes. If the first draft had only minor problems and the
  // revision has a major one, the first draft is kept.
  let revisionNote = "";
  if (review && review.checks.some((c) => !c.ok) && parseInt(env.REVISIONS_PER_DRAFT || "1", 10) > 0) {
    try {
      budget.take(`revision ${bill.id}`);
      // The reviewer's problems, plus anything the wording check still finds.
      const reasons = [...review.reasons, ...lintDraft(draft, { basis: source.basis, depth })];
      const revised = await draftAnalysis(env, bill, source, depth, { draft: draftForReview(draft, depth), reasons: reasons.length ? reasons : review.notes || [] });
      const checked = await checks(revised.draft, revised.trimmed);
      budget.take(`AI reviewer (revision) ${bill.id}`);
      const second = await reviewDraft(env, bill, source, revised.draft, depth);
      const first = { verdict: review.verdict, checks: review.checks, reasons: review.reasons, notes: review.notes, model: review.model, usage: review.usage };
      const worse = review.verdict === "pass" && second.verdict === "flag";
      if (!worse) {
        draft = revised.draft;
        ({ quoteCheck, citationCheck } = checked);
      }
      addUsage(revised.usage);
      review = worse ? { ...review, kept_first: true, first: { ...second, revision_rejected: true } } : { ...second, first };
      revisionNote = `; revision tokens in ${revised.usage.input_tokens}, out ${revised.usage.output_tokens}; second review tokens in ${second.usage.input_tokens}, out ${second.usage.output_tokens}`;
    } catch (err) {
      // The first draft and its review stand; it's in the queue.
      revisionNote = err instanceof BudgetExhausted ? "; no budget left for the revision step" : `; revision step failed (${redact(`${err.name}: ${err.message}`)})`;
    }
  }
  const row = await save(env, db, bill, source, draft, { depth, model, usage, quoteCheck, citationCheck, review });
  await finishRequest(db, bill, "done", `analysis ${row.id}`);
  const fixes = [
    `${quoteCheck.checked} quotes checked, ${quoteCheck.replaced.length} replaced with stored text`,
    `${citationCheck.checked.length - citationCheck.removed_citations.length} of ${citationCheck.checked.length} citations verified`,
    citationCheck.removed_sentences.length ? `${citationCheck.removed_sentences.length} sentences removed` : null,
  ].filter(Boolean);
  const reviewTokens = review ? `; reviewer ${review.model}, tokens in ${(review.first || review).usage.input_tokens}, out ${(review.first || review).usage.output_tokens}` : "";
  return {
    status: "ok",
    counted: true,
    message:
      `${bill.id}: ${depth === "card" ? "card" : "full analysis"} ${row.id} saved (${source.basis}${source.condensed ? ", long bill condensed for the card" : ""}); model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, ` +
      `cache read ${usage.cache_read_tokens}, cache write ${usage.cache_write_tokens}; ${fixes.join("; ")}; ${reviewNote(review, row.spot_check)}${reviewTokens}${lintNote}${revisionNote}${reviewError}`,
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
  // Redrafts of flagged drafts (after a drafting-prompt change) have their own
  // daily allowance, REDRAFT_DAILY (20), so they don't hold up new bills.
  const redraftLimit = parseInt(env.REDRAFT_DAILY || "20", 10);
  const redraftKey = `redrafts_${day()}`;
  let redrafted = parseInt((await getState(db, redraftKey)) || "0", 10);
  const bills = used < limit || redrafted < redraftLimit ? await nextBills(db, Math.max(0, limit - used), env, Math.max(0, redraftLimit - redrafted)) : [];
  for (const bill of bills) {
    if (bill.redraft ? redrafted >= redraftLimit : used >= limit) continue;
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
    if (r.counted && bill.redraft) {
      redrafted += 1;
      await setState(db, redraftKey, String(redrafted));
    } else if (r.counted) {
      used += 1;
      await setState(db, key, String(used));
    }
    if (r.status === "ok") analyzed += 1;
    console.log(`[${runId}] analysis ${r.status}: ${r.message}`);
    await log(db, run, "analysis", r.status, budget.used - before, r.message, t0);
  }
  // Executive orders: the same pipeline, with their own daily cap (ORDER_ANALYSIS_DAILY).
  const orderLimit = parseInt(env.ORDER_ANALYSIS_DAILY || "5", 10);
  const orderKey = `order_analyses_${day()}`;
  let ordersUsed = parseInt((await getState(db, orderKey)) || "0", 10);
  let ordersWaiting = false;
  try {
    const orders = ordersUsed < orderLimit && !stoppedEarly ? await nextOrders(db, orderLimit - ordersUsed) : [];
    for (const order of orders) {
      if (ordersUsed >= orderLimit) break;
      if (budget.timeLeft() < MIN_TIME_PER_BILL_MS) {
        ordersWaiting = true;
        break;
      }
      const t0 = new Date().toISOString();
      const before = budget.used;
      let r;
      try {
        r = await analyzeBill(env, db, budget, order);
      } catch (err) {
        if (err instanceof BudgetExhausted) {
          ordersWaiting = true;
          break;
        }
        r = { status: "error", message: `${order.id}: ${redact(`${err.name}: ${err.message}`)}`, counted: false };
        await noteAttempt(db, order.id, r.message);
        await finishRequest(db, order, "failed", r.message);
      }
      if (r.counted) {
        ordersUsed += 1;
        await setState(db, orderKey, String(ordersUsed));
      }
      if (r.status === "ok") analyzed += 1;
      await log(db, run, "analysis-orders", r.status, budget.used - before, r.message, t0);
    }
  } catch (err) {
    // Before migration 0018 (no order tables yet), there is nothing to do.
    if (!/no such (table|column)/i.test(String(err && err.message))) throw err;
  }

  // More relevance checks wait only if this round's check made progress (a failing check doesn't loop).
  const unchecked = relevance.checked > 0 && (await uncheckedBills(db, 1, env)).length > 0;
  const waiting = (used < limit || redrafted < redraftLimit) && (stoppedEarly || unchecked || (await nextBills(db, used < limit ? 1 : 0, env, redrafted < redraftLimit ? 1 : 0)).length > 0);
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
  // Promises: candidates for review, with their own small daily caps.
  let promises = { suggested: 0 };
  try {
    promises = await runPromises(env, db, { run, deadline: budget.deadline });
  } catch (err) {
    await log(db, run, "promises", "error", 0, redact(`${err.name}: ${err.message}`), new Date().toISOString());
  }
  // Topics: tags for new bills, agenda items, executive actions and Platform excerpts, with their own daily cap.
  let topics = { tagged: 0, more_now: false };
  try {
    topics = await runTopics(env, db, { run, deadline: budget.deadline });
  } catch (err) {
    await log(db, run, "topics", "error", 0, redact(`${err.name}: ${err.message}`), new Date().toISOString());
  }
  return { status: "ok", analyzed, used, limit, agendas, promises, topics, more_now: (waiting && (stoppedEarly || unchecked)) || ordersWaiting || agendas.more_now || topics.more_now };
}
