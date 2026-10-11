"""Temporary probe, round 12: save a few Form 700 PDFs (public records) for building the reader."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out/pdf"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    with op.open(urllib.request.Request(u, data=data, headers=h), timeout=90) as r:
        return r.read()
raw("https://form700search.fppc.ca.gov/")
J = {"Content-Type": "application/json", "Accept": "application/json"}
def search(last, first):
    f = [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": last}, {"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": first}]
    return json.loads(json.loads(raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps({"searchFieldQueryInfos": f}).encode(), hdr=J)))["documents"]
def pdf_of(x):
    p = x["filingPositions"][0]
    q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": x["filer"]["lastName"], "fileNameInfo.FirstName": x["filer"]["firstName"], "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"], "fileNameInfo.IsAmendment": str(x["filingInfo"]["isAmendment"]).lower(), "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
    return raw(json.loads(raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q))["PDFDownloadUrl"])
want = [("Ma", "Fiona", 2025), ("Ma", "Fiona", 2023), ("Newsom", "Gavin", 2025), ("Kounalakis", "Eleni", 2025), ("Alvarado-Gil", "Marie", 2024),
        ("Bonta", "Rob", 2025), ("Cohen", "Malia", 2025), ("Weber", "Shirley", 2024), ("Huberty", "Martin", 2024), ("Stopper", "Benjamin", 2024), ("Folendorf", "Amanda", 2024)]
index = []
for last, first, year in want:
    try:
        docs = [x for x in search(last, first) if x["filingPositions"][0]["filingType"] == "Annual" and x["filingPositions"][0]["filingYear"] == year]
        if not docs: print(last, year, "none"); continue
        x = sorted(docs, key=lambda d: d["filingInfo"]["filedDate"])[-1]
        b = pdf_of(x)
        name = f"{last}-{year}.pdf"; (OUT / name).write_bytes(b)
        index.append({"file": name, "doc": x}); print(last, year, len(b))
    except Exception as e:
        print(last, year, type(e).__name__, e)
(OUT / "index.json").write_text(json.dumps(index, indent=1))
