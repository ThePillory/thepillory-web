import json, sys, urllib.request, io, zipfile
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
def req(u, data=None, accept="application/json"):
    h = {"User-Agent": UA, "Accept": accept}
    if data is not None:
        h["Content-Type"] = "application/json"; data = json.dumps(data).encode()
    r = urllib.request.urlopen(urllib.request.Request(u, data=data, headers=h), timeout=90)
    return r.status, r.headers.get("Content-Type"), r.read()
def show(label, u, data=None, accept="application/json", n=1500):
    print("=" * 20, label, u)
    try:
        st, ct, b = req(u, data, accept)
        print(st, ct, len(b))
        if b[:2] == b"PK":
            z = zipfile.ZipFile(io.BytesIO(b)); print("ZIP", [(i.filename, i.file_size) for i in z.infolist()][:20]); return b
        print(b[:n].decode("utf-8", "replace")); return b
    except Exception as e:
        print("ERR", e, getattr(e, "read", lambda: b"")()[:500])
B = "https://netfile.com/Connect2/api"
ag = show("agencies", B + "/public/list/agencies", n=400)
try:
    d = json.loads(ag)
    rows = d if isinstance(d, list) else d.get("agencies") or d.get("Agencies") or d
    print("COUNT", len(rows))
    for r in rows:
        s = json.dumps(r)
        if any(k in s.upper() for k in ("SANTA CLARA", "CALAVERAS", "SAN JOSE", "SAN JOSÉ", "SUNNYVALE", "PALO ALTO", "MOUNTAIN VIEW", "CUPERTINO", "MILPITAS", "GILROY", "MORGAN HILL", "CAMPBELL", "LOS GATOS", "SARATOGA", "LOS ALTOS")):
            print("AG", s)
    open("/tmp/agencies.json", "w").write(json.dumps(rows))
except Exception as e:
    print("parse", e)
show("filings CLVS", B + "/public/list/filing", {"AID": "CLVS", "Application": "Campaign", "CurrentPageIndex": 0, "PageSize": 5})
show("filings list GET", B + "/public/list/filing/list/CLVS?pageSize=5")
show("export cal201 CLVS 2026", B + "/public/campaign/export/cal201/transaction/year/2026?aid=CLVS", accept="*/*")
show("help", B + "/help", accept="text/html", n=3000)
