# Stock trades (STOCK Act)

Periodic Transaction Reports filed by members of Congress, shown as filed, side by side with the record. Same rules as [funding.md](funding.md): facts side by side, never cause; neutral wording; the same rules for every member and party.

**The Ethics in Government Act forbids commercial use of these reports.** Trades are free on ThePillory: never behind a paid plan, never in an export, a data feed or an API.

## Sources and loading

`tools/load_trades.py`, run by the **Load stock trades** workflow (`.github/workflows/trades.yml`): by hand until a measure run on real reports has been checked, then daily, up to 300 new reports, newest first, back to 2023; or by hand in **measure** mode (reads a sample, writes what it found to the run summary, writes nothing) or **load** mode.

| Source | What's read |
|---|---|
| House Clerk (`disclosures-clerk.house.gov`) | the yearly index `<year>FD.zip` (FilingType `P`), then each report's PDF (`public_disc/ptr-pdfs/<year>/<DocID>.pdf`). Electronic reports have a text layer, read with `pdftotext -layout`; scanned paper filings have none and are stored as a link only |
| Senate eFD (`efdsearch.senate.gov`) | the search for Periodic Transaction Reports after accepting the site's terms, then each electronic report's table. Paper filings (`/search/view/paper/…`) are stored as a link only |
| SEC EDGAR | a ticker's CIK (`company_tickers.json`) and SIC code (`data.sec.gov/submissions/CIK….json`); the sector is the SIC division. Cached in `sec_tickers`. `SEC_USER_AGENT` (a name and contact email) is optional but EDGAR asks for one |
| congress-legislators | current committee assignments (`committees-current.json`, `committee-membership-current.json`), matched by Bioguide ID, into `congress_committees` |

Rules in the loader:
- **Only what the report says.** Owner is one of Self, Spouse, Joint, Dependent child; anything else is not stored. Asset names, tickers, types and amount ranges are kept exactly as filed.
- **Matching:** a House report needs exactly one member with the same last name, state and district (`StateDst`); a Senate report exactly one senator with the same first and last name. No unique match: the report is stored with `official_id` NULL and `unmatched` saying why, and never shown. Measure and load runs list the unmatched filers in the run summary.
- **No guessing:** an electronic report whose table can't be read with confidence (an unknown row, a range without its upper bound) is stored as a link only (`parsed = 0`).

## Tables (migration 0024)

`trade_reports` (one per filed report), `trades` (one per transaction: dates, `days_to_file`, owner, asset, ticker, type, the range as filed with its bounds, SIC and sector), `trade_summary` (per member and year, precomputed after each load: count, total range, open-ended ranges, paper reports), `sec_tickers`, `congress_committees`.

## Pages

- **Member page, More tab → Stock trades** (`functions/_lib/trades.js`): a summary first ("[N] trades reported in 2026, totaling $X–$Y in ranges as filed"), current committee assignments as plain facts, then one compact line per trade (newest first, 25 at a time with Load more from `/reps/<slug>/trades/`), then reports filed on paper or not read automatically, each linked. No "conflict" labels or commentary.
- **Quick mode:** one line on the member page, "Reported [N] stock trades this year", opening the list.
- **`/trades/`** (linked from Reps → Browse → Federal and from Laws): the latest trades across Congress, newest first, filtered by chamber, state, sector and member name, 25 at a time. Ordered only by date.
- **Filing timeliness:** when a trade was reported more than 45 days after it happened, its line says "Filed [N] days after the trade". No "late", "violation" or warning colors.
- **Speed:** summaries are precomputed; lists are paged; every query is narrowed by member or capped.

## Tests

`tools/test_load_trades.py` (the House index and report text, the Senate table, owners, ranges, matching, and the SQL in SQLite: reports, trades, summaries, a paper report); `workers/sync/test/trades.test.mjs` (the pages: a member who files electronically, one who files on paper, spouse trades, `/trades/` filters and paging, Quick mode).
