// California legislative committee hearings that involve Calaveras County's two
// state legislators (the districts in sync_state "home_districts"), from Open States v3 (/committees with memberships, /events).
//
// Request-conscious, like the rest of the Open States code: committee
// memberships are refreshed weekly (at most COMMITTEE_PAGES requests), upcoming
// events at most once a day (at most EVENT_PAGES requests). Both count toward
// OPENSTATES_DAILY_LIMIT, and this step runs before state votes so hearings
// are never starved by the vote backfill.
import { API, headers } from "../openstates-api.js";
import { getState, setState, isHttp, slugify, BudgetExhausted } from "../util.js";
import { pacificNow, toPacific } from "./time.js";

const COMMITTEE_PAGES = 12;
const EVENT_PAGES = 3;
const WEEK_MS = 7 * 86400000;

async function ourLegislators(db) {
  const home = JSON.parse((await getState(db, "home_districts")) || "{}");
  const { results } = await db
    .prepare(
      `SELECT * FROM officials WHERE active = 1 AND openstates_id IS NOT NULL
         AND ((chamber = 'ca-senate' AND district_code = ?) OR (chamber = 'ca-assembly' AND district_code = ?))`
    )
    .bind(String(home.su || ""), String(home.sl || ""))
    .all();
  return results;
}

async function refreshCommittees(env, db, budget, legislators) {
  const byPerson = new Map(legislators.map((o) => [o.openstates_id, o]));
  const found = [];
  const api = env.OPENSTATES_API_BASE || API;
  for (let page = 1; page <= COMMITTEE_PAGES; page++) {
    const url = `${api}/committees?jurisdiction=ca&classification=committee&include=memberships&per_page=20&page=${page}`;
    const data = await budget.openStates(db, url, { headers: headers(env) }, `committees page ${page}`);
    for (const c of data.results || []) {
      const members = (c.memberships || []).map((m) => byPerson.get(m.person && m.person.id)).filter(Boolean);
      if (!members.length) continue;
      const source = ((c.sources || c.links || []).map((s) => s.url).find(isHttp)) || "https://openstates.org/ca/";
      found.push([c.id, c.name, members.map((o) => o.id), source]);
    }
    const max = data.pagination && data.pagination.max_page;
    if (!max || page >= max) break;
  }
  const stmts = [db.prepare("DELETE FROM state_committees")];
  for (const [id, name, members, source] of found) {
    stmts.push(
      db
        .prepare("INSERT INTO state_committees (id, name, member_ids, source_url, updated_at) VALUES (?, ?, ?, ?, datetime('now'))")
        .bind(id, name, JSON.stringify(members), source)
    );
  }
  await db.batch(stmts);
  await setState(db, "state_committees_checked", new Date().toISOString());
  return found.length;
}

/** Keep an event if one of its participants is a committee (or legislator) of ours. */
export function matchEvent(event, committees, legislators) {
  const byId = new Map(committees.map((c) => [c.id, c]));
  const byName = new Map(committees.map((c) => [c.name.toLowerCase(), c]));
  const people = new Map(legislators.map((o) => [o.openstates_id, o]));
  let committee = null;
  const members = new Set();
  for (const p of event.participants || []) {
    const org = p.organization || {};
    const c = byId.get(org.id) || byName.get(String(org.name || p.name || "").toLowerCase());
    if (c) {
      committee ||= c;
      for (const id of JSON.parse(c.member_ids || "[]")) members.add(id);
    }
    const person = p.person && people.get(p.person.id);
    if (person) members.add(person.id);
  }
  if (!committee && !members.size) return null;
  return { committee, members: [...members] };
}

export async function syncStateHearings(env, db, budget) {
  const legislators = await ourLegislators(db);
  if (!legislators.length) return { status: "skipped", message: "no state legislators loaded yet" };
  const today = pacificNow().slice(0, 10);
  if ((await getState(db, "state_hearings_day")) === today) return { status: "skipped", message: "already checked today" };
  try {
    const checked = await getState(db, "state_committees_checked");
    let committeesNote = "";
    if (!checked || Date.now() - Date.parse(checked) > WEEK_MS) {
      committeesNote = `${await refreshCommittees(env, db, budget, legislators)} committee(s) with our legislators; `;
    }
    const committees = (await db.prepare("SELECT * FROM state_committees").all()).results;
    const names = new Map(legislators.map((o) => [o.id, o.name]));
    const api = env.OPENSTATES_API_BASE || API;
    let saved = 0;
    for (let page = 1; page <= EVENT_PAGES; page++) {
      const url =
        `${api}/events?jurisdiction=ca&after=${today}&include=participants&include=links&include=sources` +
        `&per_page=20&page=${page}`;
      const data = await budget.openStates(db, url, { headers: headers(env) }, `events page ${page}`);
      for (const ev of data.results || []) {
        const match = matchEvent(ev, committees, legislators);
        if (!match) continue;
        const source = [...(ev.sources || []), ...(ev.links || [])].map((s) => s.url).find(isHttp);
        const starts = /T\d{2}:\d{2}/.test(ev.start_date || "") ? toPacific(ev.start_date) : ev.start_date ? `${ev.start_date.slice(0, 10)}T00:00` : null;
        if (!source || !starts) continue; // nothing is shown without a source and a date
        const online = (ev.links || []).find((l) => /video|stream|watch|live/i.test(`${l.note} ${l.url}`) && isHttp(l.url));
        await db
          .prepare(
            `INSERT INTO meetings (id, level, source, body, meeting_type, starts_at, status, location, online_url, participants, source_url, updated_at)
             VALUES (?, 'state', 'openstates', ?, 'Hearing', ?, ?, ?, ?, ?, ?, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET body = excluded.body, starts_at = excluded.starts_at, status = excluded.status,
               location = excluded.location, online_url = excluded.online_url, participants = excluded.participants,
               source_url = excluded.source_url, updated_at = excluded.updated_at`
          )
          .bind(
            `os-${slugify(ev.id)}`,
            (match.committee && match.committee.name) || ev.name || "Legislative hearing",
            starts,
            /cancel/i.test(ev.status || "") ? "cancelled" : "scheduled",
            (ev.location && ev.location.name) || null,
            online ? online.url : null,
            JSON.stringify(match.members.map((id) => names.get(id)).filter(Boolean)),
            source
          )
          .run();
        saved += 1;
      }
      const max = data.pagination && data.pagination.max_page;
      if (!max || page >= max) break;
    }
    await setState(db, "state_hearings_day", today);
    return { status: "ok", message: `${committeesNote}${saved} upcoming hearing(s) saved` };
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: err.message };
    throw err;
  }
}
