// Source health rules, pure and tested (test/health.test.mjs). src/health/sync.js
// gathers the facts; these decide green, yellow or red, and write the alert.
//
//   red     no successful pull in twice the expected interval (or ever, once set up);
//           the loading workflow's last run failed; rows fell to 0;
//           a step's error says the source is gone (404, 410);
//           most re-fetched records no longer match what's stored.
//   yellow  no successful pull in the expected interval; the newest record is older
//           than expected (Congress: not counted during a recess); rows fell by more
//           than half against the usual count; refused requests (403); recent rows
//           missing fields they always have; a record that no longer matches; dead links.
//   unknown not set up yet (no rows and no runs), or nothing to measure.

const DAY = 86400000;
export const LEVELS = ["green", "unknown", "yellow", "red"];
const worse = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);
const days = (from, to) => (from ? (Date.parse(to) - Date.parse(from)) / DAY : Infinity);

/**
 * True when Congress is usually away: August, the weeks around the new year,
 * and an election year's October (the House and Senate mostly recess to campaign).
 * Roll call votes aren't expected then, so their age isn't flagged.
 */
export function congressRecess(date) {
  const d = new Date(date);
  const m = d.getUTCMonth() + 1;
  const day = d.getUTCDate();
  if (m === 8) return true;
  if ((m === 12 && day >= 20) || (m === 1 && day <= 6)) return true;
  if (m === 10 && d.getUTCFullYear() % 2 === 0) return true;
  if (m === 9 && day <= 7) return true; // the end of the August recess
  return false;
}

/** The usual count: the median of the last week's counts. */
export function usual(counts) {
  const c = counts.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!c.length) return null;
  const mid = Math.floor(c.length / 2);
  return c.length % 2 ? c[mid] : (c[mid - 1] + c[mid]) / 2;
}

