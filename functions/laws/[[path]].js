// /laws/                real bills your officials have voted on, and the Constitution
// /laws/bills/<id>/     one real bill: summary, constitutional analysis, how your reps voted
//   POST /laws/bills/<id>/flag           "Something wrong?" on a published analysis
//   POST /laws/bills/<id>/request-full   "Request full analysis"
//   Both need Turnstile and are rate-limited per visitor (functions/_lib/turnstile.js).
// /laws/constitution/ is static and passed through. Old sample pages redirect (OLD_PAGES).
import { page, notFound, notLoaded, esc, safeUrl, section, sourceLink, card, fmtDate } from "../_lib/render.js";
import { safe, recentBills, billById, votesOnBill, officialsWhere, CHAMBER_NAME } from "../_lib/data.js";
import { districtsFromCookie, repsWhere, describe } from "../_lib/districts.js";
import { billVote, billHref } from "../_lib/votes.js";
import { lobbyingFor, industryMoney, followTheMoney, cycleOf } from "../_lib/funding.js";
import { outcomeFor, outcomeSection } from "../_lib/executive.js";
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

function billCard(b) {
  return card({
    href: billHref(b.id),
    label: `${LEVELS[b.level]} · ${CHAMBER_NAME[b.chamber] || "Bill"}`,
    title: `${b.bill_number}: ${b.title}`,
    who: b.level === "federal" ? `${ordinal(parseInt(b.session, 10))} Congress` : `California, ${b.session.slice(0, 4)}–${b.session.slice(4)} session`,
    left: `Last vote: <strong>${fmtDate(b.last_vote)}</strong>`,
    right: `Recorded votes: <strong>${b.vote_count}</strong>`,
    level: b.level,
  });
}

async function index(env, url) {
  const all = url.searchParams.get("votes") === "all";
  const bills = await safe(env, async (db) => ({
    federal: await recentBills(db, { level: "federal", all }),
    state: await recentBills(db, { level: "state", all }),
  }));
  const real = bills
    ? ["federal", "state"].map((level) => `
<section class="stack">
  <h2 class="label">${LEVELS[level]}</h2>
  ${bills[level].map(billCard).join("") || '<p class="secondary small">No recorded votes loaded yet.</p>'}
</section>`).join("")
    : '<section class="card stack-sm"><h2 class="label">Not loaded yet</h2><p>Real bills appear here after the first data sync runs.</p></section>';
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
<nav class="segmented vote-filter" aria-label="Which bills to show">
  <a class="toggle" href="/laws/"${all ? "" : ' aria-current="true"'}>With final-passage votes</a>
  <a class="toggle" href="/laws/?votes=all"${all ? ' aria-current="true"' : ""}>All with recorded votes</a>
</nav>
${real}
`;
  return page("Laws", main, { tab: "laws", root: true });
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
  const data = await safe(env, async (db) => {
    const b = await billById(db, id);
    if (!b) return { b: null };
    const reps = districts ? await officialsWhere(db, repsWhere(districts)) : [];
    const [votes, analysis, lobbying, outcome] = await Promise.all([
      votesOnBill(db, id, reps.map((o) => o.id)),
      analysisFor(db, id),
      b.level === "federal" ? lobbyingFor(db, id) : null,
      outcomeFor(db, id),
    ]);
    // Each rep's latest final-passage position on this bill, beside contributions in
    // that two-year period from the industries that lobbied on it.
    let repMoney = [];
    let cycle = null;
    if (districts && lobbying && lobbying.orgs.length) {
      const finals = votes.filter((v) => v.vote_type === "final_passage");
      const federal = reps.filter((o) => o.level === "federal");
      const latest = finals[0] || votes[0];
      cycle = cycleOf(latest && latest.vote_date);
      const m = await industryMoney(db, federal.map((o) => o.id), lobbying.industries, cycle);
      repMoney = federal.map((rep) => {
        const v = finals.find((x) => x.positions.some((p) => p.slug === rep.slug));
        const p = v && v.positions.find((x) => x.slug === rep.slug);
        return { rep, vote: v || null, position: p ? p.position : null, money: m[rep.id] };
      });
    }
    return { b, votes, analysis, lobbying, repMoney, cycle, reps, outcome };
  });
  if (!data) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  const { b, votes, analysis, lobbying, repMoney, cycle, reps, outcome } = data;
  if (!b) return notFound("No bill at this address.", "laws", ["Laws", "/laws/"]);
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
${outcomeSection(b, outcome)}
${sent ? `<p class="banner" role="status">${esc(sent)}</p>` : ""}
${error ? `<p class="banner banner--error" role="alert">${esc(error)}</p>` : ""}
${baselineSection(analysis.a, analysis.provisions, { underReview: analysis.flags > 0, empty, after: readerForms(env, id, analysis) })}
<section class="stack" id="votes">
  <h2 class="label">${districts ? "How your reps voted" : "Votes"}</h2>
  <p class="hint">${
    districts
      ? `Every recorded vote on this bill, newest first, with the totals and how your reps voted (${esc(describe(districts))}). Each links to the official record, which lists every member.`
      : "Every recorded vote on this bill, newest first, with the totals. Each links to the official record, which lists every member."
  }</p>
  ${districts ? "" : '<p class="small"><a class="inline-link" href="/#find">Find your representatives</a> to see how yours voted.</p>'}
  ${votes.map((v) => billVote(v, { personal: !!districts })).join("") || '<p class="secondary small">No recorded votes loaded for this bill.</p>'}
</section>
${followTheMoney(b, lobbying, { reps: districts ? reps : null, repMoney, cycle })}
`;
  return page(`${b.bill_number}: ${b.title}`, main, { tab: "laws", back: ["Laws", "/laws/"], personal: true });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return index(context.env, url);
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
}

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
