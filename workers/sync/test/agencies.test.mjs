// node --test test/agencies.test.mjs
// Federal agencies (docs/agencies.md): /agencies/ and /agencies/<slug>/, the empty states, and
// the wording rules. Every agency, person, report and number here is FAKE.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequestGet as route } from "../../../functions/agencies/[[path]].js";
import { NOT_LOADED, lastCompleteFy, confirmLine, agencyMain } from "../../../functions/_lib/agencies.js";
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

const FY = lastCompleteFy();
function db({ empty = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(readFileSync(new URL("../migrations/0052_agencies.sql", import.meta.url), "utf8"));
  sqlite.exec(`CREATE TABLE officials (id TEXT PRIMARY KEY, slug TEXT, name TEXT);
    CREATE TABLE votes (id TEXT PRIMARY KEY, source_url TEXT, vote_date TEXT);
    CREATE TABLE bill_list (bill_id TEXT PRIMARY KEY, bill_number TEXT, title TEXT, final_result TEXT, final_chamber TEXT, last_final TEXT, last_vote TEXT, yea INTEGER, nay INTEGER);`);
  if (empty) return d1(sqlite);
  sqlite.exec(`
    INSERT INTO agencies (id, fr_id, name, short_name, parent_id, kind, description, website, usas_code, source_url) VALUES
      ('example-department', 1, 'Example Department', 'EXD', NULL, 'department', 'The Example Department carries out examples.', 'https://example.gov/', '9999', 'https://www.federalregister.gov/agencies/example-department'),
      ('sample-service', 2, 'Sample Service', NULL, 'example-department', 'sub-agency', 'The Sample Service serves samples.', NULL, NULL, 'https://www.federalregister.gov/agencies/sample-service'),
      ('quiet-board', 3, 'Quiet Board', NULL, NULL, 'independent', NULL, NULL, NULL, 'https://www.federalregister.gov/agencies/quiet-board');
    INSERT INTO officials VALUES ('x:1', 'pat-sample', 'Pat Sample');
    INSERT INTO votes VALUES ('us-senate-119-1-100', 'https://www.senate.gov/legislative/LIS/roll_call_votes/vote1191/vote_119_1_00100.htm', '2025-03-10');
    INSERT INTO agency_leaders (agency_id, organization, position, name, status, appointment, placement, since, nomination_id, confirmed_on, vote_id, confirm_note, official_id, source_url) VALUES
      ('example-department', 'Example Department', 'Secretary of Examples', 'Pat Sample', 'Filled', 'PAS', NULL, '2025-03-11', 'PN1-1', '2025-03-10', 'us-senate-119-1-100', NULL, 'x:1', 'https://www.opm.gov/x'),
      ('example-department', 'Example Department', 'Deputy Secretary', '', 'Vacant', 'PAS', NULL, NULL, NULL, NULL, NULL, NULL, NULL, 'https://www.opm.gov/x'),
      ('example-department', 'Example Department', 'Deputy Secretary', 'Jane Example', 'Filled', 'CA', 'PTDO', '2026-02-01', NULL, NULL, NULL, NULL, NULL, 'https://www.opm.gov/x'),
      ('example-department', 'Example Department', 'Under Secretary', 'Lee Voice', 'Filled', 'PAS', NULL, '2025-06-01', 'PN2-1', '2025-05-20', NULL, 'Confirmed by the Senate by Voice Vote.', NULL, 'https://www.opm.gov/x');
    INSERT INTO agency_money (agency_id, fy, resources, obligations, outlays, source_url) VALUES
      ('example-department', ${FY - 1}, 21000000000, 20000000000, 19500000000, 'https://www.usaspending.gov/agency/9999?fy=${FY - 1}'),
      ('example-department', ${FY}, 22000000000, 21000000000, 20345678901, 'https://www.usaspending.gov/agency/9999?fy=${FY}'),
      ('example-department', ${FY + 1}, 23000000000, 2000000000, 1000000000, 'https://www.usaspending.gov/agency/9999?fy=${FY + 1}');
    INSERT INTO agency_money_parts VALUES ('example-department', ${FY}, 'object_class', 'Grants and fixed charges', NULL, 9000000000, 8000000000),
      ('example-department', ${FY}, 'function', 'Training and Employment', 'Education, Training, Employment, and Social Services', 5000000000, 4900000000);
    INSERT INTO agency_recipients VALUES ('example-department', ${FY}, 'grants', 1, 'STATE OF EXAMPLE', 'r1', 900000000);
    INSERT INTO agency_money (agency_id, fy, resources, obligations, outlays, source_url) VALUES
      ('sample-service', ${FY - 1}, NULL, 700000000, NULL, 'https://www.usaspending.gov/agency/9999?fy=${FY - 1}'),
      ('sample-service', ${FY}, NULL, 812345678, NULL, 'https://www.usaspending.gov/agency/9999?fy=${FY}');
    INSERT INTO agency_recipients VALUES ('sample-service', ${FY}, 'contracts', 1, 'EXAMPLE SUPPLY CO', 'r9', 40000000);
    INSERT INTO agency_workforce VALUES ('example-department', ${FY}, 15123, 'https://data.opm.gov/'), ('example-department', ${FY - 1}, 15000, 'https://data.opm.gov/');
    INSERT INTO agency_reports VALUES ('gao', 'GAO-27-100001', 'example-department', 'Example Programs: Example Department Should Improve Grant Data', '2026-11-17', 'https://www.gao.gov/products/gao-27-100001');
    INSERT INTO agency_rule_counts VALUES ('example-department', 2026, 18), ('example-department', 2025, 22);
    INSERT INTO agency_rules VALUES ('example-department', '2026-1', 'Recordkeeping', '2026-11-10', 'https://www.federalregister.gov/d/2026-1');
    INSERT INTO bill_list VALUES ('us-119-s-1', 'S. 1', 'Example Appropriations Act, 2026', 'Passed', 'us-senate', '2025-08-01', '2025-08-01', 60, 39);
    INSERT INTO agency_bills VALUES ('example-department', 'us-119-s-1', 'Example');
  `);
  return d1(sqlite);
}

const call = async (path, env) => {
  const request = new Request(`https://thepillory.test${path}`);
  const params = { path: new URL(request.url).pathname.split("/").filter(Boolean).slice(1) };
  const res = await route({ request, env, params, waitUntil: () => {}, data: {} });
  return { status: res.status, html: await res.text() };
};

const BANNED = /\b(waste|wasteful|bloat|bloated|grade|ranked|ranking|rank #|best|worst|top-performing|failing agency|overspen\w*|boondoggle|democrat\w*|republican\w*|liberal|conservative)\b/i;

test("the index lists departments with their sub-agencies, then independent agencies", async () => {
  const { status, html } = await call("/agencies/", { DB: db() });
  assert.equal(status, 200);
  assert.ok(html.indexOf("Executive departments") < html.indexOf("Independent agencies"));
  assert.match(html, /Example Department/);
  assert.match(html, /EXD · 1 agency · FY/);
  assert.match(html, /href="\/agencies\/example-department\/"/);
  assert.match(html, new RegExp(`FY${FY} paid out \\$20.3 billion`));
  assert.doesNotMatch(html, BANNED);
});

test("search finds an agency by name", async () => {
  const { html } = await call("/agencies/?q=sample", { DB: db() });
  assert.match(html, /Sample Service/);
  assert.match(html, /Part of the Example Department/);
  assert.doesNotMatch(html, /Quiet Board/);
  assert.equal(checkQuery(new URL("https://x/agencies/?q=a&offset=25")).bad, undefined);
});

test("an agency page: every section, in order, with years and sources", async () => {
  const { status, html } = await call("/agencies/example-department/", { DB: db() });
  assert.equal(status, 200);
  const order = ["What it is", "Leadership", "Money", "Workforce", "Oversight reports", "Rules", "Funding laws", "Agencies in this department"].map((t) => html.indexOf(`>${t}</h2>`));
  assert.ok(order.every((i, k) => i > 0 && (k === 0 || i > order[k - 1])), String(order));
  assert.match(html, /The Example Department carries out examples\./);
  // Leadership: linked to the official's page, the roll call, voice vote as stated, vacant and acting as listed.
  assert.match(html, /href="\/reps\/pat-sample\/"/);
  assert.match(html, /roll call vote/);
  assert.match(html, /Confirmed by the Senate by Voice Vote, May 20, 2025/);
  assert.match(html, />Vacant</);
  assert.match(html, /PTDO, as OPM lists it/);
  // Money: the latest complete fiscal year's outlays, short; exact under Show the numbers.
  assert.match(html, new RegExp(`\\$20.3 billion</p><p class="small secondary">Paid out in fiscal year ${FY} \\(`));
  assert.match(html, /title="\$20,345,678,901">\$20.3 billion<\/td>/);
  assert.match(html, /<th scope="col">Year<\/th><th scope="col">Available<\/th><th scope="col">Committed<\/th><th scope="col">Paid out<\/th>/);
  assert.doesNotMatch(html, /class="fold[" ]/); // no cards inside the Money card
  assert.match(html, /Show the numbers/);
  assert.match(html, /people who receive awards aren(?:'|&#x27;)t listed/);
  assert.match(html, /15,123/);
  assert.match(html, /GAO-27-100001/);
  assert.match(html, /18 rules in 2026/);
  assert.match(html, /S\. 1 · Example Appropriations Act, 2026/);
  assert.doesNotMatch(html, BANNED);
  assert.doesNotMatch(html, /style="[^"]*color/);
});

test("a sub-agency's money: obligations only, never outlays, with the department linked", async () => {
  const { html } = await call("/agencies/sample-service/", { DB: db() });
  assert.match(html, />Money<\/h2>/);
  assert.match(html, new RegExp(`\\$812 million</p><p class="small secondary">Obligations \\(money committed\\) in fiscal year ${FY} \\(`));
  assert.match(html, /Money available and paid out is reported only for the whole department: <a class="inline-link" href="\/agencies\/example-department\/">Example Department ›<\/a>/);
  assert.match(html, /<th scope="col">Obligations \(money committed\)<\/th>/);
  assert.match(html, /title="\$812,345,678">\$812 million<\/td>/);
  assert.match(html, /EXAMPLE SUPPLY CO/);
  assert.doesNotMatch(html, /Paid out in fiscal year|<th scope="col">(Paid out|Available)<\/th>|pair-bars/); // no outlays or resources, never estimated
  assert.doesNotMatch(html, BANNED);
});

test("empty sections are hidden; an agency with only its name says so", async () => {
  const { html } = await call("/agencies/quiet-board/", { DB: db() });
  for (const t of ["What it is", "Leadership", "Money", "Workforce", "Oversight reports", "Rules", "Funding laws"]) assert.doesNotMatch(html, new RegExp(`>${t}</h2>`));
  assert.match(html, /Only this agency's name is loaded so far/);
});

test("nothing loaded: the honest empty state; unknown slug: not found", async () => {
  const { html } = await call("/agencies/", { DB: db({ empty: true }) });
  assert.ok(html.includes(NOT_LOADED.replace(/'/g, "&#x27;")) || html.includes(NOT_LOADED));
  assert.equal((await call("/agencies/no-such-agency/", { DB: db() })).status, 404);
  assert.match((await call("/agencies/", {})).html, /Not loaded yet|not loaded/i);
});

test("confirmation is only what the record states", () => {
  assert.equal(confirmLine({ appointment: "PAS" }), "");
  assert.equal(confirmLine({ appointment: "CA", placement: null }), "");
  assert.match(confirmLine({ appointment: "PAS", confirm_note: "Confirmed by the Senate by Voice Vote.", confirmed_on: "2025-05-20" }), /^Confirmed by the Senate by Voice Vote, May 20, 2025$/);
});

test("the wording rules hold across the source", () => {
  const src = readFileSync(new URL("../../../functions/_lib/agencies.js", import.meta.url), "utf8");
  assert.doesNotMatch(src.replace(/BANNED.*$/m, ""), BANNED);
  assert.doesNotMatch(src, /var\(--(tension|live|yes|no)\)/); // no good/bad colors
  assert.doesNotMatch(src, /ORDER BY [^`"]*(outlays|employees|amount) DESC[^`"]*FROM agencies/i); // no rankings across agencies
  assert.equal(typeof agencyMain, "function");
});
