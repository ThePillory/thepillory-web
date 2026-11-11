// node --import ./test/sql-stub.mjs --test test/email.test.mjs
// The weekly email (src/email/, functions/email/, functions/api/email.js; docs/email.md):
// each level and section, split ZIPs, empty weeks, the line cap, the wording rules, the
// Sunday send time across daylight saving, the rollout switch, signup, confirm, change,
// unsubscribe, the January district change, and that no address is ever stored.
// The real schema in SQLite; fake mail, Turnstile and Census lookup.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { buildEditions, isoDate, firstSentences } from "../src/email/edition.js";
import { renderEdition, personalize, listHeaders, capped, TOKEN } from "../src/email/render.js";
import { editionKey, placeOf, zipCombos, cdWords } from "../src/email/places.js";
import { pacific, isSendTime, weekOf, comingSunday, weekWords, CRONS } from "../src/email/schedule.js";
import { rollout, everyMinute, buildWeek, sendRound, remapIfNewDistricts, confirmationEmail } from "../src/email/send.js";
import { wordingProblems } from "../src/promises/check.js";
import { onRequestPost as signupPost } from "../../../functions/api/email.js";
import { onRequestGet as emailGet, onRequestPost as emailPost } from "../../../functions/email/[[path]].js";
import { matchedZip } from "../../../functions/api/districts.js";
import { previewPlace } from "../../../functions/_lib/email-admin.js";

const MIG = new URL("../migrations/", import.meta.url);
const WEEK = weekOf("2026-11-15"); // Sun Nov 8 – Sat Nov 14, sent Sun Nov 15
const TODAY = "2026-11-15";

function d1(sqlite) {
  const wrap = (sql, binds = []) => {
    const st = sqlite.prepare(sql);
    return {
      __sql: sql,
      bind: (...b) => wrap(sql, b),
      all: async () => ({ results: st.all(...binds), meta: {} }),
      first: async () => st.get(...binds) ?? null,
      run: async () => {
        const r = st.run(...binds);
        return { meta: { changes: r.changes } };
      },
      _run: () => st.run(...binds),
    };
  };
  return { prepare: (sql) => wrap(sql), batch: async (stmts) => stmts.map((s) => s._run()) };
}

const FILES = {
  "/data/zip/952.json": { 95247: [["CA", "4", "4", "8", "06009", 0.6], ["CA", "5", "4", "8", "06009", 0.4]], 95222: [["CA", "5", "4", "8", "06009", 1]] },
  "/data/zip/953.json": { 95301: [["CA", "5", "4", "8", "06009", 0.5], ["CA", "5", "4", "8", "06077", 0.5]] },
  "/data/zip/750.json": { 75001: [["TX", "24", "16", "115", "48113", 1]] },
  "/data/counties.json": { "06009": ["Calaveras County", "CA"], "06077": ["San Joaquin County", "CA"], 48113: ["Dallas County", "TX"] },
  "/data/elections/dates.json": { states: { CA: [{ date: "2026-12-08", type: "SG", name: "Special election", district: "", offices: ["U.S. House"] }], TX: [] } },
  "/data/scotus/index.json": { terms: [2026, 2025] },
  "/data/scotus/terms/2026.json": { cases: [{ docket: "26A1", name: "Example v. Sample", date: "11/10/2026" }, { docket: "26A2", name: "Earlier v. Case", date: "11/01/2026" }] },
  "/data/scotus/terms/2025.json": { cases: [] },
};
const loadJson = async (p) => (p in FILES ? JSON.parse(JSON.stringify(FILES[p])) : null);

