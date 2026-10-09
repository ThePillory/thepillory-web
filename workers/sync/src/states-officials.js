// Every state's legislators and statewide executive officers (except
// California's, which have their own steps), from data/states/people/<st>.json
// (built weekly from Open States' public people data by
// tools/build_state_people.py). Each state is refreshed weekly, the states
// visitors look up most first, as many a round as time allows. No Open States
// API requests: the files are this site's own static files.
// See docs/states.md.
import { getState, setState, slugify, isHttp, BudgetExhausted } from "./util.js";
import { deactivateOthers } from "./db.js";
import { ALL_JURISDICTIONS, chamberIds, memberTitle, districtLabel, districtKey, executiveOffice, stableKey } from "./states.js";
import { statePriority } from "./state-priority.js";

const REFRESH_DAYS = 7;
const daysSince = (iso) => (iso ? (Date.now() - Date.parse(iso)) / 86400000 : Infinity);

/** The officials rows for one state's file. Pure apart from the key hash; tested. */
export async function stateRecords(doc) {
  const st = String(doc.st || "").toUpperCase();
  const ids = chamberIds(st);
  const out = [];
  for (const p of doc.legislators || []) {
    const type = p.type === "legislature" ? "legislature" : p.type;
    const chamber = type === "legislature" ? ids.upper : ids[type];
    if (!chamber || !p.name || !isHttp(p.source_url)) continue;
    const id = `openstates:${p.id}`;
    out.push({
      id, slug: slugify(p.name), name: p.name, last_name: p.family_name || p.name.split(/\s+/).pop(),
      office: memberTitle(st, type), level: "state", chamber, body: "state-legislature",
      district: districtLabel(st, type, p.district), state: st, district_code: districtKey(st, type, p.district) || null,
      party: p.party || null, term_start: p.start_date || null, term_end: p.end_date || null,
      website: isHttp(p.website) ? p.website : null, photo_url: isHttp(p.image) ? p.image : null,
      photo_credit: isHttp(p.image) ? "Photo via Open States" : null,
      source_url: p.source_url, last_verified: doc.built_on, openstates_id: p.id, rank: null, k: await stableKey(id),
    });
  }
  for (const p of doc.executives || []) {
    const office = executiveOffice(p.type, st);
    if (!office || !p.name || !isHttp(p.source_url)) continue;
    const id = `openstates:${p.id}`;
    out.push({
      id, slug: slugify(p.name), name: p.name, last_name: p.family_name || p.name.split(/\s+/).pop(),
      office: office.title, level: "state", chamber: ids.executive, body: ids.executive,
      district: null, state: st, district_code: null, party: p.party || null,
      term_start: p.start_date || null, term_end: p.end_date || null,
      website: isHttp(p.website) ? p.website : null, photo_url: isHttp(p.image) ? p.image : null,
      photo_credit: isHttp(p.image) ? "Photo via Open States" : null,
      source_url: p.source_url, last_verified: doc.built_on, openstates_id: p.id, rank: office.rank, k: await stableKey(id),
    });
  }
  return out;
}

const UPSERT = `INSERT INTO officials (id, slug, name, last_name, office, level, chamber, body, district, party,
    term_start, term_end, website, photo_url, photo_credit, source_url, last_verified, openstates_id, state,
    district_code, rank, k, active, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, datetime('now'))
  ON CONFLICT(id) DO UPDATE SET
    name = excluded.name, last_name = excluded.last_name, office = excluded.office, level = excluded.level,
    chamber = excluded.chamber, body = excluded.body, district = excluded.district, party = excluded.party,
    term_start = excluded.term_start, term_end = excluded.term_end, website = excluded.website,
    photo_url = excluded.photo_url, photo_credit = excluded.photo_credit, source_url = excluded.source_url,
    last_verified = excluded.last_verified, openstates_id = excluded.openstates_id, state = excluded.state,
    district_code = excluded.district_code, rank = excluded.rank, k = excluded.k, active = 1,
    updated_at = excluded.updated_at`;

/**
 * Upsert a state's officials in batches. Slugs stay as they are for officials
 * already on file; a new official gets the plain name slug, or "-2", "-3" if
 * another official has it (the same rule as upsertOfficial).
 */
