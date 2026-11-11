# The weekly email: "This week from your representatives"

One email every Sunday at 5:00 p.m. Pacific, covering the seven days that ended Saturday night (Pacific). It lists what the reader's representatives did that week, from the public record, with every line linked to its page on thepillory.co. **It goes to nobody but `ALERT_TO` until `EMAIL_SENDING` is turned on.**

## Who gets what

Readers sign up at `/email/`. An email address is required. Under "Want it personalized?" there are three levels, and a reader can switch levels at any time on Change my place (`/email/manage/?t=`):

| Level | Stored | Districts |
|---|---|---|
| National | the email only | none |
| ZIP | the 5-digit ZIP | from `data/zip/` each time an edition is built, so every district the ZIP touches is included |
| Address | the ZIP from the Census match, plus `st`, `cd`, `su`, `sl` and `co` | exact. The address is used once, for the `/api/districts` Census lookup (`lookupAddress()`), and is **never stored or logged** |

Every email is the same template, with the sections in the same order. A section with nothing new is left out.

1. **In Washington** (everyone): executive orders signed, bills that became law, and Supreme Court opinions.
2. **Your U.S. senators.**
3. **Your U.S. representatives**: every House member the ZIP touches, under "Your ZIP covers Congressional Districts 4 and 5".
4. **Your Governor**: bills signed or vetoed.
5. **Your state legislators**, in states whose votes are loaded. In other states this section is one line: "Coming to [State]: … Join the list ›".
6. **The county**: when the ZIP lies wholly in a live county, its meetings in the next 14 days, with item titles and the comment instructions quoted from the agenda. When the ZIP lies only partly in a live county, this section is one line.
7. **Elections** within 45 days: a link to preview the ballot (`ballotWindow()`).

For each rep, the email lists final-passage votes from the week, plus stock trade and financial disclosure reports filed. A rep with none of these gets one line: "No final-passage votes or new filings this week". The email says "recess" only when the records show one.

**Format:**
- A "Based on…" line under the title, e.g. "Based on ZIP 95247, which covers 2 congressional districts · Make it exact ›".
- At most 15 item lines (`MAX_LINES`), then "See everything for your area on ThePillory ›".
- The subject counts what's inside: "Your representatives this week: 6 votes, 2 county meetings", or "This week in Washington: 3 laws, 2 executive orders".
- The preview line gives the place and the dates.
- Facts only. The only AI text allowed is a plain summary, labeled.
- **A week where every section is empty isn't sent.**

## How it's built

**Signup** (the Pages Functions):
- `functions/email/[[path]].js` serves `/email/`, `confirm/`, `manage/`, `unsubscribe/` and the web version `/email/<week>/<edition key>/`.
- `functions/api/email.js` handles the signup POST: Turnstile, then at most 5 signups a day per visitor hash (`email_signup_attempts`).
- `functions/_lib/email-pages.js`, `email-store.js` and `email-admin.js` hold the pages, storage and admin.

**Double opt-in:** the row waits until its confirmation link is used. Confirm and Unsubscribe are buttons (POST), so mail scanners that open links can't trigger them. Unsubscribe **deletes the row**. An unconfirmed row is deleted 7 days after its confirmation email was sent.

**Sending** is done by the sync Worker, `workers/sync/src/email/`:

| File | What it does |
|---|---|
| `schedule.js` | Pacific time, the send hour, and which week an edition covers |
| `places.js` | Turns a subscriber into a place; edition keys |
| `edition.js` | Builds the sections from D1 and the site's data files |
| `render.js` | Renders the HTML and plain-text versions |
| `send.js` | Rollout, confirmations, sending rounds, the January re-map |
| `runner.js` | `EmailRunner`, the Durable Object that runs the rounds |

**Crons** (in UTC):
- `0 0 * * 1` and `0 1 * * 1` are Sunday 5 p.m. Pacific in daylight time and in standard time. `isSendTime()` keeps only the one that lands at 17:00 in America/Los_Angeles.
- `* * * * *` sends confirmation emails, and handles admin requests (a test or the invitation) within a minute.
- `0 11 * * *` is the daily sync.

**Each edition is built once**, then sent to everyone who shares it. Edition keys are `national`, `zip-<zip>` and `x-<st>-<cd>-<su>-<sl>-<co>`. Editions are stored in `email_editions`, which also serves the web version.

