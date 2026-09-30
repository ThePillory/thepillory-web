// Pure helpers for roll calls and members (no D1, no network), shared by the
// sync steps and tested in test/nationwide.test.mjs.
import { normalizePosition } from "./classify.js";
import { xmlTag } from "./util.js";

const CHAMBER = { lower: "ca-assembly", upper: "ca-senate" };

// State names as Congress.gov writes them -> USPS codes (states, DC, and the
// territories that send a delegate).
export const STATE_CODES = {
  Alabama: "AL", Alaska: "AK", Arizona: "AZ", Arkansas: "AR", California: "CA", Colorado: "CO", Connecticut: "CT",
  Delaware: "DE", Florida: "FL", Georgia: "GA", Hawaii: "HI", Idaho: "ID", Illinois: "IL", Indiana: "IN", Iowa: "IA",
  Kansas: "KS", Kentucky: "KY", Louisiana: "LA", Maine: "ME", Maryland: "MD", Massachusetts: "MA", Michigan: "MI",
  Minnesota: "MN", Mississippi: "MS", Missouri: "MO", Montana: "MT", Nebraska: "NE", Nevada: "NV", "New Hampshire": "NH",
  "New Jersey": "NJ", "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", Ohio: "OH",
  Oklahoma: "OK", Oregon: "OR", Pennsylvania: "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD",
  Tennessee: "TN", Texas: "TX", Utah: "UT", Vermont: "VT", Virginia: "VA", Washington: "WA", "West Virginia": "WV",
  Wisconsin: "WI", Wyoming: "WY", "District of Columbia": "DC", "Puerto Rico": "PR", Guam: "GU", "American Samoa": "AS",
  "Virgin Islands": "VI", "U.S. Virgin Islands": "VI", "Northern Mariana Islands": "MP",
};

// "Last, First M." (the list's form) -> "First M. Last". The detail record's
// directOrderName replaces it once read.
export function directName(listName) {
  const parts = String(listName || "").split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length < 2) return String(listName || "").trim();
  const [last, first, ...rest] = parts;
  return [first, last].join(" ") + (rest.length ? `, ${rest.join(", ")}` : "");
}

// The House district as a bare number: "5", or "0" for a member elected at
// large or a delegate (the source gives 0 or no district).
export function districtCode(d) {
  const n = parseInt(d, 10);
  return Number.isFinite(n) && n > 0 ? String(n) : "0";
}

// The whole House's tally: summed from the vote's party totals, or counted
// from the full member list when the source gives no totals.
export function houseTotals(v, memberVotes) {
  const parties = v.votePartyTotal || v.votePartyTotals || [];
  const list = Array.isArray(parties) ? parties : parties.item || [];
  if (list.length) {
    const sum = (k) => list.reduce((acc, p) => acc + (parseInt(p[k], 10) || 0), 0);
    return { yea: sum("yeaTotal"), nay: sum("nayTotal"), present: sum("presentTotal"), not_voting: sum("notVotingTotal") };
  }
  return tally(memberVotes.map((m) => m.voteCast));
}

export function tally(casts) {
  const t = { yea: 0, nay: 0, present: 0, not_voting: 0 };
  for (const c of casts) {
    const p = normalizePosition(c);
    if (p === "Yes") t.yea += 1;
    else if (p === "No") t.nay += 1;
    else if (p === "Present") t.present += 1;
    else t.not_voting += 1;
  }
  return casts.length ? t : null;
}

// The Senate's tally as the XML states it (<count>), or counted from the member list.
export function senateTotals(xml, casts) {
  const count = xmlTag(xml, "count");
  if (count) {
    const n = (t) => parseInt(xmlTag(count, t), 10) || 0;
    return { yea: n("yeas"), nay: n("nays"), present: n("present"), not_voting: n("absent") };
  }
  return tally(casts);
}

// Which loaded legislators cast each individual vote: by Open States person ID,
// or, for floor votes without one, by a last name that matches exactly one
// member of that chamber.
export function matchPositions(vote, officials) {
  const org = String((vote.organization && vote.organization.classification) || "").toLowerCase();
  const out = [];
  const seen = new Set();
  for (const pv of vote.votes || []) {
    let o = pv.voter && pv.voter.id ? officials.by.get(pv.voter.id) : null;
    if (!o && !(pv.voter && pv.voter.id) && CHAMBER[org]) {
      const name = String(pv.voter_name || "").toLowerCase().trim();
      const hits = officials.all.filter((x) => {
        const last = String(x.last_name || "").toLowerCase();
        return x.chamber === CHAMBER[org] && !!last && (name === last || name.startsWith(`${last},`) || name.endsWith(` ${last}`));
      });
      if (hits.length === 1) o = hits[0];
    }
    if (o && !seen.has(o.id)) {
      seen.add(o.id);
      out.push({ official_id: o.id, position: normalizePosition(pv.option), raw_position: String(pv.option) });
    }
  }
  return out;
}

// The tally as Open States gives it (counts: [{option, value}]).
export function stateTotals(vote) {
  const counts = vote.counts || [];
  if (!counts.length) return null;
  const get = (...opts) => counts.filter((c) => opts.includes(String(c.option).toLowerCase())).reduce((a, c) => a + (parseInt(c.value, 10) || 0), 0);
  return { yea: get("yes"), nay: get("no"), present: get("abstain", "present"), not_voting: get("not voting", "absent", "excused", "other") };
}

// [yea, nay, present, not_voting] as integers, or NULL for any the source doesn't state.
export function totals(t) {
  const n = (x) => (x === null || x === undefined || x === "" || !Number.isFinite(Number(x)) ? null : Math.trunc(Number(x)));
  return t ? [n(t.yea), n(t.nay), n(t.present), n(t.not_voting)] : [null, null, null, null];
}

