"""Federal agencies into D1 (docs/agencies.md; migration 0052): the "Load agencies" workflow.

Official sources only:
  agencies   the Federal Register's agencies list (name, slug, parent, description, website)
  leaders    OPM's PLUM data (Senate-confirmed positions and who holds them), tied to the
             Congress.gov nominations and Senate roll calls already in D1
  money      USAspending.gov: total budgetary resources, obligations and outlays by fiscal year
             since 2017; by object class and budget function; top recipients that aren't individuals
  workforce  OPM's Federal Workforce Data: employees by agency, each September
  oversight  GAO's reports feed: reports naming the agency (Oversight.gov refuses GitHub's servers)
  rules      the Federal Register's rules by agency: count per year, and the latest 10
  laws       the appropriations bills already in D1, by the subcommittee in each bill's title

  python3 tools/load_agencies.py --mode measure            # read everything, write nothing; report rows and writes
  python3 tools/load_agencies.py --mode load               # write only what changed
  python3 tools/load_agencies.py --mode load --parts oversight

Measure mode reads the sources and what D1 holds, and reports per table the rows that would be
inserted, updated and deleted, the row writes that makes (each row plus one per index, as D1
bills), and the storage added. Load mode writes exactly those rows: upserts that skip identical
rows and prune() for rows gone from the source (tools/d1sql.py), never delete-and-reinsert, and
records them in usage_steps as "agencies-<part>". Each part first checks whether its source
changed (Content-Length, ETag, USAspending's reporting period) and skips when it didn't.
Standard library, plus pyarrow for OPM's parquet files (workforce only). Tested in
tools/test_load_agencies.py with saved copies of each source.
"""

import argparse
import concurrent.futures
import csv
import http.client
import datetime
import io
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import d1sql as D  # noqa: E402

ROOT = Path(__file__).resolve().parent.parent
UA = "ThePillory/1.0 (civic data loader; +https://thepillory.co)"
SINCE_FY = 2017
FR_AGENCIES = "https://www.federalregister.gov/api/v1/agencies.json"
FR_DOCS = "https://www.federalregister.gov/api/v1/documents"
PLUM_CSV = "https://escs.opm.gov/escs-net/api/pbpub/download-data"
PLUM_PAGE = "https://www.opm.gov/about-us/open-government/plum-reporting/plum-data/"
USAS = "https://api.usaspending.gov/api/v2"
OPM_FILES = "https://data.opm.gov/api/v1/files"
GAO_RSS = "https://www.gao.gov/rss/reports.xml"
APPROPRIATIONS = ROOT / "data" / "agencies" / "appropriations.json"
MIGRATION = ROOT / "workers" / "sync" / "migrations" / "0052_agencies.sql"
PARTS = ("agencies", "leaders", "money", "workforce", "oversight", "rules", "laws")

# The tables, their keys and how many indexes each has (D1 writes one entry per index per row).
TABLES = {
    "agencies": (("id", "fr_id", "name", "short_name", "parent_id", "kind", "description", "website", "usas_code", "source_url"), ("id",), 1),
    "agency_leaders": (("agency_id", "organization", "position", "name", "status", "appointment", "placement", "since", "nomination_id", "confirmed_on", "vote_id", "confirm_note", "official_id", "source_url"), ("agency_id", "organization", "position", "name"), 0),
    "agency_money": (("agency_id", "fy", "resources", "obligations", "outlays", "source_url"), ("agency_id", "fy"), 0),
    "agency_money_parts": (("agency_id", "fy", "kind", "name", "parent", "obligations", "outlays"), ("agency_id", "fy", "kind", "name"), 0),
    "agency_recipients": (("agency_id", "fy", "award", "rank", "name", "recipient_id", "amount"), ("agency_id", "fy", "award", "rank"), 0),
    "agency_workforce": (("agency_id", "year", "employees", "source_url"), ("agency_id", "year"), 0),
    "agency_reports": (("source", "number", "agency_id", "title", "published_on", "url"), ("source", "number", "agency_id"), 1),
    "agency_rule_counts": (("agency_id", "year", "rules"), ("agency_id", "year"), 0),
    "agency_rules": (("agency_id", "document_number", "title", "published_on", "url"), ("agency_id", "document_number"), 0),
    "agency_bills": (("agency_id", "bill_id", "subcommittee"), ("agency_id", "bill_id"), 0),
}


def say(*a):
    print(*a, flush=True)


# ---------------------------------------------------------------------------
# Fetching (honest user agent; a refusal is reported, never worked around)


class Refused(Exception):
    pass


def fetch(url, *, method="GET", body=None, accept="application/json", timeout=180, raw=False):
    headers = {"User-Agent": UA, "Accept": accept}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    for wait in (5, 20, 60, 120, None):
        try:
            req = urllib.request.Request(url, data=data, headers=headers, method=method)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                if method == "HEAD":
                    return dict(r.headers.items())
                b = r.read()
                return b if raw else b.decode("utf-8", "replace")
        except urllib.error.HTTPError as e:
            if e.code in (403, 406):
                raise Refused(f"{urllib.parse.urlsplit(url).hostname} refused the request (HTTP {e.code})") from e
            if wait is None or (e.code < 500 and e.code != 429):
                raise
        except (urllib.error.URLError, TimeoutError, ConnectionError, http.client.HTTPException, OSError):
            if wait is None:
                raise
        time.sleep(wait)


