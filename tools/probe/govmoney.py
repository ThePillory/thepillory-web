"""Temporary probe round 5: Senate public-law CDS table text, FARA supplemental statements' text layers, Senate travel PDF text."""
import io, json, re, zipfile, urllib.request, urllib.error
from pathlib import Path
import pdfplumber
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)", "Accept": "*/*"}
def get(url, n=60000000):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=180) as r:
            return r.status, r.headers.get("Content-Type"), r.read()[:n], r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()[:3000], url
    except Exception as e:
        return 0, None, repr(e).encode(), url
def text(b, pages=None):
    with pdfplumber.open(io.BytesIO(b)) as p:
        return [(pg.extract_text() or "") for pg in (p.pages if pages is None else p.pages[:pages])]
def upright_rows(b, page=0):
    with pdfplumber.open(io.BytesIO(b)) as p:
        pg = p.pages[page]
        chars = pg.chars
        up = sum(1 for c in chars if c.get("upright"))
        return {"chars": len(chars), "upright": up, "rotation": pg.rotation, "size": [pg.width, pg.height]}
res = {}
s, ct, b, u = get("https://www.appropriations.senate.gov/download/fy26-thud-cds-public-law")
res["pl"] = [s, ct, u, len(b)]
if b[:4] == b"%PDF":
    res["pl_layout"] = upright_rows(b)
    t = text(b, 2); res["pl_text"] = t[0][:2500]
    # Rotated pages: try rotating the page's chars by reading with a derotated crop.
    with pdfplumber.open(io.BytesIO(b)) as p:
        pg = p.pages[1]
        words = pg.extract_words(keep_blank_chars=False, use_text_flow=False, extra_attrs=["upright"])
        res["pl_words_sample"] = [(w["text"], round(w["x0"]), round(w["top"]), w["upright"]) for w in words[:60]]
# FARA: text-layer prevalence in 25 recent supplemental statements
s, ct, b, u = get("https://efile.fara.gov/bulk/zip/FARA_All_RegistrantDocs.csv.zip")
zf = zipfile.ZipFile(io.BytesIO(b)); lines = zf.read(zf.namelist()[0]).decode("latin-1").splitlines()
sup = [re.search(r"https://efile\.fara\.gov/docs/[^\",]+\.pdf", l).group(0) for l in lines if "Supplemental Statement" in l and re.search(r'"\d\d/\d\d/2026"', l)][:25]
stats = []
for url in sup:
    s, ct, pdf, u = get(url)
    try:
        t = "\n".join(text(pdf))
    except Exception as e:
        stats.append([url, "err", repr(e)[:80]]); continue
    hits = re.findall(r"(?:Senator|Sen\.|Rep\.|Representative|Congressman|Congresswoman)\s+[A-Z][a-zA-Z'\-]+(?:\s+[A-Z][a-zA-Z'\-]+)?", t)
    stats.append([url, len(t), len(hits), hits[:6]])
res["fara_stats"] = stats
good = next((x for x in stats if isinstance(x[1], int) and x[2] > 0), None)
if good:
    s, ct, pdf, u = get(good[0]); t = "\n".join(text(pdf))
    i = t.find(good[3][0]); res["fara_excerpt"] = t[max(0, i - 1500): i + 800]
# Senate travel PDFs
s, ct, b, u = get("https://giftrule-disclosure.senate.gov/media/giftruledownloads/giftruledata.zip")
x = zipfile.ZipFile(io.BytesIO(b)).read("giftrule.xml").decode("utf-8-sig")
docs = re.findall(r'ReportingYear="2026"[^>]*>\s*<dbo\.Reports ReportTitle="([^"]+)" DocURL="([^"]+)"', x)[:6]
res["titles"] = sorted(set(re.findall(r'ReportTitle="([^"]+)"', x)))
res["filer_offices_sample"] = re.findall(r'<dbo\.filer LastName="([^"]+)" FirstName="([^"]+)">\s*<dbo\.Office OfficeName="([^"]+)"', x)[:5]
tt = []
for title, url in docs[:4]:
    s, ct, pdf, u = get(url)
    try:
        t = "\n".join(text(pdf, 3))
    except Exception as e:
        t = repr(e)
    tt.append([title, url, len(t), t[:1800]])
res["senate_travel_text"] = tt
(OUT / "govmoney5.json").write_text(json.dumps(res, indent=1, default=str))
