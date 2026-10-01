// Parsers for the county's Tyler Meeting Manager (TMM), which replaced the IQM2
// portal in September 2026. Pure functions only (no network, no PDF library), so
// they can be tested with saved responses.
//
// The public calendar is an Angular app over a JSON API (no login):
//   POST meetingInformation/getMeetingInformationByDate
//        {"startDate":"MM/DD/YYYY","endDate":"MM/DD/YYYY","meetingTypeIds":[5,11]}
//        every meeting in the range, with its agenda status and item titles
//   GET  meetingInformation/Agenda/false/<agendaId>   the agenda (Board of Supervisors)
//   GET  meetingInformation/Agenda/true/<agendaId>    the full packet; for the Planning
//        Commission this is the only form, and its first pages are the agenda
//
// What the JSON doesn't give reliably (sections, each item's text, attachments),
// comes from the agenda PDF's text: see parseSummaryAgenda (Board of Supervisors)
// and parseNumberedAgenda (Planning Commission). Nothing is inferred: item text
// is copied from the agenda.
import { sectionKind } from "./iqm2.js";

export const API = "https://calaverascountycatmmapp.tylerhost.net/tylermmcalendar9579prod/";
export const CALENDAR = "https://calaverascountycatmmapp.tylerhost.net/9579prod/tylermm/calendar/";
// Meeting type IDs from meetingType/getMeetingTypes.
export const MEETING_TYPES = { 5: "Board of Supervisors", 11: "Planning Commission" };
const POSTED = 5; // agendaStatus once the agenda is published

const MONTHS = { Jan: 1, Feb: 2, Mar: 3, Apr: 4, May: 5, Jun: 6, Jul: 7, Aug: 8, Sep: 9, Oct: 10, Nov: 11, Dec: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** "MM/DD/YYYY", the only date format the API accepts. */
export function apiDate(ymd) {
  const [y, m, d] = ymd.split("-");
  return `${m}/${d}/${y}`;
}

/** The meeting's calendar date, "YYYY-MM-DD". The API gives it two ways. */
export function meetingDate(r) {
  const a = String(r.actualStartDate || "");
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(a);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  // "Thu Oct 22 00:00:00 EDT 2026"
  m = /^\w{3} (\w{3}) (\d{1,2}) [\d:]+ \w+ (\d{4})$/.exec(a);
  if (m && MONTHS[m[1]]) return `${m[3]}-${pad(MONTHS[m[1]])}-${pad(m[2])}`;
  // startDateTime is midnight in the server's time zone (Eastern), given in UTC:
  // its date in Eastern time is the meeting date.
  const t = Date.parse(r.startDateTime || "");
  if (Number.isNaN(t)) return null;
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(t));
}

/** "9:00 AM" → "09:00"; null when missing. */
export function clock(s) {
  const m = /^(\d{1,2}):(\d{2})\s*([AP])M$/i.exec(String(s || "").trim());
  if (!m) return null;
  let h = parseInt(m[1], 10) % 12;
  if (m[3].toUpperCase() === "P") h += 12;
  return `${pad(h)}:${m[2]}`;
}

const agendaUrl = (base, id, packet) => `${base}meetingInformation/Agenda/${packet ? "true" : "false"}/${id}`;

/**
 * One meeting from the list. Returns null for a meeting type we don't follow or
 * without a date. Cancellations show only in the title ("Cancelled - Planning
 * Commission"); the `canceled` flag stays false.
 */
