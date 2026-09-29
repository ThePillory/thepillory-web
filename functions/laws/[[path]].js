// /laws/                real bills your officials have voted on, sample laws, and the Constitution
// /laws/bills/<id>/     one real bill: summary, how your reps voted, related issues
// Everything else under /laws/ (the Constitution, sample laws) is static and passed through.
import { SAMPLE_LAW_CARDS, ISSUE_CARDS } from "../_lib/generated.js";
import { page, notFound, notLoaded, esc, safeUrl, section, sourceLink, card, fmtDate } from "../_lib/render.js";
import { safe, recentBills, billById, votesOnBill, approvedIssuesForBill, CHAMBER_NAME } from "../_lib/data.js";
import { billVote, billHref } from "../_lib/votes.js";

const LEVELS = { federal: "Federal", state: "State" };

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
  <p class="subtitle">Bills your officials have voted on, and the Constitution they answer to.</p>
</header>
<a class="parchment stack-sm constitution-link" href="/laws/constitution/">
  <p class="label">The Constitution</p>
  <p class="quote">The starting point for every issue.</p>
  <p class="small">Browse the articles and amendments, with the issues and laws that cite them →</p>
</a>
<nav class="segmented vote-filter" aria-label="Which bills to show">
  <a class="toggle" href="/laws/"${all ? "" : ' aria-current="true"'}>With final-passage votes</a>
  <a class="toggle" href="/laws/?votes=all"${all ? ' aria-current="true"' : ""}>All with recorded votes</a>
</nav>
${real}
<section class="stack">
  <h2 class="label">Sample laws</h2>
  <p class="hint">Hypothetical examples linked to the sample issues. They have no recorded votes.</p>
  ${SAMPLE_LAW_CARDS.join("")}
</section>`;
  return page("Laws", main, { tab: "laws", root: true });
}

async function bill(env, id) {
  const data = await safe(env, async (db) => {
    const b = await billById(db, id);
    if (!b) return { b: null };
    const [votes, links] = await Promise.all([votesOnBill(db, id), approvedIssuesForBill(db, id)]);
    return { b, votes, links };
  });
  if (!data) return notLoaded("Laws", "laws", false, ["Laws", "/laws/"]);
  const { b, votes, links } = data;
  if (!b) return notFound("No bill at this address.", "laws", ["Laws", "/laws/"]);

  const official = safeUrl(b.official_url);
  const summary = b.summary
    ? `<p>${esc(b.summary)}</p>`
    : '<p class="secondary small">A plain-language summary hasn\'t been written yet. Read the full text at the official source.</p>';
  const issues = links.map((l) => ISSUE_CARDS[l.issue_slug]).filter(Boolean).join("");
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
<section class="parchment stack-sm">
  <h2 class="label">Constitutional baseline</h2>
  <p>Not yet mapped. Reviewers will add the parts of the Constitution this bill touches, with sources.</p>
</section>
<section class="stack">
  <h2 class="label">How your reps voted</h2>
  <p class="hint">Every recorded vote on this bill by officials who represent Calaveras County, newest first. Each links to the official record.</p>
  ${votes.map(billVote).join("") || '<p class="secondary small">No recorded votes by your officials.</p>'}
</section>
${issues ? section("Related issues", issues, "stack") : ""}`;
  return page(`${b.bill_number}: ${b.title}`, main, { tab: "laws", back: ["Laws", "/laws/"] });
}

export async function onRequestGet(context) {
  const url = new URL(context.request.url);
  const parts = (context.params.path || []).filter(Boolean);
  if (parts.length === 0) return index(context.env, url);
  if (parts[0] === "bills" && parts.length === 2) {
    if (!url.pathname.endsWith("/")) return Response.redirect(`${url.origin}${url.pathname}/${url.search}`, 301);
    return bill(context.env, decodeURIComponent(parts[1]));
  }
  // Static pages: /laws/constitution/…, sample laws.
  return context.next();
}