function seeded({ empty = false } = {}) {
  const sqlite = new DatabaseSync(":memory:");
  for (const f of readdirSync(MIG).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, MIG), "utf8"));
  sqlite.exec("CREATE TABLE IF NOT EXISTS sync_state (key TEXT PRIMARY KEY, value TEXT)");
  const off = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, office, level, chamber, body, district, source_url, last_verified, state, district_code, rank)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'https://example.org', '2026-11-01', ?, ?, ?)`
  );
  off.run("s1", "sen-one", "Senator One", "U.S. Senator", "federal", "us-senate", "us-senate", null, "CA", null, null);
  off.run("s2", "sen-two", "Senator Two", "U.S. Senator", "federal", "us-senate", "us-senate", null, "CA", null, null);
  off.run("h4", "rep-four", "Rep Four", "U.S. Representative", "federal", "us-house", "us-house", "CA-4", "CA", "4", null);
  off.run("h5", "rep-five", "Rep Five", "U.S. Representative", "federal", "us-house", "us-house", "CA-5", "CA", "5", null);
  off.run("gov", "gov-ca", "Governor Person", "Governor", "state", "ca-executive", "ca-executive", null, "CA", null, 1);
  off.run("su4", "sen-four", "State Senator Four", "State Senator", "state", "ca-senate", "state-legislature", "Senate District 4", "CA", "4", null);
  off.run("sl8", "asm-eight", "Assemblymember Eight", "State Assemblymember", "state", "ca-assembly", "state-legislature", "Assembly District 8", "CA", "8", null);
  off.run("sup1", "sup-one", "[Supervisor, District 1]", "Supervisor", "county", "county-board", "board-of-supervisors", "District 1", null, "1", null);
  off.run("tx1", "tx-sen", "Texas Senator", "U.S. Senator", "federal", "us-senate", "us-senate", null, "TX", null, null);
  if (empty) return sqlite;
  sqlite.exec(`INSERT INTO bills (id, level, chamber, bill_number, title, session, source_url) VALUES
    ('us-119-hr-1', 'federal', 'us-house', 'H.R. 1', 'An Act to publish permit data', '119', 'https://example.org/b1'),
    ('us-119-hr-2', 'federal', 'us-house', 'H.R. 2', 'An Act about roads', '119', 'https://example.org/b2'),
    ('ca-20252026-ab-9', 'state', 'ca-assembly', 'AB 9', 'An act relating to water', '20252026', 'https://example.org/b3')`);
  sqlite.exec(`INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES
    ('v1', 'us-119-hr-1', 'federal', 'us-house', '2026-11-10', 'On Passage', 'final_passage', 'Passed', 'https://example.org/v1'),
    ('v2', 'us-119-hr-2', 'federal', 'us-house', '2026-11-12', 'On Motion to Recommit', 'procedural', 'Failed', 'https://example.org/v2'),
    ('v3', 'us-119-hr-2', 'federal', 'us-house', '2026-11-02', 'On Passage', 'final_passage', 'Passed', 'https://example.org/v3'),
    ('v4', 'us-119-hr-1', 'federal', 'us-senate', '2026-11-13', 'On Passage', 'final_passage', 'Passed', 'https://example.org/v4')`);
  sqlite.exec(`INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES
    ('v1', 'h5', 'Yes', 'Yea'), ('v1', 'h4', 'No', 'Nay'), ('v2', 'h5', 'No', 'Nay'), ('v3', 'h5', 'Yes', 'Yea'), ('v4', 's1', 'Yes', 'Yea')`);
  sqlite.exec(`INSERT INTO bill_outcomes (bill_id, outcome, action_date, law_number, action_text, actor_id, source_url) VALUES
    ('us-119-hr-1', 'signed', '2026-11-14', 'Public Law 119-50', 'Signed by President.', NULL, 'https://example.org/o1'),
    ('ca-20252026-ab-9', 'vetoed', '2026-11-09', NULL, 'Vetoed by Governor.', 'gov', 'https://example.org/o2')`);
  sqlite.exec(`INSERT INTO executive_actions (id, official_id, kind, number, title, signed_on, source_url) VALUES
    ('fr:2026-1', 'p1', 'executive_order', '14500', 'Publishing Permit Data', '2026-11-11', 'https://example.org/eo'),
    ('fr:2026-2', 'p1', 'executive_order', '14499', 'An Older Order', '2026-11-01', 'https://example.org/eo2')`);
  sqlite.exec(`INSERT INTO trade_reports (id, official_id, chamber, filer_name, filed_on, report_url, source_url) VALUES
    ('house:1', 'h5', 'us-house', 'Rep Five', '2026-11-12', 'https://example.org/ptr', 'https://example.org/ptrs')`);
  sqlite.exec(`INSERT INTO meetings (id, level, source, body, meeting_type, starts_at, status, comment_text, source_url) VALUES
    ('tylermm-1', 'county', 'tylermm', 'Board of Supervisors', 'Regular Meeting', '2026-11-17T09:00', 'scheduled',
     'Members of the public may submit written comments to the Clerk of the Board by noon the day before the meeting. Comments received are made part of the record.', 'https://example.org/m1')`);
  sqlite.exec(`INSERT INTO meeting_items (meeting_id, item_key, number, title, section_kind, sort) VALUES
    ('tylermm-1', '1', '1', 'Approve the minutes', 'consent', 1), ('tylermm-1', '2', '2', 'Road maintenance contract', 'regular', 2), ('tylermm-1', '3', '3', 'Personnel matter', 'closed_session', 3)`);
  return sqlite;
}

const ctx = (sqlite) => ({ db: d1(sqlite), loadJson, week: WEEK, today: TODAY });
const text = (e) => JSON.stringify(e);

// ---------------------------------------------------------------------------
// When it's sent

test("the send time: Sunday 5 p.m. Pacific all year, exactly one of the two UTC crons, across daylight saving", () => {
  assert.deepEqual(CRONS, ["0 0 * * 1", "0 1 * * 1"]);
  // Every Sunday from 2026 into 2028, both daylight saving changes each year.
  let sunday = new Date("2026-01-04T12:00:00Z");
  for (let i = 0; i < 110; i++) {
    const monday = new Date(sunday.getTime() + 86400000).toISOString().slice(0, 10);
    const fires = [`${monday}T00:00:00Z`, `${monday}T01:00:00Z`].filter((t) => isSendTime(new Date(t)));
    assert.equal(fires.length, 1, `the Sunday before ${monday}`);
    const p = pacific(new Date(fires[0]));
    assert.deepEqual([p.weekday, p.hour, p.date], [0, 17, sunday.toISOString().slice(0, 10)]);
    sunday = new Date(sunday.getTime() + 7 * 86400000);
  }
  // March 8, 2026 (clocks forward that morning): Monday 00:00 UTC; November 1 (back): 01:00 UTC.
  assert.equal(isSendTime(new Date("2026-03-09T00:00:00Z")), true);
  assert.equal(isSendTime(new Date("2026-03-09T01:00:00Z")), false);
  assert.equal(isSendTime(new Date("2026-11-02T01:00:00Z")), true);
  assert.equal(isSendTime(new Date("2026-11-02T00:00:00Z")), false);
});

test("the week: the 7 days ending Saturday night Pacific, and the coming Sunday", () => {
  assert.deepEqual(weekOf("2026-11-15"), { week: "2026-11-15", start: "2026-11-08", end: "2026-11-14" });
  assert.equal(comingSunday(new Date("2026-11-11T20:00:00Z")), "2026-11-15");
  assert.equal(comingSunday(new Date("2026-11-16T00:30:00Z")), "2026-11-15", "Sunday 4:30 p.m. Pacific: today");
  assert.equal(comingSunday(new Date("2026-11-16T03:00:00Z")), "2026-11-22", "Sunday 7 p.m. Pacific: next week");
  assert.equal(weekWords("2026-11-08", "2026-11-14"), "Nov 8–14, 2026");
  assert.equal(weekWords("2026-10-25", "2026-10-31"), "Oct 25–31, 2026");
  assert.equal(weekWords("2026-12-27", "2027-01-02"), "Dec 27, 2026–Jan 2, 2027");
});

// ---------------------------------------------------------------------------
// Places and editions

test("edition keys: one per level and place; a split ZIP covers each of its districts", () => {
  assert.equal(editionKey({ level: "national" }), "national");
  assert.equal(editionKey({ level: "zip", zip: "95247" }), "zip-95247");
  assert.equal(editionKey({ level: "exact", st: "MA", cd: "4", su: "Norfolk, Worcester and Middlesex", sl: "7th Middlesex", co: "25017" }), "x-MA-4-Norfolk_Worcester_and_Middlesex-7th_Middlesex-25017");
  const place = placeOf({ level: "zip", zip: "95247" }, zipCombos(FILES["/data/zip/952.json"], "95247"));
  assert.deepEqual(place.cds, ["4", "5"]);
  assert.deepEqual(place.counties, ["06009"]);
  assert.equal(cdWords(place.cds), "Congressional Districts 4 and 5");
  assert.equal(cdWords(["5"]), "Congressional District 5");
  assert.equal(placeOf({ level: "zip", zip: "00000" }, []), null);
});

test("National: executive orders signed, bills that became law and Supreme Court decisions in the week; the subject counts them", async () => {
  const [e] = await buildEditions(ctx(seeded()), [{ key: "national", sub: { level: "national" } }]);
  assert.deepEqual(e.sections.map((s) => s.id), ["national"]);
  const lines = e.sections[0].items.map((i) => i.text);
  assert.deepEqual(lines, ["Publishing Permit Data", "H.R. 1: An Act to publish permit data", "Example v. Sample"]);
  assert.ok(!lines.includes("An Older Order"), "outside the week");
  assert.equal(e.subject, "This week in Washington: 1 law, 1 executive order, 1 Supreme Court decision");
  assert.equal(e.preview, "National edition · Nov 8–14, 2026");
  assert.deepEqual(e.based, { text: "National edition", link: { label: "Personalize it ›", to: "manage" } });
  assert.equal(e.sections[0].items[0].href, "/laws/orders/fr-2026-1/");
  assert.equal(e.sections[0].items[2].href, "/court/cases/2026/26A1/");
});

test("ZIP: senators, every House member the ZIP touches (labeled), the Governor, legislators, the county and the election; reps with nothing get one line", async () => {
  const [e] = await buildEditions(ctx(seeded()), [{ key: "zip-95247", sub: { level: "zip", zip: "95247" } }]);
  assert.deepEqual(e.sections.map((s) => s.id), ["national", "senate", "house", "governor", "county", "elections"]);
  const house = e.sections.find((s) => s.id === "house");
  assert.equal(house.title, "Your U.S. representatives");
  assert.equal(house.note, "Your ZIP covers Congressional Districts 4 and 5");
  assert.deepEqual(house.groups.map((g) => g.name), ["Rep Four", "Rep Five"]);
  const five = house.groups[1];
  assert.deepEqual(five.items.map((i) => [i.text, i.status]), [["H.R. 1: An Act to publish permit data", "Yes"], ["Stock trade report filed", undefined]]);
  assert.ok(!text(five).includes("Recommit"), "procedural votes aren't in it");
  assert.ok(!text(five).includes("2026-11-02"), "votes outside the week aren't in it");
  const senate = e.sections.find((s) => s.id === "senate");
  assert.equal(senate.groups.find((g) => g.name === "Senator Two").empty, "No final-passage votes or new filings this week");
  assert.ok(!/recess/i.test(text(e)), "never says recess without a record of it");
  const gov = e.sections.find((s) => s.id === "governor");
  assert.deepEqual(gov.groups[0].items.map((i) => [i.text, i.status]), [["AB 9: An act relating to water", "Vetoed"]]);
  const county = e.sections.find((s) => s.id === "county");
  assert.equal(county.title, "Calaveras County");
  assert.equal(county.items[0].text, "Board of Supervisors, Regular Meeting");
  assert.ok(!county.items[0].meta.includes("Personnel matter"), "closed session items left out");
  assert.equal(county.quote.text, "Members of the public may submit written comments to the Clerk of the Board by noon the day before the meeting. Comments received are made part of the record.");
  assert.equal(e.sections.find((s) => s.id === "elections").items[0].href, "/ballot/ca/");
  assert.equal(e.based.text, "Based on ZIP 95247, which covers 2 congressional districts");
  assert.equal(e.based.link.label, "Make it exact ›");
  assert.equal(e.preview, "ZIP 95247 · Calaveras County, CA · Nov 8–14, 2026");
  assert.match(e.subject, /^Your representatives this week: 3 votes, 1 law, 1 executive order$/);
  // The state legislators had nothing new: their section is left out.
  assert.ok(!e.sections.some((s) => s.id === "state"));
});

test("address: exact, one representative for each office", async () => {
  const [e] = await buildEditions(ctx(seeded()), [{ key: "x", sub: { level: "exact", st: "CA", cd: "4", su: "4", sl: "8", co: "06009" } }]);
  const house = e.sections.find((s) => s.id === "house");
  assert.deepEqual(house.groups.map((g) => g.name), ["Rep Four"]);
  assert.equal(house.note, null);
  assert.equal(house.title, "Your U.S. representative");
  assert.match(e.based.text, /^Based on your address: Congressional District 4, Senate District 4 and Assembly District 8$/);
});

test("a ZIP partly in the live county gets one line; a state without votes loaded gets 'Coming to'", async () => {
  const eds = await buildEditions(ctx(seeded()), [
    { key: "zip-95301", sub: { level: "zip", zip: "95301" } },
    { key: "zip-75001", sub: { level: "zip", zip: "75001" } },
  ]);
  const county = eds[0].sections.find((s) => s.id === "county");
  assert.equal(county.coming.text, "Part of ZIP 95301 is in Calaveras County, which ThePillory follows meeting by meeting ›");
  assert.equal(county.items.length, 0);
  const tx = eds[1].sections.find((s) => s.id === "state");
  assert.deepEqual(tx.coming, { text: "Coming to Texas: state legislators' votes. Join the list ›", href: "/waitlist/?state=TX" });
});

test("an empty week: nothing new, so the edition isn't sent", async () => {
  const [e] = await buildEditions(ctx(seeded({ empty: true })), [{ key: "national", sub: { level: "national" } }]);
  // Only the Supreme Court decision from the data files; without it, nothing.
  const files = { ...FILES, "/data/scotus/terms/2026.json": { cases: [] } };
  const [none] = await buildEditions({ ...ctx(seeded({ empty: true })), loadJson: async (p) => files[p] ?? null }, [{ key: "national", sub: { level: "national" } }]);
  assert.equal(e.items, 1);
  assert.equal(none.items, 0);
  assert.deepEqual(none.sections, []);
});

test("at most about 15 lines in the email, then 'See everything for your area'; the web version has all", async () => {
  const sqlite = seeded();
  const ins = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES (?, 'us-119-hr-2', 'federal', 'us-house', '2026-11-11', 'On Passage', 'final_passage', 'Passed', 'https://example.org/x')");
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, 'h5', 'Yes', 'Yea')");
  for (let i = 0; i < 20; i++) {
    ins.run(`x${i}`);
    pos.run(`x${i}`);
  }
  const [e] = await buildEditions(ctx(sqlite), [{ key: "zip-95222", sub: { level: "zip", zip: "95222" } }]);
  assert.ok(e.items > 20);
  const { sections, cut } = capped(e);
  const lines = sections.flatMap((s) => [...(s.items || []), ...(s.groups || []).flatMap((g) => (g.items.length ? g.items : [g.empty]))]);
  assert.equal(cut, true);
  assert.ok(lines.length <= 15, `${lines.length} lines`);
  const html = renderEdition(e).html;
  assert.match(html, /See everything for your area on ThePillory ›/);
  assert.match(html, /href="https:\/\/thepillory\.co\/email\/2026-11-15\/zip-95222\/"/);
});

// ---------------------------------------------------------------------------
// The email itself

test("the email: subject, preview, 'based on' line, every line linked to thepillory.co, the footer, one-click unsubscribe, no tracking", async () => {
  const [e] = await buildEditions(ctx(seeded()), [{ key: "zip-95247", sub: { level: "zip", zip: "95247" } }]);
  const r = personalize(renderEdition(e, { mailingAddress: "P.O. Box 1, Town, CA 95000" }), "a".repeat(48));
  assert.ok(!r.html.includes(TOKEN) && !r.text.includes(TOKEN));
  assert.match(r.html, /Based on ZIP 95247, which covers 2 congressional districts · <a href="https:\/\/thepillory\.co\/email\/manage\/\?t=a{48}"[^>]*>Make it exact ›<\/a>/);
  assert.match(r.html, /<div style="display:none[^"]*">ZIP 95247 · Calaveras County, CA · Nov 8–14, 2026<\/div>/);
  for (const [, href] of r.html.matchAll(/href="([^"]+)"/g)) assert.match(href, /^https:\/\/thepillory\.co\//, href);
  assert.match(r.html, /You're getting this because you signed up/);
  assert.match(r.html, /Change my place<\/a> · <a href="https:\/\/thepillory\.co\/email\/unsubscribe\/\?t=a{48}"/);
  assert.match(r.html, /P\.O\. Box 1, Town, CA 95000/);
  assert.match(r.html, /prefers-color-scheme: dark/);
  // The logo is the only image; no tracking pixels or redirecting links.
  assert.deepEqual([...r.html.matchAll(/<img [^>]*src="([^"]+)"/g)].map((m) => m[1]), ["https://thepillory.co/assets/logo/apple-touch-icon.png"]);
  assert.doesNotMatch(r.html, /utm_|track|pixel|open\.gif/i);
  // Plain text: the same lines, each with its link.
  assert.match(r.text, /- H\.R\. 1: An Act to publish permit data \(Yes\)\n  Passed · Nov 10 · On Passage\n  https:\/\/thepillory\.co\/laws\/bills\/us-119-hr-1\//);
  assert.match(r.text, /Unsubscribe: https:\/\/thepillory\.co\/email\/unsubscribe\/\?t=a{48}/);
  assert.deepEqual(listHeaders("a".repeat(48)), { "List-Unsubscribe": `<https://thepillory.co/email/unsubscribe/?t=${"a".repeat(48)}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  // No party colors: the one blue, grays and white.
  const colors = new Set([...r.html.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase()));
  for (const c of colors) assert.ok(["#F2F2F7", "#FFFFFF", "#1D1D1F", "#6E6E73", "#0066CC", "#E5E5EA", "#F5F5F7", "#000000", "#1C1C1E", "#F5F5F7", "#A1A1A6", "#38383A", "#2C2C2E", "#4DA3FF"].includes(c), c);
});

