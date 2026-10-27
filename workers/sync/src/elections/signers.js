// The people and organizations who signed a ballot measure's arguments, as the
// official guide prints them ("Lorrel Plimier", "Co-President, League of Women
// Voters of California"): what the printed title names, and which signers are
// in ThePillory's records. Pure; used by the measure pages (functions/elections/)
// and the sync's measure-signer-orgs step (IRS records for the organizations).
// The same rules for both sides of every measure.
//
//   orgFromTitle      the organization a title names ("Role, Organization"), or null
//   isGovernment      a government body (a commission, a legislature, a city…): no panel
//   officeTitle       whether a title names an elected office a signer holds now
//   matchSigner       the one official, else the one candidate, with that name
//   signerOrgs        every organization named in an election file's signers
import { matchCandidate } from "../funding/state.js";

// Words that make a comma-separated part of a title a role, not an organization.
const ROLE = /\b(president|vice[- ]president|co-president|chair(?:man|woman|person)?|co-chair|director|executive|ceo|cfo|coo|chief|officer|founder|co-founder|commissioner|member|secretary|treasurer|manager|partner|owner|coordinator|organizer|spokes(?:person|man|woman)|trustee|principal|head|lead|leader|counsel|attorney|advocate|fellow|professor|dean|chancellor|superintendent|administrator|representative|staff|former|fmr|retired|emeritus|board|boardmember|specialist|analyst|teacher|nurse|physician|worker)\b/i;
// Degrees and post-nominals printed before the role ("MPA, Executive Director, …").
const DEGREE = /^(?:[A-Z]{2,5}|M\.?D\.?|Ph\.?D\.?|J\.?D\.?|Esq\.?|R\.?N\.?|Jr\.?|Sr\.?|II|III|IV)$/;
// Government bodies get no organization panel: they aren't private organizations.
const GOVERNMENT = /\b(commission|department|agency|legislature|senate|assembly|congress|county|city of|state of|office of|court|board of (?:supervisors|equalization|education|regents|trustees)|university of california|california state university|school district|water district|fire district|police|sheriff|cal ?fire)\b/i;
// An elected office a signer can hold, as titles print them.
const OFFICE = /\b(senator|assemblymember|assembly ?member|assemblyman|assemblywoman|member of the (?:state )?assembly|minority leader|majority leader|floor leader|speaker|governor|attorney general|secretary of state|state treasurer|state controller|insurance commissioner|superintendent of public instruction|board of equalization|u\.?s\.? representative|congressmember|congressman|congresswoman|member of congress|supervisor|mayor|councilmember|council member)\b/i;

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

/** The organization a printed title names: the last part of "Role, …, Organization", when every earlier part is a role or degree. */
export function orgFromTitle(title) {
  const parts = clean(title).split(/,\s*/).filter(Boolean);
  // "…, American College of Emergency Physicians, California Chapter": the chapter is part of the name.
  if (parts.length > 2 && /^(?:California|CA|LA|Los Angeles|[\w .]+ (?:Chapter|Section|Division))$/i.test(parts[parts.length - 1])) parts.splice(-2, 2, `${parts[parts.length - 2]}, ${parts[parts.length - 1]}`);
  if (parts.length < 2) return null;
  const org = parts[parts.length - 1];
  const before = parts.slice(0, -1);
  if (!before.every((p) => ROLE.test(p) || DEGREE.test(p))) return null;
  if (ROLE.test(org) && !/\b(association|council|union|federation|league|alliance|coalition|foundation|society|institute|center|network|chamber|committee|party|project|fund|group|inc|company|corporation|organization|watchdog|cause|club|partnership|action)\b/i.test(org)) return null;
  return org;
}

export const isGovernment = (org) => GOVERNMENT.test(String(org || ""));

/** A title that names an elected office now held: an office word, no organization, not "Former". */
export function officeTitle(title) {
  const t = clean(title);
  return OFFICE.test(t) && !/\b(former|fmr|retired|emeritus|candidate)\b/i.test(t) && !orgFromTitle(t);
}

/**
 * The one official with this name, else the one candidate: {kind: "official", o} or
 * {kind: "candidate", c}, or null. Only for a title that names an elected office
 * (officeTitle), so a private person who shares a name is never linked.
 */
export function matchSigner(signer, officials, candidates) {
  if (!signer || !officeTitle(signer.title)) return null;
  const o = matchCandidate(officials || [], signer.name);
  if (o) return { kind: "official", o };
  const c = matchCandidate(candidates || [], signer.name);
  return c ? { kind: "candidate", c } : null;
}

/** Every private organization named in an election file's argument signers, once each. */
export function signerOrgs(election) {
  const out = new Map();
  for (const m of (election && election.measures) || []) {
    for (const a of m.arguments || []) {
      for (const s of a.signers || []) {
        const org = orgFromTitle(s.title);
        if (org && !isGovernment(org)) out.set(org.toUpperCase(), org);
      }
    }
  }
  return [...out.values()];
}
