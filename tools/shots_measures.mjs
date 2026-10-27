// TEMPORARY (removed before merge): does the branch preview read the same officials as production?
import { mkdirSync, writeFileSync } from "node:fs";
mkdirSync("shots", { recursive: true });
const out = [];
for (const base of ["https://claude-pillory-mobile-screen.thepillory-web.pages.dev", "https://thepillory.co"]) {
  for (const q of ["Patterson", "Umberg"]) {
    const r = await fetch(`${base}/api/search-officials?q=${q}`);
    out.push(`${base} ${q} ${r.status} ${(await r.text()).slice(0, 400)}`);
  }
}
writeFileSync("shots/check.txt", out.join("\n") + "\n");
console.log(out.join("\n"));
