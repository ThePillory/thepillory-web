// /admin/review/          the review queue: flagged by the AI reviewer, flagged by readers,
//                         spot checks; the agreement rate; bills the relevance check skipped;
//                         every analysis by status; agenda summaries and issue links
// /admin/review/<id>/     one analysis: why it's in the queue, preview, what the checks changed,
//                         edit any field, approve, reject, reopen, ask for a new draft or a
//                         full analysis, close reader reports; full history
// POST /admin/review/relevance/<bill id>/   un-skip (or skip again) a bill
// /admin/review/promise/<id>/   one promise: approve or reject a suggestion, edit its note,
//                         record a status change (evidence and source required), history
// /admin/review/promise/new/    add a promise by hand (a meeting video with its time, an
//                         interview…): approved as it's saved, with the person's name
// POST /admin/review/promise/batch/   approve the ticked suggestions at once
// /admin/review/promise/pages/  campaign and office "Issues" or "Priorities" pages the sync reads,
//                         and the excerpt each shows under "In their own words" (choose, hide)
// /admin/review/promise/statements/  statements officials' offices sent in ("Submitted by the official")
// /admin/review/promise/candidates/  candidates' issues pages found on their campaign websites, and
//                         the excerpt each shows on the Platform tab (remove a wrong page, hide, re-pick)
// /admin/waitlist/        "Bring ThePillory to your county": sign-ups by county (counts only)
//
// Protected by Cloudflare Access (see functions/_lib/access.js and docs/analysis.md).
// Every change writes a bill_analysis_revisions row with the row as it was before.
import { page, esc, fmtDate, safeUrl, guard } from "../_lib/render.js";
import { checkAccess } from "../_lib/access.js";
import { inChunks } from "../_lib/data.js";
import { parse, badge, baselineSection, provisionsFor } from "../_lib/analysis.js";
import { orderHref } from "../_lib/orders.js";
import { verifyQuotes } from "../../workers/sync/src/analysis/verify.js";
import { CHECKS, CHECK_LABELS } from "../../workers/sync/src/analysis/review-checks.js";
import { summarizeFlags } from "../../workers/sync/src/analysis/flags.js";
import { FLAGS, FLAG_LABELS, IMPACT, MAX_FLAGGED } from "../../workers/sync/src/analysis/agenda-check.js";
import { ISSUES } from "../_lib/generated.js";
import { when, meetingHref } from "../_lib/meetings.js";
import { STATUS, STATUSES, SOURCE_KIND, statusChip, historyList, sourceHref, checkedLine, FLAG_REASONS as PROMISE_FLAG_REASONS } from "../_lib/promises.js";
import { checkEntry, checkPage, checkStatement, selectedIds, officialLabel, PAGE_KINDS } from "../_lib/promise-entry.js";
import { checkExcerpt } from "../../workers/sync/src/promises/excerpt.js";
import { wordingProblems, quoteKey } from "../../workers/sync/src/promises/check.js";
import { KINDS as TOPIC_KINDS, itemFromLink, reviewHref, topicReviewList, topicReviewItem, topicReviewChange } from "../_lib/topic-review.js";

// Browse every current analysis by where it stands.
const BROWSE = {
  auto: ["Published, auto-checked", "a.status = 'ai_draft' AND a.ai_review = 'pass'"],
  reviewed: ["Reviewed by you", "a.status = 'reviewed'"],
  waiting: ["Waiting for the AI reviewer", "a.status = 'ai_draft' AND a.ai_review IS NULL"],
  rejected: ["Rejected", "a.status = 'rejected'"],
  all: ["All", "1 = 1"],
};
const FLAG_REASON_NAMES = { inaccurate: "Inaccurate", unfair: "Unfair to one side", missing: "Missing perspective", other: "Other" };
const CHECK_QUESTIONS = Object.fromEntries(CHECKS);

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
<section class="card stack-sm"><h2 class="label">Nothing yet</h2><p>The sync Worker hasn't set up the latest analysis tables yet. They're created on its next run, or as soon as you open its /status link. The review queue appears here after that.</p></section>`
  );
}

// ---------------------------------------------------------------------------
// List

// A subject is a bill or an executive order (migration 0018): both are listed.
const ROW_SQL = `SELECT a.id, a.bill_id, a.status, a.depth, a.basis, a.created_at, a.reviewer, a.reviewed_at, a.ai_review,
    a.ai_review_detail, a.spot_check,
    COALESCE(b.bill_number, CASE WHEN x.number IS NOT NULL THEN 'Executive Order ' || x.number ELSE 'Executive order' END) AS bill_number,
    COALESCE(b.title, x.title) AS title,
    COALESCE(b.level, CASE WHEN x.id LIKE 'fr:%' THEN 'federal' ELSE 'state' END) AS level,
    (SELECT COUNT(*) FROM analysis_flags f WHERE f.analysis_id = a.id AND f.status = 'open') AS open_flags
  FROM bill_analyses a LEFT JOIN bills b ON b.id = a.bill_id LEFT JOIN executive_actions x ON x.id = a.bill_id
  WHERE a.current = 1 AND (b.id IS NOT NULL OR x.id IS NOT NULL)`;

function analysisRow(r, why) {
  const meta = [
    r.level === "federal" ? "Federal" : "State",
    r.depth === "card" ? "short card" : "full analysis",
    `drafted ${fmtDate(r.created_at)}`,
    r.basis === "full_text" ? null : r.basis === "summary_only" ? "summary only" : "partial text",
  ]
    .filter(Boolean)
    .join(" · ");
  return `
<a class="list-row link-row" href="/admin/review/${r.id}/">
  <div class="stack-sm"><div class="list-title">${esc(r.bill_number)}: ${esc(r.title)}</div><div class="list-meta">${esc(meta)}</div>
  ${why ? `<div class="queue-why">${why}</div>` : ""}<div class="chips">${badge(r, false)}${r.open_flags ? '<span class="review-badge review-badge--flag">Under review</span>' : ""}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

/** Why drafts are flagged: which checks fail most often, and how serious. */
function flagSummary(rows) {
  const s = summarizeFlags(rows.map((r) => ({ bill_id: r.bill_id, detail: parse(r).ai_review_detail || {} })));
  if (!s.drafts) return "";
  const top = Object.entries(s.by_check).filter(([, n]) => n).sort((a, b) => b[1] - a[1]);
  const sev = s.by_severity;
  return `<section class="card stack-sm" aria-label="Why drafts are flagged">
  <p class="label">Why ${s.drafts === 1 ? "this draft is" : `these ${s.drafts} drafts are`} flagged</p>
  <ul class="plain-list money-list">${top.map(([id, n]) => `<li class="money-row"><span>${esc(CHECK_LABELS[id])}</span><span class="money-amt">${n}</span></li>`).join("")}</ul>
  <p class="hint">Failed checks across the flagged drafts (a draft can fail more than one).${
    sev.major || sev.minor ? ` Rated major: ${sev.major}; minor: ${sev.minor}.` : ""
  }${sev.unrated ? ` ${sev.unrated} from reviews before major and minor were rated; those drafts are reviewed again under the current rules, and only major problems stay here.` : ""}</p>
</section>`;
}

function aiReasons(r) {
  const d = parse(r).ai_review_detail || {};
  const reasons = d.reasons || [];
  return reasons.length ? `<ul class="panel-list small">${reasons.slice(0, 3).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>` : "";
}

/** Your agreement with the AI reviewer, from every decision on a draft it looked at. */
async function agreementCard(db) {
  const { results } = await db.prepare("SELECT ai_review, human_agrees FROM bill_analyses WHERE human_agrees IS NOT NULL").all();
  const pct = (xs) => (xs.length ? Math.round((100 * xs.filter((x) => x.human_agrees === 1).length) / xs.length) : null);
  const all = pct(results);
  const passes = results.filter((r) => r.ai_review === "pass");
  const flags = results.filter((r) => r.ai_review === "flag");
  const line = (label, xs) =>
    `<li>${label}: ${xs.length ? `you agreed on ${xs.filter((x) => x.human_agrees === 1).length} of ${xs.length} (${pct(xs)}%)` : "no decisions yet"}</li>`;
  return `
<section class="card stack-sm" id="agreement">
  <h2 class="label">Your agreement with the AI reviewer</h2>
  <p class="stat-line"><strong>${all == null ? "—" : `${all}%`}</strong> <span class="small secondary">${results.length ? `of ${results.length} decision${results.length === 1 ? "" : "s"}` : "no decisions yet"}</span></p>
  <ul class="panel-list small">
    ${line("Drafts it passed (spot checks and reader reports)", passes)}
    ${line("Drafts it flagged", flags)}
  </ul>
  <p class="hint">Agreeing means: it passed a draft and you approved it unchanged, or it flagged one and you rejected or edited it. Around 30 decisions give a fair first read.</p>
</section>`;
}

async function readerReasons(db, ids) {
  if (!ids.length) return new Map();
  const results = await inChunks(ids, async (chunk) =>
    (
      await db
        .prepare(`SELECT analysis_id, reason, note, created_at FROM analysis_flags WHERE status = 'open' AND analysis_id IN (${chunk.map(() => "?").join(",")}) ORDER BY id`)
        .bind(...chunk)
        .all()
    ).results);
  const out = new Map();
  for (const f of results) (out.get(f.analysis_id) || out.set(f.analysis_id, []).get(f.analysis_id)).push(f);
  return out;
}

async function skippedSection(db) {
  const { results } = await db
    .prepare(
      `SELECT r.*, b.bill_number, b.title FROM bill_relevance r JOIN bills b ON b.id = r.bill_id
       WHERE r.verdict = 'skip' ORDER BY r.override IS NOT NULL, r.checked_at DESC LIMIT 100`
    )
    .all();
  const rows = results
    .map(
      (r) => `
<div class="list-row stack-sm">
  <p class="small"><a class="inline-link" href="/laws/bills/${esc(r.bill_id)}/">${esc(r.bill_number)}</a>: ${esc(r.title)}</p>
  <p class="small secondary">${esc(r.category.replace(/_/g, " "))}: ${esc(r.reason)} · checked ${fmtDate(r.checked_at)} (${esc(r.model)})</p>
  ${
    r.override === "unskip"
      ? `<p class="small">Un-skipped by ${esc(r.override_by || "you")}, ${fmtDate(r.override_at)}. It's analyzed like any other bill.</p>
  <form method="post" action="/admin/review/relevance/${encodeURIComponent(r.bill_id)}/"><input type="hidden" name="action" value="skip"><button class="btn" type="submit">Skip again</button></form>`
      : `<form method="post" action="/admin/review/relevance/${encodeURIComponent(r.bill_id)}/"><input type="hidden" name="action" value="unskip"><button class="btn" type="submit">Un-skip: analyze this bill</button></form>`
  }
</div>`
    )
    .join("");
  return `<h2 class="label" id="skipped">Skipped as ceremonial or routine</h2>
<p class="hint">The relevance check sets these aside before any drafting. Un-skip one and it's drafted on the next run.</p>
<section class="card">${rows || '<p class="secondary small">None skipped yet.</p>'}</section>`;
}

