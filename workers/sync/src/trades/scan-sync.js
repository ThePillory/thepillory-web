// The scanned-trades step: transcribes scanned OGE Form 278-T reports
// (docs/trades.md). tools/load_trades.py queues each executive-branch report
// whose text layer it couldn't read, with that layer's numbered rows
// (trade_scans, trade_scan_lines). Here each queued report is read from its
// PDF twice, by two different models (SCAN_MODEL_A, SCAN_MODEL_B), in chunks
// of SCAN_CHUNK_ROWS rows so a long report's answer isn't cut off; each chunk
// is kept (trade_scan_chunks), so a reading resumes in the next round. The
// readings are then checked row by row in code (scan-check.js). Nothing is
// published here: a report whose readings agree waits on
// /admin/review/trades/ until a person compares it with the scan and confirms
// it ("Checked by [name]"), and stays a link to the report on public pages
// until then. A transcription published without a person's check (before
// this rule) is taken back to a link at the start of each run. The
// President's reports go first, newest first, then the rest of the executive
// branch.
// SCANNED_TRADES_DAILY reports are finished a day; a report that fails to
// read is tried again (SCAN_TRIES times), and failures don't count.
import { getState, setState, today, redact, BudgetExhausted } from "../util.js";
import { structuredCall, DraftRefused } from "../analysis/claude.js";
import { SCAN_INSTRUCTIONS, scanSchema, scanMessage } from "./scan-prompt.js";
import { checkReadings, blocking, rowsLine } from "./scan-check.js";
import { takeDownStatements } from "./publish.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));
const MAX_ROWS = 1500; // no 278-T is near this long; a reading past it is a runaway
const CALL_MS = 5 * 60 * 1000; // leave this much of the round for each chunk
const SCAN_TRIES = 3;

export const scanModels = (env) => [env.SCAN_MODEL_A || "claude-sonnet-5-5", env.SCAN_MODEL_B || "claude-opus-5-5"];
const chunkRows = (env) => Math.max(10, parseInt(env.SCAN_CHUNK_ROWS || "80", 10) || 80);

/** An error that stops the whole step for today (the account, not the report): no credit, a bad key. */
export const accountError = (err) =>
  /credit balance|billing|\b401\b|authentication|invalid x-api-key|permission_error/i.test(String((err && err.message) || err));

/** Chunks of one model's reading, merged: {rows, done} (done: the table ended). Pure. */
export function mergeChunks(chunks) {
  const rows = new Map();
  let done = false;
  let next = 1;
  for (const c of [...chunks].sort((a, b) => a.first_n - b.first_n)) {
    if (c.first_n !== next) break; // chunks are read in order; anything after a gap is ignored
    const got = (c.reading && Array.isArray(c.reading.rows) ? c.reading.rows : []).filter((r) => Number(r.n) >= c.first_n && Number(r.n) <= c.last_n);
    for (const r of got) if (!rows.has(Number(r.n))) rows.set(Number(r.n), { ...r, n: Number(r.n) });
    next = c.last_n + 1;
    // A chunk that didn't reach its last row means the table ended there.
    if (!got.some((r) => Number(r.n) === c.last_n)) {
      done = true;
      break;
    }
  }
  if (next > MAX_ROWS) done = true;
  return { rows: [...rows.values()].sort((a, b) => a.n - b.n), done, next };
}

/**
 * One model's reading of one report, chunk by chunk, resuming from what's
 * stored. Returns {rows} once the table has ended. Throws BudgetExhausted when
 * the round has no time left for another chunk (the next round resumes).
 */
export async function readReport(env, db, report, model, { call = structuredCall, budget = null } = {}) {
  const size = chunkRows(env);
  for (;;) {
    const { results } = await db.prepare("SELECT first_n, last_n, reading FROM trade_scan_chunks WHERE report_id = ? AND model = ?").bind(report.report_id, model).all();
    const merged = mergeChunks(results.map((c) => ({ ...c, reading: JSON.parse(c.reading) })));
    if (merged.done) return { rows: merged.rows };
    if (budget && budget.timeLeft() < CALL_MS) throw new BudgetExhausted(`run time limit reached before reading rows ${merged.next}+ of ${report.report_id}`);
    const first = merged.next;
    const last = first + size - 1;
    const { data } = await call(env, {
      model,
      system: [SCAN_INSTRUCTIONS],
      message: scanMessage(report.report_url, first, last),
      jsonSchema: scanSchema,
      maxTokens: 64000,
    });
    await db
      .prepare("INSERT OR REPLACE INTO trade_scan_chunks (report_id, model, first_n, last_n, reading) VALUES (?, ?, ?, ?, ?)")
      .bind(report.report_id, model, first, last, JSON.stringify({ rows: Array.isArray(data && data.rows) ? data.rows : [] }))
      .run();
  }
}

/** Read one report with both models and check the readings row by row. Returns {status, rows, unread, total, problems, models}. */
export async function transcribe(env, db, report, lines, { call = structuredCall, budget = null } = {}) {
  const models = scanModels(env);
  const readings = [];
  for (const model of models) {
    try {
      readings.push(await readReport(env, db, report, model, { call, budget }));
    } catch (err) {
      if (err instanceof DraftRefused) {
        return { status: "disagree", rows: [], unread: [], total: 0, problems: [{ n: null, kind: "block", text: `${model} declined to read it.` }], models };
      }
      throw err;
    }
  }
  const { rows, unread, total, problems } = checkReadings(readings[0], readings[1], lines);
  const status = blocking(problems) || !rows.length ? "disagree" : "agreed";
  if (!rows.length && !blocking(problems)) problems.push({ n: null, kind: "block", text: "No row was read the same way by both readings." });
  return { status, rows: status === "agreed" ? rows : [], agreedRows: rows, unread, total, problems, models };
}

