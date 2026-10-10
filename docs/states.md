# Every state

ThePillory covers all 50 states, the District of Columbia and Puerto Rico in two layers, which load separately:

1. **Officials: every state, now.** Each state's current legislators (with their districts), its governor and its statewide officers. *Find your representatives* works for state legislators everywhere.
2. **Bills and roll call votes: state by state.** They're loaded from Open States' bulk session files, the states visitors look up most first. Until a state is loaded, its pages say so plainly: "*[State]*'s bills and roll call votes are coming soon."

California keeps its own sources and steps: the Open States API for votes, `data/state-executive-officials.json` for its statewide officers, and Cal-Access for money. Nothing below changes California.

## 1. Officials (weekly)

| What | Where |
|---|---|
| Source | Open States' public people data, [`openstates/people`](https://github.com/openstates/people) (one YAML file per person; it carries the same data as their `people/current/<st>.csv`). |
| Builder | `tools/build_state_people.py` writes `data/states/people/<st>.json`, one per state except CA. It runs in the weekly **Refresh state officials** workflow (`.github/workflows/state-officials.yml`), which commits the files. |
| Sync step | `all-state-officials` (`workers/sync/src/states-officials.js`) reads those files from the site itself, with no API requests. Each state refreshes once a week, in priority order, as many per round as time allows. It upserts officials and marks people no longer listed inactive, but only when the file lists at least half the chamber already on record (so a truncated file can't empty a chamber). |
| Chambers | California keeps `ca-senate`, `ca-assembly` and `ca-executive`. Every other state uses `<st>-upper`, `<st>-lower` and `<st>-executive`. Nebraska's unicameral legislature and DC's Council use `<st>-legislature`. `workers/sync/src/states.js` (`chamberIds`, `chamberName`, `memberTitle`, `districtLabel`) is the one place these are worked out. |
| Statewide officers | Whatever Open States lists, in one fixed order: Governor, Lieutenant Governor, Attorney General, Secretary of State, Treasurer, Auditor, Controller, then any other office. DC's "governor" is shown as Mayor. Open States lists a governor for every state but not every other statewide office, so some states show fewer offices than they have. Pages say "as Open States lists them", not "all". |

### Matching districts

The lookup (`/api/districts`) returns the Census Bureau's district names (the `BASENAME` of the 2024 state legislative district files), and the ZIP files carry the same names. Open States names districts its own way. `districtKey()` makes both sides the same key:

- lowercase letters and digits only;
- leading zeros dropped ("Merrimack 06" becomes "merrimack6");
- the words *and*, *district* and *ward* dropped ("Norfolk, Worcester and Middlesex" matches "Norfolk-Worcester-Middlesex");
- Idaho House seat letters dropped (the Census maps the district; two members share it).

Measured against today's data, **7,518 of 7,563 current legislators match a Census district**. The 45 that don't:

| Not matched | Why | What the page does |
|---|---|---|
| New Hampshire floterial seats (39) | A floterial district overlaps several base districts; the Census maps only the base districts. | The member is listed on the state page and has their own page. A lookup shows the base district's members only. |
| DC and Puerto Rico at-large seats, and the DC Council chair | They represent the whole jurisdiction, not a mapped district. | Listed on the state page. |
| Maine's two tribal representatives | Non-voting seats with no district. | Listed on the state page. |

`data/states/district-names/<st>.json` (built with the ZIP data by `tools/build_zip_districts.py`) gives map and district pages each district's name. A known quirk: `tools/build_geo.mjs` writes district code 98 (at large) as "0" for legislative layers too. The names file maps "0" back to "98" so labels are still right.

## 2. Bills and votes (state by state)

### Where they come from

Open States publishes one CSV ZIP per legislative session (bills, sponsors, actions, votes, each member's position, vote counts, and sources). The files themselves are public (`https://data.openstates.org/csv/latest/<st>_<session>_csv_<random>.zip`), but **the list of links is only on [open.pluralpolicy.com/data/session-csv/](https://open.pluralpolicy.com/data/session-csv/) when signed in** (a free account). The loader can get the list two ways:

- **Signed in:** add the repository secrets `OPENSTATES_EMAIL` and `OPENSTATES_PASSWORD`. The loader signs in and reads the list. The account is used for nothing else.
- **By hand:** copy the ZIP links from that page into the workflow's `urls` box.

### The loader

`tools/load_state_votes.py` (standard library only; tests in `tools/test_load_state_votes.py`) runs in the **Load state votes** workflow (`.github/workflows/state-votes.yml`):

| Input | Meaning |
|---|---|
| `mode: measure` | Downloads the files and reports the bills, votes, positions, **database size** and **row writes** a load would add. Writes nothing; needs no Cloudflare access. **Run this first.** |
| `mode: load` | Writes to D1 (needs `CLOUDFLARE_API_TOKEN` with D1 Edit and `CLOUDFLARE_ACCOUNT_ID`). It skips votes already loaded, so reruns are safe, and it writes a `state_loads` row per session. |
| `states` | `priority:10` (the 10 states visitors look up most, read from D1), a list (`TX,NY`), `all`, or `loaded` (the monthly refresh). |
| `since_year` | Sessions reaching this year. The default is the current two-year period. |
| `max_gb` | **Load mode stops before any file that would take the database past this size** (default 5, the storage Workers Paid includes). It reads the current size with `wrangler d1 info` first. |

Each load also:

- **Keeps the record as it is.** A bill keeps its number, title and source link. A vote keeps its exact motion text, the result, the totals as Open States states them (or none), and the journal or bill source link. Votes without a bill, and votes on bills without a source link, are left out and counted.
- **Records positions for current members only.** Members are matched by Open States person ID, or by a last name that's unique in the chamber. Former members' positions are counted, not stored, until the officials data covers them.
- **Classifies votes the same way as California's:** final passage, amendment, procedural or committee (`classify_state`, the same rules as `src/classify.js`).

After the bulk load, the sync's `other-state-votes` step (`src/state-votes-api.js`) keeps each loaded state's current session up to date from the Open States API: bills updated since the file was generated, with their votes. It reads at most **`STATE_VOTES_API_DAILY` (60) pages a day**, after California's own step, and counts against the same `OPENSTATES_DAILY_LIMIT` (250 a day, kept well under Open States' free tier), so it can never push the site past that limit. The monthly workflow run refreshes from the files again and adds only new votes.

### Which states first

`src/state-priority.js` ranks every state by what this site can see without keeping anything about a person:

- **Lookups:** `/api/districts` adds one to `state_interest` (state, day, count) for each lookup. No address, ZIP or visitor is kept, only the count.
- **Waitlist signups:** each counts as 10 lookups.
- **Ties** go to the larger state.
- **`STATE_PRIORITY`** (a Worker variable, e.g. `TX,NY`) puts states first by hand.

The order is saved to `sync_state` (`state_priority`) for the loader and `/status`. ThePillory doesn't run visitor analytics, so lookups and signups stand in for "most visited". Until enough lookups accumulate, the order is mostly by population.

## 3. Storage

### The layout

Congress and California keep `vote_positions` (one row per member per vote, with text IDs). Measured with the real schema (SQLite 3.45, the same engine as D1), that layout costs **about 320 bytes per position** with Open States IDs. Tens of millions of state positions would come to 5–14 GB, near or past D1's 10 GB limit per database.

So other states' positions go to a compact table, **`state_positions`** (migration 0020):

```sql
CREATE TABLE state_positions (
  vote_k INTEGER NOT NULL, member_k INTEGER NOT NULL,
  position INTEGER NOT NULL CHECK (position BETWEEN 0 AND 3),  -- Yes, No, Present, Not voting
  raw TEXT,                                                     -- the source's word, only when it isn't one of those
  PRIMARY KEY (vote_k, member_k)
) WITHOUT ROWID;
CREATE INDEX state_positions_member ON state_positions (member_k, vote_k);
```

`vote_k` and `member_k` are 52-bit integer keys (the first 13 hex digits of SHA-256 of the vote's or official's ID), stored as `votes.k` and `officials.k`, both UNIQUE. A collision would stop a load rather than mix records. The JS (`stableKey`) and Python (`stable_key`) versions are tested to agree. **Measured: 24.6 bytes per position with both indexes**, about 13 times smaller.

Pages never read either table directly. They read **`all_positions`**, a view that puts the two tables together with the same columns as `vote_positions` (`vote_id`, `official_id`, `position`, `raw_position`). Query plans were checked for each use:

- one vote's positions (`WHERE vote_id = ?`), through the primary key;
- one member's votes (`WHERE official_id = ?`), through `state_positions_member`;
- positions for a list of votes and members (`IN … AND IN …`).

An `EXISTS` across the view, and the per-official totals in `official_stats`, are written as two explicit branches (one per table) so each uses its own index. **The rule from CLAUDE.md still holds:** pages never compute from the whole of either table on a visit. They read `bill_list`, `official_stats` and `state_coverage`, which the sync precomputes.

### Indexes the pages use

| Page | Reads | Index |
|---|---|---|
| Bill page, roll call | one vote's positions | `state_positions` primary key (`vote_k, member_k`) |
| Official page, Votes tab | one member's positions | `state_positions_member (member_k, vote_k)` |
| Laws list, state filter | `bill_list` by state | `bill_list_state (st, last_final)` |
| State page (explore), coverage note | `state_coverage` (one row per state) | primary key |
| Reps lists, district lookup | officials by state, chamber, district | `officials_by_state (state, active, chamber)` |
| Votes list, state filter | votes by chamber and date | existing `votes` indexes, filtered by chamber prefix |

### Expected size

Measured bytes per row, indexes included: **position 25, vote 500, bill 400.**

For a two-year period across all 49 other states plus DC and PR:

| | Low | High |
|---|---:|---:|
| Recorded votes | ~150,000 | ~440,000 |
| Member positions | ~15 million | ~44 million |
| Bills with a recorded vote | ~60,000 | ~120,000 |
| **Positions** | 0.38 GB | 1.1 GB |
| **Votes and bills** | ~0.1 GB | ~0.27 GB |
| **Total added** | **~0.5 GB** | **~1.4 GB** |

**Measured, October 9, 2026** (the 10 states first in line: TX, FL, NY, PA, IL, OH, GA, NC, MI, NJ, 21 session files reaching 2025): **20,574 bills, 48,058 votes, 2,610,983 member positions: 97.5 MB and 5,647,578 row writes.** That's well under the estimate above. These states hold about half the country's population, so all states for the period would come to roughly 0.2–0.3 GB and 12–15 million row writes, inside one month's included writes. Two files had no votes yet: New Jersey's 2026–2027 session and Texas's first called session of 2025.

The range is wide because states record very differently. Some record every committee and procedural vote (hundreds of thousands of positions a session); others record only floor votes. **The measure run gives the exact number before anything is written.**

With the old layout the same data would be 5–14 GB.

### Expected cost

D1 pricing on Workers Paid ($5 a month, which the site already uses for the sync Worker):

| Item | Included each month | Over that |
|---|---|---|
| Storage | 5 GB | $0.75 per GB-month |
| Rows written (each row plus each index entry) | 50 million | $1.00 per million |
| Rows read | 25 billion | $0.001 per million |

What it means here:

- **The first load (one-time):** each position is 2 row writes (the row and its member index), each vote about 8, each bill about 2. All states for one two-year period come to **about 30–90 million row writes**. That's within the 50 million included if spread over two months (top 10 states this month, the rest next), or **up to about $40 once** if loaded in one month.
- **Every month after:** new votes only. A busy month across all states is a few million positions, well within the included writes. Storage stays under 5 GB unless several past sessions are loaded (see below). **Expected: $0 beyond the $5 base.**
- **Reads:** pages read precomputed summaries and single votes, not whole tables; reads stay far within 25 billion.
- **AI analysis:** unchanged (see below); the same daily caps.

**Before loading everything, two numbers are needed:** the database's current size (Cloudflare dashboard → Workers & Pages → D1 → `pillory`, or the "Database now" line in a load run), and confirmation that the account is on Workers Paid (Free caps D1 at 500 MB, which can't hold this).

