// /awards/?name=…: an organization's federal contracts and grants, from
// USAspending.gov, behind the "Federal awards" link on organization lines
// (lobbying clients and givers, donors' employers, super PAC donors, earmark
// recipients). Cloudflare's servers can't reach USAspending, so the lookups run
// daily in GitHub Actions (tools/load_gov_money.py awards, tools/usaspending.py)
// and this page reads only what they stored (federal_awards_cache). An
// organization not looked up yet is queued (federal_awards_wanted) and looked up
// first on the next run. Shown as facts on their own: never tied in words to a
// vote, a contribution or lobbying (docs/funding.md).
import { page, esc, guard, edgeCached, fmtDate } from "../_lib/render.js";
import { HOW } from "../_lib/gov-money.js";

// A negative amount is money taken back (a deobligation), as agencies report it.
const money = (n) => {
  const v = Math.round(Number(n || 0));
  return `${v < 0 ? "−" : ""}$${Math.abs(v).toLocaleString("en-US")}`;
};
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

/** An organization's name for exact matching: lowercase, no punctuation or "Inc."/"The". The same rule as name_key() in tools/usaspending.py. */
export function nameKey(name) {
  const words = String(name || "").toLowerCase().replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  return words.filter((w) => !["the", "inc", "incorporated", "llc", "corp", "corporation", "co", "ltd"].includes(w)).join(" ");
}

/** The stored lookup for this name: {result, fetched_at}, or {queued: true} after adding it to the queue; null without the tables. */
export async function storedAwards(db, name) {
  const key = nameKey(name);
  try {
    const row = await db.prepare("SELECT result, fetched_at FROM federal_awards_cache WHERE name_key = ?").bind(key).first();
    if (row) return { result: JSON.parse(row.result), fetched_at: row.fetched_at };
    await db.prepare("INSERT OR IGNORE INTO federal_awards_wanted (name_key, name) VALUES (?, ?)").bind(key, name).run();
    return { queued: true };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
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
  const name = (url.searchParams.get("name") || "").trim().replace(/\s+/g, " ").slice(0, 200);
  const intro = `<header class="page-head"><p class="label">Federal awards</p><h1>${name ? esc(name) : "Federal awards"}</h1></header>`;
  const note = (checked) =>
    `<p class="hint">Contracts and grants: federal money obligated to each recipient, by awarding agency and fiscal year (October to September), as agencies report it to USAspending.gov. Only recipients with exactly this name are shown, each separately, since organizations in different places can share a name.${checked ? ` Looked up ${esc(fmtDate(checked))}; looked up again monthly.` : ""} <a class="tap" href="${HOW}">How this works</a></p>`;
  const opts = { tab: "reps", back: ["Reps", "/reps/"] };
  if (nameKey(name).length < 3) return page("Federal awards", `${intro}<p class="small">Open this page from an organization's "Federal awards" link.</p>${note()}`, opts);
  const got = env.DB ? await storedAwards(env.DB, name) : null;
  const search = `<a class="inline-link" href="https://www.usaspending.gov/search" target="_blank" rel="noopener">Search USAspending.gov ↗</a>`;
  if (!got || got.queued) {
    // Not kept at the edge, so the page shows the result as soon as it's stored.
    const res = page(`Federal awards: ${name}`, `${intro}<p class="small">This organization's federal awards haven't been looked up yet. They're looked up from USAspending.gov once a day, and this one is now near the front of the line: check back tomorrow. ${search}</p>${note()}`, opts);
    res.headers.set("Cache-Control", "no-store");
    return res;
  }
  const r = got.result;
  const body = r.recipients.length
    ? `${r.total_found > r.recipients.length ? `<p class="small">USAspending lists ${r.total_found} organizations with exactly this name; ${r.recipients.length === 1 ? "the one with the most federal money is shown" : `the ${r.recipients.length} with the most federal money are shown`}.</p>` : r.recipients.length > 1 ? `<p class="small">USAspending lists ${r.recipients.length} organizations with exactly this name. They may be different organizations.</p>` : ""}${r.recipients.map(recipientBlock).join("")}`
    : `<p class="small">No recipient with exactly this name in USAspending.gov. An organization can receive awards under a different legal name. ${search}</p>`;
  return page(`Federal awards: ${name}`, `${intro}${body}${note(r.checked || String(got.fetched_at).slice(0, 10))}`, opts);
}

export const onRequestGet = guard((context) => edgeCached(context, 300, () => render(context.env, new URL(context.request.url))), { tab: "reps" });
