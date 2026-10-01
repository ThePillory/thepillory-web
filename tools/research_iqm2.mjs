// TEMPORARY diagnostic, round 7: meetings and an agenda from Tyler Meeting Manager.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const H = "https://calaverascountycatmmapp.tylerhost.net";
const API = `${H}/tylermmcalendar9579prod/`;
async function req(method, url, body, show = 2500) {
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": UA, Accept: "application/json, */*", "Content-Type": "application/json; charset=UTF-8" }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    console.log(`${method} ${url} ${body ? JSON.stringify(body) : ""} -> ${res.status} ${res.headers.get("content-type")} ${text.length} bytes`);
    if (show) console.log(text.slice(0, show));
    return { res, text };
  } catch (e) { console.log(`${method} ${url} failed: ${e.message}`); return { text: "" }; }
}
const main = await (await fetch(`${H}/9579prod/tylermm/calendar/main.js`, { headers: { "User-Agent": UA } })).text();
for (const k of ["format = {", "format: {", "getMeeting(", "agendaLink", "getAgendaMergePDF", "meetingInformation/getMeeting'", "minutesLink"]) {
  let i = -1, n = 0;
  while ((i = main.indexOf(k, i + 1)) >= 0 && n < 2) console.log(`--- ctx ${k} #${++n}:`, main.slice(Math.max(0, i - 300), i + 600).replace(/\s+/g, " "));
}
const types = JSON.parse((await req("GET", `${API}meetingType/getMeetingTypes`, null, 0)).text || "[]");
console.log("types:", JSON.stringify(types.map((t) => [t.meetingTypeId, t.meetingTypeTitle, t.meetingTypeDescription])));
const ids = types.filter((t) => /supervisor|planning/i.test(t.meetingTypeTitle)).map((t) => t.meetingTypeId);
let list = [];
for (const [s, e] of [["2026-09-01", "2026-11-15"], ["09/01/2026", "11/15/2026"]]) {
  await sleep(3000);
  const r = await req("POST", `${API}meetingInformation/getMeetingInformationByDate`, { startDate: s, endDate: e, meetingTypeIds: ids }, 4000);
  try { const j = JSON.parse(r.text); if (Array.isArray(j) && j.length) { list = j; break; } } catch {}
}
console.log("meetings:", list.length);
const m = list.find((x) => /supervisor/i.test(JSON.stringify(x))) || list[0];
if (m) {
  console.log("one meeting:", JSON.stringify(m).slice(0, 3000));
  const id = m.id || m.meetingId || m.meetingInformationId;
  for (const u of [`${API}meetingInformation/getMeeting?meetingId=${id}`, `${API}meetingInformation/getMeeting/${id}`, `${API}meetingInformation/Agenda/${id}`]) {
    await sleep(3000);
    await req("GET", u, null, 3000);
  }
}
