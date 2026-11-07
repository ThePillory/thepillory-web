#!/usr/bin/env python3
"""Who pays taxes: data/taxes/taxpayers.json for /taxes/taxpayers/ (docs/taxes.md),
built by the "Refresh company taxes" workflow's taxpayers job, from official tables only:

  irs      IRS Statistics of Income, Individual Income Tax Rates and Tax Shares,
           Tables 4.1 (top percentiles) and 4.2 (bottom percentiles): number of
           returns, AGI floor, share of adjusted gross income and share of total
           income tax, by year, as the IRS computes them (nothing recomputed here).
           The newest files are found on the IRS's page ("<yy>in41ts", "<yy>in42ts").
  top400   The IRS's "400 Individual Income Tax Returns Reporting the Largest Adjusted
           Gross Incomes Each Year" (its last edition, 1992-2014), Table 1's first
           columns: the AGI cutoff, total and average AGI, and the top 400's share of
           all AGI. Read from the PDF's text; a year that doesn't read in full is left out.
  ftb      California Franchise Tax Board, Annual Report table B-4A (California
           residents, all filing statuses), from data.ca.gov: returns, California
           AGI and total tax liability by AGI class, the latest year; the FTB's classes
           are added up into a few bands (said so on the page).
  cbo      The Congressional Budget Office's "Distribution of Household Income": its
           site refuses requests from GitHub's servers, so it's linked, not read.

Standard library plus openpyxl/xlrd (spreadsheets) and pdftotext (poppler-utils).
Pure parts tested in tools/test_build_taxpayers.py.
"""
import csv
import datetime
import io
import json
import re
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "taxes" / "taxpayers.json"
UA = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36"
IRS_PAGE = "https://www.irs.gov/statistics/soi-tax-stats-individual-statistical-tables-by-tax-rate-and-income-percentile"
TOP400 = "https://www.irs.gov/pub/irs-soi/14intop400.pdf"
FTB_PACKAGE = "https://data.ca.gov/api/3/action/package_show?id=b-4a-adjusted-gross-income-class-comparison-all-filing-statuses"
FTB_PAGE = "https://data.ca.gov/dataset/b-4a-adjusted-gross-income-class-comparison-all-filing-statuses"
CBO = "https://www.cbo.gov/publication/62300"

# Table 4.1's column order (descending cumulative percentiles) and 4.2's (ascending).
TOP_GROUPS = ["top-0.001", "top-0.01", "top-0.1", "top-1", "top-2", "top-3", "top-4", "top-5", "top-10", "top-20", "top-25", "top-30", "top-40", "top-50"]
BOTTOM_GROUPS = ["bottom-50", "bottom-75", "bottom-90", "bottom-95", "bottom-99"]
SECTIONS = [  # the label each block starts with -> our key
    ("number of returns", "returns"),
    ("adjusted gross income floor on percentiles (current", "floor"),
    ("adjusted gross income share", "agi_share"),
    ("total income tax share", "tax_share"),
    ("adjusted gross income (millions", "agi"),
    ("total income tax (millions", "tax"),
]


def say(*a):
    print(*a, flush=True)


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180) as r:
        return r.read()


# ---------------------------------------------------------------------------
# Pure parts


def newest_tables(page_html):
    """{"41": url, "42": url}: the newest edition of Tables 4.1 and 4.2 linked on the IRS's page."""
    out = {}
    for t in ("41", "42"):
        best = None
        for m in re.finditer(rf'href="(/pub/irs-soi/(\d\d)in{t}ts\.(xlsx?|XLSX?))"', page_html):
            key = (int(m.group(2)), m.group(3).lower() == "xlsx")
            if best is None or key > best[0]:
                best = (key, "https://www.irs.gov" + m.group(1))
        if best:
            out[t] = best[1]
    return out


