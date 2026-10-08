// Topics on the pages: the chips on bills, meeting items, executive actions and
// Platform excerpts, and what a topic page shows for a place. The list and the
// industry table are in workers/sync/src/topics/list.js; the tags in D1
// (topic_tags, written by the sync's topics step or a reviewer). See docs/topics.md.
//
// A topic page puts records side by side as facts: bills and how a place's reps
// voted, county meeting items, executive actions, what officials' own Issues
// pages say, and campaign money from industries tied to the topic. Nothing on
// it says one caused another.
import { esc, fmtDate, sourceLink } from "./render.js";
import { inChunks } from "./data.js";
import { industryMoney, money, period, cycleOf } from "./funding.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";
import { TOPICS, TOPIC, topicName, industriesFor, INDUSTRY_TOPICS } from "../../workers/sync/src/topics/list.js";

export { TOPICS, TOPIC, topicName, industriesFor, INDUSTRY_TOPICS };

export const METHOD = "/about/methodology/#topics";
export const SIDE_BY_SIDE =
  "These records are about the same topic. They're shown next to each other as facts: nothing here says that one caused another, or why anyone voted, acted or gave as they did.";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/** A topic's page: for a place ({ st, slug }) when known, otherwise the statewide and national page. */
export const topicHref = (slug, place = null) => (place ? `/place/${place.st.toLowerCase()}/${place.slug}/topics/${slug}/` : `/topics/${slug}/`);
export const placeTopicsHref = (place) => `/place/${place.st.toLowerCase()}/${place.slug}/topics/`;

/** Live tags for some items of one kind: Map item_id -> [{ topic, reason, tagged_by }], in the order tagged. */
export async function tagsFor(db, kind, ids) {
  const out = new Map();
  const list = [...new Set((ids || []).filter(Boolean))];
  if (!db || !list.length) return out;
  try {
    const rows = await inChunks(list, async (chunk) =>
      (await db
        .prepare(`SELECT id, item_id, topic, reason, tagged_by FROM topic_tags WHERE item_kind = ? AND removed_at IS NULL AND item_id IN (${chunk.map(() => "?").join(",")})`)
        .bind(kind, ...chunk)
        .all()).results
    );
    for (const r of rows.sort((a, b) => a.id - b.id)) {
      if (!TOPIC[r.topic]) continue;
      if (!out.has(r.item_id)) out.set(r.item_id, []);
      out.get(r.item_id).push(r);
    }
  } catch (err) {
    if (missing(err)) return out;
    throw err;
  }
  return out;
}

/** Topic chips for one item (links to the topic's page, for a place when given). Empty string when untagged. */
export function topicChips(tags, place = null, { label = true } = {}) {
  if (!tags || !tags.length) return "";
  return `<div class="topic-row">${label ? '<span class="label">Topics</span>' : ""}<div class="chips chips--tight">${tags
    .map((t) => `<a class="chip chip--sm chip--topic" href="${topicHref(t.topic, place)}">${esc(topicName(t.topic))}</a>`)
    .join("")}</div></div>`;
}

/** Every topic as a chip (the hub and county pages). */
export function topicGrid(place = null) {
  return `<ul class="plain-list topic-grid">${TOPICS.map((t) => `<li><a class="chip chip--tap chip--topic" href="${topicHref(t.slug, place)}">${esc(t.name)}</a></li>`).join("")}</ul>`;
}

/** How a tag was made, said plainly: "AI-tagged: <reason>" or "Set by <name>". */
export function tagNote(t) {
  if (!t) return "";
  const by = String(t.tagged_by || "");
  return by.startsWith("person:") ? `Topic set by ${by.slice(7)}${t.reason ? `: ${t.reason}` : ""}` : `AI-tagged: ${t.reason}`;
}

// ---------------------------------------------------------------------------
// What a topic page reads. Each is small: by topic through the topic_tags
// index, then by vote and official through primary keys.

/** Bills on the topic with a final-passage vote, newest first, from bill_list. */
export async function topicBills(db, topic, level, limit = 8) {
  const { results } = await db
    .prepare(
      `SELECT bl.bill_id, bl.bill_number, bl.title, bl.level, bl.last_final, bl.final_vote_id, bl.final_result, bl.final_chamber,
              bl.yea, bl.nay, bl.present, bl.not_voting, bl.outcome, t.reason, t.tagged_by
       FROM topic_tags t JOIN bill_list bl ON bl.bill_id = t.item_id
       WHERE t.item_kind = 'bill' AND t.topic = ? AND t.removed_at IS NULL AND bl.level = ? AND bl.final_vote_id IS NOT NULL
       ORDER BY bl.last_final DESC LIMIT ?`
    )
    .bind(topic, level, limit)
    .all();
  return results;
}

