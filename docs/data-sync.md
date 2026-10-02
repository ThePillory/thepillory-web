# Real officials and voting records: setup and operations

The site stays static, with three additions:

```
Congress.gov ─┐
senate.gov ───┤   sync Worker (workers/sync)        D1 database "pillory"        Pages Functions (functions/)
Open States ──┼──▶ daily Cron + manual /run ───────▶ officials, bills, votes, ───▶ /reps/, /reps/<name>/,
county JSON ──┘   logs every step to sync_log       vote_positions, …             /laws/, /laws/bills/<id>/, /bodies/<slug>/
```

Everything shown carries a source URL. The database refuses rows without one.

## One-time setup in Cloudflare (about 15 minutes, all in the dashboard)

1. **Create the database.** Go to Storage & Databases → D1 → **Create database**, name it `pillory`, and copy its **Database ID**.
2. **Point the Worker at it.** In GitHub, edit `workers/sync/wrangler.toml` and replace `REPLACE_WITH_D1_DATABASE_ID` with that ID. Merge it.
3. **Deploy the sync Worker.** Go to Workers & Pages → **Create** → Workers → **Import a repository**:
   - Repository: `ThePillory/thepillory-web`
   - Root directory: `workers/sync`
   - Deploy command: leave the default (`npx wrangler deploy`)

   It deploys as `pillory-sync`, with the daily Cron Trigger from `wrangler.toml` (11:00 UTC) and its background-run Durable Object. The Worker creates the database tables itself on its first run.
