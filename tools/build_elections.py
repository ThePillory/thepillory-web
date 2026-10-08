#!/usr/bin/env python3
"""Build data/elections/<date>.json from official election sources only.

    python3 tools/build_elections.py            # writes data/elections/2026-11-03.json
    python3 tools/build_elections.py --check    # prints what it found, writes nothing

Run in GitHub Actions ("Refresh election data", .github/workflows/elections.yml),
because the sources aren't reachable from everywhere. Needs `pdftotext`
(poppler-utils). Standard library otherwise.

Every item keeps the URL of the official document it came from:

  - Contests and candidates (statewide, U.S. House, State Senate, State Assembly,
    Board of Equalization): the Secretary of State's Certified List of Candidates
    (PDF): each candidate's name, ballot designation and party preference as
    certified, and the incumbent mark.
  - Ballot order: the Secretary of State's randomized alphabet for this election
    (its press release), applied by functions/_lib/elections.js the way the
    Secretary of State describes (https://www.sos.ca.gov/elections/randomized-alphabet).
  - Statewide candidate statements: the state Official Voter Information Guide
    (one page per office), word for word.
  - Statewide propositions: the state guide's page for each (official title and
    summary, what a yes and a no vote mean) and its Arguments and Rebuttals page
    (each argument and rebuttal word for word, with its signers as printed).
  - Calaveras County: the county's Qualified Candidates List (local contests on
    the ballot), and its Voter Information Pamphlet (candidate statements, and
    local measures: the question, County Counsel's impartial analysis and the
    arguments). Text from a PDF is extracted as printed; the PDF stays linked as
    the official version.
  - Federal candidates: their FEC candidate filings (link only), matched by name
    and district.

No candidate's contact details are kept. Results aren't stored: the pages read
the Secretary of State's results feed only after the polls close.
"""
import html
import json
import os
import re
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
UA = "ThePillory/1.0 (+https://thepillory.co; civic records)"

ELECTION = {
    "id": "2026-11-03",
    "name": "November 3, 2026, General Election",
    "date": "2026-11-03",
    # Polls close at 8:00 p.m. Pacific (PST after November 1): 04:00 UTC the next day.
    "polls_close_utc": "2026-11-04T04:00:00Z",
    "state": "CA",
    "sos_page": "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026",
    "guide": "https://voterguide.sos.ca.gov/",
    "guide_pdf": "https://vig.cdn.sos.ca.gov/2026/general/pdf/complete-vig.pdf",
    "certified_list": "https://elections.cdn.sos.ca.gov/statewide-elections/2026-general/cert-list-candidates.pdf",
    "alphabet_source": "https://www.sos.ca.gov/administration/news-releases-and-advisories/2026-news-releases-and-advisories/california-secretary-state-shirley-n-weber-phd-announces-results-randomized-alphabet-drawing-november-3-2026-general-election",
    "alphabet_method": "https://www.sos.ca.gov/elections/randomized-alphabet",
    "results_api": "https://api.sos.ca.gov/returns/",
    "results_page": "https://electionresults.sos.ca.gov/",
}

# How to vote: official pages only, linked rather than restated.
HOW_TO_VOTE = {
    "state": [
        {"label": "Register to vote, or update your registration", "url": "https://registertovote.ca.gov/", "by": "California Secretary of State"},
        {"label": "Check your registration status", "url": "https://voterstatus.sos.ca.gov/", "by": "California Secretary of State"},
        {"label": "Key dates and deadlines", "url": "https://www.sos.ca.gov/elections/upcoming-elections/general-election-november-3-2026/key-dates-deadlines", "by": "California Secretary of State"},
        {"label": "Find your polling place or vote center", "url": "https://www.sos.ca.gov/elections/polling-place", "by": "California Secretary of State"},
        {"label": "Track your ballot", "url": "https://california.ballottrax.net/voter/", "by": "California Secretary of State (BallotTrax)"},
    ],
    "06009": [
        {"label": "Where to vote in Calaveras County: vote centers and drop boxes", "url": "https://elections.calaverasgov.us/Next-Election/Where-to-Vote", "by": "Calaveras County Elections"},
        {"label": "Important dates in Calaveras County", "url": "https://elections.calaverasgov.us/Next-Election/Important-Dates", "by": "Calaveras County Elections"},
        {"label": "Registering to vote in Calaveras County", "url": "https://elections.calaverasgov.us/Voter-Services/Registering-to-Vote", "by": "Calaveras County Elections"},
        {"label": "Calaveras County Voter Information Pamphlet (PDF)", "url": "https://elections.calaverasgov.us/Portals/Elections/Documents/Guides/Master VIP.pdf", "by": "Calaveras County Elections"},
    ],
}

