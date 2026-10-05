// FAKE upstream APIs for local testing only. Every name and number here is
// invented ("Test Senator Alpha", bill "H.R. 10", …). Nothing in this file is
// real data and none of it is ever loaded into production.
//
// Mimics the response shapes of Congress.gov v3, Open States v3, and the
// senate.gov roll call XML closely enough to exercise the sync end to end.
import { executive, cabinetHtml, fr, congressExec, leginfoHistory, stateExecutiveFile, govFeed, govPosts } from "./executive-fixtures.mjs";
import http from "node:http";
import { calendarHtml, rssHtml, meetingHtml, agendaLines, makePdf, dayFromToday } from "./iqm2-fixtures.mjs";
import { meetingList, agendaPages } from "./tylermm-fixtures.mjs";
import { legislators, fec as fecFixture, lda as ldaFixture } from "./funding-fixtures.mjs";

const PORT = parseInt(process.env.FIXTURE_PORT || "8788", 10);
const hits = {};

const member = (id, name, last, chamber, district, party, state = "California") => ({
  bioguideId: id,
  name: `${last}, ${name.split(" ")[0]}`,
  partyName: party,
  state,
  district,
  terms: { item: [{ chamber, startYear: 2023 }] },
  depiction: { imageUrl: `https://example.org/photos/${id}.jpg`, attribution: "Fixture photo" },
});

const congress = {
  // Every current member (nationwide). T000004, T000005 and T000006 have no
  // detail record, so the list's record is used for them.
  "/member": {
    members: [
      member("T000001", "Test Senator Alpha", "Alpha", "Senate", undefined, "Party A"),
      member("T000002", "Test Senator Beta", "Beta", "Senate", undefined, "Party B"),
      member("T000003", "Test Representative Gamma", "Gamma", "House of Representatives", 77, "Party C"),
      member("T000004", "Test Representative Other", "Other", "House of Representatives", 12, "Party A"),
      member("T000005", "Other Senator Alpha", "Alpha", "Senate", undefined, "Party B", "Nevada"),
      member("T000006", "Test Delegate Zeta", "Zeta", "House of Representatives", undefined, "Party A", "Alaska"),
    ],
    pagination: { count: 6 },
  },
  ...Object.fromEntries(
    [
      ["T000001", "Test Senator Alpha", "Alpha", "Senate", "Party A"],
      ["T000002", "Test Senator Beta", "Beta", "Senate", "Party B"],
      ["T000003", "Test Representative Gamma", "Gamma", "House of Representatives", "Party C"],
    ].map(([id, name, last, chamber, party]) => [
      `/member/${id}`,
      {
        member: {
          bioguideId: id,
          directOrderName: name,
          lastName: last,
          officialWebsiteUrl: `https://example.org/${last.toLowerCase()}`,
          partyHistory: [{ partyName: party, startYear: 2019 }],
          terms: [
            { chamber, congress: 118, startYear: 2023, endYear: 2025 },
            { chamber, congress: 119, startYear: 2025, endYear: 2027 },
          ],
          depiction: { imageUrl: `https://example.org/photos/${id}.jpg`, attribution: "Fixture photo" },
        },
      },
    ])
  ),
  "/house-vote/119/1": {
    houseRollCallVotes: [1, 2, 3].map((n) => ({ congress: 119, sessionNumber: 1, rollCallNumber: n })),
  },
  "/house-vote/119/2": { houseRollCallVotes: [4, 5].map((n) => ({ congress: 119, sessionNumber: 2, rollCallNumber: n })) },
  "/house-vote/119/1/1": { houseRollCallVote: { voteQuestion: "On Passage", legislationType: "HR", legislationNumber: "10", result: "Passed", startDate: "2025-02-01T15:00:00-05:00", sourceDataURL: "https://clerk.house.gov/evs/2025/roll1.xml",
    votePartyTotal: [{ voteParty: "A", yeaTotal: 200, nayTotal: 10, presentTotal: 1, notVotingTotal: 3 }, { voteParty: "B", yeaTotal: 20, nayTotal: 190, presentTotal: 0, notVotingTotal: 11 }] } },
  "/house-vote/119/1/2": { houseRollCallVote: { voteQuestion: "On Motion to Recommit", legislationType: "HR", legislationNumber: "10", result: "Failed", startDate: "2025-02-01T14:00:00-05:00" } },
  "/house-vote/119/1/3": { houseRollCallVote: { voteQuestion: "On Agreeing to the Resolution", legislationType: "HRES", legislationNumber: "5", result: "Passed", startDate: "2025-01-31T12:00:00-05:00" } },
  "/house-vote/119/2/4": { houseRollCallVote: { voteQuestion: "On Motion to Suspend the Rules and Pass", legislationType: "HR", legislationNumber: "20", result: "Passed", startDate: "2026-03-10T12:00:00-04:00" } },
  "/house-vote/119/1/1/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Yea" }, { bioguideID: "T000004", voteCast: "Nay" }, { bioguideID: "T000006", voteCast: "Yea" }, { bioguideID: "X999999", voteCast: "Nay" }] } },
  "/house-vote/119/1/2/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Nay" }] } },
  "/house-vote/119/1/3/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Aye" }] } },
  "/house-vote/119/2/4/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Not Voting" }] } },
  // A ceremonial bill (a post office naming): the relevance check skips it.
  "/house-vote/119/2/5": { houseRollCallVote: { voteQuestion: "On Motion to Suspend the Rules and Pass", legislationType: "HR", legislationNumber: "40", result: "Passed", startDate: "2026-03-12T12:00:00-04:00" } },
  "/house-vote/119/2/5/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Yea" }] } },
  "/bill/119/hr/10": { bill: { title: "Test Bill Ten Act" } },
  "/bill/119/hres/5": { bill: { title: "Providing for consideration of the bill (H.R. 10) to test things" } },
  "/bill/119/hr/20": { bill: { title: "Test Bill Twenty Act of 2026 ($1 test)" } },
  "/bill/119/hr/40": { bill: { title: "To designate the facility of the United States Postal Service located at 100 Example Street in Testville, California, as the \"Test Person Post Office Building\"." } },
};

