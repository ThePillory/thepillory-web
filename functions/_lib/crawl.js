// Keeping crawlers out of endless URL combinations (functions/_middleware.js).
// Filters, "Load more" and "Federal awards" links each make a new address, and
// a crawler that follows every one runs a database query per address. So, on
// every page but /admin/ (files such as /assets/pillory.css?v=53 pass untouched):
//   - checkQuery(): only the query parameters the site's own links and forms
//     use, each once and of sane length; offsets up to MAX_OFFSET and pages up
//     to MAX_PAGE. Anything else gets a short 400 before any database query.
//     Tracking tags (utm_*, fbclid, …) are dropped with a redirect instead, so
//     shared links keep working.
//   - forCrawlers(): on an address with a query string, a robots noindex meta
//     tag; every link on a page to an address with a query string gets
//     rel="nofollow"; a "Load more" or "Older" link past the cap is replaced
//     by a note.
// robots.txt asks crawlers not to fetch query-string addresses at all.

export const MAX_PAGE = 50;
export const MAX_OFFSET = 1250; // 50 pages of 25
const MAX_PARAMS = 8;
const MAX_VALUE = 300;

/** Every query parameter a page reads (outside /admin/). */
export const KNOWN = new Set([
  "name", "q", "offset", "toffset", "page", "state", "chamber", "sector", "filter", "show", "clause", "vote", "votes",
  "party", "position", "level", "year", "cycle", "status", "browse", "sort", "layer", "st", "lookup", "waitlist",
  "now", "hub", "pick", "notice", "error", "sent",
]);
const TRACKING = /^(utm_[a-z]+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|igshid|ref|ref_src|_ga)$/i;

/**
 * Whether a request's query string is one the site makes. Pure.
 * Returns { ok: true }, { redirect: <clean URL> } (tracking tags only), or { bad: <reason> }.
 */
export function checkQuery(url) {
  // Files (stylesheets, scripts, icons, data: "/assets/pillory.css?v=53") carry a version tag and run no query.
  if (url.pathname.startsWith("/admin/") || !url.search || /\.[a-z0-9]+$/i.test(url.pathname)) return { ok: true };
  if (url.search.length > 1000) return { bad: "The address is too long." };
  const seen = new Set();
  let tracking = false;
  let n = 0;
  for (const [k, v] of url.searchParams) {
    if (TRACKING.test(k)) {
      tracking = true;
      continue;
    }
    n += 1;
    if (!KNOWN.has(k)) return { bad: `This page doesn't take "${k.slice(0, 40)}".` };
    if (seen.has(k)) return { bad: `"${k}" is given more than once.` };
    seen.add(k);
    if (v.length > MAX_VALUE) return { bad: `"${k}" is too long.` };
    if (k === "offset" || k === "toffset") {
      if (v !== "" && (!/^\d{1,6}$/.test(v) || Number(v) > MAX_OFFSET)) return { bad: `Lists here go up to item ${MAX_OFFSET.toLocaleString("en-US")}. Use the filters or search to narrow the list.` };
    }
    // /corrections/?page= is the address of the page being reported, not a page number.
    if (k === "page" && !url.pathname.startsWith("/corrections/")) {
      if (v !== "" && (!/^\d{1,4}$/.test(v) || Number(v) > MAX_PAGE)) return { bad: `Lists here go up to page ${MAX_PAGE}. Use the filters or search to narrow the list.` };
    }
    if (k === "year" && v !== "" && !/^\d{4}$/.test(v)) return { bad: "The year isn't a year." };
  }
  if (n > MAX_PARAMS) return { bad: "Too many filters at once." };
  if (tracking) {
    const clean = new URL(url);
    for (const k of [...clean.searchParams.keys()]) if (TRACKING.test(k)) clean.searchParams.delete(k);
    return { redirect: clean.toString() };
  }
  return { ok: true };
}

/** The short answer to an address checkQuery() refuses: plain text, no database. */
export function badRequest(reason) {
  return new Response(`400 Bad request. ${reason}\n`, {
    status: 400,
    headers: { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "public, max-age=3600", "X-Robots-Tag": "noindex" },
  });
}

const PAST_CAP = '<p class="small secondary">That\'s as far as this list goes here. Use the filters or search to narrow it.</p>';

/** Is this link's next page past the cap? Pure. */
export function pastCap(href) {
  const m = /[?&](?:amp;)?(offset|toffset|page)=(\d+)/.exec(href);
  if (!m) return false;
  return m[1] === "page" ? Number(m[2]) > MAX_PAGE : Number(m[2]) > MAX_OFFSET;
}

/**
 * A page's HTML for crawlers. Pure.
 *   noindex: this address has a query string (a filtered or later page)
 * Links to addresses with a query string get rel="nofollow"; "Load more" links
 * past the cap become a note.
 */
export function forCrawlers(html, { noindex = false } = {}) {
  let out = html.replace(/<a\b([^>]*?)\shref="(\/[^"]*\?[^"]*)"([^>]*)>([\s\S]*?)<\/a>/g, (whole, before, href, after, inner) => {
    if (/^\/admin\//.test(href)) return whole;
    if (pastCap(href)) return PAST_CAP;
    const attrs = `${before}${after}`;
    const rel = /\srel="([^"]*)"/.exec(attrs);
    if (rel) {
      if (/\bnofollow\b/.test(rel[1])) return whole;
      return whole.replace(rel[0], ` rel="${rel[1]} nofollow"`);
    }
    return `<a${before} href="${href}" rel="nofollow"${after}>${inner}</a>`;
  });
  if (noindex && !/<meta name="robots"/.test(out)) out = out.replace("</head>", '<meta name="robots" content="noindex, nofollow">\n</head>');
  return out;
}
