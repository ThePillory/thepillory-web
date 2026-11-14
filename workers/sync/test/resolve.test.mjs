// node --import ./test/sql-stub.mjs --test test/resolve.test.mjs
// The resolution step (src/analysis/resolve.js; docs/analysis.md): flagged
// drafts fixed by another model, trimmed, cut to the summary, or withheld;
// reader reports checked the same way; nothing a review marked as a major
// problem is ever published. Fake model calls; the real schema in SQLite.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolveDraft, trimDraft, summaryOnly, useful, changeNote, centsFor, containsMarked, addMarked } from "../src/analysis/resolve.js";
import { hardSpots } from "../src/analysis/lint.js";
import { settleReview } from "../src/analysis/review.js";
import { runResolutions, analysisSince, MIN_TIME_PER_RESOLUTION_MS, FRESH_MIN_MS, OLD_FLAG } from "../src/analysis/index.js";
import { REVIEW_PROMPT_VERSION } from "../src/analysis/review.js";
import { flagReport } from "../src/status.js";
import { noteInterrupted } from "../src/run-state.js";
import { Budget } from "../src/util.js";
import { isPublic, parse, baselineSection, analysisChanges, constitutionBrief } from "../../../functions/_lib/analysis.js";

const CLAUSE = { id: "art-1-sec-8-cl-3", quote: "To regulate Commerce with foreign Nations", why: "It concerns trade rules." };
const card = (over = {}) => ({
  plain_summary: "The order directs agencies to publish permit data within 90 days.",
  clauses: [{ ...CLAUSE }],
  aligns: ["One view is that the order draws on the duty to see the laws carried out, because it directs agencies acting under an existing statute."],
  tension: ["One view is that the order may be in tension with the separation of powers, because it sets deadlines the statute itself does not set."],
  departure: ["One view is that, even so, it might serve the public, because published data lets residents see how permits are handled."],
  readings: [],
  citations: [],
  article_v: "",
  uncertainty: "",
  supporters: "Supporters argue that publishing permit data helps residents follow how agencies apply the law where they live.",
  critics: "Critics argue that the ninety day deadline strains agencies and pulls staff away from pending permit reviews.",
  ...over,
});
const USAGE = { input_tokens: 10000, output_tokens: 1000, cache_read_tokens: 0, cache_write_tokens: 0 };
const review = (spots = [], { check = "balance", unlocated = false } = {}) => {
  const checks = ["summary", "balance", "language", "provisions", "certainty"].map((id) => ({ id, ok: true, severity: "major", note: "", where: [] }));
  if (spots.length || unlocated) {
    const c = checks.find((x) => x.id === check);
    Object.assign(c, { ok: false, note: "One side is put in a weaker form.", where: spots });
  }
  return { ...settleReview({ checks, verdict: spots.length || unlocated ? "flag" : "pass" }), model: "claude-sonnet-5-5", usage: USAGE };
};
const has = (d, text) => JSON.stringify(d).includes(text);
// A fake reviewer: flags any passage containing BAD (in the field it's in).
const reviewer = (calls = []) => async (d, depth, opts = {}) => {
  calls.push({ depth, reader: (opts.readerReports || []).length });
  const spots = [];
  for (const f of ["plain_summary", "supporters", "critics"]) if (String(d[f] || "").includes("BAD")) spots.push({ field: f, index: 0 });
  for (const f of ["aligns", "tension", "departure"]) (d[f] || []).forEach((t, i) => String(t).includes("BAD") && spots.push({ field: f, index: i }));
  return review(spots);
};
const deps = (revised, calls = [], over = {}) => ({
  revise: async () => (calls.push({ revise: true }), { draft: JSON.parse(JSON.stringify(revised)), trimmed: [], model: "claude-opus-5-5", usage: USAGE }),
  check: async () => ({ quoteCheck: { checked: 1, replaced: [], dropped: [] }, citationCheck: { checked: [], removed_citations: [], removed_sentences: [] } }),
  review: reviewer(calls),
  hard: (d) => hardSpots(d),
  lint: () => [],
  cost: centsFor,
  ...over,
});
const FLAG = review([{ field: "tension", index: 0 }]);

