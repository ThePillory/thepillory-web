// Bills passed without a recorded vote (docs/data-sync.md, "Passage without a recorded vote"): the action
// readers, the sync step, discharge petitions, the bill page, the Laws list, This week and the email.
// Action texts, related bills and the Clerk's markup are copied from what the accuracy audit's sections 10
// and 11 printed (H.R. 9237, H.R. 2102, Discharge Petitions No. 1 and 22); names and people are left out
// where a test doesn't need them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { passagesWithoutRollCall, passageMethod, passageLine, rulesFromActions, relatedRows, relationWords, cosponsorRows, committeeVotes, NOT_RECORDED, METHODS } from "../src/passages/parse.js";
import { parsePetitionList, parseSignatures, clerkDate, billIdFrom } from "../src/passages/petitions-parse.js";
import { readBill, queueAnalyses, worthReading, ANALYSIS_REQUESTER } from "../src/passages/sync.js";
import { syncDischargePetitions, petitionDue } from "../src/passages/petitions.js";
import { buildSummaries } from "../src/summaries.js";
import { buildEditions } from "../src/email/edition.js";
import { weekOf } from "../src/email/schedule.js";
import { listBillStatus } from "../../../functions/_lib/laws-list.js";
import { thisWeek } from "../../../functions/_lib/quick-home.js";
import { billStatus } from "../../../functions/_lib/bill-page.js";
import { billStands } from "../../../functions/_lib/simple.js";
import { voteOn } from "../../../functions/_lib/passages.js";
import { onRequestGet as lawsRoute } from "../../../functions/laws/[[path]].js";

const MIG = new URL("../migrations/", import.meta.url);
const fmt = (d) => ({ "2026-11-11": "Nov 11, 2026", "2026-11-12": "Nov 12, 2026" })[d] || d;

function d1(sqlite) {
  const wrap = (sql, binds = []) => {
    const st = sqlite.prepare(sql);
    return {
      bind: (...b) => wrap(sql, b),
      all: async () => ({ results: st.all(...binds), meta: {} }),
      first: async () => st.get(...binds) ?? null,
      run: async () => ({ meta: { changes: Number(st.run(...binds).changes) } }),
      _run: () => st.run(...binds),
    };
  };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => (s._run ? s._run() : s.run())) };
}
function fresh() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)");
  return sqlite;
}

