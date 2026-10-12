// Two sync steps (see docs/funding.md):
//
//   federal-funding   FEC campaign finance for every member of Congress, for the
//                     current and the previous two-year period. Per member and
//                     period: totals, PAC contributions (all of them, summed by
//                     committee), employers of donors who gave more than $200
//                     (summed; never a donor's name), and outside spending for
//                     and against. About 6 to 20 requests each. The current
//                     period is read again every FUNDING_REFRESH_DAYS (7), the
//                     previous one every 90 days.
//   federal-lobbying  lda.gov lobbying reports that mention each bill of the
//                     current Congress with a final-passage vote or committee
//                     action, newest activity first, searched again every
//                     LOBBYING_REFRESH_DAYS (30): reports are quarterly.
//   committee-bills   Congress.gov's bill list for each full committee: bills a
//                     committee reported, marked up, held hearings on or was
//                     discharged from (not referral alone), so federal-lobbying
//                     searches them too.
//   lobbying-contributions
//                     lda.gov LD-203 reports: contributions from registered
//                     lobbyists and lobbying organizations honoring each member
//                     of Congress, searched by the member's last name and kept
//                     only on an exact name match; LDA_CONTRIB_DAILY (400) a day.
//
// All are paced and capped per day (FEC: an api.data.gov key allows 1,000
// requests an hour), keep their place across rounds and days, and stop with
// "partial" when a round's time or the day's cap runs out.
//
// Order: members who represent a live community (LIVE_HOUSE_DISTRICTS, e.g.
// "CA-5", plus that state's senators) first, then the rest of those states'
// delegations, then everyone else; each member is matched to FEC IDs and read
// in turn. While lobbying has bills waiting, funding leaves it
// LOBBYING_ROUND_SHARE (0.4) of the round's remaining time.
import { getState, setState, BudgetExhausted, UpstreamError, isHttp, currentCongress } from "../util.js";
import { API as FEC_API, currentCycle, candidateIdsFor, candidatePage, parseTotals, aggregatePacs, parseEmployers, parseOutside } from "./fec.js";
import { API as LDA_API, congressYears, billQueries, mentionsIn, filingRow, memberIndex, honoreeQuery, contribFilingRow, contributionItems, committeeActed } from "./lobbying.js";
import { api as congressApi } from "../congress-api.js";
import { federalBill } from "../congress.js";
import { upsertBill } from "../db.js";

const CROSSWALK = "https://unitedstates.github.io/congress-legislators/legislators-current.json";
const MAX_PAC_PAGES = 40;
const MAX_EMPLOYER_PAGES = 3;
const MAX_OUTSIDE_PAGES = 5;
const DAY = 86400000;

const daysSince = (iso) => (iso ? (Date.now() - Date.parse(`${iso.replace(" ", "T")}${/Z|[+-]\d\d:?\d\d$/.test(iso) ? "" : "Z"}`)) / DAY : Infinity);

async function inBatches(db, stmts, size = 50) {
  for (let i = 0; i < stmts.length; i += size) await db.batch(stmts.slice(i, i + size));
}

// ---------------------------------------------------------------------------
// FEC

export function fecOptions(env) {
  // Funding has its own api.data.gov key (FEC_API_KEY), so it doesn't share an
  // hourly limit with the votes steps. Without it, funding borrows the
  // Congress.gov key at half the pace, leaving room for votes.
  const own = !!env.FEC_API_KEY;
  return {
    base: (env.FEC_API_BASE || FEC_API).replace(/\/$/, ""),
    key: env.FEC_API_KEY || env.CONGRESS_API_KEY,
    own,
    pace: {
      intervalMs: parseInt((own ? env.FEC_MIN_INTERVAL_MS : env.FEC_SHARED_MIN_INTERVAL_MS) || (own ? "4000" : "8000"), 10),
      dailyLimit: parseInt(env.FEC_DAILY_LIMIT || "3000", 10),
    },
    refreshDays: parseInt(env.FUNDING_REFRESH_DAYS || "7", 10),
    crosswalk: env.LEGISLATORS_URL || CROSSWALK,
  };
}

/**
 * Live communities' House districts ("CA-5"), from LIVE_HOUSE_DISTRICTS (keep in
 * step with LIVE in functions/_lib/geo.js), else CA_HOUSE_DISTRICT.
 */
export function liveDistricts(env) {
  const raw = env.LIVE_HOUSE_DISTRICTS || (env.CA_HOUSE_DISTRICT ? `CA-${env.CA_HOUSE_DISTRICT}` : "");
  return raw
    .split(",")
    .map((x) => x.trim().toUpperCase().match(/^([A-Z]{2})-(\d+)$/))
    .filter(Boolean)
    .map((m) => ({ st: m[1], cd: String(parseInt(m[2], 10)) }));
}

