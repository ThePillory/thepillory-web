# Reporting pilot: Calaveras County (plan)

**Status: plan only. Nothing here is built yet.** The seven open questions were answered on October 27, 2026; see "Decisions" at the end. One thing is still open: your check of the public bodies list.

## The pilot in one line

20–40 Calaveras residents you invite, reporting on **county government only**, every report reviewed by a person before it's public, for about 8 weeks starting after the November 3 election.

It follows the principles in CLAUDE.md: facts first, evidence first, protected identities (no name, address or ID is ever shown, to anyone but you), public roles only, and a resident's perspective kept separate from the facts.

## What's already there

- **Report tab** (`/report/`) and **Issues** (`/issues/`): static pages from `tools/build.py` that say reporting opens when accounts launch. They stay exactly as they are for everyone outside the pilot.
- **Approved-only links**: `item_issue_links` (agenda items ↔ issues, migration 0003) and `issue_bill_links` (migration 0001) already show only links a person approved. The pilot reuses `item_issue_links` for "this issue is on the Board's agenda".
- **Meetings**: the county's Board of Supervisors and Planning Commission agendas, with comment instructions copied verbatim from the agenda PDF. The pilot links to these; it never rewrites them.
- **Admin**: `/admin/...` is behind Cloudflare Access, checked again in code (`functions/_lib/access.js`, fails closed). The review queue reuses this.
- **Abuse limits**: Turnstile and daily per-visitor limits from the corrections and flag forms (`functions/_lib/turnstile.js`).
- **Storage**: an R2 bucket exists (`SOURCES`), but it's bound to the sync Worker and holds public documents. Reports need their own **private** bucket bound to the Pages project.

Nothing yet: accounts, sessions, uploads, image processing, or any page that shows per-person content.

## Who can do what

| Who | Can |
|---|---|
| Anyone | Read approved reports and issues; see "Verified resident · Calaveras County". Same Report tab as today if not in the pilot. |
| Invited, not yet verified | Sign in, read the rules, nothing else. |
| Verified Calaveras resident (you mark them) | Submit reports, see and edit their own, choose a later publish date, mark "I've seen this too" and "This affects me" on others' approved reports, delete their account. |
| Reviewer (you, and a second reviewer) | Everything in `/admin/`: invite and verify accounts, review reports, group issues, link agenda items, enter agency responses, see metrics. Emails are visible only here. |

Officials and agencies never see who reported anything, and neither does any other user.

## Accounts and sign-in

**Invite links, no passwords, no email sent by the site.** You create an invite on `/admin/accounts/` (an email address, and optionally which supervisor district they live in, for your own coverage tracking, never shown). The page gives you a one-time link (`/join/<token>`, 32 random bytes, valid 14 days) that **you send yourself** (text or your own email). Reasons:

- Cloudflare's email sending only reaches addresses verified in advance, so the site can't email arbitrary invitees without a third-party email service. For 40 people, you sending the link is simpler, free, and keeps the email list off any other service.
- Opening the link signs the person in on that device: a session cookie (`HttpOnly`, `Secure`, `SameSite=Lax`, 90 days). A lost phone or a new device: you issue a fresh sign-in link from the same page. No passwords to leak or reset.
- Tokens are stored only as SHA-256 hashes, so a database leak doesn't give anyone a working link.

**Verified resident by hand.** After you've confirmed the person lives in the county (you know them), you press "Mark verified resident" on their account. That records who verified and when. No ID, address or document is collected.

**What's stored per person:** email (lower-cased, kept for the whole pilot, since it's how a lost device gets a new sign-in link), status (invited, active, verified, suspended, deleted), who verified them and when, the optional supervisor district you entered, and the date (not time) of last use. **Never** a name, address, phone, IP address, or device details. Server logs don't record request bodies.

**Signed-in pages are never cached.** Any request with a session cookie is served `private, no-store`, and `functions/_middleware.js` must skip its edge cache for it. This is the most important security detail in the build: a cached signed-in page could show one person's drafts to another. The build adds a test for it.

