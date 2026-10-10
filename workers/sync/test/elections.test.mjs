// node workers/sync/test/elections.test.mjs
// Elections (functions/_lib/elections.js and the /elections/ pages): ballot
// order from the randomized alphabet, which contests are on a ballot, matching
// officeholders by name, results only after the polls close, and pages that show
// every candidate the same way. Every name in the fixture is invented; one test
// also checks the real data file's county contests against its alphabet.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  nameParts, compareNames, alphabetOrder, rotateFor, ballotOrder, ballotFor, courtGroups, sameName, holderFor,
  pollsClosed, sosResults, candidateResults, measureResult, daysUntil,
} from "../../../functions/_lib/elections.js";

const ALPHA = "HXKWCPJOZALDNSQBIRYGVEFMTU".split("");
const SRC = "https://example.org/source";

const ELECTION = {
  election: {
    id: "2026-11-03", name: "November 3, 2026, General Election", date: "2026-11-03", polls_close_utc: "2026-11-04T04:00:00Z", state: "CA",
    alphabet: ALPHA, results_api: "https://results.example.org/returns/", results_page: "https://results.example.org/",
    certified_list: SRC, guide: SRC, alphabet_source: SRC, sos_page: SRC,
  },
  how_to_vote: { state: [{ label: "Register to vote", url: "https://register.example.org/", by: "Secretary of State" }], "06999": [{ label: "Where to vote", url: "https://county.example.org/where", by: "Example County Elections" }] },
  counties: { "06999": { name: "Example County", elections_page: SRC, results_page: "https://county.example.org/results", pamphlet_pdf: SRC, boe: "1" } },
  contests: [
    { id: "governor", office: "Governor", scope: "statewide", district: null, results_path: "governor", vote_for: 1, source_url: SRC, source: "Certified list",
      candidates: [
        { name: "Alma Zed", party: "Party One", designation: "Teacher", incumbent: false, statement: { paragraphs: ["I will listen."], source_url: SRC, source: "Official Voter Information Guide, Secretary of State" } },
        { name: "Bo Hart", party: "Party Two", designation: "Farmer", incumbent: false },
        { name: "Cy Kemp", party: "No Party Preference", designation: "", incumbent: false },
      ] },
    { id: "us-rep-9", office: "United States Representative District 9", scope: "cd", district: "9", results_path: "us-rep/district/9", vote_for: 1, source_url: SRC, source: "Certified list",
      candidates: [{ name: "Dee Lane", party: "Party One", designation: "Nurse", incumbent: false, fec: { id: "H0XX00001", url: "https://www.fec.gov/data/candidate/H0XX00001/" } }, { name: "Ed Hale", party: "Party Two", designation: "Member of Congress", incumbent: true }] },
    { id: "us-rep-10", office: "United States Representative District 10", scope: "cd", district: "10", results_path: "us-rep/district/10", vote_for: 1, source_url: SRC, source: "Certified list", candidates: [{ name: "Fay Gill", party: "Party One", designation: "", incumbent: false }] },
    { id: "state-senate-2", office: "State Senate District 2", scope: "sldu", district: "2", results_path: "state-senate/district/2", vote_for: 1, source_url: SRC, source: "Certified list", candidates: [{ name: "Gus Ives", party: "Party Two", designation: "", incumbent: false }] },
    { id: "state-assembly-3", office: "State Assembly Member District 3", scope: "sldl", district: "3", results_path: "state-assembly/district/3", vote_for: 1, source_url: SRC, source: "Certified list", candidates: [{ name: "Hal Jones", party: "Party One", designation: "", incumbent: true }] },
    { id: "board-of-equalization-1", office: "Board of Equalization Member District 1", scope: "boe", district: "1", results_path: "board-of-equalization/district/1", vote_for: 1, source_url: SRC, source: "Certified list", candidates: [{ name: "Ivy Kerr", party: "Party Two", designation: "", incumbent: false }] },
    { id: "board-of-equalization-2", office: "Board of Equalization Member District 2", scope: "boe", district: "2", results_path: "board-of-equalization/district/2", vote_for: 1, source_url: SRC, source: "Certified list", candidates: [{ name: "Jo Lund", party: "Party One", designation: "", incumbent: false }] },
    { id: "supreme-court-1", office: "Associate Justice of the Supreme Court", scope: "judicial", court: "supreme", district: null, court_name: "Supreme Court", counties: ["all"], question: "Shall Associate Justice of the Supreme Court KIT MOSS be elected to the office for the term provided by law?", justice: "KIT MOSS", vote_for: 1, candidates: [], results_path: null, source_url: SRC, source: "Certified list" },
    { id: "court-of-appeal-3-1", office: "Associate Justice, Court of Appeal, Third District", scope: "judicial", court: "appeal", district: "3", court_name: "Court of Appeal, Third Appellate District", counties: ["Example", "Other"], question: "Shall Associate Justice LEE NASH be elected to the office for the term provided by law?", justice: "LEE NASH", vote_for: 1, candidates: [], results_path: null, source_url: SRC, source: "Certified list" },
    { id: "court-of-appeal-5-1", office: "Associate Justice, Court of Appeal, Fifth District", scope: "judicial", court: "appeal", district: "5", court_name: "Court of Appeal, Fifth Appellate District", counties: ["Elsewhere"], question: "Shall Associate Justice MO OAKS be elected to the office for the term provided by law?", justice: "MO OAKS", vote_for: 1, candidates: [], results_path: null, source_url: SRC, source: "Certified list" },
    { id: "06999-1001", office: "TOWN COUNCIL", scope: "county", county: "06999", district: null, vote_for: 2, source_url: SRC, source: "Example County Elections, Qualified Candidates List", results_url: "https://county.example.org/results",
      candidates: [{ name: "PAT HILL", party: null, designation: "Retired Clerk", incumbent: false }, { name: "ROB ABEL", party: null, designation: "Incumbent", incumbent: true }] },
  ],
  measures: [
    { id: "prop-1", number: "1", title: "AUTHORIZES EXAMPLE BONDS. LEGISLATIVE STATUTE.", scope: "statewide", summary: "Authorizes example bonds.", yes_means: "A YES vote on this measure means: example yes.", no_means: "A NO vote on this measure means: example no.",
      ag_summary: ["Authorizes $1 billion in example bonds.", "Requires annual audits."], fiscal_heading: "SUMMARY OF LEGISLATIVE ANALYST'S ESTIMATE OF NET STATE AND LOCAL GOVERNMENT FISCAL IMPACT", fiscal_effect: ["Example state costs of about $50 million a year."],
      // Out of order on purpose: the page puts them in the guide's order.
      arguments: [
        { kind: "rebuttal_for", side: "supporters", heading: "REBUTTAL TO ARGUMENT AGAINST PROPOSITION 1", paragraphs: ["The supporters reply."], signers: [{ name: "Quinn Reyes", title: "President, Example Association" }], none_submitted: null },
        { kind: "against", side: "opponents", heading: "ARGUMENT AGAINST PROPOSITION 1", paragraphs: ["Vote no because of the example."], signers: [{ name: "Lee Moss", title: "Director, Example Taxpayers" }], none_submitted: null },
        { kind: "rebuttal_against", side: "opponents", heading: "REBUTTAL TO ARGUMENT IN FAVOR OF PROPOSITION 1", paragraphs: ["The opponents reply."], signers: [{ name: "Ada Park", title: "U.S. Senator" }], none_submitted: null },
        { kind: "for", side: "supporters", heading: "ARGUMENT IN FAVOR OF PROPOSITION 1", paragraphs: ["Vote yes because of the example."], signers: [{ name: "Quinn Reyes", title: "President, Example Association" }], none_submitted: null },
      ],
      arguments_disclaimer: "Arguments printed on this page are the opinions of the authors and have not been checked for accuracy by any official agency.",
      links: { guide: SRC, title_summary: SRC, analysis: SRC, arguments: SRC, text: SRC }, results_path: "ballot-measures", results_number: "01", source_url: SRC, source: "Official Voter Information Guide, Secretary of State" },
    { id: "06999-measure-a", number: "A", title: "Measure A", question: "Shall the example district issue bonds?", scope: "county", county: "06999", jurisdiction: "Example School District",
      impartial_analysis: ["A yes vote would authorize bonds."], impartial_analysis_by: "County Counsel", tax_rate_statement: [], arguments: [{ kind: "for", heading: "Argument in favor of Measure A", paragraphs: ["Vote yes."], signers: [{ name: "Sam Tate", title: "Registered Voter" }], none_submitted: null }, { kind: "against", heading: "Argument against Measure A", paragraphs: [], signers: [], none_submitted: "No argument against Measure A was filed." }],
      links: { pamphlet: SRC, page: SRC }, results_url: "https://county.example.org/results", source_url: SRC, source: "Example County Voter Information Pamphlet", note: "Text from the county's PDF, as printed." },
  ],
};

