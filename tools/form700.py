"""
California Form 700 (Statement of Economic Interests), Schedule A-1: each
investment's name and description as filed, the fair market value box
checked, the nature of the investment, and the date it was acquired or
disposed of during the period, when the filer gave one.

The FPPC's PDFs are the form with the filer's entries laid on top: what the
filer typed is text in its own font (Helvetica), but the boxes they checked
are drawn, not text. So each box's ink is measured on the rendered page: a
checked box is dark inside, an empty one is blank. A statement is read only
when every Schedule A-1 entry passes the checks (exactly one value box, at
most one nature box, no box half-inked, whole dates); otherwise it's left as
a link, never guessed.

Needs pdfplumber (and the pypdfium2 it renders with). read_pdf(path) -> entries.
"""
import re
from datetime import date

PARSER_VERSION = 1
FILLED = "Helvetica"          # the font of what the filer typed; the form itself is Arial
SCALE = 4                     # render at 288 dpi
CHECKED, EMPTY = 0.25, 0.05   # ink inside a box: at least CHECKED is checked, at most EMPTY is empty


class Unreadable(Exception):
    """A statement whose Schedule A-1 can't be read in full; it stays a link."""


def _filled(w):
    return w.get("fontname", "").split("+")[-1].startswith(FILLED)


def _ink(img, box):
    x0, top, x1, bottom = box
    pad = 1.6
    crop = img.crop((int((x0 + pad) * SCALE), int((top + pad) * SCALE), int((x1 - pad) * SCALE), int((bottom - pad) * SCALE)))
    px = list(crop.getdata())
    return sum(1 for v in px if v < 128) / max(1, len(px))


def _squares(page):
    """The page's checkboxes: small drawn squares (the Income radio buttons are diamonds and aren't needed)."""
    out = []
    for c in page.curves:
        w, h = c["x1"] - c["x0"], c["bottom"] - c["top"]
        if 7 < w < 10 and 7 < h < 10 and len(c.get("pts") or []) == 6:
            out.append((c["x0"], c["top"], c["x1"], c["bottom"]))
    return out


def _label(words, box, stop_x):
    """The printed words just right of a box on its line, up to the next box."""
    x0, top, x1, bottom = box
    got = [w for w in words if not _filled(w) and abs(w["top"] - top) < 4 and x1 - 1 <= w["x0"] < stop_x]
    return " ".join(w["text"] for w in sorted(got, key=lambda w: w["x0"]))


def _date(slots, year_hint):
    """(month, day, year) words in the three slots → ISO date; None when month and day are blank."""
    m, d, y = (" ".join(s).strip() for s in slots)
    if not m and not d:
        return None
    if not (re.fullmatch(r"\d{1,2}", m) and re.fullmatch(r"\d{1,2}", d) and re.fullmatch(r"\d{2}(\d{2})?", y or str(year_hint)[-2:])):
        raise Unreadable(f"a partial or unreadable date: {m!r}/{d!r}/{y!r}")
    yy = int(y) if len(y) == 4 else 2000 + int(y)
    try:
        return date(yy, int(m), int(d)).isoformat()
    except ValueError:
        raise Unreadable(f"not a date: {m}/{d}/{y}")


