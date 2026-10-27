// "Just the facts": the card that leads every ballot measure, on the measure's
// page, the ballot preview and Your ballot, in the home page's card style:
//   - a row of chips: the measure's type, who placed it on the ballot, and
//     whether an official cost estimate is printed;
//   - "Yes" and "No" in two inner panels (side by side from 768px);
//   - "What it changes" (the official summary) in its own panel;
//   - "Cost" (the Legislative Analyst's estimate or the state's equivalent);
//   - one line at the bottom naming each source once, linked.
// Official neutral text only. Nothing here is written by ThePillory or by AI:
// text is quoted word for word and shortened only by cutting whole paragraphs,
// never by rewording. The type and "placed by" chips are the official label's
// own words (the label itself is in the chip's title); what the source doesn't
// print says so plainly, never a blank.
//
// Three data formats (data/elections/): California's guide (title, ag_summary,
// yes_means, fiscal_effect), Washington's Voters' Pamphlet (ballot_title,
// fiscal_summary) and the "sections" format (Colorado, Arizona, Florida,
// Michigan). Pure.
import { esc, safeUrl, sourceLink } from "./render.js";

export const FACTS_NOTE = "Official text only, word for word or shortened by cutting; nothing here is written by ThePillory or by AI.";
const MAX_COST_PARAGRAPHS = 2;

const quote = (s) => `“${String(s).trim()}”`;

// California's title ends with the official label: "LEGISLATIVE STATUTE.", "INITIATIVE CONSTITUTIONAL AMENDMENT AND STATUTE."
const CA_LABEL = /\b((?:LEGISLATIVE|INITIATIVE|REFERENDUM)(?: [A-Z]+)*)\.?\s*$/;

/** The measure's type, in the official label's own words. */
function typeFrom(label) {
  const l = String(label || "").toLowerCase();
  if (/convention/.test(l)) return "Constitutional convention question";
  const amend = /constitutional amendment/.test(l);
  const statute = /statute/.test(l);
  if (amend && statute) return "Constitutional amendment and statute";
  if (amend) return "Constitutional amendment";
  if (statute) return "Statute";
  if (/referendum/.test(l)) return "Referendum";
  return "";
}

/** Who put it on the ballot, from the official label's own words. */
function placedFrom(label) {
  const l = String(label || "").toLowerCase();
  if (/petition signatures|citizen|^initiative|initiative (?:statute|constitutional)/.test(l)) return "Citizen initiative";
  if (/legislat/.test(l)) return "The Legislature";
  if (/required every 16 years/.test(l)) return "The state constitution (required every 16 years)";
  return "";
}

/** Whole paragraphs or list items, in order, up to `max`; whether any were cut. */
function cut(list, max) {
  const items = (list || []).filter((x) => typeof x === "string" && x.trim());
  return { items: items.slice(0, max), cut: items.length > max };
}

/**
 * The facts for one measure, in one shape for every format:
 * {type, placed: {text, from} | null, changes: html | null, means: {yes, no} | null,
 *  meansMissing, cost: html | null, costMissing, sources: [{label, url}]}.
 * Every text here comes from one of `sources`.
 */
