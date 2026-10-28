import json, urllib.request, urllib.parse, io, zipfile
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
B = "https://netfile.com/Connect2/api"
def call(method, path, body=None, q=None, accept="application/json"):
    u = B + path + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": UA, "Accept": accept}
    if data: h["Content-Type"] = "application/json"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, data=data, headers=h, method=method), timeout=180)
        return r.status, r.headers.get("Content-Type"), r.read()
    except Exception as e:
        return getattr(e, "code", 0), "", (getattr(e, "read", lambda: b"")() or str(e).encode())[:600]
st, ct, b = call("GET", "/public/filing/info/217834141")
print("INFO", st, ct, b[:2500])
st, ct, b = call("GET", "/public/efile/217834141", accept="*/*")
print("EFILE", st, ct, len(b))
if b[:2] == b"PK":
    z = zipfile.ZipFile(io.BytesIO(b)); print([i.filename for i in z.infolist()]); b = z.read(z.infolist()[0])
print(b[:5000].decode("utf-8", "replace"))
st, ct, b = call("GET", "/public/image/217834141", accept="*/*")
print("IMAGE", st, ct, len(b), b[:8])
for tt in (4, 19, 20):
    st, ct, b = call("POST", "/public/campaign/search/transaction/query", body={"Agency": 51, "PageSize": 3, "CurrentPageIndex": 0, "DateStart": "2026-01-01", "TransactionType": tt, "SortOrder": 1})
    print("TYPE", tt, st, b[:2500])
st, ct, b = call("POST", "/public/campaign/search/transaction/query", body={"Agency": 51, "PageSize": 1000, "CurrentPageIndex": 0, "DateStart": "2026-01-01", "SortOrder": 1})
d = json.loads(b); print("PAGE1000", st, len(d.get("results", [])), d.get("totalMatchingPages"))
codes = {}
for r in d.get("results", []):
    codes[(r["transactionType"], r["code"])] = codes.get((r["transactionType"], r["code"]), 0) + 1
print("CODES", sorted(codes.items(), key=lambda x: -x[1])[:40])
st, ct, b = call("POST", "/public/campaign/search/transaction/query", body={"Agency": 116, "QueryString": "Folendorf", "PageSize": 5, "CurrentPageIndex": 0})
print("SUPER Folendorf", st, b[:2500])
