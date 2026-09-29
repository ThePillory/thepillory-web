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

Each step (county officials, state officials, federal officials, House votes, Senate votes, state votes) logs `ok`, `partial` (stopped at a limit; resumes next run), `skipped` (nothing due) or `error`, with the message. One failing source never stops the others. Worker logs are also in the dashboard under `pillory-sync` → Logs.

### What each step fetches, and how often

| Step | Source | Frequency and what's new |
|---|---|---|
| County officials | `data/county-officials.json` on the live site | every run (1 request) |
| State officials | Open States `people.geo` (a point in San Andreas), then `people` | weekly (2 requests); also detects the U.S. House district |
| Federal officials | Congress.gov `member/CA` and `member/{id}` | daily (about 4 requests) |
| House votes | Congress.gov `house-vote/{congress}/{session}`, with detail, members and the bill title | only roll calls not already in D1 |
| Senate votes | senate.gov `vote_menu_{congress}_{session}.xml`, then each vote's XML | only votes not already in D1 |
| State votes | Open States `bills?include=votes&updated_since=…` for the current CA session | only bills updated since the last run; capped at `OPENSTATES_DAILY_LIMIT` (default 250/day), one call every 6.5 s |

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