### Older sessions and archiving

- **Default: the current two-year session only.** That's what `since_year` loads unless told otherwise.
- **Previous sessions** (`since_year: 2023` etc.) add roughly the same size again per period. Check with a measure run first; `max_gb` stops a load before the cap.
- **If the database nears 5 GB** (where storage starts to cost), the plan is to move sessions older than the previous one into a second D1 database, `pillory_archive`, with the same schema, read only by past-year pages (Time Machine). That's not built yet, because one or two periods fit comfortably. D1's hard limit is 10 GB per database.

## 4. AI analysis

The analysis round's daily caps are unchanged. Within them, `stateBillScope()` (`src/state-priority.js`) decides which bills are considered and in what order:

1. Congress and California, as before.
2. Then, from the **`ANALYSIS_STATES` (10)** states at the top of the priority order, **only bills that passed a final-passage vote**, in that order.

Other states' bills aren't analyzed until they're in the top 10. Every analysis follows the same rules as now (relevance check, checks, reviewer, review queue).

## 5. Pages

| Page | Before votes load | After |
|---|---|---|
| State page (`/states/<name>/`, its "[State] map" section) | Legislators by chamber and statewide officers, then "bills and roll call votes are coming soon" | The latest bills with final votes, and how much is loaded: bills, votes, the date range and the source (`functions/_lib/coverage.js`) |
| County and district pages | Each district's legislators | The same |
| Home and briefing | The visitor's state legislators and executive; Happening now on Home shows Congress and California | Your briefing's Happening now toggle shows the visitor's state |
| Official page | About, Platform, and the Votes tab saying votes are coming soon | Every recorded vote. The Funding tab: money data for other states isn't loaded; it says so. |
| Votes list (`/votes/`) | Congress, California | Plus a chip for the visitor's state (`?level=state:XX`) |
| Bill page | n/a | The same layout as California; the full text links to the state's site (from the source) |

