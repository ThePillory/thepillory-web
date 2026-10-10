// The U.S. Supreme Court, from data/scotus/ (built daily by tools/build_scotus.py
// from supremecourt.gov, senate.gov and CourtListener). See docs/scotus.md.
//
//   /bodies/us-supreme-court/          the Court: the justices by seniority, This term, latest decisions
//   /justices/<slug>/                  one justice: About · Record · Disclosures · More
//   /court/term/                       This term: cases granted for argument, argument dates,
//                                      questions presented, and decisions as they come
//   /court/cases/<term>/<docket>/      one decision: summary, lineup, the provisions the
//                                      opinion of the Court names, the opinion
//
// The same layout for every justice. No ideology labels, scores, voting blocs or
// predictions: each decision shows who wrote and who joined each opinion, as the
// opinion's own syllabus states it, and links to the opinion.
import { esc, fmtDate, linkRow, safeUrl } from "./render.js";
import { compactRow, clauseChips, fold, outLink } from "./summary.js";
import { asset } from "./geo.js";

export const COURT_HREF = "/bodies/us-supreme-court/";
export const TERM_HREF = "/court/term/";
export const justiceHref = (slug) => `/justices/${slug}/`;
export const caseHref = (term, docket) => `/court/cases/${term}/${encodeURIComponent(docket)}/`;
const PAGE = 20;

export const loadJustices = (env, request) => asset(env, request, "/data/scotus/justices.json");
export const loadIndex = (env, request) => asset(env, request, "/data/scotus/index.json");
export const loadTerm = (env, request, term) => (/^\d{4}$/.test(String(term)) ? asset(env, request, `/data/scotus/terms/${term}.json`) : null);
export const loadCurrent = (env, request) => asset(env, request, "/data/scotus/current.json");
export const loadDisclosures = (env, request) => asset(env, request, "/data/scotus/disclosures.json");

/** {id: label} for every provision in data/constitution.json. */
export async function constitutionLabels(env, request) {
  const c = await asset(env, request, "/data/constitution.json");
  return Object.fromEntries(((c && c.provisions) || []).map((p) => [p.id, p.label]));
}

/** The surname the opinions use: "John G. Roberts, Jr." → "Roberts"; "Amy Coney Barrett" → "Barrett". */
export const surname = (name) => String(name).split(",")[0].trim().split(/\s+/).pop();

/** "October Term 2025" */
export const termName = (term) => `October Term ${term}`;

/** The decision's date as a Date-comparable ISO string; oath dates ("June 30, 2022") too. */
const isoOf = (s) => {
  if (/^\d{4}-\d{2}-\d{2}$/.test(String(s))) return s;
  const d = new Date(`${s} 12:00 UTC`);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString().slice(0, 10);
};

// ---------------------------------------------------------------------------
// Positions, as the lineup states them

const BASE_ROLES = ["majority", "majority in part", "concurrence", "concurring in part", "concurrence in the judgment", "concurring in part and dissenting in part", "dissenting in part", "dissent", "took no part"];
// "dissent (in part)": joined part of that opinion ("… joined as to Parts II and III").
const ROLE_ORDER = BASE_ROLES.flatMap((r) => [r, `${r} (in part)`]);
const ROLE_LABEL = {
  majority: "Majority",
  "majority in part": "Joined the majority in part",
  concurrence: "Concurrence",
  "concurring in part": "Concurring in part",
  "concurrence in the judgment": "Concurring in the judgment",
  "concurring in part and dissenting in part": "Concurring in part and dissenting in part",
  "dissenting in part": "Dissenting in part",
  dissent: "Dissent",
  "took no part": "Took no part",
};
for (const r of BASE_ROLES) ROLE_LABEL[`${r} (in part)`] = `Joined ${r === "dissent" ? "a dissent" : r === "concurrence" ? "a concurrence" : `the ${r}`} in part`;
const WROTE_LABEL = {
  majority: "the opinion of the Court",
  concurrence: "a concurrence",
  "concurring in part": "an opinion concurring in part",
  "concurrence in the judgment": "an opinion concurring in the judgment",
  "concurring in part and dissenting in part": "an opinion concurring in part and dissenting in part",
  "dissenting in part": "an opinion dissenting in part",
  dissent: "a dissent",
};

/** The justice's entry in a decision's lineup, or null. */
export function positionFor(c, name) {
  const s = surname(name);
  const list = c.lineup && c.lineup.justices;
  return (list && list.find((x) => x.justice === s)) || null;
}

