"""Temporary probe, round 8: FPPC Form 700 PDF text for state officials; all Calaveras Schedule A-1 rows and Supervisors' filings."""
import re, json, subprocess, urllib.request, urllib.parse, http.cookiejar, pathlib
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
log = []
def say(*a): s = " ".join(str(x) for x in a); print(s); log.append(s)
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    try:
        with op.open(urllib.request.Request(u, data=data, headers=h), timeout=90) as r:
            b = r.read(); say(f"== {u[:200]} -> {r.status} {r.headers.get('content-type')} {len(b)}"); return b
    except urllib.error.HTTPError as e:
        say(f"== {u[:200]} -> HTTP {e.code}: {e.read()[:400]!r}"); return b""
    except Exception as e:
        say(f"== {u[:200]} -> {type(e).__name__}: {e}"); return b""
raw("https://form700search.fppc.ca.gov/")
J = {"Content-Type": "application/json", "Accept": "application/json"}
for last, first in [("Newsom", "Gavin"), ("Ma", "Fiona"), ("Alvarado-Gil", "Marie"), ("Kounalakis", "Eleni")]:
    body = {"searchFieldQueryInfos": [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": last}, {"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": first}]}
    d = json.loads(json.loads(raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps(body).encode(), hdr=J)))
    annual = [x for x in d["documents"] if x["filingPositions"][0].get("filingType") == "Annual"]
    annual.sort(key=lambda x: (-(x["filingPositions"][0].get("filingYear") or 0), x["filingInfo"]["filedDate"]), reverse=False)
    for x in annual[:2]:
        p = x["filingPositions"][0]
        q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": x["filer"]["lastName"], "fileNameInfo.FirstName": x["filer"]["firstName"],
              "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"],
              "fileNameInfo.IsAmendment": str(x["filingInfo"]["isAmendment"]).lower(), "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
        j = json.loads(raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q))
        pdf = raw(j["PDFDownloadUrl"])
        if pdf[:4] == b"%PDF":
            f = pathlib.Path("/tmp/f.pdf"); f.write_bytes(pdf)
            say(subprocess.run(["pdfinfo", str(f)], capture_output=True, text=True).stdout.replace("\n", " | "))
            (OUT / f"fppc-{last}-{p['filingYear']}-{p['agency'][:12]}.txt").write_text(subprocess.run(["pdftotext", "-layout", str(f), "-"], capture_output=True, text=True).stdout)
        else:
            say("  not a PDF:", pdf[:200])
base = "https://netfile.com/api/public/sites/api/"
H = {"Content-Type": "application/json", "Accept": "application/json"}
rows = []
for page in range(1, 6):
    q = {"aid": "CLVS", "isArchived": False, "search": "", "searchSchedules": ["A1"], "currentPage": page, "pageSize": 50, "sort": "filingDate"}
    d = json.loads(raw(base + "searchtransactions", data=json.dumps(q).encode(), hdr=H))
    rows += d["items"]
    if not d.get("hasNextPage"): break
(OUT / "netfile-a1-all.json").write_text(json.dumps(rows))
say("A1 rows", len(rows), "with dates", sum(1 for r in rows if json.loads(r["content"]).get("DateAcquired") or json.loads(r["content"]).get("DateDisposed")))
q = {"aid": "CLVS", "isArchived": False, "search": "", "searchPosition": "Supervisor", "currentPage": 1, "pageSize": 50, "sort": "filingDate"}
d = json.loads(raw(base + "searchfilings", data=json.dumps(q).encode(), hdr=H))
for x in d["items"][:40]:
    say("  SUP", x["filerName"], x["positionName"], x["year"], x["statementType"], x["filingDate"][:10], "A1:", x["coverDetailsScheduleA1Count"], "archived:", x["isArchived"], x["id"], x["filingId"])
(OUT / "log.txt").write_text("\n".join(log))
