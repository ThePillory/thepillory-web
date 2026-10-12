"""
Money from government to organizations, and outside contacts and travel:
pure parsers, tested in tools/test_govmoney.py; tools/load_gov_money.py
downloads the sources and writes D1 (migration 0031). See docs/funding.md.

  - Earmarks. The Appropriations Committees' tables, read as `pdftotext -layout`
    text: each project is a record whose first line ends with its origination
    (H, S or H/S), with wrapped text on the lines below. Requesters are split
    into House and Senate by their column (two cells: House, then Senate), or
    by the origination when only one chamber's member asked. "[Dollars in thousands]" pages
    are scaled. A table without an origination column, or whose records don't
    all read cleanly, is left as a link. The House's consolidated spreadsheets
    of members' requests are read as they are.
  - Privately paid travel. The House Clerk's gift travel search results (member,
    traveler, destination, dates, sponsor, report), and the Senate's Gift Rule
    database (traveler, office, dates, report; sponsor and destination are on the
    scanned report itself).
  - FARA. The Justice Department's bulk files of registrants and foreign
    principals, and the "Response to Item 12-Detail" table of a supplemental
    statement (political activities: foreign principal, date, contact, method).

Names of members are matched to officials only on exactly one match. Staff and
other individuals contacted or traveling aren't stored by name.
"""
import csv
import hashlib
import html
import io
import re
import unicodedata
import xml.etree.ElementTree as ET

STATES = {
    "Alabama": "AL", "Alaska": "AK", "Arizona": "AZ", "Arkansas": "AR", "California": "CA", "Colorado": "CO", "Connecticut": "CT", "Delaware": "DE",
    "District of Columbia": "DC", "Florida": "FL", "Georgia": "GA", "Hawaii": "HI", "Idaho": "ID", "Illinois": "IL", "Indiana": "IN", "Iowa": "IA",
    "Kansas": "KS", "Kentucky": "KY", "Louisiana": "LA", "Maine": "ME", "Maryland": "MD", "Massachusetts": "MA", "Michigan": "MI", "Minnesota": "MN",
    "Mississippi": "MS", "Missouri": "MO", "Montana": "MT", "Nebraska": "NE", "Nevada": "NV", "New Hampshire": "NH", "New Jersey": "NJ",
    "New Mexico": "NM", "New York": "NY", "North Carolina": "NC", "North Dakota": "ND", "Ohio": "OH", "Oklahoma": "OK", "Oregon": "OR",
    "Pennsylvania": "PA", "Rhode Island": "RI", "South Carolina": "SC", "South Dakota": "SD", "Tennessee": "TN", "Texas": "TX", "Utah": "UT",
    "Vermont": "VT", "Virginia": "VA", "Washington": "WA", "West Virginia": "WV", "Wisconsin": "WI", "Wyoming": "WY", "Puerto Rico": "PR",
    "Guam": "GU", "American Samoa": "AS", "Virgin Islands": "VI", "Northern Mariana Islands": "MP",
}
CODES = set(STATES.values())
ORIGINS = {"H", "S", "H/S", "S/H"}
AMOUNT = re.compile(r"^\$?\d{1,3}(?:,\d{3})*$")
SUBCOMMITTEES = [
    ("agriculture", re.compile(r"\bagricultur", re.I)),
    ("cjs", re.compile(r"commerce,? justice|\bcjs\b", re.I)),
    ("defense", re.compile(r"^defense\b|department of defense appropriations", re.I)),
    ("energy-water", re.compile(r"energy (and|&) water|\bewd\b", re.I)),
    ("fsgg", re.compile(r"financial services|\bfsgg\b", re.I)),
    ("homeland", re.compile(r"homeland", re.I)),
    ("interior", re.compile(r"\binterior\b", re.I)),
    ("lhhs", re.compile(r"labor,? (health|hhs)|\blhhs\b", re.I)),
    ("legislative", re.compile(r"legislative branch", re.I)),
    ("milcon-va", re.compile(r"military construction|\bmcva\b|milcon", re.I)),
    ("sfops", re.compile(r"state,? foreign operations|national security, department of state", re.I)),
    ("thud", re.compile(r"transportation,? housing|\bthud\b", re.I)),
]


def subcommittee_of(text):
    for key, rx in SUBCOMMITTEES:
        if rx.search(text or ""):
            return key
    return None


