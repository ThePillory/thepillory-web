"""Temporary probe, round 10: the shapes of a Form 700's checkboxes and checkmarks; Calaveras supervisors in FPPC's search."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib
import pdfplumber
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
log = []
def say(*a): s = " ".join(str(x) for x in a); print(s); log.append(s)
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    with op.open(urllib.request.Request(u, data=data, headers=h), timeout=90) as r:
        return r.read()
raw("https://form700search.fppc.ca.gov/")
J = {"Content-Type": "application/json", "Accept": "application/json"}
def search(last, first=None):
    f = [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": last}]
    if first: f.append({"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": first})
    return json.loads(json.loads(raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps({"searchFieldQueryInfos": f}).encode(), hdr=J)))["documents"]
def pdf_of(x):
    p = x["filingPositions"][0]
    q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": x["filer"]["lastName"], "fileNameInfo.FirstName": x["filer"]["firstName"], "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"], "fileNameInfo.IsAmendment": str(x["filingInfo"]["isAmendment"]).lower(), "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
    return raw(json.loads(raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q))["PDFDownloadUrl"])
docs = search("Ma", "Fiona")
x = next(x for x in docs if x["filingPositions"][0]["filingType"] == "Annual" and x["filingPositions"][0]["filingYear"] == 2025 and x["filingPositions"][0]["position"] == "Treasurer")
pathlib.Path("/tmp/ma.pdf").write_bytes(pdf_of(x))
with pdfplumber.open("/tmp/ma.pdf") as doc:
    pg = doc.pages[2]
    shapes = []
    for c in pg.curves:
        w, h = c["x1"] - c["x0"], c["bottom"] - c["top"]
        if w < 14 and h < 14:
            shapes.append({"x0": round(c["x0"], 1), "top": round(c["top"], 1), "w": round(w, 1), "h": round(h, 1), "n": len(c.get("pts") or []), "pts": [(round(a, 1), round(b, 1)) for a, b in (c.get("pts") or [])][:12], "fill": c.get("fill"), "stroke": c.get("stroke"), "lw": c.get("linewidth"), "sc": c.get("stroking_color"), "nsc": c.get("non_stroking_color")})
    for s in sorted(shapes, key=lambda s: (s["top"], s["x0"])):
        say("  shape", json.dumps(s))
    for l in pg.lines[:15]:
        say("  line", round(l["x0"]), round(l["top"]), round(l["x1"]), round(l["bottom"]), l.get("linewidth"))
    say("TEXT", (pg.extract_text() or "")[:1800])
for last in ["Garamendi", "Tofanelli", "Stopper", "Folendorf", "Huberty", "Mills"]:
    try:
        ds = search(last)
    except Exception as e:
        say(last, "search failed", e); continue
    cal = [d for d in ds if "Calaveras" in json.dumps(d)]
    say(last, len(ds), "documents;", len(cal), "mention Calaveras:", [(d["filingPositions"][0]["agency"], d["filingPositions"][0]["position"], d["filingPositions"][0]["filingYear"], d["filingPositions"][0]["filingType"]) for d in cal[:6]])
(OUT / "log.txt").write_text("\n".join(log))