async function saveState(db, rows) {
  const existing = new Map();
  for (let i = 0; i < rows.length; i += 90) {
    const chunk = rows.slice(i, i + 90);
    const { results } = await db.prepare(`SELECT id, slug FROM officials WHERE id IN (${chunk.map(() => "?").join(",")})`).bind(...chunk.map((r) => r.id)).all();
    for (const r of results) existing.set(r.id, r.slug);
  }
  const fresh = rows.filter((r) => !existing.has(r.id));
  const taken = new Set();
  const bases = [...new Set(fresh.map((r) => r.slug || "official"))];
  for (let i = 0; i < bases.length; i += 40) {
    const chunk = bases.slice(i, i + 40);
    const res = await db.batch(chunk.map((b) => db.prepare("SELECT slug FROM officials WHERE slug = ? OR slug GLOB ?").bind(b, `${b}-[0-9]*`)));
    for (const r of res) for (const x of r.results || []) taken.add(x.slug);
  }
  for (const r of rows) {
    if (existing.has(r.id)) {
      r.slug = existing.get(r.id);
      continue;
    }
    let slug = r.slug || "official";
    for (let n = 2; taken.has(slug); n++) slug = `${r.slug || "official"}-${n}`;
    taken.add(slug);
    r.slug = slug;
  }
  for (let i = 0; i < rows.length; i += 40) {
    await db.batch(
      rows.slice(i, i + 40).map((o) =>
        db.prepare(UPSERT).bind(
          o.id, o.slug, o.name, o.last_name, o.office, o.level, o.chamber, o.body, o.district, o.party,
          o.term_start, o.term_end, o.website, o.photo_url, o.photo_credit, o.source_url, o.last_verified,
          o.openstates_id, o.state, o.district_code, o.rank, o.k
        )
      )
    );
  }
  return fresh.length;
}

export async function syncAllStateOfficials(env, db, budget) {
  const base = (env.SITE_URL || "").replace(/\/$/, "");
  if (!base) return { status: "skipped", message: "SITE_URL is not set" };
  const order = await statePriority(db, env);
  const due = [];
  for (const st of order) {
    if (st === "CA" || !ALL_JURISDICTIONS.includes(st)) continue;
    if (daysSince(await getState(db, `state_officials_${st}`)) >= REFRESH_DAYS) due.push(st);
  }
  if (!due.length) return { status: "skipped", message: `every state's officials loaded in the last ${REFRESH_DAYS} days` };
  const done = [];
  const problems = [];
  try {
    for (const st of due) {
      if (budget.timeLeft() < 60000) throw new BudgetExhausted(`time left in this round; ${due.length - done.length - problems.length} state(s) next round`);
      // Leave the round's later steps their requests (half the budget, at most 100); the rest go next round.
      if (budget.remaining() <= Math.min(100, Math.floor(budget.max / 2))) throw new BudgetExhausted(`requests kept for later steps; ${due.length - done.length - problems.length} state(s) next round`);
      let doc;
      try {
        doc = await budget.json(`${base}/data/states/people/${st.toLowerCase()}.json`, {}, `state officials ${st}`);
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        problems.push(`${st}: ${err.message}`);
        await setState(db, `state_officials_${st}`, new Date().toISOString());
        continue;
      }
      const rows = await stateRecords(doc);
      const ids = chamberIds(st);
      // A file with far fewer people than are on record now is treated as
      // incomplete: nothing is marked inactive from it.
      const deactivated = [];
      for (const chamber of [ids.upper, ids.lower, ids.executive].filter(Boolean)) {
        const keep = rows.filter((r) => r.chamber === chamber).map((r) => r.id);
        const now = (await db.prepare("SELECT COUNT(*) AS n FROM officials WHERE chamber = ? AND active = 1").bind(chamber).first()).n;
        if (keep.length && keep.length >= now * 0.5) deactivated.push([chamber, keep]);
        else if (now && keep.length < now * 0.5) problems.push(`${st} ${chamber}: the file lists ${keep.length}, ${now} on record; nothing marked inactive`);
      }
      const added = await saveState(db, rows);
      let left = 0;
      for (const [chamber, keep] of deactivated) left += await deactivateOthers(db, chamber, keep);
      await setState(db, `state_officials_${st}`, new Date().toISOString());
      done.push(`${st} ${rows.length}${added ? ` (${added} new)` : ""}${left ? ` (${left} no longer listed)` : ""}`);
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${done.join(", ") || "none yet"}; ${err.message}${problems.length ? `; ${problems.join("; ")}` : ""}` };
  }
  return { status: problems.length && !done.length ? "error" : "ok", message: `${done.join(", ")}${problems.length ? `; ${problems.join("; ")}` : ""}` };
}