COUNTIES = {
    "06009": {
        "name": "Calaveras County",
        "elections_page": "https://elections.calaverasgov.us/Next-Election/General-Election/Candidates-and-Measures",
        "results_page": "https://elections.calaverasgov.us/Results/Current-Results",
        "candidates_pdf": "https://elections.calaverasgov.us/Portals/Elections/Documents/Candidates/qualified caniddate listcfmcfmr009_nominationlist.pdf?ver=we4iXWdmaw_7ZiEPp4gN7g%3d%3d",
        "pamphlet_pdf": "https://elections.calaverasgov.us/Portals/Elections/Documents/Guides/Master VIP.pdf",
        # Board of Equalization district, as the county's pamphlet names it.
        "boe": "1",
    },
}

STATEWIDE = {
    "Governor": ("governor", "governor-candidate-statements.htm"),
    "Lieutenant Governor": ("lieutenant-governor", "lt-governor-candidate-statements.htm"),
    "Secretary of State": ("secretary-of-state", "sos-candidate-statements.htm"),
    "Controller": ("controller", "controller-candidate-statements.htm"),
    "Treasurer": ("treasurer", "treasurer-candidate-statements.htm"),
    "Attorney General": ("attorney-general", "attorney-general-candidate-statements.htm"),
    "Insurance Commissioner": ("insurance-commissioner", "insurance-commissioner-candidate-statements.htm"),
    "Superintendent of Public Instruction": ("superintendent-of-public-instruction", "superintendent-candidate-statements.htm"),
}
PARTIES = ["American Independent", "Peace and Freedom", "No Party Preference", "Non-Partisan", "Democratic", "Republican", "Libertarian", "Green", "None"]
PARTY_RE = re.compile(r"^(?P<name>\S.*?\S)\s{3,}(?P<party>" + "|".join(re.escape(p) for p in PARTIES) + r")\s*$")


def log(*a):
    print(*a, file=sys.stderr)


def fetch(url, binary=False):
    req = urllib.request.Request(urllib.parse.quote(url, safe=":/?=&%#~+"), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=90) as r:
        data = r.read()
    return data if binary else data.decode("utf-8", "ignore")


def pdf_text(url):
    data = fetch(url, binary=True)
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout


def clean(s):
    return re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", s or ""))).strip()


def slug(s):
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")


# ---------------------------------------------------------------------------
# The randomized alphabet, from the Secretary of State's press release.

def alphabet():
    t = clean(fetch(ELECTION["alphabet_source"]))
    m = re.search(r"results of today[’']s drawing are as follows:\s*((?:[A-Z]\s+){25}[A-Z])\b", t)
    if not m:
        raise SystemExit("randomized alphabet not found in the press release")
    letters = m.group(1).split()
    if sorted(letters) != [chr(c) for c in range(65, 91)]:
        raise SystemExit(f"the alphabet isn't 26 distinct letters: {letters}")
    return letters


# ---------------------------------------------------------------------------
# The Certified List of Candidates.

def contest_scope(office):
    if office in STATEWIDE:
        return {"type": "statewide", "district": None, "results": STATEWIDE[office][0]}
    m = re.match(r"United States Representative District (\d+)$", office)
    if m:
        return {"type": "cd", "district": m.group(1), "results": f"us-rep/district/{m.group(1)}"}
    m = re.match(r"(?:State Senate|State Senator|Member of the State Senate) District (\d+)$", office)
    if m:
        return {"type": "sldu", "district": m.group(1), "results": f"state-senate/district/{m.group(1)}"}
    m = re.match(r"(?:State Assembly|Member of the State Assembly|State Assembly Member|Member, State Assembly) District (\d+)$", office)
    if m:
        return {"type": "sldl", "district": m.group(1), "results": f"state-assembly/district/{m.group(1)}"}
    m = re.match(r"Board of Equalization Member District (\d+)$", office)
    if m:
        return {"type": "boe", "district": m.group(1), "results": f"board-of-equalization/district/{m.group(1)}"}
    if office == "United States Senator":
        return {"type": "statewide", "district": None, "results": "us-senate"}
    return None


