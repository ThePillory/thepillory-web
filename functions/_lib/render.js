// HTML helpers for the Pages Functions. The page shell, tab bars and sample
// cards come from generated.js (written by tools/build.py), so dynamic pages
// match the static ones exactly.
import { PAGE, TABBARS } from "./generated.js";

export function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

// Only http(s) links are ever rendered from data.
export function safeUrl(u) {
  return /^https?:\/\//i.test(String(u || "")) ? String(u) : null;
}

// personal: the page depends on the visitor's district cookie, so no shared cache.
export function page(title, main, { tab = null, root = false, back = null, status = 200, personal = false, partial = false } = {}) {
  const nav = tab ? TABBARS[tab][root ? "root" : "sub"] : "";
  const backHtml = back ? `<a class="back-link" href="${esc(back[1])}">← ${esc(back[0])}</a>` : "";
  // Function replacements: data may contain "$", which .replace() would treat as a pattern.
  const html = PAGE.split("%%TITLE%%").join(esc(title))
    .replace("%%NAV%%", () => nav)
    .replace("%%BACK%%", () => backHtml)
    .replace("%%MAIN%%", () => main);
  return new Response(html, {
    status,
    headers: personal
      ? { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "private, no-cache", Vary: "Cookie" }
      : partial || status >= 500
        ? // A section failed to load: never keep this copy anywhere.
          { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" }
        : {
          "Content-Type": "text/html; charset=utf-8",
          // Data changes at most daily; a short edge cache keeps D1 reads low.
          "Cache-Control": "public, max-age=300",
        },
  });
}

export function notFound(what, tab, back) {
  return page(
    "Not found",
    `<header class="page-head"><h1>Not found</h1><p class="subtitle">${esc(what)}</p></header>`,
    { tab, back, status: 404 }
  );
}

// Shown when D1 isn't bound yet or the first sync hasn't run.
export function notLoaded(title, tab, root, back) {
  return page(
    title,
    `<header class="page-head"><h1>${esc(title)}</h1></header>
<section class="card stack-sm">
  <h2 class="label">Not loaded yet</h2>
  <p>Officials and voting records appear here after the first data sync runs.</p>
  <p class="small secondary">Nothing is shown until it has been loaded from an official source.</p>
</section>`,
    { tab, root, back }
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function fmtDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || "");
  if (!m) return iso ? esc(iso) : "Date not given";
  return `${MONTHS[parseInt(m[2], 10) - 1]} ${parseInt(m[3], 10)}, ${m[1]}`;
}

export function kv(rows) {
  return `<dl class="kv">${rows
    .filter(([, v]) => v)
    .map(([k, v]) => `<div class="kv-row"><dt>${esc(k)}</dt><dd>${v}</dd></div>`)
    .join("")}</dl>`;
}

export function linkRow(href, title, meta = "", right = "") {
  return `
<a class="list-row link-row" href="${esc(href)}">
  <div><div class="list-title">${esc(title)}</div>${meta ? `<div class="list-meta">${esc(meta)}</div>` : ""}</div>
  <span class="row-end">${right}<span class="chev" aria-hidden="true">›</span></span>
</a>`;
}

export function sourceLink(url, label = "Source") {
  const u = safeUrl(url);
  return u ? `<a class="inline-link source-link" href="${esc(u)}" target="_blank" rel="noopener">${esc(label)} ↗</a>` : "";
}

export function card({ href, label, title, who, chips = "", left = "", right = "", level = "" }) {
  return `
<a class="card issue-card" href="${esc(href)}"${level ? ` data-level="${esc(level)}"` : ""}>
  <p class="label">${esc(label)}</p>
  <h3>${esc(title)}</h3>
  <p class="secondary small">${esc(who)}</p>
  ${chips ? `<div class="chips">${chips}</div>` : ""}
  <div class="issue-foot"><span>${left}</span><span>${right}</span></div>
</a>`;
}

export function section(label, inner, cls = "card stack") {
  return `<section class="${cls}"><h2 class="label">${esc(label)}</h2>${inner}</section>`;
}

// ---------------------------------------------------------------------------
// Failing gracefully. A data-heavy page loads each section on its own: if one
// section's data can't load, the rest of the page still shows, with a short
// note where that section would be (and the page isn't cached).

export const FAILED = Symbol("section failed");

/**
 * Runs one section's loader. Returns its value, or FAILED (logged) if it
 * threw. A missing table (before the first sync) returns `missingValue`.
 */
export async function loadSection(name, fn, missingValue = FAILED) {
  try {
    return await fn();
  } catch (err) {
    if (missingValue !== FAILED && /no such table|no such column/i.test(String(err && err.message))) return missingValue;
    console.error(`section "${name}" failed: ${err && err.name}: ${err && err.message}`);
    return FAILED;
  }
}

/** True if any of the values is FAILED. */
export const anyFailed = (...values) => values.some((v) => v === FAILED);

/** The note shown where a section couldn't load. */
export function sectionError(label) {
  return `<section class="card stack-sm section-error" role="status">
  ${label ? `<h2 class="label">${esc(label)}</h2>` : ""}
  <p class="small secondary">Couldn't load this section right now. The rest of the page is fine; try again in a few minutes.</p>
</section>`;
}

/** The page shown when a whole page fails: the shell and nav, never Cloudflare's error. */
export function errorPage(tab = null) {
  return page(
    "Something went wrong",
    `<header class="page-head"><h1>Couldn't load this page</h1><p class="subtitle">Something went wrong on our side. Please try again in a few minutes.</p></header>
<section class="card stack-sm">
  <p class="small">The rest of the site is working: <a class="inline-link" href="/">Home</a>, <a class="inline-link" href="/reps/">Reps</a>, <a class="inline-link" href="/laws/">Laws</a>.</p>
</section>`,
    { tab, root: true, status: 500 }
  );
}

/** Wraps a page handler so an unexpected error shows errorPage() instead of crashing the Worker. */
export function guard(handler, { tab = null } = {}) {
  return async (context) => {
    try {
      return await handler(context);
    } catch (err) {
      console.error(`${new URL(context.request.url).pathname}: ${err && err.name}: ${err && err.message}`);
      return errorPage(tab);
    }
  };
}

// ---------------------------------------------------------------------------
// Edge cache. A page that's the same for every visitor (no district cookie) is
// kept at Cloudflare's edge for `seconds`, so most visits never reach D1.
// Responses marked private or no-store (personal pages, a failed section, an
// error) are never stored.

export async function edgeCached(context, seconds, render) {
  const { request } = context;
  const cache = typeof caches !== "undefined" ? caches.default : null;
  if (!cache || request.method !== "GET") return render();
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key).catch(() => null);
  if (hit) return hit;
  const res = await render();
  const cc = res.headers.get("Cache-Control") || "";
  if (res.status !== 200 || /private|no-store|no-cache/.test(cc)) return res;
  const out = new Response(res.body, res);
  out.headers.set("Cache-Control", `public, max-age=${seconds}`);
  const put = cache.put(key, out.clone()).catch((err) => console.error(`edge cache: ${err && err.message}`));
  if (context.waitUntil) context.waitUntil(put);
  return out;
}
