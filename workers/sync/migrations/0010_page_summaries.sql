-- Page summaries: what the Laws page, the hub's Happening now, the state map
-- pages and the Reps lists show, computed once per sync (src/summaries.js)
-- instead of from the full votes and vote_positions tables on every visit.
-- Rebuilt whenever the votes, bills, outcomes or relevance checks change.

-- One row per bill with at least one recorded vote.
CREATE TABLE IF NOT EXISTS bill_list (
  bill_id       TEXT PRIMARY KEY,
  level         TEXT NOT NULL,
  chamber       TEXT NOT NULL,
  bill_number   TEXT NOT NULL,
  title         TEXT NOT NULL,
  session       TEXT NOT NULL,
  last_vote     TEXT NOT NULL,             -- date of the latest recorded vote of any kind
  vote_count    INTEGER NOT NULL,          -- recorded votes of any kind
  last_final    TEXT,                      -- date of the latest final-passage vote (NULL: none)
  final_count   INTEGER NOT NULL DEFAULT 0,
  final_vote_id TEXT,                      -- that vote, for its question, result and totals
  final_result  TEXT,
  final_chamber TEXT,
  yea           INTEGER,
  nay           INTEGER,
  present       INTEGER,
  not_voting    INTEGER,
  outcome       TEXT,                      -- bill_outcomes.outcome, when recorded
  outcome_date  TEXT,
  routine       INTEGER NOT NULL DEFAULT 0, -- 1: the relevance check set it aside as ceremonial or routine
  built_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bill_list_final ON bill_list (level, last_final);
CREATE INDEX IF NOT EXISTS bill_list_any ON bill_list (level, last_vote);
CREATE INDEX IF NOT EXISTS bill_list_notable ON bill_list (level, routine, last_final);

-- Each official's recorded votes, counted.
CREATE TABLE IF NOT EXISTS official_stats (
  official_id TEXT PRIMARY KEY,
  vote_count  INTEGER NOT NULL,
  final_count INTEGER NOT NULL,
  built_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The latest votes on one bill (bill pages, and the summaries above).
CREATE INDEX IF NOT EXISTS votes_bill_type_date ON votes (bill_id, vote_type, vote_date);
