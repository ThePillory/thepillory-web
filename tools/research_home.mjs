// TEMPORARY: is there still a challenge page in front of thepillory.co?
for (const [u, ua] of [["https://thepillory.co/", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36"], ["https://thepillory.co/", "curl/8.5"], ["https://thepillory.co/explore/", "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148 Safari/604.1"], ["https://www.thepillory.co/", "Mozilla/5.0"]]) {
  try {
    const r = await fetch(u, { redirect: "manual", headers: { "User-Agent": ua, Accept: "text/html" } });
    const body = await r.text();
    console.log(`${u} [${ua.slice(0, 30)}] -> ${r.status} ${r.headers.get("location") || ""} | title: ${(/<title>([^<]*)/.exec(body) || [])[1]} | cf-mitigated: ${r.headers.get("cf-mitigated")}`);
  } catch (e) {
    console.log(`${u} -> ERROR ${e.message} ${e.cause ? e.cause.code : ""}`);
  }
}
