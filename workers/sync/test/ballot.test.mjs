// node --test test/ballot.test.mjs
// The ballot preview (/ballot/<st>/, functions/_lib/civic.js): the Google Civic
// Information API's answer as ThePillory shows it (contests in ballot order, the
// same layout for every candidate, no contact details), links to ThePillory's
// own pages only on a sure match, plain errors that never carry the address,
// and pages that are never cached and never show the address. Every name in the
// fixtures is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { voterInfo, ballotFromVoterInfo, officialFor, measureFor, CivicError } from "../../../functions/_lib/civic.js";

const ADDRESS = "123 Example Street, Exampleville, CA 95999";

const VOTER_INFO = {
  election: { id: "9000", name: "Example General Election", electionDay: "2026-11-03" },
  normalizedInput: { line1: "123 Example Street", city: "Exampleville", state: "CA", zip: "95999" },
  contests: [
    { type: "General", office: "Member of the State Assembly", district: { name: "Assembly District 3", scope: "stateLower" }, ballotPlacement: "3",
      candidates: [{ name: "Hal Jones", party: "Party One", phone: "555-0100", email: "hal@example.org", channels: [{ type: "Twitter", id: "hal" }] }, { name: "Ana Bell", party: "Party Two", candidateUrl: "https://ana.example.org" }],
      sources: [{ name: "Voting Information Project", official: true }] },
    { type: "General", office: "Governor", district: { name: "California", scope: "statewide" }, ballotPlacement: "1", level: ["administrativeArea1"],
      candidates: [{ name: "Alma Zed", party: "Party One" }, { name: "Bo Hart", party: "Party Two" }, { name: "Cy Kemp", party: "" }] },
    { type: "Referendum", referendumTitle: "Proposition 1", referendumSubtitle: "Authorizes example bonds.", referendumUrl: "https://sos.example.gov/prop1", ballotPlacement: "20" },
  ],
  pollingLocations: [{ address: { locationName: "Example Hall", line1: "1 Main St", city: "Exampleville", state: "CA", zip: "95999" }, pollingHours: "7am to 8pm" }],
  earlyVoteSites: [{ address: { locationName: "County Office", line1: "2 Main St", city: "Exampleville", state: "CA" }, startDate: "2026-10-05", endDate: "2026-11-02" }],
  state: [{ name: "California", electionAdministrationBody: { name: "Secretary of State", ballotInfoUrl: "https://sos.example.gov/sample", electionRegistrationConfirmationUrl: "https://sos.example.gov/status", votingLocationFinderUrl: "javascript:alert(1)" },
    local_jurisdiction: { name: "Example County", electionAdministrationBody: { name: "Example County Elections", electionInfoUrl: "https://county.example.gov/" } } }],
};

test("the answer as shown: ballot order, places, official links; no contact details, no street address", () => {
  const b = ballotFromVoterInfo(VOTER_INFO);
  assert.deepEqual(b.contests.map((c) => c.title), ["Governor", "Member of the State Assembly", "Proposition 1"], "by ballot placement");
  assert.deepEqual(b.contests[0].candidates.map((c) => c.name), ["Alma Zed", "Bo Hart", "Cy Kemp"], "candidates in the order listed");
  assert.deepEqual(Object.keys(b.contests[1].candidates[0]).sort(), ["name", "party"], "no phone, email, site or social accounts");
  assert.equal(b.contests[2].kind, "referendum");
  assert.equal(b.contests[2].referendum.url, "https://sos.example.gov/prop1");
  assert.equal(b.where, "Exampleville, CA", "city and state only");
  assert.ok(!JSON.stringify(b).includes("123 Example Street"), "the street address is dropped");
  assert.equal(b.polling[0].name, "Example Hall");
  assert.deepEqual(b.early[0].dates, ["2026-10-05", "2026-11-02"]);
  assert.deepEqual(b.state.links.map((l) => l.label), ["Check your registration", "Your sample ballot"], "only http(s) links");
  assert.equal(b.county.name, "Example County Elections");
});

