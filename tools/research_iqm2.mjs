// TEMPORARY diagnostic (see .github/workflows/research-iqm2.yml): read the
// county portal the way the sync Worker does, paced at robots.txt's 60 s.
import { parseCalendar, parseRss, parseMeeting, PORTAL } from "../workers/sync/src/meetings/iqm2.js";
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA } });
  const text = await res.text();
  console.log(`GET ${url} -> ${res.status} ${text.length} bytes`);
  return text;
}
const cal = await get(`${PORTAL}/Citizens/calendar.aspx?View=List`);
const rows = parseCalendar(cal);
console.log(`calendar rows: ${rows.length}; MeetingRow markers: ${(cal.match(/class="Row MeetingRow/g) || []).length}`);
const today = new Date().toISOString().slice(0, 10);
const pick = rows.filter((m) => /Board of Supervisors|Planning Commission/.test(m.body || "") && m.starts_at && m.starts_at.slice(0, 10) >= "2026-09-01" && m.starts_at.slice(0, 10) <= "2026-11-15");
for (const m of pick) console.log(JSON.stringify({ id: m.portal_id, at: m.starts_at, body: m.body, status: m.status, agenda: !!m.agenda_url, file: m.agenda_file_id }));
if (!rows.length) console.log(cal.slice(0, 3000));
await sleep(61000);
const rss = await get(`${PORTAL}/Services/RSS.aspx?Feed=Calendar`);
console.log("rss entries", Object.keys(parseRss(rss)).length, JSON.stringify(parseRss(rss)).slice(0, 600));
const sample = [...pick.filter((m) => m.starts_at.slice(0, 10) >= today).slice(0, 2), ...pick.filter((m) => m.starts_at.slice(0, 10) < today).slice(-2)];
for (const m of sample) {
  await sleep(61000);
  const html = await get(m.source_url);
  const p = parseMeeting(html);
  console.log(`meeting ${m.portal_id} ${m.starts_at}: items=${p.items.length} unavailable=${p.unavailable} agenda_url=${p.agenda_url} file=${p.agenda_file_id}`);
  if (p.items[0]) console.log("  first item:", JSON.stringify(p.items[0]).slice(0, 300));
  if (!p.items.length) {
    const i = html.search(/MeetingDetail|not available|Agenda/i);
    console.log("  has MeetingDetail table:", /id=['"]MeetingDetail['"]/.test(html));
    console.log("  snippet:", html.slice(Math.max(0, i - 200), i + 1500).replace(/\s+/g, " "));
  }
}
