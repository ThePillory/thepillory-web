-- The "Constitution" section of each ballot measure's page (docs/elections.md,
-- "The Constitution section"): what the measure changes (state constitution,
-- statute, or both, quoted from the official text), the constitutional
-- provisions it amends, adds to or directly involves (each quoted word for word
-- from data/constitution.json or data/ca-constitution.json, or linked to the
-- state's official text), and court records that mention it. Drafted by
-- tools/measure_constitution.py ("Draft measure Constitution sections"
-- workflow), checked in code, and held until a person approves each measure on
-- /admin/review/measures/. The pages show the sections only once every measure
-- of the election is approved, all at once.
CREATE TABLE IF NOT EXISTS measure_constitution (
  measure_key TEXT PRIMARY KEY,               -- '<election id>/<measure id>', e.g. '2026-11-03-co/amendment-87'
  election_id TEXT NOT NULL,
  measure_id TEXT NOT NULL,
  state TEXT NOT NULL,
  label TEXT NOT NULL,                        -- 'Proposition 2', 'Amendment 87'
  changes TEXT NOT NULL CHECK (changes IN ('constitution', 'statute', 'both', 'convention', 'unclear')),
  changes_quote TEXT NOT NULL DEFAULT '',     -- word for word from the official text
  changes_source TEXT NOT NULL DEFAULT '',    -- which official document, as named on the page
  changes_source_url TEXT NOT NULL CHECK (changes_source_url LIKE 'http%'),
  provisions TEXT NOT NULL DEFAULT '[]',      -- JSON: [{doc: 'us'|'ca'|'state', id, label, quote, url, relation, line}]
  cases TEXT NOT NULL DEFAULT '[]',           -- JSON: [{name, court, filed, url, docket}]
  cases_new TEXT NOT NULL DEFAULT '[]',       -- court records found after review, shown only once a person approves them
  cases_checked_at TEXT,                      -- when court records were last searched
  notes TEXT NOT NULL DEFAULT '[]',           -- JSON: what the checks removed or flagged, for the reviewer
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  reviewed_by TEXT,
  reviewed_at TEXT,
  review_note TEXT,
  model TEXT,
  prompt_version TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS measure_constitution_election ON measure_constitution (election_id, status);

-- Every version of every section, drafted or edited, kept.
CREATE TABLE IF NOT EXISTS measure_constitution_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  measure_key TEXT NOT NULL,
  version INTEGER NOT NULL,
  snapshot TEXT NOT NULL,                     -- JSON of the row as it was
  action TEXT NOT NULL,                       -- 'drafted', 'approved', 'rejected', 'edited', 'cases'
  by_whom TEXT,
  at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS measure_constitution_history_key ON measure_constitution_history (measure_key, version);

-- After the election: the full three-panel analysis (Where it aligns / Where it
-- may be in tension / Why this might still serve the public) of every measure,
-- passed or not, through the usual analysis pipeline and checks. Rows wait until
-- not_before; the sync's analysis round drafts them (workers/sync/src/analysis/measures.js).
CREATE TABLE IF NOT EXISTS measure_analysis_queue (
  measure_key TEXT PRIMARY KEY,
  election_id TEXT NOT NULL,
  measure_id TEXT NOT NULL,
  state TEXT NOT NULL,
  label TEXT NOT NULL,
  title TEXT NOT NULL,
  text_url TEXT NOT NULL CHECK (text_url LIKE 'http%'),
  text TEXT,                                  -- the official text the analysis is drafted from (stored by the drafting tool: PDFs are read there)
  not_before TEXT NOT NULL,                   -- '2026-11-04'
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'drafted', 'failed')),
  tries INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