def digest(*parts):
    return hashlib.sha1("|".join(str(p) for p in parts).encode()).hexdigest()[:20]


def amount(s):
    return float(re.sub(r"[$,\s]", "", s))


def _clean(line):
    """Stray marks pdftotext leaves after an amount ('1,092,000‘')."""
    return re.sub(r"(\d,\d{3})[‘’'`]", r"\1 ", line)


def _cells(line):
    """A pdftotext -layout line → [(start column, text)], cells split at 2+ spaces."""
    return [(m.start(), m.group(0).strip()) for m in re.finditer(r"\S+(?: \S+)*", line)]


def _center(start, text):
    return start + len(text) / 2


def _nearest(cols, start, text):
    """The column heading (centered over its column) nearest this cell's center."""
    c = _center(start, text)
    return min(cols, key=lambda h: abs(_center(h[0], h[1]) - c))[1]


def _by_start(cols, start):
    """The column whose cell (as a record line placed it) starts at or before this one."""
    best = cols[0][1]
    for s, n in cols:
        if s <= start + 2:
            best = n
    return best


NOT_LEFT = re.compile(r"Amount|Request|Origination|House|Senate|\(\$\)|Total|Additional")


def _join(a, b):
    a, b = a.strip(), b.strip()
    if not a:
        return b
    if not b:
        return a
    if a.endswith("-") and b[:1].islower():
        return a[:-1] + b
    return f"{a} {b}"


def _names(text):
    """'Blunt Rochester, Coons' → ['Blunt Rochester', 'Coons']; 'Torres (CA)' stays whole."""
    text = re.sub(r"(\w)- (\w)", r"\1-\2", text or "")  # "Cherfilus- McCormick", wrapped at the hyphen
    return [n.strip() for n in re.split(r",(?![^()]*\))", text) if n.strip()]


class Unreadable(Exception):
    """A table that can't be read in full: it stays a link."""


