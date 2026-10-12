// Scanned net worth reports on /admin/review/networth/ (routed from
// functions/admin/[[path]].js; docs/funding.md "Net worth"):
//   /admin/review/networth/              every report read by AI: published (to check),
//                                        held (lines read differently), confirmed, taken down
//   /admin/review/networth/<id>/         one report: the totals, the lines the two readings
//                                        read differently (pick one for each), the lines page
//                                        by page beside the scan; confirm or take down
//   /admin/review/networth/<id>/?page=N  the lines read from one page of the scan
// tools/networth_scan.py reads the reports and publishes a report whose two
// readings agree on every line ("Transcribed by AI from a scanned report,
// auto-checked"). Lines a person settles here are applied by its next run in
// "publish" mode, which publishes with "Checked by [name]".
import { esc, fmtDate, safeUrl } from "./render.js";

export const networthReviewHref = (id) => `/admin/review/networth/${encodeURIComponent(id)}/`;
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const json = (s, fallback) => {
  try {
    return JSON.parse(s || "") ?? fallback;
  } catch (_) {
    return fallback;
  }
};
const money = (n) => (n == null ? "" : `${n < 0 ? "−" : ""}$${Math.abs(Math.round(n)).toLocaleString("en-US")}`);

const SECTIONS = [
  ["agreed", "Published by AI: check these", "Both readings agreed on every line and the checks passed. Public as \"Transcribed by AI from a scanned report, auto-checked\". Compare the lines with the scan, then confirm or take it down."],
  ["disagree", "Held", "Nothing public: some lines were read differently (or a check failed). Pick the right reading for each; the next run of the \"Read a scanned net worth report\" workflow (mode: publish) publishes it."],
  ["approved", "Confirmed by a person", "Public with \"Checked by [name]\"."],
  ["rejected", "Taken down", "A link to the report again."],
];

const BASE = `SELECT s.*, o.name AS official_name, r.low, r.high, r.low_open, r.high_open, r.assets, r.liabilities, r.year AS report_year
  FROM networth_scans s LEFT JOIN officials o ON o.id = s.official_id LEFT JOIN networth_reports r ON r.id = s.report_id`;

const who = (s) => s.official_name || s.official_id;

export async function networthScanList(db, { done = "" } = {}) {
  const { results } = await db.prepare(`${BASE} ORDER BY s.read_at DESC LIMIT 200`).all();
  const line = (s) => {
    const dis = json(s.disagreements, []).length;
    const meta = [`${s.year || ""} report`, `${s.lines_total || 0} lines`, dis ? `${dis} read differently` : "", s.reviewed_by ? `by ${s.reviewed_by}` : ""].filter(Boolean).join(" · ");
    return `<a class="compact-row" href="${networthReviewHref(s.report_id)}"><span class="cr-main"><span class="cr-title">${esc(who(s))}</span><span class="cr-meta">${esc(meta)}</span></span><span class="chev" aria-hidden="true">›</span></a>`;
  };
  return {
    title: "Scanned net worth reports",
    main: `<header class="page-head"><h1>Scanned net worth reports</h1><p class="subtitle">Annual financial disclosure reports posted as scans, read twice by two AI models. Every line has to be read the same way by both before the report counts toward "Net worth, as reported".</p></header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${SECTIONS.map(([status, title, note]) => {
  const rows = results.filter((s) => s.status === status);
  return `<h2 class="label queue-head">${esc(title)} (${rows.length})</h2><p class="hint">${esc(note)}</p>${rows.length ? `<div class="card compact-list">${rows.map(line).join("")}</div>` : '<p class="small secondary">None.</p>'}`;
}).join("")}`,
  };
}

const flags = (x) => [x.inc ? "income" : "", x.elsewhere ? "reported elsewhere" : "", x.nra ? "not readily ascertainable" : "", x.unsure ? "hard to read" : ""].filter(Boolean).join(", ");
const lineText = (x) => (x && typeof x === "object" ? `${x.n ? `Line ${x.n}: ` : ""}${x.v || "(no value)"}${flags(x) ? ` (${flags(x)})` : ""}${x.cred ? ` · ${x.cred}` : ""}` : String(x || ""));

function linesTable(lines) {
  return `<div class="table-scroll"><table class="tally-table"><thead><tr><th scope="col">Section</th><th scope="col">Heading</th><th scope="col">Line</th><th scope="col">Value</th><th scope="col">Notes</th></tr></thead><tbody>${lines
    .map((x) => `<tr><td>${esc(x.sec)}</td><td>${esc(x.grp || "")}</td><td>${esc(x.n || "")}</td><td>${esc(x.v || "")}</td><td>${esc([flags(x), x.cred].filter(Boolean).join(" · "))}</td></tr>`)
    .join("")}</tbody></table></div>`;
}

