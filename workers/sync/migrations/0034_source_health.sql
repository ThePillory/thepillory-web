-- Data source health (workers/sync/src/health/): each source's state once a
-- day, for /admin/health/ (30 days of history), the public /about/data-status/
-- page and the alert email; and each stored source link's state: whether it
-- still answers, its Internet Archive copy, and ThePillory's own saved copy
-- (Cloudflare R2). See docs/data-sync.md, "Source health".

CREATE TABLE IF NOT EXISTS source_health (
  day        TEXT NOT NULL,                  -- YYYY-MM-DD (UTC)
  source     TEXT NOT NULL,                  -- id in src/health/sources.js
  status     TEXT NOT NULL CHECK (status IN ('green', 'yellow', 'red', 'unknown')),
  last_ok    TEXT,                           -- last successful pull (a sync step's run, or a workflow's)
  latest     TEXT,                           -- the newest record's own date, where the source has one
  rows       INTEGER,                        -- rows stored from the source
  rows_added INTEGER,                        -- since the day before
  problems   TEXT,                           -- JSON: [{level, check, text}]
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (day, source)
);
CREATE INDEX IF NOT EXISTS source_health_source ON source_health (source, day);

-- One row per source link the site shows, once checked, archived or copied.
CREATE TABLE IF NOT EXISTS source_links (
  url           TEXT PRIMARY KEY,
  source        TEXT,                        -- the source it came from
  status        INTEGER,                     -- the last check's HTTP status (0: no answer)
  dead_checks   INTEGER NOT NULL DEFAULT 0,  -- checks in a row that found it gone (404, 410, no such host)
  first_dead    TEXT,                        -- when it was first found gone, in the current run of failures
  checked_at    TEXT,
  archive_url   TEXT,                        -- an Internet Archive (Wayback Machine) copy
  archived_at   TEXT,
  archive_tries INTEGER NOT NULL DEFAULT 0,
  copy_key      TEXT,                        -- ThePillory's own copy, in the R2 bucket (SOURCES)
  copy_type     TEXT,
  copy_bytes    INTEGER,
  copied_at     TEXT,
  copy_tries    INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS source_links_dead ON source_links (dead_checks);

-- At most one alert email a day.
CREATE TABLE IF NOT EXISTS health_alerts (
  day     TEXT PRIMARY KEY,
  sent_at TEXT NOT NULL DEFAULT (datetime('now')),
  summary TEXT
);