test("names link to an official only when exactly one fits", () => {
  const officials = [{ slug: "hal-jones", name: "Hal Jones", office: "Assemblymember" }, { slug: "ana-bell", name: "Ana M. Bell", office: "Senator" }, { slug: "jo-lee-1", name: "Jo Lee" }, { slug: "jo-lee-2", name: "Jo Lee" }];
  assert.equal(officialFor("Hal Jones", officials).slug, "hal-jones");
  assert.equal(officialFor("ANA BELL", officials).slug, "ana-bell");
  assert.equal(officialFor("Jo Lee", officials), null, "two people with the name: no link");
  assert.equal(officialFor("Cy Kemp", officials), null);
  assert.equal(officialFor("Kemp", officials), null, "one word is never enough");
});

test("measures link to ThePillory's page by number", () => {
  const ca = { election: { state: "CA" }, measures: [{ id: "prop-1", number: "1", scope: "statewide" }, { id: "prop-10", number: "10", scope: "statewide" }] };
  assert.equal(measureFor({ title: "Proposition 1", subtitle: "" }, ca).id, "prop-1");
  assert.equal(measureFor({ title: "Prop. 10", subtitle: "" }, ca).id, "prop-10");
  assert.equal(measureFor({ title: "Measure A", subtitle: "" }, ca), null);
  const wa = JSON.parse(readFileSync(new URL("../../../data/elections/2026-11-03-wa.json", import.meta.url), "utf8"));
  assert.equal(measureFor({ title: "Initiative Measure No. IL26-001", subtitle: "" }, wa).number, "IL26-001");
  assert.equal(measureFor({ title: "Initiative Measure No. 645", subtitle: "" }, wa).number, "IP26-645");
});

test("errors say what happened and never carry the address", async () => {
  const answer = (status, message) => async () => new Response(JSON.stringify({ error: { message } }), { status });
  const env = { GOOGLE_CIVIC_API_KEY: "k" };
  const kindOf = async (p) => p.then(() => "ok", (e) => (assert.ok(e instanceof CivicError) && assert.ok(!String(e.message + e.stack).includes("Example Street")), e.kind));
  assert.equal(await kindOf(voterInfo({}, ADDRESS)), "no-key");
  assert.equal(await kindOf(voterInfo(env, ADDRESS, { fetchImpl: answer(400, "Failed to parse address") })), "address");
  assert.equal(await kindOf(voterInfo(env, ADDRESS, { fetchImpl: answer(400, "Election unknown") })), "not-found");
  assert.equal(await kindOf(voterInfo(env, ADDRESS, { fetchImpl: answer(404, "Not found") })), "not-found");
  assert.equal(await kindOf(voterInfo(env, ADDRESS, { fetchImpl: answer(503, "Backend error") })), "unavailable");
  assert.equal(await kindOf(voterInfo(env, ADDRESS, { fetchImpl: async () => { throw new Error(`fetch ${ADDRESS}`); } })), "unavailable");
  let asked = null;
  await voterInfo(env, ADDRESS, { fetchImpl: async (u) => ((asked = new URL(u)), new Response("{}")) });
  assert.equal(asked.searchParams.get("address"), ADDRESS);
  assert.equal(asked.searchParams.get("returnAllAvailableData"), "true");
});

// ---------------------------------------------------------------------------
// The pages, with fixtures served as the static files and a small D1 stub.

