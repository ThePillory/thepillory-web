// Unit tests for the county meeting portal readers and the comment-instruction
// extraction, against FAKE pages that copy the portal's real markup.
// Run: node workers/sync/test/meetings.test.mjs
import assert from "node:assert/strict";
import { parseCalendar, parseRss, parseMeeting, localDateTime, sectionKind } from "../src/meetings/iqm2.js";
import { commentInfo, deadlineLabel, flatten, sentences } from "../src/meetings/comment.js";
import { agendaPdfText } from "../src/meetings/county.js";
import { matchEvent } from "../src/meetings/state.js";
import { checkSummaries, rankFlags, MAX_FLAGGED } from "../src/analysis/agenda-check.js";
import { caDigest } from "../src/analysis/billtext.js";
import { calendarHtml, rssHtml, meetingHtml, agendaLines, makePdf, MEETINGS } from "./iqm2-fixtures.mjs";
import { parseMeetingList, parseSummaryAgenda, parsePacketAgenda, meetingDate, clock } from "../src/meetings/tylermm.js";
import { openPdf, streamPages, linePages } from "../src/meetings/pdftext.js";
import { meetingList, agendaPages } from "./tylermm-fixtures.mjs";
import { dayFromToday } from "./iqm2-fixtures.mjs";

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
      { item_key: "2", summary: "The Board would approve a road repair contract with Example Paving Co. The contract may not exceed $250,000. It runs for 36 months.", impact: "high", flags: ["budget", "budget"] },
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
  // No residents' issues exist yet, so every suggested link is dropped.
  assert.equal(draft.issue_links.length, 0);
});

// ---- Tyler Meeting Manager ----

await test("Tyler: meeting dates in both of the API's formats, times, and cancellations", () => {
  assert.equal(meetingDate({ actualStartDate: "2026-09-22 00:00:00.0" }), "2026-09-22");
  assert.equal(meetingDate({ actualStartDate: "Thu Oct 22 00:00:00 EDT 2026" }), "2026-10-22");
  assert.equal(meetingDate({ actualStartDate: "Tue Nov 10 00:00:00 EST 2026" }), "2026-11-10");
  // Midnight Eastern, given in UTC.
  assert.equal(meetingDate({ startDateTime: "2026-11-10T05:00:00.000+00:00" }), "2026-11-10");
  assert.equal(clock("9:00 AM"), "09:00");
  assert.equal(clock("1:30 PM"), "13:30");
  assert.equal(clock("12:00 PM"), "12:00");
  assert.equal(clock(""), null);
  assert.equal(meetingList({ startDate: "2026-10-01", endDate: "2026-11-01", meetingTypeIds: [5] }), null); // the real API answers 500
  const list = parseMeetingList(meetingList({ startDate: "01/01/2026", endDate: "12/31/2026", meetingTypeIds: [5, 11, 4] }), "https://tmm.example/api/");
  assert.ok(!list.some((m) => m.id === "tmm-701"), "a committee we don't follow");
  const bos = list.find((m) => m.id === "tmm-502");
  assert.equal(bos.body, "Board of Supervisors");
  assert.equal(bos.meeting_type, "Special Meeting");
  assert.match(bos.starts_at, /^\d{4}-\d{2}-\d{2}T09:00$/);
  assert.equal(bos.agenda_url, "https://tmm.example/api/meetingInformation/Agenda/false/8101");
  assert.equal(bos.packet_url, "https://tmm.example/api/meetingInformation/Agenda/true/8101");
  assert.match(bos.agenda_file_id, /^8101@/);
  assert.equal(bos.titles.length, 6);
  const pc = list.find((m) => m.id === "tmm-601");
  assert.equal(pc.agenda_url, "https://tmm.example/api/meetingInformation/Agenda/true/8102", "the Commission posts only the packet");
  assert.equal(pc.packet_url, null);
  assert.equal(list.find((m) => m.id === "tmm-602").status, "cancelled");
  const unposted = list.find((m) => m.id === "tmm-503");
  assert.equal(unposted.agenda_url, null, "an agenda id without a posted agenda isn't linked");
  assert.equal(unposted.agenda_file_id, null);
  // tmm-504 has the long date format ("Tue Nov 10 00:00:00 EST 2026").
  assert.equal(list.find((m) => m.id === "tmm-504").starts_at.slice(0, 10), dayFromToday(16).toISOString().slice(0, 10));
});

const tylerPdf = async (id, packet) => openPdf(makePdf(agendaPages(id, packet)));

await test("Tyler: Board agenda items, sections, departments and attachments from the agenda PDF", async () => {
  const titles = parseMeetingList(meetingList({ startDate: "01/01/2026", endDate: "12/31/2026", meetingTypeIds: [5] })).find((m) => m.id === "tmm-502").titles;
  const items = parseSummaryAgenda(await streamPages(await tylerPdf(8101, false)), titles);
  assert.equal(items.length, 6);
  assert.deepEqual(items.map((i) => i.number), ["1", "2", "3", "4", "5", "6"]);
  assert.deepEqual(items.map((i) => i.section_kind), ["closed_session", "other", "consent", "consent", "consent", "regular"]);
  // The closed-session title comes from the JSON (the PDF inserts a stray period).
  assert.equal(items[0].title, titles[0]);
  assert.equal(items[1].title, "Proclamation - 2099-0101, Clerk of the Board. Adopt a Proclamation recognizing [a fake observance].");
  assert.deepEqual(items[1].attachments.map((a) => a.title), ["Staff Memo_Fake.docx", "Proclamation_Fake.docx"]);
  assert.equal(items[2].section, "Consent Agenda");
  assert.deepEqual(items[2].attachments.map((a) => a.title), ["Minutes_20990106.pdf"], "attachments continue past the page break");
  assert.equal(items[3].title, "Resolution - 2099-0102, Public Works. Adopt a Resolution approving [a fake road project] in an amount not to exceed $100.");
  assert.equal(items[4].title, "Agreement-2099-0103, Library. Authorize the Board Chair to sign an agreement with [Vendor A].");
  assert.equal(items[4].attachments.length, 0);
  assert.equal(items[5].section, "Regular Agenda");
  assert.deepEqual(items[5].attachments.map((a) => a.title), ["Staff Memo_Ordinance.docx", "Draft Ordinance.pdf"], "stops at the next section");
  // A title the PDF doesn't have still becomes an item.
  const extra = parseSummaryAgenda(await streamPages(await tylerPdf(8101, false)), [...titles, "Resolution - 2099-0999"]);
  assert.equal(extra[6].title, "Resolution - 2099-0999");
  assert.equal(extra[6].section, null);
});

