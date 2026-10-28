import json, urllib.request, urllib.parse, concurrent.futures as cf
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
B = "https://netfile.com/Connect2/api"
def call(method, path, body=None, q=None, accept="application/json"):
    u = B + path + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": UA, "Accept": accept}
    if data: h["Content-Type"] = "application/json"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, data=data, headers=h, method=method), timeout=120)
        return r.status, r.headers.get("Content-Type"), r.read()
    except Exception as e:
        return getattr(e, "code", 0), "", (getattr(e, "read", lambda: b"")() or str(e).encode())[:400]
for acc in ("application/json", "text/plain", "application/octet-stream", "text/csv"):
    st, ct, b = call("GET", "/public/efile/217834141", accept=acc)
    print("EFILE", acc, st, ct, len(b)); print(b[:3000].decode("utf-8", "replace") if b[:1] != b"<" else b[:200])
for p in ("/public/efile/217834141.json", "/public/efile/217834141?format=json", "/json/reply/PublicEfileRequest?FilingId=217834141"):
    st, ct, b = call("GET", p)
    print("EFILE2", p, st, ct, len(b)); print(b[:1500].decode("utf-8", "replace") if b[:1] != b"<" else b[:200])
ids = set(r["id"] for r in json.loads(call("GET", "/public/campaign/agencies", q={"IncludeTestAgencies": "true"})[2])["agencies"])
def probe(i):
    st, ct, b = call("POST", "/public/campaign/search/transaction/query", body={"Agency": i, "PageSize": 1, "CurrentPageIndex": 0})
    try:
        d = json.loads(b)
        r = d.get("results") or []
        return i, d.get("totalMatchingCount"), (r[0]["filerLocalId"], r[0]["filerName"]) if r else None
    except Exception:
        return i, None, None
with cf.ThreadPoolExecutor(8) as ex:
    for i, n, r in ex.map(probe, [i for i in range(0, 700) if i not in ids]):
        if n:
            print("UNLISTED", i, n, r)