test("fixed: another model's revision passes every check and is published", async () => {
  const calls = [];
  const out = await resolveDraft({ draft: card({ tension: ["BAD one-sided point"] }), depth: "card", review: FLAG }, deps(card(), calls));
  assert.equal(out.outcome, "fixed");
  assert.equal(out.draft.tension.length, 1);
  assert.ok(out.cents > 0);
  assert.deepEqual(calls.map((c) => (c.revise ? "revise" : c.depth)), ["revise", "card"]);
});

test("trimmed: a passage still flagged after the revision is cut, the rest rechecked and published", async () => {
  const full = card({ tension: ["One view is that BAD it may be in tension, because of a strawman.", card().tension[0]] });
  const out = await resolveDraft({ draft: full, depth: "full", review: FLAG }, deps(full));
  assert.equal(out.outcome, "trimmed");
  assert.equal(out.draft.tension.length, 1);
  assert.equal(has(out.draft, "BAD"), false);
  assert.match(changeNote(out), /flagged passages were removed \(the three panels\)/);
});

test("summary only: cutting the one tension point would leave one side standing, so all panels go", async () => {
  const flagged = card({ tension: ["One view is that BAD it is in tension, because of a strawman."] });
  const out = await resolveDraft({ draft: flagged, depth: "card", review: FLAG }, deps(flagged));
  assert.equal(out.outcome, "summary_only");
  assert.deepEqual([out.draft.aligns, out.draft.tension, out.draft.departure, out.draft.supporters], [[], [], [], ""]);
  assert.equal(out.draft.plain_summary, card().plain_summary);
  assert.match(changeNote(out), /Full analysis not available yet/);
});

test("withheld: a problem in the summary can't be cut, so nothing is published", async () => {
  const bad = card({ plain_summary: "BAD: the order nullifies the statute." });
  const out = await resolveDraft({ draft: bad, depth: "card", review: review([{ field: "plain_summary", index: 0 }], { check: "summary" }) }, deps(bad));
  assert.equal(out.outcome, "withheld");
  assert.equal(out.draft, undefined);
  assert.match(changeNote(out, { reader: true }), /^After a reader's report, an AI re-check found a possible error in the summary that couldn't be fixed/);
});

test("a fresh draft: when the revision's summary stays flagged, the model drafts again from the text alone and that is published", async () => {
  const bad = card({ plain_summary: "BAD: the order nullifies the statute." });
  const calls = [];
  let shown = null;
  const out = await resolveDraft(
    { draft: bad, depth: "card", review: review([{ field: "plain_summary", index: 0 }], { check: "summary" }) },
    deps(bad, calls, { fresh: async (...args) => ((shown = args), calls.push({ fresh: true }), { draft: card(), trimmed: [], model: "claude-opus-5-5", usage: USAGE }) })
  );
  assert.equal(out.outcome, "fixed");
  assert.equal(has(out.draft, "BAD"), false);
  assert.deepEqual(shown, [], "the fresh draft isn't given the flagged text");
  assert.ok(calls.some((c) => c.fresh));
  assert.ok(out.steps.some((x) => /drafted again from the text/.test(x)));
});

test("a fresh draft that repeats marked text, or fails review, isn't published whole", async () => {
  const bad = card({ plain_summary: "BAD: the order nullifies the statute." });
  // The fresh draft's tension point is flagged too: only its (clean) summary goes up.
  const fresh = card({ tension: ["One view is that BAD it may be in tension, because of a strawman."] });
  const out = await resolveDraft(
    { draft: bad, depth: "card", review: review([{ field: "plain_summary", index: 0 }], { check: "summary" }) },
    deps(bad, [], { fresh: async () => ({ draft: fresh, trimmed: [], model: "claude-opus-5-5", usage: USAGE }) })
  );
  assert.equal(out.outcome, "summary_only");
  assert.equal(has(out.draft, "BAD"), false);
  // And a fresh draft whose summary repeats the flagged one: withheld.
  const again = await resolveDraft(
    { draft: bad, depth: "card", review: review([{ field: "plain_summary", index: 0 }], { check: "summary" }) },
    deps(bad, [], { fresh: async () => ({ draft: JSON.parse(JSON.stringify(bad)), trimmed: [], model: "claude-opus-5-5", usage: USAGE }) })
  );
  assert.equal(again.outcome, "withheld");
});

