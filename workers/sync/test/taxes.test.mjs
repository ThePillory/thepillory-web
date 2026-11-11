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
import { loadCompany, companyMain, listCompanies, listFilters, listHref, SORTS, READING, READING_TEXT, RATE_LINE, NO_RECORDS, GAP_LABEL, OVER_LABEL, gapRow, GROUP_LABEL, taxMarker, markersIn, taxInfo, fillTaxLines, filingUrl, fiscalYear, taxesSwitch, LABELS, FILING_TERMS, shareOfProfit, shareText, multiYear, yearsWords, companyRow, taxLine, taxesTree, usTaxes, profitLine, shortMoney, fyLabel, lawsSection, LAWS_LINE } from "../../../functions/_lib/taxes.js";
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

const LAWS = JSON.parse(readFileSync(new URL("../../../data/taxes/corporate-tax-laws.json", import.meta.url), "utf8"));

// Shaped like Tesla's FY2025 10-K (CIK 1318605, 0001628280-26-003952), as the accuracy audit's section 9 printed it.
const TA = "0001628280-26-003952";
function teslaDb() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0047_company_taxes.sql", import.meta.url), "utf8"));
  const src = (fields) => JSON.stringify(Object.fromEntries(fields.map((f) => [f, TA])));
  sqlite.exec(`
    INSERT INTO companies (cik, name, name_key, tickers, sic, sic_desc, state, fy_end, latest_end, latest_fy, revenue, pretax, taxes_paid, source_url) VALUES
      (1318605, 'Tesla, Inc.', 'tesla', 'TSLA', '3711', 'Motor Vehicles & Passenger Car Bodies', 'TX', '1231', '2025-12-31', 2025, 94827000000, 5278000000, 1232000000, 'https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&CIK=0001318605&type=10-K');
    INSERT INTO company_tax_years (cik, period_end, period_start, fy, taxes_paid, paid_federal, paid_state, paid_foreign, current_federal, current_state, deferred, pretax, pretax_tag, pretax_us, pretax_foreign, revenue, revenue_tag, src) VALUES
      (1318605, '2023-12-31', '2023-01-01', 2023, 1120000000, NULL, NULL, NULL, 48000000, 57000000, -6349000000, 9973000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 3196000000, 6800000000, 96773000000, 'Revenues', '${src(["taxes_paid", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"])}'),
      (1318605, '2024-12-31', '2024-01-01', 2024, 1330000000, NULL, NULL, NULL, 0, 45000000, 477000000, 8990000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 2292000000, 6636000000, 97690000000, 'Revenues', '${src(["taxes_paid", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"])}'),
      (1318605, '2025-12-31', '2025-01-01', 2025, 1232000000, 28000000, NULL, NULL, 0, 5000000, 123000000, 5278000000, 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 4766000000, 451000000, 94827000000, 'Revenues', '${src(["taxes_paid", "paid_federal", "current_federal", "current_state", "deferred", "pretax", "pretax_us", "pretax_foreign", "revenue"])}');
    INSERT INTO company_tax_jurisdictions (cik, period_end, element, jurisdiction, name, amount, accn) VALUES
      (1318605, '2025-12-31', 'IncomeTaxPaidStateAndLocalAfterRefundReceived', 'stpr:CA', 'California', 86000000, '${TA}'),
      (1318605, '2025-12-31', 'IncomeTaxPaidStateAndLocalAfterRefundReceived', 'tsla:OtherStatesMember', 'Other states', 65000000, '${TA}'),
      (1318605, '2025-12-31', 'IncomeTaxPaidForeignAfterRefundReceived', 'country:CN', 'China', 751000000, '${TA}'),
      (1318605, '2025-12-31', 'IncomeTaxPaidForeignAfterRefundReceived', 'us-gaap:ForeignTaxJurisdictionOtherMember', 'Other countries', 302000000, '${TA}');
    INSERT INTO company_orgs (cik, kind, org_name, how, summary) VALUES
      (1318605, 'lobbying', 'TESLA INC', 'name', '{"by_year": {"2025": 1570000}, "count": 4, "first": "2025", "last": "2025", "source_url": "https://lda.gov/filings/public/filing/fd5d7311-6368-4a08-90d0-c4bc1bb27a62/print/", "total": 1570000}');
  `);
  return d1(sqlite);
}
const plain = (html) => html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");

