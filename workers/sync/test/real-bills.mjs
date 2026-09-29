// Run the analysis pipeline on real federal bills, outside Cloudflare, and print
// the drafts as Markdown. Nothing is saved anywhere. Used by the "Real-bill
// analysis" GitHub workflow (the keys live in repository secrets), or locally:
//
//   ANTHROPIC_API_KEY=… COURTLISTENER_API_TOKEN=… CONGRESS_API_KEY=… \
//     node workers/sync/test/real-bills.mjs --latest 3       # newest House final-passage votes
//   … node workers/sync/test/real-bills.mjs us-119-hr-1 …   # or specific bills
//
// Same code as the Worker: bill text, the Claude call, and both checks.
import { api, BILL_TYPES } from "../src/congress-api.js";
import { Budget, currentCongress, congressSessions, ordinal } from "../src/util.js";
import { PROVISIONS } from "../src/constitution.js";
import { fetchBillText } from "../src/analysis/billtext.js";
import { draftAnalysis } from "../src/analysis/claude.js";
import { verifyQuotes, verifyCitations, sameCase } from "../src/analysis/verify.js";
import { makeLookup } from "../src/analysis/courtlistener.js";
import { PROMPT_VERSION } from "../src/analysis/prompt.js";

const env = { ...process.env, MAX_SUBREQUESTS: "200" };
for (const k of ["ANTHROPIC_API_KEY", "COURTLISTENER_API_TOKEN", "CONGRESS_API_KEY"]) {
  if (!env[k]) {
    console.log(`Skipped: ${k} is not set.`);
    process.exit(0);
  }
}
const budget = new Budget(env, 60 * 60 * 1000);
const args = process.argv.slice(2);

async function latestPassed(n) {
  // The newest House roll calls on passing a bill (not amendments or procedure), as Congress.gov lists them.
  const congress = currentCongress();
  const out = [];
  for (const session of congressSessions(congress).slice().reverse()) {
    const list = await budget.json(api(env, `/house-vote/${congress}/${session}`, { limit: "250" }), {}, "house votes");
    const votes = (list.houseRollCallVotes || []).slice().sort((a, b) => (b.rollCallNumber || 0) - (a.rollCallNumber || 0));
    for (const v of votes) {
      if (out.length >= n) return out;
      const type = String(v.legislationType || "").toUpperCase().replace(/[^A-Z]/g, "");
      if (!["HR", "S", "HJRES", "SJRES"].includes(type) || !v.legislationNumber) continue;
      const d = await budget.json(api(env, `/house-vote/${congress}/${session}/${v.rollCallNumber}`), {}, "house vote");
      const q = String((d.houseRollCallVote || {}).voteQuestion || "");
      if (!/pass/i.test(q) || /amendment|recommit|motion to (table|proceed)/i.test(q)) continue;
      const id = `us-${congress}-${type.toLowerCase()}-${v.legislationNumber}`;
      if (!out.some((x) => x.id === id)) out.push({ id, vote: `${q} (House roll call ${v.rollCallNumber}, ${String(v.startDate || "").slice(0, 10)})` });
    }
  }
  return out;
}

async function billInfo(id) {
  const [, congress, type, number] = /^us-(\d+)-([a-z]+)-(\d+)$/.exec(id) || [];
  if (!congress) throw new Error(`not a federal bill ID: ${id}`);
  const b = (await budget.json(api(env, `/bill/${congress}/${type}/${number}`), {}, "bill")).bill || {};
  const [prefix, path] = BILL_TYPES[type.toUpperCase()] || [type.toUpperCase(), "bill"];
  return {
    id,
    level: "federal",
    bill_number: `${prefix} ${number}`,
    session: congress,
    title: b.title || id,
    official_url: `https://www.congress.gov/bill/${ordinal(parseInt(congress, 10))}-congress/${path}/${number}`,
  };
}

const list = (xs) => (xs.length ? xs.map((x) => `- ${x}`).join("\n") : "_None._");

function markdown(bill, why, source, result, draft, quoteLog, citeLog) {
  const byId = new Map(PROVISIONS.map((p) => [p.id, p]));
  const u = result.usage;
  return `## ${bill.bill_number}: ${bill.title}

${why ? `Picked because: ${why}. ` : ""}Read from: ${source.version || source.basis} (${source.source_url})${source.basis !== "full_text" ? `. **Limited: ${source.basis === "summary_only" ? "based on summary only" : source.note}.**` : ""}

Status: **AI-drafted, not yet reviewed** · model \`${result.model}\` · prompt ${PROMPT_VERSION} · tokens in ${u.input_tokens}, out ${u.output_tokens}, cache read ${u.cache_read_tokens}, cache write ${u.cache_write_tokens}

**What the bill does.** ${draft.plain_summary}

**Provisions it touches**
${draft.clauses.map((c) => `- **${(byId.get(c.id) || {}).label || c.id}**: “${c.quote}”. ${c.why}`).join("\n") || "_None._"}

**Where it aligns**
${list(draft.aligns)}

**Where it may be in tension**
${list(draft.tension)}

**Why this might still serve the public**
${list(draft.departure)}

**Article V.** ${draft.article_v}

**How different approaches read it**
${
  draft.readings.length
    ? draft.readings.map((r) => `- _${r.question}_\n  - Original meaning: ${r.original_meaning}\n  - Precedent: ${r.precedent}\n  - Evolving interpretation: ${r.evolving}`).join("\n")
    : "_No contested questions identified._"
}

**Cases cited (verified in CourtListener)**
${list(draft.citations.map((c) => `[${c.case_name}, ${c.citation}](${c.url}): ${c.point}`))}

**What this analysis can't tell you.** ${draft.uncertainty}

<details><summary>What the automatic checks did</summary>

- Constitution quotes checked: ${quoteLog.checked}; replaced with stored text: ${quoteLog.replaced.length}
${quoteLog.replaced.map((r) => `  - ${r.field}: “${r.given}” → “${r.stored}” (${r.from})`).join("\n")}
- Citations looked up: ${citeLog.checked.length}; removed: ${citeLog.removed_citations.length}
${citeLog.checked.map((c) => `  - ${c.case_name}, ${c.citation}: ${c.status}${c.message ? ` (${c.message})` : ""}`).join("\n")}
- Sentences removed for relying on an unverified case: ${citeLog.removed_sentences.length}
${citeLog.removed_sentences.map((r) => `  - ${r.field}: “${r.sentence}” (${r.because})`).join("\n")}

</details>
`;
}

const picks = args[0] === "--latest" ? await latestPassed(parseInt(args[1] || "3", 10)) : args.map((id) => ({ id, vote: null }));
console.log(`# Real-bill analysis drafts\n\nRun ${new Date().toISOString()}. Drafts are unreviewed and were not saved anywhere.\n`);
for (const pick of picks) {
  try {
    const bill = await billInfo(pick.id);
    const source = await fetchBillText(env, budget, bill);
    if (!source) {
      console.log(`## ${bill.bill_number}\n\nSkipped: no bill text or official summary available.\n`);
      continue;
    }
    const result = await draftAnalysis(env, bill, source);
    const draft = result.draft;
    const quoteLog = verifyQuotes(draft, PROVISIONS);
    const citeLog = await verifyCitations(draft, makeLookup(env, budget, sameCase));
    console.log(markdown(bill, pick.vote, source, result, draft, quoteLog, citeLog));
  } catch (err) {
    console.log(`## ${pick.id}\n\nFailed: ${err.name}: ${err.message}\n`);
  }
}
console.log(`\n_${budget.used} outside requests._`);
