// California legislators and their votes, from the Open States v3 API.
// https://docs.openstates.org/api-v3/
//
// Request-conscious: officials are refreshed at most weekly; votes are pulled
// incrementally with `updated_since`, resuming from a saved page cursor, under
// a per-day cap (OPENSTATES_DAILY_LIMIT) and pacing (OPENSTATES_MIN_INTERVAL_MS).
import { upsertOfficial, deactivateOthers, officialIndex, upsertBill, saveVote } from "./db.js";
import { classifyState } from "./classify.js";
import { matchPositions, stateTotals } from "./rollcall.js";
import { API, headers, openStatesReserve } from "./openstates-api.js";
import { getState, setState, isHttp, slugify, today, BudgetExhausted } from "./util.js";


function daysSince(iso) {
  return iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity;
}

const CHAMBER = { lower: "ca-assembly", upper: "ca-senate" };

function legislatorRecord(p) {
  const role = p.current_role;
  const chamber = CHAMBER[role.org_classification];
  const officialSource = (p.sources || []).map((x) => x.url).find(isHttp);
  const website = (p.links || []).map((l) => l.url).find(isHttp);
  return {
    id: `openstates:${p.id}`,
    slug: slugify(p.name),
    name: p.name,
    last_name: p.family_name || p.name.split(/\s+/).pop(),
    office: chamber === "ca-assembly" ? "State Assemblymember" : "State Senator",
    level: "state",
    chamber,
    body: "state-legislature",
    district: `${chamber === "ca-assembly" ? "Assembly" : "Senate"} District ${role.district}`,
    state: "CA",
    district_code: String(parseInt(role.district, 10) || role.district),
    party: p.party || null,
    // Open States doesn't publish term dates for current roles; left blank rather than guessed.
    term_start: null,
    term_end: null,
    website: website || null,
    photo_url: isHttp(p.image) ? p.image : null,
    photo_credit: isHttp(p.image) ? "Photo via Open States" : null,
    source_url: officialSource || p.openstates_url,
    last_verified: today(),
    openstates_id: p.id,
  };
}

// Every current California legislator (about 120), refreshed weekly. The
// point lookup inside Calaveras County also records the county's own
// districts, for the Calaveras briefing.
export async function syncStateOfficials(env, db, budget) {
  // The weekly wait counts only from a run that loaded every legislator
  // ("state_officials_all"); until one succeeds, every run tries again.
  const loadedAll = await getState(db, "state_officials_all");
  if (loadedAll && daysSince(loadedAll) < 7) return { status: "skipped", message: `every legislator loaded ${loadedAll}; refreshes weekly` };
  const api = env.OPENSTATES_API_BASE || API;
  const h = { headers: headers(env) };

  const geo = await budget.openStates(
    db,
    `${api}/people.geo?lat=${encodeURIComponent(env.LOOKUP_LAT)}&lng=${encodeURIComponent(env.LOOKUP_LNG)}`,
    h,
    "people.geo"
  );
  const here = {};
  for (const p of geo.results || []) {
    const r = p.current_role;
    if (!r || !p.jurisdiction) continue;
    if (p.jurisdiction.classification === "state" && r.org_classification === "upper") here.su = String(parseInt(r.district, 10) || r.district);
    if (p.jurisdiction.classification === "state" && r.org_classification === "lower") here.sl = String(parseInt(r.district, 10) || r.district);
    if (p.jurisdiction.classification === "country" && r.org_classification === "lower") {
      here.cd = String(parseInt(r.district, 10) || r.district);
      await setState(db, "house_district_detected", here.cd);
    }
  }
  if (env.CA_HOUSE_DISTRICT) here.cd = String(env.CA_HOUSE_DISTRICT);
  if (here.su && here.sl) await setState(db, "home_districts", JSON.stringify({ st: "CA", co: "06009", ...here }));

  const people = [];
  for (let page = 1; page <= 10; page++) {
    const data = await budget.openStates(
      db,
      // No org_classification filter: a legislator's current role is in the
      // "lower" or "upper" chamber, which is filtered below.
      `${api}/people?jurisdiction=ca&include=links&include=sources&per_page=50&page=${page}`,
      h,
      `people page ${page}`
    );
    people.push(...(data.results || []));
    const max = (data.pagination && data.pagination.max_page) || page;
    if (page >= max) break;
  }
  const current = people.filter((p) => p.current_role && CHAMBER[p.current_role.org_classification] && p.current_role.district);
  if (current.length < parseInt(env.MIN_STATE_LEGISLATORS || "100", 10)) {
    const roles = [...new Set(people.map((p) => (p.current_role && p.current_role.org_classification) || "none"))].join(", ");
    throw new Error(`Open States listed ${people.length} people but only ${current.length} current California legislators (roles seen: ${roles || "none"}); nothing changed`);
  }

  const loaded = [];
  for (const p of current) {
    const rec = legislatorRecord(p);
    if (!isHttp(rec.source_url)) continue;
    await upsertOfficial(db, rec);
    loaded.push(rec);
  }
  for (const chamber of ["ca-assembly", "ca-senate"]) {
    const keep = loaded.filter((l) => l.chamber === chamber).map((l) => l.id);
    if (keep.length) await deactivateOthers(db, chamber, keep);
  }
  await setState(db, "state_officials_checked", new Date().toISOString());
  await setState(db, "state_officials_all", new Date().toISOString());
  return { status: "ok", message: `loaded ${loaded.length} California legislators; Calaveras districts ${JSON.stringify(here)}` };
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

export async function syncStateVotes(env, db, budget) {
  const officials = await officialIndex(db, ["ca-assembly", "ca-senate"], "openstates_id");
  if (!officials.all.length) return { status: "skipped", message: "no state legislators loaded yet" };
  const api = env.OPENSTATES_API_BASE || API;
  const session = currentSession(env);

  // Read the whole session again, so earlier votes get their totals and every
  // member's position: once after migration 0005, and again whenever more
  // legislators are loaded than when the last full read started (positions are
  // saved only for loaded legislators). Not for a partial load (fewer than
  // MIN_STATE_LEGISLATORS), which would just be repeated.
  const full = officials.all.length >= parseInt(env.MIN_STATE_LEGISLATORS || "100", 10);
  const readWith = parseInt((await getState(db, `ca_votes_backfill_members_${session}`)) || "0", 10);
  if (!(await getState(db, `ca_votes_all_members_${session}`)) || (full && officials.all.length > readWith)) {
    await setState(db, `ca_votes_since_${session}`, `${session.slice(0, 4)}-01-01`);
    await setState(db, `ca_votes_page_${session}`, "1");
    await setState(db, `ca_votes_all_members_${session}`, new Date().toISOString());
    await setState(db, `ca_votes_backfill_members_${session}`, String(officials.all.length));
  }
  const reserve = await openStatesReserve(env, db);

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
      const data = await budget.openStates(db, url, { headers: headers(env) }, `bills page ${page}`, { reserve });
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
              totals: stateTotals(v),
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
