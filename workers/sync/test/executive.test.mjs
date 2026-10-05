// Unit tests for the executive branch parsers, against FAKE responses shaped
// like the real ones. Run: node workers/sync/test/executive.test.mjs
import assert from "node:assert/strict";
import {
  isoDate, executiveOn, personName, parseCabinet, frOrder, federalOutcome, federalWorthChecking, presentableFederal,
  parseLeginfoHistory, californiaOutcome, leginfoBillId, presentableCalifornia, parseGovFeed, govOrderFromPost,
  nominationStatus, nominationRow, currentCongress,
} from "../src/executive/parse.js";
import { executive, cabinetHtml, fr, congressExec, leginfoHistory, govFeed, govPosts } from "./executive-fixtures.mjs";

let n = 0;
const test = (name, fn) => {
  fn();
  n++;
  console.log(`ok   ${name}`);
};
const year = new Date().getUTCFullYear();

test("dates and Congress numbers", () => {
  assert.equal(isoDate("10/09/25"), "2025-10-09");
  assert.equal(isoDate("1/2/2026"), "2026-01-02");
  assert.equal(isoDate("Oct 9"), null);
  assert.equal(currentCongress(new Date("2026-10-05T00:00:00Z")), 119);
  assert.equal(currentCongress(new Date("2025-01-02T00:00:00Z")), 118, "a new Congress starts January 3");
  assert.equal(currentCongress(new Date("2027-01-03T00:00:00Z")), 120);
});

test("President and Vice President on a date, from executive.json", () => {
  const now = executiveOn(executive, `${year}-06-01`);
  assert.equal(personName(now.prez.person), "Testa Q. Presidente");
  assert.equal(personName(now.viceprez.person), "Vicky Vicepresidente", "official_full wins");
  assert.equal(personName(executiveOn(executive, "2010-06-01").prez.person), "Former Presidentperson");
  assert.equal(executiveOn(executive, "1990-01-01").prez, undefined);
});

test("Cabinet: name and office pairs only; bios and menus ignored", () => {
  const c = parseCabinet(cabinetHtml);
  assert.equal(c.length, 9);
  assert.deepEqual(c[0], { name: "Alex Testsecretary", title: "Secretary of State" });
  assert.ok(c.some((m) => m.name === "Harper Dummy" && m.title === "Director of the Office of Management and Budget"));
  assert.ok(!c.some((m) => /Menu|About|Subscribe/.test(m.name)));
  assert.deepEqual(parseCabinet("<h2>Our Priorities</h2><h3>Grow the economy.</h3>"), []);
});

