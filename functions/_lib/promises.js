// Promises on an official's page: specific, checkable commitments, quoted
// exactly, with date and source; only those a person approved. Each shows its
// status (No action yet, In progress, Kept, Broken) and every change of
// status with its evidence and source. See docs/promises.md.
import { esc, fmtDate, safeUrl } from "./render.js";

export const STATUS = {
  no_action: ["No action yet", "status--gray"],
  in_progress: ["In progress", "status--gray"],
  kept: ["Kept", "status--kept"],
  broken: ["Broken", "status--broken"],
};
export const STATUSES = Object.keys(STATUS);
export const SOURCE_KIND = { press_release: "Press release", address: "Address", minutes: "Meeting minutes", agenda: "Meeting agenda" };

export const statusChip = (s) => `<span class="status ${STATUS[s] ? STATUS[s][1] : "status--gray"}">${esc(STATUS[s] ? STATUS[s][0] : s)}</span>`;
const ext = (url, label) => (safeUrl(url) ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "");

/** Approved promises for one official, newest first, each with its history. */
export async function promisesFor(db, officialId) {
  const { results: rows } = await db
    .prepare("SELECT * FROM promises WHERE official_id = ? AND review = 'approved' ORDER BY made_on DESC, id DESC")
    .bind(officialId)
    .all();
  if (!rows.length) return [];
  const { results: changes } = await db
    .prepare(
      `SELECT * FROM promise_status_changes WHERE promise_id IN (${rows.map(() => "?").join(",")}) ORDER BY evidence_on DESC, recorded_at DESC, id DESC`
    )
    .bind(...rows.map((r) => r.id))
    .all();
  for (const r of rows) r.changes = changes.filter((c) => c.promise_id === r.id);
  return rows;
}

/** The history of one promise: every status change, newest first, then when it was recorded. */
export function historyList(p) {
  const items = p.changes.map(
    (c) => `<li class="promise-change">
  <p class="small">${fmtDate(c.evidence_on)}: ${statusChip(c.from_status)} → ${statusChip(c.to_status)}</p>
  <p class="small">${esc(c.evidence)}</p>
  <p class="hint">${ext(c.source_url, "Evidence source")} · recorded by ${esc(c.recorded_by)}, ${fmtDate(String(c.recorded_at).slice(0, 10))}</p>
</li>`
  );
  items.push(`<li class="promise-change"><p class="small">${fmtDate(String(p.reviewed_at || p.created_at).slice(0, 10))}: recorded as ${statusChip("no_action")}</p></li>`);
  return `<ol class="plain-list promise-history">${items.join("")}</ol>`;
}

export function promiseCard(p) {
  return `<article class="card stack-sm promise">
  <div class="promise-head"><p class="label">${esc(SOURCE_KIND[p.source_kind] || "Source")} · ${fmtDate(p.made_on)}</p>${statusChip(p.status)}</div>
  <blockquote class="promise-quote">“${esc(p.quote)}”</blockquote>
  <p class="small"><strong>What would show it done:</strong> ${esc(p.check_note)}${p.due ? ` <span class="secondary">Deadline as stated: ${esc(p.due)}.</span>` : ""}</p>
  <p class="hint">${ext(p.source_url, p.source_title)}</p>
  <details class="weigh-details"><summary>Status history (${p.changes.length + 1})</summary>${historyList(p)}</details>
  <p class="hint">Reviewed by ${esc(p.reviewed_by || "")}, ${fmtDate(String(p.reviewed_at || "").slice(0, 10))}</p>
</article>`;
}

/** The Promises tab. `rows` is null before the promise tables exist. */
export function promisesTab(o, rows) {
  const intro = `<p class="small secondary">Specific, checkable commitments ${esc(o.name)} made in official statements, quoted exactly, with the date and the source. Each status (No action yet, In progress, Kept, Broken) changes only with evidence and a source, and every change is listed. <a class="inline-link" href="/about/methodology/#promises">How promises are chosen</a></p>`;
  if (!rows || !rows.length) {
    return `${intro}<p class="secondary small">No promises recorded yet. Promises are added only after a person checks each one against its source.</p>`;
  }
  const counts = STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n);
  return `${intro}
<p class="small">${counts.map(([s, n]) => `${statusChip(s)} ${n}`).join(" · ")}</p>
${rows.map(promiseCard).join("")}`;
}
