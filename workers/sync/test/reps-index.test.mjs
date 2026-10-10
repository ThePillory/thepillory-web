// node --test test/reps-index.test.mjs
// The Reps tab (/reps/): Your representatives (districts saved; only a state
// known; nothing known), Search (officials, justices, candidates), and Browse
// (Federal / State / Courts), 25 at a time, the same layout for every state.
// Served from the real schema in SQLite and the repo's static files.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { yourList, stateChambers, repsHref, PER_PAGE } from "../../../functions/_lib/reps-index.js";
import { cleanQuery, nameMatches, matchCandidates, matchJustices } from "../../../functions/_lib/people-search.js";
import { districtKey } from "../src/states.js";

const ROOT = new URL("../../../", import.meta.url);
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};

const queries = [];
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => (queries.push(sql), { results: sqlite.prepare(sql).all(...binds) }),
    first: async () => (queries.push(sql), sqlite.prepare(sql).get(...binds) ?? null),
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return { prepare: (sql) => stmt(sql) };
}

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  const ins = sqlite.prepare(
    `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, district_code, party, state, rank, source_url, last_verified, active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'https://example.org/o', '2026-10-01', 1)`
  );
  const add = (slug, name, office, level, chamber, { district = null, code = null, party = null, st = null, rank = null } = {}) =>
    ins.run(slug, slug, name, name.split(" ").pop(), office, level, chamber, chamber, district, code, party, st, rank);
  add("test-president", "Test President", "President of the United States", "federal", "us-executive", { rank: 1 });
  add("test-vice", "Test Vice", "Vice President of the United States", "federal", "us-executive", { rank: 2 });
  add("test-secretary", "Test Secretary", "Secretary of Example", "federal", "us-executive", { rank: 10 });
  for (const st of ["WA", "CA", "TX"]) {
    add(`${st.toLowerCase()}-senator-one`, `${st} Senator Alpha`, "U.S. Senator", "federal", "us-senate", { party: "Party A", st });
    add(`${st.toLowerCase()}-senator-two`, `${st} Senator Beta`, "U.S. Senator", "federal", "us-senate", { party: "Party B", st });
    add(`${st.toLowerCase()}-governor`, `${st} Governor Gamma`, "Governor", "state", st === "CA" ? "ca-executive" : `${st.toLowerCase()}-executive`, { st, rank: 1 });
  }
  add("ca-house-five", "CA Representative Five", "U.S. Representative", "federal", "us-house", { district: "CA-5", code: "5", st: "CA" });
  add("ca-house-six", "CA Representative Six", "U.S. Representative", "federal", "us-house", { district: "CA-6", code: "6", st: "CA" });
  add("ca-state-senator", "CA StateSenator Four", "State Senator", "state", "ca-senate", { district: "Senate District 4", code: districtKey("CA", "upper", "4"), st: "CA" });
  add("ca-assembly", "CA Assemblymember Eight", "Assemblymember", "state", "ca-assembly", { district: "Assembly District 8", code: districtKey("CA", "lower", "8"), st: "CA" });
  // A chamber longer than one page.
  for (let i = 1; i <= 30; i++) add(`wa-senator-${i}`, `WA Member${String(i).padStart(2, "0")}`, "State Senator", "state", "wa-upper", { district: `Senate District ${i}`, code: String(i), st: "WA" });
  return d1(sqlite);
}

const reps = (await import("../../../functions/reps/[[path]].js")).onRequestGet;
async function get(path, { cookie = "", cf = null, db = seeded() } = {}) {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await reps({ request, env: { DB: db, ASSETS }, params: { path: parts }, waitUntil: () => {} });
  return { res, html: await res.text() };
}
const section = (html, id) => {
  const at = html.indexOf(`id="${id}"`);
  if (at < 0) return "";
  const open = html.lastIndexOf("<", at);
  const end = html.indexOf("</section>", at);
  return html.slice(open, end < 0 ? undefined : end);
};
const CA_COOKIE = `pillory_districts=${encodeURIComponent("st=CA&cd=5&su=4&sl=8&co=06009")}`;