def fetch_json(url, **kw):
    return json.loads(fetch(url, **kw))


def head(url, accept="*/*"):
    try:
        h = fetch(url, method="HEAD", accept=accept)
        return {k.lower(): v for k, v in h.items()}
    except Exception:  # noqa: BLE001  (a server without HEAD: the full read decides)
        return {}


# ---------------------------------------------------------------------------
# Names (pure)

ARTICLES = {"and", "of", "the", "for", "on", "in", "to", "a", "an", "at", "by"}


def norm_name(s):
    """A name for matching across sources: "Agriculture Department" = "Department of Agriculture"
    = "DEPARTMENT OF AGRICULTURE". Pure."""
    t = re.sub(r"[^a-z0-9 ]+", " ", str(s or "").lower().replace("&", " and "))
    t = re.sub(r"\s+", " ", t).strip()
    m = re.match(r"^(.*) department$", t)
    if m:
        t = f"department of {m.group(1)}"
    t = re.sub(r"\bu s\b", "united states", t)
    t = re.sub(r" civil works$", "", t)  # USAspending's "Corps of Engineers - Civil Works"
    words = [w for w in t.split() if w not in ARTICLES]
    return " ".join(words)


def normal_case(s):
    """A name or title printed in capitals, with ordinary capitalization (the words unchanged). Pure."""
    s = str(s or "").strip()
    if not s or s != s.upper():
        return s
    out = []
    for i, w in enumerate(s.lower().split()):
        if i and w in ARTICLES:
            out.append(w)
        elif re.fullmatch(r"(ii|iii|iv|vi|vii|viii|ix|x|jr\.?|sr\.?)", w):
            out.append(w.upper() if not w.startswith(("jr", "sr")) else w.capitalize())
        else:
            out.append("-".join(p[:1].upper() + p[1:] for p in w.split("-")))
    return " ".join(out)


# ---------------------------------------------------------------------------
# agencies: the Federal Register's list (pure)


def parse_fr_agencies(data):
    """The Federal Register's agencies as table rows. A top-level agency named "... Department" is one
    of the executive departments; an agency with a parent is a sub-agency; every other top-level agency
    is listed as independent. The description is kept word for word (whitespace tidied). Pure."""
    by_id = {a["id"]: a for a in data}
    rows = []
    for a in data:
        parent = by_id.get(a.get("parent_id")) if a.get("parent_id") else None
        top = parent is None
        kind = "department" if top and re.search(r"\bDepartment$", a.get("name") or "") else "independent" if top else "sub-agency"
        desc = re.sub(r"[ \t]+", " ", (a.get("description") or "").replace("\r", "")).strip()
        desc = re.sub(r"\n{3,}", "\n\n", desc) or None
        site = a.get("agency_url") or None
        rows.append({
            "id": a["slug"], "fr_id": a["id"], "name": (a.get("name") or "").strip(), "short_name": a.get("short_name") or None,
            "parent_id": parent["slug"] if parent else None, "kind": kind, "description": desc,
            "website": site if site and re.match(r"https?://", site) else None, "usas_code": None,
            "source_url": a.get("url") or f"https://www.federalregister.gov/agencies/{a['slug']}",
        })
    return rows


# Names an official source uses for an agency the Federal Register lists under another name.
ALIASES = {"access board": "architectural transportation barriers compliance board"}


def word_key(n):
    return "|" + " ".join(sorted(n.split()))


def name_index(agencies):
    """{normalized name: [agency ids]}, plus the same words in any order ("Personnel Management
    Office" = "Office of Personnel Management"). Pure."""
    idx = {}
    for a in agencies:
        n = norm_name(a["name"])
        idx.setdefault(n, []).append(a["id"])
        idx.setdefault(word_key(n), []).append(a["id"])
    return idx


def unique_match(idx, name):
    """The one agency with this name (or the same words in another order); None unless exactly one. Pure."""
    n = norm_name(name)
    n = ALIASES.get(n, n)
    for key in (n, word_key(n)):
        ids = idx.get(key, [])
        if ids:
            return ids[0] if len(set(ids)) == 1 else None
    return None


# ---------------------------------------------------------------------------
# leaders: OPM's PLUM data, tied to Congress.gov nominations (pure)


def parse_plum(text):
    """PLUM's CSV: current positions only (not "Historical"). Returns dicts with the columns kept. Pure."""
    rows = []
    for r in csv.DictReader(io.StringIO(text.lstrip("﻿"))):
        status = (r.get("Position Status") or "").strip()
        if status not in ("Filled", "Vacant"):
            continue
        rows.append({
            "agency": (r.get("Agency") or "").strip(), "organization": (r.get("Organization") or "").strip(),
            "position": (r.get("Position Title") or "").strip(), "placement": (r.get("Position Placement") or "").strip() or None,
            "status": status, "appointment": (r.get("Appointment Type") or "").strip() or None,
            "first": (r.get("First Name") or "").strip(), "last": (r.get("Last Name") or "").strip(),
            "begin": (r.get("Begin Date") or "").strip() or None,
        })
    return rows


