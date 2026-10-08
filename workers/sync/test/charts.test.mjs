// node workers/sync/test/charts.test.mjs
// The page components in functions/_lib/charts.js and icons.js: every chart
// says its numbers in words too, and nothing renders without data.
import { test } from "node:test";
import assert from "node:assert/strict";
import { voteBar, breakdownBar, miniBars } from "../../../functions/_lib/charts.js";
import { icon, ICON_NAMES } from "../../../functions/_lib/icons.js";
import { TOPICS } from "../src/topics/list.js";

test("vote bar: the totals in words and as a bar; nothing without totals", () => {
  const html = voteBar({ yea: 51, nay: 47, present: 0, not_voting: 2 });
  assert.match(html, /aria-label="Yes 51, No 47, Not voting 2"/);
  assert.match(html, />Yes 51</);
  assert.match(html, />No 47</);
  assert.match(html, /class="vb-seg-yes" style="width:51.00%"/);
  assert.match(html, /Not voting 2/);
  assert.equal(voteBar({ yea: null, nay: null }), "");
  assert.doesNotMatch(voteBar({ yea: 3, nay: 1 }, { note: false }), /vote-bar-note/);
});

test("breakdown bar: each part's amount and share, in order, with a legend", () => {
  const html = breakdownBar([{ label: "Small donors", value: 25 }, { label: "PACs", value: 75 }], { total: 100, format: (n) => `$${n}` });
  assert.match(html, /Small donors 25%, PACs 75%/);
  assert.match(html, /<span class="bl-name">PACs<\/span><span class="bl-amt">\$75<\/span><span class="bl-pct">75%<\/span>/);
  assert.equal(breakdownBar([], { total: 0 }), "");
});

test("small bar chart: a table of the numbers; negative values below the line", () => {
  const html = miniBars([{ label: "FY1", value: 10, tick: "1" }, { label: "FY2", value: -5, tick: "2" }], { format: (n) => `${n}`, caption: "Example" });
  assert.match(html, /has-zero/);
  assert.match(html, /class="is-neg"/);
  assert.match(html, /<th scope="row">FY2<\/th><td>-5<\/td>/);
  assert.equal(miniBars([{ label: "only", value: 1 }]), "");
});

test("every topic has an icon, and icons are hidden from screen readers", () => {
  for (const t of TOPICS) assert.ok(ICON_NAMES.includes(t.slug), t.slug);
  assert.match(icon("water"), /aria-hidden="true"/);
  assert.equal(icon("nope"), "");
});