def parse_table(text, fy, subcommittee, source_url, stage="enacted"):
    """
    One Appropriations table (pdftotext -layout text) → earmark rows:
    [{id, fy, stage, subcommittee, agency, account, state, location, recipient, project,
      amount, origination, page, house: [...], senate: [...], source_url}].
    """
    if "Origination" not in text:
        raise Unreadable("no origination column")
    rows = []
    header = None  # [(start, name)] of the column headings, kept for the pages that don't repeat them
    base_left = None  # where the first record's first cell started under that header
    additional = False
    thousands = False
    chambers = None  # where the House and Senate requester columns start
    for page_no, page in enumerate(text.split("\f"), 1):
        if "[Dollars in thousands]" in page:
            thousands = True
        shift = 0  # facing pages have different margins: header positions move with them
        fresh = False
        page_cols = None  # where this page's record lines put each left-hand column
        cur = None
        for line in page.splitlines():
            line = _clean(line)
            stripped = line.strip()
            if not stripped or re.fullmatch(r"\d{1,4}", stripped):
                continue
            if re.search(r"\b(Agency|State)\b.*\b(Account|Project)\b", line) and not re.search(r"\d,\d{3}", line) and ("Origination" in line or "Amount" in line or "Project" in line):
                if cur:
                    rows.append(cur)
                header, base_left, fresh, shift, cur, page_cols = _cells(line), None, True, 0, None, None
                continue
            if "Additional" in line and "Total Amount" in line:
                additional = True
            hs = re.search(r"\bHouse\b\s+\bSenate\b", line)
            if hs and not re.search(r"\d", line):
                chambers = (hs.start(), line.index("Senate", hs.start()))
                continue
            cells = _cells(line)
            last = cells[-1][1] if cells else ""
            nums = [i for i, (_, t) in enumerate(cells) if AMOUNT.match(t)]
            if header and last in ORIGINS and nums:
                if cur:
                    rows.append(cur)
                if base_left is None:
                    base_left = cells[0][0]
                elif not fresh and shift == 0 and cur is None:
                    shift = cells[0][0] - base_left
                fresh = True
                cols = [(h + shift, n) for h, n in header]
                r_end = nums[-1]
                pick = nums[-2] if additional and len(nums) >= 2 else nums[-1]
                left = cells[: nums[0]]
                req = cells[r_end + 1: -1]
                names_left = [n for _, n in header if not NOT_LEFT.search(n)]
                if len(left) == len(names_left):
                    # One cell per column: this line shows where each column starts on this page.
                    page_cols = [(s, n) for (s, _), n in zip(left, names_left)]
                fields = {}
                for start, t in left:
                    name = _by_start(page_cols, start) if page_cols else _nearest(cols, start, t)
                    fields[name] = _join(fields.get(name, ""), t)
                cur = {"cols": cols, "page_cols": page_cols, "chambers": (chambers[0] + shift, chambers[1] + shift) if chambers else None,
                    "fields": fields, "left": left, "req": [[s, t] for s, t in req], "req_start": req[0][0] if req else cells[-1][0] - 2,
                    "num_start": cells[nums[0]][0], "amount": amount(cells[pick][1]) * (1000 if thousands else 1), "origination": last, "page": page_no,
                }
                continue
            if not cur or not header:
                continue
            if re.search(r"Continued|\[Community Project|\[Congressionally Directed|\[Dollars in thousands\]|Requester|Requestor", line):
                continue
            for start, t in cells:
                if start >= cur["req_start"] - 3:
                    if cur["req"]:
                        target = min(cur["req"], key=lambda c: abs(c[0] - start))
                        target[1] = _join(target[1], t)
                    else:
                        cur["req"].append([start, t])
                elif start < cur["num_start"] - 1:
                    name = _by_start(cur["page_cols"], start) if cur["page_cols"] else _nearest(cur["cols"], start, t)
                    cur["fields"][name] = _join(cur["fields"].get(name, ""), t)
        if cur:
            rows.append(cur)
    out = []
    for i, r in enumerate(rows):
        f = {k.lower(): v for k, v in r["fields"].items()}
        get = lambda *keys: next((v for k, v in f.items() if any(x in k for x in keys)), None)
        project = get("project")
        recipient = get("recipient") if not any(("project" in k and "recipient" in k) for k in f) else None
        if project and "project name; recipient" in " ".join(f) and ";" in project:
            project, recipient = [p.strip() for p in project.rsplit(";", 1)]
        state = get("state")
        if state in STATES:
            state = STATES[state]
        location = get("location")
        if not state and location and location.upper() in CODES:
            state, location = location.upper(), None
        if not state:
            for text in (location, project):
                m = re.search(r",\s*([A-Z]{2})(?:[;,]|$|\s)", text or "")
                if m and m.group(1) in CODES:
                    state = m.group(1)
                    break
        if not recipient and project:
            # "Recipient, ST, for what it funds" (the Senate's Labor-HHS style).
            m = re.match(r"(.+?), ([A-Z]{2}), (?:for|to)\b", project)
            if m and m.group(2) in CODES:
                recipient = m.group(1)
        if not project:
            project = location or recipient
        names = [n for _, t in r["req"] for n in _names(t)]
        house, senate = [], []
        cells_req = [c for c in r["req"] if c[1].strip()]
        if len(cells_req) == 2:
            # Two requester cells: the House column comes first, then the Senate's.
            house, senate = _names(cells_req[0][1]), _names(cells_req[1][1])
        elif r["origination"] == "H":
            house = names
        elif r["origination"] == "S":
            senate = names
        elif r["chambers"] and len(cells_req) == 1:
            # One cell on an H/S project: under whichever column heading is nearer.
            h_at, s_at = r["chambers"]
            start, t = cells_req[0]
            (house if abs(start - h_at) <= abs(start - s_at) else senate).extend(_names(t))
        else:
            raise Unreadable(f"page {r['page']}: requesters for both chambers in one cell ({names})")
        if not project or not names or r["amount"] <= 0:
            raise Unreadable(f"page {r['page']}: a project without a name, requester or amount ({project!r}, {names}, {r['amount']}, {r['fields']})")
        out.append({
            "id": digest(source_url, i, project, r["amount"]), "fy": fy, "stage": stage, "subcommittee": subcommittee,
            "agency": get("agency"), "account": get("account"), "state": state if state and state.upper() in CODES else None, "location": location,
            "recipient": recipient, "project": " ".join(project.split()), "amount": r["amount"], "origination": r["origination"].replace("S/H", "H/S"),
            "page": r["page"], "house": house, "senate": senate, "source_url": source_url,
        })
    if not out:
        raise Unreadable("no projects found")
    return out


