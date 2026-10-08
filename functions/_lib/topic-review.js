// Correcting topic tags on /admin/review/topics/ (routed from functions/admin/[[path]].js):
//   /admin/review/topics/                     the latest tagged items, by kind, and "find an item"
//   /admin/review/topics/<kind>/?id=<item>    one item: its topics, reasons and history; the correction form
// A correction keeps the history: tags it drops are marked removed (who, when,
// why), the person's tags are added under their name, and the item is locked so
// the AI never re-tags it. Pure checks are tested in test/topics.test.mjs.
import { esc, fmtDate } from "./render.js";
import { TOPICS, TOPIC, topicName } from "../../workers/sync/src/topics/list.js";
import { KIND_LABEL, MAX_TOPICS } from "../../workers/sync/src/topics/tag.js";
import { wordingProblems } from "../../workers/sync/src/promises/check.js";

export const KINDS = { bill: "Bills", meeting_item: "County agenda items", executive_action: "Executive actions", platform: "Platform excerpts" };
const clean = (v, max) => String(v == null ? "" : v).replace(/\s+/g, " ").trim().slice(0, max);
export const reviewHref = (kind, id) => `/admin/review/topics/${kind}/?id=${encodeURIComponent(id)}`;

/** A ThePillory link (or a bill id) as the item it points to: { kind, id }, or null. */
export function itemFromLink(text) {
  const s = clean(text, 2000);
  let path = s;
  try {
    const u = new URL(s);
    path = u.pathname + u.hash;
  } catch (_) {
    /* not a URL: a path or an id */
  }
  let m = /\/laws\/bills\/([^/#?]+)/.exec(path);
  if (m) return { kind: "bill", id: decodeURIComponent(m[1]) };
  m = /\/meetings\/([^/#?]+)\/?#item-([^#?/]+)/.exec(path);
  if (m) return { kind: "meeting_item", id: `${decodeURIComponent(m[1])}/${decodeURIComponent(m[2])}` };
  if (/^(us|ca)-[a-z0-9-]+$/i.test(s)) return { kind: "bill", id: s };
  return null;
}

/**
 * Check a correction. Returns { error, topics, note, reviewer }: topics are the
 * slugs ticked (none is allowed: procedure or ceremony), at most three.
 */
export function checkCorrection(form) {
  const ticked = [].concat(form.topics || []).map((t) => clean(t, 40));
  const topics = [...new Set(ticked)].filter((t) => TOPIC[t]);
  const note = clean(form.note, 240);
  const reviewer = clean(form.reviewer, 80);
  const words = wordingProblems(note, { strict: false });
  const error = ticked.some((t) => !TOPIC[t]) ? "Choose topics from the list."
    : topics.length > MAX_TOPICS ? `Choose at most ${MAX_TOPICS} topics: the ones the item is mainly about.`
    : !note ? "Say briefly why (shown as the reason for the topics you set)."
    : words.length ? `Use neutral wording in the reason: ${words.join("; ")}.`
    : !reviewer ? "Enter your name: it's shown with the topics you set."
    : "";
  return { error, topics, note, reviewer };
}

/** What an item is, for the review page: { title, meta, href } (null if it no longer exists). */
export async function itemInfo(db, kind, id) {
  if (kind === "bill") {
    const b = await db.prepare("SELECT bill_number, title, level FROM bills WHERE id = ?").bind(id).first();
    return b && { title: `${b.bill_number}: ${b.title}`, meta: b.level === "federal" ? "Congress" : "California Legislature", href: `/laws/bills/${encodeURIComponent(id)}/` };
  }
  if (kind === "meeting_item") {
    const [mid, key] = [id.slice(0, id.lastIndexOf("/")), id.slice(id.lastIndexOf("/") + 1)];
    const r = await db.prepare("SELECT mi.number, mi.title, m.body, m.starts_at FROM meeting_items mi JOIN meetings m ON m.id = mi.meeting_id WHERE mi.meeting_id = ? AND mi.item_key = ?").bind(mid, key).first();
    return r && { title: `${r.number ? `${r.number}. ` : ""}${r.title}`, meta: `${r.body} · ${fmtDate(r.starts_at)}`, href: `/meetings/${encodeURIComponent(mid)}/#item-${encodeURIComponent(key)}` };
  }
  if (kind === "executive_action") {
    const r = await db.prepare("SELECT a.title, a.signed_on, a.published_on, o.name, o.slug FROM executive_actions a JOIN officials o ON o.id = a.official_id WHERE a.id = ?").bind(id).first();
    return r && { title: r.title, meta: `${r.name} · ${fmtDate(r.signed_on || r.published_on)}`, href: `/reps/${encodeURIComponent(r.slug)}/#more` };
  }
  if (kind === "platform") {
    const r = await db.prepare("SELECT p.excerpt, p.title, o.name, o.slug FROM promise_pages p JOIN officials o ON o.id = p.official_id WHERE p.url = ?").bind(id).first();
    return r && { title: `“${r.excerpt || "(no excerpt)"}”`, meta: `${r.name} · ${r.title}`, href: `/reps/${encodeURIComponent(r.slug)}/#platform` };
  }
  return null;
}

async function tagRows(db, kind, ids) {
  if (!ids.length) return [];
  return (
    await db
      .prepare(`SELECT * FROM topic_tags WHERE item_kind = ? AND item_id IN (${ids.map(() => "?").join(",")}) ORDER BY id`)
      .bind(kind, ...ids)
      .all()
  ).results;
}

const byWho = (t) => (String(t.tagged_by).startsWith("person:") ? `set by ${esc(t.tagged_by.slice(7))}` : "AI");

function tagLine(t) {
  return `<li class="small"><strong>${esc(topicName(t.topic))}</strong> · ${byWho(t)} · ${esc(t.reason)}</li>`;
}

/** The list: the latest tagged items of one kind. Returns { title, main }. */
export async function topicReviewList(db, url, { error = "" } = {}) {
  const kind = KINDS[url.searchParams.get("kind")] ? url.searchParams.get("kind") : "meeting_item";
  const runs = (
    await db.prepare("SELECT item_id, tagged_at, model, locked_by FROM topic_runs WHERE item_kind = ? ORDER BY tagged_at DESC, rowid DESC LIMIT 40").bind(kind).all()
  ).results;
  const tags = await tagRows(db, kind, runs.map((r) => r.item_id));
  const counts = (await db.prepare("SELECT item_kind, COUNT(*) AS n FROM topic_runs GROUP BY item_kind").all()).results;
  const activity = (await db.prepare("SELECT status, message, finished_at FROM sync_log WHERE step = 'topics' ORDER BY id DESC LIMIT 5").all()).results;
  const n = Object.fromEntries(counts.map((r) => [r.item_kind, r.n]));
  const rows = [];
  for (const r of runs) {
    const info = await itemInfo(db, kind, r.item_id);
    const live = tags.filter((t) => t.item_id === r.item_id && !t.removed_at);
    rows.push(`<a class="list-row link-row" href="${reviewHref(kind, r.item_id)}">
  <div class="stack-xs"><div class="list-title">${esc(info ? info.title : r.item_id)}</div>
  <div class="list-meta">${esc(info ? info.meta : "no longer on the site")} · tagged ${fmtDate(String(r.tagged_at).slice(0, 10))}${r.locked_by ? ` · corrected by ${esc(r.locked_by)}` : ""}</div>
  <div class="chips chips--tight">${live.length ? live.map((t) => `<span class="chip chip--sm chip--light">${esc(topicName(t.topic))}</span>`).join("") : '<span class="small secondary">No topic</span>'}</div></div>
  <span class="row-end"><span class="chev" aria-hidden="true">›</span></span>
</a>`);
  }
  const main = `
<header class="page-head stack-xs">
  <h1>Topic tags</h1>
  <p class="subtitle">Each bill, county agenda item, executive action and Platform excerpt gets up to ${MAX_TOPICS} topics from an AI model, with a short reason. Correct any of them here: the old tags stay in the history, your tags show your name, and the AI won't re-tag that item.</p>
</header>
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<form class="card stack-sm" method="get" action="/admin/review/topics/find/">
  <label class="field"><span class="field-label">Find an item: paste a bill page link, an agenda item link (…/meetings/…#item-…), or a bill id</span><input class="input" name="link" required></label>
  <button class="btn" type="submit">Open</button>
</form>
<nav class="pill-filter" aria-label="Kind">${Object.entries(KINDS)
    .map(([k, label]) => `<a class="toggle" href="/admin/review/topics/?kind=${k}"${k === kind ? ' aria-current="true"' : ""}>${esc(label)} · ${n[k] || 0}</a>`)
    .join("")}</nav>
<section class="card">${rows.join("") || '<p class="small secondary">Nothing tagged yet. Tagging runs after each sync, up to its daily limit.</p>'}</section>
<details class="weigh-details"><summary>Recent activity</summary><section class="card stack-sm">${
    activity.length
      ? `<ul class="plain-list activity-list">${activity.map((a) => `<li class="small"><span class="secondary">${esc(String(a.finished_at || "").slice(0, 16).replace("T", " "))} · ${esc(a.status)}</span><br>${esc(String(a.message || "").slice(0, 400))}</li>`).join("")}</ul>`
      : '<p class="small secondary">No tagging runs yet.</p>'
  }</section></details>`;
  return { title: "Topic tags", main };
}

/** One item: its tags, history and the correction form. Returns { title, main } or null. */
export async function topicReviewItem(db, env, kind, id, { error = "", done = "", form = null } = {}) {
  if (!KINDS[kind] || !id) return null;
  const info = await itemInfo(db, kind, id);
  const tags = await tagRows(db, kind, [id]);
  const run = await db.prepare("SELECT * FROM topic_runs WHERE item_kind = ? AND item_id = ?").bind(kind, id).first();
  if (!info && !tags.length) return null;
  const live = tags.filter((t) => !t.removed_at);
  const removed = tags.filter((t) => t.removed_at);
  const ticked = new Set(form ? form.topics : live.map((t) => t.topic));
  const action = reviewHref(kind, id);
  const main = `
<header class="page-head stack-xs">
  <p class="label">${esc(KIND_LABEL[kind])}</p>
  <h1 class="statement-title">${esc(info ? info.title : id)}</h1>
  <p class="secondary small">${esc(info ? info.meta : "No longer on the site")}${info ? ` · <a class="inline-link" href="${esc(info.href)}">Open it on the site</a>` : ""}</p>
</header>
${done ? `<p class="banner" role="status">${esc(done)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
<section class="card stack-sm">
  <h2 class="label">Topics now</h2>
  ${live.length ? `<ul class="plain-list stack-xs">${live.map(tagLine).join("")}</ul>` : '<p class="small secondary">No topic.</p>'}
  <p class="hint">${run ? `Tagged ${fmtDate(String(run.tagged_at).slice(0, 10))}${run.model ? ` by ${esc(run.model)}` : ""}${run.locked_by ? `; corrected by ${esc(run.locked_by)} (the AI won't re-tag it)` : ""}.` : "Not tagged by the AI yet."}</p>
</section>
<form class="card stack-sm" method="post" action="${esc(action)}">
  <h2 class="label">Correct the topics</h2>
  <p class="small">Tick the topics this item is mainly about (at most ${MAX_TOPICS}), or none if it's only procedure or ceremony.</p>
  <div class="stack-xs">${TOPICS.map(
    (t) => `<label class="check-row"><input type="checkbox" name="topics" value="${t.slug}"${ticked.has(t.slug) ? " checked" : ""}> <span>${esc(t.name)}</span></label>`
  ).join("")}</div>
  <label class="field"><span class="field-label">Why (shown as the reason for these topics)</span><input class="input" name="note" required maxlength="240" value="${esc((form && form.note) || "")}" placeholder="The item approves a water main replacement."></label>
  <label class="field"><span class="field-label">Your name</span><input class="input" name="reviewer" required autocomplete="name" value="${esc((form && form.reviewer) || env.REVIEWER_NAME || "")}"></label>
  <button class="btn btn--primary" type="submit">Save the topics</button>
</form>
${removed.length ? `<section class="card stack-sm"><h2 class="label">History</h2><ul class="plain-list stack-xs">${removed
    .map((t) => `<li class="small"><strong>${esc(topicName(t.topic))}</strong> · ${byWho(t)} · ${esc(t.reason)} · removed ${fmtDate(String(t.removed_at).slice(0, 10))}${t.removed_by ? ` by ${esc(String(t.removed_by).replace(/^person:/, ""))}` : ""}${t.removed_note ? `: ${esc(t.removed_note)}` : ""}</li>`)
    .join("")}</ul></section>` : ""}
<p class="small"><a class="inline-link" href="/admin/review/topics/?kind=${kind}">All ${esc(KINDS[kind].toLowerCase())}</a></p>`;
  return { title: "Topic tags", main };
}

/** Save a correction. Returns { error, form } or { done }. */
export async function topicReviewChange(db, kind, id, rawForm) {
  const r = checkCorrection(rawForm);
  if (r.error) return { error: r.error, form: r };
  const live = (await tagRows(db, kind, [id])).filter((t) => !t.removed_at);
  const keep = new Set(r.topics);
  const who = `person:${r.reviewer}`;
  const stmts = [];
  for (const t of live) {
    if (!keep.has(t.topic)) {
      stmts.push(db.prepare("UPDATE topic_tags SET removed_at = datetime('now'), removed_by = ?, removed_note = ? WHERE id = ?").bind(who, r.note, t.id));
    }
  }
  const have = new Set(live.map((t) => t.topic));
  for (const t of r.topics) {
    if (have.has(t)) {
      // Confirmed: the person's reason and name replace the AI's (the AI's row is kept as history).
      const old = live.find((x) => x.topic === t);
      if (!String(old.tagged_by).startsWith("person:")) {
        stmts.push(db.prepare("UPDATE topic_tags SET removed_at = datetime('now'), removed_by = ?, removed_note = 'confirmed by a reviewer' WHERE id = ?").bind(who, old.id));
        stmts.push(db.prepare("INSERT INTO topic_tags (item_kind, item_id, topic, reason, tagged_by) VALUES (?, ?, ?, ?, ?)").bind(kind, id, t, r.note, who));
      }
    } else {
      stmts.push(db.prepare("INSERT INTO topic_tags (item_kind, item_id, topic, reason, tagged_by) VALUES (?, ?, ?, ?, ?)").bind(kind, id, t, r.note, who));
    }
  }
  stmts.push(
    db
      .prepare("INSERT INTO topic_runs (item_kind, item_id, locked_by, locked_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT (item_kind, item_id) DO UPDATE SET locked_by = excluded.locked_by, locked_at = excluded.locked_at")
      .bind(kind, id, r.reviewer)
  );
  await db.batch(stmts);
  return { done: r.topics.length ? `Saved: ${r.topics.map(topicName).join(", ")}. The AI won't re-tag this item.` : "Saved: no topic. The AI won't re-tag this item." };
}
