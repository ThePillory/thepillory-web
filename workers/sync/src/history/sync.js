// The Time Machine's sync steps: officeholders, votes, executive orders, Senate
// confirmations and campaign money for past years, loaded a little at a time
// (newest first) so the daily sync stays within its limits. See docs/history.md.
//
//   history-officials  past Presidents and Vice Presidents (since 1993) and past
//                      members of Congress for live states (California), as
//                      inactive officials, so their votes and orders can be shown.
//                      From data/history/ (tools/build_history.py, Biographical Directory).
//   history-orders     executive orders since 1994, Federal Register, by term.
//   history-funding    FEC totals by two-year period for every federal official
//                      with an FEC ID (one request per candidate gives every period).
//   history-nominations  civilian nominations of past Congresses (Congress.gov),
//                      for the Cabinet's Senate confirmation records.
//   history-votes      House roll calls (Clerk's XML) and Senate roll calls (senate.gov
//                      XML) from 2001, newest first; every loaded official's position.
//
// HISTORY_DAILY_REQUESTS (default 600) caps all of them together per day.
import { saveVote, upsertBill } from "../db.js";
import { classifyFederal, normalizePosition } from "../classify.js";
import { federalBill, normalizeBillType } from "../congress.js";
import { senateTotals, tally } from "../rollcall.js";
import { getState, setState, slugify, today, currentCongress, isHttp, xmlTag, xmlBlocks, parseLongDate, BudgetExhausted, UpstreamError } from "../util.js";
import { frOrder } from "../executive/parse.js";
import { saveAction, loadNominations, presidentLookup } from "../executive/sync.js";
import { parseHouseRoll, houseLegis, congressOfYear, fecCycles } from "./parse.js";

const FIRST_VOTE_YEAR = 2001;
const FIRST_ORDER_YEAR = 1994;
const FIRST_CONGRESS = 107; // 2001–2002
const LIVE_STATES = ["CA"];
const CLERK = "https://clerk.house.gov/evs";
const SENATE = "https://www.senate.gov/legislative/LIS";
const FR_API = "https://www.federalregister.gov/api/v1";
const FEC = "https://api.open.fec.gov/v1";
const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/** A shared daily cap for the history steps, on top of each round's request budget. */
async function historyCap(env, db) {
  const limit = parseInt(env.HISTORY_DAILY_REQUESTS || "600", 10);
  const key = `history_requests_${today()}`;
  let used = parseInt((await getState(db, key)) || "0", 10);
  return {
    left: () => limit - used,
    async take(label) {
      if (used >= limit) throw new BudgetExhausted(`history daily limit (${limit}) reached before ${label}`);
      used += 1;
      await setState(db, key, String(used));
    },
  };
}

async function siteJson(env, budget, path) {
  const base = (env.SITE_URL || "").replace(/\/$/, "");
  return budget.json(`${base}${path}`, {}, path);
}

// ---------------------------------------------------------------------------
// Past officeholders

