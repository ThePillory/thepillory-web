"""Sample data for The Pillory's app screens.

Everything here is static sample content for layout only.

Rules (see CLAUDE.md):
- No real names. People are role placeholders like "[Supervisor, District 1]".
- No party labels, and nothing that suggests a political side.
- Anything in [brackets] is a visible placeholder.
- Link items by slug. tools/build.py derives every reverse link
  (rep -> issues, clause -> laws, meeting -> issues, ...) from these lists,
  so each connection only needs to be written once.

Clause references are (clause_slug, aspect) pairs. The aspect is the short
label shown on the parchment chip, e.g. ("amend-1", "Petition") renders as
"Amendment I · Petition".
"""

LEVELS = ["county", "state", "federal"]

# The signed-in sample resident's own representatives.
YOUR_REPS = [
    "supervisor-d1",
    "assembly-member",
    "state-senator",
    "us-representative",
    "us-senator-1",
    "us-senator-2",
]

# ---------------------------------------------------------------------------
# Constitution
# ---------------------------------------------------------------------------

CLAUSE_GROUPS = [
    ("articles", "Articles I–VII", "Structure of government"),
    ("bill-of-rights", "Bill of Rights", "Amendments I–X"),
    ("later", "Later amendments", "Amendments XI–XXVII"),
]

CLAUSES = [
    {
        "slug": "art-1-sec-2",
        "group": "articles",
        "short": "Article I, Sec. 2",
        "title": "Article I, Section 2",
        "subtitle": "The House of Representatives",
        "excerpt": "The House of Representatives shall be composed of Members chosen every second Year by the People of the several States …",
        "text": [
            "The House of Representatives shall be composed of Members chosen every second Year by the People of the several States, and the Electors in each State shall have the Qualifications requisite for Electors of the most numerous Branch of the State Legislature.",
            "No Person shall be a Representative who shall not have attained to the Age of twenty five Years, and been seven Years a Citizen of the United States, and who shall not, when elected, be an Inhabitant of that State in which he shall be chosen.",
            "Representatives and direct Taxes shall be apportioned among the several States which may be included within this Union, according to their respective Numbers, which shall be determined by adding to the whole Number of free Persons, including those bound to Service for a Term of Years, and excluding Indians not taxed, three fifths of all other Persons. The actual Enumeration shall be made within three Years after the first Meeting of the Congress of the United States, and within every subsequent Term of ten Years, in such Manner as they shall by Law direct. The Number of Representatives shall not exceed one for every thirty Thousand, but each State shall have at Least one Representative; and until such enumeration shall be made, the State of New Hampshire shall be entitled to chuse three, Massachusetts eight, Rhode-Island and Providence Plantations one, Connecticut five, New-York six, New Jersey four, Pennsylvania eight, Delaware one, Maryland six, Virginia ten, North Carolina five, South Carolina five, and Georgia three.",
            "When vacancies happen in the Representation from any State, the Executive Authority thereof shall issue Writs of Election to fill such Vacancies.",
            "The House of Representatives shall chuse their Speaker and other Officers; and shall have the sole Power of Impeachment.",
        ],
        "note": "The third paragraph's apportionment rule was changed by Section 2 of the Fourteenth Amendment.",
    },
    {
        "slug": "art-1-sec-3",
        "group": "articles",
        "short": "Article I, Sec. 3",
        "title": "Article I, Section 3",
        "subtitle": "The Senate",
        "excerpt": "The Senate of the United States shall be composed of two Senators from each State …",
        "text": [
            "The Senate of the United States shall be composed of two Senators from each State, chosen by the Legislature thereof, for six Years; and each Senator shall have one Vote.",
            "Immediately after they shall be assembled in Consequence of the first Election, they shall be divided as equally as may be into three Classes. The Seats of the Senators of the first Class shall be vacated at the Expiration of the second Year, of the second Class at the Expiration of the fourth Year, and of the third Class at the Expiration of the sixth Year, so that one third may be chosen every second Year; and if Vacancies happen by Resignation, or otherwise, during the Recess of the Legislature of any State, the Executive thereof may make temporary Appointments until the next Meeting of the Legislature, which shall then fill such Vacancies.",
            "No Person shall be a Senator who shall not have attained to the Age of thirty Years, and been nine Years a Citizen of the United States, and who shall not, when elected, be an Inhabitant of that State for which he shall be chosen.",
            "The Vice President of the United States shall be President of the Senate, but shall have no Vote, unless they be equally divided.",
            "The Senate shall chuse their other Officers, and also a President pro tempore, in the Absence of the Vice President, or when he shall exercise the Office of President of the United States.",
            "The Senate shall have the sole Power to try all Impeachments. When sitting for that Purpose, they shall be on Oath or Affirmation. When the President of the United States is tried, the Chief Justice shall preside: And no Person shall be convicted without the Concurrence of two thirds of the Members present.",
            "Judgment in Cases of Impeachment shall not extend further than to removal from Office, and disqualification to hold and enjoy any Office of honor, Trust or Profit under the United States: but the Party convicted shall nevertheless be liable and subject to Indictment, Trial and Judgment and Punishment, according to Law.",
        ],
        "note": "The first two paragraphs were changed by the Seventeenth Amendment, under which senators are elected directly by the people of each state.",
    },
    {
        "slug": "amend-1",
        "group": "bill-of-rights",
        "short": "Amendment I",
        "title": "Amendment I",
        "subtitle": "Religion, speech, press, assembly, and petition",
        "excerpt": "Congress shall make no law … abridging … the right of the people peaceably to assemble, and to petition the Government for a redress of grievances.",
        "text": [
            "Congress shall make no law respecting an establishment of religion, or prohibiting the free exercise thereof; or abridging the freedom of speech, or of the press; or the right of the people peaceably to assemble, and to petition the Government for a redress of grievances.",
        ],
        "note": "Courts apply this to state and local governments through the Fourteenth Amendment.",
    },
    {
        "slug": "amend-10",
        "group": "bill-of-rights",
        "short": "Amendment X",
        "title": "Amendment X",
        "subtitle": "Powers reserved to the states and the people",
        "excerpt": "The powers not delegated to the United States by the Constitution, nor prohibited by it to the States, are reserved to the States respectively, or to the people.",
        "text": [
            "The powers not delegated to the United States by the Constitution, nor prohibited by it to the States, are reserved to the States respectively, or to the people.",
        ],
        "note": "Counties exercise powers that their state grants them.",
    },
    {
        "slug": "amend-14",
        "group": "later",
        "short": "Amendment XIV",
        "title": "Amendment XIV, Section 1",
        "subtitle": "Citizenship, due process, and equal protection",
        "excerpt": "… nor shall any State deprive any person of life, liberty, or property, without due process of law …",
        "text": [
            "All persons born or naturalized in the United States, and subject to the jurisdiction thereof, are citizens of the United States and of the State wherein they reside. No State shall make or enforce any law which shall abridge the privileges or immunities of citizens of the United States; nor shall any State deprive any person of life, liberty, or property, without due process of law; nor deny to any person within its jurisdiction the equal protection of the laws.",
        ],
        "note": "Sections 2–5 of this amendment are not yet included in the sample.",
    },
]

