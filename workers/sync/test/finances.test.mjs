// node workers/sync/test/finances.test.mjs
// The Time Machine's finances and year helpers: fiscal years, the start and end
// of a term, the measures (change, share of GDP, per person and household),
// Congresses and events in a term, which year a page shows, and who held a
// seat in a year. Every number and name here is invented.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fiscalYearOf, termYears, measure, congressesIn, eventsIn, federalTerms, californiaTerms, usd, pctText } from "../../../functions/_lib/finances.js";
import { pickYear, todayHref, yearBar, pastBanner, districtsIn, congressIn, californiaIn, mergeTerms, executiveIn, gapsSection } from "../../../functions/_lib/history.js";

test("fiscal years: federal from October 1, California from July 1", () => {
  assert.equal(fiscalYearOf("2009-01-20", { startMonth: 10 }), 2009);
  assert.equal(fiscalYearOf("2008-10-01", { startMonth: 10 }), 2009);
  assert.equal(fiscalYearOf("2008-09-30", { startMonth: 10 }), 2008);
  assert.equal(fiscalYearOf("2019-01-07", { startMonth: 7 }), 2019);
  assert.equal(fiscalYearOf("2019-07-01", { startMonth: 7 }), 2020);
});

test("a term's start and end fiscal years, the same rule for every term", () => {
  // Inaugurated January 2009, left January 2017: FY2008 ended before; FY2016 was the last to end during the term.
  assert.deepEqual(termYears("2009-01-20", "2017-01-20", { startMonth: 10, latest: 2025, today: "2026-10-08" }), { before: 2008, first: 2009, last: 2016, inProgress: false });
  // A term in progress ends at the latest published year.
  assert.deepEqual(termYears("2025-01-20", "2029-01-20", { startMonth: 10, latest: 2025, today: "2026-10-08" }), { before: 2024, first: 2025, last: 2025, inProgress: true });
});

const ROWS = new Map([
  [2008, { fy: 2008, debt: 1000, gdp: 4000, population: 10, households: 4 }],
  [2016, { fy: 2016, debt: 1500, gdp: 5000, population: 12, households: null }],
]);

test("a measure: start, end, change, share of GDP, per person and per household", () => {
  const m = measure(ROWS, "debt", 2008, 2016);
  assert.equal(m.start, 1000);
  assert.equal(m.end, 1500);
  assert.equal(m.change, 500);
  assert.equal(m.changePct, 50);
  assert.equal(m.startShare, 25);
  assert.equal(m.endShare, 30);
  assert.equal(m.startPerPerson, 100);
  assert.equal(m.endPerPerson, 125);
  assert.equal(m.startPerHousehold, 250);
  assert.equal(m.endPerHousehold, null); // not available stays not available
  const missing = measure(ROWS, "debt", 2007, 2016);
  assert.equal(missing.start, null);
  assert.equal(missing.change, null);
});

const CONTROL = {
  house: { 110: { years: [2007, 2009], democrats: 233, republicans: 202, majority: "Democrats" }, 111: { years: [2009, 2011], democrats: 257, republicans: 178, majority: "Democrats" } },
  senate: { 110: { years: [2007, 2009], majority: "Democrats", majorities: ["Democrats"] }, 111: { years: [2009, 2011], majority: null, majorities: ["Democrats", "Republicans"] } },
};

test("Congresses that overlap a term, and events that began during it", () => {
  assert.deepEqual(congressesIn(CONTROL, "2009-01-20", "2013-01-20").map((c) => c.congress), [111]);
  assert.deepEqual(congressesIn(CONTROL, "2005-01-20", "2009-01-20").map((c) => c.congress), [110]);
  const events = [{ kind: "Recession", label: "Example", from: "2007-12", to: "2009-06" }, { kind: "Pandemic", label: "Example", from: "2009-04", to: "2010-06" }];
  assert.deepEqual(eventsIn(events, "2009-01-20", "2013-01-20").map((e) => e.kind), ["Pandemic"]);
});

test("federal and California terms get the same measures", () => {
  const fin = {
    federal: {
      years: [
        { fy: 2008, debt: 1000, receipts: 100, outlays: 120, surplus: -20, gdp: 4000, population: 10, households: 4, functions: { "National Defense": 30, "Net interest": 10 } },
        { fy: 2016, debt: 1500, receipts: 150, outlays: 160, surplus: -10, gdp: 5000, population: 12, households: 5, functions: { "National Defense": 33, "Net interest": 12 } },
      ],
      terms: [{ name: "First Example", start: "2009-01-20", end: "2017-01-20" }],
      control: CONTROL,
    },
    california: {
      general_fund: { rows: { 2018: { revenues: 50, expenditures: 45, ending_balance: 5 }, 2026: { revenues: 60, expenditures: 70, ending_balance: 1 }, 2027: { revenues: 99, expenditures: 99, ending_balance: 0 } } },
      governors: [{ name: "Second Example", from: 2019, to: null }],
      population: { 2018: 5, 2026: 6 },
      households: {},
    },
    events: [],
  };
  const [t] = federalTerms(fin, "2026-10-08");
  assert.equal(t.debt.change, 500);
  assert.equal(t.interest.end, 12);
  assert.deepEqual(t.categories.map((c) => c.name), ["National Defense", "Net interest"]);
  const [g] = californiaTerms(fin, "2026-10-08");
  assert.equal(g.years.before, 2018);
  assert.equal(g.revenues.end, 60); // FY2025-26 ended June 30, 2026; FY2026-27 (an estimate) is left out
  assert.equal(g.revenues.startPerPerson, 10);
  assert.equal(g.revenues.startShare, null);
});

