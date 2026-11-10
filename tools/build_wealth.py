"""Who holds household wealth: data/taxes/wealth.json, from the Federal Reserve's
Distributional Financial Accounts (DFA), for /taxes/wealth/ (docs/taxes.md).

The DFA divide U.S. households into separate groups by net worth: the top 0.1%, the next
0.9%, the next 9%, the next 40% and the bottom 50%. They are already non-overlapping, so
nothing is subtracted. Read from the Fed's own download (dfa.zip):
  - dfa-networth-shares.csv: each group's share of total household net worth, by quarter
    (the Fed's own shares, never recomputed);
  - dfa-networth-levels-detail.csv: each group's net worth (millions of dollars), household
    count and minimum wealth cutoff, by quarter.

A run that doesn't read cleanly (not five groups, shares not adding to about 100, too few
quarters) keeps the last good file and fails, so the failure is seen. Standard library only.
Run in the weekly "Refresh company taxes" workflow (its taxpayers job). Tested in
tools/test_build_wealth.py.
"""
import csv
import datetime
import io
import json
import sys
import urllib.request
import zipfile
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "data" / "taxes" / "wealth.json"
PAGE = "https://www.federalreserve.gov/releases/z1/dataviz/dfa/index.html"
ZIP = "https://www.federalreserve.gov/releases/z1/dataviz/download/zips/dfa.zip"
SCF = "https://www.federalreserve.gov/econres/scfindex.htm"
UA = "Mozilla/5.0 (compatible; ThePillory data build; +https://thepillory.co)"

# The DFA's category codes -> our ids and labels, top to bottom (the same labels as the income table).
GROUPS = [
    ("TopPt1", "top-0.1", "Top 0.1%"),
    ("RemainingTop1", "next-0.9", "Next 0.9% (rest of the top 1%)"),
    ("Next9", "top-1-10", "Top 1–10%"),
    ("Next40", "top-10-50", "Top 10–50%"),
    ("Bottom50", "bottom-50", "Bottom 50%"),
]


def get(url):
    with urllib.request.urlopen(urllib.request.Request(url, headers={"User-Agent": UA}), timeout=180) as r:
        return r.read()


# ---------------------------------------------------------------------------
# Pure parts


def num(v):
    try:
        return float(str(v).replace(",", "").strip())
    except (TypeError, ValueError):
        return None


def column(header, *words):
    """The first column whose name contains every word (case ignored); None if there isn't one."""
    for i, h in enumerate(header):
        if all(w in h.lower() for w in words):
            return i
    return None


def read_shares(text):
    """dfa-networth-shares.csv -> {quarter: {category: share of net worth}}."""
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    q, cat, nw = column(head, "date"), column(head, "category"), column(head, "net worth")
    out = {}
    for r in rows[1:]:
        if len(r) > max(q, cat, nw) and num(r[nw]) is not None:
            out.setdefault(r[q].strip(), {})[r[cat].strip()] = num(r[nw])
    return out


def read_detail(text):
    """dfa-networth-levels-detail.csv -> {quarter: {category: {net_worth (dollars), households, cutoff}}}."""
    rows = list(csv.reader(io.StringIO(text)))
    head = rows[0]
    q, cat = column(head, "date"), column(head, "category")
    nw, hh, cut = column(head, "net worth"), column(head, "household"), column(head, "cutoff")
    if None in (q, cat, nw, hh):
        raise ValueError(f"columns not found in {head}")
    out = {}
    for r in rows[1:]:
        if len(r) <= max(q, cat, nw, hh):
            continue
        n, h = num(r[nw]), num(r[hh])
        if n is None or h is None:
            continue
        c = num(r[cut]) if cut is not None and cut < len(r) else None
        out.setdefault(r[q].strip(), {})[r[cat].strip()] = {"net_worth": n * 1e6, "households": h, "cutoff": c}
    return out


def qkey(quarter):
    """'2026:Q2' -> (2026, 2), for ordering."""
    y, _, qq = quarter.partition(":Q")
    return (int(y), int(qq or 0))


def build(shares, detail):
    """The file's content from the two tables: the latest quarter's groups, and every quarter's shares."""
    codes = [c for c, _, _ in GROUPS]
    quarters = sorted((q for q in shares if all(c in shares[q] for c in codes)), key=qkey)
    if len(quarters) < 100:
        raise ValueError(f"only {len(quarters)} complete quarters")
    latest = quarters[-1]
    if latest not in detail or not all(c in detail[latest] for c in codes):
        raise ValueError(f"the detail table has no complete {latest}")
    total = sum(shares[latest][c] for c in codes)
    if abs(total - 100) > 0.5:
        raise ValueError(f"{latest}: shares add to {total}")
    groups = []
    for code, gid, label in GROUPS:
        d = detail[latest][code]
        groups.append({"id": gid, "label": label, "share": shares[latest][code], "net_worth": d["net_worth"], "households": d["households"], "cutoff": d["cutoff"]})
    series = [{"quarter": q, "shares": {gid: shares[q][code] for code, gid, _ in GROUPS}} for q in quarters]
    return {"latest": latest, "groups": groups, "series": series}


# ---------------------------------------------------------------------------


def main():
    try:
        z = zipfile.ZipFile(io.BytesIO(get(ZIP)))
        names = {Path(n).name: n for n in z.namelist()}
        shares = read_shares(z.read(names["dfa-networth-shares.csv"]).decode("utf-8-sig"))
        detail = read_detail(z.read(names["dfa-networth-levels-detail.csv"]).decode("utf-8-sig"))
        body = build(shares, detail)
    except Exception as e:  # noqa: BLE001 - keep the last good file, and fail so it's seen
        print(f"Didn't read the Distributional Financial Accounts: {e}", file=sys.stderr)
        sys.exit(1)
    out = {
        "_readme": "Built by tools/build_wealth.py from the Federal Reserve's Distributional Financial Accounts. Never edit by hand.",
        "generated": datetime.date.today().isoformat(),
        "source_url": PAGE,
        "file": ZIP,
        "scf_url": SCF,
        **body,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(out, indent=1, ensure_ascii=False) + "\n")
    print(f"Wrote {OUT.name}: {body['latest']}, {len(body['series'])} quarters, "
          + ", ".join(f"{g['label']} {g['share']}%" for g in body["groups"]))


if __name__ == "__main__":
    main()
