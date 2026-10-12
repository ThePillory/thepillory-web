// Tests for data source health (src/health/): the rules that decide green,
// yellow and red; every source's SQL against the real schema; the daily step end
// to end with fake responses (no network); the alert email; archiving and saved
// copies; and the site's source-link rewriting. Every row and response is FAKE.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { SOURCES, SOURCE_BY_ID } from "../src/health/sources.js";
import { evaluate, congressRecess, spotVerdict, alertEmail, mimeMessage, usual, sinceDay, linkGone } from "../src/health/check.js";
import { syncSourceHealth, syncArchiveSources, syncSourceCopies } from "../src/health/sync.js";
import { linksIn, rewriteSourceLinks, savedHref } from "../../../functions/_lib/source-links.js";
import { adminHealthMain, dataStatusMain, healthData } from "../../../functions/_lib/health-pages.js";

const NOW = "2026-10-12T12:00:00Z";
const base = (id, over = {}) => ({ source: SOURCE_BY_ID[id], now: NOW, everRan: true, lastOk: "2026-10-12T11:30:00Z", rows: 1000, history: [1000, 990, 1010], latest: "2026-10-09", nullRows: 0, stepErrors: [], spot: {}, deadLinks: 0, ...over });

test("the rules: green, late, broken, shape and accuracy", () => {
  assert.equal(evaluate(base("house-clerk-votes")).status, "green");
  assert.equal(evaluate(base("house-clerk-votes", { lastOk: "2026-10-09T11:00:00Z" })).status, "yellow"); // 3 days > 2
  assert.equal(evaluate(base("house-clerk-votes", { lastOk: "2026-10-05T11:00:00Z" })).status, "red"); // > 4 days
  assert.equal(evaluate(base("house-clerk-votes", { rows: 0 })).status, "red");
  assert.equal(evaluate(base("house-clerk-votes", { rows: 400 })).status, "yellow");
  assert.equal(evaluate(base("house-clerk-votes", { nullRows: 3 })).status, "yellow");
  assert.equal(evaluate(base("house-clerk-votes", { stepErrors: ["house-votes: UpstreamError: 404 from https://clerk.house.gov/x"] })).status, "red");
  assert.equal(evaluate(base("house-clerk-votes", { stepErrors: ["house-votes: UpstreamError: 403 from https://clerk.house.gov/x"] })).status, "yellow");
  assert.equal(evaluate(base("house-clerk-votes", { spot: { ok: 4, mismatch: 1 } })).status, "yellow");
  assert.equal(evaluate(base("house-clerk-votes", { spot: { ok: 1, mismatch: 2, gone: 2 } })).status, "red");
  assert.equal(evaluate(base("house-clerk-votes", { spot: { ok: 3, unverifiable: 2 } })).status, "green");
  assert.equal(evaluate(base("house-clerk-votes", { deadLinks: 2 })).status, "yellow");
  // A workflow's failed last run.
  assert.equal(evaluate(base("stock-trades", { workflow: { conclusion: "failure", at: "2026-10-12T15:00:00Z" } })).status, "red");
  // Not set up, and looked up live.
  assert.equal(evaluate({ source: SOURCE_BY_ID.fara, now: NOW, everRan: false, rows: 0, history: [] }).status, "unknown");
  assert.equal(evaluate({ source: SOURCE_BY_ID["google-civic"], now: NOW }).status, "unknown");
});

test("freshness: Congress's votes aren't expected during a recess", () => {
  const old = { latest: "2026-07-25" };
  assert.ok(congressRecess("2026-08-15"));
  assert.ok(congressRecess("2026-10-12")); // an election year's October
  assert.ok(!congressRecess("2027-10-12"));
  assert.ok(!congressRecess("2026-06-10"));
  assert.equal(evaluate(base("house-clerk-votes", old)).status, "green"); // NOW is October 2026
  assert.equal(evaluate({ ...base("house-clerk-votes", old), now: "2027-03-10T12:00:00Z", lastOk: "2027-03-10T11:00:00Z" }).status, "yellow");
});

