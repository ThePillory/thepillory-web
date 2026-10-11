"""Temporary probe, round 5: saves sample text to tools/probe/out/ (committed by the workflow)."""
import re, json, subprocess, urllib.request, urllib.parse, http.cookiejar, pathlib
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
log = []
def say(*a): s = " ".join(str(x) for x in a); print(s); log.append(s)
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    try:
        with op.open(urllib.request.Request(u, data=data, headers=h), timeout=60) as r:
            b = r.read(); say(f"== {u} -> {r.status} {r.headers.get('content-type')} {len(b)}"); return b
    except urllib.error.HTTPError as e:
        say(f"== {u} -> HTTP {e.code}: {e.read()[:600]!r}"); return b""
    except Exception as e:
        say(f"== {u} -> {type(e).__name__}: {e}"); return b""
# 1. Justices: every 2023-2025 report's text layer
for y in (2023, 2024, 2025):
    h = raw(f"https://fixthecourt.com/{y}disclosures/").decode("utf-8", "replace")
    for u in sorted(set(re.findall(r'href="(https://fixthecourt\.com/wp-content/uploads/[^"]*Annual-%d[^"]*\.pdf)"' % y, h))):
        b = raw(u)
        if not b: continue
        p = pathlib.Path("/tmp/x.pdf"); p.write_bytes(b)
        t = subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout
        (OUT / ("scotus-" + u.rsplit("/", 1)[1].replace(".pdf", ".txt"))).write_text(f"SOURCE {u}\n" + t)
# 2. FPPC: bootstrap and a search
b = raw("https://form700search.fppc.ca.gov/Home/GetBootstrap", hdr={"Accept": "application/json", "X-Requested-With": "XMLHttpRequest"})
(OUT / "fppc-bootstrap.txt").write_bytes(b[:200000])
js = raw("https://form700search.fppc.ca.gov/Scripts/searchExportBundle?v=PmZlP9DDYzcACL-VvAVDQMhok6EFPb07FuLAfWYKwj81").decode("utf-8", "replace")
(OUT / "fppc-searchExportBundle.js").write_text(js)
for body in [{"searchQueryInfo": [{"queryField": "FilerLastName", "filterValue": "Newsom"}]},
             {"query": [{"queryField": "FilerLastName", "filterValue": "Newsom"}]}]:
    b = raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps(body).encode(), hdr={"Content-Type": "application/json", "Accept": "application/json", "X-Requested-With": "XMLHttpRequest"})
    (OUT / "fppc-search.txt").write_bytes(b[:100000]); say("   ", b[:800])
# 3. NetFile (Calaveras): SEI filings and transactions
base = "https://netfile.com/api/public/sites/api/"
say(raw(base + "config/CLVS")[:1500])
q = {"aid": "CLVS", "isArchived": False, "search": "", "currentPage": 1, "pageSize": 50, "sort": "filingDate"}
for path in ["searchfilings", "searchtransactions"]:
    b = raw(base + path, data=json.dumps(q).encode(), hdr={"Content-Type": "application/json", "Accept": "application/json"})
    (OUT / f"netfile-{path}.json").write_bytes(b[:300000]); say("   ", b[:1500])
b = raw(base + "exporttransactioncsv", data=json.dumps(q).encode(), hdr={"Content-Type": "application/json"})
(OUT / "netfile-transactions.csv").write_bytes(b[:300000]); say("   ", b[:1500])
(OUT / "log.txt").write_text("\n".join(log))
