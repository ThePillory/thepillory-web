// The analysis pipeline. Runs in the SyncRunner Durable Object after each sync
// (and on /analyze). For bills our officials voted on that have no analysis yet,
// and for regeneration requests from /admin/review:
//
//   1. fetch the bill text (or the official summary, marked "limited")
//   2. ask Claude for a draft in a fixed JSON shape
//   3. check every quote against the stored Constitution and every case against
//      CourtListener, fixing or removing what fails, and log it
//   4. save it as an "ai_draft", keeping every earlier version
//
// At most ANALYSIS_DAILY_LIMIT drafts a day (default 20). Tokens are logged per draft.
import { log } from "../db.js";
import { Budget, BudgetExhausted, getState, setState, redact } from "../util.js";
import { loadConstitution, PROVISIONS } from "../constitution.js";
import { fetchBillText } from "./billtext.js";
import { draftAnalysis, DraftRefused } from "./claude.js";
import { verifyQuotes, verifyCitations, sameCase } from "./verify.js";
import { makeLookup } from "./courtlistener.js";
import { PROMPT_VERSION } from "./prompt.js";
import { withD1Retry } from "../d1retry.js";
import { runAgendaWatch } from "./agenda.js";

const RETRY_AFTER_DAYS = 7; // a bill that couldn't be drafted waits this long before another try
const MIN_TIME_PER_BILL_MS = 4 * 60 * 1000; // don't start a bill without this much time left in the round

function dailyKey() {
  return `analyses_${new Date().toISOString().slice(0, 10)}`;
}

async function nextBills(db, limit) {
  const requested = (
    await db
      .prepare(
        `SELECT r.id AS request_id, b.* FROM analysis_requests r JOIN bills b ON b.id = r.bill_id
         WHERE r.status = 'pending' ORDER BY r.requested_at LIMIT ?`
      )
      .bind(limit)
      .all()
  ).results;
  if (requested.length >= limit) return requested;
  const fresh = (
    await db
      .prepare(
        `SELECT b.*, MAX(v.vote_date) AS last_vote FROM bills b
         JOIN votes v ON v.bill_id = b.id
         JOIN vote_positions p ON p.vote_id = v.id
         JOIN officials o ON o.id = p.official_id
         WHERE NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = b.id)
           AND NOT EXISTS (SELECT 1 FROM analysis_attempts t WHERE t.bill_id = b.id
                           AND t.last_attempt > datetime('now', ?))
         GROUP BY b.id ORDER BY last_vote DESC, b.id LIMIT ?`
      )
      .bind(`-${RETRY_AFTER_DAYS} days`, limit - requested.length)
      .all()
  ).results;
  const seen = new Set(requested.map((r) => r.id));
  return [...requested, ...fresh.filter((b) => !seen.has(b.id))];
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

const J = (x) => JSON.stringify(x);

async function save(db, bill, source, draft, meta) {
  const prev = await db.prepare("SELECT * FROM bill_analyses WHERE bill_id = ? AND current = 1").bind(bill.id).first();
  const basisNote =
    source.basis === "summary_only"
      ? "limited: based on summary only."
      : source.basis === "partial_text"
        ? `limited: based on ${source.note} of the bill text.`
        : null;
  const insert = db
    .prepare(
      `INSERT INTO bill_analyses (bill_id, current, status, basis, basis_note, text_version, text_source_url,
         plain_summary, clauses, aligns, tension, departure, article_v, readings, citations, uncertainty,
         model, prompt_version, quote_check, citation_check,
         input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES (?, 1, 'ai_draft', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      bill.id,
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
      PROMPT_VERSION,
      J(meta.quoteCheck),
      J(meta.citationCheck),
      meta.usage.input_tokens,
      meta.usage.output_tokens,
      meta.usage.cache_read_tokens,
      meta.usage.cache_write_tokens
    );
  const stmts = [];
  if (prev) {
    // Every current draft of this bill, not just prev.id, so that a batch
    // repeated after a temporary D1 error still leaves exactly one current draft.
    stmts.push(db.prepare("UPDATE bill_analyses SET current = 0 WHERE bill_id = ? AND current = 1").bind(bill.id));
    stmts.push(
      db
        .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, 'superseded', 'pipeline', ?, ?)")
        .bind(prev.id, bill.id, "replaced by a regenerated draft", J(prev))
    );
  }
  stmts.push(insert);
  await db.batch(stmts);
  const row = await db.prepare("SELECT * FROM bill_analyses WHERE bill_id = ? AND current = 1").bind(bill.id).first();
  await db
    .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, 'created', 'pipeline', ?, ?)")
    .bind(row.id, bill.id, bill.request_id ? "regenerated on request" : null, J(row))
    .run();
  return row.id;
}

/** Draft, verify and save one bill. Returns a log message. */
export async function analyzeBill(env, db, budget, bill) {
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
    result = await draftAnalysis(env, bill, source);
  } catch (err) {
    const tokens = err.usage ? ` (tokens in ${err.usage.input_tokens}, out ${err.usage.output_tokens})` : "";
    const msg = redact(`${err.name}: ${err.message}`) + tokens;
    await noteAttempt(db, bill.id, msg);
    await finishRequest(db, bill, "failed", msg);
    return { status: err instanceof DraftRefused ? "skipped" : "error", message: `${bill.id}: ${msg}`, counted: true };
  }
  const { draft, model, usage } = result;
  const quoteCheck = verifyQuotes(draft, PROVISIONS);
  const citationCheck = await verifyCitations(draft, makeLookup(env, budget, sameCase));
  const id = await save(db, bill, source, draft, { model, usage, quoteCheck, citationCheck });
  await finishRequest(db, bill, "done", `analysis ${id}`);
  const fixes = [
    `${quoteCheck.checked} quotes checked, ${quoteCheck.replaced.length} replaced with stored text`,
    `${citationCheck.checked.length - citationCheck.removed_citations.length} of ${citationCheck.checked.length} citations verified`,
    citationCheck.removed_sentences.length ? `${citationCheck.removed_sentences.length} sentences removed` : null,
  ].filter(Boolean);
  return {
    status: "ok",
    counted: true,
    message:
      `${bill.id}: analysis ${id} saved (${source.basis}); model ${model}; tokens in ${usage.input_tokens}, out ${usage.output_tokens}, ` +
      `cache read ${usage.cache_read_tokens}, cache write ${usage.cache_write_tokens}; ${fixes.join("; ")}`,
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
  const key = dailyKey();
  let used = parseInt((await getState(db, key)) || "0", 10);
  const budget = new Budget(env, deadlineMs);
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
  const waiting = used < limit && (stoppedEarly || (await nextBills(db, 1)).length > 0);
  const summary =
    used >= limit
      ? `daily limit of ${limit} drafts reached; the rest wait for tomorrow`
      : waiting
        ? "more bills waiting; continuing"
        : "no bills waiting";
  await log(db, run, "analysis-round", "ok", budget.used, `${analyzed} drafted this round; ${used} of ${limit} today; ${summary}`, started);
  // Agenda watch: county agenda summaries, with their own daily cap.
  const agendas = await runAgendaWatch(env, db, { run, deadline: budget.deadline });
  return { status: "ok", analyzed, used, limit, agendas, more_now: (waiting && stoppedEarly) || agendas.more_now };
}