test("spot checks compare letters and digits only; refusals don't count against a source", () => {
  assert.equal(spotVerdict({ status: 200, contentType: "text/xml", body: "<vote-question>On Passage of the Bill</vote-question>" }, "On passage of the bill"), "ok");
  assert.equal(spotVerdict({ status: 200, contentType: "text/html", body: "<p>Something else entirely</p>" }, "On Motion to Recommit"), "mismatch");
  assert.equal(spotVerdict({ status: 404 }, "x"), "gone");
  assert.equal(spotVerdict({ status: 403 }, "x"), "unverifiable");
  assert.equal(spotVerdict({ status: 200, contentType: "application/pdf" }, "anything"), "ok");
  assert.ok(linkGone(410) && linkGone(0) && !linkGone(403) && !linkGone(503));
  assert.equal(usual([10, 30, 20]), 20);
  assert.equal(sinceDay([{ day: "2026-10-12", status: "red" }, { day: "2026-10-11", status: "yellow" }, { day: "2026-10-10", status: "green" }], "2026-10-12"), "2026-10-11");
});

test("the alert email: nothing when healthy; the broken sources, what failed and since when", () => {
  const ok = [{ source: SOURCE_BY_ID.fec, status: "green", problems: [] }];
  assert.equal(alertEmail(ok, "2026-10-12"), null);
  const msg = alertEmail([...ok, { source: SOURCE_BY_ID.lda, status: "red", since: "2026-10-10", problems: [{ level: "red", check: "run", text: "No successful pull since 2026-10-08." }] }], "2026-10-12");
  assert.equal(msg.subject, "ThePillory data: 1 source red (2026-10-12)");
  assert.match(msg.body, /RED {2}Lobbying Disclosure \(lda\.gov\) \(since 2026-10-10\)\n {2}- No successful pull since 2026-10-08\./);
  assert.match(msg.body, /\/admin\/health\//);
  const raw = mimeMessage({ from: "data-health@thepillory.co", to: "someone@example.com", subject: msg.subject, body: msg.body, date: new Date(NOW), id: "abc" });
  assert.match(raw, /^From: ThePillory data health <data-health@thepillory\.co>\r\nTo: someone@example\.com\r\nSubject: ThePillory data: 1 source red/);
  assert.match(raw, /Message-ID: <abc@thepillory\.co>/);
});

// ---------------------------------------------------------------------------
// Against the real schema

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(new URL("../migrations/", import.meta.url)).sort()) sqlite.exec(readFileSync(new URL(`../migrations/${f}`, import.meta.url), "utf8"));
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { sqlite, prepare: (sql) => stmt(sql) };
}

test("every source's queries run against the schema (all migrations)", () => {
  const { sqlite } = d1();
  for (const s of SOURCES) {
    if (s.table) sqlite.prepare(`SELECT COUNT(*) AS n${s.latest ? `, ${s.latest} AS latest` : ""} FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ""}`).get();
    if (s.nulls) sqlite.prepare(`SELECT ${s.nulls.join(", ")} FROM ${s.table} LIMIT 1`).all();
    for (const spec of [s.sample, s.links, s.copies].filter(Boolean)) {
      sqlite.prepare(`SELECT rowid, ${spec.url}${spec.expect ? `, ${spec.expect}` : ""} FROM ${spec.table}${spec.where ? ` WHERE ${spec.where}` : ""} LIMIT 1`).all();
    }
  }
  assert.equal(new Set(SOURCES.map((s) => s.id)).size, SOURCES.length);
});

function budgetWith(responses) {
  const calls = [];
  return {
    calls,
    used: 0,
    remaining() { return 1000 - this.used; },
    timeLeft() { return 600000; },
    take() { this.used += 1; },
    fetchImpl: async (url, init = {}) => {
      calls.push(`${init.method || "GET"} ${url}`);
      for (const [pattern, make] of responses) if (pattern.test(url)) return make(url, init);
      return new Response("not found", { status: 404, headers: { "content-type": "text/plain" } });
    },
  };
}

