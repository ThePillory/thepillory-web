// Scanned OGE Form 278-T reports on /admin/review/trades/ (routed from
// functions/admin/[[path]].js; docs/trades.md):
//   /admin/review/trades/          waiting for a person; not agreeing (kept as links);
//                                  waiting to be read; approved; rejected
//   /admin/review/trades/<id>/     one report: the scan's link, what the checks noted,
//                                  the agreed rows; approve, reject, read again
// Approving publishes the rows as trades labeled "Transcribed from a scanned
// report · Checked by [name]" and rebuilds the official's trade summary. Only
// rows both readings agreed on can be approved; a person compares every row
// with the scan first.
import { esc, fmtDate, safeUrl } from "./render.js";
import { summaryStatements } from "../../workers/sync/src/trades/summary.js";
import { blocking } from "../../workers/sync/src/trades/scan-check.js";

export const scanHref = (id) => `/admin/review/trades/${encodeURIComponent(id)}/`;
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const json = (s, fallback) => {
  try {
    return JSON.parse(s || "");
  } catch (_) {
    return fallback;
  }
};

const SECTIONS = [
  ["agreed", "Waiting for you", "Both readings agree and the checks passed. Compare every row with the scan, then approve or reject."],
  ["disagree", "Readings didn't agree", "Kept as links to the report on public pages. The notes say why."],
  ["pending", "Waiting to be read", "The sync Worker reads these, a few a day."],
  ["approved", "Approved", "Published as transcribed from a scanned report."],
  ["rejected", "Rejected", "Kept as links to the report."],
];

const BASE = `SELECT s.report_id, s.status, s.text_rows, s.reading, s.problems, s.models, s.read_at, s.reviewed_by, s.reviewed_at, s.reject_reason,
  r.report_url, r.filed_on, r.official_id, r.chamber, r.state, r.filer_name, o.name AS official_name, o.slug
  FROM trade_scans s JOIN trade_reports r ON r.id = s.report_id LEFT JOIN officials o ON o.id = r.official_id`;

function lineFor(s) {
  const rows = json(s.reading, []).length;
  const meta = [`Filed ${fmtDate(s.filed_on)}`, s.status === "pending" ? `${s.text_rows} rows in its text layer` : `${rows} agreed rows`];
  if (s.reviewed_by) meta.push(`${s.status === "approved" ? "Approved" : "Rejected"} by ${s.reviewed_by}`);
  return `<a class="compact-row" href="${scanHref(s.report_id)}"><span class="cr-main"><span class="cr-title">${esc(s.official_name || s.filer_name)}</span><span class="cr-meta">${esc(meta.join(" · "))}</span></span><span class="chev" aria-hidden="true">›</span></a>`;
}

export async function scanList(db, { done = "" } = {}) {
  const { results } = await db.prepare(`${BASE} ORDER BY r.filed_on DESC LIMIT 400`).all();
  const sections = SECTIONS.map(([status, title, note]) => {
    const rows = results.filter((s) => s.status === status);
    return `<h2 class="label queue-head">${esc(title)} (${rows.length})</h2><p class="hint">${esc(note)}</p>${rows.length ? `<div class="card compact-list">${rows.map(lineFor).join("")}</div>` : '<p class="small secondary">None.</p>'}`;
  }).join("");
  return {
    title: "Scanned trade reports",
    main: `<header class="page-head"><h1>Scanned trade reports</h1><p class="subtitle">Executive branch reports (OGE Form 278-T) posted as scans. Each is read twice by AI, by two different models; rows publish only when the readings agree, the checks pass, and a person has compared them with the scan.</p></header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${sections}`,
  };
}

