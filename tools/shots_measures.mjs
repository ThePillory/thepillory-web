// TEMPORARY (removed before merge): screenshots of Props 4 and 5 from the branch preview.
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
const BASE = "https://claude-pillory-mobile-screen.thepillory-web.pages.dev";
mkdirSync("shots", { recursive: true });
const b = await chromium.launch();
for (let i = 0; i < 40; i++) {
  const html = await (await fetch(`${BASE}/elections/2026-11-03/measure/prop-4/`)).text();
  if (html.includes("behind each side")) break;
  await new Promise((r) => setTimeout(r, 20000));
}
for (const n of ["4", "5"]) {
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(`${BASE}/elections/2026-11-03/measure/prop-${n}/`, { waitUntil: "networkidle" });
  await p.screenshot({ path: `shots/prop${n}-top.png` });
  await p.evaluate(() => { for (const id of ["behind", "arguments"]) { const d = document.getElementById(id); if (d) d.open = true; } });
  const behind = await p.$("#behind");
  if (behind) await behind.screenshot({ path: `shots/prop${n}-behind.png` });
  await p.evaluate(() => document.querySelectorAll(".signer-more").forEach((d) => (d.open = true)));
  const args = await p.$("#arguments");
  if (args) await args.screenshot({ path: `shots/prop${n}-signers.png` });
  console.log(n, await p.evaluate(() => document.documentElement.scrollWidth));
  await ctx.close();
}
await b.close();
