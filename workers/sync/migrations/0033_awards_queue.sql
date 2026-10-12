-- Federal awards are looked up from USAspending.gov in GitHub Actions
-- (tools/load_gov_money.py awards; Cloudflare's servers can't reach it) and
-- stored in federal_awards_cache (migration 0031). /awards/ reads only that
-- cache; an organization someone opened before it was looked up waits here and
-- is looked up first on the next run.
CREATE TABLE IF NOT EXISTS federal_awards_wanted (
  name_key TEXT PRIMARY KEY,
  name     TEXT NOT NULL,
  asked_at TEXT NOT NULL DEFAULT (datetime('now'))
);
