// Promises on an official's page: specific, checkable commitments, quoted
// exactly, with date and source. Published once they pass the code checks
// ("AI-identified, auto-checked") or when a person adds or confirms one
// ("Reviewed by"). Each shows its status (No action yet, In progress, Kept,
// Broken) and every change of status with its evidence and source; a reader
// can flag one ("Something wrong?"), and it shows "Under review" until a
// person resolves the flag. See docs/promises.md.
import { tagsFor, topicChips } from "./topics.js";
import { esc, fmtDate, safeUrl } from "./render.js";
import { turnstileReady, turnstileWidget } from "./turnstile.js";

export const METHOD_URL = "/about/methodology/#promises";
export const AI_LABEL = "AI-identified, auto-checked";
export const FLAG_REASONS = [
  ["not_a_promise", "Not a specific promise"],
  ["misquoted", "Misquoted or out of context"],
  ["wrong_status", "Wrong status"],
  ["unfair", "Unfair wording"],
  ["other", "Other"],
];
export const FLAG_MESSAGES = {
  "promise-flag": "Thank you. Your report went to the review queue, and the promise is marked \"Under review\" until a person checks it (this page can take a few minutes to update).",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "You've reached today's limit for reports. Please try again tomorrow.",
  closed: "This form isn't open yet.",
  invalid: "Something was missing from the form. Please try again.",
};

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

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/**
 * Published promises for one official (auto-checked or confirmed by a person),
 * newest first, each with its history and whether a reader flag is open.
 * Before migration 0019 only approved ones exist.
 */
export async function promisesFor(db, officialId) {
  let rows;
  try {
    rows = (await db.prepare("SELECT * FROM promises WHERE official_id = ? AND review IN ('auto', 'approved') ORDER BY made_on DESC, id DESC").bind(officialId).all()).results;
  } catch (err) {
    if (!missing(err)) throw err;
    rows = (await db.prepare("SELECT * FROM promises WHERE official_id = ? AND review = 'approved' ORDER BY made_on DESC, id DESC").bind(officialId).all()).results;
  }
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const marks = ids.map(() => "?").join(",");
  const { results: changes } = await db
    .prepare(`SELECT * FROM promise_status_changes WHERE promise_id IN (${marks}) ORDER BY evidence_on DESC, recorded_at DESC, id DESC`)
    .bind(...ids)
    .all();
  let flagged = new Set();
  try {
    const { results } = await db.prepare(`SELECT DISTINCT promise_id FROM promise_flags WHERE status = 'open' AND promise_id IN (${marks})`).bind(...ids).all();
    flagged = new Set(results.map((r) => r.promise_id));
  } catch (err) {
    if (!missing(err)) throw err;
  }
  for (const r of rows) {
    r.changes = changes.filter((c) => c.promise_id === r.id);
    r.underReview = flagged.has(r.id);
  }
  return rows;
}

/** The history of one promise: every status change, newest first, then when it was recorded. */
export function historyList(p) {
  const items = p.changes.map(
    (c) => `<li class="promise-change">
  <p class="small">${fmtDate(c.evidence_on)}: ${statusChip(c.from_status)} → ${statusChip(c.to_status)}</p>
  ${c.evidence_quote ? `<blockquote class="promise-quote promise-quote--small">“${esc(c.evidence_quote)}”</blockquote>` : ""}
  <p class="small">${esc(c.evidence)}</p>
  <p class="hint">${ext(c.source_url, "Evidence source")} · ${c.auto ? `<a class="inline-link" href="${METHOD_URL}">${esc(AI_LABEL)}</a>, recorded` : `recorded by ${esc(c.recorded_by)},`} ${fmtDate(String(c.recorded_at).slice(0, 10))}</p>
</li>`
  );
  items.push(`<li class="promise-change"><p class="small">${fmtDate(String(p.published_at || p.reviewed_at || p.created_at).slice(0, 10))}: recorded as ${statusChip("no_action")}</p></li>`);
  return `<ol class="plain-list promise-history">${items.join("")}</ol>`;
}

/** Who checked it: "AI-identified, auto-checked" (linked to the methodology) or "Reviewed by [name], [date]". */
export function checkedLine(p) {
  if (p.review === "auto") return `<a class="inline-link" href="${METHOD_URL}">${esc(AI_LABEL)}</a>, ${fmtDate(String(p.published_at || p.created_at).slice(0, 10))}`;
  return `Reviewed by ${esc(p.reviewed_by || "")}, ${fmtDate(String(p.reviewed_at || "").slice(0, 10))}`;
}