const PLACE = { st: "CA", name: "California", chambers: { sldu: "State Senate", sldl: "State Assembly" }, counties: [{ fips: "06999", slug: "example", name: "Example County", cd: [["9", 1]], sldu: [["2", 1]], sldl: [["3", 1]], neighbors: [] }], districts: {} };

test("names: last name first, keeping particles, dropping suffixes and nicknames", () => {
  assert.deepEqual(nameParts("Rickey Tracy Hayes II"), { last: "Hayes", first: "Rickey", middle: "Tracy" });
  assert.deepEqual(nameParts("Gracey Van Der Mark"), { last: "Van Der Mark", first: "Gracey", middle: "" });
  assert.deepEqual(nameParts("Donald P. (Don) Wagner"), { last: "Wagner", first: "Donald", middle: "P." });
  assert.deepEqual(nameParts('MICHAEL "MIKE" ZIEHLKE'), { last: "ZIEHLKE", first: "MICHAEL", middle: "" });
  assert.deepEqual(nameParts("RALPH OSCAR CHICK, III"), { last: "CHICK", first: "RALPH", middle: "OSCAR" });
});

test("ballot order: the randomized alphabet, letter by letter, last name then first name", () => {
  // H comes before Z and K in this alphabet.
  assert.deepEqual(alphabetOrder(ALPHA, ELECTION.contests[0].candidates).map((c) => c.name), ["Bo Hart", "Cy Kemp", "Alma Zed"]);
  assert.ok(compareNames(ALPHA, "Ann Hale", "Bob Hart") < 0, "second letter: A before R in this alphabet");
  assert.ok(compareNames(ALPHA, "Ann Hal", "Ann Hale") < 0, "a shorter name that matches so far comes first");
  assert.ok(compareNames(ALPHA, "Xia Hale", "Kai Hale") < 0, "same last name: the first name decides (X before K)");
});

