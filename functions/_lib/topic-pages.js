// Topic pages:
//   /topics/                              every topic
//   /topics/<topic>/                      Congress, California and the executive branch on one topic
//   /place/<st>/<county>/topics/          every topic, for one county
//   /place/<st>/<county>/topics/<topic>/  one topic for one county: bills and how its reps
//                                         voted, county meeting items, executive actions,
//                                         officials' own words, and money from industries
//                                         tied to the topic, side by side as facts
// The county pages are routed from functions/place/[[path]].js.
import { page, esc, notFound, loadSection, FAILED, anyFailed, sectionError } from "./render.js";
import { summaryHead, contentsBar, fold } from "./summary.js";
import { LIVE, officialsFor, breadcrumb, placeHref, loadDistrictNames } from "./geo.js";
import { STATE_NAME } from "./districts.js";
import { pacificNow } from "./meetings.js";
import {
  TOPICS, TOPIC, METHOD, SIDE_BY_SIDE, topicHref, placeTopicsHref, topicGrid, industriesFor,
  topicBills, positionsFor, topicMeetingItems, topicExecutive, topicPlatform, topicMoney, topicCounts,
  billRows, meetingRows, executiveRows, platformRows, moneyRows,
} from "./topics.js";
import { yearBar } from "./history.js";
import { icon } from "./icons.js";
import { INDUSTRIES } from "../../workers/sync/src/funding/industry.js";

const BACK = ["Topics", "/topics/"];

// Summary first: each kind of record is a section collapsed until tapped, with its count beside the title.
const block = (id, label, inner, hint = "", count = null) =>
  fold(id, label, `${inner}${hint ? `<p class="hint">${hint}</p>` : ""}`, { meta: count == null ? "" : `${count} ${count === 1 ? "item" : "items"}` });
const countOf = (v) => (v === FAILED || v == null ? null : Array.isArray(v) ? v.length : Array.isArray(v.bills) ? v.bills.length : null);
const TOPIC_CONTENTS = [["summary", "Summary"], ["fed", "Congress"], ["state", "California"], ["meet", "Meetings"], ["exec", "Executive"], ["words", "Own words"], ["money", "Money"]];
function topicSummary(counts) {
  const parts = counts.filter(([, n]) => n != null).map(([label, n]) => `${n} ${label}`);
  return parts.length ? `On this topic: ${parts.join(", ")}.` : "";
}
const list = (rows, empty) => (rows ? `<ul class="card plain-list topic-list">${rows}</ul>` : `<p class="small secondary">${esc(empty)}</p>`);

function industriesLine(topic) {
  const ind = industriesFor(topic);
  return ind.length
    ? `Industries tied to ${esc(TOPIC[topic].name.toLowerCase())}: ${esc(ind.map((k) => INDUSTRIES[k]).join("; "))}. Industries are approximate (keyword rules on names), and an industry says nothing about what a contribution was for. <a class="inline-link" href="${METHOD}">How industries are tied to topics</a>`
    : "";
}

// ---------------------------------------------------------------------------
// /topics/

export async function topicsIndex(env) {
  const counts = env.DB ? await loadSection("topic counts", () => topicCounts(env.DB), {}) : {};
  const c = counts === FAILED ? {} : counts;
  const rows = TOPICS.map(
    (t) => `<a class="list-row link-row" href="${topicHref(t.slug)}"><div><div class="list-title">${esc(t.name)}</div><div class="list-meta">${esc(t.about)}</div></div><span class="row-end">${c[t.slug] ? `<span class="small secondary">${c[t.slug]}</span>` : ""}<span class="chev" aria-hidden="true">›</span></span></a>`
  ).join("");
  const main = `
<header class="page-head stack-xs">
  <h1>Topics</h1>
  <p class="subtitle">One subject at a time: bills and votes, county meetings, executive actions, what officials say on their own pages, and campaign money, side by side.</p>
</header>
<div class="card">${rows}</div>
<section class="card stack-xs">
  <p class="small">For a county, open its page on the <a class="inline-link" href="/explore/">map</a> and choose a topic there: <a class="inline-link" href="${placeTopicsHref({ st: "CA", slug: "calaveras" })}">Calaveras County's topics</a>.</p>
</section>
<p class="hint">${esc(SIDE_BY_SIDE)} <a class="inline-link" href="${METHOD}">How topics work</a></p>`;
  return page("Topics", main, { tab: "laws", back: ["Laws", "/laws/"], partial: counts === FAILED });
}

