-- A scanned net worth report's reading, stored a page at a time (one big JSON
-- column ran past D1's 100 KB statement limit on the President's report):
-- the lines both readings agreed on, by page, and each line still read
-- differently (a and b are each reading's line as JSON, or NULL when that
-- reading has no such line). tools/networth_scan.py writes them;
-- /admin/review/networth/ reads them (functions/_lib/networth-review.js).
CREATE TABLE IF NOT EXISTS networth_scan_pages (
  report_id TEXT NOT NULL,
  page      INTEGER NOT NULL,
  lines     TEXT NOT NULL,                    -- JSON [{sec, grp, n, v, inc, elsewhere, nra, cred, idx}]
  PRIMARY KEY (report_id, page)
);
CREATE TABLE IF NOT EXISTS networth_scan_open (
  report_id TEXT NOT NULL,
  key       TEXT NOT NULL,                    -- "p<page>.<index>", as compare_readings() names it
  page      INTEGER NOT NULL,
  idx       INTEGER NOT NULL,
  a         TEXT,
  b         TEXT,
  PRIMARY KEY (report_id, key)
);
