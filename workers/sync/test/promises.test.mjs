// node workers/sync/test/promises.test.mjs
// Promises: the checks every AI candidate must pass, the source parsers, and
// the reading order. Every name and quote here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, quoteKey, notACommitment, wordingProblems, checkCandidate, normalizeText } from "../src/promises/check.js";
import { htmlToText, parseRssWithContent, parseWpPosts, addressPackages, whiteHouseKind, worthReading, roundRobin, commitmentScore, commitmentSentences } from "../src/promises/sources.js";
import { schema } from "../src/promises/prompt.js";
import { whiteHouseFeed, govcaPosts, govinfoCollection } from "./promise-fixtures.mjs";

const DOC = "Today the Governor spoke. “We will open three new veterans clinics in Ohio by the end of 2027,” she said. I believe in strong families.";

test("the quote must be in the source word for word (only spacing, curly quotes and dashes may differ)", () => {
  assert.equal(findQuote(DOC, "We will open three new veterans clinics in Ohio by the end of 2027"), "We will open three new veterans clinics in Ohio by the end of 2027");
  assert.equal(findQuote(DOC, "“We will open three new veterans clinics in Ohio by the end of 2027,”"), "We will open three new veterans clinics in Ohio by the end of 2027", "outer quotation marks and the trailing comma are trimmed");
  assert.equal(findQuote(DOC, "We will open  three new\nveterans clinics in Ohio by the end of 2027"), "We will open three new veterans clinics in Ohio by the end of 2027");
  assert.equal(findQuote(DOC, "We will open four new veterans clinics in Ohio by the end of 2027"), null);
  assert.equal(findQuote(DOC, "We will open"), null, "too short to be a commitment");
  assert.equal(normalizeText("a – b ’c’"), "a - b 'c'");
  assert.equal(quoteKey("We will, open!"), quoteKey("we will open"));
});

test("a commitment, not a value or position", () => {
  assert.equal(notACommitment("We will open three new veterans clinics in Ohio by the end of 2027"), null);
  assert.equal(notACommitment("The state will award $25 million in grants to 40 rural libraries."), null);
  assert.match(notACommitment("I believe in strong families and safe streets for every American."), /values/);
  assert.match(notACommitment("Our economy is the strongest it has ever been in history."), /no commitment/);
});

test("the wording ThePillory adds is neutral", () => {
  assert.deepEqual(wordingProblems("Three new veterans clinics open in Ohio."), []);
  assert.ok(wordingProblems("A historic signature on the act.").length);
  assert.ok(wordingProblems("He vowed to open clinics").length);
  assert.ok(wordingProblems("Clinics finally open!").length);
  // A person's evidence may say what happened plainly.
  assert.deepEqual(wordingProblems("The bill failed to pass the Senate; only 40 senators voted for it.", { strict: false }), []);
  assert.ok(wordingProblems("The Governor betrayed voters.", { strict: false }).length);
});

test("checkCandidate: passes, and each way it's dropped", () => {
  const ok = checkCandidate({ quote: "We will open three new veterans clinics in Ohio by the end of 2027", check_note: "Three new veterans clinics open in Ohio.", due: "by the end of 2027" }, DOC);
  assert.equal(ok.ok, true);
  assert.equal(ok.due, "by the end of 2027");
  // A deadline the quote doesn't state is dropped, not invented.
  assert.equal(checkCandidate({ quote: "We will open three new veterans clinics in Ohio by the end of 2027", check_note: "Clinics open.", due: "March 2026" }, DOC).due, null);
  assert.match(checkCandidate({ quote: "We will open four new veterans clinics in Ohio by the end of 2027", check_note: "x clinics" }, DOC).reason, /word for word/);
  assert.match(checkCandidate({ quote: "We will open three new veterans clinics in Ohio by the end of 2027", check_note: "A historic expansion." }, DOC).reason, /loaded/);
  assert.match(checkCandidate({ quote: "We will open three new veterans clinics in Ohio by the end of 2027", check_note: "" }, DOC).reason, /note/);
});

test("sources: White House feed (full text, own site only), gov.ca.gov posts, govinfo addresses", () => {
  const wh = parseRssWithContent(whiteHouseFeed("releases"), { origin: "http://127.0.0.1:8788/whitehouse/", kind: whiteHouseKind });
  assert.equal(wh.length, 2, "the off-site item is left out");
  assert.equal(wh[0].published_on, "2026-10-05");
  assert.equal(wh[0].kind, "press_release");
  assert.match(wh[0].text, /“?We will open three new veterans clinics in Ohio by the end of 2027/);
  assert.equal(worthReading(wh[1].title), false, "appointment lists aren't read");
  const ca = parseWpPosts(govcaPosts(), "http://127.0.0.1:8788/govca/");
  assert.equal(ca[0].kind, "press_release");
  assert.doesNotMatch(ca[0].text, /et_pb_/, "builder shortcodes are stripped");
  assert.match(ca[0].text, /SACRAMENTO - The state will award \$25 million/);
  assert.deepEqual(addressPackages(govinfoCollection()).map((p) => p.packageId), ["DCPD-FAKE00001"]);
  assert.equal(whiteHouseKind("The Inaugural Address"), "address");
  assert.equal(htmlToText("<style>p{}</style><p>A&nbsp;b</p>"), "A b");
});