# ---------------------------------------------------------------------------
# Bodies and reps
# ---------------------------------------------------------------------------

BODIES = [
    {
        "slug": "board-of-supervisors",
        "name": "Calaveras County Board of Supervisors",
        "short": "Board of Supervisors",
        "level": "county",
        "about": "Five supervisors, one per county district, who set the county budget, adopt ordinances, and oversee county departments.",
        "clause": ("amend-10", "State powers"),
    },
    {
        "slug": "state-legislature",
        "name": "California State Legislature",
        "short": "State Legislature",
        "level": "state",
        "about": "The State Assembly and State Senate. Shown here: the members who represent your districts.",
        "clause": ("amend-10", "State powers"),
    },
    {
        "slug": "us-house",
        "name": "U.S. House of Representatives",
        "short": "U.S. House",
        "level": "federal",
        "about": "Members elected every two years by district. Shown here: the member who represents your district.",
        "clause": ("art-1-sec-2", "The House"),
    },
    {
        "slug": "us-senate",
        "name": "U.S. Senate",
        "short": "U.S. Senate",
        "level": "federal",
        "about": "Two senators per state, elected to six-year terms. Shown here: California's senators.",
        "clause": ("art-1-sec-3", "The Senate"),
    },
]

REPS = [
    {
        "slug": f"supervisor-d{n}",
        "title": f"[Supervisor, District {n}]",
        "level": "county",
        "office": "Board of Supervisors",
        "district": f"County District {n}",
        "body": "board-of-supervisors",
        "clause": ("amend-10", "State powers"),
    }
    for n in range(1, 6)
] + [
    {
        "slug": "assembly-member",
        "title": "[State Assembly Member, District]",
        "level": "state",
        "office": "State Assembly",
        "district": "Assembly District [#]",
        "body": "state-legislature",
        "clause": ("amend-10", "State powers"),
    },
    {
        "slug": "state-senator",
        "title": "[State Senator, District]",
        "level": "state",
        "office": "State Senate",
        "district": "Senate District [#]",
        "body": "state-legislature",
        "clause": ("amend-10", "State powers"),
    },
    {
        "slug": "us-representative",
        "title": "[U.S. Representative, District]",
        "level": "federal",
        "office": "U.S. House",
        "district": "Congressional District [#]",
        "body": "us-house",
        "clause": ("art-1-sec-2", "The House"),
    },
    {
        "slug": "us-senator-1",
        "title": "[U.S. Senator, Seat 1]",
        "level": "federal",
        "office": "U.S. Senate",
        "district": "California",
        "body": "us-senate",
        "clause": ("art-1-sec-3", "The Senate"),
    },
    {
        "slug": "us-senator-2",
        "title": "[U.S. Senator, Seat 2]",
        "level": "federal",
        "office": "U.S. Senate",
        "district": "California",
        "body": "us-senate",
        "clause": ("art-1-sec-3", "The Senate"),
    },
]

