// Past-year views for the Time Machine (?year=YYYY):
//   placePastYear     /place/<st>/<county>/?year=   who represented the county that
//                     year, their votes, executive orders, and campaign totals
//   officialPastYear  /reps/<slug>/?year=           one official's office, votes,
//                     executive orders and campaign totals that year
//   topicPastYear     /topics/<topic>/?year= and /place/<st>/<county>/topics/<topic>/?year=
// Each view says which year it shows, has one-tap "Back to today", and lists
// what isn't available for that year. Facts only: no scores, no party colors,
// nothing that ties a number to a person as cause.
import { page, esc, fmtDate, loadSection, FAILED, anyFailed, sectionError } from "./render.js";
import { breadcrumb, placeHref } from "./geo.js";
import { TOPIC, topicHref, SIDE_BY_SIDE, METHOD } from "./topics.js";
import {
  FIRST_YEAR, yearBar, pastBanner, gapsSection, loadFederalExecutive, loadCongress, loadDistricts, loadCalifornia,
  executiveIn, districtsIn, congressIn, californiaIn, legislatureIn, votesInYear, voteCountInYear, officialVotesInYear,
  ordersInYear, officialOrdersInYear, cabinetAsOf, fundingInCycle, officialsById, holderRow, electedRow,
  pastVoteRows, orderRows, fundingRows, termText, yearOf,
} from "./history.js";
import { holdersInYear } from "../../workers/sync/src/history/parse.js";

const block = (id, label, inner, hint = "") =>
  `<section class="stack-sm" aria-labelledby="h-${id}"><h2 class="label" id="h-${id}">${esc(label)}</h2>${inner}${hint ? `<p class="hint">${hint}</p>` : ""}</section>`;
const rowsCard = (rows, empty) => (rows ? `<div class="card">${rows}</div>` : `<p class="small secondary">${empty}</p>`);
const listCard = (rows, empty, cls = "plain-list") => (rows ? `<ul class="card ${cls}">${rows}</ul>` : `<p class="small secondary">${empty}</p>`);
const FEDERAL_FISCAL = `<a class="inline-link" href="/finances/">Federal finances by presidential term</a>`;
const FIRST_VOTE_YEAR = 2001;
const FIRST_ORDER_YEAR = 1994;
const FIRST_NOMINATION_YEAR = 2001; // Congress.gov nominations from the 107th Congress

function pastHead(url, year, crumbs, title, sub, sliderLabel, min = FIRST_YEAR) {
  return `${pastBanner(year, url)}
${crumbs}
<header class="page-head stack-xs">
  <p class="label">Time Machine · ${year}</p>
  <h1>${title}</h1>
  ${sub ? `<p class="subtitle">${sub}</p>` : ""}
</header>
${yearBar(url, year, { label: sliderLabel, min })}`;
}

// ---------------------------------------------------------------------------
// A county in a past year