function rowsTable(rows) {
  return `<div class="table-scroll"><table class="tally-table"><thead><tr><th scope="col">#</th><th scope="col">Date</th><th scope="col">Type</th><th scope="col">Description</th><th scope="col">Amount</th><th scope="col">Owner</th></tr></thead><tbody>${rows
    .map((r) => `<tr><td>${r.n}</td><td>${esc(fmtDate(r.date))}</td><td>${esc(r.type)}</td><td>${esc(r.description)}</td><td>${esc(r.amount)}</td><td>${esc(r.owner || "Not stated")}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

export async function scanItem(db, env, id, { error = "", done = "", form = null } = {}) {
  const s = await db.prepare(`${BASE} WHERE s.report_id = ?`).bind(id).first();
  if (!s) return null;
  const rows = json(s.reading, []);
  const problems = json(s.problems, []);
  const blocks = problems.filter((p) => p.kind === "block");
  const looks = problems.filter((p) => p.kind === "look");
  const f = form || {};
  const reviewer = esc(f.reviewer || env.REVIEWER_NAME || "");
  const post = (inner) => `<form method="post" action="${scanHref(s.report_id)}" class="stack-sm">${inner}</form>`;
  let actions = "";
  if (s.status === "agreed") {
    actions = `<section class="card stack-sm"><h2 class="label">Approve</h2>
${post(`<input type="hidden" name="action" value="approve">
  <label class="check-row"><input type="checkbox" name="compared" value="1" required> <span class="small">I compared every row above with the scan: the dates, types, descriptions and amounts.</span></label>
  <label class="field"><span class="field-label">Your name, as shown with these trades</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn btn--primary" type="submit">Approve and publish ${rows.length} trades</button>`)}
</section>
<section class="card stack-sm"><h2 class="label">Reject</h2>
${post(`<input type="hidden" name="action" value="reject">
  <label class="field"><span class="field-label">What's wrong (kept with the report)</span><input class="input" name="reason" required value="${esc(f.reason || "")}"></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn" type="submit">Reject: keep it a link</button>`)}
</section>`;
  } else if (["disagree", "rejected"].includes(s.status)) {
    actions = `<section class="card stack-sm"><h2 class="label">Read again</h2><p class="small">Puts it back in the queue: both models read it again on a later sync run.</p>
${post('<input type="hidden" name="action" value="reread"><button class="btn" type="submit">Read it again</button>')}</section>`;
  }
  const url = safeUrl(s.report_url);
  return {
    title: `Scanned report: ${s.official_name || s.filer_name}`,
    main: `<header class="page-head"><h1>${esc(s.official_name || s.filer_name)}</h1><p class="subtitle">OGE Form 278-T, filed ${esc(fmtDate(s.filed_on))} · ${esc(SECTIONS.find((x) => x[0] === s.status)?.[1] || s.status)}</p></header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<section class="card stack-sm">
  <p>${url ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">Open the scanned report</a> ↗` : "No document link."}</p>
  <p class="small secondary">Read by ${esc(s.models || "—")}${s.read_at ? ` on ${esc(fmtDate(s.read_at.slice(0, 10)))}` : ""}. Its own text layer shows ${s.text_rows} numbered rows.</p>
  ${s.reviewed_by ? `<p class="small">${s.status === "approved" ? "Approved" : "Rejected"} by ${esc(s.reviewed_by)}${s.reviewed_at ? `, ${esc(fmtDate(s.reviewed_at.slice(0, 10)))}` : ""}${s.reject_reason ? `: ${esc(s.reject_reason)}` : ""}</p>` : ""}
</section>
${blocks.length ? `<section class="card stack-sm"><h2 class="label">Why it can't be approved</h2><ul class="plain-list">${blocks.map((p) => `<li class="small">${esc(p.text)}</li>`).join("")}</ul></section>` : ""}
${looks.length ? `<section class="card stack-sm"><h2 class="label">Check these closely</h2><ul class="plain-list">${looks.map((p) => `<li class="small">${esc(p.text)}</li>`).join("")}</ul></section>` : ""}
${rows.length ? `<section class="stack-sm"><h2 class="label">${s.status === "disagree" ? "Rows both readings agreed on" : "The rows"} (${rows.length})</h2>${rowsTable(rows)}</section>` : ""}
${actions}`,
  };
}

/** A POST on /admin/review/trades/<id>/. Returns {done} or {error, form}. */
export async function scanChange(db, id, rawForm, email) {
  const action = String(rawForm.get("action") || "");
  const form = { reviewer: clean(rawForm.get("reviewer"), 80), reason: clean(rawForm.get("reason"), 300) };
  const s = await db.prepare(`${BASE} WHERE s.report_id = ?`).bind(id).first();
  if (!s) return { error: "No such report.", form };
  if (action === "reread") {
    if (!["disagree", "rejected"].includes(s.status)) return { error: "Only a report that didn't agree or was rejected can be read again.", form };
    await db.prepare("UPDATE trade_scans SET status = 'pending', reading = NULL, problems = NULL, reviewed_by = NULL, reviewer_email = NULL, reviewed_at = NULL, reject_reason = NULL WHERE report_id = ?").bind(id).run();
    return { done: "Back in the queue: it's read again on a later sync run." };
  }
  if (!form.reviewer) return { error: "Enter your name.", form };
  if (action === "reject") {
    if (s.status !== "agreed") return { error: "Only a report waiting for you can be rejected.", form };
    if (!form.reason) return { error: "Say what's wrong: it's kept with the report.", form };
    await db
      .prepare("UPDATE trade_scans SET status = 'rejected', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE report_id = ? AND status = 'agreed'")
      .bind(form.reviewer, email || null, form.reason, id)
      .run();
    return { done: "Rejected. The report stays a link on public pages." };
  }
  if (action !== "approve") return { error: "Unknown action.", form };
  if (s.status !== "agreed") return { error: "Only rows both readings agreed on, waiting for you, can be approved.", form };
  if (rawForm.get("compared") !== "1") return { error: "Tick the box once you've compared every row with the scan.", form };
  if (blocking(json(s.problems, []))) return { error: "The checks found a problem; this report can't be approved.", form };
  const rows = json(s.reading, []);
  if (!rows.length || !s.official_id) return { error: "Nothing to publish.", form };
  const stmts = [
    db.prepare("DELETE FROM trades WHERE report_id = ?").bind(id),
    ...rows.map((r) =>
      db
        .prepare(
          `INSERT INTO trades (report_id, n, official_id, chamber, state, transaction_date, filed_on, days_to_file, owner, asset_name, ticker, asset_type, type, amount, amount_min, amount_max, sic, sector)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, NULL, ?, ?, ?, ?, (SELECT sic FROM sec_tickers WHERE ticker = ?), (SELECT sector FROM sec_tickers WHERE ticker = ?))`
        )
        .bind(id, r.n, s.official_id, s.chamber, s.state, r.date, s.filed_on, r.owner, r.description, r.ticker, r.type, r.amount, r.amount_min, r.amount_max, r.ticker, r.ticker)
    ),
    db.prepare("UPDATE trade_reports SET parsed = 1, trade_count = ?, transcribed_by = ?, transcribed_at = datetime('now') WHERE id = ?").bind(rows.length, form.reviewer, id),
    db.prepare("UPDATE trade_scans SET status = 'approved', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE report_id = ?").bind(form.reviewer, email || null, id),
    ...summaryStatements([s.official_id]).map((q) => db.prepare(q.sql).bind(...q.binds)),
  ];
  await db.batch(stmts);
  return { done: `Published ${rows.length} trades, labeled "Transcribed from a scanned report · Checked by ${form.reviewer}".` };
}
