// /laws/                real bills your officials have voted on, and the Constitution
// /laws/bills/<id>/     one real bill: summary, constitutional analysis, how your reps voted
//   POST /laws/bills/<id>/flag           "Something wrong?" on a published analysis
//   POST /laws/bills/<id>/request-full   "Request full analysis"
//   Both need Turnstile and are rate-limited per visitor (functions/_lib/turnstile.js).
// /laws/constitution/ is static and passed through. Old sample pages redirect (OLD_PAGES).
import { page, notFound, notLoaded, esc, safeUrl, section, sourceLink, card, fmtDate, loadSection, FAILED, anyFailed, sectionError, guard, edgeCached } from "../_lib/render.js";
import { billList, BILLS_PER_PAGE, billById, votesOnBill, officialsWhere, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe } from "../_lib/districts.js";
import { billVote, billHref } from "../_lib/votes.js";
import { lobbyingFor, industryMoney, followTheMoney, cycleOf } from "../_lib/funding.js";
import { outcomeFor, outcomeSection, OUTCOME_LABEL } from "../_lib/executive.js";
import { currentAnalysis, parse, provisionsFor, baselineSection, isPublic, openFlagCount, METHOD_URL } from "../_lib/analysis.js";
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

// A row of bill_list (built during the sync): the latest final-passage vote's
// result and totals, and the final action when one is recorded.
function billCard(b, all) {
  const tally = b.yea != null || b.nay != null ? ` · Yes ${b.yea ?? "–"}, No ${b.nay ?? "–"}` : "";
  const chips = [
    b.final_result ? `<span class="chip chip--quiet">Latest final vote: ${esc(b.final_result)}${esc(tally)}</span>` : "",
    b.outcome && b.outcome !== "presented" ? `<span class="chip chip--quiet">${esc(OUTCOME_LABEL[b.outcome] || b.outcome)} · ${fmtDate(b.outcome_date)}</span>` : "",
  ].join("");
  return card({
    href: billHref(b.bill_id),
    label: `${LEVELS[b.level]} · ${CHAMBER_NAME[b.chamber] || "Bill"}`,
    title: `${b.bill_number}: ${b.title}`,
    who: b.level === "federal" ? `${ordinal(parseInt(b.session, 10))} Congress` : `California, ${b.session.slice(0, 4)}–${b.session.slice(4)} session`,
    chips,
    left: all || !b.last_final ? `Last vote: <strong>${fmtDate(b.last_vote)}</strong>` : `Last final vote: <strong>${fmtDate(b.last_final)}</strong>`,
    right: `Recorded votes: <strong>${b.vote_count}</strong>`,
    level: b.level,
  });
}

const lawsHref = ({ all, level, offset }) => {
  const q = new URLSearchParams();
  if (all) q.set("votes", "all");
  if (level) q.set("level", level);
  if (offset) q.set("offset", String(offset));
  const s = q.toString();
  return `/laws/${s ? `?${s}` : ""}`;
};

// One level's list: up to BILLS_PER_PAGE cards, then "Load more" (a plain link
// to the next page of that level; app.js appends it in place).
function billSection(level, list, { all, offset = 0, heading = true }) {
  const id = `bills-${level}`;
  const head = heading ? `<h2 class="label">${LEVELS[level]}</h2>` : "";
  if (list === FAILED) return sectionError(LEVELS[level]);
  if (!list) {
    return `<section class="stack">${head}<p class="secondary small">The bill list is being prepared. It appears within a few minutes of the next data sync starting.</p></section>`;
  }
  const more = list.more
    ? `<a class="btn btn--block load-more" href="${lawsHref({ all, level, offset: offset + BILLS_PER_PAGE })}" data-load-more="${id}">Load more</a>`
    : "";
  const empty = offset ? "" : '<p class="secondary small">No recorded votes loaded yet.</p>';
  return `
<section class="stack">
  ${head}
  <div class="stack" id="${id}" data-more-list>${list.rows.map((b) => billCard(b, all)).join("") || empty}</div>
  ${more}
</section>`;
}

