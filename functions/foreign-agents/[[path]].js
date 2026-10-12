// /foreign-agents/: registered foreign agents (the Justice Department's FARA
// filings) and the foreign principals they represent, searchable by name or
// country; /foreign-agents/<registration number>/: one registrant, its
// principals, and the contacts with members of Congress or their offices its
// supplemental statements report. Loaded weekly by tools/load_gov_money.py. A
// reported contact is the agent's account; nothing here says what a member did.
import { page, notFound, notLoaded, esc, loadSection, FAILED, sectionError, guard, edgeCached, fmtDate, safeUrl } from "../_lib/render.js";
import { HOW } from "../_lib/gov-money.js";

const PER_PAGE = 25;
const missing = (err) => /no such table|no such column/i.test(String(err && err.message));
const ABOUT = `Under the Foreign Agents Registration Act (FARA), people and firms working in the United States for a foreign government, party or organization register with the Justice Department and report what they do for it, including contacts with officials. Registrants active since 2023. <a class="tap" href="https://efile.fara.gov/" target="_blank" rel="noopener">FARA eFile ↗</a> · <a class="tap" href="${HOW}">How this works</a>`;

async function list(db, { q, offset }) {
  try {
    const like = `%${q}%`;
    const where = q ? `WHERE g.name LIKE ?1 OR EXISTS (SELECT 1 FROM fara_principals p WHERE p.registration_number = g.registration_number AND (p.principal LIKE ?1 OR p.country LIKE ?1))` : "";
    const stmt = db.prepare(`SELECT g.*, (SELECT COUNT(*) FROM fara_principals p WHERE p.registration_number = g.registration_number AND p.termination_date IS NULL) AS principals,
        (SELECT group_concat(DISTINCT p.country) FROM fara_principals p WHERE p.registration_number = g.registration_number AND p.termination_date IS NULL) AS countries,
        (SELECT COUNT(*) FROM fara_contacts c WHERE c.registration_number = g.registration_number) AS contacts
      FROM fara_registrants g ${where} ORDER BY g.termination_date IS NOT NULL, g.name LIMIT ${PER_PAGE + 1} OFFSET ${offset}`);
    const { results } = await (q ? stmt.bind(like) : stmt).all();
    return { rows: results.slice(0, PER_PAGE), more: results.length > PER_PAGE };
  } catch (err) {
    if (missing(err)) return null;
    throw err;
  }
}

function regRow(g) {
  const meta = [
    g.termination_date ? `Terminated ${fmtDate(g.termination_date)}` : `Registered ${fmtDate(g.registration_date)}`,
    g.principals ? `${g.principals} current foreign ${g.principals === 1 ? "principal" : "principals"}` : "",
    g.countries ? esc(String(g.countries).split(",").slice(0, 4).join(", ")) + (String(g.countries).split(",").length > 4 ? "…" : "") : "",
    g.contacts ? `${g.contacts} reported ${g.contacts === 1 ? "contact" : "contacts"} with Congress` : "",
  ].filter(Boolean).join(" · ");
  return `<a class="list-row" href="/foreign-agents/${g.registration_number}/"><span class="list-title">${esc(g.name)}</span><span class="list-meta">${meta}</span></a>`;
}

async function index(env, url) {
  if (!env.DB) return notLoaded("Foreign agents", "reps", false, ["Reps", "/reps/"]);
  const q = (url.searchParams.get("q") || "").trim().slice(0, 80);
  const offset = Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0);
  const got = await loadSection("foreign agents", () => list(env.DB, { q, offset }));
  const href = (o) => `/foreign-agents/?${new URLSearchParams({ ...(q ? { q } : {}), ...(o ? { offset: String(o) } : {}) })}`;
  const body = got === FAILED
    ? sectionError("")
    : !got
      ? '<p class="secondary small">Foreign agents\' filings haven\'t been loaded yet. They load weekly from the Justice Department\'s FARA files.</p>'
      : `<div class="card compact-list" id="fara-list">${got.rows.map(regRow).join("") || '<p class="secondary small cr-empty">No registrants match.</p>'}</div>
${got.more ? `<a class="btn btn--block load-more" href="${esc(href(offset + PER_PAGE))}" data-load-more="fara-list">Load more</a>` : ""}`;
  const main = `
<header class="page-head"><p class="label">Foreign agents</p><h1>Foreign agents</h1></header>
<form class="card stack-sm" method="get" action="/foreign-agents/">
  <label class="label" for="fara-q">Registrant, foreign principal or country</label>
  <div class="lookup-row"><input class="input" id="fara-q" name="q" type="search" value="${esc(q)}" autocomplete="off" /><button class="btn btn--primary" type="submit">Search</button></div>
</form>
${body}
<p class="hint">${ABOUT}</p>`;
  return page("Foreign agents", main, { tab: "reps", back: ["Reps", "/reps/"], partial: got === FAILED });
}