/** "Majority · wrote the opinion of the Court", "Majority; dissenting in part · wrote …". Pure. */
export function positionText(p) {
  if (!p) return "";
  const roles = ROLE_ORDER.filter((r) => p.roles.includes(r)).map((r) => ROLE_LABEL[r]);
  const wrote = ROLE_ORDER.filter((r) => (p.wrote || []).includes(r)).map((r) => WROTE_LABEL[r]).filter(Boolean);
  return [roles.join("; "), wrote.length ? `wrote ${wrote.join(" and ")}` : ""].filter(Boolean).join(" · ");
}

/** The decision's lineup, grouped: [{role label, names (writers marked)}], in a fixed order. Pure. */
export function lineupGroups(c) {
  const list = (c.lineup && c.lineup.justices) || [];
  return ROLE_ORDER.map((r) => ({
    label: ROLE_LABEL[r],
    names: list.filter((x) => x.roles.includes(r)).map((x) => `${x.justice}${(x.wrote || []).includes(r) ? " (wrote)" : ""}`),
  })).filter((g) => g.names.length);
}

// ---------------------------------------------------------------------------
// Rows and sections

function caseRow(term, c, status, clauses) {
  const first = (c.provisions || []).find((p) => clauses[p.id]);
  return compactRow({
    href: caseHref(term, c.docket),
    type: c.docket,
    title: c.name,
    status,
    meta: fmtDate(c.date),
    clause: first ? { label: clauses[first.id] } : null,
  });
}

/** The justices, by seniority: each a row to their page. */
export function justiceRows(justices) {
  return justices.map((j) => linkRow(justiceHref(j.slug), j.name, j.title)).join("");
}

/** "The nation": the Supreme Court card. */
export function courtCard(justices) {
  return `
  <div class="card stack-xs">
    <p class="label">The Supreme Court</p>
    ${justices && justices.justices && justices.justices.length
      ? `${justiceRows(justices.justices)}${linkRow(TERM_HREF, "This term", "Cases the Court will hear, and its decisions")}`
      : '<p class="small secondary">Appears after the Supreme Court data refresh.</p>'}
  </div>`;
}

// ---------------------------------------------------------------------------
// The Court (/bodies/us-supreme-court/)

export async function courtPage(env, request, body) {
  const [justices, index, current] = await Promise.all([loadJustices(env, request), loadIndex(env, request), loadCurrent(env, request)]);
  const latestTerm = index && index.terms && index.terms[0] ? await loadTerm(env, request, index.terms[0]) : null;
  const clauses = await constitutionLabels(env, request);
  const latest = latestTerm ? latestTerm.cases.filter((c) => !c.pending_read).slice(0, 5) : [];
  const pending = current ? current.cases.filter((c) => !c.decided).length : 0;
  return `
<header class="page-head">
  <p class="label">Federal · Governing body</p>
  <h1>${esc(body.name)}</h1>
  <div class="secondary">${esc(body.about)}</div>
  <div class="chips">${body.chip}</div>
</header>
<section class="stack-sm" aria-labelledby="h-justices">
  <h2 class="label" id="h-justices">The justices</h2>
  <div class="card">${justices ? justiceRows(justices.justices) : '<p class="small secondary">Appears after the Supreme Court data refresh.</p>'}</div>
  <p class="hint">The Chief Justice, then by when each took the oath, as the Court lists them.</p>
</section>
<section class="stack-sm" aria-labelledby="h-term">
  <h2 class="label" id="h-term">${index ? esc(termName(index.current_term)) : "This term"}</h2>
  <div class="card">${linkRow(TERM_HREF, "This term", current ? `${pending} ${pending === 1 ? "case" : "cases"} granted for argument and not yet decided` : "Cases the Court will hear")}</div>
</section>
${latest.length ? `<section class="stack-sm" aria-labelledby="h-latest">
  <h2 class="label" id="h-latest">Latest decisions</h2>
  <div class="compact-list">${latest.map((c) => caseRow(latestTerm.term, c, c.author_code === "PC" ? "Per curiam" : "", clauses)).join("")}</div>
</section>` : ""}
<p class="hint">From the Court's own records: its list of justices and their biographies (supremecourt.gov), the Senate's record of each confirmation (senate.gov), and each opinion as the Court published it. <a class="inline-link" href="/about/methodology/#scotus">How ThePillory builds this</a></p>`;
}

// ---------------------------------------------------------------------------
// This term (/court/term/)

const mdy = (s) => {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{2})$/.exec(String(s || ""));
  return m ? `20${m[3]}-${m[1].padStart(2, "0")}-${m[2].padStart(2, "0")}` : "";
};

