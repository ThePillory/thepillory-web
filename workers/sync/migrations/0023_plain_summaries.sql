-- Simple mode (docs/simple-mode.md): a plain-words rewrite of a summary the
-- site already shows (a bill's official summary or a person's, a checked
-- analysis's summary, an executive order's checked analysis, a ballot
-- measure's official summary). Written by the sync's plain-summaries step and
-- kept only when the checks pass: no new facts, neutral wording, short and
-- readable, supporters and critics equal. Shown labeled "Simplified by AI from
-- [source]". One row per item; it's written again when its source changes.
CREATE TABLE IF NOT EXISTS plain_summaries (
  kind         TEXT NOT NULL CHECK (kind IN ('bill', 'order', 'measure')),
  item_id      TEXT NOT NULL,           -- bill id, order id, or '<election id>:<measure id>'
  what         TEXT NOT NULL,           -- "What it does", one or two short sentences
  supporters   TEXT,                    -- only when the source has both sides
  critics      TEXT,
  source_label TEXT NOT NULL,           -- "the Congressional Research Service's summary", …
  source_hash  TEXT NOT NULL,           -- the source text it was written from
  grade        REAL,                    -- reading grade level of `what` (Flesch-Kincaid)
  model        TEXT NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, item_id)
);
-- Tried and refused (the checks didn't pass): tried again only when the source changes.
CREATE TABLE IF NOT EXISTS plain_attempts (
  kind        TEXT NOT NULL,
  item_id     TEXT NOT NULL,
  source_hash TEXT NOT NULL,
  problems    TEXT NOT NULL,
  tried_at    TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, item_id)
);
