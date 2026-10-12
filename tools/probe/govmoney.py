"""Temporary probe round 4: Senate gift travel XML, House gift travel search results, FY27 CPF awards xlsx, enacted CPF/CDS tables, a FARA supplemental statement's text."""
import io, json, re, sys, zipfile, http.cookiejar, urllib.request, urllib.error, urllib.parse
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; public records)", "Accept": "*/*"}
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def get(url, data=None, headers=None, n=60000000):
    h = dict(UA); h.update(headers or {})
    try:
        with op.open(urllib.request.Request(url, data=data, headers=h), timeout=180) as r:
            return r.status, r.headers.get("Content-Type"), r.read()[:n]
    except urllib.error.HTTPError as e:
        return e.code, e.headers.get("Content-Type"), e.read()[:3000]
    except Exception as e:
        return 0, None, repr(e).encode()
def links(b, pat):
    return sorted(set(re.findall(r'href="([^"]*(?:%s)[^"]*)"' % pat, b.decode("utf-8", "replace"), re.I)))[:80]
res = {}
s, ct, b = get("https://www.senate.gov/legislative/Public_Disclosure/gift-rule-travel.htm")
res["senate_gt_page"] = {"status": s, "links": links(b, r"zip|xml|gift|travel|search")}
z = next((l for l in res["senate_gt_page"]["links"] if l.lower().endswith(".zip")), None)
if z:
    url = z if z.startswith("http") else urllib.parse.urljoin("https://www.senate.gov/legislative/Public_Disclosure/", z)
    s, ct, b = get(url)
    res["senate_zip"] = [url, s, ct, len(b)]
    try:
        zf = zipfile.ZipFile(io.BytesIO(b)); names = zf.namelist(); res["senate_zip_names"] = names[:10]
        x = zf.read(names[0]).decode("utf-8", "replace"); res["senate_xml_head"] = x[:4000]; res["senate_xml_len"] = len(x)
    except Exception as e:
        res["senate_zip_err"] = repr(e)
# House gift travel: token, then search a member
s, ct, b = get("https://disclosures-clerk.house.gov/GiftTravelFilings/ViewSearch")
tok = (re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', b.decode("utf-8", "replace")) or [None, ""])[1]
data = urllib.parse.urlencode({"MemberLastName": "Pelosi", "StaffLastName": "", "TravelDateFrom": "", "TravelDateTo": "", "Sponsor": "", "Destination": "", "__RequestVerificationToken": tok}).encode()
s, ct, b = get("https://disclosures-clerk.house.gov/GiftTravelFilings/ViewSearchResult", data=data, headers={"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": "https://disclosures-clerk.house.gov/GiftTravelFilings"})
h = b.decode("utf-8", "replace")
res["house_gt_result"] = {"status": s, "len": len(h), "rows": re.findall(r"<tr[\s\S]*?</tr>", h)[:4], "links": links(b, r"pdf|travel")[:10]}
data = urllib.parse.urlencode({"MemberLastName": "", "StaffLastName": "", "TravelDateFrom": "01/01/2026", "TravelDateTo": "03/31/2026", "Sponsor": "", "Destination": "", "__RequestVerificationToken": tok}).encode()
s, ct, b = get("https://disclosures-clerk.house.gov/GiftTravelFilings/ViewSearchResult", data=data, headers={"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": "https://disclosures-clerk.house.gov/GiftTravelFilings"})
res["house_gt_dates"] = {"status": s, "rows": len(re.findall(r"<tr", b.decode("utf-8", "replace")))}
# FY27 CPF awards
try:
    import openpyxl
    for name in ("consolidated-table-of-fy27-cpf-awards.xlsx", "consolidated-table-of-fy27-cpf-requests.xlsx"):
        s, ct, b = get("https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/" + name)
        wb = openpyxl.load_workbook(io.BytesIO(b), read_only=True)
        out = {"sheets": wb.sheetnames}
        for ws in wb.worksheets[:2]:
            out[ws.title] = [[str(c)[:50] if c is not None else None for c in row] for i, row in enumerate(ws.iter_rows(values_only=True)) if i < 5]
            out[ws.title + "_rows"] = ws.max_row
        res[name] = out
except Exception as e:
    res["xlsx_err"] = repr(e)
for url in ("https://appropriations.house.gov/committee-activity/enacted-legislation/fiscal-year-2026-enacted-legislation",
            "https://appropriations.house.gov/committee-activity/enacted-legislation/fiscal-year-2025-enacted-legislation",
            "https://appropriations.house.gov/committee-activity/fy25-community-project-funding",
            "https://www.appropriations.senate.gov/fy-2026-congressionally-directed-spending"):
    s, ct, b = get(url)
    res[url] = links(b, r"\.xlsx|\.xls|\.csv|cpf|cds|directed|explanatory|joint")
# FARA: a recent supplemental statement's text
s, ct, b = get("https://efile.fara.gov/api/v1/RegDocs/json/7766")
res["fara_docs_7766"] = b.decode("utf-8", "replace")[:1500]
s, ct, b = get("https://efile.fara.gov/bulk/zip/FARA_All_RegistrantDocs.csv.zip")
try:
    zf = zipfile.ZipFile(io.BytesIO(b)); n = zf.namelist()[0]
    t = zf.read(n).decode("latin-1")
    lines = t.splitlines(); res["fara_docs_csv"] = [n, len(lines), lines[:3]]
    sup = [l for l in lines if "Supplemental Statement" in l and "/2026" in l][:5]
    res["fara_sup_recent"] = sup
    m = re.search(r"https://efile\.fara\.gov/docs/[^\",]+\.pdf", sup[0]) if sup else None
    if m:
        s, ct, pdf = get(m.group(0)); (OUT / "fara.pdf").write_bytes(pdf); res["fara_pdf"] = [m.group(0), s, len(pdf)]
except Exception as e:
    res["fara_err"] = repr(e)
(OUT / "govmoney4.json").write_text(json.dumps(res, indent=1, default=str))