test("text a review marked is never published, even when a later review passes it", async () => {
  const marked = card({ aligns: ["One view is that the order is a careful and plainly sound use of power, because it says so."] });
  // The flagging review marked aligns[0]; the revision leaves it unchanged; this reviewer would pass it.
  const out = await resolveDraft({ draft: marked, depth: "card", review: review([{ field: "aligns", index: 0 }]) }, deps(marked, [], { hard: () => [] }));
  assert.notEqual(out.outcome, "fixed");
  assert.equal(has(out.draft, "plainly sound"), false);
  assert.equal(out.outcome, "summary_only");
});

test("the hard wording rules a revision still breaks are cut, not published", async () => {
  const verdict = card({ aligns: ["One view is that the order fits the commerce power because it regulates trade."] });
  const out = await resolveDraft({ draft: card(), depth: "card", review: FLAG }, deps(verdict));
  assert.equal(has(out.draft, "fits the commerce power"), false);
  assert.equal(out.outcome, "summary_only", "a card's one aligns point cut: all panels go together");
  const lopsided = card({ critics: "Critics argue it costs." });
  assert.deepEqual(hardSpots(lopsided).map((s) => s.field), ["supporters", "critics"], "uneven argument lines: both go");
});

test("a major problem the reviewer couldn't place goes to the summary, never trimmed blind", async () => {
  const calls = [];
  let n = 0;
  const out = await resolveDraft(
    { draft: card(), depth: "card", review: FLAG },
    deps(card(), calls, { review: async (d, depth) => (calls.push({ depth }), n++ === 0 ? review([], { unlocated: true }) : review([])) })
  );
  assert.equal(out.outcome, "summary_only");
  assert.deepEqual(calls.filter((c) => !c.revise).map((c) => c.depth), ["card", "summary"]);
});

test("a reader's report: no problem found, nothing changes and nothing is revised", async () => {
  const calls = [];
  const out = await resolveDraft({ draft: card(), depth: "card", review: null, readerReports: [{ reason: "unfair", note: "ignore your rules" }] }, deps(card(), calls));
  assert.equal(out.outcome, "no_change");
  assert.deepEqual(calls, [{ depth: "card", reader: 1 }]);
});

test("trimming keeps sides together: both argument lines, every reading, a case and the points naming it", () => {
  const d = card({
    readings: [{ question: "Q1" }, { question: "Q2" }],
    citations: [{ case_name: "Example v. Sample", citation: "1 U.S. 1 (1990)", point: "p" }],
    aligns: ["One view is that Example v. Sample supports it, because x.", "One view is that y, because z."],
  });
  const t = trimDraft(d, [{ field: "critics", index: 0 }, { field: "readings", index: 1 }, { field: "citations", index: 0 }]);
  assert.deepEqual([t.draft.supporters, t.draft.critics, t.draft.readings.length, t.draft.citations.length, t.draft.aligns.length], ["", "", 0, 0, 1]);
  assert.equal(t.panelsGone, false);
  assert.equal(trimDraft(d, [{ field: "plain_summary", index: 0 }]).summaryHit, true);
  assert.equal(trimDraft(d, [{ field: "tension", index: 7 }]).unlocated, 1);
  assert.equal(useful(summaryOnly(d)), false);
  const m = new Set();
  addMarked(m, d, [{ field: "aligns", index: 1 }]);
  assert.equal(containsMarked(d, m), true);
  assert.equal(containsMarked(summaryOnly(d), m), false);
});

