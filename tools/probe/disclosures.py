"""Temporary probe, round 7: FPPC Form 700 PDFs for state officials; NetFile's value labels."""
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
for last, first in [("Newsom", "Gavin"), ("Kounalakis", "Eleni"), ("Ma", "Fiona"), ("Alvarado-Gil", "Marie")]:
    body = {"searchFieldQueryInfos": [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": last}, {"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": first}]}
    b = raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps(body).encode(), hdr=J)
    try:
        d = json.loads(json.loads(b))
    except Exception as e:
        say("  parse", type(e).__name__, b[:300]); continue
    docs = d.get("documents") or []
    say(f"  {first} {last}: {len(docs)} documents; keys {list(d)[:8]}")
    for x in docs[:12]:
        p = x["filingPositions"][0]
        say("   ", x["indexID"], x["filer"], x["filingInfo"], p.get("filingType"), p.get("filingYear"), p.get("agency"), p.get("position"), json.dumps(x.get("hits"))[:200])
    annual = [x for x in docs if "Annual" in (x["filingPositions"][0].get("filingType") or "")]
    annual.sort(key=lambda x: -(x["filingPositions"][0].get("filingYear") or 0))
    for x in annual[:2]:
        p = x["filingPositions"][0]
        q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": x["filer"]["lastName"], "fileNameInfo.FirstName": x["filer"]["firstName"],
              "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"],
              "fileNameInfo.IsAmendment": "false", "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
        pdf = raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q)
        if pdf[:4] == b"%PDF":
            f = pathlib.Path("/tmp/f.pdf"); f.write_bytes(pdf)
            say(subprocess.run(["pdfinfo", str(f)], capture_output=True, text=True).stdout.replace("\n", " | "))
            (OUT / f"fppc-{last}-{p['filingYear']}.txt").write_text(subprocess.run(["pdftotext", "-layout", str(f), "-"], capture_output=True, text=True).stdout)
        else:
            say("  not a PDF:", pdf[:300])
nf = raw("https://netfile.com/public/assets/index-vtK6lIvZ.js").decode("utf-8", "replace")
for w in ["FairMarketValue", "$100,001", "Over $1,000,000", "DateAcquired"]:
    for m in list(re.finditer(re.escape(w), nf))[:2]:
        say("   NF ...", nf[max(0, m.start()-500): m.start()+700].replace("\n", " "))
(OUT / "log.txt").write_text("\n".join(log))
