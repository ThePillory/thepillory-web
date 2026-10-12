"""Temporary probe round 2: line 17 rows in full, ProPublica full-filing pages (Schedule C political spending), IRS e-file index."""
import json, os, re, urllib.request, urllib.parse, urllib.error
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
K = os.environ.get("FEC_API_KEY") or "DEMO_KEY"
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co)"}
def raw(url, method="GET"):
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers=UA, method=method), timeout=90) as r:
            return r.status, dict(r.headers), (r.read() if method == "GET" else b"")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()[:400]
    except Exception as e:
        return 0, {}, repr(e).encode()
def fec(path, **p):
    p["api_key"] = K
    return json.loads(raw(f"https://api.open.fec.gov/v1{path}?{urllib.parse.urlencode(p, doseq=True)}")[2])
res = {}
d = fec("/schedules/schedule_a/", committee_id="C00571703", two_year_transaction_period=2024, is_individual="false", sort="-contribution_receipt_amount", per_page=12)
res["rows"] = d.get("results", [])[:12]
# Line-number filter works?
d = fec("/schedules/schedule_a/", committee_id="C00484642", two_year_transaction_period=2024, is_individual="false", line_number=["F3X-11AI", "F3X-11C"], sort="-contribution_receipt_amount", per_page=5)
res["line_filter"] = {"pagination": d.get("pagination"), "first": [(r.get("contributor_name"), r.get("line_number"), r.get("contribution_receipt_amount")) for r in d.get("results", [])], "err": d.get("message") or d.get("error")}
d = fec("/schedules/schedule_a/by_size/", committee_id="C00571703", cycle=2024)
res["by_size"] = d.get("results", [])[:3]
# ProPublica org HTML: links to full filings
s, h, b = raw("https://projects.propublica.org/nonprofits/organizations/271937961")
html = b.decode("utf-8", "replace")
res["pp_html_status"] = s
res["pp_links"] = sorted(set(re.findall(r'href="([^"]*(?:full|xml|object)[^"]*)"', html)))[:20]
full = [l for l in res["pp_links"] if "/full" in l]
if full:
    u = full[0] if full[0].startswith("http") else "https://projects.propublica.org" + full[0]
    s, h, b = raw(u)
    t = re.sub(r"<[^>]+>", " ", b.decode("utf-8", "replace"))
    t = re.sub(r"\s+", " ", t)
    res["pp_full_status"] = s
    res["pp_full_political"] = [t[max(0, m.start() - 200): m.start() + 300] for m in re.finditer(r"(?i)political", t)][:12]
# IRS e-file index
for y in (2024, 2025):
    s, h, b = raw(f"https://apps.irs.gov/pub/epostcard/990/xml/{y}/index_{y}.csv", method="HEAD")
    res[f"irs_index_{y}"] = [s, h.get("Content-Length"), h.get("Last-Modified")]
s, h, b = raw("https://www.irs.gov/charities-non-profits/form-990-series-downloads")
res["irs_page"] = re.findall(r'href="([^"]+\.zip)"', b.decode("utf-8", "replace"))[:30]
(OUT / "darkmoney2.json").write_text(json.dumps(res, indent=1, default=str))
print("ok")