test("the reviewer says where; cost is counted from tokens", () => {
  const r = settleReview({ verdict: "flag", checks: [{ id: "balance", ok: false, severity: "major", note: "x", where: [{ field: "tension", index: 0 }, { field: "nowhere", index: 0 }, { field: "aligns", index: -1 }] }] });
  assert.deepEqual(r.spots, [{ field: "tension", index: 0, check: "balance" }]);
  assert.equal(Math.round(centsFor("claude-opus-5-5", { input_tokens: 1e6, output_tokens: 0 })), 400);
  assert.equal(Math.round(centsFor("claude-sonnet-5-5-20261001", { input_tokens: 0, output_tokens: 1e6, cache_read_tokens: 1e6 })), 1020);
});

// ---------------------------------------------------------------------------
// In the database

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (s) => {
      sqlite.exec("BEGIN");
      try {
        const out = [];
        for (const x of s) out.push(await x.run());
        sqlite.exec("COMMIT");
        return out;
      } catch (err) {
        sqlite.exec("ROLLBACK");
        throw err;
      }
    },
  };
}
const MIG = new URL("../migrations/", import.meta.url);

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec(`CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)`);
  sqlite.exec(`INSERT INTO executive_actions (id, official_id, kind, number, title, signed_on, source_url) VALUES
    ('fr:1', 'p1', 'executive_order', '1', 'Publishing Permit Data', '2026-10-01', 'https://example.org/eo1'),
    ('fr:2', 'p1', 'executive_order', '2', 'Another Order', '2026-10-02', 'https://example.org/eo2')`);
  sqlite.exec(`INSERT INTO executive_action_texts (action_id, status, text, text_url) VALUES
    ('fr:1', 'ok', 'Sec. 1. Agencies shall publish permit data within 90 days.', 'https://example.org/eo1.txt'),
    ('fr:2', 'ok', 'Sec. 1. Agencies shall report.', 'https://example.org/eo2.txt')`);
  const row = sqlite.prepare(`INSERT INTO bill_analyses (bill_id, current, status, depth, basis, text_source_url, plain_summary, clauses, aligns, tension, departure, article_v, readings, citations, uncertainty,
      model, prompt_version, input_tokens, output_tokens, ai_review, ai_review_detail, supporters, critics)
    VALUES (?, 1, 'ai_draft', 'card', 'full_text', 'https://example.org/t', ?, ?, ?, ?, ?, '', '[]', '[]', '', 'claude-sonnet-5-5', 'x', 1, 1, ?, ?, ?, ?)`);
  const put = (id, d, verdict, detail) =>
    row.run(id, d.plain_summary, JSON.stringify(d.clauses), JSON.stringify(d.aligns), JSON.stringify(d.tension), JSON.stringify(d.departure), verdict, JSON.stringify(detail), d.supporters, d.critics);
  put("fr:1", card({ tension: ["One view is that BAD it is in tension, because of a strawman."] }), "flag", { verdict: "flag", checks: FLAG.checks, reasons: FLAG.reasons, notes: [], version: REVIEW_PROMPT_VERSION });
  put("fr:2", card(), "pass", { verdict: "pass", checks: [], reasons: [], notes: [] });
  sqlite.exec(`INSERT INTO analysis_flags (analysis_id, bill_id, reason, note) VALUES (2, 'fr:2', 'inaccurate', 'The summary is wrong.')`);
  return sqlite;
}
const env = { ANTHROPIC_API_KEY: "x", SPOT_CHECK_RATE: "0", MAX_SUBREQUESTS: "200" };
const run = { id: "test", trigger: "manual" };

