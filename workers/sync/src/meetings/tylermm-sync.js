// County meetings from the county's Tyler Meeting Manager (see ./tylermm.js),
// which replaced the IQM2 portal in September 2026.
//
// The server has no robots.txt; requests are still paced (TYLERMM_MIN_INTERVAL_MS,
// 10 s) and capped (TYLERMM_DAILY_LIMIT, 20 a day). Each day:
//   1. the meeting list (once): every Board of Supervisors and Planning Commission
//      meeting from MEETING_BACKFILL_DAYS ago to LOOK_AHEAD_DAYS ahead, with its
//      agenda status, item titles and video
//   2. each posted agenda's PDF, once per posting (again only if the county
//      re-posts it): the items, their sections and attachments, and how to
//      comment (sentences copied from the PDF; see ./comment.js)
// Board of Supervisors: the agenda PDF (about 1 MB). Planning Commission: the
// county posts only the packet, whose first pages are the agenda; it's read only
// if it's under TYLERMM_PDF_MAX_BYTES. Board packets (often 100 MB or more) are
// linked, never downloaded.
//
// A meeting both systems list (September 2026) is kept once: the IQM2 copy is
// dropped unless it already has agenda items, in which case the Tyler copy is
// skipped.
import { API, CALENDAR, MEETING_TYPES, apiDate, parseMeetingList, parseSummaryAgenda, parsePacketAgenda } from "./tylermm.js";
import { openPdf, streamPages, linePages } from "./pdftext.js";
import { commentInfo } from "./comment.js";
import { saveItems } from "./items.js";
import { getState, setState, BudgetExhausted } from "../util.js";
import { pacificNow, addDays } from "./time.js";

const LOOK_AHEAD_DAYS = 45;
const BODY_SLUGS = { "Board of Supervisors": "board-of-supervisors" };

function options(env) {
  const base = (env.TYLERMM_BASE || API).replace(/\/?$/, "/");
  return {
    base,
    pace: {
      intervalMs: parseInt(env.TYLERMM_MIN_INTERVAL_MS || "10000", 10),
      dailyLimit: parseInt(env.TYLERMM_DAILY_LIMIT || "20", 10),
    },
    maxBytes: parseInt(env.TYLERMM_PDF_MAX_BYTES || String(25 * 1024 * 1024), 10),
    bodies: (env.MEETING_BODIES || "Board of Supervisors|Planning Commission").split("|").map((s) => s.trim()).filter(Boolean),
    backfillDays: parseInt(env.MEETING_BACKFILL_DAYS || "30", 10),
  };
}