test("wording rules: the email's own words, and the short emails, are plain and neutral", async () => {
  const [e] = await buildEditions(ctx(seeded()), [{ key: "zip-95247", sub: { level: "zip", zip: "95247" } }]);
  const r = renderEdition(e, { mailingAddress: "P.O. Box 1" });
  const banned = /\b(?:slam\w*|blast\w*|radical|extreme|outrage\w*|shocking|scandal\w*|corrupt\w*|bought|paid for|fair share|loophole|dodg\w*|best|worst|ranked|ranking)\b/i;
  for (const t of [r.text, confirmationEmail({}, { token: "x" }).text]) {
    assert.deepEqual(wordingProblems(t), []);
    assert.doesNotMatch(t, banned);
  }
  assert.doesNotMatch(r.html, /\b(Republican|Democrat|GOP|liberal|conservative)\b/i);
});

test("small helpers: dates, quotes cut only at sentence ends, the ZIP a geocoder match carries", () => {
  assert.equal(isoDate("11/10/2026"), "2026-11-10");
  assert.equal(isoDate("2026-11-10"), "2026-11-10");
  assert.equal(isoDate("soon"), null);
  const long = "First sentence here. " + "Second sentence goes on. ".repeat(30);
  assert.match(firstSentences(long, 60), /^First sentence here\. Second sentence goes on\.$/);
  assert.equal(matchedZip({ addressComponents: { zip: "95247" } }), "95247");
  assert.equal(matchedZip({ matchedAddress: "1 MAIN ST, MURPHYS, CA, 95247-1234" }), "95247");
  assert.equal(matchedZip({}), null);
  assert.deepEqual(previewPlace((k) => ({ level: "exact", st: "ca", cd: "5", su: "4", sl: "8", co: "06009" })[k] || ""), { level: "exact", zip: null, st: "CA", cd: "5", su: "4", sl: "8", co: "06009" });
});

