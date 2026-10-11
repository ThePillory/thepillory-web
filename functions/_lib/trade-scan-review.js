// Scanned OGE Form 278-T reports on /admin/review/trades/ (routed from
// functions/admin/[[path]].js; docs/trades.md):
//   /admin/review/trades/          spot checks; published by AI; not agreeing (kept as
//                                  links); waiting to be read; confirmed; taken down
//   /admin/review/trades/<id>/     one report: the scan's link, what the checks noted,
//                                  the rows; confirm, take down, read again
// A transcription publishes on its own once both AI readings agree and the
// checks pass ("Transcribed by AI from a scanned report, auto-checked").
// Confirming adds "Checked by [name]" after a person compares every row with
// the scan; taking down removes the trades and makes the report a link again.
import { esc, fmtDate, safeUrl } from "./render.js";
import { takeDownStatements } from "../../workers/sync/src/trades/publish.js";

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
  ["spot", "Spot checks", "Picked at random from published transcriptions. Compare every row with the scan, then confirm it or take it down."],
  ["agreed", "Published by AI", "Both readings agreed and the checks passed; public as \"Transcribed by AI from a scanned report, auto-checked\"."],
  ["disagree", "Readings didn't agree", "Kept as links to the report on public pages. The notes say why."],
  ["pending", "Waiting to be read", "The sync Worker reads these, a few a day."],
  ["approved", "Confirmed by a person", "Public with \"Checked by [name]\"."],
  ["rejected", "Taken down", "Kept as links to the report."],
];
const sectionOf = (s) => (s.status === "agreed" && s.spot_check ? "spot" : s.status);

const BASE = `SELECT s.report_id, s.status, s.spot_check, s.text_rows, s.reading, s.problems, s.models, s.read_at, s.reviewed_by, s.reviewed_at, s.reject_reason,
  r.report_url, r.filed_on, r.official_id, r.chamber, r.state, r.filer_name, o.name AS official_name, o.slug
  FROM trade_scans s JOIN trade_reports r ON r.id = s.report_id LEFT JOIN officials o ON o.id = r.official_id`;

function lineFor(s) {
  const rows = json(s.reading, []).length;
  const meta = [`Filed ${fmtDate(s.filed_on)}`, s.status === "pending" ? `${s.text_rows} rows in its text layer` : `${rows} agreed rows`];
  if (s.reviewed_by) meta.push(`${s.status === "approved" ? "Confirmed" : "Taken down"} by ${s.reviewed_by}`);
  return `<a class="compact-row" href="${scanHref(s.report_id)}"><span class="cr-main"><span class="cr-title">${esc(s.official_name || s.filer_name)}</span><span class="cr-meta">${esc(meta.join(" · "))}</span></span><span class="chev" aria-hidden="true">›</span></a>`;
}

