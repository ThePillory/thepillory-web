"""Site data for tools/build.py.

Only real, plain facts live here: the governing bodies that represent
Calaveras County, described in general terms. Everything about specific
officials, bills, votes and meetings comes from Cloudflare D1, loaded by the
sync Worker (workers/sync) and rendered by Pages Functions (functions/).

The one exception is EXAMPLE_ISSUE: a single, clearly labeled example of what
a report will look like, shown only on /about/how-it-works/. It is not a report
about any real official or agency, and nothing links to it.

Rules (see CLAUDE.md):
- No real names in examples. People are role placeholders like "[Supervisor, District 1]".
- No party labels, and nothing that suggests a political side.
- Anything in [brackets] is a visible placeholder.
"""

LEVELS = ["county", "state", "federal"]

# Each body's constitutional anchor is a provision ID in data/constitution.json,
# plus the short aspect shown on its parchment chip ("Amendment X · State powers").
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

# Shown once, on How it works, labeled "Example". Hypothetical.
EXAMPLE_ISSUE = {
    "level": "county",
    "category": "Public meetings",
    "title": "Public comment cut to one minute at Board of Supervisors meetings",
    "responsible": "Calaveras County Board of Supervisors",
    "clause": ("amend-1", "Petition"),
    "status": "Agency responded",
    "confidence": "High",
    "facts": "On [date], the Board changed the public comment limit from three minutes to one minute per speaker. The change applies to all agenda items, including budget hearings.",
}