export async function placePastYear(env, request, url, place, c, year) {
  const st = place.st.toLowerCase();
  const db = env.DB;
  const gaps = [];
  const [fe, cong, dist, cal] = await Promise.all([
    loadSection("history executive", () => loadFederalExecutive(env, request), null),
    loadSection("history congress", () => loadCongress(env, request, st), null),
    loadSection("history districts", () => loadDistricts(env, request, st), null),
    place.st === "CA" ? loadSection("history california", () => loadCalifornia(env, request), null) : null,
  ]);
  const ok = (v) => (v === FAILED ? null : v);
  const d = districtsIn(ok(dist), c.fips, year);
  const { presidents, vps } = executiveIn(ok(fe), year);
  const houseIds = d ? d.cd.map((p) => p[0]) : null;
  const members = congressIn(ok(cong), year, houseIds || []);
  if (!d) gaps.push(`District lines for ${esc(c.name)} in ${year}: the Census Bureau's county-to-district files ThePillory reads start with the districts drawn after the ${year < 2003 ? "2000" : "2010"} census, so ${esc(c.name)}'s U.S. House${place.st === "CA" ? " and state legislative" : ""} districts for ${year} aren't shown.`);

  // Every past officeholder ThePillory has a page for.
  const ids = [
    ...presidents.map((t) => `exec:govtrack:${t.govtrack}`), ...vps.map((t) => `exec:govtrack:${t.govtrack}`),
    ...members.senate.filter((t) => t.bioguide).map((t) => `bioguide:${t.bioguide}`),
    ...Object.values(members.house).flat().filter((t) => t.bioguide).map((t) => `bioguide:${t.bioguide}`),
  ];
  const linked = db ? await loadSection("history officials", () => officialsById(db, ids), new Map()) : new Map();
  const link = (id) => (linked === FAILED ? null : linked.get(id) || null);
  const congressIds = ids.filter((id) => id.startsWith("bioguide:"));
  const execIds = ids.filter((id) => id.startsWith("exec:"));

  const [votes, orders, cabinet, money, caOrders] = await Promise.all([
    db && year >= FIRST_VOTE_YEAR ? loadSection("history votes", () => votesInYear(db, congressIds, year), { rows: [], more: false }) : { rows: [], more: false },
    db && year >= FIRST_ORDER_YEAR ? loadSection("history orders", () => ordersInYear(db, year), { rows: [], more: false, count: 0 }) : { rows: [], more: false, count: 0 },
    db && year >= FIRST_NOMINATION_YEAR ? loadSection("history cabinet", () => cabinetAsOf(db, year), []) : [],
    db ? loadSection("history funding", () => fundingInCycle(db, [...congressIds, ...execIds], year), []) : [],
    db && place.st === "CA" ? loadSection("history ca orders", () => ordersInYear(db, year, { chamber: "ca-executive" }), { rows: [], more: false, count: 0 }) : { rows: [], more: false, count: 0 },
  ]);

  // Federal
  const execRows = [
    ...presidents.map((t) => holderRow(t, { office: "President", linked: link(`exec:govtrack:${t.govtrack}`), year })),
    ...vps.map((t) => holderRow(t, { office: "Vice President", linked: link(`exec:govtrack:${t.govtrack}`), year })),
  ].join("");
  let cabinetHtml = "";
  if (year < FIRST_NOMINATION_YEAR) gaps.push(`The Cabinet in ${year}: Congress.gov's nomination records that ThePillory reads start with the 107th Congress (2001).`);
  else if (cabinet === FAILED) cabinetHtml = sectionError("The Cabinet");
  else {
    const found = cabinet.filter((x) => !x.missing);
    cabinetHtml = block(
      "cabinet",
      `The Cabinet: Senate confirmations through ${year}`,
      found.length
        ? `<ul class="card plain-list">${cabinet
            .map((x) => x.missing
              ? `<li class="list-row"><div><div class="list-title">${esc(x.position)}</div><div class="list-meta">No Senate confirmation loaded for the eight years before the end of ${year}</div></div></li>`
              : `<li class="list-row"><div><div class="list-title">${esc(x.name)}</div><div class="list-meta">${esc(x.position)} · Confirmed ${fmtDate(x.latest_on)}</div></div><span class="row-end"><a class="inline-link xsmall" href="${esc(x.source_url)}" target="_blank" rel="noopener">Congress.gov ↗</a></span></li>`)
            .join("")}</ul>`
        : `<p class="small secondary">Nominations for ${year} haven't been loaded yet. They load a Congress at a time.</p>`,
      "The latest confirmation to each department on or before December 31. These records don't show departures, acting secretaries or recess appointments, so a person listed may have left during the year."
    );
  }
  const senators = members.senate.map((t) => holderRow(t, { office: "U.S. Senator", linked: link(`bioguide:${t.bioguide}`), year })).join("");
  const house = d
    ? d.cd.map(([id, full]) => {
        const held = members.house[id] || [];
        const note = full ? "" : "district covers part of this county";
        const label = id === "0" ? "U.S. Representative, at large" : `U.S. Representative, District ${id}`;
        return held.length ? held.map((t) => holderRow(t, { office: label, linked: link(`bioguide:${t.bioguide}`), year, note })).join("") : `<div class="list-row"><div><div class="list-title">${esc(label)}</div><div class="list-meta">No member listed for ${year}</div></div></div>`;
      }).join("")
    : "";

  // California
  let stateHtml = "";
  if (place.st === "CA") {
    const ca = ok(cal) ? californiaIn(ok(cal), year) : null;
    if (!ca) stateHtml = sectionError("California");
    else {
      const govRows = ca.governors.map((g) => `<div class="list-row"><div><div class="list-title">${esc(g.name)}</div><div class="list-meta">Governor · ${g.from}–${g.to || "present"} · <a class="inline-link" href="${esc(ok(cal).governors.source)}" target="_blank" rel="noopener">California State Library ↗</a></div></div></div>`).join("");
      const statewide = ca.statewide.filter((w) => w.office !== "governor").map((w) => electedRow(w, w.label)).join("");
      if (!statewide) gaps.push(`California's other statewide officers in ${year}: the Statements of Vote ThePillory reads start with the ${ca.firstElection < 9999 ? ca.firstElection : 2002} general election.`);
      const seatRows = (layer, office, label) => {
        if (!d || !d[layer]) return "";
        return d[layer].map(([id, full]) => {
          const w = ca.seat(office, id);
          const note = full ? "" : " (district covers part of this county)";
          return w ? electedRow(w, `${label}, District ${id}${note}`) : `<div class="list-row"><div><div class="list-title">${esc(label)}, District ${esc(id)}</div><div class="list-meta">Winner not found in the Statements of Vote ThePillory reads</div></div></div>`;
        }).join("");
      };
      const legislature = seatRows("sldu", "sldu", "State Senator") + seatRows("sldl", "sldl", "Assembly Member");
      if (d && (!d.sldu || !d.sldl)) gaps.push(`California's legislative districts for ${esc(c.name)} in ${year} aren't in the Census Bureau files ThePillory reads.`);
      gaps.push("California legislators who took office by appointment or special election aren't shown: the Time Machine reads general-election winners from the Statement of Vote.");
      const makeup = legislatureIn(ok(cal), year);
      stateHtml = block(
        "state",
        "California",
        rowsCard(govRows + statewide + legislature, "No California officeholders found for this year."),
        makeup && makeup.assembly_seats + makeup.senate_seats
          ? `After the ${makeup.after_election} general election, seats by the winners' party as listed on the ballot: ${makeup.assembly_seats ? `Assembly ${Object.entries(makeup.assembly).map(([p, n]) => `${esc(p)} ${n}`).join(", ")} (${makeup.assembly_seats} seats read); ` : ""}${makeup.senate_seats ? `Senate ${Object.entries(makeup.senate).map(([p, n]) => `${esc(p)} ${n}`).join(", ")} (${makeup.senate_seats} seats read)` : ""}. Source: Statement of Vote.`
          : ""
      );
    }
    if (year < 2025) gaps.push(`California Legislature votes in ${year}: ThePillory loads California floor votes for the current session only (Open States).`);
  }

  // County
  gaps.push(`${esc(c.name)} officials in ${year}: no online county record of past ${place.st === "CA" ? "supervisors" : "county officials"} has been found, so county offices aren't shown for past years.`);

  // Votes, orders, money
  if (year < FIRST_VOTE_YEAR) gaps.push(`Votes in Congress in ${year}: ThePillory loads House and Senate roll calls from ${FIRST_VOTE_YEAR} on.`);
  const voteHtml = year < FIRST_VOTE_YEAR ? "" : votes === FAILED ? sectionError("Votes in Congress") : block(
    "votes",
    `Final-passage votes in Congress, ${year}`,
    votes.rows.length ? `<ul class="plain-list card brief-votes">${pastVoteRows(votes.rows)}</ul>` : `<p class="small secondary">No final-passage votes by these members are loaded for ${year} yet. Past roll calls load a little each day, newest first.</p>`,
    votes.rows.length ? "How this county's members of Congress voted, as the House Clerk and the Senate recorded it. Every other vote is on each member's page for that year." : ""
  );
  if (year < FIRST_ORDER_YEAR) gaps.push(`Executive orders in ${year}: the Federal Register's online records ThePillory reads start in ${FIRST_ORDER_YEAR}.`);
  const orderHtml = year < FIRST_ORDER_YEAR ? "" : orders === FAILED ? sectionError("Executive orders") : block(
    "orders",
    `Executive orders signed in ${year}`,
    listCard(orderRows(orders.rows), `None loaded for ${year} yet. Past executive orders load one term at a time.`, "plain-list exec-list"),
    orders.count ? `${orders.count} loaded for ${year}, newest first. Titles exactly as published in the Federal Register.` : ""
  );
  const caOrderHtml = place.st === "CA" && caOrders !== FAILED && caOrders.rows.length ? block("ca-orders", `Governor's executive orders in ${year}`, listCard(orderRows(caOrders.rows), "", "plain-list exec-list")) : "";
  if (place.st === "CA" && (caOrders === FAILED || !caOrders.rows.length)) gaps.push(`The Governor's executive orders in ${year}: ThePillory reads them from the Governor's Office website, which lists the current administration's orders.`);
  const cycle = year % 2 ? year + 1 : year;
  const moneyHtml = money === FAILED ? sectionError("Campaign money") : block(
    "money",
    `Campaign money, ${cycle - 1}–${cycle}`,
    listCard(fundingRows(money), `No FEC totals loaded for ${cycle - 1}–${cycle} for these officials yet.`),
    "Totals for the two-year period as each campaign reported them to the FEC. Raised and spent are what the reports state; they say nothing about why money was given."
  );
  if (place.st === "CA") gaps.push(`California campaign money in ${year}: Cal-Access totals on ThePillory cover the current two-year period.`);
  gaps.push(`Meetings and agenda items: ThePillory reads ${esc(c.name)}'s agendas from the county's current meeting portal, from when the community launched.`);

  const crumbs = breadcrumb([["United States", "/explore/"], [place.name, `/explore/${st}/`], [c.name, placeHref(place.st, c.slug)], [String(year), null]]);
  const main = `${pastHead(url, year, crumbs, `${esc(c.name)} in ${year}`, `Who represented ${esc(c.name)} in ${year}, how they voted, executive orders signed that year, and campaign totals for the period. ${FEDERAL_FISCAL}.`, "Move the slider to see this county in another year")}
${block("federal", "Federal", rowsCard(execRows + senators + house, "No federal officeholders found for this year."), d ? `Districts: ${esc(d.note || "")} Source: Census Bureau relationship files.` : "")}
${cabinetHtml}
${stateHtml}
${voteHtml}
${orderHtml}
${caOrderHtml}
${moneyHtml}
${gapsSection(year, gaps)}`;
  return page(`${c.name} in ${year}`, main, { tab: "home", back: [c.name, placeHref(place.st, c.slug)], partial: anyFailed(fe, cong, dist, cal, linked, votes, orders, cabinet, money) });
}

