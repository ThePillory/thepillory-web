// Readers' error reports on /admin/corrections/ (routed from
// functions/admin/[[path]].js; the public form is functions/corrections/):
// open reports first, oldest first, each with its page, what the reader says
// is wrong and the source they point to; a person records what was done
// (fixed, not an error, or a duplicate) with a note and their name.
import { esc, fmtDate, safeUrl } from "./render.js";

const STATUS = {
  open: "Open",
  fixed: "Fixed",
  not_an_error: "Not an error",
  duplicate: "Duplicate",
};
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);

function item(r) {
  const src = safeUrl(r.source_url);
  const resolve =
    r.status === "open"
      ? `<form class="stack-xs" method="post" action="/admin/corrections/${r.id}/">
  <label class="field"><span class="field-label">What was done</span><select class="input" name="status" required>
    <option value="fixed">Fixed on the page</option><option value="not_an_error">Not an error (the page matches its source)</option><option value="duplicate">Duplicate of another report</option>
  </select></label>
  <label class="field"><span class="field-label">Note (what changed, or why not)</span><input class="input" name="note" required maxlength="500"></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="reviewer" required autocomplete="name" maxlength="80"></label>
  <button class="btn" type="submit">Record</button>
</form>`
      : `<p class="small">${esc(STATUS[r.status] || r.status)}${r.resolved_by ? ` · ${esc(r.resolved_by)}` : ""}${r.resolved_at ? `, ${esc(fmtDate(String(r.resolved_at).slice(0, 10)))}` : ""}${r.note ? `: ${esc(r.note)}` : ""}</p>`;
  return `
<article class="card stack-sm" id="c${r.id}">
  <p class="list-meta">#${r.id} · ${esc(fmtDate(String(r.created_at).slice(0, 10)))} · <a class="inline-link" href="${esc(r.page)}">${esc(r.page)}</a></p>
  <p class="small">${esc(r.what).replace(/\n/g, "<br>")}</p>
  ${src ? `<p class="small">Source given: <a class="inline-link" href="${esc(src)}" target="_blank" rel="noopener noreferrer">${esc(src)}</a> ↗</p>` : '<p class="small secondary">No source given.</p>'}
  ${resolve}
</article>`;
}

/** The list: every open report, then the 50 most recently resolved. */
export async function correctionsList(db, { done = "", error = "" } = {}) {
  const open = (await db.prepare("SELECT * FROM corrections WHERE status = 'open' ORDER BY created_at, id").all()).results;
  const resolved = (await db.prepare("SELECT * FROM corrections WHERE status <> 'open' ORDER BY resolved_at DESC, id DESC LIMIT 50").all()).results;
  const main = `
<header class="page-head"><h1>Error reports</h1><p class="subtitle">From "Report an error" in every page's footer. No name or email is kept with them.</p></header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<section class="stack-sm"><h2 class="label">Open (${open.length})</h2>${open.map(item).join("") || '<p class="secondary small">No open reports.</p>'}</section>
<section class="stack-sm"><h2 class="label">Recently resolved</h2>${resolved.map(item).join("") || '<p class="secondary small">None yet.</p>'}</section>`;
  return { title: "Error reports", main };
}

/** Record what was done with report `id`. Returns {done} or {error}. */
export async function correctionChange(db, id, form) {
  const status = String(form.get("status") || "");
  const note = clean(form.get("note"), 500);
  const reviewer = clean(form.get("reviewer"), 80);
  if (!STATUS[status] || status === "open") return { error: "Choose what was done." };
  if (!note) return { error: "Add a note: what changed, or why it isn't an error." };
  if (!reviewer) return { error: "Enter your name." };
  const r = await db
    .prepare("UPDATE corrections SET status = ?, note = ?, resolved_by = ?, resolved_at = datetime('now') WHERE id = ? AND status = 'open'")
    .bind(status, note, reviewer, id)
    .run();
  if (!r.meta || !r.meta.changes) return { error: `Report #${id} isn't open.` };
  return { done: `Report #${id}: ${STATUS[status].toLowerCase()}.` };
}