// ---------------------------------------------------------------------------
// Sending

function mailer() {
  const sent = [];
  return { sent, EMAIL: { send: async (m) => (sent.push(m), { messageId: String(sent.length) }) } };
}

test("rollout: off sends only to ALERT_TO, pilot adds EMAIL_PILOT, on everyone", () => {
  const base = { ALERT_TO: "Admin@Example.org" };
  assert.equal(rollout(base).mode, "off");
  assert.equal(rollout(base).allowed("admin@example.org"), true);
  assert.equal(rollout(base).allowed("someone@example.org"), false);
  assert.equal(rollout({ ...base, EMAIL_SENDING: "pilot", EMAIL_PILOT: "a@x.org, b@x.org" }).allowed("b@x.org"), true);
  assert.equal(rollout({ ...base, EMAIL_SENDING: "pilot", EMAIL_PILOT: "a@x.org" }).allowed("c@x.org"), false);
  assert.equal(rollout({ ...base, EMAIL_SENDING: "on" }).allowed("c@x.org"), true);
  assert.equal(rollout({ ...base, EMAIL_SENDING: "yes please" }).mode, "off");
});

function subscriber(sqlite, email, level, extra = {}, confirmed = true) {
  const token = (email.replace(/\W/g, "") + "0".repeat(48)).slice(0, 48).replace(/[^a-f0-9]/g, "a");
  sqlite
    .prepare("INSERT INTO email_subscribers (email, level, zip, st, cd, su, sl, co, token, confirmed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
    .run(email, level, extra.zip ?? null, extra.st ?? null, extra.cd ?? null, extra.su ?? null, extra.sl ?? null, extra.co ?? null, token, confirmed ? "2026-11-01" : null);
  return token;
}

test("confirmations: sent within a minute while sending allows it; held otherwise, not expired", async () => {
  const sqlite = seeded();
  subscriber(sqlite, "admin@example.org", "national", {}, false);
  subscriber(sqlite, "reader@example.org", "national", {}, false);
  const m = mailer();
  const env = { ...m, ALERT_TO: "admin@example.org", EMAIL_SENDING: "off", MAILING_ADDRESS: "P.O. Box 1" };
  const r = await everyMinute(env, d1(sqlite));
  assert.deepEqual([r.confirmations, r.held], [1, 1]);
  assert.deepEqual(m.sent.map((x) => x.to), ["admin@example.org"]);
  assert.match(m.sent[0].text, /https:\/\/thepillory\.co\/email\/confirm\/\?t=/);
  // Again: the admin's confirmation isn't sent twice; the reader's waits.
  await everyMinute(env, d1(sqlite));
  assert.equal(m.sent.length, 1);
  await everyMinute({ ...env, EMAIL_SENDING: "on" }, d1(sqlite));
  assert.deepEqual(m.sent.map((x) => x.to), ["admin@example.org", "reader@example.org"]);
  // Unconfirmed 7 days after the confirmation went out: deleted.
  sqlite.exec("UPDATE email_subscribers SET confirm_sent_at = datetime('now', '-8 days')");
  await everyMinute(env, d1(sqlite));
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_subscribers").get().n, 0);
});

test("the weekly send: each edition built once, sent to everyone who shares it, never twice; empty editions skipped", async () => {
  const sqlite = seeded();
  subscriber(sqlite, "a@example.org", "zip", { zip: "95247" });
  subscriber(sqlite, "b@example.org", "zip", { zip: "95247" });
  subscriber(sqlite, "c@example.org", "national");
  subscriber(sqlite, "d@example.org", "zip", { zip: "95247" }, false); // not confirmed
  const m = mailer();
  const env = { ...m, ALERT_TO: "admin@example.org", EMAIL_SENDING: "on", SITE_URL: "https://x" };
  globalThis.fetch = async (url) => ({ ok: url.replace("https://x", "") in FILES, json: async () => FILES[url.replace("https://x", "")] });
  const built = await buildWeek(env, d1(sqlite), "2026-11-15", TODAY);
  assert.equal(built.built, 2, "national and zip-95247");
  const r1 = await sendRound(env, d1(sqlite), "2026-11-15", { limit: 2 });
  const r2 = await sendRound(env, d1(sqlite), "2026-11-15");
  const r3 = await sendRound(env, d1(sqlite), "2026-11-15");
  assert.deepEqual([r1.sent, r2.sent, r3.sent], [2, 2, 0]);
  assert.deepEqual(m.sent.map((x) => x.to).sort(), ["a@example.org", "admin@example.org", "b@example.org", "c@example.org"]);
  const a = m.sent.find((x) => x.to === "a@example.org");
  assert.match(a.subject, /^Your representatives this week:/);
  assert.equal(a.headers["List-Unsubscribe-Post"], "List-Unsubscribe=One-Click");
  assert.equal(sqlite.prepare("SELECT sent FROM email_editions WHERE edition_key = 'zip-95247'").get().sent, 2);
  // Sending off: only ALERT_TO, the National edition (a fresh database, the same week).
  const fresh = seeded();
  subscriber(fresh, "a@example.org", "zip", { zip: "95247" });
  const m2 = mailer();
  const off = { ...env, ...m2, EMAIL_SENDING: "off" };
  await buildWeek(off, d1(fresh), "2026-11-15", TODAY);
  await sendRound(off, d1(fresh), "2026-11-15");
  assert.deepEqual(m2.sent.map((x) => [x.to, x.subject]), [["admin@example.org", "This week in Washington: 1 law, 1 executive order, 1 Supreme Court decision"]]);
  // The next week has nothing new: built, and not sent.
  const m3 = mailer();
  const next = await buildWeek({ ...off, ...m3 }, d1(fresh), "2026-11-22", TODAY);
  await sendRound({ ...off, ...m3 }, d1(fresh), "2026-11-22");
  assert.deepEqual([next.keys, next.empty, m3.sent.length], [[], 1, 0]);
});

test("January: new districts re-map exact subscribers from their ZIP; a ZIP now split asks once to confirm", async () => {
  const sqlite = seeded();
  subscriber(sqlite, "one@example.org", "exact", { zip: "95222", st: "CA", cd: "3", su: "1", sl: "1", co: "06009" });
  subscriber(sqlite, "split@example.org", "exact", { zip: "95247", st: "CA", cd: "4", su: "4", sl: "8", co: "06009" });
  const m = mailer();
  const env = { ...m, ALERT_TO: "admin@example.org", EMAIL_SENDING: "on", CENSUS_VINTAGE: "ACS2025_Current" };
  const first = await remapIfNewDistricts(env, d1(sqlite), loadJson);
  assert.equal(first.first, true, "the first run only records the vintage");
  const r = await remapIfNewDistricts({ ...env, CENSUS_VINTAGE: "ACS2027_Current" }, d1(sqlite), loadJson);
  assert.deepEqual([r.remapped, r.split], [1, 1]);
  const one = sqlite.prepare("SELECT level, cd, su, sl FROM email_subscribers WHERE email = 'one@example.org'").get();
  assert.deepEqual({ ...one }, { level: "exact", cd: "5", su: "4", sl: "8" });
  const split = sqlite.prepare("SELECT level, zip, cd, place_check_sent_at FROM email_subscribers WHERE email = 'split@example.org'").get();
  assert.equal(split.level, "zip");
  assert.equal(split.zip, "95247");
  assert.equal(split.cd, null);
  assert.ok(split.place_check_sent_at);
  assert.deepEqual(m.sent.map((x) => [x.to, x.subject]), [["split@example.org", "Your districts changed: confirm your place"]]);
  // Again with the same vintage: nothing more.
  const again = await remapIfNewDistricts({ ...env, CENSUS_VINTAGE: "ACS2027_Current" }, d1(sqlite), loadJson);
  assert.deepEqual([again.remapped, again.split], [0, 0]);
});

// ---------------------------------------------------------------------------
// Signup, confirm, change, unsubscribe (the website)

function site(sqlite, { census = null } = {}) {
  const env = {
    DB: d1(sqlite),
    TURNSTILE_SITE_KEY: "site",
    TURNSTILE_SECRET_KEY: "secret",
    ASSETS: { fetch: async (u) => {
      const p = new URL(u).pathname;
      return p in FILES ? new Response(JSON.stringify(FILES[p])) : new Response("", { status: 404 });
    } },
  };
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes("challenges.cloudflare.com")) return new Response(JSON.stringify({ success: true }));
    if (u.includes("geocoding.geo.census.gov")) return new Response(JSON.stringify(census || { result: { addressMatches: [] } }));
    return new Response("", { status: 404 });
  };
  return env;
}

