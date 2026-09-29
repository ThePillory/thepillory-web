// Meetings (county agendas from the county portal, state hearings from Open
// States) for Home, the calendar, and meeting pages. Everything shown comes
// from D1 rows that carry a source URL. Agenda summaries are AI drafts and are
// always labeled; issue links show only once approved.
import { esc, safeUrl } from "./render.js";
import { deadlineLabel } from "../../workers/sync/src/meetings/comment.js";
import { pacificNow, addDays } from "../../workers/sync/src/meetings/time.js";
import { FLAG_LABELS } from "../../workers/sync/src/analysis/agenda-check.js";

export { pacificNow, addDays, FLAG_LABELS };

export const LEVEL_LABEL = { county: "County", state: "State", federal: "Federal" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** "2026-10-13T09:00" -> {day: "Tue, Oct 13", time: "9:00 AM", month: "October 2026"} */
export function when(startsAt) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startsAt || "");
  if (!m) return { day: esc(startsAt || ""), time: "", month: "" };
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], 12));
  const h = +m[4];
  const time = h === 0 && m[5] === "00" ? "" : `${h % 12 || 12}:${m[5]} ${h < 12 ? "AM" : "PM"}`;
  return {
    day: `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`,
    long: `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS_LONG[d.getUTCMonth()]} ${d.getUTCDate()}, ${m[1]}`,
    time,
    month: `${MONTHS_LONG[d.getUTCMonth()]} ${m[1]}`,
  };
}

export function meetingHref(id) {
  return `/meetings/${encodeURIComponent(id)}/`;
}

function tableMissing(err) {
  return /no such table/i.test(String(err && err.message));
}

/** Meetings between two local times, soonest first. Empty if the tables don't exist yet. */
export async function listMeetings(db, { from, to, level = null, limit = 100, order = "ASC" }) {
  try {
    const { results } = await db
      .prepare(
        `SELECT * FROM meetings WHERE starts_at >= ? AND starts_at <= ? AND (? IS NULL OR level = ?)
         ORDER BY starts_at ${order === "DESC" ? "DESC" : "ASC"} LIMIT ?`
      )
      .bind(from, to, level, level, limit)
      .all();
    return results;
  } catch (err) {
    if (tableMissing(err)) return [];
    throw err;
  }
}

/** Current (not rejected) agenda summaries for these meetings: {meeting_id: {...row, items: [...]}} */
export async function summariesFor(db, ids) {
  if (!ids.length) return {};
  try {
    const { results } = await db
      .prepare(`SELECT * FROM agenda_summaries WHERE current = 1 AND status != 'rejected' AND meeting_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    return Object.fromEntries(results.map((r) => [r.meeting_id, { ...r, items: JSON.parse(r.items || "[]") }]));
  } catch (err) {
    if (tableMissing(err)) return {};
    throw err;
  }
}

/** Approved issue links for these meetings. */
export async function approvedLinks(db, ids) {
  if (!ids.length) return [];
  try {
    const { results } = await db
      .prepare(`SELECT * FROM item_issue_links WHERE status = 'approved' AND meeting_id IN (${ids.map(() => "?").join(",")})`)
      .bind(...ids)
      .all();
    return results;
  } catch (err) {
    if (tableMissing(err)) return [];
    throw err;
  }
}

/** Flag chips for a summary: each flag once, with how many items carry it. */
export function flagChips(summary) {
  if (!summary) return "";
  const counts = {};
  for (const it of summary.items || []) for (const f of it.flags || []) counts[f] = (counts[f] || 0) + 1;
  return Object.entries(counts)
    .map(([f, n]) => `<span class="chip chip--flag">${esc(FLAG_LABELS[f] || f)}${n > 1 ? ` · ${n}` : ""}</span>`)
    .join("");
}

/** The comment deadline in a few words, or null. Only from the agenda's own plain wording. */
export function shortDeadline(m) {
  const d = deadlineLabel(m.comment_deadline_text, m.starts_at);
  return d ? `Written comments by ${d.label}` : null;
}

/** A compact meeting card (Home, calendar). */
export function meetingCard(m, summary) {
  const w = when(m.starts_at);
  const deadline = shortDeadline(m);
  const chips = flagChips(summary);
  const status = m.status === "cancelled" ? '<span class="chip chip--gray">Cancelled</span>' : "";
  const note =
    m.status === "cancelled"
      ? ""
      : deadline
        ? `<p class="deadline">${esc(deadline)}</p>`
        : m.level === "state"
          ? `<p class="small secondary">${esc(participantsText(m) || "Legislative hearing")}</p>`
          : m.agenda_url
            ? '<p class="small secondary">Comment deadline: see the agenda</p>'
            : '<p class="small secondary">Agenda not posted yet</p>';
  return `
<a class="card meeting-card" href="${meetingHref(m.id)}" data-level="${esc(m.level)}">
  <p class="label">${esc(LEVEL_LABEL[m.level] || "")} · ${esc(m.meeting_type || "Meeting")} ${status}</p>
  <h3>${esc(m.body)}</h3>
  <p class="meeting-when"><strong>${esc(w.day)}</strong>${w.time ? ` · ${esc(w.time)}` : ""}</p>
  ${note}
  ${chips ? `<div class="chips">${chips}</div>` : ""}
</a>`;
}

export function participantsText(m) {
  let names = [];
  try {
    names = JSON.parse(m.participants || "[]");
  } catch (_) {}
  return names.length ? `With ${names.join(" and ")}` : "";
}

export function sourceHref(u) {
  return safeUrl(u);
}
