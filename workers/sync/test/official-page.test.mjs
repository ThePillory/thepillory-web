// node --test test/official-page.test.mjs
// The official's page, tightened (functions/reps/[[path]].js): one line each for
// votes, money and net worth in the header; no repeats in the tabs; the latest
// ten votes, then "See all"; the Funding tab's top five of each list, then "See
// all"; More as one row per topic with five earmarks, trips and contacts; the
// empty Platform and Issues as one line; and every "See all" page. Served from
// the real schema in SQLite; every name is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { currentCycle } from "../src/funding/fec.js";

const ROOT = new URL("../../../", import.meta.url);
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};
function d1(sqlite) {
  const stmt = (sql, binds = []) => ({
    bind: (...b) => stmt(sql, b),
    all: async () => ({ results: sqlite.prepare(sql).all(...binds) }),
    first: async () => sqlite.prepare(sql).get(...binds) ?? null,
    run: async () => sqlite.prepare(sql).run(...binds),
  });
  return { prepare: (sql) => stmt(sql), batch: async (s) => Promise.all(s.map((x) => x.run())) };
}
const CYCLE = currentCycle();
const VOTES = 30;

function seeded() {
  const sqlite = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const f of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) sqlite.exec(readFileSync(new URL(f, dir), "utf8"));
  sqlite.exec(`INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, district_code, party, state, source_url, last_verified, active)
    VALUES ('h1', 'example-member', 'Example Member', 'Member', 'U.S. Representative', 'federal', 'us-house', 'us-house', 'CA-5', '5', 'Party A', 'CA', 'https://example.org/o', '2026-10-01', 1)`);
  const bill = sqlite.prepare("INSERT INTO bills (id, level, chamber, bill_number, session, title, source_url) VALUES (?, 'federal', 'us-house', ?, '119', ?, 'https://example.org/b')");
  const vote = sqlite.prepare("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url) VALUES (?, ?, 'federal', 'us-house', ?, 'On Passage', ?, 'Passed', 'https://example.org/v')");
  const pos = sqlite.prepare("INSERT INTO vote_positions (vote_id, official_id, position, raw_position) VALUES (?, 'h1', 'Yes', 'Yea')");
  for (let i = 1; i <= VOTES; i++) {
    const n = String(i).padStart(2, "0");
    bill.run(`us-119-hr-${i}`, `H.R. ${i}`, `Example Bill ${n}`);
    vote.run(`v${n}`, `us-119-hr-${i}`, `2026-0${1 + Math.floor((i - 1) / 9)}-${String(1 + ((i - 1) % 9)).padStart(2, "0")}`, i % 3 ? "final_passage" : "procedural");
    pos.run(`v${n}`);
  }
  const finals = Array.from({ length: VOTES }, (_, i) => i + 1).filter((i) => i % 3).length;
  sqlite.exec(`INSERT INTO official_stats (official_id, vote_count, final_count) VALUES ('h1', ${VOTES}, ${finals})`);
  sqlite.exec(`INSERT INTO fec_candidates (official_id, candidate_id, committee_id, source_url) VALUES ('h1', 'H0XX00001', 'C00000001', 'https://www.fec.gov/data/candidate/H0XX00001/')`);
  sqlite.exec(`INSERT INTO funding_progress (official_id, cycle, done_at) VALUES ('h1', ${CYCLE}, '2026-10-01')`);
  sqlite.exec(`INSERT INTO funding_totals (official_id, cycle, candidate_id, receipts, disbursements, cash_on_hand, individual_unitemized, individual_itemized, pac, source_url)
    VALUES ('h1', ${CYCLE}, 'H0XX00001', 1000000, 600000, 400000, 300000, 500000, 200000, 'https://www.fec.gov/data/candidate/H0XX00001/')`);
  const pac = sqlite.prepare(`INSERT INTO funding_pacs (official_id, cycle, committee_id, name, total, count, industry, source_url) VALUES ('h1', ${CYCLE}, ?, ?, ?, 2, 'other', 'https://www.fec.gov/')`);
  for (let i = 1; i <= 8; i++) pac.run(`C1${i}`, `Example PAC ${i}`, 10000 - i * 100);
  const trip = sqlite.prepare("INSERT INTO gift_travel (id, official_id, chamber, traveler, sponsor, destination, start_date, end_date, source_url) VALUES (?, 'h1', 'house', 'member', ?, 'Example City', ?, ?, 'https://example.org/t')");
  for (let i = 1; i <= 7; i++) trip.run(`t${i}`, `Example Sponsor ${i}`, `2025-0${i}-01`, `2025-0${i}-03`);
  return d1(sqlite);
}

