// node --test workers/sync/test/measure-people.test.mjs
// Ballot measure pages: who's behind each side (functions/_lib/measure-people.js)
// and the argument signers (workers/sync/src/elections/signers.js). Every name
// and amount in the fixtures is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { orgFromTitle, isGovernment, officeTitle, matchSigner, signerOrgs } from "../src/elections/signers.js";
import { behindSection, signerDetails } from "../../../functions/_lib/measure-people.js";

const SRC = "https://example.org/source";

test("titles: the organization a title names, government bodies, and offices held now", () => {
  assert.equal(orgFromTitle("Co-President, Example League of Voters"), "Example League of Voters");
  assert.equal(orgFromTitle("MPA, Executive Director, Example Common Cause"), "Example Common Cause");
  assert.equal(orgFromTitle("MD, President, Example College of Physicians, California Chapter"), "Example College of Physicians, California Chapter");
  assert.equal(orgFromTitle("California State Senator"), null);
  assert.equal(orgFromTitle("Registered Voter"), null);
  assert.equal(orgFromTitle("Cancer Survivor, Santa Monica"), null, "a place isn't an organization");
  assert.ok(isGovernment("Fair Political Practices Commission"));
  assert.ok(isGovernment("Senate Elections Committee"));
  assert.ok(!isGovernment("Example Nurses Association"));
  assert.ok(officeTitle("Senate Minority Leader"));
  assert.ok(officeTitle("Assemblymember"));
  assert.ok(!officeTitle("Former Chair, Fair Political Practices Commission"));
  assert.ok(!officeTitle("Fmr. California State Controller"));
  assert.ok(!officeTitle("Treasurer, Example Taxpayers Association"), "an officer of an organization isn't an elected official");
});

test("signers are linked only on a unique match and a title that names an office", () => {
  const officials = [{ id: "o1", slug: "ada-park", name: "Ada Park" }, { id: "o2", slug: "brian-jones", name: "Brian Jones" }];
  const contest = { id: "governor", office: "Governor" };
  const candidates = [{ name: "Cy Kemp", party: "Party C", contest }];
  assert.equal(matchSigner({ name: "Brian W. Jones", title: "Senate Minority Leader" }, officials, candidates).o.slug, "brian-jones", "a middle initial");
  assert.equal(matchSigner({ name: "Ada Park", title: "President, Example League" }, officials, candidates), null, "a private person who shares a name");
  assert.equal(matchSigner({ name: "Cy Kemp", title: "Mayor" }, officials, candidates).c.name, "Cy Kemp", "a candidate when no official matches");
  assert.equal(matchSigner({ name: "Ada Park", title: "Senator" }, [...officials, { id: "o3", slug: "ada-park-2", name: "Ada Park" }], []), null, "two officials could be them: no link");
  const election = { measures: [{ arguments: [{ signers: [{ name: "X", title: "President, Example League" }, { name: "Y", title: "Chair, Example Commission" }, { name: "Z", title: "President, Example League" }] }] }] };
  assert.deepEqual(signerOrgs(election), ["Example League"], "organizations once each, no government bodies");
});

const committee = (o) => ({
  filer_id: "1", name: "Yes on 9, Example Committee", side: "support", props: [{ number: "9", side: "support" }], raised: 1000, spent: 400, cash_end: 600,
  statements: 2, through: "2026-10-17", filed: "2026-10-22", source_url: SRC, statement_url: SRC,
  individuals: { total: 250, count: 3 }, organizations: [{ name: "Example Builders Association", kind: "organization", total: 500, count: 1, statement_url: SRC }], organizations_count: 1, ...o,
});
const MONEY = {
  generated: "2026-10-27",
  measures: {
    9: { cal_access_url: SRC, committees: [committee()], spending: [{ side: "oppose", spender: null, person: true, people: 2, total: 9000, filings: 2, first: "2026-10-01", last: "2026-10-09", source_url: null }] },
  },
  orgs: { "EXAMPLE BUILDERS ASSOCIATION": { name: "Example Builders Association", gave: [{ committee: "Yes on 9, Example Committee", filer_id: "1", props: [{ number: "9", side: "support" }], total: 500, source_url: SRC }], spent: [] } },
};
const ELECTION = { election: { id: "2026-11-03", state: "CA" }, contests: [], measures: [] };

