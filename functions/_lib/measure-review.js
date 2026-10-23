// The ballot measures' "Constitution" sections on /admin/review/measures/
// (routed from functions/admin/[[path]].js; docs/elections.md "The Constitution
// section"). tools/measure_constitution.py drafts them; nothing is public until
// a person approves each measure here, and the measure pages show the sections
// only once every measure of the election is approved, all at once.
//   /admin/review/measures/          every measure: waiting, sent back, approved; progress
//   /admin/review/measures/<election>/<measure>/   one measure's draft: what it changes and the words quoted,
//                                    each provision (keep or drop; edit its line), each court
//                                    record (keep or drop), what the checks removed; approve or send back
// Court records found after approval wait here too ("New court records").
import { esc, fmtDate, safeUrl } from "./render.js";
import { CHANGES, LINE_RULE, lineProblem } from "./measure-constitution.js";

// A key is '<election id>/<measure id>': two path segments, both plain [a-z0-9-].
export const measureReviewHref = (key) => `/admin/review/measures/${key.split("/").map(encodeURIComponent).join("/")}/`;
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
const json = (s, fallback) => {
  try {
    return JSON.parse(s || "") ?? fallback;
  } catch (_) {
    return fallback;
  }
};
const ext = (url, text) => (safeUrl(url) ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)} ↗</a>` : esc(text));

const SECTIONS = [
  ["pending", "Waiting for you", "Drafted by AI and checked in code. Read each one against its sources, then approve it or send it back."],
  ["rejected", "Sent back", "Drafted again by the next run of the \"Draft measure Constitution sections\" workflow (with \"redo\"), with your note."],
  ["approved", "Approved", "Goes live with the others once every measure is approved."],
];

export async function measureReviewList(db, { done = "" } = {}) {
  const { results } = await db.prepare("SELECT measure_key, state, label, changes, status, reviewed_by, reviewed_at, provisions, cases, cases_new, notes FROM measure_constitution ORDER BY measure_key").all();
  const total = await db.prepare("SELECT value FROM sync_state WHERE key = 'measure_constitution_total'").first().catch(() => null);
  const expected = total ? parseInt(total.value, 10) : results.length;
  const approved = results.filter((r) => r.status === "approved").length;
  const live = approved === expected && expected > 0 && results.length >= expected;
  const line = (r) => {
    const meta = [r.state, (CHANGES[r.changes] || {}).short || r.changes, `${json(r.provisions, []).length} provisions`, `${json(r.cases, []).length} court records`,
      json(r.notes, []).length ? `${json(r.notes, []).length} notes from the checks` : "", r.reviewed_by ? `${r.reviewed_by}, ${fmtDate(String(r.reviewed_at || "").slice(0, 10))}` : ""].filter(Boolean).join(" · ");
    return `<a class="compact-row" href="${measureReviewHref(r.measure_key)}"><span class="cr-main"><span class="cr-title">${esc(r.label)}</span><span class="cr-meta">${esc(meta)}</span></span><span class="chev" aria-hidden="true">›</span></a>`;
  };
  const fresh = results.filter((r) => json(r.cases_new, []).length);
  return {
    title: "Ballot measures: the Constitution section",
    main: `<header class="page-head"><h1>Ballot measures: the Constitution section</h1>
