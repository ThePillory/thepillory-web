// The weekly email as HTML and plain text (docs/email.md). Mobile-first, in the site's look
// (white cards on light gray, one blue, dark mode where the mail app supports it), the logo
// the only image, no open or click tracking. Each edition is rendered once with TOKEN where
// each subscriber's own links go (Change my place, Unsubscribe), then sent with it filled in.
// Pure; tested.
import { SITE, MAX_LINES } from "./edition.js";

export const TOKEN = "%%TOKEN%%";
const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const abs = (href) => (/^https?:/.test(href) ? href : `${SITE}${href}`);

/** The links a subscriber's email carries; on the web version, the signup page instead. */
export function links(edition, { web = false } = {}) {
  return {
    manage: web ? `${SITE}/email/` : `${SITE}/email/manage/?t=${TOKEN}`,
    unsubscribe: web ? null : `${SITE}/email/unsubscribe/?t=${TOKEN}`,
    webVersion: `${SITE}/email/${edition.week}/${encodeURIComponent(edition.key)}/`,
    everything: edition.level === "national" ? `${SITE}/` : `${SITE}/email/${edition.week}/${encodeURIComponent(edition.key)}/`,
  };
}

/**
 * The lines the email shows, in order, at most MAX_LINES items (an empty rep's one line
 * counts as one), and whether anything was left for the web version.
 */
export function capped(edition, max = MAX_LINES) {
  let left = max;
  let cut = false;
  const sections = [];
  for (const s of edition.sections) {
    if (left <= 0) {
      cut = true;
      break;
    }
    const out = { ...s, items: [], groups: [] };
    for (const i of s.items || []) {
      if (left <= 0) {
        cut = true;
        break;
      }
      out.items.push(i);
      left -= 1;
    }
    for (const g of s.groups || []) {
      if (left <= 0) {
        cut = true;
        break;
      }
      const items = g.items.slice(0, left);
      if (items.length < g.items.length) cut = true;
      left -= items.length || 1;
      out.groups.push({ ...g, items });
    }
    sections.push(out);
  }
  return { sections, cut };
}

const C = {
  page: "#F2F2F7",
  card: "#FFFFFF",
  text: "#1D1D1F",
  secondary: "#6E6E73",
  blue: "#0066CC",
  border: "#E5E5EA",
  panel: "#F5F5F7",
};

function itemHtml(i) {
  return `<tr><td style="padding:10px 0;border-top:1px solid ${C.border}" class="row">
<a href="${esc(abs(i.href))}" style="color:${C.text};text-decoration:none;font-weight:600;font-size:16px;line-height:1.35" class="t">${esc(i.text)}</a>${i.status ? ` <span style="color:${C.secondary};font-size:14px;white-space:nowrap" class="s">· ${esc(i.status)}</span>` : ""}
${i.meta ? `<div style="color:${C.secondary};font-size:14px;line-height:1.4;margin-top:2px" class="s">${esc(i.meta)}</div>` : ""}
</td></tr>`;
}

function sectionHtml(s) {
  const parts = [];
  if (s.note) parts.push(`<p style="margin:0 0 6px;color:${C.secondary};font-size:14px" class="s">${esc(s.note)}</p>`);
  if (s.coming) parts.push(`<p style="margin:0 0 4px;font-size:16px"><a href="${esc(abs(s.coming.href))}" style="color:${C.blue}">${esc(s.coming.text)}</a></p>`);
  if ((s.items || []).length) parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${s.items.map(itemHtml).join("")}</table>`);
  for (const g of s.groups || []) {
    parts.push(`<p style="margin:12px 0 2px;font-size:16px;font-weight:700"><a href="${esc(abs(g.href))}" style="color:${C.text};text-decoration:none" class="t">${esc(g.name)}</a></p><p style="margin:0 0 4px;color:${C.secondary};font-size:14px" class="s">${esc(g.office)}</p>`);
    if (g.items.length) parts.push(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${g.items.map(itemHtml).join("")}</table>`);
    else parts.push(`<p style="margin:0;padding:10px 0;border-top:1px solid ${C.border};color:${C.secondary};font-size:14px" class="s row">${esc(g.empty || "Nothing new this week")}</p>`);
  }
  if (s.quote) parts.push(`<div style="margin-top:10px;padding:12px 14px;background:${C.panel};border-radius:14px" class="q"><div style="font-size:12px;letter-spacing:.06em;text-transform:uppercase;color:${C.secondary}" class="s">${esc(s.quote.label)}</div><div style="font-family:Georgia,serif;font-size:15px;line-height:1.5;margin-top:4px">“${esc(s.quote.text)}”</div></div>`);
  return `<tr><td style="padding:16px 20px;background:${C.card};border-radius:20px" class="card">
<h2 style="margin:0 0 8px;font-size:20px;line-height:1.25;font-weight:800;color:${C.text}" class="t">${esc(s.title)}</h2>
${parts.join("\n")}
</td></tr><tr><td style="height:12px;line-height:12px;font-size:0">&nbsp;</td></tr>`;
}

/**
 * The email (or, with web: true, the web version's body). opts: {mailingAddress, web}.
 * Returns {html, text, subject, preview}. The email's own links carry TOKEN.
 */
