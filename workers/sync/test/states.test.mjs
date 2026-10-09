// node --import ./test/sql-stub.mjs --test test/states.test.mjs
// Every state: chamber ids, district names and keys (Census vs Open States),
// integer keys shared with tools/load_state_votes.py, the loading order, the
// analysis scope, each state's officials file, and matching positions.
// Every person here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { chamberIds, districtKey, districtLabel, executiveOffice, stableKey, memberTitle, chamberName, parseChamber } from "../src/states.js";
import { rankStates, stateBillScope } from "../src/state-priority.js";
import { stateRecords } from "../src/states-officials.js";
import { matchStatePositions, billIsFrom } from "../src/state-votes-api.js";
import { cleanDistricts, describe, legislativeSeats, repsWhere } from "../../../functions/_lib/districts.js";
import { listScope, voteScope, parseLevel } from "../../../functions/_lib/data.js";

test("chamber ids: California keeps its own; one-chamber legislatures", () => {
  assert.deepEqual(chamberIds("CA"), { upper: "ca-senate", lower: "ca-assembly", executive: "ca-executive" });
  assert.deepEqual(chamberIds("TX"), { upper: "tx-upper", lower: "tx-lower", executive: "tx-executive" });
  assert.equal(chamberIds("NE").lower, null);
  assert.equal(chamberIds("NE").upper, "ne-legislature");
  assert.equal(chamberIds("DC").upper, "dc-legislature");
  assert.deepEqual(parseChamber("tx-lower"), { st: "TX", type: "lower" });
});

test("district keys match the Census Bureau's names to Open States'", () => {
  const same = (st, type, a, b) => assert.equal(districtKey(st, type, a), districtKey(st, type, b), `${a} / ${b}`);
  same("NH", "lower", "Merrimack 06", "Merrimack 6");
  same("MA", "lower", "Norfolk-Worcester-Middlesex", "Norfolk, Worcester and Middlesex");
  same("MA", "upper", "1st Plymouth & Norfolk", "First Plymouth and Norfolk".replace("First", "1st"));
  same("TX", "upper", "007", "7");
  same("ID", "lower", "12", "12A");
  assert.notEqual(districtKey("MN", "lower", "12A"), districtKey("MN", "lower", "12B"), "Minnesota's 12A and 12B are separate districts");
  assert.equal(districtKey("TX", "upper", ""), "");
});

test("district labels and titles read plainly", () => {
  assert.equal(districtLabel("TX", "upper", "12"), "Senate District 12");
  assert.equal(districtLabel("MN", "lower", "12A"), "House District 12A");
  assert.equal(districtLabel("MA", "lower", "7th Hampden"), "7th Hampden House District");
  assert.equal(districtLabel("DC", "legislature", "2"), "Ward 2");
  assert.equal(districtLabel("NE", "legislature", "5"), "Legislative District 5");
  assert.equal(districtLabel("VT", "upper", ""), null);
  assert.equal(memberTitle("CA", "lower"), "Assemblymember");
  assert.equal(memberTitle("TX", "upper"), "State Senator");
  assert.equal(chamberName("TX", "upper", "Texas"), "Texas Senate");
});

test("executive offices: the same order everywhere; DC's governor is its Mayor", () => {
  assert.deepEqual(executiveOffice("governor", "TX"), { title: "Governor", rank: 1 });
  assert.deepEqual(executiveOffice("lt_governor", "TX"), { title: "Lieutenant Governor", rank: 2 });
  assert.deepEqual(executiveOffice("governor", "DC"), { title: "Mayor", rank: 1 });
  assert.deepEqual(executiveOffice("commissioner of agriculture"), { title: "Commissioner of Agriculture", rank: 20 });
  assert.equal(executiveOffice("mayor"), null);
});

test("integer keys are the same as the Python loader's", async () => {
  assert.equal(await stableKey("tx-ocd-vote/1111"), 243118297724161);
  assert.equal(await stableKey("openstates:ocd-person/aaaa"), 2837591691952820);
});

