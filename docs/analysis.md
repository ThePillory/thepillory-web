# AI-drafted constitutional analysis: setup and operations

The Pillory maps the Constitution; it does not rule on it. AI drafts, automatic checks and an AI reviewer check them, and a person reviews what's flagged plus a random share. Nothing is presented as a verdict.

```
bills with a final-passage vote by our officials, or linked to an issue (D1)
   │  after each daily sync, inside the SyncRunner Durable Object (workers/sync/src/analysis/)
   ▼
relevance check ── claude-haiku-4-5, titles in batches of 25 (relevance.js)
   │   ceremonial or routine → skipped, logged with the reason (un-skip at /admin/review)
   │   the rest rated for local relevance → ranks the daily queue
   ▼
bill text ── Congress.gov text versions (federal) / leginfo (California)
   │         no text? the official summary, marked "limited: based on summary only."
   ▼
draft ── claude-sonnet-5-5: a short card by default; a full analysis when an issue
   │     links to the bill or someone asks (fixed JSON shapes, full Constitution in the prompt)
   ▼
checks ── every Constitution quote vs. the stored text (mismatches replaced, logged)
       └─ every case vs. CourtListener citation lookup (unverified cases removed with
          every sentence relying on them, logged)
   ▼
AI reviewer ── claude-sonnet-5-5, five-point checklist against the bill text (review.js)
   │   pass → published: "AI-drafted, auto-checked" (10% also go to the queue as spot checks)
   │   flag → hidden, in the review queue with the reasons
   ▼
/laws/bills/<id>/ ── "Something wrong?" (reader flag → queue, "Under review") and
   │                 "Request full analysis" (Turnstile, per-visitor limits)
   ▼
/admin/review (behind Cloudflare Access) ── queue: flagged by AI, flagged by readers,
    spot checks; agreement rate; approve, edit, reject, regenerate ──▶ "Reviewed by [name], [date]"
```

## Which bills, and in what order

