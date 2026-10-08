// /laws/                real bills your officials have voted on, and the Constitution
// /laws/bills/<id>/     one real bill: summary, constitutional analysis, how your reps voted
//   POST /laws/bills/<id>/flag           "Something wrong?" on a published analysis
//   POST /laws/bills/<id>/request-full   "Request full analysis"
//   Both need Turnstile and are rate-limited per visitor (functions/_lib/turnstile.js).
// /laws/constitution/ is static and passed through. Old sample pages redirect (OLD_PAGES).
import { CURRENT, loadElection, electionHref, whenLine } from "../_lib/elections.js";
import { tagsFor, topicChips, tagNote } from "../_lib/topics.js";
import { pacificNow } from "../_lib/meetings.js";
import { page, notFound, notLoaded, esc, linkRow, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { billById, votesOnBill, officialsWhere } from "../_lib/data.js";
import { billRows, orderRows, constitutionRows, topClauses, BILL_FILTERS, ORDER_FILTERS, PER_PAGE } from "../_lib/laws-list.js";
import { districtsFromCookie, repsWhere, describe } from "../_lib/districts.js";
import { billHref } from "../_lib/votes.js";
import { lobbyingFor, industryMoney, followTheMoney, cycleOf } from "../_lib/funding.js";
import { outcomeFor, outcomeSection } from "../_lib/executive.js";
import { currentAnalysis, parse, provisionsFor, baselineSection, isPublic, openFlagCount, analysisClauses, constitutionBrief } from "../_lib/analysis.js";
import { summaryHead, contentsBar, fold, clauseChips, statusChip, compactRow, shortLabel } from "../_lib/summary.js";
import { billStatus, billSummary, yourRepsCard, billHistory, billFullText } from "../_lib/bill-page.js";
import { rollCallFilters, rollCallRows, rollCallBreakdown, pickVote, votePicker, voteHeading, totalsSection, rollCallFilterForm, rollCallList } from "../_lib/rollcall.js";
import { orderById, orderHref, orderIdFromSlug, orderLabel, orderStatus, orderSummary, authoritySection, courtsSection, orderHistory, orderFullText } from "../_lib/orders.js";
import { turnstileReady, turnstileWidget, verifyTurnstile, visitorHash, actionsToday, recordAction } from "../_lib/turnstile.js";

const FLAGS_PER_VISITOR = 5; // per day
const FULL_REQUESTS_PER_VISITOR = 3; // per day
const FLAG_REASONS = [
  ["inaccurate", "Inaccurate"],
  ["unfair", "Unfair to one side"],
  ["missing", "Missing perspective"],
  ["other", "Other"],
];
const CATEGORY_NAMES = {
  commemoration: "a commemoration",
  awareness: "an awareness day, week or month",
  naming: "a naming",
  honorary: "an honorary measure",
  procedural_rule: "a procedural rule for debating another bill",
  other_routine: "a routine measure",
};

const LEVELS = { federal: "Federal", state: "State" };

// Sample pages that were removed, and where they go now: sample laws to the
// Laws index, sample clause pages to the same provision in the full text.
const OLD_PAGES = {
  "bill-broadband": "/laws/",
  "bill-constituent-access": "/laws/",
  "res-public-comment": "/laws/",
  "constitution/amend-1": "/laws/constitution/#amend-1",
  "constitution/amend-10": "/laws/constitution/#amend-10",
  "constitution/amend-14": "/laws/constitution/#amend-14-sec-1",
  "constitution/art-1-sec-2": "/laws/constitution/#art-1-sec-2",
  "constitution/art-1-sec-3": "/laws/constitution/#art-1-sec-3",
};

function ordinal(n) {
  const v = n % 100;
  return n + (v >= 11 && v <= 13 ? "th" : { 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th");
}

const SHOWS = { bills: "Bills", orders: "Orders", constitution: "Constitution" };

const lawsHref = ({ show = "bills", filter = "all", clause = null, offset = 0 } = {}) => {
  const q = new URLSearchParams();
  if (show !== "bills") q.set("show", show);
  if (filter && filter !== "all") q.set("filter", filter);
  if (clause) q.set("clause", clause);
  if (offset) q.set("offset", String(offset));
  const s = q.toString();
  return `/laws/${s ? `?${s}` : ""}`;
};

// The Laws list: Bills / Orders / Constitution, one compact line per item, filter
// chips, and "Load more" (a plain link to the next page; app.js appends it in place).
async function index(env, url, request) {
  const p = url.searchParams;
  const show = SHOWS[p.get("show")] ? p.get("show") : "bills";
  // Older addresses: ?level=federal|state and ?votes=all.
  const filters = show === "orders" ? ORDER_FILTERS : BILL_FILTERS;
  let filter = p.get("filter") || (p.get("votes") === "all" ? "any" : p.get("level") === "federal" ? "federal" : p.get("level") === "state" ? "state" : "all");
  if (show === "constitution" || !filters[filter]) filter = "all";
  const clause = show === "constitution" && /^[a-z0-9-]{1,40}$/.test(p.get("clause") || "") ? p.get("clause") : null;
  const offset = Math.max(0, parseInt(p.get("offset") || "0", 10) || 0);
  if (!env.DB) return notLoaded("Laws", "laws", true);
  const db = env.DB;
  const list = await loadSection(`laws ${show}`, () =>
    show === "orders" ? orderRows(db, { filter, offset }) : show === "constitution" ? constitutionRows(db, { clause, offset }) : billRows(db, { filter, offset })
  );
  const chipsData = show === "constitution" ? await loadSection("laws clauses", () => topClauses(db), []) : null;

  const switcher = `<nav class="segmented list-switch" aria-label="Show">${Object.entries(SHOWS)
    .map(([k, label]) => `<a class="toggle" href="${lawsHref({ show: k })}"${k === show ? ' aria-current="true"' : ""}>${label}</a>`)
    .join("")}</nav>`;
  const chip = (href, label, on) => `<a href="${esc(href)}"${on ? ' aria-current="true"' : ""}>${esc(label)}</a>`;
  const chips =
    show === "constitution"
      ? chipsData && chipsData !== FAILED && chipsData.length
        ? `<nav class="filter-chips" aria-label="Filter by clause">${chip(lawsHref({ show }), "All", !clause)}${chipsData.map((c) => chip(lawsHref({ show, clause: c.id }), shortLabel(c.label), clause === c.id)).join("")}</nav>`
        : ""
      : `<nav class="filter-chips" aria-label="Filter">${Object.entries(filters).map(([k, [label]]) => chip(lawsHref({ show, filter: k }), label, k === filter)).join("")}</nav>`;
  const empty = {
    bills: list && list.provisional ? "The bill list is being prepared. It appears within a few minutes of the next data sync starting." : "No bills here yet.",
    orders: "No executive orders here yet. They appear after the data sync loads them from the Federal Register and the Governor's Office.",
    constitution: "No checked analyses yet. Bills and executive orders appear here once their constitutional analysis is written and checked.",
  }[show];
  const rows = list === FAILED ? sectionError("") : `<section class="card compact-list" id="law-list" data-more-list>${list.rows.map(compactRow).join("") || `<p class="secondary small cr-empty">${esc(empty)}</p>`}</section>`;
  const more = list !== FAILED && list.more ? `<a class="btn btn--block load-more" href="${lawsHref({ show, filter, clause, offset: offset + PER_PAGE })}" data-load-more="law-list">Load more</a>` : "";
  const notes = {
    bills: "Bills in Congress and the California Legislature with recorded votes, newest final vote first. Each line shows its latest final action or final-passage vote, and the first clause of the Constitution its checked analysis maps.",
    orders: "Executive orders of the President (Federal Register) and the Governor of California (Governor's Office), newest first, the same way for every officeholder.",
    constitution: "Bills and executive orders with a checked constitutional analysis, newest first. Choose a clause to see everything mapped to it. ThePillory maps the Constitution; it doesn't rule on it.",
  }[show];

  // A later page ("Load more" without JavaScript).
  if (offset) {
    const main = `
<header class="page-head"><h1>${SHOWS[show]}</h1><p class="subtitle">From number ${offset + 1}.</p></header>
${rows}
${more}`;
    return page(`Laws: ${SHOWS[show]}`, main, { tab: "laws", back: ["Laws", lawsHref({ show, filter, clause })], partial: list === FAILED });
  }

  // On the ballot: propositions and measures are proposed laws, so the next election is linked here too.
  const election = show === "bills" ? await loadSection("laws election", () => loadElection(env, request, CURRENT), null) : null;
  const moreLinks = [
    election && election !== FAILED ? linkRow(electionHref(election.election.id), `On the ballot: ${election.election.name}`, whenLine(election, pacificNow().slice(0, 10))) : "",
    show !== "constitution" ? linkRow("/laws/constitution/", "The Constitution", "The full text, as the National Archives transcribes it") : "",
    linkRow("/topics/", "Laws by subject", "Bills, votes, meeting items and orders by topic"),
    linkRow("/finances/", "Public finances by term", "The Time Machine"),
  ].join("");
  const main = `
<header class="page-head">
  <h1>Laws</h1>
  <p class="subtitle">Bills, executive orders, and the Constitution they answer to.</p>
</header>
${switcher}
${show === "constitution" ? `<a class="parchment stack-sm constitution-link" href="/laws/constitution/"><p class="label">The Constitution</p><p class="small">The full text, as the National Archives transcribes it →</p></a>` : ""}
${chips}
${rows}
${more}
<p class="hint">${esc(notes)}</p>
<section class="card"><h2 class="label">More in Laws</h2>${moreLinks}</section>
`;
  return page("Laws", main, { tab: "laws", root: true, partial: list === FAILED || (list && list.provisional) });
}

// The current analysis and what the page needs around it. Missing tables
// (before the analysis step's first run) just mean there's no analysis yet.
async function analysisFor(db, id) {
  const none = { a: null, row: null, provisions: new Map(), flags: 0, relevance: null, pendingFull: false };
  try {
    const row = await currentAnalysis(db, id);
    const relevance = await db.prepare("SELECT * FROM bill_relevance WHERE bill_id = ?").bind(id).first();
    const pendingFull = await db
      .prepare("SELECT id FROM analysis_requests WHERE bill_id = ? AND status = 'pending' AND depth = 'full'")
      .bind(id)
      .first();
    if (!row) return { ...none, relevance, pendingFull: Boolean(pendingFull) };
    const a = parse(row);
    return {
      a: isPublic(row) ? a : null,
      row,
      provisions: await provisionsFor(db, a.clauses.map((c) => c.id)),
      flags: isPublic(row) ? await openFlagCount(db, row.id) : 0,
      relevance,
      pendingFull: Boolean(pendingFull),
    };
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return none;
    throw err;
  }
}

const skipped = (r) => r && r.verdict === "skip" && r.override !== "unskip";

const MESSAGES = {
  flag: "Thank you. Your report went to the review queue, and the analysis is marked \"Under review\" until a person checks it (this page can take a few minutes to update).",
  full: "Thank you. A full analysis is requested; it's usually written within a day, then checked like every analysis.",
  turnstile: "The anti-spam check didn't go through. Please try again.",
  limit: "You've reached today's limit for this. Please try again tomorrow.",
  busy: "Today's full-analysis requests are used up. Please try again tomorrow.",
  closed: "This form isn't open yet.",
  invalid: "Something was missing from the form. Please try again.",
};

/** "Something wrong?" and "Request full analysis", under the analysis. */
function readerForms(env, id, analysis, { base = billHref(id), noun = "bill" } = {}) {
  const { a, row, relevance, pendingFull } = analysis;
  const ready = turnstileReady(env);
  const action = (what) => `${base}${what}`;
  const closed = '<p class="small secondary">This form isn\'t open yet.</p>';
  const parts = [];
  if (a) {
    parts.push(`
<details class="reader-form" id="something-wrong">
  <summary>Something wrong?</summary>
  ${
    ready
      ? `<form method="post" action="${action("flag")}" class="stack-sm">
    <fieldset class="stack-sm bare">
      <legend class="small">What's the problem?</legend>
      ${FLAG_REASONS.map(([v, label], i) => `<label class="radio-row"><input type="radio" name="reason" value="${v}"${i === 0 ? " required" : ""}> ${label}</label>`).join("")}
    </fieldset>
    <label class="field"><span class="field-label">Explain (optional)</span><textarea class="textarea" name="note" rows="3" maxlength="1000"></textarea></label>
    <p class="hint">No account needed. A person reads every report; the analysis stays up, marked "Under review", until then.</p>
    ${turnstileWidget(env)}
    <button class="btn" type="submit">Send report</button>
  </form>`
      : closed
  }
</details>`);
  }
  const canRequest = !skipped(relevance) && !(row && row.depth === "full" && (a || row.status === "ai_draft"));
  if (pendingFull) {
    parts.push('<p class="small">A full analysis has been requested. It\'s usually written within a day, then checked like every analysis.</p>');
  } else if (canRequest && (a || !row)) {
    parts.push(`
<div class="reader-form stack-sm" id="request-full">
  <p class="small">${a ? `Want more than the short card? A full analysis covers every provision the ${noun} touches, contested readings, and what it can't tell you.` : `Want an analysis of this ${noun}? A full analysis maps every provision it touches.`}</p>
  ${
    ready
      ? `<form method="post" action="${action("request-full")}" class="stack-sm">${turnstileWidget(env)}<button class="btn" type="submit">Request full analysis</button></form>`
      : closed
  }
</div>`);
  }
  if (!parts.length) return "";
  return `<div class="stack-sm reader-forms">${parts.join("")}</div>`;
}

async function bill(env, id, url, request, { analysisPage = false } = {}) {
  const districts = districtsFromCookie(request);
  if (!env.DB) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  const db = env.DB;
  const b = await loadSection("bill", () => billById(db, id), undefined);
  if (b === undefined) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  if (b === FAILED) throw new Error(`bill ${id} couldn't load`);
  if (!b) return notFound("No bill at this address.", "laws", ["Laws", "/laws/"]);
  const sent = MESSAGES[url.searchParams.get("sent")] || null;
  const error = MESSAGES[url.searchParams.get("error")] || null;
  const banners = `${sent ? `<p class="banner" role="status">${esc(sent)}</p>` : ""}${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}`;
  const analysisLoaded = await loadSection("bill analysis", () => analysisFor(db, id));
  const analysis = analysisLoaded === FAILED
    ? { a: null, row: null, provisions: new Map(), flags: 0, relevance: null, pendingFull: false, failed: true }
    : analysisLoaded;
  const empty = skipped(analysis.relevance)
    ? `<p>Not analyzed. Before any analysis is written, a quick check sets aside ceremonial and routine measures; it found this bill to be ${esc(CATEGORY_NAMES[analysis.relevance.category] || "a routine measure")}: ${esc(analysis.relevance.reason)}</p>`
    : analysis.row
      ? "<p>An analysis of this bill is being checked. It appears here once it passes review.</p>"
      : "";
  const href = billHref(id);

  // The full analysis: its own page, linked from the collapsed Constitution section.
  if (analysisPage) {
    const main = `
<header class="page-head">
  <p class="label">${esc(b.bill_number)} · Constitutional analysis</p>
  <h1>${esc(b.title)}</h1>
</header>
${banners}
${analysis.failed ? sectionError("Constitutional baseline") : baselineSection(analysis.a, analysis.provisions, { underReview: analysis.flags > 0, empty, after: readerForms(env, id, analysis) })}`;
    return page(`${b.bill_number}: constitutional analysis`, main, { tab: "laws", back: [b.bill_number, href], partial: analysisLoaded === FAILED });
  }

  // Each section loads on its own: one that can't load shows a short note, and
  // the rest of the page still shows.
  const reps = districts ? await loadSection("bill reps", () => officialsWhere(db, repsWhere(districts)), []) : [];
  const repIds = reps === FAILED ? [] : reps.map((o) => o.id);
  const [votes, lobbying, outcome, topics] = await Promise.all([
    loadSection("bill votes", () => votesOnBill(db, id, repIds), []),
    b.level === "federal" ? loadSection("bill lobbying", () => lobbyingFor(db, id), null) : null,
    loadSection("bill outcome", () => outcomeFor(db, id), { outcome: null, checked: null }),
    loadSection("bill topics", () => tagsFor(db, "bill", [id]), new Map()),
  ]);
  const billTopics = topics === FAILED ? [] : topics.get(id) || [];
  const voteList = votes === FAILED ? [] : votes;
  // Each rep's latest final-passage position on this bill, beside contributions in
  // that two-year period from the industries that lobbied on it.
  let repMoney = [];
  let cycle = null;
  if (districts && reps !== FAILED && votes !== FAILED && lobbying && lobbying !== FAILED && lobbying.orgs.length) {
    const finals = votes.filter((v) => v.vote_type === "final_passage");
    const federal = reps.filter((o) => o.level === "federal");
    const latest = finals[0] || votes[0];
    cycle = cycleOf(latest && latest.vote_date);
    const m = await loadSection("bill rep money", () => industryMoney(db, federal.map((o) => o.id), lobbying.industries, cycle), {});
    repMoney = m === FAILED ? [] : federal.map((rep) => {
      const v = finals.find((x) => x.positions.some((p) => p.slug === rep.slug));
      const p = v && v.positions.find((x) => x.slug === rep.slug);
      return { rep, vote: v || null, position: p ? p.position : null, money: m[rep.id] };
    });
  }

  const a = analysis.a;
  const clauses = analysisClauses(a, analysis.provisions);
  const status = outcome === FAILED ? "" : billStatus(b, outcome, voteList);
  const session = b.level === "federal" ? `${ordinal(parseInt(b.session, 10))} Congress` : `California, ${esc(b.session.slice(0, 4))}–${esc(b.session.slice(4))} session`;
  const head = summaryHead({
    kicker: `${LEVELS[b.level]} · ${esc(b.bill_number)} · ${session}`,
    status: statusChip(status),
    title: b.title,
    summary: billSummary(b, a),
    none: "No summary yet. The official page has the bill's text and status.",
    chips: clauseChips(clauses),
  });
  const constitution = analysis.failed
    ? '<p class="small secondary">Couldn\'t load the analysis right now.</p>'
    : a
      ? constitutionBrief(a, analysis.provisions, { fullHref: `${href}analysis/`, underReview: analysis.flags > 0 })
      : `${empty || "<p class=\"small\">Not yet mapped. The parts of the Constitution this bill touches appear here once an analysis is written and checked.</p>"}${readerForms(env, id, analysis)}`;
  // All votes: a picker of every recorded vote (final passage by default), its
  // totals by party and by state, and the full roll call, 20 members at a time.
  const selected = votes === FAILED ? null : pickVote(voteList, url.searchParams.get("vote"));
  const filters = { q: "", position: "", party: "", state: "", offset: 0 };
  const [breakdown, roll] = selected
    ? await Promise.all([loadSection("bill breakdown", () => rollCallBreakdown(db, selected.id)), loadSection("bill roll call", () => rollCallRows(db, selected.id, filters))])
    : [null, null];
  const yoursOnIt = districts && selected && selected.positions.length
    ? `<div class="card--flat stack-xs"><p class="label">Your reps on this vote</p>${selected.positions.map((p) => `<div class="rep-vote"><a href="/reps/${esc(p.slug)}/">${esc(p.name)}</a><span class="position" title="Recorded as: ${esc(p.raw_position)}">${esc(p.position)}</span></div>`).join("")}</div>`
    : "";
  const votesInner = votes === FAILED
    ? '<p class="small secondary">Couldn\'t load the votes right now.</p>'
    : !selected
      ? '<p class="secondary small">No recorded votes loaded for this bill.</p>'
      : `${votePicker(voteList, selected, `${href}#votes`)}
  ${voteHeading(selected)}
  ${yoursOnIt}
  ${breakdown === FAILED ? '<p class="small secondary">Couldn\'t load the totals by party and state right now.</p>' : totalsSection(selected, breakdown, { federal: b.level === "federal" })}
  <h3 class="roll-head">Every member's vote</h3>
  ${breakdown === FAILED ? "" : rollCallFilterForm(id, selected, filters, { parties: breakdown.byParty.map((x) => x.name), states: breakdown.byState.map((x) => x.name), federal: b.level === "federal" })}
  ${roll === FAILED ? '<p class="small secondary">Couldn\'t load the roll call right now.</p>' : rollCallList(id, selected, filters, roll)}
  <p class="hint">From the official record of each vote. A member who left office keeps their recorded position; their page shows the years they served.</p>`;
  const lastDate = voteList[0] ? fmtDate(voteList[0].vote_date) : "";
  const main = `
${contentsBar([["summary", "Summary"], ["your-reps", "Your reps"], ["constitution", "Constitution"], ["votes", "All votes"], ["money", "Money"], ["history", "History"], ["full-text", "Full text"]])}
${head}
${banners}
${yourRepsCard(b, { districts, reps: reps === FAILED ? [] : reps, votes: voteList, failed: reps === FAILED || votes === FAILED })}
${fold("constitution", "Constitution", constitution, { meta: clauses.length ? `${clauses.length} ${clauses.length === 1 ? "provision" : "provisions"}` : "", cls: "fold--parch", open: Boolean(sent || error) })}
${fold("votes", "All votes", votesInner, { meta: votes === FAILED ? "" : `${voteList.length} recorded`, open: Boolean(url.searchParams.get("vote")) })}
${fold("money", "Money", lobbying === FAILED ? '<p class="small secondary">Couldn\'t load this section right now.</p>' : followTheMoney(b, lobbying, { reps: districts && reps !== FAILED ? reps : null, repMoney, cycle, bare: true }))}
${fold("history", "History", `${billHistory(b, outcome === FAILED ? null : outcome, voteList)}${outcome === FAILED ? sectionError("Final action") : outcomeSection(b, outcome)}`, { meta: lastDate })}
${fold("full-text", "Full text", billFullText(b, analysis.row && isPublic(analysis.row) ? analysis.row : null))}
${billTopics.length ? `<section class="stack-sm">${topicChips(billTopics)}<p class="hint">${esc(tagNote(billTopics[0]))} <a class="inline-link" href="/about/methodology/#topics">How topics work</a></p></section>` : ""}
`;
  return page(`${b.bill_number}: ${b.title}`, main, { tab: "laws", back: ["Laws", "/laws/"], personal: true, partial: anyFailed(reps, votes, analysisLoaded, lobbying, outcome) });
}

// ---------------------------------------------------------------------------
// An executive order: the same layout for every President and Governor.

async function orderPage(env, id, url, { analysisPage = false } = {}) {
  const back = ["Laws", "/laws/?show=orders"];
  if (!env.DB) return notLoaded("Laws", "laws", false, back);
  const db = env.DB;
  const a = await loadSection("order", () => orderById(db, id), undefined);
  if (a === undefined) return notLoaded("Laws", "laws", false, back);
  if (a === FAILED) throw new Error(`order ${id} couldn't load`);
  if (!a) return notFound("No executive order at this address.", "laws", back);
  const sent = MESSAGES[url.searchParams.get("sent")] || null;
  const error = MESSAGES[url.searchParams.get("error")] || null;
  const banners = `${sent ? `<p class="banner" role="status">${esc(sent)}</p>` : ""}${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}`;
  const href = orderHref(id);
  const analysisLoaded = await loadSection("order analysis", () => analysisFor(db, id));
  const analysis = analysisLoaded === FAILED
    ? { a: null, row: null, provisions: new Map(), flags: 0, relevance: null, pendingFull: false, failed: true }
    : analysisLoaded;
  const empty = analysis.row ? "<p>An analysis of this order is being checked. It appears here once it passes review.</p>" : "";
  const forms = a.kind === "executive_order" ? readerForms(env, id, analysis, { base: href, noun: "order" }) : "";
  const label = orderLabel(a);
  if (analysisPage) {
    const main = `
<header class="page-head">
  <p class="label">${esc(label)} · Constitutional analysis</p>
  <h1>${esc(a.title)}</h1>
</header>
${banners}
${analysis.failed ? sectionError("Constitutional baseline") : baselineSection(analysis.a, analysis.provisions, { underReview: analysis.flags > 0, empty, after: forms, noun: "order" })}`;
    return page(`${label}: constitutional analysis`, main, { tab: "laws", back: [label, href], partial: analysisLoaded === FAILED });
  }
  const topics = await loadSection("order topics", () => tagsFor(db, "executive_action", [id]), new Map());
  const tags = topics === FAILED ? [] : topics.get(id) || [];
  const an = analysis.a;
  const clauses = analysisClauses(an, analysis.provisions);
  const issuer = a.official_name
    ? `${a.official_active && a.official_slug ? `<a class="inline-link" href="/reps/${esc(a.official_slug)}/">${esc(a.official_name)}</a>` : esc(a.official_name)}, ${esc(a.official_office || "")}`
    : esc(String(id).startsWith("fr:") ? "The President" : "The Governor of California");
  const head = summaryHead({
    kicker: `${String(id).startsWith("fr:") ? "President" : "Governor of California"} · ${esc(label)}`,
    status: orderStatus(a).map(statusChip).join(""),
    title: a.title,
    summary: orderSummary(an),
    none: "No summary yet: it's written with the order's constitutional analysis. The order's own text is under Full text.",
    chips: clauseChips(clauses),
    extra: `<p class="small secondary">Issued by ${issuer}</p>`,
  });
  const constitution = analysis.failed
    ? '<p class="small secondary">Couldn\'t load the analysis right now.</p>'
    : an
      ? constitutionBrief(an, analysis.provisions, { fullHref: `${href}analysis/`, underReview: analysis.flags > 0 })
      : `${empty || '<p class="small">Not yet mapped. The parts of the Constitution this order touches appear here once an analysis is written and checked, the same way as for bills.</p>'}${forms}`;
  const main = `
${contentsBar([["summary", "Summary"], ["authority", "Authority"], ["courts", "In the courts"], ["constitution", "Constitution"], ["history", "History"], ["full-text", "Full text"]])}
${head}
${banners}
${authoritySection(a)}
${courtsSection(a)}
${fold("constitution", "Constitution", constitution, { meta: clauses.length ? `${clauses.length} ${clauses.length === 1 ? "provision" : "provisions"}` : "", cls: "fold--parch", open: Boolean(sent || error) })}
${fold("history", "History", orderHistory(a), { meta: a.signed_on ? fmtDate(a.signed_on) : "" })}
${fold("full-text", "Full text", orderFullText(a))}
${tags.length ? `<section class="stack-sm">${topicChips(tags)}<p class="hint">${esc(tagNote(tags[0]))} <a class="inline-link" href="/about/methodology/#topics">How topics work</a></p></section>` : ""}
`;
  return page(`${label}: ${a.title}`, main, { tab: "laws", back, partial: analysisLoaded === FAILED || topics === FAILED });
}

// ---------------------------------------------------------------------------
// One vote's roll call, 20 members at a time (/laws/bills/<id>/rollcall/?vote=…):
// the page "Load more", the search box and the filters fetch; also a page of
// its own without JavaScript. The same for every visitor.

async function rollCallPage(env, id, url) {
  if (!env.DB) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  const db = env.DB;
  const f = rollCallFilters(url);
  const b = await billById(db, id);
  if (!b) return notFound("No bill at this address.", "laws", ["Laws", "/laws/"]);
  const v = f.vote ? await db.prepare("SELECT * FROM votes WHERE id = ? AND bill_id = ?").bind(f.vote, id).first() : null;
  if (!v) return Response.redirect(`${url.origin}${billHref(id)}#votes`, 302);
  const [breakdown, roll] = await Promise.all([rollCallBreakdown(db, v.id), rollCallRows(db, v.id, f)]);
  const main = `
<header class="page-head">
  <p class="label">${esc(b.bill_number)} · Roll call</p>
  <h1>${esc(b.title)}</h1>
</header>
<section class="card stack-sm">
  ${voteHeading(v)}
  ${rollCallFilterForm(id, v, f, { parties: breakdown.byParty.map((x) => x.name), states: breakdown.byState.map((x) => x.name), federal: b.level === "federal" })}
</section>
${rollCallList(id, v, f, roll)}`;
  return page(`${b.bill_number}: roll call`, main, { tab: "laws", back: [b.bill_number, `${billHref(id)}?vote=${encodeURIComponent(v.id)}#votes`] });
}

// The Laws list is the same for every visitor: kept at the edge for a few minutes.
const LAWS_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return edgeCached(context, LAWS_CACHE_SECONDS, () => index(context.env, url, context.request));
  // The reader forms post to these; a plain visit goes back to the page.
  if (["bills", "orders"].includes(parts[0]) && parts.length === 3 && ["flag", "request-full"].includes(parts[2])) {
    return Response.redirect(`${url.origin}/laws/${parts[0]}/${parts[1]}/`, 302);
  }
  if (parts[0] === "orders" && (parts.length === 2 || (parts.length === 3 && parts[2] === "analysis"))) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    const id = orderIdFromSlug(decodeURIComponent(parts[1]));
    if (!id) return notFound("No executive order at this address.", "laws", ["Laws", "/laws/?show=orders"]);
    return edgeCached(context, LAWS_CACHE_SECONDS, () => orderPage(context.env, id, url, { analysisPage: parts.length === 3 }));
  }
  if (parts[0] === "bills" && parts.length === 3 && parts[2] === "rollcall") {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return edgeCached(context, LAWS_CACHE_SECONDS, () => rollCallPage(context.env, decodeURIComponent(parts[1]), url));
  }
  if (parts[0] === "bills" && (parts.length === 2 || (parts.length === 3 && parts[2] === "analysis"))) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return bill(context.env, decodeURIComponent(parts[1]), url, context.request, { analysisPage: parts.length === 3 });
  }
  const old = OLD_PAGES[parts.join("/")];
  if (old) return Response.redirect(`${url.origin}${old}`, 301);
  // Static pages: /laws/constitution/.
  return context.next();
}, { tab: "laws" });

// ---------------------------------------------------------------------------
// Reader actions

async function readerPost(context, id, what, { order = false } = {}) {
  const { request, env } = context;
  const url = new URL(request.url);
  // Back to the page the form was on: the full analysis, or the page's Constitution section.
  const onAnalysis = /\/analysis\/?$/.test(new URL(request.headers.get("Referer") || url.origin).pathname);
  const home = order ? orderHref(id) : billHref(id);
  const back = (q) => Response.redirect(`${url.origin}${home}${onAnalysis ? "analysis/" : ""}?${q}#${onAnalysis ? "baseline" : "constitution"}`, 303);
  const origin = request.headers.get("Origin");
  if (origin && origin !== url.origin) return new Response("Refused", { status: 403 });
  if (!env.DB || !turnstileReady(env)) return back("error=closed");
  const form = await request.formData();
  if (!(await verifyTurnstile(env, form.get("cf-turnstile-response"), request.headers.get("CF-Connecting-IP")))) return back("error=turnstile");
  const db = env.DB;
  const visitor = await visitorHash(env, request);

  if (what === "flag") {
    const reason = String(form.get("reason") || "");
    if (!FLAG_REASONS.some(([v]) => v === reason)) return back("error=invalid");
    const row = await currentAnalysis(db, id);
    if (!row || !isPublic(row)) return back("error=invalid");
    if ((await actionsToday(db, "flag", visitor)) >= FLAGS_PER_VISITOR) return back("error=limit");
    const note = String(form.get("note") || "").replace(/\s+/g, " ").trim().slice(0, 1000);
    await db.batch([
      db.prepare("INSERT INTO analysis_flags (analysis_id, bill_id, reason, note) VALUES (?, ?, ?, ?)").bind(row.id, id, reason, note),
      recordAction(db, "flag", visitor),
    ]);
    return back("sent=flag");
  }

  // request-full
  if (order) {
    const x = await db.prepare("SELECT id FROM executive_actions WHERE id = ? AND kind = 'executive_order'").bind(id).first();
    if (!x) return back("error=invalid");
    // Orders share the analysis tables once the sync has opened them to orders (migration 0018).
    await db.prepare("SELECT supporters FROM bill_analyses LIMIT 0").all();
  } else {
    const b = await billById(db, id);
    if (!b) return back("error=invalid");
    const relevance = await db.prepare("SELECT verdict, override FROM bill_relevance WHERE bill_id = ?").bind(id).first();
    if (skipped(relevance)) return back("error=invalid");
  }
  const pending = await db.prepare("SELECT id FROM analysis_requests WHERE bill_id = ? AND status = 'pending' AND depth = 'full'").bind(id).first();
  if (pending) return back("sent=full");
  if ((await actionsToday(db, "full_request", visitor)) >= FULL_REQUESTS_PER_VISITOR) return back("error=limit");
  const today = await db
    .prepare("SELECT COUNT(*) AS n FROM analysis_requests WHERE source = 'reader' AND requested_at > datetime('now', '-1 day')")
    .first();
  if (today && today.n >= parseInt(env.READER_FULL_REQUESTS_DAILY || "10", 10)) return back("error=busy");
  await db.batch([
    db.prepare("INSERT INTO analysis_requests (bill_id, requested_by, depth, source) VALUES (?, 'reader', 'full', 'reader')").bind(id),
    recordAction(db, "full_request", visitor),
  ]);
  return back("sent=full");
}

export async function onRequestPost(context) {
  const parts = (context.params.path || []).filter(Boolean);
  if (["bills", "orders"].includes(parts[0]) && parts.length === 3 && ["flag", "request-full"].includes(parts[2])) {
    const order = parts[0] === "orders";
    const id = order ? orderIdFromSlug(decodeURIComponent(parts[1])) : decodeURIComponent(parts[1]);
    if (!id) return new Response("Not found", { status: 404 });
    try {
      return await readerPost(context, id, parts[2] === "flag" ? "flag" : "full", { order });
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return new Response("Not available yet", { status: 503 });
      throw err;
    }
  }
  return new Response("Not found", { status: 404 });
}