const senMember = (last, first, state, cast, lis) =>
  `<member><member_full>${last} (X-${state})</member_full><last_name>${last}</last_name><first_name>${first}</first_name><party>X</party><state>${state}</state><vote_cast>${cast}</vote_cast><lis_member_id>${lis}</lis_member_id></member>`;
const senVote = (n, s, date, question, docType, docNumber, title, members, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote><congress>119</congress><session>${s}</session><vote_number>${n}</vote_number><vote_date>${date}</vote_date><question>${question}</question><vote_result>Passed</vote_result>${n === 1 && s === 1 ? "<count><yeas>51</yeas><nays>47</nays><present/><absent>2</absent></count>" : ""}<document><document_congress>119</document_congress><document_type>${docType}</document_type><document_number>${docNumber}</document_number><document_title>${title}</document_title></document>${extra}<vote_document_text>${title}</vote_document_text><members>${members}</members></roll_call_vote>`;
const senate = {
  "/roll_call_lists/vote_menu_119_1.xml": "<vote_summary><votes><vote><vote_number>00001</vote_number></vote><vote><vote_number>00002</vote_number></vote></votes></vote_summary>",
  "/roll_call_lists/vote_menu_119_2.xml": "<vote_summary><votes><vote><vote_number>00001</vote_number></vote></votes></vote_summary>",
  "/roll_call_votes/vote1191/vote_119_1_00001.xml": senVote(1, 1, "February 5, 2025, 11:52 AM", "On Passage of the Bill", "H.R.", "10", "Test Bill Ten Act",
    senMember("Alpha", "Test", "CA", "Yea", "S001") + senMember("Beta", "Test", "CA", "Nay", "S002") + senMember("Alpha", "Other", "NV", "Nay", "S099")),
  "/roll_call_votes/vote1191/vote_119_1_00002.xml": senVote(2, 1, "February 6, 2025, 10:00 AM", "On the Cloture Motion", "PN", "55", "Nomination of Test Nominee &amp; Co.",
    senMember("Alpha", "Test", "CA", "Yea", "S001") + senMember("Beta", "Test", "CA", "Not Voting", "S002")),
  "/roll_call_votes/vote1192/vote_119_2_00001.xml": senVote(1, 2, "March 3, 2026, 2:15 PM", "On the Amendment", "S.", "30", "Test Senate Bill Thirty",
    senMember("Alpha", "Test", "CA", "Nay", "S001") + senMember("Beta", "Test", "CA", "Yea", "S002"), "<amendment><amendment_number>S.Amdt. 7</amendment_number></amendment>"),
};

const person = (id, name, family, org, district, cls) => ({
  id: `ocd-person/${id}`,
  name,
  family_name: family,
  party: cls === "state" ? (org === "lower" ? "Party A" : "Party B") : "Party C",
  current_role: { title: org, org_classification: org, district },
  jurisdiction: { classification: cls },
  image: `https://example.org/photos/${id}.jpg`,
  openstates_url: `https://openstates.org/person/${id}/`,
});
const osPeople = [
  person("fake-asm", "Test Assemblymember Delta", "Delta", "lower", "99", "state"),
  person("fake-sen", "Test State Senator Epsilon", "Epsilon", "upper", "98", "state"),
  person("fake-usrep", "Test Representative Gamma", "Gamma", "lower", "77", "country"),
];
const osBill = (identifier, title, votes) => ({
  id: `ocd-bill/${identifier.replace(" ", "")}`,
  identifier,
  title,
  updated_at: "2026-02-01T00:00:00",
  from_organization: { classification: identifier.startsWith("AB") ? "lower" : "upper" },
  openstates_url: `https://openstates.org/ca/bills/20252026/${identifier.replace(" ", "")}/`,
  sources: [{ url: `https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=202520260${identifier.replace(" ", "")}` }],
  votes,
});
const hearingDate = dayFromToday(3).toISOString().slice(0, 10);
const openstates = {
  // FAKE committees and hearings (state hearings step).
  "/committees": {
    results: [
      { id: "ocd-organization/fake-cmte-1", name: "Assembly Committee on Test Matters", memberships: [{ person: { id: "ocd-person/fake-asm" }, role: "member" }], sources: [{ url: "https://example.org/committees/test-matters" }] },
      { id: "ocd-organization/fake-cmte-2", name: "Senate Committee on Other Things", memberships: [{ person: { id: "ocd-person/someone-else" }, role: "member" }] },
    ],
    pagination: { page: 1, max_page: 1 },
  },
  "/events": {
    results: [
      {
        id: "ocd-event/fake-hearing-1",
        name: "Assembly Committee on Test Matters hearing",
        start_date: `${hearingDate}T09:30:00-07:00`,
        status: "tentative",
        location: { name: "1021 O Street, Room 1100" },
        participants: [{ name: "Assembly Committee on Test Matters", entity_type: "organization", organization: { id: "ocd-organization/fake-cmte-1", name: "Assembly Committee on Test Matters" } }],
        links: [{ url: "https://example.org/watch/fake-hearing-1", note: "Watch live video" }],
        sources: [{ url: "https://example.org/hearings/fake-hearing-1" }],
      },
      {
        id: "ocd-event/fake-hearing-2",
        name: "Senate Committee on Other Things hearing",
        start_date: `${hearingDate}T13:30:00-07:00`,
        participants: [{ name: "Senate Committee on Other Things", entity_type: "organization", organization: { id: "ocd-organization/fake-cmte-2" } }],
        sources: [{ url: "https://example.org/hearings/fake-hearing-2" }],
      },
    ],
    pagination: { page: 1, max_page: 1 },
  },
  "/people.geo": { results: osPeople },
  "/people": {
    pagination: { page: 1, max_page: 1 },
    results: [...osPeople.slice(0, 2), person("fake-asm-2", "Test Assemblymember Eta", "Eta", "lower", "12", "state")].map((p) => ({
      ...p,
      links: [{ url: `https://example.org/${p.family_name.toLowerCase()}` }],
      sources: [{ url: `https://example.org/source/${p.family_name.toLowerCase()}` }],
    })),
  },
  "/jurisdictions/ocd-jurisdiction/country:us/state:ca/government": {
    legislative_sessions: [
      { identifier: "20232024", start_date: "2022-12-05", classification: "primary" },
      { identifier: "20252026", start_date: "2024-12-02", classification: "primary" },
    ],
  },
  "/bills?page=1": {
    pagination: { page: 1, max_page: 2 },
    results: [
      osBill("AB 101", "Test Assembly Bill One Oh One", [
        { id: "ocd-vote/1", motion_text: "AB 101 Assembly Third Reading", motion_classification: ["passage"], start_date: "2025-05-20", result: "pass",
          organization: { classification: "lower" }, counts: [{ option: "yes", value: 60 }, { option: "no", value: 15 }, { option: "not voting", value: 5 }],
          votes: [{ option: "yes", voter_name: "Delta", voter: { id: "ocd-person/fake-asm" } }, { option: "no", voter_name: "Eta", voter: { id: "ocd-person/fake-asm-2" } }] },
        { id: "ocd-vote/2", motion_text: "Do pass as amended", motion_classification: [], start_date: "2025-04-01", result: "pass",
          organization: { classification: "committee" }, votes: [{ option: "no", voter_name: "Delta", voter: null }] },
        { id: "ocd-vote/3", motion_text: "AB 101 Senate Third Reading", motion_classification: ["passage"], start_date: "2025-08-30", result: "pass",
          organization: { classification: "upper" }, votes: [{ option: "abstain", voter_name: "Epsilon", voter: null }] },
      ]),
    ],
  },
  "/bills?page=2": {
    pagination: { page: 2, max_page: 2 },
    results: [
      osBill("SB 7", "Test Senate Bill Seven", [
        { id: "ocd-vote/4", motion_text: "SB 7 Senate Third Reading", motion_classification: ["passage"], start_date: "2025-06-02", result: "fail",
          organization: { classification: "upper" }, votes: [{ option: "no", voter_name: "Epsilon", voter: { id: "ocd-person/fake-sen" } }] },
      ]),
      osBill("AB 999", "Bill none of our legislators voted on", [
        { id: "ocd-vote/5", motion_text: "AB 999 Assembly Third Reading", motion_classification: ["passage"], start_date: "2025-06-03", result: "pass",
          organization: { classification: "lower" }, votes: [{ option: "yes", voter_name: "Somebody", voter: { id: "ocd-person/other" } }] },
      ]),
    ],
  },
};