# ---------------------------------------------------------------------------
# Meetings
# ---------------------------------------------------------------------------

# Agenda items are (text, link) where link is None or (kind, slug),
# kind being "issue" or "law".
MEETINGS = [
    {
        "slug": "bos-regular-meeting",
        "title": "Board of Supervisors regular meeting",
        "body": "board-of-supervisors",
        "date": "[date], 9:00 a.m.",
        "location": "[County government center, Board chambers]",
        "comment_deadline": "[date], 5:00 p.m. for written comment",
        "agenda": [
            ("Public comment on items not on the agenda (one minute per speaker)", ("issue", "public-comment-limit")),
            ("Review of rules of procedure", ("law", "res-public-comment")),
            ("Road maintenance contract, [County road]", ("issue", "road-repaving")),
            ("Budget hearing: [fiscal year] recommended budget", None),
        ],
        "issues": ["public-comment-limit", "road-repaving"],
    },
    {
        "slug": "bos-budget-workshop",
        "title": "Board of Supervisors budget workshop",
        "body": "board-of-supervisors",
        "date": "[date], 1:30 p.m.",
        "location": "[County government center, Board chambers]",
        "comment_deadline": "[date], noon for written comment",
        "agenda": [
            ("Budget overview from the County Administrative Officer", None),
            ("Public comment on budget priorities", ("issue", "public-comment-limit")),
        ],
        "issues": ["public-comment-limit"],
    },
    {
        "slug": "assembly-committee-hearing",
        "title": "Assembly committee hearing on [Bill number]",
        "body": "state-legislature",
        "date": "[date], 1:30 p.m.",
        "location": "[State Capitol, hearing room]",
        "comment_deadline": "[date] for position letters",
        "agenda": [
            ("[Bill number]: rural broadband funding criteria", ("law", "bill-broadband")),
        ],
        "issues": ["broadband-scoring"],
    },
]

# ---------------------------------------------------------------------------
# Laws (bills, ordinances, resolutions)
# ---------------------------------------------------------------------------

PLACEHOLDER_BASELINE = {
    "aligns": "[How this aligns with the constitutional text.]",
    "aligns_source": "Source: [case law or legal analysis]",
    "tension": "[Where verified residents say it may be in tension.]",
    "tension_source": "From [#] verified residents",
    "serves": "[Why this might still serve the public.]",
    "serves_source": "From [#] verified residents",
}

PUBLIC_COMMENT_BASELINE = {
    "aligns": "Courts have generally allowed reasonable time limits on public comment, as long as they apply equally to every speaker and viewpoint.",
    "aligns_source": "Source: [case law or legal analysis]",
    "tension": "Residents argue one minute is too short to meaningfully petition on complex items like the budget.",
    "tension_source": "From [#] verified residents",
    "serves": "Supporters say shorter limits let more people speak and keep meetings from running past midnight.",
    "serves_source": "From [#] verified residents",
}

