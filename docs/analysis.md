# AI-drafted constitutional analysis: setup and operations

The Pillory maps the Constitution; it does not rule on it. AI drafts, people review. Nothing is presented as a verdict.

```
bills your officials voted on (D1)
   │  after each daily sync, inside the SyncRunner Durable Object (workers/sync/src/analysis/)
   ▼
bill text ── Congress.gov text versions (federal) / leginfo (California)
   │         no text? the official summary, marked "limited: based on summary only."
   ▼
Claude API (claude-sonnet-5-5) ── fixed JSON shape, full Constitution text in the prompt
   ▼
checks ── every Constitution quote vs. the stored text (mismatches replaced, logged)
       └─ every case vs. CourtListener citation lookup (unverified cases removed with
          every sentence relying on them, logged)
   ▼
bill_analyses (status ai_draft) ──▶ /laws/bills/<id>/ "AI-drafted, not yet reviewed"
   ▼
/admin/review (behind Cloudflare Access) ── edit, approve, reject, regenerate ──▶ "Reviewed by [name], [date]"
```

## The Constitution's text

`data/constitution.json` holds the Constitution and all 27 amendments as the National Archives transcribes them (original spelling), split into 137 quotable provisions with stable IDs such as `art-1-sec-8-cl-3`, `amend-14-sec-1` and `amend-17-cl-2`, plus their containers (`art-1-sec-8`, `amend-14`). It's the only source for quoted text:

- The sync Worker loads it into the D1 table `constitution_provisions` whenever its `version` changes.
- The analysis prompt includes it in full, and the checks compare quotes against it.
- `/laws/constitution/` shows it in full, with an anchor for every ID (`/laws/constitution/#art-1-sec-8-cl-3`).
- The **Constitution text** GitHub workflow runs `tools/check_constitution.py`, which checks every provision word for word against the three archives.gov transcription pages, whenever the file changes. `python3 tools/build.py` also fails if a sample clause page quotes it inexactly.

Never renumber or reuse an ID.

## One-time setup

### 1. Keys

- **Claude API key:** console.anthropic.com → API keys → Create key.
- **CourtListener token:** create a free account at courtlistener.com, then open your profile → Developer tools → API token.

### 2. Worker secrets

In Cloudflare → Workers & Pages → `pillory-sync` → Settings → **Variables and Secrets**, add as type *Secret*:

| Name | Value |
|---|---|
| `ANTHROPIC_API_KEY` | the Claude API key |
| `COURTLISTENER_API_TOKEN` | the CourtListener token |

Without `ANTHROPIC_API_KEY`, the analysis step logs `skipped` and does nothing else. Without the CourtListener token, drafts are still saved but **every** case citation is removed, because none can be verified.

The Worker now has one npm dependency (the Anthropic SDK, in `workers/sync/package.json`). Workers Builds installs it automatically.

### 3. Protect /admin with Cloudflare Access

`/admin` is locked until this is done: it answers "Locked" (HTTP 503) to everyone, including you.

1. Cloudflare dashboard → **Zero Trust**. The first time, it asks for a **team name** (for example `thepillory`, which gives the team domain `thepillory.cloudflareaccess.com`) and a plan. Pick **Free**. It may ask for a payment method even for the free plan.
2. **Access → Applications → Add an application → Self-hosted.**
   - Application name: `The Pillory admin`
   - Session duration: `24 hours`
   - Add these public hostnames, each with path `admin`:
     - `thepillory.co`
     - `thepillory-web.pages.dev`
     - `*.thepillory-web.pages.dev` (preview deployments)
3. Add a **policy**:
   - Name: `Only me`
   - Action: **Allow**
   - Include → **Emails** → your email address

   Login method: **One-time PIN** (on by default) emails you a code.
4. Save. Open the application's **Overview** and copy the **Application Audience (AUD) Tag**.
5. Pages project `thepillory-web` → Settings → **Variables and Secrets**. Add these for Production and Preview:

   | Name | Value |
   |---|---|
   | `ACCESS_TEAM_DOMAIN` | your team domain, e.g. `thepillory.cloudflareaccess.com` (Zero Trust → Settings → Custom Pages shows it) |
   | `ACCESS_AUD` | the AUD tag from step 4 |
   | `ADMIN_EMAILS` | your email address (a second check; optional but recommended) |
   | `REVIEWER_NAME` | optional: the name to pre-fill when you approve, e.g. your name as you want it shown |

