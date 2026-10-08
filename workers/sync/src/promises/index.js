// Promises: AI proposes candidate promises from official documents; a person
// approves each on /admin/review/ before anything is public. See
// docs/promises.md.
//
//   1. Discover (once a day, no AI): new documents from each official's
//      sources (src/promises/sources.js), saved in promise_sources as pending.
//   2. Read (AI): a few documents a day, taking turns between officials so
//      no one's documents use up the day, newest first. Each candidate is
//      checked in code (src/promises/check.js): the quote must be in the
//      document word for word, the note neutral, the quote a commitment.
//   3. Save what passes as review = 'suggested'.
//
// Caps on cost: PROMISE_SUGGESTIONS_DAILY (default 10) new suggestions a day
// and PROMISE_DOCS_DAILY (default 15) documents read a day. Suggestions keep
// coming however many wait for review; the review page shows the count.
import { log } from "../db.js";
import { getState, setState, redact } from "../util.js";
import { structuredCall, DEFAULT_MODEL, DraftRefused } from "../analysis/claude.js";
import { INSTRUCTIONS, schema, documentMessage, PROMISE_PROMPT_VERSION, MAX_PER_DOCUMENT } from "./prompt.js";
import { checkCandidate, quoteKey } from "./check.js";
import { EXCERPT_INSTRUCTIONS, excerptSchema, excerptMessage, checkExcerpt, needsExcerpt } from "./excerpt.js";
import { parseRssWithContent, parseWpPosts, addressPackages, whiteHouseKind, worthReading, htmlToText, clip, roundRobin, commitmentScore } from "./sources.js";

const UA = "ThePillory/1.0 (+https://thepillory.co; civic records)";
const WH = "https://www.whitehouse.gov/";
const GOVCA = "https://www.gov.ca.gov/";
const GOVINFO = "https://api.govinfo.gov/";
const COUNTY_GROUP = "county-board"; // agenda documents belong to the whole Board
const today = () => new Date().toISOString().slice(0, 10);
const sha256 = async (text) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))].map((b) => b.toString(16).padStart(2, "0")).join("");

async function get(url, { json = false, timeoutMs = 30000 } = {}) {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: json ? "application/json" : "*/*" }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`${new URL(url).host}${new URL(url).pathname}: HTTP ${res.status}`);
  return json ? res.json() : res.text();
}

/**
 * The officials with their own document sources: the President (press releases,
 * addresses), the Governor (press releases, State of the State) and Calaveras's
 * supervisors (agendas). Everyone else with a Platform page (an Issues page in
 * promise_pages, found automatically or listed by a person) is tracked through
 * that page.
 */
export async function trackedOfficials(db) {
  const { results } = await db
    .prepare(
      `SELECT id, slug, name, office, chamber, rank, term_start FROM officials WHERE active = 1 AND (
         (chamber = 'us-executive' AND rank = 1) OR (chamber = 'ca-executive' AND rank = 1) OR chamber = 'county-board')`
    )
    .all();
  return {
    president: results.find((o) => o.chamber === "us-executive") || null,
    governor: results.find((o) => o.chamber === "ca-executive") || null,
    supervisors: results.filter((o) => o.chamber === "county-board"),
  };
}

