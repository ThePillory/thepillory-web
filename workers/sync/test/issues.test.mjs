// node workers/sync/test/issues.test.mjs
// Issues pages found automatically: which links count, which pages count, the
// order officials are searched in (Calaveras, then California, then everyone
// else), pages saved as found automatically, and a page a person removed never
// coming back. Every site and name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { issueLinks, issuesHeading, isIssuesPath } from "../src/promises/finder.js";
import { syncIssuesPages, nextOfficials } from "../src/promises/finder-sync.js";
import { UpstreamError } from "../src/util.js";

const SITE = "https://example.house.gov/";

test("links that name an issues page count; services, press and other sites don't", () => {
  const html = `<nav>
    <a href="/about">About</a>
    <a href="/services/help-with-a-federal-agency">Help with a Federal Agency</a>
    <a href="/media/press-releases">Press Releases</a>
    <a href="https://elsewhere.gov/issues">Issues</a>
    <a href="/legislation">Legislation</a>
    <a href="/issues/health-care">Health Care</a>
    <a href="/key-issues/">Key Issues</a>
    <a href="https://www.example.house.gov/issues#top">Issues</a>
  </nav>`;
  const links = issueLinks(html, SITE);
  assert.deepEqual(links.map((l) => l.url), ["https://www.example.house.gov/issues", "https://example.house.gov/key-issues/"]);
  assert.equal(issueLinks('<a href="/priorities/">Priorities</a>', SITE)[0].url, "https://example.house.gov/priorities/");
  assert.equal(issueLinks('<a href="/policy-issues">Policy Issues</a>', SITE)[0].text, "Policy Issues");
  assert.equal(issueLinks('<a href="/constituent-services">Constituent Services</a><a href="/report-an-issue">Report an issue</a>', SITE).length, 0);
  assert.ok(isIssuesPath("https://example.senate.gov/about/issues/"));
  assert.ok(!isIssuesPath("https://example.senate.gov/issues/water"));
});

test("a page counts only when its own heading or title names Issues, Priorities or Platform", () => {
  const long = "x".repeat(400);
  assert.equal(issuesHeading(`<title>Issues | Example</title><h1>Issues</h1>${long}`, 400), "Issues");
  assert.equal(issuesHeading(`<title>Priorities & Progress - Office of the Governor</title><h1>Priorities &amp; Progress</h1>`, 900), "Priorities & Progress");
  assert.equal(issuesHeading("<title>Home</title><h1>Welcome</h1>", 900), null);
  assert.equal(issuesHeading("<title>Issues</title><h1>Issues</h1>", 100), null, "too little text to be the page");
});

function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => {
      const r = sqlite.prepare(sql).run(...binds);
      return { meta: { changes: r.changes } };
    },
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (list) => {
      for (const s of list) await s.run();
    },
  };
}

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  const off = sqlite.prepare("INSERT INTO officials (id, slug, name, office, level, chamber, body, source_url, last_verified, active, state, district_code, website) VALUES (?, ?, ?, ?, ?, ?, ?, 'https://example.org/s', '2026-01-01', 1, ?, ?, ?)");
  off.run("tx-1", "far-rep", "Far Rep", "U.S. Representative", "federal", "us-house", "us-house", "TX", "1", "https://farrep.house.gov/");
  off.run("ca-9", "ca-rep", "Other California Rep", "U.S. Representative", "federal", "us-house", "us-house", "CA", "9", "https://carep.house.gov/");
  off.run("ca-5", "home-rep", "Home Rep", "U.S. Representative", "federal", "us-house", "us-house", "CA", "5", "https://homerep.house.gov/");
  off.run("sup-1", "supervisor-one", "Supervisor One", "Supervisor", "county", "county-board", "county-board", "CA", "1", null);
  sqlite.prepare("INSERT INTO sync_state (key, value) VALUES ('home_districts', ?)").run(JSON.stringify({ st: "CA", cd: "5", su: "4", sl: "8" }));
  return { sqlite, db: d1(sqlite) };
}

