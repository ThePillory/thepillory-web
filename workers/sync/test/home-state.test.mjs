// node --test test/home-state.test.mjs
// The home page's state: picked, then saved districts, then the connection's
// approximate state (US states, DC and Puerto Rico only), and one edge-cache
// copy per state that browsers don't keep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { connectionState, visitorState, pickedState, stateCookie } from "../../../functions/_lib/visitor-state.js";
import { edgeCached } from "../../../functions/_lib/render.js";

const R = (cookie = "", cf = null) => ({ headers: new Headers({ Cookie: cookie }), cf });

test("the connection's state: US states, DC and Puerto Rico; nothing else", () => {
  assert.equal(connectionState({ country: "US", regionCode: "WA" }), "WA");
  assert.equal(connectionState({ country: "US", regionCode: "DC" }), "DC");
  assert.equal(connectionState({ country: "PR", regionCode: "SJ" }), "PR");
  assert.equal(connectionState({ country: "CA", regionCode: "ON" }), null, "Ontario, Canada: the national hub");
  assert.equal(connectionState({ country: "US" }), null, "region unknown");
  assert.equal(connectionState({ country: "US", regionCode: "ZZ" }), null);
  assert.equal(connectionState(null), null);
});

test("a picked state, then saved districts, then the connection", () => {
  const wa = { country: "US", regionCode: "WA" };
  assert.deepEqual(visitorState(R("", wa), null), { st: "WA", name: "Washington", source: "connection" });
  assert.deepEqual(visitorState(R("", wa), { st: "CA", cd: "5" }), { st: "CA", name: "California", source: "districts" });
  assert.deepEqual(visitorState(R("pillory_state=tx", wa), { st: "CA" }), { st: "TX", name: "Texas", source: "picked" });
  assert.equal(visitorState(R("pillory_state=zz", { country: "DE" }), null), null, "a bad cookie is ignored");
  assert.equal(pickedState(R("other=1; pillory_state=NY")), "NY");
  assert.match(stateCookie("NY"), /^pillory_state=NY; Path=\/; Max-Age=31536000/);
  assert.match(stateCookie(null), /Max-Age=0/);
});

test("one cached copy per state; browsers told not to keep it", async () => {
  const store = new Map();
  globalThis.caches = { default: { match: async (k) => (store.has(k.url) ? store.get(k.url).clone() : undefined), put: async (k, r) => void store.set(k.url, r) } };
  try {
    let built = 0;
    const page = (st) => async () => {
      built += 1;
      return new Response(`home for ${st}`, { headers: { "Content-Type": "text/html" } });
    };
    const ctx = { request: new Request("https://thepillory.co/"), waitUntil: (p) => p };
    const opts = (v) => ({ variant: v, clientCache: "private, no-cache" });
    const tx = await edgeCached(ctx, 300, page("TX"), opts("TX-connection"));
    await new Promise((r) => setTimeout(r, 0));
    const wa = await edgeCached(ctx, 300, page("WA"), opts("WA-connection"));
    await new Promise((r) => setTimeout(r, 0));
    const tx2 = await edgeCached(ctx, 300, page("TX"), opts("TX-connection"));
    assert.equal(await tx.text(), "home for TX");
    assert.equal(await wa.text(), "home for WA", "never another state's copy");
    assert.equal(await tx2.text(), "home for TX");
    assert.equal(built, 2, "the second Texas visit came from the cache");
    assert.equal(tx2.headers.get("Cache-Control"), "private, no-cache");
    assert.equal(store.size, 2);
  } finally {
    delete globalThis.caches;
  }
});
