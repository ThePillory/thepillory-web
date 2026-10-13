"""
"Net worth, as reported": each annual (or candidate, nominee) financial
disclosure report's assets and liabilities, read from the report as filed, and
the range they add up to (docs/funding.md, "Net worth"). Pure: text in, sums out.

Sources, one reader each, the same rules for every filer:
  House Clerk     the e-filed report's PDF text layer: Schedule A (assets),
                  Schedule D (liabilities)
  Senate eFD      the e-filed report's HTML: Part 3 (assets), Part 7 (liabilities)
  OGE 278e        the e-filed report's PDF text layer: Parts 2 and 5 (employment
                  assets and retirement accounts), 6 (other assets), 8 (liabilities)
  Judiciary       the JEFS report's text layer (AO Form 10, list layout):
                  Part VII (gross value), Part VI (liabilities)

Every asset and liability line must be accounted for, with a value the form
allows; otherwise the report isn't read (Unreadable) and stays a link, never
guessed. Scanned reports have no text to read here (see is_scan).

The range: low = sum of the assets' minimums - sum of the liabilities'
maximums; high = sum of the assets' maximums - sum of the liabilities'
minimums. An open-ended category ("Over $50,000,000", a spouse's "Over
$1,000,000") counts at its stated minimum and makes the high end "or more"; an
open-ended liability makes the low end "or less". A value the filer gave as
undetermined or not readily ascertainable counts as $0 to open-ended (high "or
more"). Mortgages on a personal residence are left out on every report: the
home itself isn't reported (House and Senate members don't report either; some
executive-branch nominees must report the mortgage), so counting only the debt
would understate the range for those filers alone.
"""
import html as htmllib
import re
from html.parser import HTMLParser

PARSER_VERSION = 1  # bump when a change could read a report differently


class Unreadable(Exception):
    """Not every line could be accounted for; the report stays a link."""


# ---------------------------------------------------------------------------
# Values

_NUM = lambda s: int(s.replace(",", ""))


def value_bounds(text):
    """
    A value as a form prints it -> (min, max, open) in dollars; max is None
    when open-ended. None when it isn't a value the forms use.
      "$1,001 - $15,000"             (1001, 15000, False)
      "None (or less than $1,001)"   (0, 1000, False)   (and plain "None")
      "$15,000 or less"              (0, 15000, False)  (judiciary)
      "Over $50,000,000"             (50000001, None, True)
      "Spouse/DC Over $1,000,000"    (1000001, None, True)
      "Undetermined", "Value not readily ascertainable", "Unascertainable"
                                     (0, None, True)
    """
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    if not s:
        return None
    m = re.fullmatch(r"\$([\d,]+) ?(?:-|to) ?\$([\d,]+)", s, re.I)
    if m:
        lo, hi = _NUM(m.group(1)), _NUM(m.group(2))
        return (lo, hi, False) if lo <= hi else None
    m = re.fullmatch(r"\$([\d,]+) or less", s, re.I)
    if m:
        return (0, _NUM(m.group(1)), False)
    m = re.fullmatch(r"None(?: \(or less than \$([\d,]+)\))?", s, re.I)
    if m:
        return (0, _NUM(m.group(1)) - 1 if m.group(1) else 0, False)
    m = re.fullmatch(r"(?:Spouse/DC )?(?:Over|More than) \$([\d,]+)(?: \(Spouse/DC Asset\)| \(asset held independently by spouse or dependent child\)| and held independently by spouse or dependent child)?", s, re.I)
    if m:
        return (_NUM(m.group(1)) + 1, None, True)
    m = re.fullmatch(r"\$([\d,]+)(?:\.(\d\d))?", s)
    if m:  # an exact amount, as some filers give one
        n = _NUM(m.group(1))
        return (n, n + (1 if m.group(2) and m.group(2) != "00" else 0), False)
    if re.fullmatch(r"(?:Value )?(?:Not Readily Ascertainable|Unascertainable|Undetermined)", s, re.I):
        return (0, None, True)
    return None


VALUE_AT_START = re.compile(
    r"^(?:Spouse/DC Over \$[\d,]+|(?:Over|More than) \$[\d,]+(?: \(Spouse/DC Asset\))?|\$[\d,]+ (?:-|to) \$[\d,]+|\$[\d,]+ or less"
    r"|None \(or less than \$[\d,]+\)|None|Undetermined|Value not readily ascertainable|Not readily ascertainable|Unascertainable"
    r"|\$[\d,]+(?:\.\d\d)?(?![\d,.]|\s*-))",
    re.I,
)


def first_value(text):
    """The value a column's text starts with (wrapped lines joined), or None."""
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    s = re.sub(r"\$([\d,]+) -$", r"$\1 -", s)
    m = VALUE_AT_START.match(s)
    return m.group(0) if m else None


def net_range(assets, liabilities):
    """
    assets, liabilities: [(min, max_or_None, open)] -> {asset_min, asset_max,
    asset_open, liab_min, liab_max, liab_open, low, high, low_open, high_open}.
    """
    a_min = sum(a[0] for a in assets)
    a_max = sum(a[0] if a[1] is None else a[1] for a in assets)
    a_open = sum(1 for a in assets if a[1] is None)
    l_min = sum(x[0] for x in liabilities)
    l_max = sum(x[0] if x[1] is None else x[1] for x in liabilities)
    l_open = sum(1 for x in liabilities if x[1] is None)
    return {
        "asset_min": a_min, "asset_max": a_max, "asset_open": a_open,
        "liab_min": l_min, "liab_max": l_max, "liab_open": l_open,
        "low": a_min - l_max, "high": a_max - l_min,
        "low_open": 1 if l_open else 0, "high_open": 1 if a_open else 0,
        "assets": len(assets), "liabilities": len(liabilities),
    }