- **Eligible:** bills with a final-passage vote by one of our officials, and bills an approved issue link points to. (Once residents can follow bills, followed bills join; the query has a TODO for it.)
- **Relevance check** (`src/analysis/relevance.js`, `claude-haiku-4-5-20251001`): one call per 25 bills, by number and title only. It skips commemorations, awareness days, post office and building namings, honorary resolutions, and rules that only set how a chamber debates another bill. When unsure, it analyzes. It also rates local relevance (`high`: California, rural counties, federal lands, water, wildfire, roads, local government…; `medium`, `low`, `none`), by subject only. Every verdict is in `bill_relevance`; every skip is logged as a `relevance-skip` row in `sync_log`, and the bill page says why it wasn't analyzed. Issue-linked bills skip the check.
- **Order:** requests (yours first, then readers'), then bills an issue now links to whose analysis is only a card, then new bills: issue-linked first, then by local relevance, then by the latest final-passage vote.
- **Un-skip:** `/admin/review/#skipped` lists every skipped bill with its reason. Un-skip drafts it on the next run; "Skip again" undoes that.

## Two levels

- **Short card** (default, `CARD_INSTRUCTIONS` in `prompt.js`): a 2 to 3 sentence summary; the 1 to 3 most relevant provisions, one sentence each (extra provisions are cut and logged); one sentence each for aligns, tension and departure; readings only when genuinely contested. Stored in the same columns as a full analysis (`depth = 'card'`).
- **Full analysis** (`INSTRUCTIONS`): the earlier format. Written when an approved issue link points to the bill, when a reader presses "Request full analysis", or when you ask from the review page.
- Both get the same checks: exact quotes from the stored text, and every case checked against CourtListener.

## The AI reviewer

`src/analysis/review.js` reads the checked draft against the bill text (and the Constitution) and answers:

1. Is the summary accurate and complete for what the bill does?
2. Is any side's argument noticeably weaker or less charitable than the other's?
3. Is opinion stated as fact, or is there loaded or partisan language? (Any verdict on constitutionality fails this.)
4. Are the chosen provisions relevant, with nothing obviously missing?
5. Does anything claim more certainty than the sources support?

It passes only if every check is fine; a missing answer counts as a failure. **Pass:** published as "AI-drafted, auto-checked", linked to the methodology page. **Flag:** off public pages, in the queue with the reasons at the top. A refusal or unusable answer is a flag. A failed call (network, timeout) leaves the draft unreviewed and hidden; it's reviewed on the next run (`REVIEW_BACKLOG_DAILY`, default 10 a day, also covers drafts written before the reviewer existed).

**Drafts from before this change:** on the first run, each pending draft goes through the relevance check and the AI reviewer. Ceremonial ones are rejected automatically (the history says why); passes are published as auto-checked; flags go to the queue.

## Reader flags and full-analysis requests

Every published analysis has **Something wrong?** (inaccurate, unfair to one side, missing perspective, other, plus an optional note) and, for cards, **Request full analysis**. No account. Both use Cloudflare Turnstile and per-visitor daily limits (5 reports, 3 requests; `READER_FULL_REQUESTS_DAILY`, default 10, caps readers' requests site-wide). The visitor is a SHA-256 of their address, the day, and `VISITOR_SALT`: it changes daily and can't be turned back into an address. A report sends the analysis to the queue; it stays up marked "Under review" until you approve, edit and approve, reject, or "Keep as is and close reports". A new draft closes the old one's reports.

### Turnstile setup

1. Cloudflare dashboard → **Turnstile** → **Add widget**. Name `The Pillory`; hostnames `thepillory.co` and `thepillory-web.pages.dev`; widget mode **Managed**.
2. Pages project `thepillory-web` → Settings → **Variables and Secrets**, for Production and Preview:

   | Name | Value |
   |---|---|
   | `TURNSTILE_SITE_KEY` | the widget's site key (plain text) |
   | `TURNSTILE_SECRET_KEY` | the widget's secret key (**Secret**) |
   | `VISITOR_SALT` | any long random string (**Secret**) |
   | `READER_FULL_REQUESTS_DAILY` | optional, default `10` |

3. Redeploy. Until the keys are set, the forms say they aren't open yet and posts are refused.

Preview deployments use `*.thepillory-web.pages.dev` hostnames; add `thepillory-web.pages.dev` to the widget (subdomains are covered) or use Cloudflare's test keys on Preview.

## Spot checks and the agreement rate

A random `SPOT_CHECK_RATE` (default `0.1`) of passed drafts also go to the queue as **Spot checks**; they stay public meanwhile. Each decision on a draft the AI reviewer looked at records whether you agreed with it (`human_agrees`): it passed and you approved unchanged, or it flagged and you rejected or edited. The review page shows the running rate, overall and split by passes and flags.

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
- **Order:** see "Which bills, and in what order" above.
- **Daily cap:** `ANALYSIS_DAILY_LIMIT` in `workers/sync/wrangler.toml` (currently `5`). Set it to `"0"` to pause drafting.
- **Retries:** a bill that can't be drafted (no text or summary, a model refusal, an error) is retried after 7 days.
- **Other settings in `wrangler.toml`:** `ANALYSIS_MODEL` (default `claude-sonnet-5-5`), `ANALYSIS_EFFORT` (default `high`), `MAX_BILL_TEXT_CHARS` (default 400,000; longer texts are cut and the draft is marked "limited"), `RELEVANCE_MODEL` (default `claude-haiku-4-5-20251001`), `REVIEW_MODEL` (default `claude-sonnet-5-5`), `REVIEW_EFFORT` (default `medium`), `SPOT_CHECK_RATE` (default `0.1`) and `REVIEW_BACKLOG_DAILY` (default 10).

**Cost, roughly:** each draft sends the Constitution (about 12,000 tokens, cached across the drafts in a run) plus the bill text, and gets back a few thousand tokens (a card, fewer). The AI reviewer sends the bill text again with the draft, at `medium` effort. At claude-sonnet-5-5 prices ($2 per million input tokens, $10 per million output), a typical bill costs about $0.05 to $0.40 for draft and review together; the longest bills up to about $2. The relevance check costs a fraction of a cent per 25 titles. The daily cap bounds the total. Every call's token counts are in `sync_log` and on the review page.

**Refusal fallback:** the request opts into the API's server-side fallback (`fallbacks: "default"`). If the model declines on certain safety categories, the API retries on another model in the same call. The model that actually wrote a draft is saved with it and shown on the page.

## Agenda watch

For each new county agenda (Board of Supervisors, Planning Commission), one Claude API call writes 2 to 3 neutral sentences per item and flags items in five areas: budget, land use, fees and taxes, public safety, public access and meetings. It also suggests links to existing issues.

- **Source:** only the official agenda's items, their sections, and their attachment titles.
- **Checks:** a sentence stating a number, amount or date that the item's own agenda text doesn't contain is removed and logged. Unknown item numbers are dropped. Flags and issue slugs are limited to fixed lists.
- **Label:** "AI-drafted from the official agenda", with a link to the source, until a person approves it.
- **Links:** issue links start as `suggested` and show only once approved at `/admin/review/`.
- **Order:** agendas someone asked to regenerate at `/admin/review/` first, then upcoming meetings (soonest first), then meetings from the last `MEETING_BACKFILL_DAYS` (30, latest first).
- **Limits:** `AGENDA_DAILY_LIMIT` (default 3), separate from the bill limit. The prompt version is `AGENDA_PROMPT_VERSION` in `src/analysis/agenda.js`.

Tables: `agenda_summaries` (every version kept), `agenda_summary_revisions`, `item_issue_links`, `agenda_requests` (migration `0003_meetings.sql`).

## Reviewing

`/admin/review/` is a queue, in three parts, each showing why an analysis is there:

- **Flagged by AI:** the AI reviewer's reasons. Hidden from public pages until you decide.
- **Flagged by readers:** each report's reason and note. Public, marked "Under review".
- **Spot checks:** a random share of passes. Public.

Below: your agreement rate with the AI reviewer, every analysis by status (published and auto-checked, reviewed by you, waiting for the AI reviewer, rejected), the bills the relevance check skipped (with un-skip), agenda summaries and suggested issue links.

Each analysis's page shows why it's in the queue, then:

- the public preview, and the AI reviewer's full checklist
- what the automatic checks changed (every replaced quote, every citation lookup, every removed sentence)
- reader reports, open and closed
- an edit form for every field
- **Approve** ("Reviewed by [name], [date]"), **Reject**, **Return to draft**, **Ask for a new draft**, **Ask for a full analysis** (cards), **Keep as is and close reports** (open reader reports). Approving or rejecting also closes open reports.
- the full version history

When you save an edit, Constitution quotes are checked again against the stored text, and cases must link to their CourtListener page.

## Tables (workers/sync/migrations/0002_analysis.sql, 0004_review_load.sql)

- `constitution_provisions`: the text, by ID.
- `bill_analyses`: one row per draft. It holds every field, plus `model`, `prompt_version`, `quote_check` and `citation_check` (JSON logs), token counts, `status` (`ai_draft` / `reviewed` / `rejected`), `reviewer`, `reviewed_at` and `created_at`. Regenerating adds a new row and marks the old one `current = 0`.
- `bill_analysis_revisions`: every create, edit, approval, rejection, reopen and supersede, with a snapshot of the row as it was.
- `analysis_requests`: regeneration requests from `/admin/review`.
- `analysis_attempts`: bills that couldn't be drafted, and when they were last tried.
- `bill_analyses` also has `depth` (`card` / `full`), `ai_review` (`pass` / `flag` / NULL), `ai_review_detail` (the checklist and reasons), `ai_review_model`, `ai_review_tokens`, `ai_reviewed_at`, `spot_check` and `human_agrees`. `analysis_requests` has `depth` and `source` (`admin` / `reader`).
- `bill_relevance`: one row per checked bill: verdict, category, reason, local relevance, model, and any un-skip.
- `analysis_flags`: reader reports: reason, note, open or resolved, and how.
- `public_actions`: per-visitor counts for the rate limits (the daily hash only).

## Testing

- `node workers/sync/test/verify.test.mjs`: the quote and citation checks, against the real stored text and fake drafts. Cases include a wrong quote, a made-up case, a real citation under the wrong name, and a lookup outage.
- `node workers/sync/test/access.test.mjs`: the `/admin` token check.
- `node workers/sync/test/review.test.mjs`: the relevance check's answer cleaning, the reviewer's verdict (a failed or missing check always flags), and cards.
- `workers/sync/test/run-local.sh`: end to end with fake APIs (`fixture-server.mjs`: a fake Claude API for drafts, cards, the relevance check and the reviewer, a fake CourtListener and a fake Turnstile). It covers a skipped post office naming, a flagged draft, a legacy draft rejected as ceremonial, an issue link that makes a full analysis, and reader reports and requests. Then the site at `http://localhost:8790` with `/admin/review/` open locally.
- **Real bills:** the **Real-bill analysis** GitHub workflow drafts the 3 newest bills with House final-passage votes and prints them in the run summary, saving nothing. It needs the repository secrets `ANTHROPIC_API_KEY`, `COURTLISTENER_API_TOKEN` and `CONGRESS_API_KEY` (GitHub → Settings → Secrets and variables → Actions). It runs when a pull request gets the label `run-real-analysis`, or from the Actions tab.