const RACES = {
  WA: { state: "WA", year: 2026, source_url: "https://www.fec.gov/data/candidates/?election_year=2026&state=WA", built_on: "2026-10-10", senate_up: false, senate: [],
    house: { 7: [
      { id: "H0WA00001", name: "LANE, DEE", party: "PARTY ONE", incumbent: true, url: "https://www.fec.gov/data/candidate/H0WA00001/" },
      { id: "H0WA00002", name: "MOSS, KIT", party: "PARTY TWO", incumbent: false, url: "https://www.fec.gov/data/candidate/H0WA00002/" },
    ] } },
  CA: { state: "CA", year: 2026, source_url: "https://www.fec.gov/data/candidates/?election_year=2026&state=CA", built_on: "2026-10-10", senate_up: false, senate: [], house: {} },
  OR: { state: "OR", year: 2026, source_url: "https://www.fec.gov/data/candidates/?election_year=2026&state=OR", built_on: "2026-10-10", senate_up: true,
    senate: [{ id: "S0OR00001", name: "LOST, PRIMARY", party: "PARTY ONE", incumbent: false, url: "https://www.fec.gov/data/candidate/S0OR00001/" }],
    house: { 2: [{ id: "H0OR00002", name: "FILED, ALSO", party: "PARTY TWO", incumbent: false, url: "https://www.fec.gov/data/candidate/H0OR00002/" }] } },
};
// New Mexico (invented names): its primary has passed and its certified list covers House District 1
// only, as when a state's amended Senate certification can't be read: the Senate race keeps the address.
RACES.NM = { state: "NM", year: 2026, source_url: "https://www.fec.gov/data/candidates/?election_year=2026&state=NM", built_on: "2026-10-10", senate_up: true,
  senate: [{ id: "S0NM00001", name: "GONE, GUS", party: "PARTY ONE", incumbent: false, url: "https://www.fec.gov/data/candidate/S0NM00001/" }],
  house: { 1: [
    { id: "H0NM00001", name: "ROWE, JEFFERSON H.", party: "PARTY ONE", incumbent: true, url: "https://www.fec.gov/data/candidate/H0NM00001/" },
    { id: "H0NM00002", name: "LOST, LENA", party: "PARTY TWO", incumbent: false, url: "https://www.fec.gov/data/candidate/H0NM00002/" },
  ] } };
const NM_CERTIFIED = { state: "NM", election: "2026-11-03", read_on: "2026-10-12",
  source: { name: "New Mexico Secretary of State, certified candidate list", url: "https://sos.example.gov/nm-certified.pdf" },
  contests: { house: { 1: [{ name: "JEFF ROWE", party: "Party One", incumbent: true }, { name: "Mia Novak", party: "Party Three" }] } } };
const OFFICES = { source: "https://www.usa.gov/state-election-office", offices: { OR: { name: "Oregon Secretary of State", url: "https://sos.oregon.gov/voting-elections/" }, WA: { name: "Washington Secretary of State", url: "https://www.sos.wa.gov/elections" }, CA: { name: "California Secretary of State", url: "https://www.sos.ca.gov/elections" } } };
const CA_ELECTION = {
  election: { id: "2026-11-03", name: "November 3, 2026, General Election", date: "2026-11-03", state: "CA", alphabet: "ZYXWVUTSRQPONMLKJIHGFEDCBA".split(""), certified_list: "https://sos.example.gov/certified-list.pdf" },
  how_to_vote: { state: [{ label: "Check your registration status", url: "https://voterstatus.example.gov/", by: "Secretary of State" }] },
  counties: {}, contests: [
    { id: "governor", office: "Governor", scope: "statewide", candidates: [] },
    { id: "us-rep-5", office: "United States Representative District 5", scope: "cd", district: "5", candidates: [
      { name: "Ann Able", party: "Party One", designation: "Teacher", fec: { id: "H0CA00001", url: "https://www.fec.gov/data/candidate/H0CA00001/" } },
      { name: "Zed Zane", party: "Party Two", designation: "United States Representative", fec: { id: "H0CA00002", url: "https://www.fec.gov/data/candidate/H0CA00002/" } },
    ] },
  ],
  measures: [{ id: "prop-1", number: "1", scope: "statewide", title: "EXAMPLE BONDS." }],
};
// Washington's House primary is still ahead in this file (a made-up late date: the FEC list may stand
// for the field); Oregon's has passed (it may not).
const datesFile = () => ({ states: {
  WA: [{ date: "2026-12-30", type: "P", district: "", offices: ["U.S. House"] }, { date: "2026-11-03", type: "G", district: "", offices: ["U.S. House"] }],
  OR: [{ date: "2026-05-19", type: "P", district: "", offices: ["U.S. Senate", "U.S. House"] }, { date: "2026-11-03", type: "G", district: "", offices: ["U.S. Senate", "U.S. House"] }],
  NM: [{ date: "2026-06-02", type: "P", district: "", offices: ["U.S. Senate", "U.S. House"] }, { date: "2026-11-03", type: "G", district: "", offices: ["U.S. Senate", "U.S. House"] }],
} });
const ASSETS = {
  fetch: async (u) => {
    const path = new URL(u).pathname;
    if (path === "/data/elections/dates.json") return new Response(JSON.stringify(datesFile()));
    const m = /^\/data\/elections\/federal-2026\/([a-z]{2})\.json$/.exec(path);
    if (m && RACES[m[1].toUpperCase()]) return new Response(JSON.stringify(RACES[m[1].toUpperCase()]));
    if (path === "/data/states/election-offices.json") return new Response(JSON.stringify(OFFICES));
    if (path === "/data/elections/certified-2026/nm.json") return new Response(JSON.stringify(NM_CERTIFIED));
    if (path === "/data/elections/2026-11-03.json") return new Response(JSON.stringify(CA_ELECTION));
    if (path === "/data/elections/2026-11-03-wa.json") return new Response(readFileSync(new URL("../../../data/elections/2026-11-03-wa.json", import.meta.url), "utf8"));
    // The real ZIP and county files: ZIP lookups and the saved place's name.
    if (/^\/data\/(zip\/\d{3}|geo\/places\/[a-z]{2})\.json$/.test(path)) return new Response(readFileSync(new URL(`../../..${path}`, import.meta.url), "utf8"));
    return new Response("not found", { status: 404 });
  },
};

