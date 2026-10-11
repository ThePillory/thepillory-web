#!/usr/bin/env python3
"""
Stock trades by members of Congress: STOCK Act Periodic Transaction Reports
(docs/trades.md), loaded into D1 by the "Load stock trades" workflow.

Sources
  House   the Clerk's yearly index (disclosures-clerk.house.gov, <year>FD.zip,
          FilingType "P"), then each report's PDF. Electronic reports have a
          text layer (read with pdftotext); scanned paper filings don't, and
          are stored as a link only ("Filed on paper: see the report").
  Senate  eFD (efdsearch.senate.gov): the search, after accepting the site's
          terms, then each electronic report's table. Paper filings: a link only.
  OGE     the President, Vice President and Cabinet: OGE Form 278-T reports,
          from the disclosures the sync's executive-funding step lists
          (D1 `disclosures`). A posted report's PDF is read; one OGE releases
          only on request (Form 201) is stored with its request link only.
  SEC     EDGAR (company_tickers.json, then submissions/CIK…json) for a
          ticker's SIC code, grouped into the SIC divisions as the sector.
  Committees  congress-legislators' current committee membership.

Rules
  - Only what the public report says is stored: never a family member's name
    (owner is Self, Spouse, Joint or Dependent child), never a guess.
  - A report is attached to a member only with exactly one match by name and
    state (and district, for the House); otherwise it's kept unmatched, with
    the reason, for review, and never shown.
  - A report whose transactions can't be read with confidence is stored as a
    link only (parsed = 0); trades are never guessed from it.
  - The Ethics in Government Act forbids commercial use of these reports.

Modes
  measure  reads up to --max-reports new reports and writes a summary (counts,
           unmatched filers, reports it couldn't read, sample trades); writes
           nothing to D1
  load     the same, then writes reports, trades, sectors, committees and the
           per-member summaries to D1

    python3 tools/load_trades.py --mode measure --max-reports 40
    python3 tools/load_trades.py --mode load --max-reports 300
"""
import argparse
import datetime
import hashlib
import html
import html.parser
import http.cookiejar
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from load_state_votes import lit  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
UA = os.environ.get("TRADES_USER_AGENT") or "ThePillory/1.0 (+https://thepillory.co; public records)"
SEC_UA = os.environ.get("SEC_USER_AGENT") or UA  # EDGAR asks for a name and contact email
HOUSE = "https://disclosures-clerk.house.gov"
SENATE = "https://efdsearch.senate.gov"
FIRST_YEAR = 2023
LATE_DAYS = 45
LEGISLATORS = "https://theunitedstates.io/congress-legislators"

# ---------------------------------------------------------------------------
# Small pure helpers


def norm(s):
    """'José Núñez-Smith Jr.' -> 'jose nunez smith': for name matching only."""
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode().lower()
    s = re.sub(r"[^a-z ]+", " ", s)
    s = re.sub(r"\b(jr|sr|ii|iii|iv|hon|dr|mr|mrs|ms)\b", " ", s)
    return " ".join(s.split())


