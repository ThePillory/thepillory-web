// How to comment, from the text of an agenda PDF. Only sentences that appear in
// the agenda word for word are kept (line breaks joined); nothing is inferred.
// Also used by the Pages Functions to show a short deadline label.

/** PDF text with line breaks joined, and web addresses the PDF wrapped put back together. */
export function flatten(text) {
  return String(text || "")
    .replace(/-\n(?=[a-z])/g, "-")
    .replace(/\s*\n\s*/g, " ")
    .replace(/(https?:\/\/[^\s]*[./_-])\s+(?=[\w@/.-]*[/.])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Split into sentences, keeping web and e-mail addresses whole. */
export function sentences(flat) {
  const out = [];
  let start = 0;
  // A sentence ends at . ! or ?, or after a web address that runs straight into
  // a new sentence (agendas often leave the period off after a link).
  const re = /(?:[.!?]["”)]?|https?:\/\/\S+)\s+(?=["“(]?[A-Z][a-z]|[0-9])/g;
  let m;
  while ((m = re.exec(flat))) {
    out.push(flat.slice(start, m.index + m[0].trimEnd().length).trim());
    start = m.index + m[0].length;
  }
  if (start < flat.length) out.push(flat.slice(start).trim());
  return out.filter(Boolean);
}

const ABOUT_COMMENT = /public comment|\bcomments?\b|e-?mail|zoom|written/i;
const DEADLINE = /no later than|deadline|received by|prior to the (?:start|meeting)|(?:before|by) \d{1,2}:\d{2}/i;

/**
 * From the first pages of an agenda: {comment_text, comment_deadline_text, online_url}.
 * comment_text is up to 6 consecutive-order sentences about commenting; each one
 * is a verbatim sentence of the agenda.
 */
export function commentInfo(pages) {
  const flat = flatten((pages || []).slice(0, 2).join("\n"));
  const all = sentences(flat);
  const about = all.filter((s) => ABOUT_COMMENT.test(s) && s.length < 600).slice(0, 6);
  const deadline = about.find((s) => DEADLINE.test(s)) || all.find((s) => DEADLINE.test(s) && ABOUT_COMMENT.test(s)) || null;
  const zoom = /https:\/\/[\w.-]*zoom\.us\/[^\s"<>)]+/i.exec(flat);
  return {
    comment_text: about.length ? about.join(" ") : null,
    comment_deadline_text: deadline,
    online_url: zoom ? zoom[0].replace(/[.,;]+$/, "") : null,
  };
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * A short label for a written-comment deadline, worked out only from wording the
 * agenda actually uses ("no later than 4:00 pm on the day before the … meeting").
 * Returns {label, date: "YYYY-MM-DD"} or null when the sentence doesn't say it plainly.
 */
export function deadlineLabel(sentence, startsAt) {
  const s = String(sentence || "");
  const m = /no later than (\d{1,2}(?::\d{2})?\s*[ap]\.?\s?m\.?)(?:,)? on the day (before|prior to)/i.exec(s);
  if (!m || !/^\d{4}-\d{2}-\d{2}/.test(startsAt || "")) return null;
  const d = new Date(`${startsAt.slice(0, 10)}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  const time = m[1].replace(/\s+/g, " ").replace(/\.$/, "").toLowerCase();
  return {
    date: d.toISOString().slice(0, 10),
    label: `${WEEKDAYS[d.getUTCDay()]}, ${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${time}`,
  };
}
