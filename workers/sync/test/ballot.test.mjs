// node --test test/ballot.test.mjs
// "Open your ballot" (/ballot/<st>/, functions/_lib/civic.js): the Google Civic
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
};
const OFFICES = { source: "https://www.usa.gov/state-election-office", offices: { WA: { name: "Washington Secretary of State", url: "https://www.sos.wa.gov/elections" }, CA: { name: "California Secretary of State", url: "https://www.sos.ca.gov/elections" } } };
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
const ASSETS = {
  fetch: async (u) => {
    const path = new URL(u).pathname;
    const m = /^\/data\/elections\/federal-2026\/([a-z]{2})\.json$/.exec(path);
    if (m && RACES[m[1].toUpperCase()]) return new Response(JSON.stringify(RACES[m[1].toUpperCase()]));
    if (path === "/data/states/election-offices.json") return new Response(JSON.stringify(OFFICES));
    if (path === "/data/elections/2026-11-03.json") return new Response(JSON.stringify(CA_ELECTION));
    if (path === "/data/elections/2026-11-03-wa.json") return new Response(readFileSync(new URL("../../../data/elections/2026-11-03-wa.json", import.meta.url), "utf8"));
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
          if (/FROM fec_candidates/.test(sql)) return { results: args[0] === "WA" ? [{ candidate_id: "H0WA00001", slug: "dee-lane", name: "Dee Lane", office: "U.S. Representative" }] : args[0] === "CA" ? [{ candidate_id: "H0CA00002", slug: "zed-zane", name: "Zed Zane", office: "U.S. Representative" }] : [] };
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

const post = async (path, address, { civic = null, db = stubDb(), key = "k" } = {}) => {
  const body = new FormData();
  body.set("address", address);
  const request = new Request(`https://thepillory.test${path}`, { method: "POST", body, headers: { Origin: "https://thepillory.test" } });
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
  assert.match(html, /href="\/reps\/dee-lane\/#votes">Votes<\/a> · <a class="inline-link" href="\/reps\/dee-lane\/#funding">Funding/);
  // The same row for every candidate: name, party, links.
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 2);
  assert.match(html, /PARTY ONE · Incumbent/);
  assert.match(html, /PARTY TWO<\/p>/);
  assert.match(html, /href="https:\/\/www\.sos\.wa\.gov\/elections"/);
  assert.match(html, /href="https:\/\/vote\.gov\/"/);
  assert.match(html, /<form class="lookup-form" action="\/ballot\/wa\/" method="post">/);
  assert.ok(html.includes(esc(CONFIRM)));
  assert.match(html, /Initiative Measure No\. IL26-001/, "ThePillory's Washington measures");
  assert.match(html, /doesn&#x27;t endorse candidates or measures, and doesn&#x27;t publish polls or predictions/);
  const noDistrict = (await get("/ballot/wa/")).html;
  assert.match(noDistrict, /Your U\.S\. House race: enter your address above/);
});

test("California: the certified candidates for the House race, in ballot order, not the FEC list", async () => {
  const { html } = await get("/ballot/ca/", { cookie: `pillory_districts=${encodeURIComponent("st=CA&cd=5")}` });
  assert.match(html, /United States Representative District 5/);
  assert.ok(html.indexOf("Zed Zane") < html.indexOf("Ann Able"), "the randomized alphabet (Z first here)");
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 2, "only the two on the November ballot");
  assert.match(html, /Party preference: Party Two · United States Representative/);
  assert.match(html, /href="\/reps\/zed-zane\/#votes">Votes/);
  assert.match(html, /Certified List of Candidates: only the candidates on the November ballot/);
  assert.doesNotMatch(html, /FEC list ↗/);
});

test("with an address: every contest in ballot order, the same card for each candidate, the address nowhere", async () => {
  const db = stubDb();
  const { res, html, logged } = await post("/ballot/ca/", ADDRESS, { db });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  const at = (t) => html.indexOf(t);
  assert.ok(at("<h3>Governor</h3>") > 0 && at("<h3>Governor</h3>") < at("<h3>Member of the State Assembly</h3>") && at("<h3>Member of the State Assembly</h3>") < at("<h3>Proposition 1</h3>"));
  assert.equal((html.match(/<li class="ballot-cand stack-xs">/g) || []).length, 5, "one row per candidate");
  assert.match(html, /Cy Kemp<\/p>\s*<p class="list-meta">No party listed/);
  assert.match(html, /href="\/reps\/hal-jones\/">Assemblymember now · on ThePillory/);
  assert.match(html, /href="\/elections\/2026-11-03\/measure\/prop-1\/">Official arguments for and against, on ThePillory/);
  assert.match(html, /href="https:\/\/sos\.example\.gov\/prop1"/);
  assert.match(html, /For an address in Exampleville, CA/);
  assert.match(html, /Example Hall/);
  assert.match(html, /Early voting/);
  assert.ok(html.includes(esc(CONFIRM)));
  assert.doesNotMatch(html, /Example Street|555-0100|hal@example\.org|ana\.example\.org|javascript:/, "no address, no contact details, no unsafe links");
  assert.ok(!logged.some((l) => l.includes("Example Street")), "nothing logged with the address");
  assert.equal(db.inserted.length, 1, "the lookup is counted");
  assert.deepEqual(db.inserted[0].args.length, 1, "only the visitor hash is kept");
});

test("no data for the address: said plainly, with the state's official sample ballot lookup", async () => {
  const { res, html } = await post("/ballot/wa/", "1 Nowhere Rd, Olympia, WA", { civic: async () => new Response(JSON.stringify({ error: { message: "Election unknown" } }), { status: 400 }) });
  assert.equal(res.headers.get("Cache-Control"), "private, no-store");
  assert.match(html, /There&#x27;s no ballot information for this address yet/);
  assert.match(html, /Your sample ballot is on <a class="inline-link" href="https:\/\/www\.sos\.wa\.gov\/elections" target="_blank" rel="noopener">Washington's election office website/);
  assert.doesNotMatch(html, /Nowhere Rd/);
  const empty = await post("/ballot/wa/", "1 Nowhere Rd, Olympia, WA", { civic: async () => new Response(JSON.stringify({ ...VOTER_INFO, normalizedInput: { city: "Olympia", state: "WA" }, contests: [] })) });
  assert.match(empty.html, /no ballot information for this address yet/, "an answer with no contests is no data");
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
