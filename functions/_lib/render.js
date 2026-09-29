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

export function page(title, main, { tab = null, root = false, back = null, status = 200 } = {}) {
  const nav = tab ? TABBARS[tab][root ? "root" : "sub"] : "";
  const backHtml = back ? `<a class="back-link" href="${esc(back[1])}">← ${esc(back[0])}</a>` : "";
  // Function replacements: data may contain "$", which .replace() would treat as a pattern.
  const html = PAGE.split("%%TITLE%%").join(esc(title))
    .replace("%%NAV%%", () => nav)
    .replace("%%BACK%%", () => backHtml)
    .replace("%%MAIN%%", () => main);
  return new Response(html, {
    status,
    headers: {
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
