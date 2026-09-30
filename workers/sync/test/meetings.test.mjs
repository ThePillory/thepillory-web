// Unit tests for the county meeting portal readers and the comment-instruction
// extraction, against FAKE pages that copy the portal's real markup.
// Run: node workers/sync/test/meetings.test.mjs
import assert from "node:assert/strict";
import { parseCalendar, parseRss, parseMeeting, localDateTime, sectionKind } from "../src/meetings/iqm2.js";
import { commentInfo, deadlineLabel, flatten, sentences } from "../src/meetings/comment.js";
import { agendaPdfText } from "../src/meetings/county.js";
import { matchEvent } from "../src/meetings/state.js";
import { checkSummaries } from "../src/analysis/agenda-check.js";
import { calendarHtml, rssHtml, meetingHtml, agendaLines, makePdf, MEETINGS } from "./iqm2-fixtures.mjs";

let n = 0;
const test = async (name, fn) => {
  await fn();
  n++;
  console.log(`ok   ${name}`);
};

await test("local date and time from the portal's wording", () => {
  assert.equal(localDateTime("JULY 28, 2026", "8:00 AM"), "2026-07-28T08:00");
  assert.equal(localDateTime("SEPTEMBER 3, 2026", "1:30 PM"), "2026-09-03T13:30");
  assert.equal(localDateTime("DECEMBER 1, 2026", "12:00 PM"), "2026-12-01T12:00");
});

await test("calendar rows: body, time, status, location and published documents", () => {
  const rows = parseCalendar(calendarHtml());
  assert.equal(rows.length, MEETINGS.length);
  const bos = rows.find((r) => r.portal_id === "9001");
  assert.equal(bos.body, "Board of Supervisors");
  assert.equal(bos.meeting_type, "Regular Meeting");
  assert.match(bos.starts_at, /T09:00$/);
  assert.equal(bos.status, "scheduled");
  assert.equal(bos.location, "Board of Supervisors Chambers, 891 Mountain Ranch Road, San Andreas, CA 95249");
  assert.equal(bos.agenda_url, "https://calaverascountyca.iqm2.com/Citizens/FileOpen.aspx?Type=14&ID=7001&Inline=True");
  assert.equal(bos.agenda_file_id, "7001");
  assert.equal(bos.minutes_url, null);
  assert.equal(bos.source_url, "https://calaverascountyca.iqm2.com/Citizens/Detail_Meeting.aspx?ID=9001");
  const past = rows.find((r) => r.portal_id === "9005");
  assert.equal(past.status, "held");
  assert.match(past.minutes_url, /Type=12&ID=8005/);
  assert.equal(rows.find((r) => r.portal_id === "9006").status, "cancelled");
  assert.equal(rows.find((r) => r.portal_id === "9004").agenda_url, null);
  // The list hides some agenda links; those meetings still get read from their own page.
  assert.equal(rows.find((r) => r.portal_id === "9002").agenda_url, null);
});

await test("publish dates from the agenda feed", () => {
  const posted = parseRss(rssHtml());
  assert.ok(posted["9001"] && /^\d{4}-\d{2}-\d{2}T/.test(posted["9001"]));
});

await test("web agenda: numbered items, sections, staff reports and exhibits", () => {
  const { items, agenda_url, packet_url } = parseMeeting(meetingHtml(9001));
  assert.deepEqual(items.map((i) => i.number), ["1", "2", "3", "4", "5"]);
  assert.equal(items[0].section_kind, "closed_session");
  assert.equal(items[1].section, "Consent Agenda");
  assert.equal(items[1].section_kind, "consent");
  assert.match(items[1].staff_report_url, /Type=30&ID=401/);
  assert.deepEqual(items[1].attachments.map((a) => a.title), ["Example Paving Co. Agreement"]);
  assert.match(items[1].item_url, /Detail_LegiFile\.aspx/);
  assert.equal(items[3].section_kind, "regular");
  assert.match(agenda_url, /Type=14&ID=7001/);
  assert.match(packet_url, /Type=1&ID=7001/);
  assert.equal(parseMeeting(meetingHtml(9001)).agenda_file_id, "7001");
  const hidden = parseMeeting(meetingHtml(9002));
  assert.equal(hidden.agenda_file_id, "7002");
  assert.match(hidden.agenda_url, /Type=14&ID=7002/);
  const none = parseMeeting(meetingHtml(9004));
  assert.deepEqual([none.items.length, none.agenda_url, none.agenda_file_id, none.unavailable], [0, null, null, false]);
  const withdrawn = parseMeeting(meetingHtml(9009));
  assert.deepEqual([withdrawn.items.length, withdrawn.unavailable], [0, true]);
  const pc = parseMeeting(meetingHtml(9002)).items;
  assert.equal(pc[0].section_kind, "public_hearing");
  assert.equal(sectionKind("Adjournment"), "other");
});

