import json, urllib.request, io, zipfile
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
def show(label, u, data=None, accept="application/json", n=1200):
    print("=" * 20, label, u, data)
    h = {"User-Agent": UA, "Accept": accept}
    body = None
    if data is not None:
        h["Content-Type"] = "application/json"; body = json.dumps(data).encode()
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, data=body, headers=h), timeout=120)
        b = r.read(); print(r.status, r.headers.get("Content-Type"), len(b))
        if b[:2] == b"PK":
            z = zipfile.ZipFile(io.BytesIO(b)); print("ZIP", [(i.filename, i.file_size) for i in z.infolist()][:30])
        else:
            print(b[:n].decode("utf-8", "replace"))
        return b
    except Exception as e:
        print("ERR", e, (getattr(e, "read", lambda: b"")() or b"")[:300])
B = "https://netfile.com/Connect2/api"
for p in ["/metadata", "/openapi.json", "/swagger-ui/", "/types/metadata", "/json/metadata?op=PublicFilingListRequest"]:
    show("meta", B + p, accept="*/*", n=4000)
for body in [{"AID": "CLVS"}, {"Aid": "CLVS", "Application": "Campaign"}, {"AgencyId": "CLVS"}, {"AID": "CLVS", "Year": 2026}]:
    show("filings", B + "/public/list/filing", body, n=800)
for u in ["https://public.netfile.com/pub2/excel/CLVSBrowsable/efile_newest_CLVS_2026.zip",
          "https://public.netfile.com/pub2/excel/SCCBrowsable/efile_newest_SCC_2026.zip",
          "https://public.netfile.com/pub2/excel/CSJBrowsable/efile_newest_CSJ_2026.zip",
          "https://netfile.com/Connect2/api/public/campaign/export/cal201/transaction/year/2026?AID=CLVS&format=json",
          "https://netfile.com/Connect2/api/public/list/agencies?format=json"]:
    show("export", u, accept="*/*")