NRA = re.compile(r"not\s+rea\w*\s+ascertainable", re.I)  # "Value not readily ascertainable" in a description
PERSONAL_RESIDENCE = re.compile(r"\b(?:personal|primary|principal)\s+residence\b", re.I)


def is_scan(text):
    """A PDF whose text layer is empty, or is an OCR layer over a scan rather than the e-filing system's text."""
    t = str(text or "")
    if len(re.sub(r"\s+", "", t)) < 200:
        return True
    # OCR of the OGE form's own header ("Fonn", "0MB", "lnmest") marks a scanned 278e.
    return bool(re.search(r"\bFonn\b|\b0MB No\b|Confficts|lnmest", t[:4000]))


def _tokens(line):
    """(start column, text) for each run of text separated by two or more spaces."""
    return [(m.start(), m.group(0)) for m in re.finditer(r"\S+(?: \S+)*", line)]


def _blocks(lines, gap=2):
    """Lists of lines separated by at least `gap` blank lines."""
    out, cur, blank = [], [], 0
    for ln in lines:
        if not ln.strip():
            blank += 1
            if blank >= gap and cur:
                out.append(cur)
                cur = []
            continue
        blank = 0
        cur.append(ln)
    if cur:
        out.append(cur)
    return out


# ---------------------------------------------------------------------------
# House Clerk (e-filed PDF): Schedule A, Schedule D

H_ASSET_HEAD = re.compile(r"^\s*Asset\s+Owner\s+Value of Asset\s+Income", re.I)
H_SCHED = re.compile(r"^\s*S(?:chedule)?\s+([A-I])\s*:", re.I)
H_END_A = re.compile(r"^\s*\*\s*(?:For the complete list|Investment Vehicle|Asset class details)|^\s*https://fd\.house\.gov", re.I)
H_TYPE_CODE = re.compile(r"\[[A-Za-z0-9]{2}\]")  # "[ST]"; small capitals in 2014-2017 reports ("[Ba]")
# The lines under an asset: location, description, comments ("L :", "LOCATION:", "D :", "C :").
H_DETAIL = re.compile(r"^\s*(?:[A-Z]{1,2}|LOCATION|DESCRIPTION|COMMENTS?)\s*:", re.I)
MONEY_PIECE = re.compile(r"^(?:\$[\d,]+(?: ?- ?(?:\$[\d,]+)?)?|-|(?:Spouse/DC )?Over(?: \$[\d,]+)?|\$[\d,]+ or less|None|Undetermined)$", re.I)


def house_meta(text):
    g = lambda k: (re.search(rf"^{k}:\s+(.+?)\s*$", text, re.M | re.I) or [None, None])[1]
    return {"name": g("Name"), "status": g("Status"), "filing_type": g("Filing Type"), "year": g("Filing Year"), "filed": g("Filing Date")}


def _house_schedule(text, letter):
    """The lines of one schedule (A to I), up to the next schedule's heading."""
    lines = text.replace("\f", "\n").split("\n")
    start = next((i for i, l in enumerate(lines) if (m := H_SCHED.match(l)) and m.group(1).upper() == letter), None)
    if start is None:
        raise Unreadable(f"no Schedule {letter}")
    end = next((i for i in range(start + 1, len(lines)) if H_SCHED.match(lines[i])), len(lines))
    return lines[start + 1:end]


def _cols(head):
    """(owner, value, income type) columns from a Schedule A heading line, either layout."""
    low = head.lower()
    v = low.index("value of asset")
    return low.index("owner"), v, low.index("income", v)


def house_assets(text):
    lines = _house_schedule(text, "A")
    if any(l.strip() == "None disclosed." for l in lines[:3]):
        return []
    cols = None
    body = []
    for ln in lines:
        if H_END_A.match(ln):
            break
        if H_ASSET_HEAD.match(ln):
            cols = _cols(ln)
            body.append((None, cols))  # a page break
            continue
        if re.fullmatch(r"\s*(?:\$1,000\?|type\(s\)\s+\$1,000\?)\s*", ln, re.I):
            continue
        body.append((ln, cols))
    if not any(c for _, c in body):
        raise Unreadable("Schedule A has no column headings")
    # Reports through 2016 or so have no asset type codes: rows are told apart by their values instead.
    coded = any(H_TYPE_CODE.search(" ".join(t for x, t in _tokens(ln) if x < c[0] - 2)) for ln, c in body if ln and c and not H_DETAIL.match(ln))
    rows = []
    for block in (_house_blocks(body) if coded else _house_blocks_by_value(body)):
        name, val = [], []
        for ln, (x_owner, x_val, x_inc) in block:
            if H_DETAIL.match(ln):
                continue
            for start, tok in _tokens(ln):
                if start < x_owner - 2:
                    name.append(tok)
                elif start >= x_owner + 3 and start < x_inc - 1:
                    val.append(tok)
        rows.append({"name": " ".join(name), "value": " ".join(val)})
    out = []
    for r in rows:
        if coded and not H_TYPE_CODE.search(r["name"]):
            raise Unreadable(f"an asset line with no type code: {r['name'][:80]!r}")
        v = first_value(r["value"])
        b = value_bounds(v) if v else None
        if b is None:
            raise Unreadable(f"no value read for {r['name'][:80]!r} ({r['value'][:40]!r})")
        out.append({"name": r["name"], "value": v, "bounds": b})
    expected = sum(len(H_TYPE_CODE.findall(" ".join(t for x, t in _tokens(ln) if x < 40))) for ln, _ in body if ln and not H_DETAIL.match(ln))
    if coded and expected != len(out):
        raise Unreadable(f"{len(out)} assets read, {expected} asset type codes in the schedule")
    return out