test("Tesla FY2025: the U.S. figure, the total worldwide, and where the taxes went adding up to the total", async () => {
  const data = await loadCompany(teslaDb(), 1318605);
  const html = companyMain({ ...data, laws: LAWS });
  const text = plain(html);
  // Header: the name, then one small gray line.
  assert.match(html, /<h1>Tesla, Inc\.<\/h1>\s*<p class="subtitle small">TSLA · Motor Vehicles &amp; Passenger Car Bodies · Texas<\/p>/);
  // The top card: the year, U.S. first, then the total worldwide.
  assert.match(html, /<h2 class="tax-title">FY2025 \(Jan–Dec 2025\)<\/h2>/);
  assert.match(text, /Taxes paid in the U\.S\. \$179 million on \$4\.77 billion of U\.S\. profit · 4% U\.S\. government \$28 million · States \$151 million \(sum of the places listed\)/);
  assert.match(text, /Total taxes paid worldwide \$1\.23 billion on \$5\.28 billion of total profit · 23%/);
  assert.match(text, /2023–2025: 15% of total profit/); // (1,120 + 1,330 + 1,232) ÷ (9,973 + 8,990 + 5,278)
  assert.ok(text.includes(RATE_LINE));
  assert.ok(text.indexOf("Taxes paid in the U.S.") < text.indexOf("Total taxes paid worldwide"));
  // Where the taxes went: every place, under its group; the rows add up to the total.
  const tree = taxesTree(data.years[2], data.jurisdictions);
  assert.deepEqual(GROUPS_OF(tree), [["U.S. government", 28e6, "tagged", []], ["States", 151e6, "sum", [["California", 86e6], ["Other states", 65e6]]], ["Other countries", 1053e6, "sum", [["China", 751e6], ["Other countries", 302e6]]]]);
  assert.equal(tree.gap, null);
  assert.equal(28e6 + 151e6 + 1053e6, tree.total);
  const places = plain(html.slice(html.indexOf('id="places"'), html.indexOf('id="years"')));
  assert.match(places, /U\.S\. government \$28 million States Sum of the places listed \$151 million California \$86 million Other states \$65 million Other countries Sum of the places listed \$1\.05 billion China \$751 million Other countries \$302 million Total \$1\.23 billion From the 10-K ›/);
  assert.doesNotMatch(places, /Not broken out/);
  // Show the numbers, once on the page: current federal tax of $0 as filed.
  assert.equal((html.match(/Show the numbers/g) || []).length, 1);
  // Rows, one block per year, newest first: nothing to pan sideways on a phone.
  assert.doesNotMatch(html, /<table|table-scroll/);
  const fy = (end) => html.slice(html.indexOf(`id="fy-${end}"`), html.indexOf("</ul>", html.indexOf(`id="fy-${end}"`)));
  assert.ok(html.indexOf('id="fy-2025-12-31"') < html.indexOf('id="fy-2023-12-31"'));
  assert.match(fy("2025-12-31"), /Federal tax owed on this year(?:'|&#x27;)s profit<\/span><\/div><span class="list-status">\$0<\/span>/);
  assert.match(fy("2023-12-31"), /Federal tax owed on this year(?:'|&#x27;)s profit<\/span><\/div><span class="list-status">\$48,000,000<\/span>/);
  // One "From the 10-K" link per card, never a link on each amount above the table.
  assert.equal((html.slice(0, html.indexOf('id="years"')).match(/From the 10-K ›/g) || []).length, 2);
  assert.doesNotMatch(html.slice(0, html.indexOf('id="years"')), /<a [^>]*>\$[\d.,]+/);
  // The order: top card, places, years, laws, records, about.
  const at = (id) => html.indexOf(`id="${id}"`);
  assert.ok(at("latest") < at("places") && at("places") < at("years") && at("years") < at("laws") && at("laws") < at("records") && at("records") < at("about"));
  assert.match(html, /<details class="fold" id="about">\s*<summary><span class="fold-title">About these numbers<\/span>/);
  const about = plain(html.slice(at("about")));
  assert.ok(about.includes(READING_TEXT));
  assert.match(about, /Income taxes actually paid In the 10-K: Income taxes paid, net of refunds · XBRL: IncomeTaxesPaidNet/);
  // Other records: only those that exist, each with its amount.
  assert.match(plain(html.slice(at("records"), at("about"))), /Federal lobbying TESLA INC · 2025 · 4 reports · same name \$1\.57 million/);
  assert.doesNotMatch(html, /Political action committee/);
});

const GROUPS_OF = (tree) => ["federal", "state", "foreign"].filter((g) => tree.groups[g]).map((g) => [GROUP_LABEL[g], tree.groups[g].amount, tree.groups[g].how, tree.groups[g].places.map((p) => [p.label, p.amount])]);

test("where the taxes went: tagged totals, sums of places, and a gap said plainly, never filled", () => {
  const y = { period_end: "2025-12-31", taxes_paid: 100e6, paid_federal: 40e6, paid_state: 20e6, paid_foreign: 30e6 };
  const j = [
    { period_end: "2025-12-31", element: "IncomeTaxPaidStateAndLocalAfterRefundReceived", jurisdiction: "stpr:CA", name: "California", amount: 12e6 },
    { period_end: "2025-12-31", element: "IncomeTaxesPaidNet", jurisdiction: "stpr:CA", name: "California", amount: 11e6 },
    { period_end: "2025-12-31", element: "IncomeTaxPaidForeignAfterRefundReceived", jurisdiction: "country:IE", name: "Ireland", amount: 30e6 },
    { period_end: "2024-12-31", element: "IncomeTaxPaidForeignAfterRefundReceived", jurisdiction: "country:GB", name: "United Kingdom", amount: 9e5 },
  ];
  const t = taxesTree(y, j);
  // States are tagged at $20M, California is $12M: the rest is "Not broken out in the 10-K".
  assert.deepEqual(t.groups.state.places, [{ label: "California", amount: 12e6 }, { label: GAP_LABEL, amount: 8e6, gap: true }]);
  assert.deepEqual(t.groups.foreign.places, [{ label: "Ireland", amount: 30e6 }]);
  // The groups add to $90M of the $100M total: the $10M left is a row of its own.
  assert.equal(t.gap, 10e6);
  // Totals filed as members on the same axis.
  const m = taxesTree({ period_end: "2025-12-31", taxes_paid: 10 }, [
    { period_end: "2025-12-31", element: "IncomeTaxesPaidNet", jurisdiction: "us-gaap:DomesticCountryMember", name: "U.S. government", amount: 5 },
    { period_end: "2025-12-31", element: "IncomeTaxesPaidNet", jurisdiction: "us-gaap:StateAndLocalJurisdictionMember", name: "States", amount: 1 },
    { period_end: "2025-12-31", element: "IncomeTaxesPaidNet", jurisdiction: "us-gaap:ForeignCountryMember", name: "Other countries", amount: 4 },
  ]);
  assert.deepEqual([m.groups.federal.amount, m.groups.state.amount, m.groups.foreign.amount, m.gap], [5, 1, 4, null]);
  // Parts adding up to more than the 10-K's own total (Chubb's FY2025, P&G's $1 million of rounding): said so, never hidden.
  const over = taxesTree({ period_end: "2025-12-31", taxes_paid: 2211e6, paid_federal: 614e6 }, [
    { period_end: "2025-12-31", element: "IncomeTaxPaidForeignAfterRefundReceived", jurisdiction: "country:CH", name: "Switzerland", amount: 2177e6 },
  ]);
  assert.equal(over.gap, -580e6);
  assert.deepEqual(gapRow(over.gap), { label: OVER_LABEL, amount: 580e6, gap: true, over: true });
  // No breakdown at all: nothing to show, so the card is hidden.
  assert.equal(taxesTree({ period_end: "2025-12-31", taxes_paid: 10 }, []).any, false);
});

test("the U.S. figure: federal and state, federal alone, nothing tagged, a loss and a refund", () => {
  const tree = (y, j = []) => taxesTree({ period_end: "2025-12-31", ...y }, j);
  assert.deepEqual(usTaxes(tree({ paid_federal: 28e6, paid_state: 151e6 })), { label: "Taxes paid in the U.S.", amount: 179e6, split: [tree({ paid_federal: 28e6 }).groups.federal, tree({ paid_state: 151e6 }).groups.state], sum: false });
  const fed = usTaxes(tree({ paid_federal: 28e6 }));
  assert.equal(fed.label, "Paid to the U.S. government");
  assert.equal(fed.split, null);
  assert.equal(usTaxes(tree({ paid_foreign: 5e6 })), null); // nothing for the U.S.: no U.S. line
  assert.equal(usTaxes(tree({})), null);
  assert.equal(profitLine(179e6, 4766e6, "us"), "on $4.77 billion of U.S. profit · 4%");
  assert.equal(profitLine(1232e6, 5278e6, "total"), "on $5.28 billion of total profit · 23%");
  assert.equal(profitLine(28e6, -5e6, "us"), "with a U.S. loss before taxes of $5 million");
  assert.equal(profitLine(28e6, -5e6, "total"), "with a loss before taxes of $5 million");
  assert.equal(profitLine(-3e6, 400e6, "us"), "More refunded than paid · on $400 million of U.S. profit");
  assert.equal(profitLine(28e6, null, "us"), "");
  for (const l of [profitLine(28e6, -5e6, "us"), profitLine(-3e6, 400e6, "us"), profitLine(28e6, null, "us")]) assert.doesNotMatch(l, /%/);
});

test("the company page's U.S. line on the page: federal alone, nothing tagged, a loss year", async () => {
  const D = db();
  // Company 1, FY2025: federal and state tagged.
  const a = plain(companyMain({ ...(await loadCompany(D, 1)), laws: LAWS }));
  assert.match(a, /Taxes paid in the U\.S\. \$8 million on \$30 million of U\.S\. profit · 27% U\.S\. government \$6 million · States \$2 million Total taxes paid worldwide/);
  // Company 2: nothing tagged for the U.S.: no U.S. line, no places card.
  const b = companyMain({ ...(await loadCompany(D, 2)), laws: LAWS });
  assert.doesNotMatch(plain(b.slice(0, b.indexOf('id="years"'))), /in the U\.S\.|U\.S\. government/);
  assert.doesNotMatch(b, /id="places"/);
  // Only federal tagged, and a U.S. loss: labeled as federal, no percent.
  const c = await loadCompany(D, 1);
  c.years[1] = { ...c.years[1], paid_state: null, pretax_us: -5e6 };
  c.jurisdictions = c.jurisdictions.filter((j) => !j.jurisdiction.startsWith("stpr:"));
  assert.match(plain(companyMain(c)), /Paid to the U\.S\. government \$6 million with a U\.S\. loss before taxes of \$5 million Total/);
});

test("short amounts and the year label", () => {
  assert.equal(shortMoney(1234567890), "$1.23 billion");
  assert.equal(shortMoney(28e6), "$28 million");
  assert.equal(shortMoney(5.28e9), "$5.28 billion");
  assert.equal(shortMoney(-7.4e6), "−$7.4 million");
  assert.equal(shortMoney(850000), "$850,000");
  assert.equal(shortMoney(null), "Not reported");
  assert.equal(fyLabel({ fy: 2025, period_start: "2025-01-01", period_end: "2025-12-31" }), "FY2025 (Jan–Dec 2025)");
  assert.equal(fyLabel({ fy: 2025, period_start: "2025-02-02", period_end: "2026-01-31" }), "FY2025 (Feb 2025–Jan 2026)");
});

test("the laws that set these taxes: one line each, linked to the bill, the same on every company page and the list", async () => {
  assert.ok(LAWS.laws.length >= 3);
  for (const l of LAWS.laws) {
    for (const k of ["name", "official_title", "public_law", "year", "congress", "bill_type", "bill_number", "bill_id", "description", "description_source"]) assert.ok(l[k], `${l.name}: ${k}`);
    assert.match(l.source_url, /^https:\/\/www\.congress\.gov\/bill\//);
    assert.match(l.public_law, /^\d{3}-\d+$/);
    assert.equal(l.bill_id, `us-${l.congress}-${l.bill_type}-${l.bill_number}`);
    assert.match(l.description_source, /^Congress\.gov summary, Public Law /);
  }
  assert.deepEqual(LAWS.laws.map((l) => l.public_law), ["115-97", "117-169", "119-21"]);
  const section = lawsSection(LAWS);
  for (const l of LAWS.laws) assert.ok(section.includes(`<a class="list-row" href="/laws/bills/${l.bill_id}/"><div><span class="list-title">${l.name} · ${l.year}</span>`), l.bill_id);
  assert.ok(section.includes(LAWS_LINE));
  assert.equal(LAWS_LINE, "Congress sets the rates, deductions and credits companies pay under. See how your representatives voted on each.");
  const a = companyMain({ ...(await loadCompany(db(), 1)), laws: LAWS });
  const b = companyMain({ ...(await loadCompany(db(), 2)), laws: LAWS });
  assert.ok(a.includes(section) && b.includes(section));
  assert.ok((await (await call(taxesRoute, "/taxes/companies/", { DB: db(), ASSETS: { fetch: async () => new Response(JSON.stringify(LAWS)) } })).text()).includes(section));
  // Never which law lowered a company's taxes.
  assert.doesNotMatch(section.replace(/<[^>]+>/g, " "), /lowered (?:its|this company|the company)|because of|thanks to|benefit(?:ed|ted) from/i);
  // Not loaded: the section is hidden, not an empty state.
  assert.equal(lawsSection(null), "");
  assert.doesNotMatch(companyMain(await loadCompany(db(), 1)), /id="laws"/);
});
test("other records: only those that exist, one row each, and one line when there are none", async () => {
  const html = companyMain(await loadCompany(db(), 1));
  const rec = plain(html.slice(html.indexOf('id="records"'), html.indexOf('id="about"')));
  assert.match(rec, /Other records under this name Political action committee Example Retail Political Action Committee · 2026 · 9 contributions · linked by a person \$15,000 Federal lobbying Example Retail, Inc\. · 2024–2025 · 3 reports · same name \$120,000/);
  assert.match(rec, /ThePillory doesn't connect them to the taxes above/);
  assert.doesNotMatch(rec, /California lobbying|LD-203|ballot measures|Federal awards/); // none of these exist for it
  const none = plain(companyMain(await loadCompany(db(), 2)));
  assert.ok(none.includes(NO_RECORDS));
  // Federal awards appear only once looked up, with what was found.
  const d = await loadCompany(db(), 2);
  const withAwards = plain(companyMain({ ...d, awards: { recipients: [{ years: [{ fy: 2024, total: 2e6 }, { fy: 2025, total: 3e6 }] }] } }));
  assert.match(withAwards, /Federal awards Contracts and grants · fiscal 2024–2025 · USAspending\.gov \$5 million/);
});
test("every company gets the same layout (the places card only where the 10-K breaks taxes paid down)", async () => {
  const shape = (html) => [...html.matchAll(/<(?:section|details)[^>]*id="([^"]+)"/g)].map((m) => m[1]).filter((id) => id !== "places").join(",");
  const a = companyMain({ ...(await loadCompany(db(), 1)), laws: LAWS });
  const b = companyMain({ ...(await loadCompany(db(), 2)), laws: LAWS });
  assert.equal(shape(a), shape(b));
  assert.match(a, /id="places"/);
  assert.doesNotMatch(b, /id="places"/);
  assert.match(b, /In the 10-K: Income \(loss\) before income taxes and equity-method investments</); // the element it is, said so
  assert.match(plain(b), /Total taxes paid worldwide \$0 on \$70 million of total profit · 0%/); // a zero as filed, with no label or color
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

test("plain labels everywhere; the list and the organization line show dollars only, no rates", async () => {
  for (const k of ["taxes_paid", "paid_federal", "paid_state", "paid_foreign", "pretax", "pretax_us", "pretax_foreign", "current_federal", "current_state", "deferred"]) {
    assert.ok(LABELS[k] && FILING_TERMS[k] && LABELS[k] !== FILING_TERMS[k], k);
    assert.doesNotMatch(LABELS[k], /expense|benefit|net of|\(loss\)|pretax/i, k);
  }
  assert.equal(LABELS.taxes_paid, "Income taxes actually paid");
  assert.equal(SORTS.pretax, "Profit before taxes");
  const row = companyRow({ cik: 1, name: "Example Retail Inc", latest_fy: 2025, revenue: 9e8, pretax: 4e7, taxes_paid: 9e6, sic_desc: "Retail", state: "TX" });
  assert.match(row, /profit before taxes \$40 million/);
  const line = taxLine({ cik: 1, latest_fy: 2025, taxes_paid: 9e6, pretax: 4e7 });
  for (const html of [row, line, await (await call(taxesRoute, "/taxes/companies/", { DB: db() })).text()]) assert.doesNotMatch(html.replace(/<[^>]+>/g, " "), /\d\s*%|share of profit/i);
});

test("wording rules: no loaded words, no rankings by taxes or rate, on any of these pages or in their code", async () => {
  const banned = /\b(?:fair share|loopholes?|dodg\w*|paid nothing|pays less than|paid zero|zero tax|top (?:tax)?payers|ranked|ranking|biggest|worst|best|evad\w*|avoid\w*)\b/i;
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
  const company = (await Promise.all([1, 2].map(async (k) => companyMain({ ...(await loadCompany(db(), k)), laws: LAWS })))).join(" ");
  const pieces = [...Object.values(LABELS), ...Object.values(FILING_TERMS), READING, LAWS_LINE, lawsSection(LAWS), company,
    RATE_LINE, NO_RECORDS, GAP_LABEL, OVER_LABEL, ...Object.values(GROUP_LABEL), companyMain({ ...(await loadCompany(teslaDb(), 1318605)), laws: LAWS }),
    profitLine(28e6, -5e6, "us"), profitLine(-3e6, 4e8, "us"), profitLine(28e6, 4e8, "us"), profitLine(28e6, 4e8, "total")];
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

test("the look of every /taxes/ view: sentence-case titles, no small caps, three text sizes, bold only for titles and big figures", async () => {
  const pages = {
    company: companyMain({ ...(await loadCompany(teslaDb(), 1318605)), laws: LAWS }),
    list: await (await call(taxesRoute, "/taxes/companies/", { DB: db(), ASSETS: { fetch: async () => new Response(JSON.stringify(LAWS)) } })).text(),
    taxpayers: taxpayersMain(JSON.parse(readFileSync(new URL("../../../data/taxes/taxpayers.json", import.meta.url), "utf8")), taxesSwitch("taxpayers")),
    wealth: wealthMain(JSON.parse(readFileSync(new URL("../../../data/taxes/wealth.json", import.meta.url), "utf8")), taxesSwitch("wealth")),
  };
  for (const [name, html] of Object.entries(pages)) {
    const main = html.includes('<div class="tax-page">') ? html.slice(html.indexOf('<div class="tax-page">')) : html;
    assert.ok(html.includes('<div class="tax-page">'), `${name}: inside .tax-page`);
    assert.doesNotMatch(main, /class="(?:[^"]* )?(?:label|h3|xsmall|lead-sentence|tax-big)(?: [^"]*)?"/, name); // no uppercase labels, no fourth size
    assert.doesNotMatch(main, /<(?:strong|b)>/, name);
    // Card titles: sentence case (only the first word, proper names and abbreviations capitalized).
    for (const m of main.matchAll(/<h2 class="tax-title">([^<]+)<\/h2>/g)) assert.doesNotMatch(m[1], /^\S+ (?:[A-Z][a-z]+ ){2,}/, `${name}: ${m[1]}`);
  }
  // The /taxes/ styles use only the three sizes.
  const css = readFileSync(new URL("../../../assets/pillory.css", import.meta.url), "utf8");
  const block = css.slice(css.indexOf("/* /taxes/ (every view"), css.indexOf("/* /admin/usage/"));
  for (const m of block.matchAll(/font-size:\s*([^;]+);/g)) assert.match(m[1], /^var\(--fs-(?:h1|body|small)\)$/);
  assert.doesNotMatch(block, /text-transform:\s*uppercase/);
});