`state_coverage` (one row per state: legislators, executives, bills, votes, first and last vote, sessions) is rebuilt by the page-summaries step.

## 6. Ballot measures in other states (survey, October 2026)

California's measures come from the Secretary of State's HTML voter guide (`tools/build_elections.py`). For other states, the question is whether the official source can be read the same way: word for word, with each part labeled. **No state found publishes its measures as structured data (JSON, XML or CSV).** The official formats seen:

| State | November 2026 measures | Official source | Format | Usable |
|---|---|---|---|---|
| Washington | 2 | Secretary of State's online voters' guide (VoteWA) and printed pamphlet | HTML per measure | Yes: the closest to California's |
| Florida | 3 legislative amendments (no citizen initiatives qualified) | Division of Elections' Initiatives / Amendments database | HTML: ballot title, summary, full text. No arguments (Florida's guide doesn't carry them) | Yes, for title, summary and text |
| Missouri | 7 | Secretary of State's ballot measure pages: official ballot title and fair ballot language | HTML and PDF. Courts rewrote several summaries this year, so builds must re-read the certified version | Yes, with a re-check before each build |
| Colorado | 14 | Legislative Council's Blue Book | Accessible PDF (and an online version): summary, arguments for and against (written by Legislative Council staff, not campaigns), fiscal impact | With a PDF parser |
| Massachusetts | 9 | Secretary of the Commonwealth's *Information for Voters* | PDF (88 pages): summary, full text, what a yes and a no vote mean, arguments for and against | With a PDF parser |
| Arizona | Legislative referrals (count to confirm) | Secretary of State's publicity pamphlet | PDF: text, Legislative Council analysis, pro and con arguments | With a PDF parser, once posted |
| Ohio | 1 (Issue 3) | Secretary of State's issue report | PDF: full text, ballot language, explanation, arguments | With a PDF parser |
| Nevada | 2 (Questions 6 and 7) | Secretary of State's Ballot Question Guide | PDF | With a PDF parser |
| Oregon | not confirmed | Secretary of State's voters' pamphlet | PDF and online | Not checked yet |

