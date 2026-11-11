// Sending the weekly email and its confirmations (docs/email.md), from the sync Worker.
//
//   everyMinute()   the once-a-minute cron: confirmation emails for new signups, and the
//                   website's requests (a test to ALERT_TO, the waitlist invitation)
//   buildWeek()     Sunday at 5 p.m. Pacific: each edition the subscribers need, built once
//                   and stored (email_editions; also the web version)
//   sendRound()     then up to SEND_PER_ROUND emails a round, each recorded in email_sends
//                   so a retried round never sends twice
//
// Who can receive anything is set by EMAIL_SENDING: "off" (the default): ALERT_TO only;
// "pilot": ALERT_TO and the addresses in EMAIL_PILOT; "on": everyone who confirmed.
// Mail goes through Cloudflare Email Service (the EMAIL send_email binding), from EMAIL_FROM.
import { buildEditions, SITE } from "./edition.js";
import { renderEdition, personalize, listHeaders } from "./render.js";
import { editionKey, zipCombos, zipFile } from "./places.js";
import { comingSunday, weekOf, pacific } from "./schedule.js";

export const SEND_PER_ROUND = 300;
export const CONFIRMS_PER_MINUTE = 50;
export const INVITES_PER_MINUTE = 100;
const J = (x) => JSON.stringify(x);

/** Who may receive email now. Pure; tested. */
export function rollout(env) {
  const mode = ["off", "pilot", "on"].includes(String(env.EMAIL_SENDING || "").toLowerCase()) ? String(env.EMAIL_SENDING).toLowerCase() : "off";
  const admin = String(env.ALERT_TO || "").trim().toLowerCase();
  const pilot = new Set(
    String(env.EMAIL_PILOT || "")
      .split(/[\s,;]+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean)
  );
  return {
    mode,
    admin,
    allowed: (email) => {
      const e = String(email || "").toLowerCase();
      if (!e) return false;
      if (e === admin) return true;
      if (mode === "pilot") return pilot.has(e);
      return mode === "on";
    },
  };
}

/** Sends one email through Cloudflare Email Service. */
export async function sendMail(env, { to, subject, html, text, headers = {} }) {
  if (!env.EMAIL) throw new Error("the EMAIL send_email binding isn't set up (docs/email.md)");
  const from = { email: env.EMAIL_FROM || "weekly@thepillory.co", name: "ThePillory" };
  return env.EMAIL.send({ to, from, subject, html, text, headers });
}

/** The site's data files, read from the site itself. */
export function siteJson(env) {
  const base = env.SITE_URL || SITE;
  return async (path) => {
    const res = await fetch(`${base}${path}`, { cf: { cacheTtl: 600 } });
    if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
    return res.json();
  };
}

// ---------------------------------------------------------------------------
// Short emails: confirmation, place check, invitation. Plain, the same for everyone.

const shell = (title, paragraphs, button, footer) => {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"></head>
<body style="margin:0;padding:24px 16px;background:#F2F2F7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1D1D1F">
<div style="max-width:480px;margin:0 auto;background:#FFFFFF;border-radius:20px;padding:20px">
<p style="margin:0 0 12px;font-size:18px;font-weight:800">The<span style="color:#0066CC">Pillory</span></p>
<h1 style="margin:0 0 12px;font-size:22px;line-height:1.25">${esc(title)}</h1>
${paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:16px;line-height:1.5">${esc(p)}</p>`).join("")}
${button ? `<p style="margin:16px 0"><a href="${esc(button.href)}" style="display:inline-block;background:#0066CC;color:#FFFFFF;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:999px">${esc(button.label)}</a></p><p style="margin:0 0 12px;font-size:13px;color:#6E6E73;word-break:break-all">${esc(button.href)}</p>` : ""}
${footer.map((f) => `<p style="margin:0 0 6px;font-size:13px;color:#6E6E73">${esc(f)}</p>`).join("")}
</div></body></html>`;
  const text = [title, "", ...paragraphs, ...(button ? ["", `${button.label}: ${button.href}`] : []), "", ...footer].join("\n");
  return { html, text };
};

/** The double opt-in email. Pure; tested. */
export function confirmationEmail(env, sub) {
  const href = `${SITE}/email/confirm/?t=${encodeURIComponent(sub.token)}`;
  const { html, text } = shell(
    "Confirm your weekly email",
    [
      "Someone, probably you, asked for ThePillory's weekly email, \"This week from your representatives\", at this address.",
      "Nothing is sent until you confirm. If it wasn't you, ignore this email and nothing will be sent; the request is deleted in 7 days.",
    ],
    { label: "Confirm", href },
    [env.MAILING_ADDRESS || ""].filter(Boolean)
  );
  return { subject: "Confirm your weekly email from ThePillory", html, text };
}

/** January: a subscriber whose ZIP is now split between districts confirms their place. Pure; tested. */
export function placeCheckEmail(env, sub) {
  const href = `${SITE}/email/manage/?t=${encodeURIComponent(sub.token)}`;
  const { html, text } = shell(
    "Your districts changed",
    [
      `The new Congress's districts took effect, and ZIP ${sub.zip} is now split between more than one district.`,
      "Your weekly email now covers each district your ZIP touches. To get exactly your own representatives, enter your street address once; it's used for that one lookup and never stored.",
    ],
    { label: "Confirm my place", href },
    [env.MAILING_ADDRESS || ""].filter(Boolean)
  );
  return { subject: "Your districts changed: confirm your place", html, text };
}

