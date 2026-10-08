-- Issues pages found automatically (src/promises/finder.js, the issues-pages
-- step). Pages a person listed stay as they were; found pages are marked.
ALTER TABLE promise_pages ADD COLUMN found_by TEXT NOT NULL DEFAULT 'person' CHECK (found_by IN ('person', 'auto'));

-- One row per official and website: when it was last searched and what came of it.
-- result: found (page_url is listed), none (no issues page found on the site),
-- no_website (no site on file), error (the site couldn't be read; tried again later).
CREATE TABLE IF NOT EXISTS issues_page_checks (
  official_id TEXT NOT NULL,
  site_kind   TEXT NOT NULL CHECK (site_kind IN ('office_site', 'campaign_site')),
  site_url    TEXT,
  result      TEXT NOT NULL CHECK (result IN ('found', 'none', 'no_website', 'error')),
  page_url    TEXT,
  note        TEXT,
  checked_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (official_id, site_kind)
);

-- Pages a person removed on the review page: never added again automatically.
CREATE TABLE IF NOT EXISTS promise_pages_removed (
  url         TEXT PRIMARY KEY,
  official_id TEXT,
  removed_by  TEXT,
  removed_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