export function measureFacts(election, m) {
  const e = election.election;
  const county = m.county ? (election.counties || {})[m.county] : null;
  const para = (t) => `<p class="small">${esc(t)}</p>`;
  const list = (items) => (items.length > 1 ? `<ul class="plain-list bullet-list">${items.map((x) => `<li class="small">${esc(x)}</li>`).join("")}</ul>` : items.map(para).join(""));
  const sources = [];
  const source = (label, url) => {
    if (url && safeUrl(url) && !sources.some((x) => x.label === label)) sources.push({ label, url });
  };

  // Washington's Voters' Pamphlet.
  if (m.ballot_title) {
    const bt = m.ballot_title;
    const kind = m.kind || "";
    const links = m.links || {};
    source("Voters' Pamphlet", links.pamphlet_page);
    if (bt.description) source("Attorney General's ballot title", links.statement);
    if ((m.fiscal_summary || []).length) source("Office of Financial Management's fiscal impact statement", links.fiscal);
    return {
      type: { text: typeFrom(kind) || (/enacted into law/i.test(bt.question || "") ? "Statute" : /constitution/i.test(bt.question || "") ? "Constitutional amendment" : ""), from: `${quote(kind)}; the ballot asks ${quote(bt.question || "")}` },
      placed: placedFrom(kind) ? { text: placedFrom(kind), from: quote(kind) } : null,
      changes: bt.description ? para(bt.description) : null,
      means: null,
      meansMissing: `Washington's Voters' Pamphlet doesn't print a "Yes means / No means" for this measure. The ballot asks: ${quote(bt.question || "")}`,
      cost: (m.fiscal_summary || []).length ? list(m.fiscal_summary) : null,
      costMissing: "No fiscal impact summary printed in the Voters' Pamphlet.",
      sources,
    };
  }

  // The "sections" format: Colorado, Arizona, Florida, Michigan.
  if (e.format === "sections") {
    const kind = m.kind || "";
    const placed = m.placed_by ? m.placed_by.charAt(0).toUpperCase() + m.placed_by.slice(1) : placedFrom(kind);
    source(m.source || "Official source", m.source_url);
    const lead = m.lead && m.lead.text && m.lead.text !== m.yes_means ? m.lead : null;
    const fiscal = (m.sections || []).find((x) => x.id === "fiscal");
    let cost = null;
    if (fiscal) {
      // Each heading kept with the paragraph under it; whole paragraphs only.
      const out = [];
      let shown = 0;
      let more = false;
      for (const p of fiscal.paragraphs) {
        if (shown >= MAX_COST_PARAGRAPHS && (typeof p === "string" || (p && p.h))) { more = true; break; }
        if (typeof p === "string") { out.push(para(p)); shown++; }
        else if (p && p.h) out.push(`<p class="small"><strong>${esc(p.h)}</strong></p>`);
      }
      if (shown) cost = out.join("") + (more ? `<p class="small secondary">Shortened by cutting; the rest is in the official ${esc(fiscal.heading)}.</p>` : "");
    }
    return {
      type: { text: typeFrom(kind), from: quote(kind) },
      placed: placed ? { text: placed, from: quote(m.placed_by || kind) } : null,
      changes: lead ? para(lead.text) : m.question ? para(m.question) : null,
      means: m.yes_means && m.no_means ? { yes: m.yes_means, no: m.no_means } : null,
      meansMissing: "Not printed in the official source ThePillory reads.",
      cost,
      costMissing: `No cost estimate in the official source ThePillory reads (${m.source || "the state's official guide"}).`,
      sources,
    };
  }

  // California, statewide: the Official Voter Information Guide.
  if (m.scope === "statewide") {
    const links = m.links || {};
    const label = (String(m.title || "").match(CA_LABEL) || [])[1] || "";
    const by = (String(m.summary || "").match(/^Put on the Ballot by (?:the Legislature|Petition Signatures)/) || [])[0] || "";
    const yes = String(m.yes_means || "").replace(/^A YES vote on this measure means:\s*/, "");
    const no = String(m.no_means || "").replace(/^A NO vote on this measure means:\s*/, "");
    source("Attorney General's official title and summary", links.title_summary);
    if ((m.fiscal_effect || []).length) source("Legislative Analyst's estimate", links.analysis);
    source("Voter Information Guide", links.guide);
    return {
      type: { text: typeFrom(label), from: `the official title's label, ${quote(label)}` },
      placed: placedFrom(by) ? { text: placedFrom(by), from: quote(by) } : null,
      changes: (m.ag_summary || []).length ? list(m.ag_summary) : null,
      means: yes && no ? { yes, no } : null,
      meansMissing: "Not found in the official guide.",
      cost: (m.fiscal_effect || []).length ? list(m.fiscal_effect) : null,
      costMissing: "Not found in the official guide.",
      sources,
    };
  }

  // California, local: the county's Voter Information Pamphlet.
  source(`${county ? county.name : "County"} Voter Information Pamphlet`, m.links && m.links.pamphlet);
  const tax = cut(m.tax_rate_statement, 1);
  return {
    type: { text: "", from: "" },
    placed: null,
    changes: m.question ? para(m.question) : null,
    means: null,
    meansMissing: "The county pamphlet doesn't print a separate “Yes means / No means”; its impartial analysis explains the measure.",
    cost: tax.items.length ? tax.items.map(para).join("") + (tax.cut ? '<p class="small secondary">Shortened by cutting; the full tax rate statement is in the county pamphlet.</p>' : "") : null,
    costMissing: "No cost estimate printed in the county pamphlet's text ThePillory reads.",
    sources,
  };
}

