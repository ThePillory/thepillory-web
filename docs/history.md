# The Time Machine

A year slider on county, official and topic pages shows the page as it was in an earlier year, back to 1993. The finances pages put federal and California budgets on a timeline of presidential and gubernatorial terms. The public explanation is under **How the Time Machine works** in Methodology (`/about/methodology/#time-machine`).

## Rules

- **Who held office is a fact.** Party is plain text, styled the same for everyone. Nothing is colored or framed by party.
- **No cause and effect.** Numbers sit beside who held office, which party led each chamber, and what happened in the world (recessions, wars, pandemics). No page says or implies that an officeholder caused a number. There are no evaluative labels.
- **The same layout and measures for every term and every year.**
- **Gaps are stated, not blank.** Every past-year view ends with "Not available for YEAR", and each finance card lists what's missing.
- **Official sources only.** Every record keeps its source URL. Nothing is filled in from memory.
- **A clear indicator for past years.** The "Viewing YEAR · Back to today" banner sticks to the top of every past-year view, below the top nav on wide screens.

## Pages

| Address | What it shows |
|---|---|
| `/place/<st>/<county>/?year=YYYY` | Who represented the county that year: the President and Vice President, the Cabinet by Senate confirmations (from 2001), senators, the House members for the districts that covered the county, and in California the Governor, the statewide officers and legislators. Also final-passage votes, executive orders and FEC totals for the period. |
| `/reps/<slug>/?year=YYYY` | The office held that year (or that they didn't hold it), votes that year, executive orders (Presidents), FEC totals for the period, and every term on record. Past officeholders' bare addresses redirect to their last year in office. |
| `/topics/<topic>/?year=YYYY`, `/place/<st>/<county>/topics/<topic>/?year=YYYY` | Bills on the topic with a final-passage vote that year, and executive orders on the topic signed that year. |
| `/finances/` | Federal debt, receipts, outlays, surplus or deficit, net interest and spending by category, by presidential term. |
| `/finances/california/` | California's General Fund by governor's term. |

**The year bar** (`yearBar()` in `functions/_lib/history.js`) is a range input in a plain GET form, so it works without JavaScript ("Show this year"). With JavaScript (`assets/app.js`, `form[data-year-bar]`), letting go of the slider opens that year, and the far right opens today. Keyboard users step with the arrow keys and press the button. `?year=` accepts 1993 through last year; anything else shows today.

**Code:**

- `functions/_lib/history.js`: the year helpers, data loaders and D1 queries.
- `functions/_lib/history-pages.js`: the past-year views.
- `functions/_lib/finances.js`: pure term math.
- `functions/finances/[[path]].js`: the finances pages.

The place, reps and topics routes call into these when `?year=` is set. Tests are in `workers/sync/test/finances.test.mjs` and `history.test.mjs`.

## Static data: `data/history/` (generated, never edit by hand)

Built by `tools/build_history.py` in the weekly **Refresh history data** workflow (`.github/workflows/history.yml`, Mondays, or run it by hand). The sources aren't reachable from everywhere, so it runs in GitHub Actions. The job log ends with a **Checks** section listing what each reader found; read it after changing the builder.

| File | Contents | Source |
|---|---|---|
| `federal-executive.json` | Presidents and Vice Presidents, terms, party, FEC IDs | congress-legislators `executive.json` (Biographical Directory) |
| `congress/<st>.json` | Every member for each seat since 1993: `{house: {district: [terms]}, senate: [terms]}` | congress-legislators current and historical |
| `districts/<st>.json` | County-to-district overlaps by period: 2003–2012 (108th Congress, House only, matched by county name), 2013–2022 and 2023 on (House, State Senate, Assembly) | Census Bureau relationship files `cd108th`, `cdsld13`, `cdsld18` |
| `california.json` | Governors; general-election winners since 2002 (statewide, Board of Equalization, State Senate, Assembly, U.S. House); seats by party after each election | California State Library; Secretary of State's Statement of Vote |
| `finances.json` | Federal by fiscal year (debt, receipts, outlays, surplus, outlays by function, GDP, population, households), presidential terms, party control by Congress, event markers; California General Fund by fiscal year, population and households | Treasury Fiscal Data (Debt to the Penny; Historical Debt Outstanding before 1993), OMB Historical Tables 1.1, 3.1, 10.1, Census Bureau population estimates and CPS Table HH-1, House and Senate historians, NBER, Public Laws 107-40 and 107-243, HHS public health emergency declarations, Department of Finance Chart A and E-5/E-8 estimates |

**Notes on the readers:**

- **Census requests** are paced (one file a second) and retried on HTTP 429. If a state's district file comes back with fewer periods than before, the earlier file is kept.
- **The Statement of Vote** is read from each year's summary PDF, or the complete or per-office PDFs where there's no summary. The winner is the candidate with the most votes. A contest that lists a candidate more than once (county-by-county lines) isn't used. Years whose layout isn't read are listed in the Checks.
- **Events** are kept only when the source page states them (`verify` patterns in `EVENTS`).
- **Chart A** (California) gives fiscal years as `1979-80`, stored under the ending year. Years that haven't ended yet are budget estimates and aren't shown.

## Data in D1 (the sync's history steps)

These steps live in `workers/sync/src/history/` and run after `federal-lobbying` and before `page-summaries`. They share one daily request budget, `HISTORY_DAILY_REQUESTS` (default 600, in `sync_state`), so the backfill takes weeks without crowding the daily sync.

| Step | What it loads |
|---|---|
| `history-officials` | Past Presidents and Vice Presidents since 1993 and California's members of Congress since 2001, as inactive officials (`active = 0`), so votes and pages can link to them. |
| `history-orders` | Executive orders for each past presidential term since 1994 (Federal Register, by signing date). |
| `history-funding` | FEC totals for each two-year period for every federal official with an FEC ID (`funding_cycles`). Rechecked every 180 days. |
| `history-nominations` | Congress.gov nominations for each earlier Congress back to the 107th (for the Cabinet as confirmed). |
| `history-votes` | House roll calls (Clerk XML) and Senate roll calls (senate.gov XML) back to 2001, newest first. Positions are kept for every member ThePillory has, active or past, and vote totals for the whole chamber. |

Schema: `migrations/0016_history.sql` adds `funding_cycles`, `history_checks` and indexes on `votes (chamber, vote_date)` and `executive_actions (signed_on)`. Past-year pages read only by date range or by official, never the whole `votes` table.

## Known gaps (stated on the pages)

- **District lines:** none before 2003. For 2003–2012, House districts only (California's legislative districts aren't in the 108th Congress files), and mid-decade redistricting isn't reflected.
- **California officeholders:** before the 2002 general election, and anyone who took office by appointment or special election.
- **Calaveras County supervisors:** no online county record of past supervisors has been found.
- **California votes:** only the current session (Open States).
- **Cal-Access money and contributors by industry:** only the current two-year period.
- **The Cabinet:** before 2001. Departures, acting secretaries and recess appointments are never shown.
- **The Governor's executive orders:** only the current administration's.
- **California's GDP:** not in the sources read, so California has no share-of-GDP figure.
- **Federal per-person figures:** for years without a Census population estimate in the files read.
