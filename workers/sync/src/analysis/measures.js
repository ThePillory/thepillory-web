// Statewide ballot measures after the election: the full three-panel
// constitutional analysis (Where it aligns / Where it may be in tension / Why
// this might still serve the public) of every measure in measure_analysis_queue
// (migration 0041), passed or not, through the same drafting, checks and review
// as bills and executive orders. Queued by tools/measure_constitution.py with
// each measure's official text (the Worker can't read the states' PDFs); none
// is drafted before its not_before date (the day after the election). Stored in
// bill_analyses keyed "measure:<election id>/<measure id>".

export const MEASURE_PREFIX = "measure:";
const STATE_NAME = { CA: "California", WA: "Washington", CO: "Colorado", AZ: "Arizona", FL: "Florida", MI: "Michigan", NC: "North Carolina" };
const MAX_MEASURE_CHARS = 150000;
const RETRY_AFTER_DAYS = 2;

/** A queued measure as the pipeline's subject: what the prompt, the log and the review page need. */
export function measureSubject(q) {
  return {
    id: `${MEASURE_PREFIX}${q.measure_key}`,
    kind: "measure",
    bill_number: q.label,
    title: q.title,
    state: q.state,
    state_name: STATE_NAME[q.state] || q.state,
    level: "state",
    election_date: String(q.election_id).slice(0, 10),
    source_url: q.text_url,
  };
}

/** The text the draft is based on: the official text the drafting tool stored, cut to a length the model reads in full. */
export function measureSource(q) {
  if (!q || !q.text) return null;
  const long = q.text.length > MAX_MEASURE_CHARS;
  return {
    basis: long ? "partial_text" : "full_text",
    note: long ? `the first ${MAX_MEASURE_CHARS.toLocaleString("en-US")} characters` : null,
    text: long ? q.text.slice(0, MAX_MEASURE_CHARS) : q.text,
    source_url: q.text_url,
    version: "the official ballot title, summary and analysis, and the measure's text where the state publishes it",
  };
}

/** Queued measures whose day has come and that have no analysis yet, up to `limit`. `today`: 'YYYY-MM-DD'. */
export async function nextMeasures(db, limit, today) {
  if (limit <= 0) return [];
  const { results } = await db
    .prepare(
      `SELECT q.* FROM measure_analysis_queue q
       WHERE q.status = 'queued' AND q.not_before <= ? AND q.text IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM bill_analyses a WHERE a.bill_id = '${MEASURE_PREFIX}' || q.measure_key)
         AND NOT EXISTS (SELECT 1 FROM analysis_attempts t WHERE t.bill_id = '${MEASURE_PREFIX}' || q.measure_key AND t.last_attempt > datetime('now', '-${RETRY_AFTER_DAYS} days'))
       ORDER BY q.election_id, q.measure_key LIMIT ?`
    )
    .bind(today, limit)
    .all();
  return results.map((q) => ({ ...measureSubject(q), depth: "full", queued: q }));
}

/** Records how the measure's draft went. */
export async function finishMeasure(db, key, ok, error = null) {
  await db
    .prepare("UPDATE measure_analysis_queue SET status = ?, tries = tries + 1, last_error = ? WHERE measure_key = ?")
    .bind(ok ? "drafted" : "queued", error, key.replace(MEASURE_PREFIX, ""))
    .run();
}
