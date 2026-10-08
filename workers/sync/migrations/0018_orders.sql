-- Executive orders get the same treatment as bills: their text, the authority
-- each claims (quoted word for word), court records that mention them, and the
-- same AI-drafted constitutional analysis, checked the same way. See docs/executive.md.

-- The Federal Register's notes on an order ("Revoked by: EO 14148, January 20, 2025").
ALTER TABLE executive_actions ADD COLUMN notes TEXT;

-- Each order's text, read once from its source: the Federal Register's text, or
-- the Governor's signed PDF. status 'no_text' means the source had no readable
-- text (a scanned image); 'error' is tried again after a few days.
CREATE TABLE IF NOT EXISTS executive_action_texts (
  action_id  TEXT PRIMARY KEY REFERENCES executive_actions(id),
  status     TEXT NOT NULL CHECK (status IN ('ok', 'no_text', 'error')),
  text       TEXT,                         -- the order's text, paragraphs kept
  authority  TEXT,                         -- the authority it claims, word for word from the text
  text_url   TEXT CHECK (text_url IS NULL OR text_url LIKE 'http%'),
  note       TEXT,
  fetched_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Court records on CourtListener that mention an order: opinions, and dockets
-- with filings that mention it (the matching filings as docketed).
CREATE TABLE IF NOT EXISTS executive_action_cases (
  action_id     TEXT NOT NULL REFERENCES executive_actions(id),
  kind          TEXT NOT NULL CHECK (kind IN ('opinion', 'docket')),
  cl_id         TEXT NOT NULL,             -- CourtListener's cluster or docket id
  case_name     TEXT NOT NULL,
  court         TEXT,
  date_filed    TEXT,
  docket_number TEXT,
  url           TEXT NOT NULL CHECK (url LIKE 'https://www.courtlistener.com/%'),
  entries       TEXT NOT NULL DEFAULT '[]', -- dockets: [{description, date, url}] of the matching filings
  PRIMARY KEY (action_id, kind, cl_id)
);

CREATE TABLE IF NOT EXISTS executive_action_court_checks (
  action_id  TEXT PRIMARY KEY REFERENCES executive_actions(id),
  query      TEXT NOT NULL,
  opinions   INTEGER NOT NULL DEFAULT 0,  -- matches CourtListener reported
  dockets    INTEGER NOT NULL DEFAULT 0,
  checked_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- The analysis tables hold executive orders too: bill_id is the subject's id,
-- a bill ('us-119-hr-1') or an executive action ('fr:2025-02007', 'ca-gov:123').
-- SQLite can't drop a foreign key in place, so both tables are rebuilt under the
-- same names (as 0008 did for officials): copied aside, emptied, dropped,
-- created again and filled. Re-inserting the same ids settles the deferred
-- foreign-key checks from analysis_flags and bill_analysis_revisions.
-- New: "Supporters argue" and "Critics argue", one attributed line each.
PRAGMA defer_foreign_keys = on;

CREATE TABLE bill_analyses_copy AS SELECT * FROM bill_analyses;
DELETE FROM bill_analyses;
DROP TABLE bill_analyses;
CREATE TABLE bill_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id TEXT NOT NULL,
  current INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ai_draft' CHECK (status IN ('ai_draft', 'reviewed', 'rejected')),
  basis TEXT NOT NULL CHECK (basis IN ('full_text', 'partial_text', 'summary_only')),
  basis_note TEXT,
  text_version TEXT,
  text_source_url TEXT NOT NULL CHECK (text_source_url LIKE 'http%'),
  plain_summary TEXT NOT NULL,
  clauses TEXT NOT NULL DEFAULT '[]',
  aligns TEXT NOT NULL DEFAULT '[]',
  tension TEXT NOT NULL DEFAULT '[]',
  departure TEXT NOT NULL DEFAULT '[]',
  article_v TEXT NOT NULL DEFAULT '',
  readings TEXT NOT NULL DEFAULT '[]',
  citations TEXT NOT NULL DEFAULT '[]',
  uncertainty TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  quote_check TEXT NOT NULL DEFAULT '{}',
  citation_check TEXT NOT NULL DEFAULT '{}',
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  reviewer TEXT,
  reviewer_email TEXT,
  reviewed_at TEXT,
  edited_by TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  depth TEXT NOT NULL DEFAULT 'full' CHECK (depth IN ('card', 'full')),
  ai_review TEXT CHECK (ai_review IN ('pass', 'flag')),
  ai_review_detail TEXT NOT NULL DEFAULT '{}',
  ai_review_model TEXT,
  ai_review_tokens TEXT,
  ai_reviewed_at TEXT,
  spot_check INTEGER NOT NULL DEFAULT 0,
  human_agrees INTEGER,
  supporters TEXT NOT NULL DEFAULT '',
  critics TEXT NOT NULL DEFAULT '',
  CHECK (status != 'reviewed' OR (reviewer IS NOT NULL AND reviewed_at IS NOT NULL))
);
INSERT INTO bill_analyses (id, bill_id, current, status, basis, basis_note, text_version, text_source_url, plain_summary, clauses,
  aligns, tension, departure, article_v, readings, citations, uncertainty, model, prompt_version, quote_check, citation_check,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reviewer, reviewer_email, reviewed_at, edited_by, edited_at,
  created_at, depth, ai_review, ai_review_detail, ai_review_model, ai_review_tokens, ai_reviewed_at, spot_check, human_agrees)
SELECT id, bill_id, current, status, basis, basis_note, text_version, text_source_url, plain_summary, clauses,
  aligns, tension, departure, article_v, readings, citations, uncertainty, model, prompt_version, quote_check, citation_check,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, reviewer, reviewer_email, reviewed_at, edited_by, edited_at,
  created_at, depth, ai_review, ai_review_detail, ai_review_model, ai_review_tokens, ai_reviewed_at, spot_check, human_agrees
FROM bill_analyses_copy;
DROP TABLE bill_analyses_copy;
CREATE INDEX IF NOT EXISTS bill_analyses_bill ON bill_analyses (bill_id, current);
CREATE INDEX IF NOT EXISTS bill_analyses_created ON bill_analyses (created_at);

CREATE TABLE analysis_requests_copy AS SELECT * FROM analysis_requests;
DELETE FROM analysis_requests;
DROP TABLE analysis_requests;
CREATE TABLE analysis_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id TEXT NOT NULL,
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  handled_at TEXT,
  message TEXT,
  depth TEXT CHECK (depth IN ('card', 'full')),
  source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'reader'))
);
INSERT INTO analysis_requests (id, bill_id, requested_by, requested_at, status, handled_at, message, depth, source)
SELECT id, bill_id, requested_by, requested_at, status, handled_at, message, depth, source FROM analysis_requests_copy;
DROP TABLE analysis_requests_copy;

-- The Laws list across both levels, newest first (functions/_lib/laws-list.js).
CREATE INDEX IF NOT EXISTS bill_list_final_all ON bill_list (last_final);
CREATE INDEX IF NOT EXISTS bill_list_vote_all ON bill_list (last_vote);