def certified_list():
    t = pdf_text(ELECTION["certified_list"])
    contests, current, unparsed = [], None, []
    lines = t.splitlines()
    i = 0
    while i < len(lines):
        raw = lines[i]
        s = raw.strip()
        i += 1
        if not s or re.match(r"^(General Election - |Official Certified List of Candidates|\d+/\d+/\d{4}$|Page \d+ of \d+|\* Incumbent)", s):
            continue
        m = PARTY_RE.match(s)
        indent = len(raw) - len(raw.lstrip())
        if m and current is not None:
            name = m.group("name").strip()
            incumbent = name.endswith("*")
            name = name.rstrip("*").strip()
            designation = ""
            if i < len(lines) and lines[i].strip() and not PARTY_RE.match(lines[i].strip()):
                nxt = lines[i]
                if len(nxt) - len(nxt.lstrip()) > indent:
                    designation = nxt.strip()
                    i += 1
            current["candidates"].append({"name": name, "party": m.group("party"), "designation": designation, "incumbent": incumbent})
            continue
        if indent >= 20 and len(s) < 90:
            scope = contest_scope(s)
            if scope:
                current = {"id": scope["results"].replace("/district/", "-").replace("/", "-"), "office": s, "scope": scope["type"], "district": scope["district"],
                           "results_path": scope["results"], "vote_for": 1, "candidates": [], "source_url": ELECTION["certified_list"], "source": "Secretary of State, Certified List of Candidates"}
                contests.append(current)
            else:
                current = None
                unparsed.append(s)
            continue
        if current is None:
            unparsed.append(s)
    log(f"certified list: {len(contests)} contests; headings not used: {sorted(set(unparsed))[:60]}")
    return [c for c in contests if c["candidates"]] + retention(lines)


APPELLATE = {"First": "1", "Second": "2", "Third": "3", "Fourth": "4", "Fifth": "5", "Sixth": "6"}


def retention(lines):
    """Judicial retention contests (yes or no on each justice), from the end of the certified list:
    "Supreme Court - For all 58 Counties", then each "Court of Appeal – <N> Appellate District"
    with the counties it covers, then "• For <office>" and "Shall ... be elected ...?"."""
    out, court, counties, office, q, collecting = [], None, [], None, [], None
    for raw in lines:
        s = raw.strip()
        if re.match(r"^(General Election - |Official Certified List of Candidates|\d+/\d+/\d{4}$|Page \d+ of \d+)", s):
            continue
        m = re.match(r"^Supreme Court\s*[-–]\s*For all 58 Counties$", s)
        if m:
            court, counties, collecting = {"court": "supreme", "district": None, "name": "Supreme Court"}, ["all"], None
            continue
        m = re.match(r"^Court of Appeal\s*[-–]\s*(\w+) Appellate District$", s)
        if m and m.group(1) in APPELLATE:
            court, counties, collecting = {"court": "appeal", "district": APPELLATE[m.group(1)], "name": f"Court of Appeal, {m.group(1)} Appellate District"}, [], "counties"
            continue
        if court is None:
            continue
        if collecting == "counties" and s and not s.startswith("•"):
            counties += [c.strip() for c in s.split(",") if c.strip()]
            continue
        m = re.match(r"^•\s*For (.+)$", s)
        if m:
            collecting, office, q = "office", m.group(1).strip(), []
            continue
        if office and s:
            q.append(s)
            if s.endswith("?"):
                question = " ".join(q)
                name = re.search(r"\b([A-Z][A-Z.,'-]*(?: [A-Z][A-Z.,'-]*)+) be elected", question)
                n = len([x for x in out if x["court"] == court["court"] and x["district"] == court["district"]]) + 1
                out.append({"id": f"{'supreme-court' if court['court'] == 'supreme' else 'court-of-appeal-' + court['district']}-{n}", "office": office, "scope": "judicial",
                            "court": court["court"], "district": court["district"], "court_name": court["name"], "counties": counties,
                            "question": question, "justice": name.group(1).strip().rstrip(",") if name else None, "vote_for": 1, "candidates": [],
                            "choices": ["Yes", "No"], "results_path": None,
                            "source_url": ELECTION["certified_list"], "source": "Secretary of State, Certified List of Candidates"})
                office, q = None, []
    log(f"judicial retention: {len(out)} ({sum(1 for x in out if x['court'] == 'supreme')} Supreme Court); third district counties: {next((x['counties'] for x in out if x['district'] == '3'), None)}")
    return out


# ---------------------------------------------------------------------------
# The state Official Voter Information Guide.

def guide_statements(contests):
    by_office = {c["office"]: c for c in contests if c["scope"] == "statewide"}
    found = 0
    for office, (_, page) in STATEWIDE.items():
        c = by_office.get(office)
        if not c:
            continue
        url = f"https://voterguide.sos.ca.gov/candidates/{page}"
        try:
            h = fetch(url)
        except Exception as e:
            log(f"statements {office}: {e}")
            continue
        for block in re.split(r"<hr\s*/?>", h):
            m = re.search(r"<h2>\s*(.*?)\s*\|\s*(.*?)\s*</h2>", block, re.S)
            if not m:
                continue
            name = clean(m.group(1))
            paras = [clean(p) for p in re.findall(r"<p[^>]*>(.*?)</p>", block[m.end():], re.S)]
            paras = [p for p in paras if p]
            cand = match_candidate(c["candidates"], name)
            if not cand:
                log(f"statements {office}: no candidate named {name}")
                continue
            if paras and not re.match(r"No candidate statement", paras[0], re.I):
                kept = [p for p in paras if not (len(p) < 200 and CONTACT.search(p))]
                note = "The candidate's email and phone are left out; the guide is the official version." if len(kept) != len(paras) else None
                cand["statement"] = {"paragraphs": kept, "source_url": url, "source": "Official Voter Information Guide, Secretary of State", "note": note}
                found += 1
    log(f"statewide statements: {found}")


