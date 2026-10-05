// Parsers for the executive branch's sources. Pure functions (no fetching), so
// the Pages Functions can import them and test/executive.test.mjs can run them
// against saved responses. See docs/executive.md.

const decode = (s) =>
  String(s || "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&#160;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#8217;|&rsquo;/g, "’")
    .replace(/&#8216;|&lsquo;/g, "‘")
    .replace(/&#8220;|&ldquo;/g, "“")
    .replace(/&#8221;|&rdquo;/g, "”")
    .replace(/&#8211;|&ndash;/g, "–")
    .replace(/&#8212;|&mdash;/g, "—")
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, " ")
    .trim();

/** MM/DD/YY or MM/DD/YYYY to YYYY-MM-DD. */
export function isoDate(us) {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(String(us || "").trim());
  if (!m) return null;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}`;
}

/** The Congress in session on a date (each starts January 3 of an odd year). */
export const currentCongress = (d = new Date()) =>
  Math.floor((d.getUTCFullYear() - 1789) / 2) + 1 - (d.getUTCMonth() === 0 && d.getUTCDate() < 3 && d.getUTCFullYear() % 2 === 1 ? 1 : 0);

// ---------------------------------------------------------------------------
// The President and Vice President: congress-legislators' executive.json

export function personName(p) {
  const n = p.name || {};
  return n.official_full || [n.first, n.middle, n.last, n.suffix].filter(Boolean).join(" ");
}

/** Who held each office on `date` (YYYY-MM-DD): { prez: {person, term}, viceprez: {person, term} }. */
export function executiveOn(executive, date) {
  const out = {};
  for (const p of executive || []) {
    for (const t of p.terms || []) {
      if ((t.type === "prez" || t.type === "viceprez") && t.start <= date && date < t.end) out[t.type] = { person: p, term: t };
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// The Cabinet: whitehouse.gov/administration/cabinet/, each member an <h2> name
// followed by an <h3> title.

export function parseCabinet(html) {
  const out = [];
  // A heading's content never runs into another heading.
  const re = /<h2[^>]*>((?:(?!<\/?h[23])[\s\S]){1,300})<\/h2>\s*(?:<hr[^>]*>\s*)?<h3[^>]*>((?:(?!<\/?h[23])[\s\S]){1,300})<\/h3>/g;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const name = decode(m[1]);
    const title = decode(m[2]);
    // A person's name, then an office ("Secretary of …", "Director of …", "Attorney General").
    if (!/^[A-Z][\w.'’-]*(?: [A-Z][\w.,'’-]*){1,5}$/.test(name)) continue;
    if (!title || title.length > 120 || /[.!?]$/.test(title)) continue;
    if (!/(Secretary|Attorney General|Director|Administrator|Representative|Ambassador|Chief of Staff|Vice President)/.test(title)) continue;
    if (!out.some((x) => x.name === name)) out.push({ name, title });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Executive orders: the Federal Register API

export function frOrder(doc) {
  return {
    id: `fr:${doc.document_number}`,
    kind: "executive_order",
    number: doc.executive_order_number ? String(doc.executive_order_number) : null,
    title: decode(doc.title),
    signed_on: doc.signing_date || null,
    published_on: doc.publication_date || null,
    citation: doc.citation || null,
    document_url: doc.pdf_url || null,
    source_url: doc.html_url,
  };
}

// ---------------------------------------------------------------------------
// Bills signed and vetoed

const OUTCOME_TYPES = /^(hr|s|hjres|sjres)$/;
export const presentableFederal = (type) => OUTCOME_TYPES.test(String(type || "").toLowerCase());

/**
 * A federal bill's outcome from its Congress.gov actions (any order). Returns
 * null when the bill hasn't reached the President.
 */
export function federalOutcome(actions) {
  const rows = (actions || []).map((a) => ({ date: a.actionDate, text: String(a.text || "").trim() }));
  const first = (re) => rows.filter((r) => re.test(r.text)).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const presented = first(/^Presented to President/i);
  const signed = first(/^Signed by President/i);
  const pocket = first(/^Pocket Vetoed by President/i);
  const veto = first(/^Vetoed by President/i);
  const law = first(/Became (Public|Private) Law No:/i);
  const without = rows.find((r) => /without (the President's |his |her )?signature/i.test(r.text)) || null;
  const lawNumber = law ? `${/Private/i.test(law.text) ? "Private" : "Public"} Law ${(/No:\s*([\d-]+)/.exec(law.text) || [])[1] || ""}`.trim() : null;
  const base = { presented_on: presented ? presented.date : null, law_number: lawNumber };
  if (law) {
    if (veto || pocket) return { ...base, outcome: "over_veto", action_date: law.date, action_text: law.text };
    if (signed) return { ...base, outcome: "signed", action_date: signed.date, action_text: signed.text };
    if (without) return { ...base, outcome: "without_signature", action_date: without.date, action_text: without.text };
    return { ...base, outcome: "became_law", action_date: law.date, action_text: law.text };
  }
  if (pocket) return { ...base, outcome: "pocket_vetoed", action_date: pocket.date, action_text: pocket.text };
  if (veto) return { ...base, outcome: "vetoed", action_date: veto.date, action_text: veto.text };
  if (presented) return { ...base, outcome: "presented", action_date: presented.date, action_text: presented.text };
  return null;
}

/** A Congress.gov bill list entry whose latest action means its outcome is worth checking. */
export const federalWorthChecking = (latestText) =>
  /Presented to President|Signed by President|Vetoed|Pocket Vetoed|Became (Public|Private) Law|veto/i.test(String(latestText || ""));

/** leginfo's bill history table (#billhistory): [{date: YYYY-MM-DD, action}], newest first as published. */
export function parseLeginfoHistory(html) {
  const t = String(html || "");
  const start = t.indexOf('id="billhistory"');
  if (start < 0) return [];
  const table = t.slice(start, t.indexOf("</table>", start));
  const out = [];
  const re = /<tr>\s*<td[^>]*>([^<]*)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/g;
  let m;
  while ((m = re.exec(table))) {
    const date = isoDate(decode(m[1]));
    if (date) out.push({ date, action: decode(m[2]) });
  }
  return out;
}

/** A California bill's outcome from its leginfo history. Null before it reaches the Governor. */
export function californiaOutcome(rows) {
  const first = (re) => (rows || []).filter((r) => re.test(r.action)).sort((a, b) => (a.date < b.date ? -1 : 1))[0] || null;
  const presented = first(/presented to the Governor/i);
  const approved = first(/^Approved by the Governor/i);
  const veto = first(/^Vetoed by (the )?Governor/i);
  const chaptered = first(/^Chaptered by Secretary of State/i);
  const without = first(/without (the )?Governor'?s? signature/i);
  const override = first(/veto overridden|over the Governor'?s veto/i);
  const chapter = chaptered ? (/(Chapter \d+, Statutes of \d{4})/i.exec(chaptered.action) || [])[1] || null : null;
  const base = { presented_on: presented ? presented.date : null, law_number: chapter };
  if (chaptered) {
    if (override || veto) return { ...base, outcome: "over_veto", action_date: chaptered.date, action_text: chaptered.action };
    if (approved) return { ...base, outcome: "signed", action_date: approved.date, action_text: approved.action };
    if (without) return { ...base, outcome: "without_signature", action_date: without.date, action_text: without.action };
    return { ...base, outcome: "became_law", action_date: chaptered.date, action_text: chaptered.action };
  }
  if (veto) return { ...base, outcome: "vetoed", action_date: veto.date, action_text: veto.action };
  if (presented) return { ...base, outcome: "presented", action_date: presented.date, action_text: presented.action };
  return null;
}

/** leginfo's bill_id for a ThePillory CA bill id ('ca-20252026-ab-123' → '202520260AB123'). */
export function leginfoBillId(billId) {
  const m = /^ca-(\d{8})-([a-z]+?)(?:x(\d+))?-(\d+)$/.exec(String(billId || ""));
  if (!m) return null;
  return `${m[1]}${m[3] || "0"}${m[2].toUpperCase()}${m[4]}`;
}
export const presentableCalifornia = (billId) => /^ca-\d{8}-(ab|sb)(x\d+)?-\d+$/.test(String(billId || ""));
export const leginfoHistoryUrl = (lid) => `https://leginfo.legislature.ca.gov/faces/billHistoryClient.xhtml?bill_id=${lid}`;

// ---------------------------------------------------------------------------
// The Governor's executive orders: gov.ca.gov's "Executive orders" feed and posts

export function parseGovFeed(xml, origin = "https://www.gov.ca.gov/") {
  const out = [];
  for (const item of String(xml || "").split("<item>").slice(1)) {
    const tag = (n) => {
      const m = new RegExp(`<${n}(?:\\s[^>]*)?>([\\s\\S]*?)</${n}>`).exec(item);
      return m ? decode(m[1].replace(/^<!\[CDATA\[|\]\]>$/g, "")) : "";
    };
    const link = tag("link");
    const guid = /[?&]p=(\d+)/.exec(tag("guid"));
    const pub = Date.parse(tag("pubDate"));
    if (!link.startsWith(origin) || !guid || Number.isNaN(pub)) continue;
    const title = tag("title");
    out.push({
      id: `ca-gov:${guid[1]}`,
      title,
      link,
      published_on: new Date(pub).toISOString().slice(0, 10),
      kind: /executive order/i.test(title) ? "executive_order" : /proclaim|proclamation|state of emergency/i.test(title) ? "proclamation" : "other",
    });
  }
  return out;
}

/** The signed order linked from a Governor's post: its PDF and number ('N-9-26'), when present. */
export function govOrderFromPost(html) {
  const links = [...String(html || "").matchAll(/href="(https:\/\/www\.gov\.ca\.gov\/wp-content\/uploads\/[^"]+\.pdf)"/gi)].map((m) => m[1]);
  const pdf = links.find((u) => /(^|[^A-Z])N-\d{1,3}-\d{2}([^0-9]|$)/i.test(u.split("/").pop())) || links.find((u) => /EO|proclamation/i.test(u.split("/").pop())) || null;
  const num = pdf ? /(?:^|[^A-Z])(N-\d{1,3}-\d{2})(?:[^0-9]|$)/i.exec(pdf.split("/").pop()) : null;
  return { document_url: pdf, number: num ? num[1].toUpperCase() : null };
}

// ---------------------------------------------------------------------------
// Nominations: Congress.gov

export function nominationStatus(text) {
  const t = String(text || "");
  if (/Confirmed by the Senate/i.test(t)) return "confirmed";
  if (/withdraw/i.test(t)) return "withdrawn";
  if (/Returned to the President/i.test(t)) return "returned";
  if (/(rejected|failed of confirmation|not confirmed)/i.test(t)) return "failed";
  return "pending";
}

export function nominationRow(n) {
  const id = String(n.citation || "").replace(/\s+/g, "");
  return {
    id,
    congress: Number(n.congress),
    description: decode(n.description),
    organization: n.organization || null,
    received_on: n.receivedDate || null,
    latest_action: n.latestAction ? decode(n.latestAction.text) : null,
    latest_on: n.latestAction ? n.latestAction.actionDate : null,
    status: nominationStatus(n.latestAction && n.latestAction.text),
    source_url: `https://www.congress.gov/nomination/${n.congress}th-congress/${n.number}`,
  };
}

// ---------------------------------------------------------------------------
// Labels shared by the pages

export const OUTCOME_LABEL = {
  presented: "Presented, awaiting action",
  signed: "Signed into law",
  vetoed: "Vetoed",
  pocket_vetoed: "Pocket vetoed",
  without_signature: "Became law without a signature",
  over_veto: "Became law over a veto",
  became_law: "Became law",
};
