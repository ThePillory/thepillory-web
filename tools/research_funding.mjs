// TEMPORARY: what FEC, the Senate lobbying database, Cal-Access and the county publish.
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co)";
const KEY = process.env.FEC_KEY || "DEMO_KEY";
const FEC = "https://api.open.fec.gov/v1";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const short = (o, n = 1500) => JSON.stringify(o, (k, v) => (typeof v === "string" && v.length > 200 ? v.slice(0, 200) + "…" : v)).slice(0, n);
async function get(url, init = {}) {
  const t = Date.now();
  try {
    const r = await fetch(url, { redirect: "follow", ...init, headers: { "User-Agent": UA, ...(init.headers || {}) } });
    const h = Object.fromEntries([...r.headers].filter(([k]) => /rate|content-length|content-type|location|retry/i.test(k)));
    const body = init.method === "HEAD" ? "" : await r.text();
    console.log(`\n## ${init.method || "GET"} ${url.replace(KEY, "KEY")} -> ${r.status} ${r.url !== url ? `(final ${r.url})` : ""} ${Date.now() - t}ms ${JSON.stringify(h)} ${body.length} chars`);
    return { status: r.status, body, url: r.url };
  } catch (e) {
    console.log(`\n## ${url} -> ERROR ${e.message} ${e.cause ? e.cause.code || e.cause.message : ""}`);
    return { status: 0, body: "" };
  }
}
const fec = async (path) => {
  const r = await get(`${FEC}${path}${path.includes("?") ? "&" : "?"}api_key=${KEY}`);
  try { return JSON.parse(r.body); } catch { console.log(r.body.slice(0, 300)); return {}; }
};

// 1. Crosswalk
const leg = await get("https://theunitedstates.io/congress-legislators/legislators-current.json");
let fecIds = [];
try {
  const all = JSON.parse(leg.body);
  console.log("legislators:", all.length, "with fec ids:", all.filter((l) => (l.id.fec || []).length).length);
  const m = all.find((l) => l.id.bioguide === "M001177");
  console.log("sample:", short({ id: m.id, terms: m.terms.slice(-1) }));
  fecIds = m.id.fec || [];
  const multi = all.filter((l) => (l.id.fec || []).length > 1).slice(0, 3).map((l) => [l.id.bioguide, l.id.fec, l.terms.at(-1).type]);
  console.log("multi:", JSON.stringify(multi));
} catch (e) { console.log("crosswalk parse failed", e.message); }
const cand = fecIds.find((x) => x.startsWith("H")) || "H8CA04152";

// 2. FEC
let j = await fec(`/candidate/${cand}/totals/?cycle=2026`);
console.log("totals keys:", Object.keys((j.results || [])[0] || {}).join(","));
console.log("totals:", short((j.results || [])[0], 2500));
j = await fec(`/candidate/${cand}/committees/?designation=P&cycle=2026`);
const cmte = ((j.results || [])[0] || {}).committee_id;
console.log("committee:", cmte, short((j.results || [])[0], 600));
j = await fec(`/schedules/schedule_a/?committee_id=${cmte}&two_year_transaction_period=2026&line_number=F3-11C&per_page=100&sort=-contribution_receipt_amount`);
console.log("11C pagination:", short(j.pagination), "rows", (j.results || []).length);
console.log("11C row:", short((j.results || [])[0], 2500));
console.log("11C top:", JSON.stringify((j.results || []).slice(0, 8).map((r) => [r.contributor_name, r.contributor_id, r.contribution_receipt_amount, r.contributor && r.contributor.committee_type, r.memo_code, r.entity_type])));
j = await fec(`/schedules/schedule_a/by_employer/?committee_id=${cmte}&cycle=2026&sort=-total&per_page=15`);
console.log("by_employer:", short(j.pagination), JSON.stringify((j.results || []).slice(0, 15).map((r) => [r.employer, r.total, r.count])));
j = await fec(`/schedules/schedule_a/by_size/by_candidate/?candidate_id=${cand}&cycle=2026`);
console.log("by_size:", short(j.results, 800));
j = await fec(`/schedules/schedule_e/by_candidate/?candidate_id=${cand}&cycle=2024&per_page=20&sort=-total`);
console.log("sched_e:", short(j.pagination), short((j.results || []).slice(0, 4), 1500));
j = await fec(`/candidates/totals/?cycle=2026&office=H&per_page=3&is_active_candidate=true`);
console.log("candidates/totals keys:", Object.keys((j.results || [])[0] || {}).join(","), short(j.pagination));

// 3. Bulk files
for (const f of ["2026/weball26.zip", "2026/pas226.zip", "2026/cm26.zip", "2026/webl26.zip", "2024/pas224.zip"]) await get(`https://www.fec.gov/files/bulk-downloads/${f}`, { method: "HEAD" });

// 4. Lobbying
for (const base of ["https://lda.senate.gov/api/v1", "https://lda.gov/api/v1"]) {
  const r = await get(`${base}/filings/?filing_specific_lobbying_issues=${encodeURIComponent('"H.R. 1"')}&filing_year=2025&page_size=5`);
  try {
    const d = JSON.parse(r.body);
    console.log("count", d.count, "next", d.next);
    const f = (d.results || [])[0];
    if (f) {
      console.log("filing keys:", Object.keys(f).join(","));
      console.log("filing:", short({ ...f, lobbying_activities: undefined, conviction_disclosures: undefined }, 2500));
      console.log("activity:", short(f.lobbying_activities[0], 1500));
    }
  } catch { console.log(r.body.slice(0, 400)); }
  await sleep(4000);
}
await get("https://lda.senate.gov/api/v1/constants/filing/lobbyingactivityissues/");

// 5. California
const ca = [
  "https://www.sos.ca.gov/campaign-lobbying/cal-access-resources/raw-data-campaign-finance-and-lobbying-activity",
  "https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip",
  "https://powersearch.sos.ca.gov/",
  "https://cal-access.sos.ca.gov/Campaign/",
  "https://www.sos.ca.gov/campaign-lobbying",
];
for (const u of ca) {
  const r = await get(u, u.endsWith(".zip") ? { method: "HEAD" } : {});
  const links = [...r.body.matchAll(/href="([^"]+)"[^>]*>([^<]{0,80})</gi)].map((m) => `${m[2].trim()} -> ${m[1]}`).filter((s) => /cars|replacement|raw|export|api|download|power|new system|cal-access|bulk|csv/i.test(s));
  console.log("links:", [...new Set(links)].slice(0, 25).join("\n  "));
  const text = r.body.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  for (const m of text.matchAll(/.{0,200}(replacement|CARS|new system|retire|transition).{0,200}/gi)) { console.log("CTX:", m[0]); break; }
}

// 6. Calaveras County elections
for (const u of ["https://elections.calaverasgov.us/", "https://calaverasgov.us/Elections", "https://calaverasgov.us/"]) {
  const r = await get(u);
  const links = [...r.body.matchAll(/href="([^"]+)"[^>]*>([^<]{0,80})</gi)].map((m) => `${m[2].trim()} -> ${m[1]}`).filter((s) => /elect|campaign|460|netfile|disclos|filing|fppc/i.test(s));
  console.log("links:", [...new Set(links)].slice(0, 30).join("\n  "));
}
