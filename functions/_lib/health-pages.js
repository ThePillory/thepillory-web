// The source health pages (migration 0034; the sync's source-health step,
// workers/sync/src/health/):
//   /admin/health/          every source green, yellow or red, what failed, and
//                           30 days of history; dead source links with their copies.
//   /about/data-status/     public: each source, what it provides, when it last
//                           updated. No error details.
import { esc, fmtDate } from "./render.js";
import { SOURCES } from "../../workers/sync/src/health/sources.js";
import { savedHref } from "./source-links.js";

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const LABEL = { green: "Healthy", yellow: "Needs a look", red: "Broken", unknown: "Not checked" };

async function rows(db, sql, ...args) {
  try {
    return (await db.prepare(sql).bind(...args).all()).results;
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

/** The latest check of every source, and each source's last 30 days. Null before migration 0034. */
export async function healthData(db) {
  const latest = await rows(db, "SELECT h.* FROM source_health h JOIN (SELECT source, MAX(day) AS day FROM source_health GROUP BY source) m ON m.source = h.source AND m.day = h.day");
  if (latest === null) return null;
  const history = await rows(db, "SELECT day, source, status FROM source_health WHERE day >= date('now', '-30 days') ORDER BY day");
  return { latest: Object.fromEntries(latest.map((r) => [r.source, r])), history: history || [] };
}

const chip = (status) => `<span class="health-chip health-chip--${esc(status)}">${esc(LABEL[status] || status)}</span>`;

function dots(history, id) {
  const mine = history.filter((h) => h.source === id);
  if (!mine.length) return "";
  return `<div class="health-dots" role="img" aria-label="Last ${mine.length} days: ${esc(mine.map((h) => h.status).join(", "))}">${mine
    .map((h) => `<span class="health-dot health-dot--${esc(h.status)}" title="${esc(h.day)}: ${esc(LABEL[h.status] || h.status)}"></span>`)
    .join("")}</div>`;
}

const when = (s) => (s ? fmtDate(String(s).slice(0, 10)) : "never");

export function adminHealthMain(data, dead) {
  if (!data) return '<header class="page-head"><h1>Data sources</h1></header><p class="secondary small">The health check hasn\'t run yet: it runs at the end of the daily sync once migration 0034 is applied.</p>';
  const order = { red: 0, yellow: 1, unknown: 2, green: 3 };
  const list = [...SOURCES].sort((a, b) => (order[(data.latest[a.id] || {}).status || "unknown"] ?? 2) - (order[(data.latest[b.id] || {}).status || "unknown"] ?? 2));
  const counts = SOURCES.reduce((c, s) => {
    const st = (data.latest[s.id] || {}).status || "unknown";
    c[st] = (c[st] || 0) + 1;
    return c;
  }, {});
  const card = (s) => {
    const h = data.latest[s.id] || {};
    let problems = [];
    try {
      problems = JSON.parse(h.problems || "[]");
    } catch (_) {}
    const facts = [
      `Last successful pull: ${when(h.last_ok)}`,
      h.latest ? `newest record: ${when(h.latest)}` : "",
      h.rows != null ? `${Number(h.rows).toLocaleString("en-US")} rows${h.rows_added != null ? ` (${h.rows_added >= 0 ? "+" : ""}${Number(h.rows_added).toLocaleString("en-US")} since the day before)` : ""}` : "",
      h.day ? `checked ${when(h.day)}` : "",
    ].filter(Boolean);
    return `<section class="card stack-sm" id="${esc(s.id)}">
  <div class="health-head"><h2 class="h3">${esc(s.name)}</h2>${chip(h.status || "unknown")}</div>
  <p class="small secondary">${facts.map(esc).join(" · ")}</p>
  ${problems.length ? `<ul class="plain-list small health-problems">${problems.map((p) => `<li><span class="health-chip health-chip--${esc(p.level === "note" ? "unknown" : p.level)}">${esc(p.check)}</span> ${esc(p.text)}</li>`).join("")}</ul>` : ""}
  ${dots(data.history, s.id)}
  <p class="hint">${s.steps ? `Sync steps: ${esc(s.steps.join(", "))}. ` : ""}${s.workflow ? `Workflow: ${esc(s.workflow)}. ` : ""}Expected at least every ${esc(String(s.runDays || "—"))} days.</p>
</section>`;
  };
  const deadList = dead && dead.length
    ? `<section class="card stack-sm" id="dead-links"><h2 class="h3">Source links that no longer open</h2><ul class="plain-list small">${dead
        .map((d) => `<li class="list-row"><span class="list-title"><a class="inline-link" href="${esc(d.url)}" target="_blank" rel="noopener">${esc(d.url.slice(0, 90))}</a></span><span class="list-meta">${esc(d.source || "")} · status ${esc(String(d.status))} · gone since ${esc(when(d.first_dead))}${d.archive_url ? ` · <a class="inline-link" href="${esc(d.archive_url)}" target="_blank" rel="noopener">Archived copy</a>` : ""}${d.copy_key ? ` · <a class="inline-link" href="${esc(savedHref(d.copy_key))}">Saved copy</a>` : ""}${!d.archive_url && !d.copy_key ? " · no copy" : ""}</span></li>`)
        .join("")}</ul></section>`
    : "";
  return `<header class="page-head"><p class="label">Admin</p><h1>Data sources</h1>
<p class="subtitle">${["red", "yellow", "green", "unknown"].filter((k) => counts[k]).map((k) => `${counts[k]} ${LABEL[k].toLowerCase()}`).join(" · ")}</p></header>
${list.map(card).join("")}
${deadList}
<p class="hint">Checked once a day at the end of the sync. Red: no pull in twice the expected time, a failed workflow, no rows, the source gone, or most re-fetched records no longer matching. Yellow: late, older data than expected, far fewer rows than usual, refused requests, missing fields, or some records or links that no longer match or open. An email goes to the alert address on days with yellow or red. <a class="tap" href="/about/data-status/">The public page</a></p>`;
}

export async function deadLinks(db) {
  return (await rows(db, "SELECT url, source, status, first_dead, archive_url, copy_key FROM source_links WHERE dead_checks >= 2 ORDER BY first_dead DESC LIMIT 100")) || [];
}

/** The public page: each source, what it provides, when it last updated. */
export function dataStatusMain(data) {
  const item = (s) => {
    const h = (data && data.latest[s.id]) || {};
    const updated = s.live ? "Looked up live, when you ask" : h.last_ok ? `Last updated ${when(h.last_ok)}` : "Not loaded yet";
    return `<li class="list-row data-status-row"><span class="list-title">${esc(s.name)}</span><span class="list-meta">${esc(s.provides)}</span><span class="list-meta"><strong>${esc(updated)}</strong></span></li>`;
  };
  return `<header class="page-head"><p class="label">About</p><h1>Data status</h1>
<p class="subtitle">Where ThePillory's records come from, and when each source last updated.</p></header>
<section class="card"><ul class="plain-list">${SOURCES.map(item).join("")}</ul></section>
<p class="hint">Each source is checked every day: that it updated on time, that it still answers in the same form, and that records re-read from it still match what's shown here. When an original page disappears, ThePillory links to a copy saved by the Internet Archive or kept by ThePillory. <a class="tap" href="/about/methodology/#data-status">How records are kept current</a></p>`;
}