def _house_blocks(body):
    """
    Asset rows. A line at the left edge names an asset, unless it follows a
    location, description or comment line directly (then it's the rest of that line);
    it starts a new row once the row above has its asset type code. A row
    can span a page break (the repeated heading is left out).
    """
    out, cur, last = [], [], None
    for ln, cols in body:
        if ln is None:
            continue
        if not ln.strip():
            last = None  # a detail line's continuation follows it directly
            continue
        if H_DETAIL.match(ln):
            kind = "detail"
        elif not ln.startswith(" "):
            kind = "detail" if last == "detail" else "name"
        else:
            kind = "other"
        if kind == "name" and cur and any(H_TYPE_CODE.search(" ".join(t for x, t in _tokens(l) if x < c[0] - 2)) for l, c in cur if not H_DETAIL.match(l)):
            out.append(cur)
            cur = []
        cur.append((ln, cols))
        if kind != "other":
            last = kind
        if kind == "name" and H_TYPE_CODE.search(ln):
            last = "name"
    if cur:
        out.append(cur)
    return out


def _value_tokens(ln, cols):
    x_owner, _, x_inc = cols
    return [t for s, t in _tokens(ln) if x_owner + 3 <= s < x_inc - 1]


def _house_blocks_by_value(body):
    """
    Asset rows in reports without type codes: a line at the left edge with
    something in the value column starts a new asset once the asset above has
    a whole value; a value that wraps ("$1,000,001 -" then "$5,000,000"), a
    wrapped name and the location and description lines belong to the asset above.
    """
    out, cur, val = [], [], ""
    for ln, cols in body:
        if ln is None or not ln.strip():
            continue
        vt = " ".join(_value_tokens(ln, cols)) if not H_DETAIL.match(ln) else ""
        whole = bool(first_value(val)) and not val.rstrip().endswith("-")
        if not ln.startswith(" ") and not H_DETAIL.match(ln) and vt and cur and whole:
            out.append(cur)
            cur, val = [], ""
        cur.append((ln, cols))
        val = (val + " " + vt).strip()
    if cur:
        out.append(cur)
    return out


H_MONEY = re.compile(r"(?:Spouse/DC )?Over \$[\d,]+|\$[\d,]+(?:\.\d\d)?(?: ?- ?(?:\$[\d,]+)?)?|(?<=\s)-(?=\s|$)")


def _open_amount(block, x_amt):
    """A row whose amount so far ends with a dash ("$100,001 -"): the rest is further down."""
    found = [m.group(0) for ln in block for m in H_MONEY.finditer(ln) if m.start() >= x_amt - 25]
    return bool(found) and " ".join(found).rstrip().endswith("-")


def house_liabilities(text):
    lines = _house_schedule(text, "D")
    if any(l.strip() == "None disclosed." for l in lines[:3]):
        return []
    x_amt = None
    rows, cur = [], []
    for ln in lines:
        if re.match(r"^\s*Owner\s+Creditor\s+Date Incurred", ln, re.I):
            x_amt = ln.lower().index("amount of")
            continue
        if re.fullmatch(r"\s*Liability\s*", ln, re.I):
            continue
        if not ln.strip():
            if cur:
                rows.append(cur)
                cur = []
            continue
        cur.append(ln)
    if cur:
        rows.append(cur)
    if x_amt is None:
        raise Unreadable("Schedule D has no column headings")
    # A blank line can fall inside a row: before its comment line ("C : Paid off"), or before the rest of an amount.
    merged = []
    for block in rows:
        if merged and (H_DETAIL.match(block[0]) or _open_amount(merged[-1], x_amt)):
            merged[-1] = merged[-1] + block
        else:
            merged.append(block)
    rows = merged
    out = []
    for block in rows:
        # The amount is the last column; its position drifts from row to row, and in some
        # reports it runs on from the type with one space ("..., Haleyville $15,001 - $50,000").
        pieces, rest = [], []
        for ln in block:
            found = [m for m in H_MONEY.finditer(ln) if m.start() >= x_amt - 25]
            if not pieces:
                while found and found[0].group(0) == "-":  # a dash in the date or type column, not part of an amount
                    found.pop(0)
            pieces += [m.group(0) for m in found]
            rest.append(ln[:found[0].start()] if found else ln)
        amt = re.sub(r"-(?:\s*-)+", "-", " ".join(pieces))
        name = re.sub(r"\s+", " ", " ".join(rest)).strip()
        v = first_value(amt)
        b = value_bounds(v) if v else None
        if b is None:
            raise Unreadable(f"no amount read for liability {name[:80]!r} ({amt[:40]!r})")
        out.append({"name": name, "value": v, "bounds": b})
    return out


