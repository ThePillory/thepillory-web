// "Just the facts": the card that leads every ballot measure, on the measure's
// page, the ballot preview and Your ballot. Official neutral text only, each
// line labeled with where it comes from: the measure's type and who put it on
// the ballot, what it changes (the official summary), what a Yes and a No vote
// mean, and its cost (the Legislative Analyst's estimate or the state's
// equivalent). Nothing here is written by ThePillory or by AI: text is quoted
// word for word, and shortened only by cutting whole paragraphs or list items,
// never by rewording. The type and "put on the ballot by" lines are the
// official label's own words, with the label quoted beside them. What the
// official source doesn't print is one plain line, never a blank.
//
// Three data formats (data/elections/): California's guide (title, ag_summary,
// yes_means, fiscal_effect), Washington's Voters' Pamphlet (ballot_title,
// fiscal_summary) and the "sections" format (Colorado, Arizona, Florida,
// Michigan). Pure.
import { esc, safeUrl, sourceLink } from "./render.js";

export const FACTS_NOTE = "Official text only, word for word or shortened by cutting. Nothing in this card is written by ThePillory or by AI.";
const MAX_COST_PARAGRAPHS = 2;

const quote = (s) => `“${String(s).trim()}”`;
const src = (label, url) => (url && safeUrl(url) ? sourceLink(url, label) : esc(label));

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
 * The facts for one measure: [{key, label, html, source, missing}], always the
 * same five lines in the same order. `html` is either the official text or a
 * plain line saying the source doesn't print it.
 */
