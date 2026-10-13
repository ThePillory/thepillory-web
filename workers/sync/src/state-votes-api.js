// Daily updates for the states whose votes were bulk-loaded from Open States'
// session files (tools/load_state_votes.py): each state's bills updated since,
// in every session (a new session is picked up on its own), read from the Open
// States API with their votes, a few pages a day. California's own step
// (src/openstates.js) runs first and keeps first claim on the free daily limit;
// this step uses at most STATE_VOTES_API_DAILY (60) pages a day, the states
// visitors look up most first. Positions go to the compact state_positions.
// See docs/states.md.
import { API, headers } from "./openstates-api.js";
import { classifyState, normalizePosition } from "./classify.js";
import { stateTotals, totals } from "./rollcall.js";
import { upsertBill } from "./db.js";
import { getState, setState, isHttp, slugify, BudgetExhausted } from "./util.js";
import { chamberIds, stableKey, POSITION_CODE } from "./states.js";
import { statePriority } from "./state-priority.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));
const PLAIN = new Set(["yes", "no", "present", "not voting"]);

/** Members' positions on one API vote, matched by Open States person id (or a unique last name in the chamber). Pure; tested. */
export function matchStatePositions(vote, officials, chamber) {
  const out = [];
  const seen = new Set();
  for (const pv of vote.votes || []) {
    const pid = pv.voter && pv.voter.id;
    let o = pid ? officials.get(pid) : null;
    if (!o && !pid && chamber) {
      const name = String(pv.voter_name || "").toLowerCase().trim();
      const hits = [...officials.values()].filter((x) => {
        const last = String(x.last_name || "").toLowerCase();
        return x.chamber === chamber && !!last && (name === last || name.startsWith(`${last},`) || name.endsWith(` ${last}`));
      });
      if (hits.length === 1) o = hits[0];
    }
    if (!o || o.k == null || seen.has(o.k)) continue;
    seen.add(o.k);
    const raw = String(pv.option || "").trim();
    out.push({ member_k: o.k, position: POSITION_CODE[normalizePosition(raw)], raw: PLAIN.has(raw.toLowerCase()) ? null : raw });
  }
  return out;
}

/** True when an API bill is this state's (a mismatched answer is never saved under the wrong state), and in `session` when one is given. Pure; tested. */
export function billIsFrom(bill, st, session = null) {
  const jur = String((bill && bill.jurisdiction && bill.jurisdiction.id) || "");
  const p = String(st).toLowerCase();
  if (!new RegExp(`/(state|district|territory):${p}/`).test(jur)) return false;
  return session == null || bill.session == null || String(bill.session) === String(session);
}

/**
 * Where a state's daily read starts the first time, from its bulk loads
 * ({session, bills, generated_at}). Each session file holds everything up to
 * the day it was generated, so the read starts at the earliest of those days
 * among the files still being added to (generated within RECENT_DAYS of the
 * state's newest; an older file's session is over). A file that came back
 * empty holds nothing, so its session is read from the API in full from that
 * day on; when no file had any bills, from the start of the two-year period.
 * Pure; tested.
 */
const RECENT_DAYS = 120;
export function firstSince(loads, today = new Date().toISOString().slice(0, 10)) {
  const y = parseInt(today.slice(0, 4), 10);
  const period = `${y % 2 ? y : y - 1}-01-01`;
  const days = loads.filter((l) => Number(l.bills) > 0).map((l) => String(l.generated_at || "").slice(0, 10)).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();
  if (!days.length) return period;
  const newest = new Date(`${days[days.length - 1]}T00:00:00Z`);
  const cutoff = new Date(newest.getTime() - RECENT_DAYS * 86400000).toISOString().slice(0, 10);
  const start = days.find((d) => d >= cutoff);
  return start < period ? period : start;
}

