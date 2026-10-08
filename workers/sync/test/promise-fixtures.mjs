// FAKE sources and a FAKE drafter for the promises step (src/promises/).
// Every name, quote and number here is invented.

const WH = "http://127.0.0.1:8788/whitehouse/";
const GOVCA = "http://127.0.0.1:8788/govca/";

const item = (link, title, date, html) => `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate><category><![CDATA[Releases]]></category><content:encoded><![CDATA[${html}]]></content:encoded></item>`;
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Fake</title>${items.join("")}</channel></rss>`;

export function whiteHouseFeed(kind) {
  if (kind === "remarks") {
    return rss([item(`${WH}remarks/2025/01/the-inaugural-address/`, "The Inaugural Address", "Mon, 20 Jan 2025 17:00:00 +0000",
      "<p>FAKE-PROMISE-DOC-INAUGURAL. My fellow citizens, thank you.</p><p>I believe in the promise of this country.</p>")]);
  }
  return rss([
    item(`${WH}releases/2026/10/fake-clinics/`, "FAKE: The President Announces a Veterans Clinic Plan", "Mon, 05 Oct 2026 15:00:00 +0000",
      "<p>FAKE-PROMISE-DOC-1. Today the President spoke in Testville.</p><p>&#8220;We will open three new veterans clinics in Ohio by the end of 2027,&#8221; the President said.</p><p>&#8220;I believe in strong families and safe streets for every American.&#8221;</p>"),
    item(`${WH}releases/2026/10/fake-appointments/`, "FAKE: President Announces Appointments", "Sun, 04 Oct 2026 15:00:00 +0000", "<p>A list of names.</p>"),
    item("https://example.org/not-the-white-house/", "FAKE: Elsewhere", "Sat, 03 Oct 2026 15:00:00 +0000", "<p>Not an official page.</p>"),
  ]);
}

export function govcaPosts() {
  return [
    {
      id: 1, date: "2026-10-02T08:00:00", link: `${GOVCA}2026/10/02/fake-libraries/`,
      title: { rendered: "FAKE: Governor announces rural library grants" },
      content: { rendered: "[et_pb_section][et_pb_text]<p>FAKE-PROMISE-DOC-GOV. SACRAMENTO &#8211; The state will award $25 million in grants to 40 rural libraries by June 30, 2027.</p><p>Last month the Governor signed a law requiring every county to publish its water use data online, starting next year.</p><p>We are proud of our libraries.</p>[/et_pb_text][/et_pb_section]" },
    },
    {
      id: 2, date: "2026-10-01T08:00:00", link: `${GOVCA}2026/10/01/fake-appointments/`,
      title: { rendered: "FAKE: Governor Newsom announces appointments" },
      content: { rendered: "<p>Names.</p>" },
    },
  ];
}

// The WordPress search for "State of the State": the address, and a press release that only mentions it.
export function govcaStateOfTheState() {
  return [
    {
      id: 3, date: "2026-01-08T10:00:00", link: `${GOVCA}2026/01/08/fake-state-of-the-state/`,
      title: { rendered: "FAKE: Governor delivers 2026 State of the State address" },
      content: { rendered: "<p>FAKE-PROMISE-DOC-SOTS. This year I will sign a law requiring every county to publish its water use data online by January 1, 2027.</p>" },
    },
    {
      id: 4, date: "2026-01-09T10:00:00", link: `${GOVCA}2026/01/09/fake-reactions/`,
      title: { rendered: "FAKE: What they're saying about the State of the State" },
      content: { rendered: "<p>Quotes from others.</p>" },
    },
  ];
}

// A campaign "Issues" page (listed by a person on /admin/review/promise/pages/): a slogan, a position and one commitment.
export const campaignIssuesPage = () =>
  `<html><body><nav>Home Donate Volunteer</nav><main><h1>Issues</h1><p>FAKE-PROMISE-DOC-ISSUES.</p>