test("loading order: lookups, then signups (x10), then population; by hand first", () => {
  const { order } = rankStates({ lookups: { VT: 30, NY: 5 }, signups: { WY: 4 } });
  assert.deepEqual(order.slice(0, 4), ["WY", "VT", "NY", "CA"], "40 > 30 > 5, then the largest state");
  assert.equal(order.length, 52);
  assert.deepEqual(rankStates({ lookups: { VT: 30 }, manual: ["OH", "ZZ"] }).order.slice(0, 2), ["OH", "VT"]);
});

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  const bill = sqlite.prepare("INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES (?, ?, ?, ?, '1', 'T', 'https://example.org/b')");
  const vote = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES (?, ?, ?, ?, '2026-01-01', 'Q', ?, ?, 'https://example.org/v')");
  bill.run("us-119-hr-1", "federal", "us-house", "H.R. 1");
  bill.run("ca-20252026-ab-1", "state", "ca-assembly", "AB 1");
  bill.run("tx-89-hb-1", "state", "tx-lower", "HB 1");
  bill.run("tx-89-hb-2", "state", "tx-lower", "HB 2");
  bill.run("vt-2026-h-1", "state", "vt-lower", "H 1");
  bill.run("ny-2025-s-1", "state", "ny-upper", "S 1");
  vote.run("v1", "tx-89-hb-1", "state", "tx-lower", "final_passage", "Passed");
  vote.run("v2", "tx-89-hb-2", "state", "tx-lower", "final_passage", "Failed");
  vote.run("v3", "vt-2026-h-1", "state", "vt-lower", "final_passage", "Passed");
  vote.run("v4", "ny-2025-s-1", "state", "ny-upper", "final_passage", "Passed");
  return sqlite;
}

test("analysis scope: Congress and California, then passed bills in the top states, in order", () => {
  const db = seeded();
  const scope = stateBillScope(["CA", "VT", "TX", "NY"], 2);
  const ids = db.prepare(`SELECT b.id FROM bills b WHERE ${scope.where} ORDER BY ${scope.rank}, b.id`).all().map((r) => r.id);
  assert.deepEqual(ids, ["ca-20252026-ab-1", "us-119-hr-1", "vt-2026-h-1", "tx-89-hb-1"], "a failed bill and a state outside the top 2 are left out");
  const none = stateBillScope([], 10);
  assert.deepEqual(db.prepare(`SELECT b.id FROM bills b WHERE ${none.where} ORDER BY b.id`).all().map((r) => r.id), ["ca-20252026-ab-1", "us-119-hr-1"]);
});

test("migration 0020: compact positions read through all_positions with the old table", () => {
  const db = seeded();
  db.exec(`UPDATE votes SET k = 11 WHERE id = 'v1'`);
  db.exec(`INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, source_url, last_verified, active, state, district, k)
           VALUES ('openstates:p1', 'ada-alpha', 'Ada Alpha', 'Alpha', 'State Representative', 'state', 'tx-lower', 'state-legislature', 'https://example.org/o', '2026-01-01', 1, 'TX', 'House District 1', 22)`);
  db.exec(`INSERT INTO state_positions (vote_k, member_k, position, raw) VALUES (11, 22, 3, 'excused')`);
  const row = db.prepare("SELECT * FROM all_positions WHERE vote_id = 'v1'").get();
  assert.equal(row.official_id, "openstates:p1");
  assert.equal(row.position, "Not voting");
  assert.equal(row.raw_position, "excused");
  assert.throws(() => db.exec(`INSERT INTO state_positions (vote_k, member_k, position) VALUES (11, 23, 4)`), /CHECK/);
  assert.throws(() => db.exec(`INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified) VALUES ('x', 'x', 'X', 'X', 'state', 'zz-middle', 'b', 'https://example.org', '2026-01-01')`), /CHECK/);
});

