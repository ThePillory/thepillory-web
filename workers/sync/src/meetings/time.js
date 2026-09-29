// Meeting times are stored as local Pacific time ("YYYY-MM-DDTHH:MM"), the way
// the county and the Legislature publish them. Also used by the Pages Functions.

const ZONE = "America/Los_Angeles";

/** Current Pacific local time as "YYYY-MM-DDTHH:MM". */
export function pacificNow(date = new Date()) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(date)
      .map((x) => [x.type, x.value])
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

/** An ISO instant (with offset) as Pacific local "YYYY-MM-DDTHH:MM". */
export function toPacific(iso) {
  const t = Date.parse(iso);
  return Number.isNaN(t) ? null : pacificNow(new Date(t));
}

/** "YYYY-MM-DD" plus n days. */
export function addDays(day, n) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
