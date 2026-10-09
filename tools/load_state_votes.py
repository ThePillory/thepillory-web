#!/usr/bin/env python3
"""Load state bills and roll call votes from Open States' bulk session files
into D1, without the per-request API. Run by the "Load state votes" workflow
(.github/workflows/state-votes.yml). See docs/states.md.

    python3 tools/load_state_votes.py --mode measure --states priority:10
    python3 tools/load_state_votes.py --mode load --states TX,NY

Where the files come from: Open States publishes one ZIP of CSV files per
legislative session (https://open.pluralpolicy.com/data/session-csv/, updated
monthly, public domain). The list of links is shown only to a signed-in
account, so either
  - OPENSTATES_EMAIL and OPENSTATES_PASSWORD (an open.pluralpolicy.com account)
    let this script sign in and read the list, or
  - --urls lists the ZIP links (copied from that page while signed in).

Modes:
  measure  downloads each session and reports what loading it would add: bills,
           votes, positions, and the database size they'd take, without
           writing anything. Needs no Cloudflare credentials.
  load     writes the bills, votes and positions to D1 with `wrangler d1
           execute --remote --file` (CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID).
           Only votes not already in D1 are written, so a monthly refresh adds
           only what's new.

What's kept: every bill with at least one recorded vote, every roll call vote
on a bill, with its exact motion text, result, date, totals as the source
states them and a source link, and each current legislator's position. A
voter who isn't a current legislator (a former member) is counted but not
stored, as for California. Nothing is guessed: a bill without an http(s)
source is skipped and counted.

Standard library only (plus `npx wrangler` for loading).
"""
import argparse
import csv
import datetime
import hashlib
import html as htmllib
import http.cookiejar
import io
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unicodedata
import urllib.parse
import urllib.request
import zipfile
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SITE = "https://open.pluralpolicy.com"
UA = "ThePillory/1.0 (+https://thepillory.co; civic records)"
csv.field_size_limit(1 << 30)

# Bytes each row takes in D1 with its indexes, measured with the real schema
# (docs/states.md): a compact position, a vote, a bill.
BYTES = {"position": 25, "vote": 500, "bill": 400}

STATE_NAME = {
    "AL": "Alabama", "AK": "Alaska", "AZ": "Arizona", "AR": "Arkansas", "CA": "California", "CO": "Colorado", "CT": "Connecticut",
    "DE": "Delaware", "DC": "District of Columbia", "FL": "Florida", "GA": "Georgia", "HI": "Hawaii", "ID": "Idaho", "IL": "Illinois",
    "IN": "Indiana", "IA": "Iowa", "KS": "Kansas", "KY": "Kentucky", "LA": "Louisiana", "ME": "Maine", "MD": "Maryland",
    "MA": "Massachusetts", "MI": "Michigan", "MN": "Minnesota", "MS": "Mississippi", "MO": "Missouri", "MT": "Montana",
    "NE": "Nebraska", "NV": "Nevada", "NH": "New Hampshire", "NJ": "New Jersey", "NM": "New Mexico", "NY": "New York",
    "NC": "North Carolina", "ND": "North Dakota", "OH": "Ohio", "OK": "Oklahoma", "OR": "Oregon", "PA": "Pennsylvania",
    "PR": "Puerto Rico", "RI": "Rhode Island", "SC": "South Carolina", "SD": "South Dakota", "TN": "Tennessee", "TX": "Texas",
    "UT": "Utah", "VT": "Vermont", "VA": "Virginia", "WA": "Washington", "WV": "West Virginia", "WI": "Wisconsin", "WY": "Wyoming",
}
BY_NAME = {v: k for k, v in STATE_NAME.items()}


# ---------------------------------------------------------------------------
# The same rules as the sync Worker (workers/sync/src/states.js, classify.js,
# rollcall.js), so a vote loaded here looks like one the Worker loaded.

def stable_key(s):
    """stableKey() in states.js: the first 13 hex digits of SHA-256, as an integer."""
    return int(hashlib.sha256(str(s).encode()).hexdigest()[:13], 16)