test("statewide offices rotate by Assembly district: the first name moves to the bottom in each later district", () => {
  const base = ["a", "b", "c"];
  assert.deepEqual(rotateFor(base, 1), ["a", "b", "c"]);
  assert.deepEqual(rotateFor(base, 2), ["b", "c", "a"]);
  assert.deepEqual(rotateFor(base, 4), ["a", "b", "c"]);
  const gov = ELECTION.contests[0];
  const ad2 = ballotOrder(gov, ELECTION, { ad: "2" });
  assert.deepEqual(ad2.candidates.map((c) => c.name), ["Cy Kemp", "Alma Zed", "Bo Hart"]);
  assert.match(ad2.note, /Assembly District 2/);
  assert.match(ballotOrder(gov, ELECTION).note, /Assembly District 1/);
  const local = ELECTION.contests.find((c) => c.scope === "county");
  assert.deepEqual(ballotOrder(local, ELECTION, { countyName: "Example County" }).candidates, local.candidates, "county contests keep the county's own order");
  assert.match(ballotOrder(ELECTION.contests[1], ELECTION).note, /may differ/);
});

test("the real data: each county contest's list order is the randomized-alphabet order", () => {
  const real = JSON.parse(readFileSync(new URL("../../../data/elections/2026-11-03.json", import.meta.url), "utf8"));
  assert.equal(real.election.alphabet.length, 26);
  const local = real.contests.filter((c) => c.scope === "county");
  assert.ok(local.length > 0);
  for (const c of local) {
    assert.deepEqual(alphabetOrder(real.election.alphabet, c.candidates).map((x) => x.name), c.candidates.map((x) => x.name), c.office);
  }
  for (const c of real.contests) {
    assert.match(c.source_url, /^https:\/\//, `${c.id} has a source`);
    for (const k of c.candidates) assert.ok(!/@|\(\d{3}\)/.test(JSON.stringify(k.statement || "")), `${k.name}: no email or phone in a statement`);
  }
  for (const m of real.measures) assert.match(m.source_url, /^https:\/\//);
});

test("your ballot: the districts' contests, the county's Court of Appeal, and local contests as partial", () => {
  const b = ballotFor(ELECTION, { st: "CA", cd: "9", su: "2", sl: "3", co: "06999" }, "Example County");
  assert.deepEqual(b.contests.map((c) => c.id), ["governor", "us-rep-9", "state-senate-2", "state-assembly-3", "board-of-equalization-1"]);
  assert.deepEqual(b.courts.map((g) => g.id), ["supreme-court", "court-of-appeal-3"]);
  assert.deepEqual(b.measures.map((m) => m.id), ["prop-1"]);
  assert.deepEqual(b.partial.map((c) => c.id), ["06999-1001"]);
  assert.deepEqual(b.partialMeasures.map((m) => m.id), ["06999-measure-a"]);
  const noCounty = ballotFor(ELECTION, { st: "CA", cd: "10" }, null);
  assert.deepEqual(noCounty.contests.map((c) => c.id), ["governor", "us-rep-10"], "no Board of Equalization contest when the county isn't known");
  assert.equal(noCounty.boeKnown, false);
  assert.deepEqual(noCounty.courts.map((g) => g.id), ["supreme-court"]);
  assert.deepEqual(ballotFor(ELECTION, { st: "NV", cd: "1" }).contests, [], "another state: nothing");
  assert.equal(courtGroups(ELECTION.contests).length, 3);
});

test("officeholders: the last name and the first name (or nickname) must both match one official", () => {
  assert.ok(sameName("Edward (Ed) Hale", "Ed Hale"));
  assert.ok(sameName("Ben Hale", "Benjamin Hale"), "a short form of the first name");
  assert.ok(!sameName("Ann Hale", "Ed Hale"));
  assert.ok(!sameName("Ed Hall", "Ed Hale"));
  const holders = [{ slug: "ed-hale", name: "Ed Hale" }, { slug: "dee-lane-1", name: "Dee Lane" }, { slug: "dee-lane-2", name: "Dee Lane" }];
  assert.equal(holderFor({ name: "Ed Hale" }, holders).slug, "ed-hale");
  assert.equal(holderFor({ name: "Dee Lane" }, holders), null, "two officials with the name: no link rather than a guess");
});

test("results: never before the polls close (the feed carries test numbers), then matched by name in ballot order", async () => {
  const before = Date.parse("2026-11-04T03:59:00Z");
  assert.equal(pollsClosed(ELECTION, before), false);
  assert.equal(pollsClosed(ELECTION, Date.parse("2026-11-04T04:00:00Z")), true);
  const realFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error("the feed must not be read before the polls close"); };
  try {
    if (!pollsClosed(ELECTION)) assert.equal(await sosResults(ELECTION, "governor"), null);
  } finally {
    globalThis.fetch = realFetch;
  }
  const feed = { candidates: [{ Name: "Alma Zed", Votes: "1,200", Percent: "60.0" }, { Name: "Bo Hart", Votes: "800", Percent: "40.0" }] };
  assert.deepEqual(candidateResults(feed, ELECTION.contests[0].candidates), [
    { name: "Alma Zed", votes: 1200, percent: "60.0" },
    { name: "Bo Hart", votes: 800, percent: "40.0" },
    { name: "Cy Kemp", votes: null, percent: null },
  ]);
  assert.deepEqual(measureResult({ "ballot-measures": [{ Number: "01", yesVotes: "10", yesPercent: "50.0", noVotes: "10", noPercent: "50.0" }] }, "1"), { yes: 10, yesPercent: "50.0", no: 10, noPercent: "50.0" });
  assert.equal(daysUntil(ELECTION, "2026-10-07"), 27);
  assert.equal(daysUntil(ELECTION, "2026-11-04"), null);
});

// ---------------------------------------------------------------------------
// The pages, with the fixture served as the static files.

const ASSETS = {
  fetch: async (u) => {
    const path = new URL(u).pathname;
    if (path === "/data/elections/2026-11-03.json") return new Response(JSON.stringify(ELECTION));
    if (path === "/data/geo/places/ca.json") return new Response(JSON.stringify(PLACE));
    // Washington's real file (tools/build_wa_measures.py): its three statewide measures.
    if (path === "/data/elections/2026-11-03-wa.json") return new Response(readFileSync(new URL("../../../data/elections/2026-11-03-wa.json", import.meta.url), "utf8"));
    return new Response("not found", { status: 404 });
  },
};
const { onRequestGet } = await import("../../../functions/elections/[[path]].js");
const get = async (path, cookie = "") => {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const params = { path: path.split("/").filter(Boolean).slice(1) };
  const res = await onRequestGet({ request, env: { ASSETS }, params, waitUntil: () => {} });
  return { res, html: await res.text() };
};

test("contest page: every candidate gets the same card, in ballot order, with no results before the polls close", async () => {
  const { res, html } = await get("/elections/2026-11-03/contest/governor/");
  assert.equal(res.status, 200);
  const cards = html.split('class="card stack-sm cand-card"').slice(1);
  assert.equal(cards.length, 3);
  const shape = (c) => [...c.matchAll(/<dt>([^<]+)<\/dt>/g)].map((m) => m[1]).join("|");
  assert.equal(new Set(cards.map(shape)).size, 1, "the same fields for every candidate");
  assert.ok(html.indexOf("Bo Hart") < html.indexOf("Cy Kemp") && html.indexOf("Cy Kemp") < html.indexOf("Alma Zed"), "ballot order");
  assert.match(html, /No candidate statement in the state Official Voter Information Guide\./);
  assert.match(html, /Results appear here after the polls close/);
  const rest = html.replace(/ThePillory doesn&#x27;t endorse candidates or measures, and doesn&#x27;t publish polls or predictions\./g, "").replace(/after the polls close/g, "");
  assert.doesNotMatch(rest, /endorse|poll|predict/i, "no endorsements, polls or predictions anywhere else");
  assert.match(html, /doesn&#x27;t endorse candidates or measures, and doesn&#x27;t publish polls or predictions/);
});

test("measure page: official content first; then each argument and rebuttal labeled by side, in the guide's order, collapsed", async () => {
  const { html } = await get("/elections/2026-11-03/measure/prop-1/");
  const at = (t) => {
    const i = html.indexOf(t);
    assert.ok(i >= 0, `missing: ${t}`);
    return i;
  };
  // The neutral official content leads: title and summary, what a vote means, the fiscal estimate.
  assert.ok(at("AUTHORIZES EXAMPLE BONDS. LEGISLATIVE STATUTE.") < at("Authorizes $1 billion in example bonds."));
  assert.ok(at("Requires annual audits.") < at("example yes."));
  assert.ok(at("example no.") < at("Example state costs of about $50 million a year."));
  assert.ok(at("Example state costs of about $50 million a year.") < at("Arguments from each campaign"));
  // Collapsed by default, under the note.
  assert.match(html, /<details class="fold" id="arguments">/);
  assert.match(html, /Written by each campaign, printed word for word from the official voter guide\. Not written or checked by ThePillory or any government agency\./);
  // The guide's order, each labeled: supporters' argument, opponents' rebuttal, opponents' argument, supporters' rebuttal.
  const order = ["Supporters&#x27; argument", "Vote yes because of the example.", "Opponents&#x27; rebuttal", "The opponents reply.", "Opponents&#x27; argument", "Vote no because of the example.", "Supporters&#x27; rebuttal", "The supporters reply."].map(at);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), "in the guide's order");
  // Each part with its own signers: the opponents' rebuttal is signed by its author, not the supporters.
  assert.ok(at("The opponents reply.") < at("<strong>Ada Park</strong>, U.S. Senator") && at("<strong>Ada Park</strong>, U.S. Senator") < at("Opponents&#x27; argument"));
  assert.match(html, /<strong>Lee Moss<\/strong>, Director, Example Taxpayers/);
  // The same full-text treatment for every part: nothing excerpted or behind a second tap.
  assert.ok(!/Read the argument/.test(html));
  const local = (await get("/elections/2026-11-03/measure/06999-measure-a/")).html;
  assert.match(local, /Shall the example district issue bonds\?/);
  assert.match(local, /Impartial analysis by County Counsel/);
  assert.match(local, /No argument against Measure A was filed\./);
  assert.match(local, /Opponents&#x27; rebuttal<\/p>\s*<p class="small secondary">None printed in the official guide\./);
});

test("your ballot: private, built from the districts cookie; without it, the lookup returns here", async () => {
  const cookie = `pillory_districts=${encodeURIComponent("st=CA&cd=9&su=2&sl=3&co=06999")}`;
  const { res, html } = await get("/elections/2026-11-03/ballot/", cookie);
  assert.match(res.headers.get("Cache-Control"), /private/);
  for (const t of ["Governor", "United States Representative District 9", "State Senate District 2", "Board of Equalization Member District 1", "Court of Appeal, Third Appellate District", "Proposition 1", "Town Council", "Local, on some ballots in Example County"]) assert.ok(html.includes(t), t);
  assert.ok(!html.includes("District 10"), "another district's contest isn't on it");
  const none = await get("/elections/2026-11-03/ballot/");
  assert.match(none.html, /data-next="\/elections\/2026-11-03\/ballot\/"/);
  const nv = await get("/elections/2026-11-03/ballot/", `pillory_districts=${encodeURIComponent("st=NV&cd=1")}`);
  assert.match(nv.html, /Your districts are in Nevada\.<\/p><a class="btn btn--primary" href="\/ballot\/nv\/">Preview Nevada&#x27;s ballot<\/a>/);
});

test("court page and election page", async () => {
  const court = (await get("/elections/2026-11-03/contest/court-of-appeal-3/")).html;
  assert.match(court, /Shall Associate Justice LEE NASH be elected/);
  const all = await get("/elections/2026-11-03/");
  assert.equal(all.res.status, 200);
  assert.match(all.html, /Statewide propositions/);
  assert.equal((await get("/elections/2030-01-01/")).res.status, 404);
  assert.equal((await get("/elections/2026-11-03/contest/nope/")).res.status, 404);
});

test("Washington: the statewide measures, the pamphlet's official parts first, both sides' arguments in matching cards", async () => {
  const all = await get("/elections/2026-11-03-wa/");
  assert.equal(all.res.status, 200);
  for (const n of ["IP26-645", "IL26-001", "IL26-638"]) assert.ok(all.html.includes(`Initiative Measure No. ${n}`), n);
  assert.doesNotMatch(all.html, /Statewide offices|By district/, "no candidates or districts: measures only");
  const { res, html } = await get("/elections/2026-11-03-wa/measure/il26-001/");
  assert.equal(res.status, 200);
  const order = ["Ballot title · Written by the Office of the Attorney General", "Fiscal impact · Written by the Office of Financial Management", "The law as it presently exists", "The effect of the proposed measure if approved", "Arguments from each campaign"].map((t) => html.indexOf(t));
  assert.ok(order.every((i) => i > 0) && order.every((i, k) => !k || i > order[k - 1]), "official parts first, in the pamphlet's order, then the arguments");
  for (const label of ["Supporters&#x27; argument", "Opponents&#x27; rebuttal", "Opponents&#x27; argument", "Supporters&#x27; rebuttal"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /Contact:|@gmail\.com|nohateinwastate\.org/, "no campaign contact details");
  // A visitor in Washington is sent to Washington's measures from California's ballot page.
  const wa = await get("/elections/2026-11-03/ballot/", `pillory_districts=${encodeURIComponent("st=WA&cd=7")}`);
  assert.match(wa.html, /href="\/elections\/2026-11-03-wa\/"/);
});
