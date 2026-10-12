// /awards/?name=…: an organization's federal contracts and grants, from
// USAspending.gov, behind the "Federal awards" link on organization lines
// (lobbying clients and givers, super PAC donors, earmark recipients). Only
// recipients with exactly this name; each one separately, since organizations
// in different places can share a name. Kept in D1 for a week
// (federal_awards_cache), so a page doesn't ask USAspending on every visit.
// Shown as facts on their own: never tied in words to a vote, a contribution or
// lobbying (docs/funding.md).
import { page, esc, guard, edgeCached } from "../_lib/render.js";
import { HOW } from "../_lib/gov-money.js";

const API = "https://api.usaspending.gov/api/v2/";
const KEEP_DAYS = 7;
const YEARS = 4; // this fiscal year and the three before it
const money = (n) => `$${Math.round(Number(n || 0)).toLocaleString("en-US")}`;

/** An organization's name for exact matching: lowercase, no punctuation or "Inc."/"The". */
export function nameKey(name) {
  const words = String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return words.filter((w) => !["the", "inc", "incorporated", "llc", "corp", "corporation", "co", "ltd"].includes(w)).join(" ");
}

/** Fiscal years, newest first: [{fy, start, end}] (a fiscal year starts October 1 of the year before). */
export function fiscalYears(today = new Date(), n = YEARS) {
  const fy = today.getUTCFullYear() + (today.getUTCMonth() >= 9 ? 1 : 0);
  return Array.from({ length: n }, (_, i) => ({ fy: fy - i, start: `${fy - i - 1}-10-01`, end: `${fy - i}-09-30` }));
}

