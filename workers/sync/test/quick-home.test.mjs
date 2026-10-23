// node --test test/quick-home.test.mjs
// "Your representatives" and "This week" on the home page and every state page
// (functions/_lib/quick-home.js): This week picks its sentences by one fixed rule
// (final actions first, then newest), Your representatives has each person once,
// and Quick keeps only the headline, the ballot card, those two cards, Elections
// and three links; everything else stays for Detailed.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { thisWeek, senatorsLine, yourReps, weekFeed, quickLinks, THIS_WEEK_MAX } from "../../../functions/_lib/quick-home.js";

const ROOT = new URL("../../../", import.meta.url);

test("senators' positions in one plain sentence", () => {
  assert.equal(senatorsLine([{ name: "A", position: "Yes" }, { name: "B", position: "Yes" }], "Texas"), " Both of Texas's senators voted yes.");
  assert.equal(senatorsLine([{ name: "A", position: "Yes" }, { name: "B", position: "No" }], "Texas"), " A voted yes and B voted no.");
  assert.equal(senatorsLine([{ name: "A", position: "Not voting" }], "Texas"), " A didn't vote.");
  assert.equal(senatorsLine([], "Texas"), "");
});

const vote = (id, date, extra = {}) => ({ bill_id: id, bill_number: id.toUpperCase(), bill_title: `Title ${id}`, chamber: "us-senate", level: "federal", result: "Passed", vote_date: date, positions: [], ...extra });

test("one fixed rule: up to two final actions first, then newest; at most five; the election last", () => {
  const items = thisWeek({
    stateName: "Texas",
    votes: [vote("a", "2026-10-01"), vote("b", "2026-10-08"), vote("c", "2026-10-05"), vote("d", "2026-10-02"), vote("e", "2026-10-03", { result: "Motion to proceed agreed to" }), vote("f", "2026-10-09", { result: "Failed" })],
    outcomes: [{ bill_id: "z", bill_number: "H.R. 9", title: "Old law", outcome: "signed", action_date: "2026-09-20", level: "federal" }],
    decisions: [{ name: "X v. Y", date: "2026-10-07", href: "/court/cases/2025/1/" }],
    election: { date: "2026-11-03", href: "/ballot/tx/", text: "Election Day in Texas is Nov 3, 2026, in 24 days." },
  });
  assert.equal(items.length, THIS_WEEK_MAX);
  assert.equal(items[0].text, "The President signed H.R. 9, “Old law”.", "the final action first, though older");
  assert.match(items[1].text, /^The Senate rejected F/, "then the newest");
  assert.match(items[2].text, /^The Senate passed B/);
  assert.match(items[3].text, /^The Supreme Court decided X v\. Y\./);
  assert.equal(items[4].href, "/ballot/tx/", "the election date last");
  // A heavy signing week never fills the list: two final actions, then the newest of the rest.
  const laws = Array.from({ length: 6 }, (_, i) => ({ bill_id: `l${i}`, bill_number: `L${i}`, outcome: "signed", action_date: `2026-10-0${i + 1}`, level: "state" }));
  const busy = thisWeek({ stateName: "California", outcomes: laws, votes: [vote("v", "2026-09-30")] });
  assert.deepEqual(busy.map((i) => i.href.replace(/^\/laws\/bills\/|\/.*$/g, "")), ["l5", "l4", "l3", "l2", "l1"]);
  const mixed = thisWeek({ stateName: "California", outcomes: laws, votes: [vote("v", "2026-10-05")] });
  assert.deepEqual(mixed.map((i) => i.href.replace(/^\/laws\/bills\/|\/.*$/g, "")), ["l5", "l4", "v", "l3", "l2"]);
});

test("a bill's checked plain line replaces its title; a bill appears once, as its final action", () => {
  const items = thisWeek({
    stateName: "Texas",
    votes: [vote("a", "2026-10-01", { positions: [{ name: "A", position: "Yes" }, { name: "B", position: "Yes" }] }), vote("tx-1", "2026-10-02", { level: "state", chamber: "tx-upper", bill_number: "SB 1" })],
    outcomes: [{ bill_id: "a", bill_number: "A", outcome: "vetoed", action_date: "2026-10-04", level: "federal", title: "Title a" }],
    plain: { "tx-1": "This bill sets aside money for wildfire crews" },
  });
  assert.equal(items.length, 2);
  assert.equal(items[0].text, "The President vetoed A, “Title a”.");
  assert.equal(items[1].text, "Texas's State Senate passed SB 1. This bill sets aside money for wildfire crews.");
  assert.equal(items[1].href, "/laws/bills/tx-1/#votes");
});

