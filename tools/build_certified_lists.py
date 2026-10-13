#!/usr/bin/env python3
"""
The November 3, 2026 general election's federal candidates, from each state's
own official list (docs/candidates.md, "Certified lists"):

  NC  State Board of Elections, Candidate_Listing_2026.csv: the rows for the
      11/03/2026 election (the general); names as on the ballot.
  NJ  Division of Elections, "Certification of General Election Nominees:
      U.S. Senate & U.S. House of Representatives" and every "Amended
      Certification" for a district or the Senate (the latest replaces it).
  FL  Division of Elections, "Candidate Listing for 2026 General Election"
      (federal offices): candidates with the status Qualified; Defeated and
      Withdrawn are left out.

Writes data/elections/certified-2026/<st>.json: the source, when it was read,
and for the U.S. Senate (when a seat is up) and each U.S. House district the
candidates in the order the list gives them, with party as written and the
incumbent mark where the list has one. Only names, parties and that mark are
kept: never addresses, phone numbers or email addresses, which some lists
include. A state whose list doesn't read cleanly is left as it was (a
problem is printed and the run fails), never written partly.

  python3 tools/build_certified_lists.py            # every state it knows
  python3 tools/build_certified_lists.py --states NC,NJ
  python3 tools/build_certified_lists.py --dry-run   # print, write nothing
Standard library plus pdftotext (poppler-utils).
"""
import argparse
import csv
import html
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.error
import urllib.parse
import urllib.request
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "elections" / "certified-2026"
UA = "ThePillory (civic data; +https://thepillory.co)"
ELECTION = "2026-11-03"


class Unreadable(Exception):
    pass


def get(url, timeout=120):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def pdf_text(data):
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        return subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, check=True).stdout


def contest(out, key, district, cand):
    """Adds a candidate once (lists repeat a candidate per county)."""
    if key == "senate":
        lst = out.setdefault("senate", [])
    else:
        lst = out.setdefault("house", {}).setdefault(str(int(district)), [])
    if not any(c["name"] == cand["name"] for c in lst):
        lst.append(cand)


# ---------------------------------------------------------------------------
# North Carolina

NC_URL = "https://s3.amazonaws.com/dl.ncsbe.gov/Elections/2026/Candidate%20Filing/Candidate_Listing_2026.csv"
NC_PAGE = "https://www.ncsbe.gov/results-data/candidate-lists"
NC_PARTY = {"DEM": "Democratic", "REP": "Republican", "LIB": "Libertarian", "GRE": "Green", "UNA": "Unaffiliated", "CST": "Constitution", "JFA": "Justice for All", "NLB": "No Labels", "WTP": "We the People"}


def parse_nc(text):
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        if r.get("election_dt") != "11/03/2026":
            continue
        name_c = (r.get("contest_name") or "").strip().upper()
        cand = {"name": (r.get("name_on_ballot") or "").strip(), "party": NC_PARTY.get((r.get("party_candidate") or "").strip().upper(), (r.get("party_candidate") or "").strip() or None)}
        if not cand["name"]:
            raise Unreadable(f"a row in {name_c} has no name on the ballot")
        if name_c == "US SENATE":
            contest(out, "senate", None, cand)
        else:
            m = re.fullmatch(r"US HOUSE OF REPRESENTATIVES DISTRICT (\d+)", name_c)
            if m:
                contest(out, "house", m.group(1), cand)
    return out


def build_nc():
    text = get(NC_URL).decode("utf-8-sig", "replace")
    return {"source": {"name": "North Carolina State Board of Elections, 2026 Candidate List", "url": NC_URL, "page": NC_PAGE}, "contests": parse_nc(text)}


# ---------------------------------------------------------------------------
# New Jersey

NJ_PAGE = "https://www.nj.gov/state/elections/election-information-2026.shtml"
NJ_BASE = "https://www.nj.gov/state/elections/"
ORDINALS = {w: i for i, w in enumerate("First Second Third Fourth Fifth Sixth Seventh Eighth Ninth Tenth Eleventh Twelfth".split(), 1)}


