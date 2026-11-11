// /admin/email/ (behind Cloudflare Access; docs/email.md): the weekly email's subscribers as
// counts only (by level, state and county; never the list of addresses), a preview of any
// edition for the coming Sunday (National, a ZIP, or a district set), "Send test to ALERT_TO",
// the one waitlist invitation, and each week's editions and sends. The website can't send
// mail, so a test or the invitation is a request the sync Worker's once-a-minute check sends.
import { esc, fmtDate } from "./render.js";
import { STATE_NAME, cleanDistricts } from "./districts.js";
import { buildEditions, SITE } from "../../workers/sync/src/email/edition.js";
import { renderEdition } from "../../workers/sync/src/email/render.js";
import { editionKey, zipCombos, zipFile } from "../../workers/sync/src/email/places.js";
import { comingSunday, weekOf, pacific } from "../../workers/sync/src/email/schedule.js";

export const ADMIN_EMAIL = "/admin/email/";

function assets(env, request) {
  const cache = new Map();
  return async (path) => {
    if (!cache.has(path)) {
      cache.set(
        path,
        (async () => {
          if (!env.ASSETS) return null;
          const res = await env.ASSETS.fetch(new URL(path, request.url));
          return res.ok ? res.json() : null;
        })()
      );
    }
    return cache.get(path);
  };
}

/** The place a preview or test asks for, from the form or query: {level, zip, st, cd, su, sl, co}. Pure. */
export function previewPlace(get) {
  const level = ["national", "zip", "exact"].includes(get("level")) ? get("level") : "national";
  if (level === "zip") return /^\d{5}$/.test(get("zip") || "") ? { level, zip: get("zip") } : { level: "national" };
  if (level === "exact") {
    const d = cleanDistricts({ st: (get("st") || "").toUpperCase(), cd: get("cd"), su: get("su"), sl: get("sl"), co: get("co") });
    return d ? { level, zip: null, st: d.st, cd: d.cd || null, su: d.su || null, sl: d.sl || null, co: d.co || null } : { level: "national" };
  }
  return { level: "national" };
}

async function counts(db, loadJson) {
  const subs = (await db.prepare("SELECT level, zip, st, co, confirmed_at IS NOT NULL AS confirmed FROM email_subscribers").all()).results;
  const counties = (await loadJson("/data/counties.json")) || {};
  const by = { level: new Map(), state: new Map(), county: new Map() };
  const bump = (m, k, confirmed) => {
    const v = m.get(k) || { confirmed: 0, waiting: 0 };
    v[confirmed ? "confirmed" : "waiting"] += 1;
    m.set(k, v);
  };
  for (const s of subs) {
    bump(by.level, s.level, s.confirmed);
    let st = s.st;
    let co = s.co;
    if (s.level === "zip" && s.zip) {
      const combos = zipCombos(await loadJson(zipFile(s.zip)), s.zip);
      st = combos[0] ? combos[0].st : null;
      const cos = [...new Set(combos.map((c) => c.co))];
      co = cos.length === 1 ? cos[0] : null;
    }
    if (st) bump(by.state, st, s.confirmed);
    if (co) bump(by.county, co, s.confirmed);
  }
  const rows = (m, name) =>
    [...m.entries()]
      .sort((a, b) => b[1].confirmed + b[1].waiting - (a[1].confirmed + a[1].waiting))
      .map(([k, v]) => `<tr><th scope="row">${esc(name(k))}</th><td>${v.confirmed}</td><td>${v.waiting}</td></tr>`)
      .join("");
  const table = (title, m, name) =>
    m.size
      ? `<h3 class="label">${esc(title)}</h3><div class="table-scroll"><table class="usage-table"><thead><tr><th scope="col">${esc(title)}</th><th scope="col">Confirmed</th><th scope="col">Waiting</th></tr></thead><tbody>${rows(m, name)}</tbody></table></div>`
      : "";
  const LEVEL = { national: "National edition (email only)", zip: "ZIP", exact: "Address (exact districts)" };
  return {
    total: subs.length,
    confirmed: subs.filter((s) => s.confirmed).length,
    html: [
      table("Level", by.level, (k) => LEVEL[k] || k),
      table("State", by.state, (k) => STATE_NAME[k] || k),
      table("County", by.county, (k) => (counties[k] ? `${counties[k][0]}, ${counties[k][1]}` : k)),
    ].join(""),
  };
}

