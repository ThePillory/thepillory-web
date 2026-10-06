// node workers/sync/test/lint.test.mjs
// The drafter's wording check (src/analysis/lint.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { lintDraft } from "../src/analysis/lint.js";

const card = (aligns, tension, departure, summary = "The bill sets a reporting deadline for an agency.") => ({ plain_summary: summary, aligns: [aligns], tension: [tension], departure: departure ? [departure] : [] });
const A = "One view is that the bill draws on the commerce power, because it regulates goods that are sold and shipped across state lines every year.";
const T = "One view is that the bill may be in tension with the Tenth Amendment, because it asks state officials to carry out parts of a federal program.";
const D = "One view is that, even so, the bill might serve the public, because a single national rule could reduce costs for buyers and sellers in every state.";

test("a clean, parallel card passes", () => {
  assert.deepEqual(lintDraft(card(A, T, D)), []);
  assert.deepEqual(lintDraft(card(A, T, "")), []);
});

test("verdicts in a panel are named", () => {
  for (const [bad, what] of [
    ["One view is that the bill fits the Tenth Amendment, because it leaves the states their own role in running the program day to day.", "fits"],
    ["One view is that the bill falls within the commerce power, because it regulates goods shipped across state lines every single year.", "falls within"],
    ["One view is that the bill is a valid exercise of the spending power, because it attaches conditions to federal grants to the states.", "valid exercise"],
    ["One view is that the bill clearly draws on the commerce power, because it regulates goods shipped across state lines every single year.", "certainty"],
    ["One view is that the bill is constitutional, because it regulates goods shipped across state lines every single year in large amounts.", "constitutional"],
    ["One view is that the bill rests on the spending power, because it attaches conditions to federal grants to the states and their agencies.", "rests on"],
  ]) {
    const p = lintDraft(card(bad, T, D));
    assert.ok(p.some((x) => /states a verdict/.test(x)), `${what}: ${JSON.stringify(p)}`);
  }
  // Mentions that aren't verdicts pass.
  assert.deepEqual(lintDraft(card("One view is that the bill raises constitutional questions about state power, because it directs how state agencies spend federal grants each year.", T, D)), []);
});

test("every panel starts 'One view is that'", () => {
  const p = lintDraft(card(A, "Does the bill direct state officials in a way the Tenth Amendment may not allow, given that it assigns them federal duties?", D));
  assert.equal(p.length, 1);
  assert.match(p[0], /doesn't start "One view is that"/);
});

test("panels of very different length are flagged in a card, not in a full analysis", () => {
  const short = "One view is that the bill draws on the commerce power.";
  const p = lintDraft(card(short, T, D));
  assert.ok(p.some((x) => /similar length/.test(x)), JSON.stringify(p));
  assert.ok(!lintDraft(card(short, T, D), { depth: "full" }).some((x) => /similar length/.test(x)));
});

test("a partly read bill says so in the summary", () => {
  assert.ok(lintDraft(card(A, T, D), { basis: "partial_text" }).some((x) => /Only part of the bill text was read/.test(x)));
  assert.deepEqual(lintDraft(card(A, T, D, "The bill sets a reporting deadline. Only part of the bill text was read: the official summary, the list of sections and the first 30,000 characters."), { basis: "partial_text" }), []);
  assert.ok(lintDraft(card(A, T, D), { basis: "summary_only" }).some((x) => /Only the official summary was read/.test(x)));
  assert.deepEqual(lintDraft(card(A, T, D, "Only the official summary was read. It says the bill sets a reporting deadline."), { basis: "summary_only" }), []);
  assert.deepEqual(lintDraft(card(A, T, D), { basis: "full_text" }), []);
});

test("a verdict in the summary is named too", () => {
  assert.ok(lintDraft(card(A, T, D, "The bill falls within Congress's power to tax and sets new rates.")).some((x) => /summary states a verdict/.test(x)));
});