Counts are from each official source where it was found. Where only press coverage was found, the official list must be checked before any build. The sandbox this was written in can't reach most Secretary of State sites, so each builder needs a probe run (as for California) before it's trusted.

**Washington is built** (October 2026): its three statewide measures, from the Secretary of State's official documents (`tools/build_wa_measures.py`, see docs/elections.md).

**Building the five most-visited.** Not in this change. "Most visited" needs the lookup counts this change starts collecting (`state_interest`), which are empty until it's live. Each state also needs its own reader and a part-by-part audit like the 14 California measures. The plan: after a week of lookups, take the top five states that have November measures, build the HTML states (Washington, Florida, Missouri) first, and use the same measure page layout as California. That means official content first, campaign arguments collapsed with the same note, and both sides in matching panels.

## Setup after merging

1. **Open the sync's `/run` link once** (or wait for the daily run). Migration 0020 runs first, and the pages read `all_positions`. Until it runs, vote sections show "Couldn't load this."
2. Add the repository secrets `OPENSTATES_EMAIL`, `OPENSTATES_PASSWORD`, `CLOUDFLARE_API_TOKEN` (D1 Edit) and `CLOUDFLARE_ACCOUNT_ID`.
3. Run **Refresh ZIP district data** once, so ZIP lookups carry every state's legislative districts.
4. Run **Load state votes** with `mode: measure`, `states: priority:10`, and check the size and row writes in the run summary.
5. Then run it with `mode: load` for the same states. Once those load, measure and load `all`.