/** The card's inside: chips, Yes / No, What it changes, Cost, then one sources line. */
function factsBody(f) {
  const chip = (text, title = "") => `<li class="chip chip--quiet"${title ? ` title="${esc(title)}"` : ""}>${esc(text)}</li>`;
  const chips = [
    f.type.text ? chip(f.type.text, f.type.from ? `From ${f.type.from}` : "") : chip("Type not stated in the source"),
    f.placed ? chip(`Placed by ${f.placed.text === "The Legislature" ? "the Legislature" : f.placed.text.charAt(0).toLowerCase() + f.placed.text.slice(1)}`, `From ${f.placed.from}`) : chip("Who placed it: not stated in the source"),
    chip(f.cost ? "Cost estimate below" : "No official cost estimate"),
  ];
  const panel = (label, html, cls = "") => `<div class="inset stack-xs${cls ? ` ${cls}` : ""}"><p class="label">${esc(label)}</p>${html}</div>`;
  const means = f.means
    ? `<div class="facts-means">${panel("Yes", `<p class="small">${esc(f.means.yes)}</p>`)}${panel("No", `<p class="small">${esc(f.means.no)}</p>`)}</div>`
    : panel("Yes means / No means", `<p class="small secondary">${esc(f.meansMissing)}</p>`);
  return `<ul class="plain-list chips facts-chips">${chips.join("")}</ul>
  ${means}
  ${panel("What it changes", f.changes || '<p class="small secondary">Not printed in the official source ThePillory reads.</p>')}
  ${panel("Cost", f.cost || `<p class="small secondary">${esc(f.costMissing)}</p>`)}
  <p class="hint facts-sources">Sources: ${f.sources.length ? f.sources.map((x) => sourceLink(x.url, x.label)).join(" · ") : "the official guide"}. ${esc(FACTS_NOTE)}</p>`;
}

/**
 * The card at the top of a measure's page: shown in both modes (.simple-keep);
 * in Quick mode it's all the page shows, with "See the full measure page".
 */
export function factsCard(election, m) {
  return `<section class="card stack facts-card simple-keep" id="facts" aria-labelledby="h-facts">
  <h2 id="h-facts">Just the facts</h2>
  ${factsBody(measureFacts(election, m))}
  <button class="btn simple-only" type="button" data-mode-set="detailed" data-mode-jump="facts">See the full measure page</button>
</section>`;
}

/** The same card, folded under the measure's name, for the ballot preview and Your ballot. */
export function factsFold(election, m, { href, name, sub = "" }) {
  return `<details class="fold facts-fold" id="facts-${esc(m.id)}">
  <summary><span class="stack-xs"><span class="fold-title">${esc(name)}</span>${sub ? `<span class="fold-sub">${esc(sub)}</span>` : ""}</span></summary>
  <div class="fold-body stack">
    <p class="label">Just the facts</p>
    ${factsBody(measureFacts(election, m))}
    <a class="inline-link" href="${esc(href)}">Full measure page ›</a>
  </div>
</details>`;
}