test("plain number formatting", () => {
  assert.equal(usd(1.5e12), "$1.50 trillion");
  assert.equal(usd(-2.34e11), "−$234.0 billion");
  assert.equal(usd(5e10, { signed: true }), "+$50.0 billion");
  assert.equal(usd(12345.6), "$12,346");
  assert.equal(usd(null), "Not available");
  assert.equal(pctText(12.345), "+12.3%");
  assert.equal(pctText(-3), "−3.0%");
});

test("which year a page shows: past years only, from 1993", () => {
  const now = new Date("2026-10-08T00:00:00Z");
  assert.equal(pickYear(new URL("https://x.test/a/?year=2008"), now), 2008);
  assert.equal(pickYear(new URL("https://x.test/a/?year=2026"), now), null);
  assert.equal(pickYear(new URL("https://x.test/a/?year=1980"), now), null);
  assert.equal(pickYear(new URL("https://x.test/a/?year=abc"), now), null);
  assert.equal(todayHref(new URL("https://x.test/reps/a/?year=2008&votes=all&page=2")), "/reps/a/?votes=all");
});

test("the year bar works without JavaScript and keeps other settings; the banner links back to today", () => {
  const url = new URL("https://x.test/reps/a/?votes=all&year=2008");
  const bar = yearBar(url, 2008, { now: new Date("2026-10-08T00:00:00Z") });
  assert.match(bar, /<form class="year-bar card" method="get" action="\/reps\/a\/"/);
  assert.match(bar, /type="range" name="year" min="1993" max="2026" step="1" value="2008"/);
  assert.match(bar, /name="votes" value="all"/);
  assert.match(bar, /type="submit">Show this year/);
  const banner = pastBanner(2008, url);
  assert.match(banner, /<strong>2008<\/strong>/);
  assert.match(banner, /href="\/reps\/a\/\?votes=all">Back to today/);
  assert.match(gapsSection(2008, ["Example gap"]), /Not available for 2008/);
  assert.equal(gapsSection(2008, []), "");
});

test("who held office in a year: districts, members of Congress, the executive, California", () => {
  const dist = { periods: [{ from: 2013, to: 2022, cd: { "06009": [["4", 1]] }, sldu: { "06009": [["8", 1]] }, sldl: { "06009": [["5", 1]] } }] };
  assert.deepEqual(districtsIn(dist, "06009", 2015).cd, [["4", 1]]);
  assert.equal(districtsIn(dist, "06009", 2005), null);
  const cong = {
    senate: [{ name: "Senator Example", bioguide: "X000001", start: "2011-01-05", end: "2017-01-03" }],
    house: { 4: [{ name: "Member Example", bioguide: "Y000002", start: "2013-01-03", end: "2015-01-03" }, { name: "Member Example", bioguide: "Y000002", start: "2015-01-06", end: "2017-01-03" }] },
  };
  const m = congressIn(cong, 2015, ["4"]);
  assert.equal(m.senate.length, 1);
  assert.equal(m.house["4"].length, 1); // back-to-back terms are one row
  assert.equal(m.house["4"][0].end, "2017-01-03");
  assert.equal(mergeTerms([]).length, 0);
  const fe = { terms: [{ office: "President", name: "A", start: "2009-01-20", end: "2017-01-20" }, { office: "President", name: "B", start: "2017-01-20", end: "2021-01-20" }, { office: "Vice President", name: "C", start: "2009-01-20", end: "2017-01-20" }] };
  assert.deepEqual(executiveIn(fe, 2017).presidents.map((t) => t.name), ["A", "B"]);
  const cal = {
    governors: { list: [{ name: "Governor Example", from: 2011, to: 2019 }] },
    elections: [
      { year: 2014, source: "https://example.org/sov", winners: [{ office: "controller", label: "Controller", name: "Officer Example", party: "X" }, { office: "governor", label: "Governor", name: "Governor Example", party: "X" }, { office: "sldl", district: "5", name: "Assembly Example", party: "Y" }, { office: "sldu", district: "8", name: "Senate Example", party: "Y" }] },
    ],
  };
  const ca = californiaIn(cal, 2015);
  assert.deepEqual(ca.governors.map((g) => g.name), ["Governor Example"]);
  assert.ok(ca.statewide.some((w) => w.name === "Officer Example" && w.election === 2014));
  assert.equal(ca.seat("sldl", "5").name, "Assembly Example");
  assert.equal(ca.seat("sldu", "8").name, "Senate Example");
  // An Assembly term is two years: by 2017 the 2014 winner's term is over.
  assert.equal(californiaIn(cal, 2017).seat("sldl", "5"), null);
  assert.equal(californiaIn(cal, 2018).seat("sldu", "8").name, "Senate Example");
  assert.equal(californiaIn(cal, 2014).seat("sldl", "5"), null); // elected in November, serves from January
});
