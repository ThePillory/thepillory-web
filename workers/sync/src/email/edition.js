// Builds the weekly email's editions (docs/email.md). One template, the same order for
// everyone; a section with nothing new is left out, and an edition with nothing new at all
// isn't sent. Facts only, each line linking to its page on thepillory.co; no AI-written text.
//
// Every fact is read once per run for all the editions that share it: each state's officials
// once, then each kind of fact (final-passage votes, trade and disclosure filings, the
// Governor's final actions) in a few queries for every official any edition needs. Votes are
// read from the week's final-passage votes (the votes_date index) joined to those officials'
// own positions, never the full votes or positions tables.
//
// Pure apart from ctx.db (D1) and ctx.loadJson (the site's data files), so the Worker sends
// with it and /admin/email/ previews with it. Tested in workers/sync/test/email.test.mjs.
import { chamberIds } from "../states.js";
import { STATE_NAME } from "../../../../functions/_lib/districts.js";
import { ballotWindow, previewLabel } from "../../../../functions/_lib/election-window.js";
import { placeOf, zipCombos, zipFile, cdWords, legWords, editionKey } from "./places.js";
import { dayWords, weekWords, addDays } from "./schedule.js";

export const SITE = "https://thepillory.co";
export const MAX_LINES = 15; // item lines in the email; everything is on the web version
const LIVE = { "06009": { name: "Calaveras County", href: "/calaveras/" } }; // as functions/_lib/geo.js LIVE

const ph = (n) => Array.from({ length: n }, () => "?").join(",");
const chunks = (a, n = 90) => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));
const billHref = (id) => `/laws/bills/${encodeURIComponent(id)}/`;
const orderHref = (id) => `/laws/orders/${encodeURIComponent(String(id).replace(":", "-"))}/`;
const repHref = (o) => `/reps/${encodeURIComponent(o.slug)}/`;
const billName = (r) => [r.bill_number, r.bill_title].filter(Boolean).join(": ") || r.question || "A vote";
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

