# ThePillory — Public Records & Investigations Tab
## Data & Build Spec (v0.2 draft)

> For Claude Code: this spec defines the data model, pipeline, evidence rules, and UI for a new profile tab on ThePillory. The first dataset is the publicly released Jeffrey Epstein investigation records. Read the **Non-negotiable rules** section before writing any code. When a requirement here is ambiguous, ask rather than guess.

---

## 1. Purpose & principles

- **Accountability through facts.** Show what public records document about people who hold federal power, using one standard for everyone, regardless of party.
- **Context, not scores.** Counts and tiers describe *documented connections*, never guilt.
- **Every claim links to a primary document.** No sourced document → no published entry.
- **Fair to subjects.** Show their own public statements alongside the record, and offer a corrections path.
- **The tab is generic.** It's named "Public Records & Investigations." The Epstein records are dataset #1; the schema must support future datasets (ethics filings, court records, IG reports).

---

## 2. Non-negotiable rules

1. **Never publish or store victim/survivor identities.** Do not attempt to recover redacted text. Redacted spans stay redacted. If a document's unredacted text appears to name a victim, flag the document as `restricted` and exclude it from public display.
2. **No unreviewed AI output at Tier 2 or above.** AI may classify; a human must confirm before any Tier 2+ entry is published.
3. **No AI-written prose about a person is published.** Public text is limited to: the structured fields below, short document excerpts (government records), and the subject's own quoted statements with sources.
4. **No raw mention counts in the UI.** Only deduplicated unique-document counts.
5. **Same-name ambiguity blocks publication.** If entity resolution confidence is below threshold, the mention goes to review, never straight to a profile.
6. **Corrections are logged publicly** (what changed, when; not who requested it).

---

## 3. Scope