LAWS = [
    {
        "slug": "res-public-comment",
        "kind": "Resolution",
        "title": "Resolution [number]: public comment time limits",
        "level": "county",
        "body": "board-of-supervisors",
        "status": "Adopted [date]",
        "summary": "Changes the Board's rules of procedure so each speaker gets one minute of public comment per agenda item instead of three. The limit applies to every agenda item, including budget hearings.",
        "clauses": [("amend-1", "Petition")],
        "baseline": PUBLIC_COMMENT_BASELINE,
        "votes": {
            "supervisor-d1": "Yes",
            "supervisor-d2": "No",
            "supervisor-d3": "Yes",
            "supervisor-d4": "Yes",
            "supervisor-d5": "Absent",
        },
        "vote_date": "[date]",
    },
    {
        "slug": "bill-broadband",
        "kind": "Bill",
        "title": "[Bill number]: rural broadband funding criteria",
        "level": "state",
        "body": "state-legislature",
        "status": "In committee",
        "summary": "Sets how the state scores counties when it awards broadband infrastructure grants. [Plain-language summary to be reviewed.]",
        "clauses": [("amend-10", "State powers")],
        "baseline": PLACEHOLDER_BASELINE,
        "votes": {
            "assembly-member": "Yes (committee)",
            "state-senator": "Not yet voted",
        },
        "vote_date": "[date]",
    },
    {
        "slug": "bill-constituent-access",
        "kind": "Bill",
        "title": "[Bill number]: public district events disclosure",
        "level": "federal",
        "body": "us-house",
        "status": "Introduced [date]",
        "summary": "Would require each House member's office to publish a schedule of public events held in the district. [Plain-language summary to be reviewed.]",
        "clauses": [("art-1-sec-2", "The House")],
        "baseline": PLACEHOLDER_BASELINE,
        "votes": {
            "us-representative": "Not yet voted",
        },
        "vote_date": "[date]",
    },
]

# ---------------------------------------------------------------------------
# Evidence
# ---------------------------------------------------------------------------

# "parent" is where the back label points: ("issue", slug) or ("promise", slug).
EVIDENCE = [
    {
        "slug": "board-minutes",
        "title": "Meeting minutes, [date]",
        "source_type": "Document · county website",
        "verification": "Official source",
        "submitted_by": "Pulled from the official county website",
        "preview": "[Document preview: meeting minutes, page 4 of 12]",
        "parent": ("issue", "public-comment-limit"),
    },
    {
        "slug": "board-video-clips",
        "title": "Meeting video, 2 clips",
        "source_type": "Video · resident upload",
        "verification": "Timestamp checked",
        "submitted_by": "Uploaded by a verified county resident",
        "preview": "[Video preview: 2 clips, [mm:ss] total]",
        "parent": ("issue", "public-comment-limit"),
    },
    {
        "slug": "prior-rules",
        "title": "Prior rules of procedure",
        "source_type": "Public record",
        "verification": "Official source",
        "submitted_by": "Requested from the Clerk of the Board",
        "preview": "[Document preview: rules of procedure, section on public comment]",
        "parent": ("issue", "public-comment-limit"),
    },
    {
        "slug": "candidate-forum",
        "title": "Candidate forum recording, [date]",
        "source_type": "Video · public forum",
        "verification": "Timestamp checked",
        "submitted_by": "Uploaded by a verified county resident",
        "preview": "[Video preview: forum recording at [mm:ss]]",
        "parent": ("promise", "d1-comment-time"),
    },
    {
        "slug": "agenda-posting-log",
        "title": "Agenda posting log, [year]",
        "source_type": "Public record",
        "verification": "Official source",
        "submitted_by": "Requested from the Clerk of the Board",
        "preview": "[Document preview: agenda posting dates]",
        "parent": ("promise", "d1-agenda-notice"),
    },
    {
        "slug": "paving-contract",
        "title": "Paving contract award",
        "source_type": "Public record",
        "verification": "Official source",
        "submitted_by": "Pulled from the official county website",
        "preview": "[Document preview: contract award, [County road]]",
        "parent": ("promise", "d2-repave"),
    },
    {
        "slug": "road-photos",
        "title": "Photos of [County road], [date]",
        "source_type": "Photo · resident upload",
        "verification": "Location checked",
        "submitted_by": "Uploaded by a verified county resident",
        "preview": "[Photo preview: 6 photos]",
        "parent": ("issue", "road-repaving"),
    },
    {
        "slug": "broadband-scoring-draft",
        "title": "Broadband grant scoring criteria, draft",
        "source_type": "Document · state website",
        "verification": "Official source",
        "submitted_by": "Pulled from the official state website",
        "preview": "[Document preview: scoring criteria table]",
        "parent": ("issue", "broadband-scoring"),
    },
    {
        "slug": "campaign-newsletter",
        "title": "Campaign newsletter, [date]",
        "source_type": "Document · resident upload",
        "verification": "Under review",
        "submitted_by": "Uploaded by a verified district resident",
        "preview": "[Document preview: newsletter, page 2]",
        "parent": ("promise", "usrep-town-halls"),
    },
    {
        "slug": "office-events-archive",
        "title": "Office public events page, archived",
        "source_type": "Link · web archive",
        "verification": "Link verified",
        "submitted_by": "Submitted by a verified district resident",
        "preview": "[Link preview: archived events page, [date]]",
        "parent": ("issue", "town-halls"),
    },
]