await test("comment instructions come out of a real PDF, word for word", async () => {
  const pages = await agendaPdfText(makePdf(agendaLines(7001)));
  const info = commentInfo(pages);
  assert.equal(
    info.comment_deadline_text,
    "As an alternative to commenting in person or via Zoom, you can make a public comment by e-mailing the Clerk of the Board, clerk@example.gov, no later than 4:00 pm on the day before the Board meeting."
  );
  assert.equal(info.online_url, "https://us02web.zoom.us/webinar/register/WN_FAKEtest123");
  const flat = flatten(pages.slice(0, 2).join("\n"));
  for (const s of sentences(info.comment_text)) assert.ok(flat.includes(s), `not verbatim: ${s}`);
});

await test("the short deadline label is worked out only from plain wording", () => {
  assert.deepEqual(deadlineLabel("… no later than 4:00 pm on the day before the Board meeting.", "2026-10-13T09:00"), { date: "2026-10-12", day: "Mon, Oct 12", time: "4:00 pm", label: "Mon, Oct 12, 4:00 pm" });
  assert.equal(deadlineLabel("Written comments received by 5:00 pm on the Monday before the meeting will be forwarded.", "2026-10-15T09:00"), null);
  assert.equal(deadlineLabel(null, "2026-10-15T09:00"), null);
});

await test("state hearings match our legislators' committees", () => {
  const committees = [{ id: "ocd-organization/c1", name: "Assembly Committee on Test Matters", member_ids: '["openstates:p1"]' }];
  const legislators = [{ id: "openstates:p1", openstates_id: "ocd-person/p1", name: "Test Assemblymember Delta" }];
  const ev = { participants: [{ name: "Assembly Committee on Test Matters", organization: { id: "ocd-organization/c1" } }] };
  assert.deepEqual(matchEvent(ev, committees, legislators).members, ["openstates:p1"]);
  assert.equal(matchEvent({ participants: [{ name: "Some Other Committee", organization: { id: "x" } }] }, committees, legislators), null);
});

await test("agenda summaries: made-up numbers and unknown items are removed", () => {
  const items = parseMeeting(meetingHtml(9001)).items.map((i) => ({ ...i, attachments: JSON.stringify(i.attachments) }));
  const draft = {
    items: [
      { item_key: "2", summary: "The Board would approve a road repair contract with Example Paving Co. The contract may not exceed $250,000. It runs for 36 months.", flags: ["budget", "budget"] },
      { item_key: "4", summary: "Staff would report on the budget for fiscal year 2026-27. The Board would give direction.", flags: ["budget"] },
      { item_key: "99", summary: "Not on the agenda.", flags: [] },
    ],
    issue_links: [
      { item_key: "5", issue_slug: "public-comment-limit", reason: "Both concern public comment time limits." },
      { item_key: "99", issue_slug: "public-comment-limit", reason: "x" },
    ],
  };
  const log = checkSummaries(draft, items);
  assert.equal(draft.items.length, 2);
  assert.equal(draft.items[0].summary, "The Board would approve a road repair contract with Example Paving Co. The contract may not exceed $250,000.");
  assert.deepEqual(draft.items[0].flags, ["budget"]);
  assert.match(draft.items[1].summary, /2026-27/);
  assert.equal(log.removed_sentences.length, 1);
  assert.match(log.removed_sentences[0].because, /36/);
  assert.equal(log.dropped_items[0].item_key, "99");
  assert.equal(draft.issue_links.length, 1);
});

console.log(`\n${n} passed`);