/** SQL for a member's place in line (0: represents a live community; 1: same state; 2: everyone else), and its binds. */
export function priorityOf(env) {
  const live = liveDistricts(env);
  if (!live.length) return { sql: "2", binds: [] };
  const states = [...new Set(live.map((d) => d.st))];
  const ph = (a) => a.map(() => "?").join(",");
  return {
    sql: `CASE WHEN (o.chamber = 'us-house' AND (o.state || '-' || o.district_code) IN (${ph(live)})) OR (o.chamber = 'us-senate' AND o.state IN (${ph(states)})) THEN 0
               WHEN o.state IN (${ph(states)}) THEN 1 ELSE 2 END`,
    binds: [...live.map((d) => `${d.st}-${d.cd}`), ...states, ...states],
  };
}

async function loadCrosswalk(db, budget, o) {
  let crosswalk = JSON.parse((await getState(db, "fec_crosswalk")) || "null");
  if (!crosswalk || daysSince(crosswalk.at) >= 7) {
    const all = await budget.json(o.crosswalk, {}, "FEC ID crosswalk");
    crosswalk = { at: new Date().toISOString(), ids: Object.fromEntries(all.filter((l) => l.id && l.id.bioguide).map((l) => [l.id.bioguide, l.id.fec || []])) };
    await setState(db, "fec_crosswalk", JSON.stringify(crosswalk));
  }
  return crosswalk;
}

/** Match one member to an FEC candidate ID and principal campaign committee. */
async function resolveOne(db, fec, o, crosswalk, m, cycle) {
  const bioguide = m.bioguide_id || m.id.replace(/^bioguide:/, "");
  // The President's FEC IDs come from executive.json (saved by executive-officials).
  const execIds = m.chamber === "us-executive" ? JSON.parse((await getState(db, "executive_fec")) || "{}")[m.id] : null;
  const ids = candidateIdsFor(execIds || crosswalk.ids[bioguide], m.chamber, m.state);
  let row = { candidate_id: ids[0] || null, committee_id: null, committee_name: null, note: null, source_url: ids[0] ? candidatePage(ids[0], cycle) : o.crosswalk };
  if (!ids.length) row.note = "No FEC candidate ID for this office in the public crosswalk (often a newly appointed senator).";
  for (const id of ids) {
    const d = await fec(`/candidate/${id}/committees/?designation=P&cycle=${cycle}&per_page=5`, `committees ${id}`);
    const c = (d.results || [])[0];
    if (c) {
      row = { candidate_id: id, committee_id: c.committee_id, committee_name: c.name || null, note: null, source_url: candidatePage(id, cycle) };
      break;
    }
  }
  if (ids.length && !row.committee_id) row.note = `No principal campaign committee registered for ${cycle - 1}–${cycle}.`;
  await db
    .prepare(
      `INSERT INTO fec_candidates (official_id, candidate_id, committee_id, committee_name, note, source_url, checked_at)
       VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(official_id) DO UPDATE SET candidate_id = excluded.candidate_id, committee_id = excluded.committee_id,
         committee_name = excluded.committee_name, note = excluded.note, source_url = excluded.source_url, checked_at = excluded.checked_at`
    )
    .bind(m.id, row.candidate_id, row.committee_id, row.committee_name, row.note, row.source_url)
    .run();
  return row;
}

/** Every page of a keyset-paginated Schedule A search. */
async function allScheduleA(fec, path, label) {
  const rows = [];
  let last = null;
  for (let page = 0; page < MAX_PAC_PAGES; page++) {
    const q = last ? `&last_index=${encodeURIComponent(last.last_index)}&last_contribution_receipt_amount=${encodeURIComponent(last.last_contribution_receipt_amount)}` : "";
    const d = await fec(`${path}${q}`, `${label} page ${page + 1}`);
    rows.push(...(d.results || []));
    last = d.pagination && d.pagination.last_indexes;
    if (!last || (d.results || []).length < 100) return { rows, complete: true };
  }
  return { rows, complete: false };
}

async function pagesOf(fec, path, max, label) {
  const rows = [];
  for (let page = 1; page <= max; page++) {
    const d = await fec(`${path}&page=${page}`, `${label} page ${page}`);
    rows.push(...(d.results || []));
    if (!d.pagination || page >= (d.pagination.pages || 1)) return rows;
  }
  return rows;
}

