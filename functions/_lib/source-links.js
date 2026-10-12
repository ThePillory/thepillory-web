// Source links and their copies (migration 0034, filled by the sync's
// source-health, archive-sources and source-copies steps; src/health/). Every
// "Source ↗" link on the site is a promise that the record can be checked:
//   - an archived copy (Internet Archive) is offered beside it, "Archived copy ↗";
//   - when the original is found gone (two checks in a row), the archived copy,
//     or ThePillory's own saved copy (/saved/…), comes first, and the original
//     stays linked beside it.
// Applied to the finished HTML by functions/_middleware.js, to links with the
// classes source-link (sourceLink()) and out-link (outLink()).
import { esc } from "./render.js";

const LINK = /<a class="([^"]*\b(?:source-link|out-link)\b[^"]*)" href="([^"]+)"([^>]*)>([\s\S]*?)<\/a>/g;
const unescape = (s) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

/** The source links in a page's HTML (unescaped URLs). Pure. */
export function linksIn(html) {
  const out = new Set();
  for (const m of String(html).matchAll(LINK)) out.add(unescape(m[2]));
  return [...out];
}

// Kept in this isolate for ten minutes, so a busy page asks D1 once.
const memo = new Map();
const MEMO_MS = 10 * 60 * 1000;

/** {url: {archive_url, copy_key, dead}} for the URLs that have an archived or saved copy, or are gone. */
export async function linkInfo(db, urls) {
  const now = Date.now();
  const out = {};
  const ask = [];
  for (const u of urls) {
    const hit = memo.get(u);
    if (hit && now - hit.at < MEMO_MS) {
      if (hit.info) out[u] = hit.info;
    } else ask.push(u);
  }
  for (let i = 0; i < ask.length; i += 90) {
    const part = ask.slice(i, i + 90);
    let rows = [];
    try {
      rows = (await db.prepare(`SELECT url, archive_url, copy_key, dead_checks FROM source_links WHERE url IN (${part.map(() => "?").join(",")}) AND (archive_url IS NOT NULL OR copy_key IS NOT NULL OR dead_checks >= 2)`).bind(...part).all()).results;
    } catch (err) {
      if (missing(err)) return out;
      throw err;
    }
    const found = new Map(rows.map((r) => [r.url, { archive_url: r.archive_url, copy_key: r.copy_key, dead: r.dead_checks >= 2 }]));
    for (const u of part) {
      const info = found.get(u) || null;
      memo.set(u, { at: now, info });
      if (info) out[u] = info;
    }
  }
  if (memo.size > 5000) memo.clear();
  return out;
}

/** The saved copy's address on this site, from its R2 key ("sources/<hash>.pdf" → "/saved/<hash>.pdf"). Pure. */
export const savedHref = (key) => `/saved/${String(key).replace(/^sources\//, "")}`;

/** The page's HTML with archived and saved copies added to its source links. Pure. */
export function rewriteSourceLinks(html, info) {
  if (!info || !Object.keys(info).length) return html;
  return String(html).replace(LINK, (whole, cls, href, rest, label) => {
    const i = info[unescape(href)];
    if (!i) return whole;
    const copy = (url, text) => `<a class="${cls} copy-link" href="${esc(url)}" target="_blank" rel="noopener">${text} ↗</a>`;
    if (i.dead) {
      const first = i.archive_url ? copy(i.archive_url, "Archived copy") : i.copy_key ? copy(savedHref(i.copy_key), "Saved copy") : null;
      if (!first) return whole;
      const also = i.archive_url && i.copy_key ? ` · ${copy(savedHref(i.copy_key), "Saved copy")}` : "";
      return `${first}${also} <span class="small secondary">(the original, <a class="inline-link" href="${href}"${rest}>${label}</a>, no longer opens)</span>`;
    }
    const extra = [i.archive_url ? `<a class="inline-link archived-link" href="${esc(i.archive_url)}" target="_blank" rel="noopener">Archived copy ↗</a>` : ""].filter(Boolean);
    return extra.length ? `${whole} <span class="archived">${extra.join(" ")}</span>` : whole;
  });
}
