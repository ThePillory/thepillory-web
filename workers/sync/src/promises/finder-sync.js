// The issues-pages step: for every official with a website on file, find
// their "Issues", "Priorities" or "On the Issues" page by following links from
// the site's home page (src/promises/finder.js), and list it in promise_pages
// as found automatically. The promises step then reads it like any listed page:
// an excerpt for "In their own words" on the Platform tab, and suggested
// commitments for review. See docs/promises.md.
//
// Order: Calaveras County's representatives first, then the rest of
// California's officials, then everyone else. Each official's site is searched
// again every ISSUES_PAGES_RECHECK_DAYS (90); a site that couldn't be read is
// tried again after 3 days. ISSUES_PAGES_DAILY (40) officials are searched a
// day. A page a person removed on the review page is never added again.
import { getState, setState, today, redact, BudgetExhausted, UpstreamError } from "../util.js";
import { issueLinks, issuesHeading, isIssuesPath, FALLBACK_PATHS, siteKey } from "./finder.js";
import { htmlToText } from "./sources.js";

const missing = (err) => /no such (table|column)/i.test(String(err && err.message));

/** Calaveras's own districts, recorded by the state-officials step. */
async function homeDistricts(db) {
  try {
    const d = JSON.parse((await getState(db, "home_districts")) || "{}");
    return { cd: d.cd || null, su: d.su || null, sl: d.sl || null };
  } catch {
    return { cd: null, su: null, sl: null };
  }
}

/** Officials to search next: Calaveras's reps, then California, then everyone else; never searched first. */
export async function nextOfficials(db, { limit, recheckDays, home }) {
  const { results } = await db
    .prepare(
      `SELECT o.id, o.name, o.website, o.chamber, o.state, o.district_code, c.checked_at, c.result,
         CASE
           WHEN o.chamber = 'county-board'
             OR (o.chamber = 'us-senate' AND o.state = 'CA')
             OR (o.chamber = 'us-house' AND o.state = 'CA' AND o.district_code = ?)
             OR (o.chamber = 'ca-senate' AND o.district_code = ?)
             OR (o.chamber = 'ca-assembly' AND o.district_code = ?) THEN 0
           WHEN o.state = 'CA' OR o.chamber IN ('ca-senate', 'ca-assembly', 'ca-executive') THEN 1
           ELSE 2
         END AS tier
       FROM officials o LEFT JOIN issues_page_checks c ON c.official_id = o.id AND c.site_kind = 'office_site'
       WHERE o.active = 1 AND (
         c.checked_at IS NULL
         OR c.checked_at < datetime('now', ?)
         OR (c.result = 'error' AND c.checked_at < datetime('now', '-3 days')))
       ORDER BY tier, c.checked_at IS NOT NULL, c.checked_at, o.name
       LIMIT ?`
    )
    .bind(home.cd || "", home.su || "", home.sl || "", `-${recheckDays} days`, limit)
    .all();
  return results;
}

/** One fetch, or null on a 4xx (a missing page is an answer, not an error). */
async function page(budget, url, label) {
  try {
    const res = await budget.fetch(url, { headers: { Accept: "text/html,*/*" } }, label);
    const html = await res.text();
    return { url: res.url || url, html };
  } catch (err) {
    if (err instanceof UpstreamError && err.status >= 400 && err.status < 500) return null;
    throw err;
  }
}

/**
 * Search one site: the home page's links that name an issues page (at most
 * two followed), then the usual addresses. The page counts only when its own
 * heading or title names Issues, Priorities or Platform.
 */
export async function findOnSite(budget, siteUrl) {
  const host = siteKey(siteUrl) || "site";
  const home = await page(budget, siteUrl, `${host} home page`);
  if (!home) return { found: null, note: "the home page wasn't found (4xx)" };
  const tried = new Set();
  for (const l of issueLinks(home.html, home.url).slice(0, 2)) {
    tried.add(l.url);
    const p = await page(budget, l.url, `${host} ${l.text || "issues"} link`);
    if (!p) continue;
    const textLength = htmlToText(p.html).length;
    const heading = issuesHeading(p.html, textLength);
    if (heading) return { found: { url: p.url, title: heading }, note: `linked from the home page as "${l.text}"` };
    // A link named "Issues" (or "Priorities") to an /issues address is the page, whatever its heading says.
    if (l.score >= 100 && isIssuesPath(p.url) && textLength >= 300) return { found: { url: p.url, title: l.text.slice(0, 120) }, note: `linked from the home page as "${l.text}"` };
  }
  for (const path of FALLBACK_PATHS) {
    const u = new URL(path, home.url).href;
    if (tried.has(u)) continue;
    const p = await page(budget, u, `${host}${path}`);
    if (!p || siteKey(p.url) !== siteKey(home.url)) continue;
    const heading = issuesHeading(p.html, htmlToText(p.html).length);
    if (heading) return { found: { url: p.url, title: heading }, note: `at ${path} on the site` };
  }
  return { found: null, note: tried.size ? "links tried didn't lead to an issues page" : "no link to an issues page on the home page" };
}