def irs_blocks(rows, groups):
    """A Table 4.1 / 4.2 sheet's rows -> {key: {year: [value per group]}} for SECTIONS, by each block's label."""
    out, key = {}, None
    for r in rows:
        if not r:
            continue
        first = r[0]
        if isinstance(first, str) and first.strip() and not re.fullmatch(r"\s*\d{4}(\.0)?\s*", first):
            label = first.strip().lower()
            key = next((k for lead, k in SECTIONS if label.startswith(lead)), None)
            continue
        m = re.fullmatch(r"(\d{4})(\.0)?", str(first).strip())
        if key and m:
            vals = []
            for v in r[2:2 + len(groups)]:
                try:
                    vals.append(float(v))
                except (TypeError, ValueError):
                    vals.append(None)
            if len(vals) == len(groups):
                out.setdefault(key, {})[int(m.group(1))] = vals
    return out


def irs_groups(blocks, groups, labels):
    """[{id, label, returns, floor, agi_share, tax_share: {year: value}}] for each group."""
    out = []
    for i, g in enumerate(groups):
        item = {"id": g, "label": labels[g]}
        for k in ("returns", "floor", "agi_share", "tax_share"):
            item[k] = {str(y): vals[i] for y, vals in sorted(blocks.get(k, {}).items()) if vals[i] is not None}
        out.append(item)
    return out


def group_labels():
    lab = {g: f"Top {g.split('-')[1]} percent" for g in TOP_GROUPS}
    lab.update({g: f"Bottom {g.split('-')[1]} percent" for g in BOTTOM_GROUPS})
    return lab


NUM = r"[\d,]+(?:\.\d+)?"


def top400_rows(text):
    """Table 1's first two blocks from the PDF text: per year, the number of returns in the population and the
    AGI cutoff (block 1, columns 1-3), and total AGI for the top 400, the average, and the share of all AGI
    (block 2, columns 4-8; money in thousands of dollars). A year missing from either block is left out."""
    a = text.find("Table 1")
    block1, block2 = {}, {}
    for line in text[a:].splitlines():
        m = re.match(rf"\s*(\d{{4}})(?:\s*\[\d+\])?\s+({NUM})\s+({NUM})\s+({NUM})\s*$", line)
        if m and int(m.group(1)) not in block1:
            block1[int(m.group(1))] = [float(x.replace(",", "")) for x in m.group(2, 3, 4)]
            continue
        m = re.match(rf"\s*(\d{{4}})(?:\s*\[\d+\])?\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s+({NUM})\s*$", line)
        if m and int(m.group(1)) not in block2 and int(m.group(1)) in block1:
            block2[int(m.group(1))] = [float(x.replace(",", "")) for x in m.group(2, 3, 4, 5, 6)]
        if "Salaries and wages" in line:
            break
    out = []
    for y in sorted(block1):
        if y in block2:
            pop, cutoff, _ = block1[y]
            total, avg, _, _, share = block2[y]
            out.append({"year": y, "returns_all": int(pop), "cutoff": cutoff * 1000, "agi_total": total * 1000, "agi_average": avg * 1000, "agi_share": share})
    return out


BANDS = [(None, 50_000, "Under $50,000"), (50_000, 100_000, "$50,000 to $99,999"), (100_000, 200_000, "$100,000 to $199,999"),
         (200_000, 500_000, "$200,000 to $499,999"), (500_000, 1_000_000, "$500,000 to $999,999"),
         (1_000_000, 5_000_000, "$1 million to $4,999,999"), (5_000_000, None, "$5 million and over")]


def class_floor(label):
    """An FTB AGI class's lower bound: "Negative" -> -1, "Zero" -> 0, "100,000  to  149,999" -> 100000."""
    s = label.strip().lower()
    if s.startswith("negative"):
        return -1
    if s.startswith("zero"):
        return 0
    m = re.match(r"([\d,]+)", s)
    return int(m.group(1).replace(",", "")) if m else None


def ftb_bands(rows):
    """B-4A rows (csv.DictReader) -> {year, bands: [{label, returns, ca_agi, tax}], total, classes} for the latest year."""
    n = lambda v: float(str(v).replace(",", "")) if str(v).strip() not in ("", "NULL") else 0.0
    years = sorted({int(r["Taxable Year"]) for r in rows})
    y = years[-1]
    mine = [r for r in rows if int(r["Taxable Year"]) == y]
    bands = [{"label": lab, "returns": 0, "ca_agi": 0.0, "tax": 0.0} for _, _, lab in BANDS]
    for r in mine:
        lo = class_floor(r["AGIC"])
        if lo is None:
            raise ValueError(f"unreadable AGI class {r['AGIC']!r}")
        i = next(i for i, (a, b, _) in enumerate(BANDS) if (a is None or lo >= a) and (b is None or lo < b))
        bands[i]["returns"] += int(n(r["All Returns"]))
        bands[i]["ca_agi"] += n(r["California AGI"])
        bands[i]["tax"] += n(r["Total Tax Liability"])
    total = {"returns": sum(b["returns"] for b in bands), "ca_agi": sum(b["ca_agi"] for b in bands), "tax": sum(b["tax"] for b in bands)}
    return {"year": y, "bands": bands, "total": total, "classes": len(mine), "years": [years[0], years[-1]]}


