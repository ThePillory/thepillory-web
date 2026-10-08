// TEMPORARY research: how well the issues-page finder works on real sites.
import { issueLinks, issuesHeading, FALLBACK_PATHS } from "../../workers/sync/src/promises/finder.js";
import { htmlToText } from "../../workers/sync/src/promises/sources.js";
const UA = "ThePillory/1.0 (+https://thepillory.co; civic records)";
async function get(url) {
  const res = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow", signal: AbortSignal.timeout(20000) });
  return { ok: res.ok, status: res.status, url: res.url, html: res.ok ? await res.text() : "" };
}
async function find(site) {
  const home = await get(site);
  if (!home.ok) return { result: "error", note: `home ${home.status}` };
  const links = issueLinks(home.html, home.url).slice(0, 3);
  for (const l of links) {
    const p = await get(l.url);
    if (!p.ok) continue;
    const h = issuesHeading(p.html, htmlToText(p.html).length);
    if (h) return { result: "found", how: "link", url: p.url, heading: h, text: l.text };
  }
  for (const path of FALLBACK_PATHS) {
    const u = new URL(path, home.url).href;
    const p = await get(u).catch(() => ({ ok: false }));
    if (!p.ok) continue;
    const h = issuesHeading(p.html, htmlToText(p.html).length);
    if (h) return { result: "found", how: "path", url: p.url, heading: h };
  }
  return { result: "none", note: `links tried: ${links.map((l) => l.text + " " + l.url).join(" | ") || "none"}`, nav: [...home.html.matchAll(/<a\b[^>]*>([^<]{2,30})<\/a>/g)].map((m) => m[1].trim()).filter(Boolean).slice(0, 40).join(" · ") };
}
const leg = await (await fetch("https://unitedstates.github.io/congress-legislators/legislators-current.json")).json();
const sites = [];
for (const p of leg) {
  const t = p.terms[p.terms.length - 1];
  if (t.url && (t.state === "CA" || Math.random() < 0.06)) sites.push([`${p.name.official_full} (${t.type} ${t.state})`, t.url, p.id.fec]);
}
for (const n of [5, 8, 9, 23, 41]) sites.push([`Assembly ${n} (D site)`, `https://a${String(n).padStart(2, "0")}.asmdc.org/`]);
for (const n of [5, 8, 9, 23, 34]) sites.push([`Assembly ${n} (R site)`, `https://ad${String(n).padStart(2, "0")}.asmrc.org/`]);
for (const n of [4, 8, 14, 21]) sites.push([`State Senate ${n}`, `https://sd${String(n).padStart(2, "0")}.senate.ca.gov/`]);
sites.push(["Governor", "https://www.gov.ca.gov/"], ["Calaveras Supervisors", "https://www.calaverascounty.gov/"]);
const tally = {};
for (const [name, url] of sites) {
  let r;
  try { r = await find(url); } catch (e) { r = { result: "error", note: e.message.slice(0, 100) }; }
  tally[r.result] = (tally[r.result] || 0) + 1;
  console.log(`${r.result.toUpperCase()} ${name} ${url} -> ${r.url || ""} ${r.how || ""} [${r.heading || ""}] ${r.note || ""}${r.nav ? `\n    nav: ${r.nav}` : ""}`);
}
console.log("TALLY", JSON.stringify(tally), "of", sites.length);
// Campaign websites: does the FEC committee record list one?
const key = process.env.FEC_API_KEY;
let shown = 0;
for (const [name, , fec] of sites) {
  if (!key || !fec || shown >= 6) continue;
  try {
    const c = await (await fetch(`https://api.open.fec.gov/v1/candidate/${fec[0]}/committees/?api_key=${key}&designation=P`)).json();
    const com = (c.results || [])[0];
    if (!com) continue;
    const d = await (await fetch(`https://api.open.fec.gov/v1/committee/${com.committee_id}/?api_key=${key}`)).json();
    const r = (d.results || [])[0] || {};
    console.log("FEC", name, com.committee_id, "website:", r.website, "keys:", Object.keys(r).filter((k) => /web|url|site/i.test(k)).join(","));
    shown++;
  } catch (e) { console.log("FEC error", e.message); }
}