test("a Washington connection, nothing saved: Washington's statewide officials and the ZIP prompt, no guessed district", async () => {
  const { res, html } = await get("/reps/", { cf: { country: "US", regionCode: "WA" } });
  assert.equal(res.status, 200);
  const yours = section(html, "yours");
  assert.match(yours, /Your representatives/);
  assert.match(yours, /Washington/);
  for (const n of ["Test President", "Test Vice", "WA Senator Alpha", "WA Senator Beta", "WA Governor Gamma"]) assert.ok(yours.includes(n), n);
  assert.ok(yours.indexOf("Test President") < yours.indexOf("WA Senator Alpha") && yours.indexOf("WA Senator Beta") < yours.indexOf("WA Governor Gamma"), "in order");
  assert.match(yours, /Add your ZIP or address to see your House member and state legislators\./);
  assert.match(yours, /data-district-lookup/);
  assert.doesNotMatch(yours, /WA Member|Representative|Test Secretary/, "no district guessed, no Cabinet");
});

test("California districts saved: every level, in order, each linked", async () => {
  const { res, html } = await get("/reps/", { cookie: CA_COOKIE });
  assert.match(res.headers.get("Cache-Control") || "", /private/);
  const yours = section(html, "yours");
  const order = ["Test President", "Test Vice", "CA Senator Alpha", "CA Senator Beta", "CA Representative Five", "CA Governor Gamma", "CA StateSenator Four", "CA Assemblymember Eight"].map((n) => yours.indexOf(n));
  assert.ok(order.every((n, i) => n > 0 && (i === 0 || n > order[i - 1])), `order ${order}`);
  assert.doesNotMatch(yours, /CA Representative Six/);
  assert.match(yours, /href="\/reps\/ca-house-five\/"[\s\S]*?U\.S\. Representative · CA-5/);
});

test("nothing known: only the lookup", async () => {
  const { html } = await get("/reps/");
  assert.equal(section(html, "yours"), "");
  assert.match(html, /data-district-lookup/);
  assert.match(html, /id="search"/);
});

test("/reps/?state=TX: members of Congress for Texas, filterable; the President and Cabinet", async () => {
  const { html } = await get("/reps/?state=TX");
  const browse = section(html, "browse");
  assert.match(browse, /aria-current="true">Federal</);
  assert.match(browse, /<option value="TX" selected>Texas<\/option>/);
  const senate = html.slice(html.indexOf('id="list-us-senate"'), html.indexOf('id="list-us-house"'));
  assert.ok(senate.includes("TX Senator Alpha") && senate.includes("TX Senator Beta"));
  assert.doesNotMatch(senate, /CA Senator|WA Senator/);
  assert.match(senate, /Party: Party A/, "party as plain text");
  assert.match(html, /Test Secretary/);
  assert.match(html, /id="state-list"/, "old #state-list links still land on the list");
});