export function parseMeeting(r, base = API) {
  const body = MEETING_TYPES[r.meetingTypeId] || null;
  const date = meetingDate(r);
  if (!body || !date || !r.meetingId) return null;
  const time = clock(r.startTime);
  const posted = r.agendaStatus === POSTED && r.meetingAgendaId > 0;
  // The Board posts a short agenda and a packet; the Planning Commission posts
  // only the packet, which starts with the agenda.
  const summary = posted && !!r.agendaSummaryDocumentId;
  const video = /^[\w-]{6,20}$/.test(r.videoId || "") && /^(public|linked)$/.test(r.videoStatus || "") ? `https://www.youtube.com/watch?v=${r.videoId}` : null;
  const description = String(r.description || "").trim();
  return {
    id: `tmm-${r.meetingId}`,
    body,
    meeting_type: description && description.length < 60 ? description : "Meeting",
    starts_at: `${date}T${time || "00:00"}`,
    status: /cancel/i.test(`${r.meetingTitle || ""} ${r.description || ""}`) || r.canceled ? "cancelled" : "scheduled",
    location: String(r.location || "").trim() || null,
    agenda_id: posted ? r.meetingAgendaId : null,
    // Changes when the county re-posts the agenda.
    agenda_file_id: posted ? `${r.meetingAgendaId}@${r.agendaPostedDate || ""}` : null,
    posted_at: posted && r.agendaPostedDate && !Number.isNaN(Date.parse(r.agendaPostedDate)) ? new Date(Date.parse(r.agendaPostedDate)).toISOString() : null,
    agenda_url: posted ? agendaUrl(base, r.meetingAgendaId, !summary) : null,
    packet_url: summary ? agendaUrl(base, r.meetingAgendaId, true) : null,
    // The PDF that holds the agenda text.
    pdf_url: posted ? agendaUrl(base, r.meetingAgendaId, !summary) : null,
    titles: Array.isArray(r.agendaItemTitles) ? r.agendaItemTitles.map((t) => String(t).trim()).filter(Boolean) : [],
    video_url: video,
  };
}

/** Every meeting in a getMeetingInformationByDate response. */
export function parseMeetingList(json, base = API) {
  const rows = Array.isArray(json) ? json : [];
  return rows.map((r) => parseMeeting(r, base)).filter(Boolean);
}

// ---- Agenda text ---------------------------------------------------------

/** Letters and digits only, lowercased, with a map back to positions in `text`. */
function compact(text) {
  let s = "";
  const at = [];
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (/[A-Za-z0-9]/.test(c)) {
      s += c.toLowerCase();
      at.push(i);
    }
  }
  return { s, at };
}