def read_house(text):
    if is_scan(text):
        raise Unreadable("scanned")
    return {"meta": house_meta(text), "assets": house_assets(text), "liabilities": house_liabilities(text)}


# ---------------------------------------------------------------------------
# OGE Form 278e (e-filed PDF): Parts 2, 5, 6, 8

O_PART = re.compile(r"^\s*(\d)\.\s+(Filer's|Spouse's|Other|Liabilities|Transactions|Gifts|Filer)", re.I)
O_ROW = re.compile(r"^\s*(\d+(?:\.\d+)*)\s{2,}\S")
O_STOP = re.compile(r"^\s*(Summary of Contents|Endnotes|Privacy Act Statement)\b")


def _oge_sections(text):
    """{part number: [lines]} for the report's tables (not the instructions after "Summary of Contents")."""
    lines = text.replace("\f", "\n").split("\n")
    stop = next((i for i, l in enumerate(lines) if O_STOP.match(l)), len(lines))
    out, cur = {}, None
    for ln in lines[:stop]:
        m = O_PART.match(ln)
        if m and not ln.lstrip().startswith(("Part ",)):
            cur = int(m.group(1))
            out.setdefault(cur, [])
            continue
        if cur is not None:
            out[cur].append(ln)
    return out


def _oge_rows(lines, head_re, val_head, next_head):
    """[(row number, [(line, (x_val, x_next))])] with each page's column positions."""
    cols, rows, cur = None, [], None
    for ln in lines:
        if re.match(head_re, ln):
            cols = (ln.index(val_head), ln.index(next_head))
            continue
        if cols is None:
            continue
        if re.match(r"^\s*(AMOUNT|INCURRED)\s*$", ln) or re.search(r" - Page \d+\s*$", ln) or re.match(r"^\s*Data Revised", ln):
            continue
        m = O_ROW.match(ln)
        if m:
            cur = (m.group(1), [])
            rows.append(cur)
        if cur is not None and ln.strip():
            cur[1].append((ln, cols))
    return rows


def oge_assets(sections):
    """
    Parts 2, 5 and 6. A line with a value counts once, and the lines under it
    (a fund's underlying holdings, listed without values) are inside it. A line
    without a value either holds the lines under it (an account) or is income
    only (a salary, a fee: something in its income columns); anything else
    makes the report unreadable.
    """
    out = []
    for part in (2, 5, 6):
        lines = sections.get(part)
        if not lines:
            continue
        if any(re.search(r"\(N/A\)|^\s*None\s*$", l) for l in lines[:4]) and not any(O_ROW.match(l) for l in lines):
            continue
        rows = _oge_rows(lines, r"^\s*#\s+DESCRIPTION\s+EIF\s+VALUE\s+INCOME TYPE", "VALUE", "INCOME TYPE")
        nums = [n for n, _ in rows]
        covered = None  # the line with a value whose lines are inside it
        for n, block in rows:
            if covered and n.startswith(covered + "."):
                continue
            covered = None
            val = " ".join(t for ln, (x_val, x_next) in block for s, t in _tokens(ln) if x_val - 3 <= s < x_next - 1)
            income = " ".join(t for ln, (x_val, x_next) in block for s, t in _tokens(ln) if s >= x_next - 1)
            desc = " ".join(t for ln, (x_val, _) in block for s, t in _tokens(ln) if s < x_val - 3)
            has_children = any(m.startswith(n + ".") for m in nums)
            v = first_value(val)
            if v is None and (not val.strip() or val.strip() == "N/A") and NRA.search(desc) and not has_children:
                out.append({"part": part, "n": n, "name": re.sub(r"^\d+(?:\.\d+)*\s+", "", desc), "value": "Value not readily ascertainable", "bounds": (0, None, True)})
                continue
            if v is None and (not val.strip() or val.strip() == "N/A"):
                # An account (lines under it), income only, or a line whose value is reported on another line.
                if has_children or income.strip() or re.search(r"\b(?:reported|included|listed)\s+(?:at|in|on|under)\s+(?:Part\s+\d+,?\s+)?line\b|\bsee\s+line\b", desc, re.I):
                    continue
                raise Unreadable(f"Part {part} line {n}: no value read ({desc[:60]!r})")
            b = value_bounds(v) if v else None
            if b is None:
                raise Unreadable(f"Part {part} line {n}: no value read ({desc[:50]!r}: {val[:40]!r})")
            if has_children:
                covered = n
            out.append({"part": part, "n": n, "name": re.sub(r"^\d+(?:\.\d+)*\s+", "", desc), "value": v, "bounds": b})
    return out


def oge_liabilities(sections):
    lines = sections.get(8)
    if not lines:
        return []
    rows = _oge_rows(lines, r"^\s*#\s+CREDITOR NAME\s+TYPE\s+AMOUNT", "AMOUNT", "YEAR")
    out = []
    for n, block in rows:
        amt = " ".join(t for ln, (x_amt, x_next) in block for s, t in _tokens(ln) if x_amt - 3 <= s < x_next - 1)
        rest = " ".join(t for ln, (x_amt, _) in block for s, t in _tokens(ln) if s < x_amt - 3)
        v = first_value(amt)
        b = value_bounds(v) if v else None
        if b is None:
            raise Unreadable(f"Part 8 line {n}: no amount read ({amt[:40]!r})")
        out.append({"n": n, "name": re.sub(r"^\d+\s+", "", rest), "value": v, "bounds": b})
    return out


