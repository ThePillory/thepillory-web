"""Temporary probe round 9: sample files to build parsers against (earmark tables as pdftotext -layout text, CPF spreadsheets, House travel results, FARA bulk CSVs, FARA statements' text)."""
import io, json, re, subprocess, zipfile, http.cookiejar, urllib.request, urllib.error, urllib.parse
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
BROWSER = {"User-Agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"}
jar = http.cookiejar.CookieJar(); op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def get(url, data=None, headers=None):
    h = dict(BROWSER); h.update(headers or {})
    try:
        with op.open(urllib.request.Request(url, data=data, headers=h), timeout=240) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        return e.code, e.read()[:2000]
def links(b, pat):
    return sorted(set(re.findall(r'href="([^"]*(?:%s)[^"]*)"' % pat, b.decode("utf-8", "replace"), re.I)))
log = {}
# Senate enacted tables for FY24-FY26: the pages' download links.
for fy in (2024, 2025, 2026):
    s, b = get(f"https://www.appropriations.senate.gov/fy-{fy}-congressionally-directed-spending")
    dl = [l for l in links(b, r"/download/") if "public-law" in l or "public_law" in l or "enacted" in l]
    log[f"senate_{fy}"] = dl
    for l in dl[:12]:
        url = urllib.parse.urljoin("https://www.appropriations.senate.gov/", l) + "&download=1"
        s, pdf = get(url)
        if pdf[:4] != b"%PDF":
            log[f"x_{l}"] = s; continue
        p = OUT / "tmp.pdf"; p.write_bytes(pdf)
        name = re.sub(r"[^a-z0-9]+", "-", l.split("/download/")[-1].lower()).strip("-")
        (OUT / f"pl-{fy}-{name}.txt").write_text(subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout)
        p.unlink()
# House CPF spreadsheets
for name in ("fy25-house-cpfs-as-requested-06.28.2024.xlsx", "fy26-house-cpf-consolidated.xlsx", "consolidated-table-of-fy27-cpf-requests.xlsx", "consolidated-table-of-fy27-cpf-awards.xlsx"):
    s, b = get("https://appropriations.house.gov/sites/evo-subsites/republicans-appropriations.house.gov/files/evo-media-document/" + name)
    log[name] = [s, len(b)]
    if s == 200: (OUT / name).write_bytes(b)
s, b = get("https://appropriations.house.gov/fiscal-year-2024-community-project-funding")
log["house_fy24"] = links(b, r"\.xlsx|\.xls")
# House travel: one quarter of results
s, b = get("https://disclosures-clerk.house.gov/GiftTravelFilings/ViewSearch")
tok = (re.search(r'name="__RequestVerificationToken"[^>]*value="([^"]+)"', b.decode("utf-8", "replace")) or [None, ""])[1]
data = urllib.parse.urlencode({"MemberLastName": "", "StaffLastName": "", "TravelDateFrom": "01/01/2026", "TravelDateTo": "03/31/2026", "Sponsor": "", "Destination": "", "__RequestVerificationToken": tok}).encode()
s, b = get("https://disclosures-clerk.house.gov/GiftTravelFilings/ViewSearchResult", data=data, headers={"Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest", "Referer": "https://disclosures-clerk.house.gov/GiftTravelFilings"})
(OUT / "house_travel_2026q1.html").write_bytes(b)
# FARA bulk CSVs (registrants, principals) and a few statements' text
for z in ("FARA_All_Registrants.csv.zip", "FARA_All_ForeignPrincipals.csv.zip"):
    s, b = get(f"https://efile.fara.gov/bulk/zip/{z}")
    zf = zipfile.ZipFile(io.BytesIO(b)); n = zf.namelist()[0]
    t = zf.read(n).decode("latin-1"); (OUT / n).write_text("\n".join(t.splitlines()[:4000]))
    log[z] = len(t.splitlines())
for url in ("https://efile.fara.gov/docs/6518-Supplemental-Statement-20260930-19.pdf", "https://efile.fara.gov/docs/2244-Supplemental-Statement-20260930-47.pdf", "https://efile.fara.gov/docs/6999-Supplemental-Statement-20260930-10.pdf"):
    s, pdf = get(url); p = OUT / "tmp.pdf"; p.write_bytes(pdf)
    (OUT / ("fara-" + url.rsplit("/", 1)[1].replace(".pdf", ".txt"))).write_text(subprocess.run(["pdftotext", "-layout", str(p), "-"], capture_output=True, text=True).stdout)
    p.unlink()
(OUT / "log.json").write_text(json.dumps(log, indent=1))
