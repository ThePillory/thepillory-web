"""Temporary probe: lda.gov contributions API and Cal-Access lobbying tables."""
import csv, io, json, re, sys, urllib.request, zipfile, collections
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
UA = "ThePillory/1.0 (+https://thepillory.co; public records)"
def get(url, accept="application/json"):
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": accept})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return r.status, dict(r.headers), r.read()
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read()
    except Exception as e:
        return 0, {}, repr(e).encode()
log = {}
for name, url in [
    ("contrib_2025", "https://lda.gov/api/v1/contributions/?filing_year=2025&page_size=3"),
    ("contrib_honoree", "https://lda.gov/api/v1/contributions/?contribution_honoree=Schiff&filing_year=2025&page_size=3"),
    ("contrib_payee", "https://lda.gov/api/v1/contributions/?contribution_payee=Schiff&filing_year=2025&page_size=3"),
    ("root", "https://lda.gov/api/v1/"),
    ("schema", "https://lda.gov/api/v1/schema/"),
    ("redoc", "https://lda.gov/api/redoc/v1/"),
    ("openapi", "https://lda.gov/api/redoc/v1/?format=openapi"),
    ("swagger", "https://lda.gov/api/swagger.json"),
    ("api_home", "https://lda.gov/api/"),
    ("register", "https://lda.gov/api/register/"),
    ("auth", "https://lda.gov/api/auth/login/"),
    ("constants", "https://lda.gov/api/v1/constants/contribution/itemtypes/"),
]:
    s, h, b = get(url)
    log[name] = {"status": s, "headers": {k: v for k, v in h.items() if k.lower().startswith(("x-", "retry", "ratelimit", "content-type", "allow"))}, "len": len(b)}
    (OUT / f"lda_{name}.txt").write_bytes(b[:400000])
(OUT / "lda_log.json").write_text(json.dumps(log, indent=1))
print(json.dumps(log, indent=1))

zp = Path("/tmp/cal.zip")
urllib.request.urlretrieve("https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip", zp)
zf = zipfile.ZipFile(zp)
names = zf.namelist()
(OUT / "cal_names.txt").write_text("\n".join(f"{n} {zf.getinfo(n).file_size}" for n in names))
def rows(table):
    member = next(n for n in names if n.upper().endswith(f"/{table}.TSV"))
    with zf.open(member) as f:
        rd = csv.reader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(rd)
        for r in rd:
            yield dict(zip(header, r))
rep = {}
for t in ["CVR_LOBBY_DISCLOSURE_CD", "LPAY_CD", "LEXP_CD", "LOTH_CD", "LCCM_CD", "LEMP_CD", "LATT_CD", "LOBBY_AMENDMENTS_CD", "CVR_REGISTRATION_CD", "FILER_FILINGS_CD", "SMRY_CD", "TEXT_MEMO_CD", "LOBBYIST_EMPLOYER1_CD", "LOBBYIST_EMPLOYER2_CD", "LOBBYIST_EMPLOYER3_CD", "LOBBYING_CHG_LOG_CD", "LOBBYIST_FIRM1_CD", "LOBBYIST_EMP_LOBBYIST1_CD", "LOBBYIST_CONTRIBUTIONS1_CD", "FILERNAME_CD"]:
    try:
        it = rows(t)
        samples = []
        n = 0
        forms = collections.Counter()
        recent = []
        for r in it:
            n += 1
            ft = r.get("FORM_TYPE") or r.get("FORM_ID") or r.get("REC_TYPE") or ""
            forms[ft] += 1
            if len(samples) < 4: samples.append(r)
            d = r.get("RPT_DATE") or r.get("FILING_DATE") or r.get("FROM_DATE") or ""
            if len(recent) < 6 and re.search(r"202[56]", d) and ft not in ("",):
                recent.append(r)
        rep[t] = {"rows": n, "forms": forms.most_common(25), "samples": samples, "recent": recent}
    except StopIteration:
        rep[t] = "missing"
    except Exception as e:
        rep[t] = repr(e)
(OUT / "cal_lobby.json").write_text(json.dumps(rep, indent=1)[:3000000])
# Lobbying activity descriptions with bill numbers, recent F635
acts = []
for r in rows("CVR_LOBBY_DISCLOSURE_CD"):
    a = r.get("LBY_ACTVTY") or ""
    if r.get("FORM_TYPE") in ("F635", "F625") and re.search(r"\b(AB|SB)\s?\d", a) and "2025" in (r.get("RPT_DATE") or ""):
        acts.append({k: r[k] for k in r})
        if len(acts) >= 40: break
(OUT / "cal_acts.json").write_text(json.dumps(acts, indent=1))
print("done")
