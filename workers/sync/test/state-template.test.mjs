// node --test test/state-template.test.mjs
// Every state's page is the home page's template (functions/_lib/home.js):
// /states/<name>/ and the home page for a visitor in that state show the same
// sections in the same order, the national sections in the same spot, "Coming
// soon for [State]" where a state has no data yet, and Calaveras as a county
// link inside California. Old /explore/<st>/ links redirect. Served from the
// repo's real static files, with no database (every section's empty state).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { stateSlug, stateFromSlug, statePath } from "../../../functions/_lib/state-paths.js";

const ROOT = new URL("../../../", import.meta.url);
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};
const env = { ASSETS };
const home = (await import("../../../functions/index.js")).onRequestGet;
const states = (await import("../../../functions/states/[[path]].js")).onRequestGet;
const explore = (await import("../../../functions/explore/[[path]].js")).onRequestGet;

async function call(fn, path, { cookie = "", cf = null } = {}) {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await fn({ request, env, params: { path: parts }, waitUntil: () => {} });
  return { res, html: res.status === 200 ? await res.text() : "" };
}
const sections = (html) => [...html.matchAll(/<(?:section|details)[^>]*\bid="([^"]+)"/g)].map((m) => m[1]);

test("state paths", () => {
  assert.equal(statePath("NY"), "/states/new-york/");
  assert.equal(statePath("DC"), "/states/district-of-columbia/");
  assert.equal(stateSlug("PR"), "puerto-rico");
  assert.equal(stateFromSlug("washington"), "WA");
  assert.equal(stateFromSlug("wa"), "WA");
  assert.equal(stateFromSlug("atlantis"), null);
});

test("/states/<name>/ and the home page for a visitor there are the same template", async () => {
  const page = await call(states, "/states/washington/");
  const visit = await call(home, "/", { cf: { country: "US", regionCode: "WA" } });
  assert.equal(page.res.status, 200);
  assert.deepEqual(sections(page.html), sections(visit.html), "same sections, same order");
  assert.match(page.html, /Showing <strong>Washington<\/strong>/);
  assert.match(visit.html, /Showing <strong>Washington<\/strong>/);
  // The national sections sit in the same spot on every state's page.
  const tx = await call(states, "/states/texas/");
  assert.deepEqual(sections(tx.html), sections(page.html));
  const order = sections(page.html);
  assert.ok(order.indexOf("your-state") < order.indexOf("nation") && order.indexOf("nation") < order.indexOf("map"));
  for (const t of ["The President and the Cabinet", "U.S. Senate", "U.S. House", "The Supreme Court"]) assert.ok(page.html.includes(t), t);
});

test("a section without data says Coming soon for [State], never disappears", async () => {
  const { html } = await call(states, "/states/texas/");
  assert.ok((html.match(/Coming soon for Texas\./g) || []).length >= 4);
  for (const label of ["In Congress", "Texas, statewide", "The legislature", "Ballot measures", "Counties", "Take part", "The Supreme Court"]) assert.ok(html.includes(label), label);
  assert.doesNotMatch(html, /appear after the data sync/);
});

test("California: Calaveras is a county link inside the state's page", async () => {
  const { html } = await call(states, "/states/california/");
  assert.match(html, /<p class="label">Counties<\/p>\s*<a class="list-row link-row" href="\/calaveras\/">/);
  assert.match(html, /Calaveras County/);
});

test("old and other addresses redirect to the state's page", async () => {
  const r = async (fn, path) => (await call(fn, path)).res;
  assert.equal((await r(explore, "/explore/wa/")).headers.get("Location"), "https://thepillory.test/states/washington/#map");
  assert.equal((await r(explore, "/explore/ca/?layer=cd")).headers.get("Location"), "https://thepillory.test/states/california/?layer=cd#map");
  assert.equal((await r(states, "/states/wa/")).headers.get("Location"), "https://thepillory.test/states/washington/");
  assert.equal((await r(states, "/states/atlantis/")).status, 404);
});

// A browser with California districts saved, browsing other states.
const CA_COOKIE = `pillory_districts=${encodeURIComponent("st=CA&cd=5&su=4&sl=8&co=06009")}`;

