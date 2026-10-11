"""Temporary probe, round 9: are a Form 700 PDF's checked boxes readable (glyphs, form fields or drawn marks)?"""
import json, urllib.request, urllib.parse, http.cookiejar, pathlib, subprocess, sys, collections
import pdfplumber
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
body = {"searchFieldQueryInfos": [{"queryField": "FilerLastName", "queryType": "Exact Match", "filterValue": "Ma"}, {"queryField": "FilerFirstName", "queryType": "Start With", "filterValue": "Fiona"}]}
d = json.loads(json.loads(raw("https://form700search.fppc.ca.gov/Home/SearchDocuments", data=json.dumps(body).encode(), hdr=J)))
x = next(x for x in d["documents"] if x["filingPositions"][0]["filingType"] == "Annual" and x["filingPositions"][0]["filingYear"] == 2025 and x["filingPositions"][0]["position"] == "Treasurer")
p = x["filingPositions"][0]
q = urllib.parse.urlencode({"indexID": x["indexID"], "fileNameInfo.LastName": "Ma", "fileNameInfo.FirstName": "Fiona", "fileNameInfo.FilingYear": p["filingYear"], "fileNameInfo.Agency": p["agency"], "fileNameInfo.Position": p["position"], "fileNameInfo.FilingType": p["filingType"], "fileNameInfo.IsAmendment": "false", "fileNameInfo.FilingDate": x["filingInfo"]["filedDate"]})
pdf = raw(json.loads(raw("https://form700search.fppc.ca.gov/Home/GetRedactedFormPdf?" + q))["PDFDownloadUrl"])
pathlib.Path("/tmp/ma.pdf").write_bytes(pdf)
with pdfplumber.open("/tmp/ma.pdf") as doc:
    say("pages", len(doc.pages), "annots on page 1-6:", [len(pg.annots or []) for pg in doc.pages[:6]])
    for i, pg in enumerate(doc.pages):
        txt = pg.extract_text() or ""
        if "SCHEDULE A-1" not in txt:
            continue
        fonts = collections.Counter(c["fontname"] for c in pg.chars)
        say(f"page {i+1} fonts", fonts.most_common(12))
        odd = [c for c in pg.chars if not c["text"].isprintable() or "Zapf" in c["fontname"] or "Symbol" in c["fontname"] or "Wingding" in c["fontname"] or ord(c["text"][0]) > 0x2000]
        say("  special chars", [(c["text"], hex(ord(c["text"][0])), c["fontname"], round(c["x0"]), round(c["top"])) for c in odd[:40]])
        say("  rects", len(pg.rects), "curves", len(pg.curves), "lines", len(pg.lines), "images", len(pg.images))
        filled = [r for r in pg.rects if r.get("fill") and r["width"] < 14 and r["height"] < 14]
        say("  small filled rects", [(round(r["x0"]), round(r["top"]), round(r["width"]), round(r["height"]), r.get("non_stroking_color")) for r in filled[:40]])
        small_curves = [c for c in pg.curves if (c["x1"] - c["x0"]) < 14 and (c["bottom"] - c["top"]) < 14]
        say("  small curves", [(round(c["x0"]), round(c["top"]), c.get("fill"), c.get("non_stroking_color")) for c in small_curves[:40]])
        words = pg.extract_words()
        say("  words with $ ", [(w["text"], round(w["x0"]), round(w["top"])) for w in words if "$" in w["text"] or w["text"] in ("Over", "ACQUIRED", "DISPOSED", "Stock", "Other", "Partnership")][:60])
        (OUT / f"ma-page{i+1}-chars.json").write_text(json.dumps([{k: c[k] for k in ("text", "fontname", "x0", "top", "size")} for c in pg.chars]))
        break
(OUT / "log.txt").write_text("\n".join(log))
