# Campaign funding and lobbying

**The rule:** money and votes are shown side by side as facts. Nothing on the site says or implies that money caused a vote. Avoid words like "bought", "paid for", "in the pocket of" anywhere, in code, copy or docs. Every number says what it counts, the period it covers and its source.

## What's shown

| Where | What |
|---|---|
| Rep profile, **Funding** tab (members of Congress) | Top PAC contributors by name; outside spending for and against; top contributing industries (approximate); totals raised, spent, cash on hand; the small-donor / larger-donor / PAC / party / self-funding breakdown; the average for the same chamber; donors' employers (3 or more donors). The current and previous two-year period (`?cycle=2024#funding`). |
| Bill page, **Follow the money** (bills in Congress) | Organizations whose lobbying reports mention the bill, the number of reports and the reported amounts (which cover the whole report); and, for the visitor's own reps (district cookie), each rep's final-passage position beside contributions in that two-year period from the industries that lobbied, with the note "This shows a relationship in the data, not a cause." |
| Methodology, `#funding` | Sources, categories, limits, the no-causation rule, and the legal restriction on FEC donor data. |

State legislators and county officials say plainly that their funding isn't shown yet. The executive branch is below.

## Sources and sync

Two steps in the sync Worker (`workers/sync/src/funding/`), last in the daily run:

