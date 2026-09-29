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