const post = (path, fields) => {
  const body = new FormData();
  for (const [k, v] of Object.entries(fields)) body.append(k, v);
  return new Request(`https://thepillory.co${path}`, { method: "POST", body, headers: { Origin: "https://thepillory.co", "CF-Connecting-IP": "203.0.113.9" } });
};
const params = (path) => ({ path: path.split("/").filter(Boolean).slice(1) });

const CENSUS = {
  result: {
    addressMatches: [
      {
        matchedAddress: "123 MAIN ST, MURPHYS, CA, 95247",
        addressComponents: { zip: "95247" },
        geographies: {
          "119th Congressional Districts": [{ STATE: "06", BASENAME: "5" }],
          "2024 State Legislative Districts - Upper": [{ BASENAME: "4" }],
          "2024 State Legislative Districts - Lower": [{ BASENAME: "8" }],
          Counties: [{ STATE: "06", GEOID: "06009", NAME: "Calaveras County" }],
        },
      },
    ],
  },
};

test("signup: email only, a ZIP, or an address; the address is used once and never stored", async () => {
  const sqlite = seeded();
  const env = site(sqlite, { census: CENSUS });
  const go = async (fields) => (await signupPost({ request: post("/api/email", { "cf-turnstile-response": "ok", ...fields }), env })).headers.get("Location");
  assert.match(await go({ email: "National@Example.org", level: "national" }), /\/email\/\?sent=1#signup$/);
  assert.match(await go({ email: "zip@example.org", level: "zip", zip: "95247" }), /sent=1/);
  assert.match(await go({ email: "bad@example.org", level: "zip", zip: "99999" }), /error=zip/);
  assert.match(await go({ email: "addr@example.org", level: "address", address: "123 Main St, Murphys, CA" }), /sent=1/);
  assert.match(await go({ email: "not an email", level: "national" }), /error=email/);
  const rows = sqlite.prepare("SELECT email, level, zip, st, cd, su, sl, co, confirmed_at FROM email_subscribers ORDER BY id").all().map((r) => ({ ...r }));
  assert.deepEqual(rows, [
    { email: "national@example.org", level: "national", zip: null, st: null, cd: null, su: null, sl: null, co: null, confirmed_at: null },
    { email: "zip@example.org", level: "zip", zip: "95247", st: null, cd: null, su: null, sl: null, co: null, confirmed_at: null },
    { email: "addr@example.org", level: "exact", zip: "95247", st: "CA", cd: "5", su: "4", sl: "8", co: "06009", confirmed_at: null },
  ]);
  // The address is nowhere in the database: no table, no column.
  for (const { name } of sqlite.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    for (const row of sqlite.prepare(`SELECT * FROM "${name}"`).all()) assert.ok(!/main st/i.test(JSON.stringify(row)), `${name} holds the address`);
  }
  assert.ok(!sqlite.prepare("PRAGMA table_info(email_subscribers)").all().some((c) => /address/i.test(c.name)));
  // The per-visitor daily limit: 5 sign-ups a day (3 so far).
  assert.match(await go({ email: "four@example.org", level: "national" }), /sent=1/);
  assert.match(await go({ email: "five@example.org", level: "national" }), /sent=1/);
  assert.match(await go({ email: "six@example.org", level: "national" }), /error=limit/);
});

test("confirm, Change my place and unsubscribe: buttons, not clicks; unsubscribe deletes the row; one-click POST works", async () => {
  const sqlite = seeded();
  const token = subscriber(sqlite, "me@example.org", "national", {}, false);
  const env = site(sqlite, { census: CENSUS });
  const get = (path) => emailGet({ request: new Request(`https://thepillory.co${path}`), env, params: params(path.split("?")[0]) });
  const send = (path, fields) => emailPost({ request: post(path, fields), env, params: params(path.split("?")[0]) });
  // Opening the link doesn't confirm: a mail scanner can't.
  let res = await get(`/email/confirm/?t=${token}`);
  assert.match(await res.text(), /<form method="post" action="\/email\/confirm\/\?t=[a-f0-9]{48}"><button[^>]*>Confirm<\/button>/);
  assert.equal(sqlite.prepare("SELECT confirmed_at FROM email_subscribers").get().confirmed_at, null);
  assert.equal(res.headers.get("Cache-Control"), "no-store");
  assert.match(res.headers.get("X-Robots-Tag"), /noindex/);
  res = await send(`/email/confirm/?t=${token}`, {});
  assert.match(await res.text(), /You're signed up/);
  assert.ok(sqlite.prepare("SELECT confirmed_at FROM email_subscribers").get().confirmed_at);
  // Change my place: to an address, then back to email only.
  res = await send(`/email/manage/?t=${token}`, { level: "address", address: "123 Main St, Murphys, CA" });
  assert.match(await res.text(), /Saved\. It(?:'|&#39;|&#x27;)s based on your address(?:'|&#39;|&#x27;)s districts/);
  assert.deepEqual({ ...sqlite.prepare("SELECT level, zip, cd FROM email_subscribers").get() }, { level: "exact", zip: "95247", cd: "5" });
  res = await send(`/email/manage/?t=${token}`, { level: "national" });
  assert.deepEqual({ ...sqlite.prepare("SELECT level, zip, cd FROM email_subscribers").get() }, { level: "national", zip: null, cd: null });
  // Unsubscribe: the link shows a button; the POST (or a mail app's one-click POST) deletes the row.
  res = await get(`/email/unsubscribe/?t=${token}`);
  assert.match(await res.text(), />Unsubscribe<\/button>/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_subscribers").get().n, 1);
  const oneClick = new Request(`https://thepillory.co/email/unsubscribe/?t=${token}`, { method: "POST", body: "List-Unsubscribe=One-Click", headers: { "Content-Type": "application/x-www-form-urlencoded" } });
  res = await emailPost({ request: oneClick, env, params: params("/email/unsubscribe/") });
  assert.match(await res.text(), /You're unsubscribed/);
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_subscribers").get().n, 0);
  // A bad or old token: an honest page, nothing changed.
  res = await get(`/email/manage/?t=${"f".repeat(48)}`);
  assert.equal(res.status, 404);
  assert.match(await res.text(), /That link has expired/);
});

test("the web version of an edition, in the site's cards", async () => {
  const sqlite = seeded();
  const [e] = await buildEditions(ctx(sqlite), [{ key: "national", sub: { level: "national" } }]);
  sqlite.prepare("INSERT INTO email_editions (week, edition_key, subject, preview, items, body) VALUES (?, ?, ?, ?, ?, ?)").run("2026-11-15", "national", e.subject, e.preview, e.items, JSON.stringify(e));
  const env = site(sqlite);
  const res = await emailGet({ request: new Request("https://thepillory.co/email/2026-11-15/national/"), env, params: { path: ["2026-11-15", "national"] } });
  const html = await res.text();
  assert.equal(res.status, 200);
  assert.match(html, /<section class="card stack-sm"><h2 class="h3">In Washington<\/h2>/);
  assert.match(html, /href="\/laws\/orders\/fr-2026-1\/"/);
  const missing = await emailGet({ request: new Request("https://thepillory.co/email/2026-11-15/zip-00000/"), env, params: { path: ["2026-11-15", "zip-00000"] } });
  assert.equal(missing.status, 404);
});