def parse_nj(text):
    """One certification PDF's text -> (date, {senate: [...], house: {d: [...]}}); amended files cover one office or district."""
    out = {}
    office, district = None, None
    dated = re.search(r"(\d{2})/(\d{2})/(\d{4})\s+Official List", text)
    for line in text.split("\n"):
        if re.search(r"Candidates for US Senate", line):
            office, district = "senate", None
            continue
        if re.search(r"Candidates for House of Representatives", line):
            office = "house"
            continue
        m = re.match(r"\s*(\w+) Congressional District\b", line)
        if m and m.group(1) in ORDINALS:
            district = ORDINALS[m.group(1)]
            continue
        # A candidate: the name from the left margin, two or more spaces, the address, then the party.
        m = re.match(r"^([A-Z][A-Z .,'\-\"()]+?)( \*)?\s{2,}\S.*?\s{2,}(\S.*?)\s*$", line)
        if not m or office is None or re.match(r"^(Name|Candidate Totals|Total Candidates)\b", line):
            continue
        name, inc, party = m.group(1).strip(), bool(m.group(2)), m.group(3).strip()
        if office == "house" and district is None:
            raise Unreadable(f"{name}: a House candidate before any district heading")
        cand = {"name": name, "party": party, **({"incumbent": True} if inc else {})}
        contest(out, office, district, cand)
    if not dated:
        raise Unreadable("no date on the certification")
    return f"{dated.group(3)}-{dated.group(1)}-{dated.group(2)}", out


def build_nj():
    page = get(NJ_PAGE).decode("utf-8", "replace")
    links = []
    for href, label in re.findall(r'href="([^"]+\.pdf)"[^>]*>(.*?)</a>', page, re.S):
        t = html.unescape(re.sub(r"<[^>]+>|\s+", " ", label)).strip()
        if re.search(r"Certification", t) and re.search(r"General Election", t) and re.search(r"U\.S\. (Senate|House)", t) and not re.search(r"Special|President|Legislative", t):
            links.append((t, urllib.parse.urljoin(NJ_PAGE, href)))
    if not links:
        raise Unreadable("no general election certification linked from the election information page")
    merged, sources = {}, []
    for label, url in sorted(links, key=lambda x: "Amended" in x[0]):  # the original first, then each amendment
        try:
            day, got = parse_nj(pdf_text(get(url)))
        except urllib.error.HTTPError as e:
            if "Amended" not in label:
                raise
            # An amendment the state links but doesn't serve: what it covers can't be confirmed, so it's left out.
            m = re.search(r"(\d+)(?:st|nd|rd|th) Cong", label)
            if m:
                merged.setdefault("_unconfirmed", []).append(str(int(m.group(1))))
            elif "Senate" in label:
                merged.setdefault("_unconfirmed", []).append("senate")
            print(f"NJ: {label}: {e}; that race is left out", flush=True)
            continue
        sources.append({"name": label, "url": url, "dated": day})
        if "senate" in got:
            merged["senate"] = got["senate"]
        for d, lst in got.get("house", {}).items():
            merged.setdefault("house", {})[d] = lst
    for key in merged.pop("_unconfirmed", []):
        if key == "senate":
            merged.pop("senate", None)
        else:
            merged.get("house", {}).pop(key, None)
    if not merged.get("house"):
        raise Unreadable("no House candidates read")
    return {"source": {"name": "New Jersey Division of Elections, Certification of General Election Nominees", "url": sources[0]["url"], "page": NJ_PAGE, "files": sources}, "contests": merged}


# ---------------------------------------------------------------------------
# Florida

FL_PAGE = "https://dos.elections.myflorida.com/candidates/downloadcanlist.asp"
FL_EXTRACT = "https://dos.elections.myflorida.com/candidates/extractCanList.asp"
FL_LIST = "https://dos.elections.myflorida.com/candidates/canlist.asp?elecid=20261103-GEN&cantype=FED"


