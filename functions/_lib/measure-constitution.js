// The "Constitution" section of a ballot measure's page (docs/elections.md,
// "The Constitution section"; migration 0041). Facts only, the same layout for
// every measure: what it changes (quoted from the official text), the
// constitutional provisions it touches (quoted word for word, or linked to the
// state's official text), and court records that mention it. Shown only once
// every measure of the election is approved on /admin/review/measures/, so
// they all go live at once. No "aligns / may be in tension" panels until after
// the election.
import { esc, fmtDate, safeUrl } from "./render.js";
import { fold } from "./summary.js";
import { currentAnalysis, isPublic, parse, provisionsFor, baselineSection } from "./analysis.js";

export const NOT_ADVICE = "This shows which parts of the Constitution each measure involves. It is not a recommendation on how to vote.";
export const METHOD = "/about/methodology/#measure-constitution";

/** How each kind of change is said: short (a fold's line) and long. "the state constitution" names the state on the page. */
export const CHANGES = {
  constitution: { short: "Amends the state constitution", long: "This measure amends the state constitution." },
  statute: { short: "Changes state statutes", long: "This measure changes state statutes (laws passed by the legislature or by voters), not the constitution." },
  both: { short: "Amends the constitution and statutes", long: "This measure amends the state constitution and changes state statutes." },
  convention: { short: "Asks about a constitutional convention", long: "This measure asks voters whether to hold a convention to revise the state constitution." },
  unclear: { short: "What it changes isn't stated", long: "The official text doesn't say whether this measure changes the constitution or statutes." },
};

// The line under each provision: one short neutral sentence (tools/measure_constitution.py has the same rule).
export const LINE_RULE = "Each line is one short neutral sentence that starts with \"This measure\" or \"The measure's\": what the measure does to the provision, nothing about effects or whether it's constitutional.";
const LOADED = /\b(unconstitutional|violat\w*|conflict\w*|protect\w*|attack\w*|threat\w*|harm\w*|danger\w*|unfair\w*|radical|extreme\w*|good|bad|best|worst|should|must not|clearly|obviously|undermin\w*|erode\w*|strip\w*|guarantee\w*|preserv\w*|restor\w*|recommend\w*|vote (?:yes|no)|support\w*|oppos\w*)\b/i;

/** Why a line can't be used, or "" when it can. Pure. */
export function lineProblem(line) {
  const s = String(line || "").replace(/\s+/g, " ").trim();
  if (!/^(This measure|The measure)/.test(s)) return 'start the line with "This measure" or "The measure\'s".';
  if (!s.endsWith(".")) return "end the line with a period.";
  if (s.split(" ").length > 30) return "keep the line to 30 words.";
  const m = LOADED.exec(s);
  if (m) return `leave out "${m[0]}": say what the measure does to the provision, not its effect.`;
  return "";
}

const json = (s, fallback) => {
  try {
    return JSON.parse(s || "") ?? fallback;
  } catch (_) {
    return fallback;
  }
};

/**
 * The approved section for one measure, or null. Null until every measure
 * counted by the drafting tool (sync_state 'measure_constitution_total') is
 * approved: they go live together.
 */
export async function publishedSection(db, electionId, measureId) {
  if (!db) return null;
  try {
    const [count, total, row] = await Promise.all([
      db.prepare("SELECT COUNT(*) AS n, SUM(status = 'approved') AS ok FROM measure_constitution").first(),
      db.prepare("SELECT value FROM sync_state WHERE key = 'measure_constitution_total'").first(),
      db.prepare("SELECT * FROM measure_constitution WHERE measure_key = ? AND status = 'approved'").bind(`${electionId}/${measureId}`).first(),
    ]);
    const expected = total ? parseInt(total.value, 10) : 0;
    if (!row || !expected || !count || count.n < expected || count.ok !== count.n) return null;
    return row;
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return null;
    throw err;
  }
}