def iso(mdy):
    """'01/14/2024' or '1/4/2024' -> '2024-01-14'; None when it isn't a date."""
    m = re.match(r"^\s*(\d{1,2})/(\d{1,2})/(\d{4})", str(mdy or ""))
    if not m:
        return None
    try:
        return datetime.date(int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
    except ValueError:
        return None


def days_between(a, b):
    if not a or not b:
        return None
    return (datetime.date.fromisoformat(b) - datetime.date.fromisoformat(a)).days


def amount_bounds(text):
    """'$1,001 - $15,000' -> (1001, 15000); 'Over $50,000,000' -> (50000001, None)."""
    t = str(text or "")
    nums = [int(x.replace(",", "")) for x in re.findall(r"\$\s*([\d,]+)", t)]
    if not nums:
        return None, None
    if re.search(r"\bover\b", t, re.I):
        return nums[0] + 1, None
    if len(nums) == 1:
        return nums[0], nums[0]
    return nums[0], nums[1]


OWNERS = {"": "Self", "self": "Self", "sp": "Spouse", "spouse": "Spouse", "jt": "Joint", "joint": "Joint",
          "dc": "Dependent child", "child": "Dependent child", "dependent child": "Dependent child"}


RANGE = re.compile(r"^(?:Spouse/DC )?Over \$[\d,]{5,}$|^\$[\d,]{3,} - \$[\d,]{4,}$")


def full_range(amount):
    """True for a whole reporting range ("$1,001 - $15,000", "Over $50,000,000"); a stray "$15" is not one."""
    a = re.sub(r"\s*-\s*", " - ", re.sub(r"\s+", " ", str(amount or "")).strip())
    if not RANGE.match(a):
        return False
    lo, hi = amount_bounds(a)
    return hi is None or (lo is not None and lo < hi)


def owner_label(raw):
    """Owner as filed, as one of four labels. Anything else (it could be a name) is not stored."""
    return OWNERS.get(str(raw or "").strip().lower())


def type_label(raw):
    t = str(raw or "").strip().lower()
    if t in ("p", "purchase"):
        return "Purchase"
    if t in ("s (partial)", "sale (partial)", "partial sale"):
        return "Partial sale"
    if t in ("s", "sale", "sale (full)", "s (full)"):
        return "Sale"
    if t in ("e", "exchange"):
        return "Exchange"
    return None


def ticker_of(asset):
    """'Apple Inc. - Common Stock (AAPL) [ST]' -> 'AAPL'."""
    m = re.findall(r"\(([A-Z][A-Z0-9.\-]{0,9})\)", str(asset or ""))
    return m[-1] if m else None


SIC_DIVISIONS = [
    (100, 999, "Agriculture, Forestry and Fishing"), (1000, 1499, "Mining"), (1500, 1799, "Construction"),
    (2000, 3999, "Manufacturing"), (4000, 4999, "Transportation, Communications and Utilities"),
    (5000, 5199, "Wholesale Trade"), (5200, 5999, "Retail Trade"), (6000, 6799, "Finance, Insurance and Real Estate"),
    (7000, 8999, "Services"), (9100, 9999, "Public Administration"),
]


def sic_division(sic):
    try:
        n = int(sic)
    except (TypeError, ValueError):
        return None
    for lo, hi, name in SIC_DIVISIONS:
        if lo <= n <= hi:
            return name
    return None


# ---------------------------------------------------------------------------
# House


def parse_house_index(xml_bytes):
    """Periodic Transaction Reports in a <year>FD.xml index."""
    out = []
    for m in ET.fromstring(xml_bytes).iter("Member"):
        g = lambda tag: (m.findtext(tag) or "").strip()
        if g("FilingType") != "P":
            continue
        out.append({"doc_id": g("DocID"), "year": g("Year"), "first": g("First"), "last": g("Last"),
                    "suffix": g("Suffix"), "state_dst": g("StateDst"), "filed_on": iso(g("FilingDate"))})
    return [f for f in out if f["doc_id"] and f["filed_on"]]


def house_pdf_url(year, doc_id):
    return f"{HOUSE}/public_disc/ptr-pdfs/{year}/{doc_id}.pdf"


ROW = re.compile(
    r"^\s*(?:(?P<owner>SP|JT|DC)\s+)?(?P<asset>\S.*?)\s+(?P<type>P|S \(partial\)|S|E)\s+"
    r"(?P<tdate>\d{1,2}/\d{1,2}/\d{4})\s+(?P<ndate>\d{1,2}/\d{1,2}/\d{4})\s+(?P<amount>(?:Spouse/DC )?Over \$[\d,]+|\$[\d,]+(?:\s*-\s*(?:\$[\d,]+)?)?)"
)
STOP = re.compile(r"^\s*(F\s*S|S\s*O|D|C|L|Filing ID|Filing Status|Subholding Of|Description|Comments?|Location)\s*:", re.I)
# Page furniture between rows: the table's headings, the certification, page headers.
HEADER = re.compile(r"^\s*(ID\s+Owner|Type\b|Date\b|Gains\b|\$200\?|Amount\b|Cap\.|Notification\b|Transaction\b|\*|I CERTIFY|Digitally Signed|Clerk of the House|Name:|Status:|State/District:|Periodic Transaction Report)", re.I)


def parse_house_ptr_text(text):
    """
    Transactions from an electronic House PTR (pdftotext -layout). Returns a
    list, or None when the report's table can't be read with confidence (then
    nothing is guessed: the report is stored as a link).
    """
    lines = [ln.rstrip() for ln in str(text or "").splitlines()]
    if not re.search(r"\bID\s+Owner\s+Asset\b", text or "") and not any(ROW.match(ln) for ln in lines):
        return None
    rows = []
    cur = None
    for ln in lines:
        m = ROW.match(ln)
        if m:
            if cur:
                rows.append(cur)
            cur = {**m.groupdict(), "more": []}
            continue
        if cur is None:
            continue
        s = ln.strip()
        if not s:
            continue
        if STOP.match(s) or HEADER.match(s):
            rows.append(cur)
            cur = None
            continue
        # The range's upper bound on its own line, or at the end of a wrapped asset line.
        if cur["amount"].rstrip().endswith("-"):
            tail = re.search(r"(\$[\d,]+)\s*$", s)
            if tail:
                cur["amount"] = f"{cur['amount'].rstrip()} {tail.group(1)}"
                s = s[: tail.start()].strip()
        if s:
            cur["more"].append(s)
    if cur:
        rows.append(cur)
    out = []
    for r in rows:
        asset = " ".join([r["asset"].strip(), *r["more"]]).strip()
        asset = re.sub(r"\s+", " ", asset)
        amount = re.sub(r"\s+", " ", r["amount"]).strip()
        if amount.endswith("-") or not full_range(amount):
            return None  # an upper bound we couldn't find, or not a whole range: don't guess
        t = type_label(r["type"])
        tdate = iso(r["tdate"])
        if not t or not tdate:
            return None
        lo, hi = amount_bounds(amount)
        out.append({"owner": owner_label(r["owner"] or ""), "asset_name": re.sub(r"\s*\[[A-Z]{2,4}\]\s*$", "", asset),
                    "asset_type": (re.search(r"\[([A-Z]{2,4})\]", asset) or [None, None])[1],
                    "ticker": ticker_of(asset), "type": t, "transaction_date": tdate,
                    "amount": amount, "amount_min": lo, "amount_max": hi})
    return out or None


# ---------------------------------------------------------------------------
# Senate


class TableRows(html.parser.HTMLParser):
    """Rows of the first <table> with a <tbody>: lists of cell texts."""

    def __init__(self):
        super().__init__()
        self.rows, self._row, self._cell, self._in_body, self._done = [], None, None, False, False
        self._first = None  # each cell's text before its first nested <div> (the gray detail lines)

    def handle_starttag(self, tag, attrs):
        if self._done:
            return
        if tag == "tbody":
            self._in_body = True
        elif self._in_body and tag == "tr":
            self._row = []
        elif self._in_body and tag in ("td", "th") and self._row is not None:
            self._cell, self._first = [], None
        elif self._cell is not None and tag in ("br", "div", "p"):
            if tag == "div" and self._first is None:
                self._first = "".join(self._cell)
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if self._done:
            return
        if tag in ("td", "th") and self._cell is not None:
            text = self._first if self._first is not None and self._first.strip() else "".join(self._cell)
            self._row.append(re.sub(r"\s+", " ", text).strip())
            self._cell = None
        elif tag == "tr" and self._row is not None:
            if self._row:
                self.rows.append(self._row)
            self._row = None
        elif tag == "tbody":
            self._in_body = False
            self._done = bool(self.rows)

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


SENATE_TYPES = {"purchase": "Purchase", "sale (full)": "Sale", "sale (partial)": "Partial sale", "sale": "Sale", "exchange": "Exchange"}


def parse_senate_ptr_html(page):
    """
    Transactions from an electronic Senate PTR page: the table # · Transaction
    Date · Owner · Ticker · Asset Name · Asset Type · Type · Amount · Comment.
    None when the table isn't there or a row can't be read.
    """
    p = TableRows()
    p.feed(page or "")
    if not p.rows:
        return None
    out = []
    for cells in p.rows:
        if len(cells) < 8:
            return None
        _, tdate, owner, ticker, asset, asset_type, ttype, amount = cells[:8]
        t = SENATE_TYPES.get(ttype.strip().lower())
        d = iso(tdate)
        if not t or not d or not full_range(amount):
            return None
        lo, hi = amount_bounds(amount)
        tk = ticker.strip()
        out.append({"owner": owner_label(owner), "asset_name": asset, "asset_type": asset_type or None,
                    "ticker": ticker_of(asset) if tk in ("", "--") else tk.upper(), "type": t, "transaction_date": d,
                    "amount": amount, "amount_min": lo, "amount_max": hi})
    return out


def senate_link(cell_html):
    """('ptr' | 'paper', absolute URL) from a search result's link cell."""
    m = re.search(r'href="(/search/view/(ptr|paper)/[^"]+)"', cell_html or "")
    return (m.group(2), SENATE + m.group(1)) if m else (None, None)


class Senate:
    """An eFD session: the site asks visitors to accept its terms before searching."""

    def __init__(self):
        self.jar = http.cookiejar.CookieJar()
        self.op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(self.jar))
        self.csrf = None

    def _req(self, url, data=None, headers=None):
        h = {"User-Agent": UA, "Referer": f"{SENATE}/search/home/", **(headers or {})}
        body = urllib.parse.urlencode(data, doseq=True).encode() if data is not None else None
        with self.op.open(urllib.request.Request(url, data=body, headers=h), timeout=90) as r:
            return r.read().decode("utf-8", "replace")

    def _token(self):
        for c in self.jar:
            if c.name == "csrftoken":
                return c.value
        return None

    def start(self):
        page = self._req(f"{SENATE}/search/home/")
        m = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page)
        self._req(f"{SENATE}/search/home/", {"prohibition_agreement": "1", "csrfmiddlewaretoken": m.group(1) if m else ""})
        self.csrf = self._token()

    def search(self, start, length, since):
        data = {"start": str(start), "length": str(length), "report_types": "[11]", "filer_types": "[]",
                "submitted_start_date": f"{since} 00:00:00", "submitted_end_date": "", "candidate_state": "",
                "senator_state": "", "office_id": "", "first_name": "", "last_name": "",
                "order[0][column]": "4", "order[0][dir]": "desc", "csrfmiddlewaretoken": self.csrf}
        return json.loads(self._req(f"{SENATE}/search/report/data/", data, {"X-CSRFToken": self.csrf, "Referer": f"{SENATE}/search/"}))

    def page(self, url):
        return self._req(url)


