// node --test test/taxes.test.mjs
// The Taxes section (docs/taxes.md): /taxes/ and its Taxpayers | Corporations switch,
// the company page (latest year, chart, split, every number linked to its filing,
// "Reading these numbers", the same organization's other records), the list (search,
// filters, sorted by name, revenue or pretax income only), the line on organization
// panels (exact name, one company only), the wording rules, and the old address's 301.
// Every company, filing and number here is FAKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequestGet as taxesRoute } from "../../../functions/taxes/[[path]].js";
import { onRequestGet as financesRoute } from "../../../functions/finances/[[path]].js";
import { loadCompany, companyMain, listCompanies, listFilters, listHref, SORTS, READING, taxMarker, markersIn, taxInfo, fillTaxLines, filingUrl, fiscalYear, taxesSwitch, LABELS, FILING_TERMS, NOTES, RATE_NOTE, shareOfProfit, shareText, multiYear, leadSentence, yearsWords, companyRow, taxLine } from "../../../functions/_lib/taxes.js";
import { wealthMain, wealthRows, COUNTS } from "../../../functions/_lib/wealth.js";
import { taxpayersMain, shortCount, shortDollars, NOT_COUNTED, UNSOLD_GAINS, irsSlices } from "../../../functions/_lib/taxpayers.js";
import { checkQuery } from "../../../functions/_lib/crawl.js";

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds), meta: {} }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => ({ meta: { changes: Number(sqlite.prepare(sql).run(...binds).changes) } }),
  });
  return { prepare: (sql) => stmt(sql), batch: async (l) => Promise.all(l.map((s) => s.run())) };
}

