// /taxes/wealth/: who holds household wealth, from the Federal Reserve's Distributional
// Financial Accounts (docs/taxes.md). data/taxes/wealth.json (tools/build_wealth.py,
// weekly): five separate groups of households by net worth, each group's share of all
// household net worth as the Fed computes it, its households and its net worth, by
// quarter since 1989. Facts as published: no conclusions, no person named, no rankings.
import { esc, sourceLink } from "./render.js";
import { asset } from "./geo.js";
import { miniBars } from "./charts.js";
import { TAXES_METHOD } from "./taxes.js";
import { shortCount, shortDollars } from "./taxpayers.js";

export const loadWealth = (env, request) => asset(env, request, "/data/taxes/wealth.json");

const pct = (v, d = 1) => (v == null ? "Not published" : `${Number(v).toFixed(d)}%`);
const table = (head, rows) =>
  `<div class="table-scroll"><table class="usage-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const tr = (cells) => `<tr>${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`;
const quarterName = (q) => String(q || "").replace(":", " ");

// What the Fed's net worth counts and leaves out: fixed text, the same for every visitor.
export const COUNTS = [
  "Net worth is everything a household owns minus everything it owes.",
  "Counted: homes, cars and other durable goods, businesses, stocks and mutual funds at market value (including gains not yet sold), deposits, and retirement accounts and pensions.",
  "Subtracted: mortgages, credit card, student and car loans, and other debts.",
  "Not counted: future Social Security benefits.",
];

/**
 * The latest quarter's groups with each one's share of households, average net worth,
 * and a Total row. Pure; tested.
 */
export function wealthRows(d) {
  const groups = d.groups || [];
  const households = groups.reduce((t, g) => t + (g.households || 0), 0);
  const rows = groups.map((g) => ({
    ...g,
    household_share: households ? (100 * g.households) / households : null,
    average: g.households ? g.net_worth / g.households : null,
  }));
  const netWorth = groups.reduce((t, g) => t + (g.net_worth || 0), 0);
  const total = { id: "total", label: "Total", households, household_share: rows.reduce((t, r) => t + (r.household_share || 0), 0), share: groups.reduce((t, g) => t + (g.share || 0), 0), net_worth: netWorth, average: households ? netWorth / households : null };
  return { rows, total };
}

/** The last quarter of each year (the latest quarter for the current year), for the charts. */
function yearly(series) {
  const byYear = new Map();
  for (const s of series || []) byYear.set(String(s.quarter).slice(0, 4), s);
  return [...byYear.entries()].map(([year, s]) => ({ year, ...s }));
}

function countsSection() {
  return `<section class="card stack-sm" id="what-counts">
  <h2 class="h3">What this counts</h2>
  <ul class="simple-list">${COUNTS.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
  <p class="small secondary">Wealth includes gains on assets that haven't been sold; taxable income doesn't. The same household can be in a different group here than in the income tables on Taxpayers.</p>
</section>`;
}

function groupsSection(d) {
  const { rows, total } = wealthRows(d);
  // Each group's share of households is in its name (the top 0.1% is 0.1% of households), so it isn't a column.
  const body = [...rows, total].map((r) => tr([esc(r.label), esc(shortCount(r.households)), esc(pct(r.share)), esc(shortDollars(r.average))]));
  return `<section class="card stack-sm" id="groups">
  <h2 class="h3">Household wealth, by wealth group (${esc(quarterName(d.latest))})</h2>
  <p class="small">U.S. households, grouped by net worth.</p>
  ${table(["Group", "Households", "Share of wealth", "Average net worth"], body)}
  <p class="small">Each row is a separate group; the rows add up to all households.</p>
  <p class="xsmall secondary">Share of wealth is the group's share of all household net worth, as the Federal Reserve computes it. Each group's name is its share of households (the top 0.1% is 0.1% of all households). Average net worth is the group's net worth divided by its households, computed by ThePillory from the Fed's figures. Households and dollar amounts are rounded (M is millions, K thousands); the exact figures are in the Fed's tables. ${sourceLink(d.source_url, "Federal Reserve, Distributional Financial Accounts")}</p>
</section>`;
}

function trendSection(d) {
  const years = yearly(d.series);
  if (years.length < 2) return "";
  const last = years[years.length - 1];
  // A label every five years and on the last, skipping a five-year label too close to the last to fit.
  const tick = (y) => (y === last.year || (Number(y) % 5 === 0 && Number(last.year) - Number(y) >= 3) ? `'${y.slice(2)}` : "");
  const chart = (label, value) =>
    miniBars(years.map((s) => ({ label: s.year, tick: tick(s.year), value: value(s.shares) })), {
      format: (v) => pct(v),
      head: ["Year", `${label}: share of wealth`],
      caption: `${label} of households: share of all household net worth, ${years[0].year}–${last.year} (each year's last quarter; ${quarterName(last.quarter)} for ${last.year}).`,
      ariaLabel: `${label} of households: share of all household net worth by year`,
    });
  return `<section class="card stack-sm" id="over-time">
  <h2 class="h3">Share of wealth over time</h2>
  ${chart("Top 1%", (s) => (s["top-0.1"] ?? 0) + (s["next-0.9"] ?? 0))}
  ${chart("Bottom 50%", (s) => s["bottom-50"])}
  <p class="xsmall secondary">The top 1% is the top 0.1% and the next 0.9% added together. ${sourceLink(d.source_url, "Federal Reserve, Distributional Financial Accounts")}</p>
</section>`;
}

function scfSection(d) {
  return `<section class="card stack-sm" id="scf">
  <h2 class="h3">Another measure</h2>
  <p class="small">The Federal Reserve's Survey of Consumer Finances asks a sample of households about their wealth every three years. It measures some things differently, so its figures for the same groups differ somewhat from these.</p>
  <p>${sourceLink(d.scf_url, "Federal Reserve, Survey of Consumer Finances")}</p>
</section>`;
}

/** The page's main content. */
export function wealthMain(d, switcher) {
  const head = `<header class="page-head">
  <h1>Taxes</h1>
  <p class="subtitle">Who holds household wealth, by wealth group, from the Federal Reserve's own accounts.</p>
</header>
${switcher}`;
  if (!d || !d.groups) return `${head}<section class="card"><p class="small secondary">These figures load weekly from the Federal Reserve. They aren't loaded yet.</p></section>`;
  return `${head}
${countsSection()}
${groupsSection(d)}
${trendSection(d)}
${scfSection(d)}
<section class="card stack-sm">
  <p class="label">About these figures</p>
  <p class="small">The figures are as the Federal Reserve publishes them, updated each quarter. They describe who held what; they don't say what anyone should hold. Households are counted, never named. <a class="inline-link" href="${TAXES_METHOD}">How this works</a></p>
</section>`;
}