/** Takes every AI transcription no person has confirmed back to a link to its report; returns how many. */
export async function holdUnchecked(db) {
  let rows;
  try {
    rows = (await db.prepare("SELECT id, official_id FROM trade_reports WHERE transcribed_at IS NOT NULL AND transcribed_by IS NULL").all()).results;
  } catch (err) {
    if (missing(err)) return 0;
    throw err;
  }
  for (const r of rows) await db.batch(takeDownStatements(r).map((q) => db.prepare(q.sql).bind(...q.binds)));
  return rows.length;
}

export async function syncScannedTrades(env, db, budget, { call } = {}) {
  const held = await holdUnchecked(db);
  const heldNote = held ? `${held} transcription(s) published before a person checked them taken back to links; ` : "";
  if (!env.ANTHROPIC_API_KEY && !call) return { status: "skipped", message: `${heldNote}no ANTHROPIC_API_KEY` };
  const limit = parseInt(env.SCANNED_TRADES_DAILY || "5", 10);
  const dayKey = `scanned_trades_${today()}`;
  let done = parseInt((await getState(db, dayKey)) || "0", 10);
  if (done >= limit) return { status: "skipped", message: `${heldNote}${done} scanned reports read today (SCANNED_TRADES_DAILY ${limit})` };
  let queue;
  try {
    // A reading already under way first, then the President's reports, newest first, then the rest.
    queue = (
      await db
        .prepare(
          `SELECT s.report_id, s.tries, r.report_url, r.official_id, r.chamber, r.state, r.filed_on FROM trade_scans s
           JOIN trade_reports r ON r.id = s.report_id LEFT JOIN officials o ON o.id = r.official_id
           WHERE s.status = 'pending' AND r.report_url IS NOT NULL AND r.official_id IS NOT NULL
           ORDER BY EXISTS (SELECT 1 FROM trade_scan_chunks c WHERE c.report_id = s.report_id) DESC,
                    COALESCE(o.office, '') LIKE 'President of the United States%' DESC, r.filed_on DESC
           LIMIT ?`
        )
        .bind(limit - done + SCAN_TRIES)
        .all()
    ).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!queue.length) return { status: "ok", message: `${heldNote}no scanned reports waiting` };
  const tally = { agreed: 0, disagree: 0, rows: 0, total: 0 };
  const failed = [];
  const note = () =>
    [
      heldNote.replace(/; $/, ""),
      `${tally.agreed} scanned report(s) read and waiting for a person (${rowsLine(tally.rows, tally.total).replace(/\.$/, "") || "no rows"})`,
      `${tally.disagree} didn't agree (kept as links)`,
      failed.length ? `${failed.length} failed: ${failed.join("; ")}` : "",
    ].filter(Boolean).join(", ");
  for (const report of queue) {
    if (done >= limit) break;
    const { results } = await db.prepare("SELECT n, line FROM trade_scan_lines WHERE report_id = ?").bind(report.report_id).all();
    const lines = Object.fromEntries(results.map((r) => [r.n, r.line]));
    let out;
    try {
      out = await transcribe(env, db, report, lines, { call, budget });
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      const msg = redact(String(err.message || err)).slice(0, 300);
      // The account can't read anything today (no credit, a bad key): stop, count nothing.
      if (accountError(err)) return { status: "error", message: `${note()}; stopped: ${msg}` };
      const tries = (report.tries || 0) + 1;
      failed.push(`${report.report_id}: ${msg}`);
      if (tries >= SCAN_TRIES) {
        await db
          .prepare("UPDATE trade_scans SET status = 'disagree', tries = ?, error = ?, problems = ?, read_at = datetime('now') WHERE report_id = ? AND status = 'pending'")
          .bind(tries, msg, JSON.stringify([{ n: null, kind: "block", text: `Couldn't be read after ${tries} tries: ${msg}` }]), report.report_id)
          .run();
      } else {
        await db.prepare("UPDATE trade_scans SET tries = ?, error = ? WHERE report_id = ?").bind(tries, msg, report.report_id).run();
      }
      continue;
    }
    // Agreed readings wait for a person (/admin/review/trades/); nothing is public yet.
    await db
      .prepare(
        `UPDATE trade_scans SET status = ?, reading = ?, problems = ?, unread = ?, rows_total = ?, models = ?, spot_check = 0, error = NULL, read_at = datetime('now')
         WHERE report_id = ? AND status = 'pending'`
      )
      .bind(out.status, JSON.stringify(out.agreedRows || out.rows), JSON.stringify(out.problems), JSON.stringify(out.unread), out.total || null, out.models.join(", "), report.report_id)
      .run();
    tally[out.status] += 1;
    if (out.status === "agreed") {
      tally.rows += out.rows.length;
      tally.total += out.total;
    }
    done += 1;
    await setState(db, dayKey, String(done));
  }
  return { status: failed.length && !tally.agreed && !tally.disagree ? "error" : failed.length ? "partial" : "ok", message: note() };
}
