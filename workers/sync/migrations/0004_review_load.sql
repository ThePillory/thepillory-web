-- Review load: fewer bills analyzed, short cards by default, an AI reviewer
-- pass, reader flags and spot checks. See docs/analysis.md.

-- Which kind of analysis a row is: a short card (the default) or the full
-- format. Every earlier row is a full analysis.
ALTER TABLE bill_analyses ADD COLUMN depth TEXT NOT NULL DEFAULT 'full' CHECK (depth IN ('card', 'full'));

-- The AI reviewer's verdict on the draft after the quote and citation checks.
-- NULL until reviewed. A draft is public only when a person approved it
-- (status 'reviewed') or the AI reviewer passed it (status 'ai_draft', ai_review 'pass').
ALTER TABLE bill_analyses ADD COLUMN ai_review TEXT CHECK (ai_review IN ('pass', 'flag'));
ALTER TABLE bill_analyses ADD COLUMN ai_review_detail TEXT NOT NULL DEFAULT '{}'; -- JSON: {verdict, checks: [{id, ok, note}], reasons: [text]}
ALTER TABLE bill_analyses ADD COLUMN ai_review_model TEXT;
ALTER TABLE bill_analyses ADD COLUMN ai_review_tokens TEXT;    -- JSON: {input, output, cache_read}
ALTER TABLE bill_analyses ADD COLUMN ai_reviewed_at TEXT;

-- A random share of passed drafts goes to the review queue as a spot check.
ALTER TABLE bill_analyses ADD COLUMN spot_check INTEGER NOT NULL DEFAULT 0;

-- When a person decides on a draft the AI reviewer looked at: 1 if the person
-- agreed with it (passed and approved as it was, or flagged and then rejected
-- or edited), 0 if not. Feeds the agreement rate on the review page.
ALTER TABLE bill_analyses ADD COLUMN human_agrees INTEGER;

-- Requests: which kind of analysis to write, and who asked.
-- depth NULL means the same kind as the current analysis (a regeneration).
ALTER TABLE analysis_requests ADD COLUMN depth TEXT CHECK (depth IN ('card', 'full'));
ALTER TABLE analysis_requests ADD COLUMN source TEXT NOT NULL DEFAULT 'admin' CHECK (source IN ('admin', 'reader'));

-- The cheap relevance check (claude-haiku-4-5), one row per bill checked.
-- verdict 'skip' means ceremonial or routine (commemorations, awareness days,
-- namings, honorary resolutions). A person can un-skip a bill (override).
CREATE TABLE IF NOT EXISTS bill_relevance (
  bill_id TEXT PRIMARY KEY REFERENCES bills(id),
  verdict TEXT NOT NULL CHECK (verdict IN ('analyze', 'skip')),
  category TEXT NOT NULL,              -- e.g. 'commemoration', 'naming', 'substantive'
  reason TEXT NOT NULL,                -- one sentence from the check
  local TEXT NOT NULL CHECK (local IN ('high', 'medium', 'low', 'none')),
  local_reason TEXT NOT NULL DEFAULT '',
  model TEXT NOT NULL,
  prompt_version TEXT NOT NULL,
  checked_at TEXT NOT NULL DEFAULT (datetime('now')),
  override TEXT CHECK (override IN ('unskip')),
  override_by TEXT,
  override_at TEXT
);

-- "Something wrong?" reports from readers. No account; the visitor is a
-- one-way hash that changes daily and is kept only for rate limits.
CREATE TABLE IF NOT EXISTS analysis_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id INTEGER NOT NULL REFERENCES bill_analyses(id),
  bill_id TEXT NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('inaccurate', 'unfair', 'missing', 'other')),
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'resolved')),
  resolution TEXT,                     -- 'approved', 'rejected', 'superseded', 'dismissed'
  resolved_by TEXT,
  resolved_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS analysis_flags_open ON analysis_flags (analysis_id, status);

-- Per-visitor rate limits for public actions (reader flags, full-analysis requests).
CREATE TABLE IF NOT EXISTS public_actions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('flag', 'full_request')),
  visitor TEXT NOT NULL,               -- daily-rotating hash, never the address itself
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS public_actions_visitor ON public_actions (kind, visitor, created_at)
