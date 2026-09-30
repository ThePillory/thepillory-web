// County meetings: Board of Supervisors and Planning Commission agendas from
// the county's IQM2 meeting portal (see ./iqm2.js).
//
// The portal's robots.txt asks for 60 seconds between requests, so every request
// here is paced (IQM2_MIN_INTERVAL_MS) and capped per day (IQM2_DAILY_LIMIT).
// Each day:
//   1. the calendar list (once): every meeting, its status, and its document links,
//      including minutes and video once they're published
//   2. the "RSS" page (once): when each recent agenda was published
//   3. each meeting's own page (the web agenda: items, sections, staff reports,
//      and the agenda link), then, for upcoming meetings, the agenda PDF for how
//      to comment (only sentences copied from the PDF; see ./comment.js)
//
// The calendar list often hides a meeting's Agenda link even when the agenda is
// published, so step 3 doesn't depend on it: it reads the meeting's page for
//   - every meeting in the window that hasn't been read yet, including the last
//     MEETING_BACKFILL_DAYS (30) days, so recent agendas are filled in once
//   - a meeting whose agenda the calendar shows under a new file (re-posted)
//   - a meeting with no agenda yet, once a day: upcoming ones in the next
//     AGENDA_WATCH_DAYS, and past ones in the backfill window. After a meeting
//     the county withdraws its page for a while ("The meeting is not available
//     at this time"); what was saved is kept, and the page is tried again daily.
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
const LOOK_AHEAD_DAYS = 45;
const AGENDA_WATCH_DAYS = 10; // agendas are posted about a week ahead; check these daily until one appears

function options(env) {
  return {
    base: (env.IQM2_BASE || PORTAL).replace(/\/$/, ""),
    pace: {
      intervalMs: parseInt(env.IQM2_MIN_INTERVAL_MS || "60000", 10),
      dailyLimit: parseInt(env.IQM2_DAILY_LIMIT || "12", 10),
    },
    bodies: (env.MEETING_BODIES || DEFAULT_BODIES).split("|").map((s) => s.trim()).filter(Boolean),
    backfillDays: parseInt(env.MEETING_BACKFILL_DAYS || "30", 10),
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
         location = excluded.location,
         -- The list hides links it has shown before, so a missing link keeps the one already saved.
         agenda_url = COALESCE(excluded.agenda_url, meetings.agenda_url),
         packet_url = COALESCE(excluded.packet_url, meetings.packet_url),
         agenda_file_id = COALESCE(excluded.agenda_file_id, meetings.agenda_file_id),
         posted_at = COALESCE(excluded.posted_at, meetings.posted_at),
         first_seen_at = COALESCE(meetings.first_seen_at, excluded.first_seen_at),
         minutes_url = COALESCE(excluded.minutes_url, meetings.minutes_url),
         summary_url = COALESCE(excluded.summary_url, meetings.summary_url),
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
  // A page with no items (agenda not posted yet) never erases items already saved.
  const stmts = parsed.items.length ? [db.prepare("DELETE FROM meeting_items WHERE meeting_id = ?").bind(meetingId)] : [];
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
        `UPDATE meetings SET details_checked_at = datetime('now'), details_file_id = ?, agenda_file_id = COALESCE(?, agenda_file_id),
           agenda_url = COALESCE(?, agenda_url), packet_url = COALESCE(?, packet_url) WHERE id = ?`
      )
      .bind(fileId, parsed.agenda_file_id, parsed.agenda_url, parsed.packet_url, meetingId)
  );
  await db.batch(stmts);
}

export async function agendaPdfText(bytes) {
  const pdf = await getDocumentProxy(new Uint8Array(bytes));
  const { text } = await extractText(pdf, { mergePages: false });
  return text;
}

