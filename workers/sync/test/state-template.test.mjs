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
