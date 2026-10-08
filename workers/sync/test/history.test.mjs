// node workers/sync/test/history.test.mjs
// The Time Machine's parsers: Congress by year, House Clerk roll calls, Cabinet
// nominations, FEC totals by period, and who held a seat on a date.
// Every name and number here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { congressOfYear, clerkDate, houseLegis, parseHouseRoll, cabinetPosition, fecCycles, holderOn, holdersInYear } from "../src/history/parse.js";

test("the Congress and session for a year", () => {
  assert.deepEqual(congressOfYear(2001), { congress: 107, session: 1 });
  assert.deepEqual(congressOfYear(2002), { congress: 107, session: 2 });
  assert.deepEqual(congressOfYear(2025), { congress: 119, session: 1 });
});

test("Clerk dates and bill numbers", () => {
  assert.equal(clerkDate("5-Mar-2008"), "2008-03-05");
  assert.equal(clerkDate("nonsense"), null);
  assert.deepEqual(houseLegis("H R 1424"), { type: "HR", number: "1424" });
  assert.deepEqual(houseLegis("H RES 12"), { type: "HRES", number: "12" });
  assert.equal(houseLegis("QUORUM"), null);
});

const ROLL = `<?xml version="1.0"?><rollcall-vote><vote-metadata>
<majority>D</majority><congress>110</congress><session>2nd</session><chamber>U.S. House of Representatives</chamber>
<rollcall-num>101</rollcall-num><legis-num>H R 1424</legis-num><vote-question>On Passage</vote-question>
<vote-type>YEA-AND-NAY</vote-type><vote-result>Passed</vote-result><action-date>5-Mar-2008</action-date>
<vote-desc>Example Act</vote-desc>
<vote-totals><totals-by-vote><total-stub>Totals</total-stub><yea-total>268</yea-total><nay-total>148</nay-total><present-total>0</present-total><not-voting-total>16</not-voting-total></totals-by-vote></vote-totals>
</vote-metadata><vote-data>
<recorded-vote><legislator name-id="A000001" sort-field="Example" unaccented-name="Example" party="D" state="CA" role="legislator">Example</legislator><vote>Yea</vote></recorded-vote>
<recorded-vote><legislator name-id="B000002" sort-field="Sample" unaccented-name="Sample" party="R" state="CA" role="legislator">Sample</legislator><vote>Nay</vote></recorded-vote>
</vote-data></rollcall-vote>`;

test("a House roll call: question, result, totals and each member's vote", () => {
  const r = parseHouseRoll(ROLL);
  assert.equal(r.congress, 110);
  assert.equal(r.session, 2);
  assert.equal(r.roll, 101);
  assert.equal(r.question, "On Passage");
  assert.equal(r.result, "Passed");
  assert.equal(r.date, "2008-03-05");
  assert.equal(r.amendment, false);
  assert.deepEqual(r.totals, { yea: 268, nay: 148, present: 0, not_voting: 16 });
  assert.deepEqual(r.members, [{ bioguide: "A000001", vote: "Yea" }, { bioguide: "B000002", vote: "Nay" }]);
  assert.equal(parseHouseRoll("<html>not found</html>"), null);
});

test("Cabinet offices from nomination descriptions; other posts are not Cabinet", () => {
  assert.equal(cabinetPosition("Jane Example, of Ohio, to be Secretary of Energy."), "Secretary of Energy");
  assert.equal(cabinetPosition("John Sample, of Texas, to be Attorney General, vice Someone Else, resigned."), "Attorney General");
  assert.equal(cabinetPosition("Pat Placeholder, of Iowa, to be Deputy Secretary of Energy."), null);
  assert.equal(cabinetPosition("Lee Example, of Utah, to be Secretary of the Air Force."), null);
});

test("FEC totals by two-year period", () => {
  const rows = fecCycles({ results: [
    { cycle: 2008, receipts: 1000.5, disbursements: 900, last_cash_on_hand_end_period: 100.5, coverage_end_date: "2008-12-31T00:00:00" },
    { cycle: null, receipts: 5 },
  ] });
  assert.deepEqual(rows, [{ cycle: 2008, receipts: 1000.5, disbursements: 900, cash_on_hand: 100.5, coverage_end: "2008-12-31" }]);
  assert.deepEqual(fecCycles(null), []);
});