def surname(name):
    parts = re.sub(r"\([^)]*\)", " ", name).replace(",", " ").split()
    while parts and re.match(r"^(jr|sr|ii|iii|iv|md|phd)\.?$", parts[-1], re.I):
        parts.pop()
    return parts[-1].lower() if parts else ""


def match_candidate(cands, name):
    last = surname(name)
    first = re.sub(r"[^a-z]", "", (name.split() or [""])[0].lower())
    hits = [c for c in cands if surname(c["name"]) == last]
    if len(hits) > 1:
        hits = [c for c in hits if re.sub(r"[^a-z]", "", c["name"].split()[0].lower())[:3] == first[:3]]
    return hits[0] if len(hits) == 1 else None


def propositions():
    index = fetch("https://voterguide.sos.ca.gov/propositions/")
    nums = []
    for n in re.findall(r'href="(?:https://voterguide\.sos\.ca\.gov)?/propositions/(\d+)/', index):
        if n not in nums:
            nums.append(n)
    props = []
    for n in nums:
        base = f"https://voterguide.sos.ca.gov/propositions/{n}/"
        h = fetch(base)
        title = clean((re.search(r'<div class="grid-90 propName">\s*<h2>(.*?)</h2>', h, re.S) or re.search(r"<h2>([^<]{20,})</h2>", h)).group(1))
        body = h[h.find("SUMMARY"):] if "SUMMARY" in h else h
        text = clean(body[: body.find("FOR ADDITIONAL INFORMATION")] if "FOR ADDITIONAL INFORMATION" in body else body)
        summary = section(text, "SUMMARY", "WHAT YOUR VOTE MEANS")
        means = section(text, "WHAT YOUR VOTE MEANS", "ARGUMENTS")
        yes = (re.search(r"YES (A YES vote on this measure means:.*?)(?= NO A NO vote)", means) or [None, None])[1]
        no = (re.search(r"NO (A NO vote on this measure means:.*)$", means) or [None, None])[1]
        args_url = f"{base}arguments-rebuttals.htm"
        args = arguments(fetch(args_url))
        ts_url = f"{base}title-summary.htm"
        ts = title_summary(fetch(ts_url))
        props.append({
            "id": f"prop-{n}", "number": n, "title": title, "scope": "statewide",
            "summary": summary, "yes_means": yes, "no_means": no,
            "ag_summary": ts["ag_summary"], "fiscal_heading": ts["fiscal_heading"], "fiscal_effect": ts["fiscal_effect"],
            "arguments": args["arguments"], "arguments_disclaimer": args["disclaimer"],
            "links": {"guide": base, "title_summary": ts_url, "analysis": f"{base}analysis.htm", "arguments": args_url,
                      "text": f"https://vig.cdn.sos.ca.gov/2026/general/pdf/prop{n}-text-proposed-laws.pdf"},
            "results_path": "ballot-measures", "results_number": n.zfill(2),
            "source_url": base, "source": "Official Voter Information Guide, Secretary of State",
        })
    log(f"propositions: {[p['number'] for p in props]}")
    return props


def blocks(h):
    """The paragraphs and list items of a piece of the page, in order, as printed."""
    h = re.sub(r"<(ul|ol)[^>]*>(.*?)</\1>", lambda m: "".join(f"<p>{x}</p>" for x in re.findall(r"<li[^>]*>(.*?)</li>", m.group(2), re.S)), h, flags=re.S)
    return [t for t in (clean(re.split(r"</p>", x)[0]) for x in re.split(r"<p[^>]*>", h)[1:]) if t]


def title_summary(h):
    """The Official Title and Summary page: the Attorney General's summary, and the
    summary of the Legislative Analyst's estimate of the fiscal impact, each as printed."""
    h = numeric_entities(h)
    start = h.find("PREPARED BY THE ATTORNEY GENERAL")
    fiscal = re.search(r"<h3[^>]*>\s*SUMMARY OF LEGISLATIVE ANALYST.*?</h3>", h[start:], re.S) if start >= 0 else None
    if start < 0 or not fiscal:
        return {"ag_summary": [], "fiscal_heading": None, "fiscal_effect": []}
    end = h.find("</section>", start + fiscal.end())
    return {
        "ag_summary": blocks(h[h.find("</h3>", start) + 5: start + fiscal.start()]),
        "fiscal_heading": clean(fiscal.group(0)).rstrip(":"),
        "fiscal_effect": blocks(h[start + fiscal.end(): end if end > 0 else None]),
    }