async function readOne(db, fec, m, cycle, current) {
  // The committee for this period (it can differ from the current one).
  let committee = cycle === current ? m.committee_id : null;
  if (cycle !== current) {
    const d = await fec(`/candidate/${m.candidate_id}/committees/?designation=P&cycle=${cycle}&per_page=5`, `committees ${m.candidate_id} ${cycle}`);
    committee = ((d.results || [])[0] || {}).committee_id || null;
  }
  const t = await fec(`/candidate/${m.candidate_id}/totals/?cycle=${cycle}&election_full=false`, `totals ${m.candidate_id} ${cycle}`);
  const totals = parseTotals((t.results || [])[0], m.candidate_id, cycle);
  let pacs = [];
  let employers = [];
  let pacNote = null;
  if (committee && totals) {
    const a = await allScheduleA(
      fec,
      `/schedules/schedule_a/?committee_id=${committee}&two_year_transaction_period=${cycle}&line_number=F3-11C&per_page=100&sort=-contribution_receipt_amount`,
      `PAC contributions ${committee} ${cycle}`
    );
    pacs = aggregatePacs(a.rows, committee, cycle);
    if (!a.complete) pacNote = `PAC list from the ${MAX_PAC_PAGES * 100} largest PAC contributions`;
    employers = parseEmployers(
      await pagesOf(fec, `/schedules/schedule_a/by_employer/?committee_id=${committee}&cycle=${cycle}&sort=-total&per_page=100`, MAX_EMPLOYER_PAGES, `employers ${committee} ${cycle}`),
      m.candidate_id,
      cycle
    );
  }
  const outside = totals
    ? parseOutside(await pagesOf(fec, `/schedules/schedule_e/by_candidate/?candidate_id=${m.candidate_id}&cycle=${cycle}&sort=-total&per_page=100`, MAX_OUTSIDE_PAGES, `outside spending ${m.candidate_id} ${cycle}`), m.candidate_id, cycle)
    : [];

  const id = m.official_id;
  const stmts = ["funding_totals", "funding_pacs", "funding_outside", "funding_employers"].map((t) => db.prepare(`DELETE FROM ${t} WHERE official_id = ? AND cycle = ?`).bind(id, cycle));
  if (totals) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO funding_totals (official_id, cycle, candidate_id, receipts, disbursements, cash_on_hand, individual_unitemized, individual_itemized,
             pac, party, self_funding, other, coverage_end, last_report, source_url, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`
        )
        .bind(id, cycle, totals.candidate_id, totals.receipts, totals.disbursements, totals.cash_on_hand, totals.individual_unitemized, totals.individual_itemized,
          totals.pac, totals.party, totals.self_funding, totals.other, totals.coverage_end, totals.last_report, totals.source_url)
    );
  }
  for (const p of pacs) {
    stmts.push(
      db
        .prepare("INSERT OR REPLACE INTO funding_pacs (official_id, cycle, committee_id, name, committee_type, total, count, industry, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, cycle, p.committee_id, p.name, p.committee_type, p.total, p.count, p.industry, p.source_url)
    );
  }
  for (const e of employers) {
    stmts.push(
      db
        .prepare("INSERT OR REPLACE INTO funding_employers (official_id, cycle, employer, total, count, industry, source_url) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .bind(id, cycle, e.employer, e.total, e.count, e.industry, e.source_url)
    );
  }
  for (const x of outside) {
    stmts.push(
      db
        .prepare("INSERT OR REPLACE INTO funding_outside (official_id, cycle, committee_id, name, support_oppose, total, count, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(id, cycle, x.committee_id, x.name, x.support_oppose, x.total, x.count, x.source_url)
    );
  }
  const note = !totals ? `No FEC totals for ${cycle - 1}–${cycle}.` : pacNote;
  stmts.push(
    db
      .prepare(
        `INSERT INTO funding_progress (official_id, cycle, done_at, note) VALUES (?, ?, datetime('now'), ?)
         ON CONFLICT(official_id, cycle) DO UPDATE SET done_at = excluded.done_at, note = excluded.note`
      )
      .bind(id, cycle, note)
  );
  await inBatches(db, stmts);
  return { pacs: pacs.length, outside: outside.length, employers: employers.length, totals: !!totals };
}

// Bills whose lobbying search is due (see syncFederalLobbying).
const LOBBYING_DUE = `b.level = 'federal'
  AND b.session = (SELECT MAX(session) FROM bills WHERE level = 'federal')
  AND (EXISTS (SELECT 1 FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage')
       OR EXISTS (SELECT 1 FROM bill_committee_actions c WHERE c.bill_id = b.id))
  AND (p.bill_id IS NULL OR p.done_at IS NULL OR p.done_at < datetime('now', ?))`;

// A bill's latest activity: its newest final-passage vote or committee action. Newest first.
const LOBBYING_LATEST = `MAX(COALESCE((SELECT MAX(v.vote_date) FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage'), ''),
  COALESCE((SELECT MAX(c.action_date) FROM bill_committee_actions c WHERE c.bill_id = b.id), ''))`;

async function lobbyingWaiting(env, db) {
  const days = `-${parseInt(env.LOBBYING_REFRESH_DAYS || "30", 10)} days`;
  const r = await db.prepare(`SELECT COUNT(*) AS n FROM bills b LEFT JOIN bill_lobbying_progress p ON p.bill_id = b.id WHERE ${LOBBYING_DUE}`).bind(days).first();
  return r ? r.n : 0;
}

// Who has campaign funding to load: members of Congress and the President (the
// Vice President runs on the President's ticket; the Cabinet is appointed).
const FUNDED = "(o.chamber IN ('us-house', 'us-senate') OR (o.chamber = 'us-executive' AND o.rank = 1))";

// Leave a member-period unstarted when less than this much of funding's time is left.
const MIN_MEMBER_MS = 90000;

export async function syncFederalFunding(env, db, budget) {
  const o = fecOptions(env);
  if (!o.key) return { status: "skipped", message: "FEC_API_KEY (or CONGRESS_API_KEY) secret is not set" };
  // While lobbying has bills waiting, it keeps its share of what's left of this round.
  const share = Math.min(0.9, Math.max(0, parseFloat(env.LOBBYING_ROUND_SHARE || "0.4")));
  const reserveMs = share > 0 && (await lobbyingWaiting(env, db)) > 0 ? Math.round(budget.timeLeft() * share) : 0;
  const ownTimeLeft = () => budget.timeLeft() - reserveMs;
  const SHARE_USED = "run time limit reached (the rest of this round is federal-lobbying's share)";
  const fec = async (path, label) => {
    if (ownTimeLeft() < o.pace.intervalMs + 15000) throw new BudgetExhausted(`${reserveMs ? SHARE_USED : "run time limit reached"} before ${label}`);
    const url = `${o.base}${path}${path.includes("?") ? "&" : "?"}api_key=${encodeURIComponent(o.key)}`;
    try {
      return await (await budget.paced(db, "fec", o.pace, url, { headers: { Accept: "application/json" } }, label)).json();
    } catch (err) {
      // Over the hourly limit: stop for now; the next round or day continues.
      if (err instanceof UpstreamError && err.status === 429) throw new BudgetExhausted("FEC hourly rate limit reached");
      throw err;
    }
  };
  const current = currentCycle();
  const prev = current - 2;
  const prio = priorityOf(env);
  let crosswalk = null;
  let resolved = 0;
  let read = 0;
  const counts = { pacs: 0, outside: 0, employers: 0, noTotals: 0 };
  const firstDone = [];
  const summary = (extra = "") => {
    return `${read} member-period(s) read (${counts.pacs} PAC, ${counts.outside} outside-spending and ${counts.employers} employer rows)` +
      `${counts.noTotals ? `, ${counts.noTotals} with no FEC totals for that period` : ""}${resolved ? `; ${resolved} member(s) matched to FEC IDs` : ""}` +
      `${firstDone.length ? `; live communities' members done: ${firstDone.join(", ")}` : ""}; ${o.own ? "FEC key" : "sharing the Congress.gov key (set FEC_API_KEY)"}${extra}`;
  };
  // Members with anything due: an FEC match (new, or older than 30 days) or a
  // period to read. Never-loaded members first, in priority order; then refreshes.
  const nextMembers = async () =>
    (
      await db
        .prepare(
          `SELECT o.id, o.bioguide_id, o.chamber, o.state, f.official_id AS matched, f.candidate_id, f.committee_id,
             f.official_id IS NULL OR f.checked_at < datetime('now', '-30 days') AS needs_match,
             p1.done_at AS cur_done, p2.done_at AS prev_done, ${prio.sql} AS priority
           FROM officials o
           LEFT JOIN fec_candidates f ON f.official_id = o.id
           LEFT JOIN funding_progress p1 ON p1.official_id = o.id AND p1.cycle = ?
           LEFT JOIN funding_progress p2 ON p2.official_id = o.id AND p2.cycle = ?
           WHERE o.level = 'federal' AND o.active = 1 AND ${FUNDED}
             AND (f.official_id IS NULL OR f.checked_at < datetime('now', '-30 days')
                  OR (f.candidate_id IS NOT NULL AND (p1.done_at IS NULL OR p1.done_at < datetime('now', ?) OR p2.done_at IS NULL OR p2.done_at < datetime('now', '-90 days'))))
           ORDER BY (f.candidate_id IS NOT NULL AND p1.done_at IS NOT NULL AND p2.done_at IS NOT NULL) OR (f.official_id IS NOT NULL AND f.candidate_id IS NULL),
             priority, p1.done_at IS NOT NULL, MIN(COALESCE(p1.done_at, ''), COALESCE(p2.done_at, '')), o.id
           LIMIT 10`
        )
        .bind(...prio.binds, current, prev, `-${o.refreshDays} days`)
        .all()
    ).results;
  const seen = new Set();
  try {
    for (;;) {
      const todo = (await nextMembers()).filter((m) => !seen.has(m.id));
      if (!todo.length) break;
      for (const m of todo) {
        seen.add(m.id); // at most once per run, whatever is left due
        let fecRow = m;
        if (m.needs_match) {
          crosswalk ||= await loadCrosswalk(db, budget, o);
          fecRow = await resolveOne(db, fec, o, crosswalk, m, current);
          resolved += 1;
        }
        if (!fecRow.candidate_id) continue;
        const due = [
          [current, m.cur_done, `-${o.refreshDays}`],
          [prev, m.prev_done, "-90"],
        ].filter(([, done, days]) => !done || Date.parse(`${done.replace(" ", "T")}Z`) < Date.now() + parseInt(days, 10) * DAY);
        for (const [cycle] of due) {
          if (ownTimeLeft() < MIN_MEMBER_MS) throw new BudgetExhausted(reserveMs ? SHARE_USED : "run time limit reached");
          const r = await readOne(db, fec, { official_id: m.id, candidate_id: fecRow.candidate_id, committee_id: fecRow.committee_id }, cycle, current);
          read += 1;
          counts.pacs += r.pacs;
          counts.outside += r.outside;
          counts.employers += r.employers;
          if (!r.totals) counts.noTotals += 1;
        }
        if (m.priority === 0 && due.length) firstDone.push(m.id.replace(/^bioguide:/, ""));
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    const waiting = (
      await db
        .prepare(
          `SELECT COUNT(*) AS n FROM officials o LEFT JOIN fec_candidates f ON f.official_id = o.id
           LEFT JOIN funding_progress p ON p.official_id = o.id AND p.cycle = ?
           WHERE o.level = 'federal' AND o.active = 1 AND ${FUNDED} AND (f.official_id IS NULL OR (f.candidate_id IS NOT NULL AND p.done_at IS NULL))`
        )
        .bind(current)
        .first()
    ).n;
    return { status: "partial", message: `${summary()}; ${waiting} member(s) not loaded yet; ${err.message}` };
  }
  if (!read && !resolved) return { status: "skipped", message: "every member's funding is up to date" };
  return { status: "ok", message: summary() };
}

// ---------------------------------------------------------------------------
// Lobbying

function ldaOptions(env) {
  return {
    base: (env.LDA_API_BASE || LDA_API).replace(/\/$/, ""),
    headers: { Accept: "application/json", ...(env.LDA_API_KEY ? { Authorization: `Token ${env.LDA_API_KEY}` } : {}) },
    pace: { intervalMs: parseInt(env.LDA_MIN_INTERVAL_MS || "3000", 10), dailyLimit: parseInt(env.LDA_DAILY_LIMIT || "1200", 10) },
    refreshDays: parseInt(env.LOBBYING_REFRESH_DAYS || "30", 10),
  };
}

async function saveMatches(db, bill, filing, mentions) {
  const f = filingRow(filing);
  if (!f.filing_uuid || !isHttp(f.source_url) || !f.client_name) return false;
  const stmts = [
    db
      .prepare(
        `INSERT INTO lobbying_filings (filing_uuid, client_name, client_description, registrant_name, filing_year, filing_period, filing_type, posted_at,
           registrant_id, client_id, amount, amount_kind, industry, source_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(filing_uuid) DO UPDATE SET client_name = excluded.client_name, client_description = excluded.client_description,
           registrant_name = excluded.registrant_name, amount = excluded.amount, amount_kind = excluded.amount_kind,
           industry = excluded.industry, source_url = excluded.source_url, updated_at = excluded.updated_at`
      )
      .bind(f.filing_uuid, f.client_name, f.client_description, f.registrant_name, f.filing_year, f.filing_period, f.filing_type, f.posted_at,
        f.registrant_id, f.client_id, f.amount, f.amount_kind, f.industry, f.source_url),
  ];
  const first = mentions[0];
  stmts.push(
    db
      .prepare("INSERT OR REPLACE INTO bill_lobbying (bill_id, filing_uuid, issue_code, excerpt) VALUES (?, ?, ?, ?)")
      .bind(bill.id, f.filing_uuid, first.issue_code, first.excerpt)
  );
  await db.batch(stmts);
  return true;
}

export async function syncFederalLobbying(env, db, budget) {
  const o = ldaOptions(env);
  const thisYear = new Date().getUTCFullYear();
  let pages = 0;
  let matched = 0;
  let finished = 0;
  const summary = () => `${pages} search page(s) read, ${matched} report(s) matched to bills, ${finished} bill(s) finished`;
  try {
    for (;;) {
      const bills = (
        await db
          .prepare(
            `SELECT b.*, p.cursor, p.done_at, p.searched, p.matched FROM bills b
             LEFT JOIN bill_lobbying_progress p ON p.bill_id = b.id
             WHERE ${LOBBYING_DUE}
             ORDER BY p.cursor IS NULL, ${LOBBYING_LATEST} DESC LIMIT 10`
          )
          .bind(`-${o.refreshDays} days`)
          .all()
      ).results;
      if (!bills.length) break;
      for (const bill of bills) {
        const searches = [];
        for (const year of congressYears(bill.session).filter((y) => y <= thisYear)) for (const q of billQueries(bill.bill_number)) searches.push({ q, year });
        // A finished bill that's due again starts over; its saved matches stay.
        let cur = bill.cursor && !bill.done_at ? JSON.parse(bill.cursor) : { i: 0, page: 1 };
        let searched = bill.done_at ? 0 : bill.searched || 0;
        let found = bill.done_at ? 0 : bill.matched || 0;
        if (!bill.cursor || bill.done_at) {
          await db
            .prepare(
              `INSERT INTO bill_lobbying_progress (bill_id, cursor, searched, matched, done_at, started_at) VALUES (?, ?, 0, 0, NULL, datetime('now'))
               ON CONFLICT(bill_id) DO UPDATE SET cursor = excluded.cursor, searched = 0, matched = 0, done_at = NULL, started_at = excluded.started_at`
            )
            .bind(bill.id, JSON.stringify(cur))
            .run();
        }
        while (cur.i < searches.length) {
          const { q, year } = searches[cur.i];
          const url = `${o.base}/filings/?filing_specific_lobbying_issues=${encodeURIComponent(`"${q}"`)}&filing_year=${year}&page_size=25&page=${cur.page}`;
          const res = await budget.paced(db, "lda", o.pace, url, { headers: o.headers }, `lobbying ${bill.id} "${q}" ${year} page ${cur.page}`);
          const d = await res.json();
          pages += 1;
          for (const filing of d.results || []) {
            searched += 1;
            const mentions = mentionsIn(filing, bill, bill.session);
            if (mentions.length && (await saveMatches(db, bill, filing, mentions))) {
              found += 1;
              matched += 1;
            }
          }
          cur = d.next ? { i: cur.i, page: cur.page + 1 } : { i: cur.i + 1, page: 1 };
          await db.prepare("UPDATE bill_lobbying_progress SET cursor = ?, searched = ?, matched = ? WHERE bill_id = ?").bind(JSON.stringify(cur), searched, found, bill.id).run();
        }
        await db.prepare("UPDATE bill_lobbying_progress SET done_at = datetime('now') WHERE bill_id = ?").bind(bill.id).run();
        finished += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary()}; ${err.message}` };
  }
  if (!pages) return { status: "skipped", message: "every bill's lobbying reports are up to date (bills with a final-passage vote or committee action)" };
  return { status: "ok", message: summary() };
}

// ---------------------------------------------------------------------------
// Committee action (Congress.gov)

// Bills a full committee acted on, from each committee's bill list: only
// relationships that are the committee acting (committeeActed), only the
// current Congress. Each committee's list is read in full the first time, then
// only what changed since the last read. A bill not loaded yet is added with
// its title from Congress.gov, up to COMMITTEE_BILLS_DAILY (150) a day.
export async function syncCommitteeBills(env, db, budget) {
  if (!env.CONGRESS_API_KEY) return { status: "skipped", message: "CONGRESS_API_KEY is not set" };
  const congress = currentCongress();
  const newBillCap = parseInt(env.COMMITTEE_BILLS_DAILY || "150", 10);
  const dayKey = `committee_new_bills_${new Date().toISOString().slice(0, 10)}`;
  let added = parseInt((await getState(db, dayKey)) || "0", 10);
  let read = 0;
  let actions = 0;
  let waiting = 0;
  const summary = () => `${read} committee list page(s) read, ${actions} committee action(s) saved, ${added} bill(s) added today${waiting ? `, ${waiting} bill(s) waiting for tomorrow's cap` : ""}`;
  try {
    let committees = JSON.parse((await getState(db, `committees_${congress}`)) || "null");
    if (!committees || committees.read < new Date(Date.now() - 30 * DAY).toISOString()) {
      const list = [];
      for (const chamber of ["house", "senate"]) {
        let offset = 0;
        for (;;) {
          const d = await budget.json(congressApi(env, `/committee/${congress}/${chamber}`, { limit: 250, offset }), {}, `committees ${chamber}`);
          for (const c of d.committees || []) if (!c.parent && c.systemCode) list.push({ code: c.systemCode, chamber, name: c.name || null });
          if ((d.committees || []).length < 250) break;
          offset += 250;
        }
      }
      committees = { read: new Date().toISOString(), list };
      await setState(db, `committees_${congress}`, JSON.stringify(committees));
    }
    for (const c of committees.list) {
      const key = `committee_bills_${congress}_${c.code}`;
      const saved = JSON.parse((await getState(db, key)) || "{}");
      if (saved.done && saved.done > new Date(Date.now() - DAY / 2).toISOString()) continue;
      const started = saved.started || new Date().toISOString().replace(/\.\d+Z$/, "Z");
      let offset = saved.offset || 0;
      const since = saved.since || `${2 * congress + 1787}-01-03T00:00:00Z`;
      for (;;) {
        const d = await budget.json(congressApi(env, `/committee/${c.chamber}/${c.code}/bills`, { limit: 250, offset, fromDateTime: since }), {}, `${c.code} bills offset ${offset}`);
        read += 1;
        const bills = (d["committee-bills"] && d["committee-bills"].bills) || [];
        for (const b of bills) {
          if (Number(b.congress) !== congress || !committeeActed(b.relationshipType)) continue;
          const row = federalBill(congress, b.type, b.number);
          if (!row) continue;
          const have = await db.prepare("SELECT 1 AS x FROM bills WHERE id = ?").bind(row.id).first();
          if (!have) {
            if (added >= newBillCap) {
              waiting += 1;
              continue;
            }
            const detail = await budget.json(congressApi(env, `/bill/${congress}/${row.id.split("-")[2]}/${b.number}`), {}, `bill ${row.id}`);
            const title = detail.bill && (detail.bill.title || "").trim();
            if (!title) continue;
            await upsertBill(db, { ...row, title });
            added += 1;
            await setState(db, dayKey, String(added));
          }
          await db
            .prepare(
              `INSERT INTO bill_committee_actions (bill_id, committee_code, committee_name, relationship, action_date, source_url) VALUES (?, ?, ?, ?, ?, ?)
               ON CONFLICT(bill_id, committee_code, relationship) DO UPDATE SET committee_name = excluded.committee_name, action_date = excluded.action_date`
            )
            .bind(row.id, c.code, c.name, b.relationshipType, b.actionDate ? String(b.actionDate).slice(0, 10) : null, `${row.official_url}/committees`)
            .run();
          actions += 1;
        }
        offset += bills.length;
        await setState(db, key, JSON.stringify({ ...saved, since, offset, started }));
        if (bills.length < 250) break;
      }
      // Bills held back by the cap are picked up on a later full pass: keep the old
      // "since" until nothing waits.
      await setState(db, key, JSON.stringify({ since: waiting ? since : started, offset: 0, done: new Date().toISOString() }));
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary()}; ${err.message}` };
  }
  if (!read) return { status: "skipped", message: "every committee's bill list was read in the last 12 hours" };
  return { status: "ok", message: summary() };
}

// ---------------------------------------------------------------------------
// LD-203 contributions (lda.gov)

// Members of Congress, each searched by last name for each year of the current
// Congress (so far); each report found is checked item by item against every
// member (matchHonoree), so one search can fill in other members too. A year
// already read is read again after LOBBY_CONTRIB_REFRESH_DAYS (45): LD-203s are
// filed in July and January.
export async function syncLobbyContributions(env, db, budget) {
  const o = ldaOptions(env);
  const pace = { intervalMs: o.pace.intervalMs, dailyLimit: parseInt(env.LDA_CONTRIB_DAILY || "400", 10) };
  const refresh = `-${parseInt(env.LOBBY_CONTRIB_REFRESH_DAYS || "45", 10)} days`;
  const thisYear = new Date().getUTCFullYear();
  const years = congressYears(currentCongress()).filter((y) => y <= thisYear);
  const { results: members } = await db.prepare("SELECT id, name, last_name FROM officials WHERE chamber IN ('us-house', 'us-senate') AND active = 1").all();
  if (!members.length) return { status: "skipped", message: "no members of Congress loaded" };
  const index = memberIndex(members);
  let pages = 0;
  let saved = 0;
  let finished = 0;
  const summary = () => `${pages} page(s) read, ${saved} contribution(s) matched to members, ${finished} member-year(s) finished`;
  try {
    for (;;) {
      const due = (
        await db
          .prepare(
            `SELECT o.id, o.name, o.last_name, y.year, p.page, p.searched, p.matched, p.done_at FROM officials o
             JOIN (${years.map(() => "SELECT ? AS year").join(" UNION ALL ")}) y
             LEFT JOIN lobby_contrib_progress p ON p.official_id = o.id AND p.year = y.year
             WHERE o.chamber IN ('us-house', 'us-senate') AND o.active = 1
               AND (p.official_id IS NULL OR p.done_at IS NULL OR p.done_at < datetime('now', ?))
             ORDER BY p.done_at IS NOT NULL, p.official_id IS NULL, y.year DESC, p.done_at, o.id LIMIT 20`
          )
          .bind(...years, refresh)
          .all()
      ).results;
      if (!due.length) break;
      for (const m of due) {
        const q = honoreeQuery(m);
        let page = m.done_at || !m.page ? 1 : m.page;
        let searched = m.done_at ? 0 : m.searched || 0;
        let matched = m.done_at ? 0 : m.matched || 0;
        await db
          .prepare(
            `INSERT INTO lobby_contrib_progress (official_id, year, page, searched, matched, done_at, started_at) VALUES (?, ?, ?, ?, ?, NULL, datetime('now'))
             ON CONFLICT(official_id, year) DO UPDATE SET page = excluded.page, searched = excluded.searched, matched = excluded.matched, done_at = NULL`
          )
          .bind(m.id, m.year, page, searched, matched)
          .run();
        for (;;) {
          const url = `${o.base}/contributions/?contribution_honoree=${encodeURIComponent(q)}&filing_year=${m.year}&page_size=25&page=${page}`;
          const res = await budget.paced(db, "lda_contrib", pace, url, { headers: o.headers }, `LD-203 "${q}" ${m.year} page ${page}`);
          const d = await res.json();
          pages += 1;
          const stmts = [];
          for (const f of d.results || []) {
            searched += 1;
            const items = contributionItems(f, index);
            const row = contribFilingRow(f);
            if (!items.length || !row.filing_uuid || !row.registrant_name || !isHttp(row.source_url)) continue;
            stmts.push(
              db
                .prepare(
                  `INSERT INTO lobby_contrib_filings (filing_uuid, filer_type, registrant_id, registrant_name, lobbyist_id, filing_year, filing_period, filing_type, posted_at, source_url, updated_at)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
                   ON CONFLICT(filing_uuid) DO UPDATE SET registrant_name = excluded.registrant_name, posted_at = excluded.posted_at, source_url = excluded.source_url, updated_at = excluded.updated_at`
                )
                .bind(row.filing_uuid, row.filer_type, row.registrant_id, row.registrant_name, row.lobbyist_id, row.filing_year, row.filing_period, row.filing_type, row.posted_at, row.source_url)
            );
            for (const it of items) {
              stmts.push(
                db
                  .prepare(
                    `INSERT OR REPLACE INTO lobby_contributions (filing_uuid, n, official_id, contribution_type, contributor_name, payee_name, honoree_name, amount, date)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
                  )
                  .bind(row.filing_uuid, it.n, it.official_id, it.contribution_type, it.contributor_name, it.payee_name, it.honoree_name, it.amount, it.date)
              );
              if (it.official_id === m.id) matched += 1;
              saved += 1;
            }
          }
          await inBatches(db, stmts);
          page = d.next ? page + 1 : 0;
          await db.prepare("UPDATE lobby_contrib_progress SET page = ?, searched = ?, matched = ? WHERE official_id = ? AND year = ?").bind(page || 1, searched, matched, m.id, m.year).run();
          if (!page) break;
        }
        await db.prepare("UPDATE lobby_contrib_progress SET done_at = datetime('now') WHERE official_id = ? AND year = ?").bind(m.id, m.year).run();
        finished += 1;
      }
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary()}; ${err.message}` };
  }
  if (!pages) return { status: "skipped", message: "every member's LD-203 contributions are up to date" };
  return { status: "ok", message: summary() };
}