<h2>Roads</h2><p>Roads matter to every family.</p><p>As Governor I will repave Route 4 between Murphys and Arnold by the end of 2027.</p>
<h2>Water</h2><p>I believe in clean water for everyone.</p>
<h2>Libraries</h2><p>The rural library grant program was canceled in the revised state budget.</p></main><footer>Paid for by a fake committee</footer></body></html>`;

export function govinfoCollection() {
  return {
    count: 2, nextPage: null,
    packages: [
      { packageId: "DCPD-FAKE00001", dateIssued: "2026-02-24", title: "Address Before a Joint Session of the Congress on the State of the Union" },
      { packageId: "DCPD-FAKE00002", dateIssued: "2026-02-25", title: "Remarks at a Fake Event" },
    ],
  };
}

export const govinfoHtm = () =>
  "<html><head><style>p{color:black}</style></head><body><p>FAKE-PROMISE-DOC-SOTU. Mr. Speaker.</p><p>Tonight I am asking Congress to pass the Fake Highways Act, and I will sign it the day it reaches my desk.</p></body></html>";

// The tracked promises listed in the reader's message: [{ id, quote }].
const tracked = (message) => [...message.matchAll(/^- id (\d+) \([^)]*\): "(.*)"$/gm)].map((m) => ({ id: +m[1], quote: m[2] }));

// What the FAKE drafter answers for each document: some candidates pass the
// checks; others are built to be dropped (misquoted, a value, a general aim,
// loaded wording). Status updates: Kept for the water law (recorded at once),
// Broken for the library grants (sent for review), and one misquoted (dropped).
export function promiseDraft(message) {
  const speaker = (/^- ([^,\n]+),/m.exec(message) || [])[1] || "Nobody";
  const open = tracked(message);
  const find = (word) => open.find((p) => p.quote.includes(word));
  if (message.includes("FAKE-PROMISE-DOC-1")) {
    return { promises: [
      { speaker, quote: "We will open three new veterans clinics in Ohio by the end of 2027", check_note: "Three new veterans clinics open in Ohio.", due: "by the end of 2027" },
      { speaker, quote: "We will open four new veterans clinics in Ohio by the end of 2027", check_note: "Four clinics open.", due: "" },
      { speaker, quote: "I believe in strong families and safe streets for every American.", check_note: "Families are strong.", due: "" },
    ] };
  }
  if (message.includes("FAKE-PROMISE-DOC-GOV")) {
    return { promises: [
      { speaker, quote: "The state will award $25 million in grants to 40 rural libraries by June 30, 2027.", check_note: "Grant awards totaling $25 million to 40 rural libraries.", due: "by June 30, 2027" },
      { speaker, quote: "We will always fight for every library in California.", check_note: "Libraries are supported.", due: "" },
    ], status_updates: [
      ...(find("water use") ? [{ promise_id: find("water use").id, to_status: "kept", evidence_quote: "Last month the Governor signed a law requiring every county to publish its water use data online", evidence_note: "A law requiring counties to publish water use data online was signed." }] : []),
      ...(find("water use") ? [{ promise_id: find("water use").id, to_status: "in_progress", evidence_quote: "The Governor proposed a water bill", evidence_note: "A second update for the same promise." }] : []),
    ] };
  }
  // "In their own words": the passage summing up the page, word for word.
  if (message.startsWith("Pick an excerpt.")) {
    return { excerpt: message.includes("FAKE-PROMISE-DOC-ISSUES") ? "As Governor I will repave Route 4 between Murphys and Arnold by the end of 2027." : "" };
  }
  if (message.includes("FAKE-PROMISE-DOC-ISSUES")) {
    return { promises: [
      { speaker, quote: "As Governor I will repave Route 4 between Murphys and Arnold by the end of 2027.", check_note: "Completed repaving of Route 4 between Murphys and Arnold.", due: "by the end of 2027" },
      { speaker, quote: "Roads matter to every family.", check_note: "Roads are better.", due: "" },
    ], status_updates: [
      ...(find("rural libraries") ? [{ promise_id: find("rural libraries").id, to_status: "broken", evidence_quote: "The rural library grant program was canceled in the revised state budget.", evidence_note: "The revised budget canceled the grant program." }] : []),
      { promise_id: 99999, to_status: "kept", evidence_quote: "Roads matter to every family.", evidence_note: "Not a tracked promise." },
    ] };
  }
  if (message.includes("FAKE-PROMISE-DOC-SOTS")) {
    return { promises: [
      { speaker, quote: "This year I will sign a law requiring every county to publish its water use data online by January 1, 2027.", check_note: "A signed law requiring counties to publish water use data online.", due: "by January 1, 2027" },
    ] };
  }
  if (message.includes("FAKE-PROMISE-DOC-SOTU")) {
    return { promises: [
      { speaker, quote: "I will sign it the day it reaches my desk", check_note: "A historic signature on the Fake Highways Act.", due: "" },
    ] };
  }
  return { promises: [] };
}