def fl_option(page, select, *wants):
    """The value of the first option in <select name=select> whose value or text matches one of `wants` (case-insensitive)."""
    m = re.search(rf'<select[^>]*name="{select}"[^>]*>(.*?)</select>', page, re.S | re.I)
    if not m:
        raise Unreadable(f"the download form has no {select} field")
    opts = [(v.strip(), html.unescape(t).strip()) for v, t in re.findall(r'<option[^>]*value\s*=\s*"([^"]*)"[^>]*>\s*([^<]*)', m.group(1), re.S | re.I)]
    for want in wants:
        for value, text in opts:
            if want.upper() in (value.upper(), text.upper()):
                return value
    raise Unreadable(f"the download form's {select} field has none of {wants}: {opts[:12]}")


def parse_fl(text):
    """Florida's tab-delimited extract -> contests. Only candidates whose status is Qualified."""
    out = {}
    rows = list(csv.DictReader(io.StringIO(text), delimiter="\t"))
    if not rows or "OfficeCode" not in rows[0]:
        raise Unreadable("the extract isn't the documented tab-delimited file")
    for r in rows:
        office = (r.get("OfficeCode") or "").strip().upper()
        if office not in ("USS", "USR") or (r.get("StatusDesc") or "").strip() != "Qualified":
            continue  # Defeated (lost the primary), Withdrawn, Did not qualify
        name = " ".join(x for x in ((r.get("NameFirst") or "").strip(), (r.get("NameMiddle") or "").strip(), (r.get("NameLast") or "").strip()) if x)
        cand = {"name": name, "party": (r.get("PartyName") or "").strip() or None}
        if office == "USS":
            contest(out, "senate", None, cand)
        else:
            d = (r.get("Juris1num") or "").strip()
            if not d.isdigit():
                raise Unreadable(f"{name}: no district")
            contest(out, "house", d, cand)
    return out


def build_fl():
    page = get(FL_PAGE).decode("latin-1", "replace")
    form = {"elecID": "20261103-GEN", "office": fl_option(page, "office", "ALL", "All Offices", ""), "status": fl_option(page, "status", "ALL", "All", ""), "cantype": fl_option(page, "cantype", "FED", "Federal", "ALL", "All", ""), "FormSubmit": "Download Candidate List"}
    req = urllib.request.Request(FL_EXTRACT, data=urllib.parse.urlencode(form).encode(), headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=120) as r:
        text = r.read().decode("latin-1", "replace")
    got = parse_fl(text)
    if not got.get("house"):
        raise Unreadable("no House candidates read")
    return {"source": {"name": "Florida Division of Elections, candidate list for the 2026 General Election (status Qualified)", "url": FL_LIST, "page": FL_PAGE}, "contests": got}


BUILDERS = {"NC": build_nc, "NJ": build_nj, "FL": build_fl}


def check(st, data):
    """A list that reads oddly isn't written: every House race has a candidate, nobody appears twice in a race."""
    c = data["contests"]
    for d, lst in (c.get("house") or {}).items():
        if not lst:
            raise Unreadable(f"House district {d} has no candidates")
    for lst in [c.get("senate") or []] + list((c.get("house") or {}).values()):
        names = [x["name"] for x in lst]
        if len(names) != len(set(names)):
            raise Unreadable("a candidate appears twice in one race")


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--states", default=",".join(BUILDERS))
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    failed = []
    for st in [s.strip().upper() for s in args.states.split(",") if s.strip()]:
        try:
            data = BUILDERS[st]()
            check(st, data)
        except (Unreadable, OSError, subprocess.CalledProcessError) as e:
            print(f"{st}: not written: {e}", flush=True)
            failed.append(st)
            continue
        c = data["contests"]
        doc = {
            "_readme": "Generated by tools/build_certified_lists.py from the state's own list; don't edit by hand.",
            "state": st, "election": ELECTION, "read_on": date.today().isoformat(), **data,
        }
        print(f"{st}: U.S. Senate {len(c.get('senate') or [])} candidates; U.S. House {len(c.get('house') or {})} districts, {sum(len(v) for v in (c.get('house') or {}).values())} candidates", flush=True)
        if args.dry_run:
            print(json.dumps(doc, indent=1)[:3000])
            continue
        OUT.mkdir(parents=True, exist_ok=True)
        (OUT / f"{st.lower()}.json").write_text(json.dumps(doc, indent=1, ensure_ascii=False) + "\n")
    if failed:
        sys.exit(f"Not written: {', '.join(failed)}")


if __name__ == "__main__":
    main()
