// node --test test/scotus.test.mjs
// The Supreme Court pages (functions/_lib/scotus.js) from data/scotus/ files in
// the shape tools/build_scotus.py writes. Every name, case and quote here is
// invented. The same layout for every justice; positions only as the lineup
// states them; no ideology labels or scores; individuals in gifts aren't named.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { positionText, lineupGroups, surname, sourceName } from "../../../functions/_lib/scotus.js";

const J = (slug, name, title, oath) => ({
  slug, name, title, state: "Example", appointed_by: "Example", oath_date: oath,
  senate: { predecessor: "Former", nominated: "Jan 1, 2020", nomination_url: "https://www.congress.gov/nomination/1", vote: "52-48", roll_call_url: "https://www.senate.gov/vote_1.htm", roll_call: "1", result: "C" },
  biography: ["He served as a judge on the Example Court of Appeals from 2000–2005."],
  sources: { members: "https://www.supremecourt.gov/about/members_text.aspx", biography: "https://www.supremecourt.gov/about/biographies.aspx#X", senate: "https://www.senate.gov/x.htm" },
});
const DATA = {
  "/data/scotus/justices.json": { justices: [J("ann-able", "Ann Able", "Chief Justice of the United States", "January 1, 2010"), J("bo-baker", "Bo Baker", "Associate Justice", "October 1, 2020")] },
  "/data/scotus/index.json": { current_term: 2026, terms: [2026, 2025] },
  "/data/scotus/terms/2026.json": { term: 2026, cases: [] },
  "/data/scotus/terms/2025.json": {
    term: 2025,
    cases: [
      { r: "2", date: "2026-06-01", docket: "25-100", name: "Example v. Sample", summary: "The example rule applies.", author_code: "AB", pdf: "https://www.supremecourt.gov/opinions/25pdf/25-100.pdf",
        lineup_text: "ABLE, C. J., delivered the opinion of the Court. BAKER, J., filed a dissenting opinion.",
        lineup: { unanimous: false, justices: [{ justice: "Able", roles: ["majority"], wrote: ["majority"] }, { justice: "Baker", roles: ["dissent"], wrote: ["dissent"] }] },
        provisions: [{ id: "amend-4", quote: "The Fourth Amendment protects the example." }] },
      { r: "1", date: "2026-05-01", docket: "25A1", name: "Order v. Order", summary: "", author_code: "PC", pdf: "https://www.supremecourt.gov/opinions/25pdf/25a1.pdf", lineup: [], provisions: [] },
      { r: "0", date: "2019-05-01", docket: "18-1", name: "Before v. Oath", author_code: "AB", pdf: "https://www.supremecourt.gov/x.pdf", lineup: { unanimous: true, justices: [{ justice: "Baker", roles: ["majority"], wrote: ["majority"] }] }, provisions: [] },
    ],
  },
  "/data/scotus/current.json": { term: 2026, built_on: "2026-10-10", source_url: "https://www.supremecourt.gov/orders/grantednotedlists.aspx", cases: [
    { dockets: ["25-200"], name: "PENDING V. CASE", lower_court: "USCA-9", granted: "6/1/26", argument_date: "11/2/26", decided: false, question_presented: ["Whether the example applies."], qp_url: "https://www.supremecourt.gov/qp/25-00200qp.pdf" },
  ] },
  "/data/scotus/disclosures.json": { justices: { "ann-able": [{ year: 2024, report_url: "https://storage.courtlistener.com/x.pdf", gifts: [{ source: "Jane Example", description: "Book", value: "$100" }, { source: "Example University", description: "Plaque", value: "" }], reimbursements: [], source_url: "https://www.courtlistener.com/person/1/x/disclosures/" }] } },
};
const ASSETS = {
  fetch: async (u) => {
    const path = new URL(u).pathname;
    if (path === "/data/constitution.json") return new Response(readFileSync(new URL("../../../data/constitution.json", import.meta.url), "utf8"));
    return DATA[path] ? new Response(JSON.stringify(DATA[path])) : new Response("not found", { status: 404 });
  },
};
const env = { ASSETS };
const call = async (mod, path) => {
  const { onRequestGet } = await import(mod);
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await onRequestGet({ request, env, params: { path: parts }, waitUntil: () => {} });
  return { res, html: res.status === 200 ? await res.text() : "" };
};

