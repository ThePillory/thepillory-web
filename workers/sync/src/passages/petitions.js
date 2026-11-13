// The discharge-petitions step (docs/data-sync.md, "Passage without a recorded vote"): the current
// Congress's House discharge petitions from the Clerk's own pages, each petition's bill and every
// Member's signature with its date. A petition's page is read again daily while it's under a year old,
// monthly after that. Signatures are matched to officials only by the Bioguide ID in the Clerk's link.
import { api } from "../congress-api.js";
import { upsertBill } from "../db.js";
import { syncScope } from "../upsert.js";
import { currentCongress, BudgetExhausted, UpstreamError } from "../util.js";
import { parsePetitionList, parseSignatures } from "./petitions-parse.js";
import { billLabel, congressUrl } from "./parse.js";

const CLERK = "https://clerk.house.gov";
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));

/** Whether a petition's page is due to be read again. Pure. */
export function petitionDue(p, now = new Date()) {
  if (!p || !p.checked_at) return true;
  const age = (now - Date.parse(`${p.checked_at.replace(" ", "T")}Z`)) / 86400000;
  const filedAge = p.filed_on ? (now - Date.parse(p.filed_on)) / 86400000 : 0;
  return age >= (filedAge > 365 ? 30 : 1);
}

export async function syncDischargePetitions(env, db, budget) {
  const congress = currentCongress();
  const base = (env.CLERK_BASE || CLERK).replace(/\/$/, "");
  const counts = { listed: 0, read: 0, signatures: 0 };
  try {
    const all = [];
    for (let page = 1, pages = 1; page <= pages && page <= 20; page += 1) {
      const html = await budget.text(`${base}/DischargePetition/DischargePetitions?Page=${page}&CongressNum=${congress}`, {}, `discharge petitions page ${page}`);
      const r = parsePetitionList(html, congress);
      pages = r.pages;
      all.push(...r.petitions);
    }
    counts.listed = all.length;
    // The newest petitions first: they change most.
    all.sort((a, b) => String(b.filed_on).localeCompare(String(a.filed_on)) || b.number - a.number);
    const { results: known } = await db.prepare("SELECT id, checked_at, filed_on FROM discharge_petitions WHERE congress = ?").bind(congress).all();
    const seen = new Map(known.map((k) => [k.id, k]));
    for (const p of all) {
      const id = `${congress}-${p.number}`;
      const url = p.href ? `${base}${p.href}` : `${base}/DischargePetition`;
      // The bill the petition would bring to a vote, with its title from Congress.gov, when not loaded yet.
      if (p.bill_id && !(await db.prepare("SELECT 1 AS x FROM bills WHERE id = ?").bind(p.bill_id).first()) && env.CONGRESS_API_KEY) {
        const m = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(p.bill_id);
        try {
          const b = (await budget.json(api(env, `/bill/${m[1]}/${m[2]}/${m[3]}`), {}, `bill ${p.bill_id}`)).bill || {};
          const page = congressUrl(m[1], m[2], m[3]);
          if (b.title) await upsertBill(db, { id: p.bill_id, level: "federal", chamber: m[2].startsWith("h") ? "us-house" : "us-senate", bill_number: billLabel(m[2], m[3]), session: m[1], title: b.title, official_url: page, source_url: page });
        } catch (err) {
          if (!(err instanceof UpstreamError)) throw err;
        }
      }
      const prev = seen.get(id);
      let sigs = null;
      if (p.href && petitionDue(prev ? { ...prev, filed_on: p.filed_on } : null)) {
        sigs = parseSignatures(await budget.text(`${base}${p.href}`, {}, `discharge petition ${p.number}`));
        counts.read += 1;
      }
      const stmts = [
        db
          .prepare(
            `INSERT INTO discharge_petitions (id, congress, number, bill_id, rule_id, filed_on, signatures, source_url, checked_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ${sigs ? "datetime('now')" : "NULL"}, datetime('now'))
             ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, rule_id = excluded.rule_id, filed_on = excluded.filed_on,
               signatures = COALESCE(excluded.signatures, discharge_petitions.signatures), source_url = excluded.source_url,
               checked_at = COALESCE(excluded.checked_at, discharge_petitions.checked_at), updated_at = excluded.updated_at
             WHERE discharge_petitions.bill_id IS NOT excluded.bill_id OR discharge_petitions.rule_id IS NOT excluded.rule_id
               OR discharge_petitions.filed_on IS NOT excluded.filed_on OR discharge_petitions.source_url IS NOT excluded.source_url
               OR (excluded.signatures IS NOT NULL AND discharge_petitions.signatures IS NOT excluded.signatures) OR excluded.checked_at IS NOT NULL`
          )
          .bind(id, congress, p.number, p.bill_id, p.rule_id, p.filed_on, sigs ? sigs.filter((s) => !s.withdrawn_on).length : null, url),
      ];
      if (sigs) {
        const ids = [...new Set(sigs.map((s) => s.bioguide_id).filter(Boolean))];
        const officials = new Map();
        for (let i = 0; i < ids.length; i += 90) {
          const chunk = ids.slice(i, i + 90);
          const { results } = await db.prepare(`SELECT id, bioguide_id FROM officials WHERE bioguide_id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk).all();
          for (const r of results) officials.set(r.bioguide_id, r.id);
        }
        const { stmts: s } = await syncScope(db, {
          table: "discharge_signatures", scope: { petition_id: id }, key: ["name"],
          cols: ["petition_id", "name", "bioguide_id", "official_id", "signed_on", "withdrawn_on"],
          rows: sigs.map((x) => ({ petition_id: id, name: x.name, bioguide_id: x.bioguide_id, official_id: x.bioguide_id ? officials.get(x.bioguide_id) || null : null, signed_on: x.signed_on, withdrawn_on: x.withdrawn_on })),
        });
        stmts.push(...s);
        counts.signatures += sigs.length;
      }
      for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
    }
  } catch (err) {
    if (err instanceof BudgetExhausted) return { status: "partial", message: `${counts.listed} petition(s) listed, ${counts.read} read; continues next round (${err.message})` };
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  return { status: "ok", message: `Congress ${congress}: ${counts.listed} discharge petition(s) listed, ${counts.read} page(s) read, ${counts.signatures} signature(s)` };
}
