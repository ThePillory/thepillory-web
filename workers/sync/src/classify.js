// Vote classification and position normalization.
//
// These labels only sort votes into "final passage" (shown by default) and
// everything else (shown behind a clearly labeled toggle). They never judge a
// vote. When a question doesn't match a known pattern it is labeled "other",
// not guessed.

const PROCEDURAL = [
  /recommit/, /previous question/, /\btable\b/, /motion to proceed/, /cloture/, /adjourn/,
  /journal/, /quorum/, /reconsider/, /motion to instruct/, /point of order/, /waive/,
  /motion to commit/, /motion to discharge/, /sustain the ruling/, /appeal the ruling/,
  /motion to refer/, /question of consideration/,
];

const FINAL = [
  /^on passage/, /passage of the bill/, /suspend the rules and pass/, /suspend the rules and agree/,
  /agreeing to the resolution/, /on the resolution/, /on the joint resolution/, /on the concurrent resolution/,
  /conference report/, /concur(ring)? in the (house|senate) amendment/, /motion to concur/,
  /override/, /objections of the president/, /veto/, /resolution of ratification/, /on the bill/,
];

/**
 * @param {string} question  exact question text, e.g. "On Motion to Recommit"
 * @param {object} ctx       { billTitle, isNomination, isAmendment }
 */
export function classifyFederal(question, ctx = {}) {
  const q = String(question || "").toLowerCase();
  const title = String(ctx.billTitle || "").toLowerCase();
  // Procedural first: a cloture vote on a nomination is procedural, not the confirmation.
  if (PROCEDURAL.some((re) => re.test(q))) return "procedural";
  if (ctx.isNomination || /nomination/.test(q)) return "nomination";
  if (/motion to suspend the rules/.test(q) && !/pass|agree/.test(q)) return "procedural";
  if (ctx.isAmendment || (/amendment/.test(q) && !/concur/.test(q) && !/as amended/.test(q))) return "amendment";
  // House "rules" (H.Res. "Providing for consideration of …") set up debate: procedural.
  if (/agreeing to the resolution/.test(q) && /^providing for (the )?consideration/.test(title)) return "procedural";
  if (FINAL.some((re) => re.test(q))) return "final_passage";
  return "other";
}

/**
 * Open States vote events (California).
 * @param {object} v  vote event: { motion_text, motion_classification[], organization{classification} }
 */
export function classifyState(v) {
  const text = String(v.motion_text || "").toLowerCase();
  const kinds = (v.motion_classification || []).map((k) => String(k).toLowerCase());
  const org = String((v.organization && v.organization.classification) || "").toLowerCase();
  if (org === "committee" || kinds.includes("committee-passage") || /do pass|committee/.test(text)) return "committee";
  if (kinds.includes("veto-override") || /override/.test(text)) return "final_passage";
  if (kinds.includes("amendment-passage") || kinds.includes("amendment-adoption") || /\bamend(ment)?\b/.test(text) && !/concurrence|as amended/.test(text)) {
    return "amendment";
  }
  if (kinds.includes("passage") || /third reading|3rd reading|final passage|concurrence|consent calendar/.test(text)) {
    return "final_passage";
  }
  if (/reconsider|motion to|table|recommit|rule waiver|suspend/.test(text)) return "procedural";
  return "other";
}

const MAP = {
  yea: "Yes", aye: "Yes", yes: "Yes",
  nay: "No", no: "No",
  present: "Present",
  "not voting": "Not voting", "not-voting": "Not voting", absent: "Not voting", abstain: "Not voting",
  excused: "Not voting", "no vote recorded": "Not voting", paired: "Not voting", other: "Not voting",
};

// Returns one of Yes / No / Present / Not voting. The raw value is stored too.
export function normalizePosition(raw) {
  const k = String(raw || "").trim().toLowerCase();
  return MAP[k] || "Not voting";
}

export const TYPE_LABELS = {
  final_passage: "Final passage",
  procedural: "Procedural",
  amendment: "Amendment",
  nomination: "Nomination",
  committee: "Committee",
  other: "Other",
};
