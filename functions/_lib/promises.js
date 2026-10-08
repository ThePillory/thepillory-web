// Promises on an official's page: specific, checkable commitments, quoted
// exactly, with date and source; only those a person approved. Each shows its
// status (No action yet, In progress, Kept, Broken) and every change of
// status with its evidence and source. See docs/promises.md.
import { tagsFor, topicChips } from "./topics.js";
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

/**
 * "In their own words": the excerpt from each listed Issues or Priorities page,
 * and statements the official's office submitted. Empty before migration 0014.
 */
export async function ownWordsFor(db, officialId) {
  try {
    const [pages, statements] = await Promise.all([
      db
        .prepare(
          `SELECT url, kind, title, excerpt, excerpt_at, excerpt_by FROM promise_pages
           WHERE official_id = ? AND excerpt IS NOT NULL AND excerpt_by IS NOT 'hidden' ORDER BY kind, title`
        )
        .bind(officialId)
        .all(),
      db
        .prepare("SELECT id, title, body, submitted_on, source_url FROM official_statements WHERE official_id = ? AND removed_at IS NULL ORDER BY submitted_on DESC, id DESC LIMIT 10")
        .bind(officialId)
        .all(),
    ]);
    const topics = await tagsFor(db, "platform", pages.results.map((x) => x.url));
    for (const x of pages.results) x.topics = topics.get(x.url) || [];
    return { pages: pages.results, statements: statements.results };
  } catch (err) {
    if (/no such (table|column)/i.test(String(err && err.message))) return { pages: [], statements: [] };
    throw err;
  }
}

const SITE = { campaign_site: "Campaign website", office_site: "Office website" };
const paragraphs = (text) =>
  String(text || "")
    .split(/\n\s*\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .map((x) => `<p>${esc(x).replace(/\n/g, "<br>")}</p>`)
    .join("");

function excerptCard(o, x) {
  const by = String(x.excerpt_by || "");
  return `<article class="card stack-sm own-words">
  <p class="label">${esc(SITE[x.kind] || "Website")} · as of ${fmtDate(String(x.excerpt_at || "").slice(0, 10))}</p>
  <blockquote class="promise-quote">“${esc(x.excerpt)}”</blockquote>
  ${topicChips(x.topics, null, { label: false })}
  <p class="hint">${ext(x.url, x.title)}</p>
  <p class="hint">${by.startsWith("person:") ? `Excerpt chosen by ${esc(by.slice(7))}` : "Excerpt picked automatically and checked word for word against the page"}; refreshed monthly. The whole page is at the link.</p>
</article>`;
}

function statementCard(o, st) {
  return `<article class="card stack-sm own-words">
  <p class="label">Submitted by the official · ${fmtDate(st.submitted_on)}</p>
  ${st.title ? `<h3 class="statement-title">${esc(st.title)}</h3>` : ""}
  <div class="statement-body small">${paragraphs(st.body)}</div>
  ${st.source_url ? `<p class="hint">${ext(st.source_url, "Also published here")}</p>` : ""}
  <p class="hint">Sent to ThePillory by ${esc(o.name)}'s office and shown as submitted, without edits.</p>
</article>`;
}

/**
 * The Platform tab: "In their own words" at the top, then "Commitments
 * tracked" once at least one promise has been approved. `rows` is the
 * approved promises (null before the promise tables exist); `own` is
 * ownWordsFor's result.
 */
export function platformTab(o, rows, own) {
  const promises = rows || [];
  const pages = (own && own.pages) || [];
  const statements = (own && own.statements) || [];
  const how = '<a class="inline-link" href="/about/methodology/#promises">How the platform is recorded</a>';
  if (!promises.length && !pages.length && !statements.length) {
    return `<div class="card empty-state stack-sm">
  <p><strong>No platform recorded yet</strong></p>
  <p class="small">This tab shows ${esc(o.name)}'s platform in two parts. <strong>In their own words:</strong> a short excerpt, word for word, from their own Issues or Priorities page, with a link to the whole page, and statements their office submits, labeled as such. <strong>Commitments tracked:</strong> specific, checkable promises (signing a named bill, funding a program at a stated amount, finishing a project by a date), each quoted with its date and source and checked by a person, with a status that changes only with evidence.</p>
  ${how}
</div>`;
  }
  const ownSection = `<section class="stack-sm">
  <h2 class="label">In their own words</h2>
  ${
    pages.length || statements.length
      ? `${statements.map((st) => statementCard(o, st)).join("")}${pages.map((x) => excerptCard(o, x)).join("")}`
      : `<p class="secondary small">No excerpt from ${esc(o.name)}'s own Issues page, and no statement from their office, yet.</p>`
  }
</section>`;
  if (!promises.length) return `${ownSection}${how}`;
  const counts = STATUSES.map((s) => [s, promises.filter((r) => r.status === s).length]).filter(([, n]) => n);
  return `${ownSection}
<section class="stack-sm">
  <h2 class="label">Commitments tracked</h2>
  <p class="small secondary">Specific, checkable commitments ${esc(o.name)} made in public, quoted exactly, with the date and the source. Each status (No action yet, In progress, Kept, Broken) changes only with evidence and a source, and every change is listed.</p>
  <p class="small">${counts.map(([s, n]) => `${statusChip(s)} ${n}`).join(" · ")}</p>
  ${promises.map(promiseCard).join("")}
</section>
${how}`;
}
