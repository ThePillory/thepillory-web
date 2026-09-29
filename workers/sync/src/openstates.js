// California legislators and their votes, from the Open States v3 API.
// https://docs.openstates.org/api-v3/
//
// Request-conscious: officials are refreshed at most weekly; votes are pulled
// incrementally with `updated_since`, resuming from a saved page cursor, under
// a per-day cap (OPENSTATES_DAILY_LIMIT) and pacing (OPENSTATES_MIN_INTERVAL_MS).
import { upsertOfficial, deactivateOthers, activeOfficials, upsertBill, saveVote } from "./db.js";
import { classifyState, normalizePosition } from "./classify.js";
import { getState, setState, isHttp, slugify, today, BudgetExhausted } from "./util.js";

const API = "https://v3.openstates.org";

function headers(env) {
  if (!env.OPENSTATES_API_KEY) throw new Error("OPENSTATES_API_KEY secret is not set");
  return { "X-API-KEY": env.OPENSTATES_API_KEY, Accept: "application/json" };
}

function daysSince(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;
}

const CHAMBER = { lower: "ca-assembly", upper: "ca-senate" };

export async function syncStateOfficials(env, db, budget) {
  const checked = await getState(db, "state_officials_checked");
  if (daysSince(checked) < 7) return { status: "skipped", message: `checked ${checked}; refreshes weekly` };
  const api = env.OPENSTATES_API_BASE || API;
  const h = { headers: headers(env) };

  // Which legislators represent a point inside Calaveras County.
  const geo = await budget.openStates(
    db,
    `${api}/people.geo?lat=${encodeURIComponent(env.LOOKUP_LAT)}&lng=${encodeURIComponent(env.LOOKUP_LNG)}`,
    h,
    "people.geo"
  );
  const people = geo.results || [];
  const state = people.filter(
    (p) => p.jurisdiction && p.jurisdiction.classification === "state" && p.current_role && CHAMBER[p.current_role.org_classification]
  );
  // Remember the U.S. House district for the federal step, if Open States has it.
  const house = people.find(
    (p) => p.jurisdiction && p.jurisdiction.classification === "country" && p.current_role && p.current_role.org_classification === "lower"
  );
  if (house && house.current_role.district) await setState(db, "house_district_detected", String(house.current_role.district));
  if (!state.length) throw new Error("Open States returned no state legislators for the lookup point");

  // Details (website and source links) for those people, in one request.
  const ids = state.map((p) => `id=${encodeURIComponent(p.id)}`).join("&");
  const detail = await budget.openStates(db, `${api}/people?${ids}&include=links&include=sources&per_page=10`, h, "people");
  const byId = new Map((detail.results || []).map((p) => [p.id, p]));

  const loaded = [];
  for (const p of state) {
    const d = byId.get(p.id) || p;
    const role = p.current_role;
    const chamber = CHAMBER[role.org_classification];
    const officialSource = (d.sources || []).map((s) => s.url).find(isHttp);
    const source = officialSource || d.openstates_url || p.openstates_url;
    const website = (d.links || []).map((l) => l.url).find(isHttp);
    await upsertOfficial(db, {
      id: `openstates:${p.id}`,
      slug: slugify(p.name),
      name: p.name,
      last_name: d.family_name || p.family_name || p.name.split(/\s+/).pop(),
      office: chamber === "ca-assembly" ? "State Assemblymember" : "State Senator",
      level: "state",
      chamber,
      body: "state-legislature",
      district: `${chamber === "ca-assembly" ? "Assembly" : "Senate"} District ${role.district}`,
      party: p.party || null,
      // Open States doesn't publish term dates for current roles; left blank rather than guessed.
      term_start: null,
      term_end: null,
      website: website || null,
      photo_url: isHttp(p.image) ? p.image : null,
      photo_credit: isHttp(p.image) ? "Photo via Open States" : null,
      source_url: source,
      last_verified: today(),
      openstates_id: p.id,
    });
    loaded.push({ id: `openstates:${p.id}`, chamber });
  }
  for (const chamber of ["ca-assembly", "ca-senate"]) {
    const keep = loaded.filter((l) => l.chamber === chamber).map((l) => l.id);
    if (keep.length) await deactivateOthers(db, chamber, keep);
  }
  await setState(db, "state_officials_checked", new Date().toISOString());
  return { status: "ok", message: `loaded ${loaded.length} state legislators` };
}

// Current regular California session, e.g. "20252026". Regular sessions are two
// years long and start in odd-numbered years, so this needs no API request.
// CA_SESSION overrides it (e.g. for a special session).
function currentSession(env) {
  if (env.CA_SESSION) return env.CA_SESSION;
  const y = new Date().getUTCFullYear();
  const start = y % 2 === 1 ? y : y - 1;
  return `${start}${start + 1}`;
}

