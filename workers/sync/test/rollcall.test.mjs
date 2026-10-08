// node --test workers/sync/test/rollcall.test.mjs
// A bill's roll call: one vote's positions 20 at a time, the search box and
// filters, the breakdown by party and by state, and which vote is shown first.
// Every member here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { rollCallRows, rollCallBreakdown, pickVote, rollCallFilters, rollCallHref, seatOf, votePicker, ROLL_PER_PAGE } from "../../../functions/_lib/rollcall.js";

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
  });
  return { prepare: (sql) => stmt(sql) };
}

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  sqlite.exec(`INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES ('us-119-hr-1', 'federal', 'us-house', 'H.R. 1', '119', 'T', 'https://example.org/b')`);
  sqlite.exec(`INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES ('v1', 'us-119-hr-1', 'federal', 'us-house', '2026-01-01', 'On Passage', 'final_passage', 'Passed', 'https://example.org/v')`);
  const off = sqlite.prepare("INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, source_url, last_verified, active, state, district, party) VALUES (?, ?, ?, ?, 'U.S. Representative', 'federal', 'us-house', 'us-house', 'https://example.org/o', '2026-01-01', 1, ?, ?, ?)");
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES ('v1', ?, ?, ?)");
  const positions = ["Yes", "No", "Present", "Not voting"];
  for (let i = 0; i < 45; i++) {
    const last = `Member${String(i).padStart(2, "0")}`;
    off.run(`m${i}`, `member-${i}`, `Test ${last}`, last, i % 3 ? "CA" : "NV", `${i % 3 ? "CA" : "NV"}-${i}`, i % 2 ? "Party A" : i % 5 ? "Party B" : null);
    pos.run(`m${i}`, positions[i % 4], positions[i % 4] === "Yes" ? "Yea" : positions[i % 4]);
  }
  return d1(sqlite);
}

const none = { q: "", position: "", party: "", state: "", offset: 0 };

test("one page of 20 members by last name, then the next", async () => {
  const db = seeded();
  const p1 = await rollCallRows(db, "v1", none);
  assert.equal(p1.rows.length, ROLL_PER_PAGE);
  assert.equal(p1.total, 45);
  assert.ok(p1.more);
  assert.equal(p1.rows[0].name, "Test Member00");
  const p3 = await rollCallRows(db, "v1", { ...none, offset: 40 });
  assert.equal(p3.rows.length, 5);
  assert.equal(p3.more, false);
});

test("search and filters narrow the list; the search can't inject LIKE wildcards", async () => {
  const db = seeded();
  assert.equal((await rollCallRows(db, "v1", { ...none, q: "member07" })).total, 1);
  assert.equal((await rollCallRows(db, "v1", { ...none, q: "%" })).total, 0);
  assert.equal((await rollCallRows(db, "v1", { ...none, position: "No" })).total, 11);
  assert.equal((await rollCallRows(db, "v1", { ...none, state: "NV" })).total, 15);
  assert.equal((await rollCallRows(db, "v1", { ...none, party: "Not listed" })).total, 5);
  const both = await rollCallRows(db, "v1", { ...none, party: "Party A", position: "No" });
  assert.ok(both.rows.every((r) => r.party === "Party A" && r.position === "No"));
});

test("the breakdown by party and by state adds up to the positions loaded", async () => {
  const b = await rollCallBreakdown(seeded(), "v1");
  assert.equal(b.loaded, 45);
  assert.equal(b.byParty.reduce((s, r) => s + r.total, 0), 45);
  assert.deepEqual(b.byState.map((r) => r.name), ["CA", "NV"]);
  assert.ok(b.byParty.some((r) => r.name === "Not listed"));
  const a = b.byParty.find((r) => r.name === "Party A");
  assert.equal(a.Yes + a.No + a.Present + a["Not voting"], a.total);
});

test("which vote shows first, the address, and the picker", () => {
  const votes = [
    { id: "p1", vote_type: "procedural", chamber: "us-house", vote_date: "2026-02-01", result: "Failed" },
    { id: "f1", vote_type: "final_passage", chamber: "us-house", vote_date: "2026-01-20", result: "Passed" },
    { id: "a1", vote_type: "amendment", chamber: "us-house", vote_date: "2026-01-10", result: "Agreed to" },
  ];
  assert.equal(pickVote(votes, null).id, "f1", "final passage by default");
  assert.equal(pickVote(votes, "a1").id, "a1");
  assert.equal(pickVote(votes, "nope").id, "f1");
  assert.equal(pickVote([votes[0]], null).id, "p1");
  assert.equal(pickVote([], null), null);
  const f = rollCallFilters(new URL("https://x/?vote=ca-ocd-vote/1&position=Maybe&state=ca&q=%20Ann%20%20Lee%20&offset=-5"));
  assert.deepEqual(f, { vote: "ca-ocd-vote/1", q: "Ann Lee", position: "", party: "", state: "", offset: 0 });
  assert.equal(rollCallHref("us-119-hr-1", "ca-ocd-vote/1", { party: "Party A" }, 20), "/laws/bills/us-119-hr-1/rollcall/?vote=ca-ocd-vote%2F1&party=Party+A&offset=20");
  assert.equal(seatOf({ chamber: "us-senate", state: "CA" }), "CA · Senate");
  assert.equal(seatOf({ chamber: "ca-assembly", district: "Assembly District 8" }), "Assembly District 8");
  const picker = votePicker(votes, votes[1], "/laws/bills/x/#votes");
  assert.match(picker, /<option value="f1" selected>Final passage · U.S. House · Jan 20, 2026 · Passed<\/option>/);
  assert.equal(votePicker([votes[0]], votes[0], "/x/"), "", "no picker for a single vote");
});