def iso_date(mdy):
    m = re.fullmatch(r"(\d{1,2})/(\d{1,2})/(\d{4})", mdy or "")
    return f"{m.group(3)}-{int(m.group(1)):02d}-{int(m.group(2)):02d}" if m else None


def leader_rows(plum, agency_idx, nominations, nom_votes, officials):
    """Senate-confirmed positions (PAS) and who holds them, filled or vacant as listed; a holder of a
    PAS position who isn't PAS appears only with a placement as listed (e.g. "PTDO"). Each holder is
    tied to the one nomination naming them for that position, its confirmation, and the Senate roll
    call when one is recorded. Pure. Returns (rows, unmatched agency names)."""
    pas_titles = {(p["agency"], p["organization"], p["position"]) for p in plum if p["appointment"] == "PAS"}
    rows, unmatched = [], set()
    for p in plum:
        key = (p["agency"], p["organization"], p["position"])
        if key not in pas_titles:
            continue
        if p["appointment"] != "PAS" and not (p["status"] == "Filled" and p["placement"]):
            continue
        agency = unique_match(agency_idx, p["organization"]) or unique_match(agency_idx, p["agency"])
        if not agency:
            unmatched.add(p["agency"])
            continue
        name = normal_case(f"{p['first']} {p['last']}".strip()) if p["status"] == "Filled" else ""
        nom = match_nomination(p["first"], p["last"], p["position"], nominations) if name and p["appointment"] == "PAS" else None
        vote = nom_votes.get(nom["id"]) if nom else None
        rows.append({
            "agency_id": agency, "organization": normal_case(p["organization"]), "position": normal_case(p["position"]),
            "name": name, "status": p["status"], "appointment": p["appointment"],
            "placement": p["placement"] if p["appointment"] != "PAS" else None, "since": iso_date(p["begin"]),
            "nomination_id": nom["id"] if nom else None,
            "confirmed_on": nom["latest_on"] if nom else None,
            "vote_id": vote,
            "confirm_note": None if vote or not nom else nom.get("latest_action"),
            "official_id": match_official(name, officials) if name else None,
            "source_url": PLUM_PAGE,
        })
    # One row per key: PLUM can list the same position twice for one person (two locations).
    seen, out = set(), []
    for r in rows:
        k = (r["agency_id"], r["organization"], r["position"], r["name"])
        if k not in seen:
            seen.add(k)
            out.append(r)
    return out, sorted(unmatched)


def match_nomination(first, last, position, nominations):
    """The one confirmed nomination whose description begins with this person's name ("Keith
    Sonderling, of Florida, to be Secretary of Labor") and names the position. None unless exactly one. Pure."""
    f, l = first.lower().split()[0] if first else "", last.lower()
    words = set(re.findall(r"[a-z]+", position.lower())) - ARTICLES - {"assistant", "deputy"} if position else set()
    found = []
    for n in nominations:
        if n.get("status") != "confirmed":
            continue
        d = (n.get("description") or "").lower()
        who = d.split(",")[0]
        if not (f and l and who.startswith(f) and re.search(rf"\b{re.escape(l)}\b", who)):
            continue
        role = d.split(" to be ", 1)[1] if " to be " in d else ""
        if words and not words <= set(re.findall(r"[a-z]+", role)):
            continue
        found.append(n)
    return found[0] if len(found) == 1 else None


def match_official(name, officials):
    """An official already on the site (the Cabinet) with exactly this name. Pure."""
    n = norm_name(name)
    hits = [o["id"] for o in officials if norm_name(o["name"]) == n]
    return hits[0] if len(hits) == 1 else None


def nomination_votes(votes, nominations):
    """{nomination id: Senate roll call id}: the vote "On the Nomination" whose subject is the start of
    the nomination's description (Senate roll calls give it word for word). Pure."""
    out = {}
    for v in votes:
        subj = (v.get("subject") or "").strip().lower()
        if not subj or not re.search(r"nomination", v.get("question") or "", re.I) or not re.search(r"confirm", v.get("result") or "", re.I):
            continue
        hits = [n["id"] for n in nominations if (n.get("description") or "").lower().startswith(subj)]
        if len(hits) == 1:
            out[hits[0]] = v["id"]
    return out


# ---------------------------------------------------------------------------
# money: USAspending (pure)


def usas_code_map(toptier, agency_idx):
    """{USAspending top-tier code: agency id}, by name, one match only. Returns (map, unmatched names). Pure."""
    out, unmatched = {}, []
    for t in toptier:
        a = unique_match(agency_idx, t.get("agency_name"))
        if a:
            out[t["toptier_code"]] = a
        else:
            unmatched.append(t.get("agency_name"))
    return out, unmatched