/** The one invitation the waitlist gets, only when a person sends it. Pure; tested. */
export function invitationEmail(env) {
  const { html, text } = shell(
    "This week from your representatives",
    [
      "You joined ThePillory's waitlist. You haven't been signed up for anything else.",
      "ThePillory now sends a weekly email: the votes, laws and filings of the people who represent you, each linked to its record and source. If you'd like it, sign up below. This is the only time we'll ask.",
    ],
    { label: "Get the weekly email", href: `${SITE}/email/` },
    [env.MAILING_ADDRESS || ""].filter(Boolean)
  );
  return { subject: "ThePillory's weekly email is here", html, text };
}

// ---------------------------------------------------------------------------
// Once a minute

/** Confirmation emails for new signups, and the website's requests. Returns a short report. */
export async function everyMinute(env, db) {
  const r = rollout(env);
  const report = { confirmations: 0, held: 0, tests: 0, invited: 0, errors: [] };
  // Unconfirmed signups expire 7 days after their confirmation went out.
  await db.prepare("DELETE FROM email_subscribers WHERE confirmed_at IS NULL AND confirm_sent_at < datetime('now', '-7 days')").run();
  const pending = (
    await db.prepare("SELECT id, email, token FROM email_subscribers WHERE confirmed_at IS NULL AND confirm_sent_at IS NULL LIMIT ?").bind(CONFIRMS_PER_MINUTE).all()
  ).results;
  for (const s of pending) {
    if (!r.allowed(s.email)) {
      report.held += 1; // sent when EMAIL_SENDING allows it
      continue;
    }
    try {
      await sendMail(env, { to: s.email, ...confirmationEmail(env, s) });
      await db.prepare("UPDATE email_subscribers SET confirm_sent_at = datetime('now') WHERE id = ?").bind(s.id).run();
      report.confirmations += 1;
    } catch (err) {
      report.errors.push(`confirmation ${s.id}: ${err.message}`);
    }
  }
  const requests = (await db.prepare("SELECT * FROM email_requests WHERE done_at IS NULL ORDER BY id LIMIT 3").all()).results;
  for (const q of requests) {
    try {
      const params = JSON.parse(q.params || "{}");
      if (q.kind === "test") {
        const result = await sendTest(env, db, params);
        report.tests += 1;
        await db.prepare("UPDATE email_requests SET done_at = datetime('now'), result = ? WHERE id = ?").bind(result, q.id).run();
      } else if (q.kind === "invite") {
        const result = await sendInvitations(env, db, r);
        report.invited += result.sent;
        if (result.done) await db.prepare("UPDATE email_requests SET done_at = datetime('now'), result = ? WHERE id = ?").bind(result.message, q.id).run();
      }
    } catch (err) {
      report.errors.push(`request ${q.id}: ${err.message}`);
      await db.prepare("UPDATE email_requests SET done_at = datetime('now'), result = ? WHERE id = ?").bind(`error: ${String(err.message).slice(0, 300)}`, q.id).run();
    }
  }
  return report;
}