// ---------------------------------------------------------------------------
// One official in a past year

/** The terms an official held, from data/history (members of Congress, Presidents and Vice Presidents). */
async function termsOf(env, request, o) {
  if ((o.chamber === "us-house" || o.chamber === "us-senate") && o.bioguide_id && o.state) {
    const cong = await loadCongress(env, request, o.state.toLowerCase());
    if (!cong) return null;
    const out = [];
    for (const t of cong.senate || []) if (t.bioguide === o.bioguide_id) out.push({ ...t, office: "U.S. Senator" });
    for (const [d, ts] of Object.entries(cong.house || {})) for (const t of ts) if (t.bioguide === o.bioguide_id) out.push({ ...t, office: d === "0" ? `U.S. Representative, ${o.state} at large` : `U.S. Representative, ${o.state}-${d}` });
    return out.sort((a, b) => a.start.localeCompare(b.start));
  }
  const g = /^exec:govtrack:(\d+)$/.exec(o.id);
  if (g) {
    const fe = await loadFederalExecutive(env, request);
    return ((fe && fe.terms) || []).filter((t) => String(t.govtrack) === g[1]).map((t) => ({ ...t }));
  }
  return null;
}

export async function officialPastYear(env, request, url, o, year) {
  const db = env.DB;
  const gaps = [];
  const termsLoaded = await loadSection("history terms", () => termsOf(env, request, o), null);
  const terms = termsLoaded === FAILED ? null : termsLoaded;
  const held = terms ? holdersInYear(terms, year) : [];
  const president = o.chamber === "us-executive" && o.rank === 1;
  const legislator = o.chamber === "us-house" || o.chamber === "us-senate";
  const min = terms && terms.length ? Math.max(FIRST_YEAR, yearOf(terms[0].start)) : FIRST_YEAR;

  const [counts, votes, orders, money] = await Promise.all([
    db && legislator && held.length ? loadSection("history official counts", () => voteCountInYear(db, o.id, year), null) : null,
    db && legislator && held.length ? loadSection("history official votes", () => officialVotesInYear(db, o.id, year, { all: url.searchParams.get("votes") === "all" }), { rows: [], more: false }) : { rows: [], more: false },
    db && president && held.length ? loadSection("history official orders", () => officialOrdersInYear(db, o.id, year), { rows: [], more: false }) : { rows: [], more: false },
    db && (legislator || o.chamber === "us-executive") ? loadSection("history official funding", () => fundingInCycle(db, [o.id], year), []) : [],
  ]);

  let office;
  if (terms === null) {
    office = `<p class="small">ThePillory's records of past officeholders cover Presidents, Vice Presidents and members of Congress. ${esc(o.office)} terms before the current one aren't in them.</p>`;
    gaps.push(`${esc(o.office)} terms before the current one: not in the officeholder records ThePillory reads.`);
  } else if (!held.length) {
    office = `<p class="small">${esc(o.name)} didn't hold ${o.chamber === "us-executive" ? "this office" : "a seat in Congress"} in ${year}, according to the Biographical Directory of the United States Congress.</p>`;
  } else {
    office = `<div class="card">${held.map((t) => `<div class="list-row"><div><div class="list-title">${esc(t.office)}</div><div class="list-meta">${t.party ? `Party: ${esc(t.party)} · ` : ""}${termText(t)}</div></div></div>`).join("")}</div>`;
  }
  const allTerms = terms && terms.length
    ? block("terms", "Every term on record", `<ul class="card plain-list">${terms.map((t) => `<li class="list-row"><div><div class="list-title">${esc(t.office)}</div><div class="list-meta">${termText(t)}</div></div><span class="row-end"><a class="inline-link xsmall" href="?year=${Math.max(FIRST_YEAR, Math.min(yearOf(t.start) + 1, new Date().getUTCFullYear() - 1))}">See ${Math.max(FIRST_YEAR, Math.min(yearOf(t.start) + 1, new Date().getUTCFullYear() - 1))}</a></span></li>`).join("")}</ul>`, "Source: the Biographical Directory of the United States Congress, via congress-legislators.")
    : "";

  let votesHtml = "";
  if (legislator && held.length) {
    if (year < FIRST_VOTE_YEAR) gaps.push(`Votes in ${year}: ThePillory loads House and Senate roll calls from ${FIRST_VOTE_YEAR} on.`);
    else {
      const all = url.searchParams.get("votes") === "all";
      const filter = `<div class="pill-filter" role="group" aria-label="Show"><a class="toggle" href="?year=${year}#h-votes"${all ? "" : ' aria-current="true"'}>Final passage</a><a class="toggle" href="?year=${year}&amp;votes=all#h-votes"${all ? ' aria-current="true"' : ""}>All votes</a></div>`;
      votesHtml = votes === FAILED ? sectionError("Votes") : block(
        "votes",
        `Votes in ${year}`,
        `${filter}${votes.rows.length ? `<ul class="plain-list vote-list card">${votes.rows.map((v) => `<li class="brief-vote"><div class="brief-vote-main"><span class="brief-vote-name">${esc(v.bill_number || v.subject || v.question)}</span><a class="brief-vote-meta xsmall" href="${v.bill_id ? `/laws/bills/${esc(v.bill_id)}/#votes` : esc(v.source_url)}">${esc(v.question)} · ${esc(v.result)} · ${fmtDate(v.vote_date)}</a></div><span class="brief-vote-position" title="Recorded as: ${esc(v.raw_position)}">${esc(v.position)}</span></li>`).join("")}</ul>` : `<p class="small secondary">No ${all ? "" : "final-passage "}votes loaded for ${year} yet. Past roll calls load a little each day, newest first.</p>`}`,
        counts && counts !== FAILED && counts.total ? `${counts.total} recorded vote${counts.total === 1 ? "" : "s"} loaded for ${year}, ${counts.final || 0} on final passage${votes.more ? "; the latest are shown" : ""}. Positions as the official record lists them.` : ""
      );
    }
  }
  let ordersHtml = "";
  if (president && held.length) {
    if (year < FIRST_ORDER_YEAR) gaps.push(`Executive orders in ${year}: the Federal Register's online records start in ${FIRST_ORDER_YEAR}.`);
    else ordersHtml = orders === FAILED ? sectionError("Executive orders") : block("orders", `Executive orders signed in ${year}`, listCard(orderRows(orders.rows, { who: false }), `None loaded for ${year} yet.`, "plain-list exec-list"), "Titles exactly as published in the Federal Register.");
  }
  const cycle = year % 2 ? year + 1 : year;
  const moneyHtml = legislator || o.chamber === "us-executive"
    ? money === FAILED ? sectionError("Campaign money") : block("money", `Campaign money, ${cycle - 1}–${cycle}`, listCard(fundingRows(money), `No FEC totals loaded for ${cycle - 1}–${cycle}.`), "Totals as the campaign reported them to the FEC for the two-year period. Contributors by industry are shown for the current period only.")
    : "";
  if (o.level === "state" || o.level === "county") gaps.push(`Votes and campaign money for ${year}: ThePillory loads California votes and Cal-Access money for the current session and period only.`);
  gaps.push("Platform statements and promises: ThePillory shows officials' current pages, not past versions.");

  const crumbs = breadcrumb([["Reps", "/reps/"], [o.name, `/reps/${o.slug}/`], [String(year), null]]);
  const main = `${pastHead(url, year, crumbs, `${esc(o.name)} in ${year}`, "", "Move the slider to see this official in another year", min)}
${block("office", `Office in ${year}`, office)}
${votesHtml}
${ordersHtml}
${moneyHtml}
${allTerms}
${gapsSection(year, gaps)}`;
  return page(`${o.name} in ${year}`, main, { tab: "reps", back: [o.name, `/reps/${o.slug}/`], partial: anyFailed(termsLoaded, counts, votes, orders, money) });
}

// ---------------------------------------------------------------------------
// A topic in a past year

async function topicBillsInYear(db, topic, level, year, limit = 10) {
  const { results } = await db
    .prepare(
      `SELECT v.id AS vote_id, v.bill_id, v.vote_date, v.question, v.result, v.chamber, b.bill_number, b.title, t.reason
       FROM topic_tags t JOIN votes v ON v.bill_id = t.item_id JOIN bills b ON b.id = v.bill_id
       WHERE t.item_kind = 'bill' AND t.topic = ? AND t.removed_at IS NULL AND v.level = ? AND v.vote_type = 'final_passage' AND v.vote_date >= ? AND v.vote_date < ?
       ORDER BY v.vote_date DESC LIMIT ?`
    )
    .bind(topic, level, `${year}-01-01`, `${year + 1}-01-01`, limit)
    .all();
  return results;
}

async function topicOrdersInYear(db, topic, year, limit = 10) {
  const { results } = await db
    .prepare(
      `SELECT a.*, o.name AS official_name FROM topic_tags t JOIN executive_actions a ON a.id = t.item_id JOIN officials o ON o.id = a.official_id
       WHERE t.item_kind = 'executive_action' AND t.topic = ? AND t.removed_at IS NULL AND a.signed_on >= ? AND a.signed_on < ?
       ORDER BY a.signed_on DESC LIMIT ?`
    )
    .bind(topic, `${year}-01-01`, `${year + 1}-01-01`, limit)
    .all();
  return results;
}

export async function topicPastYear(env, url, slug, year, { place = null, c = null } = {}) {
  const t = TOPIC[slug];
  const db = env.DB;
  const [federal, state, orders] = await Promise.all([
    db ? loadSection("history topic federal", () => topicBillsInYear(db, slug, "federal", year), []) : [],
    db && (!place || place.st === "CA") ? loadSection("history topic state", () => topicBillsInYear(db, slug, "state", year), []) : [],
    db ? loadSection("history topic orders", () => topicOrdersInYear(db, slug, year), []) : [],
  ]);
  const billRow = (b) => `<li class="list-row"><div><a class="list-title inline-link" href="/laws/bills/${esc(b.bill_id)}/">${esc(b.bill_number)}: ${esc(b.title)}</a><div class="list-meta">${esc(b.question)} · ${esc(b.result)} · ${fmtDate(b.vote_date)}</div>${b.reason ? `<div class="xsmall secondary">Tagged: ${esc(b.reason)}</div>` : ""}</div></li>`;
  const bills = (id, label, v) => (v === FAILED ? sectionError(label) : block(id, label, listCard(v.map(billRow).join(""), `No bill tagged with this topic had a final-passage vote loaded for ${year}.`)));
  const gaps = [
    `Topic tags: older bills and orders are tagged a few at a time, so ${year} may show fewer than were acted on.`,
    `Votes in Congress before ${FIRST_VOTE_YEAR} and California votes before the current session aren't loaded.`,
    "County meeting items, officials' own words and money by industry are shown for the present only.",
  ];
  const where = place ? ` in ${esc(c.name)}` : "";
  const crumbs = place
    ? breadcrumb([["United States", "/explore/"], [place.name, `/explore/${place.st.toLowerCase()}/`], [c.name, placeHref(place.st, c.slug)], [t.name, topicHref(slug, { st: place.st, slug: c.slug })], [String(year), null]])
    : breadcrumb([["Topics", "/topics/"], [t.name, topicHref(slug)], [String(year), null]]);
  const placeNote = place
    ? `<section class="card stack-xs"><p class="small">Who represented ${esc(c.name)} in ${year}, and how they voted: <a class="inline-link" href="${placeHref(place.st, c.slug)}?year=${year}">${esc(c.name)} in ${year}</a>.</p></section>`
    : "";
  const main = `${pastHead(url, year, crumbs, `${esc(t.name)}${where} in ${year}`, esc(t.about), "Move the slider to see this topic in another year")}
<section class="card stack-xs side-by-side"><p class="small">${esc(SIDE_BY_SIDE)}</p><p class="hint"><a class="inline-link" href="${METHOD}">How topics work</a></p></section>
${placeNote}
${bills("fed", `Bills in Congress with a final-passage vote in ${year}`, federal)}
${!place || place.st === "CA" ? bills("state", `Bills in the California Legislature with a final-passage vote in ${year}`, state) : ""}
${orders === FAILED ? sectionError("Executive orders") : block("orders", `Executive orders signed in ${year}`, listCard(orderRows(orders), `No executive order tagged with this topic is loaded for ${year}.`, "plain-list exec-list"))}
${gapsSection(year, gaps)}`;
  const back = place ? [t.name, topicHref(slug, { st: place.st, slug: c.slug })] : [t.name, topicHref(slug)];
  return page(`${t.name}${place ? ` in ${c.name}` : ""} in ${year}`, main, { tab: place ? "home" : "laws", back, partial: anyFailed(federal, state, orders) });
}
