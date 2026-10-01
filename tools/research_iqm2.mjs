// TEMPORARY diagnostic, round 2: has the county moved its agendas, or does the
// portal answer browsers differently? Few requests, paced.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BROWSER = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
async function get(url, ua = BROWSER) {
  try {
    const res = await fetch(url, { headers: { "User-Agent": ua }, redirect: "follow" });
    const text = await res.text();
    console.log(`GET ${url} -> ${res.status} ${res.url} ${text.length} bytes`);
    return text;
  } catch (e) { console.log(`GET ${url} failed: ${e.message}`); return ""; }
}
const links = (html) => [...new Set([...html.matchAll(/href="([^"]+)"/gi)].map((m) => m[1]).filter((h) => /agenda|meeting|iqm2|granicus|legistar|civicclerk|primegov|boarddocs|novus|civicplus|escribe|municode|youtube/i.test(h)))];
// The county's own site.
for (const u of ["https://www.calaverascounty.gov/", "https://www.calaverascounty.gov/government/board-of-supervisors", "https://www.calaverascounty.gov/government/board-of-supervisors/agendas-minutes", "https://calaverascounty.gov/agendas"]) {
  const h = await get(u);
  console.log("  links:", JSON.stringify(links(h).slice(0, 40)));
  await sleep(3000);
}
// Same IQM2 page as a browser would see it.
await sleep(30000);
const h = await get("https://calaverascountyca.iqm2.com/Citizens/Detail_Meeting.aspx?ID=2827");
console.log("  browser UA unavailable:", /not available at this time/i.test(h), "MeetingDetail:", /id=['"]MeetingDetail['"]/.test(h));
const m = /<div id="MainWindow">([\s\S]{0,3000})/.exec(h);
console.log("  main:", m ? m[1].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 800) : "");
await sleep(61000);
const old = await get("https://calaverascountyca.iqm2.com/Citizens/Detail_Meeting.aspx?ID=2825");
console.log("  Aug 28 meeting (last in RSS) unavailable:", /not available at this time/i.test(old), "MeetingDetail:", /id=['"]MeetingDetail['"]/.test(old));