def money_rows(agency, code, data, since=SINCE_FY):
    """budgetary_resources: one row per fiscal year since `since` with any figure. Pure."""
    rows = []
    for y in data.get("agency_data_by_year", []):
        fy = y.get("fiscal_year")
        if not fy or fy < since:
            continue
        vals = (y.get("agency_budgetary_resources"), y.get("agency_total_obligated"), y.get("agency_total_outlayed"))
        if all(v is None for v in vals):
            continue
        rows.append({"agency_id": agency, "fy": fy, "resources": vals[0], "obligations": vals[1], "outlays": vals[2],
                     "source_url": f"https://www.usaspending.gov/agency/{code}?fy={fy}"})
    return rows


def object_class_rows(agency, fy, data):
    return [{"agency_id": agency, "fy": fy, "kind": "object_class", "name": r["name"], "parent": None,
             "obligations": r.get("obligated_amount"), "outlays": r.get("gross_outlay_amount")} for r in data.get("results", []) if r.get("name")]


def function_rows(agency, fy, data):
    out = []
    for f in data.get("results", []):
        for c in f.get("children") or []:
            if c.get("name"):
                out.append({"agency_id": agency, "fy": fy, "kind": "function", "name": c["name"], "parent": f.get("name"),
                            "obligations": c.get("obligated_amount"), "outlays": c.get("gross_outlay_amount")})
    return out


def recipient_rows(agency, fy, award, top, individuals, n=10):
    """The `n` largest recipients that aren't individuals: USAspending's list less the recipients its
    "individuals" filter returns, and less its placeholder names for redacted or multiple recipients. Pure."""
    skip = {r.get("recipient_id") for r in individuals.get("results", [])}
    out = []
    for r in top.get("results", []):
        name = (r.get("name") or "").strip()
        if not name or r.get("recipient_id") in skip or re.search(r"multiple recipients|redacted|individual", name, re.I):
            continue
        out.append({"agency_id": agency, "fy": fy, "award": award, "rank": len(out) + 1, "name": name,
                    "recipient_id": r.get("recipient_id"), "amount": r.get("amount")})
        if len(out) == n:
            break
    return out


AWARDS = {"contracts": ["A", "B", "C", "D"], "grants": ["02", "03", "04", "05"]}


def recipient_body(name, fy, award, individuals=False, limit=20):
    f = {"time_period": [{"start_date": f"{fy - 1}-10-01", "end_date": f"{fy}-09-30"}],
         "agencies": [{"type": "awarding", "tier": "toptier", "name": name}], "award_type_codes": AWARDS[award]}
    if individuals:
        f["recipient_type_names"] = ["individuals"]
    return {"filters": f, "category": "recipient", "limit": limit, "page": 1}


# ---------------------------------------------------------------------------
# oversight: GAO's feed (pure)


def parse_gao_rss(xml):
    """GAO's reports feed: [{number, title, published_on, url, text}]. Pure."""
    out = []
    for item in re.findall(r"<item>(.*?)</item>", xml, re.S):
        tag = lambda t: (re.search(rf"<{t}[^>]*>(.*?)</{t}>", item, re.S) or [None, ""])[1].strip()
        link = tag("link")
        m = re.search(r"/products/(gao-\d{2}-\d+[a-z]*)", link, re.I)
        if not m:
            continue
        date = None
        try:
            date = datetime.datetime.strptime(tag("pubDate")[:16], "%a, %d %b %Y").date().isoformat()
        except ValueError:
            pass
        text = re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", unescape(tag("description"))))
        out.append({"number": m.group(1).upper(), "title": unescape(tag("title")), "published_on": date, "url": link, "text": text})
    return out


def unescape(s):
    import html
    return html.unescape(re.sub(r"^<!\[CDATA\[|\]\]>$", "", s or ""))


def report_rows(items, agencies):
    """A report names an agency when its title or GAO's summary contains the agency's full name
    (Federal Register name, or "Department of X" for "X Department"). Pure."""
    names = []
    for a in agencies:
        forms = {a["name"]}
        m = re.match(r"^(.*) Department$", a["name"])
        if m:
            forms.add(f"Department of {m.group(1)}")
            forms.add(f"Department of the {m.group(1)}")
        names.append((a["id"], [f for f in forms if len(f) > 8]))
    rows = []
    for it in items:
        hay = f"{it['title']} {it['text']}"
        for aid, forms in names:
            if any(re.search(rf"\b{re.escape(f)}\b", hay) for f in forms):
                rows.append({"source": "gao", "number": it["number"], "agency_id": aid, "title": it["title"], "published_on": it["published_on"], "url": it["url"]})
    return rows


# ---------------------------------------------------------------------------
# rules: the Federal Register (pure)


def rule_count_rows(agency, facet, since=SINCE_FY):
    out = []
    for k, v in (facet or {}).items():
        y = int(k[:4]) if re.match(r"\d{4}", k) else None
        if y and y >= since and v.get("count") is not None:
            out.append({"agency_id": agency, "year": y, "rules": int(v["count"])})
    return sorted(out, key=lambda r: r["year"])


