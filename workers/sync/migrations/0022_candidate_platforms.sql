-- Candidates' Platform tab (docs/candidates.md): the issues page found on each
-- candidate's campaign website (the website listed in their FEC filing, from
-- data/candidates/<year>/<st>.json) and a short excerpt from it, word for word,
-- picked and checked by the same rules as officials' "In their own words"
-- (src/promises/excerpt.js). One row per candidate, keyed by FEC candidate ID.
-- Candidates aren't in officials, so this table stands on its own; a page a
-- person removes goes into promise_pages_removed (official_id = the candidate
-- ID) and is never found again.
CREATE TABLE IF NOT EXISTS candidate_platforms (
  candidate_id TEXT PRIMARY KEY,          -- FEC candidate ID, e.g. 'S4TX00722'
  name         TEXT NOT NULL,             -- as filed, for the review page
  state        TEXT NOT NULL,
  year         INTEGER NOT NULL,
  site_url     TEXT,                      -- campaign website, as the FEC filing lists it
  result       TEXT,                      -- found | none | no_website | error | removed
  page_url     TEXT CHECK (page_url IS NULL OR page_url LIKE 'http%'),
  title        TEXT,                      -- the page's own heading or title
  note         TEXT,
  checked_at   TEXT,                      -- last search of the site
  page_text    TEXT,
  text_hash    TEXT,
  fetched_at   TEXT,                      -- last read of the page
  excerpt      TEXT,                      -- word for word from page_text
  excerpt_at   TEXT,
  excerpt_by   TEXT                       -- the model, 'none', 'hidden', or 'person:<email>'
);
CREATE INDEX IF NOT EXISTS candidate_platforms_checked ON candidate_platforms (checked_at);