**D1 reads are kept low:** the week's final votes come from the `votes_date` index, then positions are read only for the officials who are needed. The step's D1 rows are recorded in `usage_steps` as `weekly-email`.

**Sending is done in rounds** of up to 300 emails, each recorded in `email_sends`, so a retried round never sends anything twice. The safety alarm works the same way as the sync's.

**Each email has:**
- HTML that fits a phone, in the site's light and dark look, plus a plain-text version.
- The logo as its only image.
- No tracking pixels and no redirect links.
- One-click unsubscribe, via `List-Unsubscribe` and `List-Unsubscribe-Post` (RFC 8058).
- A footer saying why the reader gets it, with Change my place, Unsubscribe, View on the web, and `MAILING_ADDRESS`.

**Admin** (`/admin/email/`, behind Access):
- Counts by level, state and county. No list of email addresses is ever shown.
- A preview of any edition for the coming Sunday (National, a ZIP, or a district set).
- "Send test to ALERT_TO".
- The weeks sent.
- The waitlist invitation.

**The waitlist is not subscribed.** At launch, each waitlist address gets one invitation to sign up. It goes out only when a person sends it from `/admin/email/` (with a confirm checkbox), and only while `EMAIL_SENDING` is on. `waitlist.email_invited_at` records who was invited.

**Data:** migration `0048_email.sql` creates these tables:
- `email_subscribers`: never an address;
- `email_editions` and `email_sends`: pruned after 8 weeks;
- `email_requests`;
- `email_signup_attempts`.

## Setup

1. **Cloudflare Email Service** (Workers Paid). In the Cloudflare dashboard, open Email → Email Sending and onboard `thepillory.co` as a sending domain. The DNS records it adds (SPF, DKIM, DMARC) are needed for delivery. Once the domain is onboarded, mail can go to any address; recipients don't need to be verified. The `[[send_email]] name = "EMAIL"` binding is in `wrangler.toml`, and mail comes from `EMAIL_FROM` (`weekly@thepillory.co`). No API key is needed, and none goes in the repo.
2. **Worker variables** (pillory-sync → Settings → Variables). Set these in the dashboard, not in `wrangler.toml`: a value in `[vars]` would overwrite the dashboard's value on every deploy.
   - `MAILING_ADDRESS`: the postal address the footer requires.
   - `EMAIL_SENDING`: `off` (the default), `pilot` or `on`.
   - `EMAIL_PILOT`: the pilot addresses, separated by commas.
   - `ALERT_TO` is already set; it is the one address that always receives.
3. **Pages variable:** set `EMAIL_SENDING` on Pages as well, to the same value. While it isn't `on`, the signup page says the email "starts soon".

**Costs:** Cloudflare Email Service includes 3,000 emails a month on Workers Paid, then charges $0.35 per 1,000. 1,000 subscribers is about 4,300 emails a month, or roughly $0.50. The weekly build reads the week's votes once for all editions; `/admin/usage/` shows its D1 rows under the `weekly-email` step.

## Rollout

1. `off`: only `ALERT_TO` receives anything. That includes the weekly edition (the National edition if `ALERT_TO` hasn't subscribed), confirmation emails for that address, and tests.
2. `pilot`: also the addresses in `EMAIL_PILOT`.
3. `on`: everyone who confirmed. Then send the waitlist invitation from `/admin/email/` if you want to.

The token-protected Worker routes `/email/status` and `/email/run?week=YYYY-MM-DD` show the state of a run, and start one by hand (the run obeys the same rollout).

## January: new districts

When `CENSUS_VINTAGE` changes (the 120th Congress) and the ZIP workflow has rebuilt `data/zip/`, the next weekly run re-maps every subscriber at the ZIP and address levels from their stored ZIP (`remapIfNewDistricts()`):
- If the ZIP still maps to one set of districts, the subscriber moves to the new districts.
- If the ZIP is now split, the subscriber goes back to the ZIP level and gets one email asking them to confirm their place (`place_check_sent_at`).

## Tests

`workers/sync/test/email.test.mjs` covers:
- each level and each section;
- split ZIPs;
- empty weeks;
- the 15-line cap;
- wording rules;
- signup, confirm, change place and unsubscribe;
- that no address is stored;
- the rollout modes;
- idempotent rounds;
- the Sunday send across both daylight-saving changes;
- the January re-map.