test("a state's page shows that state, whatever districts the browser has saved", async () => {
  for (const [slug, st] of [["minnesota", "MN"], ["texas", "TX"], ["wyoming", "WY"]]) {
    const { res, html } = await call(states, `/states/${slug}/`, { cookie: CA_COOKIE });
    assert.equal(res.status, 200);
    assert.match(html, new RegExp(`href="/bodies/us-senate/\\?state=${st}"`), `${st}: the Senate link is for ${st}`);
    assert.match(html, new RegExp(`href="/bodies/us-house/\\?state=${st}"`));
    assert.match(html, new RegExp(`href="/ballot/${st.toLowerCase()}/"`), "the ballot is the state's");
    assert.doesNotMatch(html, /href="\/bodies\/us-senate\/"/, "never the unscoped Senate page");
    assert.doesNotMatch(html, /\/place\/ca\/calaveras\/topics\//, "no California county topics on another state's page");
    assert.doesNotMatch(html, /href="\/elections\/#how-to-vote"/);
  }
});

// The Senate page with ?state=: that state's members first, then the visitor's own only when they're elsewhere.
const bodies = (await import("../../../functions/bodies/[[path]].js")).onRequestGet;
const SENATORS = { MN: ["Minnesota Senator One", "Minnesota Senator Two"], CA: ["California Senator One", "California Senator Two"] };
const db = {
  prepare(sql) {
    let binds = [];
    const st = () => binds.find((b) => SENATORS[b]);
    const rows = () => (SENATORS[st()] || []).map((name, i) => ({ id: `${st()}${i}`, slug: `${st()}-${i}`.toLowerCase(), name, office: "U.S. Senator", body: "us-senate", chamber: "us-senate", state: st() }));
    const q = { bind: (...b) => ((binds = b), q), all: async () => ({ results: /FROM officials/.test(sql) ? rows() : [] }), first: async () => null };
    return q;
  },
};
async function senate(path, cookie = "") {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  const res = await bodies({ request, env: { DB: db }, params: { path: ["us-senate"] } });
  return res.text();
}

test("/bodies/us-senate/?state=MN: Minnesota's members first, then yours from another state", async () => {
  const html = await senate("/bodies/us-senate/?state=MN", CA_COOKIE);
  const at = (t) => html.indexOf(t);
  assert.ok(at("Minnesota&#x27;s members") > 0 && at("Minnesota Senator One") > at("Minnesota&#x27;s members"));
  assert.ok(at("Your members") > at("Minnesota Senator Two"), "yours after");
  assert.ok(at("California Senator One") > at("Your members"));
  assert.ok(at("Members by state") > at("California Senator One"));
  const same = await senate("/bodies/us-senate/?state=CA", CA_COOKIE);
  assert.match(same, /California&#x27;s members/);
  assert.doesNotMatch(same, /Your members/, "not twice when it's the visitor's own state");
  const plain = await senate("/bodies/us-senate/", CA_COOKIE);
  assert.match(plain, /Your members/);
  assert.match(plain, /California Senator One/);
});

test("the top of every state's page: headline, map, ballot card, Find your representatives, then the rest", async () => {
  const { ballotWindow, todayIn, previewLabel } = await import("../../../functions/_lib/election-window.js");
  const dates = JSON.parse(readFileSync(new URL("data/elections/dates.json", ROOT), "utf8"));
  for (const [path, st, label] of [["/states/california/", "CA", "Preview California&#x27;s ballot"], ["/states/washington/", "WA", "Preview Washington&#x27;s ballot"], ["/states/district-of-columbia/", "DC", "Preview D.C.&#x27;s ballot"]]) {
    const { html } = await call(states, path);
    const at = (s) => html.indexOf(s);
    const head = at('class="hub-title"');
    const map = at('id="us-map"');
    const find = at('id="find"');
    const yours = at('id="your-state"');
    assert.ok(head > 0 && head < map && map < find && find < yours, `${st}: headline, map, Find your representatives, Your state`);
    const win = ballotWindow(dates, st, todayIn(st));
    if (win && win.open) {
      const card = at('class="card ballot-hero"');
      assert.ok(map < card && card < find, `${st}: the ballot card sits between the map and Find your representatives`);
      const cardHtml = html.slice(card, html.indexOf("</section>", card));
      assert.ok(cardHtml.includes(`<p class="ballot-hero-when">${win.line.replace(/'/g, "&#x27;")}`), `${st}: one line with the date and countdown`);
      assert.ok(cardHtml.includes(`>${label}</a>`), `${st}: ${label}`);
      assert.doesNotMatch(cardHtml, /btn--block/, "a standard-size button");
      assert.equal((cardHtml.match(/<p\b/g) || []).length, 1, "no extra text");
    } else {
      assert.equal(at("ballot-hero"), -1);
      assert.ok(html.includes(label), `${st}: ${label} as a link`);
    }
  }
  assert.equal(previewLabel("CA", "California"), "Preview California's ballot");
  assert.equal(previewLabel("DC", "District of Columbia"), "Preview D.C.'s ballot");
  assert.equal(previewLabel(null, null), "Preview your state's ballot");
});