const county = {
  "/data/county-officials.json": {
    officials: [
      { district: "1", name: "Test Supervisor One", source_url: "https://example.org/county/d1", last_verified: "2026-09-01", photo_url: "", party: "" },
      { district: "2", name: "Test Supervisor Two", source_url: "https://example.org/county/d2", last_verified: "2026-09-01" },
      { district: "3", name: "", source_url: "", last_verified: "" },
      { district: "4", name: "Missing Source", source_url: "", last_verified: "2026-09-01" },
      { district: "5", name: "", source_url: "", last_verified: "" },
    ],
  },
};

// ---------------------------------------------------------------------------
// Analysis step: FAKE bill texts, a FAKE CourtListener, and a FAKE Claude API
// that returns canned drafts (two of them deliberately wrong, to check that the
// quote and citation checks catch them).

const BASE = `http://127.0.0.1:${PORT}`;
const textVersion = (file, type = "Introduced in House") => ({
  textVersions: [
    { date: "2025-01-20T05:00:00Z", type: "Introduced in House", formats: [{ type: "Formatted Text", url: `${BASE}/textfiles/old-${file}` }] },
    { date: null, type, formats: [{ type: "PDF", url: `${BASE}/textfiles/${file}.pdf` }, { type: "Formatted Text", url: `${BASE}/textfiles/${file}` }] },
  ],
});
Object.assign(congress, {
  "/bill/119/hr/10/text": textVersion("hr10.htm", "Engrossed in House"),
  "/bill/119/hr/20/text": textVersion("hr20.htm"),
  "/bill/119/s/30/text": textVersion("s30.htm", "Introduced in Senate"),
  "/bill/119/hres/5/text": { textVersions: [] },
  // H.R. 20 is longer than the test's CARD_TEXT_CHARS, so its card is drafted from the condensed text.
  "/bill/119/hr/20/summaries": {
    summaries: [{ actionDate: "2026-03-01", actionDesc: "Introduced in House", updateDate: "2026-03-02T00:00:00Z", text: "<p>This bill requires agencies to accept petitions by mail and online. [FAKE SUMMARY]</p>" }],
  },
  // No CRS summary yet for H.R. 10: the relevance check gets its official title.
  "/bill/119/hr/10/titles": {
    titles: [
      { title: "Test Bill Ten Act", titleType: "Display Title" },
      { title: "To provide grants to States for rural broadband, and for other purposes.", titleType: "Official Title as Introduced" },
    ],
  },
  "/bill/119/hres/5/summaries": {
    summaries: [
      { actionDate: "2025-01-30", actionDesc: "Introduced in House", updateDate: "2025-02-01T00:00:00Z", text: "<p>This resolution sets the rules for considering the Test Bill Ten Act (H.R. 10) in the House.</p>" },
    ],
  },
});
const billHtml = (title, body) =>
  `<html><head><title>${title}</title><style>p{}</style></head><body><pre>${title}\n\nSEC. 1. SHORT TITLE.\n\nThis Act may be cited as the "${title}".\n\n${body}\n\nSEC. 9. EFFECTIVE DATE.\n\nThis Act takes effect 180 days after the date of its enactment. [FAKE TEST TEXT, repeated to look like a bill.] [FAKE TEST TEXT, repeated to look like a bill.]</pre></body></html>`;
