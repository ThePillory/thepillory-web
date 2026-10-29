-- What drives Cloudflare usage (src/usage/, docs/data-sync.md "What Cloudflare costs").
-- Counts only: no IP addresses, no URLs with query strings, nothing about a visitor.

-- D1 rows each kind of page reads, per day: the route pattern ("/reps/:id/"), never the URL.
-- visitor: 'verified-bot' (Cloudflare's verified bot signal), 'likely-bot' (bot score or a
-- crawler's user agent), 'person' (everything else). Gathered per isolate and written in batches.
CREATE TABLE IF NOT EXISTS usage_routes (
  day          TEXT NOT NULL,
  route        TEXT NOT NULL,
  visitor      TEXT NOT NULL,
  requests     INTEGER NOT NULL DEFAULT 0,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, route, visitor)
);

-- The most expensive queries: the SQL text only (literals replaced with ?), never the values bound.
-- source: 'pages' for the site's Functions, or the sync step's name.
CREATE TABLE IF NOT EXISTS usage_queries (
  day          TEXT NOT NULL,
  source       TEXT NOT NULL,
  sql_key      TEXT NOT NULL,
  sql          TEXT NOT NULL,
  calls        INTEGER NOT NULL DEFAULT 0,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, source, sql_key)
);

-- D1 rows each sync step read and wrote, per day.
CREATE TABLE IF NOT EXISTS usage_steps (
  day          TEXT NOT NULL,
  step         TEXT NOT NULL,
  rounds       INTEGER NOT NULL DEFAULT 0,
  rows_read    INTEGER NOT NULL DEFAULT 0,
  rows_written INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step)
);

-- The account's usage per day from Cloudflare's GraphQL Analytics API, and its estimated cost
-- at Workers Paid rates (src/usage/cloudflare.js). Written by the sync's usage-check step.
CREATE TABLE IF NOT EXISTS usage_daily (
  day             TEXT PRIMARY KEY,
  workers_requests INTEGER, workers_cpu_ms REAL, pages_requests INTEGER,
  d1_rows_read    INTEGER, d1_rows_written INTEGER, d1_storage_gb REAL,
  do_requests     INTEGER, do_gb_seconds REAL,
  r2_storage_gb   REAL, r2_class_a INTEGER, r2_class_b INTEGER,
  ai_neurons      INTEGER,
  cost_usd        REAL,             -- that day's usage at the marginal rates (dayCost())
  by_script       TEXT,             -- JSON: {script: {requests, cpuMs}}
  fetched_at      TEXT NOT NULL
);

-- /votes/ (every level): final-passage votes newest first, read in date order and stopped at the page.
CREATE INDEX IF NOT EXISTS votes_type_date_id ON votes (vote_type, vote_date, id);