def section(text, start, end):
    i = text.find(start)
    if i < 0:
        return None
    j = text.find(end, i + len(start))
    return text[i + len(start): j if j > 0 else None].strip()


# Who wrote each part. On the official page, each column is an argument
# followed by the rebuttal to it, so a rebuttal is written by the other side:
# the column for the measure holds the supporters' argument and the
# opponents' rebuttal to it.
SIDE = {"for": "supporters", "rebuttal_against": "opponents", "against": "opponents", "rebuttal_for": "supporters"}


def argument_kind(heading):
    h = heading.upper()
    if "REBUTTAL TO ARGUMENT AGAINST" in h:
        return "rebuttal_for"       # the supporters' rebuttal
    if "REBUTTAL TO ARGUMENT IN FAVOR" in h:
        return "rebuttal_against"   # the opponents' rebuttal
    if "IN FAVOR" in h:
        return "for"
    if "AGAINST" in h:
        return "against"
    return "other"


def argument_part(heading, body):
    """One argument or rebuttal: its paragraphs word for word and its signers as printed."""
    # A bulleted list (inside a paragraph or between them) becomes one paragraph per item, marked "• ".
    body = re.sub(r"<(ul|ol)[^>]*>(.*?)</\1>", lambda m: "".join(f"<p>• {x}</p>" for x in re.findall(r"<li[^>]*>(.*?)</li>", m.group(2), re.S)), body, flags=re.S)
    # Split at each opening <p>: a paragraph isn't always closed before the next one.
    raw = [re.split(r"</p>", x)[0] for x in re.split(r"<p[^>]*>", body)[1:]]
    # The signature block: the closing paragraphs that read "<strong>Name</strong>, Title"
    # (or "<strong>Name,</strong> Title"); a bold line in the text doesn't.
    sigs = []
    while raw and re.match(r"\s*<strong>[^<]*(,\s*</strong>|</strong>\s*,)", raw[-1]):
        sigs.insert(0, raw.pop())
    signers = []
    for sig in sigs:
        for name, rest in re.findall(r"<strong>(.*?)</strong>(.*?)(?=<strong>|$)", sig, re.S):
            lines = [clean(x).lstrip(", ") for x in re.split(r"<br\s*/?>", rest) if clean(x).lstrip(", ")]
            signers.append({"name": clean(name).rstrip(","), "title": ", ".join(lines)})
    paras = [clean(p) for p in raw]
    paras = [p for p in paras if p and p != "•"]
    none_submitted = bool(paras) and re.match(r"NO (ARGUMENT|REBUTTAL).*WAS SUBMITTED", paras[0], re.I)
    kind = argument_kind(heading)
    return {"kind": kind, "side": SIDE.get(kind), "heading": heading, "paragraphs": [] if none_submitted else paras,
            "signers": signers, "none_submitted": paras[0] if none_submitted else None}


def numeric_entities(h):
    """Decode numeric entities ("&#44;", "&#45;") so markup like class="grid&#45;50" and
    "</strong>&#44; Title" can be matched; "<", ">" and "&" stay encoded."""
    def one(m):
        c = chr(int(m.group(1)))
        return m.group(0) if c in "<>&" else c
    return re.sub(r"&#(\d+);", one, h)


def arguments(h):
    """Every argument and rebuttal on the page, in the page's order, each split at its own heading."""
    h = numeric_entities(h)
    out = []
    for block in re.findall(r'<div class="grid-50 argumentsRebuttals">(.*?)</div>', h, re.S):
        heads = list(re.finditer(r"<h3[^>]*>(.*?)</h3>", block, re.S))
        for n, m in enumerate(heads):
            body = block[m.end(): heads[n + 1].start() if n + 1 < len(heads) else len(block)]
            out.append(argument_part(clean(m.group(1)), body))
    disclaimer = clean((re.search(r'<p class="disclaimer">(.*?)</p>', h, re.S) or [None, ""])[1])
    return {"arguments": out, "disclaimer": disclaimer}


# ---------------------------------------------------------------------------
# Calaveras County.

def county_contests(fips, cfg):
    t = pdf_text(cfg["candidates_pdf"])
    contests, current = [], None
    lines = t.splitlines()
    for idx, raw in enumerate(lines):
        m = re.match(r"^(\d{4})\s+(.+?)\s{3,}On Ballot:\s*(Yes|No)\s+Vote For:\s*(\d+)", raw.strip())
        if m:
            current = {"id": f"{fips}-{m.group(1)}", "office": m.group(2).strip(), "scope": "county", "county": fips, "district": None,
                       "on_ballot": m.group(3) == "Yes", "vote_for": int(m.group(4)), "candidates": [],
                       "source_url": cfg["candidates_pdf"], "source": f"{cfg['name']} Elections, Qualified Candidates List",
                       "results_url": cfg["results_page"]}
            contests.append(current)
            continue
        m = re.match(r"^Qualified\s+\d+\s+(.+?)\s{3,}Candidate Stmt Filed\?", raw.strip())
        if m and current is not None:
            designation = lines[idx + 1].strip() if idx + 1 < len(lines) else ""
            if re.match(r"^(Res:|Qualified)", designation):
                designation = ""
            current["candidates"].append({"name": m.group(1).strip(), "designation": designation, "party": None, "incumbent": designation == "Incumbent"})
    on = [c for c in contests if c["on_ballot"] and c["candidates"]]
    log(f"{cfg['name']}: {len(contests)} local contests, {len(on)} on the ballot: {[c['office'] for c in on]}")
    for c in on:
        del c["on_ballot"]
    return on


