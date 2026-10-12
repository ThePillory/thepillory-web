"""
California lobbying from the Cal-Access export: pure functions, tested in
tools/test_ca_lobbying.py; tools/load_ca_lobbying.py reads the export and
writes D1.

Lobbyist employers report each quarter on Form 635 (and people who spend
$5,000 or more to influence state action on Form 645): the total paid for
lobbying, and, in the filer's own words, what they lobbied ("AB 6, 7, 96;
SB 411; Legislature re: budget"). The bills are read from those words:

  - a bill is a prefix and a number: AB, SB, ACA, SCA, AJR, SJR, ACR, SCR
    (house and senate resolutions are left out: "SR 99" is usually a highway);
  - a prefix carries over to the numbers after it ("AB 6, 7, 96" is AB 6,
    AB 7 and AB 96), and "ABs 238, 683" is AB 238 and AB 683;
  - bill numbers restart every two-year session, so a report's bills belong
    to the session its quarter falls in; a mention about implementing an
    earlier law ("SB 54 implementation", "regulations implementing SB 253")
    is set aside, since it names a law from an earlier session.

What remains can still be wrong; every report links to the filing itself.
"""
import re
from datetime import date

PREFIXES = ("ACA", "SCA", "AJR", "SJR", "ACR", "SCR", "AB", "SB")
SINCE = "2025-01-01"
FORMS = {"F635": "employer", "F645": "other", "F625": "firm", "F615": "lobbyist"}
# Form 635's total payments in connection with lobbying (A+B+C+D), and Form 645's (A+B).
TOTAL_LINE = {"F635": "ABCD", "F645": "AB"}
CONTRIB_FORMS = {"F635P4B": "employer", "F625P4B": "firm", "F645P3B": "other", "F615P2": "lobbyist"}
REPORT_PDF = "https://cal-access.sos.ca.gov/PDFGen/pdfgen.prg?filingid={}&amendid={}"
EMPLOYER_PAGE = "https://cal-access.sos.ca.gov/Lobbying/Employers/Detail.aspx?id={}"

_PREFIX = r"(?<![A-Z0-9])(ACA|SCA|AJR|SJR|ACR|SCR|AB|SB)S?\.?(?:\s*NOS?\.?)?\s*,?\s*(\d{1,4})(?!\d|\.\d|%)"
_MORE = r"\s*(?:,|&|\bAND\b|/)\s*(\d{1,4})(?!\d|\.\d|%|\s*(?:MILLION|BILLION|PERCENT))"
_JOIN = r"\s*(?:,|&|\bAND\b)\s*$"


def iso(s):
    """Cal-Access dates ('7/26/2026 12:00:00 AM') → '2026-07-26'; '' when unreadable."""
    m = re.match(r"\s*(\d{1,2})/(\d{1,2})/(\d{4})", s or "")
    if not m:
        return ""
    try:
        return date(int(m[3]), int(m[1]), int(m[2])).isoformat()
    except ValueError:
        return ""


def session_of(day):
    """The two-year session a date falls in: 2026-03-31 → '20252026'."""
    y = int(day[:4])
    start = y if y % 2 else y - 1
    return f"{start}{start + 1}"


def _normalize(text):
    t = " ".join(str(text or "").upper().split())
    # "A.B. 6" → "AB 6", "S. B. 411" → "SB 411".
    t = re.sub(r"\b([AS])\.\s?([BR])\.", r"\1\2", t)
    return t