// ---------------------------------------------------------------------------
// /topics/<topic>/  (no place: Congress, California, the executive branch)

export async function topicPage(env, slug, url = null) {
  const t = TOPIC[slug];
  if (!t) return notFound("No topic at this address.", "laws", BACK);
  const db = env.DB;
  const execIds = db ? await loadSection("topic executive ids", async () => (await db.prepare("SELECT id FROM officials WHERE active = 1 AND chamber IN ('us-executive', 'ca-executive')").all()).results.map((r) => r.id), []) : [];
  const [federal, state, exec, words] = await Promise.all([
    db ? loadSection("topic federal bills", () => topicBills(db, slug, "federal"), []) : [],
    db ? loadSection("topic state bills", () => topicBills(db, slug, "state"), []) : [],
    db && execIds !== FAILED ? loadSection("topic executive", () => topicExecutive(db, slug, execIds), []) : [],
    db ? loadSection("topic platform", () => topicPlatform(db, slug, null), []) : [],
  ]);
  const none = new Map();
  const section = (id, label, v, render, empty, hint = "") => (v === FAILED ? sectionError(label) : block(id, label, list(v.length ? render(v) : "", empty), hint, v.length));
  const main = `
${contentsBar(TOPIC_CONTENTS.filter(([id]) => !["meet", "money"].includes(id)))}
${summaryHead({
    kicker: `<span class="kicker-icon">${icon(slug)}</span>Topic`,
    title: t.name,
    summary: { text: `${t.about} ${topicSummary([["bills in Congress", countOf(federal)], ["in California", countOf(state)], ["executive actions", countOf(exec)], ["excerpts in officials' own words", countOf(words)]])}`.trim(), source: `${esc(SIDE_BY_SIDE)} <a href="${METHOD}">How topics work</a>` },
  })}
${section("fed", "Bills in Congress", federal, (v) => billRows(v, none, null), db ? "No bills with a final-passage vote are tagged with this topic yet." : "Bills appear once the data sync has run.")}
${section("state", "Bills in the California Legislature", state, (v) => billRows(v, none, null), db ? "No bills with a final-passage vote are tagged with this topic yet." : "Bills appear once the data sync has run.")}
${section("exec", "Executive actions", exec, executiveRows, "No executive orders or proclamations by the President or the Governor are tagged with this topic yet.")}
${section("words", "In their own words", words, platformRows, "No excerpt from an official's own Issues page is tagged with this topic yet.", "Excerpts are word for word from each official's own website, the same way for every official.")}
<section class="card stack-xs">
  <p class="small">To see how a place's representatives voted, its county meetings and the campaign money around its officials, open the topic for a county: <a class="inline-link" href="${topicHref(slug, { st: "CA", slug: "calaveras" })}">${esc(t.name)} in Calaveras County</a>, or pick a county on the <a class="inline-link" href="/explore/">map</a>.</p>
</section>
${url ? yearBar(url, null, { label: `See ${t.name.toLowerCase()} in an earlier year` }) : ""}`;
  return page(t.name, main, { tab: "laws", back: BACK, partial: anyFailed(federal, state, exec, words, execIds) });
}

// ---------------------------------------------------------------------------
// /place/<st>/<county>/topics/ and /place/<st>/<county>/topics/<topic>/

export function placeTopicsIndex(place, c) {
  const p = { st: place.st, slug: c.slug };
  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, `/explore/${place.st.toLowerCase()}/`], [c.name, placeHref(place.st, c.slug)], ["Topics", null]])}
