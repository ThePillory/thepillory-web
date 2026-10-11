// The scanned-trades step: transcribes scanned OGE Form 278-T reports
// (docs/trades.md). tools/load_trades.py queues each executive-branch report
// whose text layer it couldn't read, with that layer's numbered rows
// (trade_scans, trade_scan_lines). Here each queued report is read from its
// PDF twice, by two different models (SCAN_MODEL_A, SCAN_MODEL_B), and the
// readings are checked in code (scan-check.js). Agreed rows wait on
// /admin/review/trades/ for a person to compare them with the scan; nothing is
// published until a person approves. SCANNED_TRADES_DAILY (2) reports a day.
import { getState, setState, today, redact, BudgetExhausted } from "../util.js";
import { structuredCall, DraftRefused } from "../analysis/claude.js";
import { SCAN_INSTRUCTIONS, scanSchema, scanMessage } from "./scan-prompt.js";
import { checkReadings, blocking } from "./scan-check.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/** Read one report twice and check the readings. Returns {status, reading, problems, models}. */
export async function transcribe(env, report, lines, { call = structuredCall } = {}) {
  const models = [env.SCAN_MODEL_A || "claude-sonnet-5-5", env.SCAN_MODEL_B || "claude-opus-5-5"];
  const readings = [];
  for (const model of models) {
    try {
      const { data } = await call(env, {
        model,
        system: [SCAN_INSTRUCTIONS],
        message: scanMessage(report.report_url),
        jsonSchema: scanSchema,
        maxTokens: 64000,
      });
      readings.push(data);
    } catch (err) {
      if (err instanceof DraftRefused) {
        return { status: "disagree", reading: null, problems: [{ n: null, kind: "block", text: `${model} declined to read it.` }], models };
      }
      throw err;
    }
  }
  const { rows, problems } = checkReadings(readings[0], readings[1], lines);
  return { status: blocking(problems) ? "disagree" : "agreed", reading: rows, problems, models };
}

export async function syncScannedTrades(env, db, budget, { call } = {}) {
  if (!env.ANTHROPIC_API_KEY && !call) return { status: "skipped", message: "no ANTHROPIC_API_KEY" };
  const limit = parseInt(env.SCANNED_TRADES_DAILY || "2", 10);
  const dayKey = `scanned_trades_${today()}`;
  let done = parseInt((await getState(db, dayKey)) || "0", 10);
  if (done >= limit) return { status: "skipped", message: `${done} scanned reports read today (SCANNED_TRADES_DAILY ${limit})` };
  let queue;
  try {
    queue = (
      await db
        .prepare(
          `SELECT s.report_id, r.report_url FROM trade_scans s JOIN trade_reports r ON r.id = s.report_id
           WHERE s.status = 'pending' AND r.report_url IS NOT NULL ORDER BY r.filed_on DESC LIMIT ?`
        )
        .bind(limit - done)
        .all()
    ).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!queue.length) return { status: "ok", message: "no scanned reports waiting" };
  const tally = { agreed: 0, disagree: 0, error: 0 };
  for (const report of queue) {
    if (done >= limit) break;
    const { results } = await db.prepare("SELECT n, line FROM trade_scan_lines WHERE report_id = ?").bind(report.report_id).all();
    const lines = Object.fromEntries(results.map((r) => [r.n, r.line]));
    try {
      const out = await transcribe(env, report, lines, { call });
      await db
        .prepare("UPDATE trade_scans SET status = ?, reading = ?, problems = ?, models = ?, read_at = datetime('now') WHERE report_id = ? AND status = 'pending'")
        .bind(out.status, JSON.stringify(out.reading || []), JSON.stringify(out.problems), out.models.join(", "), report.report_id)
        .run();
      tally[out.status] += 1;
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      tally.error += 1;
      console.warn(`scanned trades ${report.report_id}: ${redact(String(err.message || err))}`);
    }
    done += 1;
    await setState(db, dayKey, String(done));
  }
  return {
    status: "ok",
    message: `${tally.agreed} scanned report(s) read with both readings agreeing (waiting for a person), ${tally.disagree} not agreeing (kept as links)${tally.error ? `, ${tally.error} failed` : ""}`,
  };
}