## The report

One page, works without JavaScript, in four parts (the order follows "facts first"):

1. **What happened** (required, facts only, up to 2,000 characters). A hint under the box: "What you saw or what the record shows. Who, in a public role, did what, and when. Save opinions for the last section."
2. **Where and when** (required): a place description ("Hwy 4 near Murphys", "the Board chambers", "Mokelumne Hill library"), never a home address, and a date (time optional).
3. **Which public body**: one choice from the pilot's list of Calaveras public bodies (see "Public bodies" below), or "Not sure" (you assign it in review).
4. **Evidence** (at least one is strongly encouraged; the reviewer can still approve a report without it if the facts are checkable): photos, PDFs or links (see "Evidence" below).
5. **Why it matters to me** (optional, up to 1,000 characters), labeled "Perspective" and shown in its own box under the facts, never mixed in.

Then one optional choice: **When to publish**: "As soon as it's approved" (the default) or "Wait until [date]", a date no more than 14 days after approval (for example, until after a meeting). See "Publish date" under Review.

Each report keeps every version (the reporter's edits after "request changes" are new versions; the reviewer never rewrites a report's words, see Risks). A reporter can withdraw a report until it's approved, and ask for removal after.

**Limits:** 5 reports a day per account, Turnstile on submit, and the same daily visitor hash the corrections form uses.

### Public bodies

A hand-written list, `data/reporting/calaveras-bodies.json`, each entry with a slug, the name, the county's own page for it (the source link) and, where it holds public meetings, the matching meeting body so issues can link to agenda items. A first draft for you to correct:

- Board of Supervisors (and each supervisor, by district: public role)
- Planning Commission
- Public Works (roads, bridges)
- Planning Department / Building (permits)
- Environmental Health
- Office of Emergency Services
- Library
- Other county department (named in the report)

**Out of scope for the pilot** (decided): the Sheriff's Office and Elections (the County Clerk-Recorder's elections work), to revisit after the pilot; state agencies that work in the county (CAL FIRE, Caltrans); and special districts (fire districts, water districts, schools). Their boards and records aren't loaded yet, and keeping the pilot to the rest of county government keeps review manageable.

**Still open:** you check this list against how Calaveras actually organizes its departments (names, which ones residents deal with, the county page for each) before step 2 writes the file.

### Evidence

- **Links**: any `http(s)` URL; shown as a link with its domain. Public records (the county's site, agendas) are the best evidence.
- **Photos** (JPEG, PNG, WebP; up to 10 MB, 4 per report):
  - **In the browser** before upload, the image is redrawn on a canvas and re-saved as JPEG, which drops all hidden data (EXIF, GPS location, camera serial number). Large photos are scaled to at most 2,400 px.
  - **On the server**, regardless of what the browser did, the file is checked by its first bytes (not its name) and stripped again: JPEG APP1 (EXIF and XMP), APP13 (IPTC) and comment segments; PNG `eXIf`, `tEXt`, `iTXt`, `zTXt` and `tIME` chunks; WebP `EXIF` and `XMP ` chunks. Then it's parsed once more, and **refused if any location tag is still there**. This is plain byte handling in a Pages Function (no image library is needed, and Functions can't use npm packages).
  - iPhone HEIC photos: Safari already converts them to JPEG when a page asks for an image; anything still HEIC is refused with a plain message.
  - The original filename is dropped; files are stored under a random key.
  - **Faces, license plates, house numbers**: no automatic blurring. The rules say not to photograph private people, and the reviewer declines or asks for a re-crop. A simple crop tool on the form is a later improvement.
