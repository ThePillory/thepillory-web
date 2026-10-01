// TEMPORARY: record real Tyler Meeting Manager responses to build the reader against.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const API = "https://calaverascountycatmmapp.tylerhost.net/tylermmcalendar9579prod/";
const H = { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json; charset=UTF-8" };
const post = async (path, body) => {
  const r = await fetch(API + path, { method: "POST", headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  console.log(`POST ${path} ${JSON.stringify(body)} -> ${r.status} ${t.length} bytes`);
  return { r, t };
};
const strip = (o) => { const x = { ...o }; for (const k of Object.keys(x)) if (/base64|thumbnail/i.test(k)) x[k] = `[${String(x[k] || "").length} chars]`; if (x.agendaOCRedContent) x.agendaOCRedContent = String(x.agendaOCRedContent).slice(0, 1500) + "…"; if (x.minutesOCRedContent) x.minutesOCRedContent = String(x.minutesOCRedContent).slice(0, 300) + "…"; return x; };
const { t } = await post("meetingInformation/getMeetingInformationByDate", { startDate: "08/15/2026", endDate: "11/15/2026", meetingTypeIds: [5, 11] });
const list = JSON.parse(t);
console.log("count", list.length);
const bos = list.find((m) => m.meetingTypeId === 5 && m.agendaStatus === 5 && m.meetingId === 102) || list.find((m) => m.agendaStatus === 5);
console.log("FULL RECORD:", JSON.stringify(strip(bos), null, 1));
const cancelled = list.find((m) => m.canceled || /cancel/i.test(m.meetingTitle));
if (cancelled) console.log("CANCELLED RECORD:", JSON.stringify({ title: cancelled.meetingTitle, canceled: cancelled.canceled, actualStartDate: cancelled.actualStartDate, startDateTime: cancelled.startDateTime, agendaStatus: cancelled.agendaStatus }));
for (const m of list) console.log("ROW", JSON.stringify({ id: m.id, meetingId: m.meetingId, recurringId: m.recurringId, type: m.meetingTypeId, title: m.meetingTitle, actualStartDate: m.actualStartDate, startDateTime: m.startDateTime, startTime: m.startTime, agendaId: m.meetingAgendaId, agendaStatus: m.agendaStatus, posted: m.agendaPostedDate, canceled: m.canceled, adjourned: m.adjourned, videoId: m.videoId, videoStatus: m.videoStatus, items: Array.isArray(m.agendaItemTitles) ? m.agendaItemTitles.length : typeof m.agendaItemTitles, packetDoc: m.agendaPacketDocumentId, summaryDoc: m.agendaSummaryDocumentId, minutesStatus: m.minutesStatus }));
for (const body of [{ meetingId: bos.meetingId, recurringId: bos.recurringId }, { id: bos.id }, { meetingId: bos.meetingId }]) {
  await sleep(4000);
  const { r, t: d } = await post("meetingInformation/getMeeting", body);
  if (r.ok) { try { console.log("DETAIL:", JSON.stringify(strip(JSON.parse(d)), null, 1).slice(0, 12000)); } catch { console.log(d.slice(0, 2000)); } break; }
  console.log(d.slice(0, 300));
}