async function all(db, sql, binds = []) {
  try {
    return (await db.prepare(sql).bind(...binds).all()).results || [];
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Facts, read once per run

/** A run's shared reads: ctx = {db, loadJson(path), week: {week, start, end}, today}. */
export function newRun(ctx) {
  return { ...ctx, zipFiles: new Map(), states: new Map(), json: new Map() };
}

async function json(run, path) {
  if (!run.json.has(path)) run.json.set(path, Promise.resolve(run.loadJson(path)).catch(() => null));
  return run.json.get(path);
}

/** Every active official of one state's federal, state and executive seats (a few hundred rows). */
async function stateOfficials(run, st) {
  if (!run.states.has(st)) {
    const ids = chamberIds(st);
    const chambers = ["us-senate", "us-house", ids.upper, ids.lower, ids.executive].filter(Boolean);
    run.states.set(st, all(run.db, `SELECT * FROM officials WHERE active = 1 AND state = ? AND chamber IN (${ph(chambers.length)})`, [st, ...chambers]));
  }
  return run.states.get(st);
}

/** A place's officials: {senators, house, governor, upper, lower, county}. */
async function officialsOf(run, place) {
  const list = await stateOfficials(run, place.st);
  const ids = chamberIds(place.st);
  const byName = (a, b) => a.name.localeCompare(b.name);
  const byDistrict = (a, b) => String(a.district_code || "").localeCompare(String(b.district_code || ""), undefined, { numeric: true }) || byName(a, b);
  const house = list.filter((o) => o.chamber === "us-house");
  const atLarge = house.length === 1;
  const seats = (chamber, pairs) => list.filter((o) => o.chamber === chamber && pairs.some(([, key]) => key === o.district_code)).sort(byDistrict);
  let county = [];
  if (place.counties.length === 1 && LIVE[place.counties[0]]) county = await all(run.db, "SELECT * FROM officials WHERE active = 1 AND chamber = 'county-board' ORDER BY district_code, name");
  return {
    senators: list.filter((o) => o.chamber === "us-senate").sort(byName),
    house: (atLarge ? house : house.filter((o) => place.cds.includes(String(o.district_code)))).sort(byDistrict),
    governor: list.filter((o) => o.chamber === ids.executive).sort((a, b) => (a.rank || 99) - (b.rank || 99))[0] || null,
    upper: seats(ids.upper, place.upper),
    lower: ids.lower ? seats(ids.lower, place.lower) : [],
    county,
  };
}

/** For every official the run needs: {votes, trades, disclosures} by official id, and the Governors' final actions. */
async function officialFacts(run, officials, governors) {
  const { start, end } = run.week;
  const out = new Map(officials.map((o) => [o.id, { votes: [], trades: [], disclosures: [] }]));
  const ids = [...out.keys()];
  const add = (rows, field) => rows.forEach((r) => out.get(r.official_id) && out.get(r.official_id)[field].push(r));
  for (const c of chunks(ids)) {
    // The week's final-passage votes (votes_date), kept where one of these officials voted (a key lookup each).
    add(
      await all(
        run.db,
        `SELECT v.id, v.bill_id, v.vote_date, v.question, v.result, v.chamber, b.bill_number, b.title AS bill_title, p.official_id, p.position
         FROM votes v JOIN vote_positions p ON p.vote_id = v.id AND p.official_id IN (${ph(c.length)})
         LEFT JOIN bills b ON b.id = v.bill_id
         WHERE v.vote_type = 'final_passage' AND v.vote_date BETWEEN ? AND ?`,
        [...c, start, end]
      ),
      "votes"
    );
    add(
      await all(
        run.db,
        `SELECT v.id, v.bill_id, v.vote_date, v.question, v.result, v.chamber, b.bill_number, b.title AS bill_title, o.id AS official_id,
           CASE sp.position WHEN 0 THEN 'Yes' WHEN 1 THEN 'No' WHEN 2 THEN 'Present' ELSE 'Not voting' END AS position
         FROM votes v JOIN state_positions sp ON sp.vote_k = v.k JOIN officials o ON o.k = sp.member_k AND o.id IN (${ph(c.length)})
         LEFT JOIN bills b ON b.id = v.bill_id
         WHERE v.vote_type = 'final_passage' AND v.vote_date BETWEEN ? AND ?`,
        [...c, start, end]
      ),
      "votes"
    );
    add(await all(run.db, `SELECT official_id, id, filed_on, report_url FROM trade_reports WHERE official_id IN (${ph(c.length)}) AND filed_on BETWEEN ? AND ?`, [...c, start, end]), "trades");
    add(await all(run.db, `SELECT official_id, id, year, filed_on FROM networth_reports WHERE official_id IN (${ph(c.length)}) AND filed_on BETWEEN ? AND ?`, [...c, start, end]), "disclosures");
  }
  for (const f of out.values()) f.votes.sort((a, b) => b.vote_date.localeCompare(a.vote_date) || String(a.bill_number || "").localeCompare(String(b.bill_number || "")));
  const govActions = new Map();
  const govIds = governors.map((g) => g.id);
  for (const c of chunks(govIds)) {
    const rows = await all(
      run.db,
      `SELECT o.actor_id, o.bill_id, o.outcome, o.action_date, o.law_number, b.bill_number, b.title AS bill_title
       FROM bill_outcomes o LEFT JOIN bills b ON b.id = o.bill_id
       WHERE o.actor_id IN (${ph(c.length)}) AND o.action_date BETWEEN ? AND ? AND o.outcome != 'presented'
       ORDER BY o.action_date DESC, b.bill_number`,
      [...c, start, end]
    );
    for (const r of rows) govActions.set(r.actor_id, [...(govActions.get(r.actor_id) || []), r]);
  }
  return { byOfficial: out, govActions };
}

/** The National section's facts: executive orders signed, bills that became law, Supreme Court opinions. */
async function nationalFacts(run) {
  const { start, end } = run.week;
  const orders = await all(
    run.db,
    "SELECT id, number, title, signed_on FROM executive_actions WHERE kind = 'executive_order' AND id LIKE 'fr:%' AND signed_on BETWEEN ? AND ? ORDER BY signed_on DESC, number DESC",
    [start, end]
  );
  const laws = await all(
    run.db,
    `SELECT o.bill_id, o.outcome, o.action_date, o.law_number, b.bill_number, b.title AS bill_title
     FROM bill_outcomes o LEFT JOIN bills b ON b.id = o.bill_id
     WHERE o.bill_id LIKE 'us-%' AND o.outcome IN ('signed', 'without_signature', 'over_veto', 'became_law') AND o.action_date BETWEEN ? AND ?
     ORDER BY o.action_date DESC, b.bill_number`,
    [start, end]
  );
  const opinions = [];
  const index = await json(run, "/data/scotus/index.json");
  const terms = index && Array.isArray(index.terms) ? index.terms.slice(0, 2) : [];
  for (const term of terms) {
    const t = await json(run, `/data/scotus/terms/${term}.json`);
    for (const c of (t && t.cases) || []) {
      const d = isoDate(c.date);
      if (d && d >= start && d <= end) opinions.push({ term, docket: c.docket, name: c.name, date: d });
    }
  }
  opinions.sort((a, b) => b.date.localeCompare(a.date) || a.name.localeCompare(b.name));
  return { orders, laws, opinions };
}

/** '2026-09-25' or '10/14/2026' as an ISO date; null otherwise. */
export function isoDate(s) {
  const t = String(s || "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10);
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(t);
  return m ? `${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : null;
}

/** The live county's meetings in the next 14 days, with their first agenda items and the county's comment instructions. */
async function countyMeetings(run) {
  const from = run.today;
  const to = addDays(run.today, 14);
  const meetings = await all(
    run.db,
    "SELECT id, body, meeting_type, starts_at, status, comment_text, comment_deadline_text FROM meetings WHERE level = 'county' AND starts_at >= ? AND starts_at < ? ORDER BY starts_at",
    [from, `${to}T99`]
  );
  for (const m of meetings) {
    m.items = await all(run.db, "SELECT title FROM meeting_items WHERE meeting_id = ? AND section_kind != 'closed_session' ORDER BY sort LIMIT 4", [m.id]);
    m.itemCount = ((await all(run.db, "SELECT COUNT(*) AS n FROM meeting_items WHERE meeting_id = ?", [m.id]))[0] || { n: 0 }).n;
  }
  return meetings;
}

// ---------------------------------------------------------------------------
// Sections

const POSITION = { Yes: "Yes", No: "No", Present: "Present", "Not voting": "Not voting" };
const OUTCOME = { signed: "Signed", vetoed: "Vetoed", pocket_vetoed: "Pocket vetoed", without_signature: "Became law without a signature", over_veto: "Became law over a veto", became_law: "Became law" };

function repGroup(o, facts, { office } = {}) {
  const f = facts.byOfficial.get(o.id) || { votes: [], trades: [], disclosures: [] };
  const items = [
    ...f.votes.map((v) => ({ text: billName(v), href: v.bill_id ? billHref(v.bill_id) : repHref(o), status: POSITION[v.position] || v.position, meta: `${v.result} · ${dayWords(v.vote_date)} · ${v.question}`, kind: "vote" })),
    ...f.trades.map((t) => ({ text: "Stock trade report filed", href: `${repHref(o)}#more`, meta: `Filed ${dayWords(t.filed_on)}`, kind: "report" })),
    ...f.disclosures.map((d) => ({ text: `Financial disclosure report filed (${d.year})`, href: `${repHref(o)}#more`, meta: d.filed_on ? `Filed ${dayWords(d.filed_on)}` : "", kind: "report" })),
  ];
  return {
    name: o.name,
    office: office || [o.office, o.district].filter(Boolean).join(", "),
    href: repHref(o),
    items,
    empty: items.length ? null : "No final-passage votes or new filings this week",
  };
}

/** A section of reps: shown only when at least one of them has something new. */
function repSection(id, title, reps, facts, note = null) {
  const groups = reps.map((o) => repGroup(o, facts));
  if (!groups.some((g) => g.items.length)) return null;
  return { id, title, note, groups };
}

/** One edition from the run's facts. */
function assemble(run, key, place, reps, facts, national, extra) {
  const sections = [];
  const nat = [];
  for (const o of national.orders) nat.push({ text: o.title, href: orderHref(o.id), meta: `${o.number ? `Executive Order ${o.number} · ` : ""}Signed ${dayWords(o.signed_on)}`, kind: "order" });
  for (const l of national.laws) nat.push({ text: billName(l), href: billHref(l.bill_id), status: "Became law", meta: [l.law_number, `${OUTCOME[l.outcome] || "Became law"} ${dayWords(l.action_date)}`].filter(Boolean).join(" · "), kind: "law" });
  for (const c of national.opinions) nat.push({ text: c.name, href: `/court/cases/${c.term}/${encodeURIComponent(c.docket)}/`, meta: `Supreme Court decision · ${dayWords(c.date)} · No. ${c.docket}`, kind: "opinion" });
  if (nat.length) sections.push({ id: "national", title: "In Washington", items: nat });

  if (place && place.level !== "national") {
    const st = place.st;
    const stateName = STATE_NAME[st] || st;
    const s1 = repSection("senate", "Your U.S. senators", reps.senators, facts);
    if (s1) sections.push(s1);
    const multiCd = place.cds.filter((d) => d !== "0").length > 1;
    const s2 = repSection("house", reps.house.length > 1 ? "Your U.S. representatives" : "Your U.S. representative", reps.house, facts, multiCd ? `Your ZIP covers ${cdWords(place.cds)}` : null);
    if (s2) sections.push(s2);
    if (reps.governor) {
      const acts = facts.govActions.get(reps.governor.id) || [];
      if (acts.length) {
        sections.push({
          id: "governor",
          title: `Your Governor`,
          groups: [{ name: reps.governor.name, office: reps.governor.office || "Governor", href: repHref(reps.governor), items: acts.map((a) => ({ text: billName(a), href: billHref(a.bill_id), status: OUTCOME[a.outcome] || a.outcome, meta: [a.law_number, dayWords(a.action_date)].filter(Boolean).join(" · "), kind: "governor" })), empty: null }],
        });
      }
    }
    const legislators = [...reps.upper, ...reps.lower];
    if (!extra.votesLoaded.has(st)) {
      sections.push({ id: "state", title: `Your ${stateName} legislators`, note: null, coming: { text: `Coming to ${stateName}: state legislators' votes. Join the list ›`, href: `/waitlist/?state=${st}` }, groups: [] });
    } else {
      const legNote = place.level === "zip" && place.upper.length + place.lower.length > 2 ? `Your ZIP covers ${legWords(place)}` : null;
      const s3 = repSection("state", `Your ${stateName} legislators`, legislators, facts, legNote);
      if (s3) sections.push(s3);
    }
    const live = place.counties.filter((co) => LIVE[co]);
    if (live.length && place.counties.length === 1) {
      const items = extra.meetings.map((m) => ({
        text: `${m.body}${m.meeting_type ? `, ${m.meeting_type}` : ""}`,
        href: `/meetings/${encodeURIComponent(m.id)}/`,
        status: m.status === "cancelled" ? "Cancelled" : dayWords(m.starts_at),
        meta: m.items.map((i) => i.title).slice(0, 3).join(" · ") + (m.itemCount > 3 ? ` · and ${m.itemCount - 3} more` : ""),
        kind: "meeting",
      }));
      const words = extra.meetings.map((m) => m.comment_deadline_text || m.comment_text).find(Boolean);
      if (items.length) sections.push({ id: "county", title: LIVE[live[0]].name, items, quote: words ? { label: "How to comment, from the agenda", text: firstSentences(words) } : null });
    } else if (live.length) {
      sections.push({ id: "county", title: LIVE[live[0]].name, coming: { text: `Part of ZIP ${place.zip} is in ${LIVE[live[0]].name}, which ThePillory follows meeting by meeting ›`, href: LIVE[live[0]].href }, items: [] });
    }
    const bw = extra.dates ? ballotWindow(extra.dates, st, run.today, place.cds.length === 1 ? place.cds[0] : null) : null;
    if (bw && bw.open) sections.push({ id: "elections", title: "Elections", items: [{ text: bw.line, href: `/ballot/${st.toLowerCase()}/`, meta: previewLabel(st, stateName), kind: "election" }] });
  }
  return finish(run, key, place, sections, extra);
}

/** Complete sentences only, up to about 400 characters, so a quote is never cut mid-sentence. */
export function firstSentences(text, max = 400) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const parts = t.match(/[^.!?]+[.!?]+(\s|$)/g) || [t];
  let out = "";
  for (const p of parts) {
    if ((out + p).length > max) break;
    out += p;
  }
  return (out || parts[0]).trim();
}

/** Counts, subject, preview and the "based on" line. */
function finish(run, key, place, sections, extra) {
  const items = sections.flatMap((s) => [...(s.items || []), ...(s.groups || []).flatMap((g) => g.items)]);
  const n = (kind) => items.filter((i) => i.kind === kind).length;
  const counts = { votes: n("vote"), laws: n("law"), orders: n("order"), opinions: n("opinion"), governor: n("governor"), meetings: n("meeting"), reports: n("report"), elections: n("election") };
  const words = [
    counts.votes && plural(counts.votes, "vote"),
    counts.laws && plural(counts.laws, "law"),
    counts.orders && plural(counts.orders, "executive order"),
    counts.governor && plural(counts.governor, "bill signed or vetoed", "bills signed or vetoed"),
    counts.meetings && plural(counts.meetings, "county meeting"),
    counts.opinions && plural(counts.opinions, "Supreme Court decision"),
    counts.reports && plural(counts.reports, "report filed", "reports filed"),
  ].filter(Boolean);
  const national = !place || place.level === "national";
  const subject = national ? `This week in Washington: ${words.slice(0, 3).join(", ") || "nothing new"}` : `Your representatives this week: ${words.slice(0, 3).join(", ") || "nothing new"}`;
  const when = weekWords(run.week.start, run.week.end);
  const label = placeLabel(place, extra);
  return {
    key,
    week: run.week.week,
    level: national ? "national" : place.level,
    title: "This week from your representatives",
    subject,
    preview: `${label} · ${when}`,
    when,
    based: basedOn(place, extra),
    sections,
    counts,
    items: items.length,
  };
}

/** The place in a few words, for the preview line. */
function placeLabel(place, extra) {
  if (!place || place.level === "national") return "National edition";
  const county = place.counties.length === 1 ? extra.counties && extra.counties[place.counties[0]] : null;
  const where = county ? `${county[0]}, ${place.st}` : STATE_NAME[place.st] || place.st;
  return place.level === "zip" ? `ZIP ${place.zip} · ${where}` : where;
}

/** The line under the title: what the edition is based on, and a way to change it ({text, link: {label, to}}). */
function basedOn(place, extra) {
  if (!place || place.level === "national") return { text: "National edition", link: { label: "Personalize it ›", to: "manage" } };
  if (place.level === "zip") {
    const n = place.cds.filter((d) => d !== "0").length;
    return { text: n > 1 ? `Based on ZIP ${place.zip}, which covers ${n} congressional districts` : `Based on ZIP ${place.zip}`, link: { label: "Make it exact ›", to: "manage" } };
  }
  const leg = legWords(place);
  return { text: `Based on your address: ${[cdWords(place.cds), leg].filter(Boolean).join(", ")}`, link: { label: "Change my place ›", to: "manage" } };
}

// ---------------------------------------------------------------------------

/**
 * Builds every edition the subscribers need, once each. groups: [{key, sub}] (sub: one
 * subscriber row with that key, for its place). Returns [edition], with items 0 for an
 * edition with nothing new (not sent). A ZIP not in the data gets the National edition's key.
 */
export async function buildEditions(ctx, groups) {
  const run = newRun(ctx);
  const places = new Map();
  for (const { key, sub } of groups) {
    if (key === "national") {
      places.set(key, { level: "national" });
      continue;
    }
    let combos = [];
    if (sub.level === "zip") combos = zipCombos(await json(run, zipFile(sub.zip)), sub.zip);
    places.set(key, placeOf(sub, combos));
  }
  const reps = new Map();
  for (const [key, place] of places) if (place && place.level !== "national") reps.set(key, await officialsOf(run, place));
  const everyone = new Map();
  const governors = new Map();
  for (const r of reps.values()) {
    for (const o of [...r.senators, ...r.house, ...r.upper, ...r.lower]) everyone.set(o.id, o);
    if (r.governor) governors.set(r.governor.id, r.governor);
  }
  const facts = await officialFacts(run, [...everyone.values()], [...governors.values()]);
  const national = await nationalFacts(run);
  const states = [...new Set([...places.values()].filter((p) => p && p.st).map((p) => p.st))];
  // California's votes are always loaded (functions/_lib/coverage.js votesLoaded); other states once state_coverage says so.
  const votesLoaded = new Set([
    "CA",
    ...(states.length ? (await all(run.db, `SELECT st FROM state_coverage WHERE votes > 0 AND st IN (${ph(states.length)})`, states)).map((r) => r.st) : []),
  ]);
  const needsCounty = [...places.values()].some((p) => p && p.counties && p.counties.some((co) => LIVE[co]));
  const extra = {
    votesLoaded,
    meetings: needsCounty ? await countyMeetings(run) : [],
    dates: states.length ? await json(run, "/data/elections/dates.json") : null,
    counties: await json(run, "/data/counties.json"),
  };
  return [...places.entries()].map(([key, place]) => (place ? assemble(run, key, place, reps.get(key), facts, national, extra) : { ...assemble(run, "national", { level: "national" }, null, facts, national, extra), key, fallback: true }));
}

export { editionKey };
