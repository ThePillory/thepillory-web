// Data source health and protection, the sync's last three steps (see
// docs/data-sync.md, "Source health"):
//
//   source-health    once a day: for every source in src/health/sources.js, did it
//                    run, is it fresh, did its shape change, do re-fetched records
//                    still match (HEALTH_SPOT_CHECKS per source), and LINK_CHECKS_DAILY
//                    random stored source links still open. Writes source_health and
//                    source_links; emails ALERT_TO (the ALERT_EMAIL binding) only when
//                    a source is yellow or red, at most once a day.
//   archive-sources  new source links saved to the Internet Archive (Save Page Now),
//                    ARCHIVE_DAILY a day, paced; an existing Wayback copy is used when
//                    there is one.
//   source-copies    ThePillory's own copy of key documents (financial disclosures,
//                    trade reports, agendas, earmark tables, travel reports) in the R2
//                    bucket bound as SOURCES, SOURCE_COPIES_DAILY a day, up to
//                    SOURCE_COPY_MAX_MB each.
//
// All three stop at their caps and at the round's request budget, so they never
// crowd out the regular sync, and none of them changes a record.
import { SOURCES } from "./sources.js";
import { evaluate, spotVerdict, linkGone, alertEmail, mimeMessage, sinceDay } from "./check.js";
import { getState, setState, redact } from "../util.js";

const int = (v, d) => {
  const n = parseInt(v ?? "", 10);
  return Number.isFinite(n) ? n : d;
};
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const UA = "ThePilloryDataSync/1.0 (+https://thepillory.co; source health check)";
const day = () => new Date().toISOString().slice(0, 10);
const ph = (a) => a.map(() => "?").join(",");

