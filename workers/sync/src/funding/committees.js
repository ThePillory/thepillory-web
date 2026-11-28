// Which committees count (docs/funding.md, "Which committees count"). Pure: used by the funding step
// (workers/sync/src/funding/sync.js) and by the pages (functions/_lib/money-line.js, funding.js).
//
// The same rule for every official the FEC ties committees to (members of Congress, the President, the
// Vice President):
//   campaign    the candidate's authorized committees (designation P, principal, or A, authorized)
//   leadership  leadership PACs the candidate sponsors (designation D)
//   joint       joint fundraising committees the FEC links to the candidate (designation J)
// Never a super PAC or other independent-expenditure-only committee (types O and I): those stay in
// outside spending, for and against. "Raised" adds campaign and leadership; a joint fundraising committee
// passes its money on to the committees it raises for, so it is shown on its own and never added in.

export const ROLE_LABELS = { campaign: "Campaign committee", leadership: "Leadership PAC", joint: "Joint fundraising committee" };

// Super PACs (O) and independent-expenditure-only filers (I).
const IE_ONLY = new Set(["O", "I"]);

/** An FEC committee record → "campaign" | "leadership" | "joint" | null (not counted). */
export function committeeRole(c) {
  if (!c || !c.committee_id || IE_ONLY.has(c.committee_type)) return null;
  if (c.designation === "P" || c.designation === "A") return "campaign";
  if (c.designation === "D") return "leadership";
  if (c.designation === "J") return "joint";
  return null;
}

export const committeePage = (id, cycle) => `https://www.fec.gov/data/committee/${id}/?cycle=${cycle}`;

/** Whether a committee record can have reports in the period (its cycles, or a filing since the period began). */
export function activeIn(c, cycle) {
  if (Array.isArray(c.cycles) && c.cycles.length) return c.cycles.includes(cycle);
  return !c.last_file_date || String(c.last_file_date).slice(0, 10) >= `${cycle - 1}-01-01`;
}

/**
 * The committees to read for an official: from /candidate/{id}/committees/ (every cycle) and
 * /committees/?sponsor_candidate_id={id}, counted roles only, active in the period, each once.
 */
export function committeesToRead(lists, cycle) {
  const out = new Map();
  for (const c of lists.flat()) {
    const role = committeeRole(c);
    if (!role || out.has(c.committee_id) || !activeIn(c, cycle)) continue;
    out.set(c.committee_id, { committee_id: c.committee_id, name: c.name || c.committee_id, role, designation: c.designation || null, committee_type: c.committee_type || null });
  }
  return [...out.values()];
}

/** /committee/{id}/totals/?cycle= results → { receipts, coverage_end } for the period, or null. */
export function committeeTotals(results, cycle) {
  const r = (results || []).find((x) => Number(x.cycle) === cycle) || null;
  if (!r) return null;
  const receipts = Number(r.receipts);
  if (!Number.isFinite(receipts)) return null;
  return { receipts, coverage_end: r.coverage_end_date ? String(r.coverage_end_date).slice(0, 10) : null };
}

/**
 * What "Raised" adds: { campaign, leadership, joint, total }. Campaign committees: the FEC's candidate
 * totals for the period when it has them (they combine the candidate's authorized committees), else the
 * authorized committees' own reports added up. Leadership PACs: their own reports. Joint: listed, never in total.
 */
export function raisedParts(candidateReceipts, committees) {
  const sum = (role) => (committees || []).filter((c) => c.role === role).reduce((s, c) => s + (Number(c.receipts) || 0), 0);
  const campaign = Number(candidateReceipts) > 0 ? Number(candidateReceipts) : sum("campaign");
  const leadership = sum("leadership");
  return { campaign, leadership, joint: sum("joint"), total: campaign + leadership };
}
