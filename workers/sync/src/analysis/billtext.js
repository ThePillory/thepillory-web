// The bill's own words, for the analysis. Federal: the latest text version on
// Congress.gov. California: the current text on leginfo. If no text is
// available, the official summary, and the draft is marked "limited".
import { api } from "../congress-api.js";

const LEGINFO = "https://leginfo.legislature.ca.gov";

/** HTML to plain text with paragraph breaks. */
export function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style|head)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<(br|\/p|\/div|\/h\d|\/li|\/tr|\/pre)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function cap(env, source) {
  const max = parseInt(env.MAX_BILL_TEXT_CHARS || "400000", 10);
  if (source.basis === "full_text" && source.text.length > max) {
    const total = source.text.length;
    return {
      ...source,
      basis: "partial_text",
      text: source.text.slice(0, max),
      note: `the first ${max.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters`,
    };
  }
  return source;
}

/**
 * Returns {basis, text, source_url, version, note} or null when there is
 * neither text nor an official summary.
 */
export async function fetchBillText(env, budget, bill) {
  const src = bill.level === "federal" ? await federal(env, budget, bill) : await california(env, budget, bill);
  return src && cap(env, src);
}

// ---------------------------------------------------------------------------
// Long bills and short cards
//
// A short card doesn't need every page of a 500-page bill, and reading it all
// twice (once to draft, once for the AI reviewer) is what made H.R. 9497 cost
// 142,000 input tokens per call. For a card, a bill longer than CARD_TEXT_CHARS
// (default 60,000 characters, about 15,000 tokens) is condensed to:
//   1. the official summary (Congress.gov's CRS summary; a California bill's
//      Legislative Counsel's Digest is at the top of its text already),
//   2. the list of its titles and sections, and
//   3. its opening text, up to the limit.
// The draft is marked "limited" and says so, and the AI reviewer checks it
// against exactly the same text. Full analyses still read the whole bill
// (up to MAX_BILL_TEXT_CHARS).

const HEADING = /^(TITLE [IVXLC]+\b|Subtitle [A-Z]\b|DIVISION [A-Z]\b|CHAPTER \d+|PART [IVXLC\d]+\b|SEC(?:TION)?\.? \d+[A-Z]?\.|Sec\. \d+[A-Z]?\.|SECTION \d+\.)/;

/** The bill's own headings (titles, subtitles, sections), one per line. Pure; tested. */
export function sectionHeadings(text, maxChars = 15000) {
  const out = [];
  let used = 0;
  for (const line of String(text || "").split("\n")) {
    if (!HEADING.test(line)) continue;
    const h = line.length > 160 ? `${line.slice(0, 159)}…` : line;
    if (used + h.length + 1 > maxChars) break;
    out.push(h);
    used += h.length + 1;
  }
  return out;
}

/** Condense a long full text for a card. Pure; tested. */
export function condense(source, { limit, summary = null }) {
  if (source.basis !== "full_text" || source.text.length <= limit) return source;
  const total = source.text.length;
  const parts = [];
  if (summary) parts.push(`OFFICIAL SUMMARY (${summary.label}):\n${summary.text}`);
  const headings = sectionHeadings(source.text, Math.floor(limit / 4));
  if (headings.length) parts.push(`LIST OF TITLES AND SECTIONS (from the bill text):\n${headings.join("\n")}`);
  // At least half the limit goes to the bill's own opening text.
  const room = Math.max(Math.floor(limit / 2), limit - parts.join("\n\n").length - 200);
  const opening = source.text.slice(0, room);
  parts.push(`OPENING TEXT OF THE BILL (the first ${opening.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters):\n${opening}`);
  const what = [summary ? "the official summary" : null, headings.length ? "the list of sections" : null, `the first ${opening.length.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} characters`].filter(Boolean);
  return {
    ...source,
    basis: "partial_text",
    text: parts.join("\n\n"),
    note: what.length > 1 ? `${what.slice(0, -1).join(", ")} and ${what[what.length - 1]}` : what[0],
    condensed: true,
  };
}

/** The text a card is drafted and reviewed from: condensed when the bill is long. */
export async function cardSource(env, budget, bill, source) {
  const limit = parseInt(env.CARD_TEXT_CHARS || "60000", 10);
  if (!source || source.basis !== "full_text" || source.text.length <= limit) return source;
  let summary = null;
  if (bill.level === "federal") {
    try {
      summary = await federalSummary(env, budget, bill);
    } catch (err) {
      if (err && err.name === "BudgetExhausted") throw err;
      summary = null; // the section list and opening text still go
    }
  }
  return condense(source, { limit, summary: summary && { label: summary.version, text: summary.text } });
}

async function federalSummary(env, budget, bill) {
  const m = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(bill.id);
  if (!m) return null;
  const sums = await budget.json(api(env, `/bill/${m[1]}/${m[2]}/${m[3]}/summaries`), {}, `bill summaries ${bill.id}`);
  const latest = (sums.summaries || []).slice().sort((a, b) => String(b.updateDate || "").localeCompare(String(a.updateDate || "")))[0];
  return latest && latest.text ? { text: htmlToText(latest.text), version: ["CRS summary", latest.actionDesc, latest.actionDate].filter(Boolean).join(", ") } : null;
}