async function post(path, body) {
  const r = await fetch(API + path, { method: "POST", headers: { "Content-Type": "application/json", "User-Agent": "ThePillory/1.0 (+https://thepillory.co)" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`USAspending ${path}: ${r.status}`);
  return r.json();
}

/** {recipients: [{id, name, uei, level, location, years: [{fy, total, agencies: [{name, amount}]}]}]} for this exact name. */
export async function lookUp(name, today = new Date()) {
  const key = nameKey(name);
  const found = await post("recipient/", { keyword: name, award_type: "all", limit: 50 });
  const exact = (found.results || []).filter((r) => nameKey(r.name) === key);
  // A parent record sums its children: show the parent alone when there is one.
  const parents = exact.filter((r) => r.recipient_level === "P");
  const picked = (parents.length ? parents : exact).slice(0, 3);
  const fys = fiscalYears(today);
  const recipients = [];
  for (const r of picked) {
    const [profile, ...years] = await Promise.all([
      fetch(`${API}recipient/${encodeURIComponent(r.id)}/`).then((x) => (x.ok ? x.json() : null)).catch(() => null),
      ...fys.map((y) =>
        post("search/spending_by_category/awarding_agency/", { filters: { recipient_id: r.id, time_period: [{ start_date: y.start, end_date: y.end }] }, limit: 10 })
          .then((d) => ({ fy: y.fy, agencies: (d.results || []).map((a) => ({ name: a.name, amount: a.amount })).filter((a) => a.amount) }))
      ),
    ]);
    const loc = profile && profile.location ? [profile.location.city_name, profile.location.state_code || profile.location.country_name].filter(Boolean).join(", ") : "";
    recipients.push({ id: r.id, name: r.name, uei: r.uei || null, level: r.recipient_level, location: loc, years: years.map((y) => ({ ...y, total: y.agencies.reduce((s, a) => s + a.amount, 0) })) });
  }
  return { name, total_found: exact.length, recipients, fiscal_years: fys.map((y) => y.fy) };
}

async function cached(db, name) {
  const key = nameKey(name);
  if (db) {
    try {
      const row = await db.prepare(`SELECT result FROM federal_awards_cache WHERE name_key = ? AND fetched_at > datetime('now', '-${KEEP_DAYS} days')`).bind(key).first();
      if (row) return JSON.parse(row.result);
    } catch {
      // No cache table yet: ask USAspending.
    }
  }
  const got = await lookUp(name);
  if (db) {
    try {
      await db.prepare("INSERT OR REPLACE INTO federal_awards_cache (name_key, result, fetched_at) VALUES (?, ?, datetime('now'))").bind(key, JSON.stringify(got)).run();
    } catch {
      // Shown even if it can't be kept.
    }
  }
  return got;
}

export function recipientBlock(r) {
  const profile = `https://www.usaspending.gov/recipient/${encodeURIComponent(r.id)}/latest`;
  const rows = r.years
    .map((y) => `<details class="weigh-details"><summary>Fiscal year ${y.fy} · ${y.total ? money(y.total) : "none reported"}</summary>${
      y.agencies.length
        ? `<ul class="plain-list money-list">${y.agencies.map((a) => `<li class="money-row"><div class="money-name">${esc(a.name)}</div><div class="money-amt">${money(a.amount)}</div></li>`).join("")}</ul>`
        : '<p class="small secondary">No contracts or grants obligated in this fiscal year.</p>'
    }</details>`)
    .join("");
  return `<section class="card stack-sm">
  <h3>${esc(r.name)}</h3>
  <p class="small secondary">${[r.location, r.uei ? `UEI ${esc(r.uei)}` : "", r.level === "P" ? "Parent organization (includes its subsidiaries' awards)" : ""].filter(Boolean).map(esc).join(" · ")}</p>
  ${rows}
  <p class="hint"><a class="tap" href="${esc(profile)}" target="_blank" rel="noopener">Every award at USAspending.gov ↗</a></p>
</section>`;
}

async function render(env, url) {
  const name = (url.searchParams.get("name") || "").trim().slice(0, 200);
  const intro = `<header class="page-head"><p class="label">Federal awards</p><h1>${name ? esc(name) : "Federal awards"}</h1></header>`;
  const note = `<p class="hint">Contracts and grants: federal money obligated to each recipient, by awarding agency and fiscal year (October to September), as agencies report it to USAspending.gov. Loans and other assistance are included where agencies report them as awards. Only recipients with exactly this name are shown, each separately, since organizations in different places can share a name. Refreshed weekly. <a class="tap" href="${HOW}">How this works</a></p>`;
  if (nameKey(name).length < 3) {
    return page("Federal awards", `${intro}<p class="small">Open this page from an organization's "Federal awards" link.</p>${note}`, { tab: "reps", back: ["Reps", "/reps/"] });
  }
  let got;
  try {
    got = await cached(env.DB, name);
  } catch (err) {
    console.error("awards", err && err.message);
    return page(`Federal awards: ${name}`, `${intro}<p class="small">Couldn't reach USAspending.gov just now. <a class="inline-link" href="https://www.usaspending.gov/search" target="_blank" rel="noopener">Search USAspending.gov ↗</a></p>${note}`, { tab: "reps", back: ["Reps", "/reps/"], partial: true });
  }
  const body = got.recipients.length
    ? `${got.total_found > got.recipients.length ? `<p class="small">USAspending lists ${got.total_found} recipients with this exact name; the ${got.recipients.length} shown are ${got.recipients.some((r) => r.level === "P") ? "the parent organizations" : "the first listed"}.</p>` : got.recipients.length > 1 ? `<p class="small">USAspending lists ${got.recipients.length} recipients with this exact name. They may be different organizations.</p>` : ""}${got.recipients.map(recipientBlock).join("")}`
    : `<p class="small">No recipient with exactly this name in USAspending.gov. An organization can receive awards under a different legal name. <a class="inline-link" href="https://www.usaspending.gov/search" target="_blank" rel="noopener">Search USAspending.gov ↗</a></p>`;
  return page(`Federal awards: ${name}`, `${intro}${body}${note}`, { tab: "reps", back: ["Reps", "/reps/"] });
}

export const onRequestGet = guard((context) => edgeCached(context, 300, () => render(context.env, new URL(context.request.url))), { tab: "reps" });
