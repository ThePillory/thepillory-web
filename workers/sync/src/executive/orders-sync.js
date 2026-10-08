// Two sync steps for executive orders (see docs/executive.md):
//
//   order-texts   each executive order's text, read once: the Federal Register's
//                 text of a President's order, or a Governor's signed PDF. The
//                 authority the order claims is kept word for word. Newest first,
//                 ORDER_TEXTS_DAILY (60) a day; a PDF with no readable text (a
//                 scanned image) is recorded as such, never guessed at.
//   order-courts  court records on CourtListener that mention each order: opinions,
//                 and dockets whose filings mention it. Needs
//                 COURTLISTENER_API_TOKEN. Each order is searched again every
//                 ORDER_COURTS_RECHECK_DAYS (14); ORDER_COURTS_DAILY (40) orders a day.
import { getState, setState, today, redact, BudgetExhausted, UpstreamError, isHttp } from "../util.js";
import { openPdf, streamPages } from "../meetings/pdftext.js";
import { cleanFrText, cleanPdfText, authorityClause, courtQuery, parseDockets, parseOpinions } from "./orders.js";

const FR_API = "https://www.federalregister.gov/api/v1";
const CL = "https://www.courtlistener.com";
const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

async function saveText(db, id, row) {
  await db
    .prepare(
      `INSERT INTO executive_action_texts (action_id, status, text, authority, text_url, note, fetched_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (action_id) DO UPDATE SET status = excluded.status, text = excluded.text, authority = excluded.authority,
         text_url = excluded.text_url, note = excluded.note, fetched_at = excluded.fetched_at`
    )
    .bind(id, row.status, row.text || null, row.authority || null, isHttp(row.text_url) ? row.text_url : null, row.note ? String(row.note).slice(0, 300) : null)
    .run();
}

/** A President's order: the Federal Register's record (for its text link and notes), then the text. */
async function federalText(env, db, budget, a) {
  const num = a.id.slice(3);
  const base = (env.FR_API_BASE || FR_API).replace(/\/$/, "");
  const d = await budget.json(`${base}/documents/${encodeURIComponent(num)}.json?fields[]=raw_text_url&fields[]=executive_order_notes`, {}, `Federal Register ${num}`);
  if (d.executive_order_notes) await db.prepare("UPDATE executive_actions SET notes = ? WHERE id = ?").bind(String(d.executive_order_notes).slice(0, 500), a.id).run();
  if (!isHttp(d.raw_text_url)) return { status: "no_text", note: "the Federal Register lists no text for this document" };
  const text = cleanFrText(await budget.text(d.raw_text_url, {}, `Federal Register text ${num}`));
  if (text.length < 200) return { status: "no_text", text_url: d.raw_text_url, note: "the Federal Register's text was empty" };
  return { status: "ok", text, authority: authorityClause(text), text_url: d.raw_text_url };
}

