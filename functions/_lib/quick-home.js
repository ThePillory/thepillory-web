// Quick mode on the home page and every state page (functions/_lib/home.js; the
// Quick / Detailed switch is in docs/quick-mode.md). In Quick: the headline, then
//   This week in [State]  3–5 plain sentences about the latest recorded facts,
//                         each linked to its page
//   Who represents you    the President, the state's two U.S. Senators, the
//                         Governor, and the House member once districts are known,
//                         each with its job in plain words
// then the ballot card (in its window), Find your representatives, and three links.
// Everything else stays in Detailed. Facts only: every sentence is built from a
// recorded vote, final action, decision, order or election date, picked by one
// fixed rule (up to two final actions first, then the most recent), never by topic or side.
import { esc, fmtDate } from "./render.js";
import { billHref } from "./votes.js";
import { orderHref } from "./orders.js";
import { officialsWhere } from "./data.js";
import { repsWhere } from "./districts.js";
import { loadIndex, loadTerm, caseHref } from "./scotus.js";
import { plainChamber } from "./simple.js";

export const THIS_WEEK_DAYS = 30; // how far back "this week" looks when the past week is quiet
export const THIS_WEEK_MAX = 5;
export const FINAL_FIRST = 2; // laws signed or vetoed lead, but never fill the list
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const soft = async (fn, fallback) => {
  try {
    return await fn();
  } catch (err) {
    if (missing(err)) return fallback;
    throw err;
  }
};

const passedWord = (result) => (/pass|agreed|adopted|concurred/i.test(result || "") && !/fail|reject|not /i.test(result || "") ? "passed" : /fail|reject/i.test(result || "") ? "rejected" : null);
const shortTitle = (t) => {
  const s = String(t || "").replace(/\s+/g, " ").trim();
  return s.length > 90 ? `${s.slice(0, 87).replace(/\s+\S*$/, "")}…` : s;
};

/** "Both of Texas's senators voted yes." / "A voted yes and B voted no." from a vote's positions. Pure. */
export function senatorsLine(positions, stateName) {
  const ps = (positions || []).filter((p) => p.position);
  if (!ps.length) return "";
  const word = (p) => (p.position === "Not voting" ? "didn't vote" : p.position === "Present" ? "voted present" : `voted ${p.position.toLowerCase()}`);
  if (ps.length === 2 && ps[0].position === ps[1].position) return ` Both of ${stateName}'s senators ${word(ps[0])}.`;
  return ` ${ps.map((p) => `${p.name} ${word(p)}`).join(" and ")}.`;
}

/**
 * The sentences, by one fixed rule: up to FINAL_FIRST laws signed or vetoed
 * first, then everything else newest first; at most THIS_WEEK_MAX, with the next election date last when
 * one is listed. Each is {date, href, text}. A bill's checked plain line
 * (plain_summaries) follows its number when there is one; otherwise its official
 * title, word for word. Pure.
 */