test("the daily step: statuses written once a day, dead links found, one email only when something is wrong", async () => {
  const db = d1();
  const s = db.sqlite;
  s.exec(`INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified) VALUES ('o1', 'a', 'A', 'U.S. Representative', 'federal', 'us-house', 'us-house', 'https://example.gov/o1', '2026-10-01');
    INSERT INTO votes (id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES
      ('v1', 'federal', 'us-house', '2026-10-09', 'On Passage of the Bill', 'final_passage', 'Passed', 'https://clerk.example.gov/v1.xml'),
      ('v2', 'federal', 'us-house', '2026-10-08', 'On Motion to Recommit', 'procedural', 'Failed', 'https://clerk.example.gov/v2.xml');
    INSERT INTO sync_log (run_id, trigger, step, status, requests, message, started_at, finished_at) VALUES
      ('r', 'cron', 'house-votes', 'ok', 3, '', '${new Date().toISOString().slice(0, 10)}T11:00', '${new Date().toISOString()}'),
      ('r', 'cron', 'federal-funding', 'error', 1, 'UpstreamError: 404 from https://api.open.fec.gov/x', '${new Date().toISOString().slice(0, 10)}T11:00', '${new Date().toISOString()}');`);
  const budget = budgetWith([
    [/clerk\.example\.gov\/v1/, () => new Response("<vote-question>On Passage of the Bill</vote-question>", { headers: { "content-type": "text/xml" } })],
    [/clerk\.example\.gov\/v2/, () => new Response("", { status: 410 })],
    [/api\.github\.com/, () => new Response(JSON.stringify({ workflow_runs: [{ event: "schedule", conclusion: "success", updated_at: new Date().toISOString() }] }), { headers: { "content-type": "application/json" } })],
  ]);
  const sent = [];
  const env = { LINK_CHECKS_DAILY: "40", HEALTH_SPOT_CHECKS: "2", ALERT_TO: "someone@example.com", ALERT_EMAIL: { send: async (m) => sent.push(m) } };
  const r = await syncSourceHealth(env, db, budget);
  assert.equal(r.status, "ok");
  assert.match(r.message, /sent to someone@example\.com/);
  const house = s.prepare("SELECT * FROM source_health WHERE source = 'house-clerk-votes'").get();
  assert.equal(house.rows, 2);
  assert.equal(house.latest, "2026-10-09");
  const fec = s.prepare("SELECT status, problems FROM source_health WHERE source = 'fec'").get();
  assert.equal(fec.status, "red");
  assert.match(fec.problems, /gone/);
  // v2's link answered 410 once: counted, not yet called dead (two checks in a row).
  const link = s.prepare("SELECT status, dead_checks FROM source_links WHERE url = 'https://clerk.example.gov/v2.xml'").get();
  assert.deepEqual({ ...link }, { status: 410, dead_checks: 1 });
  assert.equal(sent.length, 1);
  assert.match(sent[0].raw, /Subject: ThePillory data: \d+ sources? red/);
  // Once a day.
  assert.equal((await syncSourceHealth(env, db, budget)).status, "skipped");

  const data = await healthData(db);
  const admin = adminHealthMain(data, []);
  assert.match(admin, /Federal Election Commission<\/h2><span class="health-chip health-chip--red">Broken/);
  const pub = dataStatusMain(data);
  assert.match(pub, /House roll call votes/);
  assert.match(pub, /Last updated/);
  assert.doesNotMatch(pub, /404|error|Broken/);
});