<header class="page-head stack-xs">
  <h1>Topics in ${esc(c.name)}</h1>
  <p class="subtitle">Choose a topic to see, for ${esc(c.name)}: bills and how its representatives voted, ${LIVE[c.fips] ? "county meeting items, " : ""}executive actions, what its officials say on their own pages, and campaign money from industries tied to the topic.</p>
</header>
${topicGrid(p)}
<p class="hint">${esc(SIDE_BY_SIDE)}</p>`;
  return page(`Topics in ${c.name}`, main, { tab: "home", back: [c.name, placeHref(place.st, c.slug)] });
}

export async function placeTopicPage(env, place, c, slug, url = null) {
  const t = TOPIC[slug];
  const p = { st: place.st, slug: c.slug };
  if (!t) return notFound("No topic at this address.", "home", ["Topics", placeTopicsHref(p)]);
  const db = env.DB;
  const live = LIVE[c.fips];
  const empty = { senators: [], house: [], upper: [], lower: [], county: [], executive: [], stateExecutive: [] };
  // District names (where they aren't just numbers) match the county's legislators; the asset loader needs only the page's address.
  const names = url ? await loadDistrictNames(env, { url: url.href }, place.st) : null;
  const oLoaded = db
    ? await loadSection("topic place officials", () => officialsFor(db, place.st, { cd: c.cd.map((x) => x[0]), sldu: c.sldu.map((x) => x[0]), sldl: c.sldl.map((x) => x[0]), county: c.fips }, names), empty)
    : empty;
  const o = oLoaded === FAILED ? empty : oLoaded;
  const fedReps = [...o.senators, ...o.house];
  const stateReps = [...o.upper, ...o.lower];
  const everyone = [...o.county, ...stateReps, ...o.stateExecutive, ...fedReps, ...o.executive];
  const now = pacificNow();
  const today = now.slice(0, 10);

  const billsWithVotes = async (level, reps) => {
    const bills = await topicBills(db, slug, level);
    const positions = await positionsFor(db, bills.map((b) => b.final_vote_id), reps.map((r) => r.id));
    return { bills, positions };
  };
  const [federal, state, upcoming, recent, exec, words, money] = await Promise.all([
    db ? loadSection("topic place federal bills", () => billsWithVotes("federal", fedReps), { bills: [], positions: new Map() }) : { bills: [], positions: new Map() },
    db ? loadSection("topic place state bills", () => billsWithVotes(place.st === "CA" ? "state" : `state:${place.st}`, stateReps), { bills: [], positions: new Map() }) : { bills: [], positions: new Map() },
    db && live ? loadSection("topic place upcoming items", () => topicMeetingItems(db, slug, now, { upcoming: true }), []) : [],
    db && live ? loadSection("topic place recent items", () => topicMeetingItems(db, slug, now, { upcoming: false }), []) : [],
    db ? loadSection("topic place executive", () => topicExecutive(db, slug, [...o.executive, ...o.stateExecutive].map((x) => x.id)), []) : [],
    db ? loadSection("topic place platform", () => topicPlatform(db, slug, everyone.map((x) => x.id)), []) : [],
    db ? loadSection("topic place money", () => topicMoney(db, slug, { federal: fedReps, state: [...stateReps, ...o.stateExecutive] }, today), []) : [],
  ]);

  const billBlock = (id, label, v, reps, emptyText) =>
    v === FAILED
      ? sectionError(label)
      : block(id, label, list(v.bills.length ? billRows(v.bills, v.positions, reps) : "", emptyText), v.bills.length ? `Each bill's latest final-passage vote, and how ${esc(c.name)}'s representatives voted on it. Positions are as the official record lists them.` : "", v.bills.length);
  const noBills = db ? "No bills with a final-passage vote are tagged with this topic yet." : "Bills appear once the data sync has run.";
  const meetings = !live
    ? block("meet", "County meetings", `<p class="small secondary">${esc(c.name)}'s county meetings aren't on ThePillory yet. County coverage opens when a community launches. <a class="inline-link" href="${placeHref(place.st, c.slug)}#waitlist">Bring ThePillory here</a></p>`)
    : upcoming === FAILED || recent === FAILED
      ? sectionError("County meetings")
      : block(
          "meet",
          "County meetings",
          `<div class="stack-sm"><p class="label">Coming up</p>${list(upcoming.length ? meetingRows(upcoming) : "", "No upcoming agenda items on this topic.")}<p class="label">Recent</p>${list(recent.length ? meetingRows(recent) : "", "No recent agenda items on this topic.")}</div>`,
          "Items from the Board of Supervisors' and Planning Commission's official agendas.",
          upcoming.length + recent.length
        );
  const ind = industriesFor(slug);
  const moneyBlock =
    money === FAILED
      ? sectionError("Campaign money from related industries")
      : block(
          "money",
          "Campaign money from related industries",
          ind.length
            ? list(money.length ? moneyRows(money) : "", fedReps.length || stateReps.length ? "No contributions from these industries are loaded for this place's representatives." : "Funding appears once representatives are loaded.")
            : `<p class="small secondary">No campaign-funding industry is tied to ${esc(t.name.toLowerCase())}. <a class="inline-link" href="${METHOD}">Which industries are tied to which topics</a></p>`,
          ind.length ? `${industriesLine(slug)} Members of Congress: this two-year period, from PACs and donors' employers (FEC). California officials: their latest two-year period, itemized contributions (Cal-Access).` : "",
          ind.length ? money.length : null
        );

  // California's state bills always (an empty list says so); another state's once any are tagged with this topic.
  const showState = place.st === "CA" || (state !== FAILED && state.bills.length > 0);
  const main = `
${breadcrumb([["United States", "/explore/"], [place.name, `/explore/${place.st.toLowerCase()}/`], [c.name, placeHref(place.st, c.slug)], [t.name, null]])}
${contentsBar(TOPIC_CONTENTS.filter(([id]) => showState || id !== "state"))}
${summaryHead({
    kicker: `<span class="kicker-icon">${icon(slug)}</span>Topic · ${esc(c.name)}`,
    title: `${t.name} in ${c.name}`,
    summary: {
      text: `${t.about} ${topicSummary([["bills in Congress", countOf(federal)], [`in ${STATE_NAME[place.st] || "the state"}`, showState ? countOf(state) : null], ["county agenda items", live && upcoming !== FAILED && recent !== FAILED ? upcoming.length + recent.length : null], ["executive actions", countOf(exec)], ["excerpts in officials' own words", countOf(words)]])}`.trim(),
      source: `${esc(SIDE_BY_SIDE)} <a href="${METHOD}">How topics work</a>`,
    },
  })}
${oLoaded === FAILED ? sectionError("Representatives") : ""}
${billBlock("fed", "Bills in Congress", federal, fedReps, noBills)}
${showState ? billBlock("state", place.st === "CA" ? "Bills in the California Legislature" : `Bills in ${STATE_NAME[place.st] || "the state"}'s legislature`, state, stateReps, noBills) : ""}
${meetings}
${exec === FAILED ? sectionError("Executive actions") : block("exec", "Executive actions", list(exec.length ? executiveRows(exec) : "", "No executive orders or proclamations on this topic yet."), "", exec.length)}
${words === FAILED ? sectionError("In their own words") : block("words", "In their own words", list(words.length ? platformRows(words) : "", `No excerpt from the own Issues pages of ${c.name}'s officials is tagged with this topic yet.`), "Word for word from each official's own website, the same way for every official.", words.length)}
${moneyBlock}
${url ? yearBar(url, null, { label: `See ${t.name.toLowerCase()} in ${c.name} in an earlier year` }) : ""}
<section class="stack-sm" aria-labelledby="h-other"><h2 class="label" id="h-other">Other topics in ${esc(c.name)}</h2>${topicGrid(p)}</section>`;
  return page(`${t.name} in ${c.name}`, main, { tab: "home", back: [c.name, placeHref(place.st, c.slug)], partial: anyFailed(oLoaded, federal, state, upcoming, recent, exec, words, money) });
}