test("Your representatives: one row each with the job in plain words; the House member and state legislators once known", () => {
  const o = (slug, name, extra = {}) => ({ slug, name, ...extra });
  const html = yourReps({ president: o("p", "P"), senators: [o("s1", "S1"), o("s2", "S2")], governor: o("g", "G"), lookup: '<div id="find">ZIP</div>' });
  for (const [slug, job] of [["p", "Leads the federal government"], ["s1", "Writes federal laws for the whole state"], ["s2", "Writes federal laws for the whole state"], ["g", "Runs the state government"]]) {
    assert.match(html, new RegExp(`href="/reps/${slug}/"[\\s\\S]*?${job}`));
  }
  assert.equal((html.match(/href="\/reps\/p\/"/g) || []).length, 1, "each person once");
  assert.match(html, /id="find">ZIP/);
  const known = yourReps({ president: null, senators: [], governor: null, mine: [o("h", "H", { chamber: "us-house" }), o("l", "L", { chamber: "tx-lower", office: "State Representative" })] });
  assert.match(known, /href="\/reps\/h\/"[\s\S]*?Writes federal laws for your district/);
  assert.match(known, /href="\/reps\/l\/"[\s\S]*?Writes state laws for your district · State Representative/);
  assert.doesNotMatch(known, /id="find"/);
});

test("This week: a Congress / [State] switch, the items, See all", () => {
  const items = [{ date: "2026-10-01", href: "/laws/bills/a/", text: "The Senate passed A." }];
  const html = weekFeed({ items, tabs: [{ label: "Congress", href: "/", current: true }, { label: "Texas", href: "/?now=state:TX", current: false }], seeAll: "/votes/?level=federal" });
  assert.match(html, /<h2 class="label" id="h-this-week">This week<\/h2><a class="section-link" href="\/votes\/\?level=federal">See all<\/a>/);
  assert.match(html, /href="\/#this-week" aria-current="true">Congress<\/a><a class="toggle" href="\/\?now=state:TX#this-week">Texas<\/a>/);
  assert.match(html, /The Senate passed A\./);
  const empty = weekFeed({ items: [], tabs: [{ label: "Congress", href: "/", current: true }], seeAll: "/votes/" });
  assert.doesNotMatch(empty, /segmented/, "one tab: no switch");
  assert.match(empty, /No new votes, laws or decisions recorded/);
  assert.match(quickLinks(), /class="card stack-sm /, "stacked");
  assert.deepEqual([...quickLinks().matchAll(/class="list-title">([^<]+)/g)].map((m) => m[1]), ["Explore the map", "Topics", "How government works"]);
});

// The pages themselves, from the repo's static files with no database.
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};
const home = (await import("../../../functions/index.js")).onRequestGet;
const states = (await import("../../../functions/states/[[path]].js")).onRequestGet;
async function get(fn, path, cf = null) {
  const request = new Request(`https://thepillory.test${path}`);
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  const res = await fn({ request, env: { ASSETS }, params: { path: new URL(request.url).pathname.split("/").filter(Boolean).slice(1) }, waitUntil: () => {} });
  return res.text();
}

test("Quick keeps the headline, the ballot card, Your representatives, This week, Elections and three links, in that order", async () => {
  for (const [fn, path, cf] of [[home, "/", { country: "US", regionCode: "TX" }], [states, "/states/california/"], [states, "/states/texas/"]]) {
    const html = await get(fn, path, cf);
    const main = html.slice(html.indexOf('<div class="simple-scope">'), html.indexOf("</main>"));
    assert.ok(main.length > 0, `${path}: the page is a .simple-scope`);
    const at = (s) => main.indexOf(s);
    const order = ['class="hub-head stack-sm simple-keep"', 'id="your-reps"', 'id="this-week"', 'id="elections"', 'quick-links"'].map(at);
    assert.ok(order.every((n, i) => n >= 0 && (i === 0 || n > order[i - 1])), `${path}: order ${order}`);
    const hero = at("ballot-hero");
    if (hero >= 0) assert.ok(hero > order[0] && hero < order[1], `${path}: the ballot card before Your representatives`);
    assert.match(main, /<section class="hub-map stack-xs simple-keep"/, `${path}: the map stays in Quick`);
    for (const id of ["your-reps", "this-week", "elections"]) {
      const i = at(`id="${id}"`);
      assert.match(main.slice(main.lastIndexOf("<", i), i), /simple-keep/, `${path}: ${id} stays in Quick`);
    }
    // Everything else is a direct child of .simple-scope without .simple-keep, so Quick hides it.
    for (const id of ["nation", "topics"]) {
      const i = at(`id="${id}"`);
      if (i < 0) continue;
      const open = main.lastIndexOf("<", i);
      assert.doesNotMatch(main.slice(open, i), /simple-keep|simple-only/, `${path}: ${id} stays in Detailed`);
    }
  }
});