const textfiles = {
  "/hr10.htm": billHtml("Test Bill Ten Act", "SEC. 2. GRANTS.\n\nThe Secretary shall award grants to States for rural broadband, on the condition that each State publish its scoring rules."),
  "/old-hr10.htm": billHtml("Test Bill Ten Act (old version)", "OLD TEXT THAT SHOULD NOT BE READ"),
  "/hr20.htm": billHtml("Test Bill Twenty Act of 2026", "SEC. 2. PETITIONS.\n\nEach Federal agency shall accept petitions from the public by mail and online, and respond within 60 days."),
  "/s30.htm": billHtml("Test Senate Bill Thirty", "SEC. 2. WATER GRANTS.\n\nThe Administrator may make grants to local water districts, subject to conditions on public meetings."),
};
const leginfo = {
  "202520260AB101": `<html><body><div id="header">nav</div><span id="version_id">Amended in Assembly</span><div id="bill_all"><p>LEGISLATIVE COUNSEL'S DIGEST</p><p>AB 101, as amended, Test Member. Test Assembly Bill One Oh One. This bill would require counties to post meeting agendas 7 days in advance. [FAKE TEST TEXT]</p><p>The people of the State of California do enact as follows:</p><p>SECTION 1. Section 54954.2 of the Government Code is amended to read: A county shall post each agenda at least 7 days before the meeting, and make it available online. [FAKE TEST TEXT]</p></div><div id="footer">footer</div></body></html>`,
  "202520260SB7": `<html><body><div id="header">nav</div><p>No text available for this version.</p></body></html>`,
};

// CourtListener knows these two real, public citations; everything else is "not found".
const COURT = {
  "514 U.S. 549": { id: 117927, case_name: "United States v. Lopez", absolute_url: "/opinion/117927/united-states-v-lopez/" },
  "5 U.S. 137": { id: 84759, case_name: "Marbury v. Madison", absolute_url: "/opinion/84759/marbury-v-madison/" },
};
function citationLookup(text) {
  const out = [];
  for (const m of text.matchAll(/(\d+) U\.S\. (\d+)/g)) {
    const cite = `${m[1]} U.S. ${m[2]}`;
    const c = COURT[cite];
    out.push({
      citation: cite,
      normalized_citations: [cite],
      start_index: m.index,
      end_index: m.index + m[0].length,
      status: c ? 200 : 404,
      error_message: c ? "" : "Citation not found.",
      clusters: c ? [c] : [],
    });
  }
  return out;
}