def senate_filings(s, since="01/01/2023", page_size=100, max_pages=60):
    out = []
    for i in range(max_pages):
        res = s.search(i * page_size, page_size, since)
        for first, last, office, link, received in res.get("data", []):
            kind, url = senate_link(link)
            if not url:
                continue
            uid = url.rstrip("/").rsplit("/", 1)[-1]
            out.append({"id": f"senate:{uid}", "first": html.unescape(re.sub(r"<[^>]+>", "", first)).strip(),
                        "last": html.unescape(re.sub(r"<[^>]+>", "", last)).strip(), "office": office,
                        "kind": kind, "url": url, "filed_on": iso(received)})
        if (i + 1) * page_size >= int(res.get("recordsFiltered") or res.get("recordsTotal") or 0):
            break
        time.sleep(1)
    return [f for f in out if f["filed_on"]]


# ---------------------------------------------------------------------------
# Office of Government Ethics: Form 278-T (the executive branch)


def is_278t(doc_type):
    """OGE lists periodic transaction reports as "278 Transaction" (or "278-T")."""
    return bool(re.search(r"278\s*-?\s*T\b|278 Transaction|Periodic Transaction", str(doc_type or ""), re.I))


def oge_report_id(disclosure_id):
    return "oge:" + hashlib.sha1(str(disclosure_id).encode()).hexdigest()[:16]


OGE_ROW = re.compile(
    r"^\s*(?P<n>\d{1,3})\.?\s+(?P<desc>\S.*?)(?:\s+(?:Yes|No|N/A))?\s+(?P<type>Purchase|Sale \(Partial\)|Sale \(partial\)|Partial Sale|Sale|Exchange)\s+"
    r"(?P<date>\d{1,2}/\d{1,2}/\d{4})\s+(?:(?:Yes|No)\s+)?(?P<amount>Over \$[\d,]+|\$[\d,]+(?:\s*-\s*(?:\$[\d,]+)?)?)"
)
OGE_OWNER = [(re.compile(r"\((?:SP|spouse)\)|\bspouse\b", re.I), "Spouse"), (re.compile(r"\((?:DC|dependent child)\)|\bdependent child\b", re.I), "Dependent child"),
             (re.compile(r"\((?:JT|joint)\)", re.I), "Joint")]
