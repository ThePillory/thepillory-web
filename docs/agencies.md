# Government agencies

Federal agencies: what each one is in its own words, who leads it, what it was given and spent, how many people work there, the oversight reports that name it, the rules it publishes, and the laws that fund it. Facts only, each with its year, what it counts and its source. Phase 1 is federal; California's departments and Calaveras County's departments come later (bottom of this page).

Pages: `/agencies/` (search, then the 15 executive departments with their sub-agencies, then independent agencies) and `/agencies/<slug>/` (one agency). Code: `tools/load_agencies.py` (the loader, run in GitHub Actions), `functions/agencies/[[path]].js` and `functions/_lib/agencies.js` (the pages), migration `0052_agencies.sql`, workflow `.github/workflows/agencies.yml`.

## Sources (official only)

| Part | Source | What's read | Check before downloading |
|---|---|---|---|
| `agencies` | Federal Register agencies API, `federalregister.gov/api/v1/agencies.json` (473 agencies) | name, short name, slug, parent, description (its own words, unedited), website, Federal Register page | `Content-Length` of the file (no ETag is sent) |
| `leaders` | OPM's PLUM data under the PLUM Act, `escs.opm.gov/escs-net/api/pbpub/download-data` (one CSV, every listed position) | positions whose appointment type is PAS (presidential appointment with Senate confirmation): position, organization, holder (or "Vacant" as listed), begin date; a non-PAS holder of a PAS position only with the placement OPM lists (for example "PTDO") | `Content-Length` |
| | Congress.gov nominations already in D1 (`nominations`, from the sync) | the nomination naming the holder: confirmation date, and the Senate roll call when one is recorded (`votes`, nomination votes); otherwise the nomination's own latest action ("Confirmed by the Senate by Voice Vote", as stated) | — (D1) |
| `money` | USAspending.gov API (`/api/v2/agency/<code>/budgetary_resources/`, `object_class/`, `budget_function/`, `search/spending_by_category/recipient/`) | per agency (the 111 USAspending top-tier agencies, matched to the Federal Register list by name) and fiscal year since 2017: total budgetary resources, obligations and outlays; obligations and outlays by object class and by budget function; the 10 largest recipients of contracts and of grants that aren't individuals | the top-tier list's latest reporting period (`active_fy`, `active_fq`): nothing is read again until it changes; closed years aren't read again |
| `workforce` | OPM's Federal Workforce Data API, `data.opm.gov/api/v1/files/employment` (monthly record-level files, parquet) | employees by agency, from each September file (fiscal year end) | the file list's version and publication date |
| `oversight` | GAO's reports feed, `gao.gov/rss/reports.xml` (the 25 newest) | title, date, report number (GAO-YY-NNNNN), link, kept when the title or GAO's summary names the agency by its full name | `ETag` / `Last-Modified` of the feed |
| | Oversight.gov (inspectors general) | **not loaded**: the site refuses requests from GitHub's servers (HTTP 406). Pages say nothing about it until a way to read it officially exists | — |
| `rules` | Federal Register documents API (`documents/facets/yearly`, `documents.json`), type RULE | rules published per year since 2017, and the latest 10, linked | the yearly counts: the latest 10 are read again only for agencies whose count changed |
| `laws` | the appropriations bills already in D1 (`bills`, with their votes), matched to agencies by the subcommittee in the bill's own title (`data/agencies/appropriations.json`, hand-kept) | bill, title, final-passage vote (from `bill_list`), linked to the bill page, where every member's vote is listed | — (D1) |

Notes:
- **Names.** PLUM lists many names in capitals; they're shown with ordinary capitalization, the words unchanged.
- **USAspending's terms.** "Total budgetary resources" is USAspending's figure for what an agency could spend in a year: new budget authority plus balances carried over. "Obligations" are what it committed to spend, and "outlays" what it paid out. The page uses these terms with one plain line each.
- **Matching.** An agency in one source is tied to an agency in another only when exactly one name matches (`norm_name()`: "Agriculture Department" = "Department of Agriculture"). Anything unmatched is listed in the loader's output and not shown.

## Tables (migration 0052)