test("positions in words, only as the lineup states them", () => {
  assert.equal(positionText({ roles: ["majority"], wrote: ["majority"] }), "Majority · wrote the opinion of the Court");
  assert.equal(positionText({ roles: ["concurring in part and dissenting in part", "majority in part"], wrote: ["concurring in part and dissenting in part"] }), "Joined the majority in part; Concurring in part and dissenting in part · wrote an opinion concurring in part and dissenting in part");
  assert.equal(positionText({ roles: ["dissent"], wrote: [] }), "Dissent");
  assert.deepEqual(lineupGroups(DATA["/data/scotus/terms/2025.json"].cases[0]).map((g) => [g.label, g.names]), [["Majority", ["Able (wrote)"]], ["Dissent", ["Baker (wrote)"]]]);
  assert.equal(surname("John G. Roberts, Jr."), "Roberts");
  assert.equal(surname("Amy Coney Barrett"), "Barrett");
  assert.equal(sourceName("Example University"), "Example University");
  assert.equal(sourceName("Jane Example"), "An individual");
});

test("a justice's page: About · Record · Disclosures · More, the same for every justice", async () => {
  const able = (await call("../../../functions/justices/[[path]].js", "/justices/ann-able/")).html;
  const baker = (await call("../../../functions/justices/[[path]].js", "/justices/bo-baker/")).html;
  for (const html of [able, baker]) {
    assert.match(html, /tab-about[\s\S]*tab-record[\s\S]*tab-disclosures[\s\S]*tab-more/);
    assert.match(html, /Confirmed by the Senate, 52-48/);
    assert.match(html, /href="https:\/\/www\.senate\.gov\/vote_1\.htm"/, "the roll call is linked");
    assert.doesNotMatch(html, /liberal|conservative|moderate|swing|bloc|score/i);
  }
  assert.match(able, /Majority · wrote the opinion of the Court/);
  assert.match(baker, /Dissent · wrote a dissent/);
  assert.doesNotMatch(baker, /Before v\. Oath/, "nothing from before the oath");
  assert.doesNotMatch(able, /Order v\. Order/, "per curiam decisions aren't in a justice's record");
  assert.match(able, /An individual: Book \(\$100\)/, "a person who gave a gift isn't named");
  assert.match(able, /Example University: Plaque/);
  assert.match(baker, /Coming soon for Bo Baker/);
  assert.equal((await call("../../../functions/justices/[[path]].js", "/justices/nobody/")).res.status, 404);
});

test("a decision: summary, lineup, the provision with the Court's own sentence, the opinion", async () => {
  const { html } = await call("../../../functions/court/[[path]].js", "/court/cases/2025/25-100/");
  assert.match(html, /The example rule applies\./);
  assert.match(html, /<strong>Majority:<\/strong> <a class="inline-link" href="\/justices\/ann-able\/">Able \(wrote\)<\/a>/);
  assert.match(html, /href="\/laws\/constitution\/#amend-4"/);
  assert.match(html, /<blockquote class="quote">The Fourth Amendment protects the example\.<\/blockquote>/);
  assert.match(html, /href="https:\/\/www\.supremecourt\.gov\/opinions\/25pdf\/25-100\.pdf"/);
  const pc = (await call("../../../functions/court/[[path]].js", "/court/cases/2025/25A1/")).html;
  assert.match(pc, /Per curiam: an unsigned opinion of the Court/);
});

test("this term: pending cases with argument dates and the question presented; no predictions", async () => {
  const { html } = await call("../../../functions/court/[[path]].js", "/court/term/");
  assert.match(html, /October Term 2026/);
  assert.match(html, /PENDING V\. CASE/);
  assert.match(html, /Argument: Nov 2, 2026/);
  assert.match(html, /Whether the example applies\./);
  assert.match(html, /doesn't predict outcomes/);
});
