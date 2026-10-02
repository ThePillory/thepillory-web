// TEMPORARY: what thepillory.co serves at /.
const UA = "Mozilla/5.0 (research; ThePillory)";
const cases = [
  ["https://thepillory.co/", ""],
  ["https://www.thepillory.co/", ""],
  ["https://thepillory-web.pages.dev/", ""],
  ["https://thepillory.co/", "pillory_districts=" + encodeURIComponent("st=CA&cd=5&su=4&sl=8&co=06009")],
  ["https://thepillory.co/?hub=1", ""],
  ["https://thepillory.co/index.html", ""],
  ["https://thepillory.co/home/", ""],
];
for (const [u, cookie] of cases) {
  try {
    const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": UA, ...(cookie ? { Cookie: cookie } : {}) } });
    const body = await r.text();
    const title = (/<title>([^<]*)<\/title>/.exec(body) || [])[1];
    const h1 = (/<h1[^>]*>([\s\S]*?)<\/h1>/.exec(body) || [])[1];
    console.log(`\n## ${u}${cookie ? " (with district cookie)" : ""} -> ${r.status} ${r.headers.get("location") || ""}`);
    console.log("server:", r.headers.get("server"), "| cache:", r.headers.get("cache-control"), "| cf-cache:", r.headers.get("cf-cache-status"), "| age:", r.headers.get("age"));
    console.log("title:", title, "| h1:", (h1 || "").replace(/<[^>]+>/g, "").trim().slice(0, 120));
    console.log("markers:", ["hub-title", "brief-title", "intro-banner", "wordmark", "ThePillory", "The Pillory", "has-tabbar", "Find your representatives"].filter((m) => body.includes(m)).join(", "));
    if (!body.includes("hub-title")) console.log("BODY:", body.replace(/<(script|style)[\s\S]*?<\/\1>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 1200));
  } catch (e) {
    console.log(`\n## ${u} -> ERROR ${e.message}`);
  }
}