async function list(db, url, env) {
  const q = async (where) => (await db.prepare(`${ROW_SQL} AND ${where} ORDER BY a.created_at DESC, a.id DESC LIMIT 100`).all()).results;
  const aiFlagged = await q("a.status = 'ai_draft' AND a.ai_review = 'flag'");
  const readerFlagged = await q("a.status != 'rejected' AND EXISTS (SELECT 1 FROM analysis_flags f WHERE f.analysis_id = a.id AND f.status = 'open')");
  const spot = await q("a.status = 'ai_draft' AND a.ai_review = 'pass' AND a.spot_check = 1");
  const reports = await readerReasons(db, readerFlagged.map((r) => r.id));

  const browseKey = BROWSE[url.searchParams.get("status")] ? url.searchParams.get("status") : "auto";
  const browsed = await q(BROWSE[browseKey][1]);
  const counts = {};
  for (const k of Object.keys(BROWSE)) counts[k] = (await db.prepare(`SELECT COUNT(*) AS n FROM bill_analyses a WHERE a.current = 1 AND ${BROWSE[k][1]}`).first()).n;
  const tabs = Object.entries(BROWSE)
    .map(
      ([k, [name]]) =>
        `<a class="chip chip-tab ${k === browseKey ? "chip--navy" : "chip--outline"}" href="/admin/review/?status=${k}#browse"${k === browseKey ? ' aria-current="page"' : ""}>${esc(name)} (${counts[k]})</a>`
    )
    .join("");
  const pending = await db.prepare("SELECT COUNT(*) AS n, SUM(source = 'reader') AS readers FROM analysis_requests WHERE status = 'pending'").first();

  const queue = (id, title, hint, rows, why) => `
<h2 class="label queue-head" id="${id}">${title} <span class="queue-count">${rows.length}</span></h2>
<p class="hint">${hint}</p>
<section class="card">${rows.map((r) => analysisRow(r, why(r))).join("") || '<p class="secondary small">Nothing waiting.</p>'}</section>`;

  return adminPage(
    "Review drafts",
    `<header class="page-head">
  <h1>Review queue</h1>
  <p class="subtitle">What needs a person. Drafts the AI reviewer passes are published as "AI-drafted, auto-checked"; the rest wait here.</p>
  <p class="small"><a class="inline-link" href="/admin/waitlist/">County waitlist</a></p>
</header>
${await waitingSummary(db)}
${await promiseQueue(db, env, url)}
${queue("flagged-ai", "Flagged by AI", "The AI reviewer found a major problem: a factual error, unfair treatment of one side, or opinion stated as fact. These are hidden from public pages until you decide. Minor problems (completeness, wording) are fixed or noted automatically and don't come here.", aiFlagged, aiReasons)}
${flagSummary(aiFlagged)}
${queue("flagged-readers", "Flagged by readers", 'Readers reported a problem. These stay up, marked "Under review", until you approve, edit, reject or close the reports.', readerFlagged, (r) => {
      const fs = reports.get(r.id) || [];
      return `<ul class="panel-list small">${fs
        .slice(0, 3)
        .map((f) => `<li><strong>${esc(FLAG_REASON_NAMES[f.reason] || f.reason)}</strong>${f.note ? `: ${esc(f.note.slice(0, 200))}` : ""} <span class="secondary">(${fmtDate(f.created_at)})</span></li>`)
        .join("")}${fs.length > 3 ? `<li>and ${fs.length - 3} more</li>` : ""}</ul>`;
    })}
${queue("spot-checks", "Spot checks", "A random share of drafts the AI reviewer passed. They're already public; your decision measures the reviewer.", spot, () => '<p class="small">Spot check: the AI reviewer passed it.</p>')}
${await agreementCard(db)}
${pending && pending.n ? `<p class="hint">${pending.n} new draft${pending.n === 1 ? "" : "s"} requested${pending.readers ? ` (${pending.readers} by readers)` : ""}; they're written on the sync Worker's next run.</p>` : ""}
<h2 class="label" id="browse">All analyses</h2>
<div class="chips" role="navigation" aria-label="Filter by status">${tabs}</div>
<section class="card">${browsed.map((r) => analysisRow(r, "")).join("") || '<p class="secondary small">Nothing here.</p>'}</section>
${await skippedSection(db)}
${await agendaSection(db)}
${await linkSection(db)}`
  );
}