6. Redeploy the site (Deployments → latest → **Retry deployment**).
7. Test in a private window: `https://thepillory.co/admin/review/` should show Cloudflare's login page. Enter your email, then the emailed code, and the review page opens. Any other email is refused.

Access stops everyone else before the request reaches the site. The site also verifies Access's signed token on every `/admin` request (`functions/_lib/access.js`), so if the Access application were deleted or misconfigured, `/admin` would stay locked rather than open.

## Running it

- **Automatically:** after every daily sync (11:00 UTC), the same background run drafts analyses of bills that have none yet.
- **Now:** open `https://pillory-sync.<your-subdomain>.workers.dev/analyze?token=<SYNC_TOKEN>`. It answers `started` right away. `/status?token=…` shows `run.analysis`, and `recent_log` shows one `analysis` row per bill: tokens used, how many quotes were replaced, and how many citations were verified or removed.
- **Order:** regeneration requests from `/admin/review` come first, then bills with the most recent votes.
- **Daily cap:** `ANALYSIS_DAILY_LIMIT` in `workers/sync/wrangler.toml` (default `20`). Set it to `"0"` to pause drafting.
- **Retries:** a bill that can't be drafted (no text or summary, a model refusal, an error) is retried after 7 days.
- **Other settings in `wrangler.toml`:** `ANALYSIS_MODEL` (default `claude-sonnet-5-5`), `ANALYSIS_EFFORT` (default `high`), and `MAX_BILL_TEXT_CHARS` (default 400,000). Longer bill texts are cut and the draft is marked "limited".

**Cost, roughly:** each draft sends the Constitution (about 12,000 tokens, cached across the drafts in a run) plus the bill text, and gets back a few thousand tokens. At claude-sonnet-5-5 prices ($2 per million input tokens, $10 per million output), a typical bill costs about $0.05 to $0.30. The longest bills cost up to about $1. The daily cap bounds the total. Every draft's token counts are in `sync_log` and on its review page.

**Refusal fallback:** the request opts into the API's server-side fallback (`fallbacks: "default"`). If the model declines on certain safety categories, the API retries on another model in the same call. The model that actually wrote a draft is saved with it and shown on the page.

## Reviewing

`/admin/review/` lists current drafts, newest first, with filters for reviewed and rejected. Each draft's page shows:

- the public preview
- what the automatic checks changed (every replaced quote, every citation lookup result, every removed sentence)
- an edit form for every field
- **Approve**: your name is shown as "Reviewed by [name], [date]"
- **Reject**: the bill page goes back to "Not yet mapped"
- **Return to draft**
- **Ask for a new draft**: written on the next run; the current version is kept
- the full version history

When you save an edit, Constitution quotes are checked again against the stored text, and cases must link to their CourtListener page.

## Tables (workers/sync/migrations/0002_analysis.sql)

- `constitution_provisions`: the text, by ID.
- `bill_analyses`: one row per draft. It holds every field, plus `model`, `prompt_version`, `quote_check` and `citation_check` (JSON logs), token counts, `status` (`ai_draft` / `reviewed` / `rejected`), `reviewer`, `reviewed_at` and `created_at`. Regenerating adds a new row and marks the old one `current = 0`.
- `bill_analysis_revisions`: every create, edit, approval, rejection, reopen and supersede, with a snapshot of the row as it was.
- `analysis_requests`: regeneration requests from `/admin/review`.
- `analysis_attempts`: bills that couldn't be drafted, and when they were last tried.

## Testing

- `node workers/sync/test/verify.test.mjs`: the quote and citation checks, against the real stored text and fake drafts. Cases include a wrong quote, a made-up case, a real citation under the wrong name, and a lookup outage.
- `node workers/sync/test/access.test.mjs`: the `/admin` token check.
- `workers/sync/test/run-local.sh`: end to end with fake APIs (`fixture-server.mjs`, including a fake Claude API and a fake CourtListener), then the site at `http://localhost:8790` with `/admin/review/` open locally.
- **Real bills:** the **Real-bill analysis** GitHub workflow drafts the 3 newest bills with House final-passage votes and prints them in the run summary, saving nothing. It needs the repository secrets `ANTHROPIC_API_KEY`, `COURTLISTENER_API_TOKEN` and `CONGRESS_API_KEY` (GitHub → Settings → Secrets and variables → Actions). It runs when a pull request gets the label `run-real-analysis`, or from the Actions tab.