<p class="subtitle">What each November 3 measure changes, the constitutional provisions it touches, and court records about it. Facts only: no "aligns" or "may be in tension" panels until after the election.</p></header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
<section class="card stack-xs"><p><strong>${approved} of ${expected}</strong> approved.</p>
<p class="small">${live ? "Every measure is approved: the sections are live on the measure pages." : "Nothing is public yet. The sections go live on every measure page at once, when the last one is approved."}</p></section>
${fresh.length ? `<h2 class="label queue-head">New court records (${fresh.length})</h2><p class="hint">Found after the measure was approved; not public until you add them.</p><div class="card compact-list">${fresh.map(line).join("")}</div>` : ""}
${SECTIONS.map(([status, title, note]) => {
  const rows = results.filter((r) => r.status === status);
  return `<h2 class="label queue-head">${esc(title)} (${rows.length})</h2><p class="hint">${esc(note)}</p>${rows.length ? `<div class="card compact-list">${rows.map(line).join("")}</div>` : '<p class="small secondary">None.</p>'}`;
}).join("")}
${results.length < expected ? `<p class="small secondary">${expected - results.length} measure(s) not drafted yet.</p>` : ""}`,
  };
}

export async function measureReviewItem(db, key, { error = "", done = "", form = null } = {}) {
  const r = await db.prepare("SELECT * FROM measure_constitution WHERE measure_key = ?").bind(key).first();
  if (!r) return null;
  const provisions = json(r.provisions, []);
  const cases = json(r.cases, []);
  const fresh = json(r.cases_new, []);
  const notes = json(r.notes, []);
  const { results: history } = await db.prepare("SELECT version, action, by_whom, at FROM measure_constitution_history WHERE measure_key = ? ORDER BY id DESC LIMIT 20").bind(key).all();
  const caseRow = (c, name, i, checked = true) => `<li class="stack-xs"><label class="check"><input type="checkbox" name="${name}" value="${i}"${checked ? " checked" : ""} /> <span><strong>${esc(c.name)}</strong></span></label>
    <p class="small secondary">${esc([c.court, c.docket, c.filed ? `filed ${fmtDate(c.filed)}` : ""].filter(Boolean).join(" · "))} · ${ext(c.url, "CourtListener")}</p></li>`;
  const changes = CHANGES[r.changes] || { long: r.changes };
  const main = `<p><a class="inline-link" href="/admin/review/measures/">← Every measure</a></p>
<header class="page-head stack-xs"><p class="label">${esc(r.state)} · ${esc(r.status)} · version ${r.version}</p><h1>${esc(r.label)}</h1>
<p class="small"><a class="inline-link" href="/elections/${esc(r.election_id)}/measure/${esc(r.measure_id)}/">The measure's page</a></p></header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${notes.length ? `<section class="card stack-xs"><h2 class="label">What the checks removed or flagged</h2><ul class="small">${notes.map((n) => `<li>${esc(n)}</li>`).join("")}</ul></section>` : ""}
<form method="post" class="stack">
<section class="card stack-sm"><h2 class="label">1. What it changes</h2>
  <p><strong>${esc(changes.long)}</strong></p>
  ${r.changes_quote ? `<blockquote class="quote">${esc(r.changes_quote)}</blockquote>` : '<p class="small secondary">No words quoted: check the official text, and send it back if it should say.</p>'}
  <p class="small">Source: ${ext(r.changes_source_url, r.changes_source)}</p>
</section>
<section class="card stack-sm"><h2 class="label">2. Constitutional provisions it touches (${provisions.length})</h2>
  ${provisions.length ? `<ol class="stack">${provisions.map((p, i) => `<li class="stack-xs">
    <label class="check"><input type="checkbox" name="keep" value="${i}" checked /> <span><strong>${esc(p.label)}</strong> · ${ext(p.url, "full text")}</span></label>
    ${p.quote ? `<blockquote class="constitution-text small">${esc(p.quote)}${p.cut ? " …" : ""}</blockquote>` : '<p class="hint">Linked to the state\'s official text (not quoted until the state\'s constitution is loaded).</p>'}
    <label class="field"><span class="label">How it's involved</span><input class="input" name="line-${i}" maxlength="200" value="${esc((form && form[`line-${i}`]) || p.line)}" /></label>
  </li>`).join("")}</ol><p class="hint">Untick a provision to leave it out. ${esc(LINE_RULE)}</p>` : '<p class="small secondary">None: the official text cites no constitutional provision the checks could confirm.</p>'}
</section>
<section class="card stack-sm"><h2 class="label">3. Legal challenges (${cases.length})</h2>
  ${cases.length ? `<ul class="plain-list stack-sm">${cases.map((c, i) => caseRow(c, "case", i)).join("")}</ul><p class="hint">Court records on CourtListener that mention the measure (searched ${esc(fmtDate(String(r.cases_checked_at || "").slice(0, 10)))}). Untick any that isn't about this measure.</p>` : `<p class="small secondary">None found on CourtListener (searched ${esc(fmtDate(String(r.cases_checked_at || "").slice(0, 10)))}).</p>`}
  ${fresh.length ? `<h3 class="label">New since approval</h3><ul class="plain-list stack-sm">${fresh.map((c, i) => caseRow(c, "new", i, false)).join("")}</ul>` : ""}
