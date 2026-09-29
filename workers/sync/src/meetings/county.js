// County meetings: Board of Supervisors and Planning Commission agendas from
// the county's IQM2 meeting portal (see ./iqm2.js).
//
// The portal's robots.txt asks for 60 seconds between requests, so every request
// here is paced (IQM2_MIN_INTERVAL_MS) and capped per day (IQM2_DAILY_LIMIT).
// Each day:
//   1. the calendar list (once): every meeting, its status, and its document links,
//      including minutes and video once they're published
//   2. the "RSS" page (once): when each recent agenda was published
//   3. for upcoming and recent meetings with an agenda: the web agenda (items,
//      sections, staff reports), and the agenda PDF, for how to comment
//      (only sentences copied from the PDF; see ./comment.js)
//
// TODO: after a meeting, read each supervisor's vote on each item from the
// minutes. Minutes are linked (minutes_url) but not parsed yet.
import { extractText, getDocumentProxy } from "unpdf";
import { PORTAL, parseCalendar, parseRss, parseMeeting } from "./iqm2.js";
import { commentInfo } from "./comment.js";
import { getState, setState, isHttp, BudgetExhausted } from "../util.js";
import { pacificNow, addDays } from "./time.js";

const DEFAULT_BODIES = "Board of Supervisors|Planning Commission";
const BODY_SLUGS = { "Board of Supervisors": "board-of-supervisors" };
const LOOK_BACK_DAYS = 14; // re-read agendas of meetings this recent
const LOOK_AHEAD_DAYS = 45;

function options(env) {
  return {
    base: (env.IQM2_BASE || PORTAL).replace(/\/$/, ""),
    pace: {
      intervalMs: parseInt(env.IQM2_MIN_INTERVAL_MS || "60000", 10),
      dailyLimit: parseInt(env.IQM2_DAILY_LIMIT || "12", 10),
    },
    bodies: (env.MEETING_BODIES || DEFAULT_BODIES).split("|").map((s) => s.trim()).filter(Boolean),
  };
}

async function saveMeeting(db, m, postedAt) {
  await db
    .prepare(
      `INSERT INTO meetings (id, level, source, body, body_slug, meeting_type, starts_at, status, location,
         agenda_url, packet_url, agenda_file_id, posted_at, first_seen_at, minutes_url, summary_url, video_url, source_url, updated_at)
       VALUES (?, 'county', 'iqm2', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') END, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, body_slug = excluded.body_slug,
         meeting_type = excluded.meeting_type, starts_at = excluded.starts_at, status = excluded.status,
         location = excluded.location, agenda_url = excluded.agenda_url, packet_url = excluded.packet_url,
         agenda_file_id = excluded.agenda_file_id,
         posted_at = COALESCE(excluded.posted_at, meetings.posted_at),
         first_seen_at = COALESCE(meetings.first_seen_at, excluded.first_seen_at),
         minutes_url = excluded.minutes_url, summary_url = excluded.summary_url,
         video_url = COALESCE(excluded.video_url, meetings.video_url),
         source_url = excluded.source_url, updated_at = excluded.updated_at`
    )
    .bind(
      `iqm2-${m.portal_id}`,
      m.body,
      BODY_SLUGS[m.body] || null,
      m.meeting_type,
      m.starts_at,
      m.status,
      m.location,
      m.agenda_url,
      m.packet_url,
      m.agenda_file_id,
      postedAt || null,
      m.agenda_url,
      m.minutes_url,
      m.summary_url,
      m.video_url,
      m.source_url
    )
    .run();
}