/** Positions on these votes by these officials: Map vote_id -> Map official_id -> position. */
export async function positionsFor(db, voteIds, officialIds) {
  const out = new Map();
  if (!voteIds.length || !officialIds.length) return out;
  const { results } = await db
    .prepare(`SELECT vote_id, official_id, position FROM vote_positions WHERE vote_id IN (${voteIds.map(() => "?").join(",")}) AND official_id IN (${officialIds.map(() => "?").join(",")})`)
    .bind(...voteIds, ...officialIds)
    .all();
  for (const r of results) {
    if (!out.has(r.vote_id)) out.set(r.vote_id, new Map());
    out.get(r.vote_id).set(r.official_id, r.position);
  }
  return out;
}

/** County agenda items on the topic: upcoming (from `now`, soonest first) or recent (before `now`, newest first). */
export async function topicMeetingItems(db, topic, now, { upcoming, limit = 8, level = "county" }) {
  const { results } = await db
    .prepare(
      `SELECT mi.meeting_id, mi.item_key, mi.number, mi.title, m.body, m.starts_at, m.status, t.reason, t.tagged_by
       FROM topic_tags t JOIN meeting_items mi ON t.item_id = mi.meeting_id || '/' || mi.item_key JOIN meetings m ON m.id = mi.meeting_id
       WHERE t.item_kind = 'meeting_item' AND t.topic = ? AND t.removed_at IS NULL AND m.level = ? AND m.status != 'cancelled'
         AND m.starts_at ${upcoming ? ">=" : "<"} ?
       ORDER BY m.starts_at ${upcoming ? "ASC" : "DESC"}, mi.sort LIMIT ?`
    )
    .bind(topic, level, now, limit)
    .all();
  return results;
}

