// The bill-passages step (docs/data-sync.md, "Passage without a recorded vote"): bills that passed
// the House or Senate by voice vote, unanimous consent or without objection, read from each bill's
// Congress.gov actions; and, for those bills, what is on record: the rules the House considered them
// under, cosponsors, related bills and committee report votes. Then a constitutional analysis is
// queued for each one that passed since ANALYSIS_SINCE.
//
// Reads only bills Congress.gov lists as updated since the last scan (the first scan reads the
// whole Congress, resuming bill by bill), and writes only what changed.
import { api } from "../congress-api.js";
import { upsertBill } from "../db.js";
import { syncScope } from "../upsert.js";
import { getState, setState, currentCongress, BudgetExhausted, UpstreamError, isHttp } from "../util.js";
import { passagesWithoutRollCall, rulesFromActions, cosponsorRows, relatedRows, committeeVotes, billLabel, congressUrl } from "./parse.js";

const TYPES = /^(hr|s|hjres|sjres)$/; // bills and joint resolutions: what can become law
// A latest action that means the bill hasn't left its first committee: nothing to read.
const NOT_YET = /^(Introduced in|Referred to the (House )?(Committee|Subcommittee)|Referred to House|Read twice and referred|Sponsor introductory remarks)/i;
export const ANALYSIS_REQUESTER = "sync: passed without a recorded vote";
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

/** Whether the bill-list entry is worth reading actions for. Pure. */
export function worthReading(b) {
  if (!b || !TYPES.test(String(b.type || "").toLowerCase()) || !b.number) return false;
  const latest = String((b.latestAction && b.latestAction.text) || "");
  return !NOT_YET.test(latest);
}

async function pages(budget, url, key, label) {
  const out = [];
  for (let offset = 0; offset < 5000; offset += 250) {
    const d = await budget.json(`${url}&limit=250&offset=${offset}`, {}, `${label} ${offset}`);
    const items = d[key] || [];
    out.push(...items);
    if (items.length < 250) break;
  }
  return out;
}

/** One bill: its actions, passages and rules; for a bill with a passage, its cosponsors, related bills and reports. */
export async function readBill(env, db, budget, congress, type, number, title, updateDate, counts) {
  const t = type.toLowerCase();
  const billId = `us-${congress}-${t}-${number}`;
  const page = congressUrl(congress, t, number);
  const actions = await pages(budget, api(env, `/bill/${congress}/${t}/${number}/actions`), "actions", `actions ${billId}`);
  counts.read += 1;
  const passages = passagesWithoutRollCall(actions);
  const rules = rulesFromActions(actions, congress);
  if (passages.length) {
    if (!(await db.prepare("SELECT 1 AS x FROM bills WHERE id = ?").bind(billId).first())) {
      await upsertBill(db, { id: billId, level: "federal", chamber: t.startsWith("h") ? "us-house" : "us-senate", bill_number: billLabel(t, number), session: String(congress), title: title || billLabel(t, number), official_url: page, source_url: page });
    }
  }
  const { stmts: p, inserted } = await syncScope(db, {
    table: "bill_passages", scope: { bill_id: billId }, key: ["chamber"], stamp: "updated_at",
    cols: ["bill_id", "chamber", "method", "action_date", "action_text", "source_url"],
    rows: passages.map((x) => ({ bill_id: billId, ...x, source_url: `${page}/all-actions` })),
  });
  const { stmts: r } = await syncScope(db, { table: "bill_rules", scope: { bill_id: billId }, key: ["rule_id"], cols: ["bill_id", "rule_id"], rows: passages.length ? rules.map((rule_id) => ({ bill_id: billId, rule_id })) : [] });
  if (p.length + r.length) await db.batch([...p, ...r]);
  counts.passages += inserted;
  if (passages.length) await readRecord(env, db, budget, congress, t, number, billId, updateDate, counts);
}