export function measureFacts(election, m) {
  const e = election.election;
  const county = m.county ? (election.counties || {})[m.county] : null;
  const line = (key, label, html, source, missing = false) => ({ key, label, html, source, missing });
  const none = (key, label, what) => line(key, label, esc(what), "", true);
  const para = (t) => `<p class="small">${esc(t)}</p>`;
  const list = (items) => (items.length > 1 ? `<ul class="plain-list bullet-list">${items.map((x) => `<li class="small">${esc(x)}</li>`).join("")}</ul>` : items.map(para).join(""));
  const means = (yes, no) => `<p class="small"><strong>Yes:</strong> ${esc(yes)}</p><p class="small"><strong>No:</strong> ${esc(no)}</p>`;

  // Washington's Voters' Pamphlet.
  if (m.ballot_title) {
    const bt = m.ballot_title;
    const kind = m.kind || "";
    const type = typeFrom(kind) || (/enacted into law/i.test(bt.question || "") ? "Statute" : /constitution/i.test(bt.question || "") ? "Constitutional amendment" : "");
    const placed = placedFrom(kind);
    const pamphlet = (label) => src(label, m.links && m.links.pamphlet_page);
    return [
      type ? line("type", "Measure type", esc(type), `${esc(quote(kind))}; the ballot asks ${esc(quote(bt.question))} · ${pamphlet("Voters' Pamphlet")}`) : none("type", "Measure type", "Not stated in the Voters' Pamphlet."),
      placed ? line("placed", "Put on the ballot by", esc(placed), `${esc(quote(kind))} · ${pamphlet("Voters' Pamphlet")}`) : none("placed", "Put on the ballot by", "Not stated in the Voters' Pamphlet."),
      bt.description ? line("changes", "What it changes", para(bt.description), `Ballot title, written by the Office of the Attorney General · ${src("Attorney General's letter", m.links && m.links.statement)}`) : none("changes", "What it changes", "Not printed in the Voters' Pamphlet."),
      none("means", "Yes means / No means", `Washington's Voters' Pamphlet doesn't print a "Yes means / No means" for this measure. The ballot asks: ${quote(bt.question || "")}`),
      (m.fiscal_summary || []).length
        ? line("cost", "Cost", list(m.fiscal_summary), `Summary of the fiscal impact statement, Office of Financial Management · ${src("The full statement", m.links && m.links.fiscal)}`)
        : none("cost", "Cost", "No fiscal impact summary printed in the Voters' Pamphlet."),
    ];
  }

  // The "sections" format: Colorado, Arizona, Florida, Michigan.
  if (e.format === "sections") {
    const kind = m.kind || "";
    const type = typeFrom(kind);
    const placed = m.placed_by ? m.placed_by.charAt(0).toUpperCase() + m.placed_by.slice(1) : placedFrom(kind);
    const official = src(m.source || "Official source", m.source_url);
    const lead = m.lead && m.lead.text && m.lead.text !== m.yes_means ? m.lead : null;
    const changes = lead
      ? line("changes", "What it changes", para(lead.text), `${esc(String(lead.source || "").replace(/\.$/, ""))} · ${official}`)
      : m.question
        ? line("changes", "What it changes", para(m.question), `The question on the ballot (${esc(m.question_by || "official ballot language")}) · ${official}`)
        : none("changes", "What it changes", "Not printed in the official source ThePillory reads.");
    const fiscal = (m.sections || []).find((s) => s.id === "fiscal");
    let cost = none("cost", "Cost", `No cost estimate in the official source ThePillory reads (${m.source || "the state's official guide"}).`);
    if (fiscal) {
      // Each heading kept with the paragraph under it; whole paragraphs only.
      const out = [];
      let shown = 0;
      let more = false;
      for (const p of fiscal.paragraphs) {
        if (typeof p === "string") {
          if (shown >= MAX_COST_PARAGRAPHS) { more = true; break; }
          out.push(para(p));
          shown++;
        } else if (p && p.h) {
          if (shown >= MAX_COST_PARAGRAPHS) { more = true; break; }
          out.push(`<p class="small"><strong>${esc(p.h)}</strong></p>`);
        }
      }
      if (shown) cost = line("cost", "Cost", out.join("") + (more ? `<p class="small secondary">Shortened by cutting; the rest is in the official ${esc(fiscal.heading)}.</p>` : ""), `${esc(fiscal.heading)}, ${esc(fiscal.by)} · ${official}`);
    }
    return [
      type ? line("type", "Measure type", esc(type), `${esc(quote(kind))} · ${official}`) : none("type", "Measure type", "Not stated in the official source ThePillory reads."),
      placed ? line("placed", "Put on the ballot by", esc(placed), `${esc(quote(m.placed_by || kind))} · ${official}`) : none("placed", "Put on the ballot by", "Not stated in the official source ThePillory reads."),
      changes,
      m.yes_means && m.no_means ? line("means", "Yes means / No means", means(m.yes_means, m.no_means), `Word for word: ${esc(m.means_by || m.source || "")}`) : none("means", "Yes means / No means", "Not printed in the official source ThePillory reads."),
      cost,
    ];
  }

  // California, statewide: the Official Voter Information Guide.
  if (m.scope === "statewide") {
    const label = (String(m.title || "").match(CA_LABEL) || [])[1] || "";
    const by = (String(m.summary || "").match(/^Put on the Ballot by (?:the Legislature|Petition Signatures)/) || [])[0] || "";
    const guide = (label2) => src(label2, m.links && m.links.guide);
    const yes = String(m.yes_means || "").replace(/^A YES vote on this measure means:\s*/, "");
    const no = String(m.no_means || "").replace(/^A NO vote on this measure means:\s*/, "");
    return [
      typeFrom(label) ? line("type", "Measure type", esc(typeFrom(label)), `The official title's label, ${esc(quote(label))} · ${src("Official title and summary", m.links && m.links.title_summary)}`) : none("type", "Measure type", "Not stated in the official title."),
      placedFrom(by) ? line("placed", "Put on the ballot by", esc(placedFrom(by)), `${esc(quote(by))} · ${guide("Official Voter Information Guide")}`) : none("placed", "Put on the ballot by", "Not stated in the official guide."),
      (m.ag_summary || []).length ? line("changes", "What it changes", list(m.ag_summary), `Official summary, prepared by the Attorney General · ${src("Official title and summary", m.links && m.links.title_summary)}`) : none("changes", "What it changes", "The summary couldn't be read from the official guide."),
      yes && no ? line("means", "Yes means / No means", means(yes, no), `Word for word · ${guide("Official Voter Information Guide")}`) : none("means", "Yes means / No means", "Not found in the official guide."),
      (m.fiscal_effect || []).length ? line("cost", "Cost", list(m.fiscal_effect), `Summary of the Legislative Analyst's estimate of the net state and local government fiscal impact · ${src("The full analysis", m.links && m.links.analysis)}`) : none("cost", "Cost", "Not found in the official guide."),
    ];
  }

  // California, local: the county's Voter Information Pamphlet.
  const pamphlet = src(`${county ? county.name : "County"} Voter Information Pamphlet`, m.links && m.links.pamphlet);
  const tax = cut(m.tax_rate_statement, 1);
  return [
    none("type", "Measure type", "Not stated in the county pamphlet's text ThePillory reads."),
    none("placed", "Put on the ballot by", "Not stated in the county pamphlet's text ThePillory reads."),
    m.question ? line("changes", "What it changes", para(m.question), `The question on the ballot · ${pamphlet}`) : none("changes", "What it changes", "Not found in the county pamphlet."),
    none("means", "Yes means / No means", "The county pamphlet doesn't print a separate “Yes means / No means”; its impartial analysis explains the measure."),
    tax.items.length
      ? line("cost", "Cost", tax.items.map(para).join("") + (tax.cut ? '<p class="small secondary">Shortened by cutting; the full tax rate statement is in the county pamphlet.</p>' : ""), `Tax rate statement · ${pamphlet}`)
      : none("cost", "Cost", "No cost estimate printed in the county pamphlet's text ThePillory reads."),
  ];
}

