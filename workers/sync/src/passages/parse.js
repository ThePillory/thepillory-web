// Bills passed without a recorded vote (docs/data-sync.md, "Passage without a recorded vote"):
// pure readers of Congress.gov's actions, cosponsors and related bills, and the wording the
// pages and the weekly email share. Tested in workers/sync/test/passages.test.mjs.
//
// A chamber can pass a bill by voice vote, by unanimous consent or (in the House) without
// objection; none of these records how each member voted. What is on record is said as it is,
// with its source, and nothing is inferred about anyone's position.

export const METHODS = ["voice_vote", "unanimous_consent", "without_objection"];
export const METHOD_WORDS = { voice_vote: "by voice vote", unanimous_consent: "by unanimous consent", without_objection: "without objection" };
export const METHOD_SHORT = { voice_vote: "Voice vote", unanimous_consent: "Unanimous consent", without_objection: "Without objection" };
export const NOT_RECORDED = "Members' individual votes were not recorded.";
export const CHAMBER_WORD = { "us-house": "the House", "us-senate": "the Senate" };

// Library of Congress action codes for passage in each chamber (Congress.gov's own summary actions).
const PASSAGE_CODE = { 8000: "us-house", 17000: "us-senate" };
const RECORDED = /\bRoll no\.|\bRecord Vote\b|\bYeas and Nays\b|\brecorded vote\b|\bYea-Nay\b|\bvote of \d+\s*-\s*\d+/i;

/** The method an action's text names, or null (a recorded vote, or a method the text doesn't name: never guessed). */
export function passageMethod(text) {
  const t = String(text || "");
  if (RECORDED.test(t) || /vitiated/i.test(t)) return null;
  if (/\bvoice vote\b/i.test(t)) return "voice_vote";
  if (/\bunanimous consent\b/i.test(t)) return "unanimous_consent";
  if (/\bwithout objection\b/i.test(t)) return "without_objection";
  return null;
}

/** The chamber a passage action belongs to, from its action code or its own words; null for any other action. */
export function passageChamber(a) {
  const code = PASSAGE_CODE[String((a && a.actionCode) || "").trim()];
  if (code) return code;
  const t = String((a && a.text) || "");
  if (/^Passed\/agreed to in House:/i.test(t)) return "us-house";
  if (/^Passed\/agreed to in Senate:|^Passed Senate\b/i.test(t)) return "us-senate";
  return null;
}

/**
 * Each chamber's passage without a recorded vote, from a bill's Congress.gov actions (any order):
 * [{chamber, method, action_date, action_text}], the latest passage in each chamber. A chamber whose
 * latest passage was a recorded vote gives nothing here (its roll call is in votes). Pure.
 */
export function passagesWithoutRollCall(actions) {
  const latest = new Map();
  for (const a of actions || []) {
    const chamber = passageChamber(a);
    if (!chamber || !a.actionDate) continue;
    const when = `${a.actionDate} ${a.actionTime || ""}`;
    const prev = latest.get(chamber);
    if (!prev || when > prev.when) latest.set(chamber, { when, a });
  }
  const out = [];
  for (const [chamber, { a }] of latest) {
    const method = passageMethod(a.text);
    if (method) out.push({ chamber, method, action_date: String(a.actionDate).slice(0, 10), action_text: String(a.text).trim() });
  }
  return out.sort((x, y) => x.action_date.localeCompare(y.action_date) || x.chamber.localeCompare(y.chamber));
}

/** The plain line a bill page, the Laws list and This week share. Pure. */
export function passageLine(p, fmt = (d) => d) {
  return `Passed ${CHAMBER_WORD[p.chamber] || "the chamber"} ${METHOD_WORDS[p.method] || ""} on ${fmt(p.action_date)}. ${NOT_RECORDED}`.replace(/\s+/g, " ");
}

/**
 * The rules (H.Res.) under which the House considered the bill, from its own actions:
 * "Considered under the provisions of rule H. Res. 1423" and "Rules Committee Resolution H. Res. 1377
 * Reported to House. Rule provides for consideration of ... H.R. 9237". -> ["us-119-hres-1423", ...]. Pure.
 */
export function rulesFromActions(actions, congress) {
  const out = new Set();
  for (const a of actions || []) {
    const t = String((a && a.text) || "");
    const m = /^(?:Considered under the provisions of rule|Rules Committee Resolution)\s+H\.\s?Res\.\s?(\d+)/i.exec(t);
    if (m) out.add(`us-${congress}-hres-${m[1]}`);
  }
  return [...out].sort();
}