- **`federal-funding`**: the [FEC API](https://api.open.fec.gov/developers/) with its own api.data.gov key (secret `FEC_API_KEY`), so funding and the votes steps don't share one key's hourly limit. Without it, funding borrows `CONGRESS_API_KEY` at half the pace (`FEC_SHARED_MIN_INTERVAL_MS`, 8 s). Members are matched to FEC candidate IDs through the public [congress-legislators](https://github.com/unitedstates/congress-legislators) crosswalk (`unitedstates.github.io`, weekly), then each member's principal campaign committee for the period. Per member and period:
  - `/candidate/{id}/totals/` (all authorized committees),
  - `/schedules/schedule_a/` line `F3-11C` (PAC and other committee contributions, every page, summed by committee),
  - `/schedules/schedule_a/by_employer/` (up to 300 employers; never donor names),
  - `/schedules/schedule_e/by_candidate/` (independent expenditures for and against).

  **Order:** first the members who represent a live community (`LIVE_HOUSE_DISTRICTS`, `CA-5`, plus that state's two senators; keep it in step with `LIVE` in `functions/_lib/geo.js`), then the rest of those states' delegations (California), then everyone else. Each member is matched to FEC IDs and then read (both periods) before the next, so a member's Funding tab fills in as soon as they're reached; until then it says "Funding data is loading". Refreshes of members already loaded come after every new member.

  **Sharing a round with lobbying:** while lobbying has bills waiting, funding stops when `LOBBYING_ROUND_SHARE` (0.4) of the round's remaining time is left, so `federal-lobbying` gets that time instead of a single request. Funding doesn't start a member-period with less than 90 s of its own time left.

  About 6 to 20 requests per member and period, one every 4 s (`FEC_MIN_INTERVAL_MS`; 900 an hour, under the key's 1,000), at most `FEC_DAILY_LIMIT` (3,000) a day. The first full load (about 535 members × 2 periods) takes about 3 days. Afterwards the current period is re-read every `FUNDING_REFRESH_DAYS` (7), the previous one every 90 days: roughly 600 requests a day. FEC's bulk files weren't needed; the API is fast enough. While the first load runs, the daily run continues in rounds, so the analysis step starts later in the day than usual.
- **`federal-lobbying`**: [lda.gov](https://lda.gov/api/redoc/v1/) (the Senate's LDA database, which moved from lda.senate.gov; no key needed, `LDA_API_KEY` optional). For each bill of the current Congress with a final-passage vote, newest vote first: `filings/?filing_specific_lobbying_issues="H.R. 4"` and `"H.R.4"`, for each year of the Congress, 25 reports a page, one request every 3 s (`LDA_MIN_INTERVAL_MS`), at most `LDA_DAILY_LIMIT` (1,200) a day. The search resumes where it stopped (`bill_lobbying_progress.cursor`), and each bill is searched again every `LOBBYING_REFRESH_DAYS` (30). Large bills (budget reconciliation, appropriations) have thousands of reports and take a day or more.

Each mention is checked in `lobbying.js`: the whole number ("H.R. 4" isn't "H.R. 40"), not next to another Congress ("118th Congress S 1071"), and not followed by a different bill's title ("H.R. 1, Lower Energy Costs Act" for this Congress's H.R. 1). The report's own words around the mention are kept as the excerpt.

## The executive branch (`executive-funding`, migration 0009)

The same rules as for Congress, for every office whatever the officeholder's party. One step in the sync Worker (`src/funding/executive.js`), before `federal-funding`; pure parsers in `src/funding/disclosure.js` (tested in `test/disclosure.test.mjs`).

| Office | Funding tab |
|---|---|
| President | The FEC campaign money (the same tab as a member of Congress, from the President's `P…` candidate ID), the inaugural committee, and OGE financial disclosures. |
| Vice President | When their term began with the President's (they ran on one ticket): the same campaign figures as the President's, said plainly, since the FEC records the ticket's money under the presidential committee; the inaugural committee; OGE financial disclosures. |
| Cabinet | No campaign money (appointed), said plainly; OGE financial disclosure reports and ethics agreements. |
| California's statewide officers and all 120 legislators | Campaign finance from Cal-Access (see below), and their Form 700 statements (FPPC), under More → Disclosures. |

- **Outside spenders and "Donors not disclosed":** each committee in `funding_outside` (Congress and the President) is looked up once at the FEC (`/committees/?committee_id=…`, 50 at a time, again after 180 days) into `fec_committees`. A spender of FEC committee type **I** ("Independent expenditure filer (not a committee)") files Form 5 and doesn't have to report its donors except those who gave for those ads: its spending is labeled **Donors not disclosed**, and each list says how much of its total came from such groups. A person spending their own money (filed as "LAST, FIRST") is shown as "An individual, spending their own money (name not shown)", never by name, and isn't labeled. Super PACs and other committees report their donors and aren't labeled. See the methodology's `#donors-not-disclosed`.
- **Inaugural committee:** the committee named "inaugural" that first filed with the FEC in the 150 days before the President's term began (`/committees/?q=inaugural`). Its Form 13 reports (`/filings/?form_type=F13`), the latest version of each, with each report's own total (not added together: a later report can repeat earlier amounts). The main report's electronic file (`.fec` on docquery.fec.gov, one request, `FEC_FILES_DAILY_LIMIT` 20) is read line by line: donations (F132) summed, organizations by name, individuals only as a count and total (never named, never stored by name); refunds (F133) summed. Shown only when it adds up to the report's total within 5%. Checked every `INAUGURAL_REFRESH_DAYS` (7); the file is read again only when a new version is filed.
- **OGE (Office of Government Ethics):** its disclosure search API (`extapps2.oge.gov/201/Presiden.nsf/API.xsp/v3/rest`, the JSON behind OGE's "Officials' Individual Disclosures Search Collection"), searched by last name, kept only when the first name matches too (`ogeNameMatches`). Each record: type as OGE lists it (Nominee or Annual 278e, 278 Transaction, Ethics Agreement, Certification of Ethics Agreement Compliance…), the position and agency, the date OGE added it, and the document's link, or OGE's request form for documents released only on request (Form 201). Every `OGE_REFRESH_DAYS` (7), one request every `OGE_MIN_INTERVAL_MS` (3 s), at most `OGE_DAILY_LIMIT` (200) a day.
- **California campaign finance (Cal-Access), migration 0012:** the **Refresh California campaign data** workflow (`.github/workflows/ca-campaign.yml`, weekly on Mondays and on demand) runs `tools/build_ca_campaign.py` on the Secretary of State's export (`campaignfinance.cdn.sos.ca.gov/dbwebexport.zip`, about 1.6 GB, rebuilt nightly; about 3 minutes), then `tools/ca_campaign_finish.mjs`, and commits `data/ca-campaign.json`. The `cal-access` step loads it when the file changes.
  - **Whose:** Form 460 cover pages (`CVR_CAMPAIGN_DISCLOSURE_CD`) from candidate and candidate-controlled committees (`CAO`, `CTL`). Statewide officers are matched by office and name (from `data/state-executive-officials.json`), since 2023. Legislators are listed by seat (`ASM-8`, `SEN-4`): every candidate with a statement for that seat since 2025; the step matches a sitting legislator to their seat's entry by last name and first name (`matchSeat` in `workers/sync/src/funding/state.js`; no unique match, no data, and the tab says so). An amendment replaces the statement it amends.
  - **Totals** by two-year period (2023-2024, 2025-2026): the sum of each statement's Summary Page (`SMRY_CD`, column A) line 5 (contributions received) and line 11 (expenditures made). Each statement's own totals stay listed with its PDF.
  - **Contributions** (Schedule A, `RCPT_CD`, form `A`; memo entries, transfers between the official's own committees and Schedule C left out): individuals only as totals and by employer (an employer listed only when 3 or more people named it; "Retired", "Not employed" and the like counted, never listed), never by name, at any amount. Committees, parties, businesses and other organizations by the name reported. Refunds (negative entries) net against the totals and never show as negative. Industries use the same keyword rules as federal funding (`industry.js`), applied in the Node step so the rules live in one place.
  - **Independent expenditures** for and against (Form 496 covers and `S496_CD` amounts), by spender, with the spender's committee page. Form 496 is filed only for $1,000 or more in the 90 days before an election, and the page says so. Reports that name the candidate without a district are matched only when one candidate of that name ran for that house.
  - Tested in `tools/test_build_ca_campaign.py` and `workers/sync/test/state-money.test.mjs`. **Cal-Access is replaced by CARS after the November 2026 election**; the workflow then needs the new system's data access.
- **California Form 700 (FPPC):** the FPPC's Form 700 search (`form700search.fppc.ca.gov/Home/SearchDocuments`, a JSON POST: `FilerLastName`, exact match). A statement is kept when the first name matches and one of its positions or agencies is the official's office ("State Controller" matches "Controller"; a legislator's is their house, "State Assembly" or "State Senate"); statements filed only for boards the official sits on are left out. Statewide officers first, then the live communities' legislators (`LIVE_STATE_DISTRICTS`, default `ca-assembly:8,ca-senate:4` for Calaveras), then the rest, `FPPC_PER_RUN` (30) a run. The FPPC's PDF links expire, so `/api/form700/<index ID>` (a Pages Function) asks the FPPC for a fresh link when a reader opens one and redirects to it, or to the FPPC's search if that fails. Every `FPPC_REFRESH_DAYS` (7), `FPPC_MIN_INTERVAL_MS` (3 s), `FPPC_DAILY_LIMIT` (100).

Tables: `fec_committees`, `inaugural_committees`, `inaugural_reports`, `inaugural_breakdown`, `inaugural_organizations`, `disclosures` (OGE and FPPC), `disclosure_checks`, `state_campaign_committees`, `state_campaign_totals`.

## Tables (migration 0007)

`fec_candidates`, `funding_totals`, `funding_pacs`, `funding_outside`, `funding_employers`, `funding_progress`; `lobbying_filings`, `bill_lobbying`, `bill_lobbying_progress`. Every row has a source URL (the FEC candidate page or receipts search, or the lobbying report).

## Industries

`src/funding/industry.js`: fixed keyword rules on a PAC's name or a donor's employer, the same for everyone; first match wins, narrower rules first. Unmatched names are "Not classified", and pages show what share of the money matched. Another member's leadership PAC or campaign committee comes from the FEC record (designation D, or committee type H/S/P), not keywords. Lobbying organizations use the same rules (with their self-description). Change the rules there; they're tested in `test/funding.test.mjs`.

## Privacy and the law

- No individual donor is stored or shown by name, at any amount. Individual giving appears only as totals, by size, and by employer, and an employer only when 3 or more donors named it.
- 52 U.S.C. 30111(a)(4): contributor information from FEC reports may not be sold or used to solicit contributions or for commercial purposes. There is no export, download or API of donor information, and none should be added.

## County (not built yet)

- **Calaveras County:** campaign statements (Form 460) filed since 2021 are on the county's NetFile public portal (`public.netfile.com/pub2/?aid=CLVS`); Form 700s are at `netfile.com/public/CLVS/sei`. NetFile publishes agency data through public exports, which is the likely path for a later phase (supervisors' committees would need to be matched by hand in `data/county-officials.json`).

## Testing

- `node workers/sync/test/funding.test.mjs`: parsing, aggregation, industries, the lobbying mention checks.
- `workers/sync/test/run-local.sh`: fake FEC, crosswalk and lda.gov (`test/funding-fixtures.mjs`), then the rep and bill pages.