test("who held a seat on a date and during a year", () => {
  const terms = [
    { name: "First Example", start: "2003-01-03", end: "2007-01-03" },
    { name: "Second Example", start: "2007-01-04", end: "2013-01-03" },
  ];
  assert.deepEqual(holderOn(terms, "2005-06-01").map((t) => t.name), ["First Example"]);
  assert.deepEqual(holdersInYear(terms, 2007).map((t) => t.name), ["First Example", "Second Example"]);
  assert.deepEqual(holdersInYear(terms, 2000), []);
});

// ---------------------------------------------------------------------------
// Past-year pages against a real migrated database (node:sqlite as D1).
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { votesInYear, ordersInYear, cabinetAsOf, fundingInCycle, officialVotesInYear } from "../../../functions/_lib/history.js";
import { placePastYear, officialPastYear, topicPastYear } from "../../../functions/_lib/history-pages.js";

const MIGRATIONS = new URL("../migrations/", import.meta.url);
const SRC = "https://example.org/source";
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return { prepare: (sql) => stmt(sql) };
}
function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIGRATIONS), "utf8"));
  const off = sqlite.prepare("INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified, active, state, district_code, rank, bioguide_id, term_end) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', ?, 'CA', ?, ?, ?, ?)");
  off.run("bioguide:Y000002", "member-example", "Member Example", "U.S. Representative", "federal", "us-house", "us-house", SRC, 0, "4", null, "Y000002", "2017");
  off.run("bioguide:X000001", "senator-example", "Senator Example", "U.S. Senator", "federal", "us-senate", "us-senate", SRC, 1, null, null, "X000001", null);
  off.run("exec:govtrack:1", "president-example", "President Example", "President", "federal", "us-executive", "us-executive", SRC, 0, null, 1, null, "2017-01-20");
  sqlite.prepare("INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES ('hr-1', 'federal', 'us-house', 'H.R. 1', '114', 'An Example Act', ?)").run(SRC);
  const vote = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES (?, ?, 'federal', ?, ?, 'On Passage', ?, 'Passed', ?)");
  vote.run("us-house-114-1-10", "hr-1", "us-house", "2015-03-01", "final_passage", SRC);
  vote.run("us-house-114-1-11", null, "us-house", "2015-03-02", "procedural", SRC);
  vote.run("us-house-115-1-10", "hr-1", "us-house", "2017-03-01", "final_passage", SRC);
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, ?, ?, ?)");
  pos.run("us-house-114-1-10", "bioguide:Y000002", "Yes", "Yea");
  pos.run("us-house-114-1-11", "bioguide:Y000002", "No", "Nay");
  pos.run("us-house-115-1-10", "bioguide:Y000002", "No", "Nay");
  sqlite.prepare("INSERT INTO executive_actions (id, official_id, kind, number, title, signed_on, published_on, source_url) VALUES ('fr:1', 'exec:govtrack:1', 'executive_order', '13700', 'An Example Order', '2015-06-01', '2015-06-03', ?)").run(SRC);
  const nom = sqlite.prepare("INSERT INTO nominations (id, congress, official_id, description, received_on, latest_on, status, source_url) VALUES (?, 114, 'exec:govtrack:1', ?, '2015-01-10', ?, ?, ?)");
  nom.run("PN1", "Jane Example, of Ohio, to be Secretary of Energy, vice Someone.", "2015-02-01", "confirmed", SRC);
  nom.run("PN2", "John Example, of Iowa, to be Secretary of Energy.", "2016-02-01", "withdrawn", SRC);
  nom.run("PN3", "Pat Example, of Utah, to be Deputy Secretary of State.", "2015-02-01", "confirmed", SRC);
  sqlite.prepare("INSERT INTO funding_cycles (official_id, fec_id, cycle, receipts, disbursements, cash_on_hand, coverage_end, source_url) VALUES ('bioguide:Y000002', 'H0XX00001', 2016, 1000, 900, 100, '2016-12-31', ?)").run(SRC);
  return d1(sqlite);
}

