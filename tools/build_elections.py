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
    return [c for c in contests if c["candidates"]]


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
                cand["statement"] = {"paragraphs": paras, "source_url": url, "source": "Official Voter Information Guide, Secretary of State"}
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
        props.append({
            "id": f"prop-{n}", "number": n, "title": title, "scope": "statewide",
            "summary": summary, "yes_means": yes, "no_means": no,
            "arguments": args["arguments"], "arguments_disclaimer": args["disclaimer"],
            "links": {"guide": base, "analysis": f"{base}analysis.htm", "arguments": args_url,
                      "text": f"https://vig.cdn.sos.ca.gov/2026/general/pdf/prop{n}-text-proposed-laws.pdf"},
            "results_path": "ballot-measures", "results_number": n.zfill(2),
            "source_url": base, "source": "Official Voter Information Guide, Secretary of State",
        })
    log(f"propositions: {[p['number'] for p in props]}")
    return props


def section(text, start, end):
    i = text.find(start)
    if i < 0:
        return None
    j = text.find(end, i + len(start))
    return text[i + len(start): j if j > 0 else None].strip()


def arguments(h):
    out = []
    for block in re.findall(r'<div class="grid-50 argumentsRebuttals">(.*?)</div>', h, re.S):
        m = re.search(r"<h3[^>]*>(.*?)</h3>", block, re.S)
        if not m:
            continue
        heading = clean(m.group(1))
        kind = ("rebuttal_for" if "REBUTTAL TO ARGUMENT AGAINST" in heading else "rebuttal_against" if "REBUTTAL TO ARGUMENT IN FAVOR" in heading
                else "for" if "IN FAVOR" in heading else "against" if "AGAINST" in heading else "other")
        paras = []
        for p in re.findall(r"<p[^>]*>(.*?)</p>", block[m.end():], re.S):
            items = re.findall(r"<li[^>]*>(.*?)</li>", p, re.S)
            if items:
                lead = clean(re.split(r"<ul", p)[0])
                if lead:
                    paras.append(lead)
                paras.extend(f"• {clean(x)}" for x in items)
            else:
                paras.append(clean(p))
        paras = [p for p in paras if p]
        signers = []
        if paras and "<strong>" in block:
            last = re.findall(r"<p[^>]*>((?:(?!</p>).)*<strong>.*?)</p>", block, re.S)
            if last:
                sig = last[-1]
                for name, rest in re.findall(r"<strong>(.*?)</strong>(.*?)(?=<strong>|$)", sig, re.S):
                    lines = [clean(x) for x in re.split(r"<br\s*/?>", rest) if clean(x)]
                    signers.append({"name": clean(name).rstrip(","), "title": ", ".join(lines)})
                signed = clean(sig)
                paras = [p for p in paras if p != signed]
        none_submitted = bool(paras) and re.match(r"NO (ARGUMENT|REBUTTAL).*WAS SUBMITTED", paras[0])
        out.append({"kind": kind, "heading": heading, "paragraphs": [] if none_submitted else paras, "signers": signers,
                    "none_submitted": paras[0] if none_submitted else None})
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


PAMPHLET_FOOTER = re.compile(r"^(\d{3}[A-Z0-9-]{3,}|E?\d{6}.*Proof|005-.*Proof|.*\|\s*5\.375.*)$")


def pamphlet(fips, cfg, contests, local):
    """Candidate statements and local measures from the county's Voter Information Pamphlet."""
    t = pdf_text(cfg["pamphlet_pdf"])
    lines = [l for l in t.splitlines() if not PAMPHLET_FOOTER.match(l.strip())]
    # Candidate statements: a heading line ("STATE SENATOR – DISTRICT 4"), then "NAME   AGE: 52",
    # "Occupation: ...", then the statement until the next heading or name line.
    blocks, cur, heading = [], None, None
    for raw in lines:
        s = raw.strip()
        if re.match(r"^[A-Z][A-Z .,&'/()-]+(?:\s[–—-]\s.+)$", s) and len(s) < 90 and "AGE:" not in s:
            heading = s
            cur = None
            continue
        m = re.match(r"^([A-Z][A-Z .,'()\"-]+?)\s{3,}AGE:\s*(\d+)$", s)
        if m and heading:
            cur = {"heading": heading, "name": m.group(1).strip(), "age": m.group(2), "lines": []}
            blocks.append(cur)
            continue
        if cur is not None:
            if re.match(r"^(IMPARTIAL ANALYSIS|MEASURE [A-Z]\b|ARGUMENT|REBUTTAL|TAX RATE STATEMENT|FULL TEXT)", s):
                cur = None
                continue
            cur["lines"].append(s)
    all_contests = contests + local
    found = 0
    for b in blocks:
        paras, para = [], []
        for s in b["lines"]:
            if not s:
                if para:
                    paras.append(" ".join(para))
                    para = []
                continue
            para.append(s)
        if para:
            paras.append(" ".join(para))
        paras = [re.sub(r"(\w)- (\w)", r"\1-\2", p) for p in paras]
        occ = next((p for p in paras if p.startswith("Occupation:")), None)
        body = [p for p in paras if p is not occ]
        target = pamphlet_contest(b["heading"], all_contests)
        cand = match_candidate(target["candidates"], b["name"].title()) if target else None
        if not cand:
            log(f"pamphlet statement not matched: {b['heading']} / {b['name']}")
            continue
        if cand.get("statement"):
            continue
        cand["statement"] = {"header": [f"Age: {b['age']}"] + ([occ] if occ else []), "paragraphs": body,
                             "source_url": cfg["pamphlet_pdf"], "source": f"{cfg['name']} Voter Information Pamphlet",
                             "note": "Text from the county's PDF, as printed; the PDF is the official version."}
        found += 1
    log(f"{cfg['name']} pamphlet: {len(blocks)} statements, {found} matched")
    return pamphlet_measures(fips, cfg, lines)


