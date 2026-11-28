#!/usr/bin/env python3
"""Read-only probe of the Cal-Access export: which tables say which committees an official controls.

    python3 tools/ca_committee_probe.py <dbwebexport.zip> [LASTNAME FIRSTNAME]

Prints the columns of the filer and link tables, the lookup codes for link and filer types, and,
for one person (default: Newsom Gavin), every filer whose name or cover pages name them, every
filer link touching those filers, Form 410 (Statement of Organization) rows naming them, and each
committee's Form 460 Summary Page line 5 (contributions received) for 2025-2026. Writes nothing.
Individuals other than the official are never printed.
"""
import csv
import io
import re
import sys
import zipfile
from collections import defaultdict
from datetime import datetime

csv.field_size_limit(10**9)


def rows(zf, table):
    member = next((n for n in zf.namelist() if n.upper().endswith(f"/{table}.TSV")), None)
    if not member:
        print(f"(no {table})")
        return
    with zf.open(member) as raw:
        reader = csv.reader(io.TextIOWrapper(raw, encoding="latin-1", newline=""), delimiter="\t", quoting=csv.QUOTE_NONE)
        header = next(reader)
        for r in reader:
            if len(r) >= len(header):
                yield dict(zip(header, r))


def cols(zf, table):
    for r in rows(zf, table):
        return list(r.keys())
    return []


def iso(d):
    for fmt in ("%m/%d/%Y %I:%M:%S %p", "%m/%d/%Y"):
        try:
            return datetime.strptime((d or "").strip(), fmt).date().isoformat()
        except ValueError:
            pass
    return None


def main():
    zf = zipfile.ZipFile(sys.argv[1])
    last = (sys.argv[2] if len(sys.argv) > 2 else "NEWSOM").upper()
    first = (sys.argv[3] if len(sys.argv) > 3 else "GAVIN").upper()
    for t in ("FILERNAME_CD", "FILER_LINKS_CD", "FILER_TYPES_CD", "FILER_TO_FILER_TYPE_CD", "CVR_SO_CD", "CVR_CAMPAIGN_DISCLOSURE_CD", "LOOKUP_CODES_CD"):
        print(f"{t}: {cols(zf, t)}")
    print("\nLookup codes about links, control, officeholders, filer types:")
    for r in rows(zf, "LOOKUP_CODES_CD"):
        d = " ".join(r.values()).upper()
        if re.search(r"CONTROL|LINK|OFFICEHOLDER|CANDIDATE|BALLOT|COMMITTEE", d):
            print("  ", r)
    print("\nFiler types:")
    for r in rows(zf, "FILER_TYPES_CD"):
        print("  ", r)

    # The person's own filer IDs, and committees naming them.
    ids = {}
    for r in rows(zf, "FILERNAME_CD"):
        if (r.get("NAML") or "").strip().upper() == last and (r.get("NAMF") or "").strip().upper().startswith(first[:3]):
            ids[r["FILER_ID"]] = r
        elif last in (r.get("NAML") or "").upper() and first in (r.get("NAML") or "").upper():
            ids[r["FILER_ID"]] = r
    print(f"\nFILERNAME_CD rows naming {first} {last}: {len(ids)}")
    for fid, r in ids.items():
        print("  ", {k: r.get(k) for k in ("FILER_ID", "FILER_TYPE", "STATUS", "EFFECT_DT", "NAML", "NAMF", "XREF_FILER_ID")})
    cover_ids = defaultdict(set)
    for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
        if r.get("FORM_TYPE") == "F460" and (r.get("CAND_NAML") or "").strip().upper() == last and (r.get("CAND_NAMF") or "").strip().upper().startswith(first[:3]):
            cover_ids[r["FILER_ID"]].add((r.get("ENTITY_CD"), (r.get("OFFICE_CD") or "").strip(), (r.get("FILER_NAML") or "").strip()[:80], (iso(r.get("THRU_DATE")) or "")[:4]))
    print(f"\nF460 covers naming {first} {last} as the candidate, by filer:")
    for fid, s in sorted(cover_ids.items()):
        print("  ", fid, sorted(s)[-3:])
    every = set(ids) | set(cover_ids)
    print("\nFILER_LINKS_CD rows touching those filers:")
    linked = set()
    for r in rows(zf, "FILER_LINKS_CD"):
        a, b = r.get("FILER_ID_A"), r.get("FILER_ID_B")
        if a in every or b in every:
            print("  ", r)
            linked |= {a, b}
    print("\nForm 410 (CVR_SO_CD) rows naming them or filed by those filers:")
    for r in rows(zf, "CVR_SO_CD"):
        text = " ".join(r.values()).upper()
        if r.get("FILER_ID") in every | linked or (last in text and first in text):
            # The committee's own fields only: never a treasurer's, bank's or other person's name or address.
            print("  ", {k: v for k, v in r.items() if v and re.search(r"FILER_ID|FILER_NAM|CONTROL|CAND|OFFICE|JURIS|TYP|STATUS|BAL|SPONSOR|PRIMFC|BRDBASE|_DT|DATE|ENTITY|FORM|CMTE", k) and not re.search(r"TRES|BANK|ADR|CITY|ST$|ZIP|PHON|FAX|EMAIL", k)})
    # Contributions received, Summary Page line 5, column A, statements covering 2025-2026.
    print("\nForm 460 line 5 (contributions received), statements through 2025-2026, by filer:")
    want = {}
    for r in rows(zf, "CVR_CAMPAIGN_DISCLOSURE_CD"):
        if r.get("FORM_TYPE") == "F460" and r["FILER_ID"] in every | linked:
            thru = iso(r.get("THRU_DATE")) or ""
            if "2025-01-01" <= thru <= "2026-12-31":
                k = r["FILING_ID"]
                if k not in want or int(want[k][1]) < int(r.get("AMEND_ID") or 0):
                    want[k] = (r["FILER_ID"], r.get("AMEND_ID") or "0", (r.get("FILER_NAML") or "").strip()[:80], r.get("ENTITY_CD"))
    total = defaultdict(float)
    names = {}
    for r in rows(zf, "SMRY_CD"):
        w = want.get(r["FILING_ID"])
        if w and r.get("AMEND_ID") == w[1] and r.get("FORM_TYPE") == "F460" and r.get("LINE_ITEM") == "5":
            try:
                total[w[0]] += float(r.get("AMOUNT_A") or 0)
            except ValueError:
                pass
            names[w[0]] = (w[2], w[3])
    for fid, t in sorted(total.items(), key=lambda x: -x[1]):
        print(f"   {fid} {names[fid]}: ${t:,.2f}")


if __name__ == "__main__":
    main()