export async function termPage(env, request) {
  const [current, index] = await Promise.all([loadCurrent(env, request), loadIndex(env, request)]);
  if (!current) return null;
  const decidedTerm = await loadTerm(env, request, current.term);
  const clauses = await constitutionLabels(env, request);
  const byDocket = Object.fromEntries(((decidedTerm && decidedTerm.cases) || []).map((c) => [c.docket, c]));
  const pending = current.cases
    .filter((c) => !c.decided)
    .sort((a, b) => (mdy(a.argument_date) || "9999").localeCompare(mdy(b.argument_date) || "9999"));
  const pendingCards = pending
    .map((c, i) => {
      const argued = mdy(c.argument_date);
      return `
  <div class="card stack-xs">
    <p class="label">${esc(c.dockets.join(", "))} · from ${esc(c.lower_court || "the lower court")}</p>
    <h3>${esc(c.name)}</h3>
    <p class="small secondary">${argued ? `Argument: ${esc(fmtDate(argued))}` : "Argument date not set yet"} · Granted ${esc(fmtDate(mdy(c.granted)))}</p>
    ${c.question_presented && c.question_presented.length
      ? fold(`qp-${i}`, "Question presented", `<div class="stack-xs">${c.question_presented.map((p) => `<p class="small">${esc(p)}</p>`).join("")}</div><p class="hint">Word for word from the Court's question-presented document. ${outLink(c.qp_url, "The document")}</p>`)
      : ""}
  </div>`;
    })
    .join("");
  const decided = ((decidedTerm && decidedTerm.cases) || []).filter((c) => !c.pending_read);
  const main = `
<header class="page-head">
  <p class="label">The Supreme Court</p>
  <h1>${esc(termName(current.term))}</h1>
  <p class="subtitle">The cases the Court has agreed to hear, when it hears them, and its decisions as they're released.</p>
</header>
<section class="stack-sm" aria-labelledby="h-pending">
  <h2 class="label" id="h-pending">To be decided · ${pending.length}</h2>
  ${pendingCards || '<p class="small secondary">No cases granted for argument are waiting for a decision.</p>'}
  <p class="hint">From the Court's Granted &amp; Noted list (as of ${esc(fmtDate(current.built_on))}). ${outLink(current.source_url, "The list")}</p>
</section>
<section class="stack-sm" aria-labelledby="h-decided">
  <h2 class="label" id="h-decided">Decided this term · ${decided.length}</h2>
  ${decided.length ? `<div class="compact-list">${decided.map((c) => caseRow(current.term, c, c.author_code === "PC" ? "Per curiam" : "Decided", clauses)).join("")}</div>` : '<p class="small secondary">No decisions released yet this term.</p>'}
</section>
<p class="hint">ThePillory lists what the Court has granted and decided. It doesn't predict outcomes. <a class="inline-link" href="${COURT_HREF}">The justices</a></p>`;
  return main;
}

// ---------------------------------------------------------------------------
// One decision (/court/cases/<term>/<docket>/)

export async function casePage(env, request, term, docket) {
  const data = await loadTerm(env, request, term);
  const c = data && data.cases.find((x) => x.docket === docket);
  if (!c) return null;
  const [clauses, justices, current] = await Promise.all([constitutionLabels(env, request), loadJustices(env, request), loadCurrent(env, request)]);
  const granted = current && current.term === Number(term) ? current.cases.find((g) => g.dockets.includes(docket)) : null;
  const qp = c.question_presented || (granted && granted.question_presented) || [];
  const slugs = Object.fromEntries(((justices && justices.justices) || []).map((j) => [surname(j.name), j.slug]));
  const groups = lineupGroups(c);
  const named = (c.provisions || []).filter((p) => clauses[p.id]);
  const nameLink = (n) => {
    const s = n.replace(" (wrote)", "");
    return slugs[s] ? `<a class="inline-link" href="${justiceHref(slugs[s])}">${esc(n)}</a>` : esc(n);
  };
  return {
    title: c.name,
    main: `
<header class="page-head stack-xs">
  <p class="label">Supreme Court · ${esc(c.docket)} · Decided ${esc(fmtDate(c.date))}</p>
  <h1>${esc(c.name)}</h1>
  ${c.summary ? `<p class="subtitle">${esc(c.summary)}</p><p class="hint">The summary supremecourt.gov gives with the opinion.</p>` : ""}
  ${clauseChips(named.map((p) => ({ id: p.id, label: clauses[p.id] })))}
  <div class="stack-xs">${outLink(c.pdf, "The opinion (PDF)")}</div>
</header>
<section class="stack-sm" aria-labelledby="h-lineup">
  <h2 class="label" id="h-lineup">Who wrote and who joined</h2>
  ${c.author_code === "PC" && !groups.length
    ? '<div class="card"><p class="small">Per curiam: an unsigned opinion of the Court. Any justice who noted a different view is named in the opinion itself.</p></div>'
    : groups.length
      ? `<div class="card stack-xs">${c.lineup.unanimous ? '<p class="small"><strong>Unanimous.</strong></p>' : ""}${groups.map((g) => `<p class="small"><strong>${esc(g.label)}:</strong> ${g.names.map(nameLink).join(", ")}</p>`).join("")}</div>
         ${c.lineup_text ? fold("lineup-text", "As the syllabus states it", `<p class="small">${esc(c.lineup_text)}</p>`) : ""}`
      : '<p class="small secondary">The lineup isn\'t read yet; it\'s in the opinion.</p>'}
</section>
${qp.length ? fold("qp", "Question presented", `<div class="stack-xs">${qp.map((p) => `<p class="small">${esc(p)}</p>`).join("")}</div><p class="hint">Word for word from the Court's question-presented document.</p>`) : ""}
${named.length ? `<section class="stack-sm" aria-labelledby="h-provisions">
  <h2 class="label" id="h-provisions">The Constitution, in the Court's words</h2>
  ${named.map((p) => `<div class="card stack-xs"><a class="chip chip--parch chip--tap" href="/laws/constitution/#${esc(p.id)}">${esc(clauses[p.id])}</a>${p.quote ? `<blockquote class="quote">${esc(p.quote)}</blockquote>` : ""}</div>`).join("")}
  <p class="hint">Each provision the opinion of the Court names${c.exact_text === false ? "" : ", with the first sentence that names it, word for word"}. ThePillory doesn't characterize the ruling.${c.exact_text === false ? " The sentences aren't quoted here: the text of this decision's PDF (the bound volume's preliminary print) can't be copied exactly. They're in the opinion." : ""}</p>
</section>` : ""}
<p class="hint">From the Court's slip opinion as published on supremecourt.gov. <a class="inline-link" href="${TERM_HREF}">This term</a> · <a class="inline-link" href="${COURT_HREF}">The justices</a></p>`,
  };
}

// ---------------------------------------------------------------------------
// One justice (/justices/<slug>/)

const ORG = /\b(University|College|School|Society|Institute|Foundation|Association|Bar|Court|Council|Academy|Library|Museum|Law|Government|Department|Federal|State|Bank|Group|Trust|Press|Inc|LLC|Corp|Corporation|Company|Club|Fund|Center|Centre|Society|Federalist|Commission|Committee|Conference|Church|Synagogue|Embassy|Ministry|Office|Agency|Republic|Kingdom|City|County|Hotel|Publishing|Publishers|Books)\b/i;
/** A gift or reimbursement source: an organization by name; a person as "An individual" (ThePillory names no individuals in money records). Pure. */
export const sourceName = (s) => (s && ORG.test(s) ? s : "An individual");

export async function justicePage(env, request, slug, url) {
  const justices = await loadJustices(env, request);
  const j = justices && justices.justices.find((x) => x.slug === slug);
  if (!j) return null;
  const [index, disclosures, clauses] = await Promise.all([loadIndex(env, request), loadDisclosures(env, request), constitutionLabels(env, request)]);
  const since = isoOf(j.oath_date);

  // Record: every decision in the loaded terms where the lineup names this justice, newest first.
  const terms = (index && index.terms) || [];
  const rows = [];
  for (const t of terms) {
    const data = await loadTerm(env, request, t);
    for (const c of (data && data.cases) || []) {
      if (c.pending_read || (since && c.date < since)) continue;
      const p = positionFor(c, j.name);
      if (p) rows.push({ term: t, c, p });
    }
  }
  const offset = Math.max(0, Number(url.searchParams.get("offset")) || 0);
  const shown = rows.slice(0, offset + PAGE);
  const oldest = terms.length ? terms[terms.length - 1] : null;
  const s = j.senate;
  const about = `
<div class="card stack-xs">
  <p class="label">${esc(j.title)}</p>
  ${linkRow(s && s.nomination_url ? s.nomination_url : j.sources.senate, `Nominated by President ${j.appointed_by}`, s ? `${s.nominated}${s.predecessor ? ` · to succeed ${s.predecessor}` : ""}` : "")}
  ${s && s.roll_call_url ? linkRow(s.roll_call_url, `Confirmed by the Senate, ${s.vote}`, `Roll call vote No. ${s.roll_call}`) : ""}
  <p class="small">Took the oath ${esc(j.oath_date)} · appointed from ${esc(j.state)}</p>
</div>
${j.biography.length ? `<div class="card stack-xs"><p class="label">From the official biography</p>${j.biography.map((x) => `<p class="small">${esc(x)}</p>`).join("")}<p class="hint">${outLink(j.sources.biography, "supremecourt.gov")}</p></div>` : ""}`;

  const record = rows.length
    ? `<p class="small secondary">${rows.length} decisions${oldest ? ` since ${esc(termName(oldest))}` : ""} where the opinion's syllabus names ${esc(surname(j.name))}, newest first. Per curiam decisions (unsigned) aren't listed here.</p>
  <div class="compact-list">${shown.map(({ term, c, p }) => caseRow(term, c, positionText(p), clauses)).join("")}</div>
  ${rows.length > shown.length ? `<a class="btn btn--block" href="?offset=${offset + PAGE}#record">Load more</a>` : ""}`
    : '<p class="small secondary">No decisions loaded yet. They appear after the Supreme Court data refresh.</p>';

  const reports = disclosures && disclosures.justices && disclosures.justices[slug];
  const disclosureHtml = reports && reports.length
    ? reports
        .map((r, i) => fold(`fd-${r.year}-${i}`, `${r.year} report`, `
  ${r.report_url ? `<p class="small">${outLink(r.report_url, "The filed report")}</p>` : ""}
  <p class="label">Gifts · ${r.gifts.length}</p>
  ${r.gifts.length ? `<ul class="plain-list stack-xs">${r.gifts.map((g) => `<li class="small">${esc(sourceName(g.source))}${g.description ? `: ${esc(g.description)}` : ""}${g.value ? ` (${esc(g.value)})` : ""}</li>`).join("")}</ul>` : '<p class="small secondary">None reported.</p>'}
  <p class="label">Reimbursements · ${r.reimbursements.length}</p>
  ${r.reimbursements.length ? `<ul class="plain-list stack-xs">${r.reimbursements.map((x) => `<li class="small">${esc(sourceName(x.source))}${x.purpose ? `: ${esc(x.purpose)}` : ""}${x.location ? `, ${esc(x.location)}` : ""}${x.dates ? ` (${esc(x.dates)})` : ""}</li>`).join("")}</ul>` : '<p class="small secondary">None reported.</p>'}
  <p class="hint">${outLink(r.source_url, "On CourtListener")}</p>`, { meta: `${r.gifts.length + r.reimbursements.length} items` }))
        .join("")
      + '<p class="hint">Annual financial disclosure reports the justices file under the Ethics in Government Act, as CourtListener (Free Law Project) transcribes them, each linked to the filed report. Gifts and reimbursements from organizations are named; a person is listed as "An individual".</p>'
    : `<p class="small secondary">Coming soon for ${esc(j.name)}: the annual financial disclosure reports, gifts and reimbursements load from CourtListener.</p>`;

  const more = `
<div class="card">
  ${linkRow(COURT_HREF, "The Supreme Court", "Every justice")}
  ${linkRow(TERM_HREF, "This term", "Cases the Court will hear, and its decisions")}
  ${linkRow("/laws/constitution/#art-3", "Article III", "The judicial power, in the Constitution's words")}
</div>
<p class="hint">Sources: ${outLink(j.sources.members, "The Court's list of justices")} ${outLink(j.sources.senate, "The Senate's record of nominations")}</p>`;

  const tab = (k, label) => `<a role="tab" id="tab-${k}" href="#${k}" aria-controls="${k}">${label}</a>`;
  return {
    title: j.name,
    main: `
<header class="page-head stack-xs">
  <p class="label">The Supreme Court</p>
  <h1>${esc(j.name)}</h1>
  <p class="subtitle">${esc(j.title)} since ${esc(j.oath_date)}</p>
</header>
<div class="rep-tabs stack" data-tabs>
  <nav class="tabs tabs--four" role="tablist" aria-label="Sections">
    ${tab("about", "About")}${tab("record", "Record")}${tab("disclosures", "Disclosures")}${tab("more", "More")}
  </nav>
  <div class="stack" role="tabpanel" id="about" aria-labelledby="tab-about">${about}</div>
  <div class="stack" role="tabpanel" id="record" aria-labelledby="tab-record">${record}</div>
  <div class="stack" role="tabpanel" id="disclosures" aria-labelledby="tab-disclosures">${disclosureHtml}</div>
  <div class="stack" role="tabpanel" id="more" aria-labelledby="tab-more">${more}</div>
</div>`,
  };
}