const field = (name, label, value, attrs = "") => `<label class="field"><span class="label">${esc(label)}</span><input class="input" name="${name}" value="${esc(value || "")}" ${attrs}/></label>`;

/** The page. */
export async function adminEmailMain(env, request, { done = "", error = "" } = {}) {
  const db = env.DB;
  const url = new URL(request.url);
  const loadJson = assets(env, request);
  const get = (k) => url.searchParams.get(k) || "";
  const mode = String(env.EMAIL_SENDING || "off").toLowerCase();
  const c = await counts(db, loadJson);
  const place = previewPlace(get);
  const sunday = comingSunday();
  let preview = "";
  if (get("level")) {
    const [edition] = await buildEditions({ db, loadJson, week: weekOf(sunday), today: pacific().date }, [{ key: editionKey(place), sub: place }]);
    const rendered = renderEdition(edition, { mailingAddress: env.MAILING_ADDRESS || "(MAILING_ADDRESS isn't set on the Worker)" });
    preview = `<section class="card stack-sm" id="preview">
  <h2 class="h3">Preview: ${esc(edition.key)}</h2>
  <dl class="kv kv--tight">
    <div class="kv-row"><dt>Subject</dt><dd>${esc(edition.subject)}</dd></div>
    <div class="kv-row"><dt>Preview line</dt><dd>${esc(edition.preview)}</dd></div>
    <div class="kv-row"><dt>Lines</dt><dd>${edition.items} (the email shows about 15, then links to the web version)${edition.items ? "" : ": nothing new, so it wouldn't be sent"}</dd></div>
  </dl>
  <iframe class="email-preview" title="The email as sent" sandbox srcdoc="${esc(rendered.html)}"></iframe>
  <form method="post" action="${ADMIN_EMAIL}">
    <input type="hidden" name="action" value="test" />
    ${Object.entries(place).map(([k, v]) => (v == null ? "" : `<input type="hidden" name="${esc(k)}" value="${esc(v)}" />`)).join("")}
    <button class="btn btn--primary" type="submit">Send test to ALERT_TO</button>
  </form>
  <details class="small"><summary>Plain-text version</summary><pre class="xsmall">${esc(rendered.text)}</pre></details>
</section>`;
  }
  const requests = (await db.prepare("SELECT kind, params, requested_by, created_at, done_at, result FROM email_requests ORDER BY id DESC LIMIT 8").all()).results;
  const weeks = (
    await db.prepare("SELECT week, COUNT(*) AS editions, SUM(items > 0) AS with_news, SUM(recipients) AS recipients, SUM(sent) AS sent FROM email_editions GROUP BY week ORDER BY week DESC LIMIT 8").all()
  ).results;
  const invited = await db.prepare("SELECT COUNT(*) AS n, SUM(email_invited_at IS NOT NULL) AS done FROM waitlist").first();
  const pendingInvite = requests.some((r) => r.kind === "invite" && !r.done_at);
  return {
    title: "Weekly email",
    main: `<header class="page-head"><h1>Weekly email</h1><p class="subtitle">"This week from your representatives": Sunday at 5 p.m. Pacific.</p></header>
${done ? `<p class="form-ok" role="status">${esc(done)}</p>` : ""}${error ? `<p class="form-error" role="alert">${esc(error)}</p>` : ""}
<section class="card stack-sm">
  <h2 class="h3">Sending</h2>
  <p>EMAIL_SENDING is <strong>${esc(mode)}</strong> on this website${mode === "on" ? "" : mode === "pilot" ? ": the Worker sends to ALERT_TO and EMAIL_PILOT only" : ": the Worker sends to ALERT_TO only"}. The Worker's own EMAIL_SENDING decides who receives mail; set both the same (docs/email.md).</p>
  <p class="small secondary">Rollout: off (ALERT_TO only), then pilot (also the addresses in EMAIL_PILOT, on the Worker), then on (everyone who confirmed).</p>
</section>
<section class="card stack-sm">
  <h2 class="h3">Subscribers</h2>
  <p>${c.confirmed} confirmed, ${c.total - c.confirmed} waiting to confirm. Counts only; the addresses aren't shown.</p>
  ${c.html}
</section>
<section class="card stack-sm" id="preview-form">
  <h2 class="h3">Preview an edition for ${esc(sunday)}</h2>
  <form class="stack-sm" method="get" action="${ADMIN_EMAIL}#preview">
    <label class="field"><span class="label">Level</span><select class="input" name="level">
      ${["national", "zip", "exact"].map((l) => `<option value="${l}"${place.level === l && get("level") ? " selected" : ""}>${{ national: "National", zip: "A ZIP", exact: "A district set" }[l]}</option>`).join("")}
    </select></label>
    ${field("zip", "ZIP (for A ZIP)", get("zip"), 'inputmode="numeric" maxlength="5"')}
    <p class="small secondary">A district set: state, congressional district, state upper and lower districts as the Census names them, county FIPS.</p>
    ${field("st", "State", get("st"), 'maxlength="2"')}${field("cd", "Congressional district", get("cd"))}${field("su", "State upper district", get("su"))}${field("sl", "State lower district", get("sl"))}${field("co", "County FIPS", get("co"), 'maxlength="5"')}
    <button class="btn" type="submit">Preview</button>
  </form>
</section>
${preview}
<section class="card stack-sm">
  <h2 class="h3">Weeks</h2>
  ${weeks.length ? `<div class="table-scroll"><table class="usage-table"><thead><tr><th scope="col">Week</th><th scope="col">Editions</th><th scope="col">With news</th><th scope="col">Recipients</th><th scope="col">Sent</th></tr></thead><tbody>${weeks
    .map((w) => `<tr><th scope="row">${esc(w.week)}</th><td>${w.editions}</td><td>${w.with_news || 0}</td><td>${w.recipients || 0}</td><td>${w.sent || 0}</td></tr>`)
    .join("")}</tbody></table></div>` : `<p class="small secondary">Nothing sent yet.</p>`}
  <p class="small secondary">Each edition's web version is at /email/&lt;week&gt;/&lt;edition&gt;/.</p>
</section>
<section class="card stack-sm">
  <h2 class="h3">Waitlist invitation</h2>
  <p>${invited ? invited.n : 0} waitlist sign-ups; ${invited ? invited.done || 0 : 0} invited. The waitlist isn't subscribed: each address gets one invitation to sign up, only when you send it, and only while EMAIL_SENDING is on.</p>
  ${
    invited && invited.n && invited.done < invited.n && !pendingInvite
      ? `<form class="stack-sm" method="post" action="${ADMIN_EMAIL}"><input type="hidden" name="action" value="invite" />
    <label class="choice"><input type="checkbox" name="sure" value="1" required /> <span>Send the one invitation to every waitlist address not yet invited</span></label>
    <button class="btn" type="submit">Send the invitation</button></form>`
      : `<p class="small secondary">${pendingInvite ? "The invitation is going out now." : "Nothing to send."}</p>`
  }
</section>
<section class="card stack-sm">
  <h2 class="h3">Requests to the Worker</h2>
  ${requests.length ? `<ul class="simple-list">${requests.map((r) => `<li class="small">${esc(r.kind)} ${esc(r.params)} by ${esc(r.requested_by || "")}, ${esc(fmtDate(r.created_at))}: ${esc(r.done_at ? r.result || "done" : "waiting (the Worker checks once a minute)")}</li>`).join("")}</ul>` : `<p class="small secondary">None yet.</p>`}
</section>`,
  };
}

