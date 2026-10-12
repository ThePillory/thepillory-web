"""Temporary probe round 5: Schedule C in real 990s (One Nation, the U.S. Chamber, Majority Forward)."""
import io, json, re, sys, zipfile
from pathlib import Path
sys.path.insert(0, "tools")
import irs990
OUT = Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
res = {}
for ein, oid, batch in (("271937961", "202513189349312806", "2025_TEOS_XML_11D"), ("530045720", "202543179349303374", "2025_TEOS_XML_11B"), ("833690373", "202541339349303434", "2025_TEOS_XML_05A")):
    url = irs990.batch_url(2025, batch)
    size = irs990.remote_size(url)
    f = irs990.RangeFile(url, size)
    z = zipfile.ZipFile(io.BufferedReader(f, buffer_size=1 << 20))
    name = next((n for n in z.namelist() if n.startswith(oid)), None)
    if not name:
        res[ein] = {"missing": oid, "sample": z.namelist()[:3], "requests": f.requests}
        continue
    x = z.read(name).decode("utf-8", "replace")
    sc = re.search(r"<IRS990ScheduleC[\s\S]*?</IRS990ScheduleC>", x)
    res[ein] = {"size": size, "requests": f.requests, "read": irs990.read_return(x), "scheduleC": re.sub(r"\s+", " ", sc.group(0))[:4000] if sc else None,
                "partIV": re.findall(r"<(PoliticalCampaignActyInd|LobbyingActivitiesInd|ScheduleBRequiredInd)>([^<]*)", x)}
(OUT / "darkmoney5.json").write_text(json.dumps(res, indent=1))