test("Federal Register executive orders", () => {
  const d = fr(new URLSearchParams({ "conditions[president][]": "testa-presidente" }));
  const o = frOrder(d.results[1]);
  assert.equal(o.id, `fr:${year}-099901`);
  assert.equal(o.number, "99901");
  assert.equal(o.title, "Establishing a Test Order & Its Title [FAKE]", "entities decoded, wording unchanged");
  assert.equal(o.signed_on, `${year}-03-05`);
  assert.match(o.source_url, /^https:\/\/www\.federalregister\.gov\//);
});

test("federal outcomes, from the action that says so", () => {
  const signed = federalOutcome(congressExec["/bill/119/hr/10/actions"].actions);
  assert.deepEqual(signed, { outcome: "signed", action_date: "2025-09-20", action_text: "Signed by President.", presented_on: "2025-09-15", law_number: "Public Law 119-99" });
  const vetoed = federalOutcome(congressExec["/bill/119/hr/20/actions"].actions);
  assert.equal(vetoed.outcome, "vetoed");
  assert.equal(vetoed.action_date, "2025-10-01");
  assert.equal(federalOutcome(congressExec["/bill/119/s/30/actions"].actions).outcome, "presented");
  const over = federalOutcome([
    { actionDate: "2025-01-10", text: "Vetoed by President." },
    { actionDate: "2025-02-01", text: "Passed Senate over veto by Yea-Nay Vote. 70 - 30." },
    { actionDate: "2025-02-02", text: "Became Public Law No: 119-5." },
  ]);
  assert.equal(over.outcome, "over_veto");
  assert.equal(over.law_number, "Public Law 119-5");
  assert.equal(federalOutcome([{ actionDate: "2025-01-02", text: "Became Public Law No: 119-6 without the President's signature." }]).outcome, "without_signature");
  assert.equal(federalOutcome([{ actionDate: "2025-01-02", text: "Became Public Law No: 119-7." }]).outcome, "became_law", "no signature action: not assumed signed");
  assert.equal(federalOutcome([{ actionDate: "2025-01-02", text: "Pocket Vetoed by President." }]).outcome, "pocket_vetoed");
  assert.equal(federalOutcome([{ actionDate: "2025-01-02", text: "Referred to committee." }]), null);
  assert.ok(federalWorthChecking("Veto message received in Senate."));
  assert.ok(!federalWorthChecking("Referred to the Committee on Testing."));
  assert.ok(presentableFederal("HJRES") && presentableFederal("s") && !presentableFederal("HRES") && !presentableFederal("SCONRES"));
});

test("California outcomes, from leginfo's history table", () => {
  const rows = parseLeginfoHistory(leginfoHistory["202520260AB101"]);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], { date: "2025-09-30", action: "Approved by the Governor." });
  assert.deepEqual(californiaOutcome(rows), {
    outcome: "signed", action_date: "2025-09-30", action_text: "Approved by the Governor.", presented_on: "2025-09-10", law_number: "Chapter 321, Statutes of 2025",
  });
  const vetoed = californiaOutcome([
    { date: "2026-01-22", action: "Consideration of Governor's veto stricken from file." },
    { date: "2025-10-13", action: "Vetoed by Governor." },
    { date: "2025-09-24", action: "Enrolled and presented to the Governor at  3 p.m." },
  ]);
  assert.equal(vetoed.outcome, "vetoed");
  assert.equal(vetoed.action_date, "2025-10-13");
  assert.equal(californiaOutcome([{ date: "2025-09-24", action: "Enrolled and presented to the Governor at  3 p.m." }]).outcome, "presented");
  assert.equal(californiaOutcome([{ date: "2025-10-01", action: "Chaptered by Secretary of State - Chapter 9, Statutes of 2025." }]).outcome, "became_law");
  assert.equal(californiaOutcome([{ date: "2025-04-01", action: "Read third time. Passed." }]), null);
  assert.deepEqual(parseLeginfoHistory("<html>no table</html>"), []);
  assert.equal(leginfoBillId("ca-20252026-ab-101"), "202520260AB101");
  assert.equal(leginfoBillId("ca-20252026-sbx1-5"), "202520261SB5");
  assert.ok(presentableCalifornia("ca-20252026-sb-7") && !presentableCalifornia("ca-20252026-acr-3"));
});

test("Governor's feed and posts: the signed order's PDF and number", () => {
  const items = parseGovFeed(govFeed(1), "http://127.0.0.1:8788/");
  assert.equal(items.length, 2);
  assert.equal(items[0].id, "ca-gov:1001");
  assert.equal(items[0].kind, "executive_order");
  assert.equal(items[1].kind, "proclamation");
  assert.equal(items[0].published_on, `${year}-09-18`);
  assert.equal(parseGovFeed(govFeed(1)).length, 0, "links off the Governor's site are ignored");
  assert.deepEqual(govOrderFromPost(govPosts["eo-test"]), { document_url: `https://www.gov.ca.gov/wp-content/uploads/${year}/09/FINAL-N-9-26-TEST-EO-SIGNED.pdf`, number: "N-9-26" });
  assert.equal(govOrderFromPost(govPosts["proclamation-test"]).number, null);
  assert.match(govOrderFromPost(govPosts["proclamation-test"]).document_url, /Proclamation\.pdf$/);
  assert.deepEqual(govOrderFromPost(govPosts["other-test"]), { document_url: null, number: null });
});

test("nominations: status from Congress.gov's latest action", () => {
  assert.equal(nominationStatus("Confirmed by the Senate by Voice Vote."), "confirmed");
  assert.equal(nominationStatus("Received message of withdrawal of nomination from the President."), "withdrawn");
  assert.equal(nominationStatus("Returned to the President under the provisions of Senate Rule XXXI."), "returned");
  assert.equal(nominationStatus("Committee on Foreign Relations. Hearings held."), "pending");
  const r = nominationRow(congressExec["/nomination/119"].nominations[0]);
  assert.equal(r.id, "PN9001");
  assert.equal(r.status, "confirmed");
  assert.equal(r.source_url, "https://www.congress.gov/nomination/119th-congress/9001");
});

console.log(`\n${n} passed`);