await test("Tyler: Planning Commission items from the packet, stopping before the staff reports", async () => {
  const items = parsePacketAgenda(await streamPages(await tylerPdf(8102, true), 8));
  assert.equal(items.length, 2);
  assert.equal(items[0].number, "1");
  assert.equal(items[0].section, "Regular Agenda");
  assert.equal(items[0].section_kind, "regular");
  assert.equal(items[0].title, "2099-001 Tentative Parcel Map for [Applicant A] The applicant is requesting approval to divide one parcel into two lots. The project site (APN 000-000-000) is located in Section 1, T01N, R01E, MDM&B. ([Planner], Planner)");
  assert.match(items[1].title, /^2099-002 Conditional Use Permit/);
});

await test("Tyler: how to comment, from lines rebuilt by position, and both deadline wordings", async () => {
  const bos = commentInfo(await linePages(await tylerPdf(8101, false), 2));
  assert.equal(bos.comment_deadline_text, "As an alternative to commenting in person or via Zoom, you can make a public comment by e-mailing the Clerk of the Board, clerk@example.org, no later than 4:00 pm on the day before the Board meeting.");
  assert.equal(bos.online_url, "https://us02web.zoom.us/webinar/register/WN_fakeTest123");
  const pc = commentInfo(await linePages(await tylerPdf(8102, true), 2));
  assert.match(pc.comment_deadline_text, /no later than 4:00pm on the Monday prior to the Commission meeting\.$/);
  assert.equal(pc.online_url, "https://us06web.zoom.us/meeting/register/fakePC456");
  // Thursday Sep 24, 2026: the Monday before is Sep 21. Monday Sep 28: the Monday before is Sep 21.
  assert.equal(deadlineLabel(pc.comment_deadline_text, "2026-09-24T09:00").label, "Mon, Sep 21, 4:00 pm");
  assert.equal(deadlineLabel(pc.comment_deadline_text, "2026-09-28T09:00").date, "2026-09-21");
  assert.equal(deadlineLabel(bos.comment_deadline_text, "2026-09-22T09:00").label, "Mon, Sep 21, 4:00 pm");
});

await test("agenda watch: at most five flagged items, ranked by impact; consent items only when high", () => {
  // 32 items like tmm-102: 2 closed session, 1 recognition, 26 consent, 3 regular. The drafter flagged 27.
  const kinds = ["closed_session", "closed_session", "other", ...Array(26).fill("consent"), "regular", "regular", "regular"];
  const agenda = kinds.map((k, i) => ({ item_key: String(i + 1), section_kind: k }));
  const impact = (i) => (i === 7 ? "high" : i === 12 ? "high" : i >= 29 ? (i === 31 ? "high" : "medium") : i === 1 ? "low" : "medium");
  const summary = agenda.map((a, i) => ({ item_key: a.item_key, summary: "x", impact: impact(i), flags: i === 2 || i === 4 ? [] : ["budget"] }));
  const { items, kept, cleared } = rankFlags(summary, agenda);
  assert.equal(MAX_FLAGGED, 5);
  assert.equal(kept, 5);
  const shown = items.filter((s) => s.flags.length).sort((a, b) => a.rank - b.rank).map((s) => s.item_key);
  // High first (regular before consent, then agenda order), then medium regular items.
  assert.deepEqual(shown, ["32", "8", "13", "1", "30"]);
  assert.equal(cleared, 30 - 5, "every other flagged item keeps its summary, without flags");
  assert.ok(items.every((s) => s.summary === "x"));
  assert.ok(!items.find((s) => s.item_key === "2").flags.length, "a low-impact item is never flagged");
  // Summaries drafted before impact ratings: every flagged consent item is left out.
  const legacy = rankFlags(summary.map(({ impact: _i, ...s }) => s), agenda);
  assert.deepEqual(legacy.items.filter((s) => s.flags.length).map((s) => s.item_key), ["1", "2", "30", "31", "32"]);
});

await test("relevance: the Legislative Counsel's Digest from a leginfo page", () => {
  const html = `<div id="bill_all"><p>An act to amend Section 1 of the Penal Code, relating to prisons.</p><p>LEGISLATIVE COUNSEL&#39;S DIGEST</p><p>SB 337, as introduced, [Senator]. Prisons: visiting.</p><p>Existing law requires the Department of Corrections and Rehabilitation to allow visits. This bill would require each prison to post its visiting hours online.</p><p>Vote: majority Appropriation: no</p><p>The people of the State of California do enact as follows:</p><p>SECTION 1. ...</p></div>`;
  assert.equal(caDigest(html), "SB 337, as introduced, [Senator]. Prisons: visiting.\nExisting law requires the Department of Corrections and Rehabilitation to allow visits. This bill would require each prison to post its visiting hours online.");
  assert.equal(caDigest("<p>No text available.</p>"), null);
});

console.log(`\n${n} passed`);
