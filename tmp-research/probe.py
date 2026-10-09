# TEMPORARY research probe (removed before merge): measures Open States bulk files
# and reads Census state legislative district names. Writes tmp-research/out/.
import csv, io, json, os, re, sys, time, urllib.request, zipfile
OUT = "tmp-research/out"; os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records)"}
def get(url, binary=True):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        b = r.read()
        return b if binary else b.decode("utf-8", "replace")
log = []
def note(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log.append(s)

# 1. The bulk data index and its links.
for url in ["https://open.pluralpolicy.com/data/", "https://open.pluralpolicy.com/data/session-csv/", "https://open.pluralpolicy.com/data/session-json/"]:
    try:
        h = get(url, False)
        open(f"{OUT}/{re.sub(r'[^a-z0-9]+','_',url)}.html", "w").write(h)
        links = sorted(set(re.findall(r'href="([^"]+)"', h)))
        note("INDEX", url, len(h), "links", len(links))
        for l in links[:400]: note("  link", l)
    except Exception as e:
        note("INDEX FAIL", url, repr(e))

# 2. Download a few session CSV archives and count rows.
idx = "\n".join(log)
zips = [l.split()[-1] for l in log if l.strip().startswith("link") and l.strip().endswith(".zip")]
want = [z for z in zips if re.search(r"/(tx|ny|fl|pa|ca|il|oh|nh|ma|ga)/", z.lower()) or re.search(r"(^|/)(TX|NY|FL|PA|CA|IL|OH|NH|MA|GA)_", z)]
note("CANDIDATE ZIPS", len(zips), "matching", len(want))
for z in want[:60]: note("  zip", z)
measured = {}
for z in want:
    m = re.search(r"(?:/|^)([A-Za-z]{2})[_/]", z)
    st = (m.group(1) if m else "??").lower()
    if sum(1 for k in measured if k.startswith(st)) >= 2:
        continue
    url = z if z.startswith("http") else urllib.parse.urljoin("https://open.pluralpolicy.com/data/session-csv/", z)
    try:
        b = get(url)
    except Exception as e:
        note("ZIP FAIL", url, repr(e)); continue
    zf = zipfile.ZipFile(io.BytesIO(b))
    info = {"url": url, "zip_bytes": len(b), "files": {}}
    for n in zf.namelist():
        data = zf.read(n)
        rows = data.count(b"\n")
        info["files"][n] = {"bytes": len(data), "lines": rows}
        if n.endswith(".csv") and ("vote" in n.lower()):
            r = csv.reader(io.StringIO(data[:20000].decode("utf-8", "replace")))
            info["files"][n]["header"] = next(r, [])
            info["files"][n]["sample"] = [next(r, []) for _ in range(2)]
        if n.endswith(".csv") and re.search(r"bills\.csv$", n):
            r = csv.reader(io.StringIO(data[:20000].decode("utf-8", "replace")))
            info["files"][n]["header"] = next(r, [])
    measured[f"{st}:{url.rsplit('/',1)[-1]}"] = info
    note("MEASURED", st, url, len(b))
    time.sleep(2)
json.dump(measured, open(f"{OUT}/measured.json", "w"), indent=1)

# 3. Legislators CSV per state (no API key).
for url in ["https://data.openstates.org/people/current/tx.csv", "https://data.openstates.org/people/current/ma.csv"]:
    try:
        t = get(url, False); note("PEOPLE", url, len(t), t.splitlines()[0][:400], "| rows", len(t.splitlines()) - 1)
    except Exception as e:
        note("PEOPLE FAIL", url, repr(e))

# 4. Census state legislative district names (cartographic boundary DBFs) for states with named districts.
import struct
def dbf_rows(b):
    n = struct.unpack("<I", b[4:8])[0]; hl = struct.unpack("<H", b[8:10])[0]; rl = struct.unpack("<H", b[10:12])[0]
    fields = []; i = 32
    while b[i] != 0x0D:
        name = b[i:i+11].split(b"\0")[0].decode(); ln = b[i+16]; fields.append((name, ln)); i += 32
    out = []
    for k in range(n):
        rec = b[hl + k*rl + 1: hl + (k+1)*rl]; pos = 0; row = {}
        for name, ln in fields:
            row[name] = rec[pos:pos+ln].decode("latin-1").strip(); pos += ln
        out.append(row)
    return out
names = {}
for layer in ("sldl", "sldu"):
    url = f"https://www2.census.gov/geo/tiger/GENZ2024/shp/cb_2024_us_{layer}_500k.zip"
    try:
        zf = zipfile.ZipFile(io.BytesIO(get(url)))
        dbf = [n for n in zf.namelist() if n.endswith(".dbf")][0]
        rows = dbf_rows(zf.read(dbf))
        note("CENSUS", layer, len(rows), "fields", list(rows[0].keys()))
        names[layer] = [{k: r.get(k) for k in r if k in ("STATEFP", "SLDLST", "SLDUST", "NAME", "NAMELSAD", "LSAD", "GEOID")} for r in rows]
    except Exception as e:
        note("CENSUS FAIL", layer, repr(e))
json.dump(names, open(f"{OUT}/census-sld-names.json", "w"))
open(f"{OUT}/log.txt", "w").write("\n".join(log))