export async function syncCountyMeetings(env, db, budget) {
  const { base, pace, bodies, backfillDays } = options(env);
  const fetchText = async (url, label) => (await budget.paced(db, "iqm2", pace, url, {}, label)).text();
  const today = pacificNow().slice(0, 10);
  const notes = [];
  let calendarCount = 0;
  let agendasRead = 0;
  let notPosted = 0;
  let withdrawn = 0;
  let pdfsRead = 0;
  const summary = () =>
    `${calendarCount} meeting(s) from the calendar, ${agendasRead} agenda(s) and ${pdfsRead} agenda PDF(s) read` +
    (notPosted ? `, ${notPosted} meeting page(s) with no agenda posted yet` : "") +
    (withdrawn ? `, ${withdrawn} meeting page(s) the county has withdrawn for now ("not available at this time"; tried again tomorrow)` : "");
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

    // 3. Meeting pages and agenda PDFs: upcoming meetings first (soonest first), then past ones (latest first).
    const now = `${today}T00:00`;
    const todo = (
      await db
        .prepare(
          `SELECT *, (details_checked_at < datetime('now', '-20 hours')) AS stale FROM meetings
           WHERE source = 'iqm2' AND status != 'cancelled' AND starts_at BETWEEN ? AND ?
             AND (details_checked_at IS NULL
                  OR (details_checked_at < datetime('now', '-20 hours')
                      AND ((agenda_file_id IS NOT NULL AND details_file_id IS NOT agenda_file_id)
                           OR (starts_at <= ? AND details_file_id IS NULL)))
                  OR (starts_at >= ? AND agenda_url IS NOT NULL AND COALESCE(details_file_id, agenda_file_id) IS NOT NULL
                      AND pdf_file_id IS NOT COALESCE(details_file_id, agenda_file_id)))
           ORDER BY starts_at < ?, CASE WHEN starts_at >= ? THEN starts_at END, starts_at DESC LIMIT 30`
        )
        .bind(
          `${addDays(today, -backfillDays)}T00:00`,
          `${addDays(today, LOOK_AHEAD_DAYS)}T23:59`,
          `${addDays(today, AGENDA_WATCH_DAYS)}T23:59`,
          now,
          now,
          now
        )
        .all()
    ).results;
    for (const m of todo) {
      const upcoming = m.starts_at >= now;
      let fileId = m.details_file_id || m.agenda_file_id;
      let agendaUrl = m.agenda_url;
      // At most once a day per meeting, whatever the page said last time.
      const needsPage =
        !m.details_checked_at || (m.stale && (!m.details_file_id || (m.agenda_file_id && m.details_file_id !== m.agenda_file_id)));
      if (needsPage) {
        const parsed = parseMeeting(await fetchText(m.source_url, `meeting page ${m.id}`), base);
        if (parsed.unavailable) {
          // Keep everything saved; only note when the page was tried.
          await db.prepare("UPDATE meetings SET details_checked_at = datetime('now') WHERE id = ?").bind(m.id).run();
          withdrawn += 1;
        } else {
          // A web agenda without an agenda file link still counts as read.
          fileId = parsed.agenda_file_id || m.agenda_file_id || (parsed.items.length ? "web" : null);
          agendaUrl = parsed.agenda_url || agendaUrl;
          await saveItems(db, m.id, fileId, parsed);
          if (parsed.items.length) agendasRead += 1;
          else notPosted += 1;
        }
      }
      // How to comment matters only before the meeting.
      if (upcoming && agendaUrl && fileId && m.pdf_file_id !== fileId) {
        const res = await budget.paced(db, "iqm2", pace, agendaUrl, {}, `agenda PDF ${m.id}`);
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
          .bind(info.comment_text, info.comment_deadline_text, info.online_url, fileId, m.id)
          .run();
        pdfsRead += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return {
      status: "partial",
      message: `${summary()}; ${err.message}`,
    };
  }
  const tail = notes.length ? `; ${notes.join("; ")}` : "";
  if (!calendarCount && !agendasRead && !notPosted && !withdrawn && !pdfsRead) return { status: "skipped", message: `calendar already read today; no new agendas${tail}` };
  return { status: "ok", message: `${summary()}${tail}` };
}
