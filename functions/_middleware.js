// Runs around every request.
//   1. An address with query parameters the site doesn't make (or too many, or
//      a page past the cap) gets a short 400 before anything else runs, so no
//      database query; tracking tags are dropped with a redirect
//      (functions/_lib/crawl.js).
//   2. On an HTML page, source links get their archived copy (and, when the
//      original is gone, the archived or saved copy first):
//      functions/_lib/source-links.js. That reads D1, so a page that's the same
//      for everyone (Cache-Control public) is kept at the edge as finished, and
//      served from there without running the page or the query again.
//   3. Filtered and later pages are marked noindex, links to addresses with a
//      query string get rel="nofollow", and "Load more" stops at the cap.
//   4. Every request's D1 rows read and written are counted by its route pattern
//      and kind of visitor (functions/_lib/usage.js; nothing about the visitor kept).
// Everything else passes through untouched.
import { linksIn, linkInfo, rewriteSourceLinks } from "./_lib/source-links.js";
import { checkQuery, badRequest, forCrawlers } from "./_lib/crawl.js";
import { startUsage, finishUsage, usageDb } from "./_lib/usage.js";

const DONE = "__finished";

/** How long a response may be kept for everyone: its public max-age, else 0. Pure. */
export function publicSeconds(res) {
  const cc = res.headers.get("Cache-Control") || "";
  if (!/\bpublic\b/.test(cc) || /private|no-store|no-cache/.test(cc) || res.headers.has("Set-Cookie")) return 0;
  const m = /max-age=(\d+)/.exec(cc);
  return m ? Math.min(Number(m[1]), 3600) : 0;
}

export async function onRequest(context) {
  const usage = startUsage(context);
  const res = await handle(context);
  finishUsage(context, usage);
  return res;
}

async function handle(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const admin = url.pathname.startsWith("/admin/");
  if (request.method === "GET" || request.method === "HEAD") {
    const q = checkQuery(url);
    if (q.bad) return badRequest(q.bad);
    if (q.redirect) return Response.redirect(q.redirect, 301);
  }

  const cache = typeof caches !== "undefined" && request.method === "GET" && !admin ? caches.default : null;
  const keyUrl = new URL(url);
  keyUrl.searchParams.set(DONE, "1");
  const key = new Request(keyUrl.toString(), { method: "GET" });
  if (cache) {
    const hit = await cache.match(key).catch(() => null);
    if (hit) return hit;
  }

  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  if (admin || !/text\/html/i.test(type) || res.status !== 200) {
    if (admin || !url.search) return res;
    const r = new Response(res.body, res);
    r.headers.set("X-Robots-Tag", "noindex, nofollow");
    return r;
  }
  const html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  if (url.search) headers.set("X-Robots-Tag", "noindex, nofollow");
  let out = html;
  if (env.DB) {
    try {
      const urls = linksIn(html);
      if (urls.length) out = rewriteSourceLinks(html, await linkInfo(usageDb(context), urls));
    } catch (err) {
      // The page as it was: a copy link is never worth a failed page.
      console.error(`source links: ${err && err.message}`);
    }
  }
  out = forCrawlers(out, { noindex: !!url.search });
  const done = new Response(out, { status: res.status, statusText: res.statusText, headers });
  const seconds = cache ? publicSeconds(done) : 0;
  if (seconds) {
    const put = cache.put(key, done.clone()).catch((err) => console.error(`finished page cache: ${err && err.message}`));
    if (context.waitUntil) context.waitUntil(put);
  }
  return done;
}
