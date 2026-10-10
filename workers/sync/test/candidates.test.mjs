// node --test test/candidates.test.mjs
// Candidate and race pages (functions/_lib/candidates.js) from data in the shape
// tools/build_candidates.mjs writes, and the builder's pure parts. Every name,
// ID and number here is invented. One rule for everyone: the same card and the
// same page for every candidate, ballot order or alphabetical, no contact
// details, no individual donors, no polls or predictions.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  fecDisplayName, stateOfId, standing, officesHeld, raceKey, officeName, generalDate, raceList,
} from "../../../functions/_lib/candidates.js";
import { websiteUrl, mergeList, certifiedFederal, refreshOrder } from "../../../tools/build_candidates.mjs";

const totals = { receipts: 1000, disbursements: 400, cash_on_hand: 600, individual_unitemized: 300, individual_itemized: 500, pac: 200, party: 0, self_funding: 0, other: 0, coverage_end: "2026-06-30", last_report: null, source_url: "https://www.fec.gov/data/candidate/S6ZZ00001/?cycle=2026&election_full=false" };
const cand = (id, name, office, district, extra = {}) => ({
  id, name, party: "EXAMPLE PARTY", office, district, incumbent: false, committee: `C${id.slice(-5)}`, fec_url: `https://www.fec.gov/data/candidate/${id}/`,
  listed: true, first_listed: "2026-10-01", last_listed: "2026-10-10", ...extra,
});
const ZZ = {
  state: "TX", year: 2026, built_on: "2026-10-10", list_built_on: "2026-10-10", senate_up: true,
  source_url: "https://www.fec.gov/data/candidates/?election_year=2026&state=TX&candidate_status=C",
  candidates: {
    S6TX00001: cand("S6TX00001", "ZULU, ANNA", "S", null, {
      funding_checked: "2026-10-10", cycle: 2026, totals,
      website: { url: "https://zulu.example/", as_filed: "ZULU.EXAMPLE", source_url: "https://www.fec.gov/data/committee/C00001/", checked: "2026-10-10" },
      organizations: { items: [{ committee_id: "C9", name: "EXAMPLE WORKERS PAC", total: 5000, count: 2, industry: "labor" }], count: 1, total: 5000, complete: true, source_url: "https://www.fec.gov/data/receipts/?committee_id=C00001" },
    }),
    S6TX00002: cand("S6TX00002", "ALPHA, BEN DR", "S", null),
    S6TX00003: cand("S6TX00003", "MIKE, CARL", "S", null, { listed: false, last_listed: "2026-09-01" }),
    H6TX07001: cand("H6TX07001", "DELTA, DANA", "H", "7"),
    H6TX07002: cand("H6TX07002", "ECHO, ED", "H", "7", { incumbent: true }),
  },
};
const CA = {
  state: "CA", year: 2026, built_on: "2026-10-10", senate_up: false, source_url: "https://www.fec.gov/data/candidates/?state=CA",
  candidates: {
    H6CA05001: cand("H6CA05001", "QUEBEC, QUINN", "H", "5"),
    H6CA05002: cand("H6CA05002", "BRAVO, BEA", "H", "5"),
    H6CA05003: cand("H6CA05003", "AARDVARK, AL", "H", "5"),
  },
};
const ELECTION = {
  election: { id: "2026-11-03", name: "November 3, 2026, General Election", date: "2026-11-03", state: "CA", alphabet: ["Q", "B", "A"], certified_list: "https://elections.example/cert.pdf" },
  contests: [
    { id: "us-rep-5", office: "United States Representative District 5", scope: "cd", district: 5, source_url: "https://elections.example/cert.pdf", candidates: [
      { name: "Bea Bravo", party: "Party B", designation: "Teacher", fec: { id: "H6CA05002", url: "https://www.fec.gov/data/candidate/H6CA05002/" } },
      { name: "Quinn Quebec", party: "Party Q", designation: "Nurse", fec: { id: "H6CA05001", url: "https://www.fec.gov/data/candidate/H6CA05001/" } },
    ] },
    { id: "governor", office: "Governor", scope: "statewide", district: null, source_url: "https://elections.example/cert.pdf", candidates: [
      { name: "Gail Golf", party: "Party G", designation: "State Senator", incumbent: false },
      { name: "Hal Hotel", party: "Party H", designation: "Business Owner", incumbent: false },
    ] },
  ],
  measures: [],
};
const DATES = { states: { TX: [{ date: "2026-03-03", type: "P", district: "" }, { date: "2026-11-03", type: "G", district: "" }], CA: [{ date: "2026-11-03", type: "G", district: "" }] } };
const DATA = {
  "/data/candidates/2026/tx.json": ZZ,
  "/data/candidates/2026/ca.json": CA,
  "/data/elections/2026-11-03.json": ELECTION,
  "/data/elections/dates.json": DATES,
};
const ASSETS = { fetch: async (u) => { const p = new URL(u).pathname; return DATA[p] ? new Response(JSON.stringify(DATA[p])) : new Response("nf", { status: 404 }); } };

