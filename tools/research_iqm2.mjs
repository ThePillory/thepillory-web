// TEMPORARY diagnostic, round 5: the Tyler Meeting Manager app's data endpoints.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const B = "https://calaverascountycatmmapp.tylerhost.net";
const C = `${B}/9579prod/tylermm/calendar/`;
async function get(url, show = 0, headers = {}) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json, */*", ...headers } });
    const text = await res.text();
    console.log(`GET ${url} -> ${res.status} ${res.headers.get("content-type")} ${text.length} bytes`);
    if (show) console.log(text.slice(0, show));
    return text;
  } catch (e) { console.log(`GET ${url} failed: ${e.message}`); return ""; }
}
const main = await get(`${C}main.js`);
const strs = [...new Set([...main.matchAll(/["'`]([^"'`\n]{2,160})["'`]/g)].map((m) => m[1]))];
console.log("url-ish:", JSON.stringify(strs.filter((s) => /\/|api|http/i.test(s) && /api|meeting|agenda|calendar|event|doc|file|public|portal|media|minutes|packet|body|board/i.test(s) && !/\s{2}|[<>{}]/.test(s)).slice(0, 150)));
for (const k of ["apiUrl", "baseUrl", "apiBase", "environment", "serverUrl", "tylermm/"]) {
  const i = main.indexOf(k);
  if (i >= 0) console.log(`ctx ${k}:`, main.slice(Math.max(0, i - 200), i + 400).replace(/\s+/g, " "));
}
await sleep(3000);
await get(`${C}assets/config.json`, 1500);
await sleep(3000);
await get(`${C}assets/env.json`, 1500);
