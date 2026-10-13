# Accuracy audit, October 12, 2026

Read-only: `tools/accuracy_audit.py` read D1 and the sources and changed nothing. Section 1 (hand-entered data) is from the first run (22:14 UTC); sections 2–5 from the second (22:18 UTC), after the audit's own false alarms were fixed (honorifics and party tags in names, pages built by JavaScript, quotes wrapped in quotation marks, cut-off digests in the audit's query). Nothing here has been fixed yet.

Ranked by how many people see it, then how wrong it is.

## Already fixed

**Ballot preview listed every FEC filer as the ballot** (Texas showed 16 U.S. Senate candidates). Fixed in PR #102: after a state's primary (and runoff), the preview, race pages and candidate pages no longer present the FEC list as the ballot; it's a separate "Filed with the FEC in 2026" list that says it's not the ballot. Finding a source for nominees in every state is still open (see the options already sent).

## 1. Most bill pages have no summary at the top (very visible; missing, not wrong)

Of 76,673 bill pages with a recorded vote (every bill a list can reach):

| Summary at the top | Bills |
|---|---|
| Shown | 2,794 (3.6%) |
| Empty | 73,873 (96.3%) |
| Too short to be a summary | 6 |

- **Every state but California has no summary source loaded** (TN 6,857, HI 5,255, NY 4,666, IL 4,653, VA 4,259, OK 2,451, MD 2,413, TX 2,345 …). Open States' session files carry titles and sometimes an abstract; we don't show either as a summary.
- **California: 2,585 empty**, plus 2 whose "This bill …" sentence means nothing alone ("This bill would repeal that prohibition.", AB 1912, AB 264).
- **Federal: 3 short**, each a complete sentence ("This resolution censures Representative …"), so they're fine.
- **Corrected, October 13:** the first version of this report said some federal summaries were cut off at a middle initial ("D.C. Robert F."). That came from the audit's own sentence splitter, not the page's. The page's splitter keeps those names whole, and the audit now uses the same rule. Military ranks ("Lt. Gen.") did end a sentence on the page; they no longer do.
- **Found on the rerun, fixed:** once a bill becomes law, the CRS summary opens with the law's title and then "This act …". The page looked only for "This bill …", so the title ran into the first sentence ("Never Again Education Reauthorization Act of 2023 This act extends …"). The page now starts at "This act" too.

## 2. State votes lag or are missing (visible on state pages; stale, not wrong)

Congress: the Senate is current (newest roll call September 30 both here and on senate.gov). The House's newest here is September 16; the Clerk's site didn't load from GitHub, so that one is unverified.

States that need a look (a legislature out of session is normal; these aren't explained by that):

| State | Newest vote here | Why it looks wrong |
|---|---|---|
| New Jersey | 2025-12-22 | The 2026–27 session began in January; none of it is loaded. |
| Alabama, Arkansas, Kansas, Puerto Rico | none | No bills or votes at all (their pages say "coming soon"). |
| Massachusetts | 2026-07-31 | Only 129 bills for a full-time legislature. |
| Vermont | 2026-05-29 | Only 75 bills. |
| Minnesota | 2026-05-17 | Only 308 bills. |

Texas (newest 2025-09-04), Montana (2025-04-30) and Nevada (2025-11-19) meet in odd years, so those dates are expected. Comparing each state against its own legislature's site isn't automated (50 different sites); this table compares against what a session normally holds.

## 3. Weak source link for the President and Vice President (fixed)

Hand-entered and synced officials: 33 of 35 found by name on the page their entry cites. The two not found are the President and Vice President, whose source link is the congress-legislators README on GitHub, which doesn't name them. The data is right; the link a reader clicks didn't show it. Fixed: the link is now whitehouse.gov's Cabinet page when that page names them, otherwise the `executive.yaml` data file the entry comes from. It changes on the next daily sync.

## 4. Doubled quotation marks in one analysis (visible on one bill)

Constitutional analyses: 85 quotes in 20 published analyses, **0 not word for word** in data/constitution.json. But us-119-hr-3633's quotes are stored wrapped in their own quotation marks, so the page shows them doubled (""To regulate Commerce …""). Nine quotes, one bill.

## 5. One promise quote not found on its source today (one promise)

6 published promises: 1 not found word for word on its govinfo page today: #8 (the President, "I'm announcing that next year, my administration will give these often-forgotten American workers-great people …", DCPD-202600136). Most likely a dash: the quote has a hyphen where the transcript has a dash, which the check at publish time allowed. Needs a person to open it.

Platform excerpts ("In their own words"): 16 shown, **0 not word for word** in the stored page, and 0 missing from the live page today.

## 6. Name matching (no errors found in the samples)

50 matches sampled at random per source, each compared with the name in the original record:

| Source | Matched | Sampled | Real errors |
|---|---|---|---|
| Cal-Access committees → California officials | 537 | 50 | 0 |
| Stock trade reports → members | 2,156 | 50 | 0 (1 flagged: "Greg Steube" → W. Gregory Steube, the same person) |
| LD-203 honorees → officials | 59,139 | 50 | 0 (2 flagged: "Chris Coons", "Rep. Hank Johnson", the same people) |
| Candidates' offices held | 131 | 50 listed | Can't be checked in code |

Candidates' offices held is matched by first and last name among the state's current officials, one match only. The FEC record doesn't say what office a candidate holds, so these 131 need a person (a campaign website usually says). None of the 50 listed looked implausible; each official named is a current officeholder in D1 with a Bioguide or state legislature source. A namesake in the same state is the risk.

**Not sampled:** dark money donors matched to IRS records (exact name and state, one match only) and industry labels (keyword rules, labeled approximate). Both are worth a sample next.

## Known, not re-audited

- The justices' financial disclosures stop at 2022 on CourtListener's bulk files.
- The President's stock trade reports (278-T) aren't read yet; the scanned annual report is being read now.
- Industry labels are approximate by design.

## Suggested order

1. ~~Source links for the President and Vice President~~ (done).
2. ~~Summaries that run a law's title into its first sentence~~ (done).
3. New Jersey's 2026 session, then AL, AR, KS, PR, and the thin MA, VT, MN loads.
4. Strip stored quotation marks from analysis quotes (one bill now; a guard for the future).
5. Promise #8: a person checks the dash.
6. State bill summaries: decide whether Open States' abstracts (where a state publishes one) count as a summary, labeled with their source.
