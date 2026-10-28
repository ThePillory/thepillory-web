// node --test workers/sync/test/local-money.test.mjs
// Local campaign money from NetFile (functions/_lib/local-money.js): the same
// card for every committee, individuals never named, unmatched never guessed,
// and what the public data doesn't give said plainly. Every name and amount in
// the fixtures is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { candidateMoney, contestSpending, localBehindSection, officialMoney, committeeBlock } from "../../../functions/_lib/local-money.js";

const committee = (o = {}) => ({
  local_id: "SCC-1", fppc_id: "1000001", name: "Ada Park for Example School Board 2026", contributions: 12000, nonmonetary: 500, payments: 8000,
  first: "2026-02-01", last: "2026-10-20", individuals: { total: 7000, count: 40 },
  organizations: [{ name: "Example Teachers Association PAC", total: 5000, count: 2 }], organizations_count: 1,
  employers: [{ employer: "Example Hospital", total: 900, donors: 3 }],
  filings: [{ id: "9", url: "https://netfile.com/Connect2/api/public/image/9", filed: "2026-10-22" }], as_of: "2026-10-22", ...o,
});
const DOC = {
  agency: "SCC", name: "Santa Clara County", county: "06085", since: "2025-01-01", generated: "2026-10-28",
  source_url: "https://public.netfile.com/pub2/?aid=SCC",
  committees: { "SCC-1": committee(), "SCC-2": committee({ local_id: "SCC-2", name: "Yes on Q for Example Schools", individuals: { total: 100, count: 1 }, organizations: [], organizations_count: 0, employers: [] }) },
  candidates: { "SCC-1": { contest: "06085-1", candidate: "Ada Park" } },
  measures: { "SCC-2": { measure: "06085-measure-q", side: "support" } },
  officials: { "Bo Hart": ["SCC-1"] },
  ies: [{ spender: "Example Neighbors PAC", target: "Ada Park", contest: "06085-1", candidate: "Ada Park", amount: 2500, date: "2026-10-01", url: "https://netfile.com/Connect2/api/public/image/7" }],
};

test("a committee: itemized totals, organizations by name, people only as totals, employers with 3+ donors, as of the latest filing", () => {
  const html = committeeBlock(committee(), DOC);
  assert.match(html, /Itemized contributions \$12,000 · Non-monetary \$500 · Itemized payments \$8,000/);
  assert.match(html, /Example Teachers Association PAC[\s\S]*\$5,000/);
  assert.match(html, /From individuals: \$7,000 in 40 itemized contributions \(people aren(?:'|&#x27;)t named\)/);
  assert.match(html, /Example Hospital[\s\S]*3 donors/);
  assert.match(html, /As of the latest filing, Oct 22, 2026[\s\S]*Latest filing/);
  assert.doesNotMatch(html, /cash on hand/i, "never a number NetFile's public data doesn't give");
});

test("a candidate gets money only on a match; anyone else gets a plain line, never a guess", () => {
  assert.match(candidateMoney([DOC], "06085-1", "Ada Park"), /<summary>Campaign money<\/summary>[\s\S]*Ada Park for Example School Board 2026/);
  const other = candidateMoney([DOC], "06085-1", "Cy Kemp");
  assert.match(other, /No committee in Santa Clara County(?:'|&#x27;)s NetFile filings matched this candidate/);
  assert.doesNotMatch(other, /Ada Park for Example/);
  assert.equal(candidateMoney([], "06085-1", "Ada Park"), "", "nothing loaded: nothing shown");
});

test("independent spending names the candidate, never a side the data doesn't state", () => {
  const html = contestSpending([DOC], "06085-1");
  assert.match(html, /Example Neighbors PAC[\s\S]*Ada Park[\s\S]*\$2,500/);
  assert.match(html, /not whether it supported or opposed them/);
  assert.doesNotMatch(html, /\b(supporting|opposing)\b/i);
  assert.equal(contestSpending([DOC], "06085-9"), "");
});

test("who's behind each side: the same layout for Yes and No; the side without a committee says so", () => {
  const html = localBehindSection([DOC], { id: "06085-measure-q", title: "Measure Q" });
  assert.match(html, /Supporting \(Yes\)[\s\S]*Yes on Q for Example Schools[\s\S]*Opposing \(No\)/);
  assert.match(html, /No committee named &quot;No on Measure Q&quot; has filed/);
  assert.doesNotMatch(html, /\b(bought|paid for|because)\b/i);
});

test("a county official's committees on the Funding tab", () => {
  assert.match(officialMoney([DOC], "Bo Hart"), /Ada Park for Example School Board 2026/);
  assert.equal(officialMoney([DOC], "Nobody"), "");
});

test("the real files: no individual's name, every committee linked to its filings", () => {
  const dir = new URL("../../../data/local-money/", import.meta.url);
  const index = new URL("index.json", dir);
  if (!existsSync(index)) return;
  for (const a of JSON.parse(readFileSync(index, "utf8")).agencies) {
    const doc = JSON.parse(readFileSync(new URL(`${a.code}.json`, dir), "utf8"));
    for (const c of Object.values(doc.committees)) {
      for (const f of c.filings) assert.match(f.url, /^https:\/\/netfile\.com\/Connect2\/api\/public\/image\/\d+$/);
      for (const e of c.employers) assert.ok(e.donors >= 3, `${a.code} ${c.name}: an employer needs 3+ donors`);
      assert.deepEqual(Object.keys(c.individuals).sort(), ["count", "total"], "individuals only as totals");
    }
    for (const [lid, m] of Object.entries(doc.candidates)) assert.ok(doc.committees[lid], `${a.code}: ${m.candidate}'s committee is in the file`);
  }
});