def bills_in(text):
    """The bills a report's activity text lists, in order, without repeats: ['AB 6', 'SB 411']."""
    t = _normalize(text)
    out = []
    skipped_end = None
    for m in re.finditer(_PREFIX, t):
        before = t[max(0, m.start() - 40):m.start()]
        nums = [m.group(2)]
        end = m.end()
        while True:
            more = re.match(_MORE, t[end:])
            if not more:
                break
            n = more.group(1)
            rest = t[end + more.end():end + more.end() + 3]
            # "2025-26", "2026–27": a fiscal year, not a bill.
            if re.match(r"(19|20)\d\d$", n) and re.match(r"\s?[-–]", rest):
                break
            nums.append(n)
            end += more.end()
        after = t[end:end + 25]
        implementing = re.search(r"IMPLEMENT\w*\s+(?:OF\s+)?(?:THE\s+)?$", before) or re.match(r"[\s,:;-]*(IMPLEMENTATION|IMPLEMENTING|REGULATIONS)", after)
        # "regulations implementing SB 253 & SB 261": the second law joins the first.
        joined = skipped_end is not None and re.fullmatch(_JOIN, t[skipped_end:m.start()])
        if implementing or joined:
            skipped_end = end
            continue
        skipped_end = None
        for n in nums:
            b = f"{m.group(1)} {int(n)}"
            if int(n) > 0 and b not in out:
                out.append(b)
    return out


def bill_id(bill, session):
    """'AB 6' in '20252026' → 'ca-20252026-ab-6', the site's id for it."""
    prefix, number = bill.split()
    return f"ca-{session}-{prefix.lower()}-{int(number)}"


def amount(x):
    try:
        return round(float(str(x).replace(",", "").strip()), 2)
    except ValueError:
        return None


def latest_amendments(covers):
    """Cover rows → the latest amendment of each filing: {filing_id: row}."""
    out = {}
    for r in covers:
        fid = r["FILING_ID"]
        if fid not in out or int(r["AMEND_ID"] or 0) > int(out[fid]["AMEND_ID"] or 0):
            out[fid] = r
    return out


def report_row(cover, totals):
    """
    A ca_lobby_reports row from a Form 635/645 cover and its summary lines
    ({line: amount}); None for a report filed by a person under their own name
    (people aren't named on ThePillory's money pages).
    """
    form = cover["FORM_TYPE"]
    if (cover.get("FILER_NAMF") or "").strip():
        return None
    name = (cover.get("FILER_NAML") or "").strip()
    start, end = iso(cover.get("FROM_DATE")), iso(cover.get("THRU_DATE"))
    activity = " ".join(str(cover.get("LBY_ACTVTY") or "").split())
    return {
        "filing_id": cover["FILING_ID"],
        "amend_id": int(cover["AMEND_ID"] or 0),
        "form": form,
        "employer_id": cover["FILER_ID"],
        "employer_name": name,
        "period_start": start,
        "period_end": end,
        "filed_on": iso(cover.get("RPT_DATE")) or None,
        "amount": totals.get(TOTAL_LINE.get(form, "")),
        "activity": activity[:2000] or None,
        "source_url": REPORT_PDF.format(cover["FILING_ID"], int(cover["AMEND_ID"] or 0)),
        "bills": [bill_id(b, session_of(end)) for b in bills_in(activity)] if end else [],
    }


def contribution_row(item, cover):
    """A ca_lobby_contributions row from an LCCM line and its filing's cover. A lobbyist's name isn't kept."""
    kind = CONTRIB_FORMS.get(item["FORM_TYPE"], "other")
    # Lobbyists, and anyone filing under their own name, are people: counts and totals only.
    person = kind == "lobbyist" or bool((cover.get("FILER_NAMF") or "").strip())
    name = None if person else (cover.get("FILER_NAML") or "").strip()
    return {
        "filing_id": item["FILING_ID"],
        "n": int(item.get("LINE_ITEM") or 0),
        "form": item["FORM_TYPE"],
        "filer_kind": kind,
        "filer_id": cover.get("FILER_ID") or None,
        "filer_name": name or None,
        "recipient_id": (item.get("RECIP_ID") or "").strip() or None,
        "recipient_name": " ".join(x for x in ((item.get("RECIP_NAMF") or "").strip(), (item.get("RECIP_NAML") or "").strip()) if x) or None,
        "date": iso(item.get("CTRIB_DATE")) or None,
        "amount": amount(item.get("AMOUNT")),
        "source_url": REPORT_PDF.format(item["FILING_ID"], int(item.get("AMEND_ID") or 0)),
    }
