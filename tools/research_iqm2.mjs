// TEMPORARY diagnostic, round 6: how the Tyler Meeting Manager calendar asks for meetings.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const H = "https://calaverascountycatmmapp.tylerhost.net";
const API = `${H}/tylermmcalendar9579prod/`;
async function req(method, url, body, show = 1500) {
  try {
    const res = await fetch(url, { method, headers: { "User-Agent": UA, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const text = await res.text();
    console.log(`${method} ${url} ${body ? JSON.stringify(body) : ""} -> ${res.status} ${res.headers.get("content-type")} ${text.length} bytes`);
    if (show) console.log(text.slice(0, show));
    return text;
  } catch (e) { console.log(`${method} ${url} failed: ${e.message}`); return ""; }
}
console.log((await req("GET", `${H}/robots.txt`, null, 500)));
const main = await (await fetch(`${H}/9579prod/tylermm/calendar/main.js`, { headers: { "User-Agent": UA } })).text();
for (const k of ["getMeetingByDateRange", "meetingCalendarSearch/search", "getMeetingInformationByDate", "meetingInformation/getMeeting\"", "meetingInformation/Agenda/", "getAgendaMergePDF", "serviceUrl = {", "serviceUrl:"]) {
  let i = -1, n = 0;
  while ((i = main.indexOf(k, i + 1)) >= 0 && n < 3) {
    console.log(`--- ctx ${k} #${++n}:`, main.slice(Math.max(0, i - 500), i + 700).replace(/\s+/g, " "));
  }
}
await sleep(3000);
await req("GET", `${API}meetingType/getMeetingTypes`);
await sleep(3000);
await req("GET", `${API}boards/getBoards`);
