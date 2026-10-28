import json, urllib.request, urllib.parse
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
B = "https://netfile.com/Connect2/api"
def call(method, path, body=None, q=None):
    u = B + path + ("?" + urllib.parse.urlencode(q) if q else "")
    data = json.dumps(body).encode() if body is not None else None
    h = {"User-Agent": UA, "Accept": "application/json"}
    if data: h["Content-Type"] = "application/json"
    try:
        r = urllib.request.urlopen(urllib.request.Request(u, data=data, headers=h, method=method), timeout=180)
        return r.status, r.read()
    except Exception as e:
        return getattr(e, "code", 0), (getattr(e, "read", lambda: b"")() or str(e).encode())[:600]
st, b = call("GET", "/public/campaign/agencies", q={"IncludeTestAgencies": "true", "IncludeCaSOS": "true"})
for r in json.loads(b).get("agencies", []):
    if r["shortcut"] in ("CLVS", "SCC", "CSC") or "Calaveras" in r["name"] or "San Jos" in r["name"] or "Cupertino" in r["name"] or "Campbell" in r["name"] or "Los Altos" in r["name"]:
        print("AG", r)
print("TYPES", call("GET", "/public/campaign/list/transaction/types")[1][:3000])
print("FORMS", call("GET", "/public/list/form/types")[1][:3000])
st, b = call("POST", "/public/campaign/search/transaction/query", body={"Agency": 51, "PageSize": 3, "CurrentPageIndex": 0, "DateStart": "2026-01-01", "SortOrder": 1})
print("TXN SCC", st, b[:4000])
st, b = call("GET", "/public/campaign/list/filer", q={"AID": "SCC", "PageSize": 3, "CurrentPageIndex": 0})
print("FILERS SCC", st, b[:1200])
for form in (30, 460, 1, 0):
    st, b = call("GET", "/public/list/filing", q={"AID": "SCC", "Application": "Campaign", "Form": form, "PageSize": 3, "CurrentPageIndex": 0})
    print("FILINGS SCC form", form, st, b[:1500])
st, b = call("GET", "/public/list/filing/rss/SCC/Campaign", q={"Format": "Xml"})
print("RSS", st, b[:2500])
