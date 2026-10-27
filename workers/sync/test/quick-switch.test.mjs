// The Quick / Detailed switch shows only on pages that have a Quick version
// (docs/quick-mode.md): page() reads it from the page's .simple-scope, adds the
// switch and <body data-quick>, and every other page gets neither.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { page } from "../../../functions/_lib/render.js";
import { simpleCard, positionLinesPlain, repListPlain } from "../../../functions/_lib/simple.js";
import { meetingLinePlain } from "../../../functions/_lib/meetings.js";

test("a page with a Quick version gets the switch and data-quick", async () => {
  const html = await page("Bill", '<div class="simple-scope"><header class="summary-head"><h1>H.R. 1</h1></header></div>').text();
  assert.match(html, /data-mode-switch/);
  assert.match(html, /<body class="has-tabbar" data-quick>/);
  assert.doesNotMatch(html, /%%MODE%%/);
});

test("a page without one gets neither, and no placeholder is left", async () => {
  for (const main of ['<header class="page-head"><h1>Report</h1></header>', '<div class="page-scope"><h1>Your briefing</h1></div>']) {
    const html = await page("Plain", main).text();
    assert.doesNotMatch(html, /data-mode-switch/);
    assert.doesNotMatch(html, /data-quick/);
    assert.doesNotMatch(html, /%%MODE%%/);
  }
});

test("static pages (About, Report, You, search) never carry the switch", () => {
  const root = new URL("../../../", import.meta.url).pathname;
  const files = [];
  const walk = (d) => { for (const f of readdirSync(d)) { const p = `${d}/${f}`; statSync(p).isDirectory() ? walk(p) : f === "index.html" && files.push(p); } };
  for (const d of ["about", "report", "you", "search", "issues"]) walk(`${root}${d}`);
  assert.ok(files.length >= 5);
  for (const f of files) assert.doesNotMatch(readFileSync(f, "utf8"), /data-mode-switch|data-quick/, f);
});

test("the county page's and briefing's plain lines", () => {
  const meet = meetingLinePlain({ id: "m1", body: "Board of Supervisors", level: "county", starts_at: "2026-10-29T09:00", location: "Board Chambers, 891 Mountain Ranch Road, San Andreas", comment_deadline_text: "" });
  assert.match(meet, /Board of Supervisors<\/a> meets Thu, Oct 29 at 9:00 AM in San Andreas\./);
  const votes = positionLinesPlain([{ bill_id: "us-119-hr-1", bill_number: "H.R. 1", bill_title: "An Act", result: "Passed", vote_date: "2026-03-12", positions: [{ name: "Ann Able", slug: "ann-able", position: "Not voting" }] }]);
  assert.match(votes, /Ann Able<\/a> did not vote on <a class="inline-link" href="\/laws\/bills\/us-119-hr-1\/">H\.R\. 1<\/a> \(An Act\)\. It passed\./);
  assert.match(repListPlain([{ name: "Ann Able", slug: "ann-able", office: "U.S. Senator", district: "California" }]), /Ann Able<\/a>, U\.S\. Senator, California/);
  assert.equal(repListPlain([]), "");
  assert.equal(simpleCard({ lines: [["Latest votes", ""]] }), "", "nothing to say: no card, so the page has no Quick version");
});