async function relevanceChange(db, billId, request, email) {
  const form = await request.formData();
  const action = form.get("action");
  if (action === "unskip") {
    await db.prepare("UPDATE bill_relevance SET override = 'unskip', override_by = ?, override_at = datetime('now') WHERE bill_id = ?").bind(email, billId).run();
    // A bill with an earlier (rejected) analysis needs a request; one with none is picked up as new.
    const had = await db.prepare("SELECT id FROM bill_analyses WHERE bill_id = ? LIMIT 1").bind(billId).first();
    const pending = await db.prepare("SELECT id FROM analysis_requests WHERE bill_id = ? AND status = 'pending'").bind(billId).first();
    if (had && !pending) await db.prepare("INSERT INTO analysis_requests (bill_id, requested_by, depth, source) VALUES (?, ?, 'card', 'admin')").bind(billId, email).run();
  } else if (action === "skip") {
    await db.prepare("UPDATE bill_relevance SET override = NULL, override_by = NULL, override_at = NULL WHERE bill_id = ?").bind(billId).run();
  }
  return Response.redirect(`${new URL(request.url).origin}/admin/review/#skipped`, 303);
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
  // Links between agenda items and residents' issues. No issues exist until reporting opens.
  if (!Object.keys(ISSUES).length) return "";
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
  ${field("items", "Summaries and flags (JSON)", form ? form.items : pretty(summaries), { rows: 16, hint: `A list of {"item_key", "summary", "impact", "flags"}; impact: ${IMPACT.join(", ")}; flags from: ${FLAGS.join(", ")}. At most ${MAX_FLAGGED} flagged items are shown, by impact; a consent item only when its impact is high.` })}
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
      if (x.impact !== undefined && !IMPACT.includes(x.impact)) throw new Error(`entry ${i + 1}: impact must be one of ${IMPACT.join(", ")}`);
      return { item_key: String(x.item_key), summary: String(x.summary || "").trim(), ...(x.impact ? { impact: x.impact } : {}), flags: [...new Set(flags)] };
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

/** At the top of a queued analysis: why it's here. */
function whySection(a, openFlags) {
  const parts = [];
  const d = a.ai_review_detail || {};
  if (a.status === "ai_draft" && a.ai_review === "flag") {
    parts.push(`<p><strong>Flagged by the AI reviewer.</strong> Hidden from the public bill page until you decide.</p>
  <ul class="panel-list">${(d.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("") || "<li>No reason given.</li>"}</ul>`);
  }
  if (openFlags.length) {
    parts.push(`<p><strong>Flagged by ${openFlags.length} reader report${openFlags.length === 1 ? "" : "s"}.</strong> Still public, marked "Under review".</p>
  <ul class="panel-list">${openFlags.map((f) => `<li>${esc(FLAG_REASON_NAMES[f.reason] || f.reason)}${f.note ? `: ${esc(f.note)}` : ""}</li>`).join("")}</ul>`);
  }
  if (a.status === "ai_draft" && a.ai_review === "pass" && a.spot_check) {
    parts.push("<p><strong>Spot check.</strong> Picked at random from drafts the AI reviewer passed; it's public as \"AI-drafted, auto-checked\". Approve it if it's right, edit or reject it if not: either way it counts toward your agreement rate.</p>");
  }
  if (a.status === "ai_draft" && !a.ai_review) parts.push("<p><strong>Waiting for the AI reviewer.</strong> Not public yet; it's reviewed on the sync Worker's next run.</p>");
  return parts.length ? `<section class="card card--why stack-sm" aria-label="Why this is in the queue">${parts.join("")}</section>` : "";
}

/** The AI reviewer's full checklist. */
function aiReviewSection(a) {
  const d = a.ai_review_detail || {};
  if (!a.ai_review) return "";
  const tokens = (() => {
    try {
      return JSON.parse(a.ai_review_tokens || "{}");
    } catch (_) {
      return {};
    }
  })();
  const checks = (d.checks || [])
    .map((c) => `<li>${c.ok ? "✓" : "✗"} ${esc(CHECK_QUESTIONS[c.id] || c.id)}${!c.ok && (c.severity === "major" || c.severity === "minor") ? ` <strong>(${c.severity})</strong>` : ""}${c.note ? `<br><span class="secondary">${esc(c.note)}</span>` : ""}</li>`)
    .join("");
  return `
<section class="card stack-sm">
  <h2 class="label">AI reviewer: ${a.ai_review === "pass" ? ((d.notes || []).length ? "pass, with minor notes" : "pass") : "flag"}</h2>
  ${d.previous ? `<p class="small secondary">Reviewed again under the current rules (major and minor). The earlier review flagged: ${esc((d.previous.reasons || []).join(" "))}</p>` : ""}
  ${checks ? `<ul class="panel-list small check-list">${checks}</ul>` : `<ul class="panel-list small">${(d.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`}
  <p class="small secondary">Model ${esc(a.ai_review_model || "?")} · reviewed ${fmtDate(a.ai_reviewed_at)} · tokens in ${tokens.input ?? "?"}, out ${tokens.output ?? "?"}</p>
  ${d.revised && d.first_review ? `<details class="small"><summary>Revised once. The first draft was flagged for:</summary><ul class="panel-list">${(d.first_review.reasons || []).map((x) => `<li>${esc(x)}</li>`).join("")}</ul><p class="secondary">The review above is of the revision.</p></details>` : ""}
</section>`;
}

/**
 * Whether your decision agrees with the AI reviewer: it passed the draft and you
 * approved it unchanged, or it flagged it and you rejected or edited it.
 * null when the AI reviewer never looked at it.
 */
function agreement(row, decision) {
  if (!row.ai_review) return null;
  const edited = Boolean(row.edited_at && (!row.ai_reviewed_at || row.edited_at > row.ai_reviewed_at));
  if (row.ai_review === "pass") return decision === "approve" && !edited ? 1 : 0;
  return decision === "reject" || edited ? 1 : 0;
}

function closeFlags(db, row, resolution, email) {
  return db
    .prepare("UPDATE analysis_flags SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE analysis_id = ? AND status = 'open'")
    .bind(resolution, email, row.id);
}

async function detail(db, env, id, { error = "", done = "", form = null, email = "" } = {}) {
  const row = await db.prepare("SELECT * FROM bill_analyses WHERE id = ?").bind(id).first();
  if (!row) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  const bill = await db.prepare("SELECT * FROM bills WHERE id = ?").bind(row.bill_id).first();
  const order = bill ? null : await db.prepare("SELECT * FROM executive_actions WHERE id = ?").bind(row.bill_id).first();
  const b = bill || (order ? { bill_number: order.number ? `Executive Order ${order.number}` : "Executive order", title: order.title } : null);
  const publicHref = order ? orderHref(order.id) : `/laws/bills/${esc(row.bill_id)}/`;
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
    supporters: a.supporters || "",
    critics: a.critics || "",
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
    .prepare("SELECT requested_at, depth FROM analysis_requests WHERE bill_id = ? AND status = 'pending'")
    .bind(row.bill_id)
    .first();
  const flags = (await db.prepare("SELECT * FROM analysis_flags WHERE analysis_id = ? ORDER BY id DESC").bind(row.id).all()).results;
  const openFlags = flags.filter((f) => f.status === "open");

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
    <button class="btn" type="submit"${pendingRegen ? " disabled" : ""}>${pendingRegen ? `New ${pendingRegen.depth === "full" ? "full analysis" : "draft"} requested` : "Ask for a new draft"}</button>
  </form>
  ${
    row.depth === "card" && !pendingRegen
      ? '<form method="post"><input type="hidden" name="action" value="full"><button class="btn" type="submit">Ask for a full analysis</button></form>'
      : ""
  }
  ${
    openFlags.length
      ? `<form method="post"><input type="hidden" name="action" value="dismiss"><button class="btn" type="submit">Keep as is and close ${openFlags.length} reader report${openFlags.length === 1 ? "" : "s"}</button></form>`
      : ""
  }
  <p class="hint">Approving or rejecting also closes open reader reports. A new draft is written on the sync Worker's next run (daily, or open its /analyze link), checked, and reviewed by the AI reviewer again; this version is kept in the history.</p>
</section>`
    : `<p class="banner">This is an earlier version. <a href="/admin/review/${versions.find((v) => v.current)?.id || ""}/">Open the current one</a>.</p>`;

  const main = `
<header class="page-head">
  <p class="label">${esc(b ? b.bill_number : row.bill_id)} · analysis ${row.id}</p>
  <h1>${esc(b ? b.title : row.bill_id)}</h1>
  <p class="secondary"><a class="inline-link" href="${publicHref}">Public ${order ? "order" : "bill"} page</a></p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${whySection(a, openFlags)}
${actions}
<h2 class="label">Preview</h2>
${baselineSection(a, provisions, { underReview: openFlags.length > 0, noun: order ? "order" : "bill" })}
${aiReviewSection(a)}
${flags.length ? `<section class="card stack-sm"><h2 class="label">Reader reports</h2><ul class="panel-list small">${flags
    .map((f) => `<li><strong>${esc(FLAG_REASON_NAMES[f.reason] || f.reason)}</strong>${f.note ? `: ${esc(f.note)}` : ""} (${fmtDate(f.created_at)}; ${f.status === "open" ? "open" : `closed: ${esc(f.resolution || "")}`})</li>`)
    .join("")}</ul></section>` : ""}
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
  ${field("supporters", "Supporters argue", f.supporters, { rows: 2, hint: 'One sentence beginning "Supporters argue that". Shown in the Constitution section.' })}
  ${field("critics", "Critics argue", f.critics, { rows: 2, hint: 'One sentence beginning "Critics argue that", of similar length.' })}
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
        .prepare("UPDATE bill_analyses SET status = 'reviewed', reviewer = ?, reviewer_email = ?, reviewed_at = datetime('now'), human_agrees = ? WHERE id = ?")
        .bind(reviewer, email, agreement(row, "approve"), id),
      closeFlags(db, row, "approved", email),
    ]);
    return back(`Approved. The public page now shows "Reviewed by ${reviewer}".`);
  }
  if (action === "reject") {
    await db.batch([
      await revision(db, row, "rejected", email, String(form.get("note") || "").trim()),
      db
        .prepare("UPDATE bill_analyses SET status = 'rejected', reviewer = NULL, reviewer_email = ?, reviewed_at = datetime('now'), human_agrees = ? WHERE id = ?")
        .bind(email, agreement(row, "reject"), id),
      closeFlags(db, row, "rejected", email),
    ]);
    return back("Rejected. The public page no longer shows this analysis.");
  }
  if (action === "reopen") {
    await db.batch([
      await revision(db, row, "reopened", email),
      db.prepare("UPDATE bill_analyses SET status = 'ai_draft', reviewer = NULL, reviewer_email = NULL, reviewed_at = NULL, human_agrees = NULL WHERE id = ?").bind(id),
    ]);
    return back(row.ai_review === "pass" ? "Returned to draft: public again as \"AI-drafted, auto-checked\"." : "Returned to draft: hidden from the public page until you decide.");
  }
  if (action === "regenerate" || action === "full") {
    const pending = await db.prepare("SELECT id FROM analysis_requests WHERE bill_id = ? AND status = 'pending'").bind(row.bill_id).first();
    if (!pending) {
      await db
        .prepare("INSERT INTO analysis_requests (bill_id, requested_by, depth, source) VALUES (?, ?, ?, 'admin')")
        .bind(row.bill_id, email, action === "full" ? "full" : null)
        .run();
    }
    return back(`${action === "full" ? "Full analysis" : "New draft"} requested. It's written on the sync Worker's next run; this version stays in the history.`);
  }
  if (action === "dismiss") {
    await closeFlags(db, row, "dismissed", email).run();
    return back('Reader reports closed. The analysis is no longer marked "Under review".');
  }
  if (action !== "save") return detail(db, env, id, { error: "Unknown action." });

  // Save edits.
  const f = Object.fromEntries(["plain_summary", "clauses", "aligns", "tension", "departure", "article_v", "readings", "citations", "uncertainty", "basis_note", "supporters", "critics"].map((k) => [k, String(form.get(k) || "")]));
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
      supporters: f.supporters.trim(),
      critics: f.critics.trim(),
    };
    if (!draft.plain_summary) throw new Error("What the bill does can't be empty.");
    if ((draft.supporters && !/^Supporters argue\b/.test(draft.supporters)) || (draft.critics && !/^Critics argue\b/.test(draft.critics))) {
      throw new Error('The two argument lines begin "Supporters argue" and "Critics argue".');
    }
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
  // The argument lines exist once the sync has applied migration 0018.
  const args = row.supporters !== undefined;
  await db.batch([
    await revision(db, row, "edited", email),
    db
      .prepare(
        `UPDATE bill_analyses SET plain_summary = ?, clauses = ?, aligns = ?, tension = ?, departure = ?, article_v = ?,
           readings = ?, citations = ?, uncertainty = ?, basis_note = ?, ${args ? "supporters = ?, critics = ?, " : ""}edited_by = ?, edited_at = datetime('now') WHERE id = ?`
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
        ...(args ? [draft.supporters, draft.critics] : []),
        email,
        id
      ),
  ]);
  const fixed = log.replaced.length ? ` ${log.replaced.length} quote${log.replaced.length === 1 ? " didn't" : "s didn't"} match the stored Constitution and ${log.replaced.length === 1 ? "was" : "were"} replaced with its exact text.` : "";
  return back(`Saved.${fixed}${row.status === "reviewed" ? " It's still marked reviewed; approve again to update the date." : ""}`);
}

// ---------------------------------------------------------------------------
// Waitlist: counts by county. Emails stay in D1 and aren't shown here.

async function waitlist(db) {
  let rows = [];
  let total = null;
  try {
    rows = (
      await db
        .prepare(
          `SELECT county_fips, county_name, COUNT(*) AS n, MIN(created_at) AS first_at, MAX(created_at) AS last_at
           FROM waitlist GROUP BY county_fips, county_name ORDER BY n DESC, county_name`
        )
        .all()
    ).results;
    total = await db.prepare("SELECT COUNT(DISTINCT email) AS people, COUNT(DISTINCT county_fips) AS counties, COUNT(*) AS signups FROM waitlist").first();
  } catch (err) {
    if (/no such table/i.test(String(err && err.message))) return missingTables();
    throw err;
  }
  const table = rows.length
    ? `<div class="card">${rows
        .map(
          (r) => `
<div class="list-row">
  <div><div class="list-title">${esc(r.county_name)}</div><div class="list-meta">FIPS ${esc(r.county_fips)} · first ${fmtDate(r.first_at)} · latest ${fmtDate(r.last_at)}</div></div>
  <span class="row-end"><strong>${r.n}</strong></span>
</div>`
        )
        .join("")}</div>`
    : '<p class="secondary small">No sign-ups yet.</p>';
  const res = page(
    "Waitlist",
    `<header class="page-head"><h1>Waitlist</h1><p class="subtitle">Sign-ups for "Bring ThePillory to your county", by county.</p></header>
<section class="card stack-sm">
  <p><strong>${total ? total.people : 0}</strong> people · <strong>${total ? total.counties : 0}</strong> counties · <strong>${total ? total.signups : 0}</strong> sign-ups</p>
  <p class="hint">Emails are used only to announce a county's launch. They aren't shown here or anywhere public.</p>
</section>
${table}`,
    { back: ["Review drafts", "/admin/review/"] }
  );
  const headers = new Headers(res.headers);
  headers.set("Cache-Control", "no-store");
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("X-Frame-Options", "DENY");
  return new Response(res.body, { status: 200, headers });
}


// ---------------------------------------------------------------------------
// Promises publish on their own once they pass the code checks ("AI-identified,
// auto-checked"). What waits here: "Broken" status suggestions, promises a
// reader flagged, random spot checks, and suggestions the checks held back.

const REJECT_REASONS = [
  ["not_commitment", "Not a specific, checkable commitment"],
  ["not_official", "Not the official's own commitment"],
  ["misquoted", "Quote doesn't match the source"],
  ["duplicate", "Duplicate of another promise"],
  ["other", "Other"],
];
const PROMISE_FLAG_LABELS = Object.fromEntries(PROMISE_FLAG_REASONS);

const count = async (db, sql) => {
  try {
    return (await db.prepare(sql).first()).n;
  } catch {
    return null;
  }
};
const PROMISE_COUNTS = {
  broken: "SELECT COUNT(*) AS n FROM promise_status_suggestions WHERE status = 'pending'",
  flagged: "SELECT COUNT(DISTINCT f.promise_id) AS n FROM promise_flags f JOIN promises p ON p.id = f.promise_id WHERE f.status = 'open' AND p.review IN ('auto', 'approved')",
  spot: "SELECT COUNT(*) AS n FROM promises WHERE review = 'auto' AND spot_check = 1",
  held: "SELECT COUNT(*) AS n FROM promises WHERE review = 'suggested'",
};