const SITES = {
  "https://homerep.house.gov/": `<a href="/issues">Issues</a>`,
  "https://homerep.house.gov/issues": `<title>Issues | Home Rep</title><h1>Issues</h1><p>${"Water, roads and wildfire. ".repeat(30)}</p>`,
  "https://carep.house.gov/": `<a href="/about">About</a>`,
  "https://carep.house.gov/priorities": `<title>Priorities</title><h1>My Priorities</h1><p>${"Housing and jobs. ".repeat(40)}</p>`,
  "https://farrep.house.gov/": `<a href="/about">About</a>`,
};

function fakeBudget(log) {
  return {
    async fetch(url, _init, label) {
      log.push(url);
      if (!(url in SITES)) throw new UpstreamError(url, 404, "");
      return { url, text: async () => SITES[url] };
    },
  };
}

test("officials are searched in order: Calaveras's reps, then California, then everyone else", async () => {
  const { db } = seeded();
  const rows = await nextOfficials(db, { limit: 10, recheckDays: 90, home: { cd: "5", su: "4", sl: "8" } });
  assert.deepEqual(rows.map((r) => r.id), ["ca-5", "sup-1", "ca-9", "tx-1"]);
});

test("the step finds pages, saves them as found automatically, records the rest, and never re-adds a removed page", async () => {
  const { db, sqlite } = seeded();
  const log = [];
  const r = await syncIssuesPages({ ISSUES_PAGES_DAILY: "10" }, db, fakeBudget(log));
  assert.equal(r.status, "ok");
  assert.match(r.message, /2 issues page\(s\) found, 1 site\(s\) without one, 1 official\(s\) with no website on file/);
  const pages = sqlite.prepare("SELECT url, official_id, found_by, added_by, title FROM promise_pages ORDER BY url").all();
  assert.deepEqual(pages.map((p) => [p.official_id, p.url, p.found_by]), [
    ["ca-9", "https://carep.house.gov/priorities", "auto"],
    ["ca-5", "https://homerep.house.gov/issues", "auto"],
  ]);
  const checks = Object.fromEntries(sqlite.prepare("SELECT official_id, result FROM issues_page_checks").all().map((c) => [c.official_id, c.result]));
  assert.deepEqual(checks, { "ca-5": "found", "sup-1": "no_website", "ca-9": "found", "tx-1": "none" });
  // Searched once; not again today.
  const again = await syncIssuesPages({ ISSUES_PAGES_DAILY: "10" }, db, fakeBudget([]));
  assert.match(again.message, /searched/);

  // A person removes the found page; a later search doesn't add it back.
  sqlite.prepare("INSERT INTO promise_pages_removed (url, official_id, removed_by) VALUES (?, ?, 'tester')").run("https://homerep.house.gov/issues", "ca-5");
  sqlite.prepare("DELETE FROM promise_pages WHERE url = ?").run("https://homerep.house.gov/issues");
  sqlite.prepare("DELETE FROM issues_page_checks").run();
  sqlite.prepare("DELETE FROM sync_state WHERE key LIKE 'issues_pages_%'").run();
  await syncIssuesPages({ ISSUES_PAGES_DAILY: "10" }, db, fakeBudget([]));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM promise_pages WHERE url = 'https://homerep.house.gov/issues'").get().n, 0);
  assert.equal(sqlite.prepare("SELECT note FROM issues_page_checks WHERE official_id = 'ca-5'").get().note, "the page found was removed on the review page");
});

test("the daily cap: only that many officials are searched a day", async () => {
  const { db, sqlite } = seeded();
  await syncIssuesPages({ ISSUES_PAGES_DAILY: "2" }, db, fakeBudget([]));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM issues_page_checks").get().n, 2);
  const r = await syncIssuesPages({ ISSUES_PAGES_DAILY: "2" }, db, fakeBudget([]));
  assert.equal(r.status, "skipped");
});
