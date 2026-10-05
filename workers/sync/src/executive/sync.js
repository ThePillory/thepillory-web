// The executive branch (see docs/executive.md). Four sync steps:
//
//   executive-officials  the President and Vice President (congress-legislators'
//                        executive.json), the Cabinet (whitehouse.gov's Cabinet
//                        page), and California's statewide elected offices
//                        (data/state-executive-officials.json, entered by hand).
//   executive-orders     the President's executive orders (Federal Register API)
//                        and the Governor's (gov.ca.gov's "Executive orders" feed,
//                        and the signed order linked from each post).
//   bill-outcomes        signed, vetoed, or law without a signature: Congress.gov
//                        bill actions, and leginfo's bill history for California.
//   nominations          civilian nominations the President sent to the Senate
//                        (Congress.gov).
//
// Every row keeps its source URL. Nothing is inferred: an outcome is recorded
// only from the action that states it.
import { getState, setState, BudgetExhausted, isHttp, slugify, today } from "../util.js";
import { upsertOfficial, deactivateOthers, upsertBill } from "../db.js";
import {
  executiveOn, personName, parseCabinet, frOrder, federalOutcome, federalWorthChecking, presentableFederal,
  parseLeginfoHistory, californiaOutcome, leginfoBillId, presentableCalifornia, leginfoHistoryUrl,
  parseGovFeed, govOrderFromPost, nominationRow, currentCongress,
} from "./parse.js";

const EXECUTIVE_URL = "https://unitedstates.github.io/congress-legislators/executive.json";
const EXECUTIVE_SOURCE = "https://github.com/unitedstates/congress-legislators#executive";
const CABINET_URL = "https://www.whitehouse.gov/administration/cabinet/";
const FR_API = "https://www.federalregister.gov/api/v1";
const CONGRESS_API = "https://api.congress.gov/v3";
const GOV_FEED = "https://www.gov.ca.gov/category/executive-orders/feed/";
const MIN_CABINET = 8; // fewer names than this means the page changed shape: keep what we have

const OFFICE = { prez: "President of the United States", viceprez: "Vice President of the United States" };

const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const partialMsg = (summary, err) => ({ status: "partial", message: `${summary}; ${err.message}` });

// ---------------------------------------------------------------------------
// Officials

async function loadExecutive(env, db, budget) {
  const data = await budget.json(env.EXECUTIVE_URL || EXECUTIVE_URL, {}, "executive.json");
  // Terms kept for naming who held office on a date (outcomes, nominations).
  const terms = [];
  for (const p of data) for (const t of p.terms || []) if (t.type === "prez" || t.type === "viceprez") terms.push({ type: t.type, start: t.start, end: t.end, name: personName(p), govtrack: p.id && p.id.govtrack });
  await setState(db, "executive_terms", JSON.stringify(terms.filter((t) => t.end >= "1989-01-01")));
  return data;
}

