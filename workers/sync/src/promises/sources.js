// Where promises come from, the same kinds of source for every official of a
// kind: official press releases, inaugural and State of the Union / State of
// the State addresses, and for county supervisors, meeting agendas and minutes.
// Pure parsers only (no network); tested with saved responses.
//
//   The President   whitehouse.gov/releases/feed/ (press releases, full text in
//                   the feed), whitehouse.gov/remarks/feed/ (the inaugural
//                   address), and govinfo's Compilation of Presidential
//                   Documents for addresses before a joint session of Congress
//   The Governor    gov.ca.gov's WordPress API, category "Press releases" (17):
//                   press releases, and State of the State addresses posted there
//   Supervisors     the Board of Supervisors' agenda text already in D1
//                   (meeting_items); minutes when the county posts them

/** Plain text from HTML (or WordPress builder shortcodes), keeping paragraph breaks as spaces. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/\[\/?et_pb_[^\]]*\]/g, " ") // Divi builder shortcodes on gov.ca.gov
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|li|h\d|blockquote)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&quot;|&#8220;|&#8221;|&#822[01];/g, '"')
    .replace(/&#8216;|&#8217;|&#039;|&#39;|&rsquo;|&lsquo;/g, "'")
    .replace(/&#8211;|&#8212;|&ndash;|&mdash;/g, "-")
    .replace(/&#8230;|&hellip;/g, "...")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

const tag = (block, name) => {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "").trim() : "";
};

/** ISO date from an RSS pubDate ("Mon, 20 Jan 2025 22:13:54 +0000"). */
export function rssDate(s) {
  const t = Date.parse(s || "");
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

/**
 * Items of a WordPress RSS feed with full text (content:encoded), e.g.
 * whitehouse.gov/releases/feed/. Only links on the feed's own site are kept.
 */
export function parseRssWithContent(xml, { origin, kind }) {
  const out = [];
  for (const m of String(xml || "").matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const it = m[1];
    const link = tag(it, "link");
    if (!link.startsWith(origin)) continue;
    const content = /<content:encoded><!\[CDATA\[([\s\S]*?)\]\]><\/content:encoded>/.exec(it);
    out.push({
      url: link,
      title: htmlToText(tag(it, "title")),
      published_on: rssDate(tag(it, "pubDate")),
      kind: kind(tag(it, "title"), link),
      text: content ? htmlToText(content[1]) : "",
    });
  }
  return out;
}

/** gov.ca.gov wp-json posts (fields id, date, link, title, content). */
export function parseWpPosts(json, origin = "https://www.gov.ca.gov/") {
  return (Array.isArray(json) ? json : [])
    .filter((p) => p && typeof p.link === "string" && p.link.startsWith(origin))
    .map((p) => {
      const title = htmlToText((p.title && p.title.rendered) || "");
      return {
        url: p.link,
        title,
        published_on: String(p.date || "").slice(0, 10) || null,
        kind: /state of the state|inaugural/i.test(title) ? "address" : "press_release",
        text: htmlToText((p.content && p.content.rendered) || ""),
      };
    });
}

/** govinfo CPD collection packages that are addresses (inaugural, joint session / State of the Union). */
export function addressPackages(json) {
  return ((json && json.packages) || [])
    .filter((p) => /inaugural address|address before a joint session of the congress|state of the union/i.test(p.title || ""))
    .map((p) => ({ packageId: p.packageId, title: p.title, published_on: String(p.dateIssued || "").slice(0, 10) || null }));
}

/** The whitehouse.gov feed item kind: the inaugural address, or a press release. */
export const whiteHouseKind = (title) => (/inaugural address|joint address|state of the union/i.test(title) ? "address" : "press_release");

// Press releases that carry no commitments of the official's own (lists of
// appointments, nominations sent to the Senate, schedules) aren't read.
const NOT_COMMITMENTS = /\b(announces appointments|nominations sent to the senate|legislative update|weekly schedule|week ahead|proclaims|proclamation|recognizes|honors|mourns|statement on the passing)\b/i;
export const worthReading = (title) => !NOT_COMMITMENTS.test(title || "");

/** Text sent to the model, cut to a length a single call can read. */
export function clip(text, max = 40000) {
  const t = String(text || "");
  return t.length <= max ? t : `${t.slice(0, max)}\n[The rest of the document was not read.]`;
}

/**
 * Take turns between officials (groups), newest document first within each,
 * so the daily reads are shared alike rather than going to whoever posts most.
 */
export function roundRobin(rows, limit) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.official_id)) groups.set(r.official_id, []);
    groups.get(r.official_id).push(r);
  }
  for (const list of groups.values()) list.sort((a, b) => String(b.published_on || "").localeCompare(String(a.published_on || "")));
  const out = [];
  const lists = [...groups.values()];
  for (let i = 0; out.length < limit && lists.some((l) => l.length); i = (i + 1) % lists.length) {
    if (lists[i].length) out.push(lists[i].shift());
  }
  return out;
}