test("archiving: an existing Wayback copy is used, otherwise one is saved; capped per day", async () => {
  const db = d1();
  db.sqlite.exec(`INSERT INTO votes (id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES
      ('v1', 'federal', 'us-house', '2026-10-09', 'Q', 'final_passage', 'Passed', 'https://clerk.example.gov/v1.xml'),
      ('v2', 'federal', 'us-house', '2026-10-08', 'Q', 'final_passage', 'Passed', 'https://clerk.example.gov/v2.xml');`);
  const budget = budgetWith([
    [/wayback\/available\?url=https%3A%2F%2Fclerk\.example\.gov%2Fv1/, () => new Response(JSON.stringify({ archived_snapshots: { closest: { available: true, url: "http://web.archive.org/web/20261001000000/https://clerk.example.gov/v1.xml" } } }), { headers: { "content-type": "application/json" } })],
    [/wayback\/available/, () => new Response(JSON.stringify({ archived_snapshots: {} }), { headers: { "content-type": "application/json" } })],
    [/web\.archive\.org\/save\//, () => new Response("saved", { status: 200, headers: { "content-type": "text/html", "content-location": "/web/20261012120000/https://clerk.example.gov/v2.xml" } })],
  ]);
  const r = await syncArchiveSources({ ARCHIVE_DAILY: "5", ARCHIVE_INTERVAL_MS: "0" }, db, budget);
  assert.match(r.message, /1 found in the Archive, 1 saved/);
  const rows = db.sqlite.prepare("SELECT url, archive_url FROM source_links ORDER BY url").all().map((x) => ({ ...x }));
  assert.deepEqual(rows, [
    { url: "https://clerk.example.gov/v1.xml", archive_url: "https://web.archive.org/web/20261001000000/https://clerk.example.gov/v1.xml" },
    { url: "https://clerk.example.gov/v2.xml", archive_url: "https://web.archive.org/web/20261012120000/https://clerk.example.gov/v2.xml" },
  ]);
  // Nothing left to archive, and the day's count kept.
  assert.match((await syncArchiveSources({ ARCHIVE_DAILY: "5", ARCHIVE_INTERVAL_MS: "0" }, db, budget)).message, /0 found in the Archive, 0 saved/);
});

test("saved copies: documents into the bucket with their source and date; none without the bucket", async () => {
  const db = d1();
  db.sqlite.exec(`INSERT INTO trade_reports (id, chamber, filer_name, filed_on, report_url, paper, source_url) VALUES
      ('t1', 'us-house', 'X', '2026-10-01', 'https://disclosures.example.gov/t1.pdf', 0, 'https://disclosures.example.gov/'),
      ('t2', 'us-house', 'Y', '2026-10-02', 'https://disclosures.example.gov/t2.pdf', 1, 'https://disclosures.example.gov/');`);
  assert.equal((await syncSourceCopies({}, db, budgetWith([]))).status, "skipped");
  const put = [];
  const env = { SOURCE_COPIES_DAILY: "10", SOURCES: { put: async (k, body, opts) => put.push({ k, size: body.byteLength, opts }) } };
  const budget = budgetWith([[/t1\.pdf/, () => new Response(new Uint8Array([37, 80, 68, 70]), { headers: { "content-type": "application/pdf", "content-length": "4" } })]]);
  const r = await syncSourceCopies(env, db, budget);
  assert.match(r.message, /1 saved/);
  assert.equal(put.length, 1); // the paper filing (t2) isn't copied
  assert.match(put[0].k, /^sources\/[0-9a-f]{64}\.pdf$/);
  assert.equal(put[0].opts.customMetadata.source_url, "https://disclosures.example.gov/t1.pdf");
  const row = db.sqlite.prepare("SELECT copy_key, copy_type, copy_bytes FROM source_links WHERE url = 'https://disclosures.example.gov/t1.pdf'").get();
  assert.deepEqual({ ...row }, { copy_key: put[0].k, copy_type: "application/pdf", copy_bytes: 4 });
});

test("source links on a page: archived copy beside the source; a dead one leads with its copy", () => {
  const html = `<p><a class="inline-link source-link" href="https://a.example.gov/1?x=1&amp;y=2" target="_blank" rel="noopener">Source ↗</a></p>
<p><a class="inline-link source-link" href="https://b.example.gov/2" target="_blank" rel="noopener">Report ↗</a></p>
<p><a class="inline-link source-link" href="https://c.example.gov/3" target="_blank" rel="noopener">Source ↗</a></p>`;
  assert.deepEqual(linksIn(html), ["https://a.example.gov/1?x=1&y=2", "https://b.example.gov/2", "https://c.example.gov/3"]);
  const out = rewriteSourceLinks(html, {
    "https://a.example.gov/1?x=1&y=2": { archive_url: "https://web.archive.org/web/2026/https://a.example.gov/1", dead: false },
    "https://b.example.gov/2": { archive_url: null, copy_key: "sources/" + "a".repeat(64) + ".pdf", dead: true },
  });
  assert.match(out, /Source ↗<\/a> <span class="archived"><a class="inline-link archived-link" href="https:\/\/web\.archive\.org\/web\/2026\/https:\/\/a\.example\.gov\/1"/);
  assert.match(out, new RegExp(`<a class="inline-link source-link copy-link" href="/saved/${"a".repeat(64)}\\.pdf"[^>]*>Saved copy ↗</a> <span class="small secondary">\\(the original, <a class="inline-link" href="https://b\\.example\\.gov/2"`));
  assert.match(out, /no longer opens\)/);
  assert.match(out, /href="https:\/\/c\.example\.gov\/3" target="_blank" rel="noopener">Source ↗<\/a><\/p>$/);
  assert.equal(savedHref("sources/abc.pdf"), "/saved/abc.pdf");
});