const ext = (url, text) => (safeUrl(url) ? `<a class="inline-link" href="${esc(url)}" target="_blank" rel="noopener">${esc(text)} ↗</a>` : esc(text));
const link = (url, text) => (safeUrl(url) && !/^https?:\/\/thepillory\.co\//.test(url) ? ext(url, text) : `<a class="inline-link" href="${esc(String(url || "").replace(/^https?:\/\/thepillory\.co/, ""))}">${esc(text)}</a>`);

/** The section, collapsed until opened, the same for every measure. `stateName`: "California". */
export function constitutionSection(row, { stateName, label }) {
  if (!row) return "";
  const kind = CHANGES[row.changes] || CHANGES.unclear;
  const provisions = json(row.provisions, []);
  const cases = json(row.cases, []);
  const checked = fmtDate(String(row.cases_checked_at || "").slice(0, 10));
  const stateText = (s) => s.replace("the state constitution", `the ${stateName} Constitution`);
  const inner = `
<div class="stack-sm">
  <h3 class="label">What it changes</h3>
  <p><strong>${esc(stateText(kind.long))}</strong></p>
  ${row.changes_quote ? `<blockquote class="quote">${row.changes_quote.split("\n\n").map((q) => `<p>“${esc(q)}”</p>`).join("")}</blockquote>` : ""}
  <p class="small secondary">From ${ext(row.changes_source_url, row.changes_source)}.</p>
</div>
<div class="stack-sm">
  <h3 class="label">Constitutional provisions it touches</h3>
  ${provisions.length
    ? provisions.map((p) => `<article class="card stack-xs measure-provision">
    <p class="small"><strong>${link(p.url, p.label)}</strong></p>
    ${p.quote ? `<blockquote class="constitution-text">${p.quote.split("\n\n").map((q) => `<p>${esc(q)}</p>`).join("")}${p.cut ? `<p class="small">… ${link(p.url, "the full text")}</p>` : ""}</blockquote>` : p.new ? `<p class="small secondary">Not in the ${esc(stateName)} Constitution now: its proposed words are in ${ext(p.url, "the measure's official text")}.</p>` : `<p class="small secondary">The full text is on the state's official site: ${ext(p.url, `the ${stateName} Constitution`)}.</p>`}
    <p class="small">${esc(p.line)}</p>
  </article>`).join("")
    : `<p class="small secondary">No provision of the U.S. Constitution or the ${esc(stateName)} Constitution is named in the official text read for this measure (${ext(row.changes_source_url, row.changes_source)}).</p>`}
</div>
<div class="stack-sm">
  <h3 class="label">Legal challenges</h3>
  ${cases.length
    ? `<ul class="plain-list stack-xs">${cases.map((c) => `<li class="small"><strong>${ext(c.url, c.name)}</strong><br /><span class="secondary">${esc([c.court, c.docket, c.filed ? `filed ${fmtDate(c.filed)}` : ""].filter(Boolean).join(" · "))}</span></li>`).join("")}</ul>`
    : `<p class="small secondary">No court records that mention ${esc(label)} were found on CourtListener${checked ? `, as of ${esc(checked)}` : ""}.</p>`}
  <p class="hint">Court records are listed as filed, from CourtListener's search, and aren't summarized: ThePillory doesn't describe cases or predict outcomes. The list may miss cases, especially in state courts.</p>
</div>
<p class="banner">${esc(NOT_ADVICE)}</p>
<p class="hint">AI-drafted from the official text, checked word for word in code, and reviewed by ${esc(row.reviewed_by || "a person")}, ${esc(fmtDate(String(row.reviewed_at || "").slice(0, 10)))}. <a class="inline-link" href="${METHOD}">How this works</a></p>`;
  return fold("constitution", "Constitution", inner, { meta: stateText(kind.short).replace(`the ${stateName} Constitution`, "the constitution") });
}

/**
 * After the election: the full three-panel analysis of the measure (drafted by
 * the sync's analysis step from measure_analysis_queue, keyed
 * "measure:<election>/<measure>"), shown only once it is public (approved, or
 * passed by the AI reviewer). "" until then.
 */
export async function measureAnalysisSection(db, electionId, measureId) {
  if (!db) return "";
  try {
    const row = await currentAnalysis(db, `measure:${electionId}/${measureId}`);
    if (!isPublic(row)) return "";
    const a = parse(row);
    const provisions = await provisionsFor(db, a.clauses.map((c) => c.id));
    return baselineSection(a, provisions, { noun: "measure" });
  } catch (err) {
    if (/no such table|no such column/i.test(String(err && err.message))) return "";
    throw err;
  }
}
