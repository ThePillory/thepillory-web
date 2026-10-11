// /trades/: the latest stock trades reported by members of Congress (STOCK Act
// Periodic Transaction Reports; docs/trades.md), newest first, filterable by
// chamber, state, sector and member. Ordered only by date. "Load more" appends
// the next 25 in place. These records may not be used for commercial purposes:
// no export, no API.
import { page, notFound, notLoaded, esc, loadSection, FAILED, sectionError, guard, edgeCached } from "../_lib/render.js";
import { STATE_NAME } from "../_lib/districts.js";
import { latestTrades, tradeFilters, tradesHref, tradeRow, SECTORS, TRADES_PER_PAGE, TRADES_METHOD } from "../_lib/trades.js";

const CHAMBERS = [["", "Congress"], ["us-house", "House"], ["us-senate", "Senate"]];

function filtersForm(f) {
  const opt = (v, label, cur) => `<option value="${esc(v)}"${v === cur ? " selected" : ""}>${esc(label)}</option>`;
  const states = Object.entries(STATE_NAME).sort((a, b) => a[1].localeCompare(b[1]));
  return `
<nav class="segmented" aria-label="Chamber">${CHAMBERS.map(([k, label]) => `<a class="toggle" href="${esc(tradesHref({ ...f, chamber: k }))}"${k === f.chamber ? ' aria-current="true"' : ""}>${label}</a>`).join("")}</nav>
<form class="card stack-sm trade-filters" method="get" action="/trades/">
  ${f.chamber ? `<input type="hidden" name="chamber" value="${esc(f.chamber)}" />` : ""}
  <label class="label" for="trade-state">State</label>
  <select class="input" id="trade-state" name="state" data-autosubmit>${opt("", "Every state", f.state)}${states.map(([c, n]) => opt(c, n, f.state)).join("")}</select>
  <label class="label" for="trade-sector">Sector</label>
  <select class="input" id="trade-sector" name="sector" data-autosubmit>${opt("", "Every sector", f.sector)}${SECTORS.map((s) => opt(s, s, f.sector)).join("")}</select>
  <label class="label" for="trade-q">Member</label>
  <div class="lookup-row">
    <input class="input" id="trade-q" name="q" type="search" value="${esc(f.q)}" placeholder="A member's name" autocomplete="off" />
    <button class="btn btn--primary" type="submit">Show</button>
  </div>
</form>`;
}

async function index(env, url) {
  if (!env.DB) return notLoaded("Stock trades", "reps", true);
  const f = tradeFilters(url.searchParams);
  const list = await loadSection("trades list", () => latestTrades(env.DB, f));
  const rows = list === FAILED
    ? sectionError("")
    : `<div class="card compact-list" id="trade-list">${list.rows.map((t) => tradeRow(t, { member: true })).join("") || `<p class="secondary small cr-empty">${list.missing ? "Stock trades load daily from the House Clerk and the Senate; none are loaded yet." : "No trades match these filters."}</p>`}</div>`;
  const more = list !== FAILED && list.more ? `<a class="btn btn--block load-more" href="${esc(tradesHref(f, f.offset + TRADES_PER_PAGE))}" data-load-more="trade-list">Load more</a>` : "";
  if (f.offset) {
    const main = `<header class="page-head"><h1>Stock trades</h1><p class="subtitle">From number ${f.offset + 1}, newest first.</p></header>${rows}${more}`;
    return page("Stock trades", main, { tab: "reps", back: ["Stock trades", tradesHref(f)], partial: list === FAILED });
  }
  const main = `
<header class="page-head">
  <h1>Stock trades</h1>
  <p class="subtitle">Trades members of Congress report under the STOCK Act, newest first. Each line links to the filed report.</p>
</header>
${filtersForm(f)}
${rows}
${more}
<section class="card stack-sm">
  <p class="label">How to read these</p>
  <p class="small">Amounts are ranges, as the law requires them to be reported, shown exactly as filed. Members must report a trade within 45 days; when a report came later, the line says how many days after the trade it was filed. Owner is as filed: the member, a spouse, a joint account, or a dependent child. Family members are never named.</p>
  <p class="small">Some reports are filed on paper. Those are linked on each member's page, not read line by line.</p>
  <p class="small">These records may not be used for commercial purposes (Ethics in Government Act). <a class="inline-link" href="${TRADES_METHOD}">How trades are recorded</a></p>
</section>`;
  return page("Stock trades", main, { tab: "reps", back: ["Reps", "/reps/"], partial: list === FAILED });
}

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length) return notFound("No page at this address.", "reps", ["Stock trades", "/trades/"]);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  return edgeCached(context, 300, () => index(context.env, url));
}, { tab: "reps" });
