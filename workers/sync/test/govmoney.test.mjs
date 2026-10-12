// Tests for money from government to organizations, privately paid travel and
// foreign agents' contacts (docs/funding.md): the member's More tab sections,
// an appropriations bill's earmarks, and the federal awards page. Every row and
// response here is FAKE; names are placeholders.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { appropriationsOf, memberGovMoney, earmarksSection, travelSection, faraSection, billEarmarks, billEarmarksSection, officialNames, awardsLink } from "../../../functions/_lib/gov-money.js";
import { nameKey, fiscalYears, lookUp } from "../../../functions/awards/index.js";

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec("CREATE TABLE officials (id TEXT PRIMARY KEY, slug TEXT, name TEXT, chamber TEXT);");
  sqlite.exec(readFileSync(new URL("../migrations/0031_gov_money.sql", import.meta.url), "utf8"));
  sqlite.exec(`
    INSERT INTO officials VALUES ('h1', 'ann-example', 'Ann Example', 'us-house'), ('s1', 'sam-example', 'Sam Example', 'us-senate');
    INSERT INTO earmark_tables (source_url, fy, stage, subcommittee, status, rows) VALUES
      ('https://example.gov/ag', 2026, 'enacted', 'agriculture', 'read', 2), ('https://example.gov/fsgg', 2026, 'enacted', 'fsgg', 'link', 0);
    INSERT INTO earmarks (id, fy, stage, subcommittee, state, recipient, project, amount, origination, source_url) VALUES
      ('e1', 2026, 'enacted', 'agriculture', 'CA', 'Example Water District', 'Pipes', 1000000, 'H', 'https://example.gov/ag'),
      ('e2', 2026, 'enacted', 'agriculture', 'NV', 'Example Clinic', 'Clinic Equipment', 250000, 'S', 'https://example.gov/ag');
    INSERT INTO earmark_requesters VALUES ('e1', 'Example', 'house', 'h1'), ('e1', 'Example (CA)', 'senate', 's1'), ('e2', 'Example', 'senate', 's1');
    INSERT INTO earmark_requests (id, fy, official_id, member_name, recipient, project, amount_requested, enacted_id, source_url) VALUES
      ('q1', 2026, 'h1', 'Ann Example', 'Example Water District', 'Pipes', 1500000, 'e1', 'https://example.gov/req'),
      ('q2', 2026, 'h1', 'Ann Example', 'Example Library', 'Roof', 400000, NULL, 'https://example.gov/req'),
      ('q3', 2025, 'h1', 'Ann Example', 'Example Library', 'Roof', 300000, NULL, 'https://example.gov/req25');
    INSERT INTO gift_travel VALUES ('t1', 'h1', 'house', 'member', 'Example Association', 'Las Vegas, NV', '2026-01-07', '2026-01-09', 'https://example.gov/t1.pdf'),
                                   ('t2', 'h1', 'house', 'staff', 'Example Institute', 'Example City', '2025-05-01', '2025-05-03', 'https://example.gov/t2.pdf');
    INSERT INTO fara_registrants VALUES (9001, 'EXAMPLE STRATEGIES LLC', '2024-01-01', NULL, 'Washington', 'DC', 'https://efile.fara.gov/x');
    INSERT INTO fara_contacts VALUES ('https://efile.fara.gov/docs/9001.pdf', 0, 9001, 'h1', 'office', 'Example Embassy', '2026-03-12', 'Email', '2026-09-30');`);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { prepare: (sql) => stmt(sql) };
}

// Money and lobbying sit beside these facts; nothing on the page ties them together in words.
const CAUSAL = /\b(in return|in exchange|because|payoff|reward|bought|paid for|thanks to|after (giving|receiving|lobbying|voting))\b/i;

test("an appropriations act's fiscal year and subcommittee come from its title", () => {
  assert.deepEqual(appropriationsOf("Agriculture, Rural Development, Food and Drug Administration, and Related Agencies Appropriations Act, 2026"), { fy: 2026, subcommittees: ["agriculture"], consolidated: false });
  assert.equal(appropriationsOf("Consolidated Appropriations Act, 2026").consolidated, true);
  assert.deepEqual(appropriationsOf("Commerce, Justice, Science; Energy and Water Development; and Interior and Environment Appropriations Act, 2026").subcommittees, ["cjs", "energy-water", "interior"]);
  assert.equal(appropriationsOf("An Act to rename a post office"), null);
});

