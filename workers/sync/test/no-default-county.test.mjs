// node --test test/no-default-county.test.mjs
// Calaveras is never anyone's default: a visitor sees Calaveras content only when
// their saved districts are in Calaveras or they open it themselves. Tested as a
// fresh visitor from a California connection and as a visitor with San Jose
// (Santa Clara County) districts saved, from the repo's real static files with
// no database (every section's empty state).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { zipResult } from "../../../functions/api/districts.js";

const ROOT = new URL("../../../", import.meta.url);
const ASSETS = {
  fetch: async (u) => {
    const file = new URL(`.${new URL(u).pathname}`, ROOT);
    return existsSync(file) ? new Response(readFileSync(file, "utf8")) : new Response("not found", { status: 404 });
  },
};
const env = { ASSETS };
const handler = async (path) => (await import(`../../../functions/${path}`)).onRequestGet;
const routes = {
  home: await handler("index.js"),
  states: await handler("states/[[path]].js"),
  briefing: await handler("briefing/index.js"),
  calaveras: await handler("calaveras/index.js"),
  place: await handler("place/[[path]].js"),
  ballot: await handler("ballot/[[path]].js"),
  reps: await handler("reps/[[path]].js"),
};

const CA = { country: "US", regionCode: "CA" };
const SAN_JOSE = `pillory_districts=${encodeURIComponent("st=CA&cd=19&su=15&sl=28&co=06085")}`;
const CALAVERAS = `pillory_districts=${encodeURIComponent("st=CA&cd=5&su=4&sl=8&co=06009")}`;

async function call(fn, path, { cookie = "", cf = CA } = {}) {
  const request = new Request(`https://thepillory.test${path}`, { headers: cookie ? { Cookie: cookie } : {} });
  if (cf) Object.defineProperty(request, "cf", { value: cf });
  const parts = new URL(request.url).pathname.split("/").filter(Boolean).slice(1);
  const res = await fn({ request, env, params: { path: parts }, waitUntil: () => {} });
  return { res, html: res.status === 200 ? await res.text() : "" };
}
/**
 * The page with its Live community section taken out, and Calaveras's entry in the state map's
 * links (every county is a tap target on the map): the only places Calaveras may appear.
 */
const withoutLive = (html) => html
  .replace(/<section class="stack-xs" id="live"[\s\S]*?<\/section>/, "")
  .replace(/"06009":\["\/place\/ca\/calaveras\/","Calaveras County \(live community\)"\]/, "");

for (const [who, cookie] of [["a fresh visitor from California", ""], ["a visitor with San Jose districts saved", SAN_JOSE]]) {
  test(`${who}: Home and the California page show Calaveras only as the Live community link, below Your representatives`, async () => {
    for (const [fn, path] of [[routes.home, "/"], [routes.states, "/states/california/"]]) {
      const { res, html } = await call(fn, path, { cookie });
      assert.equal(res.status, 200, path);
      assert.doesNotMatch(withoutLive(html), /Calaveras|\/calaveras\//, `${path}: nothing else from Calaveras`);
      assert.ok(html.indexOf('id="live"') > html.indexOf('id="your-reps"'), `${path}: the Live community after Your representatives`);
      assert.match(html, /Not necessarily yours\./);
    }
  });

  test(`${who}: the Reps tab and the ballot preview never fall back to Calaveras`, async () => {
    for (const [fn, path] of [[routes.reps, "/reps/"], [routes.ballot, "/ballot/ca/"]]) {
      const { res, html } = await call(fn, path, { cookie });
      assert.equal(res.status, 200, path);
      assert.doesNotMatch(html, /Calaveras|\/calaveras\/|District 5\b/, path);
    }
    const pick = await call(routes.ballot, "/ballot/", { cookie });
    assert.equal(pick.res.headers.get("Location"), "https://thepillory.test/ballot/ca/");
  });
}

test("/briefing/ with no saved districts: Find your place, never a county", async () => {
  const { res, html } = await call(routes.briefing, "/briefing/");
  assert.equal(res.status, 200);
  assert.match(html, /id="h-find">Find your place<\/h2>/);
  assert.match(html, /<input type="hidden" name="next" value="\/briefing\/" \/>/);
  assert.doesNotMatch(html, /Calaveras/);
});

test("/briefing/ with San Jose saved: their own reps, county and ballot, never Calaveras", async () => {
  const { res, html } = await call(routes.briefing, "/briefing/", { cookie: SAN_JOSE });
  assert.equal(res.status, 200);
  assert.doesNotMatch(html, /Calaveras/);
  assert.match(html, /href="\/place\/ca\/santa-clara\/"[\s\S]*?Your county: Santa Clara County/);
  assert.match(html, /href="\/ballot\/ca\/"[\s\S]*?Your ballot preview/);
  const calaveras = await call(routes.briefing, "/briefing/", { cookie: CALAVERAS });
  assert.match(calaveras.html, /Calaveras County/, "Calaveras only for a visitor whose districts are there");
});

test("every county page, /calaveras/ included, has Not your county? near the top", async () => {
  const cal = await call(routes.calaveras, "/calaveras/", { cookie: SAN_JOSE });
  const at = (h, t) => h.indexOf(t);
  assert.match(cal.html, /Not your county\? Enter your ZIP or address/);
  assert.match(cal.html, /id="not-yours-q"[\s\S]*?name="next" value="\/briefing\/"|name="next" value="\/briefing\/"[\s\S]*?id="not-yours-q"/);
  assert.ok(at(cal.html, "Not your county?") < at(cal.html, 'id="h-week"'), "before the county's sections");
  const fresh = await call(routes.calaveras, "/calaveras/");
  assert.match(fresh.html, /Not your county\?/);
  const own = await call(routes.calaveras, "/calaveras/", { cookie: CALAVERAS });
  assert.doesNotMatch(own.html, /Not your county\?/, "it is their county");
  for (const path of ["/place/ca/santa-clara/", "/place/ca/calaveras/"]) {
    const { res, html } = await call(routes.place, path);
    assert.equal(res.status, 200, path);
    assert.match(html, /Not your county\? Enter your ZIP or address/, path);
    assert.ok(at(html, "Not your county?") < at(html, 'id="who"'), `${path}: near the top`);
  }
});

test("a ZIP wholly in one county keeps the county, so the visitor's own county follows", () => {
  const r = zipResult([["CA", "19", "15", "28", "06085", 0.984], ["CA", "16", "15", "28", "06085", 0.016]]);
  assert.equal(r.found, true);
  assert.equal(r.districts.co, "06085");
  const split = zipResult([["CA", "16", "13", "23", "06081", 0.8], ["CA", "16", "13", "23", "06085", 0.2]]);
  assert.equal(split.found, true, "choices that differ only by county count as one");
  assert.equal(split.districts.co, undefined, "a ZIP across county lines doesn't pick a county");
});