test("reading order: officials take turns, newest first", () => {
  const rows = [
    { official_id: "p", published_on: "2026-10-01", url: "p1" },
    { official_id: "p", published_on: "2026-10-05", url: "p2" },
    { official_id: "p", published_on: "2026-10-03", url: "p3" },
    { official_id: "g", published_on: "2026-09-01", url: "g1" },
    { official_id: "c", published_on: "2026-09-20", url: "c1" },
  ];
  assert.deepEqual(roundRobin(rows, 4).map((r) => r.url), ["p2", "g1", "c1", "p3"]);
});

test("reading order: documents that commit to something first; none, skipped", () => {
  const report = { kind: "press_release", text: "The program reached 10,000 people this year. Results continue to improve across the state." };
  const plan = { kind: "press_release", text: "Progress was strong. The Governor will sign the budget by June 30, 2027. The state plans to open two new clinics in rural counties." };
  const values = { kind: "press_release", text: "We believe in a strong and growing economy for every family in this state." };
  const address = { kind: "address", text: "Tonight I will send Congress a bill to fund rural broadband in every state." };
  assert.equal(commitmentScore(report), 0, "a report of results: nothing to read");
  assert.equal(commitmentScore(values), 0, "values aren't commitments");
  assert.equal(commitmentSentences(plan.text).length, 2);
  assert.ok(commitmentScore(address) > commitmentScore(plan), "addresses first");
  const rows = [
    { official_id: "g", published_on: "2026-10-05", url: "newest", score: 1 },
    { official_id: "g", published_on: "2026-09-01", url: "older-plan", score: 3 },
  ];
  assert.deepEqual(roundRobin(rows, 2).map((r) => r.url), ["older-plan", "newest"]);
});

test("the output shape limits the speaker to the listed officials", () => {
  const s = schema(["Gloria Testgovernor"]);
  assert.deepEqual(s.properties.promises.items.properties.speaker.enum, ["Gloria Testgovernor"]);
  assert.deepEqual(s.properties.promises.items.required, ["speaker", "quote", "check_note", "due"]);
});

test("a promise added by hand: the same rules in code; a video time; batch ids", async () => {
  const { checkEntry, checkPage, selectedIds, officialLabel } = await import("../../../functions/_lib/promise-entry.js");
  const { sourceHref, timeSeconds } = await import("../../../functions/_lib/promises.js");
  const officials = [{ id: "ca-exec:governor:x", name: "Gloria Testgovernor", office: "Governor" }];
  const good = {
    official: officialLabel(officials[0]), quote: "I will open the new library in San Andreas by May 2027.", made_on: "2026-09-01",
    source_kind: "meeting_video", source_url: "https://www.youtube.com/watch?v=abc", source_time: "1:02:03",
    source_title: "Board meeting, September 1, 2026", check_note: "The library in San Andreas opens.", due: "by May 2027", reviewer: "Test Reviewer",
  };
  const ok = checkEntry(good, officials, "2026-10-06");
  assert.equal(ok.error, "");
  assert.equal(ok.row.official_id, "ca-exec:governor:x");
  assert.equal(ok.row.suggested_by, "Added by Test Reviewer");
  assert.equal(sourceHref(good.source_url, good.source_time), "https://www.youtube.com/watch?v=abc&t=3723s");
  assert.equal(timeSeconds("61:00"), 3660);
  assert.equal(timeSeconds("1:75:00"), null);
  const err = (patch) => checkEntry({ ...good, ...patch }, officials, "2026-10-06").error;
  assert.match(err({ official: "Gloria" }), /Choose the official/);
  assert.match(err({ made_on: "2026-12-01" }), /not in the future/);
  assert.match(err({ source_url: "javascript:alert(1)" }), /http\(s\) link/);
  assert.match(err({ source_time: "noon" }), /h:mm:ss/);
  assert.match(err({ check_note: "A historic library opens." }), /neutral wording/);
  assert.match(err({ due: "by 2030" }), /only when the quote states one/);
  // A value, not a commitment: refused unless the person confirms it is one.
  const value = { ...good, quote: "We value our libraries and the people who use them.", due: "" };
  assert.match(checkEntry(value, officials, "2026-10-06").error, /may not be a specific commitment/);
  assert.equal(checkEntry({ ...value, confirm: "yes" }, officials, "2026-10-06").error, "");
  // Pages: an official, an http(s) link, whose site.
  assert.equal(checkPage({ official: officialLabel(officials[0]), url: "https://example.org/issues", kind: "campaign_site", title: "Issues" }, officials, "me@example.org").error, "");
  assert.match(checkPage({ official: officialLabel(officials[0]), url: "ftp://x", kind: "campaign_site", title: "Issues" }, officials, "me").error, /http\(s\)/);
  assert.deepEqual(selectedIds(["3", "3", "x", "-1", "7"]), [3, 7]);
});

test("Issues pages are read right after addresses; nav and footer aren't part of the text", () => {
  const page = { kind: "campaign_site", text: htmlToText("<nav>Donate</nav><p>I will repave Route 4 by the end of 2027.</p><footer>Paid for by</footer>") };
  assert.doesNotMatch(page.text, /Donate|Paid for/);
  assert.ok(commitmentScore(page) > 500 && commitmentScore(page) < 1000);
});
