"""Temporary probe: Congress.gov committee bills (relationship types) and bill actions."""
import json, os, urllib.request, collections
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
K = os.environ["CONGRESS_API_KEY"]
def get(path, **p):
    q = "&".join(f"{k}={v}" for k, v in {"format": "json", "api_key": K, **p}.items())
    with urllib.request.urlopen(f"https://api.congress.gov/v3{path}?{q}", timeout=60) as r:
        return json.loads(r.read())
res = {}
c = get("/committee/119/house", limit=250)
res["house_committees"] = [(x["systemCode"], x["name"], x.get("committeeTypeCode"), bool(x.get("parent"))) for x in c.get("committees", [])][:80]
c = get("/committee/119/senate", limit=250)
res["senate_committees"] = [(x["systemCode"], x["name"], x.get("committeeTypeCode"), bool(x.get("parent"))) for x in c.get("committees", [])][:80]
for code, ch in (("hsif00", "house"), ("ssfi00", "senate"), ("hsju00", "house")):
    d = get(f"/committee/{ch}/{code}/bills", limit=250, fromDateTime="2025-01-03T00:00:00Z")
    cb = d.get("committee-bills", d)
    bills = cb.get("bills", [])
    res[code] = {"keys": list(d.keys()), "count": cb.get("count"), "pagination": d.get("pagination"),
                 "rel": collections.Counter(b.get("relationshipType") for b in bills).most_common(),
                 "congress": collections.Counter(b.get("congress") for b in bills).most_common(),
                 "first": bills[:3], "last": bills[-2:]}
d = get("/bill/119/hr/1/actions", limit=50)
res["actions"] = [(a.get("actionDate"), a.get("type"), a.get("actionCode"), a.get("text")[:90]) for a in d.get("actions", [])][:40]
d = get("/bill/119", limit=5, sort="updateDate+desc")
res["bill_list"] = d.get("bills", [])[:2]
(OUT / "committee.json").write_text(json.dumps(res, indent=1, default=str))
print(json.dumps(res, default=str)[:3000])