test("who's behind each side: the same layout for Yes and No, people never named, what's missing said plainly", () => {
  const html = behindSection(MONEY, { number: "9" }, ELECTION);
  assert.match(html, /<details class="fold" id="behind">/, "collapsed until opened");
  assert.match(html, /Supporting \(Yes\)[\s\S]*Opposing \(No\)/);
  assert.match(html, /Yes on 9, Example Committee[\s\S]*Raised \$1,000 · Spent \$400 · Cash on hand \$600/);
  assert.match(html, /Example Builders Association[\s\S]*\$500/);
  assert.match(html, /From individuals: \$250 in 3 itemized contributions \(people aren(?:'|&#x27;)t named\)/);
  assert.match(html, /As of the statement covering through/);
  assert.match(html, /No committee formed to oppose this measure has filed a campaign statement naming it\./);
  assert.match(html, /2 people spending their own money \(not named\)/);
  assert.doesNotMatch(html, /\b(bought|paid for|because|in exchange)\b/i, "no cause and effect");
  assert.match(behindSection(MONEY, { number: "8" }, ELECTION), /isn(?:'|&#x27;)t loaded yet/);
  assert.match(behindSection(null, { number: "1" }, { election: { state: "WA" } }), /Campaign committee data for Washington(?:'|&#x27;)s measures isn(?:'|&#x27;)t loaded yet/);
  const negative = behindSection({ ...MONEY, measures: { 9: { ...MONEY.measures[9], committees: [committee({ raised: -5000 })] } } }, { number: "9" }, ELECTION);
  assert.match(negative, /Raised −\$5,000/);
});

// A D1 stand-in: answers by the table each query reads.
function db(tables) {
  return {
    prepare(sql) {
      const table = (Object.keys(tables).find((t) => sql.includes(` ${t} `) || sql.includes(` ${t}\n`)) || "");
      const rows = tables[table] || [];
      return { bind() { return this; }, all: async () => ({ results: rows }), first: async () => rows[0] || null };
    },
  };
}

test("signer panels: officials and organizations get a collapsed panel; private people stay as printed", async () => {
  const m = {
    number: "9",
    arguments: [
      { kind: "for", signers: [{ name: "Ada Park", title: "California State Senator" }, { name: "Lee Moss", title: "President, Example Builders Association" }, { name: "Quinn Reyes", title: "Registered Voter" }] },
      { kind: "against", signers: [{ name: "Bo Hart", title: "Former Chair, Example Commission" }] },
    ],
  };
  const ctx = { officials: [{ id: "o1", slug: "ada-park", name: "Ada Park", office: "State Senator", district: "District 9", party: "Party A", level: "state", chamber: "ca-senate" }], candidates: [] };
  const stub = db({
    org_lookups: [{ ein: "12-3456789", subsection: 6 }],
    ca_lobby_reports: [{ employer_id: "e1", employer_name: "Example Builders Association", period_end: "2026-03-31", amount: 12000, source_url: SRC }],
    state_money_cycles: [{ raised: 42000 }],
  });
  const d = await signerDetails(stub, ELECTION, m, MONEY, ctx);
  const ada = d.get("Ada Park|California State Senator");
  assert.equal(ada.href, "/reps/ada-park/");
  assert.match(ada.panel, /<details class="signer-more">\s*<summary>About Ada Park<\/summary>/, "closed by default");
  assert.match(ada.panel, /State Senator, District 9[\s\S]*Party A[\s\S]*Full record ›[\s\S]*\$42,000 raised/);
  const lee = d.get("Lee Moss|President, Example Builders Association");
  assert.equal(lee.href, null, "a private person isn't linked");
  assert.match(lee.panel, /About Example Builders Association[\s\S]*501\(c\)\(6\)[\s\S]*\$12,000 in total lobbying payments reported, 2026[\s\S]*Gave \$500 to Yes on 9, Example Committee/);
  assert.doesNotMatch(lee.panel, /Party/, "no party for an organization");
  assert.deepEqual(d.get("Quinn Reyes|Registered Voter"), { href: null, panel: "" }, "a private individual: as printed, no panel");
  assert.deepEqual(d.get("Bo Hart|Former Chair, Example Commission"), { href: null, panel: "" }, "a government body: no panel");
});
