// "Can't run again for this office (term limit)" (docs/funding.md, "When there's no amount"): only when
// both the office's term limit, quoted from the Constitution with its source, and the official's terms
// served, counted from ThePillory's own records, show they can't run again for this office. Otherwise
// nothing: never a guess, never "termed out" from a date alone. Pure.
//
//   The President: Amendment XXII ("No person shall be elected to the office of the President more than
//   twice"), terms from data/history/federal-executive.json (congress-legislators' executive.json), the
//   same person by GovTrack ID.
//   California's Governor and statewide officers: the California Constitution (Article V, Sections 2 and
//   11; Article IX, Section 2: "may not serve more than 2 terms"), terms from the general-election
//   winners in data/history/california.json (the Secretary of State's Statement of Vote), the same office
//   and exactly the same name.

import { loadFederalExecutive, loadCalifornia } from "./history.js";

export const TERM_LIMIT_TEXT = "Can't run again for this office (term limit)";

// Office → the provision that limits it, where its text is, and how many terms it allows.
const CA_LEGINFO = (article) => `https://leginfo.legislature.ca.gov/faces/codes_displayText.xhtml?lawCode=CONS&article=${article}`;
export const LIMITS = {
  president: { max: 2, label: "U.S. Constitution, Amendment XXII", href: "/laws/constitution/#amend-22" },
  governor: { max: 2, label: "California Constitution, Article V, Section 2", href: CA_LEGINFO("V") },
  "lieutenant-governor": { max: 2, label: "California Constitution, Article V, Section 11", href: CA_LEGINFO("V") },
  "attorney-general": { max: 2, label: "California Constitution, Article V, Section 11", href: CA_LEGINFO("V") },
  controller: { max: 2, label: "California Constitution, Article V, Section 11", href: CA_LEGINFO("V") },
  "secretary-of-state": { max: 2, label: "California Constitution, Article V, Section 11", href: CA_LEGINFO("V") },
  treasurer: { max: 2, label: "California Constitution, Article V, Section 11", href: CA_LEGINFO("V") },
  superintendent: { max: 2, label: "California Constitution, Article IX, Section 2", href: CA_LEGINFO("IX") },
};

const norm = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z ]/gi, "").replace(/\s+/g, " ").trim().toLowerCase();

/** Which limited office an official holds: "president", a California office key, or null. */
export function limitedOffice(o) {
  if (!o) return null;
  if (o.chamber === "us-executive" && o.rank === 1) return "president";
  if (o.chamber === "ca-executive") {
    const key = (String(o.id || "").match(/^ca-exec:([a-z-]+):/) || [])[1];
    // The Superintendent's office key in the officials file and "superintendent" in the history file.
    const k = key && key.startsWith("superintendent") ? "superintendent" : key;
    return LIMITS[k] ? k : null;
  }
  return null;
}

/** Terms the official has been elected to for this office, counted from the records; null when the records can't tell. */
export function termsServed(o, office, { federalExecutive = null, california = null } = {}) {
  if (office === "president") {
    const gt = (String(o.id || "").match(/^exec:govtrack:(\d+)$/) || [])[1];
    if (!gt || !federalExecutive || !Array.isArray(federalExecutive.terms)) return null;
    return new Set(federalExecutive.terms.filter((t) => t.office === "President" && String(t.govtrack) === gt).map((t) => t.start)).size;
  }
  if (!california || !Array.isArray(california.elections)) return null;
  const name = norm(o.name);
  return california.elections.filter((e) => (e.winners || []).some((w) => w.office === office && !w.district && norm(w.name) === name)).length;
}

/** { text, href, source } when the records show the official can't run again for this office, else null. */
export function termLimit(o, records) {
  const office = limitedOffice(o);
  if (!office) return null;
  const n = termsServed(o, office, records || {});
  const limit = LIMITS[office];
  return n != null && n >= limit.max ? { text: TERM_LIMIT_TEXT, href: limit.href, source: limit.label } : null;
}

/** The records termLimit() reads, loaded only when moneyGlances() has someone left to check. */
export const termRecords = (env, request) => async () => {
  if (!env || !request) return {};
  const [federalExecutive, california] = await Promise.all([loadFederalExecutive(env, request).catch(() => null), loadCalifornia(env, request).catch(() => null)]);
  return { federalExecutive, california };
};
