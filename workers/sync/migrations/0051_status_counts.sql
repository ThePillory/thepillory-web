-- /status reads these counts instead of counting the big tables on every visit
-- (COUNT(*) on votes and vote_positions while a run is going overloaded D1).
-- The sync records them once per round (src/status.js, recordStatusCounts()).
CREATE TABLE IF NOT EXISTS status_counts (
  name   TEXT PRIMARY KEY,
  value  INTEGER NOT NULL,
  as_of  TEXT NOT NULL
);

-- /status's analysis counts and flagged drafts read the current drafts by this index.
CREATE INDEX IF NOT EXISTS bill_analyses_current_review ON bill_analyses (current, status, ai_review);