test("a House member's earmarks: table rows with the request tied to them, and requests not tied", async () => {
  const db = d1();
  const g = await memberGovMoney(db, "h1");
  const html = earmarksSection({ name: "Ann Example", chamber: "us-house" }, g);
  assert.match(html, /Fiscal year 2026 · 1 project in the tables, \$1,000,000 · 2 requests, \$1,900,000 requested/);
  assert.match(html, /Enacted, FY2026 Agriculture · requested \$1,500,000 · 1 other requester/);
  assert.match(html, /Requested, .*?not matched to one row in the FY2026 enacted tables|Requested · not matched to one row in the FY2026 enacted tables/);
  assert.match(html, /the enacted tables for FY2025 aren't loaded/);
  assert.match(html, /\/awards\/\?name=Example%20Water%20District/);
  assert.match(html, /FY2026 Financial Services and General Government ↗<\/a> \(not read: see the table\)/);
  assert.doesNotMatch(html, CAUSAL);
  const senate = earmarksSection({ name: "Sam Example", chamber: "us-senate" }, await memberGovMoney(db, "s1"));
  assert.match(senate, /Senators post their requests on their own websites/);
  assert.match(senate, /2 projects in the tables, \$1,250,000/);
});

test("travel and foreign agents' contacts: facts with their reports, staff never named", async () => {
  const g = await memberGovMoney(d1(), "h1");
  const t = travelSection({ name: "Ann Example", chamber: "us-house" }, g);
  assert.match(t, /2 trips disclosed since 2023: 1 by Ann Example, 1 by staff/);
  assert.match(t, /Example Association.*Ann Example · Las Vegas, NV/s);
  assert.match(t, /A staff member · Example City/);
  const f = faraSection({ name: "Ann Example" }, g);
  assert.match(f, /EXAMPLE STRATEGIES LLC.*for Example Embassy · with the member's office · Email/s);
  assert.match(f, /doesn't say what the member did or thought/);
  for (const html of [t, f]) assert.doesNotMatch(html, CAUSAL);
  assert.match(travelSection({ name: "X", chamber: "us-senate" }, { travel: [] }), /No privately paid trips/);
  assert.match(faraSection({ name: "X" }, null), /haven't been loaded yet/);
});

test("a bill's earmarks: the tables' list for its fiscal year and subcommittee, largest first", async () => {
  const db = d1();
  const ap = appropriationsOf("Agriculture Appropriations Act, 2026");
  const data = await billEarmarks(db, { fy: 2026, subcommittees: ap.subcommittees, limit: 10 });
  assert.deepEqual(data.rows.map((r) => r.id), ["e1", "e2"]);
  assert.deepEqual(data.states.map((s) => s.state), ["CA", "NV"]);
  const names = await officialNames(db, ["h1", "s1"]);
  const html = billEarmarksSection({ id: "us-119-hr-1" }, ap, data, names);
  assert.match(html, /2 projects, \$1,250,000<\/strong>, in the enacted FY2026 appropriations \(Agriculture\)/);
  assert.match(html, /Requested by <a class="inline-link" href="\/reps\/ann-example\/">Example \(House\)<\/a>, <a class="inline-link" href="\/reps\/sam-example\/">Example \(CA\) \(Senate\)<\/a>/);
  assert.match(html, /may have listed different ones/);
  const none = billEarmarksSection({ id: "x" }, appropriationsOf("Agriculture Appropriations Act, 2031"), await billEarmarks(db, { fy: 2031, subcommittees: ["agriculture"] }), {});
  assert.match(none, /No earmark tables for fiscal year 2031/);
  const nv = await billEarmarks(db, { fy: 2026, subcommittees: ["agriculture"], state: "NV" });
  assert.deepEqual(nv.rows.map((r) => r.id), ["e2"]);
});

test("federal awards: only recipients with exactly the name, each separately, by fiscal year", async () => {
  assert.equal(nameKey("The Example Co., Inc."), "example");
  assert.equal(awardsLink("Example Water District"), ' <a class="tap small awards-link" href="/awards/?name=Example%20Water%20District">Federal awards</a>');
  assert.equal(awardsLink(" "), "");
  assert.deepEqual(fiscalYears(new Date("2026-10-12T00:00:00Z"), 2), [{ fy: 2027, start: "2026-10-01", end: "2027-09-30" }, { fy: 2026, start: "2025-10-01", end: "2026-09-30" }]);
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push(String(url));
    const body = init.body ? JSON.parse(init.body) : null;
    const json = (o) => ({ ok: true, json: async () => o });
    if (String(url).endsWith("/recipient/") && body) return json({ results: [
      { id: "r1-C", name: "EXAMPLE WATER DISTRICT", uei: "U1", recipient_level: "C", amount: 5 },
      { id: "r2-C", name: "EXAMPLE WATER DISTRICT OF NEVADA", uei: "U2", recipient_level: "C", amount: 9 },
    ] });
    if (String(url).includes("/recipient/r1-C/")) return json({ location: { city_name: "Exampletown", state_code: "CA" } });
    if (String(url).includes("spending_by_category")) return json({ results: body.filters.time_period[0].start_date.startsWith("2025") ? [{ name: "Department of Example", amount: 1200 }] : [] });
    throw new Error(`unexpected ${url}`);
  };
  const got = await lookUp("Example Water District", new Date("2026-10-12T00:00:00Z"));
  assert.equal(got.recipients.length, 1);
  assert.equal(got.recipients[0].location, "Exampletown, CA");
  assert.deepEqual(got.recipients[0].years.map((y) => [y.fy, y.total]), [[2027, 0], [2026, 1200], [2025, 0], [2024, 0]]);
});