export async function syncExecutiveOfficials(env, db, budget) {
  const notes = [];
  const kept = [];
  // 1. The President and Vice President.
  const data = await loadExecutive(env, db, budget);
  const now = executiveOn(data, today());
  const fec = {};
  for (const [type, rank] of [["prez", 1], ["viceprez", 2]]) {
    const cur = now[type];
    if (!cur) {
      notes.push(`no current ${OFFICE[type]} in executive.json`);
      continue;
    }
    const p = cur.person;
    const id = `exec:govtrack:${p.id.govtrack}`;
    const name = personName(p);
    await upsertOfficial(db, {
      id, slug: slugify(name), claimSlug: true, name, last_name: (p.name || {}).last || name.split(/\s+/).pop(),
      office: OFFICE[type], level: "federal", chamber: "us-executive", body: "us-executive",
      party: cur.term.party || null, term_start: cur.term.start, term_end: cur.term.end,
      website: "https://www.whitehouse.gov/", source_url: EXECUTIVE_SOURCE, last_verified: today(),
      bioguide_id: p.id.bioguide || null, state: null, rank,
    });
    fec[id] = (p.id.fec || []).filter((x) => /^P\d/.test(x));
    kept.push(id);
  }
  await setState(db, "executive_fec", JSON.stringify(fec));

  // 2. The Cabinet, as whitehouse.gov lists it.
  const cabinetUrl = env.CABINET_URL || CABINET_URL;
  const members = parseCabinet(await budget.text(cabinetUrl, {}, "whitehouse.gov Cabinet page"));
  let cabinetOk = members.length >= MIN_CABINET;
  if (cabinetOk) {
    members.forEach((m, i) => kept.push(`exec:cabinet:${slugify(m.name)}`));
    for (const [i, m] of members.entries()) {
      await upsertOfficial(db, {
        id: `exec:cabinet:${slugify(m.name)}`, slug: slugify(m.name), claimSlug: true, name: m.name,
        last_name: m.name.replace(/,? (Jr|Sr|II|III)\.?$/, "").split(/\s+/).pop(),
        office: m.title, level: "federal", chamber: "us-executive", body: "us-executive",
        source_url: cabinetUrl, last_verified: today(), rank: 10 + i,
      });
    }
  } else {
    notes.push(`the Cabinet page listed ${members.length} members (expected at least ${MIN_CABINET}); kept the current list`);
    const { results } = await db.prepare("SELECT id FROM officials WHERE chamber = 'us-executive' AND active = 1 AND id LIKE 'exec:cabinet:%'").all();
    kept.push(...results.map((r) => r.id));
  }
  const dropped = await deactivateOthers(db, "us-executive", kept);

  // 3. California's statewide elected offices (entered by hand).
  const url = `${(env.SITE_URL || "").replace(/\/$/, "")}/data/state-executive-officials.json`;
  const file = await budget.json(url, {}, "state-executive-officials.json");
  const entries = Array.isArray(file.officials) ? file.officials : [];
  const state = [];
  const skipped = [];
  for (const e of entries) {
    const label = e.office || e.office_key || "an entry";
    const need = ["office_key", "office", "name", "source_url", "last_verified"].filter((k) => !String(e[k] || "").trim());
    if (need.length) skipped.push(`${label} (missing ${need.join(", ")})`);
    else if (!isHttp(e.source_url)) skipped.push(`${label} (source_url must start with http)`);
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(e.last_verified)) skipped.push(`${label} (last_verified must be YYYY-MM-DD)`);
    else {
      const name = e.name.trim();
      const id = `ca-exec:${slugify(e.office_key)}:${slugify(name)}`;
      await upsertOfficial(db, {
        id, slug: slugify(name), claimSlug: true, name, last_name: name.replace(/,? (Jr|Sr|II|III)\.?$/, "").split(/\s+/).pop(),
        office: e.office.trim(), level: "state", chamber: "ca-executive", body: "ca-executive", state: "CA",
        party: (e.party || "").trim() || null, term_start: e.term_start || null, term_end: e.term_end || null,
        website: isHttp(e.website) ? e.website : null, photo_url: isHttp(e.photo_url) ? e.photo_url : null,
        photo_credit: e.photo_credit || null, source_url: e.source_url, last_verified: e.last_verified,
        rank: Number(e.rank) || 50,
      });
      state.push(id);
    }
  }
  const droppedState = await deactivateOthers(db, "ca-executive", state);

  const msg = [
    `federal: ${kept.length} (${members.length} from the Cabinet page)${dropped ? `, ${dropped} no longer listed` : ""}`,
    `California: ${state.length} of ${entries.length}${droppedState ? `, ${droppedState} removed` : ""}`,
    skipped.length ? `skipped ${skipped.join("; ")}` : "",
    ...notes,
  ].filter(Boolean).join("; ");
  return { status: notes.length || skipped.length || !cabinetOk ? "error" : "ok", message: msg };
}

// ---------------------------------------------------------------------------
// Who held the office on a date