# ---------------------------------------------------------------------------
# Promises
# ---------------------------------------------------------------------------

# Status is one of: Kept, Broken, In progress, No action.
PROMISES = [
    {
        "slug": "d1-comment-time",
        "rep": "supervisor-d1",
        "commitment": "Keep public comment at three minutes per speaker",
        "source": "Candidate forum",
        "source_date": "[date]",
        "status": "Broken",
        "history": [
            ("[date]", "Commitment made at a candidate forum"),
            ("[date]", "Voted yes on Resolution [number], setting a one-minute limit"),
            ("[date]", "Status set to Broken after review"),
        ],
        "evidence": ["candidate-forum", "board-minutes"],
        "issues": ["public-comment-limit"],
        "laws": ["res-public-comment"],
    },
    {
        "slug": "d1-agenda-notice",
        "rep": "supervisor-d1",
        "commitment": "Post full Board agendas at least seven days before each meeting",
        "source": "Campaign website, archived",
        "source_date": "[date]",
        "status": "Kept",
        "history": [
            ("[date]", "Commitment published on campaign website"),
            ("[date]", "Posting log shows agendas out seven or more days ahead"),
            ("[date]", "Status set to Kept after review"),
        ],
        "evidence": ["agenda-posting-log"],
        "issues": [],
        "laws": [],
    },
    {
        "slug": "d2-repave",
        "rep": "supervisor-d2",
        "commitment": "Complete repaving of [County road] by [date]",
        "source": "District newsletter",
        "source_date": "[date]",
        "status": "In progress",
        "history": [
            ("[date]", "Commitment made in district newsletter"),
            ("[date]", "Paving contract awarded"),
            ("[date]", "Promised completion date passed"),
            ("[date]", "Work resumed, per county road schedule"),
        ],
        "evidence": ["paving-contract", "road-photos"],
        "issues": ["road-repaving"],
        "laws": [],
    },
    {
        "slug": "assembly-broadband",
        "rep": "assembly-member",
        "commitment": "Introduce a bill to change how rural broadband funding is scored",
        "source": "Public statement",
        "source_date": "[date]",
        "status": "Kept",
        "history": [
            ("[date]", "Commitment made in a public statement"),
            ("[date]", "[Bill number] introduced"),
            ("[date]", "Status set to Kept after review"),
        ],
        "evidence": ["broadband-scoring-draft"],
        "issues": ["broadband-scoring"],
        "laws": ["bill-broadband"],
    },
    {
        "slug": "senator-office-hours",
        "rep": "state-senator",
        "commitment": "Hold monthly office hours in Calaveras County",
        "source": "Press release",
        "source_date": "[date]",
        "status": "In progress",
        "history": [
            ("[date]", "Commitment made in a press release"),
            ("[date]", "[#] of [#] monthly sessions held so far"),
        ],
        "evidence": [],
        "issues": [],
        "laws": [],
    },
    {
        "slug": "usrep-town-halls",
        "rep": "us-representative",
        "commitment": "Hold a public town hall in the district every quarter",
        "source": "Campaign newsletter",
        "source_date": "[date]",
        "status": "No action",
        "history": [
            ("[date]", "Commitment made in a campaign newsletter"),
            ("[date]", "No district town hall found on the office's public events page"),
            ("[date]", "Status set to No action after review"),
        ],
        "evidence": ["campaign-newsletter", "office-events-archive"],
        "issues": ["town-halls"],
        "laws": [],
    },
]

# ---------------------------------------------------------------------------
# Issues
# ---------------------------------------------------------------------------