- **PDFs** (up to 20 MB, 3 per report): the document information fields (Author, Creator, Producer, Title) and the XMP metadata block are overwritten in place with blanks (same length, so the file stays valid), then checked. The reviewer sees what was removed. A PDF that's itself a public record is better linked than uploaded.
- **Storage**: a new private R2 bucket, `pillory-reports`, bound to the Pages project. Files are served only through a Function that checks the report is approved (or the viewer is its author or a reviewer), with a fixed content type, `X-Content-Type-Options: nosniff`, and `Content-Disposition` set. No SVG, HTML or other active formats, ever.

## Review

`/admin/review/reports/` (Cloudflare Access), oldest first, with how long each has waited (target: 48 hours).

Each report shows the facts, perspective, evidence (with what metadata was removed), the body, the account's verified status (not the email, which is one click away on the account page, so review stays about the report), and the reporter's other reports. Three actions, each needing a reason:

- **Approve**: published as "Verified resident · Calaveras County", with the date it was published: at once, or on the reporter's chosen date.
- **Request changes**: the reason goes to the reporter (on their My reports page); they edit and resubmit. The reviewer never edits the words.
- **Decline**: the reason goes to the reporter; the report stays private.

A checklist on the review page, the same for every report: public body or public role only; no private person named or pictured; no home address or other identifying detail about anyone, the reporter included; facts separate from perspective; evidence supports the facts; nothing that could identify the reporter by accident (a photo from their own window, "my neighbor at …").

Later actions: **remove** an approved report (with a reason; logged publicly as "Removed on [date]: [reason category]", never who asked) and **restore**.

**Publish date.** If the reporter chose "Wait until [date]", the review page shows it beside the actions. The report publishes on that date, or at approval if the date has already passed; a date more than 14 days after approval is capped at 14 days, and the reporter is told so on My reports. Until then the report is "Approved · publishes [date]": not on any public page, its files not served, not counted on an issue. On My reports the reporter can publish it now or move the date earlier, never later. A report waiting to publish doesn't appear anywhere public, so there's nothing to schedule: pages check `publish_on` when they're built, and the edge cache's 5 minutes is the only lag.

Every action is a row in `pilot_reviews` (who, what, when, reason): the audit trail and the source of the review-time metric.

**Two reviewers, built in from the start.** The queue, recusal and the audit trail all assume two reviewers, even while you're the only one: each reviewer can mark themselves recused on a report (for example, about a relative's department), and it waits for the other. With only one reviewer, a recused report shows "Waiting for a second reviewer" in the queue. Both reviewers are on the Access allow list for `/admin/`. **A second reviewer is required before the pilot goes past 20 members**: `/admin/accounts/` refuses a 21st invite while only one reviewer is listed (the list is the `PILOT_REVIEWERS` setting, the same emails as the Access policy).

## Public view

