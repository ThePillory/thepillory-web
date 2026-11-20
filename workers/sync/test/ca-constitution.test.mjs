// California bills' analyses (src/ca-constitution.js): the California Constitution beside the U.S.
// Constitution in the prompt, quoted only word for word from data/ca-constitution.json, and no Tenth
// Amendment or Supremacy Clause point unless the bill touches federal law.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { isCaliforniaBill, caSelection, CA_PROVISIONS, MAX_SECTIONS, MAX_CHARS, ALWAYS_ARTICLE } from "../src/ca-constitution.js";
import { billContext, billMessage, schema, cardSchema, caProvisionsFor, STATE_BILL_RULES, PROMPT_VERSION, CARD_PROMPT_VERSION } from "../src/analysis/prompt.js";
import { quoteProvisions, PROVISIONS } from "../src/constitution.js";
import { verifyQuotes } from "../src/analysis/verify.js";
import { provisionHref } from "../../../functions/_lib/provision-link.js";
import { shortLabel } from "../../../functions/_lib/summary.js";

const data = JSON.parse(readFileSync(new URL("../../../data/ca-constitution.json", import.meta.url), "utf8"));
const raw = new Map(data.provisions.map((p) => [p.id, p]));
const caBill = { id: "ca-20252026-ab-1", level: "state", chamber: "ca-assembly", bill_number: "AB 1", title: "Property taxation: assessment: change in ownership", session: "20252026", summary: "" };
const caSource = { basis: "full_text", text: "This bill would revise the definition of change in ownership for purposes of real property tax assessment, the full cash value of real property, and the base year value." };
const usBill = { id: "us-119-hr-1", level: "federal", chamber: "us-house", bill_number: "H.R. 1", title: "A bill", session: "119" };

test("which bills are California bills", () => {
  assert.equal(isCaliforniaBill(caBill), true);
  assert.equal(isCaliforniaBill(usBill), false);
  assert.equal(isCaliforniaBill({ ...caBill, chamber: "tx-lower", id: "tx-1" }), false);
  assert.equal(isCaliforniaBill({ ...caBill, kind: "order" }), false);
  assert.equal(isCaliforniaBill({ ...caBill, kind: "measure" }), false);
});

test("the provisions are the file's text, word for word, labeled as California's", () => {
  for (const p of CA_PROVISIONS) {
    assert.equal(p.text, raw.get(p.id).text || "");
    assert.equal(p.label, `California Constitution, ${raw.get(p.id).label}`);
  }
  // Never the same ID as a U.S. provision.
  const us = new Set(PROVISIONS.map((p) => p.id));
  assert.ok(CA_PROVISIONS.every((p) => !us.has(p.id)));
});

test("a property tax bill's prompt carries Article I and Article XIII A, within the caps", () => {
  const picked = caSelection(caBill, caSource);
  const art1 = CA_PROVISIONS.filter((p) => p.parent === ALWAYS_ARTICLE && p.leaf && p.text);
  for (const p of art1) assert.ok(picked.some((x) => x.id === p.id), p.id);
  const rest = picked.filter((p) => p.parent !== ALWAYS_ARTICLE);
  assert.ok(rest.length > 0 && rest.length <= MAX_SECTIONS);
  assert.ok(rest.reduce((n, p) => n + p.text.length, 0) <= MAX_CHARS);
  assert.ok(rest.some((p) => p.parent === "ca-art-13a"), rest.map((p) => p.id).join(", "));
});

test("the California bill's message: the state rules, the provisions, and the schema accepts their IDs", () => {
  const source = { ...caSource };
  const msg = billMessage(caBill, source, "card");
  assert.ok(msg.includes(STATE_BILL_RULES));
  assert.match(msg, /<california_constitution>[\s\S]*\[ca-art-1-sec-1\] California Constitution, Article I, Section 1\nAll people are by nature free/);
  assert.match(STATE_BILL_RULES, /Tenth Amendment or Supremacy Clause \(Article VI\) point only if the bill text touches federal law or federal power/);
  assert.match(STATE_BILL_RULES, /Quote no California provision that isn't below/);
  const ids = caProvisionsFor(caBill, source).map((p) => p.id);
  assert.ok(cardSchema(ids).properties.clauses.items.properties.id.enum.includes("ca-art-1-sec-1"));
  assert.ok(schema(ids).properties.clauses.items.properties.id.enum.includes("ca-art-1-sec-1"));
  // A federal bill: no California text, rules or IDs.
  const fed = billContext(usBill, { basis: "full_text", text: "Sec. 1." });
  assert.doesNotMatch(fed, /California|Tenth Amendment/);
  assert.ok(!cardSchema().properties.clauses.items.properties.id.enum.includes("ca-art-1-sec-1"));
  assert.notEqual(PROMPT_VERSION, "2026-10-08.1");
  assert.notEqual(CARD_PROMPT_VERSION, "2026-10-08.1");
});

test("California quotes are checked word for word against the file", () => {
  const sec1 = raw.get("ca-art-1-sec-1").text;
  const draft = {
    plain_summary: "", aligns: [], tension: [], departure: [], readings: [], citations: [],
    clauses: [
      { id: "ca-art-1-sec-1", quote: "All people are by nature free and independent and have inalienable rights.", why: "x" },
      { id: "ca-art-1-sec-1", quote: "All people are by nature free and independant, with rights", why: "y" },
    ],
  };
  const log = verifyQuotes(draft, quoteProvisions(caBill));
  assert.equal(draft.clauses.length, 2);
  assert.equal(draft.clauses[0].quote, "All people are by nature free and independent and have inalienable rights.");
  for (const c of draft.clauses) for (const piece of c.quote.split(" … ")) assert.ok(sec1.includes(piece), piece);
  assert.equal(log.replaced.length, 1);
  // A federal bill's draft can't cite a California provision.
  const fed = { clauses: [{ id: "ca-art-1-sec-1", quote: "All people are by nature free", why: "x" }], aligns: [], tension: [], departure: [], readings: [], citations: [] };
  const fl = verifyQuotes(fed, quoteProvisions(usBill));
  assert.equal(fed.clauses.length, 0);
  assert.equal(fl.dropped[0].reason, "no provision with this ID");
});

test("pages link a California provision to the Legislature's page, with a short label", () => {
  assert.equal(provisionHref("ca-art-13a-sec-1"), "https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CONS&article=XIII%20A");
  assert.equal(provisionHref("ca-art-1-sec-7"), raw.get("ca-art-1-sec-7").source_url);
  assert.equal(provisionHref("ca-art-34"), raw.get("ca-art-34").source_url);
  assert.equal(provisionHref("amend-10"), "/laws/constitution/#amend-10");
  assert.equal(shortLabel("California Constitution, Article XIII A, Section 1"), "Cal. Const. Art. XIII A, §1");
  assert.equal(shortLabel("Article I, Section 8, Clause 3"), "Art. I, §8, cl. 3");
});
