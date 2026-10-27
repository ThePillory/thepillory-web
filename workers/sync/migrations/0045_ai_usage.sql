-- What every AI call costs, by day, sync step and model (src/ai-usage.js): calls,
-- tokens and dollars at the list price, written as each call returns. The
-- accuracy audit's section 6 reads it as "AI cost per day, by step".
CREATE TABLE IF NOT EXISTS ai_usage (
  day                TEXT NOT NULL,             -- UTC date, YYYY-MM-DD
  step               TEXT NOT NULL,             -- the sync step that made the call ('analysis', 'plain-summaries', …)
  model              TEXT NOT NULL,
  calls              INTEGER NOT NULL DEFAULT 0,
  input_tokens       INTEGER NOT NULL DEFAULT 0,
  output_tokens      INTEGER NOT NULL DEFAULT 0,
  cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
  cache_write_tokens INTEGER NOT NULL DEFAULT 0,
  cost_usd           REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (day, step, model)
);
