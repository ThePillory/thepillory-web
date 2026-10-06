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
export const SOURCE_KIND = {
  press_release: "Press release",
  address: "Address",
  minutes: "Meeting minutes",
  agenda: "Meeting agenda",
  meeting_video: "Meeting video",
  interview: "Interview",
  campaign_site: "Campaign website",
  office_site: "Office website",
};

/** "1:02:03" → seconds, or null. */
export function timeSeconds(t) {
  const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})$/.exec(String(t || "").trim());
  if (!m || +m[3] > 59 || (m[1] != null && +m[2] > 59)) return null;
  return (+(m[1] || 0)) * 3600 + +m[2] * 60 + +m[3];
}

/** The source link, starting at the stated time for a YouTube video (other players are linked as they are). */
export function sourceHref(url, time) {
  const s = timeSeconds(time);
  if (s == null || !safeUrl(url)) return url;
  try {
    const u = new URL(url);
    if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return url;
    u.searchParams.set("t", `${s}s`);
    return u.toString();
  } catch {
    return url;
  }
}

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
  <div class="promise-head"><p class="label">${esc(SOURCE_KIND[p.source_kind] || "Source")} · ${/_site$/.test(p.source_kind) ? "as of " : ""}${fmtDate(p.made_on)}</p>${statusChip(p.status)}</div>
  <blockquote class="promise-quote">“${esc(p.quote)}”</blockquote>
  <p class="small"><strong>What would show it done:</strong> ${esc(p.check_note)}${p.due ? ` <span class="secondary">Deadline as stated: ${esc(p.due)}.</span>` : ""}</p>
  <p class="hint">${ext(sourceHref(p.source_url, p.source_time), p.source_title)}${p.source_time ? ` <span class="secondary">at ${esc(p.source_time)}</span>` : ""}</p>
  <details class="weigh-details"><summary>Status history (${p.changes.length + 1})</summary>${historyList(p)}</details>
  <p class="hint">Reviewed by ${esc(p.reviewed_by || "")}, ${fmtDate(String(p.reviewed_at || "").slice(0, 10))}</p>
</article>`;
}

/** The Promises tab. `rows` is null before the promise tables exist. */
export function promisesTab(o, rows) {
  const how = '<a class="inline-link" href="/about/methodology/#promises">How promises are chosen</a>';
  if (!rows || !rows.length) {
    return `<div class="card empty-state stack-sm">
  <p><strong>No promises tracked yet</strong></p>
  <p class="small">A promise here is a specific, checkable commitment ${esc(o.name)} made in public: something they said they would do, such as signing a named bill, funding a program at a stated amount, or finishing a project by a date, quoted word for word with the date and a link to the source. Statements of values or general goals ("keep families safe") aren't promises.</p>
  <p class="small">Promises come from official statements, addresses, meetings and the official's own Issues pages. Each one is checked against its source by a person before it appears, and its status (No action yet, In progress, Kept, Broken) changes only with evidence.</p>
  ${how}
</div>`;
  }
  const intro = `<p class="small secondary">Specific, checkable commitments ${esc(o.name)} made in public, quoted exactly, with the date and the source. Each status (No action yet, In progress, Kept, Broken) changes only with evidence and a source, and every change is listed.</p>${how}`;
  const counts = STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length]).filter(([, n]) => n);
  return `${intro}
<p class="small">${counts.map(([s, n]) => `${statusChip(s)} ${n}`).join(" · ")}</p>
${rows.map(promiseCard).join("")}`;
}
