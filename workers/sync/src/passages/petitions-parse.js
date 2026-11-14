// The House Clerk's discharge petition pages (clerk.house.gov/DischargePetition), read as the
// Clerk publishes them: each petition's number, the rule (H.Res.) it would discharge, the bill that
// rule provides for, the date filed, and each Member's signature with its date. Pure; tested in
// workers/sync/test/passages.test.mjs.

const MONTHS = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
const decode = (s) => String(s || "").replace(/&#x27;|&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, "&").replace(/&nbsp;/g, " ");
const text = (html) => decode(String(html || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();

/** "March 10th, 2025" / "March 10, 2025" / "3/10/2025" -> "2025-03-10"; null otherwise. Pure. */
export function clerkDate(s) {
  const t = String(s || "").trim();
  const m = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:st|nd|rd|th)?,\s*(\d{4})/i.exec(t);
  if (m) return `${m[3]}-${MONTHS[m[1].toLowerCase()]}-${m[2].padStart(2, "0")}`;
  const n = /\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/.exec(t);
  return n ? `${n[3]}-${n[1].padStart(2, "0")}-${n[2].padStart(2, "0")}` : null;
}

/** "H.R. 2102", "H. Res. 23", "H. J. Res. 72", "H.Res. 164" -> "us-<congress>-hr-2102" etc. Pure. */
export function billIdFrom(label, congress) {
  const m = /\b(H\.?\s?R\.?|H\.?\s?Res\.?|H\.?\s?J\.?\s?Res\.?|H\.?\s?Con\.?\s?Res\.?|S\.?)\s*(\d+)\b/i.exec(String(label || ""));
  if (!m) return null;
  const k = m[1].replace(/[\s.]/g, "").toLowerCase();
  const type = { hr: "hr", hres: "hres", hjres: "hjres", hconres: "hconres", s: "s" }[k];
  return type ? `us-${congress}-${type}-${m[2]}` : null;
}

/**
 * One page of the Clerk's petition list (/DischargePetition/DischargePetitions?Page=N&CongressNum=C):
 * [{number, description, href, rule_id, bill_id, filed_on, sponsor}] and the page count. Pure.
 */
export function parsePetitionList(html, congress) {
  const out = [];
  const blocks = String(html || "").split(/class="role-call-vote discharge-petition-result"/).slice(1);
  for (const b of blocks) {
    const num = /Discharge Petition No\.\s*(\d+)/.exec(b);
    if (!num) continue;
    const desc = /Description:<\/label>([\s\S]*?)<\/p>/.exec(b);
    const href = /href=["']?(\/DischargePetition\/\d+)/.exec(b);
    const rule = /Bill Number:<\/label>[\s\S]*?>([^<]+)<\/a>/.exec(b);
    const filed = /Petition Date:<\/label>([^<]*)</.exec(b);
    const sponsor = /Sponsor:<\/label>[\s\S]*?>([^<]+)<\/a>/.exec(b);
    const description = desc ? text(desc[1]) : "";
    // The bill the rule provides for: "(H.R. 2102)" in "Providing for consideration of the bill (H.R. 2102) ..."
    const inner = /\(((?:H\.?\s?R\.?|H\.?\s?J\.?\s?Res\.?|H\.?\s?Res\.?|H\.?\s?Con\.?\s?Res\.?|S\.?)\s*\d+)\)/i.exec(description);
    out.push({
      number: Number(num[1]),
      description,
      href: href ? href[1] : null,
      rule_id: rule ? billIdFrom(text(rule[1]), congress) : null,
      bill_id: inner ? billIdFrom(inner[1], congress) : rule ? billIdFrom(text(rule[1]), congress) : null,
      filed_on: filed ? clerkDate(filed[1]) : null,
      sponsor: sponsor ? text(sponsor[1]) : null,
    });
  }
  const pages = [...String(html || "").matchAll(/page (\d+) of (\d+) pages/g)].map((m) => Number(m[2]));
  return { petitions: out, pages: pages.length ? Math.max(...pages) : 1 };
}

/**
 * A petition page's signatures table (#signatures-table): [{bioguide_id, name, state, district, signed_on,
 * withdrawn_on}], one per row, as the Clerk lists them. A row the Clerk marks withdrawn keeps its date. Pure.
 */
export function parseSignatures(html) {
  const t = String(html || "");
  const at = t.search(/id="member-signatures"|id="signatures-table"/);
  if (at < 0) return [];
  const body = t.slice(at, t.indexOf("</table>", at) > 0 ? t.indexOf("</table>", at) : undefined);
  const out = [];
  for (const row of body.split(/<tr[\s>]/).slice(1)) {
    const cells = {};
    for (const m of row.matchAll(/<td[^>]*data-label="([^"]+)"[^>]*>([\s\S]*?)<\/td>/g)) cells[m[1]] = m[2];
    const rep = cells.Representative || "";
    const id = /\/Members\/([A-Z]\d{6})/.exec(rep);
    const name = text(rep).replace(/\s*&#xD;\s*/g, " ").replace(/\s+/g, " ");
    if (!name) continue;
    const signed = cells["Signed Date"] || "";
    const hidden = /display:\s*none;?">\s*([0-9/]+)/.exec(signed);
    const withdrawn = /withdr[ae]w[^<]*?((?:January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:st|nd|rd|th)?,\s*\d{4}|\d{1,2}\/\d{1,2}\/\d{4})/i.exec(text(row));
    out.push({
      bioguide_id: id ? id[1] : null,
      name,
      state: cells.State ? text(cells.State) : null,
      district: cells.District ? text(cells.District) : null,
      signed_on: clerkDate(hidden ? hidden[1] : text(signed)),
      withdrawn_on: withdrawn ? clerkDate(withdrawn[1]) : null,
    });
  }
  return out;
}