/** The response body, or null once it passes maxBytes (the rest isn't downloaded). */
async function readCapped(res, maxBytes) {
  const declared = parseInt(res.headers.get("content-length") || "0", 10);
  if (declared > maxBytes) {
    await res.body?.cancel();
    return null;
  }
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

async function saveMeeting(db, m) {
  await db
    .prepare(
      `INSERT INTO meetings (id, level, source, body, body_slug, meeting_type, starts_at, status, location,
         agenda_url, packet_url, agenda_file_id, posted_at, first_seen_at, video_url, source_url, updated_at)
       VALUES (?, 'county', 'tylermm', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? IS NOT NULL THEN datetime('now') END, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, body_slug = excluded.body_slug,
         meeting_type = excluded.meeting_type, starts_at = excluded.starts_at, status = excluded.status,
         location = excluded.location,
         agenda_url = COALESCE(excluded.agenda_url, meetings.agenda_url),
         packet_url = COALESCE(excluded.packet_url, meetings.packet_url),
         agenda_file_id = COALESCE(excluded.agenda_file_id, meetings.agenda_file_id),
         posted_at = COALESCE(excluded.posted_at, meetings.posted_at),
         first_seen_at = COALESCE(meetings.first_seen_at, excluded.first_seen_at),
         video_url = COALESCE(excluded.video_url, meetings.video_url),
         source_url = excluded.source_url, updated_at = excluded.updated_at`
    )
    .bind(
      m.id,
      m.body,
      BODY_SLUGS[m.body] || null,
      m.meeting_type,
      m.starts_at,
      m.status,
      m.location,
      m.agenda_url,
      m.packet_url,
      m.agenda_file_id,
      m.posted_at,
      m.agenda_url,
      m.video_url,
      CALENDAR
    )
    .run();
}

/**
 * The same meeting from the old IQM2 portal (same body, same day). Returns
 * "keep-iqm2" when that copy already has agenda items; otherwise drops it.
 */
async function settleDuplicate(db, m) {
  const dupes = (
    await db
      .prepare(
        `SELECT id, EXISTS (SELECT 1 FROM meeting_items i WHERE i.meeting_id = meetings.id) AS has_items
         FROM meetings WHERE source = 'iqm2' AND body = ? AND substr(starts_at, 1, 10) = ?`
      )
      .bind(m.body, m.starts_at.slice(0, 10))
      .all()
  ).results;
  if (dupes.some((d) => d.has_items)) return "keep-iqm2";
  for (const d of dupes) {
    await db.batch(
      ["agenda_requests", "item_issue_links", "agenda_summary_revisions", "agenda_summaries", "meeting_items"]
        .map((t) => db.prepare(`DELETE FROM ${t} WHERE meeting_id = ?`).bind(d.id))
        .concat(db.prepare("DELETE FROM meetings WHERE id = ?").bind(d.id))
    );
  }
  return dupes.length ? "dropped" : null;
}

export async function syncTylerMeetings(env, db, budget) {
  const { base, pace, maxBytes, bodies, backfillDays } = options(env);
  const today = pacificNow().slice(0, 10);
  const from = addDays(today, -backfillDays);
  const to = addDays(today, LOOK_AHEAD_DAYS);
  const notes = [];
  let listed = 0;
  let dropped = 0;
  let agendasRead = 0;
  const summary = () =>
    `${listed} meeting(s) from Tyler Meeting Manager, ${agendasRead} agenda PDF(s) read` + (dropped ? `, ${dropped} duplicate IQM2 meeting(s) removed` : "");
  try {
    // 1. The meeting list, once a day. Item titles are kept for step 2, which may
    // run in a later round.
    if ((await getState(db, "tylermm_list_day")) !== today) {
      const typeIds = Object.entries(MEETING_TYPES)
        .filter(([, body]) => bodies.includes(body))
        .map(([id]) => parseInt(id, 10));
      const res = await budget.paced(
        db,
        "tylermm",
        pace,
        `${base}meetingInformation/getMeetingInformationByDate`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=UTF-8", Accept: "application/json" },
          body: JSON.stringify({ startDate: apiDate(from), endDate: apiDate(to), meetingTypeIds: typeIds }),
        },
        "Tyler meeting list"
      );
      const titles = {};
      for (const m of parseMeetingList(await res.json(), base)) {
        if (!bodies.includes(m.body)) continue;
        const dupe = await settleDuplicate(db, m);
        if (dupe === "keep-iqm2") continue;
        if (dupe === "dropped") dropped += 1;
        await saveMeeting(db, m);
        if (m.titles.length) titles[m.id] = m.titles;
        listed += 1;
      }
      await setState(db, "tylermm_titles", JSON.stringify(titles));
      await setState(db, "tylermm_list_day", today);
    }

    // 2. Agenda PDFs not read yet in their current posting: upcoming meetings
    // first (soonest first), then past ones (latest first). A PDF that couldn't be
    // read is tried again the next day.
    const now = `${today}T00:00`;
    const todo = (
      await db
        .prepare(
          `SELECT * FROM meetings
           WHERE source = 'tylermm' AND status != 'cancelled' AND agenda_url IS NOT NULL AND agenda_file_id IS NOT NULL
             AND details_file_id IS NOT agenda_file_id AND starts_at BETWEEN ? AND ?
             AND (pdf_checked_at IS NULL OR pdf_checked_at < datetime('now', '-20 hours') OR pdf_file_id IS NOT agenda_file_id)
           ORDER BY starts_at < ?, CASE WHEN starts_at >= ? THEN starts_at END, starts_at DESC LIMIT 20`
        )
        .bind(`${from}T00:00`, `${to}T23:59`, now, now)
        .all()
    ).results;
    const titles = todo.length ? JSON.parse((await getState(db, "tylermm_titles")) || "{}") : {};
    for (const m of todo) {
      const res = await budget.paced(db, "tylermm", pace, m.agenda_url, {}, `agenda PDF ${m.id}`);
      const bytes = await readCapped(res, maxBytes);
      let items = [];
      let info = { comment_text: null, comment_deadline_text: null, online_url: null };
      let ok = false;
      if (!bytes) {
        // Not tried again until the county re-posts it.
        notes.push(`${m.id}: agenda PDF over ${Math.round(maxBytes / 1048576)} MB, linked but not read`);
        await db.prepare("UPDATE meetings SET details_checked_at = datetime('now'), details_file_id = ? WHERE id = ?").bind(m.agenda_file_id, m.id).run();
      } else {
        try {
          const pdf = await openPdf(bytes);
          // A packet's agenda is its first few pages; the staff reports follow.
          const pages = await streamPages(pdf, m.packet_url ? 40 : 8);
          // How to comment is read from lines rebuilt by position: the plain text
          // of the Board's first page comes out shuffled.
          const head = await linePages(pdf, 2);
          info = commentInfo(head);
          items = m.packet_url ? parseSummaryAgenda(pages, titles[m.id] || []) : parsePacketAgenda(pages);
          ok = true;
        } catch (err) {
          notes.push(`${m.id}: couldn't read the agenda PDF (${err.message})`);
        }
      }
      if (ok) {
        await saveItems(db, m.id, m.agenda_file_id, { items, agenda_file_id: null, agenda_url: null, packet_url: null });
        if (items.length) agendasRead += 1;
        else notes.push(`${m.id}: no items found in the agenda PDF`);
      }
      await db
        .prepare(
          `UPDATE meetings SET comment_text = COALESCE(?, comment_text), comment_deadline_text = COALESCE(?, comment_deadline_text),
             online_url = COALESCE(?, online_url), pdf_checked_at = datetime('now'), pdf_file_id = ? WHERE id = ?`
        )
        .bind(info.comment_text, info.comment_deadline_text, info.online_url, ok ? m.agenda_file_id : null, m.id)
        .run();
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary()}; ${err.message}` };
  }
  const tail = notes.length ? `; ${notes.join("; ")}` : "";
  if (!listed && !agendasRead) return { status: notes.length ? "ok" : "skipped", message: `meeting list already read today; no new agendas${tail}` };
  return { status: "ok", message: `${summary()}${tail}` };
}