// "Who wrote it · <link>": the words as a hint, the link on its own line (a full tap target).
function sourceLine(source) {
  if (!source) return "";
  const i = source.lastIndexOf(" · <a ");
  const [text, link] = i >= 0 ? [source.slice(0, i), source.slice(i + 3)] : [source, ""];
  return `<p class="hint">Source: ${text}</p>${link}`;
}

function factsList(facts) {
  return `<ul class="plain-list facts-list">${facts
    .map((f) => `<li class="fact stack-xs"><p class="label">${esc(f.label)}</p>${/^<(ul|p|div)\b/.test(f.html) ? f.html : `<p class="small${f.missing ? " secondary" : ""}">${f.html}</p>`}${sourceLine(f.source)}</li>`)
    .join("")}</ul>`;
}

/**
 * The card at the top of a measure's page: shown in both modes (.simple-keep);
 * in Quick mode it's all the page shows, with "See the full measure page".
 */
export function factsCard(election, m) {
  return `<section class="card stack facts-card simple-keep" id="facts" aria-labelledby="h-facts">
  <h2 id="h-facts">Just the facts</h2>
  ${factsList(measureFacts(election, m))}
  <p class="hint">${esc(FACTS_NOTE)}</p>
  <button class="btn simple-only" type="button" data-mode-set="detailed" data-mode-jump="facts">See the full measure page</button>
</section>`;
}

/** The same card, folded under the measure's name, for the ballot preview and Your ballot. */
export function factsFold(election, m, { href, name, sub = "" }) {
  return `<details class="fold facts-fold" id="facts-${esc(m.id)}">
  <summary><span class="stack-xs"><span class="fold-title">${esc(name)}</span>${sub ? `<span class="fold-sub">${esc(sub)}</span>` : ""}</span></summary>
  <div class="fold-body stack">
    <p class="label">Just the facts</p>
    ${factsList(measureFacts(election, m))}
    <p class="hint">${esc(FACTS_NOTE)}</p>
    <a class="inline-link" href="${esc(href)}">Full measure page ›</a>
  </div>
</details>`;
}