async function federal(env, budget, bill) {
  const m = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(bill.id);
  if (!m) return null;
  const [, congress, type, number] = m;
  const base = `/bill/${congress}/${type}/${number}`;
  const data = await budget.json(api(env, `${base}/text`), {}, `bill text list ${bill.id}`);
  // Newest first; a version without a date yet is the newest.
  const versions = (data.textVersions || []).slice().sort((a, b) => (b.date || "9999").localeCompare(a.date || "9999"));
  for (const v of versions) {
    const f = (v.formats || []).find((x) => /formatted text/i.test(x.type || "")) || (v.formats || []).find((x) => /\.htm/i.test(x.url || ""));
    if (!f || !f.url) continue;
    const html = await budget.text(f.url, {}, `bill text ${bill.id}`);
    const text = htmlToText(html);
    if (text.length > 200) {
      return { basis: "full_text", text, source_url: f.url, version: [v.type, v.date && v.date.slice(0, 10)].filter(Boolean).join(", ") };
    }
  }
  const sums = await budget.json(api(env, `${base}/summaries`), {}, `bill summaries ${bill.id}`);
  const latest = (sums.summaries || []).slice().sort((a, b) => String(b.updateDate || "").localeCompare(String(a.updateDate || "")))[0];
  if (latest && latest.text) {
    return {
      basis: "summary_only",
      text: htmlToText(latest.text),
      source_url: bill.official_url || bill.source_url,
      version: ["CRS summary", latest.actionDesc, latest.actionDate].filter(Boolean).join(", "),
    };
  }
  return null;
}

async function california(env, budget, bill) {
  const id = `${bill.session}0${String(bill.bill_number || "").replace(/\s+/g, "")}`;
  const url = `${env.LEGINFO_BASE || LEGINFO}/faces/billTextClient.xhtml?bill_id=${encodeURIComponent(id)}`;
  const html = await budget.text(url, {}, `leginfo text ${bill.id}`);
  const at = html.search(/id=["']bill_all["']/i);
  if (at >= 0) {
    const end = html.slice(at).search(/id=["'](footer|bottom)[^"']*["']/i);
    const text = htmlToText(html.slice(at).slice(html.slice(at).indexOf(">") + 1, end > 0 ? end : undefined));
    if (text.length > 300) {
      const version = (html.match(/<span[^>]*id=["']?[^"'>]*version[^"'>]*["']?[^>]*>([^<]+)</i) || [])[1];
      return { basis: "full_text", text, source_url: url.replace(env.LEGINFO_BASE || LEGINFO, LEGINFO), version: version ? version.trim() : null };
    }
  }
  if (bill.summary && bill.summary.trim()) {
    return { basis: "summary_only", text: bill.summary.trim(), source_url: bill.official_url || bill.source_url, version: "summary on file" };
  }
  return null;
}

// ---------------------------------------------------------------------------
// The official description, for the relevance check (saved on the bill once)
//   federal     Congress.gov's latest CRS summary; before CRS writes one, the
//               official title as introduced ("To amend … to …")
//   California  the Legislative Counsel's Digest at the top of the bill text,
//               including the bill's "An act to …" title

const SUMMARY_CHARS = 6000;

/** The Legislative Counsel's Digest from a leginfo bill text page, or null. Pure. */
export function caDigest(html) {
  const text = htmlToText(html);
  const start = text.search(/LEGISLATIVE COUNSEL[’']S DIGEST/i);
  if (start < 0) return null;
  const rest = text.slice(start).replace(/^LEGISLATIVE COUNSEL[’']S DIGEST\s*/i, "");
  const end = rest.search(/The people of the State of California do enact as follows|^Digest Key|^Vote:/im);
  const digest = (end > 0 ? rest.slice(0, end) : rest).trim();
  return digest.length > 40 ? digest.slice(0, SUMMARY_CHARS) : null;
}

/** Returns {text, label, url} or null. A source that has nothing (404) is null, not an error. */
export async function officialSummary(env, budget, bill) {
  const missing = (err) => err && err.name === "UpstreamError" && (err.status === 404 || err.status === 400);
  if (bill.level === "federal") {
    const m = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(bill.id);
    if (!m) return null;
    try {
      const s = await federalSummary(env, budget, bill);
      if (s) return { text: s.text.slice(0, SUMMARY_CHARS), label: s.version, url: bill.official_url || bill.source_url };
    } catch (err) {
      if (!missing(err)) throw err;
    }
    try {
      const data = await budget.json(api(env, `/bill/${m[1]}/${m[2]}/${m[3]}/titles`), {}, `bill titles ${bill.id}`);
      const titles = data.titles || [];
      const official = titles.find((t) => /^Official Title as Introduced/i.test(t.titleType || "")) || titles.find((t) => /^Official Title/i.test(t.titleType || ""));
      if (official && official.title) return { text: String(official.title).trim().slice(0, SUMMARY_CHARS), label: official.titleType, url: bill.official_url || bill.source_url };
    } catch (err) {
      if (!missing(err)) throw err;
    }
    return null;
  }
  const id = `${bill.session}0${String(bill.bill_number || "").replace(/\s+/g, "")}`;
  const url = `${env.LEGINFO_BASE || LEGINFO}/faces/billTextClient.xhtml?bill_id=${encodeURIComponent(id)}`;
  let html;
  try {
    html = await budget.text(url, {}, `leginfo digest ${bill.id}`);
  } catch (err) {
    if (!missing(err)) throw err;
    return null;
  }
  const digest = caDigest(html);
  return digest ? { text: digest, label: "Legislative Counsel's Digest", url: url.replace(env.LEGINFO_BASE || LEGINFO, LEGINFO) } : null;
}
