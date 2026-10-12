// Tests for the lobbying additions (docs/funding.md): LD-203 contributions to
// members of Congress, bills with committee action, and California lobbying.
// Every response here is FAKE, shaped like lda.gov's and Congress.gov's; the
// names are placeholders, not real people.
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { matchHonoree, memberIndex, honoreeParts, contributionItems, contribFilingRow, committeeActed, honoreeQuery, sameFirst } from "../src/funding/lobbying.js";
import { syncLobbyContributions, syncCommitteeBills } from "../src/funding/sync.js";
import { lobbyContributionsFor, lobbyContribSection, lobbyGiversFor, giversSideBySide, lobbyingFor, followTheMoney } from "../../../functions/_lib/funding.js";
import { caLobbyingFor, caLobbyingForOfficial, caFollowTheMoney, caLegislatorLobbying, sessionYears } from "../../../functions/_lib/ca-lobbying.js";

const MEMBERS = [
  { id: "bioguide:A1", slug: "alex-example", name: "Alexander B. Example", last_name: "Example", chamber: "us-house" },
  { id: "bioguide:A2", slug: "dana-example", name: "Dana Example", last_name: "Example", chamber: "us-senate" },
  { id: "bioguide:A3", slug: "pat-sample-ruiz", name: "Pat Sample Ruiz", last_name: "Sample Ruiz", chamber: "us-house" },
  { id: "bioguide:A4", slug: "robin-placeholder", name: "Robin Placeholder", last_name: "Placeholder", chamber: "us-senate" },
];

// ---------------------------------------------------------------------------
// Names

test("LD-203 honorees match exactly one member, or none", () => {
  const index = memberIndex(MEMBERS);
  assert.equal(matchHonoree("Rep. Alex Example", index), "bioguide:A1");
  assert.equal(matchHonoree("EXAMPLE, ALEXANDER", index), "bioguide:A1");
  assert.equal(matchHonoree("Senator Dana Example", index), "bioguide:A2");
  assert.equal(matchHonoree("Example", index), null); // two members named Example
  assert.equal(matchHonoree("Placeholder", index), "bioguide:A4"); // only one
  assert.equal(matchHonoree("Rep. Pat Sample Ruiz", index), "bioguide:A3");
  assert.equal(matchHonoree("Pat Ruiz", index), null); // not the member's full last name
  assert.equal(matchHonoree("Chris Example", index), null);
  assert.equal(matchHonoree("Example for Congress", index), null);
  assert.equal(matchHonoree("NRCC", index), null);
  assert.equal(honoreeParts("Friends of Robin Placeholder"), null);
  assert.ok(sameFirst("mike", "michael") && sameFirst("alex", "alexander") && !sameFirst("dana", "dan"));
  assert.equal(honoreeQuery(MEMBERS[2]), "Ruiz");
});

const ORG_REPORT = {
  url: "https://lda.gov/api/v1/contributions/aaaa/",
  filing_uuid: "aaaa",
  filing_type: "MM",
  filing_year: 2025,
  filing_period: "mid_year",
  filing_document_url: "https://lda.gov/filings/public/contribution/aaaa/print/",
  filer_type: "organization",
  dt_posted: "2025-07-20T10:00:00-04:00",
  registrant: { id: 111, name: "EXAMPLE TRADE ASSOCIATION" },
  lobbyist: null,
  contribution_items: [
    { contribution_type: "feca", contributor_name: "EXAMPLE TRADE ASSOCIATION PAC", payee_name: "EXAMPLE FOR CONGRESS", honoree_name: "Rep. Alex Example", amount: "2500.00", date: "2025-06-16" },
    { contribution_type: "feca", contributor_name: "EXAMPLE TRADE ASSOCIATION PAC", payee_name: "NRCC", honoree_name: "NRCC", amount: "5000.00", date: "2025-06-16" },
    { contribution_type: "he", contributor_name: "SELF", payee_name: "Example Foundation", honoree_name: "Senator Robin Placeholder", amount: "1000.00", date: "2025-03-02" },
  ],
};
const LOBBYIST_REPORT = {
  ...ORG_REPORT,
  url: "https://lda.gov/api/v1/contributions/bbbb/",
  filing_uuid: "bbbb",
  filing_document_url: "https://lda.gov/filings/public/contribution/bbbb/print/",
  filer_type: "lobbyist",
  lobbyist: { id: 9001, first_name: "JORDAN", last_name: "LOBBYIST" },
  contribution_items: [{ contribution_type: "feca", contributor_name: "SELF", payee_name: "EXAMPLE FOR CONGRESS", honoree_name: "Alex Example", amount: "500.00", date: "2025-05-01" }],
};

