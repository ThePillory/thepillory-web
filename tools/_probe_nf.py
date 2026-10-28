import json, urllib.request, urllib.parse
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
B = "https://netfile.com/Connect2/api"
def call(method, path, body=None, q=None, accept="application/json"):
    u = B + path + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": UA, "Accept": accept}
    if data: h["Content-Type"] = "application/json"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, data=data, headers=h, method=method), timeout=180)
        b = r.read(); return r.status, r.headers.get("Content-Type"), b
    except Exception as e:
        return getattr(e, "code", 0), str(e), (getattr(e, "read", lambda: b"")() or b"")[:400]
st, ct, b = call("GET", "/public/campaign/agencies")
print("AGENCIES", st, ct, len(b))
try:
    ag = json.loads(b)
    print(json.dumps(ag)[:600])
    rows = ag if isinstance(ag, list) else next(v for v in ag.values() if isinstance(v, list))
    print("COUNT", len(rows))
    for r in rows:
        print("AG", json.dumps(r, ensure_ascii=False))
except Exception as e:
    print("parse", e, b[:300])
st, ct, b = call("GET", "/public/campaign/list/filer", q={"AID": "CLVS", "PageSize": 5, "CurrentPageIndex": 0})
print("FILERS", st, ct, b[:1500])
st, ct, b = call("GET", "/public/list/filing", q={"AID": "CLVS", "Application": "Campaign", "PageSize": 3, "CurrentPageIndex": 0})
print("FILINGS", st, ct, b[:1500])
for path in ["/public/campaign/export/cal201/summary/year", "/public/campaign/export/cal201/transaction/year"]:
    for body in [{"Aid": "CLVS", "Year": 2026}, {"AID": "CLVS", "Year": 2026, "PageSize": 3, "CurrentPageIndex": 0}]:
        st, ct, b = call("POST", path, body=body)
        print("EXPORT", path, body, st, ct, len(b)); print(b[:1500])
    st, ct, b = call("POST", path + "/csv", body={"Aid": "CLVS", "Year": 2026}, accept="*/*")
    print("EXPORTCSV", path, st, ct, len(b)); print(b[:1200])