def house_requests(rows, fy, source_url):
    """Rows of a House consolidated CPF requests spreadsheet (header first) → request dicts."""
    rows = list(rows)
    head = [str(h or "").strip().lower() for h in rows[0]]
    col = lambda *names: next((i for i, h in enumerate(head) if any(n in h for n in names)), None)
    ln, fn, dist, sub, rec, proj, addr, amt, url = (col("last"), col("first"), col("district"), col("subcommittee"), col("recipient"),
                                                   col("project"), col("address"), col("amount"), col("website", "url"))
    out = []
    for i, r in enumerate(rows[1:], 2):
        v = lambda j: (str(r[j]).strip() if j is not None and j < len(r) and r[j] is not None else "")
        if not v(ln) or not v(amt):
            continue
        try:
            a = float(str(r[amt]).replace(",", "").replace("$", ""))
        except ValueError:
            continue
        link = v(url)
        m = re.search(r'https?://[^"\s)]+', link)
        out.append({
            "id": digest(fy, i, v(ln), v(rec), a), "fy": fy, "last": v(ln), "first": v(fn), "district": v(dist).upper() or None,
            "subcommittee": subcommittee_of(v(sub)) or (v(sub).lower() or None), "recipient": v(rec) or None, "project": v(proj) or None,
            "address": v(addr) or None, "amount_requested": a, "member_url": m.group(0) if m else None, "source_url": source_url,
        })
    return out


def house_awards(rows, fy, source_url):
    """The House committee's consolidated table of funded CPFs (FY27 onward) → earmark rows."""
    rows = list(rows)
    head = [str(h or "").strip().lower() for h in rows[0]]
    col = lambda *names: next((i for i, h in enumerate(head) if any(n in h for n in names)), None)
    bill, agency, account, loc, proj, rec, amt, req = (col("appropriations bill"), col("agency"), col("account"), col("state/location"),
                                                       col("project"), col("recipient"), col("amount"), col("requestor"))
    out = []
    for i, r in enumerate(rows[1:], 2):
        v = lambda j: (" ".join(str(r[j]).split()) if j is not None and j < len(r) and r[j] is not None else "")
        try:
            a = float(str(r[amt]).replace(",", "").replace("$", ""))
        except (TypeError, ValueError):
            continue
        if not v(proj) or not v(req) or a <= 0:
            continue
        place = v(loc)
        st = None
        for t in (place, v(rec), v(proj)):
            m = re.search(r"[,.]\s*([A-Z]{2})\b", t) or re.fullmatch(r"([A-Z]{2})", t)
            if m and m.group(1) in CODES:
                st = m.group(1)
                break
        out.append({
            "id": digest(source_url, i, v(proj), a), "fy": fy, "stage": "house_committee", "subcommittee": subcommittee_of(v(bill)) or v(bill).lower(),
            "agency": v(agency) or None, "account": v(account) or None, "state": st, "location": place or None, "recipient": v(rec) or None,
            "project": v(proj), "amount": a, "origination": "H", "page": None, "house": _names(v(req)), "senate": [], "source_url": source_url,
        })
    return out


# ---------------------------------------------------------------------------
# Members' names


def fold(s):
    s = unicodedata.normalize("NFKD", s or "")
    s = "".join(c for c in s if not unicodedata.combining(c))
    return re.sub(r"[^a-z\- ]", "", s.lower().replace("’", "").replace("'", "")).strip()