# ---------------------------------------------------------------------------


def sheet_rows(data, url):
    if url.lower().endswith(".xlsx"):
        import openpyxl
        return list(openpyxl.load_workbook(io.BytesIO(data), read_only=True, data_only=True).worksheets[0].iter_rows(values_only=True))
    import xlrd
    sh = xlrd.open_workbook(file_contents=data).sheets()[0]
    return [sh.row_values(i) for i in range(sh.nrows)]


def main():
    prev = json.loads(OUT.read_text()) if OUT.exists() else {}
    out = {"_readme": "Built by tools/build_taxpayers.py from official tables. Never edit by hand.", "generated": datetime.date.today().isoformat()}
    failed = []
    labels = group_labels()
    try:
        links = newest_tables(get(IRS_PAGE).decode("utf-8", "replace"))
        top = irs_blocks(sheet_rows(get(links["41"]), links["41"]), TOP_GROUPS)
        bottom = irs_blocks(sheet_rows(get(links["42"]), links["42"]), BOTTOM_GROUPS)
        if not top.get("tax_share") or not bottom.get("tax_share"):
            raise ValueError("the share blocks didn't read")
        out["irs"] = {"source_url": IRS_PAGE, "tables": [links["41"], links["42"]],
                      "years": [min(top["tax_share"]), max(top["tax_share"])],
                      "groups": irs_groups(top, TOP_GROUPS, labels) + irs_groups(bottom, BOTTOM_GROUPS, labels)}
        say(f"IRS: {len(out['irs']['groups'])} groups, {out['irs']['years'][0]}-{out['irs']['years'][1]}")
    except Exception as e:  # noqa: BLE001 - a failed source keeps its last good data
        failed.append(f"IRS tables: {e}")
        if prev.get("irs"):
            out["irs"] = prev["irs"]
    try:
        with tempfile.NamedTemporaryFile(suffix=".pdf") as f:
            f.write(get(TOP400))
            f.flush()
            text = subprocess.run(["pdftotext", "-layout", f.name, "-"], capture_output=True, text=True, timeout=120).stdout
        rows = top400_rows(text)
        if len(rows) < 20:
            raise ValueError(f"only {len(rows)} years read")
        out["top400"] = {"source_url": TOP400, "rows": rows}
        say(f"Top 400: {len(rows)} years")
    except Exception as e:  # noqa: BLE001
        failed.append(f"Top 400: {e}")
        if prev.get("top400"):
            out["top400"] = prev["top400"]
    try:
        pkg = json.loads(get(FTB_PACKAGE))["result"]
        url = [r["url"] for r in pkg["resources"] if (r.get("format") or "").lower() == "csv"][-1]
        rows = list(csv.DictReader(io.StringIO(get(url).decode("utf-8-sig"))))
        out["ftb"] = {"source_url": FTB_PAGE, "file": url, **ftb_bands(rows)}
        say(f"FTB: {out['ftb']['year']}, {out['ftb']['classes']} classes")
    except Exception as e:  # noqa: BLE001
        failed.append(f"FTB: {e}")
        if prev.get("ftb"):
            out["ftb"] = prev["ftb"]
    out["cbo"] = {"source_url": CBO, "title": "The Distribution of Household Income, 2022", "read": False,
                  "note": "CBO's website refuses requests from the servers that build ThePillory's data, so its tables are linked here, not read."}
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, sort_keys=True) + "\n")
    say(f"Wrote {OUT.relative_to(ROOT)}")
    if failed:
        sys.exit("Not read (the last good data is kept): " + "; ".join(failed))


if __name__ == "__main__":
    main()