/** One edition for the coming Sunday, sent to ALERT_TO with "[Test]" in the subject. */
async function sendTest(env, db, params) {
  if (!env.ALERT_TO) throw new Error("ALERT_TO isn't set");
  const sub = { level: params.level || "national", zip: params.zip, st: params.st, cd: params.cd, su: params.su, sl: params.sl, co: params.co };
  const key = editionKey(sub);
  const sunday = comingSunday();
  const [edition] = await buildEditions({ db, loadJson: siteJson(env), week: weekOf(sunday), today: pacific().date }, [{ key, sub }]);
  const rendered = personalize(renderEdition(edition, { mailingAddress: env.MAILING_ADDRESS || "" }), "test");
  await sendMail(env, { to: env.ALERT_TO, subject: `[Test] ${rendered.subject}`, html: rendered.html, text: rendered.text });
  return `sent ${key} for ${sunday} (${edition.items} items) to ALERT_TO`;
}

/** The waitlist invitation, in batches; each address once, only when sending is on. */
async function sendInvitations(env, db, r) {
  if (r.mode !== "on") return { sent: 0, done: true, message: "not sent: EMAIL_SENDING isn't on" };
  const rows = (
    await db.prepare("SELECT DISTINCT lower(email) AS email FROM waitlist WHERE email_invited_at IS NULL AND lower(email) NOT IN (SELECT email FROM email_subscribers) LIMIT ?").bind(INVITES_PER_MINUTE).all()
  ).results;
  let sent = 0;
  for (const w of rows) {
    await sendMail(env, { to: w.email, ...invitationEmail(env) });
    await db.prepare("UPDATE waitlist SET email_invited_at = datetime('now') WHERE lower(email) = ?").bind(w.email).run();
    sent += 1;
  }
  // Waitlist addresses that already subscribed are marked too, without an email.
  if (rows.length < INVITES_PER_MINUTE) await db.prepare("UPDATE waitlist SET email_invited_at = datetime('now') WHERE email_invited_at IS NULL").run();
  return { sent, done: rows.length < INVITES_PER_MINUTE, message: `invitations sent` };
}

// ---------------------------------------------------------------------------
// The weekly send

/** Everyone who gets this week's email, by edition. ALERT_TO gets the National edition if not subscribed. */
export async function recipients(env, db) {
  const r = rollout(env);
  const subs = (await db.prepare("SELECT id, email, level, zip, st, cd, su, sl, co, token FROM email_subscribers WHERE confirmed_at IS NOT NULL").all()).results.filter((s) => r.allowed(s.email));
  if (r.admin && !subs.some((s) => s.email === r.admin)) subs.push({ id: 0, email: r.admin, level: "national", token: "admin" });
  return subs.map((s) => ({ ...s, key: editionKey(s) }));
}

/**
 * Builds and stores this week's editions. Returns {keys: [with something new], built, empty}.
 * A ZIP no longer in the data falls back to the National edition (the key is kept).
 */
export async function buildWeek(env, db, week, today) {
  const subs = await recipients(env, db);
  const byKey = new Map();
  for (const s of subs) if (!byKey.has(s.key)) byKey.set(s.key, { key: s.key, sub: s, count: 0 });
  for (const s of subs) byKey.get(s.key).count += 1;
  const editions = await buildEditions({ db, loadJson: siteJson(env), week: weekOf(week), today }, [...byKey.values()]);
  for (const e of editions) {
    await db
      .prepare(
        `INSERT INTO email_editions (week, edition_key, subject, preview, items, body, recipients) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (week, edition_key) DO UPDATE SET subject = excluded.subject, preview = excluded.preview, items = excluded.items, body = excluded.body, recipients = excluded.recipients, built_at = datetime('now')`
      )
      .bind(week, e.key, e.subject, e.preview, e.items, J(e), byKey.get(e.key) ? byKey.get(e.key).count : 0)
      .run();
  }
  return { keys: editions.filter((e) => e.items > 0).map((e) => e.key), built: editions.length, empty: editions.filter((e) => !e.items).length };
}