test("State: the state's own chamber names, statewide offices, 25 at a time with Load more", async () => {
  const { html } = await get("/reps/?browse=state&state=WA");
  assert.match(html, /Washington Senate/);
  assert.match(html, /WA Governor Gamma/);
  const list = html.slice(html.indexOf('id="list-wa-upper"'), html.indexOf('data-load-more="list-wa-upper"'));
  assert.equal((list.match(/href="\/reps\/wa-senator-/g) || []).length, PER_PAGE);
  assert.match(html, /WA Member01[\s\S]*WA Member02/, "by last name");
  assert.match(html, new RegExp(`href="/reps/\\?browse=state&amp;state=WA&amp;chamber=wa-upper&amp;offset=${PER_PAGE}" data-load-more="list-wa-upper"`));
  const more = await get(`/reps/?browse=state&state=WA&chamber=wa-upper&offset=${PER_PAGE}`);
  assert.equal((more.html.match(/href="\/reps\/wa-senator-/g) || []).length, 30 - PER_PAGE);
  assert.match(more.html, /id="list-wa-upper"/);
  assert.doesNotMatch(more.html, /data-load-more=/);
  const byDistrict = await get("/reps/?browse=state&state=WA&sort=district");
  assert.ok(byDistrict.html.indexOf("wa-senator-2/") < byDistrict.html.indexOf("wa-senator-10/"), "district 2 before 10");
});

test("chamber names: Assembly in California, House of Delegates in Virginia, one chamber in Nebraska", () => {
  assert.deepEqual(stateChambers("CA").map((c) => c.name), ["California Senate", "California Assembly"]);
  assert.deepEqual(stateChambers("VA").map((c) => c.name), ["Virginia Senate", "Virginia House of Delegates"]);
  assert.deepEqual(stateChambers("NE").map((c) => c.name), ["Nebraska Legislature"]);
  assert.equal(repsHref({ browse: "state", state: "VA", sort: "name" }), "/reps/?browse=state&state=VA");
});

test("Courts: the justices, from the Court's own list", async () => {
  const { html } = await get("/reps/?browse=courts");
  const browse = section(html, "browse");
  assert.match(browse, /href="\/justices\/[a-z-]+\/"/);
  assert.match(browse, /Chief Justice/);
});

test("search: officials, justices and candidates by name; never every official", async () => {
  queries.length = 0;
  const { html } = await get("/reps/?q=senator%20alpha");
  const found = section(html, "search");
  assert.match(found, /CA Senator Alpha/);
  assert.match(found, /TX Senator Alpha/);
  assert.doesNotMatch(found, /Senator Beta/);
  const j = await get("/reps/?q=roberts");
  assert.match(section(j.html, "search"), /href="\/justices\/john-roberts\/"/);
  assert.equal(cleanQuery(" a "), null);
  assert.equal(cleanQuery("  Ann   Lee "), "Ann Lee");
  assert.ok(nameMatches("Jane Q. Example", "jane example"));
  const cands = matchCandidates([["H6CA01251", "EXAMPLE, JANE", "CA", "H", "01"], ["S6TX00001", "OTHER, PAT", "TX", "S", ""]], "jane");
  assert.deepEqual(cands, [{ type: "Candidate", name: "Jane Example", sub: "U.S. House · CA-1", href: "/candidates/H6CA01251/" }]);
  assert.deepEqual(matchJustices([{ slug: "a-b", name: "A B", title: "Associate Justice" }], "b").map((x) => x.href), ["/justices/a-b/"]);
  // Every query that reads officials is narrowed (a chamber, a state, districts) or capped.
  for (const sql of queries.filter((s) => /FROM officials/.test(s))) assert.match(sql, /LIMIT|chamber = \?|o\.active = 1 AND \(/, sql);
});

test("Quick mode: Your representatives and Search stay; Browse sits behind Browse all", async () => {
  const { html } = await get("/reps/", { cf: { country: "US", regionCode: "WA" } });
  assert.match(html, /<div class="simple-scope">/);
  assert.match(html, /<section class="stack-sm simple-keep" id="yours"/);
  assert.match(html, /<section class="stack-sm simple-keep" id="search"/);
  assert.match(html, /<section class="stack-sm" id="browse"/);
  assert.match(html, /class="simple-only simple-keep"><button class="btn" type="button" data-mode-set="detailed" data-mode-jump="browse">Browse all<\/button>/);
});

test("yourList puts the offices in order and skips what isn't there", () => {
  const o = (slug, chamber, extra = {}) => ({ slug, name: slug, chamber, ...extra });
  const list = yourList({
    federalExec: [o("p", "us-executive", { rank: 1 }), o("c", "us-executive", { rank: 10 }), o("v", "us-executive", { rank: 2 })],
    reps: [o("county", "county-board"), o("lower", "tx-lower"), o("house", "us-house"), o("s", "us-senate"), o("upper", "tx-upper")],
    stateExec: [o("ag", "tx-executive", { rank: 3, office: "Attorney General" }), o("g", "tx-executive", { rank: 1, office: "Governor" })],
  });
  assert.deepEqual(list.map((x) => x.slug), ["p", "v", "s", "house", "g", "upper", "lower", "county"]);
});
