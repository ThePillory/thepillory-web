"""Temporary probe round 4: IRS e-file index columns and whether the batch zips allow range requests; one filing's Schedule C."""
import io, json, re, struct, urllib.request, urllib.error, zipfile, csv
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co)"}
def req(url, rng=None, method="GET"):
    h = dict(UA)
    if rng: h["Range"] = rng
    with urllib.request.urlopen(urllib.request.Request(url, headers=h, method=method), timeout=120) as r:
        return r.status, dict(r.headers), (r.read() if method == "GET" else b"")
res = {}
s, h, b = req("https://apps.irs.gov/pub/epostcard/990/xml/2025/index_2025.csv", rng="bytes=0-3000")
res["index_head"] = [s, h.get("Content-Range"), b.decode("utf-8", "replace")[:1500]]
# Find One Nation (271937961) rows in the 2025 index (stream the whole file, ~93MB).
rows = []
with urllib.request.urlopen(urllib.request.Request("https://apps.irs.gov/pub/epostcard/990/xml/2025/index_2025.csv", headers=UA), timeout=300) as r:
    rd = csv.reader(io.TextIOWrapper(r, encoding="utf-8", errors="replace"))
    header = next(rd)
    for row in rd:
        if row and ("271937961" in row or "530045720" in row or "833690373" in row):
            rows.append(dict(zip(header, row)))
res["header"] = header; res["rows"] = rows
url = "https://apps.irs.gov/pub/epostcard/990/xml/2025/2025_TEOS_XML_01A.zip"
s, h, _ = req(url, method="HEAD")
res["zip_head"] = [s, h.get("Content-Length"), h.get("Accept-Ranges")]
size = int(h.get("Content-Length") or 0)
class RangeFile(io.RawIOBase):
    def __init__(self, url, size): self.url, self.size, self.pos, self.reads = url, size, 0, 0
    def seekable(self): return True
    def readable(self): return True
    def seek(self, off, whence=0):
        self.pos = off if whence == 0 else self.pos + off if whence == 1 else self.size + off
        return self.pos
    def tell(self): return self.pos
    def readinto(self, b):
        n = min(len(b), self.size - self.pos)
        if n <= 0: return 0
        self.reads += 1
        _, _, data = req(self.url, rng=f"bytes={self.pos}-{self.pos + n - 1}")
        b[:len(data)] = data; self.pos += len(data); return len(data)
if size:
    f = RangeFile(url, size)
    z = zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 20))
    names = z.namelist()
    res["zip_names"] = [len(names), names[:3]]
    want = [r for r in rows if r.get("XML_BATCH_ID", "").startswith("2025_TEOS_XML_01A")]
    res["want"] = want[:3]
    target = next((n for n in names for w in want if w.get("OBJECT_ID") and w["OBJECT_ID"] in n), None) or names[0]
    x = z.read(target).decode("utf-8", "replace")
    res["file"] = target; res["reads"] = f.reads
    res["returntype"] = re.findall(r"<ReturnTypeCd>([^<]+)", x)[:2]
    res["politicalTags"] = sorted(set(re.findall(r"<(\w*[Pp]olitic\w*)>", x)))
    res["schedC"] = re.sub(r"\s+", " ", (re.search(r"<IRS990ScheduleC[\s\S]*?</IRS990ScheduleC>", x) or [""])[0])[:2500]
    res["totals"] = re.findall(r"<(CYTotalRevenueAmt|CYTotalExpensesAmt|TaxYr|TaxPeriodEndDt|EIN|BusinessNameLine1Txt)>([^<]*)", x)[:8]
(OUT / "darkmoney4.json").write_text(json.dumps(res, indent=1, default=str))