PAMPHLET_SKIP = re.compile(r"^(\d{3}[A-Z0-9]{4,}|E?\d{6}\b.*Proof.*|005-.*Proof.*|INTENTIONALLY LEFT BLANK|CONTINUE TO NEXT PAGE.*|➔)$")
# Lines giving an email address or phone number are left out of statements (the same for every candidate); websites stay.
CONTACT = re.compile(r"^(e-?mail|phone|tel|telephone)\s*:|[\w.+-]+@[\w-]+\.[\w.]+|\(?\b\d{3}\)?[ .-]\d{3}-\d{4}\b", re.I)
COUNTY_ABBR = {"CCD": "COMMUNITY COLLEGE DISTRICT", "FPD": "FIRE PROTECTION DISTRICT", "PUD": "PUBLIC UTILITY DISTRICT", "TA": "TRUSTEE AREA",
               "USD": "UNIFIED SCHOOL DISTRICT", "UHSD": "UNION HIGH SCHOOL DISTRICT", "ANGELS": "ANGELS CAMP"}


def pamphlet_lines(cfg):
    """The pamphlet as (indent, text) lines, without printer's marks and page furniture."""
    out = []
    for raw in pdf_text(cfg["pamphlet_pdf"]).splitlines():
        s = raw.strip()
        if PAMPHLET_SKIP.match(s):
            out.append((0, ""))
            continue
        out.append((len(raw) - len(raw.lstrip()), s))
    return out


def reflow(lines):
    """Join printed lines into paragraphs. A paragraph ends at a blank line, a bullet
    or numbered item, or a line that stops well short of the column (as printed)."""
    width = max((len(t) for _, t in lines if t), default=0)
    paras, cur, prev = [], [], None
    for indent, t in lines:
        if not t:
            if cur:
                paras.append(" ".join(cur))
                cur = []
            continue
        # A bullet or numbered item starts a paragraph; so does a line set back left of the one before (the end of an item).
        if cur and (re.match(r"^(•|\d+\.\s)", t) or (prev is not None and indent < prev - 2)):
            paras.append(" ".join(cur))
            cur = []
        cur.append(t)
        prev = indent
        if len(t) < width * 0.85 and re.search(r"[.!?:”\"]$", t):
            paras.append(" ".join(cur))
            cur = []
    if cur:
        paras.append(" ".join(cur))
    return [re.sub(r"\s+", " ", re.sub(r"(\w)- (\w)", r"\1-\2", p)).strip() for p in paras if p.strip()]


def is_heading(indent, t):
    return indent >= 10 and len(t) < 90 and t == t.upper() and re.search(r"[A-Z]{3}", t) and "AGE:" not in t and not t.startswith(("/S/", "BY:"))


def pamphlet(fips, cfg, contests, local):
    """Candidate statements and local measures from the county's Voter Information Pamphlet."""
    lines = pamphlet_lines(cfg)
    # A statement: a centered heading (one or two lines: the office, then the seat),
    # the name ("NAME   AGE: 52", or the name alone), "Occupation: ..." if given, then the text.
    blocks, cur, heading, last_heading_i = [], None, [], -9
    for i, (indent, t) in enumerate(lines):
        if re.match(r"^(BOND MEASURE|IMPARTIAL ANALYSIS|MEASURE [A-Z]$|TAX RATE STATEMENT|ARGUMENT|REBUTTAL|FULL TEXT)", t):
            break
        if t and is_heading(indent, t):
            heading = heading + [t] if last_heading_i >= i - 2 and heading else [t]
            last_heading_i = i
            cur = None
            continue
        m = re.match(r"^([A-Z][A-Z .,'()\"-]+?)(?:\s{3,}AGE:\s*(\d+))?$", t)
        if m and heading and indent < 10 and cur is None and len(t) < 200:
            cur = {"heading": " ".join(heading), "name": m.group(1).strip(), "age": m.group(2), "lines": []}
            blocks.append(cur)
            continue
        if cur is not None:
            cur["lines"].append((indent, t))
    found = 0
    for b in blocks:
        body = [(i, t) for i, t in b["lines"] if not CONTACT.search(t)]
        dropped_contact = len(body) != len(b["lines"])
        occ = next((t for _, t in body if t.startswith("Occupation:")), None)
        body = [(i, t) for i, t in body if t != occ]
        target = pamphlet_contest(b["heading"], b["name"], contests + local)
        cand = match_candidate(target["candidates"], b["name"]) if target else None
        if not cand:
            log(f"pamphlet statement not matched: {b['heading']} / {b['name']}")
            continue
        if cand.get("statement"):
            continue
        note = "Text from the county's PDF, as printed" + ("; the candidate's email and phone are left out" if dropped_contact else "") + ". The PDF is the official version."
        cand["statement"] = {"header": ([f"Age: {b['age']}"] if b["age"] else []) + ([occ] if occ else []), "paragraphs": reflow(body),
                             "source_url": cfg["pamphlet_pdf"], "source": f"{cfg['name']} Voter Information Pamphlet", "note": note}
        found += 1
    log(f"{cfg['name']} pamphlet: {len(blocks)} statements, {found} matched")
    return pamphlet_measures(fips, cfg, lines)


