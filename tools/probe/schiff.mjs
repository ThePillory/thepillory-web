// Temporary: screenshots Adam Schiff's Stock trades section on the PR preview at phone width.
import { chromium } from "playwright";
import { mkdirSync, writeFileSync } from "node:fs";
const base = process.argv[2];
mkdirSync("tools/probe/out", { recursive: true });
const found = await (await fetch(`${base}/api/search-officials?q=schiff`)).json().catch(() => null);
writeFileSync("tools/probe/out/search.json", JSON.stringify(found, null, 1));
const list = (found && (found.results || found.officials || found)) || [];
const hit = (Array.isArray(list) ? list : []).find((x) => /schiff/i.test(x.name || ""));
const slug = hit ? hit.slug || String(hit.url || "").split("/").filter(Boolean).pop() : "adam-b-schiff";
const b = await chromium.launch();
for (const scheme of ["light", "dark"]) {
  const p = await b.newPage({ viewport: { width: 390, height: 844 }, colorScheme: scheme, deviceScaleFactor: 1 });
  await p.goto(`${base}/reps/${slug}/#more-trades`, { waitUntil: "networkidle" });
  await p.waitForTimeout(800);
  const info = await p.evaluate(() => {
    const sec = document.getElementById("more-trades");
    if (!sec) return { error: "no #more-trades" };
    sec.open = true;
    const list = document.getElementById("trade-list");
    const kids = list ? [...list.children].map((c) => c.className) : [];
    const text = sec.innerText;
    const order = ["trades reported in", "Trades, newest first", "Load more", "Committee assignments, for reference"].map((s) => text.indexOf(s));
    return { scrollWidth: document.documentElement.scrollWidth, rows: kids.length, nonTrade: kids.filter((c) => !/trade-row/.test(c)), order, reference: (text.match(/Committee assignments, for reference[^\n]*/) || [""])[0], about: !!document.getElementById("congress-committees") };
  });
  writeFileSync(`tools/probe/out/schiff-${scheme}.json`, JSON.stringify({ slug, ...info }, null, 1));
  const el = await p.$("#more-trades");
  if (el) await el.screenshot({ path: `tools/probe/out/schiff-${scheme}.png` });
  console.log(scheme, JSON.stringify({ slug, ...info }));
}
await b.close();