/** At the top of the review page: what about promises needs a person, and how far the Issues-page search has got. */
async function waitingSummary(db) {
  const broken = await count(db, PROMISE_COUNTS.broken);
  const held = await count(db, PROMISE_COUNTS.held);
  if (held == null) return "";
  const flagged = (await count(db, PROMISE_COUNTS.flagged)) || 0;
  const spot = (await count(db, PROMISE_COUNTS.spot)) || 0;
  const published = (await count(db, "SELECT COUNT(*) AS n FROM promises WHERE review IN ('auto', 'approved')")) || 0;
  const found = await count(db, "SELECT COUNT(*) AS n FROM issues_page_checks WHERE site_kind = 'office_site' AND result = 'found'");
  const none = await count(db, "SELECT COUNT(*) AS n FROM issues_page_checks WHERE site_kind = 'office_site' AND result IN ('none', 'no_website')");
  const officials = await count(db, "SELECT COUNT(*) AS n FROM officials WHERE active = 1");
  const searched = (found || 0) + (none || 0);
  const stat = (href, n, label) => `<a class="stat" href="${href}"><div class="stat-num">${n}</div><div class="stat-label">${label}</div></a>`;
  return `<section class="card stack-sm">
  <div class="grid-2">
    ${stat("#promise-broken", broken || 0, `"Broken" status${broken === 1 ? "" : "es"} to confirm`)}
    ${stat("#promise-flags", flagged, `promise${flagged === 1 ? "" : "s"} flagged by readers`)}
    ${stat("#promise-spot", spot, `spot check${spot === 1 ? "" : "s"}`)}
    ${stat("#promise-held", held, `suggestion${held === 1 ? "" : "s"} held back by the checks`)}
    ${stat("/admin/review/promise/pages/", found || 0, `Issues pages found${officials ? ` (${searched} of ${officials} officials' sites searched)` : ""}`)}
    ${stat("#promise-published", published, "promises published")}
  </div>
  <p class="hint">Promises that pass the code checks publish on their own, labeled "AI-identified, auto-checked", and so do "In progress" and "Kept" with their evidence. Only what's counted above waits for you.</p>
</section>`;
}

/** A promise as the queue shows it: who, the quote, the note, the source, and how it was published. */
function promiseBlock(p) {
  return `<p class="small"><strong>${esc(p.name)}</strong>, ${esc(p.office)} · ${esc(SOURCE_KIND[p.source_kind] || p.source_kind)} · ${fmtDate(p.made_on)} · ${statusChip(p.status)}</p>
  <blockquote class="promise-quote">“${esc(p.quote)}”</blockquote>
  <p class="small"><strong>What would show it done:</strong> ${esc(p.check_note)}${p.due ? ` · Deadline as stated: ${esc(p.due)}` : ""}</p>
  <p class="small"><a class="inline-link" href="${esc(sourceHref(p.source_url, p.source_time))}" target="_blank" rel="noopener">${esc(p.source_title)} ↗</a> <span class="secondary">· check the quote against the source</span></p>
  <p class="hint">${p.review === "suggested" ? `Suggested by ${esc(p.suggested_by)}, ${fmtDate(String(p.created_at).slice(0, 10))}` : checkedLine(p)}. <a class="inline-link" href="/admin/review/promise/${p.id}/">Open</a>${p.review !== "suggested" ? ` · <a class="inline-link" href="/reps/${esc(p.slug)}/#promise-${p.id}">On the page</a>` : ""}</p>`;
}

const reviewerField = (env) => `<label class="field"><span class="field-label">Your name, as shown on the page</span><input class="input" name="reviewer" required value="${esc(env.REVIEWER_NAME || "")}" autocomplete="name"></label>`;
/** Confirm (published as "Reviewed by [name]") and take down, for one promise. */
function promiseActions(env, p, { confirm = "Confirm", takeDown = "Take down" } = {}) {
  return `<div class="watch-actions">
    <form method="post" action="/admin/review/promise/${p.id}/" class="stack-sm">
      <input type="hidden" name="action" value="approve">
      ${reviewerField(env)}
      <button class="btn btn--primary" type="submit">${esc(confirm)}</button>
    </form>
    <form method="post" action="/admin/review/promise/${p.id}/" class="stack-sm">
      <input type="hidden" name="action" value="reject">
      <label class="field"><span class="field-label">Why</span><select class="input" name="reason">${REJECT_REASONS.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join("")}</select></label>
      ${reviewerField(env)}
      <button class="btn" type="submit">${esc(takeDown)}</button>
    </form>
  </div>`;
}

const PROMISE_COLS = "p.*, o.name, o.office, o.slug";
async function queryRows(db, sql, ...binds) {
  try {
    return (await db.prepare(sql).bind(...binds).all()).results;
  } catch (err) {
    if (/no such (table|column)/i.test(String(err && err.message))) return null;
    throw err;
  }
}