/** Cosponsors, related bills and committee report votes, read again only when Congress.gov's updateDate changed. */
async function readRecord(env, db, budget, congress, t, number, billId, updateDate, counts) {
  const seen = await db.prepare("SELECT update_date FROM bill_record_checks WHERE bill_id = ?").bind(billId).first();
  if (seen && updateDate && seen.update_date === updateDate) return;
  const base = `/bill/${congress}/${t}/${number}`;
  const cos = cosponsorRows(await pages(budget, api(env, `${base}/cosponsors`), "cosponsors", `cosponsors ${billId}`));
  const rel = relatedRows(await pages(budget, api(env, `${base}/relatedbills`), "relatedBills", `related ${billId}`));
  const detail = (await budget.json(api(env, base), {}, `bill ${billId}`)).bill || {};
  const votes = [];
  for (const rep of detail.committeeReports || []) {
    const m = /committee-report\/(\d+)\/(hrpt|srpt)\/(\d+)/i.exec(String(rep.url || ""));
    if (!m) continue;
    try {
      const texts = (await budget.json(api(env, `/committee-report/${m[1]}/${m[2].toLowerCase()}/${m[3]}/text`), {}, `report ${rep.citation}`)).text || [];
      const url = (texts.find((x) => /Formatted Text|HTML/i.test(x.type || "")) || texts[0] || {}).url;
      if (!isHttp(url)) continue;
      const body = await budget.text(url, {}, `report text ${rep.citation}`);
      for (const v of committeeVotes(body)) votes.push({ bill_id: billId, report: rep.citation || `${m[2].toUpperCase()} ${m[1]}-${m[3]}`, ...v, source_url: url });
    } catch (err) {
      if (!(err instanceof UpstreamError)) throw err;
      counts.reportErrors += 1; // the report stays unread; tried again when the bill next changes
    }
  }
  const all = [];
  for (const spec of [
    { table: "bill_cosponsors", key: ["bioguide_id"], cols: ["bill_id", "bioguide_id", "name", "signed_on", "original", "withdrawn_on"], rows: cos.map((c) => ({ bill_id: billId, ...c })) },
    { table: "bill_related", key: ["related_id"], cols: ["bill_id", "related_id", "label", "title", "relationship", "identified_by"], rows: rel.map((x) => ({ bill_id: billId, ...x })) },
    { table: "committee_votes", key: ["report", "vote_date", "question"], cols: ["bill_id", "report", "vote_date", "question", "source_url"], rows: votes },
  ]) all.push(...(await syncScope(db, { ...spec, scope: { bill_id: billId } })).stmts);
  all.push(db.prepare("INSERT INTO bill_record_checks (bill_id, update_date, checked_at) VALUES (?, ?, datetime('now')) ON CONFLICT(bill_id) DO UPDATE SET update_date = excluded.update_date, checked_at = excluded.checked_at").bind(billId, updateDate || null));
  for (let i = 0; i < all.length; i += 50) await db.batch(all.slice(i, i + 50));
  counts.records += 1;
}

/** A constitutional analysis for each bill that passed without a recorded vote on or after `since`, once. */
export async function queueAnalyses(db, since) {
  const r = await db
    .prepare(
      `INSERT INTO analysis_requests (bill_id, requested_by, depth, source)
       SELECT p.bill_id, ?, 'card', 'admin' FROM bill_passages p JOIN bills b ON b.id = p.bill_id
       WHERE p.action_date >= ?
         AND NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = p.bill_id)
         AND NOT EXISTS (SELECT 1 FROM analysis_requests q WHERE q.bill_id = p.bill_id)
       GROUP BY p.bill_id`
    )
    .bind(ANALYSIS_REQUESTER, since)
    .run();
  return (r.meta && r.meta.changes) || 0;
}

export async function syncBillPassages(env, db, budget, { since: analysisFrom = "2026-10-01" } = {}) {
  if (!env.CONGRESS_API_KEY) return { status: "skipped", message: "CONGRESS_API_KEY is not set" };
  const congress = currentCongress();
  const counts = { read: 0, passages: 0, records: 0, reportErrors: 0, queued: 0 };
  const stateKey = `passages_federal_${congress}`;
  const saved = JSON.parse((await getState(db, stateKey)) || "{}");
  const started = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  const summary = () => `Congress ${congress}: ${counts.read} bill(s) read, ${counts.passages} new passage(s) without a recorded vote, ${counts.records} bill record(s) read${counts.reportErrors ? `, ${counts.reportErrors} committee report(s) not read` : ""}${counts.queued ? `, ${counts.queued} analysis request(s) queued` : ""}`;
  try {
    let offset = saved.offset || 0;
    let at = saved.at || 0; // the bill within the page to resume at
    for (;;) {
      const url = api(env, `/bill/${congress}`, { limit: "250", offset: String(offset), sort: "updateDate+asc", ...(saved.since ? { fromDateTime: saved.since } : {}) }).replace("updateDate%2Basc", "updateDate+asc");
      const d = await budget.json(url, {}, `bills updated ${saved.since || "this Congress"} offset ${offset}`);
      const bills = d.bills || [];
      for (let i = at; i < bills.length; i += 1) {
        const b = bills[i];
        if (worthReading(b)) await readBill(env, db, budget, congress, b.type, b.number, b.title, b.updateDate, counts);
        await setState(db, stateKey, JSON.stringify({ since: saved.since || null, offset, at: i + 1, started: saved.started || started }));
      }
      offset += bills.length;
      at = 0;
      await setState(db, stateKey, JSON.stringify({ since: saved.since || null, offset, at: 0, started: saved.started || started }));
      if (bills.length < 250) break;
    }
    await setState(db, stateKey, JSON.stringify({ since: saved.started || started, offset: 0, at: 0 }));
    counts.queued = await queueAnalyses(db, analysisFrom);
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${summary()}; continues next round (${err.message})` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: counts.read || counts.queued ? "ok" : "skipped", message: counts.read || counts.queued ? summary() : `no bills changed since ${saved.since || "the last scan"}` };
}