/** "Something wrong?" under a promise: no account, Turnstile and a daily limit. */
export function promiseFlagForm(env, slug, p) {
  const ready = env && turnstileReady(env);
  return `<details class="reader-form">
  <summary>Something wrong?</summary>
  ${
    ready
      ? `<form method="post" action="/reps/${esc(slug)}/promises/${p.id}/flag" class="stack-sm">
    <fieldset class="stack-sm bare">
      <legend class="small">What's the problem?</legend>
      ${FLAG_REASONS.map(([v, label], i) => `<label class="radio-row"><input type="radio" name="reason" value="${v}"${i === 0 ? " required" : ""}> ${label}</label>`).join("")}
    </fieldset>
    <label class="field"><span class="field-label">Explain (optional)</span><textarea class="textarea" name="note" rows="3" maxlength="1000"></textarea></label>
    <p class="hint">No account needed. A person reads every report; the promise stays up, marked "Under review", until then.</p>
    ${turnstileWidget(env)}
    <button class="btn" type="submit">Send report</button>
  </form>`
      : '<p class="small secondary">This form isn\'t open yet.</p>'
  }
</details>`;
}

export function promiseCard(p, { env = null, slug = "" } = {}) {
  return `<article class="card stack-sm promise" id="promise-${p.id}">
  <div class="promise-head"><p class="label">${esc(SOURCE_KIND[p.source_kind] || "Source")} · ${/_site$/.test(p.source_kind) ? "as of " : ""}${fmtDate(p.made_on)}</p>${p.underReview ? '<span class="status status--gray">Under review</span>' : ""}${statusChip(p.status)}</div>
  <blockquote class="promise-quote">“${esc(p.quote)}”</blockquote>
  <p class="small"><strong>What would show it done:</strong> ${esc(p.check_note)}${p.due ? ` <span class="secondary">Deadline as stated: ${esc(p.due)}.</span>` : ""}</p>
  <p class="hint">${ext(sourceHref(p.source_url, p.source_time), p.source_title)}${p.source_time ? ` <span class="secondary">at ${esc(p.source_time)}</span>` : ""}</p>
  <details class="weigh-details"><summary>Status history (${p.changes.length + 1})</summary>${historyList(p)}</details>
  <p class="hint">${checkedLine(p)}${p.underReview ? " · A reader flagged this promise; a person is checking it." : ""}</p>
  ${slug ? promiseFlagForm(env, slug, p) : ""}
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
    // Pages found or listed whose excerpt hasn't been picked yet, and the last search of the official's site.
    let waiting = [];
    let check = null;
    try {
      waiting = (await db.prepare("SELECT url, kind, title FROM promise_pages WHERE official_id = ? AND excerpt IS NULL AND (excerpt_by IS NULL OR excerpt_by NOT IN ('hidden', 'none')) ORDER BY kind").bind(officialId).all()).results;
      check = await db.prepare("SELECT site_url, result, page_url, checked_at FROM issues_page_checks WHERE official_id = ? AND site_kind = 'office_site'").bind(officialId).first();
    } catch (err) {
      if (!/no such (table|column)/i.test(String(err && err.message))) throw err;
    }
    return { pages: pages.results, statements: statements.results, waiting, check };
  } catch (err) {
    if (/no such (table|column)/i.test(String(err && err.message))) return { pages: [], statements: [], waiting: [], check: null };
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
 * What the search of the official's own website found, when there's no
 * excerpt to show: an issues page waiting to be read, "No issues page found"
 * with a link to their site, or no website on file. "" when not searched yet.
 */
function siteNote(o, own) {
  const waiting = (own && own.waiting) || [];
  const check = own && own.check;
  if (waiting.length) {
    return `<div class="card stack-sm"><p><strong>Issues page found</strong></p>${waiting
      .map((x) => `<p class="small">${ext(x.url, x.title || "Issues")}</p>`)
      .join("")}<p class="hint">A short excerpt, word for word, appears here after the page is read in the next daily update.</p></div>`;
  }
  if (!check) return "";
  if (check.result === "error") {
    const link = safeUrl(check.site_url || o.website);
    return `<div class="card stack-sm"><p><strong>No issues page found yet</strong></p><p class="small">ThePillory couldn't read ${esc(o.name)}'s website${link ? ` (${ext(link, new URL(link).hostname.replace(/^www\./, ""))})` : ""} on ${fmtDate(String(check.checked_at).slice(0, 10))}. It tries again in a few days.</p></div>`;
  }
  if (check.result === "none") {
    const link = safeUrl(check.site_url || o.website);
    return `<div class="card stack-sm"><p><strong>No issues page found</strong></p><p class="small">${esc(o.name)}'s website${link ? ` (${ext(link, new URL(link).hostname.replace(/^www\./, ""))})` : ""} has no page titled Issues, Priorities or Platform that ThePillory could find, as of ${fmtDate(String(check.checked_at).slice(0, 10))}. It's searched again every few months.</p></div>`;
  }
  if (check.result === "no_website") {
    return `<div class="card stack-sm"><p><strong>No issues page found</strong></p><p class="small">There's no website on file for ${esc(o.name)}.</p></div>`;
  }
  return "";
}