// Canned drafts, keyed by bill number. All content is FAKE test content.
const base = {
  aligns: [],
  tension: [],
  departure: [],
  article_v: "Not indicated: nothing in the text changes the structure of government.",
  readings: [],
  citations: [],
  uncertainty: "Uncertain how the grant conditions would be applied in practice; the text leaves that to later rules.",
};
const DRAFTS = {
  "H.R. 10": {
    ...base,
    plain_summary: "The bill creates a federal grant program for rural broadband. States that receive grants must publish the rules they use to score applications. The program is run by a federal Secretary.",
    clauses: [
      { id: "art-1-sec-8-cl-1", quote: "provide for the common Defence and general Welfare of the United States", why: "Grant programs rest on the spending power." },
      { id: "amend-10", quote: "The powers not delegated to the United States by the Constitution, nor prohibited by it to the States, are reserved to the States respectively, or to the people.", why: "Conditions on grants to States raise questions about federal and state roles." },
    ],
    aligns: ["The program spends money for a stated public purpose, which Article I describes as “the common Defence and general Welfare of the United States”."],
    tension: ["Could the condition that States publish scoring rules be read as directing how States run their own programs?"],
    departure: ["Publishing scoring rules may help residents see how funding decisions are made."],
    readings: [
      {
        question: "May Congress attach conditions to grants to States?",
        original_meaning: "This reading asks what the spending power was understood to cover when it was adopted, and whether conditions of this kind fit that understanding.",
        precedent: "This reading looks at how courts have treated grant conditions before, including limits on federal power described in United States v. Lopez.",
        evolving: "This reading asks how the federal and state roles in funding programs have changed over time, and how the condition fits current practice.",
      },
    ],
    citations: [{ case_name: "United States v. Lopez", citation: "514 U.S. 549 (1995)", point: "Limits on federal power under Article I." }],
  },
  // WRONG QUOTES: the clause quote and a quote in the prose don't match the Constitution.
  "H.R. 20": {
    ...base,
    plain_summary: "The bill requires federal agencies to accept petitions from the public by mail and online. Agencies must respond within 60 days.",
    clauses: [{ id: "amend-1", quote: "Congress shall make no law abridging the right of the people to petition the Government", why: "The bill concerns petitions to the government." }],
    aligns: ['The bill builds on the right "to peaceably assemble and to petition the government for a redress of their grievances".'],
    tension: ["Could a fixed 60-day deadline conflict with how some agencies handle large volumes of petitions?"],
  },
  // MADE-UP CASE: "Harrington v. Calaveras Water District" doesn't exist, and
  // "Smith v. Jones" is attached to a real citation that belongs to another case.
  "S. 30": {
    ...base,
    plain_summary: "The bill allows grants to local water districts. Districts that accept grants must follow conditions on holding public meetings.",
    clauses: [{ id: "art-1-sec-8-cl-1", quote: "To lay and collect Taxes, Duties, Imposts and Excises", why: "The spending power covers grants." }],
    aligns: ["The grants fund a public service. The conditions concern open meetings."],
    tension: [
      "In Harrington v. Calaveras Water District, 612 U.S. 118 (2024), the Court upheld meeting conditions on water grants. Could the conditions reach beyond what the grant pays for?",
      "Smith v. Jones is sometimes read to limit conditions of this kind.",
    ],
    citations: [
      { case_name: "Harrington v. Calaveras Water District", citation: "612 U.S. 118 (2024)", point: "Grant conditions on water districts." },
      { case_name: "Smith v. Jones", citation: "5 U.S. 137 (1803)", point: "Limits on conditions." },
    ],
  },
  "H.Res. 5": {
    ...base,
    plain_summary: "The resolution sets the rules the House will use to consider the Test Bill Ten Act. It does not change the law itself.",
    clauses: [{ id: "art-1-sec-5-cl-2", quote: "Each House may determine the Rules of its Proceedings", why: "The resolution is a House rule for one bill." }],
    aligns: ["Each chamber sets its own procedural rules."],
    uncertainty: "Uncertain: only the official summary was available, so the specific terms of the rule could not be reviewed.",
  },
  "AB 101": {
    ...base,
    plain_summary: "The bill requires counties to post meeting agendas 7 days in advance and to make them available online.",
    clauses: [{ id: "amend-1", quote: "the right of the people peaceably to assemble, and to petition the Government for a redress of grievances", why: "Advance notice of meetings relates to the public's ability to take part." }],
    aligns: ["Advance agendas give residents time to prepare comments."],
    tension: ["Could a 7-day rule make it harder for counties to respond to urgent matters?"],
    departure: [],
  },
};

