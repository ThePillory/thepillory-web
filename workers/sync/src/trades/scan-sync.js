// The scanned-trades step: transcribes scanned OGE Form 278-T reports
// (docs/trades.md). tools/load_trades.py queues each executive-branch report
// whose text layer it couldn't read, with that layer's numbered rows
// (trade_scans, trade_scan_lines). Here each queued report is read from its
// PDF by SCAN_MODEL_A (claude-sonnet-5-5), in chunks of SCAN_CHUNK_ROWS rows
// so a long report's answer isn't cut off; each chunk is kept
// (trade_scan_chunks), so a reading resumes in the next round. Each row it
// reads is then held against the report's own text layer (textBacks(): the
// same date, both dollar figures of the range, most of the description); only
// the rows the text layer doesn't back up are read a second time, by
// SCAN_MODEL_B (claude-opus-5-5), so the second, dearer model reads only what
// needs a second opinion (all of it when there's no usable text layer). The
// rows are then checked one by one in code (scan-check.js). Nothing is
// published here: a report whose readings agree waits on
// /admin/review/trades/ until a person compares it with the scan and confirms
// it ("Checked by [name]"), and stays a link to the report on public pages
// until then. A transcription published without a person's check (before
// this rule) is taken back to a link at the start of each run. The
// President's reports go first, newest first, then the rest of the executive
// branch.
// The step downloads each report's PDF itself and sends the file, since
// OGE's server often times out when the Claude API fetches the link; a PDF
// that can't be downloaded (or is over MAX_PDF_BYTES) is sent as its link.
// A round that runs out of time stops "partial", keeping its chunks, and the
// next round resumes (rather than the step waiting for tomorrow).
// SCANNED_TRADES_DAILY reports are finished a day; a report that fails to
// read is tried again (SCAN_TRIES times), and failures don't count.
import { getState, setState, today, redact, BudgetExhausted } from "../util.js";
import { structuredCall, DraftRefused } from "../analysis/claude.js";
import { SCAN_INSTRUCTIONS, scanSchema, scanMessage } from "./scan-prompt.js";
import { checkReadings, blocking, rowsLine, isoDate, amountBounds, contained, textLayerType, typeLabel } from "./scan-check.js";
import { takeDownStatements } from "./publish.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));
const MAX_ROWS = 1500; // no 278-T is near this long; a reading past it is a runaway
const CALL_MS = 5 * 60 * 1000; // leave this much of the round for each chunk
const SCAN_TRIES = 3;
const MAX_PDF_BYTES = 24 * 1024 * 1024; // the Claude API takes requests up to 32 MB, and base64 adds a third

/** Bytes -> base64, in slices so a large PDF doesn't overflow the call stack. Pure. */
export function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/**
 * The report's document source, downloaded once per report and round: the
 * PDF's bytes (base64) when the round's budget can fetch it, else its link.
 */
export async function pdfSource(report, budget) {
  if (report.doc) return report.doc;
  report.doc = report.report_url;
  if (budget && typeof budget.fetch === "function") {
    try {
      const res = await budget.fetch(report.report_url, {}, `scanned report ${report.report_id}`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pdf = bytes.length >= 5 && String.fromCharCode(...bytes.subarray(0, 5)) === "%PDF-";
      if (pdf && bytes.length <= MAX_PDF_BYTES) report.doc = { type: "base64", media_type: "application/pdf", data: toBase64(bytes) };
    } catch (err) {
      if (err instanceof BudgetExhausted) throw err;
      console.warn(`scanned report ${report.report_id}: download failed, sending the link (${redact(String(err.message || err)).slice(0, 200)})`);
    }
  }
  return report.doc;
}

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
    const doc = await pdfSource(report, budget);
    const { data } = await call(env, {
      model,
      system: [SCAN_INSTRUCTIONS],
      message: scanMessage(doc, first, last),
      jsonSchema: scanSchema,
      maxTokens: 64000,
    });
    await db
      .prepare("INSERT OR REPLACE INTO trade_scan_chunks (report_id, model, first_n, last_n, reading) VALUES (?, ?, ?, ?, ?)")
      .bind(report.report_id, model, first, last, JSON.stringify({ rows: Array.isArray(data && data.rows) ? data.rows : [] }))
      .run();
  }
}

/**
 * Does the report's own text layer back up this row of the first reading?
 * Strict, since it then stands in for a second reading: the line shows the
 * same date, both dollar figures of the range, most of the description's
 * letters, and no other transaction type; and the reading didn't mark the row
 * hard to read. Pure.
 */