def rule_rows(agency, data, n=10):
    return [{"agency_id": agency, "document_number": r["document_number"], "title": r.get("title") or "", "published_on": r.get("publication_date"), "url": r["html_url"]}
            for r in (data.get("results") or [])[:n] if r.get("document_number") and r.get("html_url")]


# ---------------------------------------------------------------------------
# laws: appropriations bills (pure)


def bill_rows(bills, mapping):
    """Each appropriations bill tied to the agencies its subcommittee covers: the bill's own title
    must begin with the subcommittee's title (data/agencies/appropriations.json). Pure."""
    out = []
    for b in bills:
        t = (b.get("title") or "").strip()
        if not re.search(r"Appropriations Act", t):
            continue
        for m in mapping:
            if any(t.startswith(p) for p in m["titles"]):
                out += [{"agency_id": a, "bill_id": b["id"], "subcommittee": m["subcommittee"]} for a in m["agencies"]]
    return out


# ---------------------------------------------------------------------------
# workforce: OPM (needs pyarrow)


def workforce_counts(table, agency_idx):
    """{agency id: employees} from one OPM employment file: OPM's "count" column summed (1 per record
    when there's none), by department (a department's total) and by agency (a sub-agency's or an
    independent agency's total). An agency matched by both columns keeps the department column's
    total. Returns (counts, unmatched names, columns used)."""
    cols = table.column_names
    used = [c for c in ("department", "agency") if c in cols]
    if not used:
        return {}, [], None
    counts = table.column("count").to_pylist() if "count" in cols else None
    out, unmatched = {}, set()
    for c in used:
        tallies = {}
        for i, v in enumerate(table.column(c).to_pylist()):
            if v:
                tallies[v] = tallies.get(v, 0) + (int(counts[i] or 0) if counts else 1)
        for name, n in tallies.items():
            a = unique_match(agency_idx, name)
            if not a:
                unmatched.add(name)
            elif a not in out:
                out[a] = n
    return out, sorted(unmatched), ",".join(used)


# ---------------------------------------------------------------------------
# D1


def d1(args, *, file=None, command=None):
    from load_trades import d1 as _d1
    return _d1(args, file=file, command=command)


def run_sql(args, statements):
    from load_trades import run_sql as _run
    return _run(args, statements)


def existing(args, table, where="1"):
    cols, key, _ = TABLES[table]
    try:
        return {tuple(r[k] for k in key): r for r in d1(args, command=f"SELECT {', '.join(cols)} FROM {table} WHERE {where}")}
    except SystemExit as e:
        if "no such table" in str(e):
            return {}
        raise


def same(a, b):
    if isinstance(a, float) or isinstance(b, float):
        try:
            return abs(float(a) - float(b)) < 0.005
        except (TypeError, ValueError):
            return a == b
    return a == b or (a in (None, "") and b in (None, ""))


class Plan:
    """What a load would write, table by table: inserts, updates, deletes, row writes and bytes."""

    def __init__(self):
        self.tables = {}
        self.statements = []
        self.source_rows = {}

    def add(self, args, table, rows, where="1", prune_scope=None):
        cols, key, indexes = TABLES[table]
        old = existing(args, table, where)
        new = {tuple(r[k] for k in key): r for r in rows}
        ins = [r for k, r in new.items() if k not in old]
        upd = [r for k, r in new.items() if k in old and any(not same(r.get(c), old[k].get(c)) for c in cols)]
        dele = [k for k in old if k not in new] if prune_scope is not None else []
        t = self.tables.setdefault(table, {"source": 0, "read": 0, "insert": 0, "update": 0, "delete": 0, "writes": 0, "bytes": 0, "indexes": indexes})
        t["source"] += len(rows)
        t["read"] += len(old)
        t["insert"] += len(ins)
        t["update"] += len(upd)
        t["delete"] += len(dele)
        t["writes"] += (len(ins) + len(upd) + len(dele)) * (1 + indexes)
        t["bytes"] += sum(row_bytes(r, cols) for r in ins) * (1 + indexes)
        changed = ins + upd
        if changed:
            self.statements += D.upserts(table, cols, [[r.get(c) for c in cols] for r in changed], key)
        if dele:
            self.statements += D.prune(table, {}, list(key), list(new), existing=list(old))

    def report(self, part):
        lines = []
        for table, t in self.tables.items():
            lines.append(f"  {table}: {t['source']:,} rows from the source; {t['read']:,} in D1; would insert {t['insert']:,}, update {t['update']:,}, delete {t['delete']:,}; "
                         f"{t['writes']:,} row writes ({t['indexes']} index{'es' if t['indexes'] != 1 else ''}); about {t['bytes'] / 1e6:.2f} MB added")
        say(f"{part}:\n" + ("\n".join(lines) if lines else "  nothing to write"))

    @property
    def writes(self):
        return sum(t["writes"] for t in self.tables.values())

    @property
    def reads(self):
        return sum(t["read"] for t in self.tables.values())


