"""Temporary probe: earmark tables, USAspending, FARA eFile, House/Senate gift travel."""
import json, re, urllib.request, urllib.error, urllib.parse
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)", "Accept": "*/*"}
def get(url, data=None, headers=None, n=200000):
    h = dict(UA); h.update(headers or {})
    try:
        req = urllib.request.Request(url, data=data, headers=h)
        with urllib.request.urlopen(req, timeout=90) as r:
            return r.status, r.headers.get("Content-Type"), r.read()[:n]
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()[:2000]
    except Exception as e:
        return 0, None, repr(e).encode()
def links(b, pat):
    return sorted(set(re.findall(r'href="([^"]*(?:%s)[^"]*)"' % pat, b.decode("utf-8", "replace"), re.I)))[:60]
res = {}
# Earmarks
for name, url in [
    ("house_cpf", "https://appropriations.house.gov/community-project-funding"),
    ("house_cpf26", "https://appropriations.house.gov/fiscal-year-2026-community-project-funding-requests"),
    ("house_cpf_alt", "https://appropriations.house.gov/legislation/fiscal-year-2026-community-project-funding"),
    ("senate_cds", "https://www.appropriations.senate.gov/congressionally-directed-spending-requests"),
    ("senate_cds2", "https://www.appropriations.senate.gov/fy-2026-congressionally-directed-spending"),
]:
    s, ct, b = get(url)
    res[name] = {"status": s, "ct": ct, "links": links(b, r"\.xlsx|\.xls|\.csv|\.pdf|project|directed|earmark")}
# USAspending
body = json.dumps({"filters": {"recipient_search_text": ["Lockheed Martin Corporation"], "award_type_codes": ["A", "B", "C", "D"], "time_period": [{"start_date": "2024-10-01", "end_date": "2025-09-30"}]},
                   "fields": ["Award ID", "Recipient Name", "Award Amount", "Awarding Agency", "Start Date", "recipient_id"], "limit": 3, "page": 1, "sort": "Award Amount", "order": "desc"}).encode()
s, ct, b = get("https://api.usaspending.gov/api/v2/search/spending_by_award/", data=body, headers={"Content-Type": "application/json"})
res["usa_awards"] = [s, b.decode("utf-8", "replace")[:2500]]
body = json.dumps({"filters": {"recipient_search_text": ["Lockheed Martin Corporation"], "time_period": [{"start_date": "2024-10-01", "end_date": "2025-09-30"}]}, "category": "awarding_agency", "limit": 5}).encode()
s, ct, b = get("https://api.usaspending.gov/api/v2/search/spending_by_category/awarding_agency/", data=body, headers={"Content-Type": "application/json"})
res["usa_by_agency"] = [s, b.decode("utf-8", "replace")[:2000]]
body = json.dumps({"keyword": "Lockheed Martin", "limit": 5}).encode()
s, ct, b = get("https://api.usaspending.gov/api/v2/autocomplete/recipient/", data=body, headers={"Content-Type": "application/json"})
res["usa_autocomplete"] = [s, b.decode("utf-8", "replace")[:2000]]
# FARA
for name, url in [
    ("fara_active", "https://efile.fara.gov/api/v1/Registrants/json/Active"),
    ("fara_fp", "https://efile.fara.gov/api/v1/ForeignPrincipals/json/Active/6400"),
    ("fara_docs", "https://efile.fara.gov/api/v1/RegDocs/json/6400"),
    ("fara_bulk_page", "https://efile.fara.gov/ords/fara/f?p=API:BULKDATA"),
]:
    s, ct, b = get(url)
    res[name] = [s, ct, b.decode("utf-8", "replace")[:2500]]
s, ct, b = get("https://efile.fara.gov/ords/fara/f?p=API:BULKDATA")
res["fara_bulk_links"] = links(b, r"\.zip|\.csv|bulk")
# Gift travel
for name, url in [
    ("house_travel", "https://disclosures-clerk.house.gov/GiftTravelFilings"),
    ("house_travel_search", "https://disclosures-clerk.house.gov/GiftTravelFilings/Search"),
    ("house_public_disc", "https://disclosures-clerk.house.gov/PublicDisclosure/FinancialDisclosure"),
    ("senate_travel", "https://www.senate.gov/legislative/Public_Disclosure/gift_travel.htm"),
    ("senate_opr", "https://www.senate.gov/legislative/opr.htm"),
    ("senate_gifts", "https://soprweb.senate.gov/index.cfm?event=selectfields"),
]:
    s, ct, b = get(url)
    t = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", re.sub(r"<script[\s\S]*?</script>|<style[\s\S]*?</style>", "", b.decode("utf-8", "replace"))))
    res[name] = {"status": s, "ct": ct, "text": t[:1500], "links": links(b, r"travel|gift|zip|xml|download|search")}
(OUT / "govmoney.json").write_text(json.dumps(res, indent=1))
