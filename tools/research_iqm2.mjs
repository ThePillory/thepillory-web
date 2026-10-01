// TEMPORARY diagnostic, round 4: Tyler Meeting Manager's public calendar.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const B = "https://calaverascountycatmmapp.tylerhost.net";
async function get(url, show = 0) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, text/html, */*" } });
    const text = await res.text();
    console.log(`GET ${url} -> ${res.status} ${res.headers.get("content-type")} ${text.length} bytes`);
    if (show) console.log(text.slice(0, show));
    return text;
  } catch (e) { console.log(`GET ${url} failed: ${e.message}`); return ""; }
}
await get(`${B}/robots.txt`, 600);
await sleep(3000);
const html = await get(`${B}/9579prod/tylermm/calendar/`, 3000);
const scripts = [...html.matchAll(/src="([^"]+\.js[^"]*)"/g)].map((m) => m[1]);
console.log("scripts:", scripts);
for (const s of scripts.slice(0, 6)) {
  await sleep(3000);
  const url = s.startsWith("http") ? s : new URL(s, `${B}/9579prod/tylermm/calendar/`).href;
  const js = await get(url);
  const apis = [...new Set([...js.matchAll(/["'`]((?:\/|https?:\/\/)[^"'`\s]*(?:api|odata|meeting|agenda|calendar|event|document)[^"'`\s]*)["'`]/gi)].map((m) => m[1]))];
  console.log("  api-like strings:", JSON.stringify(apis.slice(0, 60)));
}
// Common Tyler Meeting Manager endpoints, guessed; logged whatever they return.
for (const p of ["/9579prod/tylermm/api/meetings", "/9579prod/tylermm/api/calendar", "/9579prod/tylermm/api/public/meetings", "/9579prod/tylermm/odata/Meetings", "/9579prod/tylermm/api/v1/meetings"]) {
  await sleep(3000);
  await get(`${B}${p}`, 800);
}
