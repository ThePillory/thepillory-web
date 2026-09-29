// FAKE upstream APIs for local testing only. Every name and number here is
// invented ("Test Senator Alpha", bill "H.R. 10", …). Nothing in this file is
// real data and none of it is ever loaded into production.
//
// Mimics the response shapes of Congress.gov v3, Open States v3, and the
// senate.gov roll call XML closely enough to exercise the sync end to end.
import http from "node:http";

const PORT = parseInt(process.env.FIXTURE_PORT || "8788", 10);
const hits = {};

const member = (id, name, last, chamber, district, party) => ({
  bioguideId: id,
  name: `${last}, ${name.split(" ")[0]}`,
  partyName: party,
  state: "California",
  district,
  terms: { item: [{ chamber, startYear: 2023 }] },
  depiction: { imageUrl: `https://example.org/photos/${id}.jpg`, attribution: "Fixture photo" },
});

const congress = {
  "/member/CA": {
    members: [
      member("T000001", "Test Senator Alpha", "Alpha", "Senate", undefined, "Party A"),
      member("T000002", "Test Senator Beta", "Beta", "Senate", undefined, "Party B"),
      member("T000003", "Test Representative Gamma", "Gamma", "House of Representatives", 77, "Party C"),
      member("T000004", "Test Representative Other", "Other", "House of Representatives", 12, "Party A"),
    ],
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
  "/house-vote/119/2": { houseRollCallVotes: [{ congress: 119, sessionNumber: 2, rollCallNumber: 4 }] },
  "/house-vote/119/1/1": { houseRollCallVote: { voteQuestion: "On Passage", legislationType: "HR", legislationNumber: "10", result: "Passed", startDate: "2025-02-01T15:00:00-05:00", sourceDataURL: "https://clerk.house.gov/evs/2025/roll1.xml" } },
  "/house-vote/119/1/2": { houseRollCallVote: { voteQuestion: "On Motion to Recommit", legislationType: "HR", legislationNumber: "10", result: "Failed", startDate: "2025-02-01T14:00:00-05:00" } },
  "/house-vote/119/1/3": { houseRollCallVote: { voteQuestion: "On Agreeing to the Resolution", legislationType: "HRES", legislationNumber: "5", result: "Passed", startDate: "2025-01-31T12:00:00-05:00" } },
  "/house-vote/119/2/4": { houseRollCallVote: { voteQuestion: "On Motion to Suspend the Rules and Pass", legislationType: "HR", legislationNumber: "20", result: "Passed", startDate: "2026-03-10T12:00:00-04:00" } },
  "/house-vote/119/1/1/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Yea" }, { bioguideID: "T000004", voteCast: "Nay" }] } },
  "/house-vote/119/1/2/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Nay" }] } },
  "/house-vote/119/1/3/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Aye" }] } },
  "/house-vote/119/2/4/members": { houseRollCallVoteMemberVotes: { results: [{ bioguideID: "T000003", voteCast: "Not Voting" }] } },
  "/bill/119/hr/10": { bill: { title: "Test Bill Ten Act" } },
  "/bill/119/hres/5": { bill: { title: "Providing for consideration of the bill (H.R. 10) to test things" } },
  "/bill/119/hr/20": { bill: { title: "Test Bill Twenty Act of 2026 ($1 test)" } },
};

const senMember = (last, first, state, cast, lis) =>
  `<member><member_full>${last} (X-${state})</member_full><last_name>${last}</last_name><first_name>${first}</first_name><party>X</party><state>${state}</state><vote_cast>${cast}</vote_cast><lis_member_id>${lis}</lis_member_id></member>`;
const senVote = (n, s, date, question, docType, docNumber, title, members, extra = "") =>
  `<?xml version="1.0" encoding="UTF-8"?><roll_call_vote><congress>119</congress><session>${s}</session><vote_number>${n}</vote_number><vote_date>${date}</vote_date><question>${question}</question><vote_result>Passed</vote_result><document><document_congress>119</document_congress><document_type>${docType}</document_type><document_number>${docNumber}</document_number><document_title>${title}</document_title></document>${extra}<vote_document_text>${title}</vote_document_text><members>${members}</members></roll_call_vote>`;
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
const openstates = {
  "/people.geo": { results: osPeople },
  "/people": {
    results: osPeople.slice(0, 2).map((p) => ({
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
          organization: { classification: "lower" }, votes: [{ option: "yes", voter_name: "Delta", voter: { id: "ocd-person/fake-asm" } }] },
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

function send(res, status, body, type = "application/json") {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
}

http
  .createServer((req, res) => {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const [, api, ...rest] = u.pathname.split("/");
    const path = "/" + rest.join("/");
    hits[api] = (hits[api] || 0) + 1;
    if (u.pathname === "/__hits") return send(res, 200, hits);
    if (api === "congress") {
      if (!u.searchParams.get("api_key")) return send(res, 403, { error: "no key" });
      return congress[path] ? send(res, 200, congress[path]) : send(res, 404, { error: `no fixture for ${path}` });
    }
    if (api === "openstates") {
      if (!req.headers["x-api-key"]) return send(res, 403, { error: "no key" });
      const key = path === "/bills" ? `/bills?page=${u.searchParams.get("page")}` : path;
      return openstates[key] ? send(res, 200, openstates[key]) : send(res, 404, { error: `no fixture for ${key}` });
    }
    if (api === "senate") return senate[path] ? send(res, 200, senate[path], "application/xml") : send(res, 404, "not found", "text/plain");
    if (api === "site") return county[path] ? send(res, 200, county[path]) : send(res, 404, { error: "no" });
    send(res, 404, { error: "unknown api" });
  })
  .listen(PORT, () => console.log(`fixtures on http://127.0.0.1:${PORT}`));
