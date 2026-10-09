// Daily updates for the states whose votes were bulk-loaded from Open States'
// session files (tools/load_state_votes.py): bills updated since, read from the
// Open States API with their votes, a few pages a day. California's own step
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

/** True when an API bill is this state's, in this session (a mismatched answer is never saved under the wrong state). Pure; tested. */
export function billIsFrom(bill, st, session) {
  const jur = String((bill && bill.jurisdiction && bill.jurisdiction.id) || "");
  const p = String(st).toLowerCase();
  if (!new RegExp(`/(state|district|territory):${p}/`).test(jur)) return false;
  return bill.session == null || String(bill.session) === String(session);
}

/** A state vote and its compact positions, in one batch. The chamber of a vote already loaded is kept. */
export async function saveStateVote(db, v, positions) {
  if (!isHttp(v.source_url)) throw new Error(`vote ${v.id} has no http(s) source URL; not saved`);
  const stmts = [
    db
      .prepare(
        `INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay, present, not_voting, k, updated_at)
         VALUES (?, ?, 'state', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(id) DO UPDATE SET vote_date = excluded.vote_date, question = excluded.question, vote_type = excluded.vote_type,
           result = excluded.result, source_url = excluded.source_url, yea = excluded.yea, nay = excluded.nay,
           present = excluded.present, not_voting = excluded.not_voting, k = excluded.k, updated_at = excluded.updated_at`
      )
      .bind(v.id, v.bill_id, v.chamber, v.vote_date, v.question, v.vote_type, v.result, v.source_url, ...totals(v.totals), v.k),
  ];
  for (const p of positions) {
    stmts.push(
      db
        .prepare("INSERT INTO state_positions (vote_k, member_k, position, raw) VALUES (?, ?, ?, ?) ON CONFLICT(vote_k, member_k) DO UPDATE SET position = excluded.position, raw = excluded.raw")
        .bind(v.k, p.member_k, p.position, p.raw)
    );
  }
  for (let i = 0; i < stmts.length; i += 100) await db.batch(stmts.slice(i, i + 100));
}

export async function syncOtherStateVotes(env, db, budget) {
  let loads;
  try {
    loads = (await db.prepare("SELECT st, session, generated_at, loaded_at FROM state_loads ORDER BY loaded_at DESC").all()).results;
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!loads.length) return { status: "skipped", message: "no state bulk-loaded yet (the Load state votes workflow)" };
  if (!env.OPENSTATES_API_KEY) return { status: "skipped", message: "OPENSTATES_API_KEY is not set" };
  // Each state's newest loaded session, in priority order.
  const latest = new Map();
  for (const l of loads) if (!latest.has(l.st)) latest.set(l.st, l);
  const order = (await statePriority(db, env)).filter((st) => latest.has(st));
  const cap = parseInt(env.STATE_VOTES_API_DAILY || "60", 10);
  const dayKey = `state_votes_api_${new Date().toISOString().slice(0, 10)}`;
  let used = parseInt((await getState(db, dayKey)) || "0", 10);
  if (used >= cap) return { status: "skipped", message: `${used} pages read today (STATE_VOTES_API_DAILY ${cap})` };
  const api = env.OPENSTATES_API_BASE || API;
  const done = [];
  try {
    for (const st of order) {
      const { session, generated_at } = latest.get(st);
      const p = st.toLowerCase();
      const ids = chamberIds(st);
      const chambers = [ids.upper, ids.lower].filter(Boolean);
      const { results: rows } = await db
        .prepare(`SELECT openstates_id, k, chamber, last_name FROM officials WHERE active = 1 AND state = ? AND k IS NOT NULL AND chamber IN (${chambers.map(() => "?").join(",")})`)
        .bind(st, ...chambers)
        .all();
      const officials = new Map(rows.filter((r) => r.openstates_id).map((r) => [r.openstates_id, r]));
      const sinceKey = `votes_since_${st}_${session}`;
      const pageKey = `votes_page_${st}_${session}`;
      const since = (await getState(db, sinceKey)) || String(generated_at || "").slice(0, 10) || `${new Date().getUTCFullYear()}-01-01`;
      let page = parseInt((await getState(db, pageKey)) || "1", 10);
      let maxUpdated = since;
      let saved = 0;
      let skipped = 0;
      for (;;) {
        if (used >= cap) throw new BudgetExhausted(`STATE_VOTES_API_DAILY (${cap}) pages read today`);
        const url = `${api}/bills?jurisdiction=${p}&session=${encodeURIComponent(session)}&updated_since=${encodeURIComponent(since)}&sort=updated_asc&include=votes&include=sources&per_page=20&page=${page}`;
        const data = await budget.openStates(db, url, { headers: headers(env) }, `${st} bills page ${page}`);
        used += 1;
        await setState(db, dayKey, String(used));
        for (const bill of data.results || []) {
          if (bill.updated_at && bill.updated_at > maxUpdated) maxUpdated = bill.updated_at;
          if (!billIsFrom(bill, st, session)) {
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
          done.push(`${st} ${session}: caught up, ${saved} vote(s)${skipped ? `; ${skipped} bill(s) from another state or session left out` : ""}`);
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
