// U.S. Senators and the U.S. Representative for Calaveras County, and House
// roll call votes, from the Congress.gov API. https://api.congress.gov/
import { api, API, BILL_TYPES } from "./congress-api.js";

export { BILL_TYPES };
import { upsertOfficial, deactivateOthers, activeOfficials, upsertBill, billExists, saveVote, existingVoteIds } from "./db.js";
import { classifyFederal, normalizePosition } from "./classify.js";
import { getState, setState, slugify, ordinal, today, currentCongress, congressSessions, isHttp, BudgetExhausted } from "./util.js";


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

function daysSince(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;
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

export async function syncFederalOfficials(env, db, budget) {
  const checked = await getState(db, "federal_officials_checked");
  if (daysSince(checked) < 1) return { status: "skipped", message: `checked ${checked}; refreshes daily` };
  const district = String(env.CA_HOUSE_DISTRICT || (await getState(db, "house_district_detected")) || "").trim();

  const list = await budget.json(api(env, "/member/CA", { currentMember: "true", limit: "250" }), {}, "members CA");
  const members = list.members || [];
  const senators = members.filter((m) => lastTerm(m).chamber === "Senate");
  const rep = district ? members.find((m) => lastTerm(m).chamber !== "Senate" && String(m.district) === district) : null;

  const picks = [...senators.map((m) => ["us-senate", m]), ...(rep ? [["us-house", rep]] : [])];
  const loaded = { "us-senate": [], "us-house": [] };
  for (const [chamber, m] of picks) {
    const d = (await budget.json(api(env, `/member/${m.bioguideId}`), {}, `member ${m.bioguideId}`)).member || {};
    const name = d.directOrderName || [d.firstName, d.lastName].filter(Boolean).join(" ") || m.name;
    const isSenate = chamber === "us-senate";
    const since = serviceSince(d, isSenate ? "Senate" : "House of Representatives");
    const term = lastTerm(m);
    const photo = (d.depiction && d.depiction.imageUrl) || (m.depiction && m.depiction.imageUrl);
    await upsertOfficial(db, {
      id: `bioguide:${m.bioguideId}`,
      slug: slugify(name),
      name,
      last_name: d.lastName || name.split(/\s+/).pop(),
      office: isSenate ? "U.S. Senator" : "U.S. Representative",
      level: "federal",
      chamber,
      body: isSenate ? "us-senate" : "us-house",
      district: isSenate ? "California" : `CA-${district}`,
      party: currentParty(d, m.partyName),
      // Congress.gov gives years. term_start = first year of continuous service in this chamber;
      // term_end only when the source states it.
      term_start: since || (term.startYear ? String(term.startYear) : null),
      term_end: term.endYear ? String(term.endYear) : null,
      website: isHttp(d.officialWebsiteUrl) ? d.officialWebsiteUrl : null,
      photo_url: isHttp(photo) ? photo : null,
      photo_credit: (d.depiction && d.depiction.attribution) || null,
      source_url: `https://bioguide.congress.gov/search/bio/${m.bioguideId}`,
      last_verified: today(),
      bioguide_id: m.bioguideId,
    });
    loaded[chamber].push(`bioguide:${m.bioguideId}`);
  }
  if (loaded["us-senate"].length) await deactivateOthers(db, "us-senate", loaded["us-senate"]);
  if (loaded["us-house"].length) await deactivateOthers(db, "us-house", loaded["us-house"]);
  await setState(db, "federal_officials_checked", new Date().toISOString());
  const msg = `loaded ${loaded["us-senate"].length} senator(s), ${loaded["us-house"].length} representative(s)`;
  if (!rep) {
    return {
      status: "partial",
      message: `${msg}. No House district known: set CA_HOUSE_DISTRICT or let the Open States lookup run first.`,
    };
  }
  return { status: "ok", message: `${msg} (district CA-${district})` };
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
  const reps = await activeOfficials(db, "us-house");
  if (!reps.length) return { status: "skipped", message: "no U.S. Representative loaded yet" };
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

        const positions = [];
        for (const r of reps) {
          const m = results.find((x) => (x.bioguideID || x.bioguideId) === r.bioguide_id);
          if (m) positions.push({ official_id: r.id, position: normalizePosition(m.voteCast), raw_position: String(m.voteCast) });
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
          },
          positions
        );
        saved += 1;
        pending -= 1;
      }
    }
    return { status: "ok", message: `Congress ${congress}: ${saved} new House vote(s) saved; caught up` };
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return { status: "partial", message: `Congress ${congress}: ${saved} new House vote(s) saved; ${pending} still to fetch. ${err.message}` };
    }
    throw err;
  }
}

export { API as CONGRESS_API };
