// Finding an official's "Issues" or "Priorities" page automatically, by
// following links from their own website (and their campaign site, where one
// is on file). The same rules for every official: only links on the same site,
// and only pages whose own title or heading says Issues, Priorities or
// Platform. A page that can't be found is reported as "No issues page found",
// never guessed. Pure: no network (the sync step in finder-sync.js fetches).

/** Words that name an issues page, in a link's text or in the page's own title or heading. */
const STRONG = /^(?:the |key |my |our |legislative |policy |top |\d{4} )?(?:issues|priorities|platform)(?: (?:&|and) (?:priorities|issues|legislation))?$|^on the issues$|^issues (?:&|and) (?:priorities|policy)$|^(?:legislative|policy) (?:agenda|priorities)$/;
const WEAK = /\b(issues|priorities|platform)\b/;
// Links that mention an issue but aren't an issues page.
const NOT = /\b(constituent|casework|services?|help with|report|contact|newsletter|press|news|media|legislation|bills?|votes?|tickets?|tours?|grants?|federal agenc|agenda item|meeting|calendar|jobs|internships?|visit|flag|academy|nominations?|resources?|login|donate|volunteer)\b/;
const PATH = /\/(on-the-issues|issues|priorities|legislative-priorities|policy-priorities|platform|key-issues|the-issues)\/?$/i;

/** The likely address of the issues page on a site, tried only when the home page links to none. */
export const FALLBACK_PATHS = ["/issues", "/priorities"];

const decode = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&#8217;|&rsquo;|&#039;|&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim();

/** "www.example.house.gov" -> "example.house.gov": the site a link must stay on. */
export function siteKey(u) {
  try {
    return new URL(u).hostname.toLowerCase().replace(/^www\d?\./, "");
  } catch {
    return null;
  }
}

/**
 * Links on a page that may lead to the official's issues page, best first.
 * Each: { url, text, score }. Only http(s) links on the same site.
 */
export function issueLinks(html, baseUrl) {
  const site = siteKey(baseUrl);
  const seen = new Map();
  for (const m of String(html || "").matchAll(/<a\b[^>]*?href\s*=\s*["']([^"'#]+)(?:#[^"']*)?["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let url;
    try {
      url = new URL(m[1].trim(), baseUrl);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(url.protocol) || siteKey(url.href) !== site) continue;
    if (/\.(pdf|jpe?g|png|gif|docx?|xlsx?|zip)$/i.test(url.pathname)) continue;
    url.hash = "";
    url.search = "";
    const text = decode(m[2]).toLowerCase().replace(/[:›»>\s]+$/, "");
    const label = decode((/aria-label\s*=\s*["']([^"']+)["']/i.exec(m[0]) || [])[1] || "").toLowerCase();
    const t = text || label;
    let score = 0;
    if (STRONG.test(t)) score = 100;
    else if (WEAK.test(t) && t.length <= 40 && !NOT.test(t)) score = 60;
    if (PATH.test(url.pathname)) score += score ? 20 : 50;
    if (!score) continue;
    // The issues index, not one issue's page: shorter paths first.
    score -= Math.min(10, url.pathname.split("/").filter(Boolean).length - 1) * 3;
    const prev = seen.get(url.href);
    if (!prev || prev.score < score) seen.set(url.href, { url: url.href, text: decode(m[2]) || decode(label), score });
  }
  return [...seen.values()].sort((a, b) => b.score - a.score || a.url.length - b.url.length);
}

/** The page's own title and first heading. */
export function pageHeadings(html) {
  const title = decode((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1]);
  const h1 = decode((/<h1[^>]*>([\s\S]*?)<\/h1>/i.exec(html) || [])[1]);
  return { title, h1 };
}

/**
 * Whether a fetched page is an issues page: its first heading (or, failing
 * that, its title) names Issues, Priorities or Platform, and it has some text.
 * Returns the heading to show, or null.
 */
export function issuesHeading(html, textLength) {
  const { title, h1 } = pageHeadings(html);
  if (textLength < 300) return null;
  for (const h of [h1, title.split(/\s+[|\-–—:]\s+/)[0], title]) {
    const t = h.toLowerCase().trim();
    if (t && t.length <= 80 && WEAK.test(t) && !NOT.test(t)) return h.slice(0, 120);
  }
  return null;
}