/** Sends up to `limit` of this week's emails not sent yet. Returns {sent, errors, left}. */
export async function sendRound(env, db, week, { limit = SEND_PER_ROUND, deadline = Date.now() + 10 * 60 * 1000 } = {}) {
  const subs = await recipients(env, db);
  const done = new Set((await db.prepare("SELECT subscriber_id FROM email_sends WHERE week = ?").bind(week).all()).results.map((r) => r.subscriber_id));
  const editions = new Map(
    (await db.prepare("SELECT edition_key, body FROM email_editions WHERE week = ? AND items > 0").bind(week).all()).results.map((r) => [r.edition_key, JSON.parse(r.body)])
  );
  const rendered = new Map();
  const todo = subs.filter((s) => !done.has(s.id) && editions.has(s.key));
  let sent = 0;
  let errors = 0;
  for (const s of todo.slice(0, limit)) {
    if (Date.now() > deadline) break;
    if (!rendered.has(s.key)) rendered.set(s.key, renderEdition(editions.get(s.key), { mailingAddress: env.MAILING_ADDRESS || "" }));
    const mine = personalize(rendered.get(s.key), s.token);
    let status = "sent";
    let error = null;
    try {
      await sendMail(env, { to: s.email, subject: mine.subject, html: mine.html, text: mine.text, headers: listHeaders(s.token) });
      sent += 1;
    } catch (err) {
      status = "error";
      error = String(err.message).slice(0, 300);
      errors += 1;
    }
    await db.prepare("INSERT OR IGNORE INTO email_sends (week, subscriber_id, edition_key, status, error) VALUES (?, ?, ?, ?, ?)").bind(week, s.id, s.key, status, error).run();
  }
  if (sent) {
    for (const key of new Set(todo.slice(0, sent + errors).map((s) => s.key))) {
      await db.prepare("UPDATE email_editions SET sent = (SELECT COUNT(*) FROM email_sends WHERE week = ? AND edition_key = ? AND status = 'sent') WHERE week = ? AND edition_key = ?").bind(week, key, week, key).run();
    }
  }
  // Sends older than 8 weeks aren't needed to prevent repeats.
  await db.prepare("DELETE FROM email_sends WHERE week < date(?, '-56 days')").bind(week).run();
  return { sent, errors, left: Math.max(0, todo.length - sent - errors) };
}

// ---------------------------------------------------------------------------
// January: the new Congress's districts

/**
 * When CENSUS_VINTAGE changes (the 120th Congress's districts), every exact subscriber is
 * re-mapped from their stored ZIP (ZIP subscribers need nothing: their districts are read
 * from data/zip/ each week). A ZIP still in one district set: the new districts, silently.
 * A ZIP now split: back to the ZIP level, and one email asking them to confirm their place.
 */
export async function remapIfNewDistricts(env, db, loadJson) {
  const vintage = env.CENSUS_VINTAGE || "";
  const row = await db.prepare("SELECT value FROM sync_state WHERE key = 'email_census_vintage'").first();
  if (!row) {
    await db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('email_census_vintage', ?)").bind(vintage).run();
    return { remapped: 0, split: 0, first: true };
  }
  if (row.value === vintage) return { remapped: 0, split: 0 };
  const r = rollout(env);
  const subs = (await db.prepare("SELECT id, email, zip, token FROM email_subscribers WHERE level = 'exact' AND zip IS NOT NULL").all()).results;
  let remapped = 0;
  let split = 0;
  for (const s of subs) {
    const combos = zipCombos(await loadJson(zipFile(s.zip)), s.zip);
    if (combos.length === 1) {
      const c = combos[0];
      await db.prepare("UPDATE email_subscribers SET st = ?, cd = ?, su = ?, sl = ?, co = ?, updated_at = datetime('now') WHERE id = ?").bind(c.st, c.cd, c.su, c.sl, c.co, s.id).run();
      remapped += 1;
    } else if (combos.length > 1) {
      await db.prepare("UPDATE email_subscribers SET level = 'zip', st = NULL, cd = NULL, su = NULL, sl = NULL, co = NULL, updated_at = datetime('now') WHERE id = ?").bind(s.id).run();
      if (r.allowed(s.email)) {
        await sendMail(env, { to: s.email, ...placeCheckEmail(env, s) });
        await db.prepare("UPDATE email_subscribers SET place_check_sent_at = datetime('now') WHERE id = ?").bind(s.id).run();
      }
      split += 1;
    }
  }
  await db.prepare("INSERT OR REPLACE INTO sync_state (key, value) VALUES ('email_census_vintage', ?)").bind(vintage).run();
  return { remapped, split };
}