function stubDb({ lookupsToday = 0 } = {}) {
  const inserted = [];
  return {
    inserted,
    prepare(sql) {
      let args = [];
      const s = {
        bind: (...a) => ((args = a), s),
        all: async () => {
          if (/FROM fec_candidates/.test(sql)) return { results: args[0] === "WA" ? [{ candidate_id: "H0WA00001", slug: "dee-lane", name: "Dee Lane", office: "U.S. Representative", active: 1 }] : args[0] === "CA" ? [{ candidate_id: "H0CA00002", slug: "zed-zane", name: "Zed Zane", office: "U.S. Representative", active: 1 }] : [] };
          // The state's officials (recordsFor()): Washington's District 7 member holds that seat.
          if (/FROM officials WHERE state = \?/.test(sql)) return { results: args[0] === "WA" ? [{ slug: "dee-lane", name: "Dee Lane", office: "U.S. Representative", chamber: "us-house", district_code: "7", active: 1, state: "WA" }] : [] };
          if (/FROM officials/.test(sql)) return { results: [{ slug: "hal-jones", name: "Hal Jones", office: "Assemblymember" }] };
          return { results: [] };
        },
        first: async () => (/ballot_lookups/.test(sql) ? { n: lookupsToday } : null),
        run: async () => void inserted.push({ sql, args }),
      };
      return s;
    },
  };
}