function sse(res, events) {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  for (const e of events) res.write(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  res.end();
}
// Canned agenda-watch drafts (FAKE). The Board one states a number the agenda
// doesn't ("36 months"), which the number check must remove.
const AGENDA_DRAFTS = {
  "Board of Supervisors": {
    items: [
      { item_key: "1", summary: "The Board would meet in closed session with its lawyers about a pending case named on the agenda.", impact: "low", flags: [] },
      { item_key: "2", summary: "The Board would approve a road repair contract with Example Paving Co. The contract may not exceed $250,000. It would run for 36 months.", impact: "medium", flags: ["budget"] },
      { item_key: "3", summary: "The Board would adopt a resolution setting fees for a permit program. The agenda doesn't list the new amounts.", impact: "high", flags: ["fees_taxes"] },
      { item_key: "4", summary: "Staff would report on the budget for fiscal year 2026-27, and the Board would give direction.", impact: "medium", flags: ["budget"] },
      { item_key: "5", summary: "The Board would discuss changing the time limit for public comment at its meetings.", impact: "medium", flags: ["public_access"] },
    ],
    issue_links: [{ item_key: "5", issue_slug: "public-comment-limit", reason: "Both concern the time limit for public comment at Board meetings." }],
  },
  "Planning Commission": {
    items: [
      { item_key: "1", summary: "The Commission would hold a public hearing on a permit for a gravel yard and decide whether it is exempt from CEQA review.", impact: "high", flags: ["land_use"] },
      { item_key: "2", summary: "The Commission would consider changing zoning text for accessory dwellings.", impact: "medium", flags: ["land_use"] },
    ],
    issue_links: [],
  },
};

function agendaAnthropic(req, res, body) {
  const problems = [];
  if (req.headers["x-api-key"] !== "fake-anthropic-key") problems.push("x-api-key");
  if (body.model !== "claude-sonnet-5-5") problems.push("model");
  if (!body.stream || body.fallbacks !== "default") problems.push("stream/fallbacks");
  if (!body.output_config || !body.output_config.format || body.output_config.format.type !== "json_schema") problems.push("output_config.format");
  anthropicRequests.push({ kind: "agenda", problems });
  if (problems.length) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `fixture: bad ${problems.join(", ")}` } });
  const msg = body.messages[0].content;
  const body_ = Object.keys(AGENDA_DRAFTS).find((b) => msg.startsWith(b));
  const text = JSON.stringify(AGENDA_DRAFTS[body_] || { items: [], issue_links: [] });
  sse(res, [
    { type: "message_start", message: { id: "msg_agenda", type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 2100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 900 } },
    { type: "message_stop" },
  ]);
}

// FAKE relevance check (claude-haiku-4-5): skips by keywords in the title,
// rates local relevance by keywords too. Checks the request's shape.
function relevanceAnthropic(req, res, body) {
  const problems = [];
  if (req.headers["x-api-key"] !== "fake-anthropic-key") problems.push("x-api-key");
  if (body.model !== "claude-haiku-4-5-20251001") problems.push("model");
  if (body.thinking) problems.push("thinking (Haiku 4.5 has no adaptive thinking)");
  if (!body.output_config || !body.output_config.format || body.output_config.format.type !== "json_schema") problems.push("output_config.format");
  // How many bills came with an official description (the CRS summary, official title or digest).
  const described = (body.messages[0].content.match(/^    (?!No official description)/gm) || []).length;
  anthropicRequests.push({ kind: "relevance", problems, described });
  if (problems.length) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `fixture: bad ${problems.join(", ")}` } });
  const bills = body.messages[0].content
    .split("\n")
    .filter((l) => / \| /.test(l) && !/^Bills,/.test(l))
    .map((l) => {
      const [id, number, , title] = l.split(" | ");
      const cat = /Postal Service|designate the facility/i.test(title) ? "naming" : /Providing for consideration/i.test(title) ? "procedural_rule" : "substantive";
      const local = /Assembly|Senate Bill|county|rural|water/i.test(`${number} ${title}`) ? "high" : /Thirty/.test(title) ? "medium" : "low";
      return {
        bill_id: id,
        verdict: cat === "substantive" ? "analyze" : "skip",
        category: cat,
        reason: cat === "naming" ? "It names a post office and changes no policy." : cat === "procedural_rule" ? "It only sets how the House will debate another bill." : "It changes a program or rule.",
        local,
        local_reason: local === "high" ? "It is about California or local government." : "It applies nationally.",
      };
    });
  return sseText(res, "claude-haiku-4-5-20251001", JSON.stringify({ bills }), 300 + bills.length * 40, 60 * bills.length);
}

// FAKE AI reviewer: flags H.R. 20 (its summary leaves out the petition
// deadline's exceptions, say), passes everything else.
function reviewAnthropic(req, res, body) {
  const problems = [];
  if (body.model !== "claude-sonnet-5-5") problems.push("model");
  if (!body.thinking || body.thinking.type !== "adaptive") problems.push("thinking");
  if (!body.output_config || body.output_config.effort !== "medium") problems.push("effort");
  if (!/<draft>/.test(body.messages[0].content)) problems.push("draft");
  anthropicRequests.push({ kind: "review", problems });
  if (problems.length) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `fixture: bad ${problems.join(", ")}` } });
  const bill = (body.messages[0].content.match(/^Bill: (.+?) \(/m) || [])[1];
  const ok = (id) => ({ id, ok: true, note: "No problem found." });
  // The revision (see the drafter below) adds the extension, which clears the flag.
  const flag = bill === "H.R. 20" && !/extend the deadline once/.test(body.messages[0].content);
  const out = {
    checks: [
      flag ? { id: "summary", ok: false, note: "The summary says agencies must respond within 60 days but leaves out that the text lets them extend it once." } : ok("summary"),
      ok("balance"),
      ok("language"),
      ok("provisions"),
      flag ? { id: "certainty", ok: false, note: "The tension panel treats the 60-day deadline as settled when the text allows an extension." } : ok("certainty"),
    ],
    verdict: flag ? "flag" : "pass",
  };
  return sseText(res, "claude-sonnet-5-5", JSON.stringify(out), 5000, 700);
}

function sseText(res, model, text, inTokens, outTokens) {
  sse(res, [
    { type: "message_start", message: { id: "msg_fixture", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: inTokens, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: outTokens } },
    { type: "message_stop" },
  ]);
}

/** A card in the card schema's shape, from the canned full draft. */
function asCard(d) {
  return {
    plain_summary: d.plain_summary,
    clauses: d.clauses,
    aligns: d.aligns[0] || "",
    tension: d.tension[0] || "",
    departure: d.departure[0] || "",
    readings: d.readings,
    citations: d.citations,
  };
}