4. **Add the Worker's secrets.** In `pillory-sync` → Settings → **Variables and Secrets**, add each of these as type *Secret*:

   | Name | Value |
   |---|---|
   | `CONGRESS_API_KEY` | your api.congress.gov key |
   | `OPENSTATES_API_KEY` | your v3.openstates.org key |
   | `SYNC_TOKEN` | any long random string (it's the password for the manual run link) |
   | `ANTHROPIC_API_KEY` | Claude API key, for the AI-drafted constitutional analysis (see [analysis.md](analysis.md)) |
   | `COURTLISTENER_API_TOKEN` | courtlistener.com API token, for checking case citations |
5. **Give the website read access.** In the Pages project `thepillory-web` → Settings → **Bindings** → Add → **D1 database**:
   - Variable name: `DB`
   - Database: `pillory`

   Add it for Production (and Preview, if you want previews to show real data). Then redeploy the site: Deployments → latest → **Retry deployment**.
6. **Recommended: Workers Paid ($5/month).** The Free plan allows only 50 outbound requests and 10 ms of CPU per run. That's enough for daily updates, but the first backfill of a year of House and Senate votes (a few thousand requests) would take many manual runs, and a busy run can hit the CPU limit. On Paid, set `MAX_SUBREQUESTS = "900"` in `workers/sync/wrangler.toml` and the backfill finishes in a few runs.

## Running the sync

- **Automatically:** every day at 11:00 UTC (4 a.m. Pacific).
- **Manually:** open this link in any browser:

  ```
  https://pillory-sync.<your-subdomain>.workers.dev/run?token=<SYNC_TOKEN>
  ```

  It answers right away with `"status": "started"` and does the work in the background. Opening it again while a run is going says `"already running"`, and never starts a second one.
- **Check progress:** open the status link:

  ```
  https://pillory-sync.<your-subdomain>.workers.dev/status?token=<SYNC_TOKEN>
  ```

  Under `run`, `status` reads `running` or `finished`. `round` counts the rounds so far, and `outcome` ends as `up to date` when everything is loaded. `counts` shows how many officials, bills, votes and positions are loaded, and `recent_log` lists each step's latest result.

How background runs work: a run happens inside a Durable Object (`SyncRunner`, created automatically on deploy) in rounds of up to about 12 minutes each. When a round stops only because it reached its request or time budget, the next round starts on its own, up to 20 rounds per run. Anything held back by a daily limit (Open States) continues with the next daily sync. The daily Cron Trigger starts runs the same way.

After the sync, the same run drafts constitutional analyses of new bills (step `analysis`; see [analysis.md](analysis.md)). `/analyze?token=<SYNC_TOKEN>` runs only that step.

Temporary D1 errors ("Network connection lost", "… caused object to be reset" and the like) are retried automatically, up to 4 times with increasing waits (`workers/sync/src/d1retry.js`). Any other database error fails the step and is logged.

Each step (county officials, state officials, federal officials, House votes, Senate votes, state votes) logs `ok`, `partial` (stopped at a limit; resumes next run), `skipped` (nothing due) or `error`, with the message. One failing source never stops the others. A step that fails is skipped for the rest of that day's rounds ("failed earlier today …") and tried again in the next day's run; a manual `/run` tries it again right away, for example after a fix is deployed. Worker logs are also in the dashboard under `pillory-sync` → Logs.

### What each step fetches, and how often

| Step | Source | Frequency and what's new |
|---|---|---|
| County officials | `data/county-officials.json` on the live site | every run (1 request) |
| State officials | Open States `people.geo` (a point in San Andreas: records Calaveras's districts as `home_districts`), then `people?jurisdiction=ca` (every current legislator, about 120, picked out by their `lower`/`upper` role) | weekly (about 4 requests), counted from the last run that loaded every legislator; fewer than 100 changes nothing and is an error |
| Federal officials | Congress.gov `member?currentMember=true` (every current member, about 540), and `member/{id}` for each member's full name and website | the list once per calendar day (3 requests); each member's detail when first seen and then every 30 days, spread over runs so the vote steps keep their budget. A list shorter than 400 members changes nothing |
| House votes | Congress.gov `house-vote/{congress}/{session}`, with detail (party totals), members and the bill title | only roll calls not already in D1 with totals. Every member's position and the totals are saved. Votes saved before migration 0005 have no totals, so each is read once more (2 requests) to fill them in |
| Senate votes | senate.gov `vote_menu_{congress}_{session}.xml`, then each vote's XML | same as House votes: every senator's position (matched by LIS ID, or state and last name) and the `<count>` totals |
| State hearings | Open States `committees` (with memberships) weekly, then `events` for upcoming dates | daily (1 to 3 requests; a few more once a week); runs before state votes so the daily cap can't starve it |
| County meetings | The county's **Tyler Meeting Manager** (since September 2026): `meetingInformation/getMeetingInformationByDate` (JSON: every Board of Supervisors and Planning Commission meeting, its agenda status, item titles and video), then each posted agenda's PDF (`meetingInformation/Agenda/false/{id}` for the Board; the Planning Commission posts only the packet, `Agenda/true/{id}`, whose first pages are the agenda). Items, sections, departments and attachment names come from the PDF text; how to comment from the PDF's first page, read line by line in position order (the plain text of the Board's first page comes out shuffled). Board packets (often over 100 MB) are linked, never downloaded; a PDF over `TYLERMM_PDF_MAX_BYTES` (25 MB) is linked but not read. Meetings saved earlier from the former IQM2 portal stay; a meeting both systems list is kept once (the IQM2 copy is dropped unless it already has items). `COUNTY_MEETING_SOURCES` picks the readers (`tylermm`, default; add `iqm2` to read the old portal too) | the list once a day (1 request, from `MEETING_BACKFILL_DAYS` ago to 45 days ahead); each agenda PDF once per posting, again only when the county re-posts it, and a PDF that couldn't be read the next day. No robots.txt; still one request every `TYLERMM_MIN_INTERVAL_MS` (10 s), at most `TYLERMM_DAILY_LIMIT` (20) a day |
| State votes | Open States `bills?include=votes&updated_since=…` for the current CA session | only bills updated since the last run, with every legislator's position and the totals (`counts`). The whole session is read again after migration 0005, and again whenever more legislators are loaded than when the last full read started (a position is saved only for a loaded legislator), so earlier votes get every member's position; capped at `OPENSTATES_DAILY_LIMIT` (default 250/day), one call every 6.5 s, so that takes a day or two. While the weekly load of every legislator is due, state votes and state hearings leave `OPENSTATES_OFFICIALS_RESERVE` (10) of the day's Open States requests for it (a full load takes about 4) |
| Campaign funding | FEC API (`FEC_API_KEY`, else `CONGRESS_API_KEY`): each member's totals, PAC contributions (line 11C), donors' employers and outside spending, for the current and previous two-year period; FEC IDs from the congress-legislators crosswalk. See [funding.md](funding.md) | one request every 4 s, at most `FEC_DAILY_LIMIT` (3,000) a day; first full load about 3 days, then the current period weekly and the previous one every 90 days |
| Lobbying | lda.gov reports that mention each current-Congress bill with a final-passage vote | one request every 3 s, at most `LDA_DAILY_LIMIT` (1,200) a day; each bill again every 30 days |

## Entering county officials

See `data/README.md`. In short: fill in `name`, `source_url` and `last_verified` for each supervisor in `data/county-officials.json`, then merge. The next sync loads them. Entries missing a required field are skipped, and the log says why.

## Verifying what was loaded

After the first run, open `/reps/` on the site. Every official has an **Official source** link and a "Last verified" date. To see the raw rows, go to D1 → `pillory` → Console and run:

```sql
SELECT name, office, district, party, source_url, last_verified FROM officials WHERE active = 1;
```

## Linking issues to bills

`issue_bill_links` exists but nothing fills it automatically. A link is shown only when its status is `approved`. To add one by hand (D1 console):

```sql
INSERT INTO issue_bill_links (issue_slug, bill_id, reason, source_url)
VALUES ('public-comment-limit', 'us-119-hr-10', 'Why this bill relates to the issue', 'https://www.congress.gov/…');
-- then, after review:
UPDATE issue_bill_links SET status = 'approved', approved_by = 'Your name', approved_at = datetime('now') WHERE id = 1;
```

## Local testing (optional, needs Node)

`workers/sync/test/run-local.sh` starts a fixture server with **fake** API responses, runs the Worker against a local D1, then serves the site with Pages Functions at `http://localhost:8790`. It never touches real APIs or the real database.

## Visitors' districts and the ZIP data

The site's lookup (`/api/districts`, a Pages Function) doesn't touch D1 or the Worker. A street address goes to the U.S. Census Geocoder (vintage `ACS2025_Current`: 119th Congress districts and 2024 state legislative districts); a ZIP code is looked up in `data/zip/`. Neither is stored or logged; only district IDs go back to the visitor's browser.

`data/zip/` and `data/counties.json` are built by `tools/build_zip_districts.py` from Census block files (ZIP code areas, 119th Congress districts, 2024 California legislative districts). It downloads about 1.4 GB, so it runs in GitHub Actions: Actions → **Refresh ZIP district data** → Run workflow; the workflow commits the result. When the 120th Congress starts (January 2027): point the script at the 120th Congress district files, rerun the workflow, and set the Pages variable `CENSUS_VINTAGE` to the geocoder vintage whose layer is "120th Congressional Districts".

## The county waitlist

"Bring ThePillory to your county" on the hub posts to `/api/waitlist`, which stores the county and email in the `waitlist` table (migration 0005), after Turnstile and a per-visitor daily limit (`waitlist_attempts`, a daily-rotating hash, never the address). The hub shows only the totals. Counts by county are at `/admin/waitlist/` (behind Cloudflare Access). To export the emails for a county's launch, run in the D1 console:

```sql
SELECT email FROM waitlist WHERE county_fips = '06009';
```