async function saveItems(db, meetingId, fileId, parsed) {
  const stmts = [db.prepare("DELETE FROM meeting_items WHERE meeting_id = ?").bind(meetingId)];
  for (const it of parsed.items) {
    stmts.push(
      db
        .prepare(
          `INSERT OR REPLACE INTO meeting_items (meeting_id, item_key, number, title, section, section_kind, item_url, staff_report_url, attachments, sort)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(meetingId, it.item_key, it.number, it.title, it.section, it.section_kind, it.item_url, it.staff_report_url, JSON.stringify(it.attachments), it.sort)
    );
  }
  stmts.push(
    db
      .prepare(
        "UPDATE meetings SET details_checked_at = datetime('now'), details_file_id = ?, agenda_url = COALESCE(?, agenda_url), packet_url = COALESCE(?, packet_url) WHERE id = ?"
      )
      .bind(fileId, parsed.agenda_url, parsed.packet_url, meetingId)
  );
  await db.batch(stmts);
}

export async function agendaPdfText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

export async function syncCountyMeetings(env, db, budget) {
  const { base, pace, bodies } = options(env);
  const fetchText = async (url, label) => (await budget.paced(db, "iqm2", pace, url, {}, label)).text();
  const today = pacificNow().slice(0, 10);
  const notes = [];
  let calendarCount = 0;
  let agendasRead = 0;
  let pdfsRead = 0;
  try {
    // 1-2. Calendar and publish dates, once a day.
    if ((await getState(db, "iqm2_calendar_day")) !== today) {
      const rows = parseCalendar(await fetchText(`${base}/Citizens/calendar.aspx?View=List`, "meeting calendar"), base);
      let posted = {};
      try {
        posted = parseRss(await fetchText(`${base}/Services/RSS.aspx?Feed=Calendar`, "agenda feed"));
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        notes.push(`publish dates unavailable (${err.message})`);
      }
      for (const m of rows) {
        if (!bodies.includes(m.body) || !m.starts_at || !isHttp(m.source_url)) continue;
        await saveMeeting(db, m, posted[m.portal_id]);
        calendarCount += 1;
      }
      await setState(db, "iqm2_calendar_day", today);
    }

    // 3. Agendas that are new or re-posted, nearest meeting first.
    const from = `${addDays(today, -LOOK_BACK_DAYS)}T00:00`;
    const to = `${addDays(today, LOOK_AHEAD_DAYS)}T23:59`;
    const todo = (
      await db
        .prepare(
          `SELECT * FROM meetings WHERE source = 'iqm2' AND status != 'cancelled' AND agenda_url IS NOT NULL
             AND starts_at BETWEEN ? AND ?
             AND (details_file_id IS NOT agenda_file_id OR pdf_file_id IS NOT agenda_file_id)
           ORDER BY ABS(julianday(starts_at) - julianday(?)) LIMIT 20`
        )
        .bind(from, to, `${today}T12:00`)
        .all()
    ).results;
    for (const m of todo) {
      if (m.details_file_id !== m.agenda_file_id || !m.details_checked_at) {
        const parsed = parseMeeting(await fetchText(m.source_url, `web agenda ${m.id}`), base);
        await saveItems(db, m.id, m.agenda_file_id, parsed);
        agendasRead += 1;
      }
      if (m.pdf_file_id !== m.agenda_file_id) {
        const res = await budget.paced(db, "iqm2", pace, m.agenda_url, {}, `agenda PDF ${m.id}`);
        let info = { comment_text: null, comment_deadline_text: null, online_url: null };
        try {
          info = commentInfo(await agendaPdfText(await res.arrayBuffer()));
        } catch (err) {
          notes.push(`${m.id}: couldn't read the agenda PDF (${err.message})`);
        }
        await db
          .prepare(
            `UPDATE meetings SET comment_text = ?, comment_deadline_text = ?, online_url = COALESCE(?, online_url),
               pdf_checked_at = datetime('now'), pdf_file_id = ? WHERE id = ?`
          )
          .bind(info.comment_text, info.comment_deadline_text, info.online_url, m.agenda_file_id, m.id)
          .run();
        pdfsRead += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return {
      status: "partial",
      message: `${calendarCount} meeting(s) from the calendar, ${agendasRead} agenda(s) and ${pdfsRead} agenda PDF(s) read; ${err.message}`,
    };
  }
  const tail = notes.length ? `; ${notes.join("; ")}` : "";
  if (!calendarCount && !agendasRead && !pdfsRead) return { status: "skipped", message: `calendar already read today; no new agendas${tail}` };
  return { status: "ok", message: `${calendarCount} meeting(s) from the calendar, ${agendasRead} agenda(s) and ${pdfsRead} agenda PDF(s) read${tail}` };
}