class Members:
    """Current members of Congress, for matching names written in tables and reports."""

    def __init__(self, rows):
        self.rows = rows  # [{id, name, last_name, chamber, state, district}]
        self.by_last = {}
        for r in rows:
            last = fold(r.get("last_name") or (r["name"].split()[-1]))
            self.by_last.setdefault(last, []).append(r)

    def match_requester(self, name, chamber, state=None):
        """'Torres (CA)', 'Blunt Rochester', 'Hyde-Smith' in a chamber → official id on one match."""
        m = re.match(r"^(.*?)\s*\(([A-Z]{2})\)$", name.strip())
        st = m.group(2) if m else None
        last = fold(m.group(1) if m else name)
        hits = [r for r in self.by_last.get(last, []) if r["chamber"] == ("us-house" if chamber == "house" else "us-senate")]
        if len(hits) > 1 and (st or state):
            hits = [r for r in hits if r.get("state") == (st or state)]
        if len(hits) > 1:
            active = [r for r in hits if r.get("active")]
            hits = active if len(active) == 1 else hits
        return hits[0]["id"] if len(hits) == 1 else None

    def match_full(self, first, last, chamber=None, district=None):
        """
        A member by first and last name: in this chamber (and district, 'WA09' or
        'WA-AL', when given), else (a member who has since changed chambers) in
        any chamber with the same first name and state. One match only.
        """
        st = code = None
        m = re.match(r"^([A-Z]{2})(?:-?(\d{1,2}|AL))?$", (district or "").upper().strip())
        if m:
            st, code = m.group(1), m.group(2)
        f = fold(first).split(" ")[0] if first and len(fold(first).rstrip(".")) > 1 else ""
        same = lambda r: not f or fold(r["name"]).split(" ")[0][:3] == f[:3] or f in fold(r["name"]).split(" ")
        pool = self.by_last.get(fold(last), [])

        def one(hits):
            if len(hits) > 1:
                active = [r for r in hits if r.get("active")]
                hits = active if len(active) == 1 else hits
            return hits[0]["id"] if len(hits) == 1 else None

        hits = [r for r in pool if not chamber or r["chamber"] == chamber]
        if len(hits) > 1 and st:
            def dist(r):
                c = str(r.get("district_code") or "").upper().lstrip("0")
                return c == code.lstrip("0") or (code in ("AL", "0", "00") and c in ("", "AL", "0"))
            hits = (code and [r for r in hits if r.get("state") == st and dist(r)]) or [r for r in hits if r.get("state") == st]
        if len(hits) > 1 and f:
            hits = [r for r in hits if same(r)]
        got = one(hits)
        if got or hits or not (f or st):
            return got
        return one([r for r in pool if same(r) and (not st or r.get("state") == st)]) if f else None


def org_key(name):
    """An organization's name for matching a request to a table row: lowercase, no punctuation or "Inc."/"The"."""
    words = re.sub(r"[^a-z0-9 ]", " ", (name or "").lower().replace("&", " and ")).split()
    return " ".join(w for w in words if w not in ("the", "inc", "incorporated", "llc", "corp", "corporation", "co", "ltd"))


# ---------------------------------------------------------------------------
# Privately paid travel


def _iso(mdy):
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", mdy or "")
    return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}" if m else None


def house_travel(page_html, base="https://disclosures-clerk.house.gov/"):
    """The House Clerk's gift travel search results → [{member, filer, destination, start, end, sponsor, url}]."""
    out = []
    for tr in re.findall(r"<tr>([\s\S]*?)</tr>", page_html):
        tds = re.findall(r'<td data-label="([^"]+)"[^>]*>([\s\S]*?)</td>', tr)
        if not tds:
            continue
        cell = {k: v for k, v in tds}
        link = re.search(r'href="([^"]+\.pdf)"', cell.get("Member Name", ""))
        text = lambda k: " ".join(html.unescape(re.sub(r"<[^>]+>", " ", cell.get(k, "")).replace("&#xA;", "; ")).split()).strip(" ;")
        dates = re.findall(r"\d{1,2}/\d{1,2}/\d{4}", cell.get("Travel Dates", ""))
        sponsor = "; ".join(s.strip() for s in html.unescape(cell.get("Sponsor", "")).split("\n") if s.strip())
        out.append({
            "member": text("Member Name"), "filer": text("Filter Name") or text("Filer Name"), "destination": text("Destination") or None,
            "start": _iso(dates[0]) if dates else None, "end": _iso(dates[-1]) if dates else None, "sponsor": sponsor or None,
            "url": (base + link.group(1).lstrip("/")) if link else None,
        })
    return out


def senate_travel(xml_text):
    """The Senate Gift Rule database (giftrule.xml) → [{filer_last, filer_first, office, member_trip, start, end, url}]."""
    root = ET.fromstring(xml_text.lstrip("﻿"))
    out = []
    for filer in root.iter("dbo.filer"):
        for office in filer.iter("dbo.Office"):
            for doc in office.iter("dbo.Document"):
                for rep in doc.iter("dbo.Reports"):
                    out.append({
                        "filer_last": filer.get("LastName"), "filer_first": filer.get("FirstName"), "office": office.get("OfficeName"),
                        "member_trip": (rep.get("ReportTitle") or "").startswith("Member"), "start": _iso(doc.get("BeginTravelDate")),
                        "end": _iso(doc.get("EndTravelDate")), "url": rep.get("DocURL"),
                    })
    return out