test("a state's officials file becomes officials rows", async () => {
  const rows = await stateRecords({
    st: "MA",
    built_on: "2026-10-01",
    legislators: [
      { id: "ocd-person/1", name: "Ada Alpha", family_name: "Alpha", party: "Independent", type: "lower", district: "7th Hampden", source_url: "https://malegislature.example/1" },
      { id: "ocd-person/2", name: "No Source", type: "upper", district: "1" },
    ],
    executives: [{ id: "ocd-person/3", name: "Bea Beta", type: "governor", source_url: "https://mass.example/gov" }],
  });
  assert.equal(rows.length, 2, "no source URL: left out");
  const [rep, gov] = rows;
  assert.equal(rep.chamber, "ma-lower");
  assert.equal(rep.district, "7th Hampden House District");
  assert.equal(rep.district_code, "7thhampden");
  assert.equal(rep.k, await stableKey("openstates:ocd-person/1"));
  assert.equal(gov.chamber, "ma-executive");
  assert.equal(gov.office, "Governor");
});

test("positions from the API: by person id, or a unique last name in the chamber", () => {
  const officials = new Map([
    ["ocd-person/a", { k: 1, chamber: "tx-lower", last_name: "Alpha" }],
    ["ocd-person/b", { k: 2, chamber: "tx-lower", last_name: "Beta" }],
    ["ocd-person/c", { k: 3, chamber: "tx-lower", last_name: "Beta" }],
  ]);
  const out = matchStatePositions(
    { votes: [
      { option: "yes", voter: { id: "ocd-person/a" } },
      { option: "yes", voter: { id: "ocd-person/a" } },
      { option: "excused", voter_name: "Alpha" },
      { option: "no", voter_name: "Beta" },
      { option: "no", voter: { id: "ocd-person/gone" } },
    ] },
    officials,
    "tx-lower"
  );
  assert.deepEqual(out, [{ member_k: 1, position: 0, raw: null }], "duplicates, two Betas and a former member are left out");
});

test("a visitor's districts in any state", () => {
  const d = cleanDistricts({ st: "MA", cd: "02", su: "Worcester and Middlesex", sl: "7th Hampden" });
  assert.equal(d.cd, "2");
  assert.equal(describe(d), "Massachusetts · Congressional District 2 · Worcester and Middlesex Senate District · 7th Hampden House District");
  assert.deepEqual(legislativeSeats(d), [["ma-upper", "worcestermiddlesex"], ["ma-lower", "7thhampden"]]);
  assert.deepEqual(legislativeSeats(cleanDistricts({ st: "NE", su: "5", sl: "9" })), [["ne-legislature", "5"]]);
  assert.equal(cleanDistricts({ st: "TX", su: "<script>" }).su, undefined);
  assert.equal(cleanDistricts({ st: "AK", su: "B" }).su, "B", "Alaska's Senate districts are letters");
  assert.equal(cleanDistricts({ st: "CA", su: "x" }).su, undefined);
  const w = repsWhere(cleanDistricts({ st: "TX", su: "12" }));
  assert.ok(w.binds.includes("tx-upper") && w.binds.includes("12"));
});

test("level filters: California by default, any state by its code", () => {
  assert.deepEqual(parseLevel("state"), { level: "state", st: "CA" });
  assert.deepEqual(parseLevel("state:TX"), { level: "state", st: "TX" });
  assert.deepEqual(listScope("federal").binds, ["federal", null, null]);
  const db = seeded();
  const v = voteScope("state:TX");
  assert.deepEqual(db.prepare(`SELECT v.id FROM votes v WHERE ${v.sql} ORDER BY v.id`).all(...v.binds).map((r) => r.id), ["v1", "v2"]);
});

test("an API answer is saved only under its own state and session", () => {
  const bill = { session: "2025-2026", jurisdiction: { id: "ocd-jurisdiction/country:us/state:vt/government" } };
  assert.equal(billIsFrom(bill, "VT", "2025-2026"), true);
  assert.equal(billIsFrom(bill, "CA", "2025-2026"), false);
  assert.equal(billIsFrom(bill, "VT", "2023-2024"), false);
  assert.equal(billIsFrom({ jurisdiction: { id: "ocd-jurisdiction/country:us/district:dc/government" } }, "DC", "26"), true);
  assert.equal(billIsFrom({ session: "2025-2026" }, "VT", "2025-2026"), false, "no jurisdiction: not saved");
});