def read_oge(text):
    if is_scan(text):
        raise Unreadable("scanned")
    sections = _oge_sections(text)
    if 6 not in sections or 8 not in sections:
        raise Unreadable("no Part 6 or Part 8")
    m = re.search(r"Year \(Annual Report only\):\s+(\d{4})", text)
    t = re.search(r"Report Type:\s+(\S[^\n]*?)\s{2,}", text)
    return {"meta": {"year": m.group(1) if m else None, "report_type": t.group(1).strip() if t else None},
            "assets": oge_assets(sections), "liabilities": oge_liabilities(sections)}


# ---------------------------------------------------------------------------
# Senate eFD (e-filed HTML): Part 3, Part 7


class _Tables(HTMLParser):
    """Each table as [header cells, [row cells]], in order, with the text before it."""

    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.tables, self._t, self._row, self._cell, self._text, self._head = [], None, None, None, [], False

    def handle_starttag(self, tag, attrs):
        if tag == "table":
            self._t = {"before": " ".join(self._text[-60:]), "head": [], "rows": []}
        elif self._t is not None and tag == "tr":
            self._row = []
        elif self._row is not None and tag in ("td", "th"):
            self._cell = []
            self._head = tag == "th"
        elif tag == "br" and self._cell is not None:
            self._cell.append(" ")

    def handle_endtag(self, tag):
        if tag in ("td", "th") and self._row is not None and self._cell is not None:
            self._row.append(re.sub(r"\s+", " ", "".join(self._cell)).strip())
            self._cell = None
        elif tag == "tr" and self._t is not None and self._row is not None:
            if self._head and not self._t["head"]:
                self._t["head"] = self._row
            elif self._row:
                self._t["rows"].append(self._row)
            self._row, self._head = None, False
        elif tag == "table" and self._t is not None:
            self.tables.append(self._t)
            self._t = None

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)
        else:
            self._text.append(data.strip())


def _senate_part(page, title, next_title):
    i = page.find(title)
    if i < 0:
        raise Unreadable(f"no {title}")
    j = page.find(next_title, i + len(title)) if next_title else -1
    return page[i: j if j > 0 else len(page)]


def _senate_table(part_html):
    """The part's table, or None when the part says No."""
    p = _Tables()
    p.feed(part_html)
    if not p.tables:
        if re.search(r"<strong>\s*No\s*</strong>", part_html):
            return None
        raise Unreadable("no table in the part")
    return p.tables[0]


def senate_assets(page):
    t = _senate_table(_senate_part(page, "Part 3. Assets", "Part 4a"))
    if t is None:
        return []
    head = [h.lower() for h in t["head"]]
    try:
        ci = head.index("#") if "#" in head else head.index("")
        cv, ca = head.index("value"), head.index("asset")
    except ValueError:
        raise Unreadable(f"Part 3 columns: {t['head']}")
    rows = [r for r in t["rows"] if len(r) > cv]
    nums = [r[ci] for r in rows]
    out = []
    for r in rows:
        n = r[ci]
        has_children = any(m.startswith(n + ".") for m in nums)
        v = r[cv]
        if has_children and v in ("--", "", "-"):
            continue
        if has_children:
            raise Unreadable(f"Part 3 line {n} has a value and lines under it")
        b = value_bounds(v)
        if b is None:
            raise Unreadable(f"Part 3 line {n}: value {v!r}")
        out.append({"n": n, "name": r[ca], "value": v, "bounds": b})
    return out


def senate_liabilities(page):
    t = _senate_table(_senate_part(page, "Part 7. Liabilities", "Part 8"))
    if t is None:
        return []
    head = [h.lower() for h in t["head"]]
    try:
        ca, ct = head.index("amount"), head.index("type")
    except ValueError:
        raise Unreadable(f"Part 7 columns: {t['head']}")
    out = []
    for r in t["rows"]:
        if len(r) <= ca:
            continue
        b = value_bounds(r[ca])
        if b is None:
            raise Unreadable(f"Part 7: amount {r[ca]!r}")
        out.append({"name": " ".join(r[ct:ct + 1] + r[ca + 1:ca + 2]), "type": r[ct], "value": r[ca], "bounds": b})
    return out


def read_senate(page):
    return {"meta": {}, "assets": senate_assets(page), "liabilities": senate_liabilities(page)}


# ---------------------------------------------------------------------------
# Judiciary (JEFS AO Form 10, list layout, 2025-): Part VII gross value, Part VI liabilities

J_ROW = re.compile(r"^\s*(\d+(?:-[A-Z]+)?)\.\s")


def _part(lines, start_re, end_re):
    s = next((i for i, l in enumerate(lines) if re.match(start_re, l)), None)
    if s is None:
        raise Unreadable(f"no {start_re}")
    e = next((i for i in range(s + 1, len(lines)) if re.match(end_re, lines[i])), len(lines))
    return lines[s + 1:e]


