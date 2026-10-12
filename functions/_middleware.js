// Runs around every request. On an HTML page, source links get their archived
// copy (and, when the original is gone, the archived or saved copy first):
// functions/_lib/source-links.js. Everything else passes through untouched.
import { linksIn, linkInfo, rewriteSourceLinks } from "./_lib/source-links.js";

export async function onRequest(context) {
  const res = await context.next();
  const type = res.headers.get("content-type") || "";
  const path = new URL(context.request.url).pathname;
  if (!context.env.DB || !/text\/html/i.test(type) || path.startsWith("/admin/") || res.status !== 200) return res;
  const html = await res.text();
  const headers = new Headers(res.headers);
  headers.delete("content-length");
  let out = html;
  try {
    const urls = linksIn(html);
    if (urls.length) out = rewriteSourceLinks(html, await linkInfo(context.env.DB, urls));
  } catch (err) {
    // The page as it was: a copy link is never worth a failed page.
    console.error(`source links: ${err && err.message}`);
  }
  return new Response(out, { status: res.status, statusText: res.statusText, headers });
}