function leginfoUrl(session, identifier) {
  // e.g. session 20252026, "AB 123" -> bill_id=202520260AB123
  return `https://leginfo.legislature.ca.gov/faces/billNavClient.xhtml?bill_id=${session}0${identifier.replace(/\s+/g, "")}`;
}

// Which of our legislators cast each individual vote. Floor votes may match by
// name within the right chamber; committee votes only by Open States person ID.
function matchPositions(vote, officials) {
  const org = String((vote.organization && vote.organization.classification) || "").toLowerCase();
  const out = [];
  for (const o of officials) {
    const hit = (vote.votes || []).find((pv) => {
      if (pv.voter && pv.voter.id) return pv.voter.id === o.openstates_id;
      if (org !== "lower" && org !== "upper") return false;
      if (CHAMBER[org] !== o.chamber) return false;
      const name = String(pv.voter_name || "").toLowerCase().trim();
      const last = String(o.last_name || "").toLowerCase();
      return !!last && (name === last || name.startsWith(`${last},`) || name.endsWith(` ${last}`));
    });
    if (hit) out.push({ official_id: o.id, position: normalizePosition(hit.option), raw_position: String(hit.option) });
  }
  return out;
}

export async function syncStateVotes(env, db, budget) {
  const officials = [...(await activeOfficials(db, "ca-assembly")), ...(await activeOfficials(db, "ca-senate"))];
  if (!officials.length) return { status: "skipped", message: "no state legislators loaded yet" };
  const api = env.OPENSTATES_API_BASE || API;
  const session = currentSession(env);

  // Cursor: bills updated since `since`, resuming at `page`.
  const since = (await getState(db, `ca_votes_since_${session}`)) || `${session.slice(0, 4)}-01-01`;
  let page = parseInt((await getState(db, `ca_votes_page_${session}`)) || "1", 10);
  let maxUpdated = (await getState(db, `ca_votes_max_updated_${session}`)) || since;
  let votesSaved = 0;
  let pages = 0;

  try {
    for (;;) {
      const url =
        `${api}/bills?jurisdiction=ca&session=${encodeURIComponent(session)}` +
        `&updated_since=${encodeURIComponent(since)}&sort=updated_asc&include=votes&include=sources` +
        `&per_page=20&page=${page}`;
      const data = await budget.openStates(db, url, { headers: headers(env) }, `bills page ${page}`);
      pages += 1;
      for (const bill of data.results || []) {
        if (bill.updated_at && bill.updated_at > maxUpdated) maxUpdated = bill.updated_at;
        const matched = [];
        for (const v of bill.votes || []) {
          const positions = matchPositions(v, officials);
          if (positions.length) matched.push([v, positions]);
        }
        if (!matched.length) continue;
        const identifier = String(bill.identifier || "").trim();
        const billId = `ca-${session}-${slugify(identifier)}`;
        const official = leginfoUrl(session, identifier);
        const billSource = (bill.sources || []).map((s) => s.url).find(isHttp) || bill.openstates_url || official;
        await upsertBill(db, {
          id: billId,
          level: "state",
          chamber: CHAMBER[bill.from_organization && bill.from_organization.classification] || "ca-assembly",
          bill_number: identifier,
          session,
          title: bill.title || identifier,
          official_url: official,
          source_url: billSource,
        });
        for (const [v, positions] of matched) {
          const org = String((v.organization && v.organization.classification) || "");
          const voteSource = (v.sources || []).map((s) => s.url).find(isHttp) || billSource;
          await saveVote(
            db,
            {
              id: `ca-${v.id}`,
              bill_id: billId,
              level: "state",
              chamber: CHAMBER[org] || (v.organization && v.organization.name) || "ca-legislature",
              vote_date: String(v.start_date || "").slice(0, 10),
              question: v.motion_text || "(no motion text)",
              vote_type: classifyState(v),
              result: v.result === "pass" ? "Passed" : v.result === "fail" ? "Failed" : String(v.result || "Unknown"),
              source_url: voteSource,
            },
            positions
          );
          votesSaved += 1;
        }
      }
      const maxPage = (data.pagination && data.pagination.max_page) || page;
      if (page >= maxPage) {
        // Caught up: next run asks only for bills updated after the newest one seen.
        await setState(db, `ca_votes_since_${session}`, maxUpdated);
        await setState(db, `ca_votes_page_${session}`, "1");
        await setState(db, `ca_votes_max_updated_${session}`, maxUpdated);
        return { status: "ok", message: `session ${session}: caught up; ${pages} page(s), ${votesSaved} vote(s) saved` };
      }
      page += 1;
      await setState(db, `ca_votes_page_${session}`, String(page));
      await setState(db, `ca_votes_max_updated_${session}`, maxUpdated);
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return {
        status: "partial",
        message: `session ${session}: ${pages} page(s), ${votesSaved} vote(s) saved; will resume at page ${page}. ${err.message}`,
      };
    }
    throw err;
  }
}