J_CODES = {"J": (0, 15000), "K": (15001, 50000), "L": (50001, 100000), "M": (100001, 250000), "N": (250001, 500000),
           "O": (500001, 1000000), "P1": (1000001, 5000000), "P2": (5000001, 25000000), "P3": (25000001, 50000000), "P4": (50000001, None)}
J_CODE = re.compile(r"^(?:J|K|L|M|N|O|P[1-4])$")


def _code_bounds(code):
    lo, hi = J_CODES[code]
    return (lo, hi, hi is None)


def read_judiciary_table(text):
    """The table layout (reports through 2024): value codes (J-P4) in Part VII column C1 and Part VI's last column."""
    lines = text.replace("\f", "\n").split("\n")
    vii = _part(lines, r"\s*VII\.\s+INVESTMENTS", r"\s*VIII\.\s")
    rows, in_header, c1 = [], False, None
    c2 = tx = amount = None
    for ln in vii:
        if re.search(r"VII\.\s+INVESTMENTS|Income Gain Codes", ln):
            in_header = True
        if 'Place "(X)"' in ln and "Amount" in ln:
            first = ln.index("Value")
            c1, c2 = first, ln.index("Value", first + 5)
            tx = ln.index("Type (e.g.,", c2)
            amount = ln.index("Amount") - 2
        if in_header:
            if "(Q-W)" in ln:
                in_header = False
            continue
        if re.search(r"FINANCIAL DISCLOSURE REPORT|Name of Person Reporting|Page \d+ of \d+", ln):
            continue
        m = J_ROW.match(ln) or re.match(r"^\s*(\d+)\.\s*$", ln)
        if not m:
            continue
        if c1 is None:
            raise Unreadable("Part VII has no column headings")
        desc = ln[m.end():amount].strip()
        val = [t for s, t in _tokens(ln) if c1 - 4 <= s < c2 - 2]
        has_tx = bool(ln[tx - 4:].strip()) if len(ln) > tx - 4 else False
        rows.append({"n": m.group(1), "desc": desc, "val": val, "tx": has_tx})
    if c1 is None:
        raise Unreadable("Part VII has no column headings")
    assets = []
    for i, r in enumerate(rows):
        if not r["desc"]:
            if r["val"]:
                raise Unreadable(f"Part VII line {r['n']}: a value with no asset")
            continue  # another transaction of the asset above, or an empty line
        if len(r["val"]) == 1 and J_CODE.match(r["val"][0]):
            assets.append({"n": r["n"], "value": r["val"][0], "bounds": _code_bounds(r["val"][0])})
        elif r["val"]:
            raise Unreadable(f"Part VII line {r['n']}: value {' '.join(r['val'])!r}")
        elif any(x["desc"] for x in rows[i + 1:i + 2]) and rows[i + 1]["desc"].startswith("-"):
            continue  # an account; the holdings in it follow ("- ...")
        else:
            # No gross value at the end of the year (sold, matured or given away during it): not held then.
            assets.append({"n": r["n"], "value": "", "bounds": (0, 0, False)})
    vi = _part(lines, r"\s*VI\.\s+LIABILITIES", r"\s*VII\.\s")
    liabs = []
    for ln in vi:
        m = J_ROW.match(ln)
        if not m or not ln[m.end():].strip():
            continue
        code = re.search(r"\s(J|K|L|M|N|O|P[1-4])\s*$", ln)
        if not code:
            raise Unreadable(f"Part VI: no value code on {ln.strip()[:80]!r}")
        liabs.append({"name": re.sub(r"\s+", " ", ln[m.end():code.start()]).strip()[:120], "value": code.group(1), "bounds": _code_bounds(code.group(1))})
    y = re.search(r"Annual,?\s+(\d{4})|(?:CY|Calendar Year)\s+(\d{4})", text)
    return {"meta": {"year": (y.group(1) or y.group(2)) if y else None}, "assets": assets, "liabilities": liabs}