/** Letters and digits only, lowercase: so markup, quotes and spacing don't matter when comparing text. */
export function alnum(s) {
  return String(s || "")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/&(amp|#39|quot|apos|nbsp);/g, " ")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * A re-fetched record against what's stored: "ok", "mismatch", "gone" or
 * "unverifiable" (refused, a rate limit, a document that isn't text).
 */
export function spotVerdict({ status, contentType = "", body = "" }, expect) {
  if (status === 404 || status === 410) return "gone";
  if (status === 0) return "gone";
  if (status < 200 || status >= 300) return "unverifiable";
  if (!expect || !/text|json|xml|html/i.test(contentType)) return "ok";
  const want = alnum(expect).slice(0, 60);
  if (want.length < 6) return "ok";
  return alnum(body).includes(want) ? "ok" : "mismatch";
}

/** A link check's status → is the page gone? (404, 410, or no such host). A refusal (401, 403, 429) or a server error isn't. */
export function linkGone(status) {
  return status === 404 || status === 410 || status === 0;
}

/**
 * One source's status for today, from the facts gathered:
 *   {source, now, setUp, lastOk, everRan, workflow: {conclusion, at} | null,
 *    rows, history: [counts of the last 7 days], latest, nullRows,
 *    stepErrors: [messages], spot: {ok, mismatch, gone, unverifiable}, deadLinks}
 * → {status, problems: [{level, check, text}]}
 */
export function evaluate(f) {
  const s = f.source;
  const problems = [];
  const add = (level, check, text) => problems.push({ level, check, text });
  if (s.live) return { status: "unknown", problems: [{ level: "unknown", check: "live", text: "Looked up live on each request; not checked here." }] };
  const empty = !f.everRan && !f.rows && !(f.workflow && f.workflow.conclusion);
  if (empty) return { status: "unknown", problems: [{ level: "unknown", check: "setup", text: "Not set up yet: no runs and no rows." }] };

  // Did it run?
  const since = days(f.lastOk, f.now);
  if (since > s.runDays * 2) add("red", "run", f.lastOk ? `No successful pull since ${f.lastOk.slice(0, 10)} (expected every ${s.runDays} day${s.runDays === 1 ? "" : "s"}).` : "No successful pull on record.");
  else if (since > s.runDays) add("yellow", "run", `Last successful pull ${f.lastOk.slice(0, 10)}, later than the expected ${s.runDays} day${s.runDays === 1 ? "" : "s"}.`);
  if (f.workflow && f.workflow.conclusion && !["success", "skipped", "neutral"].includes(f.workflow.conclusion)) {
    add("red", "workflow", `The ${s.workflow} workflow's last run ended "${f.workflow.conclusion}" (${String(f.workflow.at || "").slice(0, 10)}).`);
  }
  for (const m of f.stepErrors || []) {
    if (/\b(404|410)\b/.test(m)) add("red", "http", `A step reports the source is gone: ${m.slice(0, 200)}`);
    else if (/\b403\b/.test(m)) add("yellow", "http", `A step was refused (403): ${m.slice(0, 200)}`);
    else add("yellow", "error", `A step failed: ${m.slice(0, 200)}`);
  }

  // Is it fresh?
  if (s.freshDays && f.latest) {
    const age = days(f.latest, f.now);
    const excused = s.season === "congress" && congressRecess(f.now);
    if (age > s.freshDays && !excused) add("yellow", "fresh", `The newest record is from ${String(f.latest).slice(0, 10)}, older than the expected ${s.freshDays} days.`);
  }

  // Did the shape change?
  const before = usual(f.history || []);
  if (f.rows === 0 && before > 0) add("red", "shape", `No rows now; there were ${before} recently.`);
  else if (before && f.rows != null && f.rows < before * 0.5) add("yellow", "shape", `${f.rows} rows, under half the usual ${Math.round(before)}.`);
  if (f.nullRows) add("yellow", "shape", `${f.nullRows} of the newest rows are missing fields they always have (${(s.nulls || []).join(", ")}).`);

  // Is it still accurate?
  const sp = f.spot || {};
  const checked = (sp.ok || 0) + (sp.mismatch || 0) + (sp.gone || 0);
  if (checked) {
    if ((sp.mismatch || 0) + (sp.gone || 0) >= Math.max(3, Math.ceil(checked / 2))) add("red", "accuracy", `${sp.mismatch || 0} of ${checked} re-fetched records no longer match, ${sp.gone || 0} gone.`);
    else if (sp.mismatch || sp.gone) add("yellow", "accuracy", `${sp.mismatch || 0} of ${checked} re-fetched records no longer match, ${sp.gone || 0} gone.`);
  }
  if (f.deadLinks) add("yellow", "links", `${f.deadLinks} stored source link${f.deadLinks === 1 ? "" : "s"} no longer open${f.deadLinks === 1 ? "s" : ""} (their archived copies are shown instead).`);

  const status = problems.reduce((st, p) => worse(st, p.level), "green");
  return { status, problems };
}

/** The alert email: only the sources that aren't green, each with what failed and since when. Null when all is well. */
export function alertEmail(results, day, siteUrl = "https://thepillory.co") {
  const bad = results.filter((r) => r.status === "yellow" || r.status === "red");
  if (!bad.length) return null;
  const red = bad.filter((r) => r.status === "red").length;
  const subject = `ThePillory data: ${red ? `${red} source${red === 1 ? "" : "s"} red` : ""}${red && bad.length > red ? ", " : ""}${bad.length > red ? `${bad.length - red} yellow` : ""} (${day})`;
  const lines = bad
    .sort((a, b) => LEVELS.indexOf(b.status) - LEVELS.indexOf(a.status))
    .map((r) => `${r.status.toUpperCase()}  ${r.source.name}${r.since ? ` (since ${r.since})` : ""}\n${r.problems.filter((p) => p.level === "red" || p.level === "yellow").map((p) => `  - ${p.text}`).join("\n")}`);
  const body = `${lines.join("\n\n")}\n\nEvery source: ${siteUrl}/admin/health/\n\nThis email is sent only on days when a source isn't healthy.\n`;
  return { subject, body };
}

/** A raw RFC 5322 message (plain text, UTF-8) for Cloudflare's send_email binding. */
export function mimeMessage({ from, to, subject, body, date = new Date(), id = crypto.randomUUID() }) {
  const enc = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode(s)))}?=`);
  const domain = String(from).split("@")[1] || "thepillory.co";
  return [
    `From: ThePillory data health <${from}>`,
    `To: ${to}`,
    `Subject: ${enc(subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${id}@${domain}>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    body.replace(/\r?\n/g, "\r\n"),
  ].join("\r\n");
}

/** How long a source has been in its current non-green state: the first day of the run, from newest-first history rows. */
export function sinceDay(historyNewestFirst, today) {
  let since = today;
  for (const h of historyNewestFirst) {
    if (h.status === "yellow" || h.status === "red") since = h.day;
    else break;
  }
  return since;
}