/** Executive actions on the topic by these officials (the President, the Governor), newest first. */
export async function topicExecutive(db, topic, officialIds, limit = 6) {
  if (!officialIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT a.id, a.kind, a.number, a.title, a.signed_on, a.published_on, a.source_url, o.name, o.slug, o.office, t.reason, t.tagged_by
       FROM topic_tags t JOIN executive_actions a ON a.id = t.item_id JOIN officials o ON o.id = a.official_id
       WHERE t.item_kind = 'executive_action' AND t.topic = ? AND t.removed_at IS NULL AND a.official_id IN (${officialIds.map(() => "?").join(",")})
       ORDER BY COALESCE(a.signed_on, a.published_on) DESC LIMIT ?`
    )
    .bind(topic, ...officialIds, limit)
    .all();
  return results;
}

/** Excerpts from these officials' own Issues pages tagged with the topic (all officials when ids is null). */
export async function topicPlatform(db, topic, officialIds, limit = 12) {
  if (officialIds && !officialIds.length) return [];
  const { results } = await db
    .prepare(
      `SELECT p.url, p.kind, p.title, p.excerpt, p.excerpt_at, o.name, o.slug, o.office, t.reason, t.tagged_by
       FROM topic_tags t JOIN promise_pages p ON p.url = t.item_id JOIN officials o ON o.id = p.official_id
       WHERE t.item_kind = 'platform' AND t.topic = ? AND t.removed_at IS NULL AND p.excerpt IS NOT NULL AND p.excerpt_by IS NOT 'hidden'
         ${officialIds ? `AND p.official_id IN (${officialIds.map(() => "?").join(",")})` : ""}
       ORDER BY o.name LIMIT ?`
    )
    .bind(topic, ...(officialIds || []), limit)
    .all();
  return results;
}

/**
 * Campaign money from the industries tied to the topic, for these officials:
 * members of Congress from the FEC (this two-year period), California
 * officials from Cal-Access (each one's latest period). [{ official, industry, total, period, source }].
 */
export async function topicMoney(db, topic, { federal = [], state = [] }, today) {
  const industries = industriesFor(topic);
  if (!industries.length) return [];
  const out = [];
  if (federal.length) {
    const cycle = cycleOf(today);
    const m = await industryMoney(db, federal.map((o) => o.id), industries, cycle);
    for (const o of federal) {
      for (const r of (m[o.id] && m[o.id].rows) || []) out.push({ official: o, industry: r.industry, total: (r.pac || 0) + (r.emp || 0), period: period(cycle), source: "Federal Election Commission" });
    }
  }
  if (state.length) {
    try {
      const ids = state.map((o) => o.id);
      const { results } = await db
        .prepare(
          `SELECT i.official_id, i.cycle, i.industry, i.total FROM state_money_industries i
           WHERE i.official_id IN (${ids.map(() => "?").join(",")}) AND i.industry IN (${industries.map(() => "?").join(",")})
             AND i.cycle = (SELECT MAX(c.cycle) FROM state_money_cycles c WHERE c.official_id = i.official_id)`
        )
        .bind(...ids, ...industries)
        .all();
      const byId = new Map(state.map((o) => [o.id, o]));
      for (const r of results) out.push({ official: byId.get(r.official_id), industry: r.industry, total: r.total, period: String(r.cycle).replace("-", "–"), source: "Cal-Access, California Secretary of State" });
    } catch (err) {
      if (!missing(err)) throw err;
    }
  }
  return out.filter((r) => r.official && r.total > 0).sort((a, b) => b.total - a.total);
}

/** How many items carry each topic: { topic: n }. */
export async function topicCounts(db) {
  try {
    const { results } = await db.prepare("SELECT topic, COUNT(*) AS n FROM topic_tags WHERE removed_at IS NULL GROUP BY topic").all();
    return Object.fromEntries(results.map((r) => [r.topic, r.n]));
  } catch (err) {
    if (missing(err)) return {};
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Rendering the sections. Every record shows its source; positions use one
// neutral style whatever they are.

const KIND_NAME = { executive_order: "Executive order", proclamation: "Proclamation", other: "Executive action" };

export function billRows(bills, positions, reps) {
  return bills
    .map((b) => {
      const pos = positions.get(b.final_vote_id) || new Map();
      const voted = reps ? reps.filter((r) => pos.has(r.id)) : [];
      const totals = [b.yea != null ? `Yes ${b.yea}` : "", b.nay != null ? `No ${b.nay}` : ""].filter(Boolean).join(" · ");
      return `<li class="topic-item stack-xs">
  <a class="list-title inline-link" href="/laws/bills/${esc(b.bill_id)}/">${esc(b.bill_number)}: ${esc(b.title)}</a>
  <p class="list-meta">Final-passage vote ${fmtDate(b.last_final)}${b.final_result ? ` · ${esc(b.final_result)}` : ""}${totals ? ` · ${esc(totals)}` : ""}</p>
  ${
    reps === null
      ? ""
      : voted.length
        ? `<ul class="plain-list rep-positions">${voted.map((r) => `<li><a class="inline-link" href="/reps/${esc(r.slug)}/#votes">${esc(r.name)}</a><span class="position">${esc(pos.get(r.id))}</span></li>`).join("")}</ul>`
        : '<p class="hint">None of this place\'s representatives voted on it.</p>'
  }
  <p class="hint">${esc(tagNote(b))}</p>
</li>`;
    })
    .join("");
}

export function meetingRows(items) {
  return items
    .map(
      (it) => `<li class="topic-item stack-xs">
  <a class="list-title inline-link" href="/meetings/${esc(it.meeting_id)}/#item-${esc(it.item_key)}">${it.number ? `${esc(it.number)}. ` : ""}${esc(it.title)}</a>
  <p class="list-meta">${esc(it.body)} · ${fmtDate(it.starts_at)}</p>
  <p class="hint">${esc(tagNote(it))}</p>
</li>`
    )
    .join("");
}

export function executiveRows(actions) {
  return actions
    .map(
      (a) => `<li class="topic-item stack-xs">
  <p class="list-title">${esc(a.title)}</p>
  <p class="list-meta">${esc(a.name)} · ${esc(KIND_NAME[a.kind] || "Executive action")}${a.number ? ` ${esc(a.number)}` : ""} · ${fmtDate(a.signed_on || a.published_on)}</p>
  <p class="hint">${sourceLink(a.source_url)}</p>
  <p class="hint">${esc(tagNote(a))}</p>
</li>`
    )
    .join("");
}

export function platformRows(rows) {
  return rows
    .map(
      (p) => `<li class="topic-item stack-xs">
  <p class="list-meta"><a class="inline-link" href="/reps/${esc(p.slug)}/#platform">${esc(p.name)}</a> · ${esc(p.office)} · ${p.kind === "office_site" ? "office website" : "campaign website"}, as of ${fmtDate(String(p.excerpt_at || "").slice(0, 10))}</p>
  <blockquote class="promise-quote">“${esc(p.excerpt)}”</blockquote>
  <p class="hint">${sourceLink(p.url, p.title || "The whole page")} · ${esc(tagNote(p))}</p>
</li>`
    )
    .join("");
}

export function moneyRows(rows) {
  return rows
    .map(
      (r) => `<li class="money-row"><div class="money-name"><a class="inline-link" href="/reps/${esc(r.official.slug)}/#funding">${esc(r.official.name)}</a><div class="list-meta">${esc(INDUSTRIES[r.industry] || r.industry)} · ${esc(r.period)} · ${esc(r.source)}</div></div><div class="money-amt">${money(r.total)}</div></li>`
    )
    .join("");
}
