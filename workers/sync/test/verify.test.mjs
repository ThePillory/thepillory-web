// Unit tests for the draft checks. Run: node workers/sync/test/verify.test.mjs
// Uses the real stored Constitution text and FAKE drafts / lookup results.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { verifyQuotes, verifyCitations, splitSentences, caseMentions, quoteMatches, sameCase } from "../src/analysis/verify.js";

const data = JSON.parse(readFileSync(new URL("../../../data/constitution.json", import.meta.url), "utf8"));
const P = data.provisions;
let n = 0;
const test = (name, fn) =>
  Promise.resolve()
    .then(fn)
    .then(
    () => (n++, console.log(`ok   ${name}`)),
    (e) => {
      console.error(`FAIL ${name}\n${e.stack}`);
      process.exitCode = 1;
    }
  );

const draft = (over = {}) => ({
  plain_summary: "The bill sets rules for grants.",
  clauses: [],
  aligns: [],
  tension: [],
  departure: [],
  article_v: "",
  readings: [],
  citations: [],
  uncertainty: "",
  ...over,
});

// A fake CourtListener: knows two real citations only.
const KNOWN = {
  "514 U.S. 549": { case_name: "United States v. Lopez", url: "https://www.courtlistener.com/opinion/117927/united-states-v-lopez/" },
  "5 U.S. 137": { case_name: "Marbury v. Madison", url: "https://www.courtlistener.com/opinion/84759/marbury-v-madison/" },
};
const lookup = async (cites) =>
  cites.map((c) => {
    const k = Object.keys(KNOWN).find((x) => c.includes(x));
    return k ? { status: "found", citation: k, ...KNOWN[k] } : { status: "not_found", message: "no match" };
  });

await test("exact quotes pass untouched", () => {
  const d = draft({
    clauses: [{ id: "amend-1", quote: "Congress shall make no law respecting an establishment of religion", why: "x" }],
    aligns: ["It relies on the power “To regulate Commerce with foreign Nations, and among the several States”."],
  });
  const log = verifyQuotes(d, P);
  assert.equal(log.replaced.length, 0);
  assert.equal(log.checked, 2);
});

await test("a wrong quote in clauses is replaced with the stored text and logged", () => {
  const d = draft({
    clauses: [{ id: "amend-1", quote: "Congress shall make no law abridging the freedom of speech or of the press", why: "x" }],
  });
  const log = verifyQuotes(d, P);
  assert.equal(log.replaced.length, 1);
  assert.ok(quoteMatches(d.clauses[0].quote, P.find((p) => p.id === "amend-1").text), d.clauses[0].quote);
  assert.match(d.clauses[0].quote, /abridging the freedom of speech, or of the press/);
});

await test("a misquote inside prose is replaced", () => {
  const d = draft({
    tension: ['The Fourth Amendment protects "the right of the people to be safe in their homes, papers and effects, against unreasonable searches".'],
  });
  const log = verifyQuotes(d, P);
  assert.equal(log.replaced.length, 1);
  assert.equal(log.replaced[0].from, "amend-4");
  assert.match(d.tension[0], /secure in their persons, houses, papers, and effects/);
});

await test("a misquote is replaced with the phrase it was about, not just the same opening words", () => {
  const d = draft({ clauses: [{ id: "amend-1", quote: "Congress shall make no law abridging the freedom of speach", why: "x" }] });
  verifyQuotes(d, P);
  assert.match(d.clauses[0].quote, /abridging the freedom of speech/, d.clauses[0].quote);
});

await test("ellipses are allowed when every piece matches", () => {
  assert.ok(quoteMatches("Congress shall make no law ... abridging the freedom of speech", P.find((p) => p.id === "amend-1").text));
});

await test("quotes from the bill (not the Constitution) are left alone", () => {
  const d = draft({ plain_summary: 'The bill defines "covered rural broadband provider" for the grant program.' });
  const log = verifyQuotes(d, P);
  assert.equal(log.replaced.length, 0);
});

await test("unknown clause IDs are dropped", () => {
  const d = draft({ clauses: [{ id: "art-9-sec-1", quote: "", why: "x" }] });
  const log = verifyQuotes(d, P);
  assert.equal(d.clauses.length, 0);
  assert.equal(log.dropped.length, 1);
});

await test("sentences split without breaking at v. or U.S.", () => {
  const s = splitSentences("In United States v. Lopez, 514 U.S. 549 (1995), the Court read the clause. A second sentence. Third?");
  assert.equal(s.length, 3, JSON.stringify(s));
});

await test("case names are found in prose", () => {
  assert.deepEqual(caseMentions("In United States v. Lopez, the Court held X, citing Marbury v. Madison."), ["United States v. Lopez", "Marbury v. Madison"]);
  assert.ok(sameCase("United States v. Lopez", "Lopez"));
});

await test("a made-up case is removed with every sentence that relies on it", async () => {
  const d = draft({
    tension: [
      "Under United States v. Lopez, 514 U.S. 549 (1995), the Court held that the Commerce Clause has limits. In Harrington v. Calaveras Water District, 612 U.S. 118 (2024), the Court upheld a similar grant condition. The bill's conditions are narrower.",
    ],
    readings: [
      {
        question: "Q",
        original_meaning: "Reading A.",
        precedent: "Harrington v. Calaveras Water District supports the program.",
        evolving: "Reading C.",
      },
    ],
    citations: [
      { case_name: "United States v. Lopez", citation: "514 U.S. 549 (1995)", point: "Commerce Clause limits." },
      { case_name: "Harrington v. Calaveras Water District", citation: "612 U.S. 118 (2024)", point: "Grant conditions." },
    ],
  });
  const log = await verifyCitations(d, lookup);
  assert.equal(d.citations.length, 1);
  assert.equal(d.citations[0].url, KNOWN["514 U.S. 549"].url);
  assert.equal(log.removed_citations.length, 1);
  assert.ok(!/Harrington/.test(JSON.stringify(d)), JSON.stringify(d));
  assert.match(d.tension[0], /Lopez/);
  assert.match(d.tension[0], /narrower/);
  assert.equal(d.readings[0].precedent, "");
  assert.ok(log.removed_sentences.length >= 2);
});

await test("a real citation attached to the wrong case name is removed", async () => {
  const d = draft({
    aligns: ["Smith v. Jones confirms this. Other text."],
    citations: [{ case_name: "Smith v. Jones", citation: "5 U.S. 137 (1803)", point: "p" }],
  });
  const log = await verifyCitations(d, lookup);
  assert.equal(d.citations.length, 0);
  assert.equal(log.removed_citations[0].status, "name_mismatch");
  assert.deepEqual(d.aligns, ["Other text."]);
});

await test("a case named in prose but never cited is removed", async () => {
  const d = draft({ uncertainty: "It is unclear how Doe v. Roe applies. The record is thin." });
  const log = await verifyCitations(d, lookup);
  assert.equal(d.uncertainty, "The record is thin.");
  assert.equal(log.removed_sentences[0].because, "Doe v. Roe");
});

await test("when the lookup service fails, nothing unverified is kept", async () => {
  const d = draft({ citations: [{ case_name: "Marbury v. Madison", citation: "5 U.S. 137", point: "p" }], aligns: ["See Marbury v. Madison."] });
  const log = await verifyCitations(d, async () => {
    throw new Error("503");
  });
  assert.equal(d.citations.length, 0);
  assert.equal(log.removed_citations[0].status, "error");
  assert.deepEqual(d.aligns, []);
});

console.log(`\n${n} passed`);