def county_words(s):
    s = s.upper()
    for k, v in COUNTY_ABBR.items():
        s = re.sub(rf"\b{k}(?=\d|\b)", v + " ", s)
    return set(re.findall(r"[A-Z]{3,}|\d+", s)) - {"THE", "AND", "MEMBER", "GOVERNING", "BOARD", "DISTRICT", "COUNTY", "CALAVERAS", "FULL", "TERM", "DIRECTOR", "CITY", "STATE", "UNITED", "STATES"}


def pamphlet_contest(heading, name, contests):
    h = heading.upper()
    m = re.search(r"DISTRICT\s+(\d+)", h)
    num = m.group(1) if m else None
    if "UNITED STATES REPRESENTATIVE" in h:
        return next((c for c in contests if c["scope"] == "cd" and c["district"] == num), None)
    if re.search(r"STATE SEN", h):  # the pamphlet has a misprint ("SENTATOR") on one page
        return next((c for c in contests if c["scope"] == "sldu" and c["district"] == num), None)
    if "ASSEMBLY" in h:
        return next((c for c in contests if c["scope"] == "sldl" and c["district"] == num), None)
    # Local contests: the candidate must be on that contest's list; the heading's words decide between several.
    pool = [c for c in contests if c["scope"] == "county" and match_candidate(c["candidates"], name)]
    words = county_words(h)
    pool.sort(key=lambda c: -len(words & county_words(c["office"])))
    return pool[0] if pool else None