async function insertPast(db, o) {
  const taken = await db.prepare("SELECT id FROM officials WHERE slug = ?").bind(o.slug).first();
  const slug = taken && taken.id !== o.id ? `${o.slug}-${o.disambig}` : o.slug;
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party, term_start, term_end,
         source_url, last_verified, bioguide_id, state, district_code, rank, active, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, datetime('now'))`
    )
    .bind(o.id, slug, o.name, o.last_name, o.office, o.level, o.chamber, o.chamber, o.district || null, o.party || null, o.term_start, o.term_end,
      o.source_url, today(), o.bioguide || null, o.state || null, o.district_code || null, o.rank || null)
    .run();
  if (o.lis) await db.prepare("UPDATE officials SET lis_id = ? WHERE id = ? AND lis_id IS NULL").bind(o.lis, o.id).run();
  return r.meta && r.meta.changes ? 1 : 0;
}

export async function syncHistoryOfficials(env, db, budget) {
  let added = 0;
  try {
    const exec = await siteJson(env, budget, "/data/history/federal-executive.json");
    const people = new Map();
    for (const t of exec.terms || []) {
      if (t.end < "1993-01-20" || !t.govtrack) continue;
      people.set(t.govtrack, t); // later terms replace earlier: the office is the most recent one
    }
    for (const t of people.values()) {
      added += await insertPast(db, {
        id: `exec:govtrack:${t.govtrack}`, slug: slugify(t.name), disambig: String(t.govtrack), name: t.name,
        last_name: t.name.replace(/,? (Jr|Sr|II|III)\.?$/, "").split(/\s+/).pop(), office: t.office, level: "federal", chamber: "us-executive",
        party: t.party, term_start: t.start, term_end: t.end, source_url: exec.source, bioguide: t.bioguide, rank: t.office === "President" ? 1 : 2,
      });
    }
    for (const st of LIVE_STATES) {
      const d = await siteJson(env, budget, `/data/history/congress/${st.toLowerCase()}.json`);
      const terms = [];
      for (const r of d.senate || []) terms.push({ ...r, chamber: "us-senate", district: null });
      for (const [dist, rows] of Object.entries(d.house || {})) for (const r of rows) terms.push({ ...r, chamber: "us-house", district: dist });
      const byPerson = new Map();
      for (const t of terms) {
        if (t.end < `${FIRST_VOTE_YEAR}-01-01` || !t.bioguide) continue;
        const list = byPerson.get(t.bioguide) || [];
        list.push(t);
        byPerson.set(t.bioguide, list);
      }
      for (const [bg, ts] of byPerson) {
        ts.sort((a, b) => a.start.localeCompare(b.start));
        const last = ts[ts.length - 1];
        const house = last.chamber === "us-house";
        added += await insertPast(db, {
          id: `bioguide:${bg}`, slug: slugify(last.name), disambig: bg.toLowerCase(), name: last.name,
          last_name: last.name.replace(/,? (Jr|Sr|II|III)\.?$/, "").split(/\s+/).pop(), office: house ? "U.S. Representative" : "U.S. Senator",
          level: "federal", chamber: last.chamber, district: house ? `${st}-${last.district}` : st, district_code: house ? last.district : null,
          party: last.party, term_start: ts[0].start.slice(0, 4), term_end: last.end.slice(0, 4), state: st,
          source_url: `https://bioguide.congress.gov/search/bio/${bg}`, bioguide: bg, lis: last.lis,
        });
      }
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${added} past officeholder(s) added. ${err.message}` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `${added} past officeholder(s) added (Presidents and Vice Presidents since 1993; ${LIVE_STATES.join(", ")} members of Congress since ${FIRST_VOTE_YEAR})` };
}

// ---------------------------------------------------------------------------
// Executive orders since 1994, by presidential term

export async function syncHistoryOrders(env, db, budget) {
  const cap = await historyCap(env, db);
  let saved = 0;
  try {
    const exec = await siteJson(env, budget, "/data/history/federal-executive.json");
    const terms = (exec.terms || []).filter((t) => t.office === "President" && t.end > `${FIRST_ORDER_YEAR}-01-01`);
    const current = await db.prepare("SELECT term_start FROM officials WHERE chamber = 'us-executive' AND rank = 1 AND active = 1").first();
    for (const t of terms.sort((a, b) => b.start.localeCompare(a.start))) {
      if (current && t.start === current.term_start) continue; // the current term is the executive-orders step's
      const done = `history_orders_${t.start}`;
      if ((await getState(db, done)) === "1") continue;
      const official = `exec:govtrack:${t.govtrack}`;
      if (!(await db.prepare("SELECT 1 AS x FROM officials WHERE id = ?").bind(official).first())) continue;
      const from = t.start < `${FIRST_ORDER_YEAR}-01-01` ? `${FIRST_ORDER_YEAR}-01-01` : t.start;
      const fields = ["executive_order_number", "title", "signing_date", "publication_date", "document_number", "html_url", "pdf_url", "citation", "executive_order_notes"].map((f) => `fields[]=${f}`).join("&");
      let url = `${(env.FR_API_BASE || FR_API).replace(/\/$/, "")}/documents.json?per_page=1000&order=oldest&conditions[type][]=PRESDOCU&conditions[presidential_document_type][]=executive_order&conditions[signing_date][gte]=${from}&conditions[signing_date][lte]=${t.end}&${fields}`;
      while (url) {
        await cap.take("Federal Register");
        const d = await budget.json(url, {}, `Federal Register executive orders ${t.start}`);
        for (const doc of d.results || []) {
          if (!doc.document_number || !isHttp(doc.html_url)) continue;
          // Signed within this President's term (the day a term ends at noon belongs to the next one).
          if (doc.signing_date && (doc.signing_date < t.start || doc.signing_date >= t.end)) continue;
          await saveAction(db, official, frOrder(doc));
          saved += 1;
        }
        url = d.next_page_url || null;
      }
      await setState(db, done, "1");
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${saved} past executive order(s) saved. ${err.message}` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `${saved} past executive order(s) saved; caught up to ${FIRST_ORDER_YEAR}` };
}