def read_judiciary(text):
    if re.search(r"^\s*VII\.\s+INVESTMENTS and TRUSTS", text, re.M):
        return read_judiciary_table(text)
    lines = text.replace("\f", "\n").split("\n")
    y = re.search(r"^\s*Annual, (\d{4})", text, re.M)
    vii = _part(lines, r"\s*VII\.\s+Investments", r"\s*VIII\.\s")
    if any("No entries in this section" in l for l in vii[:4]):
        assets_rows = []
    else:
        x_val = x_next = None
        rows, cur = [], None
        in_tx = False
        pending = []  # the start of a value range printed above its row's number ("$1,000,001 -")
        for i, ln in enumerate(vii):
            if re.match(r"^\s*DESCRIPTION\s+INCOME AMOUNT\s+INCOME TYPE\s+GROSS VALUE", ln):
                x_val, x_next = ln.index("GROSS VALUE"), ln.index("VALUE METHOD")
                continue
            if re.match(r"^\s*Transactions\s+Transaction Type", ln):
                in_tx = True
                continue
            if re.match(r"^\s*\(\d+\)\.", ln) or re.match(r"^\s*Page \d+/\d+", ln.strip()) or ln.strip().startswith("Additional Explanation"):
                continue
            m = J_ROW.match(ln)
            if m:
                in_tx = False
                cur = [m.group(1), pending, x_val, x_next]
                pending = []
                rows.append(cur)
            elif x_val is not None and ln.strip() and not in_tx:
                toks = _tokens(ln)
                nxt = next((l for l in vii[i + 1:] if l.strip()), "")
                if toks and all(x_val - 4 <= x < x_next - 1 for x, _ in toks) and ln.rstrip().endswith("-") and J_ROW.match(nxt):
                    pending = [ln]
                    continue
            if cur is not None and ln.strip() and not in_tx:
                cur[1].append(ln)
        if x_val is None:
            raise Unreadable("Part VII has no column headings")
        nums = [r[0] for r in rows]
        assets_rows = []
        for n, block, xv, xn in rows:
            val = " ".join(t for ln in block for s, t in _tokens(ln) if xv - 4 <= s < xn - 1)
            has_children = any(m.startswith(n + "-") for m in nums)
            if has_children:
                continue
            v = first_value(val)
            if v is None and not val.strip():
                b = (0, 0, False)  # no gross value at the end of the year: not held then
                v = ""
            else:
                b = value_bounds(v) if v else None
            if b is None:
                raise Unreadable(f"Part VII line {n}: value {val[:40]!r}")
            assets_rows.append({"n": n, "value": v, "bounds": b})
    vi = _part(lines, r"\s*VI\.\s+Liabilities", r"\s*VII\.\s")
    liabs = []
    if not any("No entries in this section" in l for l in vi[:4]):
        for ln in vi:
            if J_ROW.match(ln):
                m = re.search(r"(\$[\d,]+ - \$[\d,]+|\$[\d,]+ or less|More than \$[\d,]+)\s*$", ln)
                if not m:
                    raise Unreadable(f"Part VI: no value on {ln.strip()[:80]!r}")
                liabs.append({"name": ln.strip()[:120], "value": m.group(1), "bounds": value_bounds(m.group(1))})
    return {"meta": {"year": y.group(1) if y else None}, "assets": assets_rows, "liabilities": liabs}


# ---------------------------------------------------------------------------
# Scanned OGE 278e reports, read by AI (tools/networth_scan.py): each line as
# {page, sec, grp, n, v, inc, elsewhere, nra, cred, unsure, note}. Two
# readings are compared line by line; only lines both read the same way count.

def _norm_value(v):
    return re.sub(r"\s+", " ", str(v or "")).replace(" -$", " - $").strip()


def _num(ln):
    return _norm_value(ln.get("n")).rstrip(".")


def line_key(ln):
    """What two readings must agree on for a line to count: its section, number and value."""
    return (ln["sec"].strip().upper(), _num(ln), _norm_value(ln.get("v")))


def blank_effect(ln):
    """What a line without a value does to the total, by its flags (report_from_lines' rules)."""
    if _norm_value(ln.get("v")):
        return "value"
    if ln.get("nra"):
        return "open"
    if ln.get("inc") or ln.get("elsewhere"):
        return "skip"
    return "none"


def _empty_row(ln):
    """A numbered row with nothing in it (forms print empty rows): no value and no flags."""
    return blank_effect(ln) == "none" and not ln.get("unsure")


def compare_readings(a, b):
    """
    a, b: each model's lines, in reading order. Compared page by page, lines
    lined up by section and number. A line counts when both readings have it
    with the same number and value (and, for a line without a value, the same
    effect: reported elsewhere, income only, or not readily ascertainable)
    and neither marked it unsure. A flag on a line that has a value changes
    nothing, so it isn't compared. A row only one reading lists counts as
    absent when it's empty (forms print empty numbered rows); otherwise it's
    a disagreement. -> {lines: agreed lines, disagreements: [{key, page, idx, a, b}]}
    (a or b None: that reading doesn't have the line).
    """
    import difflib
    by_page = lambda lines: {p: [x for x in lines if x["page"] == p] for p in sorted({x["page"] for x in lines})}
    pa, pb = by_page(a), by_page(b)
    agreed, dis = [], []
    for page in sorted(set(pa) | set(pb)):
        la, lb = pa.get(page, []), pb.get(page, [])
        ka = [(x["sec"].strip().upper(), _num(x)) for x in la]
        kb = [(x["sec"].strip().upper(), _num(x)) for x in lb]
        pairs = []
        for op, i1, i2, j1, j2 in difflib.SequenceMatcher(a=ka, b=kb, autojunk=False).get_opcodes():
            if op == "equal":
                pairs += list(zip(la[i1:i2], lb[j1:j2]))
            else:
                xa, xb = la[i1:i2], lb[j1:j2]
                common = min(len(xa), len(xb)) if op == "replace" else 0
                pairs += list(zip(xa[:common], xb[:common]))
                pairs += [(x, None) for x in xa[common:]] + [(None, y) for y in xb[common:]]
        for i, (x, y) in enumerate(pairs):
            if x is None or y is None:
                one = x or y
                if _empty_row(one):
                    continue
                dis.append({"key": f"p{page}.{i}", "page": page, "idx": i, "a": x, "b": y})
                continue
            same = line_key(x) == line_key(y) and (blank_effect(x) == blank_effect(y) or bool(_norm_value(x.get("v"))))
            if same and not x.get("unsure") and not y.get("unsure"):
                if not _empty_row(x):
                    agreed.append({**x, "idx": i})
            else:
                dis.append({"key": f"p{page}.{i}", "page": page, "idx": i, "a": x, "b": y})
    return {"lines": agreed, "disagreements": dis}