OGE_STOP = re.compile(r"^\s*(Summary of Contents|Privacy Act|Public Burden|Filer's Information|Signature|Agency Ethics|Comments of Reviewing|Part \d|#\s+DESCRIPTION|DESCRIPTION|Transactions\b|\d+\s+of\s+\d+$)", re.I)


def parse_oge_ptr_text(text):
    """
    Transactions from an OGE Form 278-T (pdftotext -layout), and the date the
    filer signed it: (trades, signed_on). trades is None when the table can't
    be read with confidence. Owner is filled only where the report states it.
    """
    t = str(text or "")
    m = re.search(r"(?:electronically\s+)?signed\s+on\s+(\d{1,2}/\d{1,2}/\d{4})", t, re.I) or re.search(r"Date\s+of\s+Report[:\s]+(\d{1,2}/\d{1,2}/\d{4})", t, re.I)
    signed = iso(m.group(1)) if m else None
    rows, cur = [], None
    for ln in t.splitlines():
        mm = OGE_ROW.match(ln)
        if mm:
            if cur:
                rows.append(cur)
            cur = {**mm.groupdict(), "more": []}
            continue
        if cur is None:
            continue
        s_ = ln.strip()
        if not s_:
            continue
        if OGE_STOP.match(s_):
            rows.append(cur)
            cur = None
            continue
        if cur["amount"].rstrip().endswith("-"):
            tail = re.search(r"(\$[\d,]+)\s*$", s_)
            if tail:
                cur["amount"] = f"{cur['amount'].rstrip()} {tail.group(1)}"
                s_ = s_[: tail.start()].strip()
        if s_:
            cur["more"].append(s_)
    if cur:
        rows.append(cur)
    if not rows:
        return None, signed
    out = []
    for r in rows:
        desc = re.sub(r"\s+", " ", " ".join([r["desc"], *r["more"]])).strip()
        amount = re.sub(r"\s+", " ", r["amount"]).strip()
        ttype = type_label(r["type"].replace("Partial Sale", "Sale (Partial)"))
        d = iso(r["date"])
        if amount.endswith("-") or not full_range(amount) or not ttype or not d:
            return None, signed
        desc = re.sub(r"\s+(?:See\s+)?Endnotes?\s*$", "", desc, flags=re.I).strip()
        owner = next((label for rx, label in OGE_OWNER if rx.search(desc)), None)
        lo, hi = amount_bounds(amount)
        out.append({"owner": owner, "asset_name": desc, "asset_type": None, "ticker": ticker_of(desc), "type": ttype,
                    "transaction_date": d, "amount": amount, "amount_min": lo, "amount_max": hi})
    return out, signed


TEXT_ROW = re.compile(r"^\s*(\d{1,3})\s*[.,']?\s+(\S.*)$")
TEXT_ROW_ALONE = re.compile(r"^\s*(\d{1,3})\s*[.,']?\s*$")


def text_layer_rows(text):
    """
    {row number: line} from a scanned 278-T's own text layer (pdftotext
    -layout): each numbered line with some words on it, spaces collapsed, the
    first time each number appears. Often garbled; the sync Worker uses it only
    to check the AI readings, never as the record.
    """
    out, pending = {}, None
    for ln in str(text or "").splitlines():
        words = len(re.findall(r"[A-Za-z]", ln))
        m = TEXT_ROW.match(ln)
        if m and words >= 8:
            n, rest = int(m.group(1)), m.group(2)
        elif pending is not None and words >= 8:
            n, rest = pending, ln
        else:
            alone = TEXT_ROW_ALONE.match(ln)
            pending = int(alone.group(1)) if alone else (pending if not ln.strip() or words < 3 else None)
            continue
        pending = None
        if 0 < n <= 500 and n not in out:
            out[n] = re.sub(r"\s+", " ", rest).strip()[:400]
    return out


def scan_queue_sql(args, limit=10):
    """
    Scanned executive-branch reports (not read, with a document) not yet queued
    for transcription: each queued in trade_scans with its text-layer rows.
    """
    rows = d1(args, command="""SELECT r.id, r.report_url FROM trade_reports r LEFT JOIN trade_scans s ON s.report_id = r.id
      WHERE r.chamber = 'us-executive' AND r.parsed = 0 AND r.report_url IS NOT NULL AND r.official_id IS NOT NULL AND s.report_id IS NULL
      ORDER BY r.filed_on DESC LIMIT """ + str(int(limit)))
    out, queued = [], []
    for r in rows:
        try:
            lines = text_layer_rows(pdf_text(get(r["report_url"])))
        except Exception as e:
            print(f"  {r['id']}: not queued for transcription ({type(e).__name__})", file=sys.stderr)
            continue
        out.append(f"INSERT OR IGNORE INTO trade_scans (report_id, text_rows) VALUES ({lit(r['id'])}, {len(lines)});")
        out += [f"INSERT OR REPLACE INTO trade_scan_lines (report_id, n, line) VALUES ({lit(r['id'])}, {n}, {lit(line)});" for n, line in sorted(lines.items())]
        queued.append((r["id"], len(lines)))
    return out, queued


def oge_filings(args):
    """The executive branch's 278-T reports, as the executive-funding step listed them."""
    rows = d1(args, command="""SELECT d.id, d.official_id, d.doc_type, d.filed_on, d.document_url, d.request_url, d.position, d.agency, d.filer_name, o.name
      FROM disclosures d JOIN officials o ON o.id = d.official_id
      WHERE d.source = 'oge' AND o.chamber = 'us-executive' AND d.filed_on IS NOT NULL""")
    return [{"id": oge_report_id(r["id"]), "official_id": r["official_id"], "filer": r["filer_name"] or r["name"], "filed_on": r["filed_on"],
             "url": r["document_url"], "request_url": r["request_url"], "position": r["position"], "agency": r["agency"]}
            for r in rows if is_278t(r["doc_type"]) and (r["document_url"] or r["request_url"])]


