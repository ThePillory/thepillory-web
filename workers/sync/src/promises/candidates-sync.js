// The candidate-platforms step: the Platform tab for candidates not yet in
// office (docs/candidates.md). For each candidate with a campaign website in
// their FEC filing (data/candidates/<year>/websites.json, written by
// tools/build_candidates.mjs), find the site's Issues or Priorities page with
// the same finder as officials (findOnSite, src/promises/finder.js), then pick a
// short excerpt, word for word, with the same instructions and the same checks
// (src/promises/excerpt.js). Results go to candidate_platforms.
//
// One rule for everyone: candidates never searched come first (the November 3
// races; 2027–2028 candidates as they file), then the longest ago. Each site is
// searched again every CANDIDATE_PLATFORMS_RECHECK_DAYS (30); one that couldn't
// be read is tried again after 3 days. CANDIDATE_PLATFORMS_DAILY (25) sites a
// day, each with at most one AI call. A page a person removed on the review page
// (promise_pages_removed) is never found again.
import { getState, setState, today, redact, BudgetExhausted } from "../util.js";
import { findOnSite, page } from "./finder-sync.js";
import { htmlToText, clip } from "./sources.js";
import { needsExcerpt } from "./excerpt.js";
import { pickExcerpt } from "./index.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

async function sha256(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** New candidates and changed websites into candidate_platforms. A changed website is searched again. */
export async function upsertCandidates(db, list, year) {
  const stmts = list
    .filter((c) => c.id && c.url && /^https?:\/\//.test(c.url))
    .map((c) =>
      db
        .prepare(
          `INSERT INTO candidate_platforms (candidate_id, name, state, year, site_url) VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (candidate_id) DO UPDATE SET name = excluded.name, state = excluded.state,
             checked_at = CASE WHEN candidate_platforms.site_url IS excluded.site_url THEN candidate_platforms.checked_at ELSE NULL END,
             site_url = excluded.site_url`
        )
        .bind(c.id, c.name, c.st, year, c.url)
    );
  for (let i = 0; i < stmts.length; i += 50) await db.batch(stmts.slice(i, i + 50));
  return stmts.length;
}

/** Candidates to search next: never searched first, then the longest ago. */
export async function nextCandidates(db, { limit, recheckDays }) {
  const { results } = await db
    .prepare(
      `SELECT * FROM candidate_platforms
       WHERE site_url IS NOT NULL AND (result IS NULL OR result <> 'removed') AND (
         checked_at IS NULL
         OR checked_at < datetime('now', ?)
         OR (result = 'error' AND checked_at < datetime('now', '-3 days')))
       ORDER BY checked_at IS NOT NULL, checked_at, year, candidate_id
       LIMIT ?`
    )
    .bind(`-${recheckDays} days`, limit)
    .all();
  return results;
}

async function save(db, id, fields) {
  const keys = Object.keys(fields);
  await db
    .prepare(`UPDATE candidate_platforms SET ${keys.map((k) => `${k} = ?`).join(", ")}, checked_at = datetime('now') WHERE candidate_id = ?`)
    .bind(...keys.map((k) => fields[k]), id)
    .run();
}

/** One candidate: search the site, read the page found, and pick an excerpt when one is due. */
export async function searchOne(env, db, budget, c, { pick = pickExcerpt } = {}) {
  const r = await findOnSite(budget, c.site_url);
  const removed = r.found && (await db.prepare("SELECT 1 FROM promise_pages_removed WHERE url = ?").bind(r.found.url).first());
  if (!r.found || removed) {
    await save(db, c.candidate_id, { result: "none", page_url: null, title: null, excerpt: null, excerpt_by: null, note: removed ? "the page found was removed on the review page" : r.note });
    return "none";
  }
  const p = await page(budget, r.found.url, `${c.candidate_id} issues page`);
  if (!p) {
    await save(db, c.candidate_id, { result: "error", note: "the issues page found couldn't be read" });
    return "error";
  }
  const text = clip(htmlToText(p.html), 60000);
  const samePage = c.page_url === r.found.url;
  const row = samePage ? c : { excerpt: null, excerpt_at: null, excerpt_by: null };
  const fields = { result: "found", page_url: r.found.url, title: r.found.title, note: r.note, page_text: text, text_hash: await sha256(text), fetched_at: new Date().toISOString().slice(0, 19).replace("T", " ") };
  if (needsExcerpt(row, text)) {
    const picked = await pick(env, { url: r.found.url, kind: "campaign_site", title: r.found.title, text }, { name: c.name }, "candidate");
    Object.assign(fields, { excerpt: picked.excerpt, excerpt_at: fields.fetched_at, excerpt_by: picked.excerpt ? picked.model : "none" });
  } else if (!samePage) {
    Object.assign(fields, { excerpt: null, excerpt_at: null, excerpt_by: null });
  }
  await save(db, c.candidate_id, fields);
  return fields.excerpt ? "excerpt" : "found";
}

export async function syncCandidatePlatforms(env, db, budget, { pick = pickExcerpt } = {}) {
  const base = (env.SITE_URL || "").replace(/\/$/, "");
  if (!base) return { status: "skipped", message: "SITE_URL is not set" };
  const year = parseInt(env.CANDIDATE_YEAR || "2026", 10);
  const limit = parseInt(env.CANDIDATE_PLATFORMS_DAILY || "25", 10);
  const recheckDays = parseInt(env.CANDIDATE_PLATFORMS_RECHECK_DAYS || "30", 10);
  const dayKey = `candidate_platforms_${today()}`;
  let searched = parseInt((await getState(db, dayKey)) || "0", 10);
  if (searched >= limit) return { status: "skipped", message: `${searched} candidates' sites searched today (CANDIDATE_PLATFORMS_DAILY ${limit})` };

  let list;
  try {
    list = await budget.json(`${base}/data/candidates/${year}/websites.json`, {}, "candidate websites");
  } catch (err) {
    if (err instanceof BudgetExhausted) throw err;
    return { status: "skipped", message: `data/candidates/${year}/websites.json isn't published yet (${redact(err.message).slice(0, 80)})` };
  }
  let todo;
  try {
    await upsertCandidates(db, list.candidates || [], year);
    todo = await nextCandidates(db, { limit: limit - searched, recheckDays });
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!todo.length) return { status: "ok", message: `every candidate's site searched in the last ${recheckDays} days` };
  const tally = { excerpt: 0, found: 0, none: 0, error: 0 };
  try {
    for (const c of todo) {
      try {
        tally[await searchOne(env, db, budget, c, { pick })] += 1;
      } catch (err) {
        if (err instanceof BudgetExhausted) throw err;
        await save(db, c.candidate_id, { result: "error", note: redact(`${err.name}: ${err.message}`).slice(0, 300) });
        tally.error += 1;
      }
      searched += 1;
      await setState(db, dayKey, String(searched));
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary(tally)}; ${err.message}` };
  }
  return { status: "ok", message: summary(tally) };
}

const summary = (t) =>
  `${t.excerpt + t.found} issues page(s) found (${t.excerpt} with an excerpt), ${t.none} site(s) without one${t.error ? `, ${t.error} couldn't be read` : ""}`;
