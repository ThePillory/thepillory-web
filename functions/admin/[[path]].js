// /admin/review/          AI-drafted constitutional analyses, newest first
// /admin/review/<id>/     one draft: preview, what the checks changed, edit any field,
//                         approve, reject, reopen, or ask for a new draft; full history
//
// Protected by Cloudflare Access (see functions/_lib/access.js and docs/analysis.md).
// Every change writes a bill_analysis_revisions row with the row as it was before.
import { page, esc, fmtDate, safeUrl } from "../_lib/render.js";
import { checkAccess } from "../_lib/access.js";
import { parse, badge, baselineSection, provisionsFor } from "../_lib/analysis.js";
import { verifyQuotes } from "../../workers/sync/src/analysis/verify.js";
import { FLAGS, FLAG_LABELS } from "../../workers/sync/src/analysis/agenda-check.js";
import { ISSUES } from "../_lib/generated.js";
import { when, meetingHref } from "../_lib/meetings.js";

const STATUS_NAMES = { ai_draft: "Drafts awaiting review", reviewed: "Reviewed", rejected: "Rejected", all: "All" };

function adminPage(title, main, status = 200) {
  const res = page(title, main, { back: title === "Review drafts" ? null : ["Review drafts", "/admin/review/"], status });
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(res.body, { status, headers });
}

function locked(reason) {
  const text =
    reason === "not-configured"
      ? "The review pages stay locked until Cloudflare Access is set up for /admin and ACCESS_TEAM_DOMAIN and ACCESS_AUD are set on the Pages project. See docs/analysis.md."
      : "You don't have access to this page.";
  return adminPage("Locked", `<header class="page-head"><h1>Locked</h1><p class="subtitle">${esc(text)}</p></header>`, reason === "not-configured" ? 503 : 403);
}

function missingTables() {
  return adminPage(
    "Review drafts",
    `<header class="page-head"><h1>Review drafts</h1></header>
<section class="card stack-sm"><h2 class="label">Nothing yet</h2><p>The analysis tables are created on the sync Worker's next run. Drafts appear here after that.</p></section>`
  );
}

// ---------------------------------------------------------------------------
// List

