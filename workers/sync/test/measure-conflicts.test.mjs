// node --test test/measure-conflicts.test.mjs
// "Conflicts with other measures" on the "Just the facts" card
// (functions/_lib/measure-facts.js): only where the official text says a
// measure can void, or be voided by, another on the same ballot; quoted word
// for word with the measures it names linked; nothing for a measure without
// such text. California's November 3, 2026 file (props 40, 41, 42) and a
// measure with no conflict text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { factsCard, factsFold, measureConflicts, measureFacts } from "../../../functions/_lib/measure-facts.js";

const CA = JSON.parse(readFileSync(new URL("../../../data/elections/2026-11-03.json", import.meta.url), "utf8"));
const prop = (n) => CA.measures.find((m) => m.scope === "statewide" && m.number === n);
const href = (n) => `href="/elections/2026-11-03/measure/prop-${n}/"`;
const panelOf = (html) => (html.match(/<p class="label">Conflicts with other measures<\/p>[\s\S]*?<\/div>\s*<\/div>/) || [""])[0];

test("Prop 40: the Legislative Analyst's figure, word for word, naming 41 and 42, both linked", () => {
  const html = factsCard(CA, prop("40"));
  const panel = panelOf(html);
  assert.ok(panel, "the panel is there");
  assert.match(panel, /Potential Interactions With Other Propositions/);
  assert.match(panel, /“If Proposition 41 or 42 on this same ballot receive more yes votes than Proposition 40, then Propostion 40 could be stopped from becoming law/, "as the guide prints it");
  assert.match(panel, new RegExp(`Names <a class="inline-link" ${href("41")}>Prop 41</a>, <a class="inline-link" ${href("42")}>Prop 42</a>\\.`));
  assert.ok(html.indexOf("Conflicts with other measures") > html.indexOf("What it changes") && html.indexOf("Conflicts with other measures") < html.indexOf('<p class="label">Cost</p>'), "right after What it changes");
  assert.match(html, /Can cancel or be cancelled by: <a class="inline-link" href="\/elections\/2026-11-03\/measure\/prop-41\/">Prop 41<\/a>, <a[^>]*>Prop 42<\/a>/, "the Quick line");
  assert.match(html, /class="inset stack-xs detail-only"><p class="label">Conflicts with other measures/, "the quote in Detailed");
  assert.match(html, /facts-sources[\s\S]*voterguide\.sos\.ca\.gov\/propositions\/40\/analysis\.htm/, "the analysis in the source line");
});

test("Props 41 and 42: their own figures, each naming and linking Prop 40", () => {
  for (const n of ["41", "42"]) {
    const panel = panelOf(factsCard(CA, prop(n)));
    assert.match(panel, new RegExp(`“If Proposition ${n} receives more “yes” votes than Proposition 40 on this same ballot`), n);
    assert.match(panel, new RegExp(`Names <a class="inline-link" ${href("40")}>Prop 40</a>\\.`), n);
    assert.doesNotMatch(panel, /Prop 4[12]</, `${n} doesn't link the other tax measure: its text doesn't name it`);
  }
});

test("a measure with no conflict text: no panel, no Quick line, no 'None'", () => {
  const m = prop("1");
  assert.equal(measureConflicts(CA, m), null);
  const html = factsCard(CA, m) + factsFold(CA, m, { href: "/x/", name: "Proposition 1" });
  assert.doesNotMatch(html, /Conflicts with other measures|Can cancel or be cancelled by|None/);
});

test("another measure's text that names this one is shown, attributed, when this one's doesn't name it", () => {
  const election = { election: { id: "2026-11-03", state: "CA" }, measures: [
    { id: "prop-1", number: "1", scope: "statewide", title: "A", conflicts: [{ text: "If Proposition 1 gets more yes votes than Proposition 2 on this same ballot, Proposition 2 could be stopped.", measures: ["prop-2"], source: "Legislative Analyst's analysis, Official Voter Information Guide", source_url: "https://example.gov/1/analysis.htm" }] },
    { id: "prop-2", number: "2", scope: "statewide", title: "B" },
  ] };
  const c = measureConflicts(election, election.measures[1]);
  assert.match(c.html, /<a class="inline-link" href="\/elections\/2026-11-03\/measure\/prop-1\/">Prop 1<\/a>, Legislative Analyst&#x27;s analysis:|<a class="inline-link" href="\/elections\/2026-11-03\/measure\/prop-1\/">Prop 1<\/a>, Legislative Analyst's analysis:/);
  assert.match(c.html, /“If Proposition 1 gets more yes votes than Proposition 2 on this same ballot, Proposition 2 could be stopped\.”/);
  assert.match(c.quick, /Can cancel or be cancelled by: <a[^>]*>Prop 1<\/a>/);
  assert.ok(measureFacts(election, election.measures[1]).sources.some((s) => s.url === "https://example.gov/1/analysis.htm"));
});

test("the summary's conflict line, naming no measure: quoted, and the Quick line is the quote", () => {
  const line = "States that other voter-approved measures appearing on the same ballot are void if they conflict with this measure and this measure receives more affirmative votes.";
  const election = { election: { id: "x", state: "CA" }, measures: [{ id: "prop-9", number: "9", scope: "statewide", title: "C", conflicts: [{ text: line, measures: [], source: "Attorney General's official title and summary", source_url: "https://example.gov/9/ts.htm" }] }] };
  const c = measureConflicts(election, election.measures[0]);
  assert.match(c.html, new RegExp(`“${line.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}”`));
  assert.doesNotMatch(c.html, /Names /);
  assert.equal(c.quick, `“${line}”`);
});