def slugify(s):
    s = unicodedata.normalize("NFD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c)).lower()
    return re.sub(r"[^a-z0-9]+", "-", s).strip("-")


def chamber_ids(st):
    st = st.upper()
    if st == "CA":
        return {"upper": "ca-senate", "lower": "ca-assembly"}
    p = st.lower()
    if st in ("NE", "DC"):
        return {"upper": f"{p}-legislature", "lower": None, "legislature": f"{p}-legislature"}
    return {"upper": f"{p}-upper", "lower": f"{p}-lower", "legislature": f"{p}-legislature"}


def classify_state(motion_text, kinds, org_class):
    """classifyState() in classify.js."""
    text = (motion_text or "").lower()
    kinds = [k.lower() for k in kinds]
    org = (org_class or "").lower()
    if org == "committee" or "committee-passage" in kinds or re.search(r"do pass|committee", text):
        return "committee"
    if "veto-override" in kinds or "override" in text:
        return "final_passage"
    if "amendment-passage" in kinds or "amendment-adoption" in kinds or (re.search(r"\bamend(ment)?\b", text) and not re.search(r"concurrence|as amended", text)):
        return "amendment"
    if "passage" in kinds or re.search(r"third reading|3rd reading|final passage|concurrence|consent calendar", text):
        return "final_passage"
    if re.search(r"reconsider|motion to|table|recommit|rule waiver|suspend", text):
        return "procedural"
    return "other"


POSITION = {
    "yea": "Yes", "aye": "Yes", "yes": "Yes", "nay": "No", "no": "No", "present": "Present",
    "not voting": "Not voting", "not-voting": "Not voting", "absent": "Not voting", "abstain": "Not voting",
    "excused": "Not voting", "no vote recorded": "Not voting", "paired": "Not voting", "other": "Not voting",
}
CODE = {"Yes": 0, "No": 1, "Present": 2, "Not voting": 3}
PLAIN = {"yes", "no", "present", "not voting"}  # stored without a raw spelling (all_positions shows these)


def position(raw):
    """(code, raw to keep or None), as normalizePosition() in classify.js."""
    k = (raw or "").strip().lower()
    name = POSITION.get(k, "Not voting")
    return CODE[name], (None if k in PLAIN else (raw or "").strip())


def totals(counts):
    """stateTotals() in rollcall.js: [yea, nay, present, not_voting] from Open States' counts."""
    if not counts:
        return [None, None, None, None]
    get = lambda *opts: sum(int(c["value"] or 0) for c in counts if c["option"].lower() in opts)
    return [get("yes"), get("no"), get("abstain", "present"), get("not voting", "absent", "excused", "other")]


def kinds_of(value):
    """motion_classification as exported (a Python list's repr, or a Postgres array): ['passage'] -> ["passage"]."""
    return re.findall(r"[a-z][a-z-]*", (value or "").lower())


def is_http(u):
    return isinstance(u, str) and re.match(r"^https?://", u) is not None


# ---------------------------------------------------------------------------
# The list of session files.

def session_links(page):
    """Each <a href="https://…zip">Texas 89th Legislature (2025)</a> (updated 2025-08-05) on the signed-in list."""
    out = []
    for m in re.finditer(r'<a href="(https?://[^"]+\.zip)">\s*(.*?)</a>\s*\(updated\s*(\d{4}-\d{2}-\d{2})\)', page, re.S):
        url, label, updated = m.group(1), htmllib.unescape(re.sub(r"\s+", " ", m.group(2))).strip(), m.group(3)
        out.append(dict(url=url, label=label, updated=updated, **file_parts(url)))
    return out


def file_parts(url):
    """'…/TX_89_csv_7eE….zip' -> {'st': 'TX', 'session': '89'} (Open States' file name: <abbr>_<session>_csv_<random>.zip)."""
    name = urllib.parse.unquote(url.rsplit("/", 1)[-1])
    m = re.match(r"([A-Za-z]{2})_(.+)_csv_[A-Za-z0-9]+\.zip$", name)
    return {"st": m.group(1).upper(), "session": m.group(2)} if m else {"st": None, "session": None}


def years(label):
    return [int(y) for y in re.findall(r"\b(19\d\d|20\d\d)\b", label or "")]


def choose(links, states, since_year):
    """The sessions to load: each state asked for, every session whose years reach since_year (the current one and its special sessions)."""
    keep = []
    newest_yearless = {}
    for link in links:
        if link["st"] not in states:
            continue
        ys = years(link["label"])
        if ys and max(ys) >= since_year:
            keep.append(link)
        elif not ys and link.get("updated", "")[:4] >= str(since_year):
            # A label without a year ("104th General Assembly"): the state's most recently updated one.
            cur = newest_yearless.get(link["st"])
            if not cur or link["updated"] > cur["updated"]:
                newest_yearless[link["st"]] = link
    keep += newest_yearless.values()
    return sorted(keep, key=lambda x: (states.index(x["st"]), x["session"]))


def signed_in_list(email, password):
    jar = http.cookiejar.CookieJar()
    op = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
    op.addheaders = [("User-Agent", UA)]
    login = f"{SITE}/accounts/login/?next=/data/session-csv/"
    page = op.open(login, timeout=60).read().decode("utf-8", "replace")
    token = re.search(r'name="csrfmiddlewaretoken" value="([^"]+)"', page)
    if not token:
        raise SystemExit("Open States' sign-in page has changed (no form token); use --urls instead.")
    body = urllib.parse.urlencode({"csrfmiddlewaretoken": token.group(1), "login": email, "password": password, "next": "/data/session-csv/"}).encode()
    req = urllib.request.Request(f"{SITE}/accounts/login/", data=body, headers={"Referer": login, "User-Agent": UA})
    page = op.open(req, timeout=60).read().decode("utf-8", "replace")
    links = session_links(page)
    if not links:
        page = op.open(f"{SITE}/data/session-csv/", timeout=60).read().decode("utf-8", "replace")
        links = session_links(page)
    if not links:
        raise SystemExit("Signed in, but the session list has no download links: check OPENSTATES_EMAIL and OPENSTATES_PASSWORD (an open.pluralpolicy.com account with a password).")
    return links


def download(url, folder):
    out = Path(folder) / urllib.parse.unquote(url.rsplit("/", 1)[-1])
    if not out.exists():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=600) as r, open(out, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        time.sleep(2)
    return out


# ---------------------------------------------------------------------------
# One session file -> rows.

def table_kind(name):
    """'tx/89R/tx_89R_bills.csv' -> 'bills', and 'tx/89R/tx_89R_related_bills.csv' -> 'related_bills' (not 'bills'):
    the file name is <abbr>_<session>_<kind>.csv inside <abbr>/<session>/."""
    parts = name.split("/")
    base = parts[-1]
    if not base.endswith(".csv"):
        return None
    if len(parts) >= 3:
        prefix = f"{parts[-3]}_{parts[-2]}_"
        if base.startswith(prefix):
            return base[len(prefix):-4]
    # No folders: the longest known kind the name ends with.
    kinds = ("related_bills", "bill_sources", "bill_actions", "bills", "vote_people", "vote_counts", "vote_sources", "votes", "organizations")
    for k in sorted(kinds, key=len, reverse=True):
        if base.endswith(f"_{k}.csv"):
            return k
    return None


def read_tables(path):
    """The CSV files a load needs, by kind ('bills', 'votes', 'vote_people', …), each a list of dicts."""
    want = ("bills", "bill_sources", "bill_actions", "votes", "vote_people", "vote_counts", "vote_sources", "organizations")
    tables = {k: [] for k in want}
    generated = None
    with zipfile.ZipFile(path) as z:
        for name in z.namelist():
            if name.endswith("README"):
                m = re.search(r"Generated At: (.+)", z.read(name).decode("utf-8", "replace"))
                generated = m.group(1).strip() if m else None
                continue
            kind = table_kind(name)
            if kind not in want:
                continue
            with z.open(name) as f:
                tables[kind] = list(csv.DictReader(io.TextIOWrapper(f, encoding="utf-8", newline="")))
    return tables, generated


def build(st, session, tables, officials):
    """Rows for D1: bills, votes and compact positions, and counts of what was left out.
    `officials`: openstates person id -> {"k", "chamber", "last_name"} (current legislators)."""
    ids = chamber_ids(st)
    p = st.lower()
    orgs = {o["id"]: o for o in tables["organizations"]}

    def chamber_type(org_id):
        o = orgs.get(org_id)
        for _ in range(3):
            if not o:
                return None
            if o.get("classification") in ("upper", "lower", "legislature"):
                return o["classification"]
            o = orgs.get(o.get("parent_id"))
        return None

    def chamber(t):
        if t == "legislature" or (t == "upper" and not ids.get("lower")):
            return ids.get("legislature") or ids["upper"]
        return ids.get(t) if t else None

    bill_source = {}
    for s in tables["bill_sources"]:
        if is_http(s.get("url")) and s["bill_id"] not in bill_source:
            bill_source[s["bill_id"]] = s["url"]
    vote_source = {}
    for s in tables["vote_sources"]:
        if is_http(s.get("url")) and s["vote_event_id"] not in vote_source:
            vote_source[s["vote_event_id"]] = s["url"]
    counts = defaultdict(list)
    for c in tables["vote_counts"]:
        counts[c["vote_event_id"]].append(c)
    people = defaultdict(list)
    for v in tables["vote_people"]:
        people[v["vote_event_id"]].append(v)

    by_chamber_last = defaultdict(list)
    for pid, o in officials.items():
        by_chamber_last[(o["chamber"], (o.get("last_name") or "").lower())].append(pid)

    bills, votes, positions = {}, [], []
    stats = defaultdict(int)
    bill_rows = {b["id"]: b for b in tables["bills"]}
    # Some files leave a vote's bill_id empty and link it through the bill action it was taken on.
    action_bill = {a["id"]: a.get("bill_id") for a in tables.get("bill_actions", []) if a.get("id")}
    for v in tables["votes"]:
        b = bill_rows.get(v.get("bill_id")) or bill_rows.get(action_bill.get(v.get("bill_action_id") or ""))
        if not b:
            stats["votes_without_bill"] += 1
            stats["votes_no_bill_id" if not v.get("bill_id") else "votes_bill_not_in_file"] += 1
            if v.get("bill_id") and "sample_missing_bill_id" not in stats:
                stats["sample_missing_bill_id"] = v["bill_id"][:80]
            continue
        src = bill_source.get(b["id"])
        if not src:
            stats["votes_on_bills_without_source"] += 1
            continue
        bill_id = f"{p}-{slugify(session)}-{slugify(b['identifier'])}"
        if bill_id not in bills:
            bills[bill_id] = {
                "id": bill_id, "level": "state", "chamber": chamber(b.get("organization_classification")) or ids["upper"],
                "bill_number": b["identifier"].strip(), "session": session, "title": (b.get("title") or b["identifier"]).strip(),
                "official_url": src, "source_url": src,
            }
        org_type = chamber_type(v.get("organization_id"))
        org_class = (orgs.get(v.get("organization_id")) or {}).get("classification")
        vote_id = f"{p}-{v['id']}"
        result = (v.get("result") or "").lower()
        votes.append({
            "id": vote_id, "bill_id": bill_id, "level": "state", "chamber": chamber(org_type) or f"{p}-legislature",
            "vote_date": (v.get("start_date") or "")[:10], "question": (v.get("motion_text") or "").strip() or "(no motion text)",
            "vote_type": classify_state(v.get("motion_text"), kinds_of(v.get("motion_classification")), org_class),
            "result": "Passed" if result == "pass" else "Failed" if result == "fail" else (v.get("result") or "Unknown"),
            "source_url": vote_source.get(v["id"]) or src, "totals": totals(counts.get(v["id"])), "k": stable_key(vote_id),
        })
        seen = set()
        for pv in people.get(v["id"], []):
            pid = pv.get("voter_id") or ""
            o = officials.get(pid)
            if not o and not pid:
                # No person id: a unique last-name match in the vote's chamber, as for California.
                name = (pv.get("voter_name") or "").lower().strip()
                cands = [x for (ch, last), xs in by_chamber_last.items() if ch == chamber(org_type) and last and (name == last or name.startswith(f"{last},") or name.endswith(f" {last}")) for x in xs]
                o = officials.get(cands[0]) if len(cands) == 1 else None
            if not o:
                stats["positions_not_current_members"] += 1
                continue
            if o["k"] in seen:
                continue
            seen.add(o["k"])
            code, raw = position(pv.get("option"))
            positions.append((votes[-1]["k"], o["k"], code, raw))
    stats["bills_without_votes"] = sum(1 for b in tables["bills"]) - len({x["bill_id"] for x in votes})
    return {"bills": list(bills.values()), "votes": votes, "positions": positions, "stats": dict(stats)}


# ---------------------------------------------------------------------------
# SQL for `wrangler d1 execute --file`.

def lit(v):
    if v is None:
        return "NULL"
    if isinstance(v, (int, float)):
        return str(int(v))
    return "'" + str(v).replace("'", "''") + "'"


def statements(rows, existing_votes=frozenset()):
    """INSERT statements in chunks (each well under D1's statement size limit). Votes already in D1 are skipped."""
    out = []
    bills = rows["bills"]
    for i in range(0, len(bills), 50):
        vals = ",".join(f"({lit(b['id'])},'state',{lit(b['chamber'])},{lit(b['bill_number'])},{lit(b['session'])},{lit(b['title'][:1000])},{lit(b['official_url'])},{lit(b['source_url'])},datetime('now'))" for b in bills[i:i + 50])
        out.append("INSERT INTO bills (id, level, chamber, bill_number, session, title, official_url, source_url, updated_at) VALUES "
                   f"{vals} ON CONFLICT(id) DO UPDATE SET title = excluded.title, official_url = excluded.official_url, source_url = excluded.source_url, updated_at = excluded.updated_at;")
    new = [v for v in rows["votes"] if v["id"] not in existing_votes]
    keep = {v["k"] for v in new}
    for i in range(0, len(new), 40):
        vals = ",".join(
            f"({lit(v['id'])},{lit(v['bill_id'])},'state',{lit(v['chamber'])},{lit(v['vote_date'])},{lit(v['question'][:2000])},{lit(v['vote_type'])},{lit(v['result'])},{lit(v['source_url'])},"
            f"{','.join(lit(x) for x in v['totals'])},{lit(v['k'])},datetime('now'))" for v in new[i:i + 40])
        out.append("INSERT INTO votes (id, bill_id, level, chamber, vote_date, question, vote_type, result, source_url, yea, nay, present, not_voting, k, updated_at) VALUES "
                   f"{vals} ON CONFLICT(id) DO UPDATE SET bill_id = excluded.bill_id, chamber = excluded.chamber, vote_date = excluded.vote_date, question = excluded.question, "
                   "vote_type = excluded.vote_type, result = excluded.result, source_url = excluded.source_url, yea = excluded.yea, nay = excluded.nay, present = excluded.present, "
                   "not_voting = excluded.not_voting, k = excluded.k, updated_at = excluded.updated_at;")
    pos = [x for x in rows["positions"] if x[0] in keep]
    for i in range(0, len(pos), 400):
        vals = ",".join(f"({a},{b},{c},{lit(r)})" for a, b, c, r in pos[i:i + 400])
        out.append(f"INSERT INTO state_positions (vote_k, member_k, position, raw) VALUES {vals} ON CONFLICT(vote_k, member_k) DO UPDATE SET position = excluded.position, raw = excluded.raw;")
    assert all(len(s.encode()) < 95000 for s in out), "a statement is over D1's size limit"
    return out, len(new), len(pos)


# ---------------------------------------------------------------------------
# D1 through wrangler (load mode).

def d1(args, *, file=None, command=None):
    cmd = ["npx", "--yes", "wrangler@4", "d1", "execute", args.database, "--remote", "--yes"]
    cmd += ["--file", str(file)] if file else ["--json", "--command", command]
    r = subprocess.run(cmd, cwd=ROOT / "workers" / "sync", capture_output=True, text=True)
    if r.returncode:
        raise SystemExit(f"wrangler d1 execute failed:\n{r.stdout[-3000:]}\n{r.stderr[-3000:]}")
    if command:
        out = json.loads(r.stdout[r.stdout.index("["):])
        return out[0].get("results", [])
    return None


def d1_size(args):
    """The database's size now, in bytes (wrangler d1 info), or None if it can't be read."""
    r = subprocess.run(["npx", "--yes", "wrangler@4", "d1", "info", args.database, "--json"], cwd=ROOT / "workers" / "sync", capture_output=True, text=True)
    try:
        info = json.loads(r.stdout[r.stdout.index("{"):])
    except ValueError:
        return None
    n = info.get("database_size", info.get("file_size"))
    return int(n) if isinstance(n, (int, float)) else None


def officials_in_d1(args, st):
    rows = d1(args, command=f"SELECT openstates_id, k, chamber, last_name FROM officials WHERE state = {lit(st)} AND openstates_id IS NOT NULL AND k IS NOT NULL AND level = 'state' AND chamber NOT GLOB '*-executive'")
    return {r["openstates_id"]: r for r in rows}


def officials_from_file(st):
    """Measure mode: the current legislators in data/states/people/<st>.json (no Cloudflare access needed)."""
    f = ROOT / "data" / "states" / "people" / f"{st.lower()}.json"
    if not f.exists():
        return {}
    doc = json.loads(f.read_text())
    ids = chamber_ids(st)
    out = {}
    for p in doc["legislators"]:
        ch = ids.get("legislature") if p["type"] == "legislature" else ids.get(p["type"])
        out[p["id"]] = {"k": stable_key(f"openstates:{p['id']}"), "chamber": ch, "last_name": p.get("family_name")}
    return out


def priority(args, n):
    """The top n states by visitors and waitlist signups, as the sync last ranked them (sync_state 'state_priority')."""
    if not os.environ.get("CLOUDFLARE_API_TOKEN"):
        raise SystemExit("--states priority:N reads the ranking from D1 and needs CLOUDFLARE_API_TOKEN; name the states instead (--states TX,NY).")
    rows = d1(args, command="SELECT value FROM sync_state WHERE key = 'state_priority'")
    if not rows:
        raise SystemExit("No state ranking yet: the sync writes it on its next run.")
    order = json.loads(rows[0]["value"])["order"]
    return [s for s in order if s != "CA"][:n]


def gb(n):
    return f"{n / 1e9:.2f} GB" if n >= 1e8 else f"{n / 1e6:.1f} MB"


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--mode", choices=("measure", "load"), default="measure")
    ap.add_argument("--states", required=True, help='"TX,NY", "all", "priority:10" (the 10 states visitors look up most), or "loaded" (every state loaded before: the monthly refresh)')
    ap.add_argument("--since-year", type=int, default=None, help="load sessions whose years reach this year (default: the current two-year period)")
    ap.add_argument("--urls", default="", help="a file listing session ZIP links, one per line (instead of signing in)")
    ap.add_argument("--database", default="pillory")
    ap.add_argument("--max-gb", type=float, default=5.0, help="load mode stops before a file would take the database past this size (default 5: the storage Workers Paid includes)")
    ap.add_argument("--work", default=tempfile.gettempdir())
    args = ap.parse_args()

    if args.states == "all":
        states = [s for s in STATE_NAME if s != "CA"]
    elif args.states.startswith("priority:"):
        states = priority(args, int(args.states.split(":")[1]))
    elif args.states == "loaded":
        states = sorted({r["st"] for r in d1(args, command="SELECT DISTINCT st FROM state_loads")})
        if not states:
            print("No state loaded yet: nothing to refresh.")
            return
    else:
        states = [s.strip().upper() for s in args.states.split(",") if s.strip()]
    if "CA" in states:
        raise SystemExit("California's votes come from the API step (workers/sync/src/openstates.js) into vote_positions; leave it out.")
    year = datetime.date.today().year
    since = args.since_year or (year if year % 2 else year - 1)

    if args.urls:
        links = [dict(url=u.strip(), label="", updated="", **file_parts(u.strip())) for u in Path(args.urls).read_text().split() if u.strip().startswith("http")]
        for link in links:
            link["label"] = str(since)  # listed by hand: taken as current
    elif os.environ.get("OPENSTATES_EMAIL") and os.environ.get("OPENSTATES_PASSWORD"):
        links = signed_in_list(os.environ["OPENSTATES_EMAIL"], os.environ["OPENSTATES_PASSWORD"])
    else:
        raise SystemExit("No session list: set OPENSTATES_EMAIL and OPENSTATES_PASSWORD, or pass --urls (see docs/states.md).")
    chosen = choose(links, states, since)
    print(f"{len(chosen)} session file(s) for {', '.join(states)} (sessions reaching {since})", flush=True)

    report, total = [], defaultdict(int)
    cap = int(args.max_gb * 1e9)
    size_before = d1_size(args) if args.mode == "load" else None
    if args.mode == "load":
        if size_before is None:
            raise SystemExit("Couldn't read the database's size (wrangler d1 info); nothing loaded.")
        print(f"Database now: {gb(size_before)}; this run stops before passing {gb(cap)} (--max-gb)", flush=True)
    stopped = ""
    for link in chosen:
        st, session = link["st"], link["session"]
        path = download(link["url"], args.work)
        tables, generated = read_tables(path)
        officials = officials_in_d1(args, st) if args.mode == "load" else officials_from_file(st)
        if args.mode == "load" and not officials:
            raise SystemExit(f"No {st} legislators in D1 yet: the sync's all-state-officials step loads them first (open /run once).")
        rows = build(st, session, tables, officials)
        existing = frozenset()
        if args.mode == "load":
            existing = frozenset(r["id"] for r in d1(args, command=f"SELECT id FROM votes WHERE id LIKE {lit(st.lower() + '-%')} AND k IS NOT NULL"))
        stmts, new_votes, new_positions = statements(rows, existing)
        size = len(rows["bills"]) * BYTES["bill"] + new_votes * BYTES["vote"] + new_positions * BYTES["position"]
        line = {"st": st, "session": session, "label": link["label"], "updated": link["updated"], "bills": len(rows["bills"]),
                "votes": len(rows["votes"]), "new_votes": new_votes, "positions": len(rows["positions"]), "new_positions": new_positions,
                "bytes": size, "row_writes": len(rows["bills"]) * 2 + new_votes * 8 + new_positions * 2, **rows["stats"]}
        report.append(line)
        for k in ("bills", "new_votes", "new_positions", "bytes", "row_writes"):
            total[k] += line[k]
        print(json.dumps(line), flush=True)
        if args.mode == "load" and size_before + total["bytes"] > cap:
            stopped = f"Stopped before {st} {session}: it would take the database to about {gb(size_before + total['bytes'])}, past --max-gb {args.max_gb:g}. Nothing from it was written."
            for k in ("bills", "new_votes", "new_positions", "bytes", "row_writes"):
                total[k] -= line[k]
            report.pop()
            path.unlink(missing_ok=True)
            break
        if args.mode == "load":
            # A few files of statements, each one transaction in D1.
            stmts.append(
                "INSERT INTO state_loads (st, session, file_url, generated_at, bills, votes, positions, skipped_positions, loaded_at) VALUES "
                f"({lit(st)},{lit(session)},{lit(link['url'])},{lit(generated)},{len(rows['bills'])},{len(rows['votes'])},{len(rows['positions'])},"
                f"{rows['stats'].get('positions_not_current_members', 0)},datetime('now')) ON CONFLICT(st, session) DO UPDATE SET file_url = excluded.file_url, "
                "generated_at = excluded.generated_at, bills = excluded.bills, votes = excluded.votes, positions = excluded.positions, "
                "skipped_positions = excluded.skipped_positions, loaded_at = excluded.loaded_at;")
            part, size_now, n = [], 0, 0
            for s in stmts + [None]:
                if s is None or size_now + len(s) > 30_000_000:
                    if part:
                        n += 1
                        f = Path(args.work) / f"load-{st}-{slugify(session)}-{n}.sql"
                        f.write_text("\n".join(part) + "\n")
                        d1(args, file=f)
                        print(f"  loaded part {n} ({gb(size_now)} of SQL)", flush=True)
                    part, size_now = [], 0
                if s is not None:
                    part.append(s)
                    size_now += len(s)
        path.unlink(missing_ok=True)

    summary = [
        f"## {'Loaded' if args.mode == 'load' else 'Measured (nothing written)'}: {len(report)} session file(s)",
        "",
        "| State | Session | Bills | Votes (new) | Positions (new) | Database size | Row writes |",
        "|---|---|---:|---:|---:|---:|---:|",
        *[f"| {r['st']} | {r['label'] or r['session']} | {r['bills']:,} | {r['votes']:,} ({r['new_votes']:,}) | {r['positions']:,} ({r['new_positions']:,}) | {gb(r['bytes'])} | {r['row_writes']:,} |" for r in report],
        f"| **Total** | | {total['bills']:,} | ({total['new_votes']:,}) | ({total['new_positions']:,}) | **{gb(total['bytes'])}** | **{total['row_writes']:,}** |",
        "",
        "Database size: rows with their indexes, measured with the real schema (docs/states.md). "
        "Row writes: what D1 bills as rows written (each row plus each index entry); Workers Paid includes 50 million a month, then $1.00 a million.",
        *([f"Database before this run: {gb(size_before)}."] if size_before is not None else []),
        *([f"**{stopped}**"] if stopped else []),
    ]
    text = "\n".join(summary)
    print(text)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as f:
            f.write(text + "\n")
    (Path(args.work) / "state-votes-report.json").write_text(json.dumps({"mode": args.mode, "since": since, "sessions": report, "total": total}, indent=1))


if __name__ == "__main__":
    main()
