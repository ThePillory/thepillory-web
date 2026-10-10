// One voter's ballot from the Google Civic Information API (voterInfoQuery),
// which serves the Voting Information Project's data: what state and county
// election offices publish. The address is sent to Google for that one
// request and is never stored or logged, here or anywhere: errors carry the
// HTTP status only, never the URL. Pure apart from the fetch; the parsing is
// tested in workers/sync/test/ballot.test.mjs.
//
// Kept: contests (office, district, candidates with their party as listed),
// referendums (title, subtitle, link), polling places, early-voting sites,
// drop-off locations and the state's official election links. Left out:
// candidates' phone numbers, emails and social accounts (no contact details on
// ThePillory), the same for every candidate.

const API = "https://www.googleapis.com/civicinfo/v2/voterinfo";

/** Plain errors that say what happened without the request (which holds the address). */
export class CivicError extends Error {
  constructor(kind, status = 0) {
    super(kind);
    this.kind = kind; // "no-key" | "not-found" | "address" | "unavailable"
    this.status = status;
  }
}

/** The raw voterInfoQuery answer for an address, or a CivicError. */
export async function voterInfo(env, address, { fetchImpl = fetch } = {}) {
  const key = env.GOOGLE_CIVIC_API_KEY;
  if (!key) throw new CivicError("no-key");
  const url = new URL(env.GOOGLE_CIVIC_API_URL || API);
  url.searchParams.set("address", address);
  url.searchParams.set("returnAllAvailableData", "true");
  url.searchParams.set("key", key);
  let res;
  try {
    res = await fetchImpl(url.toString(), { headers: { Accept: "application/json" } });
  } catch (_) {
    throw new CivicError("unavailable");
  }
  if (res.ok) return res.json();
  let reason = "";
  try {
    const body = await res.json();
    reason = String((body.error && (body.error.message || (body.error.errors || [])[0]?.reason)) || "");
  } catch (_) {}
  // "Election unknown" / no data for this address: the API has nothing for it.
  if (res.status === 400 && /parse|address/i.test(reason) && !/election/i.test(reason)) throw new CivicError("address", res.status);
  if (res.status === 400 || res.status === 404) throw new CivicError("not-found", res.status);
  throw new CivicError("unavailable", res.status);
}

const text = (v) => (v == null ? "" : String(v).replace(/\s+/g, " ").trim());
const http = (u) => (/^https?:\/\//i.test(String(u || "")) ? String(u) : null);

function place(p) {
  const a = p.address || {};
  return {
    name: text(a.locationName || p.name),
    address: [a.line1, a.line2, a.line3].map(text).filter(Boolean).join(", "),
    city: [text(a.city), text(a.state), text(a.zip)].filter(Boolean).join(" "),
    hours: text(p.pollingHours),
    dates: [text(p.startDate), text(p.endDate)].filter(Boolean),
    notes: text(p.notes),
  };
}

const LINKS = [
  ["electionInfoUrl", "Election information"],
  ["electionRegistrationConfirmationUrl", "Check your registration"],
  ["electionRegistrationUrl", "Register to vote"],
  ["ballotInfoUrl", "Your sample ballot"],
  ["votingLocationFinderUrl", "Find where to vote"],
  ["absenteeVotingInfoUrl", "Voting by mail"],
  ["electionRulesUrl", "Election rules"],
];

function adminLinks(body) {
  if (!body) return null;
  return {
    name: text(body.name),
    links: LINKS.map(([k, label]) => (http(body[k]) ? { label, url: body[k] } : null)).filter(Boolean),
  };
}

/** The answer as ThePillory shows it: contests in ballot order, places, and the official links. Pure. */
export function ballotFromVoterInfo(data) {
  const contests = (data.contests || []).map((c, i) => {
    const referendum = String(c.type || "").toLowerCase() === "referendum" || !!c.referendumTitle;
    return {
      order: Number.isFinite(Number(c.ballotPlacement)) ? Number(c.ballotPlacement) : 10000 + i,
      kind: referendum ? "referendum" : "candidate",
      office: text(c.office),
      district: text(c.district && c.district.name),
      level: (c.level || [])[0] || (c.district && c.district.scope) || "",
      title: text(c.ballotTitle || c.office || c.referendumTitle),
      // In the order the official data lists them (the order on the ballot, where the election office gives it).
      candidates: (c.candidates || []).map((x) => ({ name: text(x.name), party: text(x.party) })),
      referendum: referendum
        ? { title: text(c.referendumTitle), subtitle: text(c.referendumSubtitle), url: http(c.referendumUrl), brief: text(c.referendumBrief) }
        : null,
      sources: (c.sources || []).map((s) => ({ name: text(s.name), official: !!s.official })),
    };
  });
  contests.sort((a, b) => a.order - b.order);
  const state = (data.state || [])[0] || {};
  const local = state.local_jurisdiction && state.local_jurisdiction.electionAdministrationBody;
  return {
    election: { name: text(data.election && data.election.name), day: text(data.election && data.election.electionDay) },
    otherElections: (data.otherElections || []).map((e) => ({ name: text(e.name), day: text(e.electionDay) })),
    where: [text(data.normalizedInput && data.normalizedInput.city), text(data.normalizedInput && data.normalizedInput.state)].filter(Boolean).join(", "),
    stateCode: text(data.normalizedInput && data.normalizedInput.state).toUpperCase(),
    mailOnly: !!data.mailOnly,
    contests,
    polling: (data.pollingLocations || []).map(place),
    early: (data.earlyVoteSites || []).map(place),
    dropOff: (data.dropOffLocations || []).map(place),
    state: adminLinks(state.electionAdministrationBody),
    county: adminLinks(local),
  };
}

// ---------------------------------------------------------------------------
// Links to ThePillory's own pages

const words = (s) => String(s || "").toLowerCase().normalize("NFD").replace(/[^a-z\s-]/g, " ").split(/[\s-]+/).filter((w) => w.length > 1);

/** An official on ThePillory for a ballot name, matched by first and last name, only when exactly one fits. Pure. */
export function officialFor(name, officials) {
  const n = words(name);
  if (n.length < 2) return null;
  const first = n[0];
  const last = n[n.length - 1];
  const hits = officials.filter((o) => {
    const w = words(o.name);
    return w.length >= 2 && w[w.length - 1] === last && (w[0] === first || (o.last_name && words(o.last_name).pop() === last && w.includes(first)));
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * ThePillory's page for a measure on the ballot, matched by its number, only when exactly one fits. Pure.
 * California: "Proposition 1" / "Prop. 1". Washington: "Initiative Measure No. IP26-645" or "... No. 645".
 */
export function measureFor(ref, election) {
  if (!ref || !election) return null;
  const t = `${ref.title} ${ref.subtitle}`;
  const st = election.election.state;
  let hits = [];
  if (st === "CA") {
    const m = /\bprop(?:osition|\.)?\s*(\d{1,3})\b/i.exec(t);
    if (m) hits = election.measures.filter((x) => x.scope === "statewide" && String(x.number) === String(Number(m[1])));
  } else {
    hits = election.measures.filter((x) => x.scope === "statewide" && (t.includes(x.number) || new RegExp(`\\b(?:no\\.|number|measure|initiative)\\s*${String(x.number).split("-").pop()}\\b`, "i").test(t)));
  }
  return hits.length === 1 ? hits[0] : null;
}