/**
 * The Platform tab: "In their own words" at the top, then "Commitments
 * tracked" once at least one promise is published. `rows` is the published
 * promises (null before the promise tables exist); `own` is ownWordsFor's
 * result; `env` opens the "Something wrong?" forms, `url` shows a form's result.
 */
export function platformTab(o, rows, own, { env = null, url = null } = {}) {
  const promises = rows || [];
  const pages = (own && own.pages) || [];
  const statements = (own && own.statements) || [];
  const how = '<a class="inline-link" href="/about/methodology/#promises">How the platform is recorded</a>';
  const site = siteNote(o, own);
  if (!promises.length && !pages.length && !statements.length && site) {
    return `${site}
<p class="hint">This tab shows ${esc(o.name)}'s platform in their own words (a short excerpt, word for word, from their own Issues or Priorities page, and statements their office submits) and specific commitments, checked word for word against their source, with a status that changes only with evidence. ${how}</p>`;
  }
  if (!promises.length && !pages.length && !statements.length) {
    return `<div class="card empty-state stack-sm">
  <p><strong>No platform recorded yet</strong></p>
  <p class="small">This tab shows ${esc(o.name)}'s platform in two parts. <strong>In their own words:</strong> a short excerpt, word for word, from their own Issues or Priorities page, with a link to the whole page, and statements their office submits, labeled as such. <strong>Commitments tracked:</strong> specific, checkable promises (signing a named bill, funding a program at a stated amount, finishing a project by a date), each quoted with its date and source and checked in code before it's published, with a status that changes only with evidence.</p>
  ${how}
</div>`;
  }
  const ownSection = `<section class="stack-sm">
  <h2 class="label">In their own words</h2>
  ${
    pages.length || statements.length
      ? `${statements.map((st) => statementCard(o, st)).join("")}${pages.map((x) => excerptCard(o, x)).join("")}`
      : site || `<p class="secondary small">No excerpt from ${esc(o.name)}'s own Issues page, and no statement from their office, yet.</p>`
  }
</section>`;
  if (!promises.length) return `${ownSection}${how}`;
  const counts = STATUSES.map((s) => [s, promises.filter((r) => r.status === s).length]).filter(([, n]) => n);
  const sentKey = url && url.searchParams.get("sent");
  const errKey = url && url.searchParams.get("error");
  const banner = `${FLAG_MESSAGES[sentKey] ? `<p class="banner" role="status">${esc(FLAG_MESSAGES[sentKey])}</p>` : ""}${FLAG_MESSAGES[errKey] ? `<p class="banner banner--error" role="alert">${esc(FLAG_MESSAGES[errKey])}</p>` : ""}`;
  return `${ownSection}
<section class="stack-sm" id="commitments">
  <h2 class="label">Commitments tracked</h2>
  ${banner}
  <p class="small secondary">Specific, checkable commitments ${esc(o.name)} made in public (an action, a vote or a deadline), quoted exactly, with the date and the source. Each starts at No action yet; its status changes only with evidence and a source, and every change is listed. Promises marked <a class="inline-link" href="${METHOD_URL}">${esc(AI_LABEL)}</a> were found by AI and checked in code, word for word against the source; a person checks a sample and every one a reader flags.</p>
  <p class="small">${counts.map(([s, n]) => `${statusChip(s)} ${n}`).join(" · ")}</p>
  ${promises.map((p) => promiseCard(p, { env, slug: o.slug })).join("")}
</section>
${how}`;
}
