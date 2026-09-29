// Readers for the county's IQM2 (Granicus) meeting portal. Pure functions over
// the portal's HTML; the network side is in ./county.js.
//
//   Citizens/calendar.aspx?View=List   every meeting this year, with document links
//   Services/RSS.aspx?Feed=Calendar    the most recently published agendas, with dates
//   Citizens/Detail_Meeting.aspx?ID=N  one meeting's web agenda: sections, items, attachments

export const PORTAL = "https://calaverascountyca.iqm2.com";

const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", laquo: "«", raquo: "»", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", sect: "§" };

export function decode(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => (n.toLowerCase() in ENTITIES ? ENTITIES[n.toLowerCase()] : m));
}

export function stripTags(s) {
  return decode(String(s || "").replace(/<[^>]+>/g, " "))
    .replace(/[ \t ]+/g, " ")
    .trim();
}

/** A portal link made absolute, or null. */
export function absolute(href, base = PORTAL) {
  const h = decode(String(href || "").trim());
  if (!h || h === "#" || /^javascript:/i.test(h)) return null;
  if (/^https?:\/\//i.test(h)) return h.replace(/^http:\/\//i, "https://");
  if (h.startsWith("/")) return `${base}${h}`;
  return `${base}/Citizens/${h}`;
}

const MONTHS = { JANUARY: 1, FEBRUARY: 2, MARCH: 3, APRIL: 4, MAY: 5, JUNE: 6, JULY: 7, AUGUST: 8, SEPTEMBER: 9, OCTOBER: 10, NOVEMBER: 11, DECEMBER: 12 };
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const pad = (n) => String(n).padStart(2, "0");

/** "JULY 28, 2026", "8:00 AM" -> "2026-07-28T08:00" (Pacific local time, as the county writes it). */
export function localDateTime(monthDayYear, time) {
  const m = /([A-Za-z]+)\.? (\d{1,2}), (\d{4})/.exec(monthDayYear || "");
  if (!m) return null;
  const month = MONTHS[m[1].toUpperCase()] || MON[m[1].slice(0, 3).toUpperCase()];
  if (!month) return null;
  const t = /(\d{1,2}):(\d{2})\s*([AP])\.?M/i.exec(time || "");
  let hh = 0;
  let mm = 0;
  if (t) {
    hh = parseInt(t[1], 10) % 12 + (t[3].toUpperCase() === "P" ? 12 : 0);
    mm = parseInt(t[2], 10);
  }
  return `${m[3]}-${pad(month)}-${pad(m[2])}T${pad(hh)}:${pad(mm)}`;
}

const STATUS = { scheduled: "scheduled", cancelled: "cancelled", canceled: "cancelled", closed: "held" };

/** Every meeting row on the calendar list page. */
export function parseCalendar(html, base = PORTAL) {
  const out = [];
  const rows = String(html || "").split(/<div class="Row MeetingRow/).slice(1);
  for (const row of rows) {
    const link = /<div class="RowLink"><a href="([^"]*Detail_Meeting\.aspx\?ID=(\d+))"\s+title="([^"]*)"/i.exec(row);
    if (!link) continue;
    const info = decode(link[3]).replace(/\r/g, "\n").split("\n").map((l) => l.replace(/\t/g, " ").trim());
    const when = /^[A-Z]+, ([A-Z]+ \d{1,2}, \d{4})\s+(\d{1,2}:\d{2} [AP]M)/i.exec(info[0] || "");
    const field = (name) => {
      const l = info.find((x) => x.toLowerCase().startsWith(`${name.toLowerCase()}:`));
      return l ? l.slice(name.length + 1).trim() : null;
    };
    const statusIdx = info.findIndex((x) => /^Status:/i.test(x));
    const location = info
      .slice(statusIdx + 1)
      .filter(Boolean)
      .join(", ")
      .replace(/\s{2,}/g, " ");
    const docs = {};
    for (const a of row.matchAll(/<a\s+href=['"]([^'"]*)['"][^>]*class=['"]([^'"]*)['"][^>]*>([^<]+)<\/a>/gi)) {
      const label = a[3].trim();
      if (/HiddenDocumentLink/.test(a[2])) continue;
      docs[label] = absolute(a[1], base);
    }
    const cancelled = /MeetingCancelled|>\s*Cancelled\s*</i.test(row);
    const rawStatus = (field("Status") || "").toLowerCase();
    const agendaId = /Type=14&(?:amp;)?ID=(\d+)/i.exec(row) || /Type=1&(?:amp;)?ID=(\d+)/i.exec(row);
    out.push({
      portal_id: link[2],
      starts_at: when ? localDateTime(when[1], when[2]) : null,
      body: field("Board"),
      meeting_type: field("Type"),
      status: cancelled ? "cancelled" : STATUS[rawStatus] || "scheduled",
      location: location || null,
      agenda_url: docs["Agenda"] || null,
      packet_url: docs["Agenda Packet"] || null,
      summary_url: docs["Summary"] || null,
      minutes_url: docs["Minutes"] || null,
      video_url: docs["Video"] || null,
      agenda_file_id: agendaId ? agendaId[1] : null,
      source_url: absolute(link[1], base),
    });
  }
  return out;
}

/** The "RSS" page: {portal_id -> published ISO time} for the latest agendas. */
export function parseRss(html) {
  const out = {};
  for (const block of String(html || "").split(/<div>\s*<h2>/i).slice(1)) {
    const id = /Detail_Meeting\.aspx\?ID=(\d+)/i.exec(block);
    const pub = /Published on:\s*([^<]+)</i.exec(block);
    if (!id || !pub) continue;
    const t = Date.parse(pub[1].trim());
    if (!Number.isNaN(t)) out[id[1]] = new Date(t).toISOString();
  }
  return out;
}

export function sectionKind(section) {
  const s = String(section || "").toLowerCase();
  if (/closed session/.test(s)) return "closed_session";
  if (/consent/.test(s)) return "consent";
  if (/public hearing/.test(s)) return "public_hearing";
  if (/regular|discussion|action|business|agenda items|departmental|board matters|ordinance|resolution|presentation|report/.test(s)) return "regular";
  return "other";
}

/** One meeting's web agenda: numbered items with their sections and attachments. */
export function parseMeeting(html, base = PORTAL) {
  const doc = String(html || "");
  const table = /<table id=['"]MeetingDetail['"][\s\S]*?(?:<\/table>|$)/i.exec(doc);
  const items = [];
  let section = null;
  let current = null;
  let sort = 0;
  for (const tr of (table ? table[0] : "").split(/<tr>/i).slice(1)) {
    const cols = /colspan='(\d+)'/i.exec(tr);
    const span = cols ? parseInt(cols[1], 10) : 0;
    const titleCell = /<td class='Title'[^>]*>([\s\S]*?)<\/td>/i.exec(tr);
    const title = titleCell ? stripTags(titleCell[1]) : "";
    const href = titleCell && /href=['"]([^'"]+)['"]/i.exec(titleCell[1]);
    if (span >= 10) {
      // A section heading.
      section = title || section;
      current = null;
    } else if (span === 9) {
      const num = /<td class='Num'>\s*([^<]*?)\s*<\/td>/i.exec(tr);
      const number = num ? num[1].replace(/\.\s*$/, "").trim() : "";
      if (!number || !title) {
        current = null;
        continue;
      }
      current = {
        item_key: number,
        number,
        title,
        section,
        section_kind: sectionKind(section),
        item_url: href ? absolute(href[1].trim(), base) : null,
        staff_report_url: null,
        attachments: [],
        sort: sort++,
      };
      items.push(current);
    } else if (span === 8 && current && href) {
      const url = absolute(href[1].trim(), base);
      if (!url) continue;
      // The staff report is the "… Printout" (portal file type 30); the rest are exhibits.
      if (!current.staff_report_url && /Type=30\b/i.test(url)) current.staff_report_url = url;
      else current.attachments.push({ title, url });
    }
  }
  const agenda = /id="ContentPlaceholder1_hlPublicAgendaFile"[^>]*href="([^"]+)"/i.exec(doc);
  const packet = /id="ContentPlaceholder1_hlFullAgendaFile"[^>]*href="([^"]+)"/i.exec(doc);
  return {
    items,
    agenda_url: agenda ? absolute(agenda[1], base) : null,
    packet_url: packet ? absolute(packet[1], base) : null,
  };
}