async function addSource(db, doc, officialId) {
  const status = doc.text && worthReading(doc.title) ? "pending" : "skipped";
  const note = !doc.text ? "no text" : status === "skipped" ? "a list or announcement without commitments (by title)" : null;
  const r = await db
    .prepare(
      `INSERT OR IGNORE INTO promise_sources (url, official_id, kind, title, published_on, text, status, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(doc.url, officialId, doc.kind, doc.title.slice(0, 300), doc.published_on, status === "pending" ? clip(doc.text, 60000) : null, status, note)
    .run();
  return (r.meta && r.meta.changes) || 0;
}

/** Step 1: new documents from each tracked official's sources. Errors per source are logged, not thrown. */
export async function discover(env, db, officials) {
  const found = [];
  const errors = [];
  const tryIt = async (label, fn) => {
    try {
      found.push(`${label}: ${await fn()}`);
    } catch (err) {
      errors.push(`${label}: ${redact(`${err.name}: ${err.message}`)}`);
    }
  };
  const p = officials.president;
  if (p) {
    await tryIt("White House press releases", async () => {
      const backfilled = (await getState(db, "promises_wh_backfilled")) === "1";
      let n = 0;
      for (let page = 1; page <= (backfilled ? 1 : 3); page++) {
        const xml = await get(`${env.WH_BASE || WH}releases/feed/${page > 1 ? `?paged=${page}` : ""}`);
        for (const d of parseRssWithContent(xml, { origin: env.WH_BASE || WH, kind: whiteHouseKind })) n += await addSource(db, d, p.id);
      }
      await setState(db, "promises_wh_backfilled", "1");
      return `${n} new`;
    });
    await tryIt("White House remarks (inaugural address)", async () => {
      const xml = await get(`${env.WH_BASE || WH}remarks/feed/`);
      let n = 0;
      for (const d of parseRssWithContent(xml, { origin: env.WH_BASE || WH, kind: () => "address" })) {
        if (/inaugural address|joint address|state of the union/i.test(d.title)) n += await addSource(db, d, p.id);
      }
      return `${n} new`;
    });
    const key = env.GOVINFO_API_KEY || env.CONGRESS_API_KEY;
    if (key) {
      await tryIt("govinfo addresses (State of the Union, inaugural)", async () => {
        const since = (await getState(db, "promises_cpd_since")) || `${new Date().getUTCFullYear() - 2}-01-01T00:00:00Z`;
        const termStart = p.term_start && /^\d{4}-\d{2}-\d{2}/.test(p.term_start) ? p.term_start.slice(0, 10) : null;
        let url = `${env.GOVINFO_BASE || GOVINFO}collections/CPD/${since}?offsetMark=*&pageSize=1000&api_key=${key}`;
        let n = 0;
        for (let pages = 0; url && pages < 25; pages++) {
          const json = await get(url, { json: true, timeoutMs: 60000 });
          for (const pkg of addressPackages(json)) {
            // Only this President's term, when the term start is on record.
            if (termStart && pkg.published_on && pkg.published_on < termStart) continue;
            const exists = await db.prepare("SELECT 1 FROM promise_sources WHERE url = ?").bind(`https://www.govinfo.gov/app/details/${pkg.packageId}`).first();
            if (exists) continue;
            const htm = await get(`${env.GOVINFO_BASE || GOVINFO}packages/${pkg.packageId}/htm?api_key=${key}`, { timeoutMs: 60000 });
            n += await addSource(db, { url: `https://www.govinfo.gov/app/details/${pkg.packageId}`, title: pkg.title, published_on: pkg.published_on, kind: "address", text: htmlToText(htm) }, p.id);
          }
          url = json.nextPage ? `${json.nextPage}${json.nextPage.includes("api_key=") ? "" : `&api_key=${key}`}` : null;
        }
        await setState(db, "promises_cpd_since", `${today()}T00:00:00Z`);
        return `${n} new`;
      });
    }
  }
  const g = officials.governor;
  if (g) {
    await tryIt("Governor's press releases", async () => {
      const backfilled = (await getState(db, "promises_govca_backfilled")) === "1";
      let n = 0;
      for (let page = 1; page <= (backfilled ? 1 : 3); page++) {
        const json = await get(`${env.GOVCA_BASE || GOVCA}wp-json/wp/v2/posts?categories=17&per_page=20&page=${page}&_fields=id,date,link,title,content`, { json: true });
        for (const d of parseWpPosts(json, env.GOVCA_BASE || GOVCA)) n += await addSource(db, d, g.id);
      }
      await setState(db, "promises_govca_backfilled", "1");
      return `${n} new`;
    });
    await tryIt("Governor's State of the State addresses", async () => {
      const json = await get(`${env.GOVCA_BASE || GOVCA}wp-json/wp/v2/posts?search=${encodeURIComponent("State of the State")}&per_page=20&_fields=id,date,link,title,content`, { json: true });
      let n = 0;
      for (const d of parseWpPosts(json, env.GOVCA_BASE || GOVCA)) if (d.kind === "address") n += await addSource(db, d, g.id);
      return `${n} new`;
    });
  }
  await tryIt("Issues and priorities pages", async () => {
    const days = parseInt(env.PROMISE_PAGES_REFRESH_DAYS || "7", 10);
    const { results: pages } = await db
      .prepare(
        `SELECT p.url, p.official_id, p.kind, p.title, p.excerpt, p.excerpt_at, p.excerpt_by, o.name FROM promise_pages p JOIN officials o ON o.id = p.official_id
         WHERE o.active = 1 AND (p.fetched_at IS NULL OR p.fetched_at < datetime('now', ?)) ORDER BY p.fetched_at IS NOT NULL, p.fetched_at LIMIT ?`
      )
      .bind(`-${days} days`, parseInt(env.PROMISE_PAGES_DAILY || "25", 10))
      .all();
    let changed = 0;
    let failed = 0;
    const excerpts = [];
    for (const pg of pages) {
      let note;
      let hash = null;
      try {
        const text = clip(htmlToText(await get(pg.url)), 60000);
        hash = await sha256(text);
        await db.prepare("UPDATE promise_pages SET page_text = ? WHERE url = ?").bind(text, pg.url).run();
        // "In their own words" on the Platform tab: a new excerpt monthly, or when the old one left the page.
        if (needsExcerpt(pg, text)) {
          const picked = await pickExcerpt(env, { ...pg, text }, { name: pg.name });
          await db
            .prepare("UPDATE promise_pages SET excerpt = ?, excerpt_at = datetime('now'), excerpt_by = ? WHERE url = ?")
            .bind(picked.excerpt, picked.excerpt ? picked.model : "none", pg.url)
            .run();
          excerpts.push(`${pg.name}: ${picked.excerpt ? "excerpt updated" : `no excerpt (${picked.reason})`}`);
        }
        const before = await db.prepare("SELECT text_hash FROM promise_pages WHERE url = ?").bind(pg.url).first();
        if (before && before.text_hash === hash) note = "unchanged";
        else {
          // Read again from the top: the same page, with its new text. Promises already
          // suggested from it aren't suggested twice (one per official and quote).
          await db
            .prepare(
              `INSERT OR REPLACE INTO promise_sources (url, official_id, kind, title, published_on, text, status, note, first_seen)
               VALUES (?, ?, ?, ?, ?, ?, 'pending', NULL, datetime('now'))`
            )
            .bind(pg.url, pg.official_id, pg.kind, pg.title, today(), text)
            .run();
          changed += 1;
          note = before && before.text_hash ? "changed; to be read again" : "to be read";
        }
      } catch (err) {
        failed += 1;
        note = redact(`${err.name}: ${err.message}`).slice(0, 200);
      }
      await db
        .prepare("UPDATE promise_pages SET fetched_at = datetime('now'), text_hash = COALESCE(?, text_hash), note = ? WHERE url = ?")
        .bind(hash, note, pg.url)
        .run();
    }
    return `${pages.length} checked, ${changed} new or changed${failed ? `, ${failed} failed` : ""}${excerpts.length ? `; ${excerpts.join("; ")}` : ""}`;
  });
  if (officials.supervisors.length) {
    await tryIt("Board of Supervisors agendas", async () => {
      const { results: meetings } = await db
        .prepare(
          `SELECT m.id, m.starts_at, m.agenda_url FROM meetings m
           WHERE m.body = 'Board of Supervisors' AND m.agenda_url LIKE 'http%' AND m.starts_at >= date('now', '-60 days') AND m.starts_at <= date('now', '+1 day')
             AND EXISTS (SELECT 1 FROM meeting_items i WHERE i.meeting_id = m.id)`
        )
        .all();
      let n = 0;
      for (const m of meetings) {
        const items = (await db.prepare("SELECT number, title FROM meeting_items WHERE meeting_id = ? ORDER BY sort").bind(m.id).all()).results;
        const text = items.map((i) => `${i.number ? `${i.number}. ` : ""}${i.title}`).join("\n");
        n += await addSource(db, { url: m.agenda_url, title: `Board of Supervisors agenda, ${m.starts_at.slice(0, 10)}`, published_on: m.starts_at.slice(0, 10), kind: "agenda", text }, COUNTY_GROUP);
      }
      return `${n} new`;
    });
  }
  return { found, errors };
}

