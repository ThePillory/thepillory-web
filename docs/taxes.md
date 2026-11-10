# Taxes

`/taxes/`: who pays taxes, and what companies report paying. It has no tab of its
own. It's linked from the nation section on Home and every state's page, the Laws
tab, the Taxes and Budget topic page and the footer. `/taxes/` opens Taxpayers, and
a Taxpayers | Corporations switch (like Laws') sits at the top of both.

Everything is shown as the agency or the company published it, without conclusions.

## Taxpayers (`/taxes/taxpayers/`)

`data/taxes/taxpayers.json`, built by `tools/build_taxpayers.py` (tested in
`tools/test_build_taxpayers.py`) in the weekly "Refresh company taxes" workflow's
`taxpayers` job. The job commits the file through `tools/commit_data.sh` and the
`data-commit` concurrency group. A source that doesn't read keeps its last good data,
and the run fails so the failure is seen.

| Section | Source | What's read |
|---|---|---|
| Federal income tax, by income group | IRS Statistics of Income, Tables 4.1 and 4.2 (the newest `<yy>in41ts` / `<yy>in42ts` linked on the IRS's percentile page) | For each group, top 0.001 percent to bottom 50 percent, by tax year: the number of returns, the AGI floor, the share of all AGI and the share of all income tax. These are the IRS's own shares, never recomputed; the average tax rate isn't shown |
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

The old address `/finances/who-pays/` redirects here with a 301 (`functions/finances/[[path]].js`).

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
| jurisdictions | those elements on `IncomeTaxAuthorityAxis`, a `country:XX` or `stpr:XX` member | By jurisdiction, as filed (each one 5% or more of taxes paid). Country names come from pycountry; an unknown code is left out |
| `current_federal`, `current_state` | `CurrentFederalTaxExpenseBenefit`, `CurrentStateAndLocalTaxExpenseBenefit` | Current federal / state and local income tax expense (benefit) |
| `deferred` | `DeferredIncomeTaxExpenseBenefit` | Deferred income tax expense (benefit) |
| `pretax` | `IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest`, else `…MinorityInterestAndIncomeLossFromEquityMethodInvestments` (`pretax_tag` records which) | Income (loss) before income taxes, or "…and equity-method investments" for the second element |
| `pretax_us`, `pretax_foreign` | `…BeforeIncomeTaxesDomestic`, `…BeforeIncomeTaxesForeign` | Income (loss) before income taxes, U.S. / foreign |
| `revenue` | `Revenues`, `RevenueFromContractWithCustomer…`, `RevenuesNetOfInterestExpense`, `SalesRevenueNet` | Revenue (chooses the 100, and the list's order) |

How the values are chosen:
- **Annual values only:** a 10-K's fact for a period of 330 to 400 days, ending in 2019 or later.
- **Restatements:** a year's value is the latest-filed 10-K's, so a restatement replaces the original.
- **Fiscal year name:** the name the year's own (earliest-filed) 10-K gives it, shown with its months.
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

- **The list.**
  - Search by name or ticker (`?q=`), Industry (SIC, `?sic=`), State (business address, `?state=`), Order (`?sort=name|revenue|pretax`), 25 a page with Load more.
  - **Never sorted, ranked, labeled or colored by taxes paid or by any rate.** There's no "top payers" or "paid zero" list. The list shows industry, state, and the latest year's revenue and pretax income.
  - Indexes on name, revenue and pretax income keep a page to its own rows.
- **A company.**
  - **The latest year:** taxes paid and pretax income, each labeled exactly and linked to its 10-K, with the split and jurisdictions when filed.
  - **Over the years:** taxes paid and pretax income side by side (`pairBars()` in `functions/_lib/charts.js`). With fewer than two years, a line says so, so every company keeps the same sections.
  - **Show the numbers:** every value by year, each linked, with the XBRL element.
  - **Reading these numbers:** a fixed panel (`READING`). Taxes paid differ from tax expense (timing, refunds, deferrals); losses carried forward, credits and deductions set by law can lower the taxes paid in a year; foreign taxes are paid to other countries.
  - **In ThePillory's other records:** each kind with how it matched, side by side, "ThePillory doesn't connect them to the taxes above", plus a Federal awards link.
  - The same layout for every company.
- **On organization lines** (members' Funding tab: donors' employers, LD-203 organizations, outside donors and lobbying organizations; California lobbying; dark money donors; measure signers' organization panels), `taxMarker(name)` leaves a placeholder. `functions/_middleware.js` fills every placeholder on a page with one query (`taxInfo()`, `fillTaxLines()`): "Taxes paid (FY2025): $X · pretax income $Y ›" to the company, when exactly one company has the name (or a person linked it), otherwise nothing.

### Wording rules (tested in `workers/sync/test/taxes.test.mjs`)

These never appear on these pages or in their code:
- "fair share", "loophole", "dodged", "paid nothing", "pays less than", "paid zero", "top payers"
- rankings ("ranked", "biggest", "worst", "best")
- "evade" and "avoid"

No person is named: there are only companies, organizations and counts of returns.
