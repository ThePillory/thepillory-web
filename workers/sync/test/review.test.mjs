// Unit tests for the review-load pieces that don't call the API: cleaning the
// relevance check's answers, settling the AI reviewer's verdict, and cards.
import assert from "node:assert/strict";
import test from "node:test";
import { cleanVerdicts, relevanceSchema, relevanceMessage, LOCAL_RANK } from "../src/analysis/relevance.js";
import { settleReview, draftForReview, reviewSchema, CHECKS } from "../src/analysis/review.js";
import { cardToDraft, cardSchema, MAX_CARD_CLAUSES } from "../src/analysis/prompt.js";

const bills = [
  { id: "us-119-hr-40", bill_number: "H.R. 40", level: "federal", title: "To designate the facility of the United States Postal Service located at 100 Example Street" },
  { id: "ca-20252026-ab-101", bill_number: "AB 101", level: "state", title: "Test Assembly Bill One Oh One" },
];

test("relevance: only bills that were asked about, once each, with safe defaults", () => {
  const out = cleanVerdicts(
    {
      bills: [
        { bill_id: "us-119-hr-40", verdict: "skip", category: "naming", reason: "Names a post office.", local: "none", local_reason: "" },
        { bill_id: "us-119-hr-40", verdict: "analyze", category: "substantive", reason: "duplicate", local: "high", local_reason: "" },
        { bill_id: "ca-20252026-ab-101", verdict: "analyze", category: "substantive", reason: "", local: "extreme", local_reason: "x" },
        { bill_id: "us-119-hr-999", verdict: "skip", category: "naming", reason: "never asked", local: "none", local_reason: "" },
      ],
    },
    bills
  );
  assert.equal(out.length, 2);
  assert.deepEqual([out[0].verdict, out[0].category, out[0].reason], ["skip", "naming", "Names a post office."]);
  assert.equal(out[1].local, "medium", "unknown local level falls back to medium");
  assert.equal(out[1].reason, "Substantive measure.");
});

test("relevance: a skip must name a routine category, or the bill is analyzed", () => {
  const [v] = cleanVerdicts({ bills: [{ bill_id: "ca-20252026-ab-101", verdict: "skip", category: "substantive", reason: "Seems minor.", local: "low", local_reason: "" }] }, bills);
  assert.deepEqual([v.verdict, v.category], ["analyze", "substantive"]);
  const [w] = cleanVerdicts({ bills: [{ bill_id: "ca-20252026-ab-101", verdict: "analyze", category: "naming", reason: "x", local: "low", local_reason: "" }] }, bills);
  assert.equal(w.category, "substantive");
});

test("relevance: schema limits ids to the batch; message lists every bill; ranks order high first", () => {
  const schema = relevanceSchema(bills.map((b) => b.id));
  assert.deepEqual(schema.properties.bills.items.properties.bill_id.enum, ["us-119-hr-40", "ca-20252026-ab-101"]);
  const msg = relevanceMessage(bills);
  assert.match(msg, /us-119-hr-40 \| H\.R\. 40 \| U\.S\. Congress \| To designate/);
  assert.match(msg, /ca-20252026-ab-101 \| AB 101 \| California Legislature/);
  assert.ok(LOCAL_RANK.high > LOCAL_RANK.medium && LOCAL_RANK.medium > LOCAL_RANK.low && LOCAL_RANK.low > LOCAL_RANK.none);
});

const allOk = CHECKS.map(([id]) => ({ id, ok: true, note: "Fine." }));

test("reviewer: pass only when every check is ok and the verdict is pass", () => {
  assert.equal(settleReview({ checks: allOk, verdict: "pass" }).verdict, "pass");
  assert.equal(settleReview({ checks: allOk, verdict: "flag" }).verdict, "flag", "a flag without a failed check is still a flag");
  const one = settleReview({ checks: allOk.map((c) => (c.id === "balance" ? { ...c, ok: false, note: "The tension panel is one line; aligns is three." } : c)), verdict: "pass" });
  assert.equal(one.verdict, "flag", "a failed check overrides a pass");
  assert.equal(one.reasons.length, 1);
  assert.match(one.reasons[0], /noticeably weaker.*tension panel/);
});

test("reviewer: a missing check counts as failed; unknown checks are ignored", () => {
  const r = settleReview({ checks: [...allOk.slice(1), { id: "vibes", ok: true, note: "" }], verdict: "pass" });
  assert.equal(r.verdict, "flag");
  assert.equal(r.checks.length, CHECKS.length);
  assert.equal(r.checks.find((c) => c.id === "summary").ok, false);
  assert.equal(settleReview(null).verdict, "flag");
  assert.deepEqual(reviewSchema().properties.checks.items.properties.id.enum, CHECKS.map(([id]) => id));
});

test("reviewer: sees what readers see, not internal fields", () => {
  const d = draftForReview({ plain_summary: "S", clauses: [{ id: "amend-1", quote: "q", why: "w", extra: 1 }], aligns: ["a"], tension: [], departure: [], article_v: "", readings: [], citations: [], uncertainty: "" }, "card");
  assert.deepEqual(Object.keys(d).sort(), ["aligns", "depth", "plain_summary", "provisions"]);
  assert.deepEqual(d.provisions[0], { id: "amend-1", quote: "q", why: "w" });
});

test("card: one-sentence panels become one-item lists; at most three provisions", () => {
  const clauses = ["amend-1", "amend-10", "amend-14-sec-1", "art-1-sec-8-cl-1"].map((id) => ({ id, quote: "x", why: "y" }));
  const { draft, trimmed } = cardToDraft({ plain_summary: "Two sentences. Here.", clauses, aligns: "It aligns.", tension: " ", departure: "", readings: [], citations: [] });
  assert.equal(draft.clauses.length, MAX_CARD_CLAUSES);
  assert.deepEqual(trimmed, ["art-1-sec-8-cl-1"]);
  assert.deepEqual([draft.aligns, draft.tension, draft.departure], [["It aligns."], [], []]);
  assert.deepEqual([draft.article_v, draft.uncertainty], ["", ""]);
  const schema = cardSchema();
  assert.equal(schema.properties.aligns.type, "string");
  assert.ok(!("article_v" in schema.properties));
});