def read_oge(f):
    if not f["url"]:
        return {"paper": 0, "trades": None, "request_only": True, "signed": None}
    text = pdf_text(get(f["url"]))
    f["_text"] = text
    if len(re.sub(r"\s+", "", text)) < 40:
        return {"paper": 1, "trades": None, "request_only": False, "signed": None}
    trades, signed = parse_oge_ptr_text(text)
    return {"paper": 0, "trades": trades, "request_only": False, "signed": signed}


# ---------------------------------------------------------------------------
# Matching filers to officials


def match_house(f, officials):
    """Exactly one House member by last name, state and district; else (None, reason)."""
    sd = f.get("state_dst") or ""
    m = re.match(r"^([A-Z]{2})(\d{1,2})$", sd)
    if not m:
        return None, f"no state and district ({sd or 'blank'})"
    st, dist = m.group(1), str(int(m.group(2)))
    last = norm(f["last"])
    at_large = ("0", "00", "AL", "")

    def same_district(o):
        code = str(o.get("district_code") or "")
        return code == dist or (dist == "0" and code in at_large)

    hits = [o for o in officials if o["chamber"] == "us-house" and o["state"] == st and same_district(o)
            and last and (norm(o.get("last_name")) == last or norm(o["name"]).endswith(" " + last))]
    if len(hits) == 1:
        return hits[0], None
    return None, f"{len(hits)} House members named {f['last']} in {sd}"


def match_senate(f, officials):
    """Exactly one senator by first and last name; else (None, reason)."""
    last, first = norm(f["last"]), norm(f["first"]).split(" ")[0] if norm(f["first"]) else ""
    hits = [o for o in officials if o["chamber"] == "us-senate" and last
            and (norm(o.get("last_name")) == last or norm(o["name"]).endswith(" " + last))
            and (not first or norm(o["name"]).split(" ")[0] == first or norm(o["name"]).startswith(first[:3]))]
    if len(hits) > 1:
        active = [o for o in hits if o.get("active")]
        hits = active if len(active) == 1 else hits
    if not hits:
        # A filing name can differ from the familiar one ("A. Mitchell" for "Mitch"):
        # then the last name alone, when exactly one senator has it.
        same_last = [o for o in officials if o["chamber"] == "us-senate" and last and (norm(o.get("last_name")) == last or norm(o["name"]).endswith(" " + last))]
        hits = same_last if len(same_last) == 1 else []
    if len(hits) == 1:
        return hits[0], None
    return None, f"{len(hits)} senators named {f['first']} {f['last']}"


# ---------------------------------------------------------------------------
# Fetching


def get(url, *, ua=UA, timeout=120):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": ua}), timeout=timeout) as r:
        return r.read()


def pdf_text(data):
    """The PDF's text layer (pdftotext -layout); '' for a scanned image."""
    with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
        f.write(data)
        f.flush()
        r = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, timeout=120)
        return r.stdout if r.returncode == 0 else ""


def house_filings(years):
    out = []
    for y in years:
        try:
            z = zipfile.ZipFile(io.BytesIO(get(f"{HOUSE}/public_disc/financial-pdfs/{y}FD.zip")))
        except Exception as e:  # a year not published yet
            print(f"House {y}: index not read ({type(e).__name__})", file=sys.stderr)
            continue
        name = next((n for n in z.namelist() if n.lower().endswith(".xml")), None)
        if name:
            for f in parse_house_index(z.read(name)):
                out.append({**f, "id": f"house:{f['doc_id']}", "url": house_pdf_url(f["year"], f["doc_id"])})
    return out


def read_house(f):
    text = pdf_text(get(f["url"]))
    f["_text"] = text
    if len(re.sub(r"\s+", "", text)) < 40:
        return {"paper": 1, "trades": None}
    return {"paper": 0, "trades": parse_house_ptr_text(text)}


def read_senate(s, f):
    if f["kind"] == "paper":
        return {"paper": 1, "trades": None}
    return {"paper": 0, "trades": parse_senate_ptr_html(s.page(f["url"]))}


def sec_sectors(tickers, known, cap=200):
    """{ticker: (cik, company, sic, sector)} for tickers not cached yet (EDGAR, about 8 requests a second at most)."""
    want = sorted(t for t in tickers if t and t not in known)[:cap]
    if not want:
        return {}
    idx = json.loads(get("https://www.sec.gov/files/company_tickers.json", ua=SEC_UA))
    by = {str(v["ticker"]).upper(): v for v in idx.values()}
    out = {}
    for t in want:
        v = by.get(t) or by.get(t.replace(".", "-"))
        if not v:
            out[t] = (None, None, None, None)
            continue
        cik = f"{int(v['cik_str']):010d}"
        try:
            sub = json.loads(get(f"https://data.sec.gov/submissions/CIK{cik}.json", ua=SEC_UA))
            sic = str(sub.get("sic") or "") or None
            out[t] = (cik, v.get("title"), sic, sic_division(sic))
        except Exception as e:
            print(f"SEC {t}: {type(e).__name__}", file=sys.stderr)
        time.sleep(0.15)
    return out


def committees():
    """[(bioguide, committee_id, name, parent, title)] from congress-legislators."""
    meta = json.loads(get(f"{LEGISLATORS}/committees-current.json"))
    names, parents = {}, {}
    for c in meta:
        names[c["thomas_id"]] = c["name"]
        for sc in c.get("subcommittees", []):
            names[c["thomas_id"] + sc["thomas_id"]] = sc["name"]
            parents[c["thomas_id"] + sc["thomas_id"]] = c["name"]
    members = json.loads(get(f"{LEGISLATORS}/committee-membership-current.json"))
    out = []
    for cid, people in members.items():
        if cid not in names:
            continue
        for p in people:
            if p.get("bioguide"):
                out.append((p["bioguide"], cid, names[cid], parents.get(cid), p.get("title")))
    return out