def _same_line(x, y):
    """Two readings of a line agree (compare_readings' rule)."""
    return (line_key(x) == line_key(y) and (blank_effect(x) == blank_effect(y) or bool(_norm_value(x.get("v"))))
            and not x.get("unsure") and not y.get("unsure"))


def tiebreak(disagreements, third):
    """
    A third reading of the disputed pages -> {key: "a" | "b"} for each line it
    settles: the third reading has exactly one line with that section and
    number, and it agrees with one reading and not the other. A line only one
    reading has is settled for that reading when the third has it too (and
    agrees), and for the other when the third has no such line. Anything else
    stays open for a person.
    """
    by = {}
    for t in third or []:
        by.setdefault((t["page"], t["sec"].strip().upper(), _num(t)), []).append(t)
    out = {}
    for d in disagreements:
        a, b = d.get("a"), d.get("b")
        one = a or b
        if one is None:
            continue
        keys = {(d["page"], x["sec"].strip().upper(), _num(x)) for x in (a, b) if x}
        ts = [t for k in keys for t in by.get(k, [])]
        if a is not None and b is not None:
            if len(ts) != 1:
                continue
            ta, tb = _same_line(ts[0], a), _same_line(ts[0], b)
            if ta != tb:
                out[d["key"]] = "a" if ta else "b"
            continue
        side = "a" if a is not None else "b"
        if not ts:
            out[d["key"]] = "b" if side == "a" else "a"
        elif len(ts) == 1 and _same_line(ts[0], one):
            out[d["key"]] = side
    return out


def report_from_lines(lines):
    """
    Agreed lines -> {assets, liabilities}, by the same rules as the text
    reader: a line with a value counts once and covers the lines numbered
    under it; one without either holds the lines under it, is income only, or
    is reported elsewhere ("See attached Schedule 1"); a value "not readily
    ascertainable" counts as open-ended. Raises Unreadable otherwise.
    """
    assets, liabs = [], []
    seq = [ln for ln in lines if ln["sec"].strip().upper() != "8"]
    covered = None
    for i, ln in enumerate(seq):
        scope = (ln["sec"].strip().upper(), (ln.get("grp") or "").strip().upper())
        n = _norm_value(ln.get("n"))
        if covered and covered[0] == scope and n.startswith(covered[1] + "."):
            continue
        covered = None
        has_children = bool(n) and any(
            (x["sec"].strip().upper(), (x.get("grp") or "").strip().upper()) == scope and _norm_value(x.get("n")).startswith(n + ".") for x in seq[i + 1:])
        v = _norm_value(ln.get("v"))
        if not v or v.upper() in ("N/A", "NA"):
            if ln.get("nra"):
                assets.append({"page": ln["page"], "n": n, "value": "Value not readily ascertainable", "bounds": (0, None, True)})
            elif has_children or ln.get("inc") or ln.get("elsewhere"):
                continue
            else:
                raise Unreadable(f"page {ln['page']}, Part {ln['sec']} line {n or '?'}: no value")
            continue
        b = value_bounds(first_value(v) or v)
        if b is None:
            raise Unreadable(f"page {ln['page']}, Part {ln['sec']} line {n or '?'}: value {v[:40]!r}")
        if has_children:
            covered = (scope, n)
        assets.append({"page": ln["page"], "n": n, "value": v, "bounds": b})
    for ln in lines:
        if ln["sec"].strip().upper() != "8":
            continue
        v = _norm_value(ln.get("v"))
        if not v:
            if ln.get("elsewhere"):
                continue
            raise Unreadable(f"page {ln['page']}, Part 8 line {ln.get('n') or '?'}: no amount")
        b = value_bounds(first_value(v) or v)
        if b is None:
            raise Unreadable(f"page {ln['page']}, Part 8 line {ln.get('n') or '?'}: amount {v[:40]!r}")
        liabs.append({"page": ln["page"], "n": _norm_value(ln.get("n")), "name": ln.get("cred") or "", "value": v, "bounds": b})
    return {"assets": assets, "liabilities": liabs}


def ocr_misses(lines, page_text):
    """Agreed values the page's own OCR text layer doesn't show anywhere (a check, not a source): [(page, value)]."""
    squash = lambda t: re.sub(r"[^0-9$]", "", t)
    out = []
    for ln in lines:
        v = _norm_value(ln.get("v"))
        nums = re.findall(r"\$[\d,]+", v)
        if not nums:
            continue
        text = squash(page_text.get(ln["page"], ""))
        if not all(squash(x) in text for x in nums):
            out.append((ln["page"], v))
    return out


# ---------------------------------------------------------------------------


def summarize(read):
    """A read report -> its range, with mortgages on a personal residence left out."""
    liabs = [x for x in read["liabilities"] if not PERSONAL_RESIDENCE.search(" ".join(str(x.get(k) or "") for k in ("name", "type")))]
    out = net_range([a["bounds"] for a in read["assets"]], [x["bounds"] for x in liabs])
    out["residence_mortgages"] = len(read["liabilities"]) - len(liabs)
    return out


def fmt_money(n):
    return ("-$" if n < 0 else "$") + f"{abs(int(n)):,}"
