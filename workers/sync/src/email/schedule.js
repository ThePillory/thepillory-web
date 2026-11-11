// When the weekly email goes out, and the week it covers (docs/email.md). Pure; tested
// across daylight saving in workers/sync/test/email.test.mjs.
//
// It's sent Sunday at 5:00 p.m. Pacific, all year. Cron schedules are in UTC, so two run:
// Monday 00:00 UTC (5 p.m. Pacific daylight time) and Monday 01:00 UTC (5 p.m. Pacific
// standard time). Each checks the Pacific clock and only the one that lands on 5 p.m. sends.
// An edition covers the 7 days ending Saturday night Pacific: Sunday through Saturday.

export const TZ = "America/Los_Angeles";
export const SEND_HOUR = 17;
export const CRONS = ["0 0 * * 1", "0 1 * * 1"];

const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** The Pacific date and time of an instant: {date: 'YYYY-MM-DD', weekday: 0 (Sunday)…6, hour, minute}. */
export function pacific(now = new Date()) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value])
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, weekday: WEEKDAYS[parts.weekday], hour: Number(parts.hour) % 24, minute: Number(parts.minute) };
}

/** Days added to an ISO date ('YYYY-MM-DD'), by the calendar (no time zone involved). */
export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Whether this instant is the send time: Sunday, 5 p.m. Pacific (the hour). */
export function isSendTime(now = new Date()) {
  const p = pacific(now);
  return p.weekday === 0 && p.hour === SEND_HOUR;
}

/**
 * The week an edition covers, for the Sunday it's sent ('YYYY-MM-DD', Pacific):
 * {week: that Sunday, start: the Sunday before, end: the Saturday before}.
 */
export function weekOf(sunday) {
  return { week: sunday, start: addDays(sunday, -7), end: addDays(sunday, -1) };
}

/**
 * The coming send: this Sunday if it's Sunday before 5 p.m. Pacific (or exactly at the
 * send hour), else the next Sunday. Used by the sender (at the send hour) and by previews.
 */
export function comingSunday(now = new Date()) {
  const p = pacific(now);
  if (p.weekday === 0 && p.hour <= SEND_HOUR) return p.date;
  return addDays(p.date, 7 - p.weekday);
}

/** A week's dates in words: "Nov 1–7, 2026", "Oct 25–Nov 1, 2026", "Dec 27, 2026–Jan 2, 2027". */
export function weekWords(start, end) {
  const f = (iso, opts) => new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", ...opts });
  const [ys, ms] = [start.slice(0, 4), start.slice(5, 7)];
  const [ye, me] = [end.slice(0, 4), end.slice(5, 7)];
  if (ys !== ye) return `${f(start, { month: "short", day: "numeric", year: "numeric" })}–${f(end, { month: "short", day: "numeric", year: "numeric" })}`;
  if (ms !== me) return `${f(start, { month: "short", day: "numeric" })}–${f(end, { month: "short", day: "numeric" })}, ${ye}`;
  return `${f(start, { month: "short", day: "numeric" })}–${Number(end.slice(8, 10))}, ${ye}`;
}

/** A date in words: "Nov 5". */
export function dayWords(iso) {
  return new Date(`${String(iso).slice(0, 10)}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" });
}