async function detail(env, reg) {
  if (!env.DB) return notLoaded("Foreign agents", "reps", false, ["Foreign agents", "/foreign-agents/"]);
  const db = env.DB;
  const g = await loadSection("foreign agent", async () => {
    try {
      return await db.prepare("SELECT * FROM fara_registrants WHERE registration_number = ?").bind(reg).first();
    } catch (err) {
      if (missing(err)) return null;
      throw err;
    }
  });
  if (g === FAILED) throw new Error(`foreign agent ${reg} couldn't load`);
  if (!g) return notFound("No registrant at this address.", "reps", ["Foreign agents", "/foreign-agents/"]);
  const [principals, contacts, docs] = await Promise.all([
    loadSection("fara principals", () => db.prepare("SELECT * FROM fara_principals WHERE registration_number = ? ORDER BY termination_date IS NOT NULL, principal").bind(reg).all().then((r) => r.results)),
    loadSection("fara contacts", () => db.prepare(`SELECT c.*, o.name AS official, o.slug FROM fara_contacts c JOIN officials o ON o.id = c.official_id
      WHERE c.registration_number = ? ORDER BY c.contact_date DESC LIMIT 200`).bind(reg).all().then((r) => r.results)),
    loadSection("fara docs", () => db.prepare("SELECT status, COUNT(*) AS n FROM fara_docs WHERE registration_number = ? GROUP BY status").bind(reg).all().then((r) => r.results)),
  ]);
  const prin = principals === FAILED ? sectionError("") : principals.length
    ? `<ul class="plain-list">${principals.map((p) => `<li class="list-row"><span class="list-title">${esc(p.principal)}</span><span class="list-meta">${[p.country ? esc(p.country) : "", p.termination_date ? `${fmtDate(p.registration_date)} – ${fmtDate(p.termination_date)}` : `Since ${fmtDate(p.registration_date)}`].filter(Boolean).join(" · ")}</span></li>`).join("")}</ul>`
    : '<p class="secondary small">No foreign principals listed in the loaded files.</p>';
  const read = docs === FAILED ? null : Object.fromEntries(docs.map((d) => [d.status, d.n]));
  const con = contacts === FAILED ? sectionError("") : contacts.length
    ? `<ul class="plain-list money-list">${contacts.map((c) => `<li class="money-row"><div class="money-name"><a class="inline-link" href="/reps/${esc(c.slug)}/#more-foreign-agents">${esc(c.official)}</a><div class="list-meta">${[c.contact_kind === "member" ? "The member" : "The member's office", c.principal ? `for ${esc(c.principal)}` : "", c.method ? esc(c.method) : "", fmtDate(c.contact_date)].filter(Boolean).join(" · ")}</div></div><div class="money-amt">${safeUrl(c.doc_url) ? `<a class="inline-link" href="${esc(c.doc_url)}" target="_blank" rel="noopener">Statement ↗</a>` : ""}</div></li>`).join("")}</ul>`
    : `<p class="secondary small">No contacts with members of Congress or their offices in the statements read so far.</p>`;
  const main = `
<header class="page-head"><p class="label">Foreign agent · Registration ${g.registration_number}</p><h1>${esc(g.name)}</h1></header>
<section class="card stack-sm">
  <p class="small">${[g.city, g.state].filter(Boolean).map(esc).join(", ")}${g.city || g.state ? " · " : ""}Registered ${fmtDate(g.registration_date)}${g.termination_date ? ` · Terminated ${fmtDate(g.termination_date)}` : ""}</p>
  <p class="hint"><a class="tap" href="${esc(g.source_url)}" target="_blank" rel="noopener">Filings at FARA eFile ↗</a></p>
</section>
<section class="stack-sm"><h2>Foreign principals</h2>${prin}</section>
<section class="stack-sm"><h2>Contacts with Congress</h2>${con}
<p class="hint">From the registrant's supplemental statements filed since 2025 (Item 12, political activities)${read ? `: ${read.read || 0} read, ${read.link || 0} scanned and left as links` : ""}. Only contacts naming a member of Congress or a member's office are listed; staff aren't named. A reported contact is the registrant's account: it doesn't say what the member did or thought.</p></section>
<p class="hint">${ABOUT}</p>`;
  return page(g.name, main, { tab: "reps", back: ["Foreign agents", "/foreign-agents/"], partial: [principals, contacts, docs].includes(FAILED) });
}

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
  if (!parts.length) return edgeCached(context, 300, () => index(context.env, url));
  if (parts.length === 1 && /^\d{1,6}$/.test(parts[0])) return edgeCached(context, 300, () => detail(context.env, Number(parts[0])));
  return notFound("No page at this address.", "reps", ["Foreign agents", "/foreign-agents/"]);
}, { tab: "reps" });