# ---------------------------------------------------------------------------
# D1


BUSY = re.compile(r"overloaded|queued for too long|too many requests|SQLITE_BUSY|timed? ?out", re.I)


def d1(args, *, file=None, command=None):
    cmd = ["npx", "--yes", "wrangler@4", "d1", "execute", args.database, "--remote", "--yes"]
    cmd += ["--file", str(file)] if file else ["--json", "--command", command]
    # D1 sometimes answers "overloaded" when other work is running; each call is all or
    # nothing and every statement can run twice, so wait and try again.
    for wait in (30, 60, 120, 240, None):
        r = subprocess.run(cmd, cwd=ROOT / "workers" / "sync", capture_output=True, text=True)
        if not r.returncode or wait is None or not BUSY.search(r.stdout + r.stderr):
            break
        print(f"  D1 is busy; trying again in {wait} s", flush=True)
        time.sleep(wait)
    if r.returncode:
        raise SystemExit(f"wrangler d1 execute failed:\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    if command:
        return json.loads(r.stdout[r.stdout.index("["):])[0].get("results", [])
    return None


def run_sql(args, statements):
    for i in range(0, len(statements), 200):
        with tempfile.NamedTemporaryFile("w", suffix=".sql", delete=False) as f:
            f.write("\n".join(statements[i:i + 200]))
        try:
            d1(args, file=f.name)
        finally:
            os.unlink(f.name)


# Some House filings put an account or holding number before the asset ("2000140445 Alphabet Inc.").
# Account numbers are never shown: drop a leading run of 6 or more digits.
ACCOUNT_NO = re.compile(r"^\d{6,}\s+(?=\S)")


def clean_asset(name):
    return ACCOUNT_NO.sub("", name or "").strip()


MIGRATIONS = ROOT / "workers" / "sync" / "migrations"
TRADE_MIGRATIONS = ("0024_trades.sql", "0025_executive_trades.sql", "0026_trade_scans.sql", "0027_trade_scans_auto.sql")


def ensure_tables(args):
    """
    The trades tables, in case the sync Worker hasn't applied their migrations
    yet; each one applied is recorded in d1_migrations, as the Worker does, so
    the Worker never applies it a second time (0025 rebuilds trade_reports and
    would drop the columns it added; 0026's and 0027's ALTERs would fail).
    """
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    done = {r["name"] for r in d1(args, command="SELECT name FROM d1_migrations")}
    cols = lambda: {c["name"] for c in d1(args, command="PRAGMA table_info(trade_reports)")}
    if TRADE_MIGRATIONS[0] not in done:
        d1(args, file=MIGRATIONS / TRADE_MIGRATIONS[0])  # CREATE … IF NOT EXISTS
    if TRADE_MIGRATIONS[1] not in done and "request_url" not in cols():
        d1(args, file=MIGRATIONS / TRADE_MIGRATIONS[1])
    if TRADE_MIGRATIONS[2] not in done and "transcribed_by" not in cols():
        d1(args, file=MIGRATIONS / TRADE_MIGRATIONS[2])
    if TRADE_MIGRATIONS[3] not in done and not any(c["name"] == "spot_check" for c in d1(args, command="PRAGMA table_info(trade_scans)")):
        d1(args, file=MIGRATIONS / TRADE_MIGRATIONS[3])
    d1(args, command="INSERT OR IGNORE INTO d1_migrations (name) VALUES " + ", ".join(f"('{n}')" for n in TRADE_MIGRATIONS))


def report_sql(rep, trades):
    out = [
        "INSERT OR REPLACE INTO trade_reports (id, chamber, official_id, filer_name, state, district, filed_on, report_url, paper, parsed, trade_count, unmatched, source_url, request_url, position, agency, checked_at) VALUES ("
        + ", ".join(lit(rep.get(k)) for k in ("id", "chamber", "official_id", "filer_name", "state", "district", "filed_on", "report_url", "paper", "parsed", "trade_count", "unmatched", "source_url", "request_url", "position", "agency"))
        + ", datetime('now'));",
        f"DELETE FROM trades WHERE report_id = {lit(rep['id'])};",
    ]
    for n, t in enumerate(trades or [], 1):
        out.append(
            "INSERT INTO trades (report_id, n, official_id, chamber, state, transaction_date, filed_on, days_to_file, owner, asset_name, ticker, asset_type, type, amount, amount_min, amount_max, sic, sector) VALUES ("
            + ", ".join(lit(v) for v in (rep["id"], n, rep["official_id"], rep["chamber"], rep["state"], t["transaction_date"], rep["filed_on"],
                                          days_between(t["transaction_date"], rep["filed_on"]) if rep.get("dated", True) else None, t["owner"], clean_asset(t["asset_name"]), t["ticker"], t["asset_type"],
                                          t["type"], t["amount"], t["amount_min"], t["amount_max"], t.get("sic"), t.get("sector")))
            + ");")
    return out


def summary_sql(official_ids):
    ids = ", ".join(lit(i) for i in sorted(official_ids))
    if not ids:
        return []
    return [
        f"DELETE FROM trade_summary WHERE official_id IN ({ids});",
        f"""INSERT INTO trade_summary (official_id, year, trades, total_min, total_max, open_ended, paper)
SELECT y.official_id, y.year, COALESCE(t.n, 0), COALESCE(t.lo, 0), CASE WHEN COALESCE(t.open, 0) > 0 THEN NULL ELSE COALESCE(t.hi, 0) END, COALESCE(t.open, 0), COALESCE(p.n, 0)
FROM (SELECT official_id, CAST(substr(transaction_date, 1, 4) AS INTEGER) AS year FROM trades WHERE official_id IN ({ids}) AND transaction_date IS NOT NULL
      UNION SELECT official_id, CAST(substr(filed_on, 1, 4) AS INTEGER) FROM trade_reports WHERE official_id IN ({ids}) AND paper = 1) y
LEFT JOIN (SELECT official_id, CAST(substr(transaction_date, 1, 4) AS INTEGER) AS year, COUNT(*) AS n, SUM(amount_min) AS lo, SUM(amount_max) AS hi,
           SUM(CASE WHEN amount_max IS NULL THEN 1 ELSE 0 END) AS open
           FROM trades WHERE official_id IN ({ids}) AND transaction_date IS NOT NULL GROUP BY 1, 2) t ON t.official_id = y.official_id AND t.year = y.year
LEFT JOIN (SELECT official_id, CAST(substr(filed_on, 1, 4) AS INTEGER) AS year, COUNT(*) AS n FROM trade_reports WHERE official_id IN ({ids}) AND paper = 1 GROUP BY 1, 2) p
  ON p.official_id = y.official_id AND p.year = y.year;""",
    ]


# ---------------------------------------------------------------------------


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--max-reports", type=int, default=300, help="new reports read this run, newest first")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--since-year", type=int, default=FIRST_YEAR)
    args = ap.parse_args()
    have_d1 = bool(os.environ.get("CLOUDFLARE_API_TOKEN"))
    log = []
    say = lambda s: (print(s), log.append(s))

    officials = d1(args, command="SELECT id, name, last_name, state, district_code, chamber, bioguide_id, active FROM officials WHERE chamber IN ('us-house', 'us-senate')") if have_d1 else []
    known = {r["id"] for r in d1(args, command="SELECT id FROM trade_reports")} if have_d1 and args.mode == "load" else set()
    say(f"Officials to match against: {len(officials)}{'' if have_d1 else ' (no Cloudflare access: matching skipped)'}")

    this_year = datetime.date.today().year
    house = house_filings(range(this_year, args.since_year - 1, -1))
    say(f"House: {len(house)} periodic transaction reports since {args.since_year}")
    senate = None
    try:
        senate = Senate()
        senate.start()
        sen = senate_filings(senate, since=f"01/01/{args.since_year}")
    except Exception as e:
        say(f"Senate: eFD not read ({type(e).__name__}: {e})")
        sen = []
    say(f"Senate: {len(sen)} periodic transaction reports since {args.since_year}")

    oge = []
    if have_d1:
        try:
            oge = oge_filings(args)
        except SystemExit as e:
            say(f"OGE: the executive branch's 278-T list not read ({str(e)[:200]})")
    say(f"Executive branch (OGE 278-T): {len(oge)} reports listed, {sum(1 for f in oge if not f['url'])} released only on request")

    queue = ([dict(f, chamber="us-house") for f in house if f["id"] not in known] + [dict(f, chamber="us-senate") for f in sen if f["id"] not in known]
             + [dict(f, chamber="us-executive") for f in oge if f["id"] not in known])
    queue.sort(key=lambda f: f["filed_on"], reverse=True)
    if args.mode == "measure":
        # A sample of both chambers, newest first.
        x = [f for f in queue if f["chamber"] == "us-executive"][:10]
        h = [f for f in queue if f["chamber"] == "us-house"][: (args.max_reports - len(x)) // 2]
        s_ = [f for f in queue if f["chamber"] == "us-senate"][: args.max_reports - len(x) - len(h)]
        queue = x + h + s_
    else:
        queue = queue[: args.max_reports]
    say(f"Reading {len(queue)} new reports")

    reports, all_trades, unreadable, unmatched = [], [], [], []
    for f in queue:
        if f["chamber"] == "us-executive":
            try:
                got = read_oge(f)
            except Exception as e:
                say(f"  {f['id']}: not read ({type(e).__name__})")
                continue
            trades = got["trades"] or []
            if not got["paper"] and not got["request_only"] and got["trades"] is None:
                unreadable.append(f)
            rep = {"id": f["id"], "chamber": "us-executive", "official_id": f["official_id"], "filer_name": f["filer"], "state": None, "district": None,
                   "filed_on": got["signed"] or f["filed_on"], "dated": bool(got["signed"]), "report_url": f["url"], "request_url": None if f["url"] else f["request_url"],
                   "paper": got["paper"], "parsed": 1 if got["trades"] else 0, "trade_count": len(trades), "unmatched": None,
                   "source_url": f["url"] or f["request_url"], "position": f["position"], "agency": f["agency"]}
            reports.append((rep, trades))
            all_trades.extend(trades)
            continue
        try:
            got = read_house(f) if f["chamber"] == "us-house" else read_senate(senate, f)
        except Exception as e:
            say(f"  {f['id']}: not read ({type(e).__name__})")
            continue
        o, why = (match_house(f, officials) if f["chamber"] == "us-house" else match_senate(f, officials)) if officials else (None, "matching skipped")
        if why:
            unmatched.append((f, why))
        trades = got["trades"] or []
        if not got["paper"] and got["trades"] is None:
            unreadable.append(f)
        st = (o or {}).get("state") or (f.get("state_dst") or "")[:2] or None
        rep = {"id": f["id"], "chamber": f["chamber"], "official_id": o["id"] if o else None,
               "filer_name": " ".join(x for x in (f.get("first"), f.get("last"), f.get("suffix")) if x),
               "state": st, "district": f.get("state_dst"), "filed_on": f["filed_on"], "report_url": f["url"],
               "paper": got["paper"], "parsed": 1 if got["trades"] else 0, "trade_count": len(trades), "unmatched": why,
               "source_url": f["url"]}
        reports.append((rep, trades))
        all_trades.extend(trades)
        time.sleep(0.5)

    # Sectors by ticker (EDGAR), cached in D1.
    cached = {r["ticker"]: r for r in d1(args, command="SELECT ticker, sic, sector FROM sec_tickers")} if have_d1 else {}
    try:
        fresh = sec_sectors({t["ticker"] for t in all_trades if t.get("ticker")}, set(cached))
    except Exception as e:
        say(f"SEC: not read ({type(e).__name__}: {e})")
        fresh = {}
    sectors = {**{k: (v["sic"], v["sector"]) for k, v in cached.items()}, **{k: (v[2], v[3]) for k, v in fresh.items()}}
    for t in all_trades:
        if t.get("ticker") in sectors:
            t["sic"], t["sector"] = sectors[t["ticker"]]

    late = sum(1 for rep, ts in reports for t in ts if (days_between(t["transaction_date"], rep["filed_on"]) or 0) > LATE_DAYS)
    say(f"Executive branch: {sum(1 for r, _ in reports if r['chamber'] == 'us-executive' and r['parsed'])} 278-T reports read, "
        f"{sum(len(ts) for r, ts in reports if r['chamber'] == 'us-executive')} trades; {sum(1 for r, _ in reports if r.get('request_url'))} available only on request")
    say(f"Read: {sum(1 for r, _ in reports if r['parsed'])} reports with {len(all_trades)} trades; {sum(1 for r, _ in reports if r['paper'])} filed on paper; "
        f"{len(unreadable)} electronic reports not read with confidence; {len(unmatched)} not matched to one member; "
        f"{late} trades filed more than {LATE_DAYS} days after the trade; sectors for {sum(1 for t in all_trades if t.get('sector'))} of {sum(1 for t in all_trades if t.get('ticker'))} trades with a ticker")
    for f, why in unmatched[:30]:
        say(f"  unmatched {f['id']} {f.get('first')} {f.get('last')} {f.get('state_dst') or f.get('office') or ''}: {why}")
    for f in unreadable[:30]:
        say(f"  not read: {f['url']}")
    if args.mode == "measure":
        # The start of a few unread reports' text, to see their layout (public records).
        for f in unreadable[:3]:
            lines = [ln.rstrip() for ln in (f.get("_text") or "").splitlines() if ln.strip()]
            say(f"  --- text of {f['id']} ({len(lines)} lines):")
            for ln in lines[:70]:
                say(f"  | {ln[:260]}")
    for rep, ts in reports[:60]:
        for t in ts[:2]:
            say(f"  sample {rep['id']} {t['transaction_date']} {t['owner']} | {t['asset_name'][:60]} | {t['ticker']} | {t['type']} | {t['amount']} | filed {rep['filed_on']} | {t.get('sector')}")

    if args.mode == "load":
        ensure_tables(args)
        stmts = []
        # Rows loaded before clean_asset() existed.
        for row in d1(args, command="SELECT report_id, n, asset_name FROM trades WHERE asset_name GLOB '[0-9][0-9][0-9][0-9][0-9][0-9]* *'"):
            if clean_asset(row["asset_name"]) != row["asset_name"]:
                stmts.append(f"UPDATE trades SET asset_name = {lit(clean_asset(row['asset_name']))} WHERE report_id = {lit(row['report_id'])} AND n = {row['n']};")
        for rep, ts in reports:
            stmts += report_sql(rep, ts if rep["official_id"] else [])
        stmts += [f"INSERT OR REPLACE INTO sec_tickers (ticker, cik, company, sic, sector, checked_at) VALUES ({lit(t)}, {lit(v[0])}, {lit(v[1])}, {lit(v[2])}, {lit(v[3])}, datetime('now'));" for t, v in fresh.items()]
        stmts += [f"UPDATE trades SET sic = {lit(v[2])}, sector = {lit(v[3])} WHERE ticker = {lit(t)} AND sector IS NULL;" for t, v in fresh.items() if v[3]]
        stmts += summary_sql({rep["official_id"] for rep, _ in reports if rep["official_id"]})
        try:
            by_bio = {o["bioguide_id"]: o["id"] for o in officials if o.get("bioguide_id") and o.get("active")}
            rows = [(by_bio[b], cid, name, parent, title) for b, cid, name, parent, title in committees() if b in by_bio]
            if rows:
                stmts.append("DELETE FROM congress_committees;")
                src = f"{LEGISLATORS}/committee-membership-current.json"
                stmts += [f"INSERT OR REPLACE INTO congress_committees (official_id, committee_id, name, parent, title, source_url) VALUES ({lit(a)}, {lit(b)}, {lit(c)}, {lit(d)}, {lit(e)}, {lit(src)});" for a, b, c, d, e in rows]
                say(f"Committees: {len(rows)} assignments")
        except Exception as e:
            say(f"Committees: not read ({type(e).__name__}: {e})")
        run_sql(args, stmts)
        say(f"Loaded {len(reports)} reports into D1")
        # Scanned 278-Ts, for the sync Worker's transcription step (docs/trades.md).
        scan_stmts, queued = scan_queue_sql(args)
        if scan_stmts:
            run_sql(args, scan_stmts)
        for rid, n in queued:
            say(f"  queued for transcription: {rid} ({n} rows in its text layer)")

    out = os.environ.get("GITHUB_STEP_SUMMARY")
    if out:
        with open(out, "a") as f:
            f.write("## Stock trades\n\n```\n" + "\n".join(log[:400]) + "\n```\n")


if __name__ == "__main__":
    main()
