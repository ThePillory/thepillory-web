"""
IRS Form 990 e-file XML: what a nonprofit filed, read from the IRS's public
batches (https://www.irs.gov/charities-non-profits/form-990-series-downloads).

The IRS publishes every e-filed return as XML inside large zip batches, with a
yearly index (index_YYYY.csv: EIN, tax period, return type, OBJECT_ID and the
batch it's in). One return is read without downloading its batch: a zip's
directory sits at its end, so a few HTTP range requests find and fetch just
that file (RangeFile).

read_return(xml) -> the figures ThePillory shows, exactly as filed: tax year and
period, total revenue, total expenses, and from Schedule C Part I-A the
organization's political campaign activity expenditures (None when the return
has no Schedule C, which the page says) and the political organizations it
paid, by name. Public copies of these returns don't
list donors (Schedule B's names are withheld from public inspection).

Standard library, plus zipfile-deflate64 for the batches compressed with
Deflate64; tested in tools/test_irs990.py.
"""
import io
import re
import urllib.request
import xml.etree.ElementTree as ET

try:  # some IRS batches are compressed with Deflate64, which zipfile can't read on its own
    import zipfile_deflate64  # noqa: F401
except ImportError:
    pass

BASE = "https://apps.irs.gov/pub/epostcard/990/xml"
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
# Return types that carry Form 990's revenue and expense lines and can carry Schedule C.
RETURN_TYPES = ("990", "990EZ", "990O")


def index_url(year):
    return f"{BASE}/{year}/index_{year}.csv"


def batch_url(year, batch_id):
    return f"{BASE}/{year}/{batch_id}.zip"


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def _num(s):
    try:
        return float(str(s).strip())
    except (TypeError, ValueError):
        return None


def _first(root, *names):
    """The text of the first element (anywhere) whose local name is one of names."""
    want = set(names)
    for el in root.iter():
        if _local(el.tag) in want and el.text and el.text.strip():
            return el.text.strip()
    return None


def read_return(xml):
    """The figures a 990, 990-EZ or 990-O return states, as filed."""
    root = ET.fromstring(xml.encode("utf-8") if isinstance(xml, str) else xml)
    rtype = _first(root, "ReturnTypeCd")
    sched_c = next((el for el in root.iter() if _local(el.tag) == "IRS990ScheduleC"), None)
    political = None
    recipients = []
    if sched_c is not None:
        political = _num(_first(sched_c, "PoliticalExpendituresAmt"))
        # Part I-C line 5: political organizations the filer paid, by name and EIN.
        for g in (el for el in sched_c.iter() if _local(el.tag) == "Section527PoliticalOrgGrp"):
            name = _first(g, "BusinessNameLine1Txt")
            if name:
                recipients.append({"name": " ".join(name.split()), "ein": _first(g, "EIN"),
                                   "amount": _num(_first(g, "PaidInternalFundsAmt", "ContributionsRcvdDeliveredAmt"))})
    filer = next((el for el in root.iter() if _local(el.tag) == "Filer"), root)
    return {
        "return_type": rtype,
        "tax_year": int(_first(root, "TaxYr") or 0) or None,
        "period_end": _first(root, "TaxPeriodEndDt"),
        "name": _first(filer, "BusinessNameLine1Txt"),
        "ein": _first(filer, "EIN"),
        # Form 990 Part I line 12 / 18 (current year); 990-EZ lines 9 and 17.
        "revenue": _num(_first(root, "CYTotalRevenueAmt", "TotalRevenueAmt")),
        "expenses": _num(_first(root, "CYTotalExpensesAmt", "TotalExpensesAmt")),
        "schedule_c": sched_c is not None,
        "political": political,
        "recipients": recipients,
        # Part IV line 3: did the organization report political campaign activity?
        "political_activity": _first(root, "PoliticalCampaignActyInd"),
    }


def _get(url, rng=None):
    headers = {"User-Agent": UA}
    if rng:
        headers["Range"] = rng
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=180) as r:
        return r.read()


class RangeFile(io.RawIOBase):
    """A remote file read by HTTP range requests, for zipfile.ZipFile."""

    def __init__(self, url, size):
        self.url, self.size, self.pos, self.requests = url, size, 0, 0

    def seekable(self):
        return True

    def readable(self):
        return True

    def tell(self):
        return self.pos

    def seek(self, offset, whence=0):
        self.pos = offset if whence == 0 else self.pos + offset if whence == 1 else self.size + offset
        return self.pos

    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0:
            return 0
        self.requests += 1
        data = _get(self.url, f"bytes={self.pos}-{self.pos + n - 1}")
        b[: len(data)] = data
        self.pos += len(data)
        return len(data)


def remote_size(url):
    req = urllib.request.Request(url, headers={"User-Agent": UA}, method="HEAD")
    with urllib.request.urlopen(req, timeout=120) as r:
        return int(r.headers.get("Content-Length") or 0)