const { onRequestGet, onRequestPost, CONFIRM, LOOKUPS_PER_DAY } = await import("../../../functions/ballot/[[path]].js");
const esc = (s) => s.replace(/'/g, "&#x27;");
const params = (path) => ({ path: path.split("/").filter(Boolean).slice(1) });

const get = async (path, { cookie = "", cf = null, db = stubDb() } = {}) => {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  const res = await onRequestGet({ request, env: { ASSETS, DB: db }, params: params(path), waitUntil: () => {} });
  return { res, html: await res.text() };
};

const post = async (path, address, { civic = null, db = stubDb(), key = "k", cookie = "" } = {}) => {
  const body = new FormData();
  body.set("address", address);
  const request = new Request(`https://thepillory.test${path}`, { method: "POST", body, headers: { Origin: "https://thepillory.test", ...(cookie ? { Cookie: cookie } : {}) } });
  const realFetch = globalThis.fetch;
  const logged = [];
  const realLog = [console.log, console.error, console.warn];
  console.log = console.error = console.warn = (...a) => logged.push(a.join(" "));
  globalThis.fetch = async (u) => (civic ? civic(u) : new Response(JSON.stringify(VOTER_INFO)));
  try {
    const res = await onRequestPost({ request, env: { ASSETS, DB: db, GOOGLE_CIVIC_API_KEY: key }, params: params(path), waitUntil: () => {} });
    return { res, html: await res.text(), logged };
  } finally {
    globalThis.fetch = realFetch;
    [console.log, console.error, console.warn] = realLog;
  }
};

test("/ballot/ goes to the visitor's state, or lists every state", async () => {
  const r = await get("/ballot/", { cf: { country: "US", regionCode: "WA" } });
  assert.equal(r.res.status, 302);
  assert.equal(r.res.headers.get("Location"), "https://thepillory.test/ballot/wa/");
  const pick = await get("/ballot/");
  assert.equal(pick.res.status, 200);
  assert.match(pick.html, /href="\/ballot\/wy\/"/);
  assert.match(pick.html, /href="\/ballot\/dc\/"/);
  assert.equal((await get("/ballot/zz/")).res.status, 404);
});

test("before an address: FEC races, incumbents linked to Votes and Funding, official links, never cached", async () => {
  const { res, html } = await get("/ballot/wa/", { cookie: `pillory_districts=${encodeURIComponent("st=WA&cd=7")}` });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.match(html, /No U\.S\. Senate seat in Washington is up this year/);
  assert.match(html, /U\.S\. House, District 7/);
  // The seat's holder: "Incumbent" and a link to their record; nobody else is labeled.
  assert.match(html, /href="\/reps\/dee-lane\/#votes">Votes and record ›<\/a><\/li><li><a class="inline-link" href="\/reps\/dee-lane\/#funding">Funding/, "each link its own bullet");
  assert.doesNotMatch(html, /Challenger/);
  // The same row for every candidate: name, party, links.
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 2);
  assert.match(html, /<li>Party One<\/li><li>Incumbent<\/li>/);
  assert.match(html, /<li>Party Two<\/li><li><a class="inline-link" href="https:\/\/www\.fec\.gov[^"]*" target="_blank" rel="noopener">FEC filing ↗<\/a><\/li><\/ul>/);
  assert.doesNotMatch(html, /PARTY ONE|PARTY TWO/, "the FEC's capitals, in normal capitalization");
  assert.match(html, /href="https:\/\/www\.sos\.wa\.gov\/elections"/);
  assert.match(html, /href="https:\/\/vote\.gov\/"/);
  assert.match(html, /<form class="lookup-form" action="\/ballot\/wa\/" method="post">/);
  assert.ok(html.includes(esc(CONFIRM)));
  assert.match(html, /Initiative Measure No\. IL26-001/, "ThePillory's Washington measures");
  assert.match(html, /doesn&#x27;t endorse candidates or measures, and doesn&#x27;t publish polls or predictions/);
  const noDistrict = (await get("/ballot/wa/")).html;
  assert.match(noDistrict, /Your U\.S\. House race: <a class="inline-link" href="#address">add your address below<\/a>/);
});

test("after the primary: no FEC list as the ballot; the address, the official list, and the FEC list behind its own link", async () => {
  const { html } = await get("/ballot/or/", { cookie: `pillory_districts=${encodeURIComponent("st=OR&cd=2")}` });
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 0, "no names under the ballot heading");
  assert.doesNotMatch(html, /LOST, PRIMARY|FILED, ALSO|Primary Lost|Also Filed/);
  assert.equal((html.match(/Oregon chose its nominees for this office in the primary on May 19, 2026\. Enter your address to see the candidates on your ballot\./g) || []).length, 2, "the Senate and House races");
  assert.match(html, /<a class="btn btn--primary" href="#address">Enter your address<\/a>/);
  assert.match(html, /Official candidate list: <a class="inline-link" href="https:\/\/sos\.oregon\.gov\/voting-elections\/"/);
  assert.match(html, /<a class="inline-link" href="\/races\/2026\/or\/senate\/">Filed with the FEC in 2026<\/a>: everyone who filed, including candidates who lost a primary or withdrew\. Not the ballot\./);
  assert.match(html, /href="\/races\/2026\/or\/house-2\/">Filed with the FEC in 2026<\/a>/);
  assert.doesNotMatch(html, /Before the primary: everyone who has filed/);
});

