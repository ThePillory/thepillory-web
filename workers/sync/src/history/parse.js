// The Time Machine's parsers: pure, no network, no D1. Tested in
// test/history.test.mjs. The steps that use them are in sync.js.
import { xmlTag, xmlBlocks } from "../util.js";

const MON = { jan: "01", feb: "02", mar: "03", apr: "04", may: "05", jun: "06", jul: "07", aug: "08", sep: "09", oct: "10", nov: "11", dec: "12" };

/** The Congress and session for a calendar year: 2001 is the 107th, session 1. */
export function congressOfYear(year) {
  return { congress: Math.floor((year - 1789) / 2) + 1, session: year % 2 ? 1 : 2 };
}

/** "5-Mar-2008" -> "2008-03-05". */
export function clerkDate(s) {
  const m = /(\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(String(s || ""));
  return m && MON[m[2].toLowerCase()] ? `${m[3]}-${MON[m[2].toLowerCase()]}-${m[1].padStart(2, "0")}` : null;
}

/** "H R 1424" -> { type: "HR", number: "1424" }; quorum calls, motions and the like -> null. */
export function houseLegis(legisNum) {
  const m = /^\s*(H\s*R|S|H\s*RES|S\s*RES|H\s*J\s*RES|S\s*J\s*RES|H\s*CON\s*RES|S\s*CON\s*RES)\s+(\d+)\s*$/i.exec(String(legisNum || ""));
  return m ? { type: m[1].toUpperCase().replace(/\s+/g, ""), number: m[2] } : null;
}

/**
 * One House roll call from the Clerk's XML (clerk.house.gov/evs/<year>/rollNNN.xml):
 * the question, result, date, the whole House's totals as the Clerk states them,
 * and each member's vote by Bioguide ID.
 */
export function parseHouseRoll(xml) {
  const meta = xmlTag(xml, "vote-metadata");
  if (!meta) return null;
  const totalsBlock = xmlTag(meta, "totals-by-vote");
  const n = (t) => {
    const v = parseInt(xmlTag(totalsBlock, t), 10);
    return Number.isFinite(v) ? v : null;
  };
  const members = [];
  for (const b of xmlBlocks(xml, "recorded-vote")) {
    const id = /name-id="([A-Z]\d{6})"/.exec(b);
    const vote = xmlTag(b, "vote");
    if (id && vote) members.push({ bioguide: id[1], vote });
  }
  return {
    congress: parseInt(xmlTag(meta, "congress"), 10),
    session: parseInt(xmlTag(meta, "session"), 10),
    roll: parseInt(xmlTag(meta, "rollcall-num"), 10),
    legis: xmlTag(meta, "legis-num"),
    question: xmlTag(meta, "vote-question"),
    result: xmlTag(meta, "vote-result"),
    date: clerkDate(xmlTag(meta, "action-date")),
    desc: xmlTag(meta, "vote-desc"),
    amendment: /amendment/i.test(xmlTag(meta, "vote-question")) && !/concur|as amended/i.test(xmlTag(meta, "vote-question")),
    totals: totalsBlock ? { yea: n("yea-total"), nay: n("nay-total"), present: n("present-total"), not_voting: n("not-voting-total") } : null,
    members,
  };
}

// Cabinet-level offices, as nominations describe them ("…, to be Secretary of Defense").
export const CABINET = [
  "Secretary of State", "Secretary of the Treasury", "Secretary of Defense", "Attorney General", "Secretary of the Interior",
  "Secretary of Agriculture", "Secretary of Commerce", "Secretary of Labor", "Secretary of Health and Human Services",
  "Secretary of Housing and Urban Development", "Secretary of Transportation", "Secretary of Energy", "Secretary of Education",
  "Secretary of Veterans Affairs", "Secretary of Homeland Security",
];

/** The Cabinet department a nomination is to head ("…, to be Secretary of Energy." -> "Secretary of Energy"), or null. */
export function cabinetPosition(description) {
  const d = String(description || "").replace(/\s+/g, " ");
  const m = /,\s*to be (?:the )?(Secretary of [A-Z][A-Za-z ,]+?|Attorney General)(?:,|\.|$| vice)/.exec(d);
  if (!m) return null;
  const pos = m[1].replace(/\s+$/, "");
  return CABINET.find((c) => c === pos) || null;
}

/**
 * FEC totals by two-year period (/candidate/<id>/totals/?election_full=false):
 * receipts, disbursements and cash on hand at the end of each period, as the FEC reports them.
 */
export function fecCycles(json) {
  const out = [];
  for (const r of (json && json.results) || []) {
    const cycle = parseInt(r.cycle, 10);
    if (!cycle) continue;
    out.push({
      cycle,
      receipts: typeof r.receipts === "number" ? r.receipts : null,
      disbursements: typeof r.disbursements === "number" ? r.disbursements : null,
      cash_on_hand: typeof r.last_cash_on_hand_end_period === "number" ? r.last_cash_on_hand_end_period : null,
      coverage_end: r.coverage_end_date ? String(r.coverage_end_date).slice(0, 10) : null,
    });
  }
  return out;
}

/** Who held a seat on a date: the term (from congress/<st>.json) whose start <= date < end. */
export function holderOn(terms, date) {
  return (terms || []).filter((t) => t.start <= date && date < t.end);
}

/** Everyone who held a seat at any time in a year. */
export function holdersInYear(terms, year) {
  const a = `${year}-01-01`;
  const b = `${year + 1}-01-01`;
  return (terms || []).filter((t) => t.start < b && t.end > a);
}
