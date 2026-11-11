// /taxes/: who pays taxes, and what companies report paying (docs/taxes.md).
//   /taxes/                  → /taxes/taxpayers/ (the section's first view)
//   /taxes/taxpayers/        Taxpayers: shares of income and income tax by income
//                            group (IRS Statistics of Income, the Congressional Budget
//                            Office, California's Franchise Tax Board)
//   /taxes/wealth/           Wealth: who holds household wealth, by wealth group (the
//                            Federal Reserve's Distributional Financial Accounts)
//   /taxes/companies/        Corporations: every company filing a 10-K, by name, revenue
//                            or profit before taxes (functions/_lib/taxes.js)
//   /taxes/companies/<cik>/  one company
// A Taxpayers | Wealth | Corporations switch at the top of each, like Laws'. The same for
// every visitor, so kept at the edge for five minutes.
import { page, notFound, notLoaded, esc, guard, edgeCached, loadSection, FAILED, sectionError } from "../_lib/render.js";
import { loadCompany, listCompanies, listFilters, listHref, listForm, industries, loadedAt, companyRow, companyMain, taxesSwitch, READING, PER_PAGE, TAXES_METHOD, loadLaws, lawsSection } from "../_lib/taxes.js";
import { fold } from "../_lib/summary.js";
import { loadTaxpayers, taxpayersMain } from "../_lib/taxpayers.js";
import { loadWealth, wealthMain } from "../_lib/wealth.js";

const CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  const parts = (context.params.path || []).filter(Boolean);
  if (!parts.length) return Response.redirect(`${url.origin}/taxes/taxpayers/`, 302);
  if (parts.length === 1 && parts[0] === "taxpayers") return edgeCached(context, CACHE_SECONDS, () => taxpayers(context.env, context.request));
  if (parts.length === 1 && parts[0] === "wealth") return edgeCached(context, CACHE_SECONDS, () => wealth(context.env, context.request));
  if (parts.length === 1 && parts[0] === "companies") return edgeCached(context, CACHE_SECONDS, () => companies(context.env, url, context.request));
  if (parts.length === 2 && parts[0] === "companies" && /^\d{1,10}$/.test(parts[1])) {
    if (String(Number(parts[1])) !== parts[1]) return Response.redirect(`${url.origin}/taxes/companies/${Number(parts[1])}/`, 301);
    return edgeCached(context, CACHE_SECONDS, () => company(context.env, Number(parts[1]), context.request));
  }
  return notFound("No page at this address.", "laws", ["Taxes", "/taxes/"]);
}, { tab: "laws" });

async function taxpayers(env, request) {
  const data = await loadSection("taxpayers data", () => loadTaxpayers(env, request), null);
  const main = `${taxpayersMain(data === FAILED ? null : data, taxesSwitch("taxpayers"))}`;
  return page("Taxes: who pays", main, { tab: "laws", back: ["Laws", "/laws/"], partial: data === FAILED });
}

async function wealth(env, request) {
  const data = await loadSection("wealth data", () => loadWealth(env, request), null);
  const main = wealthMain(data === FAILED ? null : data, taxesSwitch("wealth"));
  return page("Taxes: who holds wealth", main, { tab: "laws", back: ["Laws", "/laws/"], partial: data === FAILED });
}

async function companies(env, url, request) {
  if (!env.DB) return notLoaded("Taxes: corporations", "laws", false, ["Laws", "/laws/"]);
  const f = listFilters(url.searchParams);
  const [list, inds, at] = await Promise.all([
    loadSection("companies list", () => listCompanies(env.DB, f)),
    loadSection("companies industries", () => industries(env.DB), []),
    loadSection("companies loaded", () => loadedAt(env.DB), null),
  ]);
  const laws = await loadLaws(env, request);
  const empty = list && list !== FAILED && !list.rows.length;
  const rows = list === FAILED
    ? sectionError("")
    : `<section class="card compact-list" id="company-list" data-more-list>${list && list.rows.length ? list.rows.map(companyRow).join("") : `<p class="secondary small cr-empty">${!list || (empty && !at) ? "Company figures load weekly from the SEC's EDGAR filings; none are loaded yet." : "No companies match these filters. Only the largest companies by revenue are loaded."}</p>`}</section>`;
  const more = list && list !== FAILED && list.more ? `<a class="btn btn--block load-more" href="${esc(listHref(f, f.offset + PER_PAGE))}" data-load-more="company-list">Load more</a>` : "";
  if (f.offset) {
    const main = `<div class="tax-page"><header class="page-head"><h1>Corporations</h1><p class="subtitle">From number ${f.offset + 1}.</p></header>${rows}${more}</div>`;
    return page("Taxes: corporations", main, { tab: "laws", back: ["Corporations", listHref(f)], partial: list === FAILED });
  }
  const about = fold(
    "about",
    "About this list",
    `<p class="small">${at && at !== FAILED ? `The ${esc(String(at.n))} largest` : "The largest"} companies by revenue in their latest fiscal year that file a 10-K with the SEC and tag these values in their financial data, ordered by name, revenue or profit before taxes, as you choose. It isn't ordered or labeled by taxes paid or by any rate. Revenue and profit before taxes are for each company's latest fiscal year with figures.</p>
  ${READING}
  <p class="small">State is the company's business address as EDGAR lists it. ${at && at !== FAILED ? `Loaded ${esc(String(at.at).slice(0, 10))}.` : ""} <a class="inline-link" href="${TAXES_METHOD}">How this works ›</a></p>`
  );
  const main = `<div class="tax-page">
<header class="page-head">
  <h1>Taxes</h1>
  <p class="subtitle">What the largest companies report paying in income taxes, and their profit before taxes, from their 10-K filings with the SEC.</p>
</header>
${taxesSwitch("companies")}
${listForm(f, inds === FAILED ? [] : inds)}
${rows}
${more}
${lawsSection(laws)}
${about}
</div>`;
  return page("Taxes: corporations", main, { tab: "laws", back: ["Laws", "/laws/"], partial: list === FAILED });
}

async function company(env, cik, request) {
  if (!env.DB) return notLoaded("Company taxes", "laws", false, ["Corporations", "/taxes/companies/"]);
  const data = await loadCompany(env.DB, cik);
  if (!data) return notFound("No company with this number is loaded. Company figures load weekly from EDGAR.", "laws", ["Corporations", "/taxes/companies/"]);
  const laws = await loadLaws(env, request);
  return page(`${data.company.name}: taxes`, companyMain({ ...data, laws }), { tab: "laws", back: ["Corporations", "/taxes/companies/"] });
}
