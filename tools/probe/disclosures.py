"""Temporary probe, round 11: render a Form 700 page and measure the ink inside each drawn box."""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib, subprocess
import pdfplumber
from PIL import Image
UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
OUT = pathlib.Path("tools/probe/out"); OUT.mkdir(parents=True, exist_ok=True)
op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
log = []
def say(*a): s = " ".join(str(x) for x in a); print(s); log.append(s)
def raw(u, data=None, hdr=None):
    h = {"User-Agent": UA}; h.update(hdr or {})
    with op.open(urllib.request.Request(u, data=data, headers=h), timeout=90) as r:
        return r.read()
raw("https://form700search.fppc.ca.gov/")
J = {"Content-Type": "application/json", "Accept": "application/json"}
def search(last, first=None):
    f = [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": last}]
    if first: f.append({"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": first})
    return json.loads(json.loads(raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps({"searchFieldQueryInfos": f}).encode(), hdr=J)))["documents"]
def pdf_of(x):
    p = x["filingPositions"][0]
    q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": x["filer"]["lastName"], "fileNameInfo.FirstName": x["filer"]["firstName"], "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"], "fileNameInfo.IsAmendment": str(x["filingInfo"]["isAmendment"]).lower(), "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
    return raw(json.loads(raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q))["PDFDownloadUrl"])
for last, first, pos in [("Ma", "Fiona", "Treasurer"), ("Tofanelli", "Gary", "Supervisor")]:
    docs = search(last, first)
    x = next(x for x in docs if x["filingPositions"][0]["filingType"] == "Annual" and x["filingPositions"][0]["position"] == pos)
    path = pathlib.Path(f"/tmp/{last}.pdf"); path.write_bytes(pdf_of(x))
    say("==", last, x["filingPositions"][0]["filingYear"], subprocess.run(["pdfinfo", str(path)], capture_output=True, text=True).stdout.split("Pages:")[1].split("\n")[0].strip(), "pages")
    (OUT / f"fppc-{last}.txt").write_text(subprocess.run(["pdftotext", "-layout", str(path), "-"], capture_output=True, text=True).stdout)
    with pdfplumber.open(str(path)) as doc:
        for i, pg in enumerate(doc.pages):
            if "SCHEDULE A-1" not in (pg.extract_text() or ""):
                continue
            scale = 4
            subprocess.run(["pdftoppm", "-r", str(72 * scale), "-f", str(i + 1), "-l", str(i + 1), "-gray", "-png", str(path), "/tmp/pg"], check=True)
            img = Image.open(next(pathlib.Path("/tmp").glob("pg*.png"))).convert("L")
            for c in sorted(pg.curves, key=lambda c: (round(c["top"]), c["x0"])):
                w, h = c["x1"] - c["x0"], c["bottom"] - c["top"]
                if not (5 < w < 14 and 5 < h < 14):
                    continue
                pad = 1.6
                box = (int((c["x0"] + pad) * scale), int((c["top"] + pad) * scale), int((c["x1"] - pad) * scale), int((c["bottom"] - pad) * scale))
                px = list(img.crop(box).getdata())
                ink = sum(1 for v in px if v < 128) / max(1, len(px))
                # the nearest word to the right: the box's label
                words = [wd for wd in pg.extract_words() if abs(wd["top"] - c["top"]) < 6 and 0 < wd["x0"] - c["x1"] < 30]
                label = words[0]["text"] if words else "?"
                say(f"  p{i+1} box x={c['x0']:.0f} y={c['top']:.0f} {'diamond' if len(c.get('pts') or []) == 5 else 'square'} ink={ink:.2f} label={label}")
            for f in pathlib.Path("/tmp").glob("pg*.png"): f.unlink()
            break
(OUT / "log.txt").write_text("\n".join(log))
