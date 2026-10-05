# The executive branch

The President, the Vice President and the Cabinet; California's Governor and the
other offices California elects statewide. What they do in office: executive
orders, bills signed and vetoed, and (for the President) nominations. Same rules
as everywhere else: facts with sources, no commentary, no scores.

## Who holds each office

| Office | Source | How |
|---|---|---|
| President, Vice President | [congress-legislators `executive.json`](https://github.com/unitedstates/congress-legislators) | Automatic, daily: whoever's term covers today. Terms, party (plain text) and FEC IDs come with it. |
| The Cabinet | [whitehouse.gov/administration/cabinet](https://www.whitehouse.gov/administration/cabinet/) | Automatic, daily: each member's `<h2>` name and `<h3>` office. If the page lists fewer than 8, the shape changed: the current list is kept and the step logs an error. |
| California's statewide offices | `data/state-executive-officials.json`, entered by hand from each office's official site | Like the county supervisors (see `data/README.md`). An entry missing its name, source or check date is skipped and logged. |

Officials live in the same `officials` table as everyone else, with `chamber`
`us-executive` or `ca-executive`, `body` the same, and `rank` (1 = President or
Governor, 2 = Vice President or Lieutenant Governor, 10 and up = the Cabinet in
the White House's order). A former member of Congress now in the Cabinet takes
over their plain name slug; the old, inactive row moves to `<slug>-<chamber>`.

## What they do

Four sync steps (`workers/sync/src/executive/`); parsers are pure functions in
`parse.js`, tested in `test/executive.test.mjs`.

- **`executive-officials`**: the offices above.
- **`executive-orders`** (`executive_actions`):
  - the President's executive orders this term, from the Federal Register API
    (`/documents.json`, presidential document type `executive_order`), with the
    number, signing date, citation, title exactly as published, and PDF;
  - the Governor's, from gov.ca.gov's "Executive orders" feed: each post's
    title, date and link, and the signed order's PDF and number (`N-9-26`) when
    the post links it. Posts are classed as an executive order or a
    proclamation by their headline; others in the category are kept but not
    shown. One request every `GOVCA_MIN_INTERVAL_MS` (2 s), at most
    `GOVCA_DAILY_LIMIT` (300) a day; the feed is read back to its start once,
    then only its first page.
- **`bill-outcomes`** (`bill_outcomes`, `bill_outcome_checks`):
  - Congress: the bills updated since the last scan (Congress.gov
    `/bill/{congress}?fromDateTime=`; the first scan reads the whole Congress),
    and for each bill or joint resolution whose latest action mentions the
    President, a veto or a public law, its actions. A law that ThePillory
    doesn't have yet (passed by voice vote, say) is added as a bill.
  - California: leginfo's bill history (`billHistoryClient.xhtml`) for each bill
    that has a final-passage vote in both houses. One request every
    `LEGINFO_MIN_INTERVAL_MS` (2 s), at most `LEGINFO_DAILY_LIMIT` (1,500) a day.
  - The outcome comes only from the action that states it: `signed`,
    `vetoed`, `pocket_vetoed`, `without_signature`, `over_veto`, or
    `became_law` (a law whose record shows no signature: not assumed signed);
    `presented` until then. Bills awaiting action or vetoed (a veto can be
    overridden) are looked at again (federal daily, California every 3 days).
  - The President or Governor named is whoever held the office that day: for
    the President, from `executive.json`; for the Governor, from the term dates
    in `data/state-executive-officials.json` (left unnamed when the file has
    none).
- **`nominations`** (`nominations`): civilian nominations in the current
  Congress (Congress.gov `/nomination/{congress}`, new ones since the last scan),
  each with its latest action and a status read from it (confirmed, pending,
  withdrawn, returned, not confirmed). Military promotion lists aren't stored.

## Funding

Every executive office has a Funding tab, the same rules for every office (see
`docs/funding.md`, "The executive branch"): the President's FEC campaign money,
inaugural committee and OGE financial disclosures; the Vice President's ticket
money (when they ran with the President), the inaugural committee and OGE
disclosures; the Cabinet's OGE financial disclosure reports and ethics
agreements (no campaign money: appointed); California's statewide officers'
campaign committees (Cal-Access) and Form 700 statements (FPPC).

## Pages

- `/reps/<slug>/`: the President gets Executive orders, Bills and Nominations
  tabs (no Votes tab); the Governor gets Bills and Executive orders; every
  executive office keeps Promises, Funding and Issues.
- `/laws/bills/<id>/`: **Final action**, with the outcome, date, law or chapter
  number, who acted, the recorded action word for word, and the source.
- "Who represents you" on the hub (`/`), state pages (`/explore/<st>/`) and
  place pages (`/place/…`); `/bodies/us-executive/` and `/bodies/ca-executive/`
  list every office; `/reps/` has an Executive branch section.

## Migration 0008

Rebuilds `officials` to allow the two executive chambers (SQLite can't change a
CHECK in place). The rows are copied aside, the old table emptied and dropped,
and the rows inserted into the new table under the same name, so the deferred
foreign-key checks (votes and funding point at `officials`) settle before the
batch commits. Tested against a populated local database.