test("a state's own certified list: its names under the ballot heading, never the FEC list; a race it doesn't cover keeps the address", async () => {
  const { html } = await get("/ballot/nm/", { cookie: `pillory_districts=${encodeURIComponent("st=NM&cd=1")}` });
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 2, "the two certified House candidates");
  assert.match(html, /JEFF ROWE/);
  assert.match(html, /Mia Novak/);
  assert.match(html, /<li>Party One<\/li><li>Incumbent<\/li>/);
  assert.match(html, /href="\/candidates\/H0NM00001\/">JEFF ROWE<\/a>/, "one filer in the race has that name: linked");
  assert.doesNotMatch(html, /href="\/candidates\/[^"]*">Mia Novak/, "no filing matches: no link");
  assert.doesNotMatch(html, /LOST, LENA|Lena Lost|GONE, GUS|Gus Gone/);
  assert.match(html, /From New Mexico Secretary of State, certified candidate list <a class="inline-link" href="https:\/\/sos\.example\.gov\/nm-certified\.pdf"/);
  assert.match(html, /New Mexico chose its nominees for this office in the primary on June 2, 2026\. Enter your address/, "the Senate race isn't in the file");
  assert.doesNotMatch(html, /Before the primary: everyone who has filed/);
});

test("California: the certified candidates for the House race, in ballot order, not the FEC list", async () => {
  const { html } = await get("/ballot/ca/", { cookie: `pillory_districts=${encodeURIComponent("st=CA&cd=5")}` });
  assert.match(html, /United States Representative District 5/);
  assert.ok(html.indexOf("Zed Zane") < html.indexOf("Ann Able"), "the randomized alphabet (Z first here)");
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 2, "only the two on the November ballot");
  // One bullet each: party preference, then the ballot designation.
  assert.match(html, /<li>Party preference: Party Two<\/li><li>United States Representative<\/li>/);
  assert.match(html, /href="\/reps\/zed-zane\/#votes">Votes/);
  assert.match(html, /Certified List of Candidates: only the candidates on the November ballot/);
  assert.doesNotMatch(html, /FEC list ↗/);
});

test("with an address: every contest in ballot order, the same card for each candidate, the address shown back only on its own answer", async () => {
  const db = stubDb();
  const { res, html, logged } = await post("/ballot/ca/", ADDRESS, { db });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const at = (t) => html.indexOf(t);
  assert.ok(at("<h3>Governor</h3>") > 0 && at("<h3>Governor</h3>") < at("<h3>Member of the State Assembly</h3>") && at("<h3>Member of the State Assembly</h3>") < at("<h3>Proposition 1</h3>"));
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 5, "one row per candidate");
  assert.match(html, /Cy Kemp<\/p>\s*<ul class="cand-facts"><li>No party listed/);
  assert.doesNotMatch(html, /href="\/reps\/hal-jones\/"/, "a name alone doesn't link a candidate to an official");
  assert.match(html, /Just the facts: Proposition 1[\s\S]*facts-chips[\s\S]*href="\/elections\/2026-11-03\/measure\/prop-1\/">Full measure page ›/);
  assert.match(html, /href="https:\/\/sos\.example\.gov\/prop1"/);
  assert.match(html, /Your ballot preview for 123 Example Street, Exampleville, CA 95999/, "labeled with the address as entered");
  assert.match(html, /<strong>Showing:<\/strong> 123 Example Street, Exampleville, CA 95999<\/p>/, "no saved place: no other link");
  assert.match(html, /Example Hall/);
  assert.match(html, /Early voting/);
  assert.ok(html.includes(esc(CONFIRM)));
  assert.doesNotMatch(html, /555-0100|hal@example\.org|ana\.example\.org|javascript:/, "no contact details, no unsafe links");
  assert.ok(!logged.some((l) => l.includes("Example Street")), "nothing logged with the address");
  assert.equal(db.inserted.length, 1, "the lookup is counted");
  assert.deepEqual(db.inserted[0].args.length, 1, "only the visitor hash is kept");
});