async function first(db, sql, ...args) {
  try {
    return await db.prepare(sql).bind(...args).first();
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

async function all(db, sql, ...args) {
  try {
    return (await db.prepare(sql).bind(...args).all()).results;
  } catch (err) {
    if (missing(err)) return [];
    throw err;
  }
}

/** One request outside the usual retries: {status, contentType, body?}; status 0 when there was no answer. Counts against the budget. */
async function probe(budget, url, { method = "GET", wantBody = false, timeoutMs = 20000 } = {}) {
  budget.take(`health ${method} ${redact(url).slice(0, 80)}`);
  try {
    const res = await (budget.fetchImpl || fetch)(url, { method, redirect: "follow", headers: { "User-Agent": UA }, signal: AbortSignal.timeout(timeoutMs) });
    const contentType = res.headers.get("content-type") || "";
    let body = "";
    if (wantBody && /text|json|xml|html/i.test(contentType)) body = (await res.text()).slice(0, 2_000_000);
    else if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
    return { status: res.status, contentType, body, headers: res.headers };
  } catch (err) {
    // No such host, a refused connection: gone. A timeout: unknown.
    return { status: err && err.name === "TimeoutError" ? 599 : 0, contentType: "", body: "", error: String(err && err.message) };
  }
}

/** Up to n random rows of a table (by random rowids, so no full scan). */
async function randomRows(db, table, where, cols, n) {
  const max = await first(db, `SELECT MAX(rowid) AS m FROM ${table}`);
  if (!max || !max.m) return [];
  const out = new Map();
  for (let i = 0; i < n * 3 && out.size < n; i++) {
    const at = 1 + Math.floor(Math.random() * max.m); // rowids start at 1
    const row = await first(db, `SELECT rowid AS _r, ${cols} FROM ${table} WHERE rowid >= ?${where ? ` AND (${where})` : ""} ORDER BY rowid LIMIT 1`, at);
    if (row) out.set(row._r, row);
  }
  return [...out.values()];
}

async function upsertLink(db, url, source, fields) {
  const cols = Object.keys(fields);
  await db
    .prepare(`INSERT INTO source_links (url, source, ${cols.join(", ")}) VALUES (?, ?, ${ph(cols)})
              ON CONFLICT(url) DO UPDATE SET source = COALESCE(source_links.source, excluded.source), ${cols.map((c) => `${c} = excluded.${c}`).join(", ")}`)
    .bind(url, source, ...cols.map((c) => fields[c]))
    .run();
}

// ---------------------------------------------------------------------------
// GitHub Actions workflows

async function workflowRuns(env, budget, file) {
  const repo = env.GITHUB_REPO || "ThePillory/thepillory-web";
  budget.take(`workflow ${file}`);
  try {
    const res = await (budget.fetchImpl || fetch)(`https://api.github.com/repos/${repo}/actions/workflows/${file}/runs?per_page=10&status=completed`, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json", ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {}) },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return { error: `GitHub API ${res.status}${res.status === 404 || res.status === 401 ? " (set GITHUB_TOKEN for a private repository)" : ""}` };
    const runs = ((await res.json()).workflow_runs || []).filter((r) => r.event !== "push");
    const latest = runs[0];
    const ok = runs.find((r) => r.conclusion === "success");
    return latest ? { conclusion: latest.conclusion, at: latest.updated_at, lastOk: ok ? ok.updated_at : null } : { conclusion: null };
  } catch (err) {
    return { error: String(err && err.message) };
  }
}

// ---------------------------------------------------------------------------
// The daily check

async function facts(env, db, budget, s, now) {
  const f = { source: s, now, everRan: false, lastOk: null, workflow: null, rows: null, latest: null, history: [], nullRows: 0, stepErrors: [], spot: {}, deadLinks: 0, notes: [] };
  if (s.steps && s.steps.length) {
    const r = await first(db, `SELECT MAX(CASE WHEN status IN ('ok', 'partial') THEN finished_at END) AS ok, COUNT(*) AS n FROM sync_log WHERE step IN (${ph(s.steps)})`, ...s.steps);
    f.everRan = !!(r && r.n);
    f.lastOk = r && r.ok ? r.ok : null;
    // Today's errors, the latest per step (a step that recovered later today isn't counted).
    const errs = await all(db, `SELECT step, status, message FROM sync_log WHERE step IN (${ph(s.steps)}) AND started_at >= ? ORDER BY id DESC`, ...s.steps, `${day()}T00:00`);
    const seen = new Set();
    for (const e of errs) {
      if (seen.has(e.step)) continue;
      seen.add(e.step);
      if (e.status === "error") f.stepErrors.push(`${e.step}: ${e.message || "error"}`);
    }
  }
  if (s.workflow) {
    const w = await workflowRuns(env, budget, s.workflow);
    if (w.error) f.notes.push(`Workflow not checked: ${w.error}`);
    else {
      f.workflow = w;
      if (w.conclusion) f.everRan = true;
      if (w.lastOk && (!f.lastOk || w.lastOk > f.lastOk)) f.lastOk = w.lastOk;
    }
  }
  if (s.table) {
    const r = await first(db, `SELECT COUNT(*) AS n${s.latest ? `, ${s.latest} AS latest` : ""} FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ""}`);
    if (r) {
      f.rows = r.n;
      f.latest = r.latest || null;
    }
    if (s.nulls && s.nulls.length && f.rows) {
      const n = await first(db, `SELECT COUNT(*) AS n FROM (SELECT ${s.nulls.join(", ")} FROM ${s.table}${s.where ? ` WHERE ${s.where}` : ""} ORDER BY rowid DESC LIMIT 50) WHERE ${s.nulls.map((c) => `${c} IS NULL OR ${c} = ''`).join(" OR ")}`);
      f.nullRows = n ? n.n : 0;
    }
  }
  f.history = (await all(db, "SELECT rows FROM source_health WHERE source = ? AND day < ? AND rows IS NOT NULL ORDER BY day DESC LIMIT 7", s.id, day())).map((r) => r.rows);
  const dead = await first(db, "SELECT COUNT(*) AS n FROM source_links WHERE source = ? AND dead_checks >= 2", s.id);
  f.deadLinks = dead ? dead.n : 0;
  // Accuracy: re-fetch a few records and look for what's stored.
  if (s.sample && f.rows) {
    const n = int(env.HEALTH_SPOT_CHECKS, 5);
    const rows = await randomRows(db, s.sample.table, s.sample.where, `${s.sample.url} AS url${s.sample.expect ? `, ${s.sample.expect} AS expect` : ""}`, n);
    for (const row of rows) {
      if (!row.url) continue;
      const got = await probe(budget, row.url, { wantBody: true });
      const v = spotVerdict(got, row.expect);
      f.spot[v] = (f.spot[v] || 0) + 1;
    }
  }
  return f;
}

/** Up to LINK_CHECKS_DAILY random stored source links, spread across the sources, checked with HEAD (GET when HEAD isn't allowed). */
async function checkLinks(env, db, budget) {
  const total = int(env.LINK_CHECKS_DAILY, 100);
  const withLinks = SOURCES.filter((s) => s.links);
  if (!withLinks.length || total <= 0) return { checked: 0, gone: 0 };
  const per = Math.max(1, Math.ceil(total / withLinks.length));
  let checked = 0;
  let gone = 0;
  for (const s of withLinks) {
    if (checked >= total || budget.remaining() < 20) break;
    const rows = await randomRows(db, s.links.table, s.links.where, `${s.links.url} AS url`, Math.min(per, total - checked));
    for (const { url } of rows) {
      if (!/^https?:\/\//.test(url || "")) continue;
      let got = await probe(budget, url, { method: "HEAD", timeoutMs: 15000 });
      if ([403, 405, 501].includes(got.status)) got = await probe(budget, url, { timeoutMs: 15000 });
      checked += 1;
      const isGone = linkGone(got.status);
      gone += isGone;
      const prev = await first(db, "SELECT dead_checks, first_dead FROM source_links WHERE url = ?", url);
      await upsertLink(db, url, s.id, {
        status: got.status,
        checked_at: new Date().toISOString(),
        dead_checks: isGone ? ((prev && prev.dead_checks) || 0) + 1 : 0,
        first_dead: isGone ? (prev && prev.first_dead) || day() : null,
      });
    }
  }
  return { checked, gone };
}

async function sendAlert(env, msg) {
  if (!env.ALERT_EMAIL) return "not sent: the ALERT_EMAIL binding isn't set up (docs/data-sync.md)";
  const from = env.ALERT_FROM || "data-health@thepillory.co";
  const to = env.ALERT_TO;
  if (!to) return "not sent: ALERT_TO isn't set";
  const { EmailMessage } = await import("cloudflare:email");
  await env.ALERT_EMAIL.send(new EmailMessage(from, to, mimeMessage({ from, to, subject: msg.subject, body: msg.body })));
  return `sent to ${to}`;
}

export async function syncSourceHealth(env, db, budget) {
  const today = day();
  if ((await getState(db, "health_done")) === today) return { status: "skipped", message: "already checked today" };
  if (!(await first(db, "SELECT 1 AS x FROM sqlite_master WHERE name = 'source_health'"))) return { status: "skipped", message: "migration 0034 not applied yet" };
  // The link checks first, so today's dead links count in the sources' status.
  const links = await checkLinks(env, db, budget);
  const now = new Date().toISOString();
  const results = [];
  for (const s of SOURCES) {
    const f = await facts(env, db, budget, s, now);
    const { status, problems } = evaluate(f);
    for (const n of f.notes) problems.push({ level: "note", check: "note", text: n });
    const yesterday = await first(db, "SELECT rows FROM source_health WHERE source = ? AND day < ? ORDER BY day DESC LIMIT 1", s.id, today);
    await db
      .prepare(`INSERT OR REPLACE INTO source_health (day, source, status, last_ok, latest, rows, rows_added, problems, checked_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`)
      .bind(today, s.id, status, f.lastOk, f.latest, f.rows, f.rows != null && yesterday && yesterday.rows != null ? f.rows - yesterday.rows : null, JSON.stringify(problems))
      .run();
    const history = await all(db, "SELECT day, status FROM source_health WHERE source = ? ORDER BY day DESC LIMIT 30", s.id);
    results.push({ source: s, status, problems, since: sinceDay(history, today) });
  }
  await setState(db, "health_done", today);
  const counts = results.reduce((c, r) => ({ ...c, [r.status]: (c[r.status] || 0) + 1 }), {});
  let mail = "no email: every source is healthy";
  const msg = alertEmail(results, today, env.SITE_URL || "https://thepillory.co");
  if (msg) {
    if (await first(db, "SELECT 1 AS x FROM health_alerts WHERE day = ?", today)) mail = "email already sent today";
    else {
      try {
        mail = await sendAlert(env, msg);
        if (/^sent/.test(mail)) await db.prepare("INSERT OR REPLACE INTO health_alerts (day, summary) VALUES (?, ?)").bind(today, msg.subject).run();
      } catch (err) {
        mail = `email failed: ${redact(String(err && err.message))}`;
      }
    }
  }
  return {
    status: "ok",
    message: `${SOURCES.length} sources: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(", ")}; ${links.checked} links checked, ${links.gone} gone; ${mail}`,
  };
}

// ---------------------------------------------------------------------------
// The Internet Archive

/** Newest stored links of each source not yet archived (or copied), round-robin across sources. */
async function pending(db, kind, perSource) {
  const spec = (s) => (kind === "copy" ? s.copies : s.links);
  const lists = [];
  for (const s of SOURCES.filter(spec)) {
    const { table, url, where } = spec(s);
    const rows = await all(db, `SELECT DISTINCT ${url} AS url FROM ${table} WHERE ${url} LIKE 'http%'${where ? ` AND (${where})` : ""} ORDER BY rowid DESC LIMIT ?`, perSource * 4);
    const urls = rows.map((r) => r.url);
    if (!urls.length) continue;
    const known = new Map();
    for (let i = 0; i < urls.length; i += 80) {
      const part = urls.slice(i, i + 80);
      for (const r of await all(db, `SELECT url, archive_url, archive_tries, copy_key, copy_tries FROM source_links WHERE url IN (${ph(part)})`, ...part)) known.set(r.url, r);
    }
    const todo = urls.filter((u) => {
      const k = known.get(u);
      if (kind === "copy") return !k || (!k.copy_key && (k.copy_tries || 0) < 3);
      return !k || (!k.archive_url && (k.archive_tries || 0) < 3);
    });
    lists.push(todo.slice(0, perSource).map((u) => ({ url: u, source: s.id })));
  }
  const out = [];
  for (let i = 0; lists.some((l) => l[i]); i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

export async function syncArchiveSources(env, db, budget) {
  const cap = int(env.ARCHIVE_DAILY, 100);
  if (cap <= 0) return { status: "skipped", message: "ARCHIVE_DAILY is 0" };
  if (!(await first(db, "SELECT 1 AS x FROM sqlite_master WHERE name = 'source_links'"))) return { status: "skipped", message: "migration 0034 not applied yet" };
  const key = `archive_count_${day()}`;
  let done = int(await getState(db, key), 0);
  if (done >= cap) return { status: "ok", message: `daily limit (${cap}) reached` };
  const todo = await pending(db, "archive", Math.ceil(cap / 4));
  const gap = int(env.ARCHIVE_INTERVAL_MS, 6000);
  let saved = 0;
  let found = 0;
  let failed = 0;
  for (const { url, source } of todo) {
    if (done >= cap) break;
    if (budget.remaining() < 10 || budget.timeLeft() < gap + 70000) return { status: "partial", message: `stopped at the round's budget: ${found} found in the Archive, ${saved} saved, ${failed} failed` };
    done += 1;
    await setState(db, key, String(done));
    // An existing Wayback copy first; otherwise ask the Archive to save one now.
    const avail = await probe(budget, `https://archive.org/wayback/available?url=${encodeURIComponent(url)}`, { wantBody: true, timeoutMs: 20000 });
    let archive = null;
    try {
      const snap = avail.status === 200 && JSON.parse(avail.body || "{}").archived_snapshots;
      if (snap && snap.closest && snap.closest.available) archive = String(snap.closest.url).replace(/^http:/, "https:");
    } catch (_) {}
    if (archive) found += 1;
    else {
      await new Promise((r) => setTimeout(r, gap));
      const save = await probe(budget, `https://web.archive.org/save/${url}`, { timeoutMs: 60000 });
      const loc = save.headers && (save.headers.get("content-location") || "");
      if (save.status >= 200 && save.status < 400) {
        archive = loc && loc.startsWith("/web/") ? `https://web.archive.org${loc}` : `https://web.archive.org/web/${url}`;
        saved += 1;
      } else failed += 1;
    }
    const prev = await first(db, "SELECT archive_tries FROM source_links WHERE url = ?", url);
    await upsertLink(db, url, source, archive ? { archive_url: archive, archived_at: new Date().toISOString() } : { archive_tries: ((prev && prev.archive_tries) || 0) + 1 });
  }
  return { status: "ok", message: `${found} found in the Archive, ${saved} saved, ${failed} failed (${done} of ${cap} today)` };
}

// ---------------------------------------------------------------------------
// Our own copies (R2)

async function sha256(s) {
  const b = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

const EXT = { "application/pdf": ".pdf", "text/html": ".html", "application/xml": ".xml", "text/xml": ".xml", "application/json": ".json", "text/plain": ".txt" };

export async function syncSourceCopies(env, db, budget) {
  if (!env.SOURCES) return { status: "skipped", message: "no R2 bucket bound as SOURCES yet (docs/data-sync.md)" };
  const cap = int(env.SOURCE_COPIES_DAILY, 50);
  const maxBytes = int(env.SOURCE_COPY_MAX_MB, 30) * 1024 * 1024;
  if (cap <= 0) return { status: "skipped", message: "SOURCE_COPIES_DAILY is 0" };
  const key = `copies_count_${day()}`;
  let done = int(await getState(db, key), 0);
  if (done >= cap) return { status: "ok", message: `daily limit (${cap}) reached` };
  const todo = await pending(db, "copy", Math.ceil(cap / 3));
  let saved = 0;
  let skipped = 0;
  let bytes = 0;
  for (const { url, source } of todo) {
    if (done >= cap) break;
    if (budget.remaining() < 10 || budget.timeLeft() < 60000) return { status: "partial", message: `stopped at the round's budget: ${saved} saved` };
    done += 1;
    await setState(db, key, String(done));
    budget.take(`copy ${redact(url).slice(0, 80)}`);
    const prev = await first(db, "SELECT copy_tries FROM source_links WHERE url = ?", url);
    const fail = () => upsertLink(db, url, source, { copy_tries: ((prev && prev.copy_tries) || 0) + 1 });
    try {
      const res = await (budget.fetchImpl || fetch)(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(60000) });
      const size = parseInt(res.headers.get("content-length") || "0", 10);
      if (!res.ok || size > maxBytes) {
        if (res.body && res.body.cancel) await res.body.cancel().catch(() => {});
        skipped += 1;
        await fail();
        continue;
      }
      const body = await res.arrayBuffer();
      if (body.byteLength > maxBytes || body.byteLength === 0) {
        skipped += 1;
        await fail();
        continue;
      }
      const type = (res.headers.get("content-type") || "application/octet-stream").split(";")[0].trim();
      const k = `sources/${await sha256(url)}${EXT[type] || ""}`;
      const at = new Date().toISOString();
      await env.SOURCES.put(k, body, { httpMetadata: { contentType: type }, customMetadata: { source_url: url, downloaded_at: at } });
      await upsertLink(db, url, source, { copy_key: k, copy_type: type, copy_bytes: body.byteLength, copied_at: at });
      saved += 1;
      bytes += body.byteLength;
    } catch (err) {
      skipped += 1;
      await fail();
    }
  }
  return { status: "ok", message: `${saved} saved (${Math.round(bytes / 1024 / 1024)} MB), ${skipped} skipped (${done} of ${cap} today)` };
}