def pamphlet_measures(fips, cfg, lines):
    """Local measures: the ballot question, County Counsel's impartial analysis,
    the tax rate statement and the arguments, each as printed."""
    texts = [t for _, t in lines]
    measures = []
    letters = sorted({m.group(1) for t in texts for m in [re.match(r"^MEASURE ([A-Z])$", t)] if m})
    for letter in letters:
        def part(title):
            """Lines after a heading ("IMPARTIAL ANALYSIS BY COUNTY COUNSEL" / "MEASURE A") up to the next heading."""
            for i, t in enumerate(texts):
                if re.match(title, t) and (f"MEASURE {letter}" in t or (i + 1 < len(texts) and texts[i + 1] == f"MEASURE {letter}")):
                    j = i + 1 + (texts[i + 1] == f"MEASURE {letter}")
                    k = j
                    while k < len(lines) and not (lines[k][1] and lines[k][0] >= 10 and re.match(r"^(IMPARTIAL ANALYSIS|TAX RATE STATEMENT|ARGUMENT|REBUTTAL|FULL TEXT|MEASURE [A-Z]$)", lines[k][1])):
                        k += 1
                    return lines[j:k]
            return None
        ia = part(r"^IMPARTIAL ANALYSIS")
        question, analysis, by = None, [], None
        if ia:
            ia = [(i, t) for i, t in ia]
            q_end = next((n for n, (_, t) in enumerate(ia) if t.endswith("?")), None)
            if q_end is not None and q_end < 15:
                question = re.sub(r"\s+", " ", " ".join(t for _, t in ia[: q_end + 1])).strip()
                ia = ia[q_end + 1:]
            sig = next((n for n, (_, t) in enumerate(ia) if t.startswith("By: /s/")), None)
            if sig is not None:
                by = " ".join(t for _, t in ia[sig + 1: sig + 2]).title() or None
                ia = ia[:sig] + ia[sig + 2:]
            analysis = reflow(ia)
        trs = part(r"^TAX RATE STATEMENT")
        args = []
        for kind, label in (("for", "IN FAVOR OF"), ("against", "AGAINST"), ("rebuttal_for", "REBUTTAL TO ARGUMENT AGAINST"), ("rebuttal_against", "REBUTTAL TO ARGUMENT IN FAVOR OF")):
            body = part(rf"^{'ARGUMENT ' + label if not kind.startswith('rebuttal') else label}\b")
            if body is None:
                continue
            txt = [(i, t) for i, t in body if t]
            signers = [{"name": x.split(",")[0].strip(), "title": ",".join(x.split(",")[1:]).strip()} for x in (re.sub(r"^/s/\s*", "", t) for _, t in txt if t.startswith("/s/"))]
            rest = [(i, t) for i, t in body if not t.startswith("/s/")]
            none = next((t.strip("()") for _, t in txt if re.match(r"^\(?None Filed\)?$", t, re.I)), None)
            heading = f"{'Argument ' if not kind.startswith('rebuttal') else ''}{label.title().replace('Of', 'of').replace('In Favor', 'in favor').replace('Against', 'against')} Measure {letter}"
            args.append({"kind": kind, "heading": heading, "paragraphs": [] if none else reflow(rest), "signers": signers,
                         "none_submitted": f"No argument {'against' if kind == 'against' else 'in favor of'} Measure {letter} was filed." if none else None})
        measures.append({
            "id": f"{fips}-measure-{letter.lower()}", "number": letter, "title": f"Measure {letter}", "question": question, "scope": "county", "county": fips,
            "jurisdiction": next((t.title() for t in texts[max(0, texts.index(f'MEASURE {letter}') - 2): texts.index(f'MEASURE {letter}')] if re.search(r"DISTRICT|CITY|COUNTY", t) and "MEASURE" not in t), None),
            "impartial_analysis": analysis, "impartial_analysis_by": by or "County Counsel",
            "tax_rate_statement": reflow(trs) if trs else [],
            "arguments": args,
            "links": {"pamphlet": cfg["pamphlet_pdf"], "page": cfg["elections_page"]},
            "results_url": cfg["results_page"], "source_url": cfg["pamphlet_pdf"], "source": f"{cfg['name']} Voter Information Pamphlet",
            "note": "Text from the county's PDF, as printed. The PDF is the official version.",
        })
    log(f"{cfg['name']} measures: {[(m['title'], m['jurisdiction'], bool(m['question']), len(m['impartial_analysis']), [(a['kind'], len(a['paragraphs']), len(a['signers']), bool(a['none_submitted'])) for a in m['arguments']]) for m in measures]}")
    return measures


# ---------------------------------------------------------------------------
# FEC candidate filings for U.S. House candidates (a link per candidate).

def fec_links(contests):
    key = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
    found, page = [], 1
    while page <= 10:
        try:
            d = json.loads(fetch(f"https://api.open.fec.gov/v1/candidates/?state=CA&office=H&election_year=2026&per_page=100&page={page}&api_key={key}"))
        except Exception as e:
            log(f"FEC: {e}")
            return
        found += d.get("results", [])
        if page >= (d.get("pagination") or {}).get("pages", 1):
            break
        page += 1
    n = 0
    for c in contests:
        if c["scope"] != "cd":
            continue
        pool = [f for f in found if str(int(f.get("district") or 0)) == c["district"]]
        for cand in c["candidates"]:
            hits = [f for f in pool if (f.get("name") or "").split(",")[0].strip().lower() == surname(cand["name"])]
            if len(hits) > 1:
                hits = [f for f in hits if f.get("candidate_status") == "C"] or hits
            if len(hits) == 1:
                cand["fec"] = {"id": hits[0]["candidate_id"], "url": f"https://www.fec.gov/data/candidate/{hits[0]['candidate_id']}/"}
                n += 1
    log(f"FEC filings linked: {n}")


def main():
    check = "--check" in sys.argv
    letters = alphabet()
    contests = certified_list()
    guide_statements(contests)
    fec_links(contests)
    measures = propositions()
    local, counties = [], {}
    for fips, cfg in COUNTIES.items():
        lc = county_contests(fips, cfg)
        local += lc
        measures += pamphlet(fips, cfg, contests, lc)
        counties[fips] = {k: cfg[k] for k in ("name", "elections_page", "results_page", "pamphlet_pdf", "boe")}
    doc = {
        "_readme": "Generated by tools/build_elections.py from official sources (Secretary of State, county elections offices, FEC); don't edit by hand. Each item has its source_url.",
        "election": {**ELECTION, "alphabet": letters},
        "how_to_vote": HOW_TO_VOTE,
        "counties": counties,
        "contests": contests + local,
        "measures": measures,
    }
    summary = f"{len(contests)} state and federal contests, {len(local)} local, {len(measures)} measures"
    log(summary)
    if check:
        print(json.dumps(doc, indent=1)[:20000])
        return
    out = ROOT / "data" / "elections" / f"{ELECTION['id']}.json"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    log(f"wrote {out.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
