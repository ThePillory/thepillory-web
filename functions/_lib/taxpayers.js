// /taxes/taxpayers/: who pays taxes, from official tables only (docs/taxes.md).
// data/taxes/taxpayers.json (tools/build_taxpayers.py, weekly): the IRS's shares of
// adjusted gross income and of total income tax by income percentile (as the IRS
// computes them), the IRS's top 400 returns (its last edition, 1992-2014), and
// California's personal income tax by AGI class (the Franchise Tax Board). The
// Congressional Budget Office's report is linked. Facts as published: no
// conclusions about who should pay what, and no person is named.
import { esc, sourceLink } from "./render.js";
import { asset } from "./geo.js";
import { pairBars, miniBars } from "./charts.js";
import { money, TAXES_METHOD } from "./taxes.js";

export const loadTaxpayers = (env, request) => asset(env, request, "/data/taxes/taxpayers.json");

const SHOWN = ["top-0.001", "top-0.01", "top-0.1", "top-1", "top-5", "top-10", "top-25", "top-50", "bottom-50"];
// Long series: a year label every five years and on the last, so they don't run together.
const tick = (y, last) => (Number(y) % 5 === 0 || String(y) === String(last) ? `'${String(y).slice(2)}` : "");
const pct = (v, d = 1) => (v == null ? "Not published" : `${Number(v).toFixed(d)}%`);
// Short forms for the two tables, so they fit a phone: 77.0M or 1,534 returns; $663K, $10.0M, $120.4B.
// The exact figures are in the linked sources.
export const shortCount = (v) => (v == null ? "Not published" : Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : Math.round(v).toLocaleString("en-US"));
export function shortDollars(v) {
  if (v == null) return "Not published";
  const a = Math.abs(v);
  const sign = v < 0 ? "-" : "";
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${sign}$${Math.round(a / 1e3)}K`;
  if (a >= 1e3) return `${sign}$${(a / 1e3).toFixed(1)}K`;
  return `${sign}$${Math.round(a).toLocaleString("en-US")}`;
}
const table = (head, rows) =>
  `<div class="table-scroll"><table class="usage-table"><thead><tr>${head.map((h) => `<th scope="col">${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
const tr = (cells) => `<tr>${cells.map((c, i) => (i === 0 ? `<th scope="row">${c}</th>` : `<td>${c}</td>`)).join("")}</tr>`;

function irsSection(irs) {
  if (!irs || !irs.groups) return `<section class="card stack-sm"><h2 class="h3">Federal income tax, by income group</h2><p class="small secondary">The IRS's tables aren't loaded yet.</p></section>`;
  const year = String(irs.years[1]);
  const g = Object.fromEntries(irs.groups.map((x) => [x.id, x]));
  const rows = SHOWN.filter((id) => g[id]).map((id) => {
    const x = g[id];
    return tr([esc(x.label), esc(shortCount(x.returns[year])), esc(x.floor[year] == null ? "—" : shortDollars(x.floor[year])), esc(pct(x.agi_share[year])), esc(pct(x.tax_share[year]))]);
  });
  const years = Object.keys(g["top-1"].tax_share).sort();
  const series = (id) =>
    pairBars(
      years.map((y) => ({ label: y, tick: tick(y, years[years.length - 1]), a: g[id].agi_share[y] ?? null, b: g[id].tax_share[y] ?? null })),
      { series: ["Share of adjusted gross income", "Share of total income tax"], format: (v) => pct(v, 2), head: "Tax year", ariaLabel: `${g[id].label}: shares of income and of income tax by year`, caption: `${esc(g[id].label)} of returns, ${years[0]}–${years[years.length - 1]}.` }
    );
  return `<section class="card stack-sm" id="irs">
  <h2 class="h3">Federal income tax, by income group (tax year ${esc(year)})</h2>
  <p class="small">Individual income tax returns, grouped by adjusted gross income (AGI). Each top group includes the ones above it: the top 10 percent includes the top 1 percent.</p>
  ${table(["Group", "Returns", "AGI at least", "Share of income", "Share of tax"], rows)}
  <p class="xsmall secondary">Share of income is each group's share of all AGI on every return; share of tax is its share of all federal income tax, after credits. Both as the IRS computes them. Returns and dollar amounts are rounded (M is millions, K thousands); the exact figures are in the IRS's tables. Federal income tax only: payroll, excise, estate and state taxes aren't in these tables. Returns of dependents aren't counted. ${sourceLink(irs.source_url, "IRS Statistics of Income, Tables 4.1 and 4.2")}</p>
  ${series("top-1")}
  ${series("bottom-50")}
</section>`;
}

function top400Section(t) {
  if (!t || !t.rows || !t.rows.length) return "";
  const last = t.rows[t.rows.length - 1];
  const chart = miniBars(t.rows.map((r) => ({ label: String(r.year), tick: tick(r.year, last.year), value: r.agi_share })), {
    format: (v) => pct(v, 2), head: ["Tax year", "Top 400's share of all AGI"], caption: `The 400 returns with the largest AGI each year: their share of all AGI, ${t.rows[0].year}–${last.year}.`, ariaLabel: "The top 400 returns' share of all adjusted gross income by year",
  });
  return `<section class="card stack-sm" id="top-400">
  <h2 class="h3">The 400 returns with the largest incomes</h2>
  <dl class="kv kv--tight">
    <div class="kv-row"><dt>Tax year</dt><dd>${esc(String(last.year))} (the IRS's latest edition of this series)</dd></div>
    <div class="kv-row"><dt>AGI to be among them, at least</dt><dd>${esc(money(last.cutoff))}</dd></div>
    <div class="kv-row"><dt>Their average AGI</dt><dd>${esc(money(last.agi_average))}</dd></div>
    <div class="kv-row"><dt>Their share of all AGI</dt><dd>${esc(pct(last.agi_share, 2))}</dd></div>
  </dl>
  ${chart}
  <p class="xsmall secondary">The group changes from year to year: these are the 400 largest that year, not the same people. Since 2014 the IRS has published the top 0.001 percent of returns (about 1,500) in its percentile tables instead, shown above. The report also lists the group's income tax, deductions and credits. ${sourceLink(t.source_url, "IRS, the 400 returns with the largest AGI, 1992–2014")}</p>
</section>`;
}

function ftbSection(f) {
  if (!f || !f.bands) return "";
  const rows = f.bands.map((b) =>
    tr([esc(b.label), esc(shortCount(b.returns)), esc(pct((100 * b.returns) / f.total.returns)), esc(shortDollars(b.tax)), esc(pct((100 * b.tax) / f.total.tax))])
  );
  rows.push(tr(["All returns", esc(shortCount(f.total.returns)), "100%", esc(shortDollars(f.total.tax)), "100%"]));
  return `<section class="card stack-sm" id="california">
  <h2 class="h3">California personal income tax (tax year ${esc(String(f.year))})</h2>
  <p class="small">California residents' returns, all filing statuses, by California adjusted gross income.</p>
  ${table(["AGI", "Returns", "Share of returns", "Tax", "Share of tax"], rows)}
  <p class="xsmall secondary">Tax is total California tax liability. Share of returns is each band's share of all resident returns; share of tax is its share of all California personal income tax liability. Returns and dollar amounts are rounded (M is millions, K thousands, B billions); the exact figures are in the FTB's table. From the Franchise Tax Board's table B-4A. ThePillory added its ${esc(String(f.classes))} income classes up into these bands and computed the shares from its figures. ${sourceLink(f.source_url, "Franchise Tax Board, table B-4A (data.ca.gov)")}</p>
</section>`;
}

function cboSection(c) {
  if (!c) return "";
  return `<section class="card stack-sm" id="cbo">
  <h2 class="h3">All federal taxes, by household income</h2>
  <p class="small">The Congressional Budget Office estimates every federal tax a household pays, income, payroll, corporate and excise taxes, by income group: ${esc(c.title)}.</p>
  <p class="small secondary">${esc(c.note)}</p>
  <p>${sourceLink(c.source_url, `CBO, ${c.title}`)}</p>
</section>`;
}

// What the tables leave out: fixed text, the same for every visitor (docs/taxes.md).
export const NOT_COUNTED = [
  "“Income” here is what’s reported on tax returns. It leaves out the growth of stocks and other assets that haven’t been sold, which is where most of the largest fortunes grow, and gains erased for tax purposes when assets pass to heirs at death. Borrowing against assets isn’t income either.",
  "These tables are federal income tax only. They leave out payroll taxes (paid mostly on wages), corporate income tax (borne partly by shareholders), estate and gift taxes, and state and local sales, gas and property taxes.",
  "They leave out government benefits received and tax-free employer health and retirement benefits.",
  "Taxes owed but not paid aren’t in them.",
];

function notCountedSection() {
  return `<section class="card stack-sm" id="not-counted">
  <h2 class="h3">What these numbers don’t count</h2>
  <ul class="simple-list">${NOT_COUNTED.map((t) => `<li>${esc(t)}</li>`).join("")}</ul>
  <p class="small secondary">Different measures give different rates for the same group. Each table below says what it counts.</p>
</section>`;
}

// One estimate that counts unsold gains as income: its figure, its source, its method and the
// main criticism of that method, of similar length. Not official tax data, and labeled so.
export const UNSOLD_GAINS = {
  rate: "8.2%",
  years: "2010–2018",
  source_url: "https://bidenwhitehouse.archives.gov/cea/written-materials/2021/09/23/what-is-the-average-federal-individual-income-tax-rate-on-the-wealthiest-americans/",
  source: "White House Council of Economic Advisers and Office of Management and Budget, 2021",
  method: "Method: it counts each year’s growth in the value of unsold stocks and other assets as income, and divides federal individual income tax paid by that total.",
  criticism: "Main criticism: unsold gains can fall, and are taxed when sold or passed on, so counting them as income overstates what goes untaxed.",
};

function unsoldGainsSection() {
  const u = UNSOLD_GAINS;
  return `<section class="card stack-sm" id="unsold-gains">
  <h2 class="h3">Counting unsold gains: one estimate</h2>
  <p><span class="chip chip--gray chip--sm">An estimate, not official tax data</span></p>
  <p>The 400 wealthiest families’ average federal individual income tax rate was ${esc(u.rate)} of their income, counting unsold gains as income, over ${esc(u.years)}, according to a 2021 analysis by the White House Council of Economic Advisers and the Office of Management and Budget.</p>
  <ul class="simple-list"><li>${esc(u.method)}</li><li>${esc(u.criticism)}</li></ul>
  <p class="xsmall secondary">These are the families with the most wealth, not the 400 returns with the largest reported incomes above. ${sourceLink(u.source_url, u.source)}</p>
</section>`;
}

/** The page's main content. */
export function taxpayersMain(d, switcher) {
  const head = `<header class="page-head">
  <h1>Taxes</h1>
  <p class="subtitle">Who pays federal and California income taxes, by income, from the IRS's and the Franchise Tax Board's own tables.</p>
</header>
${switcher}`;
  if (!d) return `${head}<section class="card"><p class="small secondary">These tables load weekly from the IRS and the Franchise Tax Board. They aren't loaded yet.</p></section>`;
  return `${head}
${notCountedSection()}
${irsSection(d.irs)}
${top400Section(d.top400)}
${unsoldGainsSection()}
${cboSection(d.cbo)}
${ftbSection(d.ftb)}
<section class="card stack-sm">
  <p class="label">About these tables</p>
  <p class="small">The figures are as each agency publishes them. They describe who paid what in a year; they don't say what anyone should pay. Returns are counted, never people's names. <a class="inline-link" href="${TAXES_METHOD}">How this works</a></p>
</section>`;
}