def pamphlet_contest(heading, contests):
    h = heading.upper()
    m = re.search(r"DISTRICT\s+(\d+)", h)
    num = m.group(1) if m else None
    if "UNITED STATES REPRESENTATIVE" in h:
        return next((c for c in contests if c["scope"] == "cd" and c["district"] == num), None)
    if "STATE SENAT" in h:
        return next((c for c in contests if c["scope"] == "sldu" and c["district"] == num), None)
    if "ASSEMBLY" in h:
        return next((c for c in contests if c["scope"] == "sldl" and c["district"] == num), None)
    words = set(re.findall(r"[A-Z]{3,}", h)) - {"DISTRICT", "MEMBER", "THE", "AND", "GOVERNING", "BOARD"}
    best, score = None, 0
    for c in contests:
        if c["scope"] != "county":
            continue
        cw = set(re.findall(r"[A-Z]{3,}", c["office"].upper()))
        s = len(words & cw)
        if s > score:
            best, score = c, s
    return best


def pamphlet_measures(fips, cfg, lines):
    text = "\n".join(lines)
    measures = []
    for letter in sorted(set(re.findall(r"^\s*MEASURE ([A-Z])\s*$", text, re.M))):
        # The ballot question: the first paragraph of County Counsel's impartial analysis, which restates it.
        ia = re.search(r"IMPARTIAL ANALYSIS[^\n]*\n\s*MEASURE " + letter + r"\s*\n(.*?)(?=\n\s*(?:ARGUMENT|TAX RATE STATEMENT|FULL TEXT|REBUTTAL|MEASURE [A-Z]\s*\n))", text, re.S)
        analysis = paragraphs(ia.group(1)) if ia else []
        question = analysis[0] if analysis and analysis[0].endswith("?") else None
        args = []
        for kind, label in (("for", "IN FAVOR"), ("against", "AGAINST")):
            m = re.search(r"ARGUMENT " + label + r"[^\n]*MEASURE " + letter + r"[^\n]*\n(.*?)(?=\n\s*(?:ARGUMENT|REBUTTAL|FULL TEXT|IMPARTIAL|TAX RATE|MEASURE [A-Z]\s*\n)|\Z)", text, re.S)
            if m:
                args.append({"kind": kind, "heading": f"Argument {label.lower()} of Measure {letter}", "paragraphs": paragraphs(m.group(1)), "signers": [], "none_submitted": None})
        measures.append({
            "id": f"{fips}-measure-{letter.lower()}", "number": letter, "title": f"Measure {letter}", "question": question, "scope": "county", "county": fips,
            "impartial_analysis": analysis[1:] if question else analysis, "impartial_analysis_by": "County Counsel",
            "arguments": args, "arguments_note": "No argument against is printed in the pamphlet." if not any(a["kind"] == "against" for a in args) else None,
            "links": {"pamphlet": cfg["pamphlet_pdf"], "page": cfg["elections_page"]},
            "results_url": cfg["results_page"], "source_url": cfg["pamphlet_pdf"], "source": f"{cfg['name']} Voter Information Pamphlet",
            "note": "Text from the county's PDF, as printed; the PDF is the official version.",
        })
    log(f"{cfg['name']} measures: {[(m['title'], bool(m['question']), [a['kind'] for a in m['arguments']]) for m in measures]}")
    return measures


def paragraphs(block):
    out, cur = [], []
    for s in block.splitlines():
        s = s.strip()
        if not s:
            if cur:
                out.append(" ".join(cur))
                cur = []
            continue
        cur.append(s)
    if cur:
        out.append(" ".join(cur))
    return [re.sub(r"(\w)- (\w)", r"\1-\2", p) for p in out]


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