test("LD-203 items: kept only for a matched member; a lobbyist's own name is never kept", () => {
  const index = memberIndex(MEMBERS);
  const items = contributionItems(ORG_REPORT, index);
  assert.deepEqual(items.map((i) => [i.n, i.official_id, i.amount, i.date]), [[1, "bioguide:A1", 2500, "2025-06-16"], [3, "bioguide:A4", 1000, "2025-03-02"]]);
  assert.equal(items[0].contributor_name, "EXAMPLE TRADE ASSOCIATION PAC");
  const own = contributionItems(LOBBYIST_REPORT, index);
  assert.equal(own[0].contributor_name, null);
  const row = contribFilingRow(LOBBYIST_REPORT);
  assert.equal(row.filer_type, "lobbyist");
  assert.equal(row.lobbyist_id, 9001);
  assert.ok(!JSON.stringify(row).includes("JORDAN") && !JSON.stringify(own).includes("JORDAN"));
});

test("committee action: acting relationships only, never referral", () => {
  for (const r of ["Reported By", "Reported Original Measure", "Markup By", "Hearings By (full committee)", "Discharged From"]) assert.ok(committeeActed(r), r);
  for (const r of ["Referred To", "Bills of Interest - Exchange of Letters", "Unknown", ""]) assert.ok(!committeeActed(r), r);
});

// ---------------------------------------------------------------------------
// A small D1

function d1() {
  const sqlite = new DatabaseSync(":memory:");
  sqlite.exec(`CREATE TABLE sync_state (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at TEXT);
    CREATE TABLE officials (id TEXT PRIMARY KEY, k INTEGER, slug TEXT, name TEXT, last_name TEXT, chamber TEXT, level TEXT, active INTEGER DEFAULT 1);
    CREATE TABLE bills (id TEXT PRIMARY KEY, level TEXT, chamber TEXT, bill_number TEXT, session TEXT, title TEXT, summary TEXT DEFAULT '', official_url TEXT, source_url TEXT, updated_at TEXT);
    CREATE TABLE votes (id TEXT PRIMARY KEY, bill_id TEXT, vote_date TEXT, vote_type TEXT);
    CREATE TABLE state_campaign_committees (official_id TEXT, filer_id TEXT, name TEXT, source_url TEXT, checked_at TEXT);`);
  const funding = readFileSync(new URL("../migrations/0007_funding.sql", import.meta.url), "utf8");
  sqlite.exec(funding.slice(funding.indexOf("-- Lobbying reports (LD-2)")));
  sqlite.exec(readFileSync(new URL("../migrations/0029_lobbying_more.sql", import.meta.url), "utf8"));
  for (const m of MEMBERS) sqlite.prepare("INSERT INTO officials (id, slug, name, last_name, chamber, level) VALUES (?, ?, ?, ?, ?, 'federal')").run(m.id, m.slug, m.name, m.last_name, m.chamber);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => sqlite.prepare(sql).get(...args) || null,
    all: async () => ({ results: sqlite.prepare(sql).all(...args) }),
    run: async () => sqlite.prepare(sql).run(...args),
  });
  return { sqlite, prepare: (sql) => stmt(sql), batch: async (list) => Promise.all(list.map((s) => s.run())) };
}