async function record(db, o, kind, siteUrl, result, pageUrl, note) {
  await db
    .prepare(
      `INSERT INTO issues_page_checks (official_id, site_kind, site_url, result, page_url, note, checked_at) VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
       ON CONFLICT (official_id, site_kind) DO UPDATE SET site_url = excluded.site_url, result = excluded.result, page_url = excluded.page_url, note = excluded.note, checked_at = excluded.checked_at`
    )
    .bind(o.id, kind, siteUrl, result, pageUrl, note ? String(note).slice(0, 300) : null)
    .run();
}

export async function syncIssuesPages(env, db, budget) {
  const limit = parseInt(env.ISSUES_PAGES_DAILY || "40", 10);
  const recheckDays = parseInt(env.ISSUES_PAGES_RECHECK_DAYS || "90", 10);
  const dayKey = `issues_pages_${today()}`;
  let searched = parseInt((await getState(db, dayKey)) || "0", 10);
  if (searched >= limit) return { status: "skipped", message: `${searched} officials' sites searched today (ISSUES_PAGES_DAILY ${limit})` };
  let todo;
  try {
    todo = await nextOfficials(db, { limit: limit - searched, recheckDays, home: await homeDistricts(db) });
  } catch (err) {
    if (missing(err)) return { status: "skipped", message: "tables not created yet" };
    throw err;
  }
  if (!todo.length) return { status: "ok", message: "every official's site searched recently" };
  // A site several officials share (an agency's home page) isn't anyone's own page.
  const shared = new Map();
  for (const r of (await db.prepare("SELECT website, COUNT(*) AS n FROM officials WHERE active = 1 AND website IS NOT NULL GROUP BY website").all()).results) shared.set(r.website, r.n);
  const tally = { found: 0, none: 0, no_website: 0, error: 0, listed: 0 };
  const found = [];
  try {
    for (const o of todo) {
      const site = o.website && /^https?:\/\//.test(o.website) ? o.website : null;
      if (!site) {
        await record(db, o, "office_site", null, "no_website", null, "no website on file");
        tally.no_website += 1;
      } else if ((shared.get(site) || 0) > 1) {
        await record(db, o, "office_site", site, "none", null, "the website on file is shared by several officials");
        tally.none += 1;
      } else {
        // A page a person already listed for this official counts as found.
        const listed = await db.prepare("SELECT url FROM promise_pages WHERE official_id = ? AND kind = 'office_site' LIMIT 1").bind(o.id).first();
        if (listed) {
          await record(db, o, "office_site", site, "found", listed.url, "listed on the review page");
          tally.listed += 1;
        } else {
          let r;
          try {
            r = await findOnSite(budget, site);
          } catch (err) {
            if (err instanceof BudgetExhausted) throw err;
            await record(db, o, "office_site", site, "error", null, redact(`${err.name}: ${err.message}`));
            tally.error += 1;
            searched += 1;
            await setState(db, dayKey, String(searched));
            continue;
          }
          const removed = r.found && (await db.prepare("SELECT 1 FROM promise_pages_removed WHERE url = ?").bind(r.found.url).first());
          if (r.found && !removed) {
            await db
              .prepare("INSERT OR IGNORE INTO promise_pages (url, official_id, kind, title, added_by, found_by) VALUES (?, ?, 'office_site', ?, 'Found automatically', 'auto')")
              .bind(r.found.url, o.id, r.found.title)
              .run();
            await record(db, o, "office_site", site, "found", r.found.url, r.note);
            tally.found += 1;
            found.push(o.name);
          } else {
            await record(db, o, "office_site", site, "none", null, removed ? "the page found was removed on the review page" : r.note);
            tally.none += 1;
          }
        }
      }
      searched += 1;
      await setState(db, dayKey, String(searched));
    }
  } catch (err) {
    if (!(err instanceof BudgetExhausted)) throw err;
    return { status: "partial", message: `${summary(tally)}; ${err.message}` };
  }
  return { status: "ok", message: `${summary(tally)}${found.length ? `; found for ${found.slice(0, 8).join(", ")}${found.length > 8 ? ` and ${found.length - 8} more` : ""}` : ""}` };
}

const summary = (t) =>
  `${t.found} issues page(s) found, ${t.none} site(s) without one, ${t.no_website} official(s) with no website on file${t.listed ? `, ${t.listed} already listed` : ""}${t.error ? `, ${t.error} site(s) couldn't be read` : ""}`;