// H.R. 9237's actions on Congress.gov (119th Congress), newest first, as the audit printed them.
const HR9237 = [
  { actionDate: "2026-11-11", actionTime: "14:46:12", actionCode: "H38310", text: "Motion to reconsider laid on the table Agreed to without objection." },
  { actionDate: "2026-11-11", actionTime: "14:46:08", actionCode: "H37100", text: "On passage Passed by voice vote." },
  { actionDate: "2026-11-11", actionTime: "14:46:08", actionCode: "8000", text: "Passed/agreed to in House: On passage Passed by voice vote." },
  { actionDate: "2026-11-11", actionTime: "14:44:08", actionCode: "H30000", text: "Considered as unfinished business. (consideration: CR H6171)" },
  { actionDate: "2026-07-16", actionTime: "11:16:29", actionCode: "H36210", text: "On motion to recommit Failed by the Yeas and Nays: 210 - 211 (Roll no. 249).", recordedVotes: [{ chamber: "House", rollNumber: 249 }] },
  { actionDate: "2026-07-16", actionTime: "09:11:43", actionCode: "H30000", text: "Considered under the provisions of rule H. Res. 1423. (consideration: CR H4548-4613; text: CR H4548-4613)" },
  { actionDate: "2026-07-13", actionTime: "17:59:05", actionCode: "H1L210", text: "Rules Committee Resolution H. Res. 1423 Reported to House. Rule provides for consideration of H.R. 139, H.R. 8595, H.R. 9237 and H.R. 1181." },
  { actionDate: "2026-06-23", actionTime: "19:18:06", actionCode: "H1L210", text: "Rules Committee Resolution H. Res. 1377 Reported to House. Rule provides for consideration of H.R. 1181, H.R. 9022, H.R. 8595 and H.R. 9237." },
  { actionDate: "2026-06-10", actionCode: "1000", text: "Introduced in House" },
];
const SENATE_UC = [
  { actionDate: "2026-09-18", actionCode: "17000", text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent." },
  { actionDate: "2026-09-18", actionCode: "", text: "Passed Senate without amendment by Unanimous Consent." },
];
// A normal roll call (the shape H.R. 2102's House passage would take: Clerk roll call, totals in the text).
const ROLL_CALL = [{ actionDate: "2026-11-12", actionCode: "8000", text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 392 - 18 (Roll no. 301)." }];

test("voice vote: H.R. 9237 passed the House by voice vote on Nov 11, 2026, and nothing else is read as a passage", () => {
  assert.deepEqual(passagesWithoutRollCall(HR9237), [
    { chamber: "us-house", method: "voice_vote", action_date: "2026-11-11", action_text: "Passed/agreed to in House: On passage Passed by voice vote." },
  ]);
  assert.equal(passageLine({ chamber: "us-house", method: "voice_vote", action_date: "2026-11-11" }, fmt), "Passed the House by voice vote on Nov 11, 2026. Members' individual votes were not recorded.");
  // The motion to recommit was a recorded vote, and the rules are not passages.
  assert.deepEqual(rulesFromActions(HR9237, 119), ["us-119-hres-1377", "us-119-hres-1423"]);
});

test("unanimous consent: a Senate passage by unanimous consent, and the House's without objection", () => {
  assert.deepEqual(passagesWithoutRollCall(SENATE_UC), [
    { chamber: "us-senate", method: "unanimous_consent", action_date: "2026-09-18", action_text: "Passed/agreed to in Senate: Passed Senate without amendment by Unanimous Consent." },
  ]);
  assert.equal(passageLine(passagesWithoutRollCall(SENATE_UC)[0], fmt), "Passed the Senate by unanimous consent on 2026-09-18. Members' individual votes were not recorded.");
  assert.equal(passageMethod("Passed/agreed to in House: On passage Passed without objection."), "without_objection");
  assert.equal(passageMethod("Passed Senate with an amendment by Voice Vote."), "voice_vote");
  assert.deepEqual(METHODS, ["voice_vote", "unanimous_consent", "without_objection"]);
});

test("a normal roll call is never read as a passage without a recorded vote, and a later roll call replaces an earlier voice vote", () => {
  assert.deepEqual(passagesWithoutRollCall(ROLL_CALL), []);
  assert.equal(passageMethod("Passed Senate with an amendment by Yea-Nay Vote. 51 - 50. Record Vote Number: 325."), null);
  assert.equal(passageMethod("Passed/agreed to in House: On passage Passed by recorded vote: 220 - 207 (Roll no. 420)."), null);
  // A method the text doesn't name is never guessed.
  assert.equal(passageMethod("Passed/agreed to in House: On passage Passed."), null);
  assert.equal(passageMethod("Passage vitiated by unanimous consent."), null);
  const both = [
    { actionDate: "2026-03-01", actionCode: "8000", text: "Passed/agreed to in House: On passage Passed by voice vote." },
    { actionDate: "2026-05-01", actionCode: "8000", text: "Passed/agreed to in House: On passage Passed by the Yeas and Nays: 300 - 100 (Roll no. 99)." },
  ];
  assert.deepEqual(passagesWithoutRollCall(both), []);
});

test("related bills, cosponsors and committee votes, in their sources' own words", () => {
  // H.R. 2102's one related bill, and H.R. 9237's rule (related and procedurally related: kept as related).
  const rel = relatedRows([
    { congress: 119, type: "S", number: 1032, title: "Major Richard Star Act", relationshipDetails: [{ identifiedBy: "CRS", type: "Identical bill" }] },
    { congress: 119, type: "HRES", number: 1377, title: "Providing for consideration of ...", relationshipDetails: [{ identifiedBy: "House", type: "Procedurally related" }] },
    { congress: 119, type: "S", number: 4744, title: "Take Care of America’s Veterans Act", relationshipDetails: [{ identifiedBy: "CRS", type: "Related bill" }, { identifiedBy: "House", type: "Related bill" }] },
  ]);
  assert.deepEqual(rel.map((r) => [r.related_id, relationWords(r)]), [["us-119-s-1032", "Identical bill (identified by CRS)"], ["us-119-s-4744", "Related bill (identified by CRS, House)"]]);
  const cos = cosponsorRows([{ bioguideId: "B001257", fullName: "Rep. Bilirakis, Gus M. [R-FL-12]", isOriginalCosponsor: true, sponsorshipDate: "2026-06-10" }, { fullName: "No id" }]);
  assert.deepEqual(cos, [{ bioguide_id: "B001257", name: "Rep. Bilirakis, Gus M. [R-FL-12]", signed_on: "2026-06-10", original: 1, withdrawn_on: null }]);
  const report = "<p>COMMITTEE CONSIDERATION</p><p>On July 9, 2026, the Full Committee met in open markup session and ordered H.R. 1234, as amended, favorably reported to the House by a recorded vote of 25 yeas and 0 nays, a quorum being present.</p><p>The Committee has no oversight findings.</p>";
  assert.deepEqual(committeeVotes(report), [{ vote_date: "2026-07-09", question: "On July 9, 2026, the Full Committee met in open markup session and ordered H.R. 1234, as amended, favorably reported to the House by a recorded vote of 25 yeas and 0 nays, a quorum being present." }]);
});

// The Clerk's list entry for Discharge Petition No. 22 (H.R. 2102), and the signatures table's markup.
const LIST = `<div id="currentCongress" hidden>119</div><nav><a aria-label="current page 1 of 3 pages">1</a></nav>
<div class="role-call-vote discharge-petition-result"> <div class="row"> <div class="col-lg-8 roll-call-first-col"> <div class="first-row heading" tabindex="0">Discharge Petition No. 22</div> <p class="roll-call-first-row" tabindex="0"> <label>Description:</label> Providing for consideration of the bill (H.R. 2102) to amend title 10, United States Code, to provide for concurrent receipt of veterans&#x27; disability compensation and retired pay for disability retirees with combat-related disabilities, and for other purposes. </p> <div class="hidden-xs hidden-sm"> <div class="view-petition-button"> <a href="/DischargePetition/2026052122?Page=3" class="btn btn-library btn-lg" type="button">View Petition</a> </div> </div> </div> <div class="col-lg-4 roll-call-second-col"> <p class="first-row heading" tabindex="0"> 119th Congress </p> <p> <label>Bill Number:</label> <a role="link" href=https://www.congress.gov/bill/119/HRes/1247 target="_blank" tabindex="0" aria-label="Bill Number: H.Res. 1247">H.Res. 1247</a> </p> <p tabindex="0"> <label>Petition Date:</label> May 21st, 2026 </p> <p tabindex="0" style="display:block;"> <label>Sponsor:</label> <a role="link" href="/Members/T000472" tabindex="0" aria-label="Sponsor: Member One">Member One</a> </p> </div> </div> </div>`;
const PAGE = `<h2>All Signatures</h2><table id="signatures-table"><thead><tr><th>No.</th></tr></thead><tbody id="member-signatures">
<tr> <td data-label="No.">1.</td> <td data-label="Representative"> <a href="/Members/T000472" title="View Profile" class="library-link" tabindex="0">Member One</a> </td> <td style="display:none;">Member One</td> <td data-label="State">California</td> <td style="display:none;">CA</td> <td data-label="District">39</td> <td data-label="Party">Party A</td> <td data-label="Signed Date"> <span style="display:none;">05/21/2026 00:00:00</span> May 21st, 2026 </td> </tr>
<tr> <td data-label="No.">2.</td> <td data-label="Representative"> <a href="/Members/F000468" title="View Profile" class="library-link" tabindex="0">Member &#xD; Two</a> </td> <td data-label="State">Texas</td> <td data-label="District">7</td> <td data-label="Party">Party B</td> <td data-label="Signed Date"> <span style="display:none;">06/02/2026 00:00:00</span> June 2nd, 2026 </td> </tr>
</tbody></table>`;

test("discharge petition: the Clerk's list and signatures, each signature with its date and the Member's Bioguide ID", () => {
  const { petitions, pages } = parsePetitionList(LIST, 119);
  assert.equal(pages, 3);
  assert.deepEqual(petitions, [{
    number: 22,
    description: "Providing for consideration of the bill (H.R. 2102) to amend title 10, United States Code, to provide for concurrent receipt of veterans' disability compensation and retired pay for disability retirees with combat-related disabilities, and for other purposes.",
    href: "/DischargePetition/2026052122", rule_id: "us-119-hres-1247", bill_id: "us-119-hr-2102", filed_on: "2026-05-21", sponsor: "Member One",
  }]);
  assert.deepEqual(parseSignatures(PAGE), [
    { bioguide_id: "T000472", name: "Member One", state: "California", district: "39", signed_on: "2026-05-21", withdrawn_on: null },
    { bioguide_id: "F000468", name: "Member Two", state: "Texas", district: "7", signed_on: "2026-06-02", withdrawn_on: null },
  ]);
  assert.equal(clerkDate("March 10th, 2025"), "2025-03-10");
  assert.equal(billIdFrom("H. J. Res. 72", 119), "us-119-hjres-72");
  assert.equal(petitionDue({ checked_at: "2026-11-12 10:00:00", filed_on: "2026-05-21" }, new Date("2026-11-12T20:00:00Z")), false);
  assert.equal(petitionDue({ checked_at: "2026-11-11 10:00:00", filed_on: "2026-05-21" }, new Date("2026-11-12T20:00:00Z")), true);
});

// A fake budget for the sync steps: Congress.gov and the Clerk's pages from fixtures.
function budget(routes) {
  const find = (url) => {
    const hit = Object.keys(routes).find((k) => url.includes(k));
    if (!hit) throw new Error(`no fixture for ${url}`);
    return routes[hit];
  };
  return { json: async (url) => find(url), text: async (url) => find(url), remaining: () => 1000, timeLeft: () => 1e9 };
}

function seed(sqlite) {
  const off = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, office, level, chamber, body, district, source_url, last_verified, state, district_code, bioguide_id, active)
     VALUES (?, ?, ?, ?, 'federal', ?, ?, ?, 'https://example.org', '2026-11-01', ?, ?, ?, 1)`
  );
  off.run("bioguide:B001257", "rep-cosponsor", "Rep Cosponsor", "U.S. Representative", "us-house", "us-house", "FL-12", "FL", "12", "B001257");
  off.run("bioguide:T000472", "rep-signer", "Rep Signer", "U.S. Representative", "us-house", "us-house", "CA-39", "CA", "39", "T000472");
  off.run("bioguide:X000001", "sen-one", "Senator One", "U.S. Senator", "us-senate", "us-senate", null, "CA", null, "X000001");
  // The motion to recommit on H.R. 9237 and the two votes on its rule, H.Res. 1423, with positions.
  sqlite.exec(`INSERT INTO bills (id, level, chamber, bill_number, title, session, source_url) VALUES
    ('us-119-hres-1423', 'federal', 'us-house', 'H.Res. 1423', 'Providing for consideration of the bill (H.R. 139) ...', '119', 'https://www.congress.gov/bill/119th-congress/house-resolution/1423')`);
  sqlite.exec(`INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay) VALUES
    ('us-house-119-2-236', 'us-119-hres-1423', 'federal', 'us-house', '2026-07-14', 'On Ordering the Previous Question', 'procedural', 'Passed', 'https://clerk.house.gov/Votes/2026236', 215, 210),
    ('us-house-119-2-237', 'us-119-hres-1423', 'federal', 'us-house', '2026-07-14', 'On Agreeing to the Resolution', 'final_passage', 'Passed', 'https://clerk.house.gov/Votes/2026237', 216, 211)`);
  sqlite.exec(`INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES
    ('us-house-119-2-236', 'bioguide:B001257', 'Yes', 'Yea'), ('us-house-119-2-237', 'bioguide:B001257', 'Yes', 'Yea'),
    ('us-house-119-2-236', 'bioguide:T000472', 'No', 'Nay')`);
}

const ROUTES = {
  "/bill/119/hr/9237/actions": { actions: HR9237 },
  "/bill/119/hr/9237/cosponsors": { cosponsors: [{ bioguideId: "B001257", fullName: "Rep. Cosponsor [X-FL-12]", isOriginalCosponsor: true, sponsorshipDate: "2026-06-10" }] },
  "/bill/119/hr/9237/relatedbills": { relatedBills: [{ congress: 119, type: "S", number: 4744, title: "Take Care of America’s Veterans Act", relationshipDetails: [{ identifiedBy: "CRS", type: "Related bill" }] }] },
  "/bill/119/hr/9237?": { bill: { title: "Take Care of America’s Veterans Act", committeeReports: [] } },
};

test("the sync: H.R. 9237's passage, rules, cosponsors and related bills; a second read writes nothing; an analysis is queued once", async () => {
  const sqlite = fresh();
  seed(sqlite);
  const db = d1(sqlite);
  const env = { CONGRESS_API_KEY: "test", CONGRESS_API_BASE: "https://api.example" };
  const counts = { read: 0, passages: 0, records: 0, reportErrors: 0 };
  await readBill(env, db, budget(ROUTES), 119, "HR", 9237, "Take Care of America’s Veterans Act", "2026-11-12T10:00:00Z", counts);
  assert.deepEqual(sqlite.prepare("SELECT bill_id, chamber, method, action_date FROM bill_passages").all().map((r) => ({ ...r })), [{ bill_id: "us-119-hr-9237", chamber: "us-house", method: "voice_vote", action_date: "2026-11-11" }]);
  assert.deepEqual(sqlite.prepare("SELECT rule_id FROM bill_rules ORDER BY rule_id").all().map((r) => r.rule_id), ["us-119-hres-1377", "us-119-hres-1423"]);
  assert.equal(sqlite.prepare("SELECT title FROM bills WHERE id = 'us-119-hr-9237'").get().title, "Take Care of America’s Veterans Act");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM bill_cosponsors").get().n, 1);
  assert.equal(sqlite.prepare("SELECT relationship FROM bill_related").get().relationship, "Related bill");
  // Read again unchanged: nothing written (the record isn't even read again at the same updateDate).
  const before = sqlite.prepare("SELECT total_changes() AS n").get().n;
  await readBill(env, db, budget(ROUTES), 119, "HR", 9237, "Take Care of America’s Veterans Act", "2026-11-12T10:00:00Z", { ...counts });
  assert.equal(sqlite.prepare("SELECT total_changes() AS n").get().n - before, 0);
  // The analysis request: once, for a passage since ANALYSIS_SINCE.
  assert.equal(await queueAnalyses(db, "2026-10-01"), 1);
  assert.equal(await queueAnalyses(db, "2026-10-01"), 0);
  assert.equal(sqlite.prepare("SELECT requested_by FROM analysis_requests WHERE bill_id = 'us-119-hr-9237'").get().requested_by, ANALYSIS_REQUESTER);
  assert.equal(worthReading({ type: "HR", number: 2102, latestAction: { text: "Referred to the Subcommittee on Disability Assistance and Memorial Affairs." } }), false);
  assert.equal(worthReading({ type: "HR", number: 9237, latestAction: { text: "Motion to reconsider laid on the table Agreed to without objection." } }), true);
  assert.equal(worthReading({ type: "HRES", number: 1, latestAction: { text: "Agreed to" } }), false);
});

test("the discharge-petitions step: H.R. 2102's petition, its bill and every signature, matched to officials by Bioguide ID only", async () => {
  const sqlite = fresh();
  seed(sqlite);
  const db = d1(sqlite);
  const env = { CONGRESS_API_KEY: "test", CONGRESS_API_BASE: "https://api.example", CLERK_BASE: "https://clerk.example" };
  const routes = {
    "DischargePetitions?Page=1": LIST.replace("page 1 of 3 pages", "page 1 of 1 pages"),
    "/DischargePetition/2026052122": PAGE,
    "/bill/119/hr/2102": { bill: { title: "Major Richard Star Act" } },
  };
  const r = await syncDischargePetitions(env, db, budget(routes));
  assert.equal(r.status, "ok");
  const p = sqlite.prepare("SELECT * FROM discharge_petitions").get();
  assert.deepEqual([p.id, p.bill_id, p.rule_id, p.filed_on, p.signatures], ["119-22", "us-119-hr-2102", "us-119-hres-1247", "2026-05-21", 2]);
  assert.deepEqual(sqlite.prepare("SELECT name, official_id, signed_on FROM discharge_signatures ORDER BY signed_on").all().map((x) => ({ ...x })), [
    { name: "Member One", official_id: "bioguide:T000472", signed_on: "2026-05-21" },
    { name: "Member Two", official_id: null, signed_on: "2026-06-02" }, // not a loaded official: no match, no guess
  ]);
  assert.equal(sqlite.prepare("SELECT title FROM bills WHERE id = 'us-119-hr-2102'").get().title, "Major Richard Star Act");
});

async function loaded() {
  const sqlite = fresh();
  seed(sqlite);
  const db = d1(sqlite);
  const env = { CONGRESS_API_KEY: "test", CONGRESS_API_BASE: "https://api.example", CLERK_BASE: "https://clerk.example" };
  await readBill(env, db, budget(ROUTES), 119, "HR", 9237, "Take Care of America’s Veterans Act", "2026-11-12T10:00:00Z", { read: 0, passages: 0, records: 0, reportErrors: 0 });
  // The recorded motion to recommit on H.R. 9237 itself.
  sqlite.exec(`INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay) VALUES
    ('us-house-119-2-249', 'us-119-hr-9237', 'federal', 'us-house', '2026-07-16', 'On Motion to Recommit', 'procedural', 'Failed', 'https://clerk.house.gov/Votes/2026249', 210, 211)`);
  sqlite.exec("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES ('us-house-119-2-249', 'bioguide:B001257', 'No', 'Nay')");
  // The motion to discharge the rule that brings up H.R. 2102 (H.Res. 1247), a recorded vote on the rule.
  sqlite.exec(`INSERT INTO bills (id, level, chamber, bill_number, title, session, source_url) VALUES
    ('us-119-hres-1247', 'federal', 'us-house', 'H.Res. 1247', 'Providing for consideration of the bill (H.R. 2102) ...', '119', 'https://www.congress.gov/bill/119th-congress/house-resolution/1247')`);
  sqlite.exec(`INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay) VALUES
    ('us-house-119-2-300', 'us-119-hres-1247', 'federal', 'us-house', '2026-11-12', 'On Motion to Discharge', 'procedural', 'Agreed to', 'https://clerk.house.gov/Votes/2026300', 300, 110)`);
  await syncDischargePetitions(env, db, budget({ "DischargePetitions?Page=1": LIST.replace("page 1 of 3 pages", "page 1 of 1 pages"), "/DischargePetition/2026052122": PAGE, "/bill/119/hr/2102": { bill: { title: "Major Richard Star Act" } } }));
  return { sqlite, db };
}

test("bill_list, the Laws list, This week and the Quick card treat it like any passed bill, with the same line", async () => {
  const { sqlite, db } = await loaded();
  await buildSummaries(db, { force: true });
  const row = sqlite.prepare("SELECT * FROM bill_list WHERE bill_id = 'us-119-hr-9237'").get();
  assert.deepEqual([row.last_final, row.passage_method, row.passage_chamber, row.passage_date, row.final_vote_id], ["2026-11-11", "voice_vote", "us-house", "2026-11-11", null]);
  assert.equal(listBillStatus(row), "Passed · House · voice vote");
  const p = { bill_id: "us-119-hr-9237", chamber: "us-house", method: "voice_vote", action_date: "2026-11-11", bill_number: "H.R. 9237", bill_title: "Take Care of America’s Veterans Act" };
  assert.deepEqual(thisWeek({ stateName: "California", passages: [p] }).map((i) => i.text), ["The House passed H.R. 9237, “Take Care of America’s Veterans Act” by voice vote. Members' individual votes were not recorded."]);
  assert.match(billStatus({ level: "federal" }, null, [], [p]), /^Passed · U\.S\. House · voice vote · /);
  assert.match(billStands({ federal: true, chambers: ["us-house", "us-senate"], outcome: null, votes: [], passages: [p] }), /^Passed the House by voice vote on .*Waiting on the Senate\. Members' individual votes were not recorded\.$/);
  // A bill with a roll call keeps its own status.
  assert.equal(listBillStatus({ final_result: "Passed", final_chamber: "us-house" }), "Passed · House");
});

test("the weekly email: the passage under each House member, the method in place of a position", async () => {
  const { sqlite, db } = await loaded();
  sqlite.prepare("UPDATE officials SET district_code = '39', state = 'CA' WHERE id = 'bioguide:T000472'").run();
  const files = { "/data/zip/900.json": { 90001: [["CA", "39", "1", "1", "06037", 1]] }, "/data/counties.json": { "06037": ["Los Angeles County", "CA"] }, "/data/elections/dates.json": { states: {} } };
  const [e] = await buildEditions({ db, loadJson: async (x) => files[x] ?? null, week: weekOf("2026-11-15"), today: "2026-11-15" }, [{ key: "x", sub: { level: "exact", st: "CA", cd: "39" } }]);
  const items = e.sections.flatMap((s) => (s.groups || []).flatMap((g) => g.items.map((i) => ({ ...i, rep: g.name }))));
  const it = items.find((i) => /H\.R\. 9237/.test(i.text) && i.rep === "Rep Signer");
  assert.ok(it, JSON.stringify(items));
  assert.equal(it.status, "Voice vote");
  assert.match(it.meta, /Members' individual votes were not recorded\./);
});

test("the bill page: the passage line, what is on record in its own labeled sections, and Your reps without an inferred position", async () => {
  const { db } = await loaded();
  const get = async (path, cookie = "") => {
    const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { cookie } : {} });
    const res = await lawsRoute({ request, env: { DB: db }, params: { path: path.split("/").filter(Boolean).slice(1) }, waitUntil: () => {}, data: {} });
    return res.text();
  };
  const html = await get("/laws/bills/us-119-hr-9237/", `pillory_districts=${encodeURIComponent("st=FL&cd=12")}`);
  const text = html.replace(/<[^>]+>/g, " ").replace(/&#x27;|&#39;/g, "'").replace(/\s+/g, " ");
  assert.match(text, /Passed the House by voice vote on Nov 11, 2026\. Members' individual votes were not recorded\./);
  // Recorded votes on this bill: each labeled with what it was a vote on, with its exact question.
  assert.match(html, /id="recorded-votes"[\s\S]*Recorded votes on this bill/);
  assert.match(text, /Sending the bill back to committee \(motion to recommit\) U\.S\. House · Jul 16, 2026 · Question: “On Motion to Recommit” · Failed \(210 yes, 211 no\)/);
  assert.match(text, /Sending the bill back to committee \(motion to recommit\) U\.S\. House · Jul 16, 2026/);
  assert.match(text, /Ending debate on the rule for this bill \(H\.Res\. 1423\) U\.S\. House · Jul 14, 2026 · Question: “On Ordering the Previous Question”/);
  assert.match(text, /Adopting the rule for this bill \(H\.Res\. 1423\)/);
  assert.match(html, /href="\/laws\/bills\/us-119-hres-1423\/\?vote=us-house-119-2-236#votes">Every member's position ›/);
  assert.match(html, /<span class="fold-title">Cosponsors \(signed on to the bill; not a vote\)<\/span>/);
  assert.match(text, /Rep Cosponsor · signed on Jun 10, 2026 \(original cosponsor\)/);
  assert.match(text, /Related bill \(identified by CRS\): S\. 4744/);
  // Your reps: no recorded vote on passage, then each fact on record for that rep, never a position on passage.
  assert.match(text, /No recorded vote on passage \(voice vote\) · Cosponsor since Jun 10, 2026 · Sending the bill back to committee \(motion to recommit\), Jul 16, 2026: No · Ending debate on the rule for this bill \(H\.Res\. 1423\), Jul 14, 2026: Yes · Adopting the rule for this bill \(H\.Res\. 1423\), Jul 14, 2026: Yes/);
  const reps = html.slice(html.indexOf('id="your-reps"'), html.indexOf("</section>", html.indexOf('id="your-reps"')));
  assert.doesNotMatch(reps, /class="position"/); // no position shown for passage
  // The petition's bill page: signatures with their dates.
  const pet = (await get("/laws/bills/us-119-hr-2102/")).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  assert.match(pet, /Signed the discharge petition to force a vote Rep Signer · signed May 21, 2026 Member Two · signed Jun 2, 2026/);
  assert.match(pet, /Discharge Petition No\. 22, filed May 21, 2026 \(to discharge H\.Res\. 1247\): 2 signatures\./);
  assert.match(pet, /Discharging the Rules Committee from the rule for this bill \(H\.Res\. 1247\) U\.S\. House · Nov 12, 2026 · Question: “On Motion to Discharge”/);
});

test("a bill with related procedural votes: each labeled with what it was a vote on, never as a position on the bill", () => {
  assert.equal(voteOn({ question: "On Motion to Recommit" }), "Sending the bill back to committee (motion to recommit)");
  assert.equal(voteOn({ question: "On Ordering the Previous Question" }, { rule: "us-119-hres-1423" }), "Ending debate on the rule for this bill (H.Res. 1423)");
  assert.equal(voteOn({ question: "On Agreeing to the Resolution" }, { rule: "us-119-hres-1423" }), "Adopting the rule for this bill (H.Res. 1423)");
  assert.equal(voteOn({ question: "On the Cloture Motion" }), "Ending debate (cloture)");
  assert.equal(voteOn({ question: "On Motion to Table" }), "Setting a motion aside (motion to table)");
});

test("neutral wording only, in every line these pages and the email add", () => {
  const files = ["workers/sync/src/passages/parse.js", "functions/_lib/passages.js", "functions/_lib/bill-page.js", "functions/_lib/quick-home.js", "functions/_lib/simple.js", "functions/_lib/laws-list.js"];
  const banned = /\b(avoid\w*|hid|hide|hiding|hidden from|coward\w*|dodg\w*|duck\w*|sneak\w*|secret\w*|quietly|behind closed doors|escape\w*|shirk\w*|evad\w*|without accountability|unaccountable)\b/i;
  for (const f of files) {
    const src = readFileSync(new URL(`../../../${f}`, import.meta.url), "utf8").replace(/^\s*(\/\/|\*).*$/gm, "");
    const strings = [...src.matchAll(/(["'`])((?:\\.|(?!\1).)*)\1/g)].map((m) => m[2]).join(" | ");
    const hit = strings.match(new RegExp(`.{0,40}${banned.source}.{0,40}`, "i"));
    assert.equal(hit, null, `${f}: ${hit && hit[0]}`);
  }
  assert.equal(NOT_RECORDED, "Members' individual votes were not recorded.");
});