def _page_entries(page, img, year_hint):
    words = page.extract_words(extra_attrs=["fontname", "size"])
    printed = [w for w in words if not _filled(w)]
    typed = [w for w in words if _filled(w)]
    heads = sorted([w for w in printed if w["text"] == "NAME" and any(
        v["text"] == "ENTITY" and abs(v["top"] - w["top"]) < 2 and v["x0"] - w["x0"] < 90 for v in printed)], key=lambda w: (w["x0"] > 300, w["top"]))
    squares = _squares(page)
    out = []
    for i, h in enumerate(heads):
        right = h["x0"] > 300
        col = (300, page.width) if right else (0, 300)
        below = [g for g in heads if (g["x0"] > 300) == right and g["top"] > h["top"]]
        bottom = min([g["top"] for g in below] + [page.height])
        inside = lambda w: col[0] <= w["x0"] < col[1] and h["top"] < w["top"] < bottom - 2

        def label_top(text):
            hit = [w for w in printed if w["text"] == text and inside(w)]
            return min(w["top"] for w in hit) if hit else None
        t_desc, t_fmv, t_nature, t_date, t_acq = (label_top(x) for x in ("GENERAL", "FAIR", "NATURE", "IF", "ACQUIRED"))
        if None in (t_desc, t_fmv, t_nature, t_date, t_acq):
            raise Unreadable(f"page {page.page_number}: an entry without the usual Schedule A-1 headings")
        cell = [w for w in typed if inside(w)]
        name = " ".join(w["text"] for w in sorted([w for w in cell if w["top"] < t_desc], key=lambda w: (round(w["top"]), w["x0"])))
        desc = " ".join(w["text"] for w in sorted([w for w in cell if t_desc < w["top"] < t_fmv], key=lambda w: (round(w["top"]), w["x0"])))
        boxes = sorted([b for b in squares if col[0] <= b[0] < col[1] and h["top"] < b[1] < bottom - 2], key=lambda b: (round(b[1]), b[0]))
        fmv = [b for b in boxes if t_fmv < b[1] < t_nature]
        nat = [b for b in boxes if t_nature < b[1] < t_date]
        if len(fmv) != 4 or len(nat) != 3:
            raise Unreadable(f"page {page.page_number}: {len(fmv)} value and {len(nat)} nature boxes where the form has 4 and 3")
        def checked(group):
            res = []
            for k, b in enumerate(group):
                ink = _ink(img, b)
                if EMPTY < ink < CHECKED:
                    raise Unreadable(f"page {page.page_number}: a box neither clearly checked nor empty ({ink:.2f})")
                if ink >= CHECKED:
                    nxt = [o[0] for o in group if abs(o[1] - b[1]) < 3 and o[0] > b[0]]
                    res.append(_label(printed, b, min(nxt + [col[1]])))
            return res
        values, natures = checked(fmv), checked(nat)
        if not name:
            if values or natures or any(t_date - 2 < w["top"] < t_acq and re.fullmatch(r"\d{1,2}", w["text"]) and w["text"] != str(year_hint)[-2:] for w in cell):
                raise Unreadable(f"page {page.page_number}: an entry with boxes or dates but no name")
            continue
        if len(values) != 1:
            raise Unreadable(f"page {page.page_number}: {name!r} has {len(values)} value boxes checked")
        if len(natures) > 1:
            raise Unreadable(f"page {page.page_number}: {name!r} has {len(natures)} nature boxes checked")
        nature = natures[0] if natures else None
        if nature and nature.startswith("Other"):
            other = [w for w in cell if t_nature < w["top"] < t_date]
            nature = "Other" + (f": {' '.join(w['text'] for w in sorted(other, key=lambda w: (round(w['top']), w['x0'])))}" if other else "")
        # The date slots: month, day, year under ACQUIRED, then under DISPOSED, at the form's fixed places.
        acq = [w for w in printed if w["text"] == "ACQUIRED" and inside(w)][0]
        dis = [w for w in printed if w["text"] == "DISPOSED" and inside(w)][0]
        slots = [[], [], [], [], [], []]
        for w in cell:
            if not (t_date < w["top"] < t_acq):
                continue
            base = acq["x0"] - 15 if w["x0"] < dis["x0"] - 15 else dis["x0"] - 15
            k = min(2, max(0, int((w["x0"] - base) // 23)))
            slots[(0 if base == acq["x0"] - 15 else 3) + k].append(w["text"])
        acquired = _date(slots[0:3], year_hint)
        disposed = _date(slots[3:6], year_hint)
        out.append({"entity": re.sub(r"\s+", " ", name).strip(), "description": desc or None, "nature": nature,
                    "value": re.sub(r"\s+", " ", values[0]).strip(), "acquired": acquired, "disposed": disposed, "page": page.page_number})
    return out


def read_pdf(path, year_hint):
    """Every Schedule A-1 entry, in filed order, or raises Unreadable."""
    import pdfplumber
    entries = []
    with pdfplumber.open(path) as doc:
        for page in doc.pages:
            text = page.extract_text() or ""
            if "SCHEDULE A-1" not in text:
                continue
            img = page.to_image(resolution=72 * SCALE).original.convert("L")
            entries += _page_entries(page, img, year_hint)
    for n, e in enumerate(entries, 1):
        e["n"] = n
    return entries