// A budget whose requests answer from fake handlers.
function fakeBudget(handler) {
  const urls = [];
  return {
    urls,
    paced: async (db, key, pace, url) => {
      urls.push(url);
      return { json: async () => handler(url) };
    },
    json: async (url) => {
      urls.push(url);
      return handler(url);
    },
  };
}

test("lobbying-contributions: searches each member by last name and saves matches for every member", async () => {
  const db = d1();
  const budget = fakeBudget((url) => {
    const q = new URL(url).searchParams;
    const hits = q.get("contribution_honoree") === "Example" && q.get("filing_year") === "2025" ? [ORG_REPORT, LOBBYIST_REPORT] : [];
    return { count: hits.length, next: null, results: hits };
  });
  const r = await syncLobbyContributions({ LDA_CONTRIB_DAILY: "100", LDA_MIN_INTERVAL_MS: "0" }, db, budget);
  assert.equal(r.status, "ok");
  const saved = db.sqlite.prepare("SELECT filing_uuid, n, official_id FROM lobby_contributions ORDER BY filing_uuid, n").all().map((x) => `${x.filing_uuid}:${x.n}:${x.official_id}`);
  assert.deepEqual(saved, ["aaaa:1:bioguide:A1", "aaaa:3:bioguide:A4", "bbbb:1:bioguide:A1"]);
  // Every member-year searched once, and not again until the refresh.
  const progress = db.sqlite.prepare("SELECT COUNT(*) AS n, SUM(done_at IS NOT NULL) AS done FROM lobby_contrib_progress").get();
  assert.equal(progress.n, progress.done);
  assert.equal((await syncLobbyContributions({ LDA_MIN_INTERVAL_MS: "0" }, db, budget)).status, "skipped");

  // The Funding tab: organizations by name with period and dates; lobbyists only as counts.
  const l = await lobbyContributionsFor(db, "bioguide:A1", 2026);
  assert.equal(l.orgs.length, 1);
  assert.equal(l.orgs[0].total, 2500);
  assert.deepEqual([l.lobbyists.count, l.lobbyists.people, l.lobbyists.total], [1, 1, 500]);
  const html = lobbyContribSection({ name: "Alexander B. Example" }, l);
  assert.match(html, /From lobbyists and lobbying organizations/);
  assert.match(html, /EXAMPLE TRADE ASSOCIATION/);
  assert.match(html, /2025–2026/);
  assert.match(html, /Jun 16, 2025|June 16, 2025/);
  assert.match(html, /Individual lobbyists aren't named/);
  assert.ok(!/JORDAN|LOBBYIST\b/.test(html));
  assert.ok(!/lobbied (for|against)/i.test(html));
});

test("Follow the money: an organization that lobbied on the bill and gave to members, both facts with dates", async () => {
  const db = d1();
  db.sqlite.exec(`INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES ('us-119-hr-10', 'federal', 'us-house', 'H.R. 10', '119', 'Example Act', 'https://www.congress.gov/bill/119th-congress/house-bill/10');
    INSERT INTO lobbying_filings (filing_uuid, client_name, registrant_name, filing_year, filing_period, filing_type, posted_at, registrant_id, client_id, amount, amount_kind, source_url)
      VALUES ('L1', 'EXAMPLE CLIENT CO', 'EXAMPLE TRADE ASSOCIATION', 2025, 'Second Quarter (Apr 1 - June 30)', 'Q2', '2025-07-18T09:00:00-04:00', 111, 5, 40000, 'income', 'https://lda.gov/filings/public/filing/L1/print/');
    INSERT INTO bill_lobbying (bill_id, filing_uuid, issue_code, excerpt) VALUES ('us-119-hr-10', 'L1', 'TEC', 'H.R. 10, Example Act');
    INSERT INTO bill_lobbying_progress (bill_id, cursor, searched, matched, done_at) VALUES ('us-119-hr-10', '{}', 1, 1, '2025-08-01');`);
  const budget = fakeBudget((url) => ({ next: null, results: new URL(url).searchParams.get("contribution_honoree") === "Example" ? [ORG_REPORT, LOBBYIST_REPORT] : [] }));
  await syncLobbyContributions({ LDA_MIN_INTERVAL_MS: "0" }, db, budget);
  const l = await lobbyingFor(db, "us-119-hr-10");
  const givers = await lobbyGiversFor(db, l, "119");
  assert.equal(givers.length, 1);
  assert.deepEqual(givers[0].members.map((m) => [m.member, m.total]), [["Alexander B. Example", 2500], ["Robin Placeholder", 1000]]);
  const bill = { id: "us-119-hr-10", level: "federal", bill_number: "H.R. 10", session: "119" };
  const html = followTheMoney(bill, l, { givers, bare: true });
  assert.match(html, /lobbied on this bill and also gave to members of Congress/);
  assert.match(html, /mention H\.R\. 10, for EXAMPLE CLIENT CO/);
  assert.match(html, /filed Jul 18, 2025|filed July 18, 2025/);
  assert.match(html, /Jun 16, 2025|June 16, 2025/);
  assert.match(html, /don't show that one led to the other/);
  assert.ok(!/lobbied (for|against)/i.test(html));
  assert.ok(!/\$500\b/.test(html)); // the lobbyist's own contribution isn't part of an organization's
});

test("committee-bills: bills a committee acted on are added and searched for lobbying", async () => {
  const db = d1();
  const congress = 2 * 0 + 119;
  const budget = fakeBudget((url) => {
    const u = new URL(url);
    if (/\/committee\/119\/house$/.test(u.pathname)) return { committees: [{ systemCode: "hsxx00", name: "Example Committee" }, { systemCode: "hsxx01", name: "Example Subcommittee", parent: { systemCode: "hsxx00" } }] };
    if (/\/committee\/119\/senate$/.test(u.pathname)) return { committees: [] };
    if (/\/committee\/house\/hsxx00\/bills$/.test(u.pathname))
      return {
        "committee-bills": {
          bills: [
            { congress: 119, type: "HR", number: "20", relationshipType: "Reported By", actionDate: "2025-05-01T10:00:00Z" },
            { congress: 119, type: "HR", number: "21", relationshipType: "Referred To", actionDate: "2025-04-01T10:00:00Z" },
            { congress: 118, type: "HR", number: "22", relationshipType: "Markup By", actionDate: "2024-04-01T10:00:00Z" },
          ],
        },
      };
    if (/\/bill\/119\/hr\/20$/.test(u.pathname)) return { bill: { title: "Example Reporting Act" } };
    throw new Error(`unexpected ${url}`);
  });
  const r = await syncCommitteeBills({ CONGRESS_API_KEY: "test" }, db, budget);
  assert.equal(r.status, "ok");
  assert.deepEqual(db.sqlite.prepare("SELECT id, title FROM bills").all().map((b) => [b.id, b.title]), [["us-119-hr-20", "Example Reporting Act"]]);
  const a = db.sqlite.prepare("SELECT * FROM bill_committee_actions").get();
  assert.equal(a.relationship, "Reported By");
  assert.equal(a.action_date, "2025-05-01");
  assert.ok(!budget.urls.some((u) => u.includes("hsxx01")), "subcommittees aren't read");
  assert.equal(congress, 119);
});

// ---------------------------------------------------------------------------
// California

function caDb() {
  const db = d1();
  db.sqlite.exec(`INSERT INTO officials (id, slug, name, last_name, chamber, level) VALUES ('openstates:x', 'sam-legislator', 'Sam Legislator', 'Legislator', 'ca-assembly', 'state');
    INSERT INTO state_campaign_committees (official_id, filer_id, name) VALUES ('openstates:x', '1477000', 'Legislator for Assembly 2026');
    INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES ('ca-20252026-ab-973', 'state', 'ca-assembly', 'AB 973', '20252026', 'Example packaging bill', 'https://leginfo.legislature.ca.gov/');
    INSERT INTO ca_lobby_loaded (filing_id, amend_id, form) VALUES ('900', 0, 'F635'), ('901', 0, 'F635'), ('902', 0, 'F615');
    INSERT INTO ca_lobby_reports (filing_id, amend_id, form, employer_id, employer_name, period_start, period_end, filed_on, amount, activity, source_url)
      VALUES ('900', 0, 'F635', 'E1', 'EXAMPLE PACKAGING ASSOCIATION', '2025-04-01', '2025-06-30', '2025-07-30', 12000, 'AB 973, 1148', 'https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=900&amendid=0'),
             ('901', 0, 'F635', 'E1', 'EXAMPLE PACKAGING ASSOCIATION', '2025-07-01', '2025-09-30', '2025-10-30', 8000, 'AB 973', 'https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=901&amendid=0');
    INSERT INTO ca_bill_lobbying (bill_id, filing_id) VALUES ('ca-20252026-ab-973', '900'), ('ca-20252026-ab-973', '901'), ('ca-20252026-ab-1148', '900');
    INSERT INTO ca_lobby_contributions (filing_id, n, form, filer_kind, filer_id, filer_name, recipient_id, recipient_name, date, amount, source_url)
      VALUES ('901', 1, 'F635P4B', 'employer', 'E1', 'EXAMPLE PACKAGING ASSOCIATION', '1477000', 'LEGISLATOR FOR ASSEMBLY 2026', '2025-08-12', 1500, 'https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=901&amendid=0'),
             ('902', 1, 'F615P2', 'lobbyist', 'P9', NULL, '1477000', 'LEGISLATOR FOR ASSEMBLY 2026', '2025-09-01', 250, 'https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid=902&amendid=0');`);
  return db;
}

test("California bill page: employers that listed the bill, amounts with quarters, and their contributions side by side", async () => {
  const db = caDb();
  assert.deepEqual(sessionYears("ca-20252026-ab-973"), [2025, 2026]);
  const l = await caLobbyingFor(db, "ca-20252026-ab-973");
  assert.equal(l.employers.length, 1);
  assert.equal(l.amount, 20000);
  assert.equal(l.givers[0].members[0].member, "Sam Legislator");
  const bill = { id: "ca-20252026-ab-973", level: "state", bill_number: "AB 973" };
  const html = followTheMoney(bill, null, { bare: true, california: caFollowTheMoney(bill, l) });
  assert.match(html, /EXAMPLE PACKAGING ASSOCIATION/);
  assert.match(html, /2 lobbying reports<\/strong> in 2025–2026 that list AB 973/);
  assert.match(html, /latest Q3 2025/);
  assert.match(html, /not only this bill/);
  assert.match(html, /Aug 12, 2025|August 12, 2025/);
  assert.ok(!/lobbied (for|against)/i.test(html));
  // Before the first load: says so.
  assert.match(caFollowTheMoney(bill, { loaded: false }), /haven't been loaded yet/);
});

test("California legislator's Lobbying section: organizations by name with their reports and bills; lobbyists only as totals", async () => {
  const db = caDb();
  const l = await caLobbyingForOfficial(db, "openstates:x");
  assert.equal(l.orgs.length, 1);
  assert.equal(l.orgs[0].lobbying.amount, 20000);
  assert.deepEqual(l.orgs[0].bills.map((b) => b.bill_number), ["AB 973"]);
  assert.deepEqual([l.people.count, l.people.n, l.people.total], [1, 1, 250]);
  const html = caLegislatorLobbying({ name: "Sam Legislator" }, l);
  assert.match(html, /EXAMPLE PACKAGING ASSOCIATION/);
  assert.match(html, /\$20,000 in lobbying payments over 2 quarters/);
  assert.match(html, /href="\/laws\/bills\/ca-20252026-ab-973\/"/);
  assert.match(html, /They aren't named/);
  assert.ok(!/P9/.test(html));
  assert.ok(!/lobbied (for|against)/i.test(html));
});