// A tiny D1 stand-in: officials in each state, and FEC IDs linked to officials.
const OFFICIALS = [
  { slug: "dana-delta", name: "Dana Delta", last_name: "Delta", office: "State Representative", district: "District 40", level: "state", chamber: "tx-lower", active: 1, state: "TX" },
  { slug: "ed-echo", name: "Ed Echo", last_name: "Echo", office: "U.S. Representative", district: "TX-7", level: "federal", chamber: "us-house", active: 1, state: "TX" },
  { slug: "gail-golf", name: "Gail Golf", last_name: "Golf", office: "State Senator", district: "District 9", level: "state", chamber: "ca-senate", active: 1, state: "CA" },
];
const FEC = [{ candidate_id: "H6TX07002", slug: "ed-echo", name: "Ed Echo", office: "U.S. Representative", district: "TX-7", active: 1, level: "federal", state: "TX" }];
const DB = {
  prepare: (sql) => ({
    bind: (st) => ({
      all: async () => ({ results: /fec_candidates/.test(sql) ? FEC.filter((r) => r.state === st) : OFFICIALS.filter((o) => o.state === st) }),
    }),
  }),
};
const env = { ASSETS, DB };
const call = async (mod, path) => {
  const { onRequestGet } = await import(mod);
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await onRequestGet({ request, env, params: { path: parts }, waitUntil: () => {} });
  return { res, html: res.status === 200 ? await res.text() : "" };
};
const CANDIDATES = "../../../functions/candidates/[[path]].js";
const RACES = "../../../functions/races/[[path]].js";
const titles = (html) => [...html.matchAll(/<div class="list-title">([^<]+)<\/div>/g)].map((m) => m[1]);

test("names as filed, in reading order, without titles", () => {
  assert.equal(fecDisplayName("ALLRED, COLIN Z MR"), "Colin Z. Allred");
  assert.equal(fecDisplayName("MCDONALD, MARY-ANN"), "Mary-Ann McDonald");
  assert.equal(fecDisplayName("O'NEIL, PAT JR"), "Pat O'Neil, Jr.");
  assert.equal(fecDisplayName("SMITH JR, JOHN"), "John Smith, Jr.");
  assert.equal(fecDisplayName("CORNYN, JOHN SEN"), "John Cornyn");
  assert.equal(stateOfId("S4TX00722"), "TX");
  assert.equal(stateOfId("P80001571"), null);
  assert.equal(stateOfId("../x"), null);
});

test("races: keys, office names, dates", () => {
  assert.equal(raceKey({ office: "S" }), "senate");
  assert.equal(raceKey({ office: "H", district: "07" }), "house-7");
  assert.equal(officeName("TX", "house-7"), "U.S. House, District 7");
  assert.equal(officeName("DC", "house-0"), "Delegate to the U.S. House");
  assert.equal(officeName("WY", "house-0"), "U.S. House, at large");
  assert.equal(officeName("CA", "governor"), null);
  assert.equal(generalDate(DATES, "TX"), "2026-11-03");
  const list = raceList("TX", ZZ, null);
  assert.deepEqual(list.federal.map((r) => r.key), ["senate", "house-7"]);
  assert.equal(list.federal[0].n, 2, "only candidates still listed are counted");
  assert.deepEqual(raceList("CA", CA, ELECTION).state.map((r) => r.key), ["governor"]);
});

