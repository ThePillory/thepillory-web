// node --test test/crawl.test.mjs
// Keeping crawlers out of endless URL combinations: the query check, the page
// rewrite for crawlers, the finished-page cache rule (functions/_lib/crawl.js,
// functions/_middleware.js) and the awards page's queue rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { checkQuery, forCrawlers, pastCap, badRequest, MAX_OFFSET } from "../../../functions/_lib/crawl.js";
import { onRequest, publicSeconds } from "../../../functions/_middleware.js";
import { fromSite } from "../../../functions/awards/index.js";

const u = (s) => new URL(`https://thepillory.test${s}`);

test("addresses the site makes pass; others get a reason", () => {
  for (const s of [
    "/", "/laws/", "/laws/?show=orders&filter=all&offset=25", "/trades/?chamber=house&state=CA&sector=Energy&q=oil&offset=1250",
    "/awards/?name=Example%20Water%20District", "/reps/?state=TX&browse=state&sort=district", "/votes/?level=federal&page=50",
    "/laws/bills/us-119-hr-1/rollcall/?vote=v1&q=&position=&party=&state=", "/reps/someone/?year=2001",
    "/corrections/?page=%2Freps%2Fsomeone%2F", "/admin/review/?anything=1&offset=999999",
    "/assets/pillory.css?v=53", "/site.webmanifest?v=3", "/assets/logo/icon.svg?v=4", "/data/geo/states.json?x=1",
  ]) assert.deepEqual(checkQuery(u(s)), { ok: true }, s);
  assert.match(checkQuery(u("/awards/?name=x&foo=1")).bad, /doesn't take "foo"/);
  assert.match(checkQuery(u("/trades/?offset=1275")).bad, /up to item 1,250/);
  assert.match(checkQuery(u("/trades/?offset=-5")).bad, /up to item/);
  assert.match(checkQuery(u("/votes/?page=51")).bad, /up to page 50/);
  assert.match(checkQuery(u("/laws/?show=bills&show=orders")).bad, /more than once/);
  assert.match(checkQuery(u(`/awards/?name=${"a".repeat(301)}`)).bad, /too long/);
  assert.match(checkQuery(u("/reps/x/?year=19x3")).bad, /isn't a year/);
});

test("tracking tags are dropped with a redirect, keeping the rest", () => {
  assert.deepEqual(checkQuery(u("/laws/?utm_source=x&fbclid=abc&show=orders")), { redirect: "https://thepillory.test/laws/?show=orders" });
  assert.deepEqual(checkQuery(u("/reps/?utm_medium=social")), { redirect: "https://thepillory.test/reps/" });
});

test("the refusal is short, plain and never indexed", async () => {
  const r = badRequest("Nope.");
  assert.equal(r.status, 400);
  assert.equal(r.headers.get("X-Robots-Tag"), "noindex");
  assert.match(await r.text(), /^400 Bad request\. Nope\./);
});

test("for crawlers: nofollow on query links, noindex on query pages, Load more stops at the cap", () => {
  const html = `<html><head><title>x</title></head><body>
<a href="/laws/">Laws</a>
<a class="chip" href="/laws/?show=orders&amp;filter=all">Orders</a>
<a href="/awards/?name=Acme" rel="noopener">Federal awards</a>
<a href="https://example.gov/?a=1">Source</a>
<a class="btn load-more" href="/laws/?offset=${MAX_OFFSET}">Load more</a>
<a class="btn load-more" href="/trades/?chamber=house&amp;offset=${MAX_OFFSET + 25}">Load more</a>
<a class="btn" href="/votes/?level=federal&amp;page=51">Load more</a>
</body></html>`;
  const out = forCrawlers(html, { noindex: true });
  assert.match(out, /<a href="\/laws\/">Laws<\/a>/, "plain addresses untouched");
  assert.match(out, /href="\/laws\/\?show=orders&amp;filter=all" rel="nofollow">Orders/);
  assert.match(out, /href="\/awards\/\?name=Acme" rel="noopener nofollow"/);
  assert.match(out, /<a href="https:\/\/example\.gov\/\?a=1">Source<\/a>/, "other sites untouched");
  assert.match(out, new RegExp(`href="/laws/\\?offset=${MAX_OFFSET}" rel="nofollow">Load more`), "at the cap: still shown");
  assert.equal((out.match(/That's as far as this list goes here/g) || []).length, 2, "past the cap: a note");
  assert.match(out, /<meta name="robots" content="noindex, nofollow">\n<\/head>/);
  assert.doesNotMatch(forCrawlers(html), /name="robots"/, "the plain address stays indexable");
  assert.equal(pastCap("/x/?toffset=1300"), true);
  assert.equal(pastCap("/x/?q=offset=99999"), false);
});

test("a finished page is kept only when it's the same for everyone", () => {
  const r = (cc, extra = {}) => new Response("x", { headers: { "Cache-Control": cc, ...extra } });
  assert.equal(publicSeconds(r("public, max-age=300")), 300);
  assert.equal(publicSeconds(r("private, no-cache")), 0);
  assert.equal(publicSeconds(r("public, max-age=0, must-revalidate")), 0);
  assert.equal(publicSeconds(r("public, max-age=300", { "Set-Cookie": "a=b" })), 0);
  assert.equal(publicSeconds(new Response("x")), 0);
});

test("the middleware refuses before the page runs, and marks query pages", async () => {
  let ran = 0;
  const page = (html, cc = "public, max-age=300") => async () => (ran++, new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", "Cache-Control": cc } }));
  const ctx = (path, next) => ({ request: new Request(`https://thepillory.test${path}`), env: {}, next, waitUntil: () => {} });
  const bad = await onRequest(ctx("/awards/?name=x&page=2&zzz=1", page("<html><head></head></html>")));
  assert.equal(bad.status, 400);
  assert.equal(ran, 0, "no page, no database");
  const moved = await onRequest(ctx("/laws/?utm_source=x", page("")));
  assert.equal(moved.status, 301);
  const ok = await onRequest(ctx("/awards/?name=Acme", page('<html><head></head><body><a href="/laws/?show=orders">O</a></body></html>')));
  assert.equal(ok.status, 200);
  assert.equal(ok.headers.get("X-Robots-Tag"), "noindex, nofollow");
  const body = await ok.text();
  assert.match(body, /name="robots" content="noindex, nofollow"/);
  assert.match(body, /href="\/laws\/\?show=orders" rel="nofollow"/);
  const plain = await onRequest(ctx("/laws/", page("<html><head></head><body></body></html>")));
  assert.equal(plain.headers.get("X-Robots-Tag"), null);
  assert.doesNotMatch(await plain.text(), /name="robots"/);
});

test("awards: only a click from the site adds a name to the lookup queue", () => {
  const req = (h) => new Request("https://thepillory.test/awards/?name=Acme", { headers: h });
  assert.equal(fromSite(req({ "Sec-Fetch-Site": "same-origin" })), true);
  assert.equal(fromSite(req({ "Sec-Fetch-Site": "none" })), false, "typed or pasted");
  assert.equal(fromSite(req({ "Sec-Fetch-Site": "cross-site" })), false);
  assert.equal(fromSite(req({ Referer: "https://thepillory.test/reps/someone/" })), true);
  assert.equal(fromSite(req({ Referer: "https://elsewhere.example/" })), false);
  assert.equal(fromSite(req({})), false, "a crawler sends neither");
});