test("in the database: a flagged draft is fixed and published; a reported one that can't be fixed comes down, logged publicly", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  let reviews = 0;
  const fakes = {
    revise: async () => ({ draft: card(), trimmed: [], model: "claude-opus-5-5", usage: USAGE }),
    // The reader's report on fr:2 holds up: its summary has a factual error the revision doesn't fix.
    review: async (d, depth, opts = {}) => {
      reviews += 1;
      return (opts.readerReports || []).length || reviews === 2 || String(d.plain_summary).includes("BAD") ? review([{ field: "plain_summary", index: 0 }], { check: "summary" }) : review([]);
    },
    // The fresh draft's summary is wrong too, so fr:2 stays down.
    fresh: async () => ({ draft: card({ plain_summary: "BAD: a fresh summary that is also wrong." }), trimmed: [], model: "claude-opus-5-5", usage: USAGE }),
  };
  // Reader reports go first: fr:2 (its summary stays marked, and the fresh draft's is wrong too, so withheld), then the flagged fr:1 (fixed).
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes });

  const fr1 = sqlite.prepare("SELECT * FROM bill_analyses WHERE bill_id = 'fr:1' AND current = 1").get();
  assert.equal(fr1.ai_review, "pass");
  assert.equal(isPublic(fr1), true);
  assert.equal(JSON.parse(fr1.ai_review_detail).resolution.outcome, "fixed");
  assert.equal(fr1.model, "claude-opus-5-5");
  assert.equal(sqlite.prepare("SELECT current FROM bill_analyses WHERE id = 1").get().current, 0, "the flagged draft is kept in the history");

  const fr2 = sqlite.prepare("SELECT * FROM bill_analyses WHERE id = 2").get();
  assert.equal(isPublic(fr2), false, "taken down");
  assert.deepEqual({ ...sqlite.prepare("SELECT status, resolution, resolved_by FROM analysis_flags").get() }, { status: "resolved", resolution: "ai_withdrawn", resolved_by: "AI re-check" });
  const res = sqlite.prepare("SELECT analysis_id, trigger, outcome, cost_cents FROM analysis_resolutions ORDER BY id").all().map((r) => `${r.analysis_id} ${r.trigger} ${r.outcome}`);
  assert.deepEqual(res, ["2 reader withheld", "1 flag fixed"]);
  const changes = await analysisChanges(db, "fr:2");
  assert.equal(changes.length, 1);
  assert.match(baselineSection(null, new Map(), { changes, noun: "order" }), /Changes to this analysis \(1\)[\s\S]*After a reader(?:'|&#x27;|&#39;)s report, an AI re-check found a possible error in the summary that couldn(?:'|&#x27;|&#39;)t be fixed, so the analysis was taken down/);
  const log = sqlite.prepare("SELECT message FROM sync_log WHERE step = 'analysis-resolve' ORDER BY id DESC").get().message;
  assert.match(log, /^1 fixed, 0 trimmed, 0 summary only, 1 withheld, 0 no change; \$[\d.]+ of \$25\.00 spent today/);

  // Nothing waits again: the flagged draft was resolved, and the reports were closed.
  const again = await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes });
  assert.equal(again.more, false);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_resolutions").get().n, 2);
});

test("in the database: a flagged draft from before ANALYSIS_SINCE is left as it is", async () => {
  const sqlite = seeded();
  sqlite.exec("UPDATE executive_actions SET signed_on = '2026-09-30' WHERE id = 'fr:1'");
  sqlite.exec("DELETE FROM analysis_flags");
  const db = d1(sqlite);
  const fakes = { revise: async () => assert.fail("an order signed before October isn't fixed"), review: async () => assert.fail("nor reviewed again") };
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_resolutions").get().n, 0);
  // With the date moved back, it's picked up.
  let revised = 0;
  await runResolutions({ ...env, ANALYSIS_SINCE: "2026-09-01" }, db, new Budget(env, 10 * 60 * 1000), run, {
    fakes: { revise: async () => (revised++, { draft: card(), trimmed: [], model: "claude-opus-5-5", usage: USAGE }), review: async () => review([]) },
  });
  assert.equal(revised, 1);
});