const tidy = (s) =>
  String(s || "")
    .replace(/\s*\n\s*/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

const titleCase = (s) =>
  s.toLowerCase().replace(/(^|[\s(/&-])([a-z])/g, (_, p, c) => p + c.toUpperCase()).replace(/\b(Of|And|The|To|For|On|In|Am|Pm)\b/g, (w, _x, i) => (i === 0 ? w : /Am|Pm/.test(w) ? w.toUpperCase() : w.toLowerCase()));

const MAX_TITLE = 2000;
const clip = (s) => (s.length > MAX_TITLE ? `${s.slice(0, MAX_TITLE - 1).trimEnd()}…` : s);

/** Page text with page numbers ("2 of 8", "3") and the item-number column ("1.", "15.") removed. */
function bodyLines(pages) {
  const out = [];
  for (const page of pages) {
    for (const raw of String(page || "").split("\n")) {
      const line = raw.trim();
      if (!line || /^\d+ of \d+$/.test(line) || /^\d{1,3}\.?$/.test(line)) continue;
      out.push(line);
    }
  }
  return out;
}

/**
 * The Board of Supervisors' agenda PDF. Sections start with "." ("​.Consent
 * Agenda"); each item starts with its title from the JSON, then ", Department.",
 * the item text, and "Attachments" with the file names. The item numbers in the
 * PDF are a separate column that doesn't line up with the text, but items are
 * numbered 1..N in the same order as the JSON titles.
 *
 * Returns items for meeting_items. A title not found in the PDF still becomes an
 * item, with only its JSON title.
 */
export function parseSummaryAgenda(pages, titles) {
  const lines = bodyLines((pages || []).slice(1)); // page 1 is the header and how to comment
  const text = lines.join("\n");
  const heads = [];
  let pos = 0;
  for (const line of lines) {
    const m = /^\.([A-Z0-9][^\n]{1,80})$/.exec(line);
    if (m && !/^\.(com|org|gov|pdf|docx?)\b/i.test(line)) heads.push({ at: pos, name: m[1].trim() });
    pos += line.length + 1;
  }
  const { s, at } = compact(text);
  // Where each title starts and ends in `text`, in order.
  const found = [];
  let from = 0;
  for (const title of titles) {
    const key = compact(title).s;
    const i = key ? s.indexOf(key, from) : -1;
    if (i < 0) {
      found.push(null);
      continue;
    }
    found.push({ start: at[i], end: at[i + key.length - 1] + 1 });
    from = i + key.length;
  }
  const items = [];
  titles.forEach((title, n) => {
    const f = found[n];
    let section = null;
    let rest = "";
    if (f) {
      for (const h of heads) if (h.at <= f.start) section = h.name;
      // The item runs to the next item or the next section, whichever is first.
      const next = found.slice(n + 1).find(Boolean);
      const nextHead = heads.find((h) => h.at > f.start);
      const stop = Math.min(next ? next.start : text.length, nextHead ? nextHead.at : text.length);
      rest = text.slice(f.end, stop);
    }
    // ", Auditor." right after the title names the department.
    let dept = null;
    const d = /^,\s*([^.\n]{2,80})\.\s*(?:\n|$)/.exec(rest);
    if (d) {
      dept = d[1].trim();
      rest = rest.slice(d[0].length);
    } else rest = rest.replace(/^[.\s]+/, "");
    const [body, files] = rest.split(/^Attachments$/m);
    const attachments = tidy(files || "") ? (files || "").split("\n").map((l) => l.trim()).filter(Boolean).map((t) => ({ title: t, url: null })) : [];
    const desc = tidy(body);
    const full = `${title}${dept ? `, ${dept}.` : ""}${desc ? ` ${desc}` : ""}`;
    items.push({
      item_key: String(n + 1),
      number: String(n + 1),
      title: clip(full),
      section,
      section_kind: sectionKind(section),
      item_url: null,
      staff_report_url: null,
      attachments,
      sort: n + 1,
    });
  });
  return items;
}

// A heading in the Planning Commission agenda: a capitalized line such as
// "REGULAR AGENDA", "9:00 AM CALL TO ORDER" or "INFORMATIONAL ITEMS - None".
const CAPS_HEAD = /^(?:\d{1,2}:\d{2}\s*[AP]M\s+)?([A-Z][A-Z&'/ -]{3,})(?:\s+-\s+None)?$/;
const END_HEAD = /^(ADJOURNMENT|COMMISSIONER REPORTS|PLANNING DIRECTOR REPORTS?)$/;

/**
 * An agenda whose items are numbered in the text ("1. 2022-059 Vesting Tentative
 * Parcel Map …") under capitalized section headings: the Planning Commission's
 * packet. Reads until ADJOURNMENT (or the reports after the last items), so the
 * staff reports that follow are ignored.
 */
export function parsePacketAgenda(pages) {
  const items = [];
  let section = null;
  let current = null;
  const close = () => {
    if (!current) return;
    const title = tidy(current.lines.join("\n"));
    if (title) {
      const n = items.length + 1;
      items.push({
        item_key: current.number || String(n),
        number: current.number || String(n),
        title: clip(title),
        section,
        section_kind: sectionKind(section),
        item_url: null,
        staff_report_url: null,
        attachments: [],
        sort: n,
      });
    }
    current = null;
  };
  // Page 1 is the header and how to comment.
  for (const page of (pages || []).slice(1, 8)) {
    for (const raw of String(page || "").split("\n")) {
      const line = raw.trim();
      if (!line || /^\d{1,3}$/.test(line) || /^\d+ of \d+$/.test(line)) continue;
      const head = CAPS_HEAD.exec(line);
      if (head) {
        close();
        const name = head[1].trim();
        if (END_HEAD.test(name)) return items;
        section = titleCase(name);
        continue;
      }
      const num = /^(\d{1,2})\.\s+(\S.*)$/.exec(line);
      if (num && section) {
        close();
        current = { number: num[1], lines: [num[2]] };
      } else if (current) current.lines.push(line);
    }
  }
  close();
  return items;
}