async function presidentLookup(db) {
  const terms = JSON.parse((await getState(db, "executive_terms")) || "[]").filter((t) => t.type === "prez");
  const { results } = await db.prepare("SELECT id, name, term_start FROM officials WHERE chamber = 'us-executive' AND rank = 1").all();
  const byGovtrack = Object.fromEntries(results.map((r) => [r.id.replace(/^exec:govtrack:/, ""), r.id]));
  return (date) => {
    const t = terms.find((x) => x.start <= date && date < x.end);
    return t ? { name: t.name, id: byGovtrack[String(t.govtrack)] || null } : { name: null, id: null };
  };
}

async function governorLookup(db) {
  const { results } = await db.prepare("SELECT id, name, term_start, term_end FROM officials WHERE chamber = 'ca-executive' AND rank = 1").all();
  // Named only when the Governor's term dates in the file cover the date.
  return (date) => {
    const g = results.find((r) => r.term_start && r.term_start <= date && (!r.term_end || date < r.term_end));
    return g ? { name: g.name, id: g.id } : { name: null, id: null };
  };
}

// ---------------------------------------------------------------------------
// Executive orders

async function saveAction(db, official_id, a) {
  await db
    .prepare(
      `INSERT INTO executive_actions (id, official_id, kind, number, title, signed_on, published_on, citation, document_url, source_url, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, number = COALESCE(excluded.number, executive_actions.number), title = excluded.title,
         signed_on = excluded.signed_on, published_on = excluded.published_on, citation = excluded.citation,
         document_url = COALESCE(excluded.document_url, executive_actions.document_url), source_url = excluded.source_url, updated_at = excluded.updated_at`
    )
    .bind(a.id, official_id, a.kind, a.number, a.title, a.signed_on, a.published_on, a.citation || null, a.document_url, a.source_url)
    .run();
}

