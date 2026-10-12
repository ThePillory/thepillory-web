"""Temporary probe, round 2: Cal-Access Form 635/645 summary lines, contributions, activity text."""
import csv, io, json, re, urllib.request, zipfile, collections, random
from pathlib import Path
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
zp = Path("/tmp/cal.zip")
urllib.request.urlretrieve("https://campaignfinance.cdn.sos.ca.gov/dbwebexport.zip", zp)
zf = zipfile.ZipFile(zp)
names = zf.namelist()
def rows(table):
    member = next(n for n in names if n.upper().endswith(f"/{table}.TSV"))
    with zf.open(member) as f:
        rd = csv.reader(io.TextIOWrapper(f, encoding="utf-8", errors="replace", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(rd)
        for r in rd:
            yield dict(zip(header, r))
def ymd(s):
    m = re.match(r"(\d+)/(\d+)/(\d{4})", s or "")
    return f"{m[3]}-{int(m[1]):02d}-{int(m[2]):02d}" if m else ""
covers = {}
for r in rows("CVR_LOBBY_DISCLOSURE_CD"):
    if r["FORM_TYPE"] in ("F635", "F645", "F625", "F615") and ymd(r["FROM_DATE"]) >= "2025-01-01":
        covers[(r["FILING_ID"], r["AMEND_ID"])] = r
print(len(covers), collections.Counter(r["FORM_TYPE"] for r in covers.values()))
pick = {}
for ft in ("F635", "F645", "F625", "F615"):
    ids = [k for k, r in covers.items() if r["FORM_TYPE"] == ft]
    random.seed(1)
    pick[ft] = random.sample(ids, min(4, len(ids)))
want = {k for v in pick.values() for k in v}
smry = collections.defaultdict(list)
for r in rows("SMRY_CD"):
    if (r["FILING_ID"], r["AMEND_ID"]) in want:
        smry[f'{r["FILING_ID"]}-{r["AMEND_ID"]}'].append({k: v for k, v in r.items() if v})
# Line items across all 2025+ F635: which lines exist
lines = collections.Counter()
for r in rows("SMRY_CD"):
    if r["FORM_TYPE"].startswith("F635") and (r["FILING_ID"], r["AMEND_ID"]) in covers:
        lines[(r["FORM_TYPE"], r["LINE_ITEM"])] += 1
lccm = collections.Counter(); lccm_s = []
for r in rows("LCCM_CD"):
    if (r["FILING_ID"], r["AMEND_ID"]) in covers:
        lccm[r["FORM_TYPE"]] += 1
        if len(lccm_s) < 12 and random.random() < 0.01: lccm_s.append({k: v for k, v in r.items() if v})
acts = [covers[k]["LBY_ACTVTY"] for k in covers if covers[k]["FORM_TYPE"] in ("F635", "F645")]
random.seed(2)
out = {
    "covers_sample": {ft: [{k: v for k, v in covers[k].items() if v} for k in ks] for ft, ks in pick.items()},
    "smry": smry,
    "f635_lines": sorted([[a, b, n] for (a, b), n in lines.items()]),
    "lccm_forms": lccm.most_common(), "lccm_samples": lccm_s,
    "acts": random.sample(acts, 300),
    "acts_none": sum(1 for a in acts if a.strip().upper() in ("", "NONE", "N/A")),
    "acts_n": len(acts),
    "amends": collections.Counter(k[1] for k in covers).most_common(6),
}
(OUT / "cal2.json").write_text(json.dumps(out, indent=1))
print("done")