export async function networthScanItem(db, env, id, { error = "", done = "", form = null, page = null } = {}) {
  const s = await db.prepare(`${BASE} WHERE s.report_id = ?`).bind(id).first();
  if (!s) return null;
  const url = safeUrl(s.report_url);
  const scanAt = (p) => (url ? `<a class="inline-link" href="${esc(url)}#page=${p}" target="_blank" rel="noopener">page ${p} of the scan ↗</a>` : `page ${p}`);
  const lines = json(s.reading, []);
  const dis = json(s.disagreements, []);
  const problems = json(s.problems, []);
  const settled = json(s.settled, {});
  const f = form || {};
  const reviewer = esc(f.reviewer || s.reviewed_by || env.REVIEWER_NAME || "");
  const post = (inner) => `<form method="post" action="${networthReviewHref(id)}" class="stack-sm">${inner}</form>`;
  const head = `<header class="page-head"><h1>${esc(who(s))}</h1><p class="subtitle">Annual report for ${esc(String(s.year || ""))} · ${esc(SECTIONS.find((x) => x[0] === s.status)?.[1] || s.status)}</p></header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}`;

  if (page != null) {
    const here = lines.filter((x) => x.page === page);
    return {
      title: `Page ${page}: ${who(s)}`,
      main: `${head}<p><a class="inline-link" href="${networthReviewHref(id)}">← All pages</a></p>
<section class="card stack-sm"><p class="small">${here.length} lines read from ${scanAt(page)}. Compare each one with the scan.</p></section>
${here.length ? linesTable(here) : '<p class="small secondary">No lines from this page.</p>'}`,
    };
  }

  const pages = [...new Set(lines.map((x) => x.page))].sort((a, b) => a - b);
  const counts = Object.fromEntries(pages.map((p) => [p, lines.filter((x) => x.page === p).length]));
  const settleForm = dis.length && ["disagree"].includes(s.status)
    ? `<section class="card stack-sm"><h2 class="label">Read differently (${dis.length})</h2><p class="small">For each, open the scan at that page and pick the reading that matches it exactly. If neither does, leave it: the report stays a link.</p>
${post(`<input type="hidden" name="action" value="settle">
${dis.map((d) => `<fieldset class="stack-xs settle-line"><legend class="small">${scanAt(d.page)}${"idx" in d ? `, line ${d.idx + 1} on the page` : ": the readings found a different number of lines"}</legend>
  <label class="check-row"><input type="radio" name="${esc(d.key)}" value="a"${settled[d.key] === "a" ? " checked" : ""}> <span class="small">Reading A: ${esc("idx" in d ? lineText(d.a) : `${d.a}: ${(d.lines_a || []).map(lineText).join("; ")}`)}</span></label>
  <label class="check-row"><input type="radio" name="${esc(d.key)}" value="b"${settled[d.key] === "b" ? " checked" : ""}> <span class="small">Reading B: ${esc("idx" in d ? lineText(d.b) : `${d.b}: ${(d.lines_b || []).map(lineText).join("; ")}`)}</span></label>
  <label class="check-row"><input type="radio" name="${esc(d.key)}" value=""${!settled[d.key] ? " checked" : ""}> <span class="small">Neither matches the scan</span></label>
</fieldset>`).join("")}
  <label class="field"><span class="field-label">Your name, as shown with this report ("Checked by")</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn btn--primary" type="submit">Save these choices</button>`)}</section>`
    : "";
  let actions = "";
  if (s.status === "agreed") {
    actions = `<section class="card stack-sm"><h2 class="label">Confirm</h2>
${post(`<input type="hidden" name="action" value="approve">
  <label class="check-row"><input type="checkbox" name="compared" value="1" required> <span class="small">I compared the lines with the scan, page by page.</span></label>
  <label class="field"><span class="field-label">Your name, as shown with this report</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn btn--primary" type="submit">Confirm: show "Checked by"</button>`)}</section>`;
  }
  if (["agreed", "approved"].includes(s.status)) {
    actions += `<section class="card stack-sm"><h2 class="label">Take down</h2><p class="small">Removes this report from "Net worth, as reported"; it shows as a link again.</p>
${post(`<input type="hidden" name="action" value="reject">
  <label class="field"><span class="field-label">What's wrong (kept with the report)</span><input class="input" name="reason" required value="${esc(f.reason || "")}"></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="reviewer" required autocomplete="name" value="${reviewer}"></label>
  <button class="btn" type="submit">Take down</button>`)}</section>`;
  }
  return {
    title: `Scanned net worth report: ${who(s)}`,
    main: `${head}
<section class="card stack-sm">
  <p>${url ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">Open the scanned report</a> ↗` : "No document link."}</p>
  <p class="small secondary">Read by ${esc(s.models || "—")}${s.read_at ? ` on ${esc(fmtDate(s.read_at.slice(0, 10)))}` : ""} · ${s.lines_total || 0} lines · cost $${((s.cost_cents || 0) / 100).toFixed(2)}.</p>
  ${s.low != null && ["agreed", "approved"].includes(s.status) ? `<p class="small">Published: ${s.assets} assets, ${s.liabilities} liabilities: ${money(s.low)}${s.low_open ? " or less" : ""} to ${money(s.high)}${s.high_open ? " or more" : ""}.</p>` : ""}
  ${s.reviewed_by ? `<p class="small">${s.status === "rejected" ? "Taken down" : s.status === "approved" ? "Confirmed" : "Lines settled"} by ${esc(s.reviewed_by)}${s.reviewed_at ? `, ${esc(fmtDate(s.reviewed_at.slice(0, 10)))}` : ""}${s.reject_reason ? `: ${esc(s.reject_reason)}` : ""}</p>` : ""}
</section>
${problems.length ? `<section class="card stack-sm"><h2 class="label">What the checks noted</h2><ul class="plain-list">${problems.map((p) => `<li class="small">${p.kind === "block" ? "Held: " : ""}${esc(p.text)}</li>`).join("")}</ul></section>` : ""}
${settleForm}
${actions}
<section class="stack-sm"><h2 class="label">Lines both readings agreed on, by page (${lines.length})</h2>
${pages.length ? `<div class="card compact-list">${pages.map((p) => `<a class="compact-row" href="${networthReviewHref(id)}?page=${p}"><span class="cr-main"><span class="cr-title">Page ${p}</span><span class="cr-meta">${counts[p]} lines</span></span><span class="chev" aria-hidden="true">›</span></a>`).join("")}</div>` : '<p class="small secondary">None.</p>'}</section>`,
  };
}

/** A POST on /admin/review/networth/<id>/. Returns {done} or {error, form}. */
export async function networthScanChange(db, id, rawForm, email) {
  const action = String(rawForm.get("action") || "");
  const form = { reviewer: clean(rawForm.get("reviewer"), 80), reason: clean(rawForm.get("reason"), 300) };
  const s = await db.prepare("SELECT * FROM networth_scans WHERE report_id = ?").bind(id).first();
  if (!s) return { error: "No such report.", form };
  if (!form.reviewer) return { error: "Enter your name.", form };
  if (action === "settle") {
    if (s.status !== "disagree") return { error: "Only a held report has lines to settle.", form };
    const dis = json(s.disagreements, []);
    const settled = {};
    for (const d of dis) {
      const v = String(rawForm.get(d.key) || "");
      if (v === "a" || v === "b") settled[d.key] = v;
    }
    await db.prepare("UPDATE networth_scans SET settled = ?, reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE report_id = ?").bind(JSON.stringify(settled), form.reviewer, email || null, id).run();
    const left = dis.length - Object.keys(settled).length;
    return { done: left ? `Saved. ${left} still open: the report stays a link until every line is settled.` : "Saved. Every line is settled: run the \"Read a scanned net worth report\" workflow in publish mode to publish it." };
  }
  if (action === "reject") {
    if (!["agreed", "approved"].includes(s.status)) return { error: "Only a published report can be taken down.", form };
    if (!form.reason) return { error: "Say what's wrong: it's kept with the report.", form };
    await db.batch([
      db.prepare("UPDATE networth_scans SET status = 'rejected', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now'), reject_reason = ? WHERE report_id = ?").bind(form.reviewer, email || null, form.reason, id),
      db.prepare(`UPDATE networth_reports SET status = 'scan', method = NULL, reason = 'Read by AI, taken down after review', assets = NULL, liabilities = NULL, asset_min = NULL, asset_max = NULL,
        liab_min = NULL, liab_max = NULL, low = NULL, high = NULL, low_open = 0, high_open = 0, residence_mortgages = 0, parser = NULL WHERE id = ?`).bind(id),
    ]);
    return { done: "Taken down. The report is a link again on public pages." };
  }
  if (action !== "approve") return { error: "Unknown action.", form };
  if (s.status !== "agreed") return { error: "Only a report published by AI can be confirmed.", form };
  if (rawForm.get("compared") !== "1") return { error: "Tick the box once you've compared the lines with the scan.", form };
  await db.prepare("UPDATE networth_scans SET status = 'approved', reviewed_by = ?, reviewer_email = ?, reviewed_at = datetime('now') WHERE report_id = ?").bind(form.reviewer, email || null, id).run();
  return { done: `Confirmed. The report now shows "Checked by ${form.reviewer}".` };
}