### Subjects (launch)
Default, editable in `data/records/subjects.json` (JSON, like the rest of the repo's hand-kept data; no YAML):
- Cabinet secretaries and cabinet-level officials
- Senior White House staff (Chief of Staff, NSA, Counsel, etc.)
- Congressional leadership, both chambers, both parties (Speaker, majority/minority leaders, whips)

Later phases: all members of Congress, then agency heads and federal judges.

Subjects are linked to existing ThePillory official profiles by `official_id` (`records_subjects.official_id` references `officials.id`).

**Phase 1 lists the qualifying roles only, with no names.** The people holding each role are filled in just before the pilot, from official sources (each with its source URL; never from memory) and linked to their profiles. Senior White House staff have no official profiles on ThePillory yet, so they wait until they do. Each role in the config carries `official_source`, the page that lists its holders, left empty until that page is checked.

### Datasets
- **Primary source of truth:** original DOJ / House Oversight releases.
- **Bootstrap (recommended):** import text and metadata from existing open-source projects (e.g., Epstein-research-data, Epstein Exposed pipeline) to skip OCR. Every imported record must map back to the original government document ID (e.g., `EFTA` Bates numbers) and file. Imported classifications are **not** trusted; re-run our own classification.

---

## 4. Architecture (Cloudflare)

| Component | Use |
|---|---|
| **R2** | Original PDFs/images, extracted text blobs |
| **D1** | Relational data (schema in §5) |
| **Workers** | Public API for profile tab, corrections form |
| **Queues** + Workers (or a local batch script) | Pipeline stages |
| **Claude Message Batches API** | Classification (50% batch discount) |
| **Access** (Cloudflare Zero Trust) | Protect the review dashboard |

Heavy one-time processing (OCR, dedupe across millions of pages) may run locally or on a VM and load results into D1/R2. Don't force it into Workers limits.

---

## 5. Data model (D1)

Migration `workers/sync/migrations/0042_records.sql`. Every table is prefixed `records_` so it can't collide with the site's own tables (the site already has `corrections` for its "Report an error" form). Every dataset, document and statement must carry an http(s) link to its government-hosted or published source (the site-wide rule: no sourced document, no record). Beyond the columns, the schema enforces the fixed value lists below, tiers 1–5, excerpts of at most 300 characters, match confidence between 0 and 1, subjects that link to a real official, and that an approved entry at Tier 2 or above has a reviewer recorded.

```sql
-- Public Records & Investigations (docs/records-tab-spec.md, §5). Phase 1: the
-- tables only; nothing writes to them yet and no page reads them. Every table
-- is prefixed records_ so it can't collide with the site's own (corrections,
-- statements). Every dataset, document and statement carries an http(s) link
-- to its government-hosted or published source, as everywhere on the site.
-- The non-negotiable rules (spec §2) are enforced in code and review, not
-- only here: victim identities are never stored, redactions stay redacted,
-- and nothing at Tier 2 or above is published without a person's review.

-- One row per investigation or collection ('epstein-doj')
CREATE TABLE IF NOT EXISTS records_datasets (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%'),
  description TEXT
);

-- People tracked, each linked to their official profile
CREATE TABLE IF NOT EXISTS records_subjects (
  id           TEXT PRIMARY KEY,
  official_id  TEXT NOT NULL REFERENCES officials(id),
  display_name TEXT NOT NULL,
  in_scope     INTEGER NOT NULL DEFAULT 1 CHECK (in_scope IN (0, 1))
);

-- Names and variants used for matching ("Gates, William", initials, an email)
CREATE TABLE IF NOT EXISTS records_subject_aliases (
  subject_id TEXT NOT NULL REFERENCES records_subjects(id),
  alias      TEXT NOT NULL,
  alias_type TEXT CHECK (alias_type IS NULL OR alias_type IN ('full', 'surname', 'initials', 'email', 'nickname')),
  ambiguity  TEXT NOT NULL DEFAULT 'low' CHECK (ambiguity IN ('low', 'high')),  -- high: always reviewed
  PRIMARY KEY (subject_id, alias)
);

-- One row per unique document (after dedupe; duplicates point at their canonical copy)
CREATE TABLE IF NOT EXISTS records_documents (
  id               TEXT PRIMARY KEY,
  dataset_id       TEXT NOT NULL REFERENCES records_datasets(id),
  bates_id         TEXT,                      -- e.g. EFTA02365899
  r2_key           TEXT NOT NULL,             -- the original file
  text_r2_key      TEXT,
  source_type      TEXT NOT NULL CHECK (source_type IN ('court_filing', 'deposition', 'law_enforcement_report', 'flight_log',
                     'contact_book', 'calendar', 'email_by_subject', 'email_to_subject', 'email_about_subject',
                     'financial_record', 'news_clipping', 'photo_or_media', 'other')),
  doc_date         TEXT,                      -- ISO date
  date_confidence  TEXT CHECK (date_confidence IS NULL OR date_confidence IN ('exact', 'inferred', 'unknown')),
  canonical_doc_id TEXT REFERENCES records_documents(id),
  restricted       INTEGER NOT NULL DEFAULT 0 CHECK (restricted IN (0, 1)),  -- 1: never shown publicly
  original_url     TEXT NOT NULL CHECK (original_url LIKE 'http%')           -- the government-hosted copy
);
CREATE INDEX IF NOT EXISTS records_documents_dataset ON records_documents (dataset_id, restricted);

-- A subject appearing in a document
CREATE TABLE IF NOT EXISTS records_mentions (
  id               TEXT PRIMARY KEY,
  document_id      TEXT NOT NULL REFERENCES records_documents(id),
  subject_id       TEXT NOT NULL REFERENCES records_subjects(id),
  role             TEXT NOT NULL CHECK (role IN ('author', 'recipient', 'cc', 'subject_of', 'listed', 'passenger', 'party')),
  excerpt          TEXT CHECK (excerpt IS NULL OR length(excerpt) <= 300),   -- redactions preserved
  page             INTEGER,
  match_confidence REAL NOT NULL CHECK (match_confidence BETWEEN 0 AND 1),
  ai_tier          INTEGER CHECK (ai_tier IS NULL OR ai_tier BETWEEN 1 AND 5),  -- the model's suggestion
  ai_rationale     TEXT,                                                       -- internal only, never public
  tier             INTEGER CHECK (tier IS NULL OR tier BETWEEN 1 AND 5),       -- confirmed; null until reviewed if 2+
  review_status    TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'approved', 'rejected', 'needs_info')),
  reviewed_by      TEXT,
  reviewed_at      TEXT,
  -- Tier 2 and above is published only after a person's review (spec §2.2)
  CHECK (NOT (review_status = 'approved' AND tier >= 2 AND reviewed_by IS NULL))
);
CREATE INDEX IF NOT EXISTS records_mentions_subject ON records_mentions (subject_id, review_status);
CREATE INDEX IF NOT EXISTS records_mentions_document ON records_mentions (document_id);

-- The subject's own public statements about the matter, quoted verbatim
CREATE TABLE IF NOT EXISTS records_statements (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT NOT NULL REFERENCES records_subjects(id),
  dataset_id  TEXT NOT NULL REFERENCES records_datasets(id),
  quote       TEXT NOT NULL,
  stated_at   TEXT NOT NULL,
  source_name TEXT NOT NULL,
  source_url  TEXT NOT NULL CHECK (source_url LIKE 'http%')
);

-- The public corrections log: what changed and when, never who asked
CREATE TABLE IF NOT EXISTS records_corrections (
  id         TEXT PRIMARY KEY,
  subject_id TEXT REFERENCES records_subjects(id),
  mention_id TEXT REFERENCES records_mentions(id),
  summary    TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  status     TEXT NOT NULL CHECK (status IN ('received', 'reviewing', 'corrected', 'declined'))
);

-- When a person last reviewed a subject's records in a dataset
CREATE TABLE IF NOT EXISTS records_profile_reviews (
  subject_id       TEXT NOT NULL REFERENCES records_subjects(id),
  dataset_id       TEXT NOT NULL REFERENCES records_datasets(id),
  last_reviewed_at TEXT NOT NULL,
  PRIMARY KEY (subject_id, dataset_id)
);
```

---

## 6. Classification definitions

### 6.1 Source types
`court_filing` · `deposition` · `law_enforcement_report` · `flight_log` · `contact_book` · `calendar` · `email_by_subject` · `email_to_subject` · `email_about_subject` · `financial_record` · `news_clipping` · `photo_or_media` · `other`

Classification is per document; `email_*` types are resolved per mention via `role`.

### 6.2 Evidence tiers (strongest documented connection)

| Tier | Name | Qualifies when | Does NOT qualify |
|---|---|---|---|
| 1 | Mentioned | Name appears in a document written by someone else, a list, or a contact book | — |
| 2 | Direct correspondence | Subject authored, or is a named direct recipient of, a message with Epstein, Maxwell, or their staff | Mass emails / large distribution lists (stay Tier 1) |
| 3 | Documented contact | Record shows in-person contact: flight log, confirmed meeting/event, calendar entry corroborated by a second record | An invitation or RSVP alone (stays Tier 1 or 2) |
| 4 | Financial ties | Record shows payment, donation, loan, investment, or business dealing between subject (or their org) and Epstein | Unverified claims in third-party emails |
| 5 | Named in legal proceedings | Subject named in a deposition, court filing, or sworn statement | Being named is not a finding of fact — UI must say so |

Rules:
- A mention gets **one** tier: the strongest it supports on its own.
- A profile's **headline tier** = highest approved tier among its mentions.
- Hearsay ("X told me Y was there") never raises a tier above 1 unless corroborated by a separate record.

### 6.3 Time period
- `pre_2008` / `post_2008`, split at **June 30, 2008** (Epstein's guilty plea in Florida).
- Documents with `date_confidence = unknown` are counted under "date unknown," never guessed.

---

## 7. Pipeline

1. **Ingest:** pull files + metadata into R2; create `records_documents` rows with Bates IDs and original URLs.
2. **Text extraction:** use existing OCR text when imported; otherwise OCR locally (Tesseract or similar). Store text in R2.
3. **Restriction screen:** flag docs likely to contain victim identities (e.g., victim statements, unredacted minors' info) as `restricted`. When unsure, restrict and send to review.
4. **Dedupe:** exact hash, then near-duplicate detection (e.g., MinHash on text). Set `canonical_doc_id` on duplicates; counts use canonical docs only.
5. **Entity resolution:** match `records_subject_aliases` against text. High-ambiguity aliases and low-confidence matches → review queue.
6. **Classification (Claude batch):** for each candidate mention, send the excerpt + document metadata and get back structured JSON (prompt in §9). Model suggestion → `ai_tier`, never directly `tier`.
7. **Auto-approve Tier 1 only** when `match_confidence >= 0.95` and alias ambiguity is low. Everything else → human review.
8. **Human review:** confirm or reject each Tier 2+ mention against the original document page.
9. **Publish:** recompute profile aggregates; set `last_reviewed_at`.

Start with a **1,000-document pilot** to tune prompts and measure accuracy before the full run.

---

## 8. Profile tab (UI)

**Tab:** "Public Records & Investigations" → section per dataset.

**Feature flag:** everything in this tab is off unless the Pages environment variable `RECORDS_TAB` is exactly `on` (unset by default). While it's off, the pages answer "not found" and nothing links to them. It stays off until the legal review (phase 6).

**Standards pages** (phase 1, under About next to Methodology and Principles; `functions/_lib/records.js`):
- `/about/records/tiers/`: the tier definitions (§6.2), how tiers are given, counts and dates (§6.3), the kinds of documents (§6.1)
- `/about/records/disclaimer/`: what the tab shows and doesn't, legal proceedings, victims and redactions, review, corrections and the response time (§11)

Per subject, per dataset:
- **Headline tier** with plain-language label and a link to tier definitions
- **Unique documents** (deduped), with a breakdown by source type
- **Timeline:** first/last documented date, with pre/post June 2008 split and "date unknown" count
- **Supporting documents:** list of approved mentions: date, source type, tier, short excerpt, link to original government document
- **Their statements:** quoted public statements with date and source
- **Last reviewed** date and a "Report an error" link
- Persistent banner: *"Appearing in these records is not evidence of wrongdoing."* linking to the full disclaimer

Never show: raw mention counts, AI rationales, rankings across people, color scales implying guilt, or "top N" leaderboards.

---

## 9. Classification prompt (Claude, batch)

```text
You are classifying a single mention of a named person in a government-released
document. Use only the text provided. Do not infer facts not in the text.

Subject: {display_name}
Document source type: {source_type}
Document date: {doc_date or "unknown"}
Subject's role (if known): {role}
Excerpt (redactions shown as [REDACTED]):
"""
{excerpt_with_context}
"""

Tier definitions:
1 Mentioned: named by someone else, in a list, or in a contact book
2 Direct correspondence: subject authored or is a named direct recipient of a
  message with Epstein, Maxwell, or their staff (not a mass email)
3 Documented contact: the record itself shows in-person contact
4 Financial ties: the record itself shows a payment, donation, or business dealing
5 Named in legal proceedings: named in a deposition, court filing, or sworn statement

Rules:
- Pick the single strongest tier THIS excerpt supports on its own.
- Hearsay or third-party claims are tier 1.
- If the person referenced may not be the subject (same name, initials only), set
  identity_confident to false.
- Never attempt to guess redacted text.

Respond with JSON only:
{"tier": 1-5, "role": "...", "identity_confident": true|false,
 "is_mass_email": true|false, "hearsay": true|false,
 "rationale": "one sentence, internal use"}
```

Use the cheapest model that passes the pilot accuracy bar for this step; route `identity_confident=false` and Tier 3+ suggestions to review.

---

## 10. Review dashboard (internal, behind Cloudflare Access)

- Queue filtered by tier, subject, confidence
- Side-by-side: excerpt + original page image
- Actions: approve (with tier), change tier, reject (wrong person / not supported), mark restricted, needs info
- Every action logged with reviewer and timestamp

---

## 11. Corrections flow

- Public form: subject/entry, what's wrong, supporting link, contact email (optional, stored only until resolved)
- Status visible on the public corrections log
- Target response time listed on the disclaimer page: **14 days**

---

## 12. Build phases

1. **Schema + config:** D1 tables (`records_*`, migration 0042), `data/records/subjects.json` (roles only), tier definitions page, disclaimer page, all behind `RECORDS_TAB` — **done**
2. **Pilot pipeline:** 1,000 docs end to end; measure classification precision against manual review
3. **Review dashboard**
4. **Profile tab UI** (behind a feature flag)
5. **Full run** for launch subjects
6. **Legal review** of the disclaimer, UI copy, and a sample of profiles
7. **Launch**, then expand subject scope

---

## 13. Open decisions (Ben)

- [ ] Bootstrap from an open dataset vs. build from DOJ originals (default: bootstrap + verify)
- [ ] Final launch subject list (default: §3; phase 1 lists the roles only, people filled in before the pilot)
- [ ] Reviewer capacity per week → sets launch timeline
- [ ] Classification model choice after pilot
- [ ] Media lawyer identified for pre-launch review
- [x] Corrections response-time commitment: 14 days (Oct 26, 2026)

---

## 14. Decisions log

Decisions made after v0.1, so the spec stays the source of truth.

| Date | Decision | Why |
|---|---|---|
| 2026-10-26 | Tables prefixed `records_` | Avoids collisions now and later (`corrections` already exists) and keeps Records data clearly separate |
| 2026-10-26 | `datasets.source_url`, `documents.original_url` and `statements.source_url` required, http(s) only | Matches the site-wide rule that every record is sourced |
| 2026-10-26 | Subject config in `data/records/subjects.json`, not YAML | No new dependency; consistent with the rest of the repo |
| 2026-10-26 | Phase 1 lists roles only; people filled in from official sources before the pilot; White House staff wait for profiles | Phase 1 is schema and pages only |
| 2026-10-26 | Feature flag: the `RECORDS_TAB` setting, off by default; pages answer "not found" while off | Hidden until the legal review |
| 2026-10-26 | Standards pages at `/about/records/tiers/` and `/about/records/disclaimer/` | Next to Methodology and Principles, where standards live |
| 2026-10-26 | Corrections response time: 14 days | Realistic for a one-person operation; can be shortened later |
| 2026-10-26 | This spec lives at `docs/records-tab-spec.md` | Cleaner; matches CLAUDE.md |