const A = "0000000001-26-000010";
const A24 = "0000000001-25-000011";
function db() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0047_company_taxes.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    INSERT INTO companies (cik, name, name_key, tickers, sic, sic_desc, state, fy_end, latest_end, latest_fy, revenue, pretax, taxes_paid, source_url) VALUES
      (1, 'Example Retail Inc', 'example retail', 'EXR', '5331', 'Retail-Variety Stores', 'TX', '0131', '2026-01-31', 2025, 900000000, 40000000, 9000000, 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000001&type=10-K'),
      (2, 'Alpha Devices Corp', 'alpha devices', 'ALD,ALDB', '3571', 'Electronic Computers', 'CA', '1231', '2025-12-31', 2025, 50000000, 70000000, 0, 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0000000002&type=10-K'),
      (3, 'Twin Co', 'twin', NULL, '3571', 'Electronic Computers', 'CA', '1231', '2025-12-31', 2025, 10, 5, 1, 'https://www.sec.gov/x'),
      (4, 'Twin Corp', 'twin', NULL, '3571', 'Electronic Computers', 'NY', '1231', '2025-12-31', 2025, 20, 6, 1, 'https://www.sec.gov/x');
    INSERT INTO company_tax_years (cik, period_end, period_start, fy, taxes_paid, paid_federal, paid_state, paid_foreign, current_federal, current_state, deferred, pretax, pretax_tag, pretax_us, pretax_foreign, revenue, revenue_tag, src) VALUES
      (1, '2025-02-01', '2024-02-04', 2024, 7000000, NULL, NULL, NULL, 5000000, 1000000, -200000, 35000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', NULL, NULL, 800000000, 'Revenues', '{"taxes_paid":"${A24}","pretax":"${A24}","revenue":"${A24}","current_federal":"${A24}","current_state":"${A24}","deferred":"${A24}"}'),
      (1, '2026-01-31', '2025-02-02', 2025, 9000000, 6000000, 2000000, 1000000, NULL, 1200000, 300000, 40000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 30000000, 10000000, 900000000, 'Revenues', '{"taxes_paid":"${A}","paid_federal":"${A}","paid_state":"${A}","paid_foreign":"${A}","pretax":"${A}","pretax_us":"${A}","pretax_foreign":"${A}","revenue":"${A}","current_state":"${A}","deferred":"${A}"}'),
      (2, '2025-12-31', '2025-01-01', 2025, 0, NULL, NULL, NULL, 0, 0, 100, 70000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments', NULL, NULL, 50000000, 'Revenues', '{"taxes_paid":"0000000002-26-000001","pretax":"0000000002-26-000001"}');
    INSERT INTO company_tax_jurisdictions (cik, period_end, element, jurisdiction, name, amount, accn) VALUES
      (1, '2026-01-31', 'IncomeTaxPaidForeignAfterRefundReceived', 'country:IE', 'Ireland', 600000, '${A}'),
      (1, '2026-01-31', 'IncomeTaxPaidStateAndLocalAfterRefundReceived', 'stpr:CA', 'California', 500000, '${A}');
    INSERT INTO company_orgs (cik, kind, org_name, how, summary) VALUES
      (1, 'lobbying', 'Example Retail, Inc.', 'name', '{"total": 120000, "count": 3, "first": "2024", "last": "2025", "source_url": "https://lda.senate.gov/filings/public/filing/1/print/"}'),
      (1, 'pac', 'Example Retail Political Action Committee', 'confirmed', '{"total": 15000, "count": 9, "first": "2026", "last": "2026", "source_url": "https://www.fec.gov/data/committee/C0001/"}');
    INSERT INTO company_org_links (org_key, cik, confirmed_by) VALUES ('example retail political action committee', 1, 'A reviewer');
  `);
  return d1(sqlite);
}

const call = async (route, path, env) => {
  const request = new Request(`https://thepillory.test${path}`);
  const params = { path: new URL(request.url).pathname.split("/").filter(Boolean).slice(1) };
  return route({ request, env, params, waitUntil: () => {}, data: {} });
};

// ---------------------------------------------------------------------------

test("the company page: the latest year labeled exactly, with its months, every amount linked to its filing", async () => {
  const html = companyMain(await loadCompany(db(), 1));
  assert.match(html, /<h2 class="h3">Fiscal year 2025 \(Feb 2025 – Jan 2026\)<\/h2>/);
  // Plain labels, each with its explanation and the filing's own term in small text under it.
  assert.match(html, /<dt>Income taxes actually paid<span class="list-meta">Cash sent to tax authorities this year, minus refunds received<\/span><span class="list-meta">In the 10-K: Income taxes paid, net of refunds<\/span><\/dt><dd><a class="inline-link" href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/000000000126000010\/0000000001-26-000010-index\.htm"[^>]*>\$9,000,000<\/a>/);
  assert.match(html, /<dt>Profit before taxes<span class="list-meta">A minus sign means a loss<\/span><span class="list-meta">In the 10-K: Income \(loss\) before income taxes<\/span><\/dt><dd><a [^>]*>\$40,000,000<\/a>/);
  assert.match(html, /Income taxes paid as a share of profit<span class="list-meta">[^<]*<\/span><\/dt><dd>23%<\/dd>/);
  // The split and the jurisdictions, when filed.
  assert.match(html, /Where the taxes went, as the 10-K splits them/);
  assert.match(html, /<dt>Paid to the U\.S\. government<span class="list-meta">In the 10-K: Federal income taxes paid, net of refunds<\/span><\/dt><dd><a [^>]*>\$6,000,000<\/a>/);
  assert.match(html, /<dt>Paid to states and cities<span/);
  assert.match(html, /<dt>Paid to other countries<span/);
  assert.match(html, /<dt>Ireland <span class="secondary">\(another country\)<\/span><\/dt>/);
  assert.match(html, /<dt>California <span class="secondary">\(state or city\)<\/span><\/dt>/);
  // A value the filing doesn't tag is "Not reported", never filled in.
  assert.match(html, /Federal tax owed on this year(?:'|&#x27;)s profit<span class="list-meta">In the 10-K: Current federal income tax expense \(benefit\)<\/span><\/th><td><a [^>]*>\$5,000,000<\/a><\/td><td>Not reported<\/td>/);
  // The share of profit, a row in Show the numbers: 7.0 / 35.0 = 20%, 9.0 / 40.0 = 23%.
  assert.match(html, /Income taxes paid as a share of profit<span class="list-meta">[^<]*<\/span><\/th><td>20%<\/td><td>23%<\/td>/);
  // The chart of both, with its numbers.
  assert.match(html, /class="mini-bars pair-bars"/);
  assert.match(html, /Show the numbers/);
  assert.ok(html.includes(READING));
  // The lead, first: the latest year in one sentence, the years together, the fixed rate line.
  assert.match(html, /<p class="lead-sentence">In fiscal 2025, Example Retail Inc reported \$40\.0 million in profit before taxes and paid \$9\.0 million in income taxes: 23% of its profit\.<\/p>/);
  assert.match(html, /Over fiscal 2024–2025: 21% of profit <span class="secondary">\(\$16\.0 million in income taxes paid on \$75\.0 million in profit before taxes\)<\/span>/);
  assert.ok(html.indexOf('id="summary"') < html.indexOf('id="latest"'));
  assert.ok(html.includes(RATE_NOTE));
  // The XBRL elements sit in a closed "Technical details" fold at the bottom.
  assert.match(html, /<details class="fold" id="technical">\s*<summary><span class="fold-title">Technical details<\/span>/);
  assert.ok(html.indexOf("xbrl-note") > html.indexOf('id="records"'));
  assert.equal((html.match(/IncomeTaxesPaidNet/g) || []).length, 1);
  // The chart's legend uses the plain labels.
  assert.match(html, /Income taxes actually paid[\s\S]*Profit before taxes/);
  assert.equal(fiscalYear({ fy: null, period_end: "2025-06-30", period_start: null }), "Fiscal year ended Jun 30, 2025");
  assert.equal(filingUrl(1, "not-an-accession"), null);
});

test("the same organization's other records sit beside the taxes as facts, each with how it matched", async () => {
  const html = companyMain(await loadCompany(db(), 1));
  assert.match(html, /In ThePillory's other records/);
  assert.match(html, /Example Retail, Inc\.: \$120,000, 2024–2025 \(3 records\)\. <span class="secondary">Matched by the same name\.<\/span>/);
  assert.match(html, /Example Retail Political Action Committee: \$15,000, 2026 \(9 records\)\. <span class="secondary">Linked to this company by a person\.<\/span>/);
  assert.match(html, /No California lobbying reports under this exact name\./);
  assert.match(html, /href="\/awards\/\?name=Example%20Retail%20Inc"/);
  assert.match(html, /doesn't connect them to the taxes above/);
});

test("every company gets the same layout", async () => {
  const shape = (html) => [...html.matchAll(/<(?:section|details)[^>]*id="([^"]+)"/g)].map((m) => m[1]).join(",");
  const a = companyMain(await loadCompany(db(), 1));
  const b = companyMain(await loadCompany(db(), 2));
  assert.equal(shape(a), shape(b));
  assert.match(b, /In the 10-K: Income \(loss\) before income taxes and equity-method investments/); // the element it is, said so
  assert.match(b, /<dt>Income taxes actually paid<span[^>]*>[^<]*<\/span><span[^>]*>[^<]*<\/span><\/dt><dd><a [^>]*>\$0<\/a>/); // a zero is shown as filed, with no label or color
  assert.match(b, /paid \$0 in income taxes: 0% of its profit\./);
});

test("the list: search by name or ticker, filter by industry and state, sorted by name, revenue or pretax income only", async () => {
  const D = db();
  const names = async (q) => (await listCompanies(D, listFilters(new URLSearchParams(q)))).rows.map((r) => r.cik);
  assert.deepEqual(Object.keys(SORTS), ["name", "revenue", "pretax"]);
  assert.deepEqual(await names(""), [2, 1, 3, 4]); // by name
  assert.deepEqual(await names("sort=revenue"), [1, 2, 4, 3]);
  assert.deepEqual(await names("sort=pretax"), [2, 1, 4, 3]);
  assert.deepEqual(await names("sort=taxes_paid"), [2, 1, 3, 4]); // not an order there is: by name
  assert.deepEqual(await names("q=aldb"), [2]); // a ticker
  assert.deepEqual(await names("q=retail"), [1]);
  assert.deepEqual(await names("sic=3571&state=CA"), [2, 3]);
  assert.equal(listFilters(new URLSearchParams("state=ZZ&sic=abc")).state, "");
  assert.equal(listHref({ q: "x", sic: "", state: "TX", sort: "name" }, 25), "/taxes/companies/?q=x&state=TX&offset=25");
  const src = readFileSync(new URL("../../../functions/_lib/taxes.js", import.meta.url), "utf8");
  assert.doesNotMatch(src.slice(src.indexOf("const ORDER"), src.indexOf("const ORDER") + 200), /taxes_paid/);
});

test("the pages: /taxes/ opens Taxpayers, the switch, the list, a company, and the old address's 301", async () => {
  const env = { DB: db() };
  const root = await call(taxesRoute, "/taxes/", env);
  assert.equal(root.status, 302);
  assert.equal(root.headers.get("location"), "https://thepillory.test/taxes/taxpayers/");
  const list = await (await call(taxesRoute, "/taxes/companies/?sort=revenue", env)).text();
  assert.match(list, /<nav class="segmented list-switch" aria-label="Show"><a class="toggle" href="\/taxes\/taxpayers\/">Taxpayers<\/a><a class="toggle" href="\/taxes\/wealth\/">Wealth<\/a><a class="toggle" href="\/taxes\/companies\/" aria-current="true">Corporations<\/a><\/nav>/);
  assert.match(list, /Example Retail Inc <span class="secondary">\(EXR\)<\/span>/);
  assert.match(list, /<option value="revenue" selected>Revenue<\/option>/);
  assert.doesNotMatch(list, /<option value="taxes_paid"/);
  const one = await call(taxesRoute, "/taxes/companies/1/", env);
  assert.equal(one.status, 200);
  assert.match(await one.text(), /<h1>Example Retail Inc<\/h1>/);
  assert.equal((await call(taxesRoute, "/taxes/companies/0001/", env)).status, 301);
  assert.equal((await call(taxesRoute, "/taxes/companies/999/", env)).status, 404);
  const moved = await call(financesRoute, "/finances/who-pays/", {});
  assert.equal(moved.status, 301);
  assert.equal(moved.headers.get("location"), "https://thepillory.test/taxes/taxpayers/");
  assert.deepEqual(checkQuery(new URL("https://thepillory.test/taxes/companies/?q=x&sic=3571&state=CA&sort=pretax&offset=25")), { ok: true });
});

test("organization panels: one line when exactly one company has the name (or a person linked it), nothing otherwise", async () => {
  const html = `<li>Example Retail, Inc.${taxMarker("Example Retail, Inc.")}</li><li>Twin Inc${taxMarker("Twin Inc")}</li><li>Nobody LLC${taxMarker("Nobody LLC")}</li><li>PAC${taxMarker("Example Retail Political Action Committee")}</li>`;
  const names = markersIn(html);
  assert.deepEqual(names, ["Example Retail, Inc.", "Twin Inc", "Nobody LLC", "Example Retail Political Action Committee"]);
  const out = fillTaxLines(html, await taxInfo(db(), names));
  assert.match(out, /<li>Example Retail, Inc\. <a class="tax-line tap small" href="\/taxes\/companies\/1\/">Taxes paid \(FY2025\): \$9\.0 million · profit before taxes \$40\.0 million ›<\/a><\/li>/);
  assert.match(out, /<li>Twin Inc<\/li>/); // two companies share the name: no line
  assert.match(out, /<li>Nobody LLC<\/li>/);
  assert.match(out, /<li>PAC <a class="tax-line[^>]*href="\/taxes\/companies\/1\/"/); // a confirmed link
  assert.doesNotMatch(out, /data-tax-org/);
});

test("Taxpayers: what the numbers don't count comes first, and the unsold-gains estimate is labeled with its method and its criticism", () => {
  const d = JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8"));
  const html = taxpayersMain(d, "");
  const at = (id) => html.indexOf(`id="${id}"`);
  // The card sits under the intro, before the first table; the estimate after the IRS tables.
  assert.ok(at("not-counted") > 0 && at("not-counted") < at("irs"));
  assert.ok(at("unsold-gains") > at("top-400") && at("unsold-gains") < at("cbo"));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'");
  assert.match(text, /What these numbers don’t count/);
  for (const t of NOT_COUNTED) assert.ok(text.includes(t.replace(/&/g, "&amp;")), t.slice(0, 40));
  assert.match(text, /Different measures give different rates for the same group\. Each table below says what it counts\./);
  assert.match(text, /Counting unsold gains: one estimate/);
  assert.match(text, /An estimate, not official tax data/);
  assert.match(text, /average federal individual income tax rate was 8\.2% of their income, counting unsold gains as income, over 2010–2018/);
  assert.match(html, /href="https:\/\/bidenwhitehouse\.archives\.gov\/cea\/written-materials\/2021\/09\/23\/[^"]+"/);
  assert.match(text, /White House Council of Economic Advisers and Office of Management and Budget, 2021/);
  // Method and criticism, both shown, of similar length.
  assert.ok(text.includes(UNSOLD_GAINS.method) && text.includes(UNSOLD_GAINS.criticism));
  const words = (s) => s.split(/\s+/).length;
  const [m, c] = [words(UNSOLD_GAINS.method), words(UNSOLD_GAINS.criticism)];
  assert.ok(Math.max(m, c) / Math.min(m, c) <= 1.3, `method ${m} words, criticism ${c}`);
  // The same for every visitor: fixed text, no person named.
  assert.equal(taxpayersMain(d, ""), html);
});

test("Taxpayers: the IRS's overlapping groups as separate slices that add up to 100%", () => {
  const d = JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8"));
  for (const year of Object.keys(d.irs.groups.find((g) => g.id === "top-1").tax_share)) {
    const { rows, total } = irsSlices(d.irs, year);
    assert.deepEqual(rows.map((r) => r.label), ["Top 0.1%", "Next 0.9% (rest of the top 1%)", "Top 1–10%", "Top 10–50%", "Bottom 50%"]);
    const add = (k) => rows.reduce((t, r) => t + r[k], 0);
    // The slices' shares sum to 100% (the IRS rounds each group's share).
    assert.ok(Math.abs(add("agi_share") - 100) < 0.2, `${year}: income shares add to ${add("agi_share")}`);
    assert.ok(Math.abs(add("tax_share") - 100) < 0.2, `${year}: tax shares add to ${add("tax_share")}`);
    assert.equal(total.agi_share, add("agi_share"));
    for (const r of rows) assert.ok(r.agi_share > 0 && r.tax_share >= 0 && r.returns > 0, `${year} ${r.label}`);
  }
  // Each slice is a group minus the one above it; the average rate is tax share / income share x the all-returns rate.
  const irs = { groups: [
    { id: "top-0.1", returns: { 2023: 150 }, agi_share: { 2023: 10 }, tax_share: { 2023: 20 } },
    { id: "top-1", returns: { 2023: 1500 }, agi_share: { 2023: 20 }, tax_share: { 2023: 40 } },
    { id: "top-10", returns: { 2023: 15000 }, agi_share: { 2023: 50 }, tax_share: { 2023: 70 } },
    { id: "top-50", returns: { 2023: 75000 }, agi_share: { 2023: 88 }, tax_share: { 2023: 97 } },
    { id: "bottom-50", returns: { 2023: 75000 }, agi_share: { 2023: 12 }, tax_share: { 2023: 3 } },
  ], all_returns: { avg_rate: { 2023: 14 } } };
  const { rows, total, allRate } = irsSlices(irs, 2023);
  assert.deepEqual(rows.map((r) => [r.returns, r.agi_share, r.tax_share]), [[150, 10, 20], [1350, 10, 20], [13500, 30, 30], [60000, 38, 27], [75000, 12, 3]]);
  assert.deepEqual(rows.map((r) => Math.round(r.avg_rate * 100) / 100), [28, 28, 14, 9.95, 3.5]);
  assert.deepEqual([total.returns, total.agi_share, total.tax_share, total.avg_rate, allRate], [150000, 100, 100, 14, 14]);
  // No all-returns rate loaded: no average rates, never a guess.
  assert.ok(irsSlices({ groups: irs.groups }, 2023).rows.every((r) => r.avg_rate === null));
});

test("Wealth: the Fed's separate groups add up to all households and all wealth, with what's counted first", () => {
  const d = JSON.parse(readFileSync(new URL("../../../data/taxes/wealth.json", import.meta.url), "utf8"));
  const { rows, total } = wealthRows(d);
  assert.deepEqual(rows.map((r) => r.label), ["Top 0.1%", "Next 0.9% (rest of the top 1%)", "Top 1–10%", "Top 10–50%", "Bottom 50%"]);
  // The Fed's shares of wealth add to 100% (it rounds each), and so do the shares of households.
  assert.ok(Math.abs(total.share - 100) <= 0.5, `wealth shares add to ${total.share}`);
  assert.ok(Math.abs(total.household_share - 100) < 1e-9);
  for (const r of rows) assert.ok(r.households > 0 && r.average > 0, r.label);
  // Every quarter's shares add to 100% too.
  for (const q of d.series) {
    const sum = Object.values(q.shares).reduce((t, v) => t + v, 0);
    assert.ok(Math.abs(sum - 100) <= 0.5, `${q.quarter}: ${sum}`);
  }
  const html = wealthMain(d, taxesSwitch("wealth"));
  const at = (id) => html.indexOf(`id="${id}"`);
  assert.ok(at("what-counts") > 0 && at("what-counts") < at("groups") && at("groups") < at("over-time") && at("over-time") < at("scf"));
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'");
  for (const t of COUNTS) assert.ok(text.includes(t), t.slice(0, 40));
  assert.match(text, /Not counted: future Social Security benefits\./);
  assert.match(text, /Each row is a separate group; the rows add up to all households\./);
  assert.match(text, /Survey of Consumer Finances/);
  assert.match(html, /<th scope="col">Group<\/th><th scope="col">Households<\/th><th scope="col">Share of wealth<\/th><th scope="col">Average net worth<\/th>/);
  assert.match(html, /<a class="toggle" href="\/taxes\/wealth\/" aria-current="true">Wealth<\/a>/);
  assert.match(wealthMain(null, ""), /aren't loaded yet/);
  // Plain, neutral wording: no "gap", "inequality" or "richest" on the page.
  assert.doesNotMatch(text, /\b(?:gap|inequalit\w*|richest|poorest)\b/i);
});

test("Taxpayers: large numbers written short", () => {
  assert.equal(shortCount(77_012_345), "77.0M");
  assert.equal(shortCount(1534), "1,534");
  assert.equal(shortCount(153_076), "153,076");
  assert.equal(shortDollars(663_164), "$663K");
  assert.equal(shortDollars(10_041_000), "$10.0M");
  assert.equal(shortDollars(97_600_000_000), "$97.6B");
  assert.equal(shortDollars(4_250), "$4.3K");
  assert.equal(shortDollars(null), "Not published");
});

test("Taxpayers: the agencies' figures as published, CBO linked, California added up and said so", () => {
  const d = JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8"));
  const html = taxpayersMain(d, "");
  assert.match(html, /Federal income tax, by income group \(tax year \d{4}\)/);
  assert.match(html, /<th scope="row">Top 1 percent<\/th>/);
  assert.match(html, /<th scope="row">Bottom 50 percent<\/th>/);
  assert.match(html, /Each row is a separate group; the rows add up to all returns\./);
  assert.match(html, /<th scope="col">Group<\/th><th scope="col">Returns<\/th><th scope="col">Share of income<\/th><th scope="col">Share of tax<\/th><th scope="col">Average tax rate<\/th>/);
  // The IRS's own overlapping groups stay, folded, with a note that each includes the ones above it.
  assert.match(html, /<details class="fold" id="irs-groups">[\s\S]*Show the IRS(?:'|&#x27;|&#39;)s groups[\s\S]*Each includes the ones above it[\s\S]*<\/details>/);
  // Phone-width tables: short headers, the notes say what each share is of, numbers written short.
  assert.match(html, /<th scope="col">Group<\/th><th scope="col">Returns<\/th><th scope="col">AGI at least<\/th><th scope="col">Share of income<\/th><th scope="col">Share of tax<\/th>/);
  assert.match(html, /<th scope="col">AGI<\/th><th scope="col">Returns<\/th><th scope="col">Share of returns<\/th><th scope="col">Tax<\/th><th scope="col">Share of tax<\/th>/);
  assert.match(html, /share of all AGI on every return; share of tax is its share of all federal income tax, after credits/);
  assert.match(html, /Average tax rate is the row(?:'|&#x27;|&#39;)s share of tax divided by its share of income, times the IRS(?:'|&#x27;|&#39;)s average tax rate for all returns/);
  assert.match(html, /share of all California personal income tax liability/);
  assert.doesNotMatch(html.slice(html.indexOf('id="irs"'), html.indexOf('id="top-400"')), /\d{1,3},\d{3},\d{3}/, "no seven-digit figures written out in the IRS table");
  assert.match(html, /The 400 returns with the largest incomes/);
  assert.match(html, /these are the 400 largest that year, not the same people/);
  assert.match(html, /CBO&#x27;s website refuses requests|CBO's website refuses requests/);
  assert.match(html, /ThePillory added its \d+ income classes up into these bands/);
  assert.match(taxpayersMain(null, ""), /aren't loaded yet/);
});

test("share of profit: whole percent of profit before taxes, never of revenue, and never estimated", () => {
  assert.deepEqual(shareOfProfit(9e6, 40e6), { pct: 23 });
  assert.deepEqual(shareOfProfit(0, 70e6), { pct: 0 });
  assert.deepEqual(shareOfProfit(5e6, -2e6), { why: "loss" });
  assert.deepEqual(shareOfProfit(5e6, 0), { why: "loss" });
  assert.deepEqual(shareOfProfit(null, 40e6), { why: "missing" });
  assert.deepEqual(shareOfProfit(9e6, null), { why: "missing" });
  assert.deepEqual(shareOfProfit(-1e6, 40e6), { why: "refund" });
  assert.equal(shareText({ why: "loss" }), "Not meaningful: loss year");
  assert.equal(shareText({ why: "missing" }), "Not reported");
  assert.equal(shareText({ pct: 21 }), "21%");
});

test("the years together: sums over the most recent five years with both values, the years named", () => {
  const y = (fy, taxes_paid, pretax) => ({ fy, period_end: `${fy}-12-31`, taxes_paid, pretax });
  const years = [y(2019, 1, 10), y(2020, 2, 10), y(2021, null, 10), y(2022, 3, 10), y(2023, 4, null), y(2024, 5, 10), y(2025, 6, 10)];
  const m = multiYear(years);
  assert.deepEqual(m.years.map((x) => x.fy), [2019, 2020, 2022, 2024, 2025]); // 2021 and 2023 lack a value
  assert.equal(m.paid, 17);
  assert.equal(m.pretax, 50);
  assert.deepEqual(m.share, { pct: 34 });
  assert.equal(yearsWords(m.years), "fiscal 2019, 2020, 2022, 2024 and 2025");
  assert.equal(yearsWords([y(2021, 1, 1), y(2022, 1, 1), y(2023, 1, 1)]), "fiscal 2021–2023");
  // Fewer than five: as many as there are; one year alone isn't a "years together" line.
  assert.equal(multiYear([y(2024, 5, 10), y(2025, 6, 10)]).years.length, 2);
  assert.equal(multiYear([y(2025, 6, 10)]), null);
  // A loss over the years: no percentage.
  assert.deepEqual(multiYear([y(2024, 5, 10), y(2025, 6, -30)]).share, { why: "losses" });
});

test("the lead sentence: every variant, parts not reported left out", () => {
  const y = (taxes_paid, pretax, fy = 2025) => ({ fy, period_end: "2025-12-31", taxes_paid, pretax });
  assert.equal(leadSentence("Example Co", y(9e6, 40e6)), "In fiscal 2025, Example Co reported $40.0 million in profit before taxes and paid $9.0 million in income taxes: 23% of its profit.");
  assert.equal(leadSentence("Example Co", y(3e6, -12e6)), "In fiscal 2025, Example Co reported a loss of $12.0 million before taxes and paid $3.0 million in income taxes.");
  assert.equal(leadSentence("Example Co", y(null, 40e6)), "In fiscal 2025, Example Co reported $40.0 million in profit before taxes.");
  assert.equal(leadSentence("Example Co", y(9e6, null)), "In fiscal 2025, Example Co paid $9.0 million in income taxes.");
  assert.equal(leadSentence("Example Co", y(-2e6, 40e6)), "In fiscal 2025, Example Co reported $40.0 million in profit before taxes and received $2.0 million more in income tax refunds than it paid.");
  assert.equal(leadSentence("Example Co", y(null, null)), "");
  assert.equal(leadSentence("Example Co", { fy: null, period_end: "2025-06-30", taxes_paid: 1e6, pretax: 2e6 }), "In the fiscal year ended Jun 30, 2025, Example Co reported $2.0 million in profit before taxes and paid $1.0 million in income taxes: 50% of its profit.");
});

test("plain labels everywhere; the list and the organization line show dollars only, no rates", async () => {
  for (const k of ["taxes_paid", "paid_federal", "paid_state", "paid_foreign", "pretax", "pretax_us", "pretax_foreign", "current_federal", "current_state", "deferred"]) {
    assert.ok(LABELS[k] && FILING_TERMS[k] && LABELS[k] !== FILING_TERMS[k], k);
    assert.doesNotMatch(LABELS[k], /expense|benefit|net of|\(loss\)|pretax/i, k);
  }
  assert.equal(LABELS.taxes_paid, "Income taxes actually paid");
  assert.equal(NOTES.deferred, "Recorded now; paid in a later year, or sometimes not at all");
  assert.equal(SORTS.pretax, "Profit before taxes");
  const row = companyRow({ cik: 1, name: "Example Retail Inc", latest_fy: 2025, revenue: 9e8, pretax: 4e7, taxes_paid: 9e6, sic_desc: "Retail", state: "TX" });
  assert.match(row, /profit before taxes \$40\.0 million/);
  const line = taxLine({ cik: 1, latest_fy: 2025, taxes_paid: 9e6, pretax: 4e7 });
  for (const html of [row, line, await (await call(taxesRoute, "/taxes/companies/", { DB: db() })).text()]) assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /\d\s*%|share of profit/i);
});

test("wording rules: no loaded words, no rankings by taxes or rate, on any of these pages or in their code", async () => {
  const banned = /\b(?:fair share|loophole|dodg\w*|paid nothing|pays less than|paid zero|zero tax|top (?:tax)?payers|ranked|ranking|biggest|worst|best|evad\w*|avoid\w*)\b/i;
  const pages = [
    companyMain(await loadCompany(db(), 1)),
    companyMain(await loadCompany(db(), 2)),
    await (await call(taxesRoute, "/taxes/companies/", { DB: db() })).text(),
    taxpayersMain(JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8")), ""),
    wealthMain(JSON.parse(readFileSync(new URL("../../../data/taxes/wealth.json", import.meta.url), "utf8")), ""),
    READING,
  ];
  for (const html of pages) {
    const hit = html.replace(/<[^>]+>/g, " ").match(new RegExp(`.{0,40}(?:${banned.source}).{0,40}`, "i"));
    assert.equal(hit, null, hit && hit[0]);
  }
  for (const f of ["functions/_lib/taxes.js", "functions/_lib/taxpayers.js", "functions/_lib/wealth.js", "functions/taxes/[[path]].js"]) {
    const src = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /fair share|loophole|dodged|paid nothing|pays less than|paid zero|top payers/i, f);
  }
  // The plain text added for readers: no "only", "just", "nearly" or the like anywhere on a company's page.
  const minimizers = /\b(?:only|just|nearly|merely|barely|mere|almost|a mere|as little as|as much as|whopping|staggering)\b/i;
  const company = (await Promise.all([1, 2].map(async (k) => companyMain(await loadCompany(db(), k))))).join(" ");
  const pieces = [...Object.values(LABELS), ...Object.values(FILING_TERMS), ...Object.values(NOTES), RATE_NOTE, READING, company,
    leadSentence("Example Co", { fy: 2025, taxes_paid: 3e6, pretax: -12e6 }), leadSentence("Example Co", { fy: 2025, taxes_paid: -2e6, pretax: 4e7 })];
  for (const t of pieces) {
    const text = t.replace(/<[^>]+>/g, " ");
    const hit = text.match(new RegExp(`.{0,40}(?:${minimizers.source}|${banned.source}).{0,40}`, "i"));
    assert.equal(hit, null, hit && hit[0]);
  }
  // No comparisons between companies in words.
  assert.doesNotMatch(company.replace(/<[^>]+>/g, " "), /\b(?:than (?:other|most|average)|compared (?:to|with)|average company|peers?|industry average|above average|below average)\b/i);
  // No person's name: only companies, organizations and income groups (returns are counted).
  assert.doesNotMatch(READING, /\b(Mr|Ms|Mrs)\.? [A-Z]/);
});