export function thisWeek({ stateName, votes = [], outcomes = [], decisions = [], orders = [], plain = {}, election = null, max = THIS_WEEK_MAX }) {
  const items = [];
  const named = (id, number, title) => (plain[id] ? `${number}. ${plain[id].trim().replace(/([^.!?])$/, "$1.")}` : `${number}${title ? `, “${shortTitle(title)}”` : ""}.`);
  for (const o of outcomes) {
    const who = o.level === "federal" ? "The President" : `${stateName}'s Governor`;
    const n = named(o.bill_id, o.bill_number, o.title);
    const text = o.outcome === "signed" ? `${who} signed ${n}`
      : o.outcome === "vetoed" || o.outcome === "pocket_vetoed" ? `${who} vetoed ${n}`
      : o.outcome === "over_veto" ? `Lawmakers overrode a veto, and this became law: ${n}`
      : o.outcome === "became_law" || o.outcome === "without_signature" ? `This became law: ${n}`
      : null;
    if (text) items.push({ rank: 0, date: o.action_date, href: billHref(o.bill_id), text });
  }
  for (const v of votes) {
    const did = passedWord(v.result);
    if (!did || !v.bill_id) continue;
    const where = plainChamber(v.chamber);
    const head = v.level === "state" ? `${stateName}'s ${where.replace(/^the /, "")}` : `${where[0].toUpperCase()}${where.slice(1)}`;
    items.push({ rank: 1, date: v.vote_date, href: `${billHref(v.bill_id)}#votes`, text: `${head} ${did} ${named(v.bill_id, v.bill_number, v.bill_title)}${v.level === "federal" ? senatorsLine(v.positions, stateName) : ""}` });
  }
  for (const c of decisions) items.push({ rank: 1, date: c.date, href: c.href, text: `The Supreme Court decided ${c.name}.` });
  for (const o of orders) items.push({ rank: 1, date: o.signed_on, href: orderHref(o.id), text: `${o.federal ? "The President" : `${stateName}'s Governor`} signed an executive order, “${shortTitle(o.title)}”.` });
  // One line per page (a bill's vote and its final action): the final action wins.
  const seen = new Set();
  const unique = items
    .sort((a, b) => a.rank - b.rank || String(b.date).localeCompare(String(a.date)))
    .filter((i) => {
      const k = i.href.replace(/#.*$/, "");
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  // Up to FINAL_FIRST final actions first, then everything else newest first.
  const first = unique.filter((i) => i.rank === 0).slice(0, FINAL_FIRST);
  const rest = unique.filter((i) => !first.includes(i)).sort((a, b) => String(b.date).localeCompare(String(a.date)));
  const picked = [...first, ...rest].slice(0, election ? max - 1 : max);
  if (election) picked.push({ date: election.date, href: election.href, text: election.text, upcoming: true });
  return picked;
}

/**
 * Everything Quick adds to the page: recent final actions, the state
 * legislature's latest final votes, Supreme Court decisions, executive orders,
 * the visitor's House member (when their districts are in this state), and the
 * checked plain lines for those bills. `senatorVotes`: the senators' latest
 * final-passage votes the page already loads (stateLeadData).
 */
export async function quickHomeData(env, request, { st, since, districts, senatorVotes = [] }) {
  const db = env.DB;
  const empty = { outcomes: [], stateVotes: [], decisions: [], orders: [], house: null, plain: {} };
  if (!db) return empty;
  const [outcomes, stateVotes, orders, house, decisions] = await Promise.all([
    soft(async () => (await db
      .prepare(
        `SELECT o.bill_id, o.outcome, o.action_date, b.bill_number, b.title, b.level FROM bill_outcomes o JOIN bills b ON b.id = o.bill_id
         WHERE o.action_date >= ? AND o.outcome != 'presented' AND (b.level = 'federal' OR (? != '' AND substr(b.id, 1, 3) = lower(?) || '-'))
         ORDER BY o.action_date DESC LIMIT 5`
      )
      .bind(since, st || "", st || "")
      .all()).results, []),
    st
      ? soft(async () => (await db
        .prepare(
          `SELECT v.id, v.bill_id, v.chamber, v.result, v.vote_date, v.level, b.bill_number, b.title AS bill_title
           FROM bill_list l JOIN votes v ON v.id = l.final_vote_id JOIN bills b ON b.id = l.bill_id
           WHERE l.level = 'state' AND COALESCE(l.st, 'CA') = ? AND l.last_final >= ? AND l.routine = 0
           ORDER BY l.last_final DESC LIMIT 3`
        )
        .bind(st, since)
        .all()).results, [])
      : [],
    soft(async () => (await db
      .prepare(
        `SELECT id, title, signed_on, id LIKE 'fr:%' AS federal FROM executive_actions
         WHERE kind = 'executive_order' AND signed_on >= ? AND (id LIKE 'fr:%' OR (? = 'CA' AND id LIKE 'ca-gov:%'))
         ORDER BY signed_on DESC LIMIT 3`
      )
      .bind(since, st || "")
      .all()).results, []),
    districts && districts.cd && districts.st === st
      ? soft(async () => (await officialsWhere(db, repsWhere(districts))).find((o) => o.chamber === "us-house") || null, null)
      : null,
    (async () => {
      const index = await loadIndex(env, request);
      const term = index && index.terms && index.terms.length ? await loadTerm(env, request, index.terms[0]) : null;
      return term
        ? (term.cases || []).filter((c) => c.date >= since && c.docket).slice(0, 2).map((c) => ({ name: c.name, date: c.date, href: caseHref(term.term, c.docket) }))
        : [];
    })().catch(() => []),
  ]);
  const ids = [...new Set([...outcomes, ...stateVotes, ...senatorVotes].map((r) => r.bill_id).filter(Boolean))];
  return { outcomes, stateVotes, orders, house, decisions, plain: await plainWhat(db, ids) };
}

/** Checked plain lines for these bills (plain_summaries), by bill id. */
export async function plainWhat(db, billIds) {
  if (!db || !billIds.length) return {};
  return soft(async () => {
    const { results } = await db
      .prepare(`SELECT item_id, what FROM plain_summaries WHERE kind = 'bill' AND item_id IN (${billIds.map(() => "?").join(",")})`)
      .bind(...billIds)
      .all();
    return Object.fromEntries(results.map((r) => [r.item_id, r.what]));
  }, {});
}

const JOB = {
  president: "Leads the federal government",
  senator: "Writes federal laws for the whole state",
  house: "Writes federal laws for your district",
  governor: "Runs the state government",
};

/** The Quick home sections (shown only in Quick mode). */
export function quickHome({ st, stateName, items, president, senators, governor, house, districtsKnown }) {
  const row = (o, job) => (o
    ? `<a class="list-row link-row" href="/reps/${esc(o.slug)}/"><div><div class="list-title">${esc(o.name)}</div><div class="list-meta">${esc(job)}</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>`
    : "");
  const place = stateName || "the country";
  const week = items.length
    ? `<ul class="simple-list quick-week">${items.map((i) => `<li><a class="quick-item" href="${esc(i.href)}">${esc(i.text)}</a>${i.upcoming ? "" : ` <span class="secondary xsmall">${esc(fmtDate(i.date))}</span>`}</li>`).join("")}</ul>`
    : `<p class="small secondary">No new votes, laws or decisions recorded in the last ${THIS_WEEK_DAYS} days.</p>`;
  const who = [
    row(president, JOB.president),
    ...senators.map((o) => row(o, JOB.senator)),
    row(governor, JOB.governor),
    house ? row(house, JOB.house) : "",
  ].join("");
  return `
<section class="card stack-sm simple-card simple-only quick-week-card" aria-labelledby="h-quick-week">
  <h2 class="label" id="h-quick-week">This week in ${esc(place)}</h2>
  ${week}
  <p class="hint">The latest recorded facts, by one rule for every state: up to two laws signed or vetoed first, then the newest votes, decisions and orders. Tap one for the details.</p>
</section>
<section class="card stack-xs simple-card simple-only" aria-labelledby="h-quick-who">
  <h2 class="label" id="h-quick-who">Who represents you</h2>
  ${who || '<p class="small secondary">Not loaded yet.</p>'}
  ${!districtsKnown && st ? '<p class="small"><a class="inline-link" href="#find">Find your representatives</a> to add your House member.</p>' : ""}
</section>`;
}

/** The three links at the bottom of the Quick home page. */
export function quickLinks() {
  return `
<nav class="card stack-sm simple-card simple-only quick-links" aria-label="More">
  <a class="list-row link-row" href="/explore/"><div><div class="list-title">Explore the map</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
  <a class="list-row link-row" href="/topics/"><div><div class="list-title">Topics</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
  <a class="list-row link-row" href="/about/how-a-bill-becomes-law/"><div><div class="list-title">How government works</div></div><span class="row-end"><span class="chev" aria-hidden="true">›</span></span></a>
</nav>`;
}