const anthropicRequests = [];
function anthropic(req, res, body) {
  if (/Agenda items, as \[item number\]/.test((body.messages && body.messages[0] && body.messages[0].content) || "")) return agendaAnthropic(req, res, body);
  if (String(body.model || "").startsWith("claude-haiku")) return relevanceAnthropic(req, res, body);
  if (/^You are the independent reviewer/.test((body.system && body.system[0] && body.system[0].text) || "")) return reviewAnthropic(req, res, body);
  const problems = [];
  if (req.headers["x-api-key"] !== "fake-anthropic-key") problems.push("x-api-key");
  if (!String(req.headers["anthropic-beta"] || "").includes("server-side-fallback-2026-07-01")) problems.push("anthropic-beta");
  if (body.model !== "claude-sonnet-5-5") problems.push("model");
  if (!body.stream) problems.push("stream");
  if (body.fallbacks !== "default") problems.push("fallbacks");
  if (!body.output_config || !body.output_config.format || body.output_config.format.type !== "json_schema") problems.push("output_config.format");
  if (!body.system || !body.system[1] || !body.system[1].cache_control) problems.push("system cache_control");
  if (!/\[amend-27\]/.test(body.system && body.system[1] && body.system[1].text)) problems.push("constitution block");
  const card = /(Draft|Revise) the short card\.$/.test(body.messages[0].content);
  const revision = /<reviewer_problems>/.test(body.messages[0].content);
  if (card && body.output_config.format.schema.properties.aligns.type !== "string") problems.push("card schema");
  anthropicRequests.push({ kind: revision ? "revision" : card ? "card" : "full", problems, model: body.model, effort: body.output_config && body.output_config.effort, bytes: JSON.stringify(body).length });
  if (problems.length) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `fixture: bad ${problems.join(", ")}` } });
  const msg = body.messages[0].content;
  const bill = (msg.match(/^Bill: (.+?) \(/m) || [])[1];
  const draft = DRAFTS[bill];
  if (!draft) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: `fixture: no draft for ${bill}` } });
  if (bill === "H.R. 10" && /OLD TEXT/.test(msg)) return send(res, 400, { type: "error", error: { type: "invalid_request_error", message: "fixture: sent the old text version" } });
  // A revision of H.R. 20 fixes what the fake reviewer flagged.
  const fixed = revision && bill === "H.R. 20" ? { ...draft, plain_summary: `${draft.plain_summary} An agency may extend the deadline once.` } : draft;
  const text = JSON.stringify(card ? asCard(fixed) : fixed);
  const cacheRead = anthropicRequests.length > 1 ? 18000 : 0;
  sse(res, [
    { type: "message_start", message: { id: `msg_test_${anthropicRequests.length}`, type: "message", role: "assistant", model: "claude-sonnet-5-5", content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 900 + Math.round(msg.length / 4), output_tokens: 1, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheRead ? 0 : 18000 } } },
    { type: "content_block_start", index: 0, content_block: { type: "thinking", thinking: "", signature: "" } },
    { type: "content_block_delta", index: 0, delta: { type: "signature_delta", signature: "fake-signature" } },
    { type: "content_block_stop", index: 0 },
    { type: "content_block_start", index: 1, content_block: { type: "text", text: "" } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(0, 200) } },
    { type: "content_block_delta", index: 1, delta: { type: "text_delta", text: text.slice(200) } },
    { type: "content_block_stop", index: 1 },
    { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1500 + Math.round(text.length / 4) } },
    { type: "message_stop" },
  ]);
}