export async function syncOtherStateVotes(env, db, budget) {
  let loads;
  try {
    loads = (await db.prepare("SELECT st, session, bills, generated_at, loaded_at FROM state_loads ORDER BY loaded_at DESC").all()).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!loads.length) return { status: "skipped", message: "no state bulk-loaded yet (the Load state votes workflow)" };
  if (!env.OPENSTATES_API_KEY) return { status: "skipped", message: "OPENSTATES_API_KEY is not set" };
  const byState = new Map();
  for (const l of loads) byState.set(l.st, [...(byState.get(l.st) || []), l]);
  const order = (await statePriority(db, env)).filter((st) => byState.has(st));
  const cap = parseInt(env.STATE_VOTES_API_DAILY || "60", 10);
  // One state reads at most this many pages a run, so a state catching up
  // never stops the others from updating.
  const perState = parseInt(env.STATE_VOTES_API_PER_STATE || "10", 10);
  const dayKey = `state_votes_api_${new Date().toISOString().slice(0, 10)}`;
  let used = parseInt((await getState(db, dayKey)) || "0", 10);
  if (used >= cap) return { status: "skipped", message: `${used} pages read today (STATE_VOTES_API_DAILY ${cap})` };
  const api = env.OPENSTATES_API_BASE || API;
  const done = [];
  try {
    for (const st of order) {
      const p = st.toLowerCase();
      const ids = chamberIds(st);
      const chambers = [ids.upper, ids.lower].filter(Boolean);
      const { results: rows } = await db
        .prepare(`SELECT openstates_id, k, chamber, last_name FROM officials WHERE active = 1 AND state = ? AND k IS NOT NULL AND chamber IN (${chambers.map(() => "?").join(",")})`)
        .bind(st, ...chambers)
        .all();
      const officials = new Map(rows.filter((r) => r.openstates_id).map((r) => [r.openstates_id, r]));
      const sinceKey = `state_votes_since_${st}`;
      const pageKey = `state_votes_page_${st}`;
      const since = (await getState(db, sinceKey)) || firstSince(byState.get(st));
      let page = parseInt((await getState(db, pageKey)) || "1", 10);
      let maxUpdated = since;
      let saved = 0;
      let skipped = 0;
      let read = 0;
      for (;;) {
        if (used >= cap) throw new BudgetExhausted(`STATE_VOTES_API_DAILY (${cap}) pages read today`);
        if (read >= perState) {
          done.push(`${st}: ${saved} vote(s), more tomorrow (page ${page}, bills updated since ${since.slice(0, 10)})`);
          break;
        }
        const url = `${api}/bills?jurisdiction=${p}&updated_since=${encodeURIComponent(since)}&sort=updated_asc&include=votes&include=sources&per_page=20&page=${page}`;
        const data = await budget.openStates(db, url, { headers: headers(env) }, `${st} bills page ${page}`);
        used += 1;
        read += 1;
        await setState(db, dayKey, String(used));
        for (const bill of data.results || []) {
          if (bill.updated_at && bill.updated_at > maxUpdated) maxUpdated = bill.updated_at;
          const session = String(bill.session || "").trim();
          if (!billIsFrom(bill, st) || !session) {
            skipped += 1;
            continue;
          }
          const identifier = String(bill.identifier || "").trim();
          const billSource = (bill.sources || []).map((s) => s.url).find(isHttp) || bill.openstates_url;
          if (!(bill.votes || []).length || !isHttp(billSource)) continue;
          const billId = `${p}-${slugify(session)}-${slugify(identifier)}`;
          const fromType = bill.from_organization && bill.from_organization.classification;
          await upsertBill(db, { id: billId, level: "state", chamber: ids[fromType] || ids.upper, bill_number: identifier, session, title: bill.title || identifier, official_url: billSource, source_url: billSource });
          for (const v of bill.votes) {
            const orgType = String((v.organization && v.organization.classification) || "");
            const chamber = ids[orgType] || (orgType === "legislature" ? ids.upper : null) || ids[fromType] || `${p}-legislature`;
            const id = `${p}-${v.id}`;
            const vote = {
              id, bill_id: billId, chamber, vote_date: String(v.start_date || "").slice(0, 10),
              question: v.motion_text || "(no motion text)", vote_type: classifyState(v),
              result: v.result === "pass" ? "Passed" : v.result === "fail" ? "Failed" : String(v.result || "Unknown"),
              source_url: (v.sources || []).map((s) => s.url).find(isHttp) || billSource, totals: stateTotals(v), k: await stableKey(id),
            };
            await saveStateVote(db, vote, matchStatePositions(v, officials, ids[orgType]));
            saved += 1;
          }
        }
        const maxPage = (data.pagination && data.pagination.max_page) || page;
        if (page >= maxPage) {
          await setState(db, sinceKey, maxUpdated);
          await setState(db, pageKey, "1");
          done.push(`${st}: caught up, ${saved} vote(s)${skipped ? `; ${skipped} bill(s) from another state left out` : ""}`);
          break;
        }
        page += 1;
        await setState(db, pageKey, String(page));
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${done.join("; ") || "none caught up yet"}; ${err.message}` };
  }
  return { status: "ok", message: done.join("; ") };
}
