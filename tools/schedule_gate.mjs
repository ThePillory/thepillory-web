// Whether a scheduled workflow runs today (docs/data-sync.md, "How often each source updates").
// The workflows keep one daily cron, and this gate decides from the rules in
// workers/sync/src/cadence.js (shared with the sync Worker): weekly jobs run on Mondays, and
// daily in their windows (filing deadlines, election season, the Court's term, the disclosure
// season). A run started by hand always runs.
//
//   node tools/schedule_gate.mjs <job> <event name> [--daily-only]
//
// --daily-only: an extra cron that runs only on the job's daily days (candidates' second run).
// Writes run=true|false to $GITHUB_OUTPUT and one line to the run summary.
import { readFileSync, appendFileSync } from "node:fs";
import { workflowDue, WORKFLOW_CADENCE } from "../workers/sync/src/cadence.js";

const [job, event = "schedule", ...flags] = process.argv.slice(2);
if (!job || !(job in WORKFLOW_CADENCE)) {
  console.error(`usage: node tools/schedule_gate.mjs <${Object.keys(WORKFLOW_CADENCE).join("|")}> <event name> [--daily-only]`);
  process.exit(2);
}
const day = new Date().toISOString().slice(0, 10);
let dates = null;
try {
  dates = JSON.parse(readFileSync(new URL("../data/elections/dates.json", import.meta.url), "utf8"));
} catch {
  dates = { states: {} };
}
let { run, why } = workflowDue(job, day, { dates });
if (flags.includes("--daily-only") && run && !/^daily/.test(why)) {
  run = false;
  why = `${why}; this extra run is for daily days only`;
}
if (event !== "schedule") {
  run = true;
  why = `started by hand (${event})`;
}
const line = `${job} on ${day}: ${run ? "runs" : "skipped"} (${why})`;
console.log(line);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `run=${run}\n`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${line}\n`);