async function index(env, url) {
  const all = url.searchParams.get("votes") === "all";
  const onlyLevel = LEVELS[url.searchParams.get("level")] ? url.searchParams.get("level") : null;
  const offset = onlyLevel ? Math.max(0, parseInt(url.searchParams.get("offset") || "0", 10) || 0) : 0;
  if (!env.DB) return notLoaded("Laws", "laws", true);
  const levels = onlyLevel ? [onlyLevel] : ["federal", "state"];
  // Each level loads on its own: if one can't, the other still shows.
  const lists = await Promise.all(levels.map((level) => loadSection(`laws ${level}`, () => billList(env.DB, { level, all, offset }), null)));
  const filter = (label, isAll) =>
    `<a class="toggle" href="${lawsHref({ all: isAll, level: onlyLevel })}"${all === isAll ? ' aria-current="true"' : ""}>${label}</a>`;

  // A later page of one level ("Load more" without JavaScript).
  if (onlyLevel) {
    const main = `
<header class="page-head">
  <h1>${LEVELS[onlyLevel]} bills</h1>
  <p class="subtitle">${all ? "With recorded votes" : "With final-passage votes"}, newest first${offset ? `, from number ${offset + 1}` : ""}.</p>
</header>
<nav class="segmented vote-filter" aria-label="Which bills to show">${filter("With final-passage votes", false)}${filter("All with recorded votes", true)}</nav>
${billSection(onlyLevel, lists[0], { all, offset, heading: false })}`;
    return page(`${LEVELS[onlyLevel]} bills`, main, { tab: "laws", back: ["Laws", lawsHref({ all })], partial: anyFailed(...lists) || lists.includes(null) });
  }

  const main = `
<header class="page-head">
  <h1>Laws</h1>
  <p class="subtitle">Bills in Congress and the California Legislature with recorded votes, and the Constitution they answer to.</p>
</header>
<a class="parchment stack-sm constitution-link" href="/laws/constitution/">
  <p class="label">The Constitution</p>
  <p class="quote">The starting point for every analysis.</p>
  <p class="small">The full text, as the National Archives transcribes it →</p>
</a>
<nav class="segmented vote-filter" aria-label="Which bills to show">${filter("With final-passage votes", false)}${filter("All with recorded votes", true)}</nav>
${levels.map((level, i) => billSection(level, lists[i], { all })).join("")}
`;
  return page("Laws", main, { tab: "laws", root: true, partial: anyFailed(...lists) || lists.includes(null) });
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
function readerForms(env, id, analysis) {
  const { a, row, relevance, pendingFull } = analysis;
  const ready = turnstileReady(env);
  const action = (what) => `/laws/bills/${encodeURIComponent(id)}/${what}`;
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
  <p class="small">${a ? "Want more than the short card? A full analysis covers every provision the bill touches, contested readings, and what it can't tell you." : "Want an analysis of this bill? A full analysis maps every provision it touches."}</p>
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

async function bill(env, id, url, request) {
  const districts = districtsFromCookie(request);
  if (!env.DB) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  const db = env.DB;
  const b = await loadSection("bill", () => billById(db, id), undefined);
  if (b === undefined) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  if (b === FAILED) throw new Error(`bill ${id} couldn't load`);
  if (!b) return notFound("No bill at this address.", "laws", ["Laws", "/laws/"]);
  // Each section loads on its own: one that can't load shows a short note, and
  // the rest of the page still shows.
  const reps = districts ? await loadSection("bill reps", () => officialsWhere(db, repsWhere(districts)), []) : [];
  const repIds = reps === FAILED ? [] : reps.map((o) => o.id);
  const [votes, analysisLoaded, lobbying, outcome] = await Promise.all([
    loadSection("bill votes", () => votesOnBill(db, id, repIds), []),
    loadSection("bill analysis", () => analysisFor(db, id)),
    b.level === "federal" ? loadSection("bill lobbying", () => lobbyingFor(db, id), null) : null,
    loadSection("bill outcome", () => outcomeFor(db, id), { outcome: null, checked: null }),
  ]);
  const analysis = analysisLoaded === FAILED
    ? { a: null, row: null, provisions: new Map(), flags: 0, relevance: null, pendingFull: false, failed: true }
    : analysisLoaded;
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
  const sent = MESSAGES[url.searchParams.get("sent")] || null;
  const error = MESSAGES[url.searchParams.get("error")] || null;
  const empty = skipped(analysis.relevance)
    ? `<p>Not analyzed. Before any analysis is written, a quick check sets aside ceremonial and routine measures; it found this bill to be ${esc(CATEGORY_NAMES[analysis.relevance.category] || "a routine measure")}: ${esc(analysis.relevance.reason)}</p>`
    : analysis.row
      ? "<p>An analysis of this bill is being checked. It appears here once it passes review.</p>"
      : "";

  const official = safeUrl(b.official_url);
  const summary = b.summary
    ? `<p>${esc(b.summary)}</p>`
    : '<p class="secondary small">A plain-language summary hasn\'t been written yet. Read the full text at the official source.</p>';
  const main = `
<header class="page-head">
  <p class="label">${LEVELS[b.level]} · ${esc(CHAMBER_NAME[b.chamber] || "Bill")} · ${esc(b.bill_number)}</p>
  <h1>${esc(b.title)}</h1>
  <p class="secondary">${b.level === "federal" ? `${ordinal(parseInt(b.session, 10))} Congress` : `California Legislature, ${esc(b.session.slice(0, 4))}–${esc(b.session.slice(4))} session`}</p>
</header>
<section class="card stack-sm">
  <h2 class="label">Plain-language summary</h2>
  ${summary}
  ${official ? sourceLink(official, "Official bill page") : sourceLink(b.source_url)}
</section>
${outcome === FAILED ? sectionError("Final action") : outcomeSection(b, outcome)}
${sent ? `<p class="banner" role="status">${esc(sent)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${analysis.failed ? sectionError("Constitutional baseline") : baselineSection(analysis.a, analysis.provisions, { underReview: analysis.flags > 0, empty, after: readerForms(env, id, analysis) })}
<section class="stack" id="votes">
  <h2 class="label">${districts ? "How your reps voted" : "Votes"}</h2>
  <p class="hint">${
    districts
      ? `Every recorded vote on this bill, newest first, with the totals and how your reps voted (${esc(describe(districts))}). Each links to the official record, which lists every member.`
      : "Every recorded vote on this bill, newest first, with the totals. Each links to the official record, which lists every member."
  }</p>
  ${districts ? "" : '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.</p>'}
  ${votes === FAILED ? sectionError("") : votes.map((v) => billVote(v, { personal: !!districts })).join("") || '<p class="secondary small">No recorded votes loaded for this bill.</p>'}
</section>
${lobbying === FAILED ? sectionError("Follow the money") : followTheMoney(b, lobbying, { reps: districts && reps !== FAILED ? reps : null, repMoney, cycle })}
`;
  return page(`${b.bill_number}: ${b.title}`, main, { tab: "laws", back: ["Laws", "/laws/"], personal: true, partial: anyFailed(reps, votes, analysisLoaded, lobbying, outcome) });
}

// The Laws list is the same for every visitor: kept at the edge for a few minutes.
const LAWS_CACHE_SECONDS = 300;

export const onRequestGet = guard(async (context) => {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return edgeCached(context, LAWS_CACHE_SECONDS, () => index(context.env, url));
  // The reader forms post to these; a plain visit goes back to the bill page.
  if (parts[0] === "bills" && parts.length === 3 && ["flag", "request-full"].includes(parts[2])) {
    return Response.redirect(`${url.origin}/laws/bills/${parts[1]}/`, 302);
  }
  if (parts[0] === "bills" && parts.length === 2) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return bill(context.env, decodeURIComponent(parts[1]), url, context.request);
  }
  const old = OLD_PAGES[parts.join("/")];
  if (old) return Response.redirect(`${url.origin}${old}`, 301);
  // Static pages: /laws/constitution/.
  return context.next();
}, { tab: "laws" });

// ---------------------------------------------------------------------------
// Reader actions

async function readerPost(context, id, what) {
  const { request, env } = context;
  const url = new URL(request.url);
  const back = (q) => Response.redirect(`${url.origin}/laws/bills/${encodeURIComponent(id)}/?${q}#baseline`, 303);
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
  const b = await billById(db, id);
  if (!b) return back("error=invalid");
  const relevance = await db.prepare("SELECT verdict, override FROM bill_relevance WHERE bill_id = ?").bind(id).first();
  if (skipped(relevance)) return back("error=invalid");
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
  if (parts[0] === "bills" && parts.length === 3 && ["flag", "request-full"].includes(parts[2])) {
    try {
      return await readerPost(context, decodeURIComponent(parts[1]), parts[2] === "flag" ? "flag" : "full");
    } catch (err) {
      if (/no such table|no such column/i.test(String(err && err.message))) return new Response("Not available yet", { status: 503 });
      throw err;
    }
  }
  return new Response("Not found", { status: 404 });
}
