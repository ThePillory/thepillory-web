"""Temporary probe round 2: House Appropriations CPF pages, a Senate CDS PDF, House gift travel downloads, Senate eFD report types, USAspending recipient search."""
import io, json, re, urllib.request, urllib.error, zipfile
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)", "Accept": "*/*"}
def get(url, data=None, headers=None, n=3000000):
    h = dict(UA); h.update(headers or {})
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=120) as r:
            return r.status, r.headers.get("Content-Type"), r.read()[:n], r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()[:3000], url
    except Exception as e:
        return 0, None, repr(e).encode(), url
def links(b, pat):
    return sorted(set(re.findall(r'href="([^"]*(?:%s)[^"]*)"' % pat, b.decode("utf-8", "replace"), re.I)))[:80]
res = {}
s, ct, b, u = get("https://appropriations.house.gov/")
res["house_home"] = {"status": s, "links": links(b, r"communit|project|cpf|earmark|request")}
for url in ("https://appropriations.house.gov/fy26-community-project-funding", "https://appropriations.house.gov/community-project-funding-requests",
            "https://appropriations.house.gov/fiscal-year-2026-community-project-funding", "https://appropriations.house.gov/legislation/community-project-funding"):
    s, ct, b, u = get(url)
    res[url] = {"status": s, "final": u, "links": links(b, r"\.xlsx|\.xls|\.csv|\.pdf|communit|project")}
s, ct, b, u = get("https://www.appropriations.senate.gov/fy27-appropriations-requests-and-congressionally-directed-spending")
res["senate_fy27"] = {"status": s, "links": links(b, r"\.xlsx|\.xls|\.csv|\.pdf|directed")}
s, ct, b, u = get("https://www.appropriations.senate.gov/imo/media/doc/fy26_thud_cds.pdf")
res["senate_pdf"] = [s, ct, len(b)]
(OUT / "cds.pdf").write_bytes(b if b[:4] == b"%PDF" else b"")
# House gift travel page: full HTML around "download"
s, ct, b, u = get("https://disclosures-clerk.house.gov/GiftTravelFilings")
h = b.decode("utf-8", "replace")
i = h.find('id="download"')
res["house_gt"] = {"status": s, "final": u, "download_html": re.sub(r"\s+", " ", h[i - 200: i + 3000]) if i >= 0 else None,
                   "forms": re.findall(r'<form[^>]*>', h)[:5], "inputs": re.findall(r'<(?:input|select)[^>]*name="([^"]+)"', h)[:40], "links": links(b, r"zip|xml|pdf|gift|travel|download")}
for y in (2025, 2026):
    for path in (f"public_disc/gift-travel/{y}GT.zip", f"public_disc/gift-travel-pdfs/{y}GT.zip", f"public_disc/financial-pdfs/{y}GT.zip"):
        s, ct, b, u = get(f"https://disclosures-clerk.house.gov/{path}", n=400)
        res[f"gt_{path}"] = [s, ct]
# Senate eFD home: report types
s, ct, b, u = get("https://efdsearch.senate.gov/search/home/")
res["efd_home"] = [s, re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", b.decode("utf-8", "replace")))[:1500]]
# USAspending recipient search
body = json.dumps({"keyword": "Lockheed Martin Corporation", "award_type": "all", "limit": 5}).encode()
s, ct, b, u = get("https://api.usaspending.gov/api/v2/recipient/", data=body, headers={"Content-Type": "application/json"})
res["usa_recipient"] = [s, b.decode("utf-8", "replace")[:2500]]
body = json.dumps({"filters": {"recipient_id": "6cf5fb1b-4988-d087-5dc1-70939d8fc6c4-C", "time_period": [{"start_date": "2024-10-01", "end_date": "2025-09-30"}]}, "category": "awarding_agency", "limit": 5}).encode()
s, ct, b, u = get("https://api.usaspending.gov/api/v2/search/spending_by_category/awarding_agency/", data=body, headers={"Content-Type": "application/json"})
res["usa_by_recipient_id"] = [s, b.decode("utf-8", "replace")[:1200]]
s, ct, b, u = get("https://api.usaspending.gov/api/v2/recipient/6cf5fb1b-4988-d087-5dc1-70939d8fc6c4-C/")
res["usa_recipient_profile"] = [s, b.decode("utf-8", "replace")[:1500]]
(OUT / "govmoney2.json").write_text(json.dumps(res, indent=1))