test("standing: one rule for everyone, before and after the election", () => {
  const base = { office: "U.S. Senate", year: 2026, state: "Texas" };
  assert.equal(standing({ ...base, certified: false, after: false }).label, "Candidate · Not yet in office");
  assert.match(standing({ ...base, certified: false, after: false }).line, /^Filed for U\.S\. Senate, 2026/);
  assert.equal(standing({ ...base, certified: false, after: true }).label, "Filed for U.S. Senate, 2026", "without a certified list, never 'Ran for'");
  assert.equal(standing({ ...base, certified: true, onBallot: true, after: true }).label, "Ran for U.S. Senate, 2026");
  assert.equal(standing({ ...base, certified: true, onBallot: false, after: false }).label, "Filed for U.S. Senate, 2026");
  assert.match(standing({ ...base, certified: true, onBallot: false, after: false }).line, /Not on the November ballot/);
  assert.equal(standing({ ...base, after: true, inOffice: { office: "U.S. Senator" } }).label, "In office · U.S. Senator");
  assert.match(standing({ ...base, listed: false, lastListed: "2026-09-01" }).line, /No longer on the FEC's list/);
});

test("offices held: by FEC ID, or by a name only one official in the state has", () => {
  const records = { officials: OFFICIALS.filter((o) => o.state === "TX"), byFec: { H6TX07002: FEC[0] } };
  assert.deepEqual(officesHeld({ id: "H6TX07001" }, records, "Dana Delta").map((h) => [h.slug, h.how]), [["dana-delta", "name"]]);
  assert.deepEqual(officesHeld({ id: "H6TX07002" }, records, "Ed Echo").map((h) => [h.slug, h.how]), [["ed-echo", "fec"]]);
  const twins = { officials: [...records.officials, { ...OFFICIALS[0], slug: "dana-delta-2" }], byFec: {} };
  assert.deepEqual(officesHeld({ id: "X" }, twins, "Dana Delta"), [], "two officials with the name: no link");
});

test("a candidate's page: the official layout, labeled, with money and no contact details", async () => {
  const { res, html } = await call(CANDIDATES, "/candidates/S6TX00001/");
  assert.equal(res.status, 200);
  assert.match(html, /<p class="label">Candidate · Not yet in office<\/p>/);
  assert.match(html, /<h1>Anna Zulu<\/h1>/);
  assert.match(html, /Filed for U\.S\. Senate, 2026 · Texas/);
  for (const t of ["About", "Platform", "Votes", "Funding", "More"]) assert.match(html, new RegExp(`role="tab"[^>]*>${t}<`));
  assert.match(html, /href="\/races\/2026\/tx\/senate\/"/);
  assert.match(html, /\$1,000/);
  assert.match(html, /EXAMPLE WORKERS PAC/);
  assert.match(html, /https:\/\/zulu\.example\//);
  assert.match(html, /How candidates are included/);
  const main = html.slice(html.indexOf("<main"), html.indexOf("</main>"));
  assert.doesNotMatch(main, /mailto:|tel:|treasurer|@/i);
  assert.doesNotMatch(main.replace(/publish polls, predictions|predict the race/g, ""), /\b(polls?|predict\w*|frontrunner|rising star|favorite)\b/i);
});

test("a candidate who holds another office links to that record", async () => {
  const { html } = await call(CANDIDATES, "/candidates/H6TX07001/");
  assert.match(html, /href="\/reps\/dana-delta\/#votes"/);
  assert.match(html, /Matched by name/);
  assert.match(html, /Funding data is loading/);
  const lower = await call(CANDIDATES, "/candidates/h6tx07001/");
  assert.equal(lower.res.status, 301);
  assert.equal((await call(CANDIDATES, "/candidates/S6TX09999/")).res.status, 404);
  assert.equal((await call(CANDIDATES, "/candidates/..%2Fx/")).res.status, 404);
});

test("an incumbent running again shows as in office, linked to their page", async () => {
  const { html } = await call(CANDIDATES, "/candidates/H6TX07002/");
  assert.match(html, /<p class="label">In office · U\.S\. Representative<\/p>/);
  assert.match(html, /href="\/reps\/ed-echo\/"/);
});

test("a race without a certified list: alphabetical, the same card each", async () => {
  const { res, html } = await call(RACES, "/races/2026/tx/senate/");
  assert.equal(res.status, 200);
  const t = titles(html);
  assert.deepEqual(t.slice(0, 2), ["Ben Alpha", "Anna Zulu"], "alphabetical by last name as filed");
  assert.ok(t.includes("Carl Mike"), "no longer listed, but kept");
  assert.match(html, /No longer listed as active by the FEC/);
  assert.match(html, /How candidates are included/);
  const cards = [...html.matchAll(/<li class="ballot-cand">/g)].length;
  assert.equal(cards, 3);
  assert.doesNotMatch(html, /\$1,000/, "no money on the cards");
});

test("a race with a certified list: ballot order, then other FEC filers", async () => {
  const { html } = await call(RACES, "/races/2026/ca/house-5/");
  const t = titles(html);
  assert.deepEqual(t.slice(0, 2), ["Quinn Quebec", "Bea Bravo"], "the randomized alphabet (Q, B, A)");
  assert.equal(t[2], "Al Aardvark");
  assert.match(html, /Also filed with the FEC \(not on the November ballot\)/);
  const gov = await call(RACES, "/races/2026/ca/governor/");
  assert.match(gov.html, /href="\/candidates\/ca\/governor\/gail-golf\/"/);
  assert.match(gov.html, /Holds: State Senator, District 9/);
});

test("a certified state candidate's page, and the state's race list", async () => {
  const { res, html } = await call(CANDIDATES, "/candidates/ca/governor/hal-hotel/");
  assert.equal(res.status, 200);
  assert.match(html, /Candidate · Not yet in office/);
  assert.match(html, /Running for Governor, 2026/);
  assert.match(html, /Cal-Access/);
  const index = await call(RACES, "/races/2026/ca/");
  assert.match(index.html, /href="\/races\/2026\/ca\/governor\/"/);
  assert.match(index.html, /href="\/races\/2026\/ca\/house-5\/"/);
  assert.equal((await call(RACES, "/races/2026/zz/")).res.status, 404);
  assert.equal((await call(RACES, "/races/2026/tx/house-99/")).res.status, 404);
});

test("builder: websites, the list kept over time, certified candidates, refresh order", () => {
  assert.equal(websiteUrl("COLINALLRED.COM"), "https://colinallred.com/");
  assert.equal(websiteUrl("http://Example.org/About"), "http://example.org/About");
  assert.equal(websiteUrl("NONE"), null);
  assert.equal(websiteUrl("a@b.com"), null);
  const races = { senate: [{ id: "S6TX00001", name: "ZULU, ANNA", party: "P", incumbent: false, url: "https://www.fec.gov/data/candidate/S6TX00001/", committee: "C1" }], house: {} };
  const first = mergeList(null, races, "2026-10-01");
  assert.equal(first.S6TX00001.first_listed, "2026-10-01");
  const later = mergeList(first, { senate: [], house: {} }, "2026-10-10");
  assert.equal(later.S6TX00001.listed, false, "dropped off the list: kept, marked");
  assert.equal(later.S6TX00001.last_listed, "2026-10-01");
  const cert = certifiedFederal(ELECTION);
  assert.deepEqual(cert.map((c) => c.id), ["H6CA05002", "H6CA05001"]);
  const merged = mergeList(null, { senate: [], house: {} }, "2026-10-10", cert);
  assert.equal(merged.H6CA05002.certified_only, true);
  const order = refreshOrder([{ c: { id: "B", funding_checked: "2026-10-09" } }, { c: { id: "A" } }, { c: { id: "C", funding_checked: "2026-10-01" } }]);
  assert.deepEqual(order.map((x) => x.c.id), ["A", "C", "B"]);
});