// ---------------------------------------------------------------------------
// FEC totals by two-year period

export async function syncHistoryFunding(env, db, budget) {
  if (!env.FEC_API_KEY) return { status: "skipped", message: "FEC_API_KEY is not set" };
  const cap = await historyCap(env, db);
  let checked = 0;
  let rows = 0;
  try {
    // FEC candidate IDs: members of Congress (fec_candidates, from the funding step), and
    // past officeholders' from data/history/ (Presidents' "P" IDs, California's delegation).
    const ids = new Map();
    for (const r of (await db.prepare("SELECT official_id, candidate_id FROM fec_candidates WHERE candidate_id IS NOT NULL").all()).results) ids.set(r.candidate_id, r.official_id);
    const exec = await siteJson(env, budget, "/data/history/federal-executive.json");
    for (const t of exec.terms || []) for (const f of t.fec || []) if (t.govtrack) ids.set(f, `exec:govtrack:${t.govtrack}`);
    for (const st of LIVE_STATES) {
      const d = await siteJson(env, budget, `/data/history/congress/${st.toLowerCase()}.json`);
      const all = [...(d.senate || []), ...Object.values(d.house || {}).flat()];
      for (const t of all) if (t.bioguide && t.end >= `${FIRST_VOTE_YEAR}-01-01`) for (const f of t.fec || []) ids.set(f, `bioguide:${t.bioguide}`);
    }
    const known = new Set((await db.prepare("SELECT id FROM officials").all()).results.map((r) => r.id));
    const seen = new Set((await db.prepare("SELECT key FROM history_checks WHERE key LIKE 'fec:%' AND checked_at > datetime('now', '-180 days')").all()).results.map((r) => r.key.slice(4)));
    for (const [fec, official] of ids) {
      if (seen.has(fec) || !known.has(official)) continue;
      await cap.take("FEC totals");
      const url = `${FEC}/candidate/${fec}/totals/?election_full=false&per_page=100&sort=-cycle&api_key=${encodeURIComponent(env.FEC_API_KEY)}`;
      const list = fecCycles(await budget.json(url, {}, `FEC totals ${fec}`));
      const source = `https://www.fec.gov/data/candidate/${fec}/`;
      const stmts = list.map((c) =>
        db
          .prepare(
            `INSERT INTO funding_cycles (official_id, fec_id, cycle, receipts, disbursements, cash_on_hand, coverage_end, source_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (fec_id, cycle) DO UPDATE SET official_id = excluded.official_id, receipts = excluded.receipts, disbursements = excluded.disbursements,
               cash_on_hand = excluded.cash_on_hand, coverage_end = excluded.coverage_end`
          )
          .bind(official, fec, c.cycle, c.receipts, c.disbursements, c.cash_on_hand, c.coverage_end, source)
      );
      stmts.push(db.prepare("INSERT INTO history_checks (key, note) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET checked_at = datetime('now'), note = excluded.note").bind(`fec:${fec}`, `${list.length} period(s)`));
      await db.batch(stmts);
      checked += 1;
      rows += list.length;
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${checked} FEC candidate(s) read (${rows} two-year periods). ${err.message}` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `${checked} FEC candidate(s) read (${rows} two-year periods); caught up` };
}

// ---------------------------------------------------------------------------
// Civilian nominations of past Congresses (the Cabinet's confirmation records)

export async function syncHistoryNominations(env, db, budget) {
  if (!env.CONGRESS_API_KEY) return { status: "skipped", message: "CONGRESS_API_KEY is not set" };
  const cap = await historyCap(env, db);
  let saved = 0;
  try {
    const presidentOn = await presidentLookup(db);
    for (let congress = currentCongress() - 1; congress >= FIRST_CONGRESS; congress--) {
      if ((await getState(db, `history_nominations_${congress}`)) === "1") continue;
      const r = await loadNominations(env, db, budget, congress, presidentOn, () => cap.take("nominations"));
      saved += r.saved;
      if (!r.done) break;
      await setState(db, `history_nominations_${congress}`, "1");
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${saved} past nomination(s) saved. ${err.message}` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `${saved} past nomination(s) saved; caught up to the ${FIRST_CONGRESS}th Congress` };
}

// ---------------------------------------------------------------------------
// House and Senate roll calls since 2001

async function memberIndex(db) {
  const { results } = await db.prepare("SELECT id, name, last_name, state, chamber, bioguide_id, lis_id FROM officials WHERE level = 'federal' AND chamber IN ('us-house', 'us-senate')").all();
  return {
    bioguide: new Map(results.filter((o) => o.bioguide_id).map((o) => [o.bioguide_id, o])),
    lis: new Map(results.filter((o) => o.lis_id).map((o) => [o.lis_id, o])),
    senators: results.filter((o) => o.chamber === "us-senate"),
  };
}

async function saveHouseRoll(db, v, year, members) {
  const legis = houseLegis(v.legis);
  let bill = legis ? federalBill(v.congress, legis.type, legis.number, v.desc || null) : null;
  if (bill) {
    const have = await db.prepare("SELECT title FROM bills WHERE id = ?").bind(bill.id).first();
    if (have) bill = { ...bill, title: have.title };
    else await upsertBill(db, bill);
  }
  const positions = [];
  for (const m of v.members) {
    const o = members.bioguide.get(m.bioguide);
    if (o) positions.push({ official_id: o.id, position: normalizePosition(m.vote), raw_position: m.vote });
  }
  await saveVote(
    db,
    {
      id: `us-house-${v.congress}-${v.session}-${v.roll}`,
      bill_id: bill ? bill.id : null,
      subject: bill ? null : [v.legis, v.desc].filter(Boolean).join(": ") || null,
      level: "federal",
      chamber: "us-house",
      vote_date: v.date || `${year}-01-01`,
      question: v.question || "(question not given by source)",
      vote_type: classifyFederal(v.question, { billTitle: bill ? bill.title : v.desc, isAmendment: v.amendment }),
      result: v.result || "Unknown",
      source_url: `https://clerk.house.gov/Votes/${year}${v.roll}`,
      totals: v.totals && v.totals.yea != null ? v.totals : tally(v.members.map((m) => m.vote)),
    },
    positions
  );
}

async function saveSenateVote(db, xml, congress, session, n, members) {
  const docType = normalizeBillType(xmlTag(xml, "document_type"));
  const docNumber = xmlTag(xml, "document_number");
  const docTitle = xmlTag(xml, "document_title") || xmlTag(xml, "vote_title");
  const question = xmlTag(xml, "question") || xmlTag(xml, "vote_question_text");
  const isNomination = docType === "PN" || /nomination/i.test(question);
  const isAmendment = !!xmlTag(xml, "amendment_number") && /amendment/i.test(question);
  const docCongress = parseInt(xmlTag(xml, "document_congress"), 10) || congress;
  let bill = isNomination ? null : federalBill(docCongress, docType, docNumber, docTitle);
  if (bill) {
    const have = await db.prepare("SELECT title FROM bills WHERE id = ?").bind(bill.id).first();
    if (!have) await upsertBill(db, bill);
  }
  const positions = [];
  const casts = [];
  for (const b of xmlBlocks(xml, "member")) {
    const cast = xmlTag(b, "vote_cast");
    casts.push(cast);
    const lis = xmlTag(b, "lis_member_id");
    let o = lis ? members.lis.get(lis) : null;
    if (!o) {
      const last = xmlTag(b, "last_name").toLowerCase();
      const st = xmlTag(b, "state");
      const c = members.senators.filter((x) => x.state === st && String(x.last_name || "").toLowerCase() === last);
      if (c.length === 1) o = c[0];
    }
    if (o && cast) positions.push({ official_id: o.id, position: normalizePosition(cast), raw_position: cast });
  }
  const page = `https://www.senate.gov/legislative/LIS/roll_call_votes/vote${congress}${session}/vote_${congress}_${session}_${String(n).padStart(5, "0")}.htm`;
  await saveVote(
    db,
    {
      id: `us-senate-${congress}-${session}-${n}`,
      bill_id: bill ? bill.id : null,
      subject: bill ? null : xmlTag(xml, "vote_document_text") || docTitle || null,
      level: "federal",
      chamber: "us-senate",
      vote_date: parseLongDate(xmlTag(xml, "vote_date")) || "",
      question: question || "(question not given by source)",
      vote_type: classifyFederal(question, { billTitle: docTitle, isNomination, isAmendment }),
      result: xmlTag(xml, "vote_result") || xmlTag(xml, "vote_result_text") || "Unknown",
      source_url: page,
      totals: senateTotals(xml, casts),
    },
    positions
  );
}

export async function syncHistoryVotes(env, db, budget) {
  const cap = await historyCap(env, db);
  const members = await memberIndex(db);
  const firstCurrent = 1789 + (currentCongress() - 1) * 2; // the current Congress's first year: its votes are the regular steps'
  let house = 0;
  let senate = 0;
  const msg = () => `${house} past House and ${senate} past Senate roll call(s) saved`;
  try {
    // House: one file per roll call; a 404 is the end of the year.
    let pos = JSON.parse((await getState(db, "history_house")) || "null") || { year: firstCurrent - 1, roll: 1 };
    while (pos.year >= FIRST_VOTE_YEAR && cap.left() > 0) {
      const { congress, session } = congressOfYear(pos.year);
      const id = `us-house-${congress}-${session}-${pos.roll}`;
      if (!(await db.prepare("SELECT 1 AS x FROM votes WHERE id = ? AND yea IS NOT NULL").bind(id).first())) {
        await cap.take("House roll call");
        let xml;
        try {
          xml = await budget.text(`${env.CLERK_BASE || CLERK}/${pos.year}/roll${String(pos.roll).padStart(3, "0")}.xml`, {}, `House ${pos.year} roll ${pos.roll}`);
        } catch (err) {
          if (err instanceof UpstreamError && err.status === 404) {
            pos = { year: pos.year - 1, roll: 1 };
            await setState(db, "history_house", JSON.stringify(pos));
            continue;
          }
          throw err;
        }
        const v = parseHouseRoll(xml);
        if (v && v.roll) {
          await saveHouseRoll(db, v, pos.year, members);
          house += 1;
        }
      }
      pos = { year: pos.year, roll: pos.roll + 1 };
      await setState(db, "history_house", JSON.stringify(pos));
    }
    // Senate: each session's vote list, then one file per vote.
    let s = JSON.parse((await getState(db, "history_senate")) || "null") || { congress: currentCongress() - 1, session: 2, list: null, i: 0 };
    while (s.congress >= FIRST_CONGRESS && cap.left() > 0) {
      if (!s.list) {
        await cap.take("Senate vote list");
        const menu = await budget.text(`${env.SENATE_BASE || SENATE}/roll_call_lists/vote_menu_${s.congress}_${s.session}.xml`, {}, `Senate list ${s.congress}-${s.session}`);
        s.list = xmlBlocks(menu, "vote").map((b) => parseInt(xmlTag(b, "vote_number"), 10)).filter(Boolean).sort((a, b) => b - a);
        s.i = 0;
        await setState(db, "history_senate", JSON.stringify(s));
      }
      if (s.i >= s.list.length) {
        s = s.session === 2 ? { congress: s.congress, session: 1, list: null, i: 0 } : { congress: s.congress - 1, session: 2, list: null, i: 0 };
        await setState(db, "history_senate", JSON.stringify(s));
        continue;
      }
      const n = s.list[s.i];
      if (!(await db.prepare("SELECT 1 AS x FROM votes WHERE id = ? AND yea IS NOT NULL").bind(`us-senate-${s.congress}-${s.session}-${n}`).first())) {
        await cap.take("Senate roll call");
        const xml = await budget.text(`${env.SENATE_BASE || SENATE}/roll_call_votes/vote${s.congress}${s.session}/vote_${s.congress}_${s.session}_${String(n).padStart(5, "0")}.xml`, {}, `Senate ${s.congress}-${s.session} vote ${n}`);
        await saveSenateVote(db, xml, s.congress, s.session, n, members);
        senate += 1;
      }
      s.i += 1;
      await setState(db, "history_senate", JSON.stringify(s));
    }
    const done = pos.year < FIRST_VOTE_YEAR && s.congress < FIRST_CONGRESS;
    if (!done) return { status: "partial", message: `${msg()}; House at ${pos.year} roll ${pos.roll}, Senate at the ${s.congress}th Congress, session ${s.session}. History daily limit reached; continues tomorrow.` };
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${msg()}. ${err.message}` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `${msg()}; caught up to ${FIRST_VOTE_YEAR}` };
}
