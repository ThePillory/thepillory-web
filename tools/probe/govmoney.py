"""Temporary probe round 6: Senate travel PDF form fields; Senate public-law CDS table PDF (link from its download page) and its text."""
import io, json, re, zipfile, urllib.request, urllib.error, urllib.parse
from pathlib import Path
import pdfplumber
from pypdf import PdfReader
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)", "Accept": "*/*"}
def get(url, n=60000000):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
            return r.status, r.headers.get("Content-Type"), r.read()[:n], r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()[:3000], url
res = {}
s, ct, b, u = get("https://giftrule-disclosure.senate.gov/media/giftruledownloads/giftruledata.zip")
x = zipfile.ZipFile(io.BytesIO(b)).read("giftrule.xml").decode("utf-8-sig")
urls = re.findall(r'ReportTitle="Member Reimbursed Travel" DocURL="([^"]+)"', x)[-4:] + re.findall(r'DocURL="([^"]+/2026/[^"]+)"', x)[:2]
forms = []
for url in urls:
    s, ct, pdf, u = get(url)
    try:
        r = PdfReader(io.BytesIO(pdf))
        f = r.get_fields() or {}
        vals = {k: str(v.get("/V"))[:80] for k, v in f.items() if v.get("/V") not in (None, "", "/Off")}
        imgs = sum(len(p.images) for p in r.pages[:2])
        forms.append([url, len(r.pages), len(f), list(vals.items())[:25], imgs, (r.metadata or {}).get("/Producer")])
    except Exception as e:
        forms.append([url, repr(e)[:100]])
res["senate_forms"] = forms
res["member_count"] = len(re.findall(r'Member Reimbursed Travel', x))
s, ct, b, u = get("https://www.appropriations.senate.gov/download/fy26-thud-cds-public-law")
h = b.decode("utf-8", "replace")
pdfs = sorted(set(re.findall(r'(?:href|src)="([^"]+\.pdf[^"]*)"', h)))
res["pl_page_pdfs"] = pdfs[:10]
res["pl_page_text"] = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", h)))[:1200]
if pdfs:
    url = urllib.parse.urljoin(u, pdfs[0])
    s, ct, pdf, u = get(url)
    res["pl_pdf"] = [url, s, ct, len(pdf)]
    with pdfplumber.open(io.BytesIO(pdf)) as p:
        pg = p.pages[0]
        res["pl_pages"] = len(p.pages)
        res["pl_upright"] = [sum(1 for c in pg.chars if c.get("upright")), len(pg.chars), pg.rotation]
        res["pl_text0"] = (pg.extract_text() or "")[:2500]
        # derotated: rotate the page 90 degrees by treating x as rows
        words = pg.extract_words(extra_attrs=["upright"])
        rows = {}
        for w in words:
            rows.setdefault(round(w["x0"] / 4), []).append((w["top"], w["text"]))
        res["pl_derot"] = [" ".join(t for _, t in sorted(v, reverse=True)) for k, v in sorted(rows.items())][:40]
(OUT / "govmoney6.json").write_text(json.dumps(res, indent=1, default=str))