</section>
<section class="card stack-sm">
  <label class="field"><span class="label">Your name (shown as "Reviewed by")</span><input class="input" name="reviewer" maxlength="80" required value="${esc((form && form.reviewer) || r.reviewed_by || "")}" /></label>
  <label class="field"><span class="label">Note (required to send it back)</span><textarea class="input" name="note" rows="3" maxlength="600">${esc((form && form.note) || "")}</textarea></label>
  <label class="check"><input type="checkbox" name="checked" value="1" /> <span>I've read every quote against its source.</span></label>
  <div class="row-wrap">
    ${r.status !== "approved" ? '<button class="btn btn--primary" name="action" value="approve">Approve</button>' : ""}
    ${fresh.length ? '<button class="btn" name="action" value="add_cases">Add the ticked new court records</button>' : ""}
    <button class="btn" name="action" value="reject">Send back</button>
  </div>
</section>
</form>
<section class="stack-xs"><h2 class="label">History</h2><ul class="small secondary">${history.map((h) => `<li>v${h.version} · ${esc(h.action)} · ${esc(h.by_whom || "")} · ${esc(h.at)}</li>`).join("")}</ul></section>`;
  return { title: `Review: ${r.label}`, main };
}

export async function measureReviewChange(db, key, rawForm, email) {
  const action = String(rawForm.get("action") || "");
  const form = { reviewer: clean(rawForm.get("reviewer"), 80), note: clean(rawForm.get("note"), 600) };
  for (const [k, v] of rawForm.entries()) if (k.startsWith("line-")) form[k] = clean(v, 200);
  const r = await db.prepare("SELECT * FROM measure_constitution WHERE measure_key = ?").bind(key).first();
  if (!r) return { error: "No such measure.", form };
  if (!form.reviewer) return { error: "Enter your name.", form };
  const history = (version, act, snapshot) =>
    db.prepare("INSERT INTO measure_constitution_history (measure_key, version, snapshot, action, by_whom) VALUES (?, ?, ?, ?, ?)").bind(key, version, JSON.stringify(snapshot), act, `${form.reviewer}${email ? ` <${email}>` : ""}`);
  if (action === "reject") {
    if (!form.note) return { error: "Say what needs changing: it goes to the next draft.", form };
    await db.batch([
      db.prepare("UPDATE measure_constitution SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = datetime('now'), updated_at = datetime('now') WHERE measure_key = ?").bind(form.note, form.reviewer, key),
      history(r.version, "rejected", { note: form.note }),
    ]);
    return { done: "Sent back. The next run of the workflow with \"redo\" drafts it again with your note." };
  }
  if (action === "add_cases") {
    const fresh = json(r.cases_new, []);
    const picked = new Set(rawForm.getAll("new").map(Number));
    const add = fresh.filter((_, i) => picked.has(i));
    await db.batch([
      db.prepare("UPDATE measure_constitution SET cases = ?, cases_new = '[]', updated_at = datetime('now') WHERE measure_key = ?").bind(JSON.stringify([...json(r.cases, []), ...add]), key),
      history(r.version, "cases", { added: add, dismissed: fresh.filter((_, i) => !picked.has(i)) }),
    ]);
    return { done: `${add.length} court record(s) added${fresh.length - add.length ? `, ${fresh.length - add.length} dismissed` : ""}.` };
  }
  if (action !== "approve") return { error: "Unknown action.", form };
  if (rawForm.get("checked") !== "1") return { error: "Tick the box once you've read every quote against its source.", form };
  const keep = new Set(rawForm.getAll("keep").map(Number));
  const provisions = [];
  for (const [i, p] of json(r.provisions, []).entries()) {
    if (!keep.has(i)) continue;
    const line = form[`line-${i}`] || p.line;
    const problem = lineProblem(line);
    if (problem) return { error: `${p.label}: ${problem}`, form };
    provisions.push({ ...p, line });
  }
  const keepCases = new Set(rawForm.getAll("case").map(Number));
  const cases = json(r.cases, []).filter((_, i) => keepCases.has(i));
  const version = r.version + 1;
  await db.batch([
    db.prepare("UPDATE measure_constitution SET provisions = ?, cases = ?, status = 'approved', reviewed_by = ?, reviewed_at = datetime('now'), review_note = NULL, version = ?, updated_at = datetime('now') WHERE measure_key = ?")
      .bind(JSON.stringify(provisions), JSON.stringify(cases), form.reviewer, version, key),
    history(version, "approved", { provisions, cases }),
  ]);
  return { done: `Approved by ${form.reviewer}.` };
}