/** An excerpt for "In their own words", checked word for word against the page; never an error that stops the step. */
export async function pickExcerpt(env, page, official) {
  if (!env.ANTHROPIC_API_KEY) return { excerpt: null, reason: "no ANTHROPIC_API_KEY" };
  try {
    const { data, model } = await structuredCall(env, {
      model: env.PROMISE_MODEL || DEFAULT_MODEL,
      system: [EXCERPT_INSTRUCTIONS],
      message: excerptMessage(page, official),
      jsonSchema: excerptSchema,
      maxTokens: 2000,
    });
    return { ...checkExcerpt(page.text, data.excerpt), model };
  } catch (err) {
    return { excerpt: null, reason: redact(`${err.name}: ${err.message}`).slice(0, 120) };
  }
}

/** Step 2 and 3 for one document: candidates from the AI, checked, saved as suggested. */
export async function readDocument(env, db, doc, speakers, room) {
  const names = speakers.map((o) => o.name);
  const { data, model, usage } = await structuredCall(env, {
    model: env.PROMISE_MODEL || DEFAULT_MODEL,
    system: [INSTRUCTIONS],
    message: documentMessage(doc, speakers),
    jsonSchema: schema(names),
    maxTokens: 4000,
  });
  const kept = [];
  const dropped = [];
  for (const c of (data.promises || []).slice(0, MAX_PER_DOCUMENT)) {
    const speaker = speakers.find((o) => o.name === c.speaker);
    if (!speaker) {
      dropped.push("speaker not in the list");
      continue;
    }
    const checked = checkCandidate(c, doc.text);
    if (!checked.ok) {
      dropped.push(checked.reason);
      continue;
    }
    // On a county agenda, the supervisor must be named in the document itself.
    if (doc.kind === "agenda" || doc.kind === "minutes") {
      const last = speaker.name.split(/\s+/).pop().toLowerCase();
      if (!doc.text.toLowerCase().includes(last)) {
        dropped.push("supervisor not named in the document");
        continue;
      }
    }
    if (kept.length >= room) {
      dropped.push("over today's suggestion cap");
      continue;
    }
    const r = await db
      .prepare(
        `INSERT OR IGNORE INTO promises (official_id, quote, quote_key, made_on, source_url, source_title, source_kind, check_note, due, suggested_by, prompt_version)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(speaker.id, checked.quote, quoteKey(checked.quote), doc.published_on || today(), doc.url, doc.title, doc.kind, checked.check_note, checked.due, model, PROMISE_PROMPT_VERSION)
      .run();
    if (r.meta && r.meta.changes) kept.push(speaker.name);
    else dropped.push("already suggested");
  }
  return { kept, dropped, model, usage };
}

export async function runPromises(env, db, { run, deadline }) {
  const started = new Date().toISOString();
  if (!env.ANTHROPIC_API_KEY) return { suggested: 0 };
  const officials = await trackedOfficials(db);
  const anyPages = await db.prepare("SELECT 1 FROM promise_pages LIMIT 1").first().catch(() => null);
  if (!officials.president && !officials.governor && !officials.supervisors.length && !anyPages) return { suggested: 0 };

  // 1. Discover, once a day.
  const dayKey = `promises_discovered_${today()}`;
  if (!(await getState(db, dayKey))) {
    const { found, errors } = await discover(env, db, officials);
    await setState(db, dayKey, "1");
    await log(db, run, "promise-sources", errors.length ? (found.length ? "partial" : "error") : "ok", 0, [...found, ...errors].join("; ") || "no sources", started);
  }

  // 2. Read, within the caps.
  const sugLimit = parseInt(env.PROMISE_SUGGESTIONS_DAILY || "10", 10);
  const docLimit = parseInt(env.PROMISE_DOCS_DAILY || "15", 10);
  const sugKey = `promise_suggestions_${today()}`;
  const docKey = `promise_docs_${today()}`;
  let suggested = parseInt((await getState(db, sugKey)) || "0", 10);
  let read = parseInt((await getState(db, docKey)) || "0", 10);
  if (suggested >= sugLimit || read >= docLimit) return { suggested: 0 };
  const { results: all } = await db.prepare("SELECT url, official_id, kind, title, published_on, text FROM promise_sources WHERE status = 'pending'").all();
  // Before any AI reads them: documents with no sentence that commits to anything are skipped.
  const pending = [];
  const none = [];
  for (const d of all) {
    const score = commitmentScore(d);
    if (score) pending.push({ ...d, score });
    else none.push(d);
  }
  for (let i = 0; i < none.length; i += 50) {
    await db.batch(
      none.slice(i, i + 50).map((d) =>
        db.prepare("UPDATE promise_sources SET status = 'skipped', note = 'no sentence committing to an action (will, plan to, by a date…)', text = NULL, read_at = datetime('now') WHERE url = ?").bind(d.url)
      )
    );
  }
  if (none.length) await log(db, run, "promises", "ok", 0, `${none.length} document(s) skipped without AI: no sentence committing to an action (will, plan to, by a date…); ${pending.length} left to read`, started);
  const todo = roundRobin(pending, docLimit - read);
  // The speaker: the Board for an agenda; otherwise the official the source belongs to
  // (the President, the Governor, or whoever an Issues page was listed for).
  const others = new Map();
  for (const id of new Set(todo.map((d) => d.official_id))) {
    if (id === COUNTY_GROUP || [officials.president, officials.governor].some((o) => o && o.id === id)) continue;
    const o = await db.prepare("SELECT id, slug, name, office, chamber, rank, term_start FROM officials WHERE id = ? AND active = 1").bind(id).first();
    if (o) others.set(id, o);
  }
  const speakersFor = (doc) =>
    doc.official_id === COUNTY_GROUP
      ? officials.supervisors
      : [officials.president, officials.governor, others.get(doc.official_id)].filter((o) => o && o.id === doc.official_id);
  let added = 0;
  for (const doc of todo) {
    if (suggested >= sugLimit || read >= docLimit) break;
    if (deadline - Date.now() < 2 * 60 * 1000) break;
    const t0 = new Date().toISOString();
    const speakers = speakersFor(doc);
    let status = "ok";
    let message;
    let found = 0;
    try {
      if (!speakers.length) throw new Error("no current official for this source");
      const r = await readDocument(env, db, doc, speakers, sugLimit - suggested);
      found = r.kept.length;
      suggested += found;
      added += found;
      message = `${doc.title} (${doc.url}): ${found} suggested${r.dropped.length ? `; dropped ${r.dropped.length} (${[...new Set(r.dropped)].join("; ")})` : ""}; model ${r.model}; tokens in ${r.usage.input_tokens}, out ${r.usage.output_tokens}`;
      await db.prepare("UPDATE promise_sources SET status = 'read', found = ?, note = ?, text = NULL, read_at = datetime('now') WHERE url = ?").bind(found, r.dropped.length ? [...new Set(r.dropped)].join("; ").slice(0, 300) : null, doc.url).run();
    } catch (err) {
      status = err instanceof DraftRefused ? "skipped" : "error";
      message = `${doc.title} (${doc.url}): ${redact(`${err.name}: ${err.message}`)}`;
      await db.prepare("UPDATE promise_sources SET status = 'failed', note = ?, read_at = datetime('now') WHERE url = ?").bind(message.slice(0, 300), doc.url).run();
    }
    read += 1;
    await setState(db, sugKey, String(suggested));
    await setState(db, docKey, String(read));
    await log(db, run, "promises", status, 1, message, t0);
  }
  return { suggested: added, read: todo.length };
}
