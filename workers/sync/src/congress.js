// U.S. Senators and the U.S. Representative for Calaveras County, and House
// roll call votes, from the Congress.gov API. https://api.congress.gov/
import { api, API, BILL_TYPES } from "./congress-api.js";

export { BILL_TYPES };
import { upsertOfficial, deactivateOthers, officialIndex, upsertBill, billExists, saveVote, existingVoteIds } from "./db.js";
import { classifyFederal, normalizePosition } from "./classify.js";
import { STATE_CODES, directName, districtCode, houseTotals, tally } from "./rollcall.js";

export { tally };
import { getState, setState, slugify, ordinal, today, currentCongress, congressSessions, isHttp, BudgetExhausted, UpstreamError } from "./util.js";


export function normalizeBillType(t) {
  return String(t || "").toUpperCase().replace(/[^A-Z]/g, "");
}

export function federalBill(congress, type, number, title) {
  const t = normalizeBillType(type);
  const info = BILL_TYPES[t];
  if (!info || !number) return null;
  const url = `https://www.congress.gov/bill/${ordinal(congress)}-congress/${info[1]}/${number}`;
  return {
    id: `us-${congress}-${t.toLowerCase()}-${number}`,
    level: "federal",
    chamber: info[2],
    bill_number: `${info[0]} ${number}`,
    session: String(congress),
    title: title || `${info[0]} ${number}`,
    official_url: url,
    source_url: url,
  };
}

function lastTerm(member) {
  const terms = (member.terms && (member.terms.item || member.terms)) || [];
  return terms.length ? terms[terms.length - 1] : {};
}

// Years of continuous service in the current chamber, from the member detail's terms.
function serviceSince(detail, chamberName) {
  const terms = (detail.terms || []).filter((t) => t.chamber === chamberName).map((t) => t.startYear).filter(Boolean);
  return terms.length ? String(Math.min(...terms)) : null;
}

function currentParty(detail, fallback) {
  const hist = detail.partyHistory || [];
  return hist.length ? hist[hist.length - 1].partyName : fallback || null;
}

// The member list is refreshed once per calendar day (UTC). Each member's
// detail record (full name, website, party history) is read when first seen
// and then every 30 days, spread across runs.
const FEDERAL_DAY_KEY = "federal_officials_day";
const DETAIL_DAYS = 30;

async function listCurrentMembers(env, budget) {
  const out = [];
  for (let offset = 0; offset < 2000; offset += 250) {
    const data = await budget.json(api(env, "/member", { currentMember: "true", limit: "250", offset: String(offset) }), {}, `members ${offset}`);
    const items = data.members || [];
    out.push(...items);
    if (items.length < 250) break;
  }
  return out;
}

function memberRecord(m, d, detailDay) {
  const term = lastTerm(m);
  const isSenate = term.chamber === "Senate";
  const state = STATE_CODES[m.state] || STATE_CODES[d.state] || null;
  const code = isSenate ? null : districtCode(m.district);
  const name = d.directOrderName || directName(m.name);
  const since = d.terms ? serviceSince(d, isSenate ? "Senate" : "House of Representatives") : null;
  const photo = (d.depiction && d.depiction.imageUrl) || (m.depiction && m.depiction.imageUrl);
  const delegate = !isSenate && ["DC", "PR", "GU", "AS", "VI", "MP"].includes(state);
  return {
    id: `bioguide:${m.bioguideId}`,
    slug: slugify(name),
    name,
    last_name: d.lastName || String(m.name || "").split(",")[0].trim() || name.split(/\s+/).pop(),
    office: isSenate ? "U.S. Senator" : delegate ? (state === "PR" ? "Resident Commissioner" : "Delegate") : "U.S. Representative",
    level: "federal",
    chamber: isSenate ? "us-senate" : "us-house",
    body: isSenate ? "us-senate" : "us-house",
    district: isSenate ? m.state : code === "0" ? `${state} (at large)` : `${state}-${code}`,
    state,
    district_code: code,
    party: currentParty(d, m.partyName),
    // Congress.gov gives years. term_start = first year of continuous service in this chamber;
    // term_end only when the source states it.
    term_start: since || (term.startYear ? String(term.startYear) : null),
    term_end: term.endYear ? String(term.endYear) : null,
    website: isHttp(d.officialWebsiteUrl) ? d.officialWebsiteUrl : null,
    photo_url: isHttp(photo) ? photo : null,
    photo_credit: (d.depiction && d.depiction.attribution) || (m.depiction && m.depiction.attribution) || null,
    source_url: `https://bioguide.congress.gov/search/bio/${m.bioguideId}`,
    last_verified: today(),
    bioguide_id: m.bioguideId,
    detail_checked: detailDay,
  };
}

