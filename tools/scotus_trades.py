"""
The justices' purchases and sales, from Part VII ("Investments and Trusts") of
their annual financial disclosure reports (AO Form 10), as the Administrative
Office of the U.S. Courts produces them in its electronic filing system (JEFS).

Two layouts, both with a text layer:
  2023-2024  the table layout: one row per line, the transaction in columns D1-D3
             (type, mm/dd/yy, a value code J-P4); a row with no description is
             another transaction of the asset above it.
  2025-      the list layout: each asset, then "Transactions" and one line per
             transaction ("(1).  Sold (part)  Oct 2, 2025  $15,000 or less").

Each transaction is kept exactly as filed: the asset as described, the type
("Buy (add'l)", "Sold (part)"), the date and the value range. A report is read
only when every transaction line in it is accounted for; otherwise it is
listed as a link, never guessed. Pure: text in, rows out (see read_report).
"""
import re
from datetime import date

PARSER_VERSION = 1  # bump when a change could read a report differently

# The form's own legend (column D3): value codes.
VALUE_CODES = {
    "J": "$15,000 or less", "K": "$15,001 - $50,000", "L": "$50,001 - $100,000", "M": "$100,001 - $250,000",
    "N": "$250,001 - $500,000", "O": "$500,001 - $1,000,000", "P1": "$1,000,001 - $5,000,000",
    "P2": "$5,000,001 - $25,000,000", "P3": "$25,000,001 - $50,000,000", "P4": "More than $50,000,000",
}
TYPES = re.compile(r"^(Buy|Sold|Sell|Redeemed|Matured|Distributed|Spinoff|Donated|Gift|Exchange|Exchanged|Open|Opened|Closed|Rollover|Merged|Converted|Withdrawn|Transferred|Inherited)\b", re.I)
MONTHS = {m: i + 1 for i, m in enumerate(["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}
RANGE = re.compile(r"^(\$[\d,]+ - \$[\d,]+|\$[\d,]+ or less|More than \$[\d,]+|Over \$[\d,]+)$")


class Unreadable(Exception):
    """The report's transactions couldn't all be accounted for; it stays a link."""


def _part7(text):
    """Part VII's lines, up to Part VIII."""
    lines = text.split("\n")
    start = next((i for i, l in enumerate(lines) if re.match(r"\s*VII\.\s+(INVESTMENTS|Investments)", l)), None)
    if start is None:
        raise Unreadable("no Part VII")
    end = next((i for i in range(start + 1, len(lines)) if re.match(r"\s*VIII\.\s", lines[i])), len(lines))
    return lines[start:end]


def _iso_mdy(s):
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{2})", s)
    if not m:
        return None
    try:
        return date(2000 + int(m.group(3)), int(m.group(1)), int(m.group(2))).isoformat()
    except ValueError:
        return None


def _iso_long(s):
    m = re.fullmatch(r"([A-Z][a-z]{2})[a-z]*\.? (\d{1,2}), (\d{4})", s.strip())
    if not m or m.group(1) not in MONTHS:
        return None
    try:
        return date(int(m.group(3)), MONTHS[m.group(1)], int(m.group(2))).isoformat()
    except ValueError:
        return None


def _clean_asset(desc):
    return re.sub(r"\s+", " ", re.sub(r"^-+\s*", "", desc)).strip()


# ---------------------------------------------------------------------------
# 2023-2024: the table layout

def read_table(text):
    lines = _part7(text)
    out = []
    expected = 0
    tx_col = desc_end = None
    cur = None          # the asset the next transaction belongs to: {"asset", "account"}
    account = None      # the last top-level entry (an account an indented "- " asset sits in)
    last_tx = None
    in_header = False   # the column headings repeated at the top of every page
    for line in lines:
        if re.match(r"\s*VII\.\s+INVESTMENTS", line):
            in_header = True
        if re.search(r"Income Gain Codes", line):
            in_header = True   # the codes legend at the foot of the page, then the next page's heading
        if in_header:
            if "buy, sell," in line:
                tx_col = line.find("buy, sell,") - 4
            if 'Place "(X)"' in line and "Amount" in line:
                desc_end = line.find("Amount") - 2
            if "(Q-W)" in line:
                in_header = False
            continue
        if "buy, sell," in line:
            tx_col = line.find("buy, sell,") - 4
        if 'Place "(X)"' in line and "Amount" in line:
            desc_end = line.find("Amount") - 2
        if tx_col is None or desc_end is None:
            continue
        if re.search(r"FINANCIAL DISCLOSURE REPORT|Name of Person Reporting|Page \d+ of \d+|Income Gain Codes|Value Codes|Value Method Codes|\(See Column", line):
            continue
        right = line[tx_col:] if len(line) > tx_col else ""
        m = re.match(r"\s*(\d+)\.(?:\s|$)", line)
        body = line[m.end():] if m else line
        left = line[:desc_end] if not m else (" " * m.end() + line[m.end():desc_end])
        desc = left.strip()
        # A transaction on this line?
        tm = re.match(r"\s*(\S.*?)\s{2,}(\d{1,2}/\d{1,2}/\d{2})(?:\s+(J|K|L|M|N|O|P[1-4]))?(?:\s+([A-H]\d?))?\s*$", right)
        if re.search(r"\d{1,2}/\d{1,2}/\d{2}", right):
            expected += 1
        if m:
            if desc:
                is_child = desc.startswith("-")
                if not is_child:
                    account = None
                cur = {"asset": _clean_asset(desc), "account": account if is_child else None}
                if not is_child:
                    # An account is a row of its own with no income, value or transaction ("Brokerage Acct #1 (H)").
                    account = _clean_asset(desc) if not line[desc_end:].strip() else None
            elif cur is None and tm:
                raise Unreadable(f"a transaction with no asset above it: {line.strip()[:80]}")
            last_tx = None
            if tm:
                kind = tm.group(1).strip()
                if not TYPES.match(kind):
                    raise Unreadable(f"unknown transaction type {kind!r}")
                when = _iso_mdy(tm.group(2))
                if not when:
                    raise Unreadable(f"unreadable date {tm.group(2)!r}")
                last_tx = {"asset": cur["asset"], "account": cur["account"], "type": kind, "date": when,
                           "amount": VALUE_CODES.get(tm.group(3)) if tm.group(3) else None}
                out.append(last_tx)
            continue
        # A line without a number: the asset's description wrapping, and/or the type wrapping ("(add'l)").
        if desc and cur is not None:
            old_asset = cur["asset"]
            cur["asset"] = _clean_asset(old_asset + " " + desc)
            for t in out:
                if t["asset"] == old_asset and t["account"] == cur["account"] and t is out[-1]:
                    t["asset"] = cur["asset"]
            if account and not cur["account"] and old_asset == account:
                account = cur["asset"]
        w = right.strip()
        if w:
            if re.fullmatch(r"\([a-z' .]+\)", w) and last_tx is not None:
                last_tx["type"] = f"{last_tx['type']} {w}"
            elif re.search(r"\d{1,2}/\d{1,2}/\d{2}", w):
                raise Unreadable(f"a transaction outside a numbered row: {line.strip()[:80]}")
    if len(out) != expected:
        raise Unreadable(f"{expected} transaction dates, {len(out)} read")
    return out


# ---------------------------------------------------------------------------
# 2025-: the list layout

ITEM = re.compile(r"^\s*(\d+)(?:-([A-Z]+))?\.(?:\s+(.*))?$")
TX = re.compile(r"^\s*\((\d+)\)\.\s+(.*)$")
VALUE_START = re.compile(r"(?:^|\s)(\$[\d,]+|None\b|N/A\b|More than\b|Over \$)")


def _wrap(line):
    """A description's wrapped line: the text in the description column only (a wrapped value range sits further right)."""
    s = line.strip()
    if not s or len(line) - len(line.lstrip()) >= 40 or s.startswith("Additional Explanation"):
        return ""
    return re.split(r"\s{2,}", s)[0]


def _tx(t, asset, account):
    cols = [c for c in re.split(r"\s{2,}", t.group(2).strip()) if c]
    kind = cols[0] if cols else ""
    if not TYPES.match(kind):
        raise Unreadable(f"unknown transaction type {kind!r}")
    when = amount = None
    for c in cols[1:]:
        if _iso_long(c):
            when = _iso_long(c)
        elif RANGE.match(c):
            amount = c
        else:
            raise Unreadable(f"unreadable transaction column {c!r}")
    return {"asset": asset, "account": account, "type": kind, "date": when, "amount": amount}


def read_list(text):
    lines = _part7(text)
    keep = []
    for l in lines:
        s = l.strip()
        if re.match(r"(Page \d+/\d+|Produced by Administrative Office|DESCRIPTION\s+INCOME|VII\.\s)", s) or l.startswith("\f"):
            if l.startswith("\f") and l.strip() and not re.match(r"Page \d+/\d+", l.strip()):
                keep.append(l.lstrip("\f"))
            continue
        keep.append(l)
    # Blocks: runs of non-blank lines.
    blocks, cur = [], []
    for l in keep:
        if l.strip():
            cur.append(l)
        elif cur:
            blocks.append(cur)
            cur = []
    if cur:
        blocks.append(cur)
    out = []
    expected = sum(1 for l in keep if TX.match(l))
    parents = {}
    last = None  # the last asset read: transactions a page break separated from it follow in the next block
    for b in blocks:
        # A block may carry more than one item (an account line followed straight by its first holding).
        idx = [i for i, l in enumerate(b) if ITEM.match(l) and not TX.match(l)]
        if not idx:
            if any(TX.match(l) for l in b):
                if last is None or any(not TX.match(l) and "Transaction Type" not in l for l in b):
                    raise Unreadable(f"transactions with no asset: {b[0].strip()[:80]}")
                for l in b:
                    if TX.match(l):
                        out.append(_tx(TX.match(l), *last))
            continue
        # Segments: the lines before the first item, and after each item up to the next.
        segs = [b[:idx[0]]] + [b[i + 1:(idx[k + 1] if k + 1 < len(idx) else len(b))] for k, i in enumerate(idx)]
        aboves = [[x for x in map(_wrap, segs[0]) if x]] + [[] for _ in idx[1:]]
        belows, txs = [], []
        for k in range(len(idx)):
            seg = segs[k + 1]
            hdr = next((n for n, l in enumerate(seg) if "Transaction Type" in l or TX.match(l)), None)
            head = seg if hdr is None else seg[:hdr]
            cut = next((n for n, l in enumerate(head) if l.strip().startswith("Additional Explanation")), None)
            desc_lines = [x for x in map(_wrap, head if cut is None else head[:cut]) if x]
            txs.append([l for l in (seg if hdr is None else seg[hdr:]) if TX.match(l)])
            if k + 1 < len(idx):
                tail = [] if hdr is None else [x for x in map(_wrap, seg[hdr:]) if x and not x.startswith("Transactions")]
                if hdr is None:
                    # The lines between two items: a holding's description starts with "--"; otherwise an
                    # item's description is centred on its number, so it gets as many lines below as above.
                    split = next((n for n, x in enumerate(desc_lines) if x.startswith("--")), None)
                    if split is None:
                        split = min(len(aboves[k]), len(desc_lines)) if ITEM.match(b[idx[k]]).group(3) is not None or aboves[k] else 0
                    belows.append(desc_lines[:split])
                    aboves[k + 1] = desc_lines[split:]
                else:
                    belows.append(desc_lines)
                    aboves[k + 1] = tail
            else:
                belows.append(desc_lines)
        for k, i in enumerate(idx):
            m = ITEM.match(b[i])
            num, sub, rest = m.group(1), m.group(2), m.group(3) or ""
            v = VALUE_START.search(rest)
            on_line = (rest[: v.start()] if v else rest).strip()
            desc = " ".join(x for x in aboves[k] + [on_line] + belows[k] if x)
            asset = _clean_asset(desc)
            if sub is None:
                parents[num] = asset
            account = parents.get(num) if sub else None
            last = (asset, account)
            for l in txs[k]:
                out.append(_tx(TX.match(l), asset, account))
    if len(out) != expected:
        raise Unreadable(f"{expected} transaction lines, {len(out)} read")
    return out


def read_report(text):
    """The report's transactions in filed order, or raises Unreadable."""
    if re.search(r"^\s*VII\.\s+INVESTMENTS and TRUSTS", text, re.M):
        return read_table(text)
    if re.search(r"^\s*VII\.\s+Investments and Trusts", text, re.M):
        return read_list(text)
    raise Unreadable("unknown layout")


def filer_name(text):
    """The filer as the report names them: "Roberts Jr., John G." (list layout) or "Gorsuch, Neil M." (table layout)."""
    m = re.search(r"Filer's Information\s*\n\s*(\S[^\n]*)", text)
    if m:
        return m.group(1).strip()
    m = re.search(r"Page \d+ of \d+\s{2,}(\S.*?\S)\s{2,}\d{2}/\d{2}/\d{4}", text)
    return m.group(1).strip() if m else None