function readBody(req) {
  return new Promise((resolve) => {
    let d = "";
    req.on("data", (c) => (d += c));
    req.on("end", () => resolve(d));
  });
}

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http
  .createServer(async (req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const [, api, ...rest] = u.pathname.split("/");
    const path = "/" + rest.join("/");
    hits[api] = (hits[api] || 0) + 1;
    if (u.pathname === "/__hits") return send(res, 200, hits);
    // FAKE Turnstile siteverify: any token passes except "bad".
    if (u.pathname === "/turnstile/siteverify" && req.method === "POST") {
      const raw = await readBody(req);
      return send(res, 200, { success: !/name="response"\r?\n\r?\nbad\r?\n/.test(raw) && !/response=bad(&|$)/.test(raw) });
    }
    if (u.pathname === "/__anthropic") return send(res, 200, anthropicRequests);
    if (api === "anthropic" && path === "/v1/messages" && req.method === "POST") return anthropic(req, res, JSON.parse(await readBody(req)));
    if (api === "iqm2") {
      // FAKE county meeting portal.
      if (path === "/Citizens/calendar.aspx") return send(res, 200, calendarHtml(), "text/html");
      if (path === "/Services/RSS.aspx") return send(res, 200, rssHtml(), "text/html");
      if (path === "/Citizens/Detail_Meeting.aspx") {
        const html = meetingHtml(u.searchParams.get("ID"));
        return html ? send(res, 200, html, "text/html") : send(res, 404, "not found", "text/plain");
      }
      if (path === "/Citizens/FileOpen.aspx") {
        const lines = agendaLines(u.searchParams.get("ID"));
        if (!lines) return send(res, 404, "not found", "text/plain");
        res.writeHead(200, { "Content-Type": "application/pdf" });
        return res.end(Buffer.from(makePdf(lines)));
      }
      return send(res, 404, "not found", "text/plain");
    }
    // FAKE FEC API, member ID crosswalk, and lda.gov.
    if (api === "fec") {
      const r = fecFixture(path.replace(/^\/v1/, ""), u.searchParams);
      return r ? send(res, r.status, r.body) : send(res, 404, { message: "fixture: no FEC route" });
    }
    if (api === "legislators") return send(res, 200, path === "/executive.json" ? executive : legislators);
    // FAKE executive branch sources.
    if (api === "whitehouse") return send(res, 200, cabinetHtml, "text/html");
    if (api === "fr" && path === "/api/v1/documents.json") return send(res, 200, fr(u.searchParams));
    if (api === "govca") {
      if (path === "/category/executive-orders/feed/") return send(res, 200, govFeed(parseInt(u.searchParams.get("paged") || "1", 10)), "application/rss+xml");
      const post = govPosts[path.split("/").filter(Boolean).pop()];
      return post ? send(res, 200, post, "text/html") : send(res, 404, "not found", "text/plain");
    }
    if (api === "lda") {
      const r = ldaFixture(path.replace(/^\/api\/v1/, ""), u.searchParams);
      return r ? send(res, r.status, r.body) : send(res, 404, { detail: "Not found." });
    }
    if (api === "tylermm") {
      // FAKE Tyler Meeting Manager API.
      if (path === "/meetingInformation/getMeetingInformationByDate" && req.method === "POST") {
        const list = meetingList(JSON.parse((await readBody(req)) || "{}"));
        return list ? send(res, 200, list) : send(res, 500, { message: "Internal Server Error" });
      }
      const a = /^\/meetingInformation\/Agenda\/(true|false)\/(\d+)$/.exec(path);
      if (a && req.method === "GET") {
        const pages = agendaPages(a[2], a[1] === "true");
        if (!pages) return send(res, 404, { message: "Not Found" });
        res.writeHead(200, { "Content-Type": "application/pdf" }); // the real server sends no Content-Length
        return res.end(Buffer.from(makePdf(pages)));
      }
      return send(res, 404, { message: "Not Found" });
    }
    if (api === "textfiles") return textfiles[path] ? send(res, 200, textfiles[path], "text/html") : send(res, 404, "not found", "text/plain");
    if (api === "leginfo") {
      const id = u.searchParams.get("bill_id");
      if (path === "/faces/billHistoryClient.xhtml") return leginfoHistory[id] ? send(res, 200, leginfoHistory[id], "text/html") : send(res, 200, "<html><body><table id=\"billhistory\"><tbody></tbody></table></body></html>", "text/html");
      return leginfo[id] ? send(res, 200, leginfo[id], "text/html") : send(res, 404, "not found", "text/plain");
    }
    if (api === "courtlistener" && path === "/api/rest/v4/citation-lookup/" && req.method === "POST") {
      if (req.headers.authorization !== "Token fake-courtlistener-token") return send(res, 401, { detail: "no token" });
      return send(res, 200, citationLookup(new URLSearchParams(await readBody(req)).get("text") || ""));
    }
    // FAKE Census Geocoder: one known address, in the fixtures' districts.
    if (api === "census") {
      const address = String(u.searchParams.get("address") || "");
      const g = (name, extra) => [{ STATE: "06", ...extra, NAME: name }];
      const match = /test street/i.test(address)
        ? [{ matchedAddress: "NOT RETURNED TO THE BROWSER", geographies: {
            "119th Congressional Districts": g("Congressional District 77", { GEOID: "0677", BASENAME: "77" }),
            "2024 State Legislative Districts - Upper": g("State Senate District 98", { GEOID: "06098", BASENAME: "98" }),
            "2024 State Legislative Districts - Lower": g("Assembly District 99", { GEOID: "06099", BASENAME: "99" }),
            Counties: g("Calaveras County", { GEOID: "06009", BASENAME: "Calaveras" }),
          } }]
        : [];
      return send(res, 200, { result: { addressMatches: match } });
    }
    if (api === "congress") {
      if (!u.searchParams.get("api_key")) return send(res, 403, { error: "no key" });
      const c = congress[path] || congressExec[path];
      return c ? send(res, 200, c) : send(res, 404, { error: `no fixture for ${path}` });
    }
    if (api === "openstates") {
      if (!req.headers["x-api-key"]) return send(res, 403, { error: "no key" });
      const key = path === "/bills" ? `/bills?page=${u.searchParams.get("page")}` : path;
      return openstates[key] ? send(res, 200, openstates[key]) : send(res, 404, { error: `no fixture for ${key}` });
    }
    if (api === "senate") return senate[path] ? send(res, 200, senate[path], "application/xml") : send(res, 404, "not found", "text/plain");
    if (api === "site") {
      if (path === "/data/state-executive-officials.json") return send(res, 200, stateExecutiveFile);
      return county[path] ? send(res, 200, county[path]) : send(res, 404, { error: "no" });
    }
    send(res, 404, { error: "unknown api" });
  })
  .listen(PORT, () => console.log(`fixtures on http://127.0.0.1:${PORT}`));
