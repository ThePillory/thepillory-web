// node workers/sync/test/promises.test.mjs
// Promises: the checks every AI candidate must pass, the source parsers, and
// the reading order. Every name and quote here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { findQuote, quoteKey, notACommitment, wordingProblems, checkCandidate, normalizeText } from "../src/promises/check.js";
import { htmlToText, parseRssWithContent, parseWpPosts, addressPackages, whiteHouseKind, worthReading, roundRobin } from "../src/promises/sources.js";
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

test("the output shape limits the speaker to the listed officials", () => {
  const s = schema(["Gloria Testgovernor"]);
  assert.deepEqual(s.properties.promises.items.properties.speaker.enum, ["Gloria Testgovernor"]);
  assert.deepEqual(s.properties.promises.items.required, ["speaker", "quote", "check_note", "due"]);
});
