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
import { loadCompany, companyMain, listCompanies, listFilters, listHref, SORTS, READING, taxMarker, markersIn, taxInfo, fillTaxLines, filingUrl, fiscalYear } from "../../../functions/_lib/taxes.js";
import { taxpayersMain } from "../../../functions/_lib/taxpayers.js";
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
  assert.match(html, /<dt>Income taxes paid, net of refunds<\/dt><dd><a class="inline-link" href="https:\/\/www\.sec\.gov\/Archives\/edgar\/data\/1\/000000000126000010\/0000000001-26-000010-index\.htm"[^>]*>\$9,000,000<\/a>/);
  assert.match(html, /<dt>Income \(loss\) before income taxes<\/dt><dd><a [^>]*>\$40,000,000<\/a>/);
  // The split and the jurisdictions, when filed.
  assert.match(html, /Taxes paid, as the 10-K splits them/);
  assert.match(html, /<dt>Federal<\/dt><dd><a [^>]*>\$6,000,000<\/a>/);
  assert.match(html, /<dt>Ireland <span class="secondary">\(foreign\)<\/span><\/dt>/);
  assert.match(html, /<dt>California <span class="secondary">\(state and local\)<\/span><\/dt>/);
  // A value the filing doesn't tag is "Not reported", never filled in.
  assert.match(html, /Current federal income tax expense \(benefit\)<\/th><td><a [^>]*>\$5,000,000<\/a><\/td><td>Not reported<\/td>/);
  // The chart of both, with its numbers.
  assert.match(html, /class="mini-bars pair-bars"/);
  assert.match(html, /Show the numbers/);
  assert.ok(html.includes(READING));
  assert.equal(fiscalYear({ fy: null, period_end: "2025-06-30", period_start: null }), "Fiscal year ended Jun 30, 2025");
  assert.equal(filingUrl(1, "not-an-accession"), null);
});

test("the same organization's other records sit beside the taxes as facts, each with how it matched", async () => {
  const html = companyMain(await loadCompany(db(), 1));
  assert.match(html, /In ThePillory's other records/);
  assert.match(html, /Example Retail, Inc\.: \$120,000, 2024–2025 \(3 records\)\. <span class="secondary">Matched by the same name\.<\/span>/);
  assert.match(html, /Example Retail Political Action Committee: \$15,000, 2026 \(9 records\)\. <span class="secondary">Matched by linked to this company by a person\.<\/span>/);
  assert.match(html, /No California lobbying reports under this exact name\./);
  assert.match(html, /href="\/awards\/\?name=Example%20Retail%20Inc"/);
  assert.match(html, /doesn't connect them to the taxes above/);
});

test("every company gets the same layout", async () => {
  const shape = (html) => [...html.matchAll(/<(?:section|details)[^>]*id="([^"]+)"/g)].map((m) => m[1]).join(",");
  const a = companyMain(await loadCompany(db(), 1));
  const b = companyMain(await loadCompany(db(), 2));
  assert.equal(shape(a), shape(b));
  assert.match(b, /Income \(loss\) before income taxes and equity-method investments/); // the element it is, said so
  assert.match(b, /<dt>Income taxes paid, net of refunds<\/dt><dd><a [^>]*>\$0<\/a>/); // a zero is shown as filed, with no label or color
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
  assert.match(list, /<nav class="segmented list-switch" aria-label="Show"><a class="toggle" href="\/taxes\/taxpayers\/">Taxpayers<\/a><a class="toggle" href="\/taxes\/companies\/" aria-current="true">Corporations<\/a><\/nav>/);
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
  assert.match(out, /<li>Example Retail, Inc\. <a class="tax-line tap small" href="\/taxes\/companies\/1\/">Taxes paid \(FY2025\): \$9\.0 million · pretax income \$40\.0 million ›<\/a><\/li>/);
  assert.match(out, /<li>Twin Inc<\/li>/); // two companies share the name: no line
  assert.match(out, /<li>Nobody LLC<\/li>/);
  assert.match(out, /<li>PAC <a class="tax-line[^>]*href="\/taxes\/companies\/1\/"/); // a confirmed link
  assert.doesNotMatch(out, /data-tax-org/);
});

test("Taxpayers: the agencies' figures as published, CBO linked, California added up and said so", () => {
  const d = JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8"));
  const html = taxpayersMain(d, "");
  assert.match(html, /Federal income tax, by income group \(tax year \d{4}\)/);
  assert.match(html, /<th scope="row">Top 1 percent<\/th>/);
  assert.match(html, /<th scope="row">Bottom 50 percent<\/th>/);
  assert.match(html, /Shares as the IRS computes them/);
  assert.match(html, /The 400 returns with the largest incomes/);
  assert.match(html, /these are the 400 largest that year, not the same people/);
  assert.match(html, /CBO&#x27;s website refuses requests|CBO's website refuses requests/);
  assert.match(html, /ThePillory added its \d+ income classes up into these bands/);
  assert.match(taxpayersMain(null, ""), /aren't loaded yet/);
});

test("wording rules: no loaded words, no rankings by taxes or rate, on any of these pages or in their code", async () => {
  const banned = /\b(?:fair share|loophole|dodg\w*|paid nothing|pays less than|paid zero|zero tax|top (?:tax)?payers|ranked|ranking|biggest|worst|best|evad\w*|avoid\w*)\b/i;
  const pages = [
    companyMain(await loadCompany(db(), 1)),
    companyMain(await loadCompany(db(), 2)),
    await (await call(taxesRoute, "/taxes/companies/", { DB: db() })).text(),
    taxpayersMain(JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8")), ""),
    READING,
  ];
  for (const html of pages) {
    const hit = html.replace(/<[^>]+>/g, " ").match(new RegExp(`.{0,40}(?:${banned.source}).{0,40}`, "i"));
    assert.equal(hit, null, hit && hit[0]);
  }
  for (const f of ["functions/_lib/taxes.js", "functions/_lib/taxpayers.js", "functions/taxes/[[path]].js"]) {
    const src = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
    assert.doesNotMatch(src, /fair share|loophole|dodged|paid nothing|pays less than|paid zero|top payers/i, f);
  }
  // No person's name: only companies, organizations and income groups (returns are counted).
  assert.doesNotMatch(READING, /\b(Mr|Ms|Mrs)\.? [A-Z]/);
});