async function list(db, url) {
  const status = STATUS_NAMES[url.searchParams.get("status")] ? url.searchParams.get("status") : "ai_draft";
  const where = status === "all" ? "" : "AND a.status = ?";
  const stmt = db.prepare(
    `SELECT a.id, a.bill_id, a.status, a.basis, a.created_at, a.reviewer, a.reviewed_at, a.quote_check, a.citation_check,
            b.bill_number, b.title, b.level
     FROM bill_analyses a JOIN bills b ON b.id = a.bill_id
     WHERE a.current = 1 ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 200`
  );
  const { results } = await (status === "all" ? stmt : stmt.bind(status)).all();
  const counts = await db
    .prepare("SELECT status, COUNT(*) AS n FROM bill_analyses WHERE current = 1 GROUP BY status")
    .all()
    .then((r) => Object.fromEntries(r.results.map((x) => [x.status, x.n])));
  const pending = await db.prepare("SELECT COUNT(*) AS n FROM analysis_requests WHERE status = 'pending'").first();
  const tabs = Object.entries(STATUS_NAMES)
    .map(([k, name]) => {
      const n = k === "all" ? Object.values(counts).reduce((x, y) => x + y, 0) : counts[k] || 0;
      return `<a class="chip chip-tab ${k === status ? "chip--navy" : "chip--outline"}" href="/admin/review/?status=${k}"${k === status ? ' aria-current="page"' : ""}>${esc(name)} (${n})</a>`;
    })
    .join("");
  const rows = results
    .map((r) => {
      const a = parse(r);
      const fixes = (a.quote_check.replaced || []).length + (a.citation_check.removed_citations || []).length;
      const meta = [
        r.level === "federal" ? "Federal" : "State",
        `drafted ${fmtDate(r.created_at)}`,
        r.basis === "full_text" ? null : r.basis === "summary_only" ? "summary only" : "partial text",
        fixes ? `${fixes} automatic fix${fixes === 1 ? "" : "es"}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
      return `
<a class="list-row link-row" href="/admin/review/${r.id}/">
  <div class="stack-sm"><div class="list-title">${esc(r.bill_number)}: ${esc(r.title)}</div><div class="list-meta">${esc(meta)}</div><div>${badge(r)}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
    })
    .join("");
  return adminPage(
    "Review drafts",
    `<header class="page-head">
  <h1>Review drafts</h1>
  <p class="subtitle">AI drafts, newest first: constitutional analyses of bills, and agenda summaries. Nothing is marked reviewed until you approve it.</p>
</header>
<h2 class="label">Bill analyses</h2>
<div class="chips" role="navigation" aria-label="Filter by status">${tabs}</div>
${pending && pending.n ? `<p class="hint">${pending.n} new draft${pending.n === 1 ? "" : "s"} requested; they're written on the sync Worker's next run.</p>` : ""}
<section class="card">${rows || '<p class="secondary small">Nothing here.</p>'}</section>
${await agendaSection(db)}
${await linkSection(db)}`
  );
}

// ---------------------------------------------------------------------------
// Agenda watch: summaries and suggested issue links

async function agendaSection(db) {
  let rows = [];
  try {
    rows = (
      await db
        .prepare(
          `SELECT s.id, s.status, s.created_at, s.reviewer, s.reviewed_at, s.items, s.check_log, m.body, m.starts_at, m.meeting_type
           FROM agenda_summaries s JOIN meetings m ON m.id = s.meeting_id WHERE s.current = 1
           ORDER BY s.created_at DESC, s.id DESC LIMIT 100`
        )
        .all()
    ).results;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return "";
    throw err;
  }
  const list = rows
    .map((r) => {
      const items = JSON.parse(r.items || "[]");
      const flagged = items.filter((i) => (i.flags || []).length).length;
      const removed = (JSON.parse(r.check_log || "{}").removed_sentences || []).length;
      const meta = [`meeting ${when(r.starts_at).day}`, `drafted ${fmtDate(r.created_at)}`, `${flagged} of ${items.length} items flagged`, removed ? `${removed} sentence(s) removed by the number check` : null]
        .filter(Boolean)
        .join(" · ");
      const b = r.status === "reviewed" ? badge(r) : r.status === "rejected" ? badge(r) : '<span class="review-badge review-badge--draft">AI-drafted from the official agenda</span>';
      return `
<a class="list-row link-row" href="/admin/review/agenda/${r.id}/">
  <div class="stack-sm"><div class="list-title">${esc(r.body)}: ${esc(r.meeting_type || "Meeting")}</div><div class="list-meta">${esc(meta)}</div><div>${b}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
    })
    .join("");
  return `<h2 class="label">Agenda summaries</h2>
<section class="card">${list || '<p class="secondary small">No agenda summaries yet.</p>'}</section>`;
}

async function linkSection(db) {
  let rows = [];
  try {
    rows = (
      await db
        .prepare(
          `SELECT l.*, m.body, m.starts_at, i.number, i.title FROM item_issue_links l
           JOIN meetings m ON m.id = l.meeting_id
           LEFT JOIN meeting_items i ON i.meeting_id = l.meeting_id AND i.item_key = l.item_key
           WHERE l.status = 'suggested' ORDER BY l.created_at DESC LIMIT 100`
        )
        .all()
    ).results;
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return "";
    throw err;
  }
  const list = rows
    .map((l) => {
      const issue = ISSUES[l.issue_slug];
      return `
<div class="list-row stack-sm link-suggestion">
  <p class="small"><strong>${esc(l.body)}, ${esc(when(l.starts_at).day)}, item ${esc(l.number || l.item_key)}:</strong> ${esc(l.title || "")}</p>
  <p class="small">→ Issue: <a class="inline-link" href="${esc(issue ? issue.url : "#")}">${esc(issue ? issue.title : l.issue_slug)}</a></p>
  ${l.reason ? `<p class="small secondary">Why (${esc(l.suggested_by)}): ${esc(l.reason)}</p>` : ""}
  <div class="watch-actions">
    <form method="post" action="/admin/review/link/${l.id}/"><input type="hidden" name="action" value="approve"><button class="btn btn--primary" type="submit">Approve link</button></form>
    <form method="post" action="/admin/review/link/${l.id}/"><input type="hidden" name="action" value="reject"><button class="btn" type="submit">Reject</button></form>
  </div>
</div>`;
    })
    .join("");
  return `<h2 class="label">Suggested issue links</h2>
<p class="hint">Links between flagged agenda items and issues. None shows on the site until you approve it.</p>
<section class="card">${list || '<p class="secondary small">No suggestions waiting.</p>'}</section>`;
}

async function linkChange(db, id, request, email) {
  const form = await request.formData();
  const action = form.get("action");
  if (action === "approve") {
    await db.prepare("UPDATE item_issue_links SET status = 'approved', approved_by = ?, approved_at = datetime('now') WHERE id = ?").bind(email, id).run();
  } else if (action === "reject") {
    await db.prepare("UPDATE item_issue_links SET status = 'rejected', approved_by = NULL, approved_at = NULL WHERE id = ?").bind(id).run();
  }
  return Response.redirect(`${new URL(request.url).origin}/admin/review/`, 303);
}

async function agendaDetail(db, env, id, { error = "", done = "", form = null } = {}) {
  const row = await db.prepare("SELECT * FROM agenda_summaries WHERE id = ?").bind(id).first();
  if (!row) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  const m = await db.prepare("SELECT * FROM meetings WHERE id = ?").bind(row.meeting_id).first();
  const items = (await db.prepare("SELECT * FROM meeting_items WHERE meeting_id = ? ORDER BY sort").bind(row.meeting_id).all()).results;
  const summaries = JSON.parse(row.items || "[]");
  const byKey = new Map(summaries.map((x) => [x.item_key, x]));
  const log = JSON.parse(row.check_log || "{}");
  const history = (
    await db.prepare("SELECT action, actor, note, created_at, summary_id FROM agenda_summary_revisions WHERE meeting_id = ? ORDER BY id DESC LIMIT 50").bind(row.meeting_id).all()
  ).results;
  const pendingRegen = await db.prepare("SELECT id FROM agenda_requests WHERE meeting_id = ? AND status = 'pending'").bind(row.meeting_id).first();
  const preview = items
    .map((it) => {
      const sm = byKey.get(it.item_key);
      return `<li class="agenda-item"><p><strong>${esc(it.number)}.</strong> ${esc(it.title)}</p>
  ${sm ? `<p class="small">${esc(sm.summary)}</p><div class="chips">${(sm.flags || []).map((f) => `<span class="chip chip--flag">${esc(FLAG_LABELS[f] || f)}</span>`).join("")}</div>` : '<p class="small secondary">No summary.</p>'}</li>`;
    })
    .join("");
  const removed = (log.removed_sentences || []).map((r) => `<li>Item ${esc(r.item_key)}: “${esc(r.sentence)}” (${esc(r.because)})</li>`).join("");
  const dropped = (log.dropped_items || []).map((r) => `<li>Item ${esc(r.item_key)}: ${esc(r.reason)}</li>`).join("");
  const actions = row.current
    ? `
<section class="card stack-sm">
  <h2 class="label">Decision</h2>
  <form method="post" class="stack-sm"><input type="hidden" name="action" value="approve">
    <label class="field"><span class="field-label">Your name, as shown on the page</span><input class="input" name="reviewer" required value="${esc(row.reviewer || env.REVIEWER_NAME || "")}"></label>
    <button class="btn btn--primary" type="submit">Approve as reviewed</button></form>
  <form method="post" class="stack-sm"><input type="hidden" name="action" value="reject">
    <label class="field"><span class="field-label">Reason for rejecting (kept in the history)</span><input class="input" name="note"></label>
    <button class="btn" type="submit">Reject</button></form>
  ${row.status !== "ai_draft" ? '<form method="post"><input type="hidden" name="action" value="reopen"><button class="btn" type="submit">Return to draft</button></form>' : ""}
  <form method="post"><input type="hidden" name="action" value="regenerate"><button class="btn" type="submit"${pendingRegen ? " disabled" : ""}>${pendingRegen ? "New draft requested" : "Ask for a new draft"}</button></form>
</section>`
    : '<p class="banner">This is an earlier version.</p>';
  const main = `
<header class="page-head">
  <p class="label">Agenda summary ${row.id} · ${esc(row.status)}</p>
  <h1>${esc(m ? m.body : row.meeting_id)}</h1>
  <p class="secondary">${m ? esc(when(m.starts_at).long) : ""} · <a class="inline-link" href="${meetingHref(row.meeting_id)}">Public meeting page</a>${m && safeUrl(m.source_url) ? ` · <a class="inline-link" href="${esc(m.source_url)}" target="_blank" rel="noopener">Official agenda ↗</a>` : ""}</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${actions}
<section class="card stack-sm"><h2 class="label">Preview</h2><ol class="plain-list agenda-items">${preview}</ol></section>
<section class="card stack-sm">
  <h2 class="label">What the automatic checks did</h2>
  ${removed ? `<p class="small">Sentences removed because they state a number the agenda item doesn't:</p><ul class="panel-list small">${removed}</ul>` : '<p class="small">No sentences removed.</p>'}
  ${dropped ? `<ul class="panel-list small">${dropped}</ul>` : ""}
  <p class="small secondary">Model ${esc(row.model)} · prompt ${esc(row.prompt_version)} · tokens in ${row.input_tokens ?? "?"}, out ${row.output_tokens ?? "?"}</p>
</section>
${
  row.current
    ? `<form method="post" class="card stack">
  <h2 class="label">Edit</h2>
  <input type="hidden" name="action" value="save">
  ${field("items", "Summaries and flags (JSON)", form ? form.items : pretty(summaries), { rows: 16, hint: `A list of {"item_key", "summary", "flags"}; flags from: ${FLAGS.join(", ")}.` })}
  <button class="btn btn--primary" type="submit">Save changes</button>
</form>`
    : ""
}
<section class="card stack-sm"><h2 class="label">History</h2><ul class="panel-list small">${history
    .map((h) => `<li>${fmtDate(h.created_at)}: ${esc(h.action)} (summary ${h.summary_id}) by ${esc(h.actor)}${h.note ? `: ${esc(h.note)}` : ""}</li>`)
    .join("")}</ul></section>`;
  return adminPage(`Review: ${m ? m.body : "agenda"}`, main, error ? 400 : 200);
}

async function agendaChange(db, env, id, request, email) {
  const row = await db.prepare("SELECT * FROM agenda_summaries WHERE id = ?").bind(id).first();
  if (!row) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  if (!row.current) return agendaDetail(db, env, id, { error: "Earlier versions can't be changed." });
  const form = await request.formData();
  const action = form.get("action");
  const back = (msg) => Response.redirect(`${new URL(request.url).origin}/admin/review/agenda/${id}/?done=${encodeURIComponent(msg)}`, 303);
  const snap = (act, note) =>
    db.prepare("INSERT INTO agenda_summary_revisions (summary_id, meeting_id, action, actor, note, snapshot) VALUES (?, ?, ?, ?, ?, ?)").bind(row.id, row.meeting_id, act, email, note || null, JSON.stringify(row));
  if (action === "approve") {
    const reviewer = String(form.get("reviewer") || "").trim();
    if (!reviewer) return agendaDetail(db, env, id, { error: "Enter your name to approve." });
    await db.batch([snap("approved"), db.prepare("UPDATE agenda_summaries SET status = 'reviewed', reviewer = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE id = ?").bind(reviewer, email, id)]);
    return back("Approved.");
  }
  if (action === "reject") {
    await db.batch([snap("rejected", String(form.get("note") || "").trim()), db.prepare("UPDATE agenda_summaries SET status = 'rejected', reviewer = NULL, reviewed_at = datetime('now') WHERE id = ?").bind(id)]);
    return back("Rejected. The meeting page no longer shows these summaries.");
  }
  if (action === "reopen") {
    await db.batch([snap("reopened"), db.prepare("UPDATE agenda_summaries SET status = 'ai_draft', reviewer = NULL, reviewer_email = NULL, reviewed_at = NULL WHERE id = ?").bind(id)]);
    return back("Returned to draft.");
  }
  if (action === "regenerate") {
    const pending = await db.prepare("SELECT id FROM agenda_requests WHERE meeting_id = ? AND status = 'pending'").bind(row.meeting_id).first();
    if (!pending) await db.prepare("INSERT INTO agenda_requests (meeting_id, requested_by) VALUES (?, ?)").bind(row.meeting_id, email).run();
    return back("New draft requested. It's written on the sync Worker's next run; this version stays in the history.");
  }
  if (action !== "save") return agendaDetail(db, env, id, { error: "Unknown action." });
  const text = String(form.get("items") || "");
  const keys = new Set((await db.prepare("SELECT item_key FROM meeting_items WHERE meeting_id = ?").bind(row.meeting_id).all()).results.map((r) => r.item_key));
  let items;
  try {
    items = JSON.parse(text);
    if (!Array.isArray(items)) throw new Error("must be a list");
    items = items.map((x, i) => {
      if (!x || !keys.has(String(x.item_key))) throw new Error(`entry ${i + 1}: item_key must be an item number on this agenda`);
      const flags = Array.isArray(x.flags) ? x.flags : [];
      const bad = flags.filter((f) => !FLAGS.includes(f));
      if (bad.length) throw new Error(`entry ${i + 1}: unknown flag ${bad.join(", ")}`);
      return { item_key: String(x.item_key), summary: String(x.summary || "").trim(), flags: [...new Set(flags)] };
    });
  } catch (err) {
    return agendaDetail(db, env, id, { error: `Summaries: ${err.message}`, form: { items: text } });
  }
  await db.batch([snap("edited"), db.prepare("UPDATE agenda_summaries SET items = ?, edited_by = ?, edited_at = datetime('now') WHERE id = ?").bind(JSON.stringify(items), email, id)]);
  return back(`Saved.${row.status === "reviewed" ? " It's still marked reviewed; approve again to update the date." : ""}`);
}

// ---------------------------------------------------------------------------
// One draft

const paras = (list) => (list || []).join("\n\n");
const fromParas = (s) =>
  String(s || "")
    .split(/\n\s*\n/)
    .map((x) => x.replace(/\s+/g, " ").trim())
    .filter(Boolean);
const pretty = (x) => JSON.stringify(x, null, 2);

function field(name, label, value, { rows = 4, hint = "" } = {}) {
  return `<label class="field"><span class="field-label">${esc(label)}</span>${hint ? `<span class="hint">${esc(hint)}</span>` : ""}<textarea class="textarea${rows > 6 ? " textarea--code" : ""}" name="${name}" rows="${rows}">${esc(value)}</textarea></label>`;
}

function checksLog(a) {
  const q = a.quote_check || {};
  const c = a.citation_check || {};
  const li = (xs) => xs.map((x) => `<li>${x}</li>`).join("");
  const quotes = (q.replaced || []).map(
    (r) => `<strong>${esc(r.field)}</strong>: “${esc(r.given)}” → stored text of ${esc(r.from)}: “${esc(r.stored)}”${r.note ? ` (${esc(r.note)})` : ""}`
  );
  const dropped = (q.dropped || []).map((r) => `Dropped clause <strong>${esc(r.id)}</strong>: ${esc(r.reason)}`);
  const cites = (c.checked || []).map((r) => {
    const u = safeUrl(r.url);
    return `${esc(r.case_name)}, ${esc(r.citation)}: <strong>${esc(r.status)}</strong>${r.message ? ` (${esc(r.message)})` : ""}${u ? ` <a href="${esc(u)}" target="_blank" rel="noopener">CourtListener ↗</a>` : ""}`;
  });
  const removed = (c.removed_sentences || []).map((r) => `<strong>${esc(r.field)}</strong>: “${esc(r.sentence)}” (relied on ${esc(r.because)})`);
  return `
<section class="card stack-sm">
  <h2 class="label">What the automatic checks did</h2>
  <p class="small">${q.checked || 0} Constitution quote${q.checked === 1 ? "" : "s"} checked; ${(q.replaced || []).length} replaced with the stored text.</p>
  ${quotes.length || dropped.length ? `<ul class="panel-list small">${li([...quotes, ...dropped])}</ul>` : ""}
  <p class="small">${(c.checked || []).length} case citation${(c.checked || []).length === 1 ? "" : "s"} looked up in CourtListener; ${(c.removed_citations || []).length} removed.</p>
  ${cites.length ? `<ul class="panel-list small">${li(cites)}</ul>` : ""}
  ${removed.length ? `<p class="small">Sentences removed because they relied on an unverified case:</p><ul class="panel-list small">${li(removed)}</ul>` : ""}
  <p class="small secondary">Model ${esc(a.model)} · prompt ${esc(a.prompt_version)} · tokens in ${a.input_tokens ?? "?"}, out ${a.output_tokens ?? "?"}, cache read ${a.cache_read_tokens ?? "?"}</p>
</section>`;
}

async function detail(db, env, id, { error = "", done = "", form = null, email = "" } = {}) {
  const row = await db.prepare("SELECT * FROM bill_analyses WHERE id = ?").bind(id).first();
  if (!row) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  const b = await db.prepare("SELECT * FROM bills WHERE id = ?").bind(row.bill_id).first();
  const a = parse(row);
  const provisions = await provisionsFor(db, a.clauses.map((c) => c.id));
  const f = form || {
    plain_summary: a.plain_summary,
    clauses: pretty(a.clauses),
    aligns: paras(a.aligns),
    tension: paras(a.tension),
    departure: paras(a.departure),
    article_v: a.article_v,
    readings: pretty(a.readings),
    citations: pretty(a.citations),
    uncertainty: a.uncertainty,
    basis_note: a.basis_note || "",
  };
  const history = (
    await db
      .prepare("SELECT id, analysis_id, action, actor, note, created_at FROM bill_analysis_revisions WHERE bill_id = ? ORDER BY id DESC LIMIT 50")
      .bind(row.bill_id)
      .all()
  ).results;
  const versions = (
    await db.prepare("SELECT id, status, created_at, current FROM bill_analyses WHERE bill_id = ? ORDER BY id DESC").bind(row.bill_id).all()
  ).results;
  const pendingRegen = await db
    .prepare("SELECT requested_at FROM analysis_requests WHERE bill_id = ? AND status = 'pending'")
    .bind(row.bill_id)
    .first();

  const actions = row.current
    ? `
<section class="card stack-sm">
  <h2 class="label">Decision</h2>
  <p class="small">Current status: ${badge(row)}</p>
  <form method="post" class="stack-sm">
    <input type="hidden" name="action" value="approve">
    <label class="field"><span class="field-label">Your name, as shown on the page</span>
      <input class="input" name="reviewer" required value="${esc(row.reviewer || env.REVIEWER_NAME || "")}" autocomplete="name"></label>
    <button class="btn btn--primary" type="submit">Approve as reviewed</button>
  </form>
  <form method="post" class="stack-sm">
    <input type="hidden" name="action" value="reject">
    <label class="field"><span class="field-label">Reason for rejecting (kept in the history, not shown publicly)</span><input class="input" name="note"></label>
    <button class="btn" type="submit">Reject</button>
  </form>
  ${row.status !== "ai_draft" ? '<form method="post"><input type="hidden" name="action" value="reopen"><button class="btn" type="submit">Return to draft</button></form>' : ""}
  <form method="post">
    <input type="hidden" name="action" value="regenerate">
    <button class="btn" type="submit"${pendingRegen ? " disabled" : ""}>${pendingRegen ? "New draft requested" : "Ask for a new draft"}</button>
  </form>
  <p class="hint">A new draft is written on the sync Worker's next run (daily, or open its /analyze link). This version is kept in the history.</p>
</section>`
    : `<p class="banner">This is an earlier version. <a href="/admin/review/${versions.find((v) => v.current)?.id || ""}/">Open the current one</a>.</p>`;

  const main = `
<header class="page-head">
  <p class="label">${esc(b ? b.bill_number : row.bill_id)} · analysis ${row.id}</p>
  <h1>${esc(b ? b.title : row.bill_id)}</h1>
  <p class="secondary"><a class="inline-link" href="/laws/bills/${esc(row.bill_id)}/">Public bill page</a></p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${actions}
<h2 class="label">Preview</h2>
${baselineSection(a, provisions)}
${checksLog(a)}
${
  row.current
    ? `<form method="post" class="card stack">
  <h2 class="label">Edit</h2>
  <p class="hint">Quotes from the Constitution are checked against the stored text when you save, and replaced if they don't match. Cases must link to their CourtListener page.</p>
  <input type="hidden" name="action" value="save">
  ${field("plain_summary", "What the bill does", f.plain_summary, { rows: 5 })}
  ${field("basis_note", "Limited note (blank if based on the full text)", f.basis_note, { rows: 1 })}
  ${field("clauses", "Provisions it touches (JSON)", f.clauses, { rows: 10, hint: 'A list of {"id", "quote", "why"}; id is a provision ID from /laws/constitution/.' })}
  ${field("aligns", "Where it aligns", f.aligns, { rows: 5, hint: "One point per paragraph (blank line between)." })}
  ${field("tension", "Where it may be in tension", f.tension, { rows: 5, hint: "One point per paragraph." })}
  ${field("departure", "Why this might still serve the public", f.departure, { rows: 5, hint: "One point per paragraph." })}
  ${field("article_v", "Article V", f.article_v, { rows: 3 })}
  ${field("readings", "How different approaches read it (JSON)", f.readings, { rows: 8, hint: 'A list of {"question", "original_meaning", "precedent", "evolving"}; [] for none.' })}
  ${field("citations", "Cases cited (JSON)", f.citations, { rows: 8, hint: 'A list of {"case_name", "citation", "url", "point"}; url must be a courtlistener.com page.' })}
  ${field("uncertainty", "What this analysis can't tell you", f.uncertainty, { rows: 4 })}
  <button class="btn btn--primary" type="submit">Save changes</button>
</form>`
    : ""
}
<section class="card stack-sm">
  <h2 class="label">Versions</h2>
  <ul class="panel-list small">${versions
    .map((v) => `<li><a href="/admin/review/${v.id}/">Analysis ${v.id}</a>, ${fmtDate(v.created_at)}, ${esc(v.status)}${v.current ? " (current)" : ""}</li>`)
    .join("")}</ul>
  <h2 class="label">History</h2>
  <ul class="panel-list small">${history
    .map((h) => `<li>${fmtDate(h.created_at)} ${esc(h.created_at.slice(11, 16))} UTC: ${esc(h.action)} (analysis ${h.analysis_id}) by ${esc(h.actor)}${h.note ? `: ${esc(h.note)}` : ""}</li>`)
    .join("")}</ul>
</section>`;
  return adminPage(`Review: ${b ? b.bill_number : row.bill_id}`, main, error ? 400 : 200);
}

// ---------------------------------------------------------------------------
// Changes

function jsonList(text, name, keys) {
  let v;
  try {
    v = JSON.parse(text || "[]");
  } catch (err) {
    throw new Error(`${name}: not valid JSON (${err.message})`);
  }
  if (!Array.isArray(v)) throw new Error(`${name}: must be a list`);
  return v.map((x, i) => {
    if (!x || typeof x !== "object") throw new Error(`${name} item ${i + 1}: must be an object`);
    const out = {};
    for (const k of keys) out[k] = typeof x[k] === "string" ? x[k].trim() : "";
    return out;
  });
}

async function revision(db, row, action, actor, note) {
  return db
    .prepare("INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(row.id, row.bill_id, action, actor, note || null, JSON.stringify(row));
}

async function change(db, env, id, request, email) {
  const row = await db.prepare("SELECT * FROM bill_analyses WHERE id = ?").bind(id).first();
  if (!row) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  if (!row.current) return detail(db, env, id, { error: "Earlier versions can't be changed." });
  const form = await request.formData();
  const action = form.get("action");
  const back = (msg) => Response.redirect(`${new URL(request.url).origin}/admin/review/${id}/?done=${encodeURIComponent(msg)}`, 303);

  if (action === "approve") {
    const reviewer = String(form.get("reviewer") || "").trim();
    if (!reviewer) return detail(db, env, id, { error: "Enter your name to approve." });
    await db.batch([
      await revision(db, row, "approved", email),
      db
        .prepare("UPDATE bill_analyses SET status = 'reviewed', reviewer = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE id = ?")
        .bind(reviewer, email, id),
    ]);
    return back(`Approved. The bill page now shows "Reviewed by ${reviewer}".`);
  }
  if (action === "reject") {
    await db.batch([
      await revision(db, row, "rejected", email, String(form.get("note") || "").trim()),
      db.prepare("UPDATE bill_analyses SET status = 'rejected', reviewer = NULL, reviewer_email = ?, reviewed_at = datetime('now') WHERE id = ?").bind(email, id),
    ]);
    return back("Rejected. The bill page no longer shows this analysis.");
  }
  if (action === "reopen") {
    await db.batch([
      await revision(db, row, "reopened", email),
      db.prepare("UPDATE bill_analyses SET status = 'ai_draft', reviewer = NULL, reviewer_email = NULL, reviewed_at = NULL WHERE id = ?").bind(id),
    ]);
    return back("Returned to draft.");
  }
  if (action === "regenerate") {
    const pending = await db.prepare("SELECT id FROM analysis_requests WHERE bill_id = ? AND status = 'pending'").bind(row.bill_id).first();
    if (!pending) {
      await db.prepare("INSERT INTO analysis_requests (bill_id, requested_by) VALUES (?, ?)").bind(row.bill_id, email).run();
    }
    return back("New draft requested. It's written on the sync Worker's next run; this version stays in the history.");
  }
  if (action !== "save") return detail(db, env, id, { error: "Unknown action." });

  // Save edits.
  const f = Object.fromEntries(["plain_summary", "clauses", "aligns", "tension", "departure", "article_v", "readings", "citations", "uncertainty", "basis_note"].map((k) => [k, String(form.get(k) || "")]));
  let draft;
  try {
    draft = {
      plain_summary: f.plain_summary.trim(),
      clauses: jsonList(f.clauses, "Provisions", ["id", "quote", "why"]),
      aligns: fromParas(f.aligns),
      tension: fromParas(f.tension),
      departure: fromParas(f.departure),
      article_v: f.article_v.trim(),
      readings: jsonList(f.readings, "Readings", ["question", "original_meaning", "precedent", "evolving"]),
      citations: jsonList(f.citations, "Cases", ["case_name", "citation", "url", "point"]),
      uncertainty: f.uncertainty.trim(),
    };
    if (!draft.plain_summary) throw new Error("What the bill does can't be empty.");
    for (const c of draft.citations) {
      if (!/^https:\/\/www\.courtlistener\.com\/.+/.test(c.url)) throw new Error(`Case "${c.case_name}": url must be its CourtListener page.`);
    }
  } catch (err) {
    return detail(db, env, id, { error: err.message, form: f, email });
  }
  const provisions = (await db.prepare("SELECT id, parent_id AS parent, label, text, leaf FROM constitution_provisions").all()).results;
  const known = new Set(provisions.map((p) => p.id));
  const unknown = draft.clauses.filter((c) => !known.has(c.id)).map((c) => c.id);
  if (unknown.length) return detail(db, env, id, { error: `No provision with ID: ${unknown.join(", ")}`, form: f, email });
  const log = verifyQuotes(draft, provisions);
  await db.batch([
    await revision(db, row, "edited", email),
    db
      .prepare(
        `UPDATE bill_analyses SET plain_summary = ?, clauses = ?, aligns = ?, tension = ?, departure = ?, article_v = ?,
           readings = ?, citations = ?, uncertainty = ?, basis_note = ?, edited_by = ?, edited_at = datetime('now') WHERE id = ?`
      )
      .bind(
        draft.plain_summary,
        JSON.stringify(draft.clauses),
        JSON.stringify(draft.aligns),
        JSON.stringify(draft.tension),
        JSON.stringify(draft.departure),
        draft.article_v,
        JSON.stringify(draft.readings),
        JSON.stringify(draft.citations),
        draft.uncertainty,
        f.basis_note.trim() || null,
        email,
        id
      ),
  ]);
  const fixed = log.replaced.length ? ` ${log.replaced.length} quote${log.replaced.length === 1 ? " didn't" : "s didn't"} match the stored Constitution and ${log.replaced.length === 1 ? "was" : "were"} replaced with its exact text.` : "";
  return back(`Saved.${fixed}${row.status === "reviewed" ? " It's still marked reviewed; approve again to update the date." : ""}`);
}

// ---------------------------------------------------------------------------

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const who = await checkAccess(request, env);
  if (!who.ok) return locked(who.reason);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return Response.redirect(`${url.origin}/admin/review/`, 302);
  if (parts[0] !== "review") return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  if (!env.DB) return missingTables();
  if (parts[1] === "agenda" || parts[1] === "link") {
    const sub = parseInt(parts[2], 10);
    if (parts.length !== 3 || !(sub > 0)) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
    try {
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
        return parts[1] === "agenda" ? await agendaChange(env.DB, env, sub, request, who.email) : await linkChange(env.DB, sub, request, who.email);
      }
      if (parts[1] === "link") return Response.redirect(`${url.origin}/admin/review/`, 302);
      return await agendaDetail(env.DB, env, sub, { done: url.searchParams.get("done") || "" });
    } catch (err) {
      if (/no such table/i.test(String(err && err.message))) return missingTables();
      throw err;
    }
  }
  const id = parts[1] ? parseInt(parts[1], 10) : null;
  if (parts.length > 2 || (parts[1] && !(id > 0))) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  try {
    if (request.method === "POST") {
      // Same-origin posts only.
      const origin = request.headers.get("Origin");
      if (!id || (origin && origin !== url.origin)) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
      return await change(env.DB, env, id, request, who.email);
    }
    if (!id) return await list(env.DB, url);
    return await detail(env.DB, env, id, { done: url.searchParams.get("done") || "", email: who.email });
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return missingTables();
    throw err;
  }
}

export const onRequestGet = handle;
export const onRequestPost = handle;
