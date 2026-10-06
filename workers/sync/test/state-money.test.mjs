// node workers/sync/test/state-money.test.mjs
// California campaign finance (Cal-Access): matching a legislator to their
// seat's entry, and the rows loaded from it. Every name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seatOf, matchSeat, moneyRows } from "../src/funding/state.js";
import { finishCycle } from "../../../tools/ca_campaign_finish.mjs";

const ENTRY = {
  name: "Ada Testassembly",
  committees: [{ filer_id: "800", name: "Ada Testassembly for Assembly 2026", source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=800", reports: [] }],
  cycles: {
    "2025-2026": finishCycle({
      raised: 51000, spent: 20000, statements: 2,
      individuals: { total: 4850, count: 5 },
      employers: [
        { employer: "EXAMPLE HOSPITAL", total: 4750, count: 4 },
        { employer: "SMALL SHOP", total: 900, count: 1 },
        { employer: "RETIRED", total: 100, count: 1 },
      ],
      organizations: [{ name: "Example Teachers Union PAC", kind: "committee", total: 4900, count: 1, filer_id: "1234" }],
      ie: [
        { spender: "Example Jobs Coalition", filer_id: "700", support_oppose: "support", race: "State Assembly", total: 15000, filings: 2, first: "2026-02-28", last: "2026-03-02", source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=700" },
        { spender: "Example Taxpayers Group", filer_id: "701", support_oppose: "oppose", race: "State Assembly", total: 8000, filings: 1, first: "2026-03-01", last: "2026-03-01", source_url: "https://cal-access.sos.ca.gov/Campaign/Committees/Detail.aspx?id=701" },
      ],
    }),
  },
};

test("a legislator's seat, and their entry by name", () => {
  assert.equal(seatOf({ chamber: "ca-assembly", district_code: "8" }), "ASM-8");
  assert.equal(seatOf({ chamber: "ca-senate", district_code: "04" }), "SEN-4");
  assert.equal(seatOf({ chamber: "us-house", district_code: "5" }), null);
  const seat = [ENTRY, { name: "Bo Challenger", committees: [], cycles: {} }];
  assert.equal(matchSeat(seat, { name: "Ada Testassembly" }), ENTRY);
  assert.equal(matchSeat(seat, { name: "Adaline Testassembly" }), ENTRY, "a longer first name starting the same matches");
  assert.equal(matchSeat(seat, { name: "Zed Testassembly" }), null, "same last name, different first name");
  assert.equal(matchSeat(seat, { name: "Someone Else" }), null);
  // Two entries that both match: no guess.
  assert.equal(matchSeat([ENTRY, { ...ENTRY }], { name: "Ada Testassembly" }), null);
});

test("rows: totals, industries, employers (3 or more donors only), organizations, independent expenditures", () => {
  const r = moneyRows("os:ada", ENTRY);
  assert.equal(r.cycles.length, 1);
  assert.equal(r.cycles[0].raised, 51000);
  assert.equal(r.cycles[0].not_employed_total, 100, "retired donors counted, not listed as an employer");
  assert.equal(r.cycles[0].source_url, ENTRY.committees[0].source_url);
  assert.deepEqual(r.employers.map((e) => [e.employer, e.industry]), [["EXAMPLE HOSPITAL", "health"]]);
  assert.deepEqual(r.orgs.map((o) => [o.name, o.industry]), [["Example Teachers Union PAC", "labor"]]);
  assert.deepEqual(r.ie.map((x) => [x.spender, x.support_oppose, x.race]), [["Example Jobs Coalition", "support", "State Assembly"], ["Example Taxpayers Group", "oppose", "State Assembly"]]);
  const industries = Object.fromEntries(r.industries.map((i) => [i.industry, i.total]));
  assert.equal(industries.health, 4750);
  assert.equal(industries.labor, 4900);
  assert.equal(industries.other, 900, "the small shop counts toward totals even though it isn't listed");
  // No individual's name anywhere: only employers and organizations.
  assert.doesNotMatch(JSON.stringify(r), /Jane|Doe/);
});

test("no committee, no rows", () => {
  assert.deepEqual(moneyRows("x", { name: "X Y", committees: [], cycles: {} }), { cycles: [], industries: [], employers: [], orgs: [], ie: [] });
});
