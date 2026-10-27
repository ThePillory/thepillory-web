-- The resolution step (src/analysis/resolve.js; docs/analysis.md, "When the
-- reviewer flags a draft"): one row each time a flagged draft, or a published
-- analysis a reader reported, went through it. What it did (fixed, trimmed,
-- summary only, withheld, or no change), the new analysis it published, what
-- was cut, the public note shown under the analysis, the model and the cost.
CREATE TABLE IF NOT EXISTS analysis_resolutions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  analysis_id     INTEGER NOT NULL,             -- the draft or published analysis it started from
  bill_id         TEXT NOT NULL,                -- the bill, order ('fr:…', 'ca-eo:…') or measure ('measure:…')
  trigger         TEXT NOT NULL CHECK (trigger IN ('flag', 'reader')),
  outcome         TEXT NOT NULL CHECK (outcome IN ('fixed', 'trimmed', 'summary_only', 'withheld', 'no_change')),
  new_analysis_id INTEGER,                      -- the version it published, if any
  removed         TEXT,                         -- JSON [{field, index, text}]: what was cut
  public_note     TEXT,                         -- shown under the analysis in "Changes to this analysis"
  steps           TEXT,                         -- JSON: what it did, in order
  model           TEXT,
  cost_cents      INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS analysis_resolutions_analysis ON analysis_resolutions (analysis_id);
CREATE INDEX IF NOT EXISTS analysis_resolutions_bill ON analysis_resolutions (bill_id, created_at);