export async function syncFederalOfficials(env, db, budget) {
  const day = await getState(db, FEDERAL_DAY_KEY);
  if (day === today()) return { status: "skipped", message: `already refreshed today (${day}); refreshes at each day's first run` };

  const members = (await listCurrentMembers(env, budget)).filter((m) => m.bioguideId && STATE_CODES[m.state]);
  // A short list means a bad response, not 100 retirements: change nothing.
  const min = parseInt(env.MIN_FEDERAL_MEMBERS || "400", 10);
  if (members.length < min) throw new Error(`Congress.gov listed only ${members.length} current members; nothing changed`);
  const { results } = await db.prepare("SELECT bioguide_id, detail_checked, website, name, term_start FROM officials WHERE bioguide_id IS NOT NULL").all();
  const known = new Map(results.map((r) => [r.bioguide_id, r]));
  const cutoff = new Date(Date.now() - DETAIL_DAYS * 86400000).toISOString().slice(0, 10);

  // Members needing their detail record first (never read, then oldest).
  const order = [...members].sort((a, b) => String((known.get(a.bioguideId) || {}).detail_checked || "").localeCompare(String((known.get(b.bioguideId) || {}).detail_checked || "")));
  const loaded = { "us-senate": [], "us-house": [] };
  let details = 0;
  let detailsLeft = 0;
  let detailErrors = 0;
  for (const m of order) {
    const prev = known.get(m.bioguideId);
    const stale = !prev || !prev.detail_checked || prev.detail_checked < cutoff;
    let d = {};
    let checked = null;
    // Leave room in this round's budget for the vote steps.
    if (stale && budget.remaining() > Math.min(60, Math.floor(budget.max / 3)) && budget.timeLeft() > 60000) {
      try {
        d = (await budget.json(api(env, `/member/${m.bioguideId}`), {}, `member ${m.bioguideId}`)).member || {};
        details += 1;
      } catch (err) {
        if (!(err instanceof UpstreamError)) throw err;
        detailErrors += 1; // the list's record is used; tried again in 30 days
      }
      checked = today();
    } else if (stale) {
      detailsLeft += 1;
    }
    const rec = memberRecord(m, d, checked);
    // Keep what an earlier detail read found until the next one.
    if (!checked && prev) {
      rec.name = prev.name || rec.name;
      rec.website = prev.website;
      rec.term_start = prev.term_start || rec.term_start;
    }
    await upsertOfficial(db, rec);
    loaded[rec.chamber].push(rec.id);
  }
  await deactivateOthers(db, "us-senate", loaded["us-senate"]);
  await deactivateOthers(db, "us-house", loaded["us-house"]);
  const msg =
    `loaded ${loaded["us-senate"].length} senators and ${loaded["us-house"].length} House members; read ${details} detail record(s)` +
    (detailErrors ? ` (${detailErrors} couldn't be read; the member list's record is used)` : "");
  if (detailsLeft) return { status: "partial", message: `${msg}; ${detailsLeft} detail record(s) left for the next run` };
  await setState(db, FEDERAL_DAY_KEY, today());
  return { status: "ok", message: msg };
}

// ---------------------------------------------------------------------------
// House roll call votes
// ---------------------------------------------------------------------------

function pick(obj, ...keys) {
  for (const k of keys) if (obj && obj[k] != null && obj[k] !== "") return obj[k];
  return null;
}