export function renderEdition(edition, { mailingAddress = "", web = false, full = web } = {}) {
  const L = links(edition, { web });
  const { sections, cut } = full ? { sections: edition.sections, cut: false } : capped(edition);
  const based = `${esc(edition.based.text)} · <a href="${esc(L.manage)}" style="color:${C.blue}">${esc(edition.based.link.label)}</a>`;
  const footer = [
    web
      ? `This is the web version of ThePillory's weekly email. <a href="${SITE}/email/" style="color:${C.blue}">Get it by email ›</a>`
      : `You're getting this because you signed up for ThePillory's weekly email at thepillory.co and confirmed it.`,
    web ? "" : `<a href="${esc(L.manage)}" style="color:${C.blue}">Change my place</a> · <a href="${esc(L.unsubscribe)}" style="color:${C.blue}">Unsubscribe</a> · <a href="${esc(L.webVersion)}" style="color:${C.blue}">View on the web</a>`,
    "Every line links to its record and source on thepillory.co.",
    mailingAddress ? esc(mailingAddress) : "",
  ].filter(Boolean);
  const body = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;margin:0 auto">
<tr><td style="padding:20px 4px 12px">
<a href="${SITE}/" style="text-decoration:none;color:${C.text}" class="t"><img src="${SITE}/assets/logo/apple-touch-icon.png" width="28" height="28" alt="" style="vertical-align:middle;border-radius:7px;border:0"> <span style="font-size:18px;font-weight:800;vertical-align:middle">The<span style="color:${C.blue}">Pillory</span></span></a>
<h1 style="margin:14px 0 4px;font-size:26px;line-height:1.2;font-weight:800;color:${C.text}" class="t">${esc(edition.title)}</h1>
<p style="margin:0;color:${C.secondary};font-size:14px" class="s">${esc(edition.when)}</p>
<p style="margin:6px 0 0;color:${C.secondary};font-size:14px" class="s">${based}</p>
</td></tr>
<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0">
${sections.map(sectionHtml).join("\n")}
</table></td></tr>
${cut ? `<tr><td style="padding:4px 4px 16px;font-size:16px"><a href="${esc(L.everything)}" style="color:${C.blue};font-weight:600">See everything for your area on ThePillory ›</a></td></tr>` : ""}
<tr><td style="padding:8px 4px 24px;color:${C.secondary};font-size:13px;line-height:1.5" class="s">${footer.map((f) => `<p style="margin:0 0 8px">${f}</p>`).join("")}</td></tr>
</table>`;
  if (web) return { html: body, text: "", subject: edition.subject, preview: edition.preview };
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title>${esc(edition.subject)}</title>
<style>
body{margin:0;padding:0;background:${C.page};font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;-webkit-text-size-adjust:100%}
a{color:${C.blue}}
@media (prefers-color-scheme: dark){
 body,.bg{background:#000000 !important}
 .card{background:#1C1C1E !important}
 .t{color:#F5F5F7 !important}
 .s{color:#A1A1A6 !important}
 .row{border-color:#38383A !important}
 .q{background:#2C2C2E !important;color:#F5F5F7 !important}
 a{color:#4DA3FF !important}
}
</style></head>
<body class="bg"><div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(edition.preview)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" class="bg" style="background:${C.page}"><tr><td style="padding:0 12px">${body}</td></tr></table>
</body></html>`;
  return { html, text: renderText(edition, { mailingAddress, sections, cut, L }), subject: edition.subject, preview: edition.preview };
}

/** The plain-text version: the same lines, each with its link. */
function renderText(edition, { mailingAddress, sections, cut, L }) {
  const out = [edition.title.toUpperCase(), edition.when, `${edition.based.text}. ${edition.based.link.label.replace(" ›", "")}: ${L.manage}`, ""];
  const item = (i) => `- ${i.text}${i.status ? ` (${i.status})` : ""}${i.meta ? `\n  ${i.meta}` : ""}\n  ${abs(i.href)}`;
  for (const s of sections) {
    out.push(s.title.toUpperCase());
    if (s.note) out.push(s.note);
    if (s.coming) out.push(`${s.coming.text.replace(" ›", "")}: ${abs(s.coming.href)}`);
    for (const i of s.items || []) out.push(item(i));
    for (const g of s.groups || []) {
      out.push(`${g.name}, ${g.office}`);
      if (g.items.length) g.items.forEach((i) => out.push(item(i)));
      else out.push(`- ${g.empty || "Nothing new this week"}`);
    }
    if (s.quote) out.push(`${s.quote.label}: "${s.quote.text}"`);
    out.push("");
  }
  if (cut) out.push(`See everything for your area on ThePillory: ${L.everything}`, "");
  out.push("You're getting this because you signed up for ThePillory's weekly email at thepillory.co and confirmed it.", `Change my place: ${L.manage}`, `Unsubscribe: ${L.unsubscribe}`, `View on the web: ${L.webVersion}`);
  if (mailingAddress) out.push("", mailingAddress);
  return out.join("\n");
}

/** One recipient's copy: their token in every personal link. */
export function personalize(rendered, token) {
  const t = encodeURIComponent(token);
  return { ...rendered, html: rendered.html.split(TOKEN).join(t), text: rendered.text.split(TOKEN).join(t) };
}

/** The headers every weekly email carries: one-click unsubscribe (RFC 8058). */
export function listHeaders(token) {
  const url = `${SITE}/email/unsubscribe/?t=${encodeURIComponent(token)}`;
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}
