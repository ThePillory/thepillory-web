"""Temporary probe: FEC Schedule A (organizations), committee totals, electioneering (Form 9), ProPublica Nonprofit Explorer."""
import json, os, urllib.request, urllib.parse, urllib.error
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
K = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co)", "Accept": "application/json"}
def get(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        return {"error": e.code, "body": e.read()[:500].decode("utf-8", "replace")}
def fec(path, **p):
    p["api_key"] = K
    return get(f"https://api.open.fec.gov/v1{path}?{urllib.parse.urlencode(p, doseq=True)}")
res = {"keylen": len(K)}
# Senate Leadership Fund (super PAC), 2026 cycle and 2024.
for cid in ("C00571703", "C00484642"):
    for cyc in (2024, 2026):
        d = fec("/schedules/schedule_a/", committee_id=cid, two_year_transaction_period=cyc, is_individual="false", sort="-contribution_receipt_amount", per_page=30)
        rows = d.get("results", [])
        res[f"a_{cid}_{cyc}"] = {"pagination": d.get("pagination"), "err": d.get("error"), "body": d.get("body"),
            "rows": [{k: r.get(k) for k in ("contributor_name", "entity_type", "entity_type_desc", "contributor_id", "contribution_receipt_amount", "contribution_receipt_date", "memo_code", "memo_text", "receipt_type", "receipt_type_desc", "line_number", "contributor_employer", "contributor_occupation", "pdf_url", "is_individual", "contributor_aggregate_ytd")} for r in rows]}
        t = fec(f"/committee/{cid}/totals/", cycle=cyc)
        res[f"t_{cid}_{cyc}"] = (t.get("results") or [{}])[:1] and {k: v for k, v in (t.get("results") or [{}])[0].items() if any(w in k for w in ("receipt", "contribution", "transfer", "coverage", "cycle", "individual", "other_political", "loan"))}
e = fec("/electioneering/", min_date="2024-08-01", per_page=5, sort="-disbursement_date")
res["ec"] = e.get("results", [])[:5]; res["ec_pag"] = e.get("pagination")
e2 = fec("/electioneering/aggregates/", cycle=2024, per_page=5)
res["ec_agg"] = e2.get("results", [])[:3]
f9 = fec("/filings/", form_type="F9", per_page=3, sort="-receipt_date")
res["f9"] = [{k: r.get(k) for k in ("committee_id", "committee_name", "form_type", "receipt_date", "pdf_url", "fec_url", "total_receipts", "file_number", "amendment_indicator")} for r in f9.get("results", [])]
# Schedule A on a Form 9 filer (donors to the communication), if any.
if res["ec"]:
    cid = res["ec"][0].get("committee_id")
    res["ec_donors"] = fec("/schedules/schedule_a/", committee_id=cid, per_page=5)
pp = "https://projects.propublica.org/nonprofits/api/v2"
for q in ("One Nation", "Majority Forward", "Chamber of Commerce of the United States of America", "Americans for Prosperity"):
    s = get(f"{pp}/search.json?q={urllib.parse.quote(q)}")
    res[f"pp_search_{q}"] = {"total": s.get("total_results"), "orgs": [{k: o.get(k) for k in ("ein", "strein", "name", "sub_name", "subseccd", "ntee_code", "state", "city")} for o in s.get("organizations", [])[:6]], "err": s.get("error")}
s = res["pp_search_One Nation"]["orgs"]
ein = s[0]["ein"] if s else 834567890
o = get(f"{pp}/organizations/{ein}.json")
res["pp_org"] = {"organization": {k: v for k, v in (o.get("organization") or {}).items() if k in ("ein", "name", "subsection_code", "ntee_code", "state", "tax_period", "revenue_amount")},
                 "filings_with_data": (o.get("filings_with_data") or [])[:2], "filings_without_data": (o.get("filings_without_data") or [])[:2]}
(OUT / "darkmoney.json").write_text(json.dumps(res, indent=1, default=str))
print(json.dumps(res, default=str)[:4000])
