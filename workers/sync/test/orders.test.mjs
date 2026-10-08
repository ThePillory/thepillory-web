// node --test workers/sync/test/orders.test.mjs
// Executive orders: the text and the authority each claims (word for word),
// court records as CourtListener lists them, the order pipeline's prompts, the
// summary-first page pieces, and migration 0018 on a database with foreign
// keys enforced. Every order, case and name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { cleanFrText, cleanPdfText, authorityClause, courtQuery, parseDockets, parseOpinions } from "../src/executive/orders.js";
import { frRawText, govOrderLines, clSearch } from "./executive-fixtures.mjs";
import { cardInstructions, instructions, rules, RULES, INSTRUCTIONS, billMessage, cardSchema, cardToDraft } from "../src/analysis/prompt.js";
import { lintDraft } from "../src/analysis/lint.js";
import { firstSentences, shortLabel, clauseChips, contentsBar, fold, compactRow } from "../../../functions/_lib/summary.js";
import { orderSlug, orderIdFromSlug, orderStatus, authoritySection, courtsSection } from "../../../functions/_lib/orders.js";
import { billSummary, billStatus } from "../../../functions/_lib/bill-page.js";

test("a Federal Register text is cleaned to the order itself, and its authority quoted word for word", () => {
  const text = cleanFrText(frRawText("2026-099902"));
  assert.match(text, /^Executive Order 99902 of March 12/);
  assert.doesNotMatch(text, /\[\[Page|GRAPHIC|Presidential Sig|FR Doc|\u0000|<pre>/);
  assert.match(text, /“residents can find them”/, "the Register's `` '' quotes become curly quotes");
  assert.ok(text.includes("\n\nSec. 2. Policy."), "paragraphs are kept");
  assert.equal(
    authorityClause(text),
    "By the authority vested in me as President by the Constitution and the laws of the United States of America, including section 301 of title 3, United States Code, it is hereby ordered:"
  );
});

test("a Governor's signed order: the authority from NOW, THEREFORE to the colon", () => {
  const text = cleanPdfText([govOrderLines.join("\n")]);
  assert.equal(
    authorityClause(text),
    "NOW, THEREFORE, I, TEST GOVERNOR, Governor of the State of California, in accordance with the authority vested in me by the State Constitution and statutes of the State of California, do hereby issue the following Order to become effective immediately:"
  );
  assert.equal(authorityClause("WHEREAS nothing here names an authority."), null);
});

test("court records: the query, opinions and dockets as listed, unsafe links dropped", () => {
  assert.equal(courtQuery({ id: "fr:2026-099902", number: "99902" }), '"Executive Order 99902" OR "Exec. Order No. 99902" OR "E.O. 99902"');
  assert.equal(courtQuery({ id: "ca-gov:1", number: "N-9-26" }), '"Executive Order N-9-26"');
  assert.equal(courtQuery({ id: "ca-gov:2", number: null }), null);
  const q = new URLSearchParams({ q: courtQuery({ id: "fr:x", number: "99902" }) });
  const ops = parseOpinions(clSearch(new URLSearchParams([...q, ["type", "o"]])));
  assert.equal(ops.length, 1);
  assert.equal(ops[0].url, "https://www.courtlistener.com/opinion/999001/testplaintiff-v-testdefendant/");
  const docs = parseDockets(clSearch(new URLSearchParams([...q, ["type", "r"]])));
  assert.equal(docs.length, 1, "the docket with a javascript: link is dropped");
  assert.equal(docs[0].entries.length, 2);
  assert.match(docs[0].entries[1].description, /^ORDER granting in part/);
});

test("the order prompts use the same rules as bills, in the order's words; bills' rules are unchanged", () => {
  assert.equal(rules("bill"), RULES);
  assert.equal(instructions("bill"), INSTRUCTIONS);
  const card = cardInstructions("order");
  assert.match(card, /constitutional context for executive orders/);
  assert.match(card, /is within the President's \(or the Governor's\) power/);
  assert.doesNotMatch(card, /\bthe bill\b/);
  assert.match(card, /supporters: one sentence of 15 to 35 words beginning "Supporters argue that"/);
  const msg = billMessage({ kind: "order", bill_number: "Executive Order 99902", issuer: "President of the United States", title: "T", signed_on: "2026-03-12" }, { basis: "full_text", text: "TEXT", version: "the Federal Register's text" }, "card");
  assert.match(msg, /^Executive order: Executive Order 99902 \(President of the United States\)/);
  assert.match(msg, /<order_text>\nTEXT\n<\/order_text>/);
  assert.ok(cardSchema().required.includes("supporters") && cardSchema().required.includes("critics"));
  const { draft } = cardToDraft({ plain_summary: "S", clauses: [], aligns: "a", tension: "b", departure: "", readings: [], citations: [], supporters: " Supporters argue that x. ", critics: "Critics argue that y." });
  assert.equal(draft.supporters, "Supporters argue that x.");
});

test("the wording check: attributed lines of similar length, no verdicts", () => {
  const base = { plain_summary: "It does a thing.", aligns: [], tension: [], departure: [] };
  assert.deepEqual(lintDraft({ ...base, supporters: "Supporters argue that it helps residents find forms in one place, quickly and for free.", critics: "Critics argue that one deadline for every agency may strain the smallest of them." }), []);
  const bad = lintDraft({ ...base, supporters: "It is a valid exercise of the President's power.", critics: "Critics argue that it costs money." });
  assert.ok(bad.some((p) => /must be one sentence beginning "Supporters argue that"/.test(p)));
  assert.ok(bad.some((p) => /states a verdict/.test(p)));
});

test("summary-first pieces: sentences, clause labels, folds, contents, compact rows", () => {
  assert.equal(firstSentences("This bill requires the U.S. Postal Service to act. It sets a deadline. It also does more."), "This bill requires the U.S. Postal Service to act. It sets a deadline.");
  assert.equal(firstSentences("One sentence only"), "One sentence only");
  assert.equal(shortLabel("Article I, Section 8, Clause 3"), "Art. I, §8, cl. 3");
  assert.equal(shortLabel("Amendment XIV, Section 1"), "14th Amendment, §1");
  assert.equal(shortLabel("Amendment I"), "1st Amendment");
  assert.match(clauseChips([{ id: "amend-1", label: "Amendment I" }]), /href="\/laws\/constitution\/#amend-1"/);
  assert.equal(clauseChips([]), "");
  assert.equal(contentsBar([["a", "A"], ["b", "B"]]), "", "short pages get no contents bar");
  assert.match(contentsBar([["a", "A"], ["b", "B"], ["c", "C"], [null, "x"]]), /<a href="#c">C<\/a><\/nav>$/);
  assert.match(fold("votes", "All votes", "<p>x</p>", { meta: "3 recorded" }), /^<details class="fold" id="votes">[\s\S]*<span class="fold-meta">3 recorded<\/span>/);
  const row = compactRow({ href: "/x/", type: "H.R. 1", title: "<b>T</b>", status: "Passed", clause: { label: "Amendment I" } });
  assert.match(row, /&lt;b&gt;T&lt;\/b&gt;/);
  assert.match(row, /cr-clause">1st Amendment/);
});

test("order pages: addresses, status, authority and courts say only what the sources say", () => {
  assert.equal(orderSlug("fr:2025-02007"), "fr-2025-02007");
  assert.equal(orderIdFromSlug("fr-2025-02007"), "fr:2025-02007");
  assert.equal(orderIdFromSlug("ca-gov-123"), "ca-gov:123");
  assert.equal(orderIdFromSlug("../etc"), null);
  assert.deepEqual(orderStatus({ signed_on: "2025-01-20", notes: "See: EO 13780; Revoked by: EO 14148, January 20, 2025" }), ["Revoked by EO 14148", "Signed Jan 20, 2025"]);
  const a = { id: "fr:1", number: "99902", text: { status: "ok", authority: "By the authority vested in me …, it is hereby ordered:", text_url: "https://example.org/t" }, cases: [], courtCheck: null };
  assert.match(authoritySection(a), /not a finding that it has that authority/);
  assert.match(courtsSection(a), /Not searched yet/);
  assert.match(courtsSection({ ...a, courtCheck: { checked_at: "2026-10-01 00:00:00", opinions: 0, dockets: 0 } }), /No court opinions or case filings on CourtListener mention Executive Order 99902/);
});

test("a bill's summary comes from the official summary's 'This bill' sentences, else the checked analysis", () => {
  const crs = { official_summary: "Test Act of 2026 This bill requires agencies to post forms. It sets a deadline. It does more.", official_summary_label: "CRS summary, Introduced in House", official_summary_url: "https://www.congress.gov/x" };
  assert.equal(billSummary({ summary: "", ...crs }, null).text, "This bill requires agencies to post forms. It sets a deadline.");
  const digest = { official_summary: "Existing law does X. This bill would require forms. It would also do more. Other.", official_summary_label: "Legislative Counsel's Digest" };
  assert.equal(billSummary({ summary: "", ...digest }, null).text, "This bill would require forms. It would also do more.");
  assert.equal(billSummary({ summary: "", official_summary: "Existing law only.", official_summary_label: "Legislative Counsel's Digest" }, null), null);
  const ai = billSummary({ summary: "" }, { plain_summary: "It does one thing. It does two. It does three.", status: "ai_draft" });
  assert.equal(ai.text, "It does one thing. It does two.");
  assert.match(ai.source, /AI-drafted, auto-checked/);
  assert.equal(billStatus({ level: "federal" }, { outcome: { outcome: "signed", action_date: "2025-09-20" } }, []), "Signed into law · Sep 20, 2025");
  assert.equal(billStatus({ level: "federal" }, { outcome: null }, [{ vote_type: "final_passage", result: "Passed", chamber: "us-house", vote_date: "2026-03-12" }]), "Passed · U.S. House vote · Mar 12, 2026");
});

test("migration 0018 keeps every analysis, flag and revision with foreign keys enforced, and opens the tables to orders", () => {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  const dir = new URL("../migrations/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files.filter((f) => f < "0018")) db.exec(readFileSync(new URL(f, dir), "utf8"));
  db.exec(`INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES ('us-119-hr-1', 'federal', 'us-house', 'H.R. 1', '119', 'T', 'https://example.org/b');
    INSERT INTO bill_analyses (bill_id, basis, text_source_url, plain_summary, model, prompt_version, depth) VALUES ('us-119-hr-1', 'full_text', 'https://example.org/t', 'S', 'm', 'v', 'card');
    INSERT INTO analysis_flags (analysis_id, bill_id, reason) VALUES (1, 'us-119-hr-1', 'other');
    INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, snapshot) VALUES (1, 'us-119-hr-1', 'created', 'pipeline', '{}');
    INSERT INTO analysis_requests (bill_id, requested_by) VALUES ('us-119-hr-1', 'tester');`);
  assert.throws(() => db.exec("INSERT INTO bill_analyses (bill_id, basis, text_source_url, plain_summary, model, prompt_version) VALUES ('fr:1', 'full_text', 'https://example.org/t', 'S', 'm', 'v')"), /FOREIGN KEY/);
  db.exec("BEGIN");
  db.exec(readFileSync(new URL("0018_orders.sql", dir), "utf8"));
  db.exec("COMMIT");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM bill_analyses").get().n, 1);
  assert.equal(db.prepare("SELECT supporters, critics, depth FROM bill_analyses WHERE id = 1").get().depth, "card");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analysis_flags").get().n, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM analysis_requests").get().n, 1);
  db.exec("INSERT INTO bill_analyses (bill_id, basis, text_source_url, plain_summary, model, prompt_version, supporters) VALUES ('fr:1', 'full_text', 'https://example.org/t', 'S', 'm', 'v', 'Supporters argue that x.')");
  db.exec("INSERT INTO analysis_requests (bill_id, requested_by) VALUES ('fr:1', 'reader')");
  assert.equal(db.prepare("SELECT MAX(id) AS id FROM bill_analyses").get().id, 2, "ids continue after the rebuild");
  assert.deepEqual(db.prepare("PRAGMA foreign_key_check").all(), []);
});