# ---------------------------------------------------------------------------
# FARA


def csv_rows(text):
    return list(csv.DictReader(io.StringIO(text)))


TITLE_SENATOR = re.compile(r"\b(U\.?S\.?\s+Senator|Senator|Sen\.)\s*", re.I)
TITLE_REP = re.compile(r"\b(U\.?S\.?\s+Representative|Representative|Congressman|Congresswoman|Congressmember|Rep\.)\s*", re.I)
OFFICE_OF = re.compile(r"Office of\s+(?:U\.?S\.?\s+)?(Senator|Sen\.|Representative|Rep\.|Congressman|Congresswoman|Leader|Speaker|Chairman|Chairwoman|Chair|Ranking Member)\s+([A-Z][\w.'\-]*(?:\s+[A-Z][\w.'\-]*){0,3})")


def item12_contacts(text):
    """
    The "Response to Item 12-Detail" table of a supplemental statement →
    [{principal, date, contact (the contact cell's words), method}]. Empty when
    the statement has no such table (or no text layer).
    """
    start = text.find("Item 12-Detail")
    if start < 0:
        return []
    end = min([i for i in (text.find("Response to Item 13", start), text.find("13.", start + 40)) if i > 0] or [len(text)])
    block = text[start:end]
    head = re.search(r"^.*\bDate\b.*\bContact\b.*\bMethod\b.*$", block, re.M)
    if not head:
        return []
    h = head.group(0)
    c_date, c_contact, c_method = h.index("Date"), h.index("Contact"), h.index("Method")
    rows, cur = [], None
    for line in block[head.end():].splitlines():
        if not line.strip() or re.search(r"Received by NSD/FARA|\(PAGE \d+\)|Response to Item", line):
            continue
        m = re.search(r"\b(\d{2}/\d{2}/\d{4})\b", line)
        if m and abs(m.start() - c_date) < 12:
            if cur:
                rows.append(cur)
            cur = {"principal": line[: m.start()].strip(), "date": _iso(m.group(1)), "contact": line[c_contact - 2: c_method - 1].strip(" |"),
                   "method": line[c_method - 1:].split("  ")[0].strip(" |")}
            continue
        if cur:
            left = line[: c_date - 1].strip()
            if left:
                cur["principal"] = _join(cur["principal"], left)
            mid = line[c_date + 10: c_method - 1].strip() if len(line) > c_date + 10 else ""
            if mid:
                cur["contact"] = _join(cur["contact"], mid)
    if cur:
        rows.append(cur)
    for r in rows:
        r["principal"] = " ".join(r["principal"].split())
        r["contact"] = " ".join(r["contact"].split())
        r["method"] = " ".join(r["method"].split()) or None
    return rows


def contact_member(contact, members):
    """
    A contact cell ('Lindsey Graham U.S. Senator', 'Mike Berg Chief of Staff, Office of
    Senator T. Sheehy') → (official_id, 'member'|'office') or None. A member is matched by
    full name plus title; an office by "Office of Senator/Rep. Name"; one match only.
    """
    c = " ".join(contact.split())
    office = OFFICE_OF.search(c)
    if office:
        chamber = "us-senate" if office.group(1).lower().startswith("sen") else ("us-house" if re.match(r"rep|cong", office.group(1), re.I) else None)
        words = office.group(2).split()
        last, first = words[-1], (words[0] if len(words) > 1 else None)
        oid = members.match_full(first if first and len(first.rstrip(".")) > 1 else None, last, chamber)
        return (oid, "office") if oid else None
    senator = TITLE_SENATOR.search(c)
    rep = TITLE_REP.search(c)
    if not senator and not rep:
        return None
    chamber = "us-senate" if senator else "us-house"
    name = (TITLE_SENATOR if senator else TITLE_REP).sub(" ", c).strip()
    words = [w for w in re.split(r"\s+", name) if re.match(r"^[A-Z][\w.'\-]*$", w)][:3]
    if len(words) < 2:
        return None
    oid = members.match_full(words[0], words[-1], chamber) or (members.match_full(words[0], words[1], chamber) if len(words) > 2 else None)
    return (oid, "member") if oid else None
