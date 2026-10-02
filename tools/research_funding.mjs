// TEMPORARY: second look at the crosswalk, lobbying search, CARS and the county.
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow", ...init, headers: { "User-Agent": UA, ...(init.headers || {}) } });
    const h = Object.fromEntries([...r.headers].filter(([k]) => /rate|content-length|content-type|retry|allow/i.test(k)));
    const body = await r.text();
    console.log(`\n## ${url} -> ${r.status} ${r.url !== url ? `(final ${r.url})` : ""} ${Date.now() - t}ms ${JSON.stringify(h)} ${body.length} chars`);
    return { status: r.status, body, url: r.url };
  } catch (e) {
    console.log(`\n## ${url} -> ERROR ${e.message} ${e.cause ? e.cause.code || e.cause.message : ""}`);
    return { status: 0, body: "" };
  }
}
const text = (html) => html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/\s+/g, " ");
const links = (html, re) => [...new Set([...html.matchAll(/href="([^"]+)"[^>]*>([\s\S]{0,120}?)<\/a>/gi)].map((m) => `${text(m[2]).trim()} -> ${m[1]}`).filter((s) => re.test(s)))];

// 1. Crosswalk
for (const u of ["https://unitedstates.github.io/congress-legislators/legislators-current.json", "https://raw.githubusercontent.com/unitedstates/congress-legislators/main/legislators-current.yaml"]) {
  const r = await get(u);
  if (u.endsWith(".json") && r.body) {
    try {
      const all = JSON.parse(r.body);
      const withFec = all.filter((l) => (l.id.fec || []).length);
      console.log("legislators", all.length, "with fec", withFec.length, "missing:", all.filter((l) => !(l.id.fec || []).length).map((l) => `${l.id.bioguide} ${l.terms.at(-1).type} ${l.terms.at(-1).state}`).join(", "));
      const m = all.find((l) => l.id.bioguide === "M001177");
      console.log("sample", JSON.stringify(m && m.id));
      console.log("multi", JSON.stringify(all.filter((l) => l.id.fec && l.id.fec.length > 1).slice(0, 5).map((l) => [l.id.bioguide, l.id.fec, l.terms.at(-1).type, l.terms.at(-1).state])));
    } catch (e) { console.log("parse", e.message); }
  } else console.log(r.body.slice(0, 300));
}

// 2. Lobbying search
const L = "https://lda.gov/api/v1/filings/";
for (const [q, size] of [['"H.R. 4"', 100], ['"S. 1071"', 25], ['"H.R.4"', 25]]) {
  const r = await get(`${L}?filing_specific_lobbying_issues=${encodeURIComponent(q)}&filing_year=2025&page_size=${size}`);
  try {
    const d = JSON.parse(r.body);
    console.log(q, "count", d.count, "returned", (d.results || []).length, "next", d.next);
    for (const f of (d.results || []).slice(0, 4)) {
      for (const a of f.lobbying_activities) {
        const i = a.description.search(/H\.?\s?R\.?\s?4\b|S\.?\s?1071\b/);
        if (i >= 0) console.log(`  [${f.client.name} | ${f.client.general_description} | ${f.income || f.expenses}] ...${a.description.slice(Math.max(0, i - 60), i + 140)}`);
      }
    }
  } catch { console.log(r.body.slice(0, 400)); }
  await sleep(5000);
}
// Rapid requests: is there a limit for anonymous use?
for (let i = 0; i < 6; i++) {
  const r = await get(`${L}?filing_year=2025&page_size=1&page=${i + 1}`);
  if (r.status !== 200) { console.log(r.body.slice(0, 300)); break; }
}
await get("https://lda.gov/api/");

// 3. California: CARS and Power Search
for (const u of [
  "https://www.sos.ca.gov/campaign-lobbying/helpful-resources/cal-access-replacement-system-project-cars-updates/cal-access-replacement-system-cars-go-live-updates",
  "https://www.sos.ca.gov/campaign-lobbying/helpful-resources/cal-access-replacement-system-project-cars-updates",
]) {
  const r = await get(u);
  const t = text(r.body);
  const i = t.search(/CAL-ACCESS Replacement|CARS/);
  console.log("TEXT:", t.slice(i, i + 3500));
  console.log("links:", links(r.body, /cars|api|data|download|portal|launch|go.?live/i).slice(0, 20).join("\n  "));
}
for (const u of ["https://powersearch.sos.ca.gov/advanced.php", "https://powersearch.sos.ca.gov/quick-search.php"]) {
  const r = await get(u);
  console.log("forms:", [...r.body.matchAll(/<form[^>]*>/gi)].map((m) => m[0]).join(" "), "| csv:", /csv|export|download/i.test(r.body));
  console.log("TEXT:", text(r.body).slice(0, 1200));
}

// 4. Calaveras County campaign filings
const seen = new Set();
const queue = ["https://elections.calaverasgov.us/Campaign-Services"];
while (queue.length && seen.size < 8) {
  const u = queue.shift();
  if (seen.has(u)) continue;
  seen.add(u);
  const r = await get(u);
  const t = text(r.body);
  const i = t.search(/Campaign/);
  console.log("TEXT:", t.slice(i, i + 1500));
  const l = links(r.body, /campaign|460|netfile|disclos|filing|fppc|candidate|statement|committee|form 7|econ/i);
  console.log("links:", l.slice(0, 30).join("\n  "));
  for (const s of l) {
    const href = s.split(" -> ").pop();
    if (/^https:\/\/elections\.calaverasgov\.us\/Campaign-Services\//i.test(href)) queue.push(href);
  }
}
