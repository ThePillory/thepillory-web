# TEMPORARY research probe 2 (removed before merge): can the bulk session files be
# listed and downloaded without signing in? If so, measure a few.
import csv, io, json, os, re, time, urllib.request, zipfile
OUT = "tmp-research/out"; os.makedirs(OUT, exist_ok=True)
UA = {"User-Agent": "ThePillory/1.0 (+https://thepillory.co; civic records)"}
log = []
def note(*a):
    s = " ".join(str(x) for x in a); print(s, flush=True); log.append(s)
def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=300) as r:
        return r.read()
keys = []
for url in ["https://data.openstates.org/?list-type=2&prefix=csv/latest/&max-keys=1000",
            "https://data.openstates.org/?prefix=csv/latest/",
            "https://s3.amazonaws.com/data.openstates.org/?list-type=2&prefix=csv/latest/",
            "https://data.openstates.org/csv/latest/",
            "https://data.openstates.org/?list-type=2&prefix=json/latest/&max-keys=50"]:
    try:
        b = get(url).decode("utf-8", "replace")
        found = re.findall(r"<Key>([^<]+)</Key>", b)
        note("LIST", url, len(b), "keys", len(found), b[:300].replace("\n", " "))
        if found and not keys and "csv" in url: keys = found
        token = re.search(r"<NextContinuationToken>([^<]+)<", b)
        while token and "list-type=2" in url and "csv" in url:
            b = get(url + "&continuation-token=" + urllib.parse.quote(token.group(1))).decode()
            more = re.findall(r"<Key>([^<]+)</Key>", b); keys += more; token = re.search(r"<NextContinuationToken>([^<]+)<", b)
    except Exception as e:
        note("LIST FAIL", url, repr(e))
open(f"{OUT}/csv-keys.txt", "w").write("\n".join(keys))
note("CSV KEYS", len(keys))
for k in keys[:5]: note("  ", k)
# Measure the newest regular session for a few big states.
measured = {}
for st in ["TX", "NY", "FL", "CA", "NH", "PA"]:
    ks = sorted(k for k in keys if k.split("/")[-1].startswith(st + "_") and k.endswith(".zip"))
    note("STATE", st, len(ks), ks[-6:])
    pick = [k for k in ks if re.search(r"_(2025|2025-2026|20252026|89|2025_2026|2025\d{4}|119|2025A?)_", k)] or ks[-1:]
    for k in pick[:2]:
        url = "https://data.openstates.org/" + k
        try:
            b = get(url)
        except Exception as e:
            note("ZIP FAIL", url, repr(e)); continue
        zf = zipfile.ZipFile(io.BytesIO(b)); info = {"zip_bytes": len(b), "files": {}}
        for n in zf.namelist():
            d = zf.read(n); info["files"][n] = {"bytes": len(d), "lines": d.count(b"\n")}
            if n.endswith(".csv"):
                r = csv.reader(io.StringIO(d[:30000].decode("utf-8", "replace")))
                info["files"][n]["header"] = next(r, []); info["files"][n]["sample"] = [next(r, []) for _ in range(2)]
        measured[k] = info; note("MEASURED", k, len(b)); time.sleep(2)
json.dump(measured, open(f"{OUT}/measured.json", "w"), indent=1)
open(f"{OUT}/log2.txt", "w").write("\n".join(log))
