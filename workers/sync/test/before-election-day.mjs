// The clock for tests written before November 3, 2026 that depend on the polls not having
// closed yet (election results, the ballot card's window, nominations): Date.now() and
// new Date() read October 28, 2026, 12:00 Pacific. Dates given explicitly are unchanged.
// Import it first in such a test file.
const FIXED = Date.parse("2026-10-28T19:00:00Z");
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args) {
    if (args.length) super(...args);
    else super(FIXED);
  }
  static now() {
    return FIXED;
  }
}
globalThis.Date = FixedDate;
export const realDate = RealDate;