async function promiseQueue(db, env, url) {
  const held = await queryRows(db, `SELECT ${PROMISE_COLS} FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.review = 'suggested' ORDER BY p.created_at, p.id LIMIT 50`);
  if (held == null) return "";
  const broken = (await queryRows(
    db,
    `SELECT s.id AS sid, s.evidence, s.evidence_quote, s.evidence_on, s.source_url AS evidence_url, s.suggested_by AS s_by, s.created_at AS s_at, ${PROMISE_COLS}
     FROM promise_status_suggestions s JOIN promises p ON p.id = s.promise_id JOIN officials o ON o.id = p.official_id
     WHERE s.status = 'pending' ORDER BY s.created_at, s.id LIMIT 50`
  )) || [];
  const flagged = (await queryRows(
    db,
    `SELECT ${PROMISE_COLS} FROM promises p JOIN officials o ON o.id = p.official_id
     WHERE p.review IN ('auto', 'approved') AND EXISTS (SELECT 1 FROM promise_flags f WHERE f.promise_id = p.id AND f.status = 'open') ORDER BY p.id LIMIT 50`
  )) || [];
  const flags = flagged.length
    ? (await queryRows(db, `SELECT * FROM promise_flags WHERE status = 'open' AND promise_id IN (${flagged.map(() => "?").join(",")}) ORDER BY created_at`, ...flagged.map((p) => p.id))) || []
    : [];
  const spot = (await queryRows(db, `SELECT ${PROMISE_COLS} FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.review = 'auto' AND p.spot_check = 1 ORDER BY p.published_at, p.id LIMIT 30`)) || [];
  const published = (await queryRows(
    db,
    `SELECT p.id, p.quote, p.status, p.made_on, p.review, o.name FROM promises p JOIN officials o ON o.id = p.official_id
     WHERE p.review IN ('auto', 'approved') ORDER BY p.made_on DESC, p.id DESC LIMIT 100`
  )) || [];
  const n = {};
  for (const [k, sql] of Object.entries(PROMISE_COUNTS)) n[k] = (await count(db, sql)) || 0;

  // What the promise step last did, so an empty queue explains itself.
  const activity = (await queryRows(db, "SELECT step, status, message, finished_at FROM sync_log WHERE step IN ('promise-sources', 'promises') ORDER BY id DESC LIMIT 6")) || [];
  const activityList = activity.length
    ? `<ul class="plain-list activity-list">${activity.map((a) => `<li class="small"><span class="secondary">${esc(String(a.finished_at || "").slice(0, 16).replace("T", " "))} · ${esc(a.step === "promise-sources" ? "looking for documents" : "reading a document")} · ${esc(a.status)}</span><br>${esc(String(a.message || "").slice(0, 400))}</li>`).join("")}</ul>`
    : '<p class="secondary small">The promise step hasn\'t run yet. It runs after the bill analysis in each sync.</p>';

  const brokenRows = broken
    .map(
      (b) => `
<div class="list-row stack-sm promise-suggestion">
  ${promiseBlock(b)}
  <p class="label">Suggested: ${statusChip(b.status)} → ${statusChip("broken")}</p>
  ${b.evidence_quote ? `<blockquote class="promise-quote">“${esc(b.evidence_quote)}”</blockquote>` : ""}
  <p class="small">${esc(b.evidence)}</p>
  <p class="small">${fmtDate(b.evidence_on)} · <a class="inline-link" href="${esc(b.evidence_url)}" target="_blank" rel="noopener">Evidence source ↗</a></p>
  <p class="hint">Suggested by ${esc(b.s_by)}, ${fmtDate(String(b.s_at).slice(0, 10))}. The evidence was checked word for word against its source in code. Confirm only if it shows the promise won't be kept, was reversed, or missed a deadline the quote states.</p>
  <div class="watch-actions">
    <form method="post" action="/admin/review/promise/${b.id}/" class="stack-sm">
      <input type="hidden" name="action" value="broken_confirm"><input type="hidden" name="suggestion" value="${b.sid}">
      ${reviewerField(env)}
      <button class="btn btn--primary" type="submit">Record as Broken</button>
    </form>
    <form method="post" action="/admin/review/promise/${b.id}/" class="stack-sm">
      <input type="hidden" name="action" value="broken_reject"><input type="hidden" name="suggestion" value="${b.sid}">
      <label class="field"><span class="field-label">Why not (kept here, not shown)</span><input class="input" name="reason" maxlength="200"></label>
      ${reviewerField(env)}
      <button class="btn" type="submit">Don't record</button>
    </form>
  </div>
</div>`
    )
    .join("");
  const flagRows = flagged
    .map((p) => {
      const mine = flags.filter((f) => f.promise_id === p.id);
      return `
<div class="list-row stack-sm promise-suggestion">
  ${promiseBlock(p)}
  <ul class="plain-list">${mine.map((f) => `<li class="small"><strong>${esc(PROMISE_FLAG_LABELS[f.reason] || f.reason)}</strong>${f.note ? `: ${esc(f.note)}` : ""} <span class="secondary">· ${fmtDate(String(f.created_at).slice(0, 10))}</span></li>`).join("")}</ul>
  <p class="hint">Shown as "Under review" until you decide. Confirm keeps it up as "Reviewed by" you and closes the reports; to change its status or note, open it first.</p>
  ${promiseActions(env, p, { confirm: "Keep it up", takeDown: "Take it down" })}
</div>`;
    })
    .join("");
  const spotRows = spot.map((p) => `<div class="list-row stack-sm promise-suggestion">${promiseBlock(p)}${promiseActions(env, p, { confirm: "Looks right", takeDown: "Take it down" })}</div>`).join("");
  const heldRows = held
    .map(
      (p) => `
<div class="list-row stack-sm promise-suggestion">
  <label class="check-row"><input type="checkbox" name="ids" value="${p.id}" form="promise-batch"> <span class="small">Select</span></label>
  ${promiseBlock(p)}
  ${p.check_reason ? `<p class="small"><strong>Held back:</strong> ${esc(p.check_reason)}</p>` : ""}
  ${promiseActions(env, p, { confirm: "Publish", takeDown: "Reject" })}
</div>`
    )
    .join("");
  const list = published
    .map((p) => `<a class="list-row link-row" href="/admin/review/promise/${p.id}/"><div><div class="list-title">${esc(p.name)}: “${esc(p.quote.length > 110 ? `${p.quote.slice(0, 110)}…` : p.quote)}”</div><div class="list-meta">${fmtDate(p.made_on)} · ${STATUS[p.status] ? STATUS[p.status][0] : p.status} · ${p.review === "auto" ? "auto-checked" : "reviewed"}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`)
    .join("");
  const pages = (await count(db, "SELECT COUNT(*) AS n FROM promise_pages")) || 0;
  const done = url && url.searchParams.get("promises");
  const batch = held.length
    ? `<form id="promise-batch" method="post" action="/admin/review/promise/batch/" class="card stack-sm">
  <label class="check-row"><input type="checkbox" data-select-all="ids" data-form="promise-batch"> <span class="small">Select all ${held.length}</span></label>
  ${reviewerField(env)}
  <button class="btn btn--primary" type="submit">Publish selected</button>
  <p class="hint">Publish only the ones you've checked against their source: they show "Reviewed by" you.</p>
</form>`
    : "";
  const head = (id, title, k, shown) => `<h2 class="label queue-head" id="${id}">${title} <span class="queue-count">${n[k]}</span></h2>${n[k] > shown ? `<p class="hint">Showing the oldest ${shown} of ${n[k]}.</p>` : ""}`;
  return `<h2 class="label queue-head" id="promises">Promises</h2>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<p class="hint">Found by AI in official press releases, addresses, county agendas and officials' Issues pages, up to 10 a day. Each one is checked in code (the quote word for word in its source, a specific action, vote or deadline, a neutral note) and published at once, labeled "AI-identified, auto-checked". "In progress" and "Kept" publish with their evidence the same way; "Broken" waits for you.</p>
<p class="small"><a class="inline-link" href="/admin/review/promise/new/">Add a promise by hand</a> · <a class="inline-link" href="/admin/review/promise/pages/">Issues and priorities pages (${pages})</a> · <a class="inline-link" href="/admin/review/promise/statements/">Statements from officials</a> · <a class="inline-link" href="/admin/review/promise/candidates/">Candidates' issues pages</a></p>
${head("promise-broken", '"Broken": waiting for you', "broken", broken.length)}
<section class="card">${brokenRows || '<p class="secondary small">None waiting.</p>'}</section>
${head("promise-flags", "Flagged by readers", "flagged", flagged.length)}
<section class="card">${flagRows || '<p class="secondary small">No open reports.</p>'}</section>
${head("promise-spot", "Spot checks", "spot", spot.length)}
<p class="hint">About 1 in 10 auto-published promises, picked at random. Check the quote against the source and that it's a specific commitment by this official.</p>
<section class="card">${spotRows || '<p class="secondary small">None waiting.</p>'}</section>
${head("promise-held", "Held back by the checks", "held", held.length)}
<p class="hint">Suggestions saved before promises published on their own that don't pass today's checks (usually not specific enough). Nothing here is public.</p>
${batch}
<section class="card">${heldRows || '<p class="secondary small">None.</p>'}</section>
<details class="weigh-details"><summary>Recent activity</summary><section class="card stack-sm">${activityList}</section></details>
<details class="weigh-details" id="promise-published"><summary>Published promises (${published.length}): record a status change</summary><section class="card">${list || '<p class="secondary small">None yet.</p>'}</section></details>
<h2 class="label queue-head" id="topics">Topic tags</h2>
<p class="small"><a class="inline-link" href="/admin/review/topics/">Check and correct topic tags</a> on bills, county agenda items, executive actions and Platform excerpts.</p>`;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Officials to pick from: the executive branch and the county first, then everyone else.
async function officialChoices(db) {
  return (
    await db
      .prepare(
        `SELECT id, name, office FROM officials WHERE active = 1
         ORDER BY CASE chamber WHEN 'us-executive' THEN 0 WHEN 'ca-executive' THEN 1 WHEN 'county-board' THEN 2 ELSE 3 END, rank, name`
      )
      .all()
  ).results;
}
const officialPicker = (officials, value) => `<label class="field"><span class="field-label">Official (start typing a name)</span><input class="input" name="official" list="official-list" required autocomplete="off" value="${esc(value || "")}"></label>
<datalist id="official-list">${officials.map((o) => `<option value="${esc(officialLabel(o))}"></option>`).join("")}</datalist>`;

async function promiseNew(db, env, { error = "", form = null } = {}) {
  const officials = await officialChoices(db);
  const f = form || {};
  return adminPage(
    "Add a promise",
    `<header class="page-head">
  <h1>Add a promise</h1>
  <p class="subtitle">A specific, checkable commitment, quoted word for word, with the date and a link to where it was said: a meeting video (with the time), an interview, an address, a page. It's approved as you save it, with your name.</p>
</header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<form method="post" action="/admin/review/promise/new/" class="card stack-sm">
  ${officialPicker(officials, f.official)}
  <label class="field"><span class="field-label">Quote, word for word</span><textarea class="textarea" name="quote" rows="4" required maxlength="1000">${esc(f.quote || "")}</textarea></label>
  <p class="hint">Only the sentence or clause that states the commitment. No changes, ellipses or brackets; from a video, write down exactly what was said.</p>
  <label class="field"><span class="field-label">Date it was said or published</span><input class="input" type="date" name="made_on" required value="${esc(f.made_on || "")}"></label>
  <label class="field"><span class="field-label">Kind of source</span><select class="input" name="source_kind" required>${Object.entries(SOURCE_KIND).map(([k, v]) => `<option value="${k}"${f.source_kind === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
  <label class="field"><span class="field-label">Source link</span><input class="input" type="url" name="source_url" required placeholder="https://" value="${esc(f.source_url || "")}"></label>
  <label class="field"><span class="field-label">Time in the video (optional)</span><input class="input" name="source_time" placeholder="1:02:03" inputmode="numeric" value="${esc(f.source_time || "")}"></label>
  <p class="hint">For a meeting video or recording: where it's said, as h:mm:ss. A YouTube link opens at that time; other players show the time beside the link.</p>
  <label class="field"><span class="field-label">Source title</span><input class="input" name="source_title" required maxlength="300" placeholder="Board of Supervisors meeting, March 12, 2026" value="${esc(f.source_title || "")}"></label>
  <label class="field"><span class="field-label">What would show it done</span><textarea class="textarea" name="check_note" rows="2" required maxlength="300">${esc(f.check_note || "")}</textarea></label>
  <p class="hint">One plain sentence a reader could check, for example "A signed contract for the Main Street repaving." No judgment of the official.</p>
  <label class="field"><span class="field-label">Deadline as the quote states it (optional)</span><input class="input" name="due" maxlength="100" placeholder="by June 30, 2027" value="${esc(f.due || "")}"></label>
  <label class="field"><span class="field-label">Your name, as shown on the page</span><input class="input" name="reviewer" required autocomplete="name" value="${esc(f.reviewer || env.REVIEWER_NAME || "")}"></label>
  <label class="check-row"><input type="checkbox" name="confirm" value="yes"${f.confirm ? " checked" : ""}> <span class="small">This is a specific commitment (only if the check above says it may not be)</span></label>
  <button class="btn btn--primary" type="submit">Save the promise</button>
</form>`
  );
}

async function promiseCreate(db, env, request) {
  const form = Object.fromEntries((await request.formData()).entries());
  const officials = await officialChoices(db);
  const r = checkEntry(form, officials, new Date().toISOString().slice(0, 10));
  if (r.error) return promiseNew(db, env, { error: r.error, form: r.form });
  const x = r.row;
  const res = await db
    .prepare(
      `INSERT OR IGNORE INTO promises (official_id, quote, quote_key, made_on, source_url, source_title, source_kind, source_time, check_note, due, review, reviewed_by, reviewed_at, published_at, suggested_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'approved', ?, datetime('now'), datetime('now'), ?)`
    )
    .bind(x.official_id, x.quote, quoteKey(x.quote), x.made_on, x.source_url, x.source_title, x.source_kind, x.source_time, x.check_note, x.due, x.reviewed_by, x.suggested_by)
    .run();
  if (!(res.meta && res.meta.changes)) return promiseNew(db, env, { error: "This quote is already recorded for this official (as a suggestion, a promise, or a rejected suggestion).", form: r.form });
  const row = await db.prepare("SELECT id FROM promises WHERE official_id = ? AND quote_key = ?").bind(x.official_id, quoteKey(x.quote)).first();
  return Response.redirect(`${new URL(request.url).origin}/admin/review/promise/${row.id}/?done=${encodeURIComponent("Saved and approved. It shows on the official's Platform tab, under Commitments tracked.")}`, 303);
}

async function promiseBatch(db, request) {
  const form = await request.formData();
  const ids = selectedIds(form.getAll("ids"));
  const reviewer = String(form.get("reviewer") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const origin = new URL(request.url).origin;
  const msg = (t) => Response.redirect(`${origin}/admin/review/?promises=${encodeURIComponent(t)}#promises`, 303);
  if (!ids.length) return msg("Nothing published: tick the suggestions to publish.");
  if (!reviewer) return msg("Nothing published: enter your name, as shown with each promise.");
  const res = await db
    .prepare(`UPDATE promises SET review = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), published_at = COALESCE(published_at, datetime('now')), reject_reason = NULL WHERE review = 'suggested' AND id IN (${ids.map(() => "?").join(",")})`)
    .bind(reviewer, ...ids)
    .run();
  const n = (res.meta && res.meta.changes) || 0;
  return msg(`Published ${n} promise${n === 1 ? "" : "s"}, reviewed by ${reviewer}.`);
}

async function promisePages(db, env, { error = "", done = "", form = null } = {}) {
  const officials = await officialChoices(db);
  const { results: pages } = await db
    .prepare("SELECT p.*, o.name, o.office FROM promise_pages p JOIN officials o ON o.id = p.official_id ORDER BY o.name, p.kind")
    .all();
  const f = form || {};
  const rows = pages
    .map(
      (p) => `<div class="list-row stack-xs">
  <p class="small"><strong>${esc(p.name)}</strong>, ${esc(p.office)} · ${esc(PAGE_KINDS[p.kind] || p.kind)}</p>
  <p class="small"><a class="inline-link" href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)} ↗</a></p>
  <p class="hint">${p.found_by === "auto" ? "Found automatically on the official's website" : `Added by ${esc(p.added_by)}`}, ${fmtDate(String(p.added_at).slice(0, 10))} · ${p.fetched_at ? `last read ${fmtDate(String(p.fetched_at).slice(0, 10))}${p.note ? `: ${esc(p.note)}` : ""}` : "not read yet; it's read in the next sync"}</p>
  <details class="weigh-details"><summary>In their own words: ${p.excerpt_by === "hidden" ? "hidden" : p.excerpt ? "excerpt shown" : "no excerpt yet"}</summary>
    <div class="stack-sm">
      ${p.excerpt && p.excerpt_by !== "hidden" ? `<blockquote class="promise-quote">“${esc(p.excerpt)}”</blockquote><p class="hint">${String(p.excerpt_by || "").startsWith("person:") ? `Chosen by ${esc(String(p.excerpt_by).slice(7))}` : `Picked by ${esc(p.excerpt_by || "the AI")}`}, ${fmtDate(String(p.excerpt_at || "").slice(0, 10))}.</p>` : `<p class="hint">${p.excerpt_by === "hidden" ? "Hidden from the official's page." : p.excerpt_by === "none" ? "The AI found no passage summing up the page; it looks again monthly." : "Picked when the page is next read."}</p>`}
      <form method="post" action="/admin/review/promise/pages/" class="stack-sm">
        <input type="hidden" name="action" value="excerpt"><input type="hidden" name="url" value="${esc(p.url)}">
        <label class="field"><span class="field-label">Use this excerpt instead (word for word from the page)</span><textarea class="textarea" name="excerpt" rows="3" maxlength="600" required></textarea></label>
        <label class="field"><span class="field-label">Your name, as shown with it</span><input class="input" name="reviewer" required autocomplete="name" value="${esc(env.REVIEWER_NAME || "")}"></label>
        <button class="btn" type="submit">Use this excerpt</button>
      </form>
      <form method="post" action="/admin/review/promise/pages/"><input type="hidden" name="action" value="${p.excerpt_by === "hidden" ? "excerpt_auto" : "excerpt_hide"}"><input type="hidden" name="url" value="${esc(p.url)}"><button class="btn" type="submit">${p.excerpt_by === "hidden" ? "Show an excerpt again" : "Hide the excerpt"}</button></form>
      ${String(p.excerpt_by || "").startsWith("person:") ? `<form method="post" action="/admin/review/promise/pages/"><input type="hidden" name="action" value="excerpt_auto"><input type="hidden" name="url" value="${esc(p.url)}"><button class="btn" type="submit">Let the AI pick again</button></form>` : ""}
    </div>
  </details>
  <form method="post" action="/admin/review/promise/pages/"><input type="hidden" name="action" value="remove"><input type="hidden" name="url" value="${esc(p.url)}"><button class="btn" type="submit">${p.found_by === "auto" ? "Remove: wrong page" : "Stop reading this page"}</button></form>
</div>`
    )
    .join("");
  return adminPage(
    "Issues pages",
    `<header class="page-head">
  <h1>Issues and priorities pages</h1>
  <p class="subtitle">An official's campaign or office website's "Issues" or "Priorities" page. The sync reads each one weekly. A short excerpt, word for word, shows on the official's Platform tab under "In their own words" (refreshed monthly; you can choose another or hide it), and the AI finds specific, checkable commitments in it, published once they pass the code checks like any other.</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<section class="card">${rows || '<p class="secondary small">No pages yet.</p>'}</section>
<form method="post" action="/admin/review/promise/pages/" class="card stack-sm">
  <h2 class="label">Add a page</h2>
  <input type="hidden" name="action" value="add">
  ${officialPicker(officials, f.official)}
  <label class="field"><span class="field-label">Whose website</span><select class="input" name="kind" required>${Object.entries(PAGE_KINDS).map(([k, v]) => `<option value="${k}"${f.kind === k ? " selected" : ""}>${esc(v)}</option>`).join("")}</select></label>
  <label class="field"><span class="field-label">Page link</span><input class="input" type="url" name="url" required placeholder="https://" value="${esc(f.url || "")}"></label>
  <label class="field"><span class="field-label">Page title, as the site shows it</span><input class="input" name="title" required maxlength="200" placeholder="Issues" value="${esc(f.title || "")}"></label>
  <p class="hint">Treat every official in the same office alike: when you add a page for one, add the same kind of page for the others who have one.</p>
  <button class="btn btn--primary" type="submit">Add the page</button>
</form>`
  );
}

// Candidates' issues pages (src/promises/candidates-sync.js): found automatically on the
// campaign website in each candidate's FEC filing. The same choices as officials' pages.
const CANDIDATE_PAGE_SIZE = 50;
async function candidatePages(db, { done = "", offset = 0 } = {}) {
  const [{ results: rows }, counts] = await Promise.all([
    db
      .prepare("SELECT candidate_id, name, state, site_url, result, page_url, title, excerpt, excerpt_at, excerpt_by, checked_at FROM candidate_platforms WHERE result = 'found' ORDER BY state, name LIMIT ? OFFSET ?")
      .bind(CANDIDATE_PAGE_SIZE + 1, offset)
      .all(),
    db.prepare("SELECT result, COUNT(*) AS n FROM candidate_platforms GROUP BY result").all(),
  ]);
  const n = Object.fromEntries(counts.results.map((r) => [r.result || "not searched", r.n]));
  const form = (action, id, label) =>
    `<form method="post" action="/admin/review/promise/candidates/"><input type="hidden" name="action" value="${action}"><input type="hidden" name="id" value="${esc(id)}"><button class="btn" type="submit">${label}</button></form>`;
  const list = rows.slice(0, CANDIDATE_PAGE_SIZE).map((r) => `
  <article class="list-row stack-sm">
    <div>
      <p class="list-title"><a class="inline-link" href="/candidates/${esc(r.candidate_id)}/#platform">${esc(r.name)}</a> · ${esc(r.state)}</p>
      <p class="list-meta">${safeUrl(r.page_url) ? `<a class="inline-link" href="${esc(r.page_url)}" target="_blank" rel="noopener">${esc(r.title || r.page_url)} ↗</a>` : ""} · site ${esc(r.site_url || "")} · searched ${fmtDate(String(r.checked_at || "").slice(0, 10))}</p>
      ${r.excerpt ? `<blockquote class="promise-quote small">“${esc(r.excerpt)}”</blockquote><p class="hint">${r.excerpt_by === "hidden" ? "Hidden" : "Shown"} · ${esc(String(r.excerpt_by || ""))}</p>` : `<p class="hint">No excerpt (${esc(String(r.excerpt_by || "not picked yet"))})</p>`}
    </div>
    <div class="chips">
      ${r.excerpt ? form(r.excerpt_by === "hidden" ? "show" : "hide", r.candidate_id, r.excerpt_by === "hidden" ? "Show the excerpt" : "Hide the excerpt") : ""}
      ${form("repick", r.candidate_id, "Search and pick again")}
      ${form("remove", r.candidate_id, "Remove: wrong page")}
    </div>
  </article>`).join("");
  const more = rows.length > CANDIDATE_PAGE_SIZE ? `<a class="btn" href="/admin/review/promise/candidates/?offset=${offset + CANDIDATE_PAGE_SIZE}">Next ${CANDIDATE_PAGE_SIZE}</a>` : "";
  return adminPage(
    "Candidates' issues pages",
    `<header class="page-head">
  <h1>Candidates' issues pages</h1>
  <p class="subtitle">Found automatically on the campaign website listed in each candidate's FEC filing, by the same finder as officials' pages. A short excerpt, word for word, shows on the candidate's Platform tab under "In their own words". A page you remove is never found again.</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<p class="small">${Object.entries(n).map(([k, v]) => `${esc(k)}: ${v}`).join(" · ") || "No candidates searched yet."}</p>
<section class="card">${list || '<p class="secondary small">No issues pages found yet.</p>'}</section>
${more}`
  );
}

async function candidatePagesChange(db, request, email) {
  const form = Object.fromEntries((await request.formData()).entries());
  const back = (t) => Response.redirect(`${new URL(request.url).origin}/admin/review/promise/candidates/?done=${encodeURIComponent(t)}`, 303);
  const row = await db.prepare("SELECT candidate_id, page_url FROM candidate_platforms WHERE candidate_id = ?").bind(String(form.id || "")).first();
  if (!row) return back("That candidate isn't listed.");
  if (form.action === "hide") {
    await db.prepare("UPDATE candidate_platforms SET excerpt_by = 'hidden' WHERE candidate_id = ?").bind(row.candidate_id).run();
    return back("Hidden. The candidate's Platform tab no longer shows an excerpt from this page.");
  }
  if (form.action === "show" || form.action === "repick") {
    // Searched again in the next sync, which picks a new excerpt.
    await db.prepare("UPDATE candidate_platforms SET excerpt = NULL, excerpt_by = NULL, checked_at = NULL WHERE candidate_id = ?").bind(row.candidate_id).run();
    return back("The site will be searched again, and an excerpt picked, in the next sync.");
  }
  if (form.action === "remove" && row.page_url) {
    await db.batch([
      db.prepare("INSERT OR REPLACE INTO promise_pages_removed (url, official_id, removed_by) VALUES (?, ?, ?)").bind(row.page_url, row.candidate_id, email || null),
      db.prepare("UPDATE candidate_platforms SET result = 'none', page_url = NULL, title = NULL, excerpt = NULL, excerpt_by = NULL, page_text = NULL, note = 'the page found was removed on the review page' WHERE candidate_id = ?").bind(row.candidate_id),
    ]);
    return back("Removed, and it won't be found again automatically.");
  }
  return back("Nothing changed.");
}

async function promisePagesChange(db, env, request, email) {
  const form = Object.fromEntries((await request.formData()).entries());
  const back = (t) => Response.redirect(`${new URL(request.url).origin}/admin/review/promise/pages/?done=${encodeURIComponent(t)}`, 303);
  if (form.action === "remove") {
    const pg = await db.prepare("SELECT url, official_id FROM promise_pages WHERE url = ?").bind(String(form.url || "")).first();
    if (!pg) return back("That page isn't listed.");
    // Remembered, so the automatic search never adds it again.
    try {
      await db.batch([
        db.prepare("INSERT OR REPLACE INTO promise_pages_removed (url, official_id, removed_by) VALUES (?, ?, ?)").bind(pg.url, pg.official_id, email || null),
        db.prepare("DELETE FROM promise_pages WHERE url = ?").bind(pg.url),
        db.prepare("DELETE FROM promise_sources WHERE url = ? AND status = 'pending'").bind(pg.url),
        db.prepare("UPDATE issues_page_checks SET result = 'none', page_url = NULL, note = 'the page found was removed on the review page' WHERE official_id = ? AND page_url = ?").bind(pg.official_id, pg.url),
      ]);
    } catch (err) {
      // Before the sync has added the tables for found pages (migration 0017).
      if (!/no such (table|column)/i.test(String(err && err.message))) throw err;
      await db.prepare("DELETE FROM promise_pages WHERE url = ?").bind(pg.url).run();
    }
    return back("Removed, and it won't be added again automatically. Promises already approved from it stay, with their source.");
  }
  if (form.action === "excerpt" || form.action === "excerpt_hide" || form.action === "excerpt_auto") {
    const pg = await db.prepare("SELECT url, page_text FROM promise_pages WHERE url = ?").bind(String(form.url || "")).first();
    if (!pg) return back("That page isn't listed.");
    if (form.action === "excerpt_hide") {
      await db.prepare("UPDATE promise_pages SET excerpt_by = 'hidden' WHERE url = ?").bind(pg.url).run();
      return back("Hidden. The official's Platform tab no longer shows an excerpt from this page.");
    }
    if (form.action === "excerpt_auto") {
      // Read again in the next sync, which picks a new excerpt.
      await db.prepare("UPDATE promise_pages SET excerpt = NULL, excerpt_by = NULL, excerpt_at = NULL, fetched_at = NULL WHERE url = ?").bind(pg.url).run();
      return back("A new excerpt is picked when the page is read in the next sync.");
    }
    const reviewer = String(form.reviewer || "").replace(/\s+/g, " ").trim().slice(0, 80);
    if (!reviewer) return promisePages(db, env, { error: "Enter your name: it's shown with the excerpt." });
    if (!pg.page_text) return promisePages(db, env, { error: "The page hasn't been read yet, so the excerpt can't be checked. Try again after the next sync." });
    const r = checkExcerpt(pg.page_text, form.excerpt);
    if (!r.excerpt) return promisePages(db, env, { error: `Not used: ${r.reason}. Copy one to three sentences exactly as the page has them.` });
    await db.prepare("UPDATE promise_pages SET excerpt = ?, excerpt_at = datetime('now'), excerpt_by = ? WHERE url = ?").bind(r.excerpt, `person:${reviewer}`, pg.url).run();
    return back("Excerpt saved. It stays while it's still on the page.");
  }
  const r = checkPage(form, await officialChoices(db), email);
  if (r.error) return promisePages(db, env, { error: r.error, form: r.form });
  const res = await db
    .prepare("INSERT OR IGNORE INTO promise_pages (url, official_id, kind, title, added_by) VALUES (?, ?, ?, ?, ?)")
    .bind(r.row.url, r.row.official_id, r.row.kind, r.row.title, r.row.added_by)
    .run();
  return back(res.meta && res.meta.changes ? "Added. It's read in the next sync." : "That page is already listed.");
}

async function officialStatements(db, env, { error = "", done = "", form = null } = {}) {
  const officials = await officialChoices(db);
  const { results: rows } = await db
    .prepare("SELECT s.*, o.name, o.office, o.slug FROM official_statements s JOIN officials o ON o.id = s.official_id ORDER BY s.removed_at IS NOT NULL, s.submitted_on DESC, s.id DESC LIMIT 100")
    .all();
  const f = form || {};
  const list = rows
    .map(
      (st) => `<div class="list-row stack-xs">
  <p class="small"><strong>${esc(st.name)}</strong>, ${esc(st.office)} · sent ${fmtDate(st.submitted_on)}${st.removed_at ? ` · <span class="secondary">removed ${fmtDate(String(st.removed_at).slice(0, 10))}${st.removed_note ? `: ${esc(st.removed_note)}` : ""}</span>` : ""}</p>
  ${st.title ? `<p class="small"><strong>${esc(st.title)}</strong></p>` : ""}
  <p class="small">${esc(st.body.length > 280 ? `${st.body.slice(0, 280)}…` : st.body)}</p>
  <p class="hint">Received: ${esc(st.received_via)} · recorded by ${esc(st.recorded_by)}${st.removed_at ? "" : ` · <a class="inline-link" href="/reps/${esc(st.slug)}/#platform">On the official's page</a>`}</p>
  ${st.removed_at ? "" : `<form method="post" action="/admin/review/promise/statements/" class="stack-xs"><input type="hidden" name="action" value="remove"><input type="hidden" name="id" value="${st.id}"><label class="field"><span class="field-label">Why remove it (kept here, not shown)</span><input class="input" name="note" required maxlength="200" placeholder="Withdrawn by the office"></label><button class="btn" type="submit">Remove from the page</button></form>`}
</div>`
    )
    .join("");
  return adminPage(
    "Official statements",
    `<header class="page-head">
  <h1>Statements from officials</h1>
  <p class="subtitle">A statement an official or their office sends in, shown in full on their Platform tab under "In their own words", labeled "Submitted by the official". It's shown exactly as sent: no edits, no summary. Record only what came from the office itself, and how it arrived.</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<section class="card">${list || '<p class="secondary small">No statements yet.</p>'}</section>
<form method="post" action="/admin/review/promise/statements/" class="card stack-sm">
  <h2 class="label">Record a statement</h2>
  <input type="hidden" name="action" value="add">
  ${officialPicker(officials, f.official)}
  <label class="field"><span class="field-label">Title (optional, as the office gave it)</span><input class="input" name="title" maxlength="200" value="${esc(f.title || "")}"></label>
  <label class="field"><span class="field-label">Statement, exactly as sent</span><textarea class="textarea" name="body" rows="8" required maxlength="4000">${esc(f.body || "")}</textarea></label>
  <p class="hint">Up to 3,000 characters, shown in full with its paragraphs. If it's longer, ask the office for a shorter version rather than cutting it.</p>
  <label class="field"><span class="field-label">Date the office sent it</span><input class="input" type="date" name="submitted_on" required value="${esc(f.submitted_on || "")}"></label>
  <label class="field"><span class="field-label">How it reached ThePillory (not shown)</span><input class="input" name="received_via" required maxlength="300" placeholder="Email from the office's official address" value="${esc(f.received_via || "")}"></label>
  <label class="field"><span class="field-label">Where the office also published it (optional)</span><input class="input" type="url" name="source_url" placeholder="https://" value="${esc(f.source_url || "")}"></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="recorded_by" required autocomplete="name" value="${esc(f.recorded_by || env.REVIEWER_NAME || "")}"></label>
  <p class="hint">Treat every official alike: any official's office can send a statement the same way.</p>
  <button class="btn btn--primary" type="submit">Publish the statement</button>
</form>`
  );
}

async function officialStatementsChange(db, env, request) {
  const form = Object.fromEntries((await request.formData()).entries());
  const back = (t) => Response.redirect(`${new URL(request.url).origin}/admin/review/promise/statements/?done=${encodeURIComponent(t)}`, 303);
  if (form.action === "remove") {
    const note = String(form.note || "").replace(/\s+/g, " ").trim().slice(0, 200);
    if (!note) return officialStatements(db, env, { error: "Say why it's removed (kept here, not shown)." });
    await db.prepare("UPDATE official_statements SET removed_at = datetime('now'), removed_note = ? WHERE id = ? AND removed_at IS NULL").bind(note, parseInt(form.id, 10) || 0).run();
    return back("Removed from the official's page; kept here.");
  }
  const r = checkStatement(form, await officialChoices(db), new Date().toISOString().slice(0, 10));
  if (r.error) return officialStatements(db, env, { error: r.error, form: r.form });
  const x = r.row;
  await db
    .prepare("INSERT INTO official_statements (official_id, title, body, submitted_on, received_via, source_url, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(x.official_id, x.title, x.body, x.submitted_on, x.received_via, x.source_url, x.recorded_by)
    .run();
  return back("Published on the official's Platform tab, labeled \"Submitted by the official\".");
}

async function promiseDetail(db, env, id, { error = "", done = "", form = null } = {}) {
  const p = await db.prepare("SELECT p.*, o.name, o.office, o.slug FROM promises p JOIN officials o ON o.id = p.official_id WHERE p.id = ?").bind(id).first();
  if (!p) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  p.changes = (await db.prepare("SELECT * FROM promise_status_changes WHERE promise_id = ? ORDER BY evidence_on DESC, recorded_at DESC, id DESC").bind(id).all()).results;
  const flags = (await queryRows(db, "SELECT * FROM promise_flags WHERE promise_id = ? ORDER BY created_at DESC", id)) || [];
  const live = p.review === "approved" || p.review === "auto";
  const f = form || {};
  const statusForm = live
    ? `<section class="card stack-sm" id="status">
  <h2 class="label">Record a status change</h2>
  <p class="hint">Every change needs evidence and a source. Describe the evidence plainly: what happened, when, and where it's recorded. No judgment of the official.</p>
  <form method="post" action="/admin/review/promise/${p.id}/" class="stack-sm">
    <input type="hidden" name="action" value="status">
    <label class="field"><span class="field-label">New status</span><select class="input" name="to_status" required>${STATUSES.filter((s) => s !== p.status).map((s) => `<option value="${s}"${f.to_status === s ? " selected" : ""}>${esc(STATUS[s][0])}</option>`).join("")}</select></label>
    <label class="field"><span class="field-label">Evidence</span><textarea class="textarea" name="evidence" rows="3" required maxlength="1000">${esc(f.evidence || "")}</textarea></label>
    <label class="field"><span class="field-label">Date of the evidence</span><input class="input" type="date" name="evidence_on" required value="${esc(f.evidence_on || "")}"></label>
    <label class="field"><span class="field-label">Source (link)</span><input class="input" type="url" name="source_url" required placeholder="https://" value="${esc(f.source_url || "")}"></label>
    <label class="field"><span class="field-label">Your name, as shown on the page</span><input class="input" name="reviewer" required value="${esc(f.reviewer || env.REVIEWER_NAME || "")}" autocomplete="name"></label>
    <button class="btn btn--primary" type="submit">Record the change</button>
  </form>
</section>`
    : "";
  const noteForm = p.review !== "rejected"
    ? `<section class="card stack-sm">
  <h2 class="label">What would show it done</h2>
  <p class="hint">The quote can't be edited; it stays word for word as the source has it. This note can: plain, neutral words.</p>
  <form method="post" action="/admin/review/promise/${p.id}/" class="stack-sm">
    <input type="hidden" name="action" value="note">
    <label class="field"><span class="field-label">Note</span><textarea class="textarea" name="check_note" rows="2" required maxlength="300">${esc(f.check_note != null ? f.check_note : p.check_note)}</textarea></label>
    <button class="btn" type="submit">Save the note</button>
  </form>
</section>`
    : "";
  return adminPage(
    "Promise",
    `<header class="page-head">
  <p class="label">${esc(p.name)} · ${esc(p.office)}</p>
  <h1>Promise</h1>
  <p class="subtitle">${p.review === "suggested" ? `Held back by the checks${p.check_reason ? ` (${esc(p.check_reason)})` : ""}; not public` : p.review === "approved" ? `Published, reviewed by ${esc(p.reviewed_by)}, ${fmtDate(String(p.reviewed_at).slice(0, 10))}` : p.review === "auto" ? `Published, ${checkedLine(p)}` : `Taken down (${esc(p.reject_reason || "")})`} · ${statusChip(p.status)}</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<section class="card stack-sm">
  <blockquote class="promise-quote">“${esc(p.quote)}”</blockquote>
  <p class="small">${esc(SOURCE_KIND[p.source_kind] || p.source_kind)}, ${fmtDate(p.made_on)}: <a class="inline-link" href="${esc(sourceHref(p.source_url, p.source_time))}" target="_blank" rel="noopener">${esc(p.source_title)} ↗</a>${p.source_time ? ` at ${esc(p.source_time)}` : ""}</p>
  <p class="small"><strong>What would show it done:</strong> ${esc(p.check_note)}</p>
  ${live ? `<p class="small"><a class="inline-link" href="/reps/${esc(p.slug)}/#promise-${p.id}">On the official's page</a></p>` : ""}
</section>
${flags.length ? `<section class="card stack-sm"><h2 class="label">Reader reports (${flags.length})</h2><ul class="plain-list">${flags.map((x) => `<li class="small"><strong>${esc(PROMISE_FLAG_LABELS[x.reason] || x.reason)}</strong>${x.note ? `: ${esc(x.note)}` : ""} <span class="secondary">· ${fmtDate(String(x.created_at).slice(0, 10))} · ${x.status === "open" ? "open" : `${esc(x.resolution || "resolved")} by ${esc(x.resolved_by || "")}`}</span></li>`).join("")}</ul></section>` : ""}
${p.review !== "rejected" ? `<section class="card stack-sm"><h2 class="label">${p.review === "approved" ? "Take down" : "Confirm or take down"}</h2>${promiseActions(env, p, { confirm: p.review === "suggested" ? "Publish" : "Confirm", takeDown: p.review === "suggested" ? "Reject" : "Take down" })}</section>` : ""}
${statusForm}
${noteForm}
<section class="card stack-sm"><h2 class="label">History</h2>${historyList(p)}</section>`
  );
}

async function promiseChange(db, env, id, request) {
  const form = await request.formData();
  const action = form.get("action");
  const back = (q) => Response.redirect(`${new URL(request.url).origin}/admin/review/promise/${id}/?${q}`, 303);
  const p = await db.prepare("SELECT * FROM promises WHERE id = ?").bind(id).first();
  if (!p) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  const reviewer = String(form.get("reviewer") || "").replace(/\s+/g, " ").trim().slice(0, 80);
  const queue = (t) => Response.redirect(`${new URL(request.url).origin}/admin/review/?promises=${encodeURIComponent(t)}#promises`, 303);
  // Open reader reports close when a person decides; tolerant before migration 0019.
  const closeFlags = (resolution) =>
    db.prepare("UPDATE promise_flags SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = datetime('now') WHERE promise_id = ? AND status = 'open'").bind(resolution, reviewer, id);
  const withFlags = async (stmt, resolution) => {
    try {
      await db.batch([stmt, closeFlags(resolution)]);
    } catch (err) {
      if (!/no such (table|column)/i.test(String(err && err.message))) throw err;
      await stmt.run();
    }
  };
  if (action === "approve") {
    if (!reviewer) return promiseDetail(db, env, id, { error: "Enter your name: it's shown with the promise." });
    if (!["suggested", "auto", "approved"].includes(p.review)) return back("done=Nothing changed: it was taken down.");
    let stmt;
    try {
      await db.prepare("SELECT spot_check FROM promises LIMIT 0").all();
      stmt = db.prepare("UPDATE promises SET review = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), published_at = COALESCE(published_at, datetime('now')), spot_check = 0, reject_reason = NULL WHERE id = ?").bind(reviewer, id);
    } catch {
      stmt = db.prepare("UPDATE promises SET review = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), reject_reason = NULL WHERE id = ?").bind(reviewer, id);
    }
    await withFlags(stmt, "kept");
    return queue(`${p.review === "suggested" ? "Published" : "Confirmed"}: it shows "Reviewed by ${reviewer}".`);
  }
  if (action === "reject") {
    if (!reviewer) return promiseDetail(db, env, id, { error: "Enter your name: it's kept with the decision." });
    const reason = REJECT_REASONS.find(([v]) => v === form.get("reason"));
    await withFlags(
      db.prepare("UPDATE promises SET review = 'rejected', reviewed_by = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE id = ?").bind(reviewer, reason ? reason[1] : "Other", id),
      "taken down"
    );
    return queue(p.review === "suggested" ? "Rejected." : "Taken down from the official's page; kept here with its history.");
  }
  if (action === "broken_confirm" || action === "broken_reject") {
    const sid = parseInt(form.get("suggestion"), 10) || 0;
    const sug = await db.prepare("SELECT * FROM promise_status_suggestions WHERE id = ? AND promise_id = ? AND status = 'pending'").bind(sid, id).first();
    if (!sug) return queue("Nothing changed: that suggestion was already decided.");
    if (!reviewer) return queue("Nothing changed: enter your name, as shown with the change.");
    if (action === "broken_reject") {
      const why = String(form.get("reason") || "").replace(/\s+/g, " ").trim().slice(0, 200);
      await db.prepare("UPDATE promise_status_suggestions SET status = 'rejected', decided_by = ?, decided_at = datetime('now'), reason = ? WHERE id = ?").bind(reviewer, why || null, sid).run();
      return queue("Not recorded. The suggestion is kept here, not shown.");
    }
    if (!["auto", "approved"].includes(p.review) || ["kept", "broken"].includes(p.status)) return queue(`Nothing changed: the promise is ${STATUS[p.status] ? STATUS[p.status][0] : p.status} or no longer published.`);
    await db.batch([
      db.prepare("INSERT INTO promise_status_changes (promise_id, from_status, to_status, evidence, evidence_quote, evidence_on, source_url, recorded_by) VALUES (?, ?, 'broken', ?, ?, ?, ?, ?)")
        .bind(id, p.status, sug.evidence, sug.evidence_quote, sug.evidence_on, sug.source_url, reviewer),
      db.prepare("UPDATE promises SET status = 'broken' WHERE id = ?").bind(id),
      db.prepare("UPDATE promise_status_suggestions SET status = 'approved', decided_by = ?, decided_at = datetime('now') WHERE id = ?").bind(reviewer, sid),
    ]);
    return queue(`Recorded as Broken, by ${reviewer}, with its evidence.`);
  }
  if (action === "note") {
    const note = String(form.get("check_note") || "").replace(/\s+/g, " ").trim();
    const problems = wordingProblems(note);
    if (!note || note.length > 300 || problems.length) {
      return promiseDetail(db, env, id, { error: !note ? "The note can't be empty." : note.length > 300 ? "Keep the note under 300 characters." : `Use neutral wording: ${problems.join("; ")}.`, form: { check_note: note } });
    }
    await db.prepare("UPDATE promises SET check_note = ? WHERE id = ?").bind(note, id).run();
    return back("done=Note saved.");
  }
  if (action === "status") {
    if (p.review !== "approved" && p.review !== "auto") return back("done=Publish the promise before recording a status.");
    const f = {
      to_status: String(form.get("to_status") || ""),
      evidence: String(form.get("evidence") || "").replace(/\s+/g, " ").trim().slice(0, 1000),
      evidence_on: String(form.get("evidence_on") || "").trim(),
      source_url: String(form.get("source_url") || "").trim(),
      reviewer,
    };
    const problems = wordingProblems(f.evidence, { strict: false });
    const error = !STATUSES.includes(f.to_status) || f.to_status === p.status ? "Choose a different status."
      : !f.evidence ? "Describe the evidence."
      : problems.length ? `Use neutral wording in the evidence: ${problems.join("; ")}.`
      : !ISO_DATE.test(f.evidence_on) || f.evidence_on > new Date().toISOString().slice(0, 10) ? "Enter the date of the evidence (not in the future)."
      : !safeUrl(f.source_url) ? "Enter the source as an http(s) link."
      : !reviewer ? "Enter your name: it's shown with the change."
      : "";
    if (error) return promiseDetail(db, env, id, { error, form: f });
    await db.batch([
      db.prepare("INSERT INTO promise_status_changes (promise_id, from_status, to_status, evidence, evidence_on, source_url, recorded_by) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, p.status, f.to_status, f.evidence, f.evidence_on, f.source_url, reviewer),
      db.prepare("UPDATE promises SET status = ? WHERE id = ?").bind(f.to_status, id),
    ]);
    return back(`done=${encodeURIComponent(`Recorded: ${STATUS[f.to_status][0]}.`)}`);
  }
  return back("done=Nothing changed.");
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const who = await checkAccess(request, env);
  if (!who.ok) return locked(who.reason);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return Response.redirect(`${url.origin}/admin/review/`, 302);
  if (parts[0] !== "review" && parts[0] !== "waitlist") return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  if (!env.DB) return missingTables();
  if (parts[0] === "waitlist") {
    if (parts.length !== 1 || request.method !== "GET") return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
    return waitlist(env.DB);
  }
  if (parts[1] === "relevance") {
    if (parts.length !== 3 || request.method !== "POST") return Response.redirect(`${url.origin}/admin/review/#skipped`, 302);
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
    return relevanceChange(env.DB, decodeURIComponent(parts[2]), request, who.email);
  }
  if (parts[1] === "topics") {
    try {
      if (parts.length === 2) return adminPage(...Object.values(await topicReviewList(env.DB, url)));
      if (parts[2] === "find" && parts.length === 3) {
        const it = itemFromLink(url.searchParams.get("link"));
        if (!it) return adminPage(...Object.values(await topicReviewList(env.DB, url, { error: "That isn't a bill page link, an agenda item link (…/meetings/…#item-…) or a bill id." })));
        return Response.redirect(`${url.origin}${reviewHref(it.kind, it.id)}`, 303);
      }
      const kind = parts[2];
      const id = url.searchParams.get("id") || "";
      if (parts.length !== 3 || !TOPIC_KINDS[kind]) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
        const fd = await request.formData();
        const r = await topicReviewChange(env.DB, kind, id, { topics: fd.getAll("topics"), note: fd.get("note"), reviewer: fd.get("reviewer") });
        if (r.error) {
          const v = await topicReviewItem(env.DB, env, kind, id, { error: r.error, form: r.form });
          return v ? adminPage(v.title, v.main) : adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
        }
        return Response.redirect(`${url.origin}${reviewHref(kind, id)}&done=${encodeURIComponent(r.done)}`, 303);
      }
      const v = await topicReviewItem(env.DB, env, kind, id, { done: url.searchParams.get("done") || "" });
      return v ? adminPage(v.title, v.main) : adminPage("Not found", '<header class="page-head"><h1>No such item</h1><p class="subtitle">Nothing with that id is on the site or tagged.</p></header>', 404);
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return missingTables();
      throw err;
    }
  }
  if (parts[1] === "promise" && ["new", "batch", "pages", "statements", "candidates"].includes(parts[2]) && parts.length === 3) {
    try {
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
        if (parts[2] === "new") return await promiseCreate(env.DB, env, request);
        if (parts[2] === "batch") return await promiseBatch(env.DB, request);
        if (parts[2] === "statements") return await officialStatementsChange(env.DB, env, request);
        if (parts[2] === "candidates") return await candidatePagesChange(env.DB, request, who.email);
        return await promisePagesChange(env.DB, env, request, who.email);
      }
      if (parts[2] === "new") return await promiseNew(env.DB, env);
      if (parts[2] === "statements") return await officialStatements(env.DB, env, { done: url.searchParams.get("done") || "" });
      if (parts[2] === "pages") return await promisePages(env.DB, env, { done: url.searchParams.get("done") || "" });
      if (parts[2] === "candidates") return await candidatePages(env.DB, { done: url.searchParams.get("done") || "", offset: Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0) });
      return Response.redirect(`${url.origin}/admin/review/#promises`, 302);
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return missingTables();
      throw err;
    }
  }
  if (parts[1] === "promise") {
    const sub = parseInt(parts[2], 10);
    if (parts.length !== 3 || !(sub > 0)) return adminPage("Not found", '<header class="page-head"><h1>Not found</h1></header>', 404);
    try {
      if (request.method === "POST") {
        const origin = request.headers.get("Origin");
        if (origin && origin !== url.origin) return adminPage("Refused", '<header class="page-head"><h1>Refused</h1></header>', 403);
        return await promiseChange(env.DB, env, sub, request);
      }
      return await promiseDetail(env.DB, env, sub, { done: url.searchParams.get("done") || "" });
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return missingTables();
      throw err;
    }
  }
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
      if (/no such table|no such column/i.test(String(err && err.message))) return missingTables();
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
    if (!id) return await list(env.DB, url, env);
    return await detail(env.DB, env, id, { done: url.searchParams.get("done") || "", email: who.email });
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return missingTables();
    throw err;
  }
}

export const onRequestGet = guard(handle);
export const onRequestPost = guard(handle);