| Table | Key | Rows (first load, estimated) |
|---|---|---|
| `agencies` | `id` (the Federal Register slug, never renamed) | 473 |
| `agency_leaders` | `(agency_id, organization, position, name)` | ~1,600 (PAS positions, filled and vacant) |
| `agency_money` | `(agency_id, fy)` | ~1,100 (111 agencies × FY2017–2026) |
| `agency_money_parts` | `(agency_id, fy, kind, name)` | ~25,000 (object classes and budget functions) |
| `agency_recipients` | `(agency_id, fy, award, rank)` | ~22,000 (10 contracts + 10 grants per agency-year) |
| `agency_workforce` | `(agency_id, year)` | ~1,000 |
| `agency_reports` | `(source, number, agency_id)` | grows ~25 a week, a few naming each agency |
| `agency_rule_counts` | `(agency_id, year)` | ~4,000 |
| `agency_rules` | `(agency_id, document_number)` | ~4,700 (latest 10 each) |
| `agency_bills` | `(agency_id, bill_id)` | ~200 |
| `agency_load_state` | `part` | 7 (the checks above) |

Every table is read by its key or the agency's index; no page reads a whole table. The index page reads the `agencies` table (473 rows) and one `agency_money` row per agency by key.

## How often each part loads

The workflow (`.github/workflows/agencies.yml`) runs daily and on demand: every part on Mondays, only GAO's feed on other days (it carries only the 25 newest reports). Scheduled runs only measure until the repository variable `AGENCIES_MODE` is set to `load`; a run by hand takes `mode`, `parts` and `force`. The accuracy audit's section 14 runs the same measure (`agency_parts` picks parts).

| Part | Runs | Writes after the first load |
|---|---|---|
| agencies | weekly | only an agency whose name, description or parent changed |
| leaders | weekly | positions whose holder, status or date changed |
| money | weekly, read only when USAspending's reporting period moves (about monthly) | the open fiscal years' rows that changed |
| workforce | weekly, read only when OPM publishes a new September file (yearly) | one row per agency, once a year |
| oversight (GAO) | daily | new reports only |
| rules | weekly | the current year's count; the latest 10 when they change |
| laws | weekly | new appropriations bills only |

## D1 cost

Every part runs `--mode measure` first: it reads the sources and what D1 already holds, and writes nothing. It reports, per table: rows read from the source, rows that would be inserted, updated and deleted, the row writes that makes (each row written plus one per index on the table, as D1 bills), and the storage it adds. `--mode load` writes only those rows: `upserts()` with a WHERE that skips identical rows, and `prune()` for rows gone from the source (never delete-and-reinsert), the same rules as `tools/d1sql.py`. Each load records its rows in `usage_steps` as `agencies-<part>`, shown on `/admin/usage/` under "Agency loads".

Before measuring, the estimate was about 60,000 rows and 120,000 row writes for the first load (about $0.12 at $1.00 per million writes), and 15 MB of storage. Weekly runs after that write about the open fiscal years' changes (a few thousand rows). The measured numbers replace these before the first load.

## Pages

**`/agencies/`** (linked from Home's nation section, the Laws tab and the footer): a search field, then "Executive departments" (each department, with its sub-agencies under it), then "Independent agencies". One line each, the site's row pattern: the name, then its short name and the latest outlays when known.

**`/agencies/<slug>/`**, in the site's card style, the same sections in the same order for every agency, each hidden when empty:
1. **What it is**: the Federal Register's description, word for word, with the agency's website.
2. **Leadership**: each Senate-confirmed position: the holder (linked to their page when they're already an official on the site, as the Cabinet is), title, since date, and how they were confirmed (the roll call, linked, or "Confirmed by voice vote" as Congress.gov states it). Vacant positions as "Vacant", as listed.
3. **Money**: the big number is the latest complete fiscal year's outlays; a chart of total budgetary resources and outlays by year; what the obligations went to (object class) and for what (budget function); the top recipients of contracts and grants; Show the numbers with exact figures.
4. **Workforce**: employees by year (September of each year).
5. **Oversight reports**: GAO reports naming the agency, newest first, in their own titles, linked.
6. **Rules**: rules published per year and the latest 10, linked.
7. **Funding laws**: the appropriations bills that fund it, linked to each bill's page and its members' votes.
A department's page lists its sub-agencies.

Rules for every page: facts only; every number with its fiscal year, what it counts and its source; short amounts, exact figures under Show the numbers; no grades, no rankings across agencies, no "waste" or "bloat" wording, no colors for good or bad; reports listed in their own titles only, never summarized or labeled; no party labels; the same layout for every agency. Tested in `workers/sync/test/agencies.test.mjs`.

## Later (not built)

- **Phase 2: California departments.** The Department of Finance's enacted budget by department, Open FI$Cal spending, and the Governor's appointments.
- **Phase 3: Calaveras County departments.** The county's adopted budget by department, tied to the Board of Supervisors' agenda items and votes already on the site.