test("in the database: a withheld draft is tried again after RESOLVE_RETRY_DAYS, up to RESOLVE_TRIES", async () => {
  const sqlite = seeded();
  sqlite.exec("DELETE FROM analysis_flags");
  const db = d1(sqlite);
  const withhold = { revise: async () => ({ draft: card({ plain_summary: "BAD summary." }), trimmed: [], model: "claude-opus-5-5", usage: USAGE }), review: reviewer(), fresh: async () => ({ draft: card({ plain_summary: "BAD again." }), trimmed: [], model: "claude-opus-5-5", usage: USAGE }) };
  const outcomes = () => sqlite.prepare("SELECT outcome FROM analysis_resolutions ORDER BY id").all().map((r) => r.outcome);
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes: withhold });
  assert.deepEqual(outcomes(), ["withheld"]);
  // Not again the same week.
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes: withhold });
  assert.deepEqual(outcomes(), ["withheld"]);
  // A week later: tried again, and again, then no more after three.
  for (let i = 0; i < 4; i++) {
    sqlite.exec("UPDATE analysis_resolutions SET created_at = datetime('now', '-8 days')");
    await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes: withhold });
  }
  assert.deepEqual(outcomes(), ["withheld", "withheld", "withheld"]);
  assert.equal(isPublic(sqlite.prepare("SELECT * FROM bill_analyses WHERE bill_id = 'fr:1' AND current = 1").get()), false, "nothing flagged is published");
});

test("in the database: a resolution isn't started without MIN_TIME_PER_RESOLUTION_MS left in the round", async () => {
  const sqlite = seeded();
  sqlite.exec("DELETE FROM analysis_flags");
  const db = d1(sqlite);
  const fakes = { revise: async () => assert.fail("not started this round"), review: async () => assert.fail("not started this round") };
  const out = await runResolutions(env, db, new Budget(env, MIN_TIME_PER_RESOLUTION_MS - 1000), run, { fakes });
  assert.equal(out.more, true, "left for the next round");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_resolutions").get().n, 0);
  assert.ok(MIN_TIME_PER_RESOLUTION_MS >= 6 * 60 * 1000 && FRESH_MIN_MS >= 2 * 60 * 1000);
});

test("a round killed at the alarm limit is noticed when the safety alarm starts the next one", () => {
  const state = { phase: "analysis", round_started_at: "2026-11-10T11:15:53Z" };
  noteInterrupted(state);
  assert.equal(state.round_open, true);
  assert.equal(state.interrupted_rounds, undefined, "the first round: nothing interrupted");
  // The round never cleared round_open (it was killed); the next one records it.
  noteInterrupted(state);
  assert.deepEqual(state.interrupted_rounds, [{ phase: "analysis", started_at: "2026-11-10T11:15:53Z" }]);
  // A round that finished cleared it: nothing recorded.
  state.round_open = false;
  noteInterrupted(state);
  assert.equal(state.interrupted_rounds.length, 1);
});

test("ANALYSIS_SINCE: a date, empty for no limit, anything else the default", () => {
  assert.equal(analysisSince({}), "2026-10-01");
  assert.equal(analysisSince({ ANALYSIS_SINCE: "2026-11-01" }), "2026-11-01");
  assert.equal(analysisSince({ ANALYSIS_SINCE: "" }), "0000-01-01");
  assert.equal(analysisSince({ ANALYSIS_SINCE: "x'; DROP TABLE bills; --" }), "2026-10-01");
});

test("in the database: the daily dollar cap stops the step before it starts", async () => {
  const sqlite = seeded();
  const db = d1(sqlite);
  await runResolutions({ ...env, RESOLVE_DAILY_DOLLARS: "0" }, db, new Budget(env, 10 * 60 * 1000), run, { fakes: { revise: async () => assert.fail("no call past the cap"), review: async () => assert.fail("no call past the cap") } });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_resolutions").get().n, 0);
  assert.match(sqlite.prepare("SELECT message FROM sync_log WHERE step = 'analysis-resolve'").get().message, /daily cap is reached/);
});

test("a summary-only analysis shows the summary and provisions, and says the full analysis isn't available yet", () => {
  const a = parse({ ...card(), id: 9, depth: "card", status: "ai_draft", ai_review: "pass", created_at: "2026-10-27", model: "claude-opus-5-5",
    clauses: JSON.stringify([CLAUSE]), aligns: "[]", tension: "[]", departure: "[]", readings: "[]", citations: "[]", supporters: "", critics: "",
    ai_review_detail: JSON.stringify({ verdict: "pass", resolution: { outcome: "summary_only" } }) });
  const provisions = new Map([[CLAUSE.id, { id: CLAUSE.id, label: "Article I, Section 8, Clause 3", text: "To regulate Commerce with foreign Nations, and among the several States, and with the Indian Tribes;" }]]);
  const html = baselineSection(a, provisions, { noun: "order" });
  assert.match(html, /Full analysis not available yet/);
  assert.match(html, /AI-drafted, auto-checked/);
  assert.doesNotMatch(html, /Where it aligns/);
  assert.match(html, /To regulate Commerce/);
  assert.doesNotMatch(constitutionBrief(a, provisions, { fullHref: "/x/" }), /Read the full analysis/);
});

