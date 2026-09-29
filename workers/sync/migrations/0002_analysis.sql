-- AI-drafted constitutional analysis of bills.
-- The Pillory maps the Constitution; it does not rule on it. AI drafts, people review.

-- Text of the Constitution and all 27 amendments (public domain), loaded from
-- data/constitution.json by the sync Worker. The only source for quoted text.
-- Leaf rows (leaf = 1) are the quotable units; container rows join their parts.
CREATE TABLE IF NOT EXISTS constitution_provisions (
  id TEXT PRIMARY KEY,                 -- stable, e.g. art-1-sec-8-cl-3, amend-14-sec-1
  parent_id TEXT,
  kind TEXT NOT NULL CHECK (kind IN ('preamble', 'article', 'section', 'clause', 'amendment')),
  label TEXT NOT NULL,                 -- "Article I, Section 8, Clause 3"
  text TEXT NOT NULL,
  leaf INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL,
  source_url TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  version TEXT NOT NULL
);

-- One row per draft. Regenerating makes a new row and marks the old one
-- current = 0, so every version is kept. Edits and decisions are recorded in
-- bill_analysis_revisions with a snapshot of the row as it was before.
CREATE TABLE IF NOT EXISTS bill_analyses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  current INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'ai_draft' CHECK (status IN ('ai_draft', 'reviewed', 'rejected')),
  -- What the draft was based on.
  basis TEXT NOT NULL CHECK (basis IN ('full_text', 'partial_text', 'summary_only')),
  basis_note TEXT,                     -- e.g. "limited: based on summary only."
  text_version TEXT,                   -- which text version was read, as the source names it
  text_source_url TEXT NOT NULL CHECK (text_source_url LIKE 'http%'),
  -- The analysis. List fields are JSON arrays.
  plain_summary TEXT NOT NULL,
  clauses TEXT NOT NULL DEFAULT '[]',  -- [{id, quote, why}]
  aligns TEXT NOT NULL DEFAULT '[]',   -- [text]
  tension TEXT NOT NULL DEFAULT '[]',  -- [text]
  departure TEXT NOT NULL DEFAULT '[]',-- [text]: why a departure might still serve the public
  article_v TEXT NOT NULL DEFAULT '',  -- whether an Article V amendment would be needed
  readings TEXT NOT NULL DEFAULT '[]', -- [{question, original_meaning, precedent, evolving}]
  citations TEXT NOT NULL DEFAULT '[]',-- verified only: [{case_name, citation, url, point}]
  uncertainty TEXT NOT NULL DEFAULT '',
  -- How it was made and checked.
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  quote_check TEXT NOT NULL DEFAULT '{}',    -- JSON: checked count and every replacement made
  citation_check TEXT NOT NULL DEFAULT '{}', -- JSON: each citation's lookup result, removals
  input_tokens INTEGER,
  output_tokens INTEGER,
  cache_read_tokens INTEGER,
  cache_write_tokens INTEGER,
  -- Review.
  reviewer TEXT,                       -- name shown on the page
  reviewer_email TEXT,                 -- from Cloudflare Access; never shown
  reviewed_at TEXT,
  edited_by TEXT,
  edited_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  CHECK (status != 'reviewed' OR (reviewer IS NOT NULL AND reviewed_at IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS bill_analyses_bill ON bill_analyses (bill_id, current);
CREATE INDEX IF NOT EXISTS bill_analyses_created ON bill_analyses (created_at);

CREATE TABLE IF NOT EXISTS bill_analysis_revisions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES bill_analyses(id),
  bill_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('created', 'edited', 'approved', 'rejected', 'reopened', 'superseded')),
  actor TEXT NOT NULL,                 -- "pipeline" or the reviewer's email
  note TEXT,
  snapshot TEXT NOT NULL,              -- JSON of the row before the action (after, for 'created')
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS bill_analysis_revisions_analysis ON bill_analysis_revisions (analysis_id);

-- Regeneration requests from /admin/review. The pipeline handles these first.
CREATE TABLE IF NOT EXISTS analysis_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  bill_id TEXT NOT NULL REFERENCES bills(id),
  requested_by TEXT NOT NULL,
  requested_at TEXT NOT NULL DEFAULT (datetime('now')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  handled_at TEXT,
  message TEXT
);

-- Bills the pipeline tried and couldn't draft (no text or summary, a refusal,
-- an error), so it waits a while before trying the same bill again.
CREATE TABLE IF NOT EXISTS analysis_attempts (
  bill_id TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_attempt TEXT NOT NULL,
  last_error TEXT
);