def row_bytes(r, cols):
    # SQLite stores each value plus a few bytes of header; the primary key index repeats the key.
    return sum(len(str(r.get(c))) if r.get(c) is not None else 1 for c in cols) + 8 * len(cols)


def state_get(args, part):
    try:
        r = d1(args, command=f"SELECT value FROM agency_load_state WHERE part = {D.lit(part)}")
        return r[0]["value"] if r else None
    except SystemExit as e:
        if "no such table" in str(e):
            return None
        raise


def state_sql(part, value):
    return f"INSERT INTO agency_load_state (part, value, checked_at) VALUES ({D.lit(part)}, {D.lit(value)}, datetime('now')) ON CONFLICT (part) DO UPDATE SET value = excluded.value, checked_at = excluded.checked_at;"


def usage_sql(part, reads, writes):
    day = datetime.date.today().isoformat()
    return (f"INSERT INTO usage_steps (day, step, rounds, rows_read, rows_written) VALUES ({D.lit(day)}, {D.lit('agencies-' + part)}, 1, {int(reads)}, {int(writes)}) "
            f"ON CONFLICT (day, step) DO UPDATE SET rounds = rounds + 1, rows_read = rows_read + excluded.rows_read, rows_written = rows_written + excluded.rows_written;")


def ensure_tables(args):
    d1(args, command="CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)")
    if not d1(args, command="SELECT 1 AS x FROM d1_migrations WHERE name = '0052_agencies.sql'"):
        d1(args, file=MIGRATION)
        d1(args, command="INSERT OR IGNORE INTO d1_migrations (name) VALUES ('0052_agencies.sql')")
        say("Applied migration 0052_agencies.sql")


# ---------------------------------------------------------------------------
# The parts


def part_agencies(args, ctx, plan):
    h = head(FR_AGENCIES, "application/json")
    stamp = h.get("content-length") or h.get("etag")
    if stamp and stamp == state_get(args, "agencies") and not args.force:
        say(f"agencies: unchanged (Content-Length {stamp}); not read")
        ctx["agencies"] = list(existing(args, "agencies").values())
        return stamp
    rows = parse_fr_agencies(fetch_json(FR_AGENCIES))
    kinds = {k: sum(1 for r in rows if r["kind"] == k) for k in ("department", "sub-agency", "independent")}
    say(f"agencies: {len(rows)} from the Federal Register ({kinds['department']} departments, {kinds['sub-agency']} sub-agencies, {kinds['independent']} other top-level agencies)")
    # Keep a USAspending code already matched.
    old = existing(args, "agencies")
    for r in rows:
        if r["id"] in old:
            r["usas_code"] = old[r["id"]].get("usas_code")
    ctx["agencies"] = rows
    ctx["agencies_read"] = True
    plan.add(args, "agencies", rows, prune_scope="all")
    return stamp


def part_leaders(args, ctx, plan):
    h = head(PLUM_CSV, "text/csv")
    stamp = h.get("content-length") or h.get("etag")
    if stamp and stamp == state_get(args, "leaders") and not args.force:
        say(f"leaders: unchanged (Content-Length {stamp}); not read")
        return stamp
    plum = parse_plum(fetch(PLUM_CSV, accept="text/csv"))
    noms = d1(args, command="SELECT id, description, status, latest_action, latest_on FROM nominations WHERE status = 'confirmed'")
    votes = d1(args, command="SELECT id, subject, question, result FROM votes WHERE chamber = 'us-senate' AND vote_type = 'nomination'")
    officials = d1(args, command="SELECT id, name FROM officials WHERE chamber = 'us-executive' AND active = 1")
    rows, unmatched = leader_rows(plum, name_index(ctx["agencies"]), noms, nomination_votes(votes, noms), officials)
    tied = sum(1 for r in rows if r["nomination_id"])
    say(f"leaders: {len(plum)} current PLUM positions; {len(rows)} Senate-confirmed positions kept ({sum(1 for r in rows if r['status'] == 'Vacant')} vacant), "
        f"{tied} tied to a Congress.gov nomination, {sum(1 for r in rows if r['vote_id'])} to a Senate roll call, {sum(1 for r in rows if r['official_id'])} to an official's page")
    if unmatched:
        say(f"  PLUM agencies not matched to the Federal Register list (not shown): {len(unmatched)}: " + "; ".join(unmatched[:30]))
    plan.add(args, "agency_leaders", rows, prune_scope="all")
    return stamp