export function textBacks(row, line) {
  if (!row || !line || row.uncertain) return false;
  const iso = isoDate(row.date);
  if (!iso) return false;
  const [y, m, d] = iso.split("-").map(Number);
  if (!new RegExp(`(^|[^0-9])0?${m}/0?${d}/(?:${y}|${String(y).slice(2)})(?![0-9])`).test(line)) return false;
  const [lo, hi] = amountBounds(row.amount);
  if (lo == null) return false;
  const digits = String(line).replace(/[^0-9$]/g, "");
  const shown = (/^(?:Spouse\/DC )?Over /.test(String(row.amount).trim()) ? [lo - 1] : [lo, hi]).filter((x) => x != null);
  if (!shown.every((x) => digits.includes(`$${x}`))) return false;
  if (contained(row.description, line) < 0.8) return false;
  const t = textLayerType(line);
  const want = typeLabel(row.type);
  return !t || t === (want === "Partial sale" ? "Sale" : want);
}

/** Row numbers -> ranges to read, consecutive ones together (gaps of up to 2 rows bridged), none longer than size. Pure. */
export function rowRanges(ns, size = 80) {
  const out = [];
  for (const n of [...new Set(ns)].sort((a, b) => a - b)) {
    const last = out[out.length - 1];
    if (last && n - last[1] <= 3 && n - last[0] < size) last[1] = n;
    else out.push([n, n]);
  }
  return out;
}

/** The second model's reading of only these ranges, resuming from what's stored (a stored chunk that covers a range is used as is). */
export async function readRows(env, db, report, model, ranges, { call = structuredCall, budget = null } = {}) {
  const { results } = await db.prepare("SELECT first_n, last_n, reading FROM trade_scan_chunks WHERE report_id = ? AND model = ?").bind(report.report_id, model).all();
  const have = results.map((c) => ({ ...c, reading: JSON.parse(c.reading) }));
  const rows = [];
  for (const [first, last] of ranges) {
    let chunk = have.find((c) => c.first_n <= first && c.last_n >= last);
    if (!chunk) {
      if (budget && budget.timeLeft() < CALL_MS) throw new BudgetExhausted(`run time limit reached before the second reading of rows ${first}-${last} of ${report.report_id}`);
      const doc = await pdfSource(report, budget);
      const { data } = await call(env, { model, system: [SCAN_INSTRUCTIONS], message: scanMessage(doc, first, last), jsonSchema: scanSchema, maxTokens: 64000 });
      chunk = { first_n: first, last_n: last, reading: { rows: Array.isArray(data && data.rows) ? data.rows : [] } };
      await db
        .prepare("INSERT OR REPLACE INTO trade_scan_chunks (report_id, model, first_n, last_n, reading) VALUES (?, ?, ?, ?, ?)")
        .bind(report.report_id, model, first, last, JSON.stringify(chunk.reading))
        .run();
      have.push(chunk);
    }
    for (const r of chunk.reading.rows || []) if (Number(r.n) >= first && Number(r.n) <= last) rows.push({ ...r, n: Number(r.n) });
  }
  return rows;
}

/**
 * Read one report and check it row by row: the first model reads everything;
 * the text layer backs up what it can; the second model reads only the rest.
 * Returns {status, rows, unread, total, problems, models}.
 */
export async function transcribe(env, db, report, lines, { call = structuredCall, budget = null } = {}) {
  const [first, second] = scanModels(env);
  let models = [first];
  const refused = (model) => ({ status: "disagree", rows: [], unread: [], total: 0, problems: [{ n: null, kind: "block", text: `${model} declined to read it.` }], models: [first, second] });
  let a;
  try {
    a = await readReport(env, db, report, first, { call, budget });
  } catch (err) {
    if (err instanceof DraftRefused) return refused(first);
    throw err;
  }
  const backed = a.rows.filter((r) => textBacks(r, lines[r.n]));
  const backedNs = new Set(backed.map((r) => r.n));
  const others = a.rows.map((r) => r.n).filter((n) => !backedNs.has(n));
  let again = [];
  if (others.length) {
    models = [first, second];
    try {
      again = await readRows(env, db, report, second, rowRanges(others, chunkRows(env)), { call, budget });
    } catch (err) {
      if (err instanceof DraftRefused) return refused(second);
      throw err;
    }
  }
  // The second "reading": the text layer's backing for those rows, the second model's for the rest.
  const b = { rows: [...backed.map((r) => ({ ...r })), ...again.filter((r) => !backedNs.has(r.n))] };
  const { rows, unread, total, problems } = checkReadings(a, b, lines);
  if (a.rows.length) {
    problems.push({
      n: null,
      kind: "look",
      text: `${backed.length} of ${a.rows.length} rows read by ${first} matched the report's text layer (date, amount, description)${others.length ? `; the other ${others.length} were read again by ${second}` : "; no second reading was needed"}. Check every row against the scan.`,
    });
  }
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
      // Out of time (or requests): the chunks read so far are kept, and the next round resumes.
      if (err instanceof BudgetExhausted) return { status: "partial", message: `${note()}; ${err.message}` };
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