export async function syncExecutiveOrders(env, db, budget) {
  let fed = 0;
  let ca = 0;
  let posts = 0;
  const summary = () => `${fed} federal executive order(s) saved; ${ca} Governor's order(s) and proclamation(s) saved, ${posts} post(s) read`;
  try {
    // The President's, from the start of the current term, newest first.
    const pres = await db.prepare("SELECT id, name, term_start FROM officials WHERE chamber = 'us-executive' AND rank = 1 AND active = 1").first();
    if (pres && pres.term_start) {
      const terms = JSON.parse((await getState(db, "executive_terms")) || "[]");
      const t = terms.find((x) => x.type === "prez" && x.start === pres.term_start);
      const who = slugify(t ? t.name.replace(/ [A-Z]\. /, " ") : pres.name);
      const fields = ["executive_order_number", "title", "signing_date", "publication_date", "document_number", "html_url", "pdf_url", "citation"].map((f) => `fields[]=${f}`).join("&");
      let url = `${(env.FR_API_BASE || FR_API).replace(/\/$/, "")}/documents.json?per_page=1000&order=newest&conditions[type][]=PRESDOCU&conditions[presidential_document_type][]=executive_order&conditions[president][]=${encodeURIComponent(who)}&conditions[signing_date][gte]=${pres.term_start}&${fields}`;
      for (let page = 0; url && page < 10; page++) {
        const d = await budget.json(url, {}, `Federal Register executive orders page ${page + 1}`);
        for (const doc of d.results || []) {
          if (!doc.document_number || !isHttp(doc.html_url)) continue;
          await saveAction(db, pres.id, frOrder(doc));
          fed += 1;
        }
        url = d.next_page_url || null;
      }
    }

    // The Governor's, from gov.ca.gov's feed; each new post read once for the signed order.
    const gov = await db.prepare("SELECT id FROM officials WHERE chamber = 'ca-executive' AND rank = 1 AND active = 1").first();
    if (gov) {
      const feed = env.GOV_FEED_URL || GOV_FEED;
      const pace = { intervalMs: parseInt(env.GOVCA_MIN_INTERVAL_MS || "2000", 10), dailyLimit: parseInt(env.GOVCA_DAILY_LIMIT || "300", 10) };
      const backfilled = (await getState(db, "gov_feed_backfilled")) === "1";
      for (let page = 1; page <= (backfilled ? 1 : 40); page++) {
        const res = await budget.paced(db, "govca", pace, page === 1 ? feed : `${feed}?paged=${page}`, {}, `Governor's executive orders feed page ${page}`);
        const items = parseGovFeed(await res.text(), `${new URL(feed).origin}/`);
        if (!items.length) break;
        for (const item of items) {
          const have = await db.prepare("SELECT document_url FROM executive_actions WHERE id = ?").bind(item.id).first();
          let found = { document_url: null, number: null };
          if (!have) {
            const post = await budget.paced(db, "govca", pace, item.link, {}, `Governor's post ${item.id}`);
            found = govOrderFromPost(await post.text());
            posts += 1;
          }
          await saveAction(db, gov.id, {
            id: item.id, kind: item.kind, number: found.number, title: item.title, signed_on: null,
            published_on: item.published_on, document_url: found.document_url, source_url: item.link,
          });
          ca += 1;
        }
      }
      if (!backfilled) await setState(db, "gov_feed_backfilled", "1");
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return partialMsg(summary(), err);
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: summary() };
}

// ---------------------------------------------------------------------------
// Bill outcomes

async function saveOutcome(db, billId, o, actor, sourceUrl) {
  const final = ["signed", "pocket_vetoed", "without_signature", "over_veto", "became_law"].includes(o.outcome) ? 1 : 0;
  await db.batch([
    db
      .prepare(
        `INSERT INTO bill_outcomes (bill_id, outcome, action_date, presented_on, law_number, action_text, actor_id, actor_name, source_url, checked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT(bill_id) DO UPDATE SET outcome = excluded.outcome, action_date = excluded.action_date, presented_on = excluded.presented_on,
           law_number = excluded.law_number, action_text = excluded.action_text, actor_id = excluded.actor_id, actor_name = excluded.actor_name,
           source_url = excluded.source_url, checked_at = excluded.checked_at`
      )
      .bind(billId, o.outcome, o.action_date, o.presented_on, o.law_number, o.action_text, actor.id, actor.name, sourceUrl),
    db
      .prepare("INSERT INTO bill_outcome_checks (bill_id, checked_at, final) VALUES (?, datetime('now'), ?) ON CONFLICT(bill_id) DO UPDATE SET checked_at = excluded.checked_at, final = excluded.final")
      .bind(billId, final),
  ]);
}

const markChecked = (db, billId) =>
  db.prepare("INSERT INTO bill_outcome_checks (bill_id, checked_at, final) VALUES (?, datetime('now'), 0) ON CONFLICT(bill_id) DO UPDATE SET checked_at = excluded.checked_at").bind(billId).run();

const typeLabel = { hr: "H.R.", s: "S.", hjres: "H.J.Res.", sjres: "S.J.Res." };

async function federalOutcomes(env, db, budget, counts) {
  if (!env.CONGRESS_API_KEY) return "CONGRESS_API_KEY is not set";
  const base = (env.CONGRESS_API_BASE || CONGRESS_API).replace(/\/$/, "");
  const key = `api_key=${encodeURIComponent(env.CONGRESS_API_KEY)}&format=json`;
  const congress = currentCongress();
  const presidentOn = await presidentLookup(db);
  const check = async (type, number, title, latest) => {
    const t = type.toLowerCase();
    const billId = `us-${congress}-${t}-${number}`;
    const d = await budget.json(`${base}/bill/${congress}/${t}/${number}/actions?${key}&limit=250`, {}, `actions ${billId}`);
    counts.fedChecked += 1;
    const o = federalOutcome(d.actions || []);
    if (!o) return markChecked(db, billId);
    const page = `https://www.congress.gov/bill/${congress}th-congress/${{ hr: "house-bill", s: "senate-bill", hjres: "house-joint-resolution", sjres: "senate-joint-resolution" }[t]}/${number}/all-actions`;
    const have = await db.prepare("SELECT id FROM bills WHERE id = ?").bind(billId).first();
    if (!have && title) {
      await upsertBill(db, {
        id: billId, level: "federal", chamber: t.startsWith("h") ? "us-house" : "us-senate", bill_number: `${typeLabel[t]} ${number}`,
        session: String(congress), title, official_url: page.replace(/\/all-actions$/, ""), source_url: page,
      });
    }
    if (!have && !title) return markChecked(db, billId);
    await saveOutcome(db, billId, o, presidentOn(o.action_date), page);
    counts.fed += 1;
  };

  // New activity since the last scan (the first scan reads the whole Congress).
  const stateKey = `outcomes_federal_${congress}`;
  const saved = JSON.parse((await getState(db, stateKey)) || "{}");
  const since = saved.since || null;
  const started = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let offset = saved.offset || 0;
  for (;;) {
    const url = `${base}/bill/${congress}?${key}&limit=250&offset=${offset}&sort=updateDate+asc${since ? `&fromDateTime=${encodeURIComponent(since)}` : ""}`;
    const d = await budget.json(url, {}, `bills updated ${since || "this Congress"} offset ${offset}`);
    const bills = d.bills || [];
    for (const b of bills) {
      if (!presentableFederal(b.type) || !b.latestAction || !federalWorthChecking(b.latestAction.text)) continue;
      await check(b.type, b.number, b.title, b.latestAction);
    }
    offset += bills.length;
    await setState(db, stateKey, JSON.stringify({ since, offset, started: saved.started || started }));
    if (bills.length < 250) break;
  }
  await setState(db, stateKey, JSON.stringify({ since: saved.started || started, offset: 0 }));

  // Bills awaiting action, or vetoed (a veto can be overridden): looked at again daily.
  const { results } = await db
    .prepare(
      `SELECT o.bill_id FROM bill_outcomes o JOIN bill_outcome_checks c ON c.bill_id = o.bill_id
       WHERE o.bill_id LIKE 'us-%' AND c.final = 0 AND c.checked_at < datetime('now', '-20 hours') LIMIT 50`
    )
    .all();
  for (const r of results) {
    const m = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(r.bill_id);
    if (m && Number(m[1]) === congress) await check(m[2], m[3], null, null);
  }
  return null;
}

async function californiaOutcomes(env, db, budget, counts) {
  const pace = { intervalMs: parseInt(env.LEGINFO_MIN_INTERVAL_MS || "2000", 10), dailyLimit: parseInt(env.LEGINFO_DAILY_LIMIT || "1500", 10) };
  const governorOn = await governorLookup(db);
  // Bills that passed both houses: each has a final-passage vote in each.
  // Unresolved ones are looked at again after 3 days, until final.
  for (;;) {
    const { results } = await db
      .prepare(
        `SELECT b.id FROM bills b LEFT JOIN bill_outcome_checks c ON c.bill_id = b.id
         WHERE b.level = 'state' AND (c.bill_id IS NULL OR (c.final = 0 AND c.checked_at < datetime('now', '-3 days')))
           AND EXISTS (SELECT 1 FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage' AND v.chamber = 'ca-assembly')
           AND EXISTS (SELECT 1 FROM votes v WHERE v.bill_id = b.id AND v.vote_type = 'final_passage' AND v.chamber = 'ca-senate')
         ORDER BY c.bill_id IS NOT NULL, b.id DESC LIMIT 25`
      )
      .all();
    const todo = results.filter((r) => presentableCalifornia(r.id));
    for (const r of results) if (!presentableCalifornia(r.id)) await db.prepare("INSERT OR REPLACE INTO bill_outcome_checks (bill_id, final) VALUES (?, 1)").bind(r.id).run();
    if (!results.length) break;
    for (const r of todo) {
      const lid = leginfoBillId(r.id);
      const url = leginfoHistoryUrl(lid);
      const res = await budget.paced(db, "leginfo", pace, `${(env.LEGINFO_BASE || "https://leginfo.legislature.ca.gov").replace(/\/$/, "")}/faces/billHistoryClient.xhtml?bill_id=${lid}`, {}, `leginfo history ${r.id}`);
      const o = californiaOutcome(parseLeginfoHistory(await res.text()));
      counts.caChecked += 1;
      if (!o) {
        await markChecked(db, r.id);
        continue;
      }
      await saveOutcome(db, r.id, o, governorOn(o.action_date), url);
      counts.ca += 1;
    }
  }
}

export async function syncBillOutcomes(env, db, budget) {
  const counts = { fed: 0, fedChecked: 0, ca: 0, caChecked: 0 };
  const summary = () => `federal: ${counts.fed} outcome(s) from ${counts.fedChecked} bill(s) checked; California: ${counts.ca} outcome(s) from ${counts.caChecked} bill(s) checked`;
  let note = null;
  try {
    note = await federalOutcomes(env, db, budget, counts);
    await californiaOutcomes(env, db, budget, counts);
  } catch (err) {
    if (err instanceof BudgetExhausted) return partialMsg(summary(), err);
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!counts.fedChecked && !counts.caChecked) return { status: "skipped", message: `nothing new to check${note ? `; ${note}` : ""}` };
  return { status: "ok", message: `${summary()}${note ? `; ${note}` : ""}` };
}

// ---------------------------------------------------------------------------
// Nominations

export async function syncNominations(env, db, budget) {
  if (!env.CONGRESS_API_KEY) return { status: "skipped", message: "CONGRESS_API_KEY is not set" };
  const base = (env.CONGRESS_API_BASE || CONGRESS_API).replace(/\/$/, "");
  const congress = currentCongress();
  const presidentOn = await presidentLookup(db);
  const stateKey = `nominations_${congress}`;
  const saved = JSON.parse((await getState(db, stateKey)) || "{}");
  const started = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  let offset = saved.offset || 0;
  let n = 0;
  try {
    for (;;) {
      const url = `${base}/nomination/${congress}?api_key=${encodeURIComponent(env.CONGRESS_API_KEY)}&format=json&limit=250&offset=${offset}&sort=updateDate+asc${saved.since ? `&fromDateTime=${encodeURIComponent(saved.since)}` : ""}`;
      const d = await budget.json(url, {}, `nominations offset ${offset}`);
      const list = d.nominations || [];
      const stmts = [];
      for (const raw of list) {
        if (!raw.nominationType || !raw.nominationType.isCivilian || !raw.citation) continue;
        const r = nominationRow(raw);
        const who = presidentOn(r.received_on || r.latest_on || today());
        stmts.push(
          db
            .prepare(
              `INSERT INTO nominations (id, congress, official_id, description, organization, received_on, latest_action, latest_on, status, source_url, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
               ON CONFLICT(id) DO UPDATE SET official_id = excluded.official_id, description = excluded.description, organization = excluded.organization,
                 received_on = excluded.received_on, latest_action = excluded.latest_action, latest_on = excluded.latest_on, status = excluded.status,
                 source_url = excluded.source_url, updated_at = excluded.updated_at`
            )
            .bind(r.id, r.congress, who.id, r.description, r.organization, r.received_on, r.latest_action, r.latest_on, r.status, r.source_url)
        );
        n += 1;
      }
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
      offset += list.length;
      await setState(db, stateKey, JSON.stringify({ since: saved.since || null, offset, started: saved.started || started }));
      if (list.length < 250) break;
    }
    await setState(db, stateKey, JSON.stringify({ since: saved.started || started, offset: 0 }));
  } catch (err) {
    if (err instanceof BudgetExhausted) return partialMsg(`${n} civilian nomination(s) saved`, err);
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: n ? "ok" : "skipped", message: n ? `${n} civilian nomination(s) saved or updated` : "no nominations changed" };
}
