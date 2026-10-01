// TEMPORARY diagnostic, round 8: the 12 recent meetings and one agenda's format.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const API = "https://calaverascountycatmmapp.tylerhost.net/tylermmcalendar9579prod/";
const res = await fetch(`${API}meetingInformation/getMeetingInformationByDate`, { method: "POST", headers: { "User-Agent": UA, Accept: "application/json", "Content-Type": "application/json; charset=UTF-8" }, body: JSON.stringify({ startDate: "09/01/2026", endDate: "11/15/2026", meetingTypeIds: [5, 11] }) });
const list = await res.json();
for (const m of list) {
  const { base64ThumbnailsString, ...rest } = m;
  console.log(JSON.stringify({ date: m.actualStartDate, time: m.startTime, title: m.meetingTitle, type: m.meetingTypeId, meetingId: m.meetingId, agendaId: m.meetingAgendaId, agendaStatus: m.agendaStatus, minutesId: m.minutesId, minutesStatus: m.minutesStatus, keys: Object.keys(rest).join(",") }));
}
const one = list.find((m) => m.meetingTypeId === 5 && m.meetingAgendaId) || list[0];
for (const p of ["false", "true", "0", "1"]) {
  await sleep(3000);
  const r = await fetch(`${API}meetingInformation/Agenda/${p}/${one.meetingAgendaId}`, { headers: { "User-Agent": UA } });
  const buf = Buffer.from(await r.arrayBuffer());
  console.log(`Agenda/${p}/${one.meetingAgendaId} -> ${r.status} ${r.headers.get("content-type")} ${buf.length} bytes; starts: ${JSON.stringify(buf.subarray(0, 120).toString("latin1"))}`);
  if (r.ok && /html|json/.test(r.headers.get("content-type") || "")) console.log(buf.toString("utf8").replace(/\s+/g, " ").slice(0, 2500));
  if (r.ok) break;
}