ISSUES = [
    {
        "slug": "public-comment-limit",
        "short": "Public comment limit",
        "level": "county",
        "category": "Public meetings",
        "title": "Public comment cut to one minute at Board of Supervisors meetings",
        "body": "board-of-supervisors",
        "responsible": None,  # None: show the body's name
        "reps": ["supervisor-d1", "supervisor-d2", "supervisor-d3", "supervisor-d4", "supervisor-d5"],
        "laws": ["res-public-comment"],
        "clauses": [("amend-1", "Petition")],
        "status": "Agency responded",
        "confidence": "High",
        "facts": "On [date], the Board changed the public comment limit from three minutes to one minute per speaker. The change applies to all agenda items, including budget hearings.",
        "evidence": ["board-minutes", "board-video-clips", "prior-rules"],
        "baseline": PUBLIC_COMMENT_BASELINE,
        "response": ("Clerk of the Board · [date]", "[The agency's response appears here, unedited.]"),
        "history": [
            ("[date]", "First report filed"),
            ("[date]", "Agency notified"),
            ("[date]", "Response added"),
        ],
    },
    {
        "slug": "broadband-scoring",
        "short": "Broadband funding scoring",
        "level": "state",
        "category": "Legislation",
        "title": "[Bill number]: how rural counties are scored for broadband funding",
        "body": "state-legislature",
        "responsible": None,
        "reps": ["assembly-member", "state-senator"],
        "laws": ["bill-broadband"],
        "clauses": [("amend-10", "State powers")],
        "status": "Aggregating reports",
        "confidence": "Medium",
        "facts": "[Summary of what verified residents have documented about how the scoring formula treats rural counties.]",
        "evidence": ["broadband-scoring-draft"],
        "baseline": PLACEHOLDER_BASELINE,
        "response": None,
        "history": [
            ("[date]", "First report filed"),
            ("[date]", "[#] related reports joined"),
        ],
    },
    {
        "slug": "town-halls",
        "short": "District town halls",
        "level": "federal",
        "category": "Official conduct",
        "title": "Promised quarterly town halls in the district: none held since [date]",
        "body": "us-house",
        "responsible": ("us-representative", "Office of the U.S. Representative, [district]"),
        "reps": ["us-representative"],
        "laws": ["bill-constituent-access"],
        "clauses": [("art-1-sec-2", "The House")],
        "status": "Gathering evidence",
        "confidence": "Low",
        "facts": "[Summary of the documented commitment and the public events record since [date].]",
        "evidence": ["office-events-archive", "campaign-newsletter"],
        "baseline": PLACEHOLDER_BASELINE,
        "response": None,
        "history": [
            ("[date]", "First report filed"),
        ],
    },
    {
        "slug": "road-repaving",
        "short": "[County road] repaving",
        "level": "county",
        "category": "Public services",
        "title": "Repaving of [County road] past its promised completion date",
        "body": "board-of-supervisors",
        "responsible": ("supervisor-d2", "[Supervisor, District 2] and County Public Works"),
        "reps": ["supervisor-d2"],
        "laws": [],
        "clauses": [],
        "status": "Gathering evidence",
        "confidence": "Medium",
        "facts": "The county committed to finishing the [County road] repaving by [date]. As of [date], [#] of [#] miles are complete.",
        "evidence": ["road-photos", "paving-contract"],
        "baseline": None,
        "response": None,
        "history": [
            ("[date]", "First report filed"),
            ("[date]", "Agency notified"),
        ],
    },
]

# ---------------------------------------------------------------------------
# You tab
# ---------------------------------------------------------------------------

FOLLOWING = {
    "reps": ["supervisor-d1", "us-representative"],
    "bodies": ["board-of-supervisors"],
    "issues": ["public-comment-limit", "road-repaving"],
    "laws": ["bill-broadband"],
}

NOTIFICATIONS = [
    ("[date]", "Agency response added", ("issue", "public-comment-limit")),
    ("[date]", "New meeting posted: budget workshop", ("meeting", "bos-budget-workshop")),
    ("[date]", "Promise status updated to In progress", ("promise", "d2-repave")),
]

# (title, status, link) where link is None or (kind, slug)
MY_REPORTS = [
    ("Public comment cut to one minute", "Joined an issue", ("issue", "public-comment-limit")),
    ("[Report title]", "In review", None),
    ("[Draft report title]", "Draft", None),
]