test("no data for the address: said plainly, with the state's official sample ballot lookup", async () => {
  const { res, html } = await post("/ballot/wa/", "1 Nowhere Rd, Olympia, WA", { civic: async () => new Response(JSON.stringify({ error: { message: "Election unknown" } }), { status: 400 }) });
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.match(html, /There&#x27;s no ballot information for &quot;1 Nowhere Rd, Olympia, WA&quot; yet/, "said for what was entered");
  assert.match(html, /Your sample ballot is on <a class="inline-link" href="https:\/\/www\.sos\.wa\.gov\/elections" target="_blank" rel="noopener">Washington's election office website/);
  const empty = await post("/ballot/wa/", "1 Nowhere Rd, Olympia, WA", { civic: async () => new Response(JSON.stringify({ ...VOTER_INFO, normalizedInput: { city: "Olympia", state: "WA" }, contests: [] })) });
  assert.match(empty.html, /no ballot information for &quot;1 Nowhere Rd, Olympia, WA&quot; yet/, "an answer with no contests is no data");
  assert.match(empty.html, /Example Hall/, "its polling places still show");
});

test("the daily limit, a bad address and a missing key", async () => {
  let called = false;
  const over = await post("/ballot/ca/", ADDRESS, { db: stubDb({ lookupsToday: LOOKUPS_PER_DAY }), civic: async () => ((called = true), new Response("{}")) });
  assert.match(over.html, new RegExp(`That&#x27;s ${LOOKUPS_PER_DAY} address lookups today`));
  assert.equal(called, false, "Google isn't asked");
  assert.match((await post("/ballot/ca/", "x")).html, /Enter a street address/);
  assert.match((await post("/ballot/ca/", ADDRESS, { key: "" })).html, /isn&#x27;t switched on yet/);
  const request = new Request("https://thepillory.test/ballot/ca/", { method: "POST", body: new FormData(), headers: { Origin: "https://elsewhere.test" } });
  assert.equal((await onRequestPost({ request, env: { ASSETS }, params: { path: ["ca"] } })).status, 403);
});

test("the ballot page leads with the statewide preview; the address card comes after, with its own wording", async () => {
  const { html } = await get("/ballot/wa/");
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  const at = (s) => main.indexOf(s);
  assert.match(main, /<h1>Washington&#x27;s ballot<\/h1>/);
  assert.ok(at('href="#address">Add your address for your exact ballot ↓</a>') > 0, "the jump link");
  assert.ok(at('id="h-federal"') > 0 && at('id="h-federal"') < at('id="address"'), "the races before the address card");
  assert.ok(at('id="address"') < main.lastIndexOf("Always confirm your ballot"), "the confirm line after the card");
  assert.match(main, /<h2 class="label" id="h-address">Your exact ballot<\/h2>\s*<p class="small">Add your address for local contests and where to vote\.<\/p>/);
  assert.match(main, />Show my ballot<\/button>/);
  assert.match(main, /ThePillory never stores or logs either, and a lookup doesn(?:'|&#x27;)t change your saved place/);
  assert.doesNotMatch(html, /Preview Washington/, "never the label of the button that leads here");
});

// What the visitor enters always wins over the saved districts cookie (Calaveras saved here).
const CALAVERAS = `pillory_districts=${encodeURIComponent("st=CA&cd=5&su=4&sl=8&co=06009")}`;

test("a ZIP alone (95120): its county and districts, the statewide ballot, and a request for the street address; never Calaveras, never 'your ballot'", async () => {
  let called = false;
  const db = stubDb();
  const { res, html } = await post("/ballot/ca/", "95120", { cookie: CALAVERAS, db, civic: async () => ((called = true), new Response("{}")) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.equal(called, false, "a ZIP isn't sent to Google");
  assert.equal(db.inserted.length, 0, "and doesn't count toward the address lookups");
  assert.equal(res.headers.get("Set-Cookie"), null, "a lookup never changes the saved place");
  assert.match(html, /<h1>What(?:'|&#x27;)s on ballots in 95120<\/h1>/);
  assert.match(html, /<strong>Showing:<\/strong> 95120 · <a class="inline-link" href="\/ballot\/ca\/">Use my saved place \(Calaveras County, CA\) instead<\/a>/);
  assert.match(html, /95120 is in <a class="inline-link" href="\/place\/ca\/santa-clara\/">Santa Clara County<\/a> and covers parts of these districts:/);
  assert.match(html, /U\.S\. House District 19<\/a> · <a[^>]*>U\.S\. House District 16/);
  assert.match(html, /A ZIP can span several districts; add your street address for your exact ballot\./);
  assert.match(html, /95120 covers parts of District 19 and District 16 of the U\.S\. House/);
  assert.match(html, /id="h-statewide"/, "the statewide races and measures");
  assert.match(html, /<input type="hidden" name="q" value="95120" \/>[\s\S]*<input type="hidden" name="next" value="\/ballot\/ca\/" \/>[\s\S]*Make this my place/);
  assert.doesNotMatch(html, /Calaveras County(?!, CA\) instead)|District 5\b|Your ballot on ThePillory|Your ballot preview for/, "nothing from the saved place, and not presented as the ballot");
});

test("a ZIP across county lines (95033): both counties, every district part", async () => {
  const { html } = await post("/ballot/ca/", "95033", { cookie: CALAVERAS });
  assert.match(html, /95033 spans parts of <a[^>]*>Santa Cruz County<\/a> and <a[^>]*>Santa Clara County<\/a> and covers parts of these districts:/);
  assert.match(html, /covers parts of District 19 and District 16 of the U\.S\. House/);
  assert.match(html, /Use my saved place \(Calaveras County, CA\) instead/);
});

test("the saved place's own ZIP: no 'use my saved place' link, no 'Make this my place'", async () => {
  const { html } = await post("/ballot/ca/", "95249", { cookie: CALAVERAS });
  assert.match(html, /<strong>Showing:<\/strong> 95249<\/p>/);
  assert.match(html, /95249 is in <a[^>]*>Calaveras County<\/a> and is in these districts:/);
  assert.doesNotMatch(html, /Make this my place/);
});

test("a full address: Google's answer, labeled with what was entered; the saved place only as a link when it differs", async () => {
  const santaClara = { ...VOTER_INFO, normalizedInput: { line1: "1 Example Way", city: "San Jose", state: "CA", zip: "95120" } };
  const sc = await post("/ballot/ca/", "1 Example Way, San Jose, CA 95120", { cookie: CALAVERAS, civic: async () => new Response(JSON.stringify(santaClara)) });
  assert.match(sc.html, /Your ballot preview for 1 Example Way, San Jose, CA 95120/);
  assert.match(sc.html, /Use my saved place \(Calaveras County, CA\) instead/);
  assert.equal(sc.res.headers.get("Set-Cookie"), null);
  assert.doesNotMatch(sc.html, /Your ballot on ThePillory/);
  const calaveras = { ...VOTER_INFO, normalizedInput: { line1: "1 Example Rd", city: "San Andreas", state: "CA", zip: "95249" } };
  const cv = await post("/ballot/ca/", "1 Example Rd, San Andreas, CA", { cookie: CALAVERAS, civic: async () => new Response(JSON.stringify(calaveras)) });
  assert.match(cv.html, /<strong>Showing:<\/strong> 1 Example Rd, San Andreas, CA<\/p>/, "the saved place itself: no link");
});

test("a failed lookup says so for what was entered and never swaps in the saved place", async () => {
  const notFound = await post("/ballot/ca/", "1 Example Way, San Jose, CA 95120", { cookie: CALAVERAS, civic: async () => new Response(JSON.stringify({ error: { message: "Election unknown" } }), { status: 400 }) });
  assert.match(notFound.html, /no ballot information for &quot;1 Example Way, San Jose, CA 95120&quot; yet/);
  assert.match(notFound.html, /Use my saved place \(Calaveras County, CA\) instead/);
  assert.doesNotMatch(notFound.html, /Your ballot on ThePillory/);
  const unknownZip = await post("/ballot/ca/", "00000", { cookie: CALAVERAS });
  assert.match(unknownZip.html, /00000 isn(?:'|&#x27;)t one of the Census Bureau(?:'|&#x27;)s ZIP code areas/);
  assert.doesNotMatch(unknownZip.html, /U\.S\. House, District 5|District 5<\/p>/, "the saved House race isn't shown in its place");
  const bad = await post("/ballot/ca/", "x", { cookie: CALAVERAS });
  assert.match(bad.html, /<strong>Showing:<\/strong> x · /);
});

test("before any lookup, the page says it's showing the saved place", async () => {
  const { html } = await get("/ballot/ca/", { cookie: CALAVERAS });
  assert.match(html, /<strong>Showing:<\/strong> your saved place \(Calaveras County, CA\) · <a class="inline-link" href="#address">a different address or ZIP<\/a>/);
});
