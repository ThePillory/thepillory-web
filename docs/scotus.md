# The U.S. Supreme Court

The justices, their decisions, this term's cases and their financial disclosures, from official sources only. Pages: `functions/_lib/scotus.js` (`/bodies/us-supreme-court/`, `/justices/<slug>/`, `/court/term/`, `/court/cases/<term>/<docket>/`), plus the Supreme Court card in "The nation" on every state's page and "This term at the Supreme Court" on Laws. Data: `data/scotus/`, built by `tools/build_scotus.py` (standard library plus `pdftotext`) in the daily "Refresh Supreme Court data" workflow (`.github/workflows/scotus.yml`), which commits it when it changes.

## Where the data comes from

| What | Source |
|---|---|
| The current justices: name, state, appointing President, oath date | supremecourt.gov, "Justices 1789 to Present" (`/about/members_text.aspx`): the rows with no termination date. The Chief Justice first, then by oath date |
| Prior positions | supremecourt.gov, the justices' official biographies (`/about/biographies.aspx`), quoted sentence by sentence, word for word. Sentences about family (spouse, children) are left out, the same for every justice |
| Nomination and confirmation | senate.gov, "Supreme Court Nominations (1789-Present)": the nomination date (linked to Congress.gov), the seat's predecessor, the vote tally and the roll call vote (linked). The confirmation that seated the justice ("C"); an earlier withdrawn nomination isn't it |
| Decisions | supremecourt.gov's slip-opinion list for each term (`/opinions/slipopinion/<yy>`): date, docket, name, the one-line summary the Court's site gives with each opinion, the author column and the opinion PDF, back to the oldest term the site lists (from OT2010 at most) |
| Who wrote and who joined | The lineup paragraph at the end of each opinion's syllabus ("ROBERTS, C. J., delivered the opinion of the Court, in which …"), read by `parse_lineup()`: majority, majority in part ("joined as to Parts …"), concurrence, concurring in part, concurring in the judgment, concurring in part and dissenting in part, dissenting in part, dissent, took no part; and who wrote each. A sentence it doesn't recognize is left out, not guessed. Per curiam opinions have no lineup and aren't in a justice's Record |
| The Constitution | `provisions_named()`: each provision the opinion of the Court names by a name that points at one provision (First Amendment, Commerce Clause, Appointments Clause, Article III …; not "Due Process Clause", which could be the Fifth or the Fourteenth), with the first sentence that names it, word for word, page headers removed. No characterization of the ruling |
| This term | The Court's Granted & Noted list (`/orders/<yy>grantednotedlist.pdf`): docket, case name, lower court, date granted, argument date; the question presented, word for word, from the docket's QP document (`/RSS/Cases/JSON/<docket>.json` → `QPLink`). A case is decided once its docket is on this term's slip-opinion list |
| Financial disclosures | CourtListener (Free Law Project): each justice's annual reports (linked to the filed report), gifts and reimbursements. Needs the `COURTLISTENER_API_TOKEN` repository secret; without it the tab says "Coming soon". Gift and reimbursement sources are named when they're organizations; a person is "An individual" (the same rule as campaign money) |

Caps: `--max-pdfs` (150 a day) opinion PDFs are read per run; the rest wait for the next run (`pending_read`), and a PDF already read is never read again. A source that can't be read leaves the previous file in place.

## Neutrality

The same layout for every justice: About · Record · Disclosures · More. No ideology labels, scores, agreement rates, voting blocs or predictions. A justice's Record lists each decision with their position as the syllabus states it ("Majority · wrote the opinion of the Court", "Dissent"), newest first, 20 at a time with "Load more", and links to the decision's page and the opinion.

## Tests

`python3 tools/test_build_scotus.py` (the parsers, with excerpts in the official pages' layout) and `node --test workers/sync/test/scotus.test.mjs` (the pages, with invented data).