async function listHouseVotes(env, budget, congress, session) {
  const out = [];
  for (let offset = 0; ; offset += 250) {
    const data = await budget.json(
      api(env, `/house-vote/${congress}/${session}`, { limit: "250", offset: String(offset) }),
      {},
      `house votes ${congress}-${session} list`
    );
    const items = data.houseRollCallVotes || data.houseVotes || [];
    out.push(...items);
    if (items.length < 250) return out;
  }
}

export async function syncHouseVotes(env, db, budget) {
  const reps = await officialIndex(db, ["us-house"], "bioguide_id");
  if (!reps.all.length) return { status: "skipped", message: "no House members loaded yet" };
  const congress = currentCongress();
  let saved = 0;
  let pending = 0;
  try {
    for (const session of congressSessions(congress)) {
      const have = await existingVoteIds(db, `us-house-${congress}-${session}-`);
      const list = await listHouseVotes(env, budget, congress, session);
      const todo = list
        .map((v) => ({ v, roll: parseInt(pick(v, "rollCallNumber", "rollNumber"), 10) }))
        .filter(({ roll }) => roll && !have.has(`us-house-${congress}-${session}-${roll}`))
        .sort((a, b) => a.roll - b.roll);
      pending += todo.length;
      for (const { v: item, roll } of todo) {
        const detailData = await budget.json(api(env, `/house-vote/${congress}/${session}/${roll}`), {}, `house vote ${roll}`);
        const v = { ...item, ...(detailData.houseRollCallVote || detailData.houseVote || {}) };
        const membersData = await budget.json(
          api(env, `/house-vote/${congress}/${session}/${roll}/members`, { limit: "500" }),
          {},
          `house vote ${roll} members`
        );
        const mv = membersData.houseRollCallVoteMemberVotes || membersData.houseRollCallMemberVotes || membersData;
        const results = mv.results || mv.memberVotes || [];

        const type = pick(v, "legislationType", "billType");
        const number = pick(v, "legislationNumber", "billNumber");
        const isAmendment = /AMDT/i.test(String(pick(v, "amendmentType") || type || ""));
        let bill = isAmendment ? null : federalBill(congress, type, number);
        if (bill && !(await billExists(db, bill.id))) {
          const b = await budget.json(
            api(env, `/bill/${congress}/${normalizeBillType(type).toLowerCase()}/${number}`),
            {},
            `bill ${bill.bill_number}`
          );
          bill = federalBill(congress, type, number, b.bill && b.bill.title);
          await upsertBill(db, bill);
        }
        const title = bill ? (await db.prepare("SELECT title FROM bills WHERE id = ?").bind(bill.id).first()).title : "";
        const date = String(pick(v, "startDate", "date") || "").slice(0, 10);
        const question = pick(v, "voteQuestion", "question") || "(question not given by source)";
        const clerkXml = pick(v, "sourceDataURL", "sourceDataUrl");
        const source = date ? `https://clerk.house.gov/Votes/${date.slice(0, 4)}${roll}` : clerkXml;

        // Every loaded member's position; members no longer serving aren't loaded.
        const positions = [];
        for (const m of results) {
          const r = reps.by.get(m.bioguideID || m.bioguideId);
          if (r && m.voteCast) positions.push({ official_id: r.id, position: normalizePosition(m.voteCast), raw_position: String(m.voteCast) });
        }
        await saveVote(
          db,
          {
            id: `us-house-${congress}-${session}-${roll}`,
            bill_id: bill ? bill.id : null,
            subject: bill ? null : [type, number].filter(Boolean).join(" ") || null,
            level: "federal",
            chamber: "us-house",
            vote_date: date,
            question,
            vote_type: classifyFederal(question, { billTitle: title, isAmendment }),
            result: pick(v, "result", "voteResult") || "Unknown",
            source_url: isHttp(source) ? source : clerkXml,
            totals: houseTotals(v, results),
          },
          positions
        );
        saved += 1;
        pending -= 1;
      }
    }
    return { status: "ok", message: `Congress ${congress}: ${saved} House vote(s) saved (new, or re-read for totals and all members); caught up` };
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return { status: "partial", message: `Congress ${congress}: ${saved} new House vote(s) saved; ${pending} still to fetch. ${err.message}` };
    }
    throw err;
  }
}

export { API as CONGRESS_API };