def part_money(args, ctx, plan):
    toptier = fetch_json(f"{USAS}/references/toptier_agencies/").get("results", [])
    period = max((f"{t.get('active_fy')}Q{t.get('active_fq')}" for t in toptier), default="")
    if period and period == state_get(args, "money") and not args.force:
        say(f"money: USAspending's reporting period is still {period}; not read")
        return period
    codes, unmatched = usas_code_map(toptier, name_index([a for a in ctx["agencies"] if a["kind"] != "sub-agency"]))
    say(f"money: {len(toptier)} USAspending top-tier agencies, {len(codes)} matched to the Federal Register list" + (f"; not matched (not shown): {'; '.join(unmatched)}" if unmatched else ""))
    names = {t["toptier_code"]: t["agency_name"] for t in toptier}
    # The agencies' rows carry the code; written with the agencies part's rows.
    by_id = {a["id"]: a for a in ctx["agencies"]}
    for code, aid in codes.items():
        by_id[aid]["usas_code"] = code
    # In a load, the agencies part wrote its rows already; the codes are an update. In a measure of a
    # first load, they ride on the agencies part's inserts (not counted twice).
    if ctx["agencies"] and not (args.mode == "measure" and ctx.get("agencies_read") and not existing(args, "agencies")):
        plan.add(args, "agencies", [by_id[a] for a in codes.values()])
    latest = int(period[:4]) if period[:4].isdigit() else datetime.date.today().year
    closed = {r["fy"] for r in existing(args, "agency_money").values()} if not args.force else set()
    years = [fy for fy in range(SINCE_FY, latest + 1) if args.all_years or fy >= latest - 1 or fy not in closed]
    def one(item):
        try:
            return read_one(item)
        except Exception as e:  # noqa: BLE001  (one agency failing leaves its rows as they are)
            say(f"  {names[item[0]]}: not read ({type(e).__name__}: {str(e)[:120]}); its rows are left as they are")
            failed.append(item[1])
            return [], [], []

    failed = []

    def read_one(item):
        code, aid = item
        m = money_rows(aid, code, fetch_json(f"{USAS}/agency/{code}/budgetary_resources/"))
        p, r = [], []
        for fy in years:
            p += object_class_rows(aid, fy, fetch_json(f"{USAS}/agency/{code}/object_class/?fiscal_year={fy}&limit=100"))
            p += function_rows(aid, fy, fetch_json(f"{USAS}/agency/{code}/budget_function/?fiscal_year={fy}&limit=100"))
            for award in AWARDS:
                top = fetch_json(f"{USAS}/search/spending_by_category/recipient/", method="POST", body=recipient_body(names[code], fy, award))
                ind = fetch_json(f"{USAS}/search/spending_by_category/recipient/", method="POST", body=recipient_body(names[code], fy, award, individuals=True))
                r += recipient_rows(aid, fy, award, top, ind)
        return m, p, r

    money, parts, recips = [], [], []
    # A few requests at a time (USAspending answers each in about half a second).
    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
        for n, (m, p, r) in enumerate(pool.map(one, sorted(codes.items())), 1):
            money, parts, recips = money + m, parts + p, recips + r
            if n % 10 == 0:
                say(f"  read {n} of {len(codes)} agencies")
    where = f"fy IN ({', '.join(map(str, years))})" if years else "0"
    if failed:
        where += f" AND agency_id NOT IN ({', '.join(D.lit(a) for a in failed)})"
        say(f"money: {len(failed)} agencies not read this time; tried again next run")
    plan.add(args, "agency_money", money)
    plan.add(args, "agency_money_parts", parts, where=where, prune_scope="years")
    plan.add(args, "agency_recipients", recips, where=where, prune_scope="years")
    say(f"money: fiscal years read: {years[0] if years else '-'}–{years[-1] if years else '-'}")
    return None if failed else period


def part_workforce(args, ctx, plan):
    try:
        import pyarrow.parquet as pq
    except ImportError:
        say("workforce: pyarrow isn't installed; skipped")
        return None
    files = fetch_json(f"{OPM_FILES}/employment?current=true")
    files = files if isinstance(files, list) else files.get("files") or files.get("data") or []
    sept = sorted([f for f in files if str(f.get("month")).lstrip("0") in ("9", "Sep", "September") and int(f.get("year", 0)) >= SINCE_FY], key=lambda f: int(f["year"]))
    stamp = json.dumps([(f.get("year"), f.get("version"), f.get("publishedDate") or f.get("published")) for f in sept])
    say(f"workforce: {len(files)} current employment files listed; September files: {[f.get('year') for f in sept]}")
    if files:
        say(f"  file fields: {sorted(files[0].keys())}")
    if stamp == state_get(args, "workforce") and not args.force:
        say("workforce: no new September file; not read")
        return stamp
    rows, idx = [], name_index(ctx["agencies"])
    for f in sept:
        url = f"{OPM_FILES}/employment/{f['year']}/{int(str(f['month']).lstrip('0') or 9):02d}/{f['version']}/download"
        try:
            data = fetch(url, accept="*/*", raw=True, timeout=600)
        except Exception as e:  # noqa: BLE001
            say(f"  {f['year']}: download failed ({e}); skipped")
            continue
        table = pq.read_table(io.BytesIO(data))
        counts, unmatched, col = workforce_counts(table, idx)
        say(f"  {f['year']}: {table.num_rows:,} records; columns {table.column_names[:25]}; counted by {col}; {len(counts)} agencies matched, {len(unmatched)} not")
        for aid, n in counts.items():
            rows.append({"agency_id": aid, "year": int(f["year"]), "employees": n, "source_url": "https://data.opm.gov/get-data/data-downloads"})
    plan.add(args, "agency_workforce", rows)
    return stamp