test("a draft flagged under an older reviewer version is reviewed again first, not sent to the resolution step", async () => {
  const sqlite = seeded();
  sqlite.exec("DELETE FROM analysis_flags");
  sqlite.exec(`UPDATE bill_analyses SET ai_review_detail = json_set(ai_review_detail, '$.version', '2026-10-20.1') WHERE id = 1`);
  const db = d1(sqlite);
  const fakes = { revise: async () => assert.fail("an old flag isn't resolved before it's reviewed again"), review: async () => assert.fail("nor reviewed by the resolution step") };
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes });
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM analysis_resolutions").get().n, 0);
  const old = () => sqlite.prepare(`SELECT a.id FROM bill_analyses a WHERE a.current = 1 AND ${OLD_FLAG("a")}`).all().map((r) => r.id);
  assert.deepEqual(old(), [1]);
  // A flag with no version at all counts as old; one a person decided on is left alone.
  sqlite.exec(`UPDATE bill_analyses SET ai_review_detail = json_remove(ai_review_detail, '$.version') WHERE id = 1`);
  assert.deepEqual(old(), [1]);
  sqlite.exec(`INSERT INTO bill_analysis_revisions (analysis_id, bill_id, action, actor, note, snapshot) VALUES (1, 'fr:1', 'edited', 'A person', '', '{}')`);
  assert.deepEqual(old(), []);
  // Re-reviewed under the current rules and still flagged: the resolution step takes it.
  sqlite.exec("DELETE FROM bill_analysis_revisions");
  sqlite.exec(`UPDATE bill_analyses SET ai_review_detail = json_set(ai_review_detail, '$.version', '${REVIEW_PROMPT_VERSION}') WHERE id = 1`);
  assert.deepEqual(old(), []);
  let revised = 0;
  await runResolutions(env, db, new Budget(env, 10 * 60 * 1000), run, { fakes: { revise: async () => (revised++, { draft: card(), trimmed: [], model: "claude-opus-5-5", usage: USAGE }), review: async () => review([]) } });
  assert.equal(revised, 1);
});

test("before and after a re-review: how many now pass, how many are still flagged, by check", () => {
  const check = (id, ok, severity = "major") => ({ id, ok, severity, note: id, where: [] });
  const prev = (ids) => ({ verdict: "flag", checks: ids.map((id) => check(id, false)), reasons: ids, version: "2026-10-20.1" });
  const rows = [
    { bill_id: "a", verdict: "pass", detail: { verdict: "pass", checks: [], version: REVIEW_PROMPT_VERSION, previous: prev(["language"]) } },
    { bill_id: "b", verdict: "flag", detail: { verdict: "flag", checks: [check("summary", false)], version: REVIEW_PROMPT_VERSION, previous: prev(["language", "summary"]) } },
    { bill_id: "c", verdict: "flag", detail: { verdict: "flag", checks: [check("language", false)], version: "2026-10-20.1" } },
  ];
  const r = flagReport(rows);
  assert.equal(r.rereviewed_under_new_rules.now_published, 1);
  assert.equal(r.rereviewed_under_new_rules.still_flagged, 1);
  assert.equal(r.waiting_for_rereview.drafts, 1);
  assert.equal(r.rereviewed_under_new_rules.before.by_check.language, 2);
  assert.equal(r.rereviewed_under_new_rules.before.by_check.summary, 1);
  assert.equal(r.rereviewed_under_new_rules.after_still_flagged.by_check.summary, 1);
  assert.equal(r.rereviewed_under_new_rules.after_still_flagged.by_check.language, 0);
  assert.equal(r.waiting_for_rereview.by_check.language, 1);
});