test("past-year queries read only that year, and only the officials asked for", async () => {
  const db = seeded();
  const v = await votesInYear(db, ["bioguide:Y000002"], 2015);
  assert.deepEqual(v.rows.map((r) => r.id), ["us-house-114-1-10"]); // final passage only, 2015 only
  assert.equal(v.rows[0].positions[0].position, "Yes");
  assert.deepEqual((await votesInYear(db, ["bioguide:X000001"], 2015)).rows, []);
  assert.equal((await officialVotesInYear(db, "bioguide:Y000002", 2015, { all: true })).rows.length, 2);
  const o = await ordersInYear(db, 2015);
  assert.equal(o.count, 1);
  assert.equal(o.rows[0].official_name, "President Example");
  const cab = await cabinetAsOf(db, 2016);
  const energy = cab.find((c) => c.position === "Secretary of Energy");
  assert.equal(energy.name, "Jane Example"); // the withdrawn nomination doesn't replace the confirmed one
  assert.ok(cab.find((c) => c.position === "Secretary of State").missing); // a deputy isn't the Secretary
  assert.equal((await cabinetAsOf(db, 2014)).find((c) => c.position === "Secretary of Energy").missing, true);
  const f = await fundingInCycle(db, ["bioguide:Y000002"], 2015);
  assert.equal(f[0].cycle, 2016);
});

const HISTORY = {
  "/data/history/federal-executive.json": { terms: [{ office: "President", name: "President Example", start: "2009-01-20", end: "2017-01-20", party: "Party A", govtrack: 1 }] },
  "/data/history/congress/ca.json": {
    senate: [{ name: "Senator Example", bioguide: "X000001", start: "2011-01-05", end: "2017-01-03", party: "Party B" }],
    house: { 4: [{ name: "Member Example", bioguide: "Y000002", start: "2013-01-03", end: "2017-01-03", party: "Party A" }] },
  },
  "/data/history/districts/ca.json": { periods: [{ from: 2013, to: 2022, cd: { "06009": [["4", 1]] }, sldu: { "06009": [["8", 1]] }, sldl: { "06009": [["5", 1]] }, note: "Example.", source: SRC }] },
  "/data/history/california.json": { governors: { source: SRC, list: [{ name: "Governor Example", from: 2011, to: 2019 }] }, elections: [], legislature_makeup: [] },
};
const ENV = (db) => ({ DB: db, ASSETS: { fetch: async (u) => (HISTORY[new URL(u).pathname] ? new Response(JSON.stringify(HISTORY[new URL(u).pathname])) : new Response("", { status: 404 })) } });
const PLACE = { st: "CA", name: "California", chambers: {} };
const COUNTY = { fips: "06009", slug: "example-county", name: "Example County" };

test("a county in a past year: who held office, votes, orders, money, the banner and what's missing", async () => {
  const url = new URL("https://x.test/place/ca/example-county/?year=2015");
  const html = await (await placePastYear(ENV(seeded()), new Request(url), url, PLACE, COUNTY, 2015)).text();
  assert.match(html, /class="past-banner"/);
  assert.match(html, /href="\/place\/ca\/example-county\/">Back to today/);
  assert.match(html, /President Example/);
  assert.match(html, /Party: Party A/);
  assert.match(html, /href="\/reps\/member-example\/\?year=2015"/);
  assert.match(html, /Governor Example/);
  assert.match(html, /H\.R\. 1/);
  assert.match(html, /An Example Order/);
  assert.match(html, /Raised \$1,000/);
  assert.match(html, /Not available for 2015/);
  assert.match(html, /no online county record of past supervisors/);
  assert.doesNotMatch(html, /\b(caused|because of|thanks to|blame)\b/i);
  const early = await (await placePastYear(ENV(seeded()), new Request(url), url, PLACE, COUNTY, 1998)).text();
  assert.match(early, /District lines for Example County in 1998/);
  assert.match(early, /Votes in Congress in 1998/);
});

test("an official in a past year, and a year they didn't serve", async () => {
  const db = seeded();
  const o = await db.prepare("SELECT * FROM officials WHERE id = 'bioguide:Y000002'").first();
  const url = new URL("https://x.test/reps/member-example/?year=2015");
  const html = await (await officialPastYear(ENV(db), new Request(url), url, o, 2015)).text();
  assert.match(html, /Member Example in 2015/);
  assert.match(html, /U\.S\. Representative, CA-4/);
  assert.match(html, /Votes in 2015/);
  assert.match(html, /Every term on record/);
  const out = await (await officialPastYear(ENV(db), new Request(url), url, o, 2005)).text();
  assert.match(out, /didn't hold a seat in Congress in 2005/);
});

test("a topic in a past year says what isn't available", async () => {
  const url = new URL("https://x.test/topics/water/?year=2015");
  const html = await (await topicPastYear(ENV(seeded()), url, "water", 2015)).text();
  assert.match(html, /Water in 2015/);
  assert.match(html, /Not available for 2015/);
});
