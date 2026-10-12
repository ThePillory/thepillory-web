"""Temporary probe round 3: a 990 e-file XML from ProPublica (Schedule C), and electioneering volume."""
import json, os, re, urllib.request, urllib.parse, urllib.error
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
K = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co)"}
def raw(url):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=90) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:400]
res = {}
for ein, oid in (("271937961", "202443209349324304"), ("530045720", None), ("833690373", None)):
    if not oid:
        s, h, b = raw(f"https://projects.propublica.org/nonprofits/organizations/{ein}")
        ids = sorted(set(re.findall(r"download-xml\?object_id=(\d+)", b.decode("utf-8", "replace"))))
        res[f"ids_{ein}"] = ids
        oid = ids[-1] if ids else None
    if not oid: continue
    s, h, b = raw(f"https://projects.propublica.org/nonprofits/download-xml?object_id={oid}")
    x = b.decode("utf-8", "replace")
    res[f"xml_{ein}"] = {"status": s, "ctype": h.get("Content-Type"), "len": len(x),
        "returntype": re.findall(r"<ReturnTypeCd>([^<]+)", x)[:2], "taxyr": re.findall(r"<TaxYr>([^<]+)", x)[:2],
        "taxperiod": re.findall(r"<TaxPeriodEndDt>([^<]+)", x)[:2],
        "schedules": sorted(set(re.findall(r"<(IRS990Schedule\w+)", x))),
        "rev": re.findall(r"<(CYTotalRevenueAmt|TotalRevenueGrp|TotalRevenueAmt)>([^<]*)", x)[:3],
        "exp": re.findall(r"<(CYTotalExpensesAmt|TotalFunctionalExpensesGrp)>([^<]*)", x)[:3],
        "politicalTags": sorted(set(re.findall(r"<(\w*[Pp]olitic\w*)>", x))),
        "schedC": re.sub(r"\s+", " ", (re.search(r"<IRS990ScheduleC[\s\S]*?</IRS990ScheduleC>", x) or [""])[0])[:3000],
        "flags": re.findall(r"<(PoliticalCampaignActyInd|LobbyingActivitiesInd)>([^<]*)", x)}
for cyc in (2024, 2026):
    e = json.loads(raw(f"https://api.open.fec.gov/v1/electioneering/?cycle={cyc}&per_page=1&api_key={K}")[2])
    res[f"ec_{cyc}"] = e.get("pagination")
    e = json.loads(raw(f"https://api.open.fec.gov/v1/electioneering/?min_date={cyc-1}-01-01&max_date={cyc}-12-31&per_page=1&api_key={K}")[2])
    res[f"ec_dates_{cyc}"] = e.get("pagination")
f = json.loads(raw(f"https://api.open.fec.gov/v1/filings/?file_number=2013897&api_key={K}")[2])
res["f9_file"] = [{k: r.get(k) for k in ("committee_id", "form_type", "total_receipts", "total_disbursements", "pdf_url", "receipt_date", "coverage_start_date", "coverage_end_date")} for r in f.get("results", [])]
(OUT / "darkmoney3.json").write_text(json.dumps(res, indent=1, default=str))
