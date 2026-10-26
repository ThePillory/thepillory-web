// node --import ./test/sql-stub.mjs --test test/records.test.mjs
// Public Records & Investigations, phase 1 (docs/records-tab-spec.md): the
// RECORDS_TAB flag, the tier definitions and disclaimer pages, the records_
// tables' rules, and the roles-only subject config.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync } from "node:fs";
import { onRequestGet as tiers } from "../../../functions/about/records/tiers/index.js";
import { onRequestGet as disclaimer } from "../../../functions/about/records/disclaimer/index.js";
import { recordsOn, BANNER, TIERS, CORRECTION_DAYS } from "../../../functions/_lib/records.js";

const get = async (handler, env) => {
  const res = await handler({ request: new Request("https://thepillory.test/about/records/"), env });
  return { status: res.status, html: await res.text() };
};

test("the flag: off unless RECORDS_TAB is exactly on", () => {
  for (const v of [undefined, "", "off", "true", "1", "yes"]) assert.equal(recordsOn({ RECORDS_TAB: v }), false, String(v));
  for (const v of ["on", "ON", " on "]) assert.equal(recordsOn({ RECORDS_TAB: v }), true, v);
  assert.equal(recordsOn(undefined), false);
});

test("both pages are hidden while the flag is off", async () => {
  for (const h of [tiers, disclaimer]) {
    const r = await get(h, {});
    assert.equal(r.status, 404);
    assert.doesNotMatch(r.html, /Evidence tiers|Disclaimer<\/h1>/);
  }
});

test("the tier definitions page: five tiers, the rules and the banner", async () => {
  const { status, html } = await get(tiers, { RECORDS_TAB: "on" });
  assert.equal(status, 200);
  assert.ok(html.includes(BANNER));
  for (const t of TIERS) assert.ok(html.includes(`id="tier-${t.n}"`) && html.includes(t.name), t.name);
  assert.equal(TIERS.length, 5);
  assert.match(html, /Hearsay stays at Tier 1/);
  assert.match(html, /never shown/, "no raw mention counts");
  assert.match(html, /June 30, 2008/);
  assert.match(html, /href="\/about\/records\/disclaimer\/"/);
});

test("the disclaimer: the line, legal proceedings, victims, AI, and 14 days", async () => {
  const { status, html } = await get(disclaimer, { RECORDS_TAB: "on" });
  assert.equal(status, 200);
  assert.ok(html.includes(BANNER));
  assert.match(html, /not a finding of fact/);
  assert.match(html, /never publishes or stores the identity of a victim or survivor/);
  assert.match(html, /redactions stay redacted/);
  assert.match(html, /never decides what&#x27;s published|never decides what's published/);
  assert.equal(CORRECTION_DAYS, 14);
  assert.match(html, /within 14 days/);
  assert.match(html, /never who asked/);
  assert.doesNotMatch(html, /<h2[^>]*>[^<]*(Top|Rank)/i, "no rankings");
});

function db() {
  const s = new DatabaseSync(":memory:");
  s.exec("PRAGMA foreign_keys = ON; CREATE TABLE officials (id TEXT PRIMARY KEY);");
  s.exec(readFileSync(new URL("../migrations/0042_records.sql", import.meta.url), "utf8"));
  s.exec(`INSERT INTO officials VALUES ('bioguide:X000001');
    INSERT INTO records_datasets (id, name, source_url) VALUES ('ds', 'Test dataset', 'https://example.gov/release');
    INSERT INTO records_subjects (id, official_id, display_name) VALUES ('s1', 'bioguide:X000001', 'Test Official');
    INSERT INTO records_documents (id, dataset_id, r2_key, source_type, original_url) VALUES ('d1', 'ds', 'k', 'flight_log', 'https://example.gov/d1.pdf');`);
  return s;
}
const mention = (s, extra) => {
  const row = { id: "m1", document_id: "d1", subject_id: "s1", role: "listed", match_confidence: 0.99, ...extra };
  const cols = Object.keys(row);
  s.prepare(`INSERT INTO records_mentions (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(...Object.values(row));
};

test("records_ tables: every dataset, document and statement has an http(s) link", () => {
  const s = db();
  assert.throws(() => s.exec("INSERT INTO records_datasets (id, name) VALUES ('x', 'No link')"), /NOT NULL/);
  assert.throws(() => s.exec("INSERT INTO records_documents (id, dataset_id, r2_key, source_type, original_url) VALUES ('d2', 'ds', 'k', 'other', 'ftp://x')"), /CHECK/);
  assert.throws(() => s.exec("INSERT INTO records_documents (id, dataset_id, r2_key, source_type) VALUES ('d3', 'ds', 'k', 'other')"), /NOT NULL/);
  assert.throws(() => s.exec("INSERT INTO records_statements (id, subject_id, dataset_id, quote, stated_at, source_name, source_url) VALUES ('q', 's1', 'ds', 'x', '2026-01-01', 'n', 'not a link')"), /CHECK/);
  assert.throws(() => s.exec("INSERT INTO records_documents (id, dataset_id, r2_key, source_type, original_url) VALUES ('d4', 'ds', 'k', 'gossip', 'https://x')"), /CHECK/, "only the spec's source types");
});

test("records_ tables: tiers 1 to 5, short excerpts, and Tier 2+ approved only with a reviewer", () => {
  const s = db();
  assert.throws(() => mention(s, { tier: 6 }), /CHECK/);
  assert.throws(() => mention(s, { excerpt: "x".repeat(301) }), /CHECK/);
  assert.throws(() => mention(s, { match_confidence: 1.5 }), /CHECK/);
  assert.throws(() => mention(s, { tier: 2, review_status: "approved" }), /CHECK/, "no reviewer");
  mention(s, { tier: 2, review_status: "approved", reviewed_by: "Reviewer", reviewed_at: "2026-10-26" });
  mention(s, { id: "m2", tier: 1, review_status: "approved", match_confidence: 0.97 });
  assert.throws(() => s.exec("INSERT INTO records_subjects (id, official_id, display_name) VALUES ('s2', 'bioguide:NOPE', 'Nobody')"), /FOREIGN KEY/, "subjects link to a real profile");
  assert.throws(() => s.exec("INSERT INTO records_corrections (id, summary, status) VALUES ('c', 'x', 'ignored')"), /CHECK/);
});

test("the subject config: roles only for now, each with no names yet", () => {
  const cfg = JSON.parse(readFileSync(new URL("../../../data/records/subjects.json", import.meta.url), "utf8"));
  assert.deepEqual(cfg.roles.map((r) => r.id), ["cabinet", "white-house-senior-staff", "house-leadership", "senate-leadership"]);
  for (const r of cfg.roles) {
    assert.deepEqual(r.subjects, [], `${r.id}: people are filled in from official sources before the pilot`);
    assert.ok(r.official_source === null || /^https:\/\//.test(r.official_source));
  }
  assert.equal(cfg.roles.find((r) => r.id === "white-house-senior-staff").has_profiles, false);
});