const reps = (await import("../../../functions/reps/[[path]].js")).onRequestGet;
async function get(path) {
  const request = new Request(`https://thepillory.test${path}`);
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await reps({ request, env: { DB: seeded(), ASSETS }, params: { path: parts }, waitUntil: () => {} });
  return { res, html: res.status === 200 ? await res.text() : "" };
}
const panel = (html, id) => {
  const at = html.indexOf(`role="tabpanel" id="${id}"`);
  const next = html.indexOf('role="tabpanel"', at + 10);
  return html.slice(at, next < 0 ? html.indexOf("</main>") : next);
};

test("the header: office, name, and one line each for votes and money; no repeats in the tabs", async () => {
  const { res, html } = await get("/reps/example-member/");
  assert.equal(res.status, 200);
  const head = html.slice(html.indexOf('class="page-head rep-head"'), html.indexOf("</header>", html.indexOf('class="page-head rep-head"')));
  assert.match(head, /<h1>Example Member<\/h1>/);
  assert.match(head, /href="#votes">20 final-passage votes on record; the latest/);
  assert.match(head, /href="#funding">Raised \$1,000,000 in /);
  assert.doesNotMatch(head, /class="chips"/, "no chips repeating the body or the website");
  assert.doesNotMatch(html, /Record at a glance/, "the counts are in the header, not again on About");
  assert.doesNotMatch(html, /id="issues"/, "no separate Issues section");
  assert.match(html, /class="tabs tabs--five"/);
});

test("Votes: the latest ten, then See all on its own paged page", async () => {
  const { html } = await get("/reps/example-member/");
  const votes = panel(html, "votes");
  assert.equal((votes.match(/class="list-status row-position/g) || []).length, 10);
  assert.match(votes, new RegExp(`href="/reps/example-member/votes/\\?votes=all">[\\s\\S]*?See all ${VOTES} votes`));
  const all = await get("/reps/example-member/votes/?votes=all");
  assert.equal((all.html.match(/class="list-status row-position/g) || []).length, 25);
  assert.match(all.html, /href="\/reps\/example-member\/votes\/\?votes=all&page=2">Older/);
  assert.match(all.html, /← Example Member/);
  const two = await get("/reps/example-member/votes/?votes=all&page=2");
  assert.equal((two.html.match(/class="list-status row-position/g) || []).length, VOTES - 25);
  const old = await get("/reps/example-member/?votes=all&page=2");
  assert.equal(old.res.status, 301, "the old paging moves to the votes page");
  assert.equal(old.res.headers.get("Location"), "https://thepillory.test/reps/example-member/votes/?votes=all&page=2");
});

test("Funding: totals and the bar, the top five PACs, then See all", async () => {
  const { html } = await get("/reps/example-member/");
  const funding = panel(html, "funding");
  assert.ok(funding.indexOf("hero-num") < funding.indexOf("Where it came from") && funding.indexOf("Where it came from") < funding.indexOf("Top PACs"));
  assert.equal((funding.match(/Example PAC \d/g) || []).length, 5);
  assert.match(funding, new RegExp(`href="/reps/example-member/funding/pacs/\\?cycle=${CYCLE}"[\\s\\S]*?See all PACs`));
  const list = await get(`/reps/example-member/funding/pacs/?cycle=${CYCLE}`);
  assert.equal(list.res.status, 200);
  assert.equal((list.html.match(/Example PAC \d/g) || []).length, 8);
  assert.equal((await get("/reps/example-member/funding/donors/")).res.status, 404);
});

test("More: one row per topic with a one-line summary; travel five, then See all", async () => {
  const { html } = await get("/reps/example-member/");
  const more = panel(html, "more");
  const row = (id) => (more.match(new RegExp(`<details class="fold" id="${id}">\\s*<summary>([\\s\\S]*?)</summary>`)) || [])[1] || "";
  assert.match(row("more-travel"), /Privately paid travel<\/span><span class="fold-meta">7 trips since 2023/);
  assert.match(row("more-trades"), /fold-meta">None reported/);
  const travel = more.slice(more.indexOf('id="more-travel"'), more.indexOf("</details>", more.indexOf('id="more-travel"')));
  assert.equal((travel.match(/Example Sponsor \d/g) || []).length, 5);
  assert.match(travel, /href="\/reps\/example-member\/travel\/"[\s\S]*?See all 7 trips/);
  const all = await get("/reps/example-member/travel/");
  assert.equal((all.html.match(/Example Sponsor \d/g) || []).length, 7);
});

test("an empty Platform and Issues are one line", async () => {
  const { html } = await get("/reps/example-member/");
  const platform = panel(html, "platform");
  assert.equal((platform.match(/<p\b/g) || []).length, 1, "one line");
  assert.match(platform, /No platform recorded yet[\s\S]*?Residents' reports and issues open when accounts launch/);
});
