# Taxes

`/taxes/`: who pays taxes, who holds household wealth, and what companies report paying. It has no tab of its
own. It's linked from the nation section on Home and every state's page, the Laws
tab, the Taxes and Budget topic page and the footer. `/taxes/` opens Taxpayers, and
a Taxpayers | Wealth | Corporations switch (like Laws') sits at the top of each.

Everything is shown as the agency or the company published it, without conclusions.

## Taxpayers (`/taxes/taxpayers/`)

`data/taxes/taxpayers.json`, built by `tools/build_taxpayers.py` (tested in
`tools/test_build_taxpayers.py`) in the weekly "Refresh company taxes" workflow's
`taxpayers` job. The job commits the file through `tools/commit_data.sh` and the
`data-commit` concurrency group. A source that doesn't read keeps its last good data,
and the run fails so the failure is seen.

| Section | Source | What's read |
|---|---|---|
| Federal income tax, by income group | IRS Statistics of Income, Tables 4.1 and 4.2 (the newest `<yy>in41ts` / `<yy>in42ts` linked on the IRS's percentile page) | For each group, top 0.001 percent to bottom 50 percent, by tax year: the number of returns, the AGI floor, the share of all AGI and the share of all income tax, as the IRS computes them; and, from Table 4.1's Total column, all returns and the IRS's average tax rate for all returns (`all_returns`) |
| The 400 returns with the largest incomes | IRS, *The 400 Individual Income Tax Returns Reporting the Largest AGIs Each Year, 1992–2014* (PDF; the series' last edition) | Table 1's first columns: the AGI cutoff, the total and average AGI, and the share of all AGI. A year that doesn't read in both blocks is left out. The page says the group changes every year and that the IRS has published the top 0.001 percent instead since 2014 |
| All federal taxes, by household income | CBO, *The Distribution of Household Income, 2022* | Linked only. CBO's site refuses requests from GitHub's servers and from this build, so nothing is read |
| California personal income tax | Franchise Tax Board, table B-4A (residents, all filing statuses), through data.ca.gov's API | The latest year's returns, California AGI and total tax liability. The FTB's AGI classes are added up into 7 bands, and each band's shares are computed from the table's own totals. The page says both |

Two fixed sections, the same for every visitor (`functions/_lib/taxpayers.js`):

- **What these numbers don't count** (`NOT_COUNTED`), right under the intro and before the first table. It covers:
  - income as reported on returns, which leaves out the growth of unsold assets, gains erased at death, and borrowing against assets;
  - federal income tax only: no payroll, corporate, estate and gift, or state and local sales, gas and property taxes;
  - government benefits and tax-free employer health and retirement benefits left out;
  - taxes owed but not paid left out.
  It ends with "Different measures give different rates for the same group. Each table below says what it counts."
- **Counting unsold gains: one estimate** (`UNSOLD_GAINS`), after the IRS tables. It states the 400 wealthiest families' average federal individual income tax rate, 8.2% of income including unsold gains, 2010–2018. The source is the 2021 analysis by the White House Council of Economic Advisers and the Office of Management and Budget, linked at its archived address. The section is labeled "An estimate, not official tax data" and gives one line on the method and one on the main criticism, of similar length (tested). It says these families aren't the IRS's 400 returns above. No person is named.

**Separate groups** (`irsSlices()`): the IRS's groups overlap (each top group includes the ones above it), so their shares don't add to 100%. The main table shows five separate slices instead, each a cumulative IRS group minus the one above it:
- Top 0.1%
- Next 0.9% (the top 1% minus the top 0.1%)
- Top 1–10%
- Top 10–50%
- Bottom 50%
- a Total row

For each: returns, share of income, share of tax, and average tax rate. The average tax rate is share of tax ÷ share of income × the IRS's average rate for all returns that year; with no all-returns rate loaded it says "Not published", never a guess. One line under the table: "Each row is a separate group; the rows add up to all returns." A test checks that the slices' shares add to 100% within rounding for every year. The IRS's own groups stay under "Show the IRS's groups", a fold below the card, with a note that each includes the ones above it.

The old address `/finances/who-pays/` redirects here with a 301 (`functions/finances/[[path]].js`).

## Wealth (`/taxes/wealth/`)

`data/taxes/wealth.json`, built by `tools/build_wealth.py` (tested in `tools/test_build_wealth.py`) in the same weekly job as Taxpayers. It's read from the Federal Reserve's Distributional Financial Accounts download (`dfa.zip`):
- `dfa-networth-shares.csv`: each group's share of all household net worth, as the Fed computes it, every quarter since 1989.
- `dfa-networth-levels-detail.csv`: each group's net worth and household count.

The five groups are the Fed's own, by net worth, and they don't overlap:
- Top 0.1%
- Next 0.9% (rest of the top 1%)
- Top 1–10%
- Top 10–50%
- Bottom 50%

A run that doesn't read cleanly keeps the last good file and fails the job. That covers: not five groups, the shares not adding to about 100, fewer than 100 quarters, or the household column missing.

The page (`functions/_lib/wealth.js`, `wealthMain()`), the same for every visitor:
1. **What this counts** (`COUNTS`). Net worth is what households own minus what they owe. Unsold gains are included; future Social Security benefits aren't. A line says the same household can be in a different group here than in the income tables.
2. **The table** (`wealthRows()`). For the latest quarter: households, share of wealth (the Fed's) and average net worth (net worth ÷ households); each group's share of households is in its name, so it isn't a column, with a Total row and the line "Each row is a separate group; the rows add up to all households."
3. **Share of wealth over time.** The top 1% (top 0.1% plus the next 0.9%) and the bottom 50%, the last quarter of each year, with "Show the numbers". These are the same two groups the income charts show.
4. **Another measure.** The Fed's Survey of Consumer Finances, linked, which measures differently.

Wording: no "gap", "inequality", "richest" or "poorest", and no rankings of people. These are tested with the other wording rules in `workers/sync/test/taxes.test.mjs`, which also check that each quarter's shares add to 100%.

## Corporations (`/taxes/companies/`, `/taxes/companies/<cik>/`)

### Data

**The 100 largest companies by revenue** (`--top`, 100; 0 loads every company), by each company's revenue in its latest fiscal year with figures. That keeps the weekly run short and the data small. Companies are never chosen or ordered by taxes paid or any rate. A company whose revenue isn't tagged with one of the revenue elements below isn't among them. Only companies still filing count: their latest fiscal year with figures ended in the last two years. Banks' `RevenuesNetOfInterestExpense` is included, so large banks qualify. A company that drops out of the 100 is removed with its years, jurisdictions and matches. A person's links in `company_org_links` are kept. The "Taxes paid" line on organization panels shows only for these companies.

D1 (migration 0047), loaded by `tools/build_company_taxes.py` (tested in
`tools/test_company_taxes.py`) in the weekly "Refresh company taxes" workflow
(`company-taxes.yml`; `--mode measure` reads and writes nothing).

Sources:
- **EDGAR's nightly bulk files.** `submissions.zip` gives names, tickers, SIC, business address and 10-K filings. `companyfacts.zip` gives every non-dimensional XBRL fact.
- **Each 10-K's own XBRL instance,** for taxes paid by jurisdiction. Only the 10-Ks that file the federal / state / foreign split are read, each once (`company_tax_filings`), at most `--max-instances` requests a run.

`SEC_USER_AGENT` (optional) gives EDGAR a contact.

| Field | XBRL element (us-gaap) | Shown as |
|---|---|---|
| `taxes_paid` | `IncomeTaxesPaidNet` | Income taxes paid, net of refunds |
| `paid_federal`, `paid_state`, `paid_foreign` | `IncomeTaxPaidFederalAfterRefundReceived`, `…StateAndLocal…`, `…Foreign…` (ASU 2023-09, from fiscal 2025) | Federal / State and local / Foreign, under "Taxes paid, as the 10-K splits them" |
| jurisdictions | those elements on `IncomeTaxAuthorityAxis`, every member: a country (`country:XX`), a state (`stpr:XX`), the standard totals and "other" members (`us-gaap:DomesticCountryMember`, `StateAndLocalJurisdictionMember`, `ForeignCountryMember`, `ForeignTaxJurisdictionOtherMember`) and the company's own members (Tesla's `tsla:OtherStatesMember`), named by the filing's label linkbase | Where the taxes went, as filed. Country names come from pycountry; an unknown code keeps its code |
| `current_federal`, `current_state` | `CurrentFederalTaxExpenseBenefit`, `CurrentStateAndLocalTaxExpenseBenefit` | Current federal / state and local income tax expense (benefit) |
| `deferred` | `DeferredIncomeTaxExpenseBenefit` | Deferred income tax expense (benefit) |
| `pretax` | `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`, else `…MinorityInterestAndIncomeLossFromEquityMethodInvestments` (`pretax_tag` records which) | Profit before taxes (in the 10-K: Income (loss) before income taxes, or "…and equity-method investments" for the second element) |
| `pretax_us`, `pretax_foreign` | `…BeforeIncomeTaxesDomestic`, `…BeforeIncomeTaxesForeign` | Profit before taxes, in the U.S. / outside the U.S. |
| `revenue` | `Revenues`, `RevenueFromContractWithCustomer…`, `RevenuesNetOfInterestExpense`, `SalesRevenueNet` | Revenue (chooses the 100, and the list's order) |

How the values are chosen:
- **Annual values only:** a 10-K's fact for a period of 330 to 400 days, ending in 2019 or later.
- **Restatements:** a year's value is the latest-filed 10-K's, so a restatement replaces the original.
- **Fiscal year name:** the name the year's own 10-K gives it (the filing whose latest period is that year), shown with its months. A year that reaches the facts only through later 10-Ks takes the company's naming rule from its other years (Tesla's 2019 once read "fiscal 2021", the year of the later filing that carried it).
- **Taxes paid by place:** every original 10-K for a year ending since December 2024, and every 10-K that tags federal / state / foreign taxes paid, is read once by the current reader (`READER`, `company_tax_filings.reader`, migration 0049); a filing read by an older reader is read again, and its rows the reader no longer finds are pruned. Each run prints the companies whose parts don't add up to their total (`breakdown()`).
- **Filing links:** each value's filing is stored (`src`), and the page links it.
- **Untagged values:** a value the filing doesn't tag stays empty ("Not reported"), never estimated or derived. A gross "Income Taxes Paid" (before refunds) isn't used.
- **Extension elements:** companies' own elements aren't used. Company facts don't carry them, and their meaning varies.

### The same organization elsewhere (`company_orgs`)

The weekly build matches what ThePillory already has to companies, once, so a
company's page reads only its own rows. A match is either:
- the exact name key (`nameKey()`, the same rule as Federal awards), when exactly one company has that key, or
- a link a person entered in `company_org_links` (organization key → CIK).

It covers these kinds:
- `pac`: contributions to members of Congress (`funding_pacs`), by cycle
- `lobbying`: LDA reports naming it as the client (`lobbying_filings`)
- `ld203`: contributions honoring members, reported by lobbying organizations (`lobby_contrib_filings`, `lobby_contributions`)
- `ca-lobbying`: California Forms 635/645 (`ca_lobby_reports`)
- `ca-measures`: 2026 California measure money, from `data/elections/measure-money-*.json`

A match that no longer holds is removed. A PAC's name rarely equals its company's, so most PACs appear only once a person links them.

### Pages

**The look** (November 2026): every /taxes/ view (Corporations, a company, Taxpayers, Wealth) uses the official's page and Home's cards and rows, inside `.tax-page` (CSS under "/taxes/" in `pillory.css`): card titles bold, sentence case, body size (`.tax-title`); no uppercase labels; three text sizes only (h1, body, small); bold only for card titles and the big figures; the row pattern (label left, amount right, at most one gray line); every amount in the text color; short amounts (`shortMoney()`), exact figures in each amount's title and in Show the numbers; one "From the 10-K ›" link per card; an empty section hidden, never "not loaded". Plain labels (`LABELS`: "Income taxes actually paid", "Profit before taxes", "Tax put off until later years"…); the 10-K's own terms (`FILING_TERMS`) and XBRL elements only in "About these numbers". Tested in `taxes.test.mjs` ("the look of every /taxes/ view").

- **The list.**
  - Search by name or ticker (`?q=`), Industry (SIC, `?sic=`), State (business address, `?state=`), Order (`?sort=name|revenue|pretax`: Name, Revenue, Profit before taxes), 25 a page with Load more.
  - **Never sorted, ranked, filtered, labeled or colored by taxes paid or by any rate.** There's no "top payers" or "paid zero" list. Each row: the name and tickers, then one gray line with industry, state, and the latest year's revenue and profit before taxes: dollars only, no rates.
  - Indexes on name, revenue and profit before taxes keep a page to its own rows.
  - Then the laws (below) and a collapsed "About this list".
- **A company**, in this order:
  1. **Header:** the name, and one small gray line: ticker · industry · state.
  2. **The top card**, titled with the fiscal year ("FY2025 (Jan–Dec 2025)", `fyLabel()`), two big figures, U.S. first:
     - "Taxes paid in the U.S." (`usTaxes()`): federal plus state and local taxes paid, when both are known (tagged, or the sum of the places listed), "on $4.77 billion of U.S. profit · 4%" (U.S. taxes ÷ income before income taxes, domestic), and a gray line "U.S. government $28 million · States $151 million". With only federal known: "Paid to the U.S. government". Neither: no U.S. figure.
     - "Total taxes paid worldwide" (`taxes_paid`), "on $5.28 billion of total profit · 23%".
     - `profitLine()`: a loss reads "with a loss before taxes of $X", a net refund starts "More refunded than paid", a missing value leaves the line out; none gets a percent (`shareOfProfit()`: taxes paid ÷ profit before taxes, never of revenue, a whole percent).
     - Small gray: "2023–2025: 15% of total profit" (sums over the latest five years with both values, `multiYear()`), and "The federal corporate income tax rate is 21%. States add their own."
  3. **Where the taxes went** (`taxesTree()`, only when the 10-K breaks taxes paid down): U.S. government; States, with each state listed and "Other states" indented; Other countries, with each country listed and "Other countries" indented; Total. The rows add up to the total: a group whose total isn't tagged shows the sum of its places, labeled "Sum of the places listed"; a difference between a tagged total and its parts is its own row, "Not broken out in the 10-K: $X" (or "Parts listed in the 10-K exceed its total by $X", `gapRow()`), never a silent gap or an estimate. Tesla's FY2025: $28 million + $151 million (California $86 million, other states $65 million) + $1.05 billion (China $751 million, other countries $302 million) = $1.23 billion.
  4. **Over the years:** taxes paid and profit before taxes side by side (`pairBars()`), a one-line legend, and Show the numbers (once on the page: every value by year in exact dollars, each year's heading linked to its 10-K, "Taxes as a share of profit" last).
  5. **Laws that set these taxes** (`lawsSection()`, hidden if the file isn't loaded): one line each, "Tax Cuts and Jobs Act · 2017 ›", linked to its bill page, where each reader's own representatives' votes show; then "Congress sets the rates, deductions and credits companies pay under. See how your representatives voted on each." From `data/taxes/corporate-tax-laws.json`, hand-kept: each law's popular title, official title, public law, year and a summary sentence word for word from Congress.gov (checked with the accuracy audit's section 8). The sync's `law-votes` step loads every recorded vote on each listed bill, once. The page never says which law lowered a company's taxes: the 10-K doesn't say. Add a law only from official sources.
  6. **Other records under this name:** only the ones that exist (PAC, federal lobbying, LD-203, California lobbying, 2026 California ballot measures, and federal awards once looked up), one row each with its amount, years, count and how it matched, linked to the latest filing; "Shown side by side as facts. ThePillory doesn't connect them to the taxes above." With none: "No PAC, lobbying or ballot measure records under this name."
  7. **About these numbers** (collapsed): "Taxes paid is cash paid this year, after refunds. It won't match this year's profit exactly: some tax is paid a year early or late. Deductions, credits and past losses set by law lower what's paid." (`READING_TEXT`), the source note, and each value's 10-K term and XBRL element.
  - The same layout for every company. A company's percentages appear on its own page only; nothing compares companies in words.
- **On organization lines** (members' Funding tab: donors' employers, LD-203 organizations, outside donors and lobbying organizations; California lobbying; dark money donors; measure signers' organization panels), `taxMarker(name)` leaves a placeholder. `functions/_middleware.js` fills every placeholder on a page with one query (`taxInfo()`, `fillTaxLines()`): "Taxes paid (FY2025): $X · profit before taxes $Y ›" (dollars only) to the company, when exactly one company has the name (or a person linked it), otherwise nothing.

### Wording rules (tested in `workers/sync/test/taxes.test.mjs`)

These never appear on these pages or in their code:
- "fair share", "loophole", "dodged", "paid nothing", "pays less than", "paid zero", "top payers"
- rankings ("ranked", "biggest", "worst", "best")
- "evade" and "avoid"

No person is named: there are only companies, organizations and counts of returns.
