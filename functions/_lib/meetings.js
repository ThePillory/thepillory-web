// Meetings (county agendas from the county portal, state hearings from Open
// States) for Home, the calendar, and meeting pages. Everything shown comes
// from D1 rows that carry a source URL. Agenda summaries are AI drafts and are
// always labeled; issue links show only once approved.
import { inChunks } from "./data.js";
import { esc, safeUrl } from "./render.js";
import { deadlineLabel } from "../../workers/sync/src/meetings/comment.js";
import { pacificNow, addDays } from "../../workers/sync/src/meetings/time.js";
import { FLAG_LABELS, rankFlags } from "../../workers/sync/src/analysis/agenda-check.js";

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
    const results = await inChunks(ids, async (chunk) =>
      (
        await db
          .prepare(`SELECT * FROM agenda_summaries WHERE current = 1 AND status != 'rejected' AND meeting_id IN (${chunk.map(() => "?").join(",")})`)
          .bind(...chunk)
          .all()
      ).results);
    // At most five flagged items per agenda, ranked by impact. New drafts are
    // saved that way; this also caps summaries drafted before the limit.
    const agenda = await inChunks(ids, async (chunk) =>
      (
        await db
          .prepare(`SELECT meeting_id, item_key, section_kind FROM meeting_items WHERE meeting_id IN (${chunk.map(() => "?").join(",")}) ORDER BY meeting_id, sort`)
          .bind(...chunk)
          .all()
      ).results);
    return Object.fromEntries(
      results.map((r) => [r.meeting_id, { ...r, items: rankFlags(JSON.parse(r.items || "[]"), agenda.filter((a) => a.meeting_id === r.meeting_id)).items }])
    );
  } catch (err) {
    if (tableMissing(err)) return {};
    throw err;
  }
}

/** Items the summary flagged, and each flag once (in the order first seen). */
export function flagSummary(summary) {
  const flags = [];
  let items = 0;
  for (const it of (summary && summary.items) || []) {
    if (!(it.flags || []).length) continue;
    items += 1;
    for (const f of it.flags) if (!flags.includes(f)) flags.push(f);
  }
  return { items, flags };
}

/** "3 items flagged" plus one quiet chip per flag. */
export function flagChips(summary) {
  const { items, flags } = flagSummary(summary);
  if (!items) return "";
  return (
    `<span class="chip chip--light chip--sm">${items} item${items === 1 ? "" : "s"} flagged</span>` +
    flags.map((f) => `<span class="chip chip--quiet chip--sm">${esc(FLAG_LABELS[f] || f)}</span>`).join("")
  );
}

/** The written-comment deadline, or null. Only from the agenda's own plain wording. */
export function deadlineParts(m) {
  return deadlineLabel(m.comment_deadline_text, m.starts_at);
}

export function shortDeadline(m) {
  const d = deadlineParts(m);
  return d ? `Written comments by ${d.label}` : null;
}

/** The town from a meeting location ("Board Chambers, 891 Mountain Ranch Road, San Andreas" -> "San Andreas"). */
export function placeName(location) {
  const parts = String(location || "")
    .split(",")
    .map((x) => x.trim())
    .filter((x) => x && !/^(CA|California)?\s*\d{5}(-\d{4})?$/i.test(x) && !/^(CA|California)$/i.test(x));
  return parts.length ? parts[parts.length - 1] : "";
}

/** A compact meeting card (Home, calendar). */
export function meetingCard(m, summary) {
  const w = when(m.starts_at);
  const d = deadlineParts(m);
  const state = m.level === "state";
  const right =
    m.status === "cancelled"
      ? '<span class="card-top-note">Cancelled</span>'
      : d
        ? `<span class="card-top-note card-top-note--due">Comments due ${esc(d.day)}</span>`
        : !state && !m.agenda_url
          ? '<span class="card-top-note">Agenda not posted yet</span>'
          : "";
  const meta = [w.day, w.time, state ? participantsText(m) : placeName(m.location)].filter(Boolean).map(esc).join(" · ");
  const chips = flagChips(summary);
  return `
<a class="card meeting-card${state ? " meeting-card--hearing" : ""}" href="${meetingHref(m.id)}" data-level="${esc(m.level)}">
  <div class="card-top"><span class="label">${esc(LEVEL_LABEL[m.level] || "")} · ${state ? "Hearing" : "Meeting"}</span>${right}</div>
  <h3>${esc(m.body)}</h3>
  <p class="small secondary">${meta}</p>
  ${chips ? `<div class="chips chips--tight">${chips}</div>` : ""}
</a>`;
}

/** "[Name] sits on this committee" for our state legislators on a hearing. */
export function participantsText(m) {
  let names = [];
  try {
    names = JSON.parse(m.participants || "[]");
  } catch (_) {}
  if (!names.length) return "";
  return `${names.join(" and ")} ${names.length === 1 ? "sits" : "sit"} on this committee`;
}

export function sourceHref(u) {
  return safeUrl(u);
}