def part_oversight(args, ctx, plan):
    h = head(GAO_RSS, "application/rss+xml")
    stamp = h.get("etag") or h.get("last-modified") or h.get("content-length")
    if stamp and stamp == state_get(args, "oversight") and not args.force:
        say(f"oversight: GAO's feed unchanged ({stamp}); not read")
        return stamp
    items = parse_gao_rss(fetch(GAO_RSS, accept="application/rss+xml"))
    rows = report_rows(items, ctx["agencies"])
    say(f"oversight: GAO's feed lists {len(items)} reports; {len({r['number'] for r in rows})} name an agency ({len(rows)} report-agency pairs). Oversight.gov isn't read: it refuses GitHub's servers.")
    numbers = ", ".join(D.lit(i["number"]) for i in items) or "''"
    plan.add(args, "agency_reports", rows, where=f"source = 'gao' AND number IN ({numbers})")
    return stamp


def part_rules(args, ctx, plan):
    counts, latest = [], []
    old = existing(args, "agency_rule_counts")
    year = datetime.date.today().year
    for n, a in enumerate(ctx["agencies"], 1):
        q = f"conditions%5Btype%5D%5B%5D=RULE&conditions%5Bagencies%5D%5B%5D={urllib.parse.quote(a['id'])}"
        facet = fetch_json(f"{FR_DOCS}/facets/yearly?{q}")
        c = rule_count_rows(a["id"], facet)
        counts += c
        now = next((r["rules"] for r in c if r["year"] == year), 0)
        if args.force or old.get((a["id"], year), {}).get("rules") != now or not old:
            fields = "".join(f"&fields%5B%5D={f}" for f in ("title", "publication_date", "document_number", "html_url"))
            latest += rule_rows(a["id"], fetch_json(f"{FR_DOCS}.json?per_page=10&order=newest&{q}{fields}"))
        if n % 50 == 0:
            say(f"  read {n} of {len(ctx['agencies'])} agencies")
    read_ids = sorted({r["agency_id"] for r in latest})
    plan.add(args, "agency_rule_counts", counts)
    if read_ids:
        plan.add(args, "agency_rules", latest, where=f"agency_id IN ({', '.join(D.lit(i) for i in read_ids)})", prune_scope="read")
    say(f"rules: yearly counts for {len(ctx['agencies'])} agencies; latest rules read again for {len(read_ids)} whose count changed")
    return None


def part_laws(args, ctx, plan):
    mapping = json.loads(APPROPRIATIONS.read_text())
    bills = d1(args, command="SELECT id, title FROM bills WHERE level = 'federal' AND title LIKE '%Appropriations Act%'")
    known = {a["id"] for a in ctx["agencies"]}
    missing = sorted({a for m in mapping for a in m["agencies"]} - known)
    if missing:
        say(f"  slugs in data/agencies/appropriations.json not in the Federal Register list (fix the file): {', '.join(missing)}")
    rows = [r for r in bill_rows(bills, mapping) if r["agency_id"] in known]
    say(f"laws: {len(bills)} appropriations bills on the site; {len({r['bill_id'] for r in rows})} tied to {len({r['agency_id'] for r in rows})} agencies")
    plan.add(args, "agency_bills", rows, prune_scope="all")
    return None


RUNNERS = {"agencies": part_agencies, "leaders": part_leaders, "money": part_money, "workforce": part_workforce, "oversight": part_oversight, "rules": part_rules, "laws": part_laws}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--parts", default=",".join(PARTS))
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--force", action="store_true", help="read sources even when their checks say unchanged")
    ap.add_argument("--workers", type=int, default=2, help="USAspending requests at a time")
    ap.add_argument("--all-years", action="store_true", help="read every fiscal year since 2017, not only open ones")
    args = ap.parse_args()
    parts = [p for p in args.parts.split(",") if p]
    if args.mode == "load":
        ensure_tables(args)
    ctx = {"agencies": []}
    if "agencies" not in parts:
        ctx["agencies"] = list(existing(args, "agencies").values())
    total = {"writes": 0, "bytes": 0}
    for part in [p for p in PARTS if p in parts or (p == "agencies" and not ctx["agencies"])]:
        plan = Plan()
        try:
            stamp = RUNNERS[part](args, ctx, plan)
        except Refused as e:
            say(f"{part}: {e}; not loaded")
            continue
        plan.report(part)
        total["writes"] += plan.writes
        total["bytes"] += sum(t["bytes"] for t in plan.tables.values())
        if args.mode == "load":
            stmts = plan.statements + ([state_sql(part, stamp)] if stamp else []) + [usage_sql(part, plan.reads, plan.writes)]
            run_sql(args, stmts)
            say(f"{part}: loaded ({plan.writes:,} row writes)")
    say(f"\nIn all: {total['writes']:,} row writes (about ${total['writes'] / 1e6:.2f} at $1.00 per million), about {total['bytes'] / 1e6:.1f} MB of storage added"
        + (" (measure: nothing was written)" if args.mode == "measure" else ""))


if __name__ == "__main__":
    main()