- **Report page** (`/reports/<id>/`, a random id, so ids don't reveal counts or order): the body, place and date, the facts, the evidence, then "Perspective" in its own box, then "Verified resident · Calaveras County · Approved [date]". Counts of "I've seen this too" and "This affects me". If it's part of an issue, a link to it. Shown only from its publish date.
- **Issue page** (`/issues/<slug>/`): a short neutral title and summary that you write (facts only), the reports in it (oldest first), the combined counts, the responsible body, then:
  - **On the agenda**: Board or Planning Commission items linked through approved `item_issue_links` (as now), each with the meeting date and **the public comment instructions copied verbatim from the agenda**, plus the comment deadline.
  - **Response**: a response from the county body, entered by you only with its source (a letter, an email from a public address, meeting minutes, a quote from a meeting video with its time), word for word, labeled "Response from [body]".
  - Status: Open, On an agenda, Responded, Resolved (with the evidence), Closed.
- **Issues list** (`/issues/`): becomes a Function when the pilot is on; until then, the current static page.
- **Corroboration**: "I've seen this too" and "This affects me", one each per verified account per report, never on your own report. Only verified pilot accounts can press them, so outside brigading can't move the counts (decided). Visitors see the counts, and the buttons are replaced by a line saying only pilot members can mark them. Counts are shown as numbers only; who pressed them is never shown.
- **Grouping**: you group reports into issues on `/admin/issues/`; nothing is grouped automatically.

No comments, replies or ranking of reports in the pilot.

## The Report tab

`/report/` becomes a Function (`functions/report/`). With the pilot on (`REPORTS_PILOT=on` on the Pages project) and a signed-in, verified account: Start a report, My reports (status and the reviewer's reason), the rules. Everyone else, including signed-in but unverified accounts and anyone when the pilot is off: today's static page, served unchanged through `env.ASSETS`.

## Community rules and privacy (drafts for the lawyer)

The build starts by writing two drafts, `docs/reporting-rules-draft.md` and `docs/reporting-privacy-draft.md`, for the lawyer to review. They become public pages (`/about/reporting-rules/`, `/about/privacy/`, generated by `tools/build.py`) only after that review.

**Rules** (draft outline): what you can report (public bodies and public roles in Calaveras County; contractors only as part of a public decision); facts first, perspective in its own section; evidence; never private people (no neighbors, no businesses as such, no family members of officials), no home addresses, no photos of private people or private property interiors; no harassment, threats or calls to action against a person; no campaign content; what gets declined or removed, and how to ask for a correction; that reviewers don't edit your words; that approval means it met the rules, not that ThePillory has verified every claim.

**Privacy** (draft outline): what's stored (email, account status, your reports and reactions, review decisions), what isn't (name, address, IP, location from photos), who can see what (only reviewers see emails; nobody outside sees who reported), how photos are cleaned, how long things are kept, how to delete your account, and what you'd do with a legal demand for a reporter's identity (the lawyer's question).

## Account deletion

"Delete my account" on the You tab, confirmed once. Immediately: email, sessions and invite records erased; pending reports and drafts (and their files) deleted; the person's corroborations and "affects me" marks removed (counts go down).

**Approved reports**: one checkbox on the delete page, **"Also remove my published reports"**, checked by default (decided):
- **Checked**: their approved reports (and any waiting for their publish date) are unpublished and their files deleted. An issue they were part of stays up with its remaining reports, and shows a public removal note ("A report was removed by its author on [date]"). An issue left with no reports keeps its title, summary, agenda links and responses, and says "No reports remain on this issue."
- **Unchecked**: their approved reports stay, with no link back to any account. The account id is cleared, so there's nothing left to connect them to anyone, even for you.

Deleted accounts can't be restored; you'd send a new invite.

## Pilot metrics

`/admin/pilot/` (Access), for the 8-week review:

- **Accounts**: invited, signed in, verified, active in the last 14 days; coverage by supervisor district (from what you entered).
- **Reports**: submitted, approved, changes requested, declined (with reason categories), withdrawn, removed.
- **Review time**: median and longest, from submitted to the first decision.
- **Corroboration**: reports with at least one "seen this too"; total marks.
- **Issues**: issues created, issues linked to an agenda item, issues with a response, issues resolved.
- **Bodies**: reports per public body.
- **Problems**: rule-breaking submissions caught in review, by rule.

All computed from the tables; no tracking scripts, no analytics service.

## Data model

One migration, `0044_reporting_pilot.sql`. All tables are prefixed `pilot_`, so the pilot can be dropped or migrated cleanly afterward.

| Table | Columns (main ones) |
|---|---|
| `pilot_accounts` | `id`, `email` (unique, lower-cased), `status` (invited / active / verified / suspended / deleted), `verified_by`, `verified_at`, `district` (optional, 1–5, reviewers only), `created_at`, `last_seen_day`, `deleted_at` |
| `pilot_tokens` | `hash` (SHA-256), `account_id`, `kind` (invite / session), `created_at`, `expires_at`, `used_at` |
| `pilot_reports` | `id` (random), `account_id` (NULL once detached), `body_slug`, `status` (draft / submitted / changes_requested / approved / declined / withdrawn / removed), `version`, `submitted_at`, `decided_at`, `approved_at`, `publish_wanted` (the reporter's date, or NULL), `publish_on` (set at approval: the later of approval and `publish_wanted`, at most 14 days after approval; public pages show a report only when `publish_on` ≤ today), `issue_id` |
| `pilot_report_versions` | `report_id`, `version`, `what`, `place`, `happened_on`, `happened_time`, `why`, `created_at` (every edit kept) |
| `pilot_evidence` | `id`, `report_id`, `kind` (photo / pdf / link), `r2_key` or `url`, `mime`, `bytes`, `sha256`, `removed_metadata` (what was stripped, as JSON), `created_at` |
| `pilot_reviews` | `id`, `report_id`, `action` (approve / request_changes / decline / remove / restore / recuse), `reason`, `reviewer`, `at` |
| `pilot_reactions` | `account_id`, `report_id`, `kind` (seen / affects), `at`; unique per account, report and kind |
| `pilot_issues` | `id`, `slug`, `title`, `summary`, `body_slug`, `status`, `created_by`, `created_at` |
| `pilot_responses` | `id`, `issue_id`, `body_slug`, `text` (verbatim), `source_url` (required, http(s)), `received_on`, `entered_by` |
| `pilot_removals` | `id`, `report_id`, `on`, `category` (public log; never who asked) |
| `pilot_limits` | `account_id`, `day`, `count` (daily submit limit) |

`item_issue_links.issue_slug` points at `pilot_issues.slug` for agenda links, so the existing approval rules apply unchanged.

## Pages and endpoints

| Path | What | Who |
|---|---|---|
| `/join/<token>` | Redeem an invite or sign-in link; sets the session | Invitees |
| `/report/` | The pilot's start page, or today's page | Everyone (gated) |
| `/report/new/`, `/report/<id>/edit/` | The form | Verified accounts |
| `/report/mine/` | My reports, status and reasons, withdraw, publish now or earlier | Signed-in accounts |
| `/reports/<id>/` | An approved report | Everyone |
| `/reports/<id>/files/<file>` | Evidence files | Everyone if approved; else the author and reviewers |
| `/issues/`, `/issues/<slug>/` | Issues | Everyone |
| `/you/account/` | Sign out, delete account | Signed-in accounts |
| `/admin/accounts/` | Invite, sign-in links, verify, suspend | Reviewers |
| `/admin/review/reports/` (and `/<id>/`) | The queue | Reviewers |
| `/admin/issues/` | Group, write, link agenda items, enter responses | Reviewers |
| `/admin/pilot/` | Metrics | Reviewers |
| `POST /api/reports`, `/api/reports/<id>/evidence`, `/api/reactions`, `/api/account/delete` | Writes | As above, with origin check and a per-form token |

`functions/_lib/crawl.js` (`KNOWN`) gets any new query parameters. Every pilot path, report and issue pages included, is `noindex` for the whole pilot (decided): a `noindex` robots tag on the page and an `X-Robots-Tag: noindex` header, and `/reports/` added to `robots.txt`. Revisit when the pilot's results are reviewed.

## Risks

**Legal**
- **Defamation is the main exposure**: reports about named officials. In the pilot, a person reviews every report before it's public, which also makes ThePillory more involved in what's published. Questions for the lawyer: how pre-publication review and "request changes" interact with Section 230 (the plan never edits a report's words, only approves, declines or asks the author to change it); California's anti-SLAPP law; the wording of "approval means it met the rules, not that every claim is verified"; the removal process.
- **A legal demand for a reporter's identity**: you hold only emails. The lawyer should advise on notice to the reporter and on retention (keep less, for less time).
- **Copyright**: photos and documents people upload. Public records are fine; the rules ask people to upload only what they took or what's a public record.

**People**
- **A small county means reporters can be recognized** from details or photos, even without a name. The review checklist covers this, and a reporter can choose a publish date up to 14 days after approval.
- **Harassment of officials or staff**: public roles only, no home addresses, no family members, no calls to action against a person; repeat offenders suspended.
- **Looking partisan**: invite across districts and political leanings; neutral wording; no campaign content; reviewer recusal; starting after the election.
- **Reviewer load and burnout**: 40 people may produce more than expected; the 48-hour target is a target, and the metrics show it. A second reviewer is required before going past 20 members.
- **Emergencies**: the form says "If someone is in danger, call 911. This isn't monitored in real time."

**Technical**
- **Cached personal pages** (see Accounts): the middleware bypass and a test are part of step 3.
- **Hidden photo data**: stripped twice, then checked; test images with GPS tags in the test suite.
- **Uploaded active content**: no SVG/HTML, files checked by their bytes, served with a fixed type and `nosniff`.
- **Session theft**: `HttpOnly`, `Secure`, `SameSite=Lax`, hashed tokens, sign out everywhere from the account page.
- **Spam or a compromised account**: invite-only, daily limits, Turnstile, suspend.

## Build order (small steps, each its own PR)

1. **Rules and privacy drafts** (`docs/reporting-rules-draft.md`, `docs/reporting-privacy-draft.md`) for the lawyer. No code.
2. **Migration 0044** and the `REPORTS_PILOT` and `PILOT_REVIEWERS` settings (off, and your email). Tables only, nothing reads them yet. The bodies list (`data/reporting/calaveras-bodies.json`), from your corrected list.
3. **Accounts**: `/admin/accounts/` (invite, sign-in link, verify, suspend; the 20-member cap while only one reviewer is listed), `/join/<token>`, sessions, sign out, the middleware cache bypass, tests (including "a signed-in page is never cached").
4. **The report, text only**: the form (with the publish date), My reports, the review queue (approve / request changes / decline, recusal for two reviewers), review history. Still off for everyone but test accounts.
5. **Evidence**: links; photos (browser re-save plus server stripping and the location check, with test images); PDFs (metadata blanking); the private R2 bucket and the file Function.
6. **Public pages**: report pages, the Report tab gate, issues as Functions, "I've seen this too" and "This affects me".
7. **Issues admin**: grouping, agenda item links (approved, as now) with the verbatim comment instructions, agency responses, statuses.
8. **Account deletion** (the "Also remove my published reports" checkbox), the public removal log, a CLAUDE.md section on the pilot's rules.
9. **Metrics** (`/admin/pilot/`).
10. **Dry run**: you and the second reviewer as test reporters for a week, on the live site with the pilot on but no invites; fix what's awkward; then the first 20 invites. Invites past 20 wait for the second reviewer.

Steps 1–2 can be done in a day; 3–7 are the bulk of November; 8–10 before the first invites in early December.

## Cost

About $0 in services: D1 and R2 within the free tiers at this size (a few hundred photos is well under 1 GB), Turnstile free, no email service. The real costs: your review time, and one hour with a media lawyer. ID checks (Stripe Identity, about $1.50 each) wait for the wider opening.

## Decisions

Answered on October 27, 2026:

1. **Two reviewers**: built for two from the start (recusal, the queue, Access). You add the second when you find them; **required before the pilot goes past 20 members**, enforced on `/admin/accounts/`.
2. **Email**: kept for the whole pilot, so a lost device can get a new sign-in link. Deleted with the account.
3. **Public bodies**: the Sheriff's Office and Elections are left out of the pilot (revisit after). CAL FIRE, Caltrans and special districts stay out. **Still open:** your corrections to the rest of the list, before step 2.
4. **Corroboration**: only verified pilot members can tap "I've seen this too" and "This affects me". Visitors see the counts.
5. **Deletion**: a checkbox, "Also remove my published reports", checked by default. Issues keep their remaining reports.
6. **Publish date**: a reporter can choose a publish date up to 14 days after approval (`publish_wanted`, `publish_on`).
7. **Search engines**: report and issue pages stay `noindex` for the whole pilot.