/** A Governor's order: the signed PDF linked from the post. */
async function californiaText(env, db, budget, a) {
  if (!isHttp(a.document_url)) return { status: "no_text", note: "no signed order is linked from the Governor's post" };
  const pace = { intervalMs: parseInt(env.GOVCA_MIN_INTERVAL_MS || "2000", 10), dailyLimit: parseInt(env.GOVCA_DAILY_LIMIT || "300", 10) };
  // GOVCA_BASE (tests) points the Governor's site at a fixture server.
  const url = env.GOVCA_BASE ? a.document_url.replace(/^https:\/\/www\.gov\.ca\.gov\//, env.GOVCA_BASE) : a.document_url;
  const res = await budget.paced(db, "govca", pace, url, {}, `Governor's signed order ${a.id}`);
  const bytes = await res.arrayBuffer();
  const pdf = await openPdf(bytes);
  const text = cleanPdfText(await streamPages(pdf, 20));
  if (text.replace(/\s/g, "").length < 200) return { status: "no_text", text_url: a.document_url, note: "the signed PDF is a scanned image with no readable text" };
  return { status: "ok", text, authority: authorityClause(text), text_url: a.document_url };
}

export async function syncOrderTexts(env, db, budget) {
  const limit = parseInt(env.ORDER_TEXTS_DAILY || "60", 10);
  const key = `order_texts_${today()}`;
  let done = parseInt((await getState(db, key)) || "0", 10);
  if (done >= limit) return { status: "skipped", message: `${done} order texts read today (ORDER_TEXTS_DAILY ${limit})` };
  let todo;
  try {
    todo = (
      await db
        .prepare(
          `SELECT a.* FROM executive_actions a LEFT JOIN executive_action_texts t ON t.action_id = a.id
           WHERE a.kind = 'executive_order' AND (t.action_id IS NULL OR (t.status = 'error' AND t.fetched_at < datetime('now', '-3 days')))
           ORDER BY COALESCE(a.signed_on, a.published_on) DESC, a.id DESC LIMIT ?`
        )
        .bind(limit - done)
        .all()
    ).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!todo.length) return { status: "ok", message: "every executive order's text is read" };
  const tally = { ok: 0, no_text: 0, error: 0, authority: 0 };
  try {
    for (const a of todo) {
      let row;
      try {
        row = a.id.startsWith("fr:") ? await federalText(env, db, budget, a) : await californiaText(env, db, budget, a);
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        row = { status: err instanceof UpstreamError && err.status === 404 ? "no_text" : "error", note: redact(`${err.name}: ${err.message}`) };
      }
      await saveText(db, a.id, row);
      tally[row.status] += 1;
      if (row.authority) tally.authority += 1;
      done += 1;
      await setState(db, key, String(done));
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary(tally)}; ${err.message}` };
  }
  return { status: "ok", message: summary(tally) };
}

const summary = (t) =>
  `${t.ok} order text(s) read (${t.authority} with the authority clause found)${t.no_text ? `, ${t.no_text} without readable text` : ""}${t.error ? `, ${t.error} couldn't be read (tried again in 3 days)` : ""}`;

// ---------------------------------------------------------------------------
// Court records

export async function syncOrderCourts(env, db, budget) {
  if (!env.COURTLISTENER_API_TOKEN) return { status: "skipped", message: "COURTLISTENER_API_TOKEN is not set" };
  const limit = parseInt(env.ORDER_COURTS_DAILY || "40", 10);
  const recheck = parseInt(env.ORDER_COURTS_RECHECK_DAYS || "14", 10);
  const key = `order_courts_${today()}`;
  let done = parseInt((await getState(db, key)) || "0", 10);
  if (done >= limit) return { status: "skipped", message: `${done} orders searched today (ORDER_COURTS_DAILY ${limit})` };
  let todo;
  try {
    todo = (
      await db
        .prepare(
          `SELECT a.* FROM executive_actions a LEFT JOIN executive_action_court_checks c ON c.action_id = a.id
           WHERE a.kind = 'executive_order' AND a.number IS NOT NULL AND (c.action_id IS NULL OR c.checked_at < datetime('now', ?))
           ORDER BY c.action_id IS NOT NULL, COALESCE(a.signed_on, a.published_on) DESC, a.id DESC LIMIT ?`
        )
        .bind(`-${recheck} days`, limit - done)
        .all()
    ).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!todo.length) return { status: "ok", message: "every order was searched recently" };
  const base = (env.COURTLISTENER_BASE || CL).replace(/\/$/, "");
  const headers = { Authorization: `Token ${env.COURTLISTENER_API_TOKEN}` };
  let searched = 0;
  let found = 0;
  try {
    for (const a of todo) {
      const q = courtQuery(a);
      if (!q) continue;
      const search = (type) => budget.json(`${base}/api/rest/v4/search/?type=${type}&order_by=${encodeURIComponent("dateFiled desc")}&q=${encodeURIComponent(q)}`, { headers }, `CourtListener ${type === "o" ? "opinions" : "dockets"} for ${a.id}`);
      const [ops, docs] = [await search("o"), await search("r")];
      const rows = [...parseOpinions(ops), ...parseDockets(docs)];
      await db.batch([
        db.prepare("DELETE FROM executive_action_cases WHERE action_id = ?").bind(a.id),
        ...rows.map((r) =>
          db
            .prepare("INSERT OR REPLACE INTO executive_action_cases (action_id, kind, cl_id, case_name, court, date_filed, docket_number, url, entries) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .bind(a.id, r.kind, r.cl_id, r.case_name.slice(0, 300), r.court, r.date_filed, r.docket_number, r.url, JSON.stringify(r.entries))
        ),
        db
          .prepare(
            `INSERT INTO executive_action_court_checks (action_id, query, opinions, dockets, checked_at) VALUES (?, ?, ?, ?, datetime('now'))
             ON CONFLICT (action_id) DO UPDATE SET query = excluded.query, opinions = excluded.opinions, dockets = excluded.dockets, checked_at = excluded.checked_at`
          )
          .bind(a.id, q, Number(ops.count) || 0, Number(docs.count) || 0),
      ]);
      searched += 1;
      if (rows.length) found += 1;
      done += 1;
      await setState(db, key, String(done));
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${searched} order(s) searched, ${found} with court records; ${err.message}` };
    if (err instanceof UpstreamError && err.status === 429) return { status: "partial", message: `${searched} order(s) searched; CourtListener's rate limit reached, continued next run` };
    throw err;
  }
  return { status: "ok", message: `${searched} order(s) searched on CourtListener, ${found} with court records` };
}