const TYPE_PATH = { hr: "house-bill", s: "senate-bill", hjres: "house-joint-resolution", sjres: "senate-joint-resolution", hres: "house-resolution", sres: "senate-resolution", hconres: "house-concurrent-resolution", sconres: "senate-concurrent-resolution" };
const LABEL = { hr: "H.R.", s: "S.", hjres: "H.J.Res.", sjres: "S.J.Res.", hres: "H.Res.", sres: "S.Res.", hconres: "H.Con.Res.", sconres: "S.Con.Res." };
export const billLabel = (type, number) => `${LABEL[String(type).toLowerCase()] || String(type).toUpperCase()} ${number}`;
export const congressUrl = (congress, type, number) => {
  const n = Number(congress);
  const ord = `${n}${n % 100 >= 11 && n % 100 <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
  return `https://www.congress.gov/bill/${ord}-congress/${TYPE_PATH[String(type).toLowerCase()] || "house-bill"}/${number}`;
};

/** Cosponsor rows from Congress.gov's cosponsors list: {bioguide_id, name, signed_on, original, withdrawn_on}. Pure. */
export function cosponsorRows(list) {
  return (list || [])
    .filter((c) => c && c.bioguideId)
    .map((c) => ({
      bioguide_id: c.bioguideId,
      name: String(c.fullName || [c.firstName, c.lastName].filter(Boolean).join(" ")).trim(),
      signed_on: c.sponsorshipDate ? String(c.sponsorshipDate).slice(0, 10) : null,
      original: c.isOriginalCosponsor ? 1 : 0,
      withdrawn_on: c.sponsorshipWithdrawnDate ? String(c.sponsorshipWithdrawnDate).slice(0, 10) : null,
    }));
}

/**
 * Related bills as Congress.gov lists them, with each relationship's own words and who identified it
 * ("Identical bill · identified by CRS"). Procedural relations (a rule) are kept apart: rules come from the
 * bill's actions. -> [{related_id, label, title, relationship, identified_by}]. Pure.
 */
export function relatedRows(list) {
  const out = [];
  for (const r of list || []) {
    if (!r || !r.type || !r.number || !r.congress) continue;
    const details = (r.relationshipDetails || []).filter((d) => d && d.type);
    const types = [...new Set(details.map((d) => d.type))].filter((t) => !/^Procedurally/i.test(t));
    if (!types.length) continue;
    out.push({
      related_id: `us-${r.congress}-${String(r.type).toLowerCase()}-${r.number}`,
      label: billLabel(r.type, r.number),
      title: String(r.title || "").trim() || null,
      relationship: types.join("; "),
      identified_by: [...new Set(details.filter((d) => types.includes(d.type)).map((d) => d.identifiedBy).filter(Boolean))].join(", ") || null,
    });
  }
  return out;
}

/** "Identical bill (identified by CRS)", from a related row. Pure. */
export const relationWords = (r) => `${r.relationship}${r.identified_by ? ` (identified by ${r.identified_by})` : ""}`;

/**
 * Votes recorded in a House or Senate committee report, from its text: each sentence that reports a
 * committee's recorded vote or voice vote, word for word, with the date the sentence names.
 * -> [{vote_date, question}] (question: the report's own sentence). Pure.
 */
const MONTHS = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };
export function committeeVotes(text) {
  // Block tags end a sentence (a heading never runs into the next sentence).
  const plain = String(text || "")
    .replace(/<\/(p|div|h\d|li|tr|td|th|pre)>|<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
  const out = [];
  const seen = new Set();
  const sentences = plain.split(/\n+|(?<=[.;])\s+(?=[A-Z])/).map((x) => x.replace(/\s+/g, " "));
  for (const s of sentences) {
    const t = s.trim();
    if (t.length > 600) continue;
    if (!/\b(ordered|reported|agreed|adopted|approved)\b/i.test(t)) continue;
    if (!/\b(recorded vote|roll ?call vote|record vote|voice vote|by a vote of|yeas? and \d+ nays?)\b/i.test(t)) continue;
    const d = /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s+(\d{4})/i.exec(t);
    if (!d) continue;
    const date = `${d[3]}-${MONTHS[d[1].toLowerCase()]}-${d[2].padStart(2, "0")}`;
    const key = `${date}|${t}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ vote_date: date, question: t });
  }
  return out;
}