export async function scanList(db, { done = "" } = {}) {
  const { results } = await db.prepare(`${BASE} ORDER BY r.filed_on DESC LIMIT 400`).all();
  const sections = SECTIONS.map(([status, title, note]) => {
    const rows = results.filter((s) => sectionOf(s) === status);
    return `<h2 class="label queue-head">${esc(title)} (${rows.length})</h2><p class="hint">${esc(note)}</p>${rows.length ? `<div class="card compact-list">${rows.map(lineFor).join("")}</div>` : '<p class="small secondary">None.</p>'}`;
  }).join("");
  return {
    title: "Scanned trade reports",
    main: `<header class="page-head"><h1>Scanned trade reports</h1><p class="subtitle">Executive branch reports (OGE Form 278-T) posted as scans. Each is read twice by AI, by two different models; the trades publish when the readings agree and the checks pass, labeled as transcribed by AI. A share is picked for you to check against the scan.</p></header>
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
    actions = `<section class="card stack-sm"><h2 class="label">Confirm</h2>
${post(`<input type="hidden" name="action" value="approve">
  <label class="check-row"><input type="checkbox" name="compared" value="1" required> <span class="small">I compared every row above with the scan: the dates, types, descriptions and amounts.</span></label>
  <label class="field"><span class="field-label">Your name, as shown with these trades</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn btn--primary" type="submit">Confirm: show "Checked by" with these ${rows.length} trades</button>`)}
</section>`;
  }
  if (["agreed", "approved"].includes(s.status)) {
    actions += `<section class="card stack-sm"><h2 class="label">Take down</h2><p class="small">Removes these trades from public pages; the report shows as a link again.</p>
${post(`<input type="hidden" name="action" value="reject">
  <label class="field"><span class="field-label">What's wrong (kept with the report)</span><input class="input" name="reason" required value="${esc(f.reason || "")}"></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn" type="submit">Take down</button>`)}
</section>`;
  } else if (["disagree", "rejected"].includes(s.status)) {
    actions = `<section class="card stack-sm"><h2 class="label">Read again</h2><p class="small">Puts it back in the queue: both models read it again on a later sync run.</p>
${post('<input type="hidden" name="action" value="reread"><button class="btn" type="submit">Read it again</button>')}</section>`;
  }
  const url = safeUrl(s.report_url);
  return {
    title: `Scanned report: ${s.official_name || s.filer_name}`,
    main: `<header class="page-head"><h1>${esc(s.official_name || s.filer_name)}</h1><p class="subtitle">OGE Form 278-T, filed ${esc(fmtDate(s.filed_on))} · ${esc(SECTIONS.find((x) => x[0] === sectionOf(s))?.[1] || s.status)}</p></header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<section class="card stack-sm">
  <p>${url ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">Open the scanned report</a> ↗` : "No document link."}</p>
  <p class="small secondary">Read by ${esc(s.models || "—")}${s.read_at ? ` on ${esc(fmtDate(s.read_at.slice(0, 10)))}` : ""}. Its own text layer shows ${s.text_rows} numbered rows.</p>
  ${s.reviewed_by ? `<p class="small">${s.status === "approved" ? "Confirmed" : "Taken down"} by ${esc(s.reviewed_by)}${s.reviewed_at ? `, ${esc(fmtDate(s.reviewed_at.slice(0, 10)))}` : ""}${s.reject_reason ? `: ${esc(s.reject_reason)}` : ""}</p>` : ""}
</section>
${blocks.length ? `<section class="card stack-sm"><h2 class="label">Why it wasn't published</h2><ul class="plain-list">${blocks.map((p) => `<li class="small">${esc(p.text)}</li>`).join("")}</ul></section>` : ""}
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
  const report = { id, official_id: s.official_id };
  if (action === "reject") {
    if (!["agreed", "approved"].includes(s.status)) return { error: "Only a published transcription can be taken down.", form };
    if (!form.reason) return { error: "Say what's wrong: it's kept with the report.", form };
    await db.batch([
      db.prepare("UPDATE trade_scans SET status = 'rejected', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE report_id = ?").bind(form.reviewer, email || null, form.reason, id),
      ...takeDownStatements(report).map((q) => db.prepare(q.sql).bind(...q.binds)),
    ]);
    return { done: "Taken down. The report is a link again on public pages." };
  }
  if (action !== "approve") return { error: "Unknown action.", form };
  if (s.status !== "agreed") return { error: "Only a transcription published by AI can be confirmed.", form };
  if (rawForm.get("compared") !== "1") return { error: "Tick the box once you've compared every row with the scan.", form };
  await db.batch([
    db.prepare("UPDATE trade_scans SET status = 'approved', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE report_id = ?").bind(form.reviewer, email || null, id),
    db.prepare("UPDATE trade_reports SET transcribed_by = ? WHERE id = ?").bind(form.reviewer, id),
  ]);
  return { done: `Confirmed. These trades now show "Checked by ${form.reviewer}".` };
}