/** POST: a test to ALERT_TO, or the waitlist invitation. Returns {done} or {error}. */
export async function adminEmailPost(env, form, who) {
  const action = String(form.get("action") || "");
  if (action === "test") {
    const place = previewPlace((k) => String(form.get(k) || ""));
    await env.DB.prepare("INSERT INTO email_requests (kind, params, requested_by) VALUES ('test', ?, ?)").bind(JSON.stringify(place), who).run();
    return { done: `Test of ${editionKey(place)} requested: it reaches ALERT_TO within a minute or two.` };
  }
  if (action === "invite") {
    if (form.get("sure") !== "1") return { error: "Tick the box to send the invitation." };
    if (String(env.EMAIL_SENDING || "off").toLowerCase() !== "on") return { error: "The invitation goes out only while EMAIL_SENDING is on." };
    const open = await env.DB.prepare("SELECT 1 FROM email_requests WHERE kind = 'invite' AND done_at IS NULL").first();
    if (open) return { error: "The invitation is already going out." };
    await env.DB.prepare("INSERT INTO email_requests (kind, params, requested_by) VALUES ('invite', '{}', ?)").bind(who).run();
    return { done: "The invitation is going out, 100 addresses a minute; each address gets it once." };
  }
  return { error: "Nothing to do." };
}

export { SITE };
