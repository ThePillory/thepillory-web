// TEMPORARY diagnostic, round 3: the county's new meetings site.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
async function get(url) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    const text = await res.text();
    console.log(`GET ${url} -> ${res.status} ${res.url} ${res.headers.get("content-type")} ${text.length} bytes`);
    return text;
  } catch (e) { console.log(`GET ${url} failed: ${e.message}`); return ""; }
}
const show = (h, n = 60) => [...new Set([...h.matchAll(/(?:href|src)="([^"]+)"/gi)].map((m) => m[1]))].filter((x) => !/\.(css|png|jpg|svg|woff2?|ico)(\?|$)/i.test(x)).slice(0, n);
for (const u of ["https://bos.calaverasgov.us/robots.txt", "https://www.calaverasgov.us/robots.txt"]) { console.log((await get(u)).slice(0, 800)); await sleep(5000); }
const b = await get("https://bos.calaverasgov.us/Board-Meetings");
console.log("generator/platform hints:", (b.match(/<meta[^>]+generator[^>]*>|granicus|civicplus|primegov|legistar|civicclerk|novus|escribe|boarddocs|onbase|laserfiche|iqm2|swagit|municode meetings|agendacenter/gi) || []).slice(0, 20));
console.log("links:", JSON.stringify(show(b, 120)));
console.log("text:", b.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 3000));
await sleep(10000);
const c = await get("https://www.calaverasgov.us/Meeting-Calendar");
console.log("calendar links:", JSON.stringify(show(c, 80).filter((x) => /meet|agenda|calendar|event|bos\./i.test(x))));
console.log("calendar text:", c.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 2000));
