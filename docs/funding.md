# Campaign funding and lobbying

**The rule:** money and votes are shown side by side as facts. Nothing on the site says or implies that money caused a vote. Avoid words like "bought", "paid for", "in the pocket of" anywhere, in code, copy or docs. Every number says what it counts, the period it covers and its source.

## What's shown

| Where | What |
|---|---|
| Rep profile, **Funding** tab (members of Congress) | Top PAC contributors by name; outside spending for and against; top contributing industries (approximate); totals raised, spent, cash on hand; the small-donor / larger-donor / PAC / party / self-funding breakdown; the average for the same chamber; donors' employers (3 or more donors). The current and previous two-year period (`?cycle=2024#funding`). |
| Bill page, **Follow the money** (bills in Congress) | Organizations whose lobbying reports mention the bill, the number of reports and the reported amounts (which cover the whole report); and, for the visitor's own reps (district cookie), each rep's final-passage position beside contributions in that two-year period from the industries that lobbied, with the note "This shows a relationship in the data, not a cause." |
| Methodology, `#funding` | Sources, categories, limits, the no-causation rule, and the legal restriction on FEC donor data. |

State legislators and county officials say plainly that their funding isn't shown yet.

## Sources and sync

Two steps in the sync Worker (`workers/sync/src/funding/`), last in the daily run:

- **`federal-funding`**: the [FEC API](https://api.open.fec.gov/developers/) with an api.data.gov key (`FEC_API_KEY`, else `CONGRESS_API_KEY`). Members are matched to FEC candidate IDs through the public [congress-legislators](https://github.com/unitedstates/congress-legislators) crosswalk (`unitedstates.github.io`, weekly), then each member's principal campaign committee for the period. Per member and period:
  - `/candidate/{id}/totals/` (all authorized committees),
  - `/schedules/schedule_a/` line `F3-11C` (PAC and other committee contributions, every page, summed by committee),
  - `/schedules/schedule_a/by_employer/` (up to 300 employers; never donor names),
  - `/schedules/schedule_e/by_candidate/` (independent expenditures for and against).

  About 6 to 20 requests per member and period, one every 4 s (`FEC_MIN_INTERVAL_MS`; 900 an hour, under the key's 1,000), at most `FEC_DAILY_LIMIT` (3,000) a day. The first full load (about 535 members × 2 periods) takes about 3 days. Afterwards the current period is re-read every `FUNDING_REFRESH_DAYS` (7), the previous one every 90 days: roughly 600 requests a day. FEC's bulk files weren't needed; the API is fast enough. While the first load runs, the daily run continues in rounds, so the analysis step starts later in the day than usual.
- **`federal-lobbying`**: [lda.gov](https://lda.gov/api/redoc/v1/) (the Senate's LDA database, which moved from lda.senate.gov; no key needed, `LDA_API_KEY` optional). For each bill of the current Congress with a final-passage vote, newest vote first: `filings/?filing_specific_lobbying_issues="H.R. 4"` and `"H.R.4"`, for each year of the Congress, 25 reports a page, one request every 3 s (`LDA_MIN_INTERVAL_MS`), at most `LDA_DAILY_LIMIT` (1,200) a day. The search resumes where it stopped (`bill_lobbying_progress.cursor`), and each bill is searched again every `LOBBYING_REFRESH_DAYS` (30). Large bills (budget reconciliation, appropriations) have thousands of reports and take a day or more.

Each mention is checked in `lobbying.js`: the whole number ("H.R. 4" isn't "H.R. 40"), not next to another Congress ("118th Congress S 1071"), and not followed by a different bill's title ("H.R. 1, Lower Energy Costs Act" for this Congress's H.R. 1). The report's own words around the mention are kept as the excerpt.

## Tables (migration 0007)

`fec_candidates`, `funding_totals`, `funding_pacs`, `funding_outside`, `funding_employers`, `funding_progress`; `lobbying_filings`, `bill_lobbying`, `bill_lobbying_progress`. Every row has a source URL (the FEC candidate page or receipts search, or the lobbying report).

## Industries

`src/funding/industry.js`: fixed keyword rules on a PAC's name or a donor's employer, the same for everyone; first match wins, narrower rules first. Unmatched names are "Not classified", and pages show what share of the money matched. Another member's leadership PAC or campaign committee comes from the FEC record (designation D, or committee type H/S/P), not keywords. Lobbying organizations use the same rules (with their self-description). Change the rules there; they're tested in `test/funding.test.mjs`.

## Privacy and the law

- No individual donor is stored or shown by name, at any amount. Individual giving appears only as totals, by size, and by employer, and an employer only when 3 or more donors named it.
- 52 U.S.C. 30111(a)(4): contributor information from FEC reports may not be sold or used to solicit contributions or for commercial purposes. There is no export, download or API of donor information, and none should be added.

## State and county (not built yet)

- **California (Cal-Access):** no API. The raw export is a single 1.6 GB zip (`campaignfinance.cdn.sos.ca.gov/dbwebexport.zip`) of form-shaped tables, too large for the Worker; Power Search (MapLight) is a search form without a stable export. The Secretary of State is replacing Cal-Access with **CARS** ("post-election, November 2026"), after which the current system "will no longer be available". Anything built on Cal-Access now would break within weeks, so state funding waits for CARS and whatever data access it offers.
- **Calaveras County:** campaign statements (Form 460) filed since 2021 are on the county's NetFile public portal (`public.netfile.com/pub2/?aid=CLVS`); Form 700s are at `netfile.com/public/CLVS/sei`. NetFile publishes agency data through public exports, which is the likely path for a later phase (supervisors' committees would need to be matched by hand in `data/county-officials.json`).

## Testing

- `node workers/sync/test/funding.test.mjs`: parsing, aggregation, industries, the lobbying mention checks.
- `workers/sync/test/run-local.sh`: fake FEC, crosswalk and lda.gov (`test/funding-fixtures.mjs`), then the rep and bill pages.
